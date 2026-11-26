import { describe, it, expect } from 'vitest';
import type { Candle } from '../src/patterns/candle';
import { detectInWindow, windowRange } from '../src/patterns/window';
import { explain, explanationText } from '../src/patterns/explain';

/** candles following a piecewise linear close path (same shape helper as patterns.test.ts) */
function path(points: [number, number][], n: number, base = 100, noise = 0.15, t0 = 0): Candle[] {
  const out: Candle[] = [];
  let prev = base + points[0][1];
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    let k = 0;
    while (k < points.length - 2 && points[k + 1][0] < x) k++;
    const [x0, y0] = points[k], [x1, y1] = points[k + 1];
    const c = base + y0 + ((x - x0) / (x1 - x0)) * (y1 - y0) + (i % 2 ? noise : -noise);
    const o = prev;
    out.push({ t: t0 + i * 60_000, o, c, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2, v: 1, closed: true });
    prev = c;
  }
  return out;
}

// 150 bars of a gentle drift, then a clean double top over 120 bars
const lead = path([[0, -20], [1, 0]], 150, 100, 0.15, 0);
const top = path([[0, 0], [0.3, 12], [0.5, 4], [0.7, 12], [1, -6]], 120, 100, 0.15, 150 * 60_000);
const cs = [...lead, ...top];
const T = (i: number) => cs[i].t;

describe('analysis window', () => {
  it('maps times to candle indices', () => {
    expect(windowRange(cs, { t0: T(150), t1: T(269), p0: 0, p1: 1e9 })).toEqual([150, 269]);
    expect(windowRange(cs, { t0: T(10), t1: T(11), p0: 0, p1: 1e9 })).toBeNull(); // fewer than 3 bars
  });

  it('finds the double top inside the window, with indices on the full list', () => {
    const d = detectInWindow(cs, { t0: T(150), t1: T(269), p0: 80, p1: 130 })!;
    const dt = d.patterns.find((p) => p.kind === 'double-top');
    expect(dt?.status).toBe('confirmed');
    expect(dt!.start).toBeGreaterThanOrEqual(150);
    for (const q of dt!.pivots) expect(cs[q.i].h).toBeGreaterThan(q.p - 3); // pivots point at the right bars
    expect(d.series.n).toBeGreaterThan(0);
  });

  it('finds nothing from outside the window', () => {
    const d = detectInWindow(cs, { t0: T(0), t1: T(140), p0: 0, p1: 1e9 })!;
    expect(d.patterns.some((p) => p.kind === 'double-top')).toBe(false);
    for (const p of d.patterns) expect(p.end).toBeLessThanOrEqual(140);
  });

  it('drops patterns outside the price band', () => {
    const d = detectInWindow(cs, { t0: T(150), t1: T(269), p0: 300, p1: 400 })!;
    expect(d.patterns).toHaveLength(0);
  });

  it('explains patterns in plain words', () => {
    const w = { t0: T(150), t1: T(269), p0: 80, p1: 130 };
    const d = detectInWindow(cs, w)!;
    const e = explain(d.patterns, { t: cs.map((c) => c.t), last: cs[cs.length - 1].c, decimals: 2, window: w, symbol: 'Kraken BTC/USD', interval: 60 });
    expect(e.title).toBe('Kraken BTC/USD 1h patterns');
    expect(e.summary).toMatch(/found inside the window/);
    const dt = e.items.find((i) => i.id.startsWith('double-top'))!;
    expect(dt.heading).toMatch(/^Double top \(bearish\)/);
    expect(dt.text).toMatch(/neckline/);
    expect(dt.text).toMatch(/confirmed/);
    expect(dt.text).toMatch(/measured target is/);
    expect(explanationText(e)).toContain(dt.text);
  });

  it('says so when nothing is found', () => {
    const e = explain([], { t: [], last: 1, decimals: 2, window: null, symbol: 'X', interval: 5 });
    expect(e.items).toHaveLength(0);
    expect(e.summary).toMatch(/No patterns were found over the loaded history/);
  });
});

describe('explanation order', () => {
  it('lists the newest patterns first', () => {
    const mk = (id: string, end: number) => ({ id, kind: 'bullish-engulfing', label: 'Bullish engulfing', bias: 1 as const, family: 'candle' as const, start: end - 1, end, pivots: [], lines: [], status: 'confirmed' as const, score: 1 });
    const e = explain([mk('a', 3), mk('b', 9), mk('c', 6)], { t: Array.from({ length: 10 }, (_, i) => i * 60_000), last: 1, decimals: 2, window: null, symbol: 'X', interval: 1 });
    expect(e.items.map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });
});
