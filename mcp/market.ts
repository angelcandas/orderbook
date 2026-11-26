/**
 * Market data for the MCP server, over the same public REST endpoints the app
 * uses (Binance spot klines and depth, Kraken OHLC, Binance USD-M futures for
 * liquidation levels). Nothing here needs an API key.
 */
import type { Candle } from '../src/patterns/candle';
import { binanceHistory, krakenOhlc, stitchOlder } from '../src/feeds/history';
import { aggregate } from '../src/feeds/aggregate';
import {
  INTERVAL_DEFS, KRAKEN_NATIVE, LIVE, MONTH, binanceInterval, intervalMs, krakenBase, localEndpoints, nextBucket,
  type Endpoints, type Interval,
} from '../src/shared/config';
import { futuresSymbol } from '../src/liquidation/model';
import { LiqSeries, periods, type Bar, type OiPoint } from '../src/liquidation/series';

export type Venue = 'binance' | 'kraken';

/**
 * Endpoints: live exchanges by default. DEPTHLINE_ENDPOINTS=local (or
 * host:port) points everything at the repo's emulator (`npm run emulator`).
 */
export function endpoints(env = process.env.DEPTHLINE_ENDPOINTS): Endpoints {
  if (!env || env === 'live') return LIVE;
  return localEndpoints(env === 'local' ? 'localhost:8787' : env);
}

export interface Pair {
  base: string;
  quote: string;
  /** Binance spot symbol, e.g. BTCUSDT */
  binance: string;
  /** Kraken WS v2 style symbol, e.g. BTC/USD */
  kraken: string;
  label: string;
}

const QUOTES = ['USDT', 'USDC', 'USD', 'EUR', 'BTC', 'ETH'];

/** "btc", "BTC/USD", "BTCUSDT", "eth-usdt" -> a pair. A bare asset means its USD pair. */
export function parsePair(input: string): Pair {
  const s = input.trim().toUpperCase().replace(/[-_ ]/g, '/');
  if (!s) throw new Error('pair is empty');
  let base: string, quote: string;
  if (s.includes('/')) [base, quote] = s.split('/').filter(Boolean) as [string, string];
  else {
    const q = QUOTES.find((q) => s.length > q.length && s.endsWith(q));
    base = q ? s.slice(0, -q.length) : s;
    quote = q ?? 'USD';
  }
  if (!base || !quote || !/^[A-Z0-9]+$/.test(base + quote)) throw new Error(`can't read pair "${input}"; try BTC, ETH/USD or SOLUSDT`);
  if (base === 'XBT') base = 'BTC';
  if (base === 'XDG') base = 'DOGE';
  // Binance lists almost no USD pairs: USD there means USDT, as in the app
  const bq = quote === 'USD' ? 'USDT' : quote;
  const kq = quote === 'USDT' ? 'USD' : quote;
  return { base, quote, binance: base + bq, kraken: `${base}/${kq}`, label: `${base}/${quote}` };
}

/** "1h", "4h", "1d", "1D", "1w", "1M" (month), "1mo" -> minutes. */
export function parseInterval(input: string): Interval {
  const s = input.trim();
  const exact = INTERVAL_DEFS.find((d) => d.label === s);
  if (exact) return exact.m;
  const l = s.toLowerCase();
  if (l === '1mo' || l === '1mon' || l === 'month' || l === '1month') return MONTH;
  const loose = INTERVAL_DEFS.find((d) => d.label.toLowerCase() === l && d.m !== MONTH);
  if (loose) return loose.m;
  throw new Error(`unknown interval "${input}"; use one of ${INTERVAL_DEFS.map((d) => d.label).join(' ')}`);
}

export const intervalName = (m: Interval) => INTERVAL_DEFS.find((d) => d.m === m)?.label ?? `${m}m`;

const DAY = 86_400_000;
/** Look-back periods, named the way people say them. In a period "m" means months. */
export const PERIODS: Record<string, number> = {
  '1d': DAY, '3d': 3 * DAY, '1w': 7 * DAY, '2w': 14 * DAY, '1m': 30 * DAY, '3m': 91 * DAY,
  '6m': 182 * DAY, '1y': 365 * DAY, '2y': 730 * DAY, '5y': 1826 * DAY,
};

export function parsePeriod(input: string): number {
  const l = input.trim().toLowerCase().replace(/^(\d+)\s*(mo|mon|month|months)$/, '$1m').replace(/^(\d+)\s*(days?)$/, '$1d')
    .replace(/^(\d+)\s*(weeks?)$/, '$1w').replace(/^(\d+)\s*(years?)$/, '$1y').replace(/^24h$/, '1d');
  const ms = PERIODS[l];
  if (ms) return ms;
  const m = /^(\d+)([dwmy])$/.exec(l);
  if (m) return +m[1] * { d: DAY, w: 7 * DAY, m: 30 * DAY, y: 365 * DAY }[m[2] as 'd']!;
  throw new Error(`unknown period "${input}"; use e.g. 1d, 1w, 1m (month), 3m, 1y`);
}

/** A date: ISO date or date-time, or a unix time in seconds or ms. */
export function parseDate(input: string): number {
  const s = input.trim();
  if (/^\d{9,10}$/.test(s)) return +s * 1000;
  if (/^\d{12,13}$/.test(s)) return +s;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (!Number.isFinite(t)) throw new Error(`can't read date "${input}"; use YYYY-MM-DD`);
  return t;
}

/** The candle size that shows `span` ms in about 60 to 200 candles. */
export function autoInterval(span: number): Interval {
  for (const d of INTERVAL_DEFS) if (span / intervalMs(d.m) <= 200) return d.m;
  return MONTH;
}

async function getJson(url: string): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      if (body.includes('-1121')) throw new Error(`${new URL(url).searchParams.get('symbol')} is not listed there`);
      throw new Error(`${r.status} from ${new URL(url).host}${body ? `: ${body.slice(0, 160)}` : ''}`);
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Mark the last candle open when its bar hasn't ended yet. */
function markLive(cs: Candle[], m: Interval, now = Date.now()): Candle[] {
  const last = cs[cs.length - 1];
  if (last && nextBucket(last.t, m) > now) last.closed = false;
  return cs;
}

export interface CandleSet {
  pair: Pair;
  venue: Venue;
  interval: Interval;
  candles: Candle[];
  /** where the bars came from, for the reply */
  source: string;
}

/**
 * Up to `bars` candles that open before `before` (default now), oldest first.
 * Kraken's REST only returns its latest 720 bars, so older Kraken history comes
 * from the Binance pair rescaled onto Kraken's price, as in the app.
 */
export async function candles(pair: Pair, interval: Interval, bars: number, o: { venue?: Venue; before?: number; ep?: Endpoints } = {}): Promise<CandleSet> {
  const ep = o.ep ?? endpoints();
  const venue = o.venue ?? 'binance';
  const before = Math.min(o.before ?? Infinity, Date.now() + 1);
  bars = Math.max(1, Math.min(5000, Math.round(bars)));
  const bin = () => binanceHistory(getJson, ep.binanceRest, pair.binance, binanceInterval(interval), before, bars);
  if (venue === 'binance') {
    const cs = await bin();
    if (!cs.length) throw new Error(`Binance has no ${pair.binance} candles there`);
    return { pair, venue, interval, candles: markLive(cs, interval), source: `Binance ${pair.binance}` };
  }
  const kb = krakenBase(interval);
  let recent = await krakenOhlc(getJson, ep.krakenRest ?? LIVE.krakenRest!, pair.kraken, kb);
  if (kb !== interval) recent = aggregate(recent, interval, kb * 60_000);
  else if (!KRAKEN_NATIVE.includes(interval)) throw new Error(`Kraken has no ${intervalName(interval)} candles`);
  recent = recent.filter((c) => c.t < before);
  markLive(recent, interval);
  let source = `Kraken ${pair.kraken}`;
  if (recent.length < bars) {
    try {
      const older = await binanceHistory(getJson, ep.binanceRest, pair.binance, binanceInterval(interval), before, bars);
      const add = stitchOlder(older, recent);
      if (add.length) { recent = add.concat(recent); source += `, older bars from Binance ${pair.binance} rescaled`; }
    } catch { /* Kraken alone */ }
  }
  if (!recent.length) throw new Error(`Kraken has no ${pair.kraken} candles there`);
  return { pair, venue, interval, candles: recent.slice(-bars), source };
}

export interface Book {
  bid: number; ask: number; mid: number;
  spreadBps: number;
  /** bid and ask notional within 1% of mid, quote currency */
  bidDepth1: number; askDepth1: number;
  /** (bid - ask) / (bid + ask) of that depth, -1..1 */
  imbalance: number;
  levels: number;
}

/** A depth snapshot (Binance REST, or Kraken REST when venue is kraken). */
export async function book(pair: Pair, venue: Venue = 'binance', ep: Endpoints = endpoints()): Promise<Book> {
  let bids: [number, number][], asks: [number, number][];
  if (venue === 'kraken') {
    const krest = ep.krakenRest ?? LIVE.krakenRest!;
    const r = await getJson(`${krest}/0/public/Depth?pair=${pair.kraken.replace('/', '').replace(/^BTC/, 'XBT').replace(/^DOGE/, 'XDG')}&count=500`);
    if (r?.error?.length) throw new Error(r.error.join(', '));
    const k = Object.keys(r.result ?? {})[0];
    bids = r.result[k].bids.map((x: any[]) => [+x[0], +x[1]]);
    asks = r.result[k].asks.map((x: any[]) => [+x[0], +x[1]]);
  } else {
    const r = await getJson(`${ep.binanceRest}/api/v3/depth?symbol=${pair.binance}&limit=1000`);
    bids = r.bids.map((x: string[]) => [+x[0], +x[1]]);
    asks = r.asks.map((x: string[]) => [+x[0], +x[1]]);
  }
  return summariseBook(bids, asks);
}

export function summariseBook(bids: [number, number][], asks: [number, number][]): Book {
  const bid = bids[0]?.[0] ?? NaN, ask = asks[0]?.[0] ?? NaN;
  const mid = (bid + ask) / 2;
  let bd = 0, ad = 0;
  for (const [p, q] of bids) if (p >= mid * 0.99) bd += p * q;
  for (const [p, q] of asks) if (p <= mid * 1.01) ad += p * q;
  return {
    bid, ask, mid, spreadBps: ((ask - bid) / mid) * 1e4, bidDepth1: bd, askDepth1: ad,
    imbalance: bd + ad > 0 ? (bd - ad) / (bd + ad) : 0, levels: bids.length + asks.length,
  };
}

export interface Liquidity {
  /** futures symbol the map was built from */
  symbol: string;
  /** 'open interest' when OI history was reachable, else a volume based estimate */
  source: 'open interest' | 'volume estimate';
  /** futures-to-chart price factor (cluster prices are already multiplied by it) */
  scale: number;
  long?: { price: number; notional: number };
  short?: { price: number; notional: number };
  /** the whole estimated map at the last bar, in chart prices: [price, longs, shorts] per row */
  rows: [number, number, number][];
  bars: number;
}

/**
 * Estimated liquidation levels from Binance USD-M futures klines and open
 * interest history, built with the app's model. `chartLast` rescales futures
 * prices onto the chart's (Kraken USD or spot) price.
 */
export async function liquidity(pair: Pair, interval: Interval, chartLast: number, ep: Endpoints = endpoints()): Promise<Liquidity> {
  const fs = futuresSymbol(`${pair.base}USDT`);
  const iv = Math.min(interval, 1440);
  const p = periods(iv);
  const limit = iv < 5 ? 1000 : 500;
  const toBars = (rows: any[]): Bar[] => rows.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  const fr = ep.futuresRest ?? LIVE.futuresRest!;
  let bars: Bar[], oi: OiPoint[] = [], source: Liquidity['source'] = 'open interest';
  try {
    const [k, o] = await Promise.all([
      getJson(`${fr}/fapi/v1/klines?symbol=${fs.symbol}&interval=${p.kline}&limit=${limit}`),
      getJson(`${fr}/futures/data/openInterestHist?symbol=${fs.symbol}&period=${p.oi}&limit=500`),
    ]);
    bars = toBars(k);
    oi = (o as any[]).map((x) => ({ t: +x.timestamp, oi: +x.sumOpenInterest })).sort((a, b) => a.t - b.t);
  } catch (err) {
    if (/^400/.test(String((err as Error).message))) throw new Error(`no ${fs.symbol} perpetual on Binance futures`);
    // futures REST unreachable (it is geo-blocked in some countries): spot bars, volume estimate
    const k = await getJson(`${ep.binanceRest}/api/v3/klines?symbol=${pair.base}USDT&interval=${p.kline}&limit=${limit}`);
    bars = toBars(k);
    source = 'volume estimate';
  }
  const s = new LiqSeries(iv * 60_000);
  s.replay(bars, oi);
  const m = s.map;
  const futLast = m.lastPrice || bars[bars.length - 1]?.c || 0;
  const scale = futLast > 0 && chartLast > 0 ? chartLast / futLast : 1 / fs.mult;
  const c = m.clusters();
  const rows: [number, number, number][] = [];
  for (let r = 0; r < m.bins; r++) if (m.longs[r] > 0 || m.shorts[r] > 0) rows.push([(m.origin + (r + 0.5) * m.step) * scale, m.longs[r], m.shorts[r]]);
  const sc = (x?: { price: number; notional: number }) => x && { price: x.price * scale, notional: x.notional };
  return { symbol: fs.symbol, source, scale, long: sc(c.long), short: sc(c.short), rows, bars: bars.length };
}
