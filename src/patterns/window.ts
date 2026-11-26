import type { Candle } from './candle';
import { detect, type Detection } from './detect';
import type { PatternHit } from './types';
import type { LiqData } from './liq';
import type { Series } from './series';
import { zigzag } from './pivots';

/** A box drawn on the candle chart: candle open times and a price band. */
export interface AnalysisWindow { t0: number; t1: number; p0: number; p1: number }

/** Bars before the window that only warm up ATR / EMA / average body; patterns may not start there. */
export const WARMUP = 60;

/** First index with t >= x (candles sorted by open time). */
export function lowerBound(t: ArrayLike<number>, x: number): number {
  let lo = 0, hi = t.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

/** Candle index range [i0, i1] covered by the window, or null if it holds fewer than 3 bars. */
export function windowRange(cs: Candle[], w: AnalysisWindow): [number, number] | null {
  const t = cs.map((c) => c.t);
  const i0 = lowerBound(t, Math.min(w.t0, w.t1));
  const i1 = lowerBound(t, Math.max(w.t0, w.t1) + 1) - 1;
  return i1 - i0 >= 2 ? [i0, i1] : null;
}

/** Lowest and highest price a pattern covers: its pivots, or its bars when it has none. */
function span(p: PatternHit, cs: Candle[]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const q of p.pivots) { lo = Math.min(lo, q.p); hi = Math.max(hi, q.p); }
  if (lo === Infinity) {
    for (let i = p.start; i <= p.end; i++) { lo = Math.min(lo, cs[i].l); hi = Math.max(hi, cs[i].h); }
  }
  return [lo, hi];
}

/**
 * Run every detector over the bars inside the window only, so a pattern must
 * start and end inside it. A few bars before it warm up the indicators. Of the
 * patterns found, only those whose prices overlap the window's price band are
 * kept. Indices in the result refer to the full candle list.
 */
export function detectInWindow(cs: Candle[], w: AnalysisWindow, liq: LiqData | null = null): Detection | null {
  const r = windowRange(cs, w);
  if (!r) return null;
  const [i0, i1] = r;
  const base = Math.max(0, i0 - WARMUP);
  const slice = cs.slice(base, i1 + 1);
  // the last bar of the window counts as closed unless it is the live candle
  // a closer look than the full chart: smaller swings too, and every signal in the window
  const d = detect(slice, { recent: i1 - i0 + 1, fine: true, liq, liqLast: cs[cs.length - 1]?.c });
  const lo = Math.min(w.p0, w.p1), hi = Math.max(w.p0, w.p1);
  const shift = <T extends { i: number }>(q: T): T => ({ ...q, i: q.i + base });
  const kept: PatternHit[] = [];
  for (const p of d.patterns) {
    if (p.start + base < i0) continue;
    const moved: PatternHit = {
      ...p,
      start: p.start + base, end: p.end + base,
      pivots: p.pivots.map(shift),
      lines: p.lines.map(([a, b]) => [shift(a), shift(b)] as [typeof a, typeof b]),
      breakout: p.breakout && shift(p.breakout),
    };
    const [a, b] = span(moved, cs);
    if (b < lo || a > hi) continue;
    kept.push(moved);
  }
  const ids = new Set(kept.map((p) => p.kind));
  return { series: d.series, patterns: kept, outcomes: d.outcomes.filter((o) => ids.has(o.kind)), study: study(d.series, i0 - base, i1 - base, kept) };
}

/** What the window holds besides patterns: trend, volatility, volume, momentum and levels. */
export interface WindowStudy {
  bars: number;
  /** close change over the window, in percent */
  changePct: number;
  /** least squares slope of the closes, ATR per bar, and how well a line fits (R squared) */
  slopeAtr: number;
  r2: number;
  high: number;
  low: number;
  /** mean true range inside vs. the same number of bars before (NaN when not enough bars) */
  volRatio: number;
  /** mean volume inside vs. before */
  volumeRatio: number;
  rsiStart: number;
  rsiEnd: number;
  /** the Bollinger band width at the end relative to its average inside the window */
  bandWidthRatio: number;
  /** prices touched by two or more swing points (1 ATR pivots), strongest first */
  levels: { price: number; touches: number; kind: 'support' | 'resistance' | 'both' }[];
  /** estimated liquidation bands nearest the window's price band, when the map is loaded */
  liqBelow?: { price: number; notional: number };
  liqAbove?: { price: number; notional: number };
  /** how many patterns by family and bias */
  counts: { chart: number; candle: number; signal: number; bull: number; bear: number };
}

const mean = (a: ArrayLike<number>, i: number, j: number) => {
  let s = 0, n = 0;
  for (let k = Math.max(0, i); k <= j; k++) if (a[k] === a[k]) { s += a[k]; n++; }
  return n ? s / n : NaN;
};

/** `a`..`b` are indices into `s`; patterns are on the full list but only counted. */
export function study(s: Series, a: number, b: number, ps: PatternHit[]): WindowStudy {
  const n = b - a + 1;
  // regression of close on bar index
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = a; i <= b; i++) { const x = i - a, y = s.c[i]; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; }
  const den = n * sxx - sx * sx;
  const slope = den ? (n * sxy - sx * sy) / den : 0;
  const vy = n * syy - sy * sy;
  const r2 = den && vy > 0 ? ((n * sxy - sx * sy) ** 2) / (den * vy) : 0;
  let high = -Infinity, low = Infinity;
  for (let i = a; i <= b; i++) { high = Math.max(high, s.h[i]); low = Math.min(low, s.l[i]); }
  const tr = (i: number) => (i ? Math.max(s.h[i] - s.l[i], Math.abs(s.h[i] - s.c[i - 1]), Math.abs(s.l[i] - s.c[i - 1])) : s.h[i] - s.l[i]);
  const trs = new Float64Array(s.n);
  for (let i = 0; i < s.n; i++) trs[i] = tr(i);
  const before = a - n >= 0 ? a - n : a >= 10 ? 0 : -1;
  const volRatio = before >= 0 ? mean(trs, a, b) / mean(trs, before, a - 1) : NaN;
  const volumeRatio = before >= 0 ? mean(s.v, a, b) / mean(s.v, before, a - 1) : NaN;
  const width = new Float64Array(s.n);
  for (let i = 0; i < s.n; i++) width[i] = (s.bbUp[i] - s.bbLo[i]) / s.bbMid[i];
  const bandWidthRatio = width[b] / mean(width, a, b);
  // support / resistance: swing points (1 ATR) inside the window grouped by price
  const pv = zigzag(s, 1).filter((p) => p.i >= a && p.i <= b);
  const tol = Math.max(0.5 * (s.atr[b] || 0), 0.002 * s.c[b]);
  const groups: { price: number; n: number; hi: number; lo: number }[] = [];
  for (const p of pv) {
    const g = groups.find((x) => Math.abs(x.price - p.p) <= tol);
    if (g) { g.price = (g.price * g.n + p.p) / (g.n + 1); g.n++; p.hi ? g.hi++ : g.lo++; }
    else groups.push({ price: p.p, n: 1, hi: p.hi ? 1 : 0, lo: p.hi ? 0 : 1 });
  }
  const levels = groups.filter((g) => g.n >= 2).sort((x, y) => y.n - x.n).slice(0, 4)
    .map((g) => ({ price: g.price, touches: g.n, kind: (g.hi && g.lo ? 'both' : g.hi ? 'resistance' : 'support') as 'support' | 'resistance' | 'both' }));
  const out: WindowStudy = {
    bars: n, changePct: ((s.c[b] - s.o[a]) / s.o[a]) * 100, slopeAtr: slope / (s.atr[b] || 1), r2, high, low,
    volRatio, volumeRatio, rsiStart: s.rsi14[a], rsiEnd: s.rsi14[b], bandWidthRatio, levels,
    counts: {
      chart: ps.filter((p) => p.family === 'chart').length, candle: ps.filter((p) => p.family === 'candle' || p.family === 'volatility').length,
      signal: ps.filter((p) => p.family === 'signal').length, bull: ps.filter((p) => p.bias > 0).length, bear: ps.filter((p) => p.bias < 0).length,
    },
  };
  const q = s.liq;
  if (q) {
    // the map at the window's last bar, nearest the band the window covers
    const i = b;
    if (q.belowP[i] === q.belowP[i] && q.belowN[i] > 0) out.liqBelow = { price: q.belowP[i], notional: q.belowN[i] };
    if (q.aboveP[i] === q.aboveP[i] && q.aboveN[i] > 0) out.liqAbove = { price: q.aboveP[i], notional: q.aboveN[i] };
  }
  return out;
}
