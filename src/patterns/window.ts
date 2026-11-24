import type { Candle } from './candle';
import { detect, type Detection } from './detect';
import type { PatternHit } from './types';

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
export function detectInWindow(cs: Candle[], w: AnalysisWindow): Detection | null {
  const r = windowRange(cs, w);
  if (!r) return null;
  const [i0, i1] = r;
  const base = Math.max(0, i0 - WARMUP);
  const slice = cs.slice(base, i1 + 1);
  // the last bar of the window counts as closed unless it is the live candle
  const d = detect(slice, i1 - i0 + 1);
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
  return { series: d.series, patterns: kept, outcomes: d.outcomes.filter((o) => ids.has(o.kind)) };
}
