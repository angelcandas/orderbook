export type Venue = 'kraken' | 'binance';

export interface Endpoints {
  krakenWs: string;
  binanceWs: string; // base, e.g. wss://data-stream.binance.vision
  binanceRest: string; // base, e.g. https://data-api.binance.vision
  /** Kraken REST base for OHLC history; optional so older configs keep working */
  krakenRest?: string;
  /** Binance USD-M futures, for liquidation levels: WS root (routes /market) and REST root */
  futuresWs?: string;
  futuresRest?: string;
}

export const LIVE: Endpoints = {
  krakenWs: 'wss://ws.kraken.com/v2',
  binanceWs: 'wss://data-stream.binance.vision',
  binanceRest: 'https://data-api.binance.vision',
  krakenRest: 'https://api.kraken.com',
  futuresWs: 'wss://fstream.binance.com',
  futuresRest: 'https://fapi.binance.com',
};

/** The local replay / synthetic server speaks both venues' protocols. */
export function localEndpoints(host = 'localhost:8787'): Endpoints {
  return {
    krakenWs: `ws://${host}/kraken`,
    binanceWs: `ws://${host}/binance`,
    binanceRest: `http://${host}/binance`,
    krakenRest: `http://${host}/kraken`,
    futuresWs: `ws://${host}/futures`,
    futuresRest: `http://${host}/futures`,
  };
}

/** Kraken symbol <-> Binance symbol for the default pairs. */
export const PAIRS: { kraken: string; binance: string; label: string }[] = [
  { label: 'BTC/USD', kraken: 'BTC/USD', binance: 'BTCUSDT' },
  { label: 'ETH/USD', kraken: 'ETH/USD', binance: 'ETHUSDT' },
  { label: 'SOL/USD', kraken: 'SOL/USD', binance: 'SOLUSDT' },
  { label: 'XRP/USD', kraken: 'XRP/USD', binance: 'XRPUSDT' },
  { label: 'DOGE/USD', kraken: 'DOGE/USD', binance: 'DOGEUSDT' },
  { label: 'ADA/USD', kraken: 'ADA/USD', binance: 'ADAUSDT' },
  { label: 'LINK/USD', kraken: 'LINK/USD', binance: 'LINKUSDT' },
  { label: 'LTC/USD', kraken: 'LTC/USD', binance: 'LTCUSDT' },
  { label: 'DOT/USD', kraken: 'DOT/USD', binance: 'DOTUSDT' },
  { label: 'AVAX/USD', kraken: 'AVAX/USD', binance: 'AVAXUSDT' },
  { label: 'BCH/USD', kraken: 'BCH/USD', binance: 'BCHUSDT' },
  { label: 'UNI/USD', kraken: 'UNI/USD', binance: 'UNIUSDT' },
  { label: 'ATOM/USD', kraken: 'ATOM/USD', binance: 'ATOMUSDT' },
  { label: 'XLM/USD', kraken: 'XLM/USD', binance: 'XLMUSDT' },
  { label: 'AAVE/USD', kraken: 'AAVE/USD', binance: 'AAVEUSDT' },
  { label: 'NEAR/USD', kraken: 'NEAR/USD', binance: 'NEARUSDT' },
  { label: 'FIL/USD', kraken: 'FIL/USD', binance: 'FILUSDT' },
  { label: 'ETC/USD', kraken: 'ETC/USD', binance: 'ETCUSDT' },
  { label: 'ALGO/USD', kraken: 'ALGO/USD', binance: 'ALGOUSDT' },
  { label: 'TRX/USD', kraken: 'TRX/USD', binance: 'TRXUSDT' },
  { label: 'ARB/USD', kraken: 'ARB/USD', binance: 'ARBUSDT' },
  { label: 'OP/USD', kraken: 'OP/USD', binance: 'OPUSDT' },
  { label: 'SUI/USD', kraken: 'SUI/USD', binance: 'SUIUSDT' },
  { label: 'PEPE/USD', kraken: 'PEPE/USD', binance: 'PEPEUSDT' },
  { label: 'SHIB/USD', kraken: 'SHIB/USD', binance: 'SHIBUSDT' },
];

/** Candle interval in minutes. 1M is calendar months, keyed as 43200 (30 days). */
export type Interval = number;
export const MONTH = 43200;
const DAY_MS = 86_400_000;

export interface IntervalDef {
  m: Interval;
  label: string;
  /** Binance kline interval (Binance serves every one natively) */
  binance: string;
  /** Kraken interval to subscribe to: the same when Kraken has it, else a smaller one we aggregate */
  kraken: number;
}

/** Kraken WS v2 / REST OHLC intervals, minutes */
export const KRAKEN_NATIVE = [1, 5, 15, 30, 60, 240, 1440, 10080, 21600];

export const INTERVAL_DEFS: IntervalDef[] = [
  { m: 1, label: '1m', binance: '1m', kraken: 1 },
  { m: 3, label: '3m', binance: '3m', kraken: 1 },
  { m: 5, label: '5m', binance: '5m', kraken: 5 },
  { m: 15, label: '15m', binance: '15m', kraken: 15 },
  { m: 30, label: '30m', binance: '30m', kraken: 30 },
  { m: 60, label: '1h', binance: '1h', kraken: 60 },
  { m: 120, label: '2h', binance: '2h', kraken: 60 },
  { m: 240, label: '4h', binance: '4h', kraken: 240 },
  { m: 720, label: '12h', binance: '12h', kraken: 240 },
  { m: 1440, label: '1D', binance: '1d', kraken: 1440 },
  { m: 4320, label: '3D', binance: '3d', kraken: 1440 },
  { m: 10080, label: '1W', binance: '1w', kraken: 10080 },
  { m: MONTH, label: '1M', binance: '1M', kraken: 1440 },
];
export const INTERVALS: Interval[] = INTERVAL_DEFS.map((d) => d.m);

const def = (m: Interval): IntervalDef => INTERVAL_DEFS.find((d) => d.m === m) ?? INTERVAL_DEFS[3];
export const isInterval = (m: unknown): m is Interval => INTERVAL_DEFS.some((d) => d.m === m);
export const intervalLabel = (m: Interval): string => def(m).label;
export const binanceInterval = (m: Interval): string => def(m).binance;
/** the Kraken interval to subscribe to for `m`; aggregate when it differs from `m` */
export const krakenBase = (m: Interval): number => def(m).kraken;

/** Nominal bar length in ms (a month counts as 30 days). */
export const intervalMs = (m: Interval): number => m * 60_000;

/**
 * Open time of the bar that contains `t` (ms, UTC). Weeks start on Monday and
 * months on the 1st, as Binance's do; everything else is aligned to the epoch.
 */
export function bucketStart(t: number, m: Interval): number {
  if (m === MONTH) {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  if (m === 10080) {
    const off = 3 * DAY_MS; // 1970-01-01 was a Thursday; Monday 1969-12-29 is 3 days earlier
    return Math.floor((t + off) / (7 * DAY_MS)) * 7 * DAY_MS - off;
  }
  const step = m * 60_000;
  return Math.floor(t / step) * step;
}

/** Open time of the bar after the one opening at `start`. */
export function nextBucket(start: number, m: Interval): number {
  if (m === MONTH) {
    const d = new Date(start);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return start + m * 60_000;
}
