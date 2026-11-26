import type { PatternHit } from '../patterns/types';
import { ema, rsi } from '../patterns/indicators';

/**
 * Trading game: you and the house AI each start with the same simulated
 * dollars on one pair and trade it at the live book (buy at the best ask, sell
 * at the best bid, a taker fee each way). Spot only: you can hold the coin or
 * cash, no shorting or leverage. When the clock runs out both sides are sold
 * at the bid and whoever has more dollars wins.
 *
 * Everything here is pure so it can be tested; the page feeds it prices.
 */
export const START_CASH = 10_000;
/** taker fee per fill, like a spot exchange's base tier */
export const FEE = 0.001;
/** the smallest order, in dollars */
export const MIN_ORDER = 10;
/** game lengths offered, minutes */
export const DURATIONS = [5, 15, 30, 60];
export const DEFAULT_MINUTES = 15;
/** quotes counted as dollars */
export const DOLLAR_QUOTES = ['USD', 'USDT', 'USDC', 'FDUSD', 'USDP', 'TUSD', 'DAI', 'PYUSD', 'USDG', 'RLUSD'];

export type Who = 'you' | 'ai';
export interface Wallet { cash: number; qty: number; /** dollars paid for the coin held, fees included (average entry) */ cost: number }
export interface Trade { t: number; who: Who; side: 'buy' | 'sell'; qty: number; price: number; /** dollars paid (buy) or received (sell), after fees */ usd: number; fee: number; reason?: string }
export interface CurvePoint { t: number; you: number; ai: number; price: number }
export interface Result { at: number; label: string; minutes: number; you: number; ai: number; winner: Who | 'tie' }

/** what the AI remembers between decisions: 5 s bars of the mid it saw, and its open trade */
export interface AiMemory {
  bars: { t: number; o: number; h: number; l: number; c: number }[];
  lastCheck: number;
  lastTrade: number;
  /** price of the AI's latest buy and the best price since, for its stop and trailing exit */
  entry: number;
  peak: number;
  /** what it thinks now, shown on the page */
  view: string;
  score: number;
}

export interface Game {
  id: string;
  venue: string;
  symbol: string;
  label: string;
  base: string;
  minutes: number;
  startedAt: number;
  endsAt: number;
  you: Wallet;
  ai: Wallet;
  trades: Trade[];
  curve: CurvePoint[];
  mem: AiMemory;
  /** set when the clock ran out (or the game was ended early) */
  result?: Result & { price: number };
}

export const isDollar = (quote: string) => DOLLAR_QUOTES.includes(quote.toUpperCase());
export const wallet = (): Wallet => ({ cash: START_CASH, qty: 0, cost: 0 });

export function newGame(o: { venue: string; symbol: string; label: string; base: string; minutes: number; now: number; id?: string }): Game {
  return {
    id: o.id ?? Math.random().toString(36).slice(2, 10),
    venue: o.venue, symbol: o.symbol, label: o.label, base: o.base, minutes: o.minutes,
    startedAt: o.now, endsAt: o.now + o.minutes * 60_000,
    you: wallet(), ai: wallet(), trades: [], curve: [],
    mem: { bars: [], lastCheck: 0, lastTrade: 0, entry: NaN, peak: NaN, view: 'Watching the market', score: 0 },
  };
}

/** What the coin and cash would fetch if sold at `bid` now, fees included. */
export const equity = (w: Wallet, bid: number) => w.cash + (w.qty > 0 && Number.isFinite(bid) ? w.qty * bid * (1 - FEE) : 0);

/** Spend `usd` (fee included) at `ask`. Null when the order is too small or the cash is short. */
export function buy(w: Wallet, usd: number, ask: number): { wallet: Wallet; qty: number; fee: number } | null {
  usd = Math.min(usd, w.cash);
  if (!(ask > 0) || !(usd >= MIN_ORDER - 1e-9)) return null;
  const fee = usd * FEE;
  const qty = (usd - fee) / ask;
  return { wallet: { cash: w.cash - usd, qty: w.qty + qty, cost: w.cost + usd }, qty, fee };
}

/** Sell `qty` of the coin at `bid`. Null when it is worth less than the minimum (unless it is everything held). */
export function sell(w: Wallet, qty: number, bid: number): { wallet: Wallet; usd: number; fee: number } | null {
  qty = Math.min(qty, w.qty);
  if (!(bid > 0) || !(qty > 0)) return null;
  const all = qty >= w.qty - 1e-12;
  if (!all && qty * bid < MIN_ORDER - 1e-9) return null;
  const gross = qty * bid;
  const fee = gross * FEE;
  const left = all ? 0 : w.qty - qty;
  return { wallet: { cash: w.cash + gross - fee, qty: left, cost: all ? 0 : w.cost * (left / w.qty) }, usd: gross - fee, fee };
}

/** Apply an order to a game. Returns the new game, or null when it cannot be filled. */
export function trade(g: Game, who: Who, side: 'buy' | 'sell', amount: number, bid: number, ask: number, t: number, reason?: string): Game | null {
  if (g.result) return null;
  const w = g[who];
  if (side === 'buy') {
    const r = buy(w, amount, ask);
    if (!r) return null;
    return { ...g, [who]: r.wallet, trades: [...g.trades, { t, who, side, qty: r.qty, price: ask, usd: Math.min(amount, w.cash), fee: r.fee, reason }] };
  }
  const r = sell(w, amount, bid);
  if (!r) return null;
  return { ...g, [who]: r.wallet, trades: [...g.trades, { t, who, side, qty: Math.min(amount, w.qty), price: bid, usd: r.usd, fee: r.fee, reason }] };
}

/** End the game: both sides are sold at the bid. */
export function finish(g: Game, bid: number, t: number): Game {
  if (g.result) return g;
  let n = g;
  for (const who of ['you', 'ai'] as Who[]) {
    if (n[who].qty > 0) n = trade(n, who, 'sell', n[who].qty, bid, bid, t, 'Game over: sold at the bid') ?? n;
  }
  const you = n.you.cash, ai = n.ai.cash;
  const winner: Result['winner'] = Math.abs(you - ai) < 0.005 ? 'tie' : you > ai ? 'you' : 'ai';
  return { ...n, curve: [...n.curve, { t, you, ai, price: bid }], result: { at: t, label: g.label, minutes: g.minutes, you, ai, winner, price: bid } };
}

/** Add a point to the money curve, at most one every `every` ms (the last point is overwritten in between). */
export function sample(g: Game, t: number, bid: number, every = 5000): Game {
  if (!Number.isFinite(bid)) return g;
  const p = { t, you: equity(g.you, bid), ai: equity(g.ai, bid), price: bid };
  const last = g.curve[g.curve.length - 1];
  if (last && t - last.t < every && g.curve.length > 1) return { ...g, curve: [...g.curve.slice(0, -1), p] };
  return { ...g, curve: [...g.curve, p] };
}

// ---------------------------------------------------------------- the AI

export const BAR_MS = 5000;
const MAX_BARS = 360;
/** how often the AI looks, and how long it waits after trading before it trades again */
export const AI_CHECK_MS = 10_000;
export const AI_COOLDOWN_MS = 30_000;
/** the AI's exits: a stop under its entry and a trailing exit once in profit */
export const AI_STOP = 0.006;
export const AI_TRAIL = 0.004;

/** Fold one mid price into the AI's 5 s bars. */
export function observe(mem: AiMemory, t: number, price: number): AiMemory {
  if (!(price > 0)) return mem;
  const bt = Math.floor(t / BAR_MS) * BAR_MS;
  const bars = mem.bars.slice(-MAX_BARS);
  const last = bars[bars.length - 1];
  if (last && last.t === bt) bars[bars.length - 1] = { ...last, h: Math.max(last.h, price), l: Math.min(last.l, price), c: price };
  else bars.push({ t: bt, o: price, h: price, l: price, c: price });
  const peak = Number.isFinite(mem.entry) ? Math.max(mem.peak, price) : mem.peak;
  return { ...mem, bars, peak };
}

/** bars of watched prices before the AI reads a trend (about a minute) */
export const TREND_BARS = 13;

export interface Signal { name: string; value: number; text: string }

/**
 * The AI's read of the market, -1 (sell) to +1 (buy), from the app's own
 * signals: chart and candle patterns on the chart's latest candles, and the
 * trend and RSI of the prices it watched during the game.
 */
export function signals(mem: AiMemory, patterns: PatternHit[], candles: number): Signal[] {
  const out: Signal[] = [];
  const closes = mem.bars.map((b) => b.c);
  if (closes.length >= TREND_BARS) {
    const f = ema(closes, 5), s = ema(closes, TREND_BARS);
    const n = closes.length - 1;
    const gap = (f[n] - s[n]) / s[n];
    // a 0.03% gap between the averages is a strong trend on 5 s bars
    const v = Math.max(-1, Math.min(1, gap / 0.0003));
    out.push({ name: 'trend', value: v, text: v > 0.2 ? 'price trending up' : v < -0.2 ? 'price trending down' : 'no clear trend' });
  }
  // RSI is read as a range signal: in a strong trend it stays stretched and says little
  const trend = out[0]?.value ?? 0;
  if (closes.length >= 15 && Math.abs(trend) < 0.5) {
    const r = rsi(closes, 14);
    const x = r[r.length - 1];
    if (x >= 75) out.push({ name: 'rsi', value: -Math.min(1, (x - 70) / 20), text: `RSI ${x.toFixed(0)}, overbought` });
    else if (x <= 25) out.push({ name: 'rsi', value: Math.min(1, (30 - x) / 20), text: `RSI ${x.toFixed(0)}, oversold` });
  }
  // patterns ending on the chart's last few candles; older ones have played out
  const recent = patterns.filter((p) => p.bias !== 0 && p.status !== 'failed' && p.end >= candles - 4);
  if (recent.length) {
    let sum = 0;
    let best: PatternHit | null = null;
    for (const p of recent) {
      const w = (p.family === 'chart' ? 1 : 0.6) * (p.status === 'confirmed' ? 1 : 0.5) * Math.max(0.3, p.score);
      sum += p.bias * w;
      if (!best || w > (best.family === 'chart' ? 1 : 0.6) * (best.status === 'confirmed' ? 1 : 0.5) * Math.max(0.3, best.score)) best = p;
    }
    const v = Math.max(-1, Math.min(1, sum));
    if (Math.abs(v) > 0.05) out.push({ name: 'patterns', value: v, text: `${best!.label} ${best!.status}` });
  }
  return out;
}

const WEIGHTS: Record<string, number> = { trend: 0.45, patterns: 0.4, rsi: 0.35 };
export const scoreOf = (sig: Signal[]) => Math.max(-1, Math.min(1, sig.reduce((s, x) => s + x.value * (WEIGHTS[x.name] ?? 0), 0)));

export interface AiMove { side: 'buy' | 'sell'; amount: number; reason: string }

/**
 * What the AI does now: null to hold. It looks every 10 s, waits 30 s after a
 * trade, cuts a loss of 0.6%, protects a gain once price falls 0.4% from its
 * best, and otherwise sizes its holding by how strongly the signals agree.
 */
export function decide(mem: AiMemory, w: Wallet, bid: number, ask: number, sig: Signal[], t: number): { mem: AiMemory; move: AiMove | null } {
  if (!(bid > 0 && ask > 0) || t - mem.lastCheck < AI_CHECK_MS) return { mem, move: null };
  const score = scoreOf(sig);
  const top = sig.slice().sort((a, b) => Math.abs(b.value * (WEIGHTS[b.name] ?? 0)) - Math.abs(a.value * (WEIGHTS[a.name] ?? 0)));
  const warming = mem.bars.length < TREND_BARS ? `still watching (${mem.bars.length * BAR_MS / 1000} s of prices, needs about ${TREND_BARS * BAR_MS / 1000} s for a trend)` : 'signals mixed';
  const why = top.filter((s) => Math.abs(s.value) > 0.15).map((s) => s.text).slice(0, 2).join(', ') || warming;
  const m: AiMemory = { ...mem, lastCheck: t, score, view: `${score > 0.25 ? 'Bullish' : score < -0.25 ? 'Bearish' : 'Neutral'}: ${why}` };
  const held = w.qty * bid;
  const total = w.cash + held;
  const frac = total > 0 ? held / total : 0;
  const mid = (bid + ask) / 2;

  // exits come first and ignore the cooldown
  if (w.qty > 0 && Number.isFinite(mem.entry)) {
    if (mid <= mem.entry * (1 - AI_STOP)) return { mem: { ...m, lastTrade: t, entry: NaN, peak: NaN }, move: { side: 'sell', amount: w.qty, reason: `Stop: down ${(AI_STOP * 100).toFixed(1)}% from its entry` } };
    if (mem.peak >= mem.entry * (1 + AI_TRAIL) && mid <= mem.peak * (1 - AI_TRAIL) && score < 0.25) {
      return { mem: { ...m, lastTrade: t }, move: { side: 'sell', amount: w.qty / 2, reason: `Took half off: ${(AI_TRAIL * 100).toFixed(1)}% below its best since buying` } };
    }
  }
  if (t - mem.lastTrade < AI_COOLDOWN_MS) return { mem: m, move: null };

  let target = frac;
  if (score >= 0.25) target = Math.min(1, 0.4 + score * 0.6);
  else if (score <= -0.5) target = 0;
  else if (score <= -0.25) target = frac / 2;
  const diff = target - frac;
  if (diff >= 0.15) {
    const usd = Math.min(w.cash, diff * total);
    if (usd < MIN_ORDER) return { mem: m, move: null };
    const entry = Number.isFinite(mem.entry) && w.qty > 0 ? (mem.entry * held + ask * usd) / (held + usd) : ask;
    return { mem: { ...m, lastTrade: t, entry, peak: Math.max(entry, Number.isFinite(mem.peak) ? mem.peak : 0) }, move: { side: 'buy', amount: usd, reason: `Bought: ${why}` } };
  }
  if (diff <= -0.15 && w.qty > 0) {
    const qty = target <= 0.01 ? w.qty : Math.min(w.qty, (-diff * total) / bid);
    const out = qty >= w.qty - 1e-12;
    return { mem: { ...m, lastTrade: t, ...(out ? { entry: NaN, peak: NaN } : {}) }, move: { side: 'sell', amount: qty, reason: `Sold: ${why}` } };
  }
  return { mem: m, move: null };
}

/** One step of the game clock: watch the price, let the AI act, sample the curve, end on time. */
export function tick(g: Game, t: number, bid: number, ask: number, patterns: PatternHit[], candles: number): Game {
  if (g.result) return g;
  if (t >= g.endsAt) return finish(g, bid > 0 ? bid : g.curve[g.curve.length - 1]?.price ?? NaN, Math.min(t, g.endsAt));
  if (!(bid > 0 && ask > 0)) return g;
  let n: Game = { ...g, mem: observe(g.mem, t, (bid + ask) / 2) };
  const d = decide(n.mem, n.ai, bid, ask, signals(n.mem, patterns, candles), t);
  n = { ...n, mem: d.mem };
  if (d.move) n = trade(n, 'ai', d.move.side, d.move.amount, bid, ask, t, d.move.reason) ?? n;
  return sample(n, t, bid);
}

// ---------------------------------------------------------------- saving

export const GAME_KEY = 'depthline.game.v1';
const MAX_RESULTS = 30;
export interface Saved { game: Game | null; results: Result[]; minutes: number }

export function parseSaved(raw: string | null): Saved {
  const empty: Saved = { game: null, results: [], minutes: DEFAULT_MINUTES };
  try {
    const p = raw ? JSON.parse(raw) : null;
    if (!p || typeof p !== 'object') return empty;
    const g = p.game;
    const okWallet = (w: any) => w && Number.isFinite(w.cash) && Number.isFinite(w.qty);
    const game = g && typeof g.symbol === 'string' && Number.isFinite(g.endsAt) && okWallet(g.you) && okWallet(g.ai) && Array.isArray(g.trades) && Array.isArray(g.curve) && g.mem && Array.isArray(g.mem.bars)
      ? { ...g, mem: { ...g.mem, entry: g.mem.entry ?? NaN, peak: g.mem.peak ?? NaN } } as Game : null;
    const results = Array.isArray(p.results) ? p.results.filter((r: any) => r && Number.isFinite(r.you) && Number.isFinite(r.ai)).slice(-MAX_RESULTS) : [];
    return { game, results, minutes: DURATIONS.includes(p.minutes) ? p.minutes : DEFAULT_MINUTES };
  } catch {
    return empty;
  }
}

/** JSON without NaN turning into null surprises: entry/peak are restored as NaN on load. */
export const serialize = (s: Saved) => JSON.stringify({ ...s, results: s.results.slice(-MAX_RESULTS) });

export function record(results: Result[]): { wins: number; losses: number; ties: number } {
  let wins = 0, losses = 0, ties = 0;
  for (const r of results) r.winner === 'you' ? wins++ : r.winner === 'ai' ? losses++ : ties++;
  return { wins, losses, ties };
}
