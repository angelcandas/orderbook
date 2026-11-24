// Runs both feeds against the local emulator under Node and checks integrity counters.
const HOST = process.env.VENUE_HOST ?? 'localhost:8787';
const NEED_CANDLES = process.env.NO_CANDLES ? false : true;
import WebSocket from 'ws';
import { KrakenFeed } from '../src/feeds/kraken';
import { BinanceFeed } from '../src/feeds/binance';
import { binanceHistory, krakenOhlc, prepend, stitchOlder, HISTORY_BARS } from '../src/feeds/history';
import type { FeedSink } from '../src/feeds/types';
import { STATUS_NAMES } from '../src/shared/view';

const statuses: Record<string, string> = {};
let candles = 0;
const history: Record<string, number> = {};
const markets: Record<string, number> = {};
const sink: FeedSink = {
  onBook() {},
  onStatus(s, st, d) { statuses[s] = STATUS_NAMES[st] + (d ? ` (${d})` : ''); },
  onCandles(_s, cs) { candles += cs.length; },
  onCandle() { candles++; },
  onHistory(s, cs, src) { history[s] = (history[s] ?? 0) + cs.length; console.log(`history ${s}: ${cs.length} older bars from ${src}`); },
  onTiming() {},
  onMarkets(ms) { markets[ms[0]?.symbol.includes('/') ? 'kraken' : 'binance'] = ms.length; },
  log: (m) => console.log('log:', m),
};
const sock = (u: string) => new WebSocket(u) as any;
const fetchJson = async (u: string) => (await fetch(u)).json();
const k = new KrakenFeed('ws://' + HOST + '/kraken', ['BTC/USD', 'ETH/USD'], 1000, sink, sock, async (sym, iv, snap) => {
  const recent = prepend(snap, await krakenOhlc(fetchJson, 'http://' + HOST + '/kraken', sym, iv));
  const older = stitchOlder(await binanceHistory(fetchJson, 'http://' + HOST + '/binance', 'BTCUSDT', `${iv}m`, snap[snap.length - 1].t + iv * 60_000, HISTORY_BARS), recent);
  return { candles: older.concat(recent.slice(0, recent.length - snap.length)), source: 'kraken+binance' };
});
const b = new BinanceFeed('ws://' + HOST + '/binance', 'http://' + HOST + '/binance', ['BTCUSDT', 'ETHUSDT'], 1000, sink, sock, fetchJson);
k.start(); b.start().then(() => b.loadMarkets()); k.setOhlc('BTC/USD', 1); b.setKline('BTCUSDT', '1m');
// switch pair mid run, on the open sockets: ETH out, SOL in
const kSyms = ['BTC/USD', 'SOL/USD'];
const bSyms = ['BTCUSDT', 'SOLUSDT'];
setTimeout(() => { k.setSymbols(kSyms); b.setSymbols(bSyms); }, 2000);
setTimeout(() => {
  const want = [...kSyms, ...bSyms];
  for (const s of Object.keys(statuses)) if (!want.includes(s)) delete statuses[s];
  console.log(statuses, 'candles', candles, 'history', history);
  const filled = !NEED_CANDLES || (history['BTC/USD'] > 0 && history['BTCUSDT'] > 0);
  const bad = k.counters.checksumFails + b.counters.gaps + k.counters.crossed + b.counters.crossed;
  const live = want.every((s) => statuses[s]?.startsWith('live'));
  const switched = !k.books.has('ETH/USD') && !b.books.has('ETHUSDT') && k.books.has('SOL/USD') && b.books.has('SOLUSDT');
  const listed = markets.kraken > 0 && markets.binance > 0;
  console.log('switched', switched, 'markets', markets);
  console.log('kraken', k.counters);
  console.log('binance', b.counters);
  const bk = b.books.get('BTCUSDT')!;
  console.log('binance best', bk.bids.bestTick * bk.inst.tickSize, bk.asks.bestTick * bk.inst.tickSize, bk.bids.n, bk.asks.n);
  process.exit(bad === 0 && live && switched && listed && (candles > 0 || !NEED_CANDLES) && filled ? 0 : 1);
}, 5000);
