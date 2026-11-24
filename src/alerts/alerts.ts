import type { Venue } from '../shared/config';

/**
 * Price level alerts. The UI owns the list and keeps it in localStorage; each
 * feed worker gets the armed alerts for its venue and checks them on a slow
 * timer (CHECK_MS), never inside the per-message update path. A check is one
 * map lookup and two reads per alert, so the cost does not grow with the
 * update rate.
 */
export type Direction = 'above' | 'below';

export interface Alert {
  id: string;
  venue: Venue;
  /** the venue's own symbol, e.g. "BTC/USD" on Kraken or "BTCUSDT" on Binance */
  symbol: string;
  /** display label, e.g. "BTC/USD" */
  label: string;
  price: number;
  dir: Direction;
  created: number; // ms epoch
  /** set once it fired; a fired alert stays in the list until re-armed or removed */
  firedAt?: number;
  firedPrice?: number;
}

/** What a feed worker needs to check an alert. */
export interface ArmedAlert { id: string; symbol: string; price: number; dir: Direction }

export interface AlertHit { type: 'alert'; id: string; price: number; t: number }

export const CHECK_MS = 200;
export const STORAGE_KEY = 'depthline.alerts.v1';

/** Mid price, or NaN when either side is empty. */
export const midOf = (bestBid: number, bestAsk: number): number =>
  Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? (bestBid + bestAsk) / 2 : NaN;

/** An alert set above the current price waits for the price to rise to it, and the other way round. */
export const inferDirection = (level: number, current: number): Direction =>
  Number.isFinite(current) && level < current ? 'below' : 'above';

/** True when `price` has reached the level in the alert's direction. */
export const reached = (a: { price: number; dir: Direction }, price: number): boolean =>
  Number.isFinite(price) && (a.dir === 'above' ? price >= a.price : price <= a.price);

export const armed = (list: Alert[], venue: Venue): ArmedAlert[] =>
  list.filter((a) => a.venue === venue && a.firedAt === undefined).map(({ id, symbol, price, dir }) => ({ id, symbol, price, dir }));

/**
 * Checks armed alerts against a price source. `priceOf` returns the current
 * price of a symbol, or NaN when its book is not live (so a partial book while
 * syncing never fires an alert). Each alert fires once and is then dropped.
 */
export class AlertChecker {
  private list: ArmedAlert[] = [];

  set(list: ArmedAlert[]): void { this.list = list.slice(); }
  get size(): number { return this.list.length; }

  check(priceOf: (symbol: string) => number, now: number): AlertHit[] {
    if (this.list.length === 0) return [];
    const hits: AlertHit[] = [];
    let keep = 0;
    for (const a of this.list) {
      const p = priceOf(a.symbol);
      if (reached(a, p)) hits.push({ type: 'alert', id: a.id, price: p, t: now });
      else this.list[keep++] = a;
    }
    this.list.length = keep;
    return hits;
  }
}

// --- persistence -----------------------------------------------------------

const isAlert = (a: any): a is Alert =>
  a && typeof a.id === 'string' && (a.venue === 'kraken' || a.venue === 'binance') &&
  typeof a.symbol === 'string' && typeof a.label === 'string' &&
  typeof a.price === 'number' && Number.isFinite(a.price) && a.price > 0 &&
  (a.dir === 'above' || a.dir === 'below') && typeof a.created === 'number';

export function parseAlerts(raw: string | null): Alert[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(isAlert) : [];
  } catch {
    return [];
  }
}

export function loadAlerts(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Alert[] {
  try { return parseAlerts(storage?.getItem(STORAGE_KEY) ?? null); } catch { return []; }
}

export function saveAlerts(list: Alert[], storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* private mode or full */ }
}

function safeStorage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export const newId = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
