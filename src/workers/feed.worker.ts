/// <reference lib="webworker" />
import { KrakenFeed } from '../feeds/kraken';
import { BinanceFeed } from '../feeds/binance';
import type { FeedSink } from '../feeds/types';
import type { Book } from '../engine/book';
import { Histogram } from '../shared/hist';
import { binanceInterval, PAIRS, type Interval } from '../shared/config';
import { binanceHistory, krakenOhlc, prepend, stitchOlder, HISTORY_BARS } from '../feeds/history';
import type { Candle } from '../patterns/candle';
import { Status, STATUS_NAMES, VIEW_LEN, seqWrite, writeView, wrapView } from '../shared/view';
import type { FeedCmd, FeedInit, FeedStats } from './protocol';
import { AlertChecker, CHECK_MS, midOf } from '../alerts/alerts';

let feed: KrakenFeed | BinanceFeed;
let init: FeedInit;
let seq: Int32Array;
let data: Float64Array;
let focus = { symbol: '', pair: 0, group: 0 };
let dirty = false;
let lastPublish = 0;
let publishTimer: any = null;
const status: Record<string, string> = {};
const statusCode = new Map<string, number>();
const parseH = new Histogram();
const applyH = new Histogram();
const publishH = new Histogram();
let publishes = 0;
let lastMsgs = 0, lastLevels = 0, lastPub = 0, lastT = performance.now();
const MIN_PUBLISH_MS = 4; // at most ~240 views per second, well above any display rate
let fallbackBuf: Float64Array | null = null;

function publish(): void {
  publishTimer = null;
  if (!dirty) return;
  const book = feed.books.get(focus.symbol);
  if (!book) return;
  dirty = false;
  const t0 = performance.now();
  const st = statusCode.get(focus.symbol) ?? Status.Connecting;
  if (init.shared) {
    seqWrite(seq, () => writeView(data, book, focus.group * book.inst.tickSize, st, focus.pair));
  } else {
    // no SharedArrayBuffer: write into a fresh buffer and transfer it
    const out = fallbackBuf ?? new Float64Array(VIEW_LEN);
    fallbackBuf = null;
    writeView(out, book, focus.group * book.inst.tickSize, st, focus.pair);
    init.renderPort.postMessage({ type: 'view', data: out }, [out.buffer]);
  }
  lastPublish = performance.now();
  publishH.record(lastPublish - t0);
  publishes++;
}

function markDirty(): void {
  dirty = true;
  if (publishTimer !== null) return;
  const since = performance.now() - lastPublish;
  if (since >= MIN_PUBLISH_MS) publish();
  else publishTimer = setTimeout(publish, MIN_PUBLISH_MS - since);
}

let focusInterval = 0;

const sink: FeedSink = {
  onBook(symbol: string, _book: Book) {
    if (symbol === focus.symbol) markDirty();
  },
  onStatus(symbol, st, detail) {
    status[symbol] = STATUS_NAMES[st] + (detail ? `: ${detail}` : '');
    statusCode.set(symbol, st);
    if (symbol === focus.symbol) markDirty();
  },
  onCandles(symbol, candles) {
    init.analyticsPort.postMessage({ type: 'candles', venue: init.venue, symbol, candles });
  },
  onCandle(symbol, candle) {
    init.analyticsPort.postMessage({ type: 'candle', venue: init.venue, symbol, candle });
  },
  onHistory(symbol, candles, source) {
    init.analyticsPort.postMessage({ type: 'history', venue: init.venue, symbol, candles, source });
  },
  onTiming(p, a) {
    parseH.record(p);
    applyH.record(a);
  },
  log(m) {
    console.warn(`[feed ${init.venue}]`, m);
  },
};

// price alerts: checked on a timer, off the per-message path
const alerts = new AlertChecker();
let alertTimer: any = null;
const livePrice = (symbol: string): number => {
  if (statusCode.get(symbol) !== Status.Live) return NaN;
  const b = feed.books.get(symbol);
  return b ? midOf(b.bids.bestTick * b.inst.tickSize, b.asks.bestTick * b.inst.tickSize) : NaN;
};
function checkAlerts(): void {
  for (const hit of alerts.check(livePrice, Date.now())) postMessage(hit);
  if (alerts.size === 0) { clearInterval(alertTimer); alertTimer = null; }
}

function stats(): void {
  const now = performance.now();
  const dt = (now - lastT) / 1000;
  const c = feed.counters;
  const s: FeedStats = {
    type: 'stats',
    venue: init.venue,
    counters: { ...c },
    msgsPerSec: (c.msgs - lastMsgs) / dt,
    levelsPerSec: (c.levels - lastLevels) / dt,
    publishesPerSec: (publishes - lastPub) / dt,
    parse: parseH.summary(),
    apply: applyH.summary(),
    publish: publishH.summary(),
    status: { ...status },
    books: feed.books.size,
  };
  lastMsgs = c.msgs; lastLevels = c.levels; lastPub = publishes; lastT = now;
  postMessage(s);
}

self.onmessage = (ev: MessageEvent<FeedCmd | { type: 'resetStats' }>) => {
  const m = ev.data;
  if (m.type === 'init') {
    init = m;
    if (m.shared) ({ seq, data } = wrapView(m.view));
    m.renderPort.onmessage = (e) => {
      // the render worker hands back used buffers to avoid reallocating
      if (e.data?.type === 'return') fallbackBuf = e.data.data;
    };
    const sock = (u: string) => new WebSocket(u) as any;
    const fetchJson = async (u: string) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    };
    if (m.venue === 'kraken') {
      // Kraken serves only its latest 720 bars; older ones come from the same pair on Binance
      const backfill = async (symbol: string, interval: number, snap: Candle[]) => {
        const stepMs = interval * 60_000;
        const alive = () => focusInterval === interval;
        // Kraken's own bars first: the WS snapshot is short, REST has the latest 720
        let recent = snap;
        let own = 0;
        if (m.endpoints.krakenRest) {
          try {
            recent = prepend(snap, await krakenOhlc(fetchJson, m.endpoints.krakenRest, symbol, interval));
            own = recent.length - snap.length;
          } catch (e) {
            sink.log(`kraken REST OHLC failed, using Binance only: ${e}`);
          }
        }
        const pair = PAIRS.find((p) => p.kraken === symbol);
        let older: Candle[] = [];
        if (pair && alive()) {
          try {
            const b = await binanceHistory(fetchJson, m.endpoints.binanceRest, pair.binance, binanceInterval(interval as Interval),
              snap[snap.length - 1].t + stepMs, HISTORY_BARS, alive);
            older = stitchOlder(b, recent);
          } catch (e) {
            sink.log(`binance backfill failed: ${e}`);
          }
        }
        const candles = older.concat(recent.slice(0, own));
        const source = own && older.length ? 'kraken+binance' : own ? 'kraken' : 'binance';
        return { candles, source };
      };
      feed = new KrakenFeed(m.endpoints.krakenWs, m.symbols, m.depth, sink, sock, backfill);
      feed.start();
    } else {
      feed = new BinanceFeed(m.endpoints.binanceWs, m.endpoints.binanceRest, m.symbols, m.depth, sink, sock, fetchJson);
      feed.start().catch((e) => sink.log(String(e)));
    }
    setInterval(stats, 1000);
  } else if (m.type === 'focus') {
    focus = { symbol: m.symbol, pair: m.pair, group: m.group };
    markDirty();
  } else if (m.type === 'candles') {
    focusInterval = m.interval;
    if (feed instanceof KrakenFeed) feed.setOhlc(m.symbol, m.interval);
    else feed.setKline(m.symbol, binanceInterval(m.interval as Interval));
  } else if (m.type === 'alerts') {
    alerts.set(m.list);
    if (alerts.size && alertTimer === null && feed) alertTimer = setInterval(checkAlerts, CHECK_MS);
  } else if (m.type === 'resetStats') {
    parseH.reset(); applyH.reset(); publishH.reset();
  } else if (m.type === 'stop') {
    feed.stop();
  }
};
