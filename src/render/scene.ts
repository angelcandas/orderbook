import { Gfx, withAlpha, type RGBA } from './gl';
import type { Theme } from './theme';
import { H, LAD_BID, LAD_ASK, DEP_BID, DEP_ASK, LADDER, STATUS_NAMES } from '../shared/view';
import type { AnalyticsOut, PatternHit } from '../patterns/types';
import { computeLayout, DEFAULT_LAYOUT, type LayoutPrefs, type Rect } from './layout';

export interface SceneSettings {
  depthRangePct: number; // half-width of the depth chart around the mid, percent
  candlesVisible: number;
  /** extra px between ladder rows on top of the text height: the ladder's zoom */
  ladderRowPad?: number;
  reducedMotion: boolean;
  showChartPatterns: boolean;
  showCandlePatterns: boolean;
  selectedPattern: string | null;
  venueLabel: string;
  pairLabel: string;
}


const FLASH_MS = 400;
export const PANE_LADDER = 1, PANE_DEPTH = 2, PANE_CANDLES = 4, PANE_ALL = 7;
const HEADER = 22;
/** px kept free at the right of each pane header for the zoom buttons drawn over it */
export const HEADER_CTRL_W = 92;

/**
 * Draws the whole market view into one WebGL2 canvas: ladder (left), depth
 * chart (top right), candles with pattern overlays (bottom right). Allocation
 * free per frame apart from the pattern labels.
 */
export class Scene {
  // flash state for ladder rows, matched by price between frames
  private prevPx = new Float64Array(LADDER * 2);
  private prevQty = new Float64Array(LADDER * 2);
  private prevFlash = new Float64Array(LADDER * 2);
  private curPx = new Float64Array(LADDER * 2);
  private curQty = new Float64Array(LADDER * 2);
  private curFlash = new Float64Array(LADDER * 2);
  private prevN = 0;
  private lastVersion = -1;
  ladder: Rect = { x: 0, y: 0, w: 0, h: 0 };
  depth: Rect = { x: 0, y: 0, w: 0, h: 0 };
  candles: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** half-width of the depth chart actually drawn, percent (for zooming from auto) */
  depthPct = 1;
  /** hit boxes of pattern labels, for clicks */
  patternBoxes: { id: string; x: number; y: number; w: number; h: number }[] = [];

  constructor(private g: Gfx) {}

  layout(w: number, h: number, prefs: LayoutPrefs = DEFAULT_LAYOUT): void {
    const l = computeLayout(w, h, prefs);
    this.ladder = l.ladder;
    this.depth = l.depth;
    this.candles = l.candles;
  }

  /**
   * Redraw the panes in `dirty` (bits: LADDER, DEPTH, CANDLES); the others keep
   * their pixels from the previous frame. Returns true if the ladder is still
   * animating (change flashes fading out).
   */
  draw(v: Float64Array, a: AnalyticsOut | null, ptr: { x: number; y: number; in: boolean }, s: SceneSettings, t: Theme, now: number, dirty: number): boolean {
    const g = this.g;
    let anim = false;
    if (dirty & PANE_LADDER) {
      g.begin();
      anim = this.drawLadder(v, s, t, now);
      g.end(t.bg, this.ladder);
    }
    if (dirty & PANE_DEPTH) {
      g.begin();
      this.drawDepth(v, ptr, s, t);
      g.rect(this.depth.x, this.depth.y, 1, this.depth.h, t.grid);
      g.end(t.bg, this.depth);
    }
    if (dirty & PANE_CANDLES) {
      g.begin();
      this.drawCandles(a, v, ptr, s, t);
      g.rect(this.candles.x, this.candles.y, 1, this.candles.h, t.grid);
      g.rect(this.candles.x, this.candles.y, this.candles.w, 1, t.grid);
      g.end(t.bg, this.candles);
    }
    return anim;
  }

  paneAt(x: number, y: number): number {
    const inR = (r: Rect) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    return inR(this.ladder) ? PANE_LADDER : inR(this.depth) ? PANE_DEPTH : inR(this.candles) ? PANE_CANDLES : 0;
  }

  private header(r: Rect, title: string, t: Theme): void {
    const g = this.g;
    g.rect(r.x, r.y, r.w, HEADER, t.panel);
    g.rect(r.x, r.y + HEADER - 1, r.w, 1, t.grid);
    g.text(r.x + 8, r.y + (HEADER - g.atlas.cellH) / 2, title, t.dim);
  }

  // ---------------- ladder ----------------
  private drawLadder(v: Float64Array, s: SceneSettings, t: Theme, now: number): boolean {
    const g = this.g;
    const r = this.ladder;
    const ch = g.atlas.cellH;
    const cw = g.atlas.cellW;
    const status = STATUS_NAMES[v[H.status]] ?? '';
    const full = `${s.venueLabel} ${s.pairLabel}  ORDER BOOK`;
    // a narrow ladder drops the "ORDER BOOK" suffix so the title, status and zoom buttons fit
    const fits = 16 + (full.length + status.length + 2) * cw + HEADER_CTRL_W <= r.w;
    this.header(r, fits ? full : `${s.venueLabel} ${s.pairLabel}`, t);
    const stColor = status === 'live' ? t.bid : status === 'error' ? t.ask : t.warn;
    g.textRight(r.x + r.w - 8 - HEADER_CTRL_W, r.y + (HEADER - ch) / 2, status.toUpperCase(), stColor);

    const pd = Math.max(0, Math.min(10, v[H.priceDecimals] | 0));
    const gp = v[H.group];
    const groupDecimals = Math.max(0, Math.min(pd, Math.ceil(-Math.log10(gp) - 1e-9)));
    const qd = Math.min(4, v[H.qtyDecimals] | 0);
    const nb = v[H.nLadBid] | 0;
    const na = v[H.nLadAsk] | 0;
    const rowH = Math.round(ch + (s.ladderRowPad ?? 3));
    const top = r.y + HEADER + 4;
    const colTitles = top;
    g.text(r.x + 8, colTitles, 'PRICE', t.dim);
    g.textRight(r.x + r.w * 0.62, colTitles, 'SIZE', t.dim);
    g.textRight(r.x + r.w - 8, colTitles, 'TOTAL', t.dim);
    const bodyTop = colTitles + rowH + 2;
    // state strip at the bottom: spread, depth, imbalance
    const stripH = rowH * 2 + 8;
    const bodyH = r.y + r.h - bodyTop - stripH;
    const midRowH = rowH + 6;
    const rowsPerSide = Math.max(1, Math.min(LADDER, Math.floor((bodyH - midRowH) / 2 / rowH)));
    const nA = Math.min(na, rowsPerSide);
    const nB = Math.min(nb, rowsPerSide);
    let maxCum = 1e-12;
    if (nA) maxCum = Math.max(maxCum, v[LAD_ASK + (nA - 1) * 3 + 2]);
    if (nB) maxCum = Math.max(maxCum, v[LAD_BID + (nB - 1) * 3 + 2]);

    // flash bookkeeping: rows that changed since the last version light up
    const newVersion = v[H.version] !== this.lastVersion;
    let n = 0;
    for (let i = 0; i < nA; i++) { this.curPx[n] = -v[LAD_ASK + i * 3]; this.curQty[n++] = v[LAD_ASK + i * 3 + 1]; }
    for (let i = 0; i < nB; i++) { this.curPx[n] = v[LAD_BID + i * 3]; this.curQty[n++] = v[LAD_BID + i * 3 + 1]; }
    let anim = false;
    for (let i = 0; i < n; i++) {
      let f = 0;
      let found = false;
      for (let j = 0; j < this.prevN; j++) {
        if (this.prevPx[j] === this.curPx[i]) {
          found = true;
          f = this.prevFlash[j];
          if (newVersion && this.prevQty[j] !== this.curQty[i]) f = now;
          break;
        }
      }
      if (!found && newVersion && this.lastVersion >= 0) f = now;
      this.curFlash[i] = f;
      if (now - f < FLASH_MS) anim = true;
    }
    this.prevPx.set(this.curPx); this.prevQty.set(this.curQty); this.prevFlash.set(this.curFlash);
    this.prevN = n;
    this.lastVersion = v[H.version];

    const sizeX = r.x + r.w * 0.62;
    const totX = r.x + r.w - 8;
    const midY = bodyTop + rowsPerSide * rowH;
    // asks: best ask sits just above the mid row
    for (let i = 0; i < nA; i++) {
      const y = midY - (i + 1) * rowH;
      const o = LAD_ASK + i * 3;
      const bw = (v[o + 2] / maxCum) * r.w;
      g.rect(r.x + r.w - bw, y, bw, rowH - 1, t.askBar);
      const fl = this.curFlash[i];
      if (!s.reducedMotion && now - fl < FLASH_MS) g.rect(r.x, y, r.w, rowH - 1, withAlpha(t.ask, 0.16 * (1 - (now - fl) / FLASH_MS)));
      g.number(r.x + 8 + 12 * cw, y + 1, v[o], groupDecimals, t.ask);
      g.number(sizeX, y + 1, v[o + 1], qd, t.text, false);
      g.number(totX, y + 1, v[o + 2], qd, t.dim, false);
    }
    for (let i = 0; i < nB; i++) {
      const y = midY + midRowH + i * rowH;
      const o = LAD_BID + i * 3;
      const bw = (v[o + 2] / maxCum) * r.w;
      g.rect(r.x + r.w - bw, y, bw, rowH - 1, t.bidBar);
      const fl = this.curFlash[nA + i];
      if (!s.reducedMotion && now - fl < FLASH_MS) g.rect(r.x, y, r.w, rowH - 1, withAlpha(t.bid, 0.16 * (1 - (now - fl) / FLASH_MS)));
      g.number(r.x + 8 + 12 * cw, y + 1, v[o], groupDecimals, t.bid);
      g.number(sizeX, y + 1, v[o + 1], qd, t.text, false);
      g.number(totX, y + 1, v[o + 2], qd, t.dim, false);
    }
    // mid row: last mid and spread
    const bb = v[H.bestBid], ba = v[H.bestAsk];
    g.rect(r.x, midY, r.w, midRowH, t.panel);
    if (bb === bb && ba === ba) {
      const mid = (bb + ba) / 2;
      g.number(r.x + 8 + 12 * cw, midY + 3, mid, pd + 1, t.text);
      const spread = ba - bb;
      g.text(sizeX - 12 * cw, midY + 3, 'SPREAD', t.dim);
      g.number(totX, midY + 3, spread, pd, t.text, false);
    }

    // market state strip: spread in bps, depth within 10 bps, imbalance
    const sy = r.y + r.h - stripH + 4;
    g.rect(r.x, sy - 4, r.w, 1, t.grid);
    if (bb === bb && ba === ba) {
      const mid = (bb + ba) / 2;
      const bps = ((ba - bb) / mid) * 1e4;
      let dB = 0, dA = 0;
      const lim = mid * 0.001; // 10 bps
      const nDB = v[H.nDepBid] | 0, nDA = v[H.nDepAsk] | 0;
      for (let i = 0; i < nDB; i++) { if (mid - v[DEP_BID + i * 2] > lim) break; dB = v[DEP_BID + i * 2 + 1]; }
      for (let i = 0; i < nDA; i++) { if (v[DEP_ASK + i * 2] - mid > lim) break; dA = v[DEP_ASK + i * 2 + 1]; }
      const imb = dB + dA > 0 ? (dB - dA) / (dB + dA) : 0;
      g.text(r.x + 8, sy, 'SPRD BPS', t.dim);
      g.number(r.x + 8 + 15 * cw, sy, bps, 2, t.text, false);
      g.text(r.x + r.w * 0.5, sy, 'IMB', t.dim);
      g.number(r.x + r.w - 8, sy, imb * 100, 1, imb >= 0 ? t.bid : t.ask, false);
      const y2 = sy + rowH;
      g.text(r.x + 8, y2, 'DEPTH 10BP', t.dim);
      g.number(r.x + r.w * 0.5 - 8, y2, dB, 2, t.bid);
      g.number(r.x + r.w - 8, y2, dA, 2, t.ask);
      // imbalance bar
      const bw = r.w - 16;
      const split = bw * (0.5 + imb / 2);
      g.rect(r.x + 8, y2 + rowH - 2, split, 3, t.bid);
      g.rect(r.x + 8 + split, y2 + rowH - 2, bw - split, 3, t.ask);
    }
    return anim;
  }

  // ---------------- depth chart ----------------
  private drawDepth(v: Float64Array, ptr: { x: number; y: number; in: boolean }, s: SceneSettings, t: Theme): void {
    const g = this.g;
    const r = this.depth;
    this.header(r, 'DEPTH', t);
    const bb = v[H.bestBid], ba = v[H.bestAsk];
    if (!(bb === bb && ba === ba)) return;
    const mid = (bb + ba) / 2;
    const nb0 = v[H.nDepBid] | 0, na0 = v[H.nDepAsk] | 0;
    let pct = s.depthRangePct;
    if (!(pct > 0)) {
      // auto: show as far as both sides have data, so neither curve runs flat
      const reach = Math.min(nb0 ? mid - v[DEP_BID + (nb0 - 1) * 2] : 0, na0 ? v[DEP_ASK + (na0 - 1) * 2] - mid : 0);
      pct = Math.max(0.01, Math.min(20, (reach / mid) * 100 * 0.95));
    }
    this.depthPct = pct;
    const lo = mid * (1 - pct / 100);
    const hi = mid * (1 + pct / 100);
    const px = r.x + 8, pw = r.w - 16 - 60;
    const py = r.y + HEADER + 8, ph = r.h - HEADER - 8 - 22;
    const X = (p: number) => px + ((p - lo) / (hi - lo)) * pw;
    const nb = v[H.nDepBid] | 0, na = v[H.nDepAsk] | 0;
    let maxCum = 1e-12;
    for (let i = 0; i < nb; i++) { if (v[DEP_BID + i * 2] < lo) break; maxCum = v[DEP_BID + i * 2 + 1]; }
    let mA = 0;
    for (let i = 0; i < na; i++) { if (v[DEP_ASK + i * 2] > hi) break; mA = v[DEP_ASK + i * 2 + 1]; }
    maxCum = Math.max(maxCum, mA) * 1.08;
    const Y = (c: number) => py + ph - (c / maxCum) * ph;
    const base = py + ph;
    // grid
    for (let k = 1; k <= 4; k++) {
      const gy = py + (ph * k) / 4;
      g.rect(px, gy, pw, 1, t.grid);
      g.number(r.x + r.w - 8, gy - g.atlas.cellH - 1, maxCum * (1 - k / 4), 2, t.dim, false);
    }
    // bids: step area from the mid leftwards
    let prevX = X(bb);
    g.rect(X(mid), py, 1, ph, t.grid);
    for (let i = 0; i < nb; i++) {
      const p = v[DEP_BID + i * 2];
      const c = v[DEP_BID + i * 2 + 1];
      const nextP = i + 1 < nb ? v[DEP_BID + (i + 1) * 2] : lo;
      const x0 = Math.max(px, X(Math.max(nextP, lo)));
      const x1 = i === 0 ? X(p) : prevX;
      const y = Y(c);
      if (x1 > x0) {
        g.rect(x0, y, x1 - x0, base - y, t.bidFill);
        g.rect(x0, y, x1 - x0, 1.5, t.bid);
      }
      prevX = x0;
      if (p < lo) break;
    }
    prevX = X(ba);
    for (let i = 0; i < na; i++) {
      const p = v[DEP_ASK + i * 2];
      const c = v[DEP_ASK + i * 2 + 1];
      const nextP = i + 1 < na ? v[DEP_ASK + (i + 1) * 2] : hi;
      const x0 = i === 0 ? X(p) : prevX;
      const x1 = Math.min(px + pw, X(Math.min(nextP, hi)));
      const y = Y(c);
      if (x1 > x0) {
        g.rect(x0, y, x1 - x0, base - y, t.askFill);
        g.rect(x0, y, x1 - x0, 1.5, t.ask);
      }
      prevX = x1;
      if (p > hi) break;
    }
    // price axis
    for (let k = 0; k <= 4; k++) {
      const p = lo + ((hi - lo) * k) / 4;
      const x = X(p);
      g.number(Math.max(px + 10 * g.atlas.cellW, Math.min(px + pw, x + 30)), base + 4, p, Math.max(0, (v[H.priceDecimals] | 0) - 1), t.dim);
    }
    // hover: cumulative size at the pointer price
    if (ptr.in && ptr.x >= px && ptr.x <= px + pw && ptr.y >= py && ptr.y <= base) {
      const p = lo + ((ptr.x - px) / pw) * (hi - lo);
      let cum = 0;
      let col: RGBA = t.text;
      if (p <= mid) {
        for (let i = 0; i < nb; i++) { if (v[DEP_BID + i * 2] < p) break; cum = v[DEP_BID + i * 2 + 1]; }
        col = t.bid;
      } else {
        for (let i = 0; i < na; i++) { if (v[DEP_ASK + i * 2] > p) break; cum = v[DEP_ASK + i * 2 + 1]; }
        col = t.ask;
      }
      g.rect(ptr.x, py, 1, ph, withAlpha(t.text, 0.4));
      const ty = Y(cum);
      g.rect(px, ty, pw, 1, withAlpha(col, 0.5));
      const bx = Math.min(ptr.x + 8, px + pw - 22 * g.atlas.cellW);
      g.rect(bx, py + 4, 22 * g.atlas.cellW, g.atlas.cellH * 2 + 8, t.panel);
      g.text(bx + 4, py + 6, 'PX', t.dim);
      g.number(bx + 22 * g.atlas.cellW - 4, py + 6, p, v[H.priceDecimals] | 0, t.text);
      g.text(bx + 4, py + 8 + g.atlas.cellH, 'CUM', t.dim);
      g.number(bx + 22 * g.atlas.cellW - 4, py + 8 + g.atlas.cellH, cum, 4, col, false);
    }
  }

  // ---------------- candles + patterns ----------------
  private drawCandles(a: AnalyticsOut | null, v: Float64Array, ptr: { x: number; y: number; in: boolean }, s: SceneSettings, t: Theme): void {
    const g = this.g;
    const r = this.candles;
    this.header(r, 'CANDLES  EMA20  EMA50  PATTERNS', t);
    this.patternBoxes.length = 0;
    if (!a || a.c.length === 0) {
      g.text(r.x + 12, r.y + HEADER + 12, 'waiting for candles...', t.dim);
      return;
    }
    const N = a.c.length;
    const vis = Math.max(20, Math.min(N, s.candlesVisible));
    const first = N - vis;
    const axisW = 70;
    const px = r.x + 8, pw = r.w - 16 - axisW;
    const volH = Math.round((r.h - HEADER) * 0.14);
    const py = r.y + HEADER + 10, ph = r.h - HEADER - 10 - 24 - volH;
    let lo = Infinity, hi = -Infinity, vmax = 0;
    for (let i = first; i < N; i++) {
      if (a.l[i] < lo) lo = a.l[i];
      if (a.h[i] > hi) hi = a.h[i];
      if (a.v[i] > vmax) vmax = a.v[i];
    }
    const pad = (hi - lo) * 0.08 || hi * 0.001;
    lo -= pad; hi += pad;
    const step = pw / vis;
    const bw = Math.max(1, Math.floor(step * 0.7));
    const X = (i: number) => px + (i - first + 0.5) * step;
    const Y = (p: number) => py + ((hi - p) / (hi - lo)) * ph;
    const pd = v[H.priceDecimals] | 0;
    // grid + axis
    for (let k = 0; k <= 5; k++) {
      const p = lo + ((hi - lo) * k) / 5;
      const y = Y(p);
      g.rect(px, y, pw, 1, t.grid);
      g.number(r.x + r.w - 8, y - g.atlas.cellH / 2, p, pd, t.dim, false);
    }
    const volBase = r.y + r.h - 24;
    for (let i = first; i < N; i++) {
      const up = a.c[i] >= a.o[i];
      const col = up ? t.bid : t.ask;
      const x = X(i);
      g.rect(x - 0.5, Y(a.h[i]), 1, Math.max(1, Y(a.l[i]) - Y(a.h[i])), col);
      const y0 = Y(Math.max(a.o[i], a.c[i]));
      const y1 = Y(Math.min(a.o[i], a.c[i]));
      g.rect(x - bw / 2, y0, bw, Math.max(1, y1 - y0), col);
      const vh = vmax > 0 ? (a.v[i] / vmax) * volH : 0;
      g.rect(x - bw / 2, volBase - vh, bw, vh, withAlpha(col, 0.35));
    }
    // EMAs
    for (const [arr, col] of [[a.ema20, t.ema20], [a.ema50, t.ema50]] as const) {
      for (let i = Math.max(first + 1, 1); i < N; i++) {
        if (arr[i - 1] === arr[i - 1] && arr[i] === arr[i]) g.line(X(i - 1), Y(arr[i - 1]), X(i), Y(arr[i]), 1.2, col);
      }
    }
    // live price line from the book
    const bb = v[H.bestBid], ba = v[H.bestAsk];
    if (bb === bb && ba === ba) {
      const m = (bb + ba) / 2;
      if (m > lo && m < hi) {
        g.dashed(px, Y(m), px + pw, Y(m), 1, 3, withAlpha(t.accent, 0.7));
        g.rect(r.x + r.w - axisW + 2, Y(m) - g.atlas.cellH / 2 - 1, axisW - 4, g.atlas.cellH + 2, t.accent);
        g.number(r.x + r.w - 8, Y(m) - g.atlas.cellH / 2, m, pd, t.bg, false);
      }
    }

    // patterns
    let labelRow = 0;
    for (const p of a.patterns) {
      if (p.family === 'chart' ? !s.showChartPatterns : !s.showCandlePatterns) continue;
      if (p.end < first) continue;
      const sel = s.selectedPattern === p.id;
      const col = p.bias > 0 ? t.bull : p.bias < 0 ? t.bear : t.neutral;
      if (p.family !== 'chart') {
        // only directional signals get a marker; neutral ones (doji, NR4,
        // inside bars) stay in the list unless selected, to keep the chart readable
        if (p.bias === 0 && !sel) continue;
        if (p.family === 'volatility' && !sel) continue;
        // marker above/below the bar
        const i = p.end;
        const x = X(i);
        const below = p.bias > 0;
        const y = below ? Y(a.l[i]) + 6 : Y(a.h[i]) - 6;
        const d = below ? 6 : -6;
        g.tri(x, y, x - 4, y + d, x + 4, y + d, sel ? t.accent : col);
        if (sel || vis <= 120) {
          const lbl = p.label;
          const ly = below ? y + d + 2 : y + d - g.atlas.cellH - 2;
          g.text(x - (lbl.length * g.atlas.cellW) / 2, ly, lbl, withAlpha(col, 0.9));
        }
        continue;
      }
      const alpha = sel ? 1 : p.status === 'failed' ? 0.35 : 0.8;
      const c2 = withAlpha(col, alpha);
      for (const [p0, p1] of p.lines) g.line(X(Math.max(first, p0.i)), Y(p0.p), X(p1.i), Y(p1.p), sel ? 2 : 1.5, c2);
      for (let k = 1; k < p.pivots.length; k++) {
        const q0 = p.pivots[k - 1], q1 = p.pivots[k];
        if (q1.i < first) continue;
        g.dashed(X(Math.max(first, q0.i)), Y(q0.p), X(q1.i), Y(q1.p), 1, 3, withAlpha(col, alpha * 0.6));
      }
      if (p.target !== undefined && (sel || p.status === 'confirmed')) {
        const ty = Y(p.target);
        if (ty > py && ty < py + ph) {
          g.dashed(X(p.end), ty, px + pw, ty, 1.2, 5, c2);
          g.text(px + pw - 7 * g.atlas.cellW, ty - g.atlas.cellH - 1, 'TARGET', c2);
        }
      }
      if (p.breakout) {
        const bx = X(p.breakout.i), by = Y(p.breakout.p);
        g.rect(bx - 3, by - 3, 6, 6, c2);
      }
      // label at the start of the pattern
      const lx = Math.max(px, X(p.start));
      const lbl = `${p.label} ${p.status === 'confirmed' ? '+' : p.status === 'failed' ? 'x' : '~'}`;
      const ly = py + 2 + (labelRow++ % 6) * (g.atlas.cellH + 3);
      const lw = lbl.length * g.atlas.cellW + 8;
      g.rect(lx, ly, lw, g.atlas.cellH + 2, withAlpha(sel ? t.accent : col, sel ? 0.9 : 0.25));
      g.text(lx + 4, ly + 1, lbl, sel ? t.bg : t.text);
      this.patternBoxes.push({ id: p.id, x: lx, y: ly, w: lw, h: g.atlas.cellH + 2 });
    }

    // crosshair + OHLC readout
    if (ptr.in && ptr.x >= px && ptr.x <= px + pw && ptr.y >= py && ptr.y <= volBase) {
      const i = Math.min(N - 1, Math.max(first, first + Math.floor((ptr.x - px) / step)));
      g.rect(X(i), py, 1, volBase - py, withAlpha(t.text, 0.3));
      g.rect(px, ptr.y, pw, 1, withAlpha(t.text, 0.3));
      const y = r.y + HEADER + 2;
      let x = r.x + r.w - axisW - 8 - 60 * g.atlas.cellW;
      g.rect(x - 4, y - 1, 60 * g.atlas.cellW + 8, g.atlas.cellH + 2, t.panel);
      const up = a.c[i] >= a.o[i] ? t.bid : t.ask;
      const cw = g.atlas.cellW;
      const fields = [a.o[i], a.h[i], a.l[i], a.c[i]];
      const names = 'OHLC';
      for (let k = 0; k < 4; k++) {
        g.glyph(x, y, names.charCodeAt(k), t.dim);
        g.number(x + 14 * cw, y, fields[k], pd, up);
        x += 15 * cw;
      }
    }
  }
}

export type { PatternHit };
