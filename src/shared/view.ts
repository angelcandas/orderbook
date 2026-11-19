import type { Book } from '../engine/book';

/**
 * The book view the feed worker publishes and the render worker reads once per
 * frame. One SharedArrayBuffer guarded by a sequence lock: the writer makes the
 * sequence odd, writes, then makes it even; the reader copies and retries if the
 * sequence changed or was odd. The view is ~35 KB, so a copy costs microseconds.
 * Without cross-origin isolation the same Float64Array is posted instead.
 */
export const LADDER = 40; // rows per side
export const DEPTH = 1000; // depth chart points per side

export const H = {
  version: 0,
  lastRecv: 1,
  lastEventTime: 2,
  bestBid: 3,
  bestAsk: 4,
  tickSize: 5,
  priceDecimals: 6,
  qtyDecimals: 7,
  group: 8,
  nLadBid: 9,
  nLadAsk: 10,
  nDepBid: 11,
  nDepAsk: 12,
  status: 13,
  pair: 14,
  publishTime: 15,
  bidLevels: 16,
  askLevels: 17,
} as const;
export const HEADER = 32;
export const LAD_BID = HEADER;
export const LAD_ASK = LAD_BID + LADDER * 3;
export const DEP_BID = LAD_ASK + LADDER * 3;
export const DEP_ASK = DEP_BID + DEPTH * 2;
export const VIEW_LEN = DEP_ASK + DEPTH * 2;

export enum Status {
  Connecting = 0,
  Syncing = 1,
  Live = 2,
  Resyncing = 3,
  Error = 4,
}
export const STATUS_NAMES = ['connecting', 'syncing', 'live', 'resyncing', 'error'];

export const sabSupported = (): boolean =>
  typeof SharedArrayBuffer !== 'undefined' && (globalThis as any).crossOriginIsolated === true;

export function allocView(): { seq: Int32Array; data: Float64Array; buffer: ArrayBuffer | SharedArrayBuffer } {
  const bytes = 8 + VIEW_LEN * 8;
  const buffer = sabSupported() ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
  return { buffer, seq: new Int32Array(buffer, 0, 2), data: new Float64Array(buffer, 8, VIEW_LEN) };
}

export function wrapView(buffer: ArrayBuffer | SharedArrayBuffer) {
  return { seq: new Int32Array(buffer, 0, 2), data: new Float64Array(buffer, 8, VIEW_LEN) };
}

/** Fill `out` with the view of `book`, aggregated to `group` (price units). */
export function writeView(out: Float64Array, book: Book, group: number, status: number, pair: number): void {
  const { tickSize, priceDecimals, qtyDecimals } = book.inst;
  out[H.version] = book.version;
  out[H.lastRecv] = book.lastRecv;
  out[H.lastEventTime] = book.lastEventTime;
  out[H.tickSize] = tickSize;
  out[H.priceDecimals] = priceDecimals;
  out[H.qtyDecimals] = qtyDecimals;
  out[H.status] = status;
  out[H.pair] = pair;
  out[H.bidLevels] = book.bids.n;
  out[H.askLevels] = book.asks.n;
  const b = book.bids;
  const a = book.asks;
  out[H.bestBid] = b.n ? b.bestTick * tickSize : NaN;
  out[H.bestAsk] = a.n ? a.bestTick * tickSize : NaN;
  const g = Math.max(1, Math.round(group / tickSize));
  out[H.group] = g * tickSize;

  // ladder, grouped
  out[H.nLadBid] = ladder(out, LAD_BID, b.n, (i) => b.tickAt(i), (i) => b.qtyAt(i), (t) => Math.floor(t / g) * g, tickSize);
  out[H.nLadAsk] = ladder(out, LAD_ASK, a.n, (i) => a.tickAt(i), (i) => a.qtyAt(i), (t) => Math.ceil(t / g) * g, tickSize);

  // depth chart, raw levels, cumulative
  let cum = 0;
  const nb = Math.min(DEPTH, b.n);
  for (let i = 0; i < nb; i++) {
    cum += b.qtyAt(i);
    out[DEP_BID + i * 2] = b.tickAt(i) * tickSize;
    out[DEP_BID + i * 2 + 1] = cum;
  }
  out[H.nDepBid] = nb;
  cum = 0;
  const na = Math.min(DEPTH, a.n);
  for (let i = 0; i < na; i++) {
    cum += a.qtyAt(i);
    out[DEP_ASK + i * 2] = a.tickAt(i) * tickSize;
    out[DEP_ASK + i * 2 + 1] = cum;
  }
  out[H.nDepAsk] = na;
}

function ladder(
  out: Float64Array,
  base: number,
  n: number,
  tickAt: (i: number) => number,
  qtyAt: (i: number) => number,
  bucket: (t: number) => number,
  tickSize: number,
): number {
  let rows = 0;
  let cur = NaN;
  let qty = 0;
  let cum = 0;
  for (let i = 0; i < n; i++) {
    const bt = bucket(tickAt(i));
    if (bt !== cur) {
      if (rows > 0 || !Number.isNaN(cur)) {
        cum += qty;
        out[base + rows * 3] = cur * tickSize;
        out[base + rows * 3 + 1] = qty;
        out[base + rows * 3 + 2] = cum;
        rows++;
        if (rows === LADDER) return rows;
      }
      cur = bt;
      qty = 0;
    }
    qty += qtyAt(i);
  }
  if (!Number.isNaN(cur) && rows < LADDER) {
    cum += qty;
    out[base + rows * 3] = cur * tickSize;
    out[base + rows * 3 + 1] = qty;
    out[base + rows * 3 + 2] = cum;
    rows++;
  }
  return rows;
}

export function seqWrite(seq: Int32Array, fill: () => void): void {
  Atomics.add(seq, 0, 1);
  fill();
  Atomics.add(seq, 0, 1);
}

/** Copy the view into `dst`. Returns false if no consistent copy was obtained. */
export function seqRead(seq: Int32Array, src: Float64Array, dst: Float64Array): boolean {
  for (let tries = 0; tries < 8; tries++) {
    const s1 = Atomics.load(seq, 0);
    if (s1 & 1) continue;
    dst.set(src);
    if (Atomics.load(seq, 0) === s1) return true;
  }
  return false;
}
