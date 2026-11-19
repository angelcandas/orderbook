/// <reference lib="webworker" />
import type { Candle } from '../patterns/candle';
import { detect } from '../patterns/detect';
import type { AnalyticsOut } from '../patterns/types';
import type { Venue } from '../shared/config';

/**
 * Candles in, indicators and patterns out. Runs off the render and feed threads;
 * recomputes at most 4 times a second and only when candles changed.
 */
const series: Record<Venue, { symbol: string; candles: Candle[] }> = {
  kraken: { symbol: '', candles: [] },
  binance: { symbol: '', candles: [] },
};
let venue: Venue = 'kraken';
let renderPort: MessagePort | null = null;
let dirty = false;
let timer: any = null;
let lastClosedCount = -1;
let cached: ReturnType<typeof detect> | null = null;

function upsert(list: Candle[], c: Candle): void {
  const last = list[list.length - 1];
  if (!last || c.t > last.t) {
    if (last) last.closed = true;
    list.push(c);
    if (list.length > 1000) list.shift();
  } else {
    // update in place (usually the forming candle)
    for (let i = list.length - 1; i >= 0 && i >= list.length - 3; i--) if (list[i].t === c.t) { list[i] = c; break; }
  }
}

function compute(): void {
  timer = null;
  if (!dirty || !renderPort) return;
  dirty = false;
  const { symbol, candles } = series[venue];
  const t0 = performance.now();
  // patterns only change when a candle closes; the forming candle only moves price
  const closedCount = candles.length && !candles[candles.length - 1].closed ? candles.length - 1 : candles.length;
  const fresh = !cached || closedCount !== lastClosedCount;
  const d = fresh ? detect(candles) : cached!;
  if (fresh) { cached = d; lastClosedCount = closedCount; }
  const n = candles.length;
  const out: AnalyticsOut = {
    symbol,
    t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n),
    ema20: d.series.ema20.slice(0, n), ema50: d.series.ema50.slice(0, n), atr14: d.series.atr.slice(0, n),
    patterns: d.patterns,
    computeMs: 0,
  };
  for (let i = 0; i < n; i++) {
    const k = candles[i];
    out.t[i] = k.t; out.o[i] = k.o; out.h[i] = k.h; out.l[i] = k.l; out.c[i] = k.c; out.v[i] = k.v;
  }
  out.computeMs = performance.now() - t0;
  renderPort.postMessage(out, [out.t.buffer, out.o.buffer, out.h.buffer, out.l.buffer, out.c.buffer, out.v.buffer]);
  if (fresh) postMessage({ type: 'patterns', venue, symbol, patterns: d.patterns, outcomes: d.outcomes, computeMs: out.computeMs, candles: n });
}

function schedule(): void {
  dirty = true;
  if (!timer) timer = setTimeout(compute, 250);
}

function onFeed(e: MessageEvent): void {
  const m = e.data;
  const s = series[m.venue as Venue];
  if (m.type === 'candles') {
    s.symbol = m.symbol;
    s.candles = m.candles;
    if (m.venue === venue) { cached = null; schedule(); }
  } else if (m.type === 'candle') {
    if (m.symbol !== s.symbol) return;
    upsert(s.candles, m.candle);
    if (m.venue === venue) schedule();
  }
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') {
    renderPort = m.renderPort;
    for (const p of m.feedPorts as MessagePort[]) p.onmessage = onFeed;
  } else if (m.type === 'venue') {
    venue = m.venue;
    cached = null;
    schedule();
  } else if (m.type === 'reset') {
    series.kraken = { symbol: '', candles: [] };
    series.binance = { symbol: '', candles: [] };
    cached = null;
    schedule();
  }
};
