import { PAIRS, type Venue } from './config';

/**
 * Currency pairs across venues. A pair is named by its two assets in a common
 * spelling ("BTC/USDT", "ETH/EUR"); each venue has its own symbol for it
 * (Kraken WS v2 "BTC/USDT", Binance "BTCUSDT"). The list of what each venue
 * lists comes from the venue itself (Kraken's instrument channel, Binance's
 * exchangeInfo), read in the feed workers; the built in PAIRS are the fallback.
 */

/** one market a venue lists, in that venue's symbol, with assets in common spelling */
export interface Market { symbol: string; base: string; quote: string }
export type Catalog = Record<Venue, Market[]>;

/** Kraken's legacy asset codes; WS v2 already uses BTC and DOGE, REST still says XBT/XDG */
const ALIASES: Record<string, string> = { XBT: 'BTC', XDG: 'DOGE' };
export const normAsset = (a: string): string => {
  const u = a.trim().toUpperCase();
  return ALIASES[u] ?? u;
};

export const pairLabel = (base: string, quote: string) => `${base}/${quote}`;

export function splitLabel(label: string): { base: string; quote: string } | null {
  const m = /^([A-Z0-9.]+)\/([A-Z0-9.]+)$/i.exec(label.trim());
  return m ? { base: normAsset(m[1]), quote: normAsset(m[2]) } : null;
}

/**
 * Quotes that stand in for each other when a venue doesn't list the exact
 * pair, best first. Binance lists almost no USD pairs, so "BTC/USD" there
 * means BTCUSDT (as it always has in this app); the app says so.
 */
const STAND_INS: Record<string, string[]> = {
  USD: ['USDT', 'USDC'],
  USDT: ['USD', 'USDC'],
  USDC: ['USD', 'USDT'],
};

export interface Resolved {
  symbol: string;
  base: string;
  quote: string;
  /** true when `quote` is a stand in for the quote that was asked for */
  standIn: boolean;
}

/** Index of one venue's markets by common label, for fast lookups. */
export class MarketIndex {
  private byLabel = new Map<string, Market>();
  constructor(readonly markets: Market[]) {
    for (const m of markets) this.byLabel.set(pairLabel(m.base, m.quote), m);
  }
  get(base: string, quote: string): Market | undefined {
    return this.byLabel.get(pairLabel(base, quote));
  }
  get size() { return this.byLabel.size; }

  /** the venue's symbol for a pair, an exact listing first, then a stand in quote */
  resolve(label: string): Resolved | null {
    const p = splitLabel(label);
    if (!p) return null;
    const exact = this.get(p.base, p.quote);
    if (exact) return { symbol: exact.symbol, base: p.base, quote: p.quote, standIn: false };
    for (const q of STAND_INS[p.quote] ?? []) {
      const m = this.get(p.base, q);
      if (m) return { symbol: m.symbol, base: p.base, quote: q, standIn: true };
    }
    return null;
  }
}

/** Markets from Kraken WS v2 `instrument` snapshot pairs. */
export function krakenMarkets(pairs: any[]): Market[] {
  const out: Market[] = [];
  for (const p of pairs ?? []) {
    if (!p?.symbol || (p.status && p.status !== 'online')) continue;
    const [b, q] = String(p.symbol).split('/');
    const base = normAsset(p.base ?? b ?? '');
    const quote = normAsset(p.quote ?? q ?? '');
    if (base && quote) out.push({ symbol: p.symbol, base, quote });
  }
  return out;
}

/** Markets from a Binance spot exchangeInfo response, trading symbols only. */
export function binanceMarkets(info: any): Market[] {
  const out: Market[] = [];
  for (const s of info?.symbols ?? []) {
    if (!s?.symbol || (s.status && s.status !== 'TRADING')) continue;
    if (s.isSpotTradingAllowed === false) continue;
    const base = normAsset(s.baseAsset ?? '');
    const quote = normAsset(s.quoteAsset ?? '');
    if (base && quote) out.push({ symbol: s.symbol, base, quote });
  }
  return out;
}

/** The built in pairs as a catalogue, used until the venues answer (and by the emulator). */
export function builtinCatalog(): Catalog {
  return {
    kraken: PAIRS.map((p) => {
      const [base, quote] = p.kraken.split('/');
      return { symbol: p.kraken, base, quote };
    }),
    binance: PAIRS.map((p) => ({ symbol: p.binance, base: p.binance.replace(/USDT$/, ''), quote: 'USDT' })),
  };
}

const PINNED_QUOTES = ['USD', 'USDT', 'USDC', 'EUR', 'GBP', 'BTC', 'ETH'];

/** Quotes ranked for the picker's filter chips: the common ones first, then by how many pairs use them. */
export function quoteRanking(catalog: Catalog): string[] {
  const n = new Map<string, number>();
  for (const v of ['kraken', 'binance'] as Venue[])
    for (const m of catalog[v]) n.set(m.quote, (n.get(m.quote) ?? 0) + 1);
  const pinned = PINNED_QUOTES;
  const rest = [...n.keys()].filter((q) => !pinned.includes(q)).sort((a, b) => n.get(b)! - n.get(a)!);
  return pinned.filter((q) => n.has(q)).concat(rest);
}

export interface PairEntry { label: string; base: string; quote: string; kraken: boolean; binance: boolean }

/** Every pair either venue lists exactly, one entry per label. */
export function allPairs(catalog: Catalog): PairEntry[] {
  const m = new Map<string, PairEntry>();
  for (const v of ['kraken', 'binance'] as Venue[]) {
    for (const x of catalog[v]) {
      const label = pairLabel(x.base, x.quote);
      let e = m.get(label);
      if (!e) m.set(label, (e = { label, base: x.base, quote: x.quote, kraken: false, binance: false }));
      e[v] = true;
    }
  }
  const pop = new Map(PAIRS.map((p, i) => [p.label.split('/')[0], i]));
  const qr = (q: string) => { const i = PINNED_QUOTES.indexOf(q); return i < 0 ? 99 : i; };
  // the app's well known assets first, then alphabetical; within an asset, common quotes first
  return [...m.values()].sort((a, b) =>
    (pop.get(a.base) ?? 1e9) - (pop.get(b.base) ?? 1e9) || a.base.localeCompare(b.base) ||
    qr(a.quote) - qr(b.quote) || a.quote.localeCompare(b.quote));
}

/** Pairs matching a search ("eth", "eth/eur", "eth eur", "eur"), best matches first. */
export function searchPairs(list: PairEntry[], query: string, quote: string | null): PairEntry[] {
  const q = query.trim().toUpperCase().replace(/[\s\-_]+/g, '/');
  const filtered = quote ? list.filter((p) => p.quote === quote) : list;
  if (!q) return filtered;
  const [qb, qq] = q.includes('/') ? q.split('/') : [q, ''];
  const score = (p: PairEntry): number => {
    if (qq !== '' || q.includes('/')) {
      if (!p.base.startsWith(qb) || !p.quote.startsWith(qq)) return -1;
      return p.base === qb ? (p.quote === qq ? 0 : 1) : 2;
    }
    if (p.base === q) return 0;
    if (p.base.startsWith(q)) return 1;
    if (p.quote === q) return 2;
    if (p.label.replace('/', '').startsWith(q)) return 3;
    if (p.base.includes(q)) return 4;
    return -1;
  };
  const scored: [PairEntry, number][] = [];
  for (const p of filtered) {
    const s = score(p);
    if (s >= 0) scored.push([p, s]);
  }
  // stable sort keeps the popularity order within a score
  return scored.sort((a, b) => a[1] - b[1]).map((x) => x[0]);
}

const CATALOG_KEY = 'depthline.catalog.v1';
const CATALOG_TTL = 24 * 3600 * 1000;

/** Compact cache of what the live venues list, so the picker is full right after a reload. */
export function loadCachedCatalog(): Partial<Catalog> {
  try {
    const raw = localStorage.getItem(CATALOG_KEY);
    if (!raw) return {};
    const c = JSON.parse(raw);
    const out: Partial<Catalog> = {};
    for (const v of ['kraken', 'binance'] as Venue[]) {
      const e = c?.[v];
      if (e && Date.now() - e.t < CATALOG_TTL && Array.isArray(e.m))
        out[v] = e.m.map((r: string[]) => ({ symbol: r[0], base: r[1], quote: r[2] }));
    }
    return out;
  } catch {
    return {};
  }
}

export function saveCachedCatalog(venue: Venue, markets: Market[]): void {
  try {
    const c = JSON.parse(localStorage.getItem(CATALOG_KEY) ?? '{}') ?? {};
    c[venue] = { t: Date.now(), m: markets.map((m) => [m.symbol, m.base, m.quote]) };
    localStorage.setItem(CATALOG_KEY, JSON.stringify(c));
  } catch { /* storage full or blocked: the venues are asked again next time */ }
}

const FAV_KEY = 'depthline.favourites.v1';

export function loadFavourites(): string[] {
  try {
    const xs = JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]');
    return Array.isArray(xs) ? xs.filter((x) => typeof x === 'string' && splitLabel(x)) : [];
  } catch {
    return [];
  }
}

export function saveFavourites(labels: string[]): void {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(labels)); } catch { /* blocked: favourites last this visit only */ }
}

export function toggleFavourite(favs: string[], label: string): string[] {
  return favs.includes(label) ? favs.filter((f) => f !== label) : [...favs, label];
}

/**
 * The symbols one venue keeps live: the focused pair plus the first built in
 * pairs up to `load` books in all (the load setting is a stress test knob).
 */
export function liveSymbols(focus: string | null, builtin: string[], load: number): string[] {
  const out: string[] = focus ? [focus] : [];
  for (const s of builtin) {
    if (out.length >= Math.max(1, load)) break;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}
