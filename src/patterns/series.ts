import type { Candle } from './candle';
import { atr, bollinger, ema, macd, rsi, sma } from './indicators';
import type { LiqCtx } from './liq';

/** Struct-of-arrays view of candles plus the indicators every detector uses. */
export interface Series {
  n: number;
  t: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; v: Float64Array;
  atr: Float64Array;
  ema20: Float64Array;
  ema50: Float64Array;
  /** mean absolute body over the previous 14 bars */
  avgBody: Float64Array;
  /** mean range over the previous 10 bars */
  avgRange: Float64Array;
  /** index of the last CLOSED candle */
  lastClosed: number;
  /** inputs of the indicator signals (src/patterns/signals.ts): RSI 14, Bollinger 20 2, MACD 12 26 9, volume SMA 20 */
  rsi14: Float64Array;
  bbMid: Float64Array; bbUp: Float64Array; bbLo: Float64Array;
  macdLine: Float64Array; macdHist: Float64Array;
  volAvg: Float64Array;
  /** estimated liquidations per candle, when the liquidation map is loaded */
  liq: LiqCtx | null;
}

export function toSeries(cs: Candle[]): Series {
  const n = cs.length;
  const s: Series = {
    n,
    t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n),
    atr: new Float64Array(n), ema20: new Float64Array(n), ema50: new Float64Array(n), avgBody: new Float64Array(n), avgRange: new Float64Array(n),
    lastClosed: n - 1,
    rsi14: new Float64Array(0), bbMid: new Float64Array(0), bbUp: new Float64Array(0), bbLo: new Float64Array(0),
    macdLine: new Float64Array(0), macdHist: new Float64Array(0), volAvg: new Float64Array(0), liq: null,
  };
  for (let i = 0; i < n; i++) {
    const k = cs[i];
    s.t[i] = k.t; s.o[i] = k.o; s.h[i] = k.h; s.l[i] = k.l; s.c[i] = k.c; s.v[i] = k.v;
  }
  if (n && !cs[n - 1].closed) s.lastClosed = n - 2;
  atr(s.h, s.l, s.c, 14, s.atr);
  ema(s.c, 20, s.ema20);
  ema(s.c, 50, s.ema50);
  s.rsi14 = rsi(s.c, 14);
  [s.bbMid, s.bbUp, s.bbLo] = bollinger(s.c, 20, 2);
  const m = macd(s.c, 12, 26, 9);
  s.macdLine = m[0]; s.macdHist = m[2];
  s.volAvg = sma(s.v, 20);
  let bodySum = 0, rangeSum = 0;
  for (let i = 0; i < n; i++) {
    s.avgBody[i] = i ? bodySum / Math.min(i, 14) : Math.abs(s.c[0] - s.o[0]);
    s.avgRange[i] = i ? rangeSum / Math.min(i, 10) : s.h[0] - s.l[0];
    bodySum += Math.abs(s.c[i] - s.o[i]);
    rangeSum += s.h[i] - s.l[i];
    if (i >= 14) bodySum -= Math.abs(s.c[i - 14] - s.o[i - 14]);
    if (i >= 10) rangeSum -= s.h[i - 10] - s.l[i - 10];
  }
  return s;
}

/**
 * Price tolerance for "roughly the same price" (the Fidelity guide gives no
 * number): the larger of 0.75 ATR and 0.2% of price. Tunable.
 */
export const tolerance = (s: Series, i: number): number => Math.max(0.75 * s.atr[i], 0.002 * s.c[i]);

/** Direction of the move into bar i over `look` bars, in ATR units (+ up, - down). */
export function priorTrend(s: Series, i: number, look = 6): number {
  const j = Math.max(0, i - look);
  const a = s.atr[i] || 1e-12;
  return (s.c[i] - s.c[j]) / a;
}
