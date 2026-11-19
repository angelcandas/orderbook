import type { PatternHit, Bias } from './types';
import { priorTrend, type Series } from './series';

/**
 * Candlestick and volatility patterns (Fidelity guide; forex.com doji and
 * morning star pages). Shape thresholds are ours, since neither source gives
 * numbers:
 *   doji: body <= 10% of range
 *   long body: >= 1.0x the mean body of the previous 14 bars; small: <= 0.35x
 *   hammer family: one shadow >= 2x body, the other <= 10% of range
 *   trend context: close moved >= 1 ATR over the previous 6 bars
 * Crypto trades around the clock and rarely gaps, so "gap" conditions in star
 * patterns are relaxed to "the small body sits beyond the first body's close".
 */
export function candlePatterns(s: Series, out: PatternHit[], from = 0): void {
  const end = s.lastClosed;
  for (let i = Math.max(from, 2); i <= end; i++) {
    const o = s.o[i], c = s.c[i], h = s.h[i], l = s.l[i];
    const range = h - l;
    if (!(range > 0)) continue;
    const body = Math.abs(c - o);
    const upper = h - Math.max(o, c);
    const lower = Math.min(o, c) - l;
    const avgB = s.avgBody[i] || body;
    const trend = priorTrend(s, i - 1);
    const down = trend <= -1, up = trend >= 1;
    const add = (kind: string, label: string, bias: Bias, start: number, note?: string) =>
      out.push({ id: `${kind}:${s.t[i]}`, kind, label, bias, family: 'candle', start, end: i, pivots: [], lines: [], status: 'confirmed', score: 1, note });

    // --- one bar ---
    if (body <= 0.1 * range) {
      if (upper <= 0.1 * range && lower >= 0.6 * range) add('dragonfly-doji', 'Dragonfly doji', down ? 1 : 0, i);
      else if (lower <= 0.1 * range && upper >= 0.6 * range) add('gravestone-doji', 'Gravestone doji', up ? -1 : 0, i);
      else if (upper >= 0.3 * range && lower >= 0.3 * range && range >= 1.5 * s.avgRange[i]) add('long-legged-doji', 'Long-legged doji', 0, i);
      else add('doji', 'Doji', 0, i, 'indecision; needs trend and support or resistance context');
    } else if (lower >= 2 * body && upper <= 0.1 * range) {
      if (down) add('hammer', 'Hammer', 1, i);
      else if (up) add('hanging-man', 'Hanging man', -1, i);
    } else if (upper >= 2 * body && lower <= 0.1 * range) {
      if (down) add('inverted-hammer', 'Inverted hammer', 1, i);
      else if (up) add('shooting-star', 'Shooting star', -1, i);
    }

    // --- two bars ---
    const po = s.o[i - 1], pc = s.c[i - 1];
    const pBody = Math.abs(pc - po);
    const pBull = pc > po, bull = c > o;
    if (pBody > 0 && body > 0) {
      if (!pBull && bull && o <= pc && c >= po && body > pBody && down) add('bullish-engulfing', 'Bullish engulfing', 1, i - 1);
      else if (pBull && !bull && o >= pc && c <= po && body > pBody && up) add('bearish-engulfing', 'Bearish engulfing', -1, i - 1);
      else if (pBody >= avgB && body <= 0.5 * pBody && pBull !== bull && Math.max(o, c) <= Math.max(po, pc) && Math.min(o, c) >= Math.min(po, pc))
        add(pBull ? 'bearish-harami' : 'bullish-harami', pBull ? 'Bearish harami' : 'Bullish harami', down && !pBull ? 1 : up && pBull ? -1 : 0, i - 1, 'breakout direction is close to random per the guide');
      else if (!pBull && bull && pBody >= avgB && o <= pc && c > (po + pc) / 2 && c < po && down) add('piercing-line', 'Piercing line', 1, i - 1);
      else if (pBull && !bull && pBody >= avgB && o >= pc && c < (po + pc) / 2 && c > po && up) add('dark-cloud', 'Dark cloud cover', -1, i - 1);
    }
    // two-bar reversal (pipe): two wide bars after a trend, closing at opposite ends
    const pr = s.h[i - 1] - s.l[i - 1];
    if (pr > 1.5 * s.avgRange[i - 1] && range > 1.5 * s.avgRange[i - 1]) {
      if (down && s.c[i - 1] - s.l[i - 1] <= 0.25 * pr && c >= l + range / 2) add('pipe-bottom', 'Two-bar reversal (pipe bottom)', 1, i - 1);
      else if (up && s.h[i - 1] - s.c[i - 1] <= 0.25 * pr && c <= l + range / 2) add('pipe-top', 'Two-bar reversal (pipe top)', -1, i - 1);
    }

    // --- three bars: morning / evening star ---
    const ao = s.o[i - 2], ac = s.c[i - 2];
    const aBody = Math.abs(ac - ao);
    const midBody = pBody;
    if (aBody >= avgB && midBody <= 0.35 * aBody && body >= 0.6 * aBody) {
      const dojiMid = midBody <= 0.1 * pr;
      if (ac < ao && Math.max(po, pc) <= ac + 0.1 * aBody && bull && c > (ao + ac) / 2 && priorTrend(s, i - 2) <= -1)
        out.push({ id: `morning-star:${s.t[i]}`, kind: 'morning-star', label: dojiMid ? 'Morning doji star' : 'Morning star', bias: 1, family: 'candle', start: i - 2, end: i, pivots: [], lines: [], status: 'confirmed', score: 1, stop: Math.min(s.l[i - 2], s.l[i - 1], l) });
      else if (ac > ao && Math.min(po, pc) >= ac - 0.1 * aBody && !bull && c < (ao + ac) / 2 && priorTrend(s, i - 2) >= 1)
        out.push({ id: `evening-star:${s.t[i]}`, kind: 'evening-star', label: dojiMid ? 'Evening doji star' : 'Evening star', bias: -1, family: 'candle', start: i - 2, end: i, pivots: [], lines: [], status: 'confirmed', score: 1, stop: Math.max(s.h[i - 2], s.h[i - 1], h) });
    }
  }
}

/** Volatility patterns: inside bar, NR4 / NR7, and gaps. */
export function volatilityPatterns(s: Series, out: PatternHit[], from = 0): void {
  const end = s.lastClosed;
  for (let i = Math.max(from, 7); i <= end; i++) {
    const range = s.h[i] - s.l[i];
    const add = (kind: string, label: string, bias: Bias, start: number, note?: string) =>
      out.push({ id: `${kind}:${s.t[i]}`, kind, label, bias, family: 'volatility', start, end: i, pivots: [], lines: [], status: 'forming', score: 1, note });
    let nr = 0;
    for (let k = 1; k <= 6; k++) { if (s.h[i - k] - s.l[i - k] > range) nr = k; else break; }
    if (nr >= 6) add('nr7', 'NR7', 0, i - 6, 'trade the break of this bar\'s high or low');
    else if (nr >= 3) add('nr4', 'NR4', 0, i - 3, 'trade the break of this bar\'s high or low');
    else if (s.h[i] <= s.h[i - 1] && s.l[i] >= s.l[i - 1]) add('inside-bar', 'Inside bar', 0, i - 1, 'next open above / below this close signals direction');
    const gap = s.o[i] - s.c[i - 1];
    if (Math.abs(gap) > 0.5 * s.atr[i - 1]) add(gap > 0 ? 'gap-up' : 'gap-down', gap > 0 ? 'Gap up' : 'Gap down', gap > 0 ? 1 : -1, i - 1);
  }
}
