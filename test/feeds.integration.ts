// Runs both feeds against the local emulator under Node and checks integrity counters.
const HOST = process.env.VENUE_HOST ?? 'localhost:8787';
const NEED_CANDLES = process.env.NO_CANDLES ? false : true;
import WebSocket from 'ws';
import { KrakenFeed } from '../src/feeds/kraken';
import { BinanceFeed } from '../src/feeds/binance';
import type { FeedSink } from '../src/feeds/types';
import { STATUS_NAMES } from '../src/shared/view';

const statuses: Record<string, string> = {};
let candles = 0;
const sink: FeedSink = {
  onBook() {},
  onStatus(s, st, d) { statuses[s] = STATUS_NAMES[st] + (d ? ` (${d})` : ''); },
  onCandles(_s, cs) { candles += cs.length; },
  onCandle() { candles++; },
  onTiming() {},
  log: (m) => console.log('log:', m),
};
const sock = (u: string) => new WebSocket(u) as any;
const fetchJson = async (u: string) => (await fetch(u)).json();
const k = new KrakenFeed('ws://' + HOST + '/kraken', ['BTC/USD', 'ETH/USD'], 1000, sink, sock);
const b = new BinanceFeed('ws://' + HOST + '/binance', 'http://' + HOST + '/binance', ['BTCUSDT', 'ETHUSDT'], 1000, sink, sock, fetchJson);
k.start(); b.start(); k.setOhlc('BTC/USD', 1); b.setKline('BTCUSDT', '1m');
setTimeout(() => {
  console.log(statuses, 'candles', candles);
  const bad = k.counters.checksumFails + b.counters.gaps + k.counters.crossed + b.counters.crossed;
  const live = Object.values(statuses).every((s) => s.startsWith('live'));
  console.log('kraken', k.counters);
  console.log('binance', b.counters);
  const bk = b.books.get('BTCUSDT')!;
  console.log('binance best', bk.bids.bestTick * bk.inst.tickSize, bk.asks.bestTick * bk.inst.tickSize, bk.bids.n, bk.asks.n);
  process.exit(bad === 0 && live && (candles > 0 || !NEED_CANDLES) ? 0 : 1);
}, 5000);
