/**
 * Liquidation levels drawn as horizontal bands behind the candles, one cell
 * per (candle, price row), coloured green -> yellow -> red by how much would
 * be liquidated there. Runs of equal colour along a row merge into one rect,
 * so a typical frame is a few hundred rects, not one per cell.
 */
import { hex, withAlpha, type Gfx, type RGBA } from './gl';
import type { Theme } from './theme';
import type { AnalyticsOut } from '../patterns/types';
import type { LiqFrame, LiqTail } from '../liquidation/series';

// cool to hot; index 0 is "nothing"
const RAMP_SRC = ['#1f6f3a', '#2ea043', '#7cc43c', '#d9d02f', '#f0a030', '#e5534b'];
const LEVELS = RAMP_SRC.length;
const RAMP: RGBA[] = RAMP_SRC.map((c) => hex(c, 0.78));
const LABEL = hex('#f0a030');
/** cells below this share of the visible maximum are not drawn */
const FLOOR = 0.15;

export class LiqView {
  stepMs = 0;
  t0 = 0;
  cols = 0;
  bins = 0;
  origin = 0;
  binStep = 0;
  lastPrice = 0;
  data: Float32Array = new Float32Array(0);
  events: Float64Array = new Float64Array(0);
  symbol = '';

  get ready(): boolean { return this.cols > 0 && this.lastPrice > 0; }

  clear(): void { this.cols = 0; this.events = new Float64Array(0); }

  frame(f: LiqFrame): void {
    Object.assign(this, { stepMs: f.stepMs, t0: f.t0, cols: f.cols, bins: f.bins, origin: f.origin, binStep: f.binStep, lastPrice: f.lastPrice, events: f.events, symbol: f.symbol });
    this.data = f.data;
  }

  tail(t: LiqTail): void {
    if (!this.bins || t.data.length !== this.bins) return;
    const need = (t.col + 1) * this.bins;
    if (need > this.data.length) {
      const grown = new Float32Array(Math.max(need, this.data.length * 2));
      grown.set(this.data.subarray(0, this.cols * this.bins));
      this.data = grown;
    }
    this.data.set(t.data, t.col * this.bins);
    this.cols = Math.max(this.cols, t.col + 1);
    if (t.lastPrice > 0) this.lastPrice = t.lastPrice;
    this.events = t.events;
  }

  /**
   * Draw behind the candles. `X(i)` is candle i's centre, `Y(p)` maps a chart
   * price; `k` rescales futures prices onto the chart's (EUR pairs, USD vs USDT).
   */
  draw(g: Gfx, a: AnalyticsOut, first: number, N: number, step: number, X: (i: number) => number, Y: (p: number) => number,
    lo: number, hi: number, py: number, ph: number, labelX: number, t: Theme): void {
    if (!this.ready || this.stepMs <= 0) return;
    const k = a.c[N - 1] / this.lastPrice;
    if (!(k > 0) || Math.abs(Math.log(k)) > 3) return;
    // candle -> column: the last column that opens inside the candle, so a
    // weekly or monthly candle shows the levels as they stood at its close
    // (columns are daily there); equal steps reduce to the candle's own column
    const colOf = (i: number) => columnOf(a.t, i, this.t0, this.stepMs, this.cols);
    // display rows of at least 2 px, each the max over the bins it covers
    const binPx = (this.binStep * k * ph) / (hi - lo);
    const per = Math.max(1, Math.ceil(2 / Math.max(binPx, 1e-9)));
    const rowLo = Math.max(0, Math.floor((lo / k - this.origin) / this.binStep));
    const rowHi = Math.min(this.bins, Math.ceil((hi / k - this.origin) / this.binStep));
    if (rowHi <= rowLo) return;
    const nRows = Math.ceil((rowHi - rowLo) / per);
    const vis = N - first;
    // gather values once (vis x nRows) so the max and the drawing read the same cells
    const cells = scratch(vis * nRows);
    let vmax = 0;
    for (let j = 0; j < vis; j++) {
      const c = colOf(first + j);
      const base = c * this.bins;
      for (let d = 0; d < nRows; d++) {
        let v = 0;
        if (c >= 0) {
          const b0 = rowLo + d * per, b1 = Math.min(rowHi, b0 + per);
          for (let b = b0; b < b1; b++) { const x = this.data[base + b]; if (x > v) v = x; }
        }
        cells[j * nRows + d] = v;
        if (v > vmax) vmax = v;
      }
    }
    if (!(vmax > 0)) return;
    const level = (v: number) => {
      const f = v / vmax;
      return f < FLOOR ? -1 : Math.min(LEVELS - 1, Math.floor(Math.sqrt((f - FLOOR) / (1 - FLOOR)) * LEVELS));
    };
    for (let d = 0; d < nRows; d++) {
      const b0 = rowLo + d * per;
      const pTop = (this.origin + (b0 + per) * this.binStep) * k;
      const pBot = (this.origin + b0 * this.binStep) * k;
      let y0 = Y(pTop), y1 = Y(pBot);
      if (y1 < py || y0 > py + ph) continue;
      y0 = Math.max(py, y0); y1 = Math.min(py + ph, y1);
      const h = Math.max(1, y1 - y0 - (binPx * per >= 4 ? 1 : 0)); // 1 px gap when rows are tall enough
      let j = 0;
      while (j < vis) {
        const L = level(cells[j * nRows + d]);
        if (L < 0) { j++; continue; }
        let e = j + 1;
        while (e < vis && level(cells[e * nRows + d]) === L) e++;
        const x0 = X(first + j) - step / 2, x1 = X(first + e - 1) + step / 2;
        g.rect(x0, y0, x1 - x0, h, RAMP[L]);
        j = e;
      }
    }
    // real liquidations: small squares at their candle
    const ev = this.events;
    if (ev.length) {
      let nmax = 0;
      for (let i = 2; i < ev.length; i += 4) if (ev[i] > nmax) nmax = ev[i];
      const tFirst = a.t[first], tEnd = a.t[N - 1] + (N > 1 ? a.t[N - 1] - a.t[N - 2] : this.stepMs);
      for (let i = 0; i < ev.length; i += 4) {
        const te = ev[i];
        if (te < tFirst || te >= tEnd) continue;
        const idx = candleAt(a.t, first, N, te);
        if (idx < 0) continue;
        const p = ev[i + 1] * k;
        if (p < lo || p > hi) continue;
        const s = 2 + 5 * Math.sqrt(ev[i + 2] / (nmax || 1));
        g.rect(X(idx) - s / 2, Y(p) - s / 2, s, s, ev[i + 3] > 0 ? t.ask : t.bid);
      }
    }
    // label the hottest rows in the newest column, like the reference heatmaps
    const last = vis - 1;
    const picks: number[] = [];
    for (let d = 0; d < nRows; d++) {
      const v = cells[last * nRows + d];
      if (level(v) < 2) continue;
      // local peak only
      if (d > 0 && cells[last * nRows + d - 1] > v) continue;
      if (d < nRows - 1 && cells[last * nRows + d + 1] >= v) continue;
      picks.push(d);
    }
    picks.sort((p, q) => cells[last * nRows + q] - cells[last * nRows + p]);
    const used: number[] = [];
    const dec = this.labelDecimals(k);
    for (const d of picks) {
      if (used.length >= 5) break;
      const p = (this.origin + (rowLo + d * per + per / 2) * this.binStep) * k;
      const y = Y(p) - g.atlas.cellH / 2;
      if (y < py || y > py + ph - g.atlas.cellH) continue;
      if (used.some((u) => Math.abs(u - y) < g.atlas.cellH + 2)) continue;
      used.push(y);
      const w = (String(Math.round(p)).length + (dec ? dec + 1 : 0)) * g.atlas.cellW + 6;
      g.rect(labelX - w + 2, y - 1, w + 2, g.atlas.cellH + 2, withAlpha(t.bg, 0.75));
      g.number(labelX, y, p, dec, LABEL, false);
    }
  }

  private labelDecimals(k: number): number {
    const step = this.binStep * k;
    return Math.max(0, Math.min(6, Math.ceil(-Math.log10(step))));
  }
}

/**
 * The level column for candle i: the last column opening inside the candle
 * (its span runs to the next candle's open), or -1 when none does.
 */
export function columnOf(t: ArrayLike<number>, i: number, t0: number, stepMs: number, cols: number): number {
  const span = i + 1 < t.length ? t[i + 1] - t[i] : i > 0 ? t[i] - t[i - 1] : stepMs;
  const c0 = Math.round((t[i] - t0) / stepMs);
  const c = Math.min(cols - 1, Math.round((t[i] + span - t0) / stepMs) - 1);
  return c >= 0 && c >= c0 ? c : -1;
}

/** Index of the candle in [first, N) whose open time is the last one <= t, or -1. */
export function candleAt(t: ArrayLike<number>, first: number, N: number, x: number): number {
  let lo = first, hi = N - 1;
  if (hi < lo || x < t[lo]) return -1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (t[m] <= x) lo = m; else hi = m - 1;
  }
  return lo;
}

let buf: Float32Array = new Float32Array(0);
function scratch(n: number): Float32Array {
  if (buf.length < n) buf = new Float32Array(n * 2);
  return buf;
}
