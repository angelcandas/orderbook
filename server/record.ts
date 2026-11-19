/**
 * Record live Kraken and Binance book traffic to JSONL for replay benchmarks.
 * Run it where the exchanges are reachable (your own machine):
 *
 *   npx tsx server/record.ts --minutes 10 --pairs 5 --out recordings/session.jsonl
 *
 * Each line: {"t": ms since start, "v": kind, "d": raw message or REST body}
 *   k  Kraken WebSocket message      ki  Kraken instrument snapshot
 *   b  Binance WebSocket message     bs  Binance REST depth snapshot ("s" = symbol)
 *   bi Binance exchangeInfo
 */
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { LIVE, PAIRS, localEndpoints } from '../src/shared/config';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const minutes = Number(args.get('minutes') ?? 5);
const seconds = Number(args.get('seconds') ?? minutes * 60);
const npairs = Number(args.get('pairs') ?? 5);
const depth = Number(args.get('depth') ?? (args.get('src') === 'local' ? 1000 : 500));
const out = args.get('out') ?? `recordings/${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
fs.mkdirSync(path.dirname(out), { recursive: true });
const file = fs.createWriteStream(out);
const t0 = performance.now();
const write = (v: string, d: unknown, extra: object = {}) =>
  file.write(JSON.stringify({ t: Math.round((performance.now() - t0) * 1000) / 1000, v, ...extra, d }) + '\n');
const pairs = PAIRS.slice(0, npairs);
// --src local records the venue emulator instead (for testing the pipeline offline)
const EP = args.get('src') === 'local' ? localEndpoints(args.get('host') ?? 'localhost:8787') : LIVE;
write('meta', { started: new Date().toISOString(), pairs: pairs.map((p) => p.label), krakenDepth: depth, binanceDepth: 1000 });
let counts = { k: 0, b: 0 };

// Kraken: instrument snapshot first (precisions for the checksum), then books
const k = new WebSocket(EP.krakenWs);
k.on('open', () => k.send(JSON.stringify({ method: 'subscribe', params: { channel: 'instrument', snapshot: true } })));
k.on('message', (buf) => {
  const s = buf.toString();
  const m = JSON.parse(s);
  if (m.channel === 'instrument' && m.type === 'snapshot') {
    write('ki', m);
    k.send(JSON.stringify({ method: 'unsubscribe', params: { channel: 'instrument' } }));
    k.send(JSON.stringify({ method: 'subscribe', params: { channel: 'book', symbol: pairs.map((p) => p.kraken), depth, snapshot: true } }));
    return;
  }
  if (m.channel === 'book') { write('k', s); counts.k++; }
});

// Binance: stream first, then REST snapshots
const syms = pairs.map((p) => p.binance);
const b = new WebSocket(`${EP.binanceWs}/stream?streams=${syms.map((s) => `${s.toLowerCase()}@depth@100ms`).join('/')}`);
b.on('message', (buf) => { write('b', buf.toString()); counts.b++; });
b.on('open', async () => {
  const info = await (await fetch(`${EP.binanceRest}/api/v3/exchangeInfo?symbols=${encodeURIComponent(JSON.stringify(syms))}`)).json();
  write('bi', info);
  for (const s of syms) {
    await new Promise((r) => setTimeout(r, 500));
    write('bs', await (await fetch(`${EP.binanceRest}/api/v3/depth?symbol=${s}&limit=1000`)).json(), { s });
  }
});

const timer = setInterval(() => console.log(`recorded kraken ${counts.k} / binance ${counts.b} messages`), 10_000);
setTimeout(() => {
  clearInterval(timer);
  k.close(); b.close();
  file.end(() => { console.log(`wrote ${out}`); process.exit(0); });
}, seconds * 1000);
