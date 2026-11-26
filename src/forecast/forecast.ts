import type { Candle } from '../patterns/candle';
import type { PatternHit } from '../patterns/types';
import { atr, bollinger, ema, macd, rsi } from '../patterns/indicators';

/**
 * Research forecast: where price may close `horizon` candles from now.
 *
 * Not a prediction service and not advice. It is a small, transparent model
 * checked against the same history it runs on:
 *
 *  1. four indicator readings (trend, momentum, RSI, Bollinger position) are
 *     each turned into a score from -1 (bearish) to +1 (bullish) and averaged;
 *  2. every past candle gets the same score, and we look at what price did
 *     `horizon` candles later. The chance of closing higher is the share of
 *     past candles with a similar score that did (smoothed towards 50%);
 *  3. the top and bottom are the 10th and 90th percentile of those past moves,
 *     scaled by today's volatility, so in this history 80% of closes landed
 *     inside the range by construction; `coverage` reports how many actually did
 *     out of sample (the second half, using quantiles from the first half);
 *  4. live chart patterns and liquidation clusters nudge the result a little.
 *     They have no history to test against here, so their weight is capped and
 *     shown separately.
 */

export interface Factor {
  key: 'trend' | 'momentum' | 'rsi' | 'bollinger' | 'patterns' | 'liquidity';
  label: string;
  /** -1 bearish .. +1 bullish */
  score: number;
  /** what the reading is, in words */
  note: string;
  /** false: not part of the backtest (live only) */
  tested: boolean;
}

export type Verdict = 'buy' | 'sell' | 'wait';

export interface Flag { id: string; label: string; tone: 'bull' | 'bear' | 'warn' | 'info' }

export interface Forecast {
  horizon: number;
  /** close of the last closed candle */
  last: number;
  /** open time of that candle */
  t: number;
  /** ~90th / 10th percentile close at the horizon */
  top: number;
  bottom: number;
  /** median expected close */
  mid: number;
  /** chance (0..1) the close at the horizon is above `last` */
  pUp: number;
  /** pUp before the liquidation nudge, so it can be applied again without stacking */
  pBase: number;
  /** combined indicator score, -1..1 */
  score: number;
  verdict: Verdict;
  /** upside to `top` divided by downside to `bottom` */
  reward: number;
  factors: Factor[];
  flags: Flag[];
  /** readings behind the warning flags (kept so the flags can be rebuilt after a postMessage) */
  extra: Extra;
  backtest: {
    /** past candles the probability was learned from */
    samples: number;
    /** share of all past candles that closed higher after `horizon` */
    baseUp: number;
    /** out of sample: share of closes that landed inside the 80% range */
    coverage: number;
    /** out of sample: share of candles where the learned chance called the direction right (above 50% = up) */
    hitRate: number;
    /** out of sample: the same for always calling the first half's majority direction; the model has an edge only if it beats this */
    naiveRate: number;
    hitSamples: number;
  };
}

export interface Extra { squeeze?: boolean; rsi?: number; pb?: number }

export const HORIZONS = [10, 20, 50] as const;
export const DEFAULT_HORIZON = 20;
/** below this many usable past candles the forecast is not given */
export const MIN_SAMPLES = 120;

const WARMUP = 60;
const VOL_N = 50;
const W = { trend: 0.35, momentum: 0.25, rsi: 0.2, bollinger: 0.2 };
/** score bucket edges */
const EDGES = [-0.5, -0.2, 0.2, 0.5];
/** prior strength (pseudo samples at 50%) when learning each bucket's up-rate */
const PRIOR = 20;
/** most the live-only factors can move the probability */
const LIVE_CAP = 0.08;

const clip = (x: number, a = -1, b = 1) => (x < a ? a : x > b ? b : x);
const bucketOf = (s: number) => { let k = 0; while (k < EDGES.length && s > EDGES[k]) k++; return k; };

interface Readings { trend: Float64Array; momentum: Float64Array; rsi: Float64Array; bb: Float64Array; score: Float64Array; vol: Float64Array; rsiRaw: Float64Array; pb: Float64Array; width: Float64Array }

/** Per-candle component scores and rolling volatility of log returns. */
export function readings(c: ArrayLike<number>, h: ArrayLike<number>, l: ArrayLike<number>): Readings {
  const n = c.length;
  const e20 = ema(c, 20), e50 = ema(c, 50), a = atr(h, l, c, 14);
  const [, , hist] = macd(c, 12, 26, 9);
  const r = rsi(c, 14);
  const [mid, up, lo] = bollinger(c, 20, 2);
  const out: Readings = {
    trend: new Float64Array(n), momentum: new Float64Array(n), rsi: new Float64Array(n), bb: new Float64Array(n),
    score: new Float64Array(n), vol: new Float64Array(n), rsiRaw: r, pb: new Float64Array(n), width: new Float64Array(n),
  };
  // rolling std of log returns
  let s = 0, s2 = 0;
  const ret = new Float64Array(n);
  for (let i = 1; i < n; i++) ret[i] = c[i] > 0 && c[i - 1] > 0 ? Math.log(c[i] / c[i - 1]) : 0;
  for (let i = 0; i < n; i++) {
    s += ret[i]; s2 += ret[i] * ret[i];
    if (i >= VOL_N) { s -= ret[i - VOL_N]; s2 -= ret[i - VOL_N] * ret[i - VOL_N]; }
    const m = Math.min(i + 1, VOL_N);
    out.vol[i] = Math.sqrt(Math.max(0, s2 / m - (s / m) ** 2));
    const ai = a[i] > 0 ? a[i] : NaN;
    out.trend[i] = Math.tanh((e20[i] - e50[i]) / ai / 2) || 0;
    out.momentum[i] = Math.tanh((hist[i] / ai) * 2) || 0;
    const ri = r[i];
    out.rsi[i] = !Number.isFinite(ri) ? 0 : ri > 70 ? -clip((ri - 70) / 20) : ri < 30 ? clip((30 - ri) / 20) : (ri - 50) / 40;
    const band = up[i] - lo[i];
    const pb = band > 0 ? (c[i] - lo[i]) / band : 0.5;
    out.pb[i] = pb;
    out.width[i] = mid[i] > 0 ? band / mid[i] : NaN;
    // outside the bands: lean back in; inside: a mild lean with the position
    out.bb[i] = !Number.isFinite(pb) ? 0 : pb > 1 ? -clip((pb - 1) * 3) : pb < 0 ? clip(-pb * 3) : (pb - 0.5) * 0.4;
    out.score[i] = W.trend * out.trend[i] + W.momentum * out.momentum[i] + W.rsi * out.rsi[i] + W.bollinger * out.bb[i];
  }
  return out;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const x = (sorted.length - 1) * q, i = Math.floor(x), f = x - i;
  return i + 1 < sorted.length ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
}

interface Learned { up: number[]; n: number[]; z: number[]; zMid: number; baseUp: number; samples: number }

/** Up-rate per score bucket and the spread of volatility-normalised moves, over candles [from, to). */
function learn(c: ArrayLike<number>, rd: Readings, horizon: number, from: number, to: number): Learned {
  const ups = [0, 0, 0, 0, 0], ns = [0, 0, 0, 0, 0];
  const z: number[] = [];
  let upAll = 0;
  for (let i = from; i < to; i++) {
    const j = i + horizon;
    const sd = rd.vol[i] * Math.sqrt(horizon);
    if (!(sd > 0) || !(c[i] > 0) || !(c[j] > 0)) continue;
    const r = Math.log(c[j] / c[i]);
    const b = bucketOf(rd.score[i]);
    ns[b]++;
    if (r > 0) { ups[b]++; upAll++; }
    z.push(r / sd);
  }
  z.sort((a, b) => a - b);
  const samples = z.length;
  const baseUp = samples ? upAll / samples : 0.5;
  // shrink each bucket towards the overall up-rate
  const up = ups.map((u, k) => (u + PRIOR * baseUp) / (ns[k] + PRIOR));
  return { up, n: ns, z: [quantile(z, 0.1), quantile(z, 0.9)], zMid: quantile(z, 0.5), baseUp, samples };
}

/** Out of sample check: learn on the first half, score the second. */
function validate(c: ArrayLike<number>, rd: Readings, horizon: number, end: number): { coverage: number; hitRate: number; naiveRate: number; hitSamples: number } {
  const split = Math.floor((WARMUP + end) / 2);
  const L = learn(c, rd, horizon, WARMUP, split - horizon);
  let inside = 0, total = 0, hits = 0, naive = 0, called = 0;
  const majority = L.baseUp >= 0.5 ? 1 : -1;
  for (let i = split; i < end; i++) {
    const j = i + horizon;
    const sd = rd.vol[i] * Math.sqrt(horizon);
    if (!(sd > 0) || !(c[i] > 0) || !(c[j] > 0)) continue;
    const r = Math.log(c[j] / c[i]);
    total++;
    if (r >= L.z[0] * sd && r <= L.z[1] * sd) inside++;
    if (r === 0) continue;
    const call = L.up[bucketOf(rd.score[i])] >= 0.5 ? 1 : -1;
    called++;
    if (call === Math.sign(r)) hits++;
    if (majority === Math.sign(r)) naive++;
  }
  return { coverage: total ? inside / total : NaN, hitRate: called ? hits / called : NaN, naiveRate: called ? naive / called : NaN, hitSamples: called };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Live patterns: confirmed or forming chart patterns that ended recently, and candle signals on the last 3 candles. */
export function patternLean(patterns: PatternHit[], lastIdx: number): { score: number; note: string } {
  let s = 0, w = 0;
  const names: string[] = [];
  for (const p of patterns) {
    const age = lastIdx - p.end;
    if (p.family === 'chart') {
      if (age > 30 || p.status === 'failed') continue;
      const k = (p.status === 'confirmed' ? 1 : 0.5) * p.score;
      s += p.bias * k; w += k;
      if (p.bias) names.push(p.label);
    } else if (age <= 2 && p.bias) {
      s += p.bias * 0.3; w += 0.3;
      names.push(p.label);
    }
  }
  if (!w) return { score: 0, note: 'no recent patterns' };
  const uniq = [...new Set(names)].slice(0, 3);
  return { score: clip(s / Math.max(1, w)), note: uniq.join(', ') || 'neutral patterns' };
}

export interface ForecastOptions { horizon?: number; patterns?: PatternHit[] }

/** The forecast from closed candles only; null until there is enough history. */
export function forecast(candles: Candle[], o: ForecastOptions = {}): Forecast | null {
  const horizon = o.horizon ?? DEFAULT_HORIZON;
  let n = candles.length;
  if (n && !candles[n - 1].closed) n--;
  if (n - WARMUP - horizon < MIN_SAMPLES) return null;
  const c = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n);
  for (let i = 0; i < n; i++) { const k = candles[i]; c[i] = k.c; h[i] = k.h; l[i] = k.l; }
  const rd = readings(c, h, l);
  const end = n - horizon; // last candle whose outcome is known (exclusive)
  const L = learn(c, rd, horizon, WARMUP, end);
  if (L.samples < MIN_SAMPLES) return null;
  const v = validate(c, rd, horizon, end);
  const i = n - 1;
  const last = c[i];
  const score = rd.score[i];
  const b = bucketOf(score);

  const factors: Factor[] = [
    { key: 'trend', label: 'Trend', score: rd.trend[i], tested: true, note: rd.trend[i] > 0.15 ? 'EMA 20 above EMA 50' : rd.trend[i] < -0.15 ? 'EMA 20 below EMA 50' : 'EMAs flat' },
    { key: 'momentum', label: 'Momentum', score: rd.momentum[i], tested: true, note: rd.momentum[i] > 0.15 ? 'MACD histogram rising' : rd.momentum[i] < -0.15 ? 'MACD histogram falling' : 'MACD near its signal' },
    { key: 'rsi', label: 'RSI 14', score: rd.rsi[i], tested: true, note: `${rd.rsiRaw[i].toFixed(0)}${rd.rsiRaw[i] > 70 ? ', overbought' : rd.rsiRaw[i] < 30 ? ', oversold' : ''}` },
    { key: 'bollinger', label: 'Bollinger 20, 2', score: rd.bb[i], tested: true, note: rd.pb[i] > 1 ? 'closed above the upper band' : rd.pb[i] < 0 ? 'closed below the lower band' : `at ${pct(clip(rd.pb[i], 0, 1))} of the band` },
  ];

  let pUp = L.up[b];
  const pl = patternLean(o.patterns ?? [], i);
  factors.push({ key: 'patterns', label: 'Patterns', score: pl.score, note: pl.note, tested: false });
  pUp = clip(pUp + pl.score * LIVE_CAP * 0.5, 0.02, 0.98);

  const sd = rd.vol[i] * Math.sqrt(horizon);
  // centre: the learned median move, shifted by how far this bucket's up-rate is from the base rate
  const tilt = (L.up[b] - L.baseUp) * 2 * sd;
  const lo = Math.log(last) + L.z[0] * sd + tilt, hi = Math.log(last) + L.z[1] * sd + tilt;
  const f: Forecast = {
    horizon, last, t: candles[i].t,
    top: Math.exp(hi), bottom: Math.exp(lo), mid: Math.exp(Math.log(last) + L.zMid * sd + tilt),
    pUp, pBase: pUp, score, verdict: 'wait', reward: NaN, factors, flags: [], extra: {},
    backtest: { samples: L.samples, baseUp: L.baseUp, coverage: v.coverage, hitRate: v.hitRate, naiveRate: v.naiveRate, hitSamples: v.hitSamples },
  };
  // a squeeze: bands narrower than 80% of the last 120 candles
  let narrower = 0, seen = 0;
  for (let k = Math.max(0, i - 120); k < i; k++) if (Number.isFinite(rd.width[k])) { seen++; if (rd.width[k] > rd.width[i]) narrower++; }
  const squeeze = seen > 60 && narrower / seen > 0.8;
  f.extra = { squeeze, rsi: rd.rsiRaw[i], pb: rd.pb[i] };
  return finish(f);
}


/** Out of sample the model must beat always calling the majority direction by 2 points, over at least 100 candles. */
export function hasNoEdge(f: Forecast): boolean {
  const b = f.backtest;
  return !(b.hitRate - b.naiveRate >= 0.02) || b.hitSamples < 100;
}

/** Verdict, reward/risk and flags from the current numbers. Run again after `withLiquidity`. */
function finish(f: Forecast): Forecast {
  const x = f.extra;
  const up = f.top - f.last, down = f.last - f.bottom;
  f.reward = down > 0 ? up / down : Infinity;
  const weak = hasNoEdge(f);
  // no lean unless the model beat the naive call out of sample
  f.verdict = weak ? 'wait' : f.pUp >= 0.58 && f.reward >= 1 ? 'buy' : f.pUp <= 0.42 && f.reward <= 1 ? 'sell' : 'wait';
  const flags: Flag[] = [];
  if (f.verdict === 'buy') flags.push({ id: 'buy', label: f.pUp >= 0.65 ? 'Strong buy lean' : 'Buy lean', tone: 'bull' });
  else if (f.verdict === 'sell') flags.push({ id: 'sell', label: f.pUp <= 0.35 ? 'Strong sell lean' : 'Sell lean', tone: 'bear' });
  else flags.push({ id: 'wait', label: weak ? 'No tested edge' : 'No clear edge', tone: 'info' });
  if ((x.rsi ?? 50) > 70) flags.push({ id: 'overbought', label: 'Overbought', tone: 'warn' });
  if ((x.rsi ?? 50) < 30) flags.push({ id: 'oversold', label: 'Oversold', tone: 'warn' });
  if ((x.pb ?? 0.5) > 1 || (x.pb ?? 0.5) < 0) flags.push({ id: 'outside', label: 'Outside Bollinger', tone: 'warn' });
  if (x.squeeze) flags.push({ id: 'squeeze', label: 'Volatility squeeze', tone: 'warn' });
  const liq = f.factors.find((k) => k.key === 'liquidity');
  if (liq && Math.abs(liq.score) > 0.2) flags.push({ id: 'liq', label: liq.score > 0 ? 'Short liquidations above' : 'Long liquidations below', tone: liq.score > 0 ? 'bull' : 'bear' });
  f.flags = flags;
  return f;
}

export interface Cluster { price: number; notional: number }

/**
 * Liquidation clusters pull price: a large cluster inside the range is a level
 * price often runs to (stops and liquidations fill there). The closer and the
 * larger compared with the other side, the stronger. `scale` converts cluster
 * prices (USDT perpetual) to the chart's price.
 */
export function withLiquidity(f: Forecast, long?: Cluster, short?: Cluster, scale = 1): Forecast {
  const span = Math.log(f.top / f.bottom);
  const pull = (c: Cluster | undefined) => {
    if (!c || !(c.notional > 0) || !(c.price > 0) || !(span > 0)) return 0;
    const d = Math.abs(Math.log((c.price * scale) / f.last)) / span;
    return d > 1 ? 0 : c.notional * (1 - d);
  };
  const a = pull(short), b = pull(long);
  const score = a + b > 0 ? clip((a - b) / (a + b)) : 0;
  const near = (c: Cluster | undefined) => (c ? (c.price * scale).toPrecision(6) : '');
  const note = !(a + b) ? 'no large cluster inside the range'
    : score > 0.2 ? `shorts at ${near(short)} above` : score < -0.2 ? `longs at ${near(long)} below` : 'clusters on both sides';
  const g: Forecast = { ...f, factors: f.factors.filter((k) => k.key !== 'liquidity'), flags: [] };
  g.factors.push({ key: 'liquidity', label: 'Liquidations', score, note, tested: false });
  g.pUp = clip(f.pBase + score * LIVE_CAP * 0.5, 0.02, 0.98);
  return finish(g);
}
