/**
 * Replay a recorded session over local Kraken and Binance endpoints, at any
 * speed, so the app's full socket-to-pixel path runs on real market data:
 *
 *   npx tsx server/replay.ts --file recordings/session.jsonl --speed 10 --port 8787
 *   open http://localhost:5173/?src=local
 *
 * The server rebuilds each book from the recording, so a client that connects
 * mid-replay gets a correct snapshot: Kraken with a valid checksum, Binance with
 * the right lastUpdateId. Recorded updates are then forwarded unchanged. At the
 * end of the file the replay loops and every client is disconnected, so it
 * resyncs from a fresh snapshot.
 */
import fs from 'node:fs';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Book, decimalsOfIncrement } from '../src/engine/book';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const FILE = args.get('file');
if (!FILE) throw new Error('--file is required');
let SPEED = Number(args.get('speed') ?? 1);
const PORT = Number(args.get('port') ?? 8787);

interface Line { t: number; v: string; d: any; s?: string }
const lines: Line[] = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.log(`loaded ${lines.length} lines, ${(lines[lines.length - 1].t / 1000).toFixed(0)} s of market time`);

const kbooks = new Map<string, Book>();
const bbooks = new Map<string, { book: Book; lastId: number; live: boolean; pending: any[] }>();
let exchangeInfo: any = { symbols: [] };
let krakenInstruments: any = null;
let krakenDepth = 500;

function resetBooks() {
  kbooks.clear();
  bbooks.clear();
}

// ---------- apply recorded traffic to the server's books ----------
function applyKraken(raw: string): any {
  const m = JSON.parse(raw);
  for (const d of m.data) {
    let book = kbooks.get(d.symbol);
    if (m.type === 'snapshot') {
      const p = krakenInstruments?.data.pairs.find((x: any) => x.symbol === d.symbol);
      if (!p) continue;
      book = new Book({ symbol: d.symbol, tickSize: Number(p.price_increment), priceDecimals: p.price_precision, qtyDecimals: p.qty_precision }, krakenDepth);
      kbooks.set(d.symbol, book);
    }
    if (!book) continue;
    for (const l of d.bids) book.setBid(l.price, l.qty);
    for (const l of d.asks) book.setAsk(l.price, l.qty);
    book.bids.truncate(krakenDepth);
    book.asks.truncate(krakenDepth);
  }
  return m;
}

function applyBinanceDiff(st: { book: Book; lastId: number }, e: any): void {
  if (e.u <= st.lastId) return;
  for (const [p, q] of e.b) st.book.setBid(+p, +q);
  for (const [p, q] of e.a) st.book.setAsk(+p, +q);
  st.lastId = e.u;
}

function onLine(l: Line): void {
  switch (l.v) {
    case 'meta': krakenDepth = l.d.krakenDepth ?? 500; break;
    case 'ki': krakenInstruments = l.d; break;
    case 'bi':
      exchangeInfo = l.d;
      for (const s of l.d.symbols) {
        const pf = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
        const lf = s.filters.find((f: any) => f.filterType === 'LOT_SIZE');
        bbooks.set(s.symbol, {
          book: new Book({ symbol: s.symbol, tickSize: +pf.tickSize, priceDecimals: decimalsOfIncrement(pf.tickSize), qtyDecimals: decimalsOfIncrement(lf.stepSize) }, 1000),
          lastId: 0, live: false, pending: [],
        });
      }
      break;
    case 'bs': {
      const st = bbooks.get(l.s!);
      if (!st) break;
      st.book.clear();
      for (const [p, q] of l.d.bids) st.book.setBid(+p, +q);
      for (const [p, q] of l.d.asks) st.book.setAsk(+p, +q);
      st.lastId = l.d.lastUpdateId;
      st.live = true;
      for (const e of st.pending) applyBinanceDiff(st, e);
      st.pending = [];
      break;
    }
    case 'k': {
      const m = applyKraken(l.d);
      if (m.type === 'update') {
        // forward only symbols each client subscribed to
        for (const cl of kclients) {
          const sym = m.data[0]?.symbol;
          if (cl.books.has(sym) && cl.ws.readyState === 1) cl.ws.send(l.d);
        }
        sent++;
      }
      break;
    }
    case 'b': {
      const m = JSON.parse(l.d);
      const e = m.data;
      const st = bbooks.get(e?.s);
      if (!st) break;
      if (!st.live) { st.pending.push(e); break; }
      applyBinanceDiff(st, e);
      // only forward once the server book is live, so snapshots and diffs agree
      for (const cl of bclients) if (cl.streams.has(m.stream) && cl.ws.readyState === 1) cl.ws.send(l.d);
      sent++;
      break;
    }
  }
}

// ---------- endpoints ----------
interface KClient { ws: WebSocket; books: Set<string> }
interface BClient { ws: WebSocket; streams: Set<string> }
const kclients = new Set<KClient>();
const bclients = new Set<BClient>();
let sent = 0;

function krakenSnapshot(sym: string, depth: number) {
  const b = kbooks.get(sym);
  if (!b) return null;
  const side = (s: typeof b.bids) => Array.from({ length: Math.min(depth, s.n) }, (_, i) => ({ price: Number((s.tickAt(i) * b.inst.tickSize).toFixed(b.inst.priceDecimals)), qty: s.qtyAt(i) }));
  return { channel: 'book', type: 'snapshot', data: [{ symbol: sym, bids: side(b.bids), asks: side(b.asks), checksum: b.krakenChecksum() }] };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/control') {
    if (url.searchParams.has('speed')) SPEED = Number(url.searchParams.get('speed'));
    return send(200, { speed: SPEED, position: pos, lines: lines.length });
  }
  const path = url.pathname.replace(/^\/binance/, '');
  if (path === '/api/v3/exchangeInfo') return send(200, exchangeInfo);
  if (path === '/api/v3/depth') {
    const st = bbooks.get(url.searchParams.get('symbol') ?? '');
    if (!st || !st.live) return send(503, { msg: 'not ready' });
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const b = st.book;
    const side = (s: typeof b.bids) => Array.from({ length: Math.min(limit, s.n) }, (_, i) => [(s.tickAt(i) * b.inst.tickSize).toFixed(b.inst.priceDecimals), s.qtyAt(i).toFixed(b.inst.qtyDecimals)]);
    return send(200, { lastUpdateId: st.lastId, bids: side(b.bids), asks: side(b.asks) });
  }
  if (path === '/api/v3/klines') return send(200, []);
  send(404, {});
});
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  wss.handleUpgrade(req, sock, head, (ws) => {
    if (url.pathname.startsWith('/kraken')) {
      const cl: KClient = { ws, books: new Set() };
      kclients.add(cl);
      ws.on('close', () => kclients.delete(cl));
      ws.on('message', (buf) => {
        const m = JSON.parse(buf.toString());
        const p = m.params ?? {};
        if (p.channel === 'instrument' && m.method === 'subscribe' && krakenInstruments) ws.send(JSON.stringify(krakenInstruments));
        if (p.channel === 'book') {
          for (const sym of p.symbol) {
            if (m.method === 'unsubscribe') { cl.books.delete(sym); continue; }
            cl.books.add(sym);
            const snap = krakenSnapshot(sym, p.depth ?? 10);
            if (snap) ws.send(JSON.stringify(snap));
          }
        }
      });
    } else if (url.pathname.startsWith('/binance')) {
      const cl: BClient = { ws, streams: new Set((url.searchParams.get('streams') ?? '').split('/').filter(Boolean)) };
      bclients.add(cl);
      ws.on('close', () => bclients.delete(cl));
      ws.on('message', (buf) => {
        const m = JSON.parse(buf.toString());
        if (m.method === 'SUBSCRIBE') for (const s of m.params) cl.streams.add(s);
        if (m.method === 'UNSUBSCRIBE') for (const s of m.params) cl.streams.delete(s);
        ws.send(JSON.stringify({ result: null, id: m.id }));
      });
    } else ws.close();
  });
});

// ---------- clock ----------
let pos = 0;
let base = performance.now();
let baseT = 0;
function pump() {
  const marketNow = baseT + (performance.now() - base) * SPEED;
  while (pos < lines.length && lines[pos].t <= marketNow) onLine(lines[pos++]);
  if (pos >= lines.length) {
    console.log('end of recording: looping, clients will resync');
    for (const c of [...kclients, ...bclients]) c.ws.close();
    resetBooks();
    pos = 0; base = performance.now(); baseT = 0;
  }
}
// keep SPEED changes continuous
let lastSpeed = SPEED;
setInterval(() => {
  if (SPEED !== lastSpeed) { baseT = baseT + (performance.now() - base) * lastSpeed; base = performance.now(); lastSpeed = SPEED; }
  pump();
}, 2);
setInterval(() => { if (sent) console.log(`forwarded ${sent} msgs/s at ${SPEED}x`); sent = 0; }, 1000);
server.listen(PORT, () => console.log(`replay on :${PORT} at ${SPEED}x`));
