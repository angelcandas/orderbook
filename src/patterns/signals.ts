import type { Bias, PatternHit, Pt } from './types';
import { priorTrend, tolerance, type Series } from './series';
import type { Pivot } from './pivots';

/**
 * Indicator signals: 20 setups that combine price with RSI, Bollinger Bands,
 * MACD, volume and the estimated liquidation map. Fixed inputs, so the
 * explanation can show exactly what was used: RSI 14, Bollinger 20 / 2,
 * MACD 12 / 26 / 9, volume SMA 20, ATR 14.
 *
 * Thresholds are ours (common textbook values where there is one: RSI 30 / 70,
 * Bollinger 2 standard deviations); the tests in test/signals.test.ts pin them.
 *
 *   divergence: two consecutive zigzag swing lows (highs) 5..80 bars apart,
 *     RSI / MACD disagreeing with price by at least 3 RSI points / 0.1 ATR
 *   failure swing: RSI beyond 30 (70), a bounce, a pullback that holds inside,
 *     then RSI clears the bounce high (low) within 30 bars
 *   squeeze: band width within 5% of its 120-bar low in the last 10 bars, then
 *     the first close outside a band
 *   W bottom / M top: first swing closes outside the band, the retest holds
 *     inside it, then a close beyond the middle band within 20 bars
 *   climax: volume >= 3x its 20-bar average on a bar >= 1.5x the average range
 *     after a 3 ATR move, closing in the half opposite the move
 *   flush / squeeze: estimated liquidations >= 3x their 50-bar mean on a bar
 *     >= 1.3x the average range that closes off its extreme
 *   sweep: a wick through the heaviest liquidation band within 8% (at least 2x
 *     the average band) that closes back on the near side
 */

const pt = (i: number, p: number): Pt => ({ i, p });
const ok = (x: number) => x === x; // not NaN

/** recent-fire guard: one hit per kind per few bars */
function adder(s: Series, out: PatternHit[], from: number) {
  const last = new Map<string, number>();
  return (kind: string, label: string, bias: Bias, start: number, end: number, extra: Partial<PatternHit> = {}, gap = 3) => {
    if (end < from) return;
    const prev = last.get(kind);
    if (prev !== undefined && end - prev <= gap) return;
    last.set(kind, end);
    out.push({ id: `${kind}:${s.t[end]}`, kind, label, bias, family: 'signal', start, end, pivots: [], lines: [], status: 'confirmed', score: 1, ...extra });
  };
}

export function signals(s: Series, pv: Pivot[], out: PatternHit[], from = 0): void {
  const add = adder(s, out, from);
  divergences(s, pv, add);
  const end = s.lastClosed;
  const r = s.rsi14;
  for (let i = Math.max(1, from); i <= end; i++) {
    const o = s.o[i], c = s.c[i], h = s.h[i], l = s.l[i];
    const range = h - l;
    if (!(range > 0)) continue;

    // --- RSI failure swings ---
    if (i >= 20 && ok(r[i]) && ok(r[i - 1])) failureSwing(s, i, add);

    // --- Bollinger ---
    const up = s.bbUp[i], lo = s.bbLo[i], mid = s.bbMid[i];
    if (ok(up) && i >= 140) {
      const w = (k: number) => (s.bbUp[k] - s.bbLo[k]) / s.bbMid[k];
      let low = Infinity;
      for (let k = i - 120; k <= i; k++) if (ok(s.bbUp[k])) low = Math.min(low, w(k));
      let squeezed = -1;
      for (let k = i - 10; k < i; k++) if (w(k) <= low * 1.05) { squeezed = k; break; }
      if (squeezed >= 0) {
        if (c > up && s.c[i - 1] <= s.bbUp[i - 1]) add('bb-squeeze-up', 'Squeeze breakout up', 1, squeezed, i, { stop: mid, lines: [[pt(squeezed, s.bbUp[squeezed]), pt(i, up)], [pt(squeezed, s.bbLo[squeezed]), pt(i, lo)]] }, 10);
        else if (c < lo && s.c[i - 1] >= s.bbLo[i - 1]) add('bb-squeeze-down', 'Squeeze breakout down', -1, squeezed, i, { stop: mid, lines: [[pt(squeezed, s.bbUp[squeezed]), pt(i, up)], [pt(squeezed, s.bbLo[squeezed]), pt(i, lo)]] }, 10);
      }
    }
    if (ok(lo) && ok(s.bbLo[i - 1]) && ok(r[i - 1])) {
      if (s.c[i - 1] < s.bbLo[i - 1] && r[i - 1] < 30 && c > lo && c > o) add('bb-rsi-oversold', 'BB + RSI oversold reversal', 1, i - 1, i, { stop: Math.min(l, s.l[i - 1]) });
      else if (s.c[i - 1] > s.bbUp[i - 1] && r[i - 1] > 70 && c < up && c < o) add('bb-rsi-overbought', 'BB + RSI overbought reversal', -1, i - 1, i, { stop: Math.max(h, s.h[i - 1]) });
    }

    // --- volume climax ---
    const va = s.volAvg[i - 1];
    if (ok(va) && va > 0 && s.v[i] >= 3 * va && range >= 1.5 * s.avgRange[i]) {
      const tr = priorTrend(s, i - 1, 10);
      if (tr <= -3 && c >= l + 0.5 * range) add('selling-climax', 'Selling climax', 1, i, i, { stop: l });
      else if (tr >= 3 && c <= l + 0.5 * range) add('buying-climax', 'Buying climax', -1, i, i, { stop: h });
    }

    // --- liquidations ---
    const q = s.liq;
    if (q) {
      if (i >= 10 && range >= 1.3 * s.avgRange[i]) {
        let sl = 0, ss = 0, n = 0;
        for (let k = Math.max(1, i - 50); k < i; k++) { sl += q.longLiq[k]; ss += q.shortLiq[k]; n++; }
        const ml = n ? sl / n : 0, ms = n ? ss / n : 0;
        if (q.longLiq[i] > 0 && q.longLiq[i] >= 3 * ml && c >= l + 0.4 * range && c < s.c[i - 1] + range) add('long-flush', 'Long liquidation flush', 1, i, i, { stop: l });
        else if (q.shortLiq[i] > 0 && q.shortLiq[i] >= 3 * ms && c <= h - 0.4 * range) add('short-squeeze', 'Short squeeze exhaustion', -1, i, i, { stop: h });
      }
      const bp = q.belowP[i], ap = q.aboveP[i];
      if (ok(bp) && q.belowN[i] >= 2 * q.bandMean[i] && l <= bp && c > bp && Math.min(o, c) - l >= 0.3 * range)
        add('liq-sweep-low', 'Liquidity sweep below', 1, i, i, { stop: l, lines: [[pt(Math.max(0, i - 8), bp), pt(i, bp)]] });
      else if (ok(ap) && q.aboveN[i] >= 2 * q.bandMean[i] && h >= ap && c < ap && h - Math.max(o, c) >= 0.3 * range)
        add('liq-sweep-high', 'Liquidity sweep above', -1, i, i, { stop: h, lines: [[pt(Math.max(0, i - 8), ap), pt(i, ap)]] });
    }
  }
  bandReversals(s, pv, add, from);
}

type Add = ReturnType<typeof adder>;

/** RSI and MACD divergences at consecutive confirmed zigzag swings. */
function divergences(s: Series, pv: Pivot[], add: Add): void {
  const r = s.rsi14, m = s.macdLine;
  // the last pivot is still extending: not a swing yet
  const conf = pv.slice(0, -1);
  for (const hi of [false, true]) {
    const sw = conf.filter((p) => p.hi === hi);
    for (let k = 1; k < sw.length; k++) {
      const a = sw[k - 1], b = sw[k];
      const gap = b.i - a.i;
      if (gap < 5 || gap > 80 || !ok(r[a.i]) || !ok(r[b.i])) continue;
      const line: [Pt, Pt][] = [[pt(a.i, a.p), pt(b.i, b.p)]];
      const pvs = [pt(a.i, a.p), pt(b.i, b.p)];
      const at = s.atr[b.i] || 1;
      const stop = b.p;
      if (!hi) {
        if (b.p < a.p && r[b.i] > r[a.i] + 3 && r[a.i] < 40) add('rsi-bull-div', 'RSI bullish divergence', 1, a.i, b.i, { lines: line, pivots: pvs, stop, note: `RSI ${r[a.i].toFixed(0)} then ${r[b.i].toFixed(0)}` }, 0);
        else if (b.p > a.p && r[b.i] < r[a.i] - 3 && s.c[b.i] > s.ema50[b.i]) add('rsi-hidden-bull-div', 'RSI hidden bullish divergence', 1, a.i, b.i, { lines: line, pivots: pvs, stop, note: `RSI ${r[a.i].toFixed(0)} then ${r[b.i].toFixed(0)}` }, 0);
        if (ok(m[a.i]) && b.p < a.p && m[a.i] < 0 && m[b.i] > m[a.i] + 0.1 * at) add('macd-bull-div', 'MACD bullish divergence', 1, a.i, b.i, { lines: line, pivots: pvs, stop }, 0);
      } else {
        if (b.p > a.p && r[b.i] < r[a.i] - 3 && r[a.i] > 60) add('rsi-bear-div', 'RSI bearish divergence', -1, a.i, b.i, { lines: line, pivots: pvs, stop, note: `RSI ${r[a.i].toFixed(0)} then ${r[b.i].toFixed(0)}` }, 0);
        else if (b.p < a.p && r[b.i] > r[a.i] + 3 && s.c[b.i] < s.ema50[b.i]) add('rsi-hidden-bear-div', 'RSI hidden bearish divergence', -1, a.i, b.i, { lines: line, pivots: pvs, stop, note: `RSI ${r[a.i].toFixed(0)} then ${r[b.i].toFixed(0)}` }, 0);
        if (ok(m[a.i]) && b.p > a.p && m[a.i] > 0 && m[b.i] < m[a.i] - 0.1 * at) add('macd-bear-div', 'MACD bearish divergence', -1, a.i, b.i, { lines: line, pivots: pvs, stop }, 0);
      }
    }
  }
}

/** Wilder's failure swings: RSI turns without price having to make a new extreme. */
function failureSwing(s: Series, i: number, add: Add): void {
  const r = s.rsi14;
  for (const bull of [true, false]) {
    // x: the latest bar beyond 30 (70) in the last 30
    let x = -1;
    for (let k = i - 1; k >= i - 30; k--) if (bull ? r[k] < 30 : r[k] > 70) { x = k; break; }
    if (x < 0) continue;
    // y: bounce extreme after x; z: pullback after y that stays inside
    let y = x;
    for (let k = x + 1; k < i; k++) if (bull ? r[k] > r[y] : r[k] < r[y]) y = k;
    if (y === x || y >= i - 1) continue;
    let z = y;
    for (let k = y + 1; k < i; k++) if (bull ? r[k] < r[z] : r[k] > r[z]) z = k;
    if (z === y) continue;
    const held = bull ? r[z] > 30 && r[z] > r[x] && r[y] - r[z] >= 3 : r[z] < 70 && r[z] < r[x] && r[z] - r[y] >= 3;
    const cross = bull ? r[i] > r[y] && r[i - 1] <= r[y] : r[i] < r[y] && r[i - 1] >= r[y];
    if (held && cross) {
      add(bull ? 'rsi-failure-swing-bull' : 'rsi-failure-swing-bear', bull ? 'RSI failure swing (bottom)' : 'RSI failure swing (top)', bull ? 1 : -1, x, i,
        { stop: bull ? Math.min(...Array.from({ length: i - x + 1 }, (_, j) => s.l[x + j])) : Math.max(...Array.from({ length: i - x + 1 }, (_, j) => s.h[x + j])), note: `RSI ${r[x].toFixed(0)}, ${r[y].toFixed(0)}, ${r[z].toFixed(0)}, now ${r[i].toFixed(0)}` }, 10);
    }
  }
}

/** Bollinger W bottoms and M tops (after John Bollinger's description). */
function bandReversals(s: Series, pv: Pivot[], add: Add, from: number): void {
  const conf = pv.slice(0, -1);
  for (const top of [false, true]) {
    const sw = conf.filter((p) => p.hi === top);
    for (let k = 1; k < sw.length; k++) {
      const a = sw[k - 1], b = sw[k];
      if (b.i - a.i < 4 || b.i - a.i > 60 || !ok(s.bbLo[a.i])) continue;
      const tol = tolerance(s, b.i);
      const firstOutside = top ? s.h[a.i] > s.bbUp[a.i] : s.l[a.i] < s.bbLo[a.i];
      const retestInside = top ? s.h[b.i] <= s.bbUp[b.i] && b.p >= a.p - tol : s.l[b.i] >= s.bbLo[b.i] && b.p <= a.p + tol;
      if (!firstOutside || !retestInside) continue;
      for (let i = b.i + 1; i <= Math.min(s.lastClosed, b.i + 20); i++) {
        if (!ok(s.bbMid[i])) break;
        const crossed = top ? s.c[i] < s.bbMid[i] && s.c[i - 1] >= s.bbMid[i - 1] : s.c[i] > s.bbMid[i] && s.c[i - 1] <= s.bbMid[i - 1];
        if (!crossed) continue;
        if (i >= from) {
          const lines: [Pt, Pt][] = [[pt(a.i, a.p), pt(b.i, b.p)]];
          add(top ? 'bb-m-top' : 'bb-w-bottom', top ? 'Bollinger M top' : 'Bollinger W bottom', top ? -1 : 1, a.i, i,
            { pivots: [pt(a.i, a.p), pt(b.i, b.p)], lines, stop: b.p }, 0);
        }
        break;
      }
    }
  }
}

/** Every signal kind, for docs and the explanation's coverage test. */
export const SIGNAL_KINDS = [
  'rsi-bull-div', 'rsi-bear-div', 'rsi-hidden-bull-div', 'rsi-hidden-bear-div', 'rsi-failure-swing-bull', 'rsi-failure-swing-bear',
  'bb-squeeze-up', 'bb-squeeze-down', 'bb-w-bottom', 'bb-m-top', 'bb-rsi-oversold', 'bb-rsi-overbought',
  'macd-bull-div', 'macd-bear-div', 'selling-climax', 'buying-climax',
  'long-flush', 'short-squeeze', 'liq-sweep-low', 'liq-sweep-high',
] as const;
