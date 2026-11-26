import { Gfx, withAlpha, type RGBA } from './gl';
import type { Theme } from './theme';
import { H, LAD_BID, LAD_ASK, DEP_BID, DEP_ASK, LADDER, STATUS_NAMES } from '../shared/view';
import type { AnalyticsOut, PatternHit } from '../patterns/types';
import { lowerBound, type AnalysisWindow } from '../patterns/window';
import { LiqView } from './liq';
import { drawPriceIndicators, drawSubPane, drawVolume, indColor, subPaneHeight, type XMap } from './indicators';
import type { IndOut } from '../indicators/spec';
import { computeLayout, DEFAULT_LAYOUT, type LayoutPrefs, type Rect } from './layout';

export interface SceneSettings {
  depthRangePct: number; // half-width of the depth chart around the mid, percent
  candlesVisible: number;
  /** vertical zoom of the candle chart: 1 = fit the visible candles, >1 = zoomed in */
  candlesPriceScale?: number;
  /** candles scrolled back from the newest, in bars (0 = following live) */
  candlesOffset?: number;
  /** vertical pan of the candle chart, in visible price ranges (0 = centred on the fit) */
  candlesPricePan?: number;
  /** horizontal pan of the depth chart's centre away from the mid, percent */
  depthShiftPct?: number;
  /** extra px between ladder rows on top of the text height: the ladder's zoom */
  ladderRowPad?: number;
  reducedMotion: boolean;
  showChartPatterns: boolean;
  showCandlePatterns: boolean;
  selectedPattern: string | null;
  /** the box patterns are searched in, drawn over the candles */
  analysisWindow?: AnalysisWindow | null;
  /** liquidation level bands behind the candles (default on) */
  showLiquidations?: boolean;
  venueLabel: string;
  pairLabel: string;
  /** candle size, e.g. "15m" or "1D", for the pane header */
  intervalLabel?: string;
  /** candle size in minutes (43200 = calendar month), for the close countdown */
  intervalMin?: number;
}


const FLASH_MS = 400;
export const PANE_LADDER = 1, PANE_DEPTH = 2, PANE_CANDLES = 4, PANE_ALL = 7;
const HEADER = 22;
/** px kept free at the right of each pane header for the zoom buttons drawn over it */
export const HEADER_CTRL_W = 92;
/** candle chart price axis width and time strip height, css px (the page puts drag handles on them) */
export const CANDLE_AXIS_W = 70, CANDLE_TIME_H = 18, PANE_HEADER = HEADER;
/** px of the candle header taken by the page's indicators / window / explain buttons */
export const CANDLE_TOOLS_W = 320;

/**
 * Where things sit inside the candle pane: price plot, the time strip right
 * under it, volume, then one pane per oscillator indicator (`nSub`). Shared with
 * the page, which puts the axis handles on it.
 */
export function candleGeom(r: Rect, nSub = 0, vol = true) {
  const axisW = CANDLE_AXIS_W;
  const subH = subPaneHeight(r.h - HEADER - 10 - CANDLE_TIME_H - 6, nSub);
  const volH = vol ? Math.round((r.h - HEADER - subH * nSub) * 0.14) : 0;
  const px = r.x + 8, pw = r.w - 16 - axisW;
  const py = r.y + HEADER + 10;
  const ph = Math.max(10, r.h - HEADER - 10 - CANDLE_TIME_H - volH - 6 - subH * nSub);
  const volBase = py + ph + CANDLE_TIME_H + 2 + volH;
  const subY = volBase + 2;
  return { axisW, volH, px, pw, py, ph, timeY: py + ph, volBase, subY, subH, bottom: subY + subH * nSub };
}
/** The depth chart's price axis strip at the bottom of its pane, css px tall. */
export const DEPTH_AXIS_H = 22;

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
  /** candle price plot and axis width, for the axis drag handles */
  candlePlot: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** hit boxes of pattern labels, for clicks */
  patternBoxes: { id: string; x: number; y: number; w: number; h: number }[] = [];
  /** the box being dragged on the candle chart, in px */
  brush: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** candle chart mapping from the last frame, to turn a dragged box into times and prices */
  private cmap: { first: number; N: number; step: number; px: number; pw: number; py: number; ph: number; lo: number; hi: number; t: Float64Array } | null = null;
  /** liquidation levels, fed by the render worker */
  readonly liq = new LiqView();
  private subRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** mid of the last ladder frame and which way it last moved (+1 up, -1 down) */
  private lastMid = NaN;
  private midDir = 0;
  /** the "back to live" button drawn when the candles are scrolled back (null: following live) */
  liveBox: Rect | null = null;
  /** the ladder flushed itself to draw its hover card over the text (the caller must not clear again) */
  private ladderCleared = false;
  /** column titles with the pair's units, rebuilt only when the pair changes */
  private unitsFor = '';
  private colPrice = 'PRICE';
  private colSize = 'SIZE';
  private colTotal = 'TOTAL';

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
      this.ladderCleared = false;
      anim = this.drawLadder(v, ptr, s, t, now);
      g.end(t.bg, this.ladder, !this.ladderCleared);
    }
    if (dirty & PANE_DEPTH) {
      g.begin();
      this.drawDepth(v, ptr, s, t);
      g.rect(this.depth.x, this.depth.y, 1, this.depth.h, t.grid);
      g.end(t.bg, this.depth);
    }
    if (dirty & PANE_CANDLES) {
      g.begin();
      const cleared = this.drawCandles(a, v, ptr, s, t);
      g.rect(this.candles.x, this.candles.y, 1, this.candles.h, t.grid);
      g.rect(this.candles.x, this.candles.y, this.candles.w, 1, t.grid);
      g.end(t.bg, this.candles, !cleared);
    }
    return anim;
  }

  /** Time labels in the strip under the price plot, about one per 90 px. */
  private timeAxis(times: Float64Array, first: number, end: number, X: (i: number) => number, px: number, pw: number, y: number, t: Theme): void {
    const g = this.g;
    g.rect(px, y, pw, 1, t.grid);
    const n = end - first;
    if (n < 2) return;
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 90))));
    const span = times[end - 1] - times[first];
    const long = span > 36 * 3600e3; // more than a day and a half: show the date too
    const ty = y + (CANDLE_TIME_H - g.atlas.cellH) / 2;
    for (let i = end - 1; i >= first; i -= every) {
      const d = new Date(times[i]);
      const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const lbl = long ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}` : hm;
      const x = X(i) - (lbl.length * g.atlas.cellW) / 2;
      if (x < px || x + lbl.length * g.atlas.cellW > px + pw) continue;
      g.rect(X(i), y, 1, 3, t.grid);
      g.text(x, ty, lbl, t.dim);
    }
  }

  /** Bar width in px and price plot height of the last candle draw, for scroll panning. */
  candleScroll(): { step: number; ph: number; pw: number; n: number } | null {
    const m = this.cmap;
    return m ? { step: m.step, ph: m.ph, pw: m.pw, n: m.t.length } : null;
  }

  /** Turn a box dragged in px into candle times and prices, or null if it spans fewer than 3 candles. */
  windowFromPx(x0: number, y0: number, x1: number, y1: number): AnalysisWindow | null {
    const m = this.cmap;
    if (!m || m.N === 0) return null;
    const idx = (x: number) => Math.min(m.N - 1, Math.max(0, m.first + Math.floor((x - m.px) / m.step)));
    const pr = (y: number) => m.hi - ((Math.min(m.py + m.ph, Math.max(m.py, y)) - m.py) / m.ph) * (m.hi - m.lo);
    const i0 = idx(Math.min(x0, x1)), i1 = idx(Math.max(x0, x1));
    if (i1 - i0 < 2) return null;
    return { t0: m.t[i0], t1: m.t[i1], p0: pr(Math.max(y0, y1)), p1: pr(Math.min(y0, y1)) };
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
  private drawLadder(v: Float64Array, ptr: { x: number; y: number; in: boolean }, s: SceneSettings, t: Theme, now: number): boolean {
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
    if (this.unitsFor !== s.pairLabel) {
      // "PRICE USD  SIZE BTC  TOTAL BTC", as on exchange books; plain titles when the pair has no units
      this.unitsFor = s.pairLabel;
      const [base, quote] = s.pairLabel.split('/');
      this.colPrice = quote ? `PRICE ${quote}` : 'PRICE';
      this.colSize = base ? `SIZE ${base}` : 'SIZE';
      this.colTotal = base ? `TOTAL ${base}` : 'TOTAL';
    }
    const wide = r.w > (this.colPrice.length + this.colSize.length + this.colTotal.length + 8) * cw;
    g.text(r.x + 8, colTitles, wide ? this.colPrice : 'PRICE', t.dim);
    g.textRight(r.x + r.w * 0.62, colTitles, wide ? this.colSize : 'SIZE', t.dim);
    g.textRight(r.x + r.w - 8, colTitles, wide ? this.colTotal : 'TOTAL', t.dim);
    const bodyTop = colTitles + rowH + 2;
    // state strip at the bottom: spread, depth, imbalance
    const stripH = rowH * 3 + 8;
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
    // walls: levels at least 3x the average visible size get a marker and a stronger size colour
    let qSum = 0;
    for (let i = 0; i < nA; i++) qSum += v[LAD_ASK + i * 3 + 1];
    for (let i = 0; i < nB; i++) qSum += v[LAD_BID + i * 3 + 1];
    const wall = nA + nB > 4 ? (qSum / (nA + nB)) * 3 : Infinity;
    // hovered row: -(i+1) for asks, i+1 for bids, 0 for none
    let hov = 0;
    if (ptr.in && ptr.x >= r.x && ptr.x < r.x + r.w) {
      if (ptr.y < midY && ptr.y >= midY - nA * rowH) hov = -(Math.floor((midY - ptr.y) / rowH) + 1);
      else if (ptr.y >= midY + midRowH && ptr.y < midY + midRowH + nB * rowH) hov = Math.floor((ptr.y - midY - midRowH) / rowH) + 1;
    }
    // asks: best ask sits just above the mid row
    for (let i = 0; i < nA; i++) {
      const y = midY - (i + 1) * rowH;
      const o = LAD_ASK + i * 3;
      const bw = (v[o + 2] / maxCum) * r.w;
      g.rect(r.x + r.w - bw, y, bw, rowH - 1, t.askBar);
      const fl = this.curFlash[i];
      if (!s.reducedMotion && now - fl < FLASH_MS) g.rect(r.x, y, r.w, rowH - 1, withAlpha(t.ask, 0.16 * (1 - (now - fl) / FLASH_MS)));
      // hovered row and every row between it and the touch: the levels a market order would take
      if (hov < 0 && i < -hov) g.rect(r.x, y, r.w, rowH - 1, withAlpha(t.text, i === -hov - 1 ? 0.1 : 0.04));
      const isWall = v[o + 1] >= wall;
      if (isWall) g.rect(r.x, y, 3, rowH - 1, t.ask);
      g.number(r.x + 8 + 12 * cw, y + 1, v[o], groupDecimals, t.ask);
      g.number(sizeX, y + 1, v[o + 1], qd, isWall ? t.warn : t.text, false);
      g.number(totX, y + 1, v[o + 2], qd, t.dim, false);
    }
    for (let i = 0; i < nB; i++) {
      const y = midY + midRowH + i * rowH;
      const o = LAD_BID + i * 3;
      const bw = (v[o + 2] / maxCum) * r.w;
      g.rect(r.x + r.w - bw, y, bw, rowH - 1, t.bidBar);
      const fl = this.curFlash[nA + i];
      if (!s.reducedMotion && now - fl < FLASH_MS) g.rect(r.x, y, r.w, rowH - 1, withAlpha(t.bid, 0.16 * (1 - (now - fl) / FLASH_MS)));
      if (hov > 0 && i < hov) g.rect(r.x, y, r.w, rowH - 1, withAlpha(t.text, i === hov - 1 ? 0.1 : 0.04));
      const isWall = v[o + 1] >= wall;
      if (isWall) g.rect(r.x, y, 3, rowH - 1, t.bid);
      g.number(r.x + 8 + 12 * cw, y + 1, v[o], groupDecimals, t.bid);
      g.number(sizeX, y + 1, v[o + 1], qd, isWall ? t.warn : t.text, false);
      g.number(totX, y + 1, v[o + 2], qd, t.dim, false);
    }
    // mid row: last mid and spread
    const bb = v[H.bestBid], ba = v[H.bestAsk];
    g.rect(r.x, midY, r.w, midRowH, t.panel);
    if (bb === bb && ba === ba) {
      const mid = (bb + ba) / 2;
      // the mid takes the colour and arrow of its last move, as an exchange's last price does
      if (this.lastMid === this.lastMid && mid !== this.lastMid) this.midDir = mid > this.lastMid ? 1 : -1;
      if (this.unitsFor !== s.pairLabel) this.midDir = 0;
      this.lastMid = mid;
      const mc = this.midDir > 0 ? t.bid : this.midDir < 0 ? t.ask : t.text;
      g.number(r.x + 8 + 12 * cw, midY + 3, mid, pd + 1, mc);
      const ax = r.x + 8 + 12 * cw + 6, ay = midY + 3 + ch / 2;
      if (this.midDir > 0) g.tri(ax, ay + 3, ax + 8, ay + 3, ax + 4, ay - 3, mc);
      else if (this.midDir < 0) g.tri(ax, ay - 3, ax + 8, ay - 3, ax + 4, ay + 3, mc);
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
      // buy / sell share of the depth within 10 bps, labelled on the bar
      const bPct = dB + dA > 0 ? (dB / (dB + dA)) * 100 : 50;
      const yb = sy + rowH * 2 + 2;
      g.text(r.x + 8, yb, 'B', t.bid);
      g.number(r.x + 8 + 6 * cw, yb, bPct, 0, t.bid, false);
      g.text(r.x + 8 + 6 * cw, yb, '%', t.bid);
      g.text(r.x + r.w - 8 - cw, yb, 'S', t.ask);
      g.number(r.x + r.w - 8 - 3 * cw, yb, 100 - bPct, 0, t.ask, false);
      g.text(r.x + r.w - 8 - 3 * cw, yb, '%', t.ask);
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
    // hover: what filling from the touch to this row costs (average price, size, value)
    if (hov !== 0) {
      // own pass: text is drawn after shapes within a pass, so the card needs a fresh one to cover the rows
      g.end(t.bg, r);
      g.begin();
      this.ladderCleared = true;
      const k = Math.abs(hov), base = hov < 0 ? LAD_ASK : LAD_BID;
      let q = 0, val = 0;
      for (let i = 0; i < k; i++) { const qi = v[base + i * 3 + 1]; q += qi; val += qi * v[base + i * 3]; }
      const rowY = hov < 0 ? midY - k * rowH : midY + midRowH + (k - 1) * rowH;
      const tw = 24 * cw, th = ch * 3 + 10;
      const tx = r.x + r.w - tw - 8;
      const ty = Math.max(r.y + HEADER + 2, Math.min(r.y + r.h - th - 2, hov < 0 ? rowY - th - 2 : rowY + rowH + 2));
      const col = hov < 0 ? t.ask : t.bid;
      g.rect(tx, ty, tw, th, t.panel);
      g.rect(tx, ty, 2, th, col);
      g.text(tx + 8, ty + 4, 'AVG PX', t.dim);
      g.number(tx + tw - 6, ty + 4, q > 0 ? val / q : 0, pd + 1, t.text);
      g.text(tx + 8, ty + 6 + ch, 'SUM', t.dim);
      g.number(tx + tw - 6, ty + 6 + ch, q, qd, col, false);
      g.text(tx + 8, ty + 8 + ch * 2, 'VALUE', t.dim);
      g.number(tx + tw - 6, ty + 8 + ch * 2, val, val >= 100 ? 0 : 2, t.text);
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
    {
      // header readout: mid and spread in bps, so the depth pane stands on its own
      const cw = g.atlas.cellW, hy = r.y + (HEADER - g.atlas.cellH) / 2;
      let hx = r.x + 8 + 7 * cw;
      if (r.w > 44 * cw + HEADER_CTRL_W) {
        hx += g.text(hx, hy, 'MID', t.dim) + cw;
        const midW = 14 * cw;
        g.number(hx + midW, hy, mid, (v[H.priceDecimals] | 0) + 1, t.text);
        hx += midW + 2 * cw;
        hx += g.text(hx, hy, 'SPRD', t.dim) + cw;
        g.number(hx + 6 * cw, hy, ((ba - bb) / mid) * 1e4, 2, t.text, false);
        g.text(hx + 6 * cw + cw / 2, hy, 'BP', t.dim);
      }
    }
    const nb0 = v[H.nDepBid] | 0, na0 = v[H.nDepAsk] | 0;
    let pct = s.depthRangePct;
    if (!(pct > 0)) {
      // auto: show as far as both sides have data, so neither curve runs flat
      const reach = Math.min(nb0 ? mid - v[DEP_BID + (nb0 - 1) * 2] : 0, na0 ? v[DEP_ASK + (na0 - 1) * 2] - mid : 0);
      pct = Math.max(0.01, Math.min(20, (reach / mid) * 100 * 0.95));
    }
    this.depthPct = pct;
    const ctr = mid * (1 + (s.depthShiftPct ?? 0) / 100);
    const lo = ctr - mid * pct / 100;
    const hi = ctr + mid * pct / 100;
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
      // price, cumulative size, its rough value and distance from the mid
      const cw = g.atlas.cellW, ch = g.atlas.cellH, bwid = 24 * cw;
      const bx = ptr.x + 12 + bwid < px + pw ? ptr.x + 12 : ptr.x - 12 - bwid;
      g.rect(bx, py + 4, bwid, ch * 4 + 14, t.panel);
      g.rect(bx, py + 4, 2, ch * 4 + 14, col);
      g.text(bx + 8, py + 7, 'PRICE', t.dim);
      g.number(bx + bwid - 6, py + 7, p, v[H.priceDecimals] | 0, t.text);
      g.text(bx + 8, py + 9 + ch, 'SUM', t.dim);
      g.number(bx + bwid - 6, py + 9 + ch, cum, 4, col, false);
      g.text(bx + 8, py + 11 + ch * 2, 'VALUE', t.dim);
      g.number(bx + bwid - 6, py + 11 + ch * 2, cum * p, 0, t.text);
      g.text(bx + 8, py + 13 + ch * 3, 'FROM MID', t.dim);
      g.text(bx + bwid - 6 - cw, py + 13 + ch * 3, '%', t.dim);
      g.number(bx + bwid - 6 - cw, py + 13 + ch * 3, ((p - mid) / mid) * 100, 2, p >= mid ? t.ask : t.bid, false);
    }
  }

  /** dashed outline of a box */
  private frame(x0: number, y0: number, x1: number, y1: number, col: RGBA): void {
    const g = this.g;
    g.dashed(x0, y0, x1, y0, 1, 4, col);
    g.dashed(x0, y1, x1, y1, 1, 4, col);
    g.dashed(x0, y0, x0, y1, 1, 4, col);
    g.dashed(x1, y0, x1, y1, 1, 4, col);
  }

  // ---------------- candles + patterns ----------------
  /** "CANDLES 15m" then the overlays in their colours, as far as they fit before the header buttons */
  private candleHeader(a: AnalyticsOut | null, s: SceneSettings, t: Theme): void {
    const g = this.g, r = this.candles, cw = g.atlas.cellW;
    this.header(r, 'CANDLES', t);
    const y = r.y + (HEADER - g.atlas.cellH) / 2;
    let x = r.x + 8 + 8 * cw;
    if (s.intervalLabel) x += g.text(x, y, s.intervalLabel, t.text) + 2 * cw;
    const end = r.x + r.w - HEADER_CTRL_W - CANDLE_TOOLS_W - 8;
    for (const ind of a?.ind ?? []) {
      if (ind.pane === 'sub') continue;
      if (x + ind.label.length * cw > end) { if (x + 3 * cw <= end) g.text(x, y, '...', t.dim); break; }
      x += g.text(x, y, ind.label, ind.pane === 'volume' ? t.dim : indColor(t, ind)) + 2 * cw;
    }
  }

  /**
   * Drawn in three passes so a vertical zoom can't spill price content over
   * the header, axis or volume: frame (clears the pane), price content
   * (scissored to the plot, no clear), crosshair (no clear). Returns true once
   * the pane has been cleared, so the caller's final flush must not clear it.
   */
  private drawCandles(a: AnalyticsOut | null, v: Float64Array, ptr: { x: number; y: number; in: boolean }, s: SceneSettings, t: Theme): boolean {
    const g = this.g;
    const r = this.candles;
    this.candleHeader(a, s, t);
    this.patternBoxes.length = 0;
    if (!a || a.c.length === 0) {
      g.text(r.x + 12, r.y + HEADER + 12, 'waiting for candles...', t.dim);
      return false;
    }
    const N = a.c.length;
    const vis = Math.max(Math.min(20, N), Math.min(N, Math.round(s.candlesVisible)));
    // scrolled back: the view ends `off` bars before the newest
    const off = Math.max(0, Math.min(N - vis, Math.round(s.candlesOffset ?? 0)));
    const end = N - off;
    const first = end - vis;
    const ind = a.ind ?? [];
    let nSub = 0, vol: IndOut | null = null;
    for (const x of ind) { if (x.pane === 'sub') nSub++; else if (x.pane === 'volume') vol = x; }
    const { axisW, volH, px, pw, py, ph, timeY, volBase, subY, subH, bottom } = candleGeom(r, nSub, !!vol);
    let lo = Infinity, hi = -Infinity;
    for (let i = first; i < end; i++) {
      if (a.l[i] < lo) lo = a.l[i];
      if (a.h[i] > hi) hi = a.h[i];
    }
    const pad = (hi - lo) * 0.08 || hi * 0.001;
    lo -= pad; hi += pad;
    const ys = s.candlesPriceScale ?? 1;
    const pan = s.candlesPricePan ?? 0;
    if ((ys !== 1 && ys > 0) || pan) {
      // scale about the middle of the fitted range, then pan by whole view heights
      const half = (hi - lo) / 2 / (ys > 0 ? ys : 1);
      const c = (lo + hi) / 2 + pan * 2 * half;
      lo = c - half; hi = c + half;
    }
    this.candlePlot.x = r.x + 1; this.candlePlot.y = py; this.candlePlot.w = r.w - axisW - 1; this.candlePlot.h = ph;
    const step = pw / vis;
    const bw = Math.max(1, Math.floor(step * 0.7));
    const X = (i: number) => px + (i - first + 0.5) * step;
    const Y = (p: number) => py + ((hi - p) / (hi - lo)) * ph;
    const pd = v[H.priceDecimals] | 0;
    const xm: XMap = { first, N: end, step, bw, X };
    const inChart = ptr.in && ptr.x >= px && ptr.x <= px + pw && ptr.y >= py && ptr.y <= bottom;
    const hover = inChart ? Math.min(end - 1, Math.max(first, first + Math.floor((ptr.x - px) / step))) : -1;
    this.cmap = { first, N: end, step, px, pw, py, ph, lo, hi, t: a.t };
    // grid + axis
    for (let k = 0; k <= 5; k++) {
      const p = lo + ((hi - lo) * k) / 5;
      const y = Y(p);
      g.rect(px, y, pw, 1, t.grid);
      g.number(r.x + r.w - 8, y - g.atlas.cellH / 2, p, pd, t.dim, false);
    }
    if (s.showLiquidations !== false) this.liq.draw(g, a, first, end, step, X, Y, lo, hi, py, ph, px + pw - 4, t);
    this.timeAxis(a.t, first, end, X, px, pw, timeY, t);
    if (vol) drawVolume(g, vol, a.o, a.c, a.v, xm, volBase - volH, volH, t);
    let sy = subY;
    for (const x of ind) {
      if (x.pane !== 'sub') continue;
      this.subRect.x = px; this.subRect.y = sy; this.subRect.w = pw; this.subRect.h = subH;
      drawSubPane(g, x, this.subRect, r.x + r.w - 8, xm, hover, t);
      sy += subH;
    }
    // live price tag on the axis (the dashed line is drawn with the price content)
    const bb = v[H.bestBid], ba = v[H.bestAsk];
    const m = (bb + ba) / 2;
    const showMid = bb === bb && ba === ba && m > lo && m < hi;
    // the tag takes the colour of the forming candle, and the time left until it closes sits under it
    const lastUp = a.c[N - 1] >= a.o[N - 1];
    const tagCol = lastUp ? t.bid : t.ask;
    if (showMid) {
      const ch = g.atlas.cellH;
      g.rect(r.x + r.w - axisW + 2, Y(m) - ch / 2 - 1, axisW - 4, ch + 2, tagCol);
      g.number(r.x + r.w - 8, Y(m) - ch / 2, m, pd, t.bg, false);
      const left = closeIn(a.t[N - 1], s.intervalMin ?? 0, Date.now());
      if (left > 0 && Y(m) + ch * 2 + 4 < py + ph) {
        g.rect(r.x + r.w - axisW + 2, Y(m) + ch / 2 + 1, axisW - 4, ch + 2, withAlpha(tagCol, 0.75));
        g.textRight(r.x + r.w - 8, Y(m) + ch / 2 + 2, countdown(left), t.bg);
      }
    }
    g.rect(r.x, r.y, 1, r.h, t.grid);
    g.rect(r.x, r.y, r.w, 1, t.grid);
    g.end(t.bg, r);

    // ---- price content, clipped to the plot ----
    g.begin();
    for (let i = first; i < end; i++) {
      const col = a.c[i] >= a.o[i] ? t.bid : t.ask;
      const x = X(i);
      g.rect(x - 0.5, Y(a.h[i]), 1, Math.max(1, Y(a.l[i]) - Y(a.h[i])), col);
      const y0 = Y(Math.max(a.o[i], a.c[i]));
      const y1 = Y(Math.min(a.o[i], a.c[i]));
      g.rect(x - bw / 2, y0, bw, Math.max(1, y1 - y0), col);
    }
    drawPriceIndicators(g, ind, xm, Y, t);
    // live price line from the book
    if (showMid) g.dashed(px, Y(m), px + pw, Y(m), 1, 3, withAlpha(tagCol, 0.7));

    // analysis window: patterns are only searched inside it
    const w = s.analysisWindow;
    let labelTop = py + g.atlas.cellH + 8; // pattern labels stack from here (under the legend), or from the window's top
    if (w) {
      const i0 = lowerBound(a.t, Math.min(w.t0, w.t1)), i1 = lowerBound(a.t, Math.max(w.t0, w.t1) + 1) - 1;
      const x0 = Math.max(px, X(i0) - step / 2), x1 = Math.min(px + pw, X(i1) + step / 2);
      const y0 = Math.max(py, Y(Math.max(w.p0, w.p1))), y1 = Math.min(py + ph, Y(Math.min(w.p0, w.p1)));
      if (x1 > x0 && y1 > y0) {
        labelTop = Math.max(labelTop, y0 + 2);
        g.rect(x0, y0, x1 - x0, y1 - y0, withAlpha(t.accent, 0.07));
        this.frame(x0, y0, x1, y1, withAlpha(t.accent, 0.8));
        const lbl = `WINDOW  ${a.patterns.length} PATTERN${a.patterns.length === 1 ? '' : 'S'}`;
        if (x1 - x0 > lbl.length * g.atlas.cellW + 8) g.text(x0 + 4, y1 - g.atlas.cellH - 3, lbl, t.accent);
      }
    }
    const b = this.brush;
    if (b) {
      const x0 = Math.max(px, Math.min(b.x0, b.x1)), x1 = Math.min(px + pw, Math.max(b.x0, b.x1));
      const y0 = Math.max(py, Math.min(b.y0, b.y1)), y1 = Math.min(py + ph, Math.max(b.y0, b.y1));
      if (x1 > x0 && y1 > y0) {
        g.rect(x0, y0, x1 - x0, y1 - y0, withAlpha(t.accent, 0.12));
        this.frame(x0, y0, x1, y1, t.accent);
      }
    }

    // patterns; with one selected, the others fade and the selected one is
    // drawn last, over a band marking the bars it spans, even if its family is hidden
    let labelRow = 0;
    const selP = s.selectedPattern ? a.patterns.find((p) => p.id === s.selectedPattern) ?? null : null;
    if (selP && selP.end >= first && selP.start < end) {
      const x0 = Math.max(px, X(Math.max(first, selP.start)) - step / 2);
      const x1 = Math.min(px + pw, X(Math.min(end - 1, Math.max(selP.end, selP.breakout?.i ?? 0))) + step / 2);
      g.rect(x0, py, x1 - x0, ph, withAlpha(t.accent, 0.1));
      g.rect(x0, py, 1, ph, withAlpha(t.accent, 0.5));
      g.rect(x1 - 1, py, 1, ph, withAlpha(t.accent, 0.5));
    }
    const order = selP ? [...a.patterns.filter((p) => p !== selP), selP] : a.patterns;
    for (const p of order) {
      const sel = p === selP;
      if (!sel && (p.family === 'chart' ? !s.showChartPatterns : !s.showCandlePatterns)) continue;
      if (p.end < first || p.start >= end) continue;
      const fade = selP && !sel ? 0.3 : 1;
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
        if (sel) {
          // every bar of the signal gets a marker, the last one larger
          for (let j = Math.max(first, p.start); j < p.end; j++) {
            const xj = X(j), yj = below ? Y(a.l[j]) + 6 : Y(a.h[j]) - 6;
            g.tri(xj, yj, xj - 3, yj + d * 0.7, xj + 3, yj + d * 0.7, t.accent);
          }
          g.tri(x, y, x - 6, y + d * 1.5, x + 6, y + d * 1.5, t.accent);
        } else g.tri(x, y, x - 4, y + d, x + 4, y + d, withAlpha(col, fade));
        if (sel || (!selP && vis <= 120)) {
          const lbl = p.label;
          const dd = sel ? d * 1.5 : d;
          const ly = below ? y + dd + 2 : y + dd - g.atlas.cellH - 2;
          const lx = x - (lbl.length * g.atlas.cellW) / 2;
          if (sel) {
            g.rect(lx - 4, ly - 1, lbl.length * g.atlas.cellW + 8, g.atlas.cellH + 2, withAlpha(t.accent, 0.9));
            g.text(lx, ly, lbl, t.bg);
          } else g.text(lx, ly, lbl, withAlpha(col, 0.9 * fade));
        }
        continue;
      }
      const alpha = (sel ? 1 : p.status === 'failed' ? 0.35 : 0.8) * fade;
      const c2 = withAlpha(col, alpha);
      for (const [p0, p1] of p.lines) g.line(X(Math.max(first, p0.i)), Y(p0.p), X(p1.i), Y(p1.p), sel ? 2.5 : 1.5, c2);
      for (let k = 1; k < p.pivots.length; k++) {
        const q0 = p.pivots[k - 1], q1 = p.pivots[k];
        if (q1.i < first) continue;
        g.dashed(X(Math.max(first, q0.i)), Y(q0.p), X(q1.i), Y(q1.p), sel ? 1.5 : 1, 3, withAlpha(col, sel ? 0.9 : alpha * 0.6));
      }
      if (sel) {
        // the pivots that define the pattern, as rings
        for (const q of p.pivots) {
          if (q.i < first || q.i >= end) continue;
          const qx = X(q.i), qy = Y(q.p);
          g.rect(qx - 4, qy - 4, 8, 8, t.accent);
          g.rect(qx - 2, qy - 2, 4, 4, t.bg);
        }
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
      const ly = labelTop + (labelRow++ % 6) * (g.atlas.cellH + 3);
      const lw = lbl.length * g.atlas.cellW + 8;
      g.rect(lx, ly, lw, g.atlas.cellH + 2, sel ? withAlpha(t.accent, 0.9) : withAlpha(col, 0.25 * fade));
      g.text(lx + 4, ly + 1, lbl, sel ? t.bg : withAlpha(t.text, fade));
      this.patternBoxes.push({ id: p.id, x: lx, y: ly, w: lw, h: g.atlas.cellH + 2 });
    }

    g.end(t.bg, this.candlePlot, false);

    // ---- crosshair, axis labels, legend and the back-to-live button, over everything ----
    g.begin();
    const cw = g.atlas.cellW, ch = g.atlas.cellH;
    if (hover >= 0) {
      const i = hover;
      const line = withAlpha(t.text, 0.3);
      g.rect(X(i), py, 1, bottom - py, line);
      g.rect(px, ptr.y, pw, 1, line);
      const lab = withAlpha(t.text, 0.85);
      // price under the pointer on the price axis
      if (ptr.y >= py && ptr.y <= py + ph) {
        g.rect(r.x + r.w - axisW + 2, ptr.y - ch / 2 - 1, axisW - 4, ch + 2, lab);
        g.number(r.x + r.w - 8, ptr.y - ch / 2, hi - ((ptr.y - py) / ph) * (hi - lo), pd, t.bg, false);
      }
      // candle time on the time strip
      const tl = timeLabel(a.t[i], s.intervalMin ?? 0);
      const tw = tl.length * cw + 10;
      const tx = Math.max(px, Math.min(px + pw - tw, X(i) - tw / 2));
      g.rect(tx, timeY + 1, tw, CANDLE_TIME_H - 2, lab);
      g.text(tx + 5, timeY + (CANDLE_TIME_H - ch) / 2, tl, t.bg);
    }
    // legend: O H L C, change from the previous close, volume; the hovered candle or the newest
    {
      const i = hover >= 0 ? hover : end - 1;
      const up = a.c[i] >= a.o[i] ? t.bid : t.ask;
      const prev = i > 0 ? a.c[i - 1] : a.o[i];
      const chg = a.c[i] - prev;
      const y = py + 2;
      const xEnd = px + pw - 4;
      let x = px + 4;
      // backing first, sized to what fits: the legend stays readable over candles
      const est = (4 * (pd + 10) + 30) * cw;
      g.rect(px, y - 2, Math.min(pw, est), ch + 4, withAlpha(t.bg, 0.8));
      const names = 'OHLC';
      for (let k = 0; k < 4; k++) {
        const f = k === 0 ? a.o[i] : k === 1 ? a.h[i] : k === 2 ? a.l[i] : a.c[i];
        if (x + (pd + 10) * cw > xEnd) break;
        g.glyph(x, y, names.charCodeAt(k), t.dim);
        x += cw * 1.5;
        x += g.numberLeft(x, y, f, pd, up) + cw * 1.5;
      }
      if (x + 18 * cw < xEnd) {
        if (chg >= 0) { g.glyph(x, y, 43, up); x += cw; }
        x += g.numberLeft(x, y, chg, pd, up, false);
        x += g.text(x, y, ' (', up);
        if (chg >= 0) { g.glyph(x, y, 43, up); x += cw; }
        x += g.numberLeft(x, y, prev ? (chg / prev) * 100 : 0, 2, up, false);
        x += g.text(x, y, '%)', up) + cw * 1.5;
      }
      const vol = a.v[i];
      if (vol === vol && x + 14 * cw < xEnd) {
        g.glyph(x, y, 86, t.dim);
        x += cw * 1.5;
        g.numberLeft(x, y, vol, vol >= 1000 ? 0 : 2, t.dim);
      }
    }
    // scrolled back into history: a button that returns to the newest candle
    this.liveBox = null;
    if (off > 0) {
      const lbl = 'LIVE >>';
      const bw2 = lbl.length * cw + 14, bh = ch + 8;
      const bx = px + pw - bw2 - 6, by = py + ph - bh - 6;
      g.rect(bx, by, bw2, bh, t.accent);
      g.text(bx + 7, by + 4, lbl, t.bg);
      this.liveBox = { x: bx, y: by, w: bw2, h: bh };
    }
    return true;
  }
}

export type { PatternHit };

/** ms until the candle that opened at `open` closes; 0 when unknown. 43200 min is a calendar month. */
export function closeIn(open: number, intervalMin: number, now: number): number {
  if (!(intervalMin > 0) || !(open > 0)) return 0;
  let close: number;
  if (intervalMin === 43200) {
    const d = new Date(open);
    close = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  } else close = open + intervalMin * 60_000;
  return Math.max(0, close - now);
}

const p2 = (n: number) => (n < 10 ? '0' : '') + n;
/** "42", "03:12", "1:05:09" or "3d 04h" */
export function countdown(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
  if (d > 0) return `${d}d ${p2(h)}h`;
  if (h > 0) return `${h}:${p2(m)}:${p2(x)}`;
  return `${p2(m)}:${p2(x)}`;
}

/** crosshair time label: date and time for intraday candles, the date alone for daily and up */
export function timeLabel(ms: number, intervalMin: number): string {
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  return intervalMin >= 1440 ? date : `${date} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
