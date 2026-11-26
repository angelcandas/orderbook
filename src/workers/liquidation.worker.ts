/**
 * Liquidation levels worker. Owns its own futures socket and model, so none of
 * this touches the order book path; it hands per-candle level columns to the
 * render worker, which draws them as bands on the candle chart.
 *
 * Data, all public Binance USD-M futures:
 *  - history: /fapi/v1/klines + /futures/data/openInterestHist (REST)
 *  - live: <sym>@aggTrade and <sym>@forceOrder on wss://fstream.binance.com/market
 *    (the unrouted /stream URL stopped carrying these streams in 2026)
 *  - open interest: /fapi/v1/openInterest every 10 s
 * If futures REST is unreachable from the browser, history falls back to spot
 * klines and a volume-based estimate, and the stats say so.
 * Kraken spot has no liquidations; the overlay always uses the Binance perpetual
 * and the chart rescales its prices onto the venue's own.
 */
import { futuresSymbol } from '../liquidation/model';
import { LiqSeries, periods, type Bar, type OiPoint } from '../liquidation/series';

export type LiqCmd =
  | { type: 'init'; futuresWs: string; futuresRest: string; spotRest: string; renderPort: MessagePort }
  | { type: 'focus'; base: string | null; interval: number }
  | { type: 'stop' };

export interface LiqStats {
  type: 'liqStats';
  symbol: string;
  status: string;
  /** where the levels come from */
  source: 'open interest' | 'volume estimate' | '';
  msgsPerSec: number;
  liquidations: number;
  liquidatedNotional: number;
  long?: { price: number; notional: number };
  short?: { price: number; notional: number };
  lastPrice: number;
  backfillMs: number;
  bars: number;
}

const OI_MS = 10_000;

let wsBase = '', restBase = '', spotRest = '';
let port: MessagePort | null = null;
let series: LiqSeries | null = null;
let symbol = '';
let status = 'idle';
let source: LiqStats['source'] = '';
let ws: WebSocket | null = null;
let timers: any[] = [];
let gen = 0;
let msgs = 0, msgsPerSec = 0;
let oiLive = true;
let backfillMs = 0;
let tailDirty = false;

self.onmessage = (e: MessageEvent<LiqCmd>) => {
  const m = e.data;
  if (m.type === 'init') {
    wsBase = m.futuresWs; restBase = m.futuresRest; spotRest = m.spotRest; port = m.renderPort;
    setInterval(() => { msgsPerSec = msgs; msgs = 0; postStats(); }, 1000);
  } else if (m.type === 'focus') focus(m.base, m.interval);
  else if (m.type === 'stop') { teardown(); close(); }
};

function teardown(): void {
  for (const t of timers) { clearInterval(t); clearTimeout(t); }
  timers = [];
  if (ws) { ws.onclose = null; ws.onmessage = null; ws.close(); ws = null; }
}

async function focus(base: string | null, interval: number): Promise<void> {
  teardown();
  const g = ++gen;
  series = null;
  port?.postMessage({ type: 'liqClear' });
  if (!base) { symbol = ''; status = 'no pair'; return; }
  // columns are one per fixed-length bar and open interest history stops at daily
  // periods, so weekly and monthly charts are built from daily columns: the
  // chart draws each candle from the last daily column it covers
  const days = interval > 1440;
  if (days) interval = 1440;
  symbol = futuresSymbol(`${base}USDT`).symbol;
  status = 'loading history';
  const s = new LiqSeries(interval * 60_000);
  const t0 = performance.now();
  try {
    const { bars, oi, src } = await history(symbol, interval, days ? 1500 : undefined);
    if (g !== gen) return;
    s.replay(bars, oi);
    source = src;
    backfillMs = performance.now() - t0;
  } catch (err) {
    if (g !== gen) return;
    if (String(err).includes('400')) { status = `no ${symbol} perpetual`; return; }
    source = 'volume estimate';
  }
  series = s;
  if (s.cols.length) port?.postMessage(s.frame(symbol));
  connect(g);
  oiLive = source === 'open interest';
  timers.push(setInterval(() => pollOi(g), OI_MS));
  // the newest column follows live trades, at most once a second
  timers.push(setInterval(() => {
    if (g !== gen || !series || !tailDirty || !series.cols.length) return;
    tailDirty = false;
    const t = series.tail();
    port?.postMessage(t, [t.data.buffer, t.events.buffer]);
  }, 1000));
}

async function getJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

async function history(sym: string, interval: number, bars?: number): Promise<{ bars: Bar[]; oi: OiPoint[]; src: LiqStats['source'] }> {
  const p = periods(interval);
  // 500 OI points is the endpoint's max; pick as many bars as it can cover
  // (weekly / monthly charts ask for more daily bars to fill more candles)
  const limit = bars ?? (interval < 5 ? 1000 : 500);
  const toBars = (rows: any[]): Bar[] => rows.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  try {
    const [k, o] = await Promise.all([
      getJson(`${restBase}/fapi/v1/klines?symbol=${sym}&interval=${p.kline}&limit=${limit}`),
      getJson(`${restBase}/futures/data/openInterestHist?symbol=${sym}&period=${p.oi}&limit=500`),
    ]);
    const oi = (o as any[]).map((x) => ({ t: +x.timestamp, oi: +x.sumOpenInterest })).sort((a, b) => a.t - b.t);
    return { bars: toBars(k), oi, src: 'open interest' };
  } catch (err) {
    if (String(err).includes('400')) throw err;
    // futures REST blocked (CORS) or down: spot klines, volume-based estimate
    const spot = sym.replace(/^1000/, '');
    const k = await getJson(`${spotRest}/api/v3/klines?symbol=${spot}&interval=${p.kline}&limit=${limit}`);
    return { bars: toBars(k), oi: [], src: 'volume estimate' };
  }
}

function connect(g: number, attempt = 0): void {
  const s = symbol.toLowerCase();
  const sock = new WebSocket(`${wsBase}/market/stream?streams=${s}@aggTrade/${s}@forceOrder`);
  ws = sock;
  let got = false;
  status = 'connecting';
  sock.onopen = () => { if (g === gen) status = 'waiting for trades'; };
  sock.onmessage = (e) => {
    if (g !== gen || !series) return;
    msgs++;
    let d: any;
    try { d = JSON.parse(e.data as string).data; } catch { return; }
    if (!d) return;
    if (!got) { got = true; attempt = 0; status = 'live'; }
    if (d.e === 'aggTrade') {
      const r = series.trade(+d.T, +d.p, +d.q);
      tailDirty = true;
      if (r === 'full') port?.postMessage(series.frame(symbol));
      else if (r === 'new') { const t = series.tail(); port?.postMessage(t, [t.data.buffer, t.events.buffer]); }
    } else if (d.e === 'forceOrder') {
      const o = d.o;
      series.liquidation(+o.T || Date.now(), +(o.ap || o.p), +(o.z || o.q), o.S === 'SELL' ? 'long' : 'short');
      tailDirty = true;
    }
  };
  sock.onclose = () => {
    if (g !== gen) return;
    status = 'reconnecting';
    timers.push(setTimeout(() => connect(g, attempt + 1), Math.min(30_000, 1000 * 2 ** attempt)));
  };
  sock.onerror = () => { if (g === gen) status = 'socket error'; };
  // a socket that opens but carries nothing is the failure seen before: say so
  timers.push(setTimeout(() => { if (g === gen && !got) status = 'no futures data'; }, 15_000));
  timers.push(setTimeout(() => sock.close(), 23 * 3600 * 1000));
}

async function pollOi(g: number): Promise<void> {
  if (!series) return;
  if (!oiLive) { series.openFromVolume(); tailDirty = true; return; }
  try {
    const j = await getJson(`${restBase}/fapi/v1/openInterest?symbol=${symbol}`);
    if (g === gen && series) { series.openInterest(+j.openInterest); tailDirty = true; }
  } catch {
    if (g === gen) { oiLive = false; source = 'volume estimate'; }
  }
}

function postStats(): void {
  let notional = 0, n = 0;
  const ev = series?.events ?? [];
  for (let i = 0; i < ev.length; i += 4) { notional += ev[i + 2]; n++; }
  const c = series?.map.clusters();
  const s: LiqStats = {
    type: 'liqStats', symbol, status, source, msgsPerSec,
    liquidations: n, liquidatedNotional: notional,
    long: c?.long, short: c?.short,
    lastPrice: series?.map.lastPrice ?? 0, backfillMs, bars: series?.cols.length ?? 0,
  };
  (self as any).postMessage(s);
}
