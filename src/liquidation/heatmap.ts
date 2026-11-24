/**
 * Draws the liquidation heatmap on a 2D canvas (an OffscreenCanvas in the
 * liquidation worker).
 *
 * The cheap part: the heat itself lives in a small image of one pixel per
 * (time column, price row), written one column at a time and scaled up with a
 * single drawImage. A full redraw (heat, price trace, liquidation dots, axis)
 * happens about once a second when a column closes, plus on hover and resize,
 * so it costs nothing per order book update.
 */
import { LiqMap, shiftArray, type LiqEvent } from './model';

export interface HeatTheme { bg: string; text: string; dim: string; grid: string; long: string; short: string; price: string }
export const HEAT_DARK: HeatTheme = { bg: '#0d1117', text: '#d6dde6', dim: '#7d8796', grid: '#1f2630', long: '#e5534b', short: '#2ebd85', price: '#ffffff' };
export const HEAT_LIGHT: HeatTheme = { bg: '#ffffff', text: '#1f2328', dim: '#59636e', grid: '#e4e8ee', long: '#cf222e', short: '#1a7f37', price: '#1f2328' };

/** 256-entry ramp: transparent -> deep blue -> teal -> green -> yellow (perceptually ordered). */
function ramp(): Uint8ClampedArray {
  const stops: [number, number, number, number, number][] = [
    [0, 30, 20, 80, 0], [0.12, 40, 30, 120, 150], [0.35, 33, 110, 160, 220],
    [0.6, 40, 180, 120, 240], [0.85, 200, 220, 50, 255], [1, 255, 250, 140, 255],
  ];
  const out = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let k = 0;
    while (k < stops.length - 2 && x > stops[k + 1][0]) k++;
    const [x0, ...a] = stops[k], [x1, ...b] = stops[k + 1];
    const f = (x - x0) / (x1 - x0);
    for (let c = 0; c < 4; c++) out[i * 4 + c] = a[c] + (b[c] - a[c]) * f;
  }
  return out;
}
const RAMP = ramp();

export interface Hover { x: number; y: number }

export class Heatmap {
  readonly cols: number;
  private heat: OffscreenCanvas;
  private hctx: OffscreenCanvasRenderingContext2D;
  private img: ImageData;
  /** raw values per column, for rescaling after a recentre */
  private hist: Float32Array[];
  private priceHist: Float32Array; // last price per column, NaN when none
  private colTime: Float64Array;
  private head = 0; // next column to write
  private filled = 0;
  private scale = 0; // running normaliser
  events: LiqEvent[] = [];
  theme = HEAT_DARK;
  hover: Hover | null = null;
  private w = 1; private h = 1; private dpr = 1;
  private readonly axisW = 64;

  constructor(private ctx: OffscreenCanvasRenderingContext2D, private map: LiqMap, cols = 900) {
    this.cols = cols;
    this.heat = new OffscreenCanvas(cols, map.bins);
    this.hctx = this.heat.getContext('2d')!;
    this.img = this.hctx.createImageData(cols, map.bins);
    this.hist = Array.from({ length: cols }, () => new Float32Array(map.bins));
    this.priceHist = new Float32Array(cols).fill(NaN);
    this.colTime = new Float64Array(cols);
  }

  resize(w: number, h: number, dpr: number): void {
    this.w = Math.max(1, w); this.h = Math.max(1, h); this.dpr = dpr;
    const c = this.ctx.canvas as OffscreenCanvas;
    c.width = Math.round(this.w * dpr); c.height = Math.round(this.h * dpr);
  }

  /** The grid recentred by `k` rows: move every stored column with it. */
  shift(k: number): void {
    if (!k) return;
    for (const col of this.hist) shiftArray(col, k);
    for (let c = 0; c < this.cols; c++) this.paintColumn(c);
    this.hctx.putImageData(this.img, 0, 0);
  }

  /** Close a time column: snapshot the map's current levels. */
  push(t: number): void {
    const m = this.map;
    const col = this.hist[this.head];
    let max = 0;
    for (let r = 0; r < m.bins; r++) {
      const v = m.longs[r] + m.shorts[r];
      col[r] = v;
      if (v > max) max = v;
    }
    // normaliser follows the strongest level, rising fast and decaying slowly,
    // so one huge cluster doesn't blank the rest for long
    this.scale = Math.max(max, this.scale * 0.995);
    this.priceHist[this.head] = m.lastPrice > 0 ? m.lastPrice : NaN;
    this.colTime[this.head] = t;
    this.paintColumn(this.head);
    this.hctx.putImageData(this.img, 0, 0, this.head, 0, 1, m.bins);
    this.head = (this.head + 1) % this.cols;
    this.filled = Math.min(this.cols, this.filled + 1);
    const oldest = this.colTime[this.filled < this.cols ? 0 : this.head];
    if (this.events.length && this.events[0].t < oldest) this.events = this.events.filter((e) => e.t >= oldest);
  }

  private paintColumn(c: number): void {
    const col = this.hist[c], d = this.img.data, bins = this.map.bins, s = this.scale || 1;
    for (let r = 0; r < bins; r++) {
      const v = col[r];
      // image row 0 is the top: highest price
      const p = ((bins - 1 - r) * this.cols + c) * 4;
      const i = v > 0 ? Math.min(255, Math.round(Math.sqrt(v / s) * 255)) : 0;
      d[p] = RAMP[i * 4]; d[p + 1] = RAMP[i * 4 + 1]; d[p + 2] = RAMP[i * 4 + 2]; d[p + 3] = RAMP[i * 4 + 3];
    }
  }

  /** Full redraw. Returns CPU time in ms. */
  draw(): number {
    const t0 = performance.now();
    const g = this.ctx, m = this.map, th = this.theme;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = th.bg;
    g.fillRect(0, 0, this.w, this.h);
    const plotW = this.w - this.axisW, H = this.h;
    if (!m.ready || this.filled === 0) {
      g.fillStyle = th.dim;
      g.font = '12px ui-sans-serif, system-ui, sans-serif';
      g.fillText('Waiting for futures trades…', 12, 20);
      return performance.now() - t0;
    }
    // heat: newest column at the right edge; columns are oldest..newest from (head) wrapping
    // until the history fills the width, stretch it (but never wider than 2 minutes per plot)
    const n = this.filled, colW = plotW / Math.max(n, Math.min(this.cols, 120));
    const x0 = plotW - n * colW;
    g.imageSmoothingEnabled = false;
    const start = this.filled < this.cols ? 0 : this.head;
    const firstLen = Math.min(n, this.cols - start);
    g.drawImage(this.heat, start, 0, firstLen, m.bins, x0, 0, firstLen * colW, H);
    if (firstLen < n) g.drawImage(this.heat, 0, 0, n - firstLen, m.bins, x0 + firstLen * colW, 0, (n - firstLen) * colW, H);

    const yOf = (p: number) => H - ((p - m.low) / (m.high - m.low)) * H;
    const xOfCol = (k: number) => x0 + (k + 0.5) * colW; // k = 0 oldest
    // price trace
    g.strokeStyle = th.price;
    g.lineWidth = 1.25;
    g.globalAlpha = 0.9;
    g.beginPath();
    let pen = false;
    for (let k = 0; k < n; k++) {
      const p = this.priceHist[(start + k) % this.cols];
      if (!(p > 0)) { pen = false; continue; }
      const x = xOfCol(k), y = yOf(p);
      if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
    }
    g.stroke();
    g.globalAlpha = 1;

    // actual liquidations, placed by time
    const tOld = this.colTime[start], tNew = this.colTime[(start + n - 1) % this.cols];
    const span = Math.max(1, tNew - tOld);
    let maxN = 0;
    for (const e of this.events) maxN = Math.max(maxN, e.price * e.qty);
    for (const e of this.events) {
      const x = xOfCol(((e.t - tOld) / span) * (n - 1));
      const r = 1.5 + 5 * Math.sqrt((e.price * e.qty) / (maxN || 1));
      g.fillStyle = e.side === 'long' ? th.long : th.short;
      g.globalAlpha = 0.85;
      g.beginPath();
      g.arc(Math.min(x, plotW - 2), yOf(e.price), r, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;

    // time labels, minutes ago
    g.font = '11px ui-monospace, Menlo, Consolas, monospace';
    g.textBaseline = 'bottom';
    g.fillStyle = th.dim;
    const spanMin = span / 60_000;
    const every = [1, 2, 5, 10, 15, 30, 60].find((m) => (m / Math.max(spanMin, 1e-9)) * (n * colW) > 90) ?? 60;
    for (let m = every; m <= spanMin; m += every) {
      const x = xOfCol((n - 1) * (1 - (m * 60_000) / span));
      g.fillText(`-${m}m`, x - 10, H - 3);
    }

    // price axis
    g.fillStyle = th.bg;
    g.fillRect(plotW, 0, this.axisW, H);
    g.strokeStyle = th.grid;
    g.beginPath(); g.moveTo(plotW + 0.5, 0); g.lineTo(plotW + 0.5, H); g.stroke();
    g.font = '11px ui-monospace, Menlo, Consolas, monospace';
    g.textBaseline = 'middle';
    const range = m.high - m.low;
    const tick = niceStep(range / Math.max(2, H / 40));
    const dec = Math.max(0, -Math.floor(Math.log10(tick)));
    g.fillStyle = th.dim;
    for (let p = Math.ceil(m.low / tick) * tick; p < m.high; p += tick) {
      const y = yOf(p);
      if (y < 8 || y > H - 8) continue;
      g.fillText(p.toFixed(dec), plotW + 6, y);
    }
    if (m.lastPrice > 0) {
      const y = yOf(m.lastPrice);
      g.fillStyle = th.price;
      g.fillRect(plotW, y - 8, this.axisW, 16);
      g.fillStyle = th.bg;
      g.fillText(m.lastPrice.toFixed(dec + 1), plotW + 6, y);
    }

    // hover readout
    if (this.hover && this.hover.x < plotW) {
      const { x, y } = this.hover;
      const price = m.low + ((H - y) / H) * range;
      const k = Math.floor((x - x0) / colW);
      let v = 0;
      if (k >= 0 && k < n) {
        const r = m.row(price);
        if (r >= 0 && r < m.bins) v = this.hist[(start + k) % this.cols][r];
      }
      g.strokeStyle = th.dim;
      g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(plotW, y + 0.5); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke();
      g.setLineDash([]);
      const label = `${price.toFixed(dec + 1)}  ~${compact(v)}`;
      g.font = '11px ui-monospace, Menlo, Consolas, monospace';
      const tw = g.measureText(label).width + 10;
      const lx = Math.min(x + 8, plotW - tw - 2), ly = Math.max(2, y - 22);
      g.fillStyle = th.bg; g.globalAlpha = 0.85; g.fillRect(lx, ly, tw, 18); g.globalAlpha = 1;
      g.fillStyle = th.text; g.fillText(label, lx + 5, ly + 9);
    }
    return performance.now() - t0;
  }
}

export function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

export function compact(v: number): string {
  if (!(v > 0)) return '0';
  const u = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']] as const;
  for (const [d, s] of u) if (v >= d) return `$${(v / d).toFixed(v >= d * 10 ? 0 : 1)}${s}`;
  return `$${v.toFixed(0)}`;
}
