import { Book, decimalsOfIncrement, type Instrument } from '../engine/book';
import { Status } from '../shared/view';
import { nowAbs } from '../shared/hist';
import type { Candle } from '../patterns/candle';
import { newCounters, type Fetcher, type FeedSink, type SocketFactory, type SocketLike } from './types';

interface SymState {
  book: Book;
  phase: 'buffering' | 'fetching' | 'live';
  buffer: any[];
  lastId: number;
  attempts: number;
}

/**
 * Binance spot diff-depth stream (keyless JSON, 100 ms) kept exact against a REST
 * snapshot, per the documented procedure: buffer the stream, fetch the snapshot,
 * refetch if its lastUpdateId is older than the first buffered U, drop events with
 * u <= lastUpdateId, then require each event's U <= local id + 1 (else resync).
 * Each side is capped at a fixed depth so far levels that Binance stops updating
 * cannot pile up as ghosts.
 */
export class BinanceFeed {
  readonly counters = newCounters();
  readonly books = new Map<string, Book>();
  private st = new Map<string, SymState>();
  private ws: SocketLike | null = null;
  private closed = false;
  private kline: { symbol: string; interval: string } | null = null;
  private id = 1;
  private reconnectTimer: any = null;

  constructor(
    private wsBase: string,
    private restBase: string,
    private symbols: string[],
    private depth: number,
    private sink: FeedSink,
    private socket: SocketFactory,
    private fetchJson: Fetcher,
  ) {}

  async start(): Promise<void> {
    this.closed = false;
    for (const s of this.symbols) this.sink.onStatus(s, Status.Connecting);
    if (this.st.size === 0) await this.loadInstruments();
    const streams = [...this.st.keys()].map((s) => `${s.toLowerCase()}@depth@100ms`);
    if (this.kline) streams.push(`${this.kline.symbol.toLowerCase()}@kline_${this.kline.interval}`);
    const ws = (this.ws = this.socket(`${this.wsBase}/stream?streams=${streams.join('/')}`));
    for (const s of this.st.values()) {
      s.phase = 'buffering';
      s.buffer = [];
    }
    ws.onopen = () => {
      for (const sym of this.st.keys()) this.sink.onStatus(sym, Status.Syncing);
      // stagger snapshot requests to respect REST weight limits
      let i = 0;
      for (const sym of this.st.keys()) setTimeout(() => this.snapshot(sym), 50 + i++ * 120);
      if (this.kline) this.loadKlines();
    };
    ws.onmessage = (ev) => this.onMessage(ev.data as string);
    ws.onclose = () => {
      clearTimeout(this.reconnectTimer);
      if (this.closed) return;
      this.counters.reconnects++;
      for (const s of this.st.keys()) this.sink.onStatus(s, Status.Connecting, 'reconnecting');
      setTimeout(() => this.start(), 1000);
    };
    ws.onerror = () => this.sink.log('binance socket error');
    // connections are cut at 24 h; reconnect on our own schedule first
    this.reconnectTimer = setTimeout(() => ws.close(), 23 * 3600 * 1000);
  }

  stop(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  setKline(symbol: string | null, interval: string): void {
    const ws = this.ws;
    if (this.kline && ws?.readyState === 1)
      ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: [`${this.kline.symbol.toLowerCase()}@kline_${this.kline.interval}`], id: this.id++ }));
    this.kline = symbol ? { symbol, interval } : null;
    if (this.kline && ws?.readyState === 1) {
      ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [`${this.kline.symbol.toLowerCase()}@kline_${this.kline.interval}`], id: this.id++ }));
      this.loadKlines();
    }
  }

  private async loadInstruments(): Promise<void> {
    const q = encodeURIComponent(JSON.stringify(this.symbols));
    let info: any;
    try {
      info = await this.fetchJson(`${this.restBase}/api/v3/exchangeInfo?symbols=${q}`);
    } catch (e) {
      this.sink.log(`binance exchangeInfo failed: ${e}`);
      for (const s of this.symbols) this.sink.onStatus(s, Status.Error, 'exchangeInfo failed');
      throw e;
    }
    for (const s of info.symbols ?? []) {
      const pf = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
      const lf = s.filters.find((f: any) => f.filterType === 'LOT_SIZE');
      const inst: Instrument = {
        symbol: s.symbol,
        tickSize: Number(pf.tickSize),
        priceDecimals: decimalsOfIncrement(pf.tickSize),
        qtyDecimals: decimalsOfIncrement(lf.stepSize),
      };
      const book = new Book(inst, this.depth);
      this.books.set(s.symbol, book);
      this.st.set(s.symbol, { book, phase: 'buffering', buffer: [], lastId: 0, attempts: 0 });
    }
    for (const s of this.symbols) if (!this.st.has(s)) this.sink.onStatus(s, Status.Error, 'unknown symbol');
  }

  private async snapshot(sym: string): Promise<void> {
    const s = this.st.get(sym);
    if (!s || this.closed) return;
    s.phase = 'fetching';
    s.attempts++;
    let snap: any;
    try {
      snap = await this.fetchJson(`${this.restBase}/api/v3/depth?symbol=${sym}&limit=${Math.min(5000, this.depth)}`);
    } catch (e) {
      this.sink.log(`binance snapshot ${sym} failed: ${e}`);
      setTimeout(() => this.snapshot(sym), Math.min(30_000, 1000 * 2 ** s.attempts));
      return;
    }
    if (s.phase !== 'fetching') return;
    const first = s.buffer[0];
    if (first && snap.lastUpdateId < first.U) {
      // snapshot older than our first buffered event: try again
      setTimeout(() => this.snapshot(sym), 250);
      return;
    }
    const book = s.book;
    book.clear();
    for (const [p, q] of snap.bids) book.setBid(+p, +q);
    for (const [p, q] of snap.asks) book.setAsk(+p, +q);
    s.lastId = snap.lastUpdateId;
    s.phase = 'live';
    s.attempts = 0;
    const buf = s.buffer;
    s.buffer = [];
    for (const ev of buf) if (!this.applyDiff(s, ev, nowAbs())) return;
    book.version++;
    this.sink.onStatus(sym, Status.Live);
    this.sink.onBook(sym, book);
  }

  private resync(s: SymState, why: string): void {
    this.counters.resyncs++;
    s.phase = 'buffering';
    s.buffer = [];
    this.sink.onStatus(s.book.inst.symbol, Status.Resyncing, why);
    setTimeout(() => this.snapshot(s.book.inst.symbol), 100);
  }

  /** returns false if a gap forced a resync */
  private applyDiff(s: SymState, ev: any, recv: number): boolean {
    if (ev.u <= s.lastId) return true; // already in the snapshot
    if (ev.U > s.lastId + 1) {
      this.counters.gaps++;
      this.resync(s, `gap ${s.lastId} -> ${ev.U}`);
      return false;
    }
    const book = s.book;
    const b = ev.b;
    for (let i = 0; i < b.length; i++) book.setBid(+b[i][0], +b[i][1]);
    const a = ev.a;
    for (let i = 0; i < a.length; i++) book.setAsk(+a[i][0], +a[i][1]);
    this.counters.levels += b.length + a.length;
    s.lastId = ev.u;
    book.version++;
    book.lastRecv = recv;
    book.lastEventTime = ev.E;
    if (book.crossed()) this.counters.crossed++;
    return true;
  }

  onMessage(raw: string): void {
    const recv = nowAbs();
    const t0 = performance.now();
    const msg = JSON.parse(raw);
    const t1 = performance.now();
    this.counters.msgs++;
    this.counters.bytes += raw.length;
    const d = msg.data;
    if (!d) return;
    if (d.e === 'depthUpdate') {
      const s = this.st.get(d.s);
      if (!s) return;
      if (s.phase !== 'live') {
        s.buffer.push(d);
        if (s.buffer.length > 5000) s.buffer.shift();
        return;
      }
      if (this.applyDiff(s, d, recv)) this.sink.onBook(d.s, s.book);
      this.sink.onTiming(t1 - t0, performance.now() - t1, d.b.length + d.a.length);
    } else if (d.e === 'kline') {
      const k = d.k;
      this.sink.onCandle(d.s, { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, closed: k.x });
    }
  }

  private async loadKlines(): Promise<void> {
    if (!this.kline) return;
    const { symbol, interval } = this.kline;
    try {
      const rows: any[] = await this.fetchJson(`${this.restBase}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=720`);
      if (!this.kline || this.kline.symbol !== symbol || this.kline.interval !== interval) return;
      const cs: Candle[] = rows.map((r, i) => ({
        t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], closed: i < rows.length - 1,
      }));
      this.sink.onCandles(symbol, cs);
    } catch (e) {
      this.sink.log(`binance klines failed: ${e}`);
    }
  }
}
