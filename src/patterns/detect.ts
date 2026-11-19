import type { Candle } from './candle';
import type { PatternHit } from './types';
import { toSeries, type Series } from './series';
import { zigzag } from './pivots';
import { converging, cups, flags, tops } from './chart';
import { candlePatterns, volatilityPatterns } from './candles';

export interface Outcome { kind: string; hit: number; stopped: number; open: number }

export interface Detection {
  series: Series;
  patterns: PatternHit[];
  /** how confirmed chart patterns played out in this history: target or stop first */
  outcomes: Outcome[];
}

/** Run every detector. Candle-level patterns are kept for the last `recent` bars only. */
export function detect(cs: Candle[], recent = 150): Detection {
  const s = toSeries(cs);
  const chart: PatternHit[] = [];
  const pv = zigzag(s, 2);
  tops(s, pv, chart);
  converging(s, pv, chart);
  cups(s, pv, chart);
  flags(s, chart);
  const small: PatternHit[] = [];
  candlePatterns(s, small, s.n - recent);
  volatilityPatterns(s, small, s.n - recent);
  const patterns = dedupe(chart).concat(small);
  return { series: s, patterns, outcomes: outcomes(s, patterns) };
}

/** Overlapping chart patterns: keep the better scoring one, preferring confirmed. */
function dedupe(ps: PatternHit[]): PatternHit[] {
  const rank = (p: PatternHit) => (p.status === 'confirmed' ? 2 : p.status === 'forming' ? 1 : 0) + p.score;
  ps.sort((a, b) => rank(b) - rank(a));
  const kept: PatternHit[] = [];
  for (const p of ps) {
    const clash = kept.some((k) => {
      const ov = Math.min(k.end, p.end) - Math.max(k.start, p.start);
      return ov > 0.6 * Math.min(k.end - k.start, p.end - p.start);
    });
    if (!clash) kept.push(p);
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
