import { binanceInterval } from '../shared/config';
/**
 * Liquidation levels per candle: one column of the LiqMap per bar, so the
 * candle chart can draw where the estimated liquidations sat at every bar.
 *
 * History is rebuilt from futures klines and open-interest history (both
 * public REST), so the map is full as soon as the chart loads; live trades
 * and open-interest polls then keep the newest column moving.
 */
import { LiqMap } from './model';

export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }
export interface OiPoint { t: number; oi: number }

/** What the render worker needs to draw the overlay. */
export interface LiqFrame {
  type: 'liq';
  symbol: string;
  stepMs: number; // bar length
  t0: number; // open time of column 0
  cols: number;
  bins: number;
  origin: number; // price of row 0's lower edge (futures price)
  binStep: number;
  lastPrice: number; // futures last trade, to rescale onto the chart's price
  data: Float32Array; // cols * bins, column-major (column c at c * bins)
  events: Float64Array; // [t, price, notional, side(1 long, -1 short)] * n
}
/** Just the newest column, sent about once a second. */
export interface LiqTail {
  type: 'liqTail';
  col: number;
  t: number;
  lastPrice: number;
  data: Float32Array; // bins
  events: Float64Array;
}

export const MAX_COLS = 1500;
const ROOM = 0.16; // grid margin around the history: past 10x leverage on both sides

export class LiqSeries {
  map: LiqMap;
  cols: Float32Array[] = [];
  t0 = 0;
  /** liquidation prints, [t, price, notional, side] flattened */
  events: number[] = [];
  private curBar = -1;

  constructor(readonly stepMs: number, readonly bins = 640) {
    this.map = new LiqMap({ bins, margin: 0.06 });
  }

  /** Rebuild from history. `oi` may be empty: then a share of volume is assumed to open positions. */
  replay(bars: Bar[], oi: OiPoint[]): void {
    if (!bars.length) return;
    let lo = Infinity, hi = -Infinity;
    for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
    this.map.setRange(lo * (1 - ROOM), hi * (1 + ROOM));
    this.t0 = bars[0].t;
    this.cols = [];
    let k = 0;
    // a baseline before the first bar, if there is one
    while (k < oi.length && oi[k].t <= bars[0].t) k++;
    if (k > 0) this.map.openInterest(oi[k - 1].oi);
    for (const b of bars) {
      walkBar(this.map, b);
      const end = b.t + this.stepMs;
      if (oi.length) {
        while (k < oi.length && oi[k].t <= end) { this.map.openInterest(oi[k].oi); k++; }
      } else this.map.openFromVolume(0.1);
      this.cols.push(this.snapshot());
    }
    this.curBar = bars[bars.length - 1].t;
    this.map.shifted = 0;
  }

  private snapshot(): Float32Array {
    const m = this.map, col = new Float32Array(m.bins);
    for (let r = 0; r < m.bins; r++) col[r] = m.longs[r] + m.shorts[r];
    return col;
  }

  /**
   * A live trade. Returns 'full' when the columns changed shape (grid moved,
   * history trimmed) and everything must be resent, 'new' when a bar closed.
   */
  trade(t: number, price: number, qty: number): 'full' | 'new' | null {
    if (!this.cols.length) {
      // no history at all: start the grid at this trade
      this.map.setRange(price * (1 - ROOM), price * (1 + ROOM));
      this.t0 = Math.floor(t / this.stepMs) * this.stepMs;
      this.curBar = this.t0;
      this.cols.push(this.snapshot());
    }
    this.map.trade(price, qty);
    let out: 'full' | 'new' | null = null;
    if (this.map.shifted) {
      const k = this.map.shifted;
      this.map.shifted = 0;
      for (const c of this.cols) shiftF32(c, k);
      out = 'full';
    }
    const bar = Math.floor(t / this.stepMs) * this.stepMs;
    if (bar > this.curBar) {
      this.cols[this.cols.length - 1] = this.snapshot();
      // a gap (tab asleep): repeat the last column so indices stay time-aligned
      for (let b = this.curBar + this.stepMs; b <= bar; b += this.stepMs) this.cols.push(this.snapshot());
      this.curBar = bar;
      if (this.cols.length > MAX_COLS) {
        const drop = this.cols.length - MAX_COLS;
        this.cols.splice(0, drop);
        this.t0 += drop * this.stepMs;
        out = 'full';
      } else out = out ?? 'new';
    }
    return out;
  }

  openInterest(oi: number): void { this.map.openInterest(oi); }
  openFromVolume(): void { this.map.openFromVolume(0.1); }

  liquidation(t: number, price: number, qty: number, side: 'long' | 'short'): void {
    this.events.push(t, price, price * qty, side === 'long' ? 1 : -1);
    // keep what the history covers
    while (this.events.length && this.events[0] < this.t0) this.events.splice(0, 4);
    if (this.events.length > 4 * 2000) this.events.splice(0, this.events.length - 4 * 2000);
  }

  /** Refresh the newest column from the live map. */
  tail(): LiqTail {
    const col = this.snapshot();
    this.cols[this.cols.length - 1] = col;
    return { type: 'liqTail', col: this.cols.length - 1, t: this.curBar, lastPrice: this.map.lastPrice, data: col.slice(), events: Float64Array.from(this.events) };
  }

  frame(symbol: string): LiqFrame {
    const n = this.cols.length, bins = this.map.bins;
    const data = new Float32Array(n * bins);
    for (let c = 0; c < n; c++) data.set(this.cols[c], c * bins);
    return {
      type: 'liq', symbol, stepMs: this.stepMs, t0: this.t0, cols: n, bins,
      origin: this.map.origin, binStep: this.map.step, lastPrice: this.map.lastPrice, data, events: Float64Array.from(this.events),
    };
  }
}

/** Replay a bar as trades along a plausible path: open, nearer extreme, other extreme, close. */
export function walkBar(m: LiqMap, b: Bar): void {
  const up = b.c >= b.o;
  const pts = up ? [b.o, b.l, b.h, b.c] : [b.o, b.h, b.l, b.c];
  const STEPS = 8;
  const q = b.v / (3 * STEPS);
  for (let leg = 0; leg < 3; leg++) {
    const a = pts[leg], z = pts[leg + 1];
    for (let s = 1; s <= STEPS; s++) m.trade(a + ((z - a) * s) / STEPS, q);
  }
}

function shiftF32(a: Float32Array, k: number): void {
  const n = a.length;
  if (Math.abs(k) >= n) { a.fill(0); return; }
  if (k > 0) { a.copyWithin(0, k); a.fill(0, n - k); }
  else { a.copyWithin(-k, 0, n + k); a.fill(0, 0, -k); }
}

/** Binance interval string for chart minutes, and the open-interest history period to pair with it. */
export function periods(minutes: number): { kline: string; oi: string } {
  const kline = binanceInterval(minutes);
  const oi = minutes < 5 ? '5m' : kline; // OI history starts at 5m
  return { kline, oi };
}
