/// <reference lib="webworker" />
import { dayStats } from '../shared/day';
import type { Candle } from '../patterns/candle';
import { detect, type Detection } from '../patterns/detect';
import { toSeries } from '../patterns/series';
import { detectInWindow, type AnalysisWindow } from '../patterns/window';
import type { AnalyticsOut } from '../patterns/types';
import type { Venue } from '../shared/config';
import { MAX_BARS, prepend, stepOf } from '../feeds/history';
import { computeAll, defaultIndicators, type IndConfig } from '../indicators/spec';
import { DEFAULT_HORIZON, forecast, type Forecast } from '../forecast/forecast';

/**
 * Candles in, indicators and patterns out. Runs off the render and feed threads;
 * recomputes at most 4 times a second and only when candles changed.
 */
interface Held { symbol: string; candles: Candle[]; backfill: number; source: string }
const empty = (): Held => ({ symbol: '', candles: [], backfill: 0, source: '' });
const series: Record<Venue, Held> = { kraken: empty(), binance: empty() };
let venue: Venue = 'kraken';
let renderPort: MessagePort | null = null;
let dirty = false;
let timer: any = null;
let lastClosedCount = -1;
let cached: Detection | null = null;
/** the box drawn on the candle chart; patterns are searched inside it only */
let win: AnalysisWindow | null = null;
/** the indicators the chart shows; recomputed on every pass since the forming candle moves them */
let indicators: IndConfig[] = defaultIndicators();
/** candles ahead for the research forecast */
let horizon = DEFAULT_HORIZON;
let fc: Forecast | null = null;

/** Indicators over everything, patterns over the window when one is drawn. */
function run(candles: Candle[]): Detection {
  if (!win) return detect(candles);
  const inside = detectInWindow(candles, win);
  return { series: toSeries(candles), patterns: inside?.patterns ?? [], outcomes: inside?.outcomes ?? [] };
}

function upsert(list: Candle[], c: Candle): void {
  const last = list[list.length - 1];
  if (!last || c.t > last.t) {
    if (last) last.closed = true;
    list.push(c);
    if (list.length > MAX_BARS) list.shift();
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
  const d = fresh ? run(candles) : cached!;
  if (fresh) {
    cached = d; lastClosedCount = closedCount;
    // full history, not the window: the forecast is about what comes after the last candle
    fc = forecast(candles, { horizon, patterns: win ? detect(candles).patterns : d.patterns });
  }
  const n = candles.length;
  const out: AnalyticsOut = {
    symbol,
    t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n),
    ind: [],
    patterns: d.patterns,
    computeMs: 0,
  };
  for (let i = 0; i < n; i++) {
    const k = candles[i];
    out.t[i] = k.t; out.o[i] = k.o; out.h[i] = k.h; out.l[i] = k.l; out.c[i] = k.c; out.v[i] = k.v;
  }
  out.ind = computeAll(indicators, out);
  out.computeMs = performance.now() - t0;
  const times = fresh ? new Float64Array(out.t) : null; // copied before out.t is transferred
  const transfer: Transferable[] = [out.t.buffer, out.o.buffer, out.h.buffer, out.l.buffer, out.c.buffer, out.v.buffer];
  for (const x of out.ind) for (const a of x.lines) transfer.push(a.buffer);
  renderPort.postMessage(out, transfer);
  if (times) {
    postMessage({
      type: 'patterns', venue, symbol, patterns: d.patterns, outcomes: d.outcomes, computeMs: out.computeMs, candles: n,
      backfill: series[venue].backfill, source: series[venue].source,
      window: win, t: times, last: n ? candles[n - 1].c : NaN,
      day: dayStats(candles),
      forecast: fc,
    }, [times.buffer]);
  }
}

function schedule(): void {
  dirty = true;
  if (!timer) timer = setTimeout(compute, 250);
}

function onFeed(e: MessageEvent): void {
  const m = e.data;
  const s = series[m.venue as Venue];
  if (m.type === 'candles') {
    const next: Candle[] = m.candles;
    // a fresh snapshot after a reconnect: keep the backfilled bars that still line up
    const st = stepOf(next), prev = stepOf(s.candles);
    // steps compared loosely: monthly bars run 28 to 31 days
    const same = m.symbol === s.symbol && st > 0 && prev > 0 && Math.abs(st - prev) <= prev * 0.15;
    const merged = same ? prepend(next, s.candles.filter((c) => c.closed)) : next;
    if (!same) { s.backfill = 0; s.source = ''; }
    else s.backfill = Math.max(0, Math.min(s.backfill, merged.length - next.length));
    s.symbol = m.symbol;
    s.candles = merged;
    if (m.venue === venue) { cached = null; schedule(); }
  } else if (m.type === 'history') {
    if (m.symbol !== s.symbol) return;
    const before = s.candles.length;
    s.candles = prepend(s.candles, m.candles);
    const added = s.candles.length - before;
    if (added <= 0) return;
    s.backfill += added;
    s.source = m.source;
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
  } else if (m.type === 'indicators') {
    indicators = m.list;
    if (!renderPort) return;
    // indicators only: no need to search patterns again
    dirty = true;
    if (timer) clearTimeout(timer);
    compute();
  } else if (m.type === 'horizon') {
    horizon = m.horizon;
    cached = null;
    schedule();
  } else if (m.type === 'window') {
    win = m.window;
    cached = null;
    schedule();
  } else if (m.type === 'reset') {
    series.kraken = empty();
    series.binance = empty();
    cached = null;
    schedule();
  }
};

