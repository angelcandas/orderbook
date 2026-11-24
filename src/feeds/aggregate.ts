import type { Candle } from '../patterns/candle';
import { bucketStart, nextBucket, type Interval } from '../shared/config';

/**
 * Candles for an interval the venue doesn't serve (Kraken has no 3m, 2h, 12h,
 * 3D or 1M), built from a smaller one it does. Buckets follow `bucketStart`, so
 * they line up with Binance's bars and the Binance backfill can stitch on.
 */

/**
 * Roll `base` (oldest first, `baseMs` apart) up into `m` bars. A leading bucket
 * that starts mid-way is dropped when anything follows it, since its open and
 * volume would be wrong. The last bar is closed only once its last base bar
 * is closed and reaches the bucket's end.
 */
export function aggregate(base: Candle[], m: Interval, baseMs: number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let partialFirst = false;
  for (const c of base) {
    const b = bucketStart(c.t, m);
    if (!cur || b !== cur.t) {
      if (cur) out.push(cur);
      else partialFirst = c.t !== b;
      cur = { t: b, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, closed: true };
    } else {
      if (c.h > cur.h) cur.h = c.h;
      if (c.l < cur.l) cur.l = c.l;
      cur.c = c.c;
      cur.v += c.v;
    }
  }
  if (!cur) return out;
  out.push(cur);
  const last = base[base.length - 1];
  cur.closed = last.closed && last.t + baseMs >= nextBucket(cur.t, m);
  if (partialFirst && out.length > 1) out.shift();
  return out;
}

/** Most base bars an Aggregator keeps (3000 aggregated bars of 3m from 1m is 9000). */
const MAX_BASE = 9000;

/**
 * Keeps the base bars of one subscription so live updates, reconnect snapshots
 * and REST history all land in the same buckets.
 */
export class Aggregator {
  private base: Candle[] = [];
  constructor(readonly m: Interval, readonly baseMs: number) {}

  /** Merge base bars in (later ones win on equal times); returns the whole aggregated series. */
  merge(cs: Candle[]): Candle[] {
    if (cs.length) {
      const at = new Map<number, Candle>();
      for (const c of this.base) at.set(c.t, c);
      for (const c of cs) at.set(c.t, c);
      const all = [...at.values()].sort((a, b) => a.t - b.t);
      this.base = all.length > MAX_BASE ? all.slice(all.length - MAX_BASE) : all;
    }
    return aggregate(this.base, this.m, this.baseMs);
  }

  /** One live base bar; returns the (forming) aggregated bar it belongs to. */
  update(c: Candle): Candle {
    const b = this.base;
    const last = b[b.length - 1];
    if (!last || c.t > last.t) {
      if (last) last.closed = true;
      b.push(c);
      if (b.length > MAX_BASE) b.shift();
    } else {
      for (let i = b.length - 1; i >= 0 && i >= b.length - 3; i--) if (b[i].t === c.t) { b[i] = c; break; }
    }
    const start = bucketStart(c.t, this.m);
    let i = b.length - 1;
    while (i > 0 && b[i - 1].t >= start) i--;
    const bar = aggregate(b.slice(i), this.m, this.baseMs)[0];
    bar.closed = false;
    return bar;
  }
}
