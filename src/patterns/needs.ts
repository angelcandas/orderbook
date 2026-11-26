import type { IndConfig, IndKind } from '../indicators/spec';
import type { PatternHit } from './types';

/**
 * The indicators a pattern or signal is computed from, so the chart can show
 * exactly those while it is being explained (and nothing else).
 *
 * Chart patterns are found on ATR-sized swings (zigzag pivots) with ATR
 * tolerances; candle patterns read the trend into the bar in ATR units; NR4 /
 * NR7 and inside bars need nothing but the bars. Indicator signals list their
 * own inputs, with the parameters the detector uses.
 */
export interface Needs {
  indicators: { kind: IndKind; params: number[] }[];
  /** the liquidation bands must be visible */
  liq: boolean;
  /** one line for the explanation: what is shown and why */
  why: string;
}

const RSI = { kind: 'rsi' as const, params: [14] };
const BB = { kind: 'bb' as const, params: [20, 2] };
const MACD = { kind: 'macd' as const, params: [12, 26, 9] };
const ATR = { kind: 'atr' as const, params: [14] };
const VOL = { kind: 'volume' as const, params: [20] };
const EMA50 = { kind: 'ema' as const, params: [50] };

const BY_KIND: Record<string, Omit<Needs, 'liq'> & { liq?: boolean }> = {
  'rsi-bull-div': { indicators: [RSI], why: 'RSI 14 is compared at the two swing lows.' },
  'rsi-bear-div': { indicators: [RSI], why: 'RSI 14 is compared at the two swing highs.' },
  'rsi-hidden-bull-div': { indicators: [RSI, EMA50], why: 'RSI 14 at the two swing lows; EMA 50 confirms the uptrend.' },
  'rsi-hidden-bear-div': { indicators: [RSI, EMA50], why: 'RSI 14 at the two swing highs; EMA 50 confirms the downtrend.' },
  'rsi-failure-swing-bull': { indicators: [RSI], why: 'The swing is read on RSI 14 alone, with its 30 line.' },
  'rsi-failure-swing-bear': { indicators: [RSI], why: 'The swing is read on RSI 14 alone, with its 70 line.' },
  'bb-squeeze-up': { indicators: [BB], why: 'Bollinger Bands 20 / 2: their width finds the squeeze, the upper band the breakout.' },
  'bb-squeeze-down': { indicators: [BB], why: 'Bollinger Bands 20 / 2: their width finds the squeeze, the lower band the breakout.' },
  'bb-w-bottom': { indicators: [BB], why: 'Bollinger Bands 20 / 2: the first low outside the lower band, the retest inside, the close over the middle.' },
  'bb-m-top': { indicators: [BB], why: 'Bollinger Bands 20 / 2: the first high outside the upper band, the retest inside, the close under the middle.' },
  'bb-rsi-oversold': { indicators: [BB, RSI], why: 'Bollinger Bands 20 / 2 for the close outside and back in; RSI 14 under 30.' },
  'bb-rsi-overbought': { indicators: [BB, RSI], why: 'Bollinger Bands 20 / 2 for the close outside and back in; RSI 14 over 70.' },
  'macd-bull-div': { indicators: [MACD], why: 'The MACD line (12, 26, 9) is compared at the two swing lows.' },
  'macd-bear-div': { indicators: [MACD], why: 'The MACD line (12, 26, 9) is compared at the two swing highs.' },
  'selling-climax': { indicators: [VOL, ATR], why: 'Volume against its 20-bar average; ATR 14 measures the decline into it.' },
  'buying-climax': { indicators: [VOL, ATR], why: 'Volume against its 20-bar average; ATR 14 measures the rally into it.' },
  'long-flush': { indicators: [VOL], liq: true, why: 'The liquidation bands show the longs the bar wiped out; volume shows the forced selling.' },
  'short-squeeze': { indicators: [VOL], liq: true, why: 'The liquidation bands show the shorts the bar wiped out; volume shows the forced buying.' },
  'liq-sweep-low': { indicators: [], liq: true, why: 'The liquidation bands show the heavy long band the wick swept.' },
  'liq-sweep-high': { indicators: [], liq: true, why: 'The liquidation bands show the heavy short band the wick swept.' },
  'nr4': { indicators: [], why: 'Bar ranges only; no indicator is involved.' },
  'nr7': { indicators: [], why: 'Bar ranges only; no indicator is involved.' },
  'inside-bar': { indicators: [], why: 'Bar ranges only; no indicator is involved.' },
};

export function needsOf(p: PatternHit): Needs {
  const k = BY_KIND[p.kind];
  if (k) return { indicators: k.indicators, liq: !!k.liq, why: k.why };
  if (p.family === 'chart') return { indicators: [ATR], liq: false, why: 'ATR 14 sizes the swings and the "same price" tolerance; the pattern itself is drawn on the candles.' };
  if (p.kind.startsWith('gap')) return { indicators: [ATR], liq: false, why: 'ATR 14: the gap is larger than half of it.' };
  return { indicators: [ATR], liq: false, why: 'ATR 14 measures the trend into the bar that gives the shape its meaning.' };
}

/** The chart's indicator list while `p` is explained: only what it needs, as fresh entries. */
export function indicatorsFor(p: PatternHit): IndConfig[] {
  return needsOf(p).indicators.map((x, n) => ({ id: `explain-${x.kind}-${n}`, kind: x.kind, params: x.params.slice(), color: n, on: true }));
}
