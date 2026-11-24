import { Book, type Instrument } from '../engine/book';
import { Status } from '../shared/view';
import { nowAbs } from '../shared/hist';
import type { Candle } from '../patterns/candle';
import { krakenMarkets } from '../shared/pairs';
import { newCounters, type FeedSink, type SocketFactory, type SocketLike } from './types';

/**
 * Kraken spot WebSocket v2 `book` channel. Snapshot then deltas on the socket;
 * after each message: apply levels in order, truncate to the subscribed depth
 * (Kraken sends no delete for levels that fall off the end), verify CRC32.
 * On mismatch: unsubscribe + resubscribe for a fresh snapshot.
 */
export class KrakenFeed {
  readonly counters = newCounters();
  readonly books = new Map<string, Book>();
  private insts = new Map<string, Instrument>();
  private live = new Set<string>();
  private ws: SocketLike | null = null;
  private ohlc: { symbol: string; interval: number } | null = null;
  private closed = false;
  private reqId = 1;

  constructor(
    private url: string,
    private symbols: string[],
    private depth: number,
    private sink: FeedSink,
    private socket: SocketFactory,
    /** older bars to prepend to an OHLC snapshot; Kraken itself serves only the latest 720 */
    private backfill?: (symbol: string, interval: number, snapshot: Candle[]) => Promise<{ candles: Candle[]; source: string }>,
  ) {}
  private backfilled = '';

  start(): void {
    this.closed = false;
    const ws = (this.ws = this.socket(this.url));
    for (const s of this.symbols) this.sink.onStatus(s, Status.Connecting);
    ws.onopen = () => {
      if (!this.insts.size) {
        this.send({ method: 'subscribe', params: { channel: 'instrument', snapshot: true } });
        return;
      }
      // reconnect: instruments are known, so resubscribe straight away
      const ok = this.symbols.filter((s) => this.insts.has(s));
      for (const s of ok) this.sink.onStatus(s, Status.Syncing);
      this.subscribeBooks(ok);
      this.subscribeOhlc();
    };
    ws.onmessage = (ev) => this.onMessage(ev.data as string);
    ws.onclose = () => {
      this.live.clear();
      if (this.closed) return;
      this.counters.reconnects++;
      for (const s of this.symbols) this.sink.onStatus(s, Status.Connecting, 'reconnecting');
      setTimeout(() => this.start(), 1000);
    };
    ws.onerror = () => this.sink.log('kraken socket error');
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
  }

  /**
   * Change the books kept live without reconnecting: unsubscribe the ones
   * dropped, subscribe the new ones (instruments are already known from the
   * instrument snapshot).
   */
  setSymbols(symbols: string[]): void {
    const next = [...new Set(symbols)];
    const gone = this.symbols.filter((s) => !next.includes(s));
    const added = next.filter((s) => !this.symbols.includes(s));
    this.symbols = next;
    if (gone.length) {
      this.send({ method: 'unsubscribe', params: { channel: 'book', symbol: gone, depth: this.depth } });
      for (const s of gone) { this.books.delete(s); this.live.delete(s); }
    }
    if (!added.length || !this.insts.size) {
      for (const s of added) this.sink.onStatus(s, Status.Connecting);
      return; // before the instrument snapshot: it subscribes this.symbols
    }
    const ok = added.filter((s) => this.insts.has(s));
    for (const s of added) if (!this.insts.has(s)) this.sink.onStatus(s, Status.Error, 'unknown symbol');
    for (const s of ok) {
      this.books.set(s, new Book(this.insts.get(s)!, this.depth));
      this.sink.onStatus(s, Status.Syncing);
    }
    this.subscribeBooks(ok);
  }

  setOhlc(symbol: string | null, interval: number): void {
    if (this.ohlc) this.send({ method: 'unsubscribe', params: { channel: 'ohlc', symbol: [this.ohlc.symbol], interval: this.ohlc.interval } });
    this.ohlc = symbol ? { symbol, interval } : null;
    this.backfilled = '';
    if (this.ohlc && this.insts.size) this.subscribeOhlc();
  }

  private subscribeOhlc(): void {
    if (!this.ohlc) return;
    this.send({ method: 'subscribe', params: { channel: 'ohlc', symbol: [this.ohlc.symbol], interval: this.ohlc.interval, snapshot: true } });
  }

  private send(obj: object): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ ...obj, req_id: this.reqId++ }));
  }

  private subscribeBooks(symbols: string[]): void {
    // chunk to keep messages small
    for (let i = 0; i < symbols.length; i += 10) {
      this.send({ method: 'subscribe', params: { channel: 'book', symbol: symbols.slice(i, i + 10), depth: this.depth, snapshot: true } });
    }
  }

  private resync(symbol: string, why: string): void {
    this.counters.resyncs++;
    this.live.delete(symbol);
    this.sink.onStatus(symbol, Status.Resyncing, why);
    this.send({ method: 'unsubscribe', params: { channel: 'book', symbol: [symbol], depth: this.depth } });
    this.send({ method: 'subscribe', params: { channel: 'book', symbol: [symbol], depth: this.depth, snapshot: true } });
  }

  onMessage(raw: string): void {
    const recv = nowAbs();
    const t0 = performance.now();
    const msg = JSON.parse(raw);
    const t1 = performance.now();
    this.counters.msgs++;
    this.counters.bytes += raw.length;
    const ch = msg.channel;
    if (ch === 'book') {
      let levels = 0;
      for (const d of msg.data) levels += this.onBook(d, msg.type, recv);
      this.sink.onTiming(t1 - t0, performance.now() - t1, levels);
    } else if (ch === 'ohlc') {
      this.onOhlc(msg);
    } else if (ch === 'instrument') {
      this.onInstrument(msg);
    } else if (msg.method === 'subscribe' && msg.success === false) {
      this.sink.log(`kraken subscribe failed: ${msg.error}`);
      const sym = msg.result?.symbol ?? msg.symbol;
      if (sym) this.sink.onStatus(sym, Status.Error, String(msg.error));
    }
  }

  private onInstrument(msg: any): void {
    if (msg.type !== 'snapshot' || this.insts.size) return;
    this.sink.onMarkets?.(krakenMarkets(msg.data.pairs));
    for (const p of msg.data.pairs ?? []) {
      const inc = Number(p.price_increment ?? p.tick_size ?? 10 ** -p.price_precision);
      this.insts.set(p.symbol, {
        symbol: p.symbol,
        tickSize: inc,
        priceDecimals: p.price_precision,
        qtyDecimals: p.qty_precision,
      });
    }
    this.send({ method: 'unsubscribe', params: { channel: 'instrument' } });
    const ok = this.symbols.filter((s) => this.insts.has(s));
    for (const s of this.symbols) if (!this.insts.has(s)) this.sink.onStatus(s, Status.Error, 'unknown symbol');
    for (const s of ok) {
      if (!this.books.has(s)) this.books.set(s, new Book(this.insts.get(s)!, this.depth));
      this.sink.onStatus(s, Status.Syncing);
    }
    this.subscribeBooks(ok);
    this.subscribeOhlc();
  }

  private onBook(d: any, type: string, recv: number): number {
    const book = this.books.get(d.symbol);
    if (!book) return 0;
    const snap = type === 'snapshot';
    if (snap) {
      book.clear();
      this.live.add(d.symbol);
    } else if (!this.live.has(d.symbol)) return 0; // waiting for a fresh snapshot
    let n = 0;
    const bids = d.bids;
    for (let i = 0; i < bids.length; i++) book.setBid(bids[i].price, bids[i].qty);
    const asks = d.asks;
    for (let i = 0; i < asks.length; i++) book.setAsk(asks[i].price, asks[i].qty);
    n = bids.length + asks.length;
    book.bids.truncate(this.depth);
    book.asks.truncate(this.depth);
    book.version++;
    book.lastRecv = recv;
    if (d.timestamp) book.lastEventTime = Date.parse(d.timestamp);
    this.counters.levels += n;
    if (typeof d.checksum === 'number' && book.krakenChecksum() !== d.checksum) {
      this.counters.checksumFails++;
      this.resync(d.symbol, 'checksum mismatch');
      return n;
    }
    if (book.crossed()) this.counters.crossed++;
    if (snap) this.sink.onStatus(d.symbol, Status.Live);
    this.sink.onBook(d.symbol, book);
    return n;
  }

  private onOhlc(msg: any): void {
    const data: any[] = msg.data ?? [];
    if (!data.length) return;
    const toCandle = (k: any): Candle => ({
      t: Date.parse(k.interval_begin),
      o: k.open, h: k.high, l: k.low, c: k.close, v: k.volume,
      closed: false,
    });
    const sym = data[0].symbol;
    // late bars from the interval we just left would land in the wrong buckets
    if (this.ohlc && data[0].interval !== undefined && data[0].interval !== this.ohlc.interval) return;
    if (msg.type === 'snapshot') {
      const cs = data.map(toCandle).sort((a, b) => a.t - b.t);
      cs.forEach((c, i) => (c.closed = i < cs.length - 1));
      this.sink.onCandles(sym, cs);
      this.loadOlder(sym, cs);
    } else {
      for (const k of data) this.sink.onCandle(sym, toCandle(k));
    }
  }

  /** once per symbol and interval: resubscribes after a reconnect keep what the analytics worker holds */
  private loadOlder(sym: string, cs: Candle[]): void {
    const o = this.ohlc;
    if (!this.backfill || !o || o.symbol !== sym || !cs.length) return;
    const key = `${sym}:${o.interval}`;
    if (this.backfilled === key) return;
    this.backfilled = key;
    this.backfill(sym, o.interval, cs).then(({ candles, source }) => {
      if (this.ohlc?.symbol === sym && this.ohlc.interval === o.interval && candles.length) this.sink.onHistory(sym, candles, source);
    }, (e) => {
      if (this.backfilled === key) this.backfilled = '';
      this.sink.log(`kraken backfill failed: ${e}`);
    });
  }
}
