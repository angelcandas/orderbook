/**
 * Local venue emulator for benchmarks and offline development.
 * Speaks Kraken WS v2 (book, instrument, ohlc) at /kraken and Binance spot
 * (combined streams, depth/exchangeInfo/klines REST) at /binance, driven by a
 * synthetic market at a chosen rate, so the app's full socket-to-pixel path is
 * exercised with exactly the protocols it uses live.
 *
 *   npx tsx server/server.ts --rate 20000 --pairs 10 --port 8787
 */
import { krakenRestPair } from '../src/feeds/history';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { MarketSim, synthHistory, type LevelChange } from './sim';
import type { Candle } from '../src/patterns/candle';
import { PAIRS } from '../src/shared/config';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const PORT = Number(args.get('port') ?? 8787);
let RATE = Number(args.get('rate') ?? 2000); // level changes per second, per venue
const NPAIRS = Number(args.get('pairs') ?? 5);
const KRAKEN_LEVELS_PER_MSG = Number(args.get('kraken-batch') ?? 4);
const BINANCE_BATCH_MS = Number(args.get('binance-batch-ms') ?? 100);
const DEPTH = 1000;
const TICK_MS = 4;

const START: Record<string, number> = { BTC: 91000, ETH: 3100, SOL: 140, XRP: 2.2, DOGE: 0.16 };
const pairs = PAIRS.slice(0, NPAIRS);

function inst(sym: string, label: string) {
  const base = label.split('/')[0];
  const px = START[base] ?? 10 + (base.charCodeAt(0) % 50);
  const decimals = px > 1000 ? 1 : px > 10 ? 2 : px > 1 ? 4 : 5;
  return { inst: { symbol: sym, tickSize: 10 ** -decimals, priceDecimals: decimals, qtyDecimals: 8 }, px };
}

let seed = 1;
const ksims = new Map<string, MarketSim>();
const bsims = new Map<string, MarketSim>();
for (const p of pairs) {
  const k = inst(p.kraken, p.label);
  ksims.set(p.kraken, new MarketSim(k.inst, k.px, DEPTH, seed++, 60_000));
  const b = inst(p.binance, p.label);
  bsims.set(p.binance, new MarketSim({ ...b.inst, qtyDecimals: 5 }, b.px, DEPTH, seed++, 60_000));
}

// candle series per (symbol, interval minutes), advanced by the sim's mid
const series = new Map<string, Candle[]>();
function getSeries(sim: MarketSim, minutes: number): Candle[] {
  const key = `${sim.inst.symbol}:${minutes}`;
  let s = series.get(key);
  if (!s) {
    s = synthHistory(sim.midTick * sim.inst.tickSize, 3000, minutes * 60_000, seed++ * 31);
    // re-anchor the sim's mid to the end of the history so the book matches the chart
    const shift = sim.midTick * sim.inst.tickSize - s[s.length - 1].c;
    for (const c of s) { c.o += shift; c.h += shift; c.l += shift; c.c += shift; }
    series.set(key, s);
  }
  return s;
}
function advance(s: Candle[], minutes: number, px: number, v: number, now: number): Candle {
  const iv = minutes * 60_000;
  const t = Math.floor(now / iv) * iv;
  let c = s[s.length - 1];
  if (t > c.t) {
    c.closed = true;
    c = { t, o: c.c, h: Math.max(c.c, px), l: Math.min(c.c, px), c: px, v: 0, closed: false };
    s.push(c);
    if (s.length > 2000) s.shift();
  }
  c.h = Math.max(c.h, px); c.l = Math.min(c.l, px); c.c = px; c.v += v;
  return c;
}

// ---------- Kraken ----------
interface KClient { ws: WebSocket; books: Map<string, number>; ohlc: { symbol: string; interval: number } | null }
const kclients = new Set<KClient>();

function krakenLevels(sim: MarketSim, side: 'bids' | 'asks', depth: number) {
  const s = sim.book[side];
  const out = [];
  const n = Math.min(depth, s.n);
  for (let i = 0; i < n; i++) out.push({ price: Number((s.tickAt(i) * sim.inst.tickSize).toFixed(sim.inst.priceDecimals)), qty: s.qtyAt(i) });
  return out;
}
const krakenCandle = (sym: string, c: Candle, interval: number) => ({
  symbol: sym, open: c.o, high: c.h, low: c.l, close: c.c, volume: Number(c.v.toFixed(8)), trades: 1, vwap: c.c,
  interval_begin: new Date(c.t).toISOString(), interval, timestamp: new Date().toISOString(),
});

function onKraken(ws: WebSocket) {
  const cl: KClient = { ws, books: new Map(), ohlc: null };
  kclients.add(cl);
  ws.on('close', () => kclients.delete(cl));
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    const p = m.params ?? {};
    const ack = (result: object) => ws.send(JSON.stringify({ method: m.method, req_id: m.req_id, result, success: true, time_in: new Date().toISOString() }));
    if (p.channel === 'instrument' && m.method === 'subscribe') {
      ack({ channel: 'instrument' });
      ws.send(JSON.stringify({
        channel: 'instrument', type: 'snapshot',
        data: { assets: [], pairs: [...ksims.values()].map((s) => ({ symbol: s.inst.symbol, base: s.inst.symbol.split('/')[0], quote: s.inst.symbol.split('/')[1], price_increment: s.inst.tickSize, price_precision: s.inst.priceDecimals, qty_precision: s.inst.qtyDecimals, status: 'online' })) },
      }));
    } else if (p.channel === 'book') {
      for (const sym of p.symbol) {
        const sim = ksims.get(sym);
        if (m.method === 'unsubscribe') { cl.books.delete(sym); continue; }
        if (!sim) { ws.send(JSON.stringify({ method: 'subscribe', success: false, error: 'Currency pair not supported', symbol: sym, req_id: m.req_id })); continue; }
        const depth = p.depth ?? 10;
        cl.books.set(sym, depth);
        ack({ channel: 'book', symbol: sym, depth, snapshot: true });
        ws.send(JSON.stringify({ channel: 'book', type: 'snapshot', data: [{ symbol: sym, bids: krakenLevels(sim, 'bids', depth), asks: krakenLevels(sim, 'asks', depth), checksum: sim.book.krakenChecksum() }] }));
      }
    } else if (p.channel === 'ohlc') {
      if (m.method === 'unsubscribe') { cl.ohlc = null; return; }
      const sym = p.symbol[0];
      const sim = ksims.get(sym);
      if (!sim) return;
      cl.ohlc = { symbol: sym, interval: p.interval };
      ack({ channel: 'ohlc', symbol: sym, interval: p.interval });
      const s = getSeries(sim, p.interval);
      // like production: the WS snapshot carries only the last few bars; REST has the latest 720
      ws.send(JSON.stringify({ channel: 'ohlc', type: 'snapshot', data: s.slice(-10).map((c) => krakenCandle(sym, c, p.interval)) }));
    } else if (m.method === 'ping') {
      ws.send(JSON.stringify({ method: 'pong', req_id: m.req_id }));
    }
  });
}

// ---------- Binance ----------
interface BClient { ws: WebSocket; streams: Set<string> }
const bclients = new Set<BClient>();
const bpending = new Map<string, { U: number; u: number; b: [string, string][]; a: [string, string][] }>();

function onBinance(ws: WebSocket, url: URL) {
  const cl: BClient = { ws, streams: new Set((url.searchParams.get('streams') ?? '').split('/').filter(Boolean)) };
  bclients.add(cl);
  ws.on('close', () => bclients.delete(cl));
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.method === 'SUBSCRIBE') for (const s of m.params) cl.streams.add(s);
    if (m.method === 'UNSUBSCRIBE') for (const s of m.params) cl.streams.delete(s);
    ws.send(JSON.stringify({ result: null, id: m.id }));
  });
}

/** Kraken REST OHLC: latest 720 bars, `[time s, o, h, l, c, vwap, volume, count]` */
function krakenRest(url: URL, res: http.ServerResponse) {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' });
    res.end(JSON.stringify(body));
  };
  const pair = url.searchParams.get('pair') ?? '';
  const minutes = Number(url.searchParams.get('interval') ?? 1);
  const sym = [...ksims.keys()].find((k) => krakenRestPair(k) === pair);
  if (!sym) return send(200, { error: ['EQuery:Unknown asset pair'] });
  const s = getSeries(ksims.get(sym)!, minutes).slice(-720);
  send(200, { error: [], result: { [pair]: s.map((c) => [c.t / 1000, String(c.o), String(c.h), String(c.l), String(c.c), String(c.c), String(c.v), 1]), last: s[s.length - 1].t / 1000 } });
}

function binanceRest(url: URL, res: http.ServerResponse) {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' });
    res.end(JSON.stringify(body));
  };
  const path = url.pathname.replace(/^\/binance/, '');
  if (path === '/api/v3/exchangeInfo') {
    const want: string[] = JSON.parse(url.searchParams.get('symbols') ?? '[]');
    return send(200, {
      symbols: [...bsims.values()].filter((s) => !want.length || want.includes(s.inst.symbol)).map((s) => ({
        symbol: s.inst.symbol,
        status: 'TRADING',
        baseAsset: s.inst.symbol.replace(/USDT$/, ''),
        quoteAsset: 'USDT',
        filters: [
          { filterType: 'PRICE_FILTER', tickSize: s.inst.tickSize.toFixed(s.inst.priceDecimals) },
          { filterType: 'LOT_SIZE', stepSize: (10 ** -s.inst.qtyDecimals).toFixed(s.inst.qtyDecimals) },
        ],
      })),
    });
  }
  const sym = url.searchParams.get('symbol') ?? '';
  const sim = bsims.get(sym);
  if (!sim) return send(400, { code: -1121, msg: 'Invalid symbol.' });
  if (path === '/api/v3/depth') {
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const lv = (side: 'bids' | 'asks') => {
      const s = sim.book[side];
      const out: [string, string][] = [];
      for (let i = 0; i < Math.min(limit, s.n); i++) out.push([(s.tickAt(i) * sim.inst.tickSize).toFixed(sim.inst.priceDecimals), s.qtyAt(i).toFixed(sim.inst.qtyDecimals)]);
      return out;
    };
    return send(200, { lastUpdateId: sim.updateId - 1, bids: lv('bids'), asks: lv('asks') });
  }
  if (path === '/api/v3/klines') {
    const iv = url.searchParams.get('interval') ?? '1m';
    const minutes = iv.endsWith('h') ? parseInt(iv) * 60 : parseInt(iv);
    const s = getSeries(sim, minutes);
    const limit = Math.min(1000, Number(url.searchParams.get('limit') ?? 500));
    const endTime = Number(url.searchParams.get('endTime') ?? Infinity);
    const upto = s.filter((c) => c.t <= endTime);
    return send(200, upto.slice(-limit).map((c) => [c.t, String(c.o), String(c.h), String(c.l), String(c.c), String(c.v), c.t + minutes * 60_000 - 1]));
  }
  send(404, { msg: 'not found' });
}

// ---------- Binance USD-M futures (liquidation levels) ----------
// Same synthetic market as the spot sim, plus a made-up open interest that
// drifts up and down over hours, so the liquidation map has something to show.
function syntheticOi(sim: MarketSim, t: number): number {
  const base = 50_000_000 / (sim.midTick * sim.inst.tickSize);
  const h = t / 3_600_000;
  return base * (1 + 0.18 * Math.sin(h / 2.3) + 0.07 * Math.sin(h * 1.7 + 1) + 0.03 * Math.sin(h * 6.1));
}
const PERIOD_MS: Record<string, number> = { '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '1d': 86_400_000 };
const fclients = new Set<BClient>();

function futuresRest(url: URL, res: http.ServerResponse) {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' });
    res.end(JSON.stringify(body));
  };
  const path = url.pathname.replace(/^\/futures/, '');
  const sym = url.searchParams.get('symbol') ?? '';
  const sim = bsims.get(sym);
  if (!sim) return send(400, { code: -1121, msg: 'Invalid symbol.' });
  if (path === '/fapi/v1/klines') {
    const iv = url.searchParams.get('interval') ?? '1m';
    const minutes = iv.endsWith('h') ? parseInt(iv) * 60 : parseInt(iv);
    const s = getSeries(sim, minutes);
    const limit = Math.min(1500, Number(url.searchParams.get('limit') ?? 500));
    return send(200, s.slice(-limit).map((c) => [c.t, String(c.o), String(c.h), String(c.l), String(c.c), String(c.v * 40), c.t + minutes * 60_000 - 1]));
  }
  if (path === '/futures/data/openInterestHist') {
    const step = PERIOD_MS[url.searchParams.get('period') ?? '5m'] ?? 300_000;
    const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 30));
    const end = Math.floor(Date.now() / step) * step;
    const out = [];
    for (let i = limit - 1; i >= 0; i--) {
      const t = end - i * step;
      const oi = syntheticOi(sim, t);
      out.push({ symbol: sym, sumOpenInterest: oi.toFixed(3), sumOpenInterestValue: (oi * sim.midTick * sim.inst.tickSize).toFixed(2), timestamp: t });
    }
    return send(200, out);
  }
  if (path === '/fapi/v1/openInterest') return send(200, { symbol: sym, openInterest: syntheticOi(sim, Date.now()).toFixed(3), time: Date.now() });
  send(404, { msg: 'not found' });
}

function onFutures(ws: WebSocket, url: URL) {
  // only routed market streams carry aggTrade / forceOrder, like production
  if (!url.pathname.startsWith('/futures/market')) return ws.close();
  const cl: BClient = { ws, streams: new Set((url.searchParams.get('streams') ?? '').split('/').filter(Boolean)) };
  fclients.add(cl);
  ws.on('close', () => fclients.delete(cl));
}

let lastFutures = 0;
let aggId = 1;
function futuresTick(wall: number) {
  for (const cl of fclients) {
    for (const st of cl.streams) {
      const m = /^(\w+)@(aggTrade|forceOrder)$/.exec(st);
      if (!m) continue;
      const sym = m[1].toUpperCase();
      const sim = bsims.get(sym);
      if (!sim) continue;
      const px = sim.midTick * sim.inst.tickSize;
      if (m[2] === 'aggTrade') {
        for (let i = 0; i < 5; i++) {
          const p = (px * (1 + (Math.random() - 0.5) * 0.0004)).toFixed(sim.inst.priceDecimals);
          const q = (Math.random() ** 2 * 2 * (91000 / px)).toFixed(3);
          cl.ws.send(JSON.stringify({ stream: st, data: { e: 'aggTrade', E: wall, s: sym, a: aggId++, p, q, T: wall, m: Math.random() < 0.5 } }));
        }
      } else if (Math.random() < 0.02) {
        const S = Math.random() < 0.5 ? 'SELL' : 'BUY';
        const q = (Math.random() ** 3 * 5 * (91000 / px)).toFixed(3);
        const p = px.toFixed(sim.inst.priceDecimals);
        cl.ws.send(JSON.stringify({ stream: st, data: { e: 'forceOrder', E: wall, o: { s: sym, S, o: 'LIMIT', f: 'IOC', q, p, ap: p, X: 'FILLED', l: q, z: q, T: wall } } }));
      }
    }
  }
}

// ---------- tick loop ----------
let carry = 0;
let last = performance.now();
let lastBinanceFlush = 0;
let lastCandle = 0;
let sentMsgs = 0;
let sentLevels = 0;
const changes: LevelChange[] = [];

function tick() {
  const now = performance.now();
  const dt = now - last;
  last = now;
  carry += (RATE * dt) / 1000;
  const budget = Math.floor(carry);
  carry -= budget;
  const nsym = pairs.length;
  const wall = Date.now();
  const ts = new Date().toISOString();

  // Kraken: many small messages
  if (kclients.size) {
    let left = budget;
    let si = 0;
    const ksyms = [...ksims.keys()];
    while (left > 0) {
      const sym = ksyms[si++ % nsym];
      const sim = ksims.get(sym)!;
      const n = Math.min(left, 1 + Math.floor(Math.random() * KRAKEN_LEVELS_PER_MSG));
      left -= n;
      changes.length = 0;
      sim.step(n, changes);
      const bids: { price: number; qty: number }[] = [];
      const asks: { price: number; qty: number }[] = [];
      for (const c of changes) (c.side === 0 ? bids : asks).push({ price: c.price, qty: c.qty });
      const msg = JSON.stringify({ channel: 'book', type: 'update', data: [{ symbol: sym, bids, asks, checksum: sim.book.krakenChecksum(), timestamp: ts }] });
      for (const cl of kclients) if (cl.books.has(sym)) { cl.ws.send(msg); sentMsgs++; }
      sentLevels += changes.length;
    }
  } else for (const sim of ksims.values()) { changes.length = 0; sim.step(1, changes); }

  // Binance: changes accumulate per symbol and flush every batch interval
  {
    const per = Math.ceil(budget / nsym);
    for (const [sym, sim] of bsims) {
      changes.length = 0;
      sim.step(per, changes);
      let p = bpending.get(sym);
      if (!p) bpending.set(sym, (p = { U: sim.updateId, u: sim.updateId, b: [], a: [] }));
      for (const c of changes) {
        const row: [string, string] = [c.price.toFixed(sim.inst.priceDecimals), c.qty.toFixed(sim.inst.qtyDecimals)];
        (c.side === 0 ? p.b : p.a).push(row);
      }
      p.u = sim.updateId;
      sim.updateId++;
    }
    if (now - lastBinanceFlush >= BINANCE_BATCH_MS) {
      lastBinanceFlush = now;
      for (const [sym, p] of bpending) {
        const stream = `${sym.toLowerCase()}@depth@100ms`;
        const msg = JSON.stringify({ stream, data: { e: 'depthUpdate', E: wall, s: sym, U: p.U, u: p.u, b: p.b, a: p.a } });
        for (const cl of bclients) if (cl.streams.has(stream)) { cl.ws.send(msg); sentMsgs++; }
        sentLevels += p.b.length + p.a.length;
      }
      bpending.clear();
    }
  }

  // futures trades, 20 times a second
  if (fclients.size && now - lastFutures > 50) { lastFutures = now; futuresTick(wall); }

  // candles, 4 times a second
  if (now - lastCandle > 250) {
    lastCandle = now;
    for (const cl of kclients) {
      if (!cl.ohlc) continue;
      const sim = ksims.get(cl.ohlc.symbol)!;
      const c = advance(getSeries(sim, cl.ohlc.interval), cl.ohlc.interval, sim.midTick * sim.inst.tickSize, Math.random(), wall);
      cl.ws.send(JSON.stringify({ channel: 'ohlc', type: 'update', data: [krakenCandle(cl.ohlc.symbol, c, cl.ohlc.interval)] }));
    }
    for (const cl of bclients) {
      for (const st of cl.streams) {
        const m = /^(\w+)@kline_(\w+)$/.exec(st);
        if (!m) continue;
        const sym = m[1].toUpperCase();
        const sim = bsims.get(sym);
        if (!sim) continue;
        const minutes = m[2].endsWith('h') ? parseInt(m[2]) * 60 : parseInt(m[2]);
        const c = advance(getSeries(sim, minutes), minutes, sim.midTick * sim.inst.tickSize, Math.random(), wall);
        cl.ws.send(JSON.stringify({ stream: st, data: { e: 'kline', E: wall, s: sym, k: { t: c.t, T: c.t + minutes * 60_000 - 1, i: m[2], o: String(c.o), h: String(c.h), l: String(c.l), c: String(c.c), v: String(c.v), x: false } } }));
      }
    }
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/control') {
    // runtime control for the benchmark harness: /control?rate=50000
    if (url.searchParams.has('rate')) RATE = Number(url.searchParams.get('rate'));
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ rate: RATE, pairs: pairs.length }));
  }
  if (url.pathname.startsWith('/binance/')) return binanceRest(url, res);
  if (url.pathname.startsWith('/futures/')) return futuresRest(url, res);
  if (url.pathname === '/kraken/0/public/OHLC') return krakenRest(url, res);
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  wss.handleUpgrade(req, sock, head, (ws) => {
    if (url.pathname.startsWith('/kraken')) onKraken(ws);
    else if (url.pathname.startsWith('/binance')) onBinance(ws, url);
    else if (url.pathname.startsWith('/futures')) onFutures(ws, url);
    else ws.close();
  });
});
server.listen(PORT, () => console.log(`venue emulator on :${PORT}, ${pairs.length} pairs per venue, ${RATE} level changes/s per venue`));
setInterval(tick, TICK_MS);
setInterval(() => {
  if (sentMsgs) console.log(`sent ${sentMsgs} msgs/s, ${sentLevels} levels/s`);
  sentMsgs = 0; sentLevels = 0;
}, 1000);
