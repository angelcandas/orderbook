/**
 * Liquidation heatmap worker: owns its own futures socket, the liquidation
 * model and the canvas, so none of this touches the order book path.
 *
 * Live: Binance USD-M futures public streams (aggTrade + forceOrder for one
 * symbol) and the public open-interest REST endpoint, polled every 5 s.
 * Kraken spot has no liquidations; the panel always shows Binance futures.
 * Synthetic: a random-walk market for the local emulator source and tests.
 */
import { LiqMap, futuresSymbol, type LiqEvent } from '../liquidation/model';
import { Heatmap, HEAT_DARK, HEAT_LIGHT, compact } from '../liquidation/heatmap';
import { Histogram } from '../shared/hist';
import { rng } from '../liquidation/model';

export type LiqCmd =
  | { type: 'init'; canvas: OffscreenCanvas; w: number; h: number; dpr: number; theme: 'dark' | 'light'; spot: string; mode: 'live' | 'synthetic'; ws?: string; rest?: string; columnMs?: number }
  | { type: 'resize'; w: number; h: number; dpr: number }
  | { type: 'symbol'; spot: string }
  | { type: 'theme'; theme: 'dark' | 'light' }
  | { type: 'pointer'; x: number; y: number; in: boolean }
  | { type: 'stop' };

export interface LiqStats {
  type: 'stats';
  symbol: string;
  status: string;
  msgsPerSec: number;
  liquidations: number; // events in view
  liquidatedNotional: number;
  oi: boolean; // open interest available (else volume fallback)
  draw: { p50: number; p99: number };
  long?: { price: number; notional: string };
  short?: { price: number; notional: string };
  last: LiqEvent | null;
  /** futures contract size vs spot (1000 for 1000PEPEUSDT) */
  mult: number;
}

const OI_MS = 5000;

let ctx: OffscreenCanvasRenderingContext2D;
let map: LiqMap;
let heat: Heatmap;
let mode: 'live' | 'synthetic' = 'live';
let wsBase = 'wss://fstream.binance.com';
let restBase = 'https://fapi.binance.com';
let columnMs = 1000;
let symbol = '';
let mult = 1;
let status = 'connecting';
let ws: WebSocket | null = null;
let timers: any[] = [];
let msgs = 0, msgsPerSec = 0;
let oiOk = true;
let gen = 0; // bumps on symbol change so stale callbacks drop out
let dirty = false;
let lastEvent: LiqEvent | null = null;
let size = { w: 1, h: 1, dpr: 1 };
const drawH = new Histogram();

self.onmessage = (e: MessageEvent<LiqCmd>) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      ctx = m.canvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D;
      mode = m.mode;
      if (m.ws) wsBase = m.ws;
      if (m.rest) restBase = m.rest;
      if (m.columnMs) columnMs = m.columnMs;
      setup(m.spot);
      heat.theme = m.theme === 'light' ? HEAT_LIGHT : HEAT_DARK;
      size = { w: m.w, h: m.h, dpr: m.dpr };
      heat.resize(m.w, m.h, m.dpr);
      startLoop();
      break;
    }
    case 'resize': size = { w: m.w, h: m.h, dpr: m.dpr }; heat?.resize(m.w, m.h, m.dpr); dirty = true; break;
    case 'symbol': if (futuresSymbol(m.spot).symbol !== symbol) setup(m.spot); break;
    case 'theme': if (heat) { heat.theme = m.theme === 'light' ? HEAT_LIGHT : HEAT_DARK; dirty = true; } break;
    case 'pointer': if (heat) { heat.hover = m.in ? { x: m.x, y: m.y } : null; dirty = true; } break;
    case 'stop': teardown(); close(); break;
  }
};

function setup(spot: string): void {
  teardown();
  gen++;
  ({ symbol, mult } = futuresSymbol(spot));
  map = new LiqMap();
  const prevTheme = heat?.theme;
  heat = new Heatmap(ctx, map);
  if (prevTheme) heat.theme = prevTheme;
  heat.resize(size.w, size.h, size.dpr);
  lastEvent = null;
  oiOk = true;
  status = 'connecting';
  if (mode === 'live') connect(gen); else synthetic(gen);
  timers.push(setInterval(() => column(), columnMs));
  timers.push(setInterval(() => { msgsPerSec = msgs; msgs = 0; post(); }, 1000));
  dirty = true;
}

function teardown(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
}

function column(): void {
  if (!map.ready) return;
  if (map.shifted) { heat.shift(map.shifted); map.shifted = 0; }
  heat.push(Date.now());
  dirty = true;
}

function onLiquidation(ev: LiqEvent): void {
  heat.events.push(ev);
  lastEvent = ev;
  dirty = true;
}

// ---- live ----

function connect(g: number, attempt = 0): void {
  const s = symbol.toLowerCase();
  const sock = new WebSocket(`${wsBase}/stream?streams=${s}@aggTrade/${s}@forceOrder`);
  ws = sock;
  sock.onopen = () => { if (g === gen) { status = 'live'; attempt = 0; } };
  sock.onmessage = (e) => {
    if (g !== gen) return;
    msgs++;
    let d: any;
    try { d = JSON.parse(e.data as string).data; } catch { return; }
    if (!d) return;
    if (d.e === 'aggTrade') map.trade(+d.p, +d.q);
    else if (d.e === 'forceOrder') {
      const o = d.o;
      onLiquidation({ t: +o.T || Date.now(), price: +(o.ap || o.p), qty: +(o.z || o.q), side: o.S === 'SELL' ? 'long' : 'short' });
    }
  };
  sock.onclose = () => {
    if (g !== gen) return;
    status = 'reconnecting';
    const t = setTimeout(() => connect(g, attempt + 1), Math.min(30_000, 500 * 2 ** attempt));
    timers.push(t);
  };
  sock.onerror = () => { if (g === gen) status = 'error: socket'; };
  // connections are cut at 24 h; recycle earlier
  timers.push(setTimeout(() => sock.close(), 23 * 3600 * 1000));
  pollOi(g);
  timers.push(setInterval(() => pollOi(g), OI_MS));
}

async function pollOi(g: number): Promise<void> {
  if (!oiOk) { map.openFromVolume(); return; }
  try {
    const r = await fetch(`${restBase}/fapi/v1/openInterest?symbol=${symbol}`);
    if (r.status === 400) { if (g === gen) { status = `error: no ${symbol} perpetual`; post(); teardown(); } return; }
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    if (g === gen) map.openInterest(+j.openInterest);
  } catch {
    // CORS or network: fall back to assuming a share of volume opens positions
    if (g === gen) { oiOk = false; map.openFromVolume(); }
  }
}

// ---- synthetic ----

function synthetic(g: number): void {
  const rnd = rng(7 + symbol.length);
  const base = { BTCUSDT: 91000, ETHUSDT: 3100, SOLUSDT: 140 }[symbol] ?? 100;
  let p = base, oi = 50_000_000 / base, drift = 0;
  status = 'live (synthetic)';
  timers.push(setInterval(() => {
    if (g !== gen) return;
    // 50 trades per 20 ms = 2,500 trades/s, with slow trends so levels get swept
    // trends of a few tenths of a percent a minute, pulled back towards the start
    drift = drift * 0.998 + (rnd() - 0.5) * 0.0000004 - (p / base - 1) * 0.0000002;
    for (let i = 0; i < 50; i++) {
      p *= 1 + drift + (rnd() - 0.5) * 0.00001;
      map.trade(p, rnd() * 0.5 * (91000 / base));
      msgs++;
    }
    if (rnd() < 0.03) {
      const side = drift < 0 ? 'long' : 'short';
      onLiquidation({ t: Date.now(), price: p, qty: rnd() ** 3 * 20 * (91000 / base), side });
    }
  }, 20));
  timers.push(setInterval(() => {
    if (g !== gen) return;
    oi *= 1 + (rnd() - 0.42) * 0.004; // tends to grow
    map.openInterest(oi);
  }, 1000));
}

// ---- draw + stats ----

const raf: (f: () => void) => void = typeof requestAnimationFrame === 'function'
  ? (f) => requestAnimationFrame(f)
  : (f) => setTimeout(f, 16);

function startLoop(): void {
  const frame = () => {
    if (dirty && heat) {
      dirty = false;
      drawH.record(heat.draw());
    }
    raf(frame);
  };
  raf(frame);
}

function post(): void {
  const c = map.clusters();
  let notional = 0;
  for (const e of heat.events) notional += e.price * e.qty;
  const s: LiqStats = {
    type: 'stats', symbol, status, msgsPerSec, liquidations: heat.events.length, liquidatedNotional: notional,
    oi: oiOk && mode === 'live' ? map.oiSamples > 1 : mode === 'synthetic',
    draw: { p50: drawH.percentile(50), p99: drawH.percentile(99) },
    long: c.long && { price: c.long.price, notional: compact(c.long.notional) },
    short: c.short && { price: c.short.price, notional: compact(c.short.notional) },
    last: lastEvent, mult,
  };
  (self as any).postMessage(s);
}
