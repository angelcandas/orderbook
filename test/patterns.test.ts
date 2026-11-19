import { describe, it, expect } from 'vitest';
import { detect } from '../src/patterns/detect';
import type { Candle } from '../src/patterns/candle';
import { synthHistory } from '../server/sim';

/** candles following a piecewise linear close path with small, regular wicks */
function path(points: [number, number][], n: number, base = 100, noise = 0.15): Candle[] {
  const out: Candle[] = [];
  let prev = base + points[0][1];
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    let k = 0;
    while (k < points.length - 2 && points[k + 1][0] < x) k++;
    const [x0, y0] = points[k], [x1, y1] = points[k + 1];
    const c = base + y0 + ((x - x0) / (x1 - x0)) * (y1 - y0) + (i % 2 ? noise : -noise);
    const o = prev;
    out.push({ t: i * 60_000, o, c, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2, v: 1, closed: true });
    prev = c;
  }
  return out;
}
const kinds = (cs: Candle[]) => detect(cs).patterns.filter((p) => p.family === 'chart').map((p) => `${p.kind}:${p.status}`);

describe('chart patterns', () => {
  it('finds a confirmed double top', () => {
    const cs = path([[0, 0], [0.3, 12], [0.5, 4], [0.7, 12], [1, -6]], 120);
    expect(kinds(cs)).toContain('double-top:confirmed');
  });
  it('finds a confirmed double bottom', () => {
    const cs = path([[0, 0], [0.3, -12], [0.5, -4], [0.7, -12], [1, 6]], 120);
    expect(kinds(cs)).toContain('double-bottom:confirmed');
  });
  it('finds head and shoulders', () => {
    const cs = path([[0, 0], [0.15, 8], [0.3, 2], [0.5, 14], [0.7, 2], [0.85, 8], [1, -8]], 160);
    expect(kinds(cs)).toContain('head-shoulders-top:confirmed');
  });
  it('finds an ascending triangle', () => {
    const cs = path([[0, 0], [0.15, 10], [0.3, 2], [0.45, 10], [0.6, 5], [0.75, 10], [0.85, 7.5], [1, 16]], 180, 100, 0.05);
    const k = kinds(cs);
    expect(k.some((x) => x.startsWith('ascending-triangle'))).toBe(true);
  });
  it('finds a forming pattern before the breakout', () => {
    const cs = path([[0, 0], [0.4, 12], [0.7, 4], [1, 12]], 100);
    cs.push(...path([[0, 12], [1, 8]], 8).map((c, i) => ({ ...c, t: (100 + i) * 60_000 })));
    expect(kinds(cs).some((k) => k === 'double-top:forming')).toBe(true);
  });
  it('runs over synthetic history quickly', () => {
    const cs = synthHistory(90000, 720, 60_000, 3);
    const t0 = performance.now();
    const d = detect(cs);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(50);
    expect(d.patterns.length).toBeGreaterThan(0);
  });
});

const bar = (o: number, h: number, l: number, c: number, t: number): Candle => ({ t, o, h, l, c, v: 1, closed: true });
function downtrendThen(...bars: [number, number, number, number][]): Candle[] {
  const cs: Candle[] = [];
  let p = 130;
  for (let i = 0; i < 20; i++) { cs.push(bar(p, p + 0.5, p - 1.6, p - 1.5, i)); p -= 1.5; }
  bars.forEach((b, k) => cs.push(bar(...b, 20 + k)));
  return cs;
}
const candleKinds = (cs: Candle[]) => detect(cs).patterns.filter((p) => p.end === cs.length - 1).map((p) => p.kind);

describe('candle patterns', () => {
  it('hammer after a decline', () => {
    expect(candleKinds(downtrendThen([99.5, 100.2, 97, 100.1]))).toContain('hammer');
  });
  it('dragonfly doji after a decline', () => {
    expect(candleKinds(downtrendThen([100, 100.05, 97, 100.02]))).toContain('dragonfly-doji');
  });
  it('bullish engulfing after a decline', () => {
    expect(candleKinds(downtrendThen([100, 100.2, 98.5, 98.8], [98.6, 101, 98.4, 100.6]))).toContain('bullish-engulfing');
  });
  it('morning star after a decline', () => {
    expect(candleKinds(downtrendThen([100, 100.2, 96.8, 97], [96.8, 97.1, 96.3, 96.7], [96.9, 99.6, 96.8, 99.4]))).toContain('morning-star');
  });
  it('NR4 and inside bar', () => {
    const cs = downtrendThen([100, 103, 97, 101], [101, 102, 99.5, 100.5]);
    expect(candleKinds(cs)).toContain('inside-bar');
  });
});
