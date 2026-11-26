import type { Candle } from './candle';
import type { PatternHit } from './types';
import { toSeries, type Series } from './series';
import { zigzag } from './pivots';
import { converging, cups, flags, tops } from './chart';
import { candlePatterns, volatilityPatterns } from './candles';
import { signals } from './signals';
import { liqContext, type LiqData } from './liq';

export interface Outcome { kind: string; hit: number; stopped: number; open: number }

export interface Detection {
  series: Series;
  patterns: PatternHit[];
  /** how confirmed chart patterns played out in this history: target or stop first */
  outcomes: Outcome[];
  /** a closer look at the drawn window (detectInWindow only) */
  study?: import('./window').WindowStudy;
}

export interface DetectOptions {
  /** bars at the end that candle patterns and indicator signals are kept for (default 150) */
  recent?: number;
  /**
   * Also search smaller swings: pivots at 1.5 and 1 ATR besides the usual 2,
   * with the size limits scaled down to match. Used inside a drawn window.
   */
  fine?: boolean;
  /** the estimated liquidation map, for the liquidation signals */
  liq?: LiqData | null;
  /** the chart's latest price, when `cs` is a slice ending before it (rescales the futures map) */
  liqLast?: number;
}

/** Pivot sizes (ATR) searched for chart patterns: the usual one, or three in a window. */
const SCALES = [2, 1.5, 1];

/** Run every detector. Candle-level patterns are kept for the last `recent` bars only. */
export function detect(cs: Candle[], opt: number | DetectOptions = {}): Detection {
  const o: DetectOptions = typeof opt === 'number' ? { recent: opt } : opt;
  const recent = o.recent ?? 150;
  const s = toSeries(cs);
  s.liq = liqContext(s.t, s.o, s.h, s.l, s.c, o.liq ?? null, o.liqLast);
  let chart: PatternHit[] = [];
  for (const k of o.fine ? SCALES : [2]) {
    const found: PatternHit[] = [];
    const pv = zigzag(s, k);
    const sc = k / 2;
    tops(s, pv, found, sc);
    converging(s, pv, found);
    cups(s, pv, found, sc);
    if (k === 2) flags(s, found);
    const kept = dedupe(found);
    if (k !== 2) for (const p of kept) { p.id = `${p.id}@${k}`; p.note = (p.note ? p.note + '; ' : '') + `smaller swings (${k} ATR pivots)`; }
    chart = k === 2 ? kept : chart.concat(kept.filter((p) => !chart.some((q) => q.kind === p.kind && overlap(q, p) > 0.6)));
  }
  chart.sort((a, b) => a.start - b.start);
  const small: PatternHit[] = [];
  candlePatterns(s, small, s.n - recent);
  volatilityPatterns(s, small, s.n - recent);
  signals(s, zigzag(s, 1.5), small, s.n - recent);
  const patterns = chart.concat(small);
  return { series: s, patterns, outcomes: outcomes(s, patterns) };
}

/** shared bars as a share of the shorter pattern */
function overlap(k: PatternHit, p: PatternHit): number {
  const ov = Math.min(k.end, p.end) - Math.max(k.start, p.start);
  return ov / Math.max(1, Math.min(k.end - k.start, p.end - p.start));
}

/** Overlapping chart patterns: keep the better scoring one, preferring confirmed. */
function dedupe(ps: PatternHit[]): PatternHit[] {
  const rank = (p: PatternHit) => (p.status === 'confirmed' ? 2 : p.status === 'forming' ? 1 : 0) + p.score;
  ps.sort((a, b) => rank(b) - rank(a));
  const kept: PatternHit[] = [];
  for (const p of ps) {
    if (!kept.some((k) => overlap(k, p) > 0.6)) kept.push(p);
  }
  return kept.sort((a, b) => a.start - b.start);
}
function outcomes(s: Series, ps: PatternHit[]): Outcome[] {
  const by = new Map<string, Outcome>();
  for (const p of ps) {
    if (p.family !== 'chart' || p.status !== 'confirmed' || !p.breakout || p.target === undefined || p.stop === undefined) continue;
    const o = by.get(p.kind) ?? { kind: p.kind, hit: 0, stopped: 0, open: 0 };
    by.set(p.kind, o);
    const up = p.target > p.breakout.p;
    let res: 'hit' | 'stopped' | 'open' = 'open';
    for (let i = p.breakout.i + 1; i <= s.lastClosed; i++) {
      const tHit = up ? s.h[i] >= p.target : s.l[i] <= p.target;
      const sHit = up ? s.l[i] <= p.stop : s.h[i] >= p.stop;
      if (sHit) { res = 'stopped'; break; } // conservative: stop first when both in one bar
      if (tHit) { res = 'hit'; break; }
    }
    o[res === 'hit' ? 'hit' : res === 'stopped' ? 'stopped' : 'open']++;
    p.note = (p.note ? p.note + '; ' : '') + `outcome: ${res}`;
  }
  return [...by.values()];
}
