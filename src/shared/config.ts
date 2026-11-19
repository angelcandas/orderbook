export type Venue = 'kraken' | 'binance';

export interface Endpoints {
  krakenWs: string;
  binanceWs: string; // base, e.g. wss://data-stream.binance.vision
  binanceRest: string; // base, e.g. https://data-api.binance.vision
}

export const LIVE: Endpoints = {
  krakenWs: 'wss://ws.kraken.com/v2',
  binanceWs: 'wss://data-stream.binance.vision',
  binanceRest: 'https://data-api.binance.vision',
};

/** The local replay / synthetic server speaks both venues' protocols. */
export function localEndpoints(host = 'localhost:8787'): Endpoints {
  return {
    krakenWs: `ws://${host}/kraken`,
    binanceWs: `ws://${host}/binance`,
    binanceRest: `http://${host}/binance`,
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

export type Interval = 1 | 5 | 15 | 60 | 240;
export const INTERVALS: Interval[] = [1, 5, 15, 60, 240];
export const binanceInterval = (m: Interval): string =>
  m < 60 ? `${m}m` : `${m / 60}h`;
