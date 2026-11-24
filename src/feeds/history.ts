import type { Candle } from '../patterns/candle';
import type { Fetcher } from './types';

/**
 * Candle history backfill over public REST, so the pattern detectors see more
 * than the ~720 bars a live subscription snapshot carries.
 *
 * Binance spot klines return at most 1000 bars per call; we page backwards with
 * endTime. Kraken's WebSocket OHLC snapshot carries only a handful of recent
 * bars in production, and its REST OHLC endpoint only ever returns the latest
 * 720, so Kraken gets its own 720 from REST (when the browser can reach it) and
 * anything older from the matching Binance pair, rescaled to Kraken's price
 * level (see `stitchOlder`).
 */

/** total bars we aim to hold per series (live snapshot plus backfill) */
export const HISTORY_BARS = 3000;
/** hard cap in the analytics worker, so a long session doesn't grow without bound */
export const MAX_BARS = 4000;
const PAGE = 1000;
const PAGE_GAP_MS = 150; // spread REST weight; each klines call costs 2

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function klineRows(rows: any[]): Candle[] {
  return rows.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], closed: true }));
}

/**
 * Up to `bars` closed Binance klines that open strictly before `before` (ms),
 * oldest first. Stops early when the venue has no older data. `alive` lets the
 * caller abandon the fetch when the user switched pair or interval.
 */
export async function binanceHistory(
  fetchJson: Fetcher, restBase: string, symbol: string, interval: string,
  before: number, bars: number, alive: () => boolean = () => true,
): Promise<Candle[]> {
  const pages: Candle[][] = [];
  let got = 0;
  let end = before - 1;
  while (got < bars && alive()) {
    const limit = Math.min(PAGE, bars - got);
    const rows: any[] = await fetchJson(`${restBase}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&endTime=${end}`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    const cs = klineRows(rows).filter((c) => c.t < before);
    pages.unshift(cs);
    got += cs.length;
    end = rows[0][0] - 1;
    if (rows.length < limit) break;
    if (got < bars) await sleep(PAGE_GAP_MS);
  }
  return pages.flat();
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
};

/**
 * Bars from another venue (`older`) that precede `recent[0]`, rescaled to
 * `recent`'s price and volume level using the bars both series share. Returns
 * [] when the two don't overlap, since a gap would fake breakouts. Prices across
 * BTC/USD and BTC/USDT differ by a basis of a few hundredths of a percent, which
 * a single ratio removes well enough for shape based pattern detection.
 */
export function stitchOlder(older: Candle[], recent: Candle[]): Candle[] {
  if (!older.length || !recent.length) return [];
  const at = new Map<number, Candle>();
  for (const c of recent) at.set(c.t, c);
  const px: number[] = [];
  let vr = 0, vo = 0;
  for (const c of older) {
    const k = at.get(c.t);
    if (!k || !k.closed || !(c.c > 0)) continue;
    px.push(k.c / c.c);
    vr += k.v; vo += c.v;
  }
  if (px.length < 1) return [];
  const p = median(px);
  const v = vo > 0 ? vr / vo : 1;
  const first = recent[0].t;
  const out: Candle[] = [];
  for (const c of older) {
    if (c.t >= first) break;
    out.push({ t: c.t, o: c.o * p, h: c.h * p, l: c.l * p, c: c.c * p, v: c.v * v, closed: true });
  }
  return out;
}

/** Kraken REST pair name for a WS v2 symbol: BTC/USD -> XBTUSD, DOGE/USD -> XDGUSD */
export function krakenRestPair(symbol: string): string {
  const [b, q] = symbol.split('/');
  const base = b === 'BTC' ? 'XBT' : b === 'DOGE' ? 'XDG' : b;
  return base + q;
}

/** Kraken's latest (up to 720) OHLC bars over REST, oldest first, all marked closed. */
export async function krakenOhlc(fetchJson: Fetcher, restBase: string, symbol: string, intervalMin: number): Promise<Candle[]> {
  const r = await fetchJson(`${restBase}/0/public/OHLC?pair=${krakenRestPair(symbol)}&interval=${intervalMin}`);
  if (r?.error?.length) throw new Error(r.error.join(', '));
  const key = Object.keys(r?.result ?? {}).find((k) => k !== 'last');
  const rows: any[] = key ? r.result[key] : [];
  return rows.map((x) => ({ t: x[0] * 1000, o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[6], closed: true }));
}

/** interval of a series in ms, from its first two bars; 0 when unknown */
export const stepOf = (cs: Candle[]) => (cs.length > 1 ? cs[1].t - cs[0].t : 0);

/**
 * Prepend `older` to `list` where it ends right where `list` begins (one step
 * before, or overlapping). Returns the merged list capped at `max` bars.
 */
export function prepend(list: Candle[], older: Candle[], max = MAX_BARS): Candle[] {
  if (!older.length) return list;
  if (!list.length) return older.slice(-max);
  const step = stepOf(list) || stepOf(older);
  const first = list[0].t;
  const keep = older.filter((c) => c.t < first);
  if (!keep.length) return list;
  // gap: don't stitch (1.5 steps of slack: months run 28 to 31 days)
  if (step && first - keep[keep.length - 1].t > step * 1.5) return list;
  const out = keep.concat(list);
  return out.length > max ? out.slice(out.length - max) : out;
}
