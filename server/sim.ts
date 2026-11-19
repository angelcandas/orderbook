import { Book, type Instrument } from '../src/engine/book';
import type { Candle } from '../src/patterns/candle';

/** Deterministic PRNG so runs are reproducible. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export interface LevelChange { side: 0 | 1; price: number; qty: number }

/**
 * A synthetic market for one symbol: a bounded L2 book around a random-walk mid,
 * producing batches of level changes and trades. The book is the truth the
 * emulated venues serve snapshots from.
 */
export class MarketSim {
  readonly book: Book;
  private r: () => number;
  midTick: number;
  updateId = 1;
  candles: Candle[] = [];

  constructor(readonly inst: Instrument, startPrice: number, readonly depth: number, seed: number, readonly intervalMs: number) {
    this.book = new Book(inst, depth);
    this.r = rng(seed);
    this.midTick = Math.round(startPrice / inst.tickSize);
    this.seedBook();
    this.candles = synthHistory(startPrice, 720, intervalMs, seed + 7);
    const last = this.candles[this.candles.length - 1];
    this.midTick = Math.round(last.c / inst.tickSize);
    this.seedBook();
  }

  private qty(): number {
    const q = Math.pow(this.r(), 3) * 5 + 0.0001;
    return Number(q.toFixed(this.inst.qtyDecimals));
  }

  private seedBook(): void {
    this.book.clear();
    for (let i = 1; i <= this.depth; i++) {
      this.book.bids.set(this.midTick - i, this.qty());
      this.book.asks.set(this.midTick + i, this.qty());
    }
  }

  /** Produce `n` level changes, applied to the truth book. */
  step(n: number, out: LevelChange[]): void {
    const b = this.book;
    const ts = this.inst.tickSize;
    // occasional mid drift
    if (this.r() < 0.02) this.midTick += this.r() < 0.5 ? -1 : 1;
    for (let k = 0; k < n; k++) {
      const side: 0 | 1 = this.r() < 0.5 ? 0 : 1;
      // distance from touch: mostly near the top
      const dist = 1 + Math.floor(Math.pow(this.r(), 3) * this.depth * 0.8);
      const tick = side === 0 ? this.midTick - dist : this.midTick + dist;
      const del = this.r() < 0.25;
      const q = del ? 0 : this.qty();
      if (side === 0) b.bids.set(tick, q); else b.asks.set(tick, q);
      out.push({ side, price: Number((tick * ts).toFixed(this.inst.priceDecimals)), qty: q });
    }
    // keep the book uncrossed after a mid move: clear levels on the wrong side
    while (b.bids.n && b.bids.bestTick >= this.midTick) {
      const t = b.bids.bestTick; b.bids.set(t, 0);
      out.push({ side: 0, price: Number((t * ts).toFixed(this.inst.priceDecimals)), qty: 0 });
    }
    while (b.asks.n && b.asks.bestTick <= this.midTick) {
      const t = b.asks.bestTick; b.asks.set(t, 0);
      out.push({ side: 1, price: Number((t * ts).toFixed(this.inst.priceDecimals)), qty: 0 });
    }
    b.bids.truncate(this.depth);
    b.asks.truncate(this.depth);
    b.version++;
  }

  /** Advance the forming candle with a trade at the mid. Returns the candle. */
  trade(nowMs: number): Candle {
    const px = this.midTick * this.inst.tickSize;
    let c = this.candles[this.candles.length - 1];
    const t = Math.floor(nowMs / this.intervalMs) * this.intervalMs;
    if (!c || t > c.t) {
      if (c) c.closed = true;
      c = { t, o: px, h: px, l: px, c: px, v: 0, closed: false };
      this.candles.push(c);
      if (this.candles.length > 2000) this.candles.shift();
    }
    c.h = Math.max(c.h, px); c.l = Math.min(c.l, px); c.c = px;
    c.v += this.qty();
    return c;
  }
}

/**
 * Candle history: a random walk with volatility clustering, with a few textbook
 * patterns spliced in so the pattern detector has something to find in demo mode.
 */
export function synthHistory(start: number, n: number, intervalMs: number, seed: number): Candle[] {
  const r = rng(seed);
  const closes: number[] = [];
  let p = start;
  let vol = 0.002;
  const templates = [doubleTop, headShoulders, ascTriangle, doubleBottom, symTriangle, cupHandle];
  let ti = Math.floor(r() * templates.length);
  while (closes.length < n) {
    if (r() < 0.08 && n - closes.length > 60) {
      const seg = templates[ti++ % templates.length](40 + Math.floor(r() * 30));
      const scale = p * (0.03 + r() * 0.03);
      for (const s of seg) closes.push(p + s * scale);
      p = closes[closes.length - 1];
      continue;
    }
    vol = Math.max(0.0008, Math.min(0.01, vol * (1 + (r() - 0.5) * 0.3)));
    p *= 1 + (r() - 0.5) * 2 * vol;
    closes.push(p);
  }
  const now = Date.now();
  const t0 = Math.floor(now / intervalMs) * intervalMs - (n - 1) * intervalMs;
  const out: Candle[] = [];
  let prev = closes[0];
  for (let i = 0; i < n; i++) {
    const c = closes[i];
    const o = prev;
    const wig = Math.abs(c - o) * 0.5 + c * 0.0008 * r();
    out.push({ t: t0 + i * intervalMs, o, c, h: Math.max(o, c) + wig * r(), l: Math.min(o, c) - wig * r(), v: 1 + r() * 20, closed: i < n - 1 });
    prev = c;
  }
  return out;
}

// templates return offsets in units of "pattern height" starting at 0
function interp(points: [number, number][], n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    let k = 0;
    while (k < points.length - 2 && points[k + 1][0] < x) k++;
    const [x0, y0] = points[k];
    const [x1, y1] = points[k + 1];
    out.push(y0 + ((x - x0) / (x1 - x0)) * (y1 - y0));
  }
  return out;
}
const doubleTop = (n: number) => interp([[0, 0], [0.25, 1], [0.5, 0.45], [0.75, 1], [1, 0.1]], n);
const doubleBottom = (n: number) => interp([[0, 0], [0.25, -1], [0.5, -0.45], [0.75, -1], [1, -0.1]], n);
const headShoulders = (n: number) => interp([[0, 0], [0.15, 0.7], [0.3, 0.35], [0.5, 1], [0.7, 0.35], [0.85, 0.7], [1, 0.05]], n);
const ascTriangle = (n: number) => interp([[0, 0], [0.15, 1], [0.3, 0.3], [0.45, 1], [0.6, 0.55], [0.75, 1], [0.85, 0.75], [1, 1.4]], n);
const symTriangle = (n: number) => interp([[0, 0], [0.15, 1], [0.3, 0.2], [0.45, 0.85], [0.6, 0.35], [0.75, 0.7], [0.85, 0.5], [1, 1.1]], n);
const cupHandle = (n: number) => interp([[0, 0], [0.1, -0.5], [0.3, -0.95], [0.5, -1], [0.7, -0.9], [0.85, 0], [0.9, -0.15], [0.95, -0.1], [1, 0.3]], n);
