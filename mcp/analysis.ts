/**
 * What the MCP tools answer, built from the app's own modules: pattern
 * detection (src/patterns), the research forecast (src/forecast) and the
 * liquidation map (src/liquidation). Fetching lives in market.ts, drawing in
 * chart.ts; this file glues them and writes the plain-language summaries.
 */
import type { Candle } from '../src/patterns/candle';
import type { PatternHit } from '../src/patterns/types';
import { detect } from '../src/patterns/detect';
import { detectInWindow } from '../src/patterns/window';
import { explain, type Explanation } from '../src/patterns/explain';
import { forecast as runForecast, hasNoEdge, withLiquidity, DEFAULT_HORIZON, type Forecast } from '../src/forecast/forecast';
import { intervalMs, type Interval } from '../src/shared/config';
import {
  autoInterval, book, candles, intervalName, liquidity, parseDate, parseInterval, parsePair, parsePeriod,
  type Book, type CandleSet, type Liquidity, type Venue,
} from './market';
import { chartSvg, decimals, fmtCompact, fmtDate, fmtPrice, type ChartTheme } from './chart';

const pct = (a: number, b: number) => ((b - a) / a) * 100;
const sgn = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');

/** Bar before `t`: index of the last candle that opened at or before it. */
function at(cs: Candle[], t: number): number {
  let lo = 0, hi = cs.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cs[m].t <= t) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}

async function safe<T>(p: Promise<T>): Promise<T | null> {
  try { return await p; } catch { return null; }
}

// ---------------------------------------------------------------- status

export interface StatusInput { pair: string; venue?: Venue }

export interface Status {
  pair: string; venue: Venue; source: string; time: string;
  last: number;
  change: Record<'1h' | '24h' | '7d' | '30d', number | null>;
  high24h: number; low24h: number; volume24h: number; quoteVolume24h: number;
  /** realised volatility of hourly returns over 7 days, annualised % */
  volatility7d: number;
  book: Book | null;
  trend: string;
  recentPatterns: { label: string; bias: string; status?: string; at: string }[];
  forecast: ForecastSummary | null;
  liquidations: Pick<Liquidity, 'source' | 'long' | 'short'> | null;
}

export async function status(i: StatusInput): Promise<{ data: Status; text: string }> {
  const pair = parsePair(i.pair);
  const venue = i.venue ?? 'binance';
  const set = await candles(pair, 60, 24 * 31, { venue });
  const cs = set.candles, n = cs.length, last = cs[n - 1].c;
  const back = (h: number) => (n > h ? pct(cs[n - 1 - h].c, last) : null);
  const day = cs.slice(-24);
  let hi = -Infinity, lo = Infinity, vol = 0, qv = 0;
  for (const c of day) { hi = Math.max(hi, c.h); lo = Math.min(lo, c.l); vol += c.v; qv += c.v * (c.h + c.l + c.c) / 3; }
  const rets: number[] = [];
  for (let k = Math.max(1, n - 168); k < n; k++) rets.push(Math.log(cs[k].c / cs[k - 1].c));
  const m = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, rets.length - 1));
  const d = detect(cs);
  const s = d.series, k = s.lastClosed;
  const trend = s.ema20[k] > s.ema50[k] * 1.001 ? 'up (EMA 20 above EMA 50 on 1h)' : s.ema20[k] < s.ema50[k] * 0.999 ? 'down (EMA 20 below EMA 50 on 1h)' : 'flat (EMA 20 and 50 together on 1h)';
  const recent = d.patterns.filter((p) => p.bias !== 0 && p.end >= n - 24 && p.status !== 'failed')
    .sort((a, b) => b.end - a.end).slice(0, 6)
    .map((p) => ({ label: p.label, bias: p.bias > 0 ? 'bullish' : 'bearish', status: p.family === 'chart' ? p.status : undefined, at: iso(cs[p.end].t) }));
  const [bk, lq] = await Promise.all([safe(book(pair, venue)), safe(liquidity(pair, 60, last))]);
  let f = runForecast(cs, { horizon: 24, patterns: d.patterns });
  if (f && lq) f = withLiquidity(f, lq.long && { price: lq.long.price, notional: lq.long.notional }, lq.short && { price: lq.short.price, notional: lq.short.notional });
  const data: Status = {
    pair: pair.label, venue, source: set.source, time: iso(cs[n - 1].t),
    last, change: { '1h': back(1), '24h': back(24), '7d': back(168), '30d': back(720) },
    high24h: hi, low24h: lo, volume24h: vol, quoteVolume24h: qv,
    volatility7d: sd * Math.sqrt(24 * 365) * 100,
    book: bk, trend, recentPatterns: recent,
    forecast: f ? summarise(f, 60) : null,
    liquidations: lq && { source: lq.source, long: lq.long, short: lq.short },
  };
  const dp = decimals(last);
  const ch = (x: number | null) => (x === null ? 'n/a' : sgn(x));
  const lines = [
    `${pair.label} on ${venue === 'binance' ? 'Binance' : 'Kraken'}: ${fmtPrice(last, dp)} (1h ${ch(data.change['1h'])}, 24h ${ch(data.change['24h'])}, 7d ${ch(data.change['7d'])}, 30d ${ch(data.change['30d'])}).`,
    `24h range ${fmtPrice(lo, dp)} to ${fmtPrice(hi, dp)}, volume ${fmtCompact(vol)} ${pair.base} (about ${fmtCompact(qv)} ${pair.quote}). 7-day realised volatility ${data.volatility7d.toFixed(0)}% annualised.`,
    `Trend: ${trend}.`,
  ];
  if (bk) lines.push(`Book: bid ${fmtPrice(bk.bid, dp)}, ask ${fmtPrice(bk.ask, dp)}, spread ${bk.spreadBps.toFixed(2)} bps; within 1% of mid ${fmtCompact(bk.bidDepth1)} bid vs ${fmtCompact(bk.askDepth1)} ask (${bk.imbalance >= 0 ? 'bid' : 'ask'} heavy by ${Math.abs(bk.imbalance * 100).toFixed(0)}%).`);
  if (recent.length) lines.push(`Patterns in the last 24h (1h candles): ${recent.map((p) => `${p.label} (${p.bias}${p.status ? `, ${p.status}` : ''})`).join('; ')}.`);
  if (lq) lines.push(`Estimated liquidation clusters (${lq.source}): ${lq.long ? `longs near ${fmtPrice(lq.long.price, dp)} (${fmtCompact(lq.long.notional)})` : 'no long cluster'}, ${lq.short ? `shorts near ${fmtPrice(lq.short.price, dp)} (${fmtCompact(lq.short.notional)})` : 'no short cluster'}.`);
  if (data.forecast) lines.push(`Next 24h (research forecast): ${data.forecast.text}`);
  lines.push('Mechanical readings from public data, not financial advice.');
  return { data, text: lines.join('\n') };
}

// ---------------------------------------------------------------- forecast

export interface ForecastSummary {
  horizon: number; interval: string; until: string;
  last: number; bottom: number; mid: number; top: number;
  chanceHigher: number; verdict: string; edge: boolean;
  factors: { label: string; score: number; note: string; tested: boolean }[];
  flags: string[];
  backtest: Forecast['backtest'];
  text: string;
}

function summarise(f: Forecast, interval: Interval): ForecastSummary {
  const dp = decimals(f.last);
  const edge = !hasNoEdge(f);
  const b = f.backtest;
  const until = iso(f.t + (f.horizon + 1) * intervalMs(interval));
  const text = `close in ${f.horizon} ${intervalName(interval)} candles likely between ${fmtPrice(f.bottom, dp)} and ${fmtPrice(f.top, dp)} (80% range, median ${fmtPrice(f.mid, dp)}), ${Math.round(f.pUp * 100)}% chance higher than ${fmtPrice(f.last, dp)}. `
    + (edge
      ? `Lean: ${f.verdict}. Out of sample it called direction ${Math.round(b.hitRate * 100)}% right vs ${Math.round(b.naiveRate * 100)}% for always guessing the majority.`
      : `No tested edge: out of sample it called direction ${Math.round(b.hitRate * 100)}% right vs ${Math.round(b.naiveRate * 100)}% for always guessing the majority, so no buy or sell lean is given.`)
    + ` The range held ${Math.round(b.coverage * 100)}% of the time out of sample.`;
  return {
    horizon: f.horizon, interval: intervalName(interval), until, last: f.last, bottom: f.bottom, mid: f.mid, top: f.top,
    chanceHigher: f.pUp, verdict: f.verdict, edge,
    factors: f.factors.map((k) => ({ label: k.label, score: +k.score.toFixed(3), note: k.note, tested: k.tested })),
    flags: f.flags.map((x) => x.label), backtest: b, text,
  };
}

export interface ForecastInput { pair: string; interval?: string; horizon?: number; venue?: Venue; theme?: ChartTheme; liquidations?: boolean }

export async function forecast(i: ForecastInput): Promise<{ data: ForecastSummary; text: string; svg: string }> {
  const pair = parsePair(i.pair);
  const iv = parseInterval(i.interval ?? '4h');
  const horizon = Math.max(1, Math.min(200, Math.round(i.horizon ?? DEFAULT_HORIZON)));
  const set = await candles(pair, iv, 1500, { venue: i.venue });
  const cs = set.candles;
  const d = detect(cs);
  let f = runForecast(cs, { horizon, patterns: d.patterns });
  if (!f) throw new Error(`not enough ${intervalName(iv)} history for a ${horizon}-candle forecast (${cs.length} candles); try a shorter horizon or interval`);
  const lq = i.liquidations === false ? null : await safe(liquidity(pair, iv, f.last));
  if (lq) f = withLiquidity(f, lq.long, lq.short);
  const s = summarise(f, iv);
  // the chart shows the closed candles the forecast used, plus the cone
  const closed = cs[cs.length - 1].closed ? cs : cs.slice(0, -1);
  const show = Math.min(closed.length, Math.max(60, 160 - horizon));
  const svg = chartSvg({
    title: `${pair.label} ${intervalName(iv)} · forecast ${horizon} candles`,
    subtitle: `${Math.round(f.pUp * 100)}% chance higher · 80% range ${fmtPrice(f.bottom)} to ${fmtPrice(f.top)} · ${s.edge ? `lean ${f.verdict}` : 'no tested edge'} · ${set.source}`,
    interval: iv, candles: closed, first: closed.length - show, theme: i.theme,
    forecast: { horizon, top: f.top, mid: f.mid, bottom: f.bottom },
    liquidity: lq ?? undefined,
  });
  const lines = [
    `${pair.label}, ${intervalName(iv)} candles, research forecast for ${horizon} candles (until about ${s.until}):`,
    s.text,
    `Factors: ${s.factors.map((k) => `${k.label} ${k.score >= 0 ? '+' : ''}${k.score.toFixed(2)} (${k.note}${k.tested ? '' : ', not backtested'})`).join('; ')}.`,
    `Flags: ${s.flags.join(', ') || 'none'}. Learned from ${f.backtest.samples} past candles (${set.source}).`,
    'A small transparent model checked against its own history; research only, not financial advice.',
  ];
  return { data: s, text: lines.join('\n'), svg };
}

// ---------------------------------------------------------------- charts

export interface ChartInput {
  pair: string;
  /** look-back: 1d, 1w, 1m (month), 3m, 6m, 1y... ignored when from is given */
  period?: string;
  from?: string; to?: string;
  interval?: string;
  venue?: Venue;
  theme?: ChartTheme;
  patterns?: boolean;
  bollinger?: boolean;
  liquidations?: boolean;
}

interface Range { t0: number; t1: number; iv: Interval }

function range(i: { period?: string; from?: string; to?: string; interval?: string }, fallback = '1m'): Range {
  const now = Date.now();
  const t1 = i.to ? parseDate(i.to) : now;
  const t0 = i.from ? parseDate(i.from) : t1 - parsePeriod(i.period ?? fallback);
  if (!(t1 > t0)) throw new Error('"to" must be after "from"');
  if (t0 > now) throw new Error('that range is in the future');
  const iv = i.interval ? parseInterval(i.interval) : autoInterval(t1 - t0);
  const bars = (t1 - t0) / intervalMs(iv);
  if (bars > 1500) throw new Error(`${Math.round(bars)} ${intervalName(iv)} candles is too many for one chart; use a larger interval or a shorter range`);
  if (bars < 3) throw new Error(`only ${bars.toFixed(1)} ${intervalName(iv)} candles in that range; use a smaller interval`);
  return { t0, t1, iv };
}

/** Candles covering [t0 - warm-up, t1 + after], and the index of the first bar inside the range. */
async function load(pair: ReturnType<typeof parsePair>, r: Range, venue: Venue | undefined, after = 0): Promise<{ set: CandleSet; first: number; lastIn: number }> {
  const ms = intervalMs(r.iv);
  const end = Math.min(Date.now() + 1, r.t1 + ms + after);
  const bars = Math.ceil((end - r.t0) / ms) + 120;
  const set = await candles(pair, r.iv, bars, { venue, before: end });
  const cs = set.candles;
  let first = cs.findIndex((c) => c.t + ms > r.t0);
  if (first < 0) throw new Error('no candles in that range');
  const lastIn = Math.max(first, at(cs, r.t1));
  return { set, first, lastIn };
}

export interface Numbered { n: number; hit: PatternHit; heading: string; text: string }

/** Patterns of a detection worth listing: everything with a direction, plus neutral chart patterns. Newest first, numbered. */
function numbered(e: Explanation, ps: PatternHit[]): Numbered[] {
  const by = new Map(ps.map((p) => [p.id, p]));
  return e.items.map((it, k) => ({ n: k + 1, hit: by.get(it.id)!, heading: it.heading, text: it.text })).filter((x) => x.hit);
}

export async function chart(i: ChartInput): Promise<{ text: string; svg: string; data: object }> {
  const pair = parsePair(i.pair);
  const r = range(i);
  const { set, first } = await load(pair, r, i.venue);
  const cs = set.candles;
  const shown = cs.slice(first);
  const a = shown[0], z = shown[shown.length - 1];
  let hi = -Infinity, lo = Infinity, hiT = 0, loT = 0, vol = 0;
  for (const c of shown) { if (c.h > hi) { hi = c.h; hiT = c.t; } if (c.l < lo) { lo = c.l; loT = c.t; } vol += c.v; }
  let marks: Numbered[] = [];
  if (i.patterns !== false) {
    const d = detect(cs, shown.length);
    // chart patterns over the whole range; candle signals only on the last 30 bars, or the chart drowns in them
    const ps = d.patterns.filter((p) => p.end >= first && (p.family === 'chart' || (p.bias !== 0 && p.end >= cs.length - 30)));
    const e = explain(ps, { t: cs.map((c) => c.t), last: z.c, decimals: decimals(z.c), window: null, symbol: pair.label, interval: r.iv });
    marks = numbered(e, ps);
  }
  const lq = i.liquidations ? await safe(liquidity(pair, r.iv, z.c)) : null;
  const change = pct(a.o, z.c);
  const svg = chartSvg({
    title: `${pair.label} ${intervalName(r.iv)} · ${fmtDate(a.t, r.iv)} to ${fmtDate(z.t, r.iv)} UTC`,
    subtitle: `${fmtPrice(z.c)} · ${sgn(change)} over the range · high ${fmtPrice(hi)} · low ${fmtPrice(lo)} · ${set.source}`,
    interval: r.iv, candles: cs, first, theme: i.theme, bollinger: i.bollinger,
    patterns: marks.map((m) => ({ ...m.hit, n: m.n })), liquidity: lq ?? undefined,
  });
  const dp = decimals(z.c);
  const lines = [
    `${pair.label}, ${shown.length} ${intervalName(r.iv)} candles from ${iso(a.t)} to ${iso(z.t)} (${set.source}).`,
    `Open ${fmtPrice(a.o, dp)}, last ${fmtPrice(z.c, dp)} (${sgn(change)}). High ${fmtPrice(hi, dp)} on ${iso(hiT)}, low ${fmtPrice(lo, dp)} on ${iso(loT)}. Volume ${fmtCompact(vol)} ${pair.base}.`,
  ];
  if (marks.length) lines.push(`Patterns on the chart (numbers match the labels, newest first):`, ...marks.slice(0, 25).map((m) => `#${m.n} ${m.heading}`));
  else if (i.patterns !== false) lines.push('No directional patterns found in this range.');
  if (lq) lines.push(`Liquidation clusters (${lq.source}): longs ${lq.long ? fmtPrice(lq.long.price, dp) : 'none'}, shorts ${lq.short ? fmtPrice(lq.short.price, dp) : 'none'}.`);
  return { text: lines.join('\n'), svg, data: { pair: pair.label, interval: intervalName(r.iv), from: iso(a.t), to: iso(z.t), open: a.o, last: z.c, high: hi, low: lo, changePct: change, candles: shown.length, patterns: marks.map((m) => ({ n: m.n, kind: m.hit.kind, label: m.hit.label, status: m.hit.status, start: iso(cs[m.hit.start].t), end: iso(cs[m.hit.end].t), target: m.hit.target, stop: m.hit.stop })) } };
}

export interface PatternInput {
  pair: string;
  from?: string; to?: string; period?: string;
  interval?: string;
  venue?: Venue;
  theme?: ChartTheme;
  /** 'chart' (multi-bar formations), 'candle' (candlestick and volatility signals) or 'all' */
  kinds?: 'chart' | 'candle' | 'all';
}

/**
 * Patterns that start and end inside [from, to], found the way the app's drawn
 * analysis window finds them, drawn on a chart with some context either side.
 */
export async function patterns(i: PatternInput): Promise<{ text: string; svg: string; data: object }> {
  const pair = parsePair(i.pair);
  const r = range(i, '3m');
  const ms = intervalMs(r.iv);
  const ctx = Math.max(5, Math.round(((r.t1 - r.t0) / ms) * 0.12));
  const { set, first, lastIn } = await load(pair, r, i.venue, ctx * ms);
  const cs = set.candles;
  const lastC = cs[cs.length - 1].c;
  let lo = Infinity, hi = -Infinity;
  for (let k = first; k <= lastIn; k++) { lo = Math.min(lo, cs[k].l); hi = Math.max(hi, cs[k].h); }
  const w = { t0: cs[first].t, t1: cs[lastIn].t, p0: lo, p1: hi };
  const d = detectInWindow(cs, w);
  if (!d) throw new Error('fewer than 3 candles in that range; use a smaller interval');
  const kinds = i.kinds ?? 'all';
  const ps = d.patterns.filter((p) => kinds === 'all' || (kinds === 'chart' ? p.family === 'chart' : p.family !== 'chart'));
  const e = explain(ps, { t: cs.map((c) => c.t), last: lastC, decimals: decimals(lastC), window: w, symbol: pair.label, interval: r.iv });
  const marks = numbered(e, ps);
  const startAt = Math.max(0, first - ctx);
  const svg = chartSvg({
    title: `${pair.label} ${intervalName(r.iv)} patterns · ${fmtDate(w.t0, r.iv)} to ${fmtDate(w.t1, r.iv)} UTC`,
    subtitle: `${marks.length} pattern${marks.length === 1 ? '' : 's'} with a direction in the shaded range · ${set.source}`,
    interval: r.iv, candles: cs, first: startAt, theme: i.theme,
    patterns: marks.map((m) => ({ ...m.hit, n: m.n })), window: { t0: w.t0, t1: w.t1 },
  });
  const out = d.outcomes.filter((o) => o.hit + o.stopped + o.open > 0)
    .map((o) => `${o.kind}: ${o.hit} reached target, ${o.stopped} stopped, ${o.open} open`);
  const lines = [
    `${e.title}, ${iso(w.t0)} to ${iso(w.t1)} (${lastIn - first + 1} candles, ${set.source}).`,
    e.summary,
    '',
    ...marks.flatMap((m) => [`#${m.n} ${m.heading}`, m.text, '']),
  ];
  if (out.length) lines.push(`How confirmed patterns played out here: ${out.join('; ')}.`);
  return {
    text: lines.join('\n').trim(), svg,
    data: {
      pair: pair.label, interval: intervalName(r.iv), from: iso(w.t0), to: iso(w.t1),
      patterns: marks.map((m) => ({ n: m.n, kind: m.hit.kind, label: m.hit.label, family: m.hit.family, bias: m.hit.bias, status: m.hit.status, start: iso(cs[m.hit.start].t), end: iso(cs[m.hit.end].t), target: m.hit.target, stop: m.hit.stop, score: m.hit.score })),
      outcomes: d.outcomes,
    },
  };
}

// ---------------------------------------------------------------- liquidations

export async function liquidations(i: { pair: string; interval?: string }): Promise<{ text: string; data: object }> {
  const pair = parsePair(i.pair);
  const iv = parseInterval(i.interval ?? '1h');
  const set = await candles(pair, 60, 2);
  const last = set.candles[set.candles.length - 1].c;
  const lq = await liquidity(pair, iv, last);
  const dp = decimals(last);
  // the five largest rows each side
  const top = (k: 1 | 2) => lq.rows.filter((r) => r[k] > 0).sort((a, b) => b[k] - a[k]).slice(0, 5).sort((a, b) => b[0] - a[0]);
  const longs = top(1), shorts = top(2);
  const fmt = (rs: [number, number, number][], k: 1 | 2) => rs.map((r) => `${fmtPrice(r[0], dp)} (${fmtCompact(r[k])}, ${sgn(pct(last, r[0]))})`).join(', ');
  const text = [
    `${pair.label} estimated liquidation levels from Binance ${lq.symbol} (${lq.source}, ${lq.bars} ${intervalName(Math.min(iv, 1440))} bars), last price ${fmtPrice(last, dp)}.`,
    `Largest clusters: longs ${lq.long ? `${fmtPrice(lq.long.price, dp)} (${fmtCompact(lq.long.notional)} USDT)` : 'none'}, shorts ${lq.short ? `${fmtPrice(lq.short.price, dp)} (${fmtCompact(lq.short.notional)} USDT)` : 'none'}.`,
    `Biggest long rows: ${fmt(longs, 1) || 'none'}.`,
    `Biggest short rows: ${fmt(shorts, 2) || 'none'}.`,
    'An estimate from open interest and volume with an assumed leverage mix, like every public liquidation heatmap; exchanges do not publish these levels.',
  ].join('\n');
  return { text, data: { pair: pair.label, last, source: lq.source, symbol: lq.symbol, long: lq.long, short: lq.short, longs, shorts } };
}
