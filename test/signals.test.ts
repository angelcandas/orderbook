import { describe, it, expect } from 'vitest';
import { detect } from '../src/patterns/detect';
import type { Candle } from '../src/patterns/candle';
import { SIGNAL_KINDS } from '../src/patterns/signals';
import { indicatorsFor, needsOf } from '../src/patterns/needs';
import { explain } from '../src/patterns/explain';
import { liqContext, type LiqData } from '../src/patterns/liq';
import { detectInWindow } from '../src/patterns/window';
import { synthHistory } from '../server/sim';
import type { PatternHit } from '../src/patterns/types';

/** candles following a piecewise linear close path (as in patterns.test.ts) */
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
const at = (cs: Candle[], i: number) => cs[i].t;
const bar = (t: number, o: number, h: number, l: number, c: number, v = 1): Candle => ({ t: t * 60_000, o, h, l, c, v, closed: true });
const sig = (cs: Candle[], liq: LiqData | null = null) => detect(cs, { liq, recent: cs.length }).patterns.filter((p) => p.family === 'signal');
const kinds = (ps: PatternHit[]) => ps.map((p) => p.kind);

describe('indicator signals', () => {
  it('RSI bullish divergence: a sharp low, then a slow lower low', () => {
    // steep fall to the first low, then a choppy, slow drift to a slightly lower low
    const a = path([[0, 30], [0.75, 0], [1, 8]], 56, 100, 0.1);
    const b = path([[0, 8], [0.9, -1.5], [1, 4]], 64, 100, 0.6, 56 * 60_000);
    const cs = [...a, ...b];
    const d = sig(cs).filter((p) => p.kind === 'rsi-bull-div');
    expect(d.length).toBeGreaterThan(0);
    expect(d[0].pivots).toHaveLength(2);
    expect(d[0].pivots[1].p).toBeLessThan(d[0].pivots[0].p);
  });

  it('RSI bearish divergence: a sharp high, then a slow higher high', () => {
    const a = path([[0, -30], [0.75, 0], [1, -8]], 56, 100, 0.1);
    const b = path([[0, -8], [0.9, 1.5], [1, -4]], 64, 100, 0.6, 56 * 60_000);
    const cs = [...a, ...b];
    expect(kinds(sig(cs))).toContain('rsi-bear-div');
  });

  it('Bollinger squeeze breakout after a long quiet range', () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 100; i++) { const c = 100 + Math.sin(i / 3) * 1.2; cs.push(bar(i, c, c + 0.4, c - 0.4, c)); }
    for (let i = 100; i < 160; i++) { const c = 100 + (i % 2 ? 0.05 : -0.05); cs.push(bar(i, c, c + 0.1, c - 0.1, c)); }
    cs.push(bar(160, 100, 101.2, 99.95, 101));
    expect(kinds(sig(cs))).toContain('bb-squeeze-up');
  });

  it('BB + RSI oversold reversal: a close under the band, then back inside', () => {
    const cs: Candle[] = [];
    let p = 120;
    for (let i = 0; i < 40; i++) { cs.push(bar(i, p, p + 0.3, p - 0.3, p + (i % 2 ? 0.2 : -0.2))); }
    for (let i = 40; i < 52; i++) { cs.push(bar(i, p, p + 0.2, p - 1.2, p - 1)); p -= 1; }
    cs.push(bar(52, p, p + 0.2, p - 4, p - 3.8)); p -= 3.8;
    cs.push(bar(53, p, p + 2.5, p - 0.2, p + 2.3));
    expect(kinds(sig(cs))).toContain('bb-rsi-oversold');
  });

  it('selling climax: huge volume on a wide bar after a steep fall, closing high', () => {
    const cs: Candle[] = [];
    let p = 150;
    for (let i = 0; i < 40; i++) { cs.push(bar(i, p, p + 0.5, p - 0.5, p + (i % 2 ? 0.1 : -0.1), 10)); }
    for (let i = 40; i < 55; i++) { cs.push(bar(i, p, p + 0.3, p - 1.4, p - 1.2, 10)); p -= 1.2; }
    cs.push(bar(55, p, p + 0.5, p - 5, p - 0.5, 60));
    expect(kinds(sig(cs))).toContain('selling-climax');
  });

  // a liquidation map with one heavy band at ~95 (in chart prices, futures = spot)
  function map(cs: Candle[], heavyAt: number): LiqData {
    const bins = 400, origin = 80, binStep = 0.1, cols = cs.length;
    const data = new Float32Array(cols * bins);
    for (let c = 0; c < cols; c++) for (let r = 0; r < bins; r++) {
      const p = origin + (r + 0.5) * binStep;
      data[c * bins + r] = 10 + (Math.abs(p - heavyAt) < 0.25 ? 5000 : 0);
    }
    return { stepMs: 60_000, t0: cs[0].t, cols, bins, origin, binStep, lastPrice: cs[cs.length - 1].c, data, events: new Float64Array(0) };
  }

  it('liquidity sweep: a wick through the heaviest long band that closes back above', () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 60; i++) { const c = 100 + (i % 2 ? 0.3 : -0.3); cs.push(bar(i, c, c + 0.5, c - 0.5, c)); }
    cs.push(bar(60, 100, 100.4, 94.8, 99.8));
    cs.push(bar(61, 99.8, 100.3, 99.5, 100));
    const s = sig(cs, map(cs, 95)).filter((p) => p.kind === 'liq-sweep-low');
    expect(s).toHaveLength(1);
    expect(s[0].end).toBe(60);
    expect(s[0].stop).toBeCloseTo(94.8);
  });

  it('long flush: a wide bar through heavy long liquidations, closing off the low', () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 60; i++) { const c = 100 + (i % 2 ? 0.3 : -0.3); cs.push(bar(i, c, c + 0.5, c - 0.5, c)); }
    cs.push(bar(60, 100, 100.2, 94, 97.5));
    const q = liqContext(cs.map((c) => c.t), cs.map((c) => c.o), cs.map((c) => c.h), cs.map((c) => c.l), cs.map((c) => c.c), map(cs, 95))!;
    expect(q.longLiq[60]).toBeGreaterThan(10 * q.longLiq[59]);
    expect(kinds(sig(cs, map(cs, 95)))).toContain('long-flush');
  });

  it('no liquidation signals without the map', () => {
    const cs = synthHistory(90000, 1500, 60_000, 7);
    expect(sig(cs).some((p) => /liq|flush|squeeze$/.test(p.kind) && p.kind !== 'bb-squeeze-up')).toBe(false);
  });

  it('fires a variety of signals on synthetic history, quickly', () => {
    const cs = synthHistory(90000, 3000, 60_000, 11);
    const t0 = performance.now();
    const d = detect(cs, { recent: 3000 });
    const ms = performance.now() - t0;
    const found = new Set(d.patterns.filter((p) => p.family === 'signal').map((p) => p.kind));
    expect(found.size).toBeGreaterThanOrEqual(6);
    expect(ms).toBeLessThan(150);
  });
});

describe('what each signal needs and says', () => {
  const hit = (kind: string, family: PatternHit['family'] = 'signal'): PatternHit => ({ id: `${kind}:1`, kind, label: kind, bias: 1, family, start: 0, end: 1, pivots: [], lines: [], status: 'confirmed', score: 1 });

  it('there are 20 signals, each explained, each with its indicators', () => {
    expect(SIGNAL_KINDS).toHaveLength(20);
    for (const k of SIGNAL_KINDS) {
      const e = explain([hit(k)], { t: [0, 60_000], last: 100, decimals: 2, window: null, symbol: 'X', interval: 1 });
      expect(e.items[0].text).not.toMatch(/no description yet/);
      const n = needsOf(hit(k));
      expect(n.indicators.length + (n.liq ? 1 : 0)).toBeGreaterThan(0);
    }
  });

  it('maps signals to the exact indicator parameters the detector used', () => {
    expect(indicatorsFor(hit('bb-rsi-oversold')).map((c) => `${c.kind}:${c.params.join(',')}`)).toEqual(['bb:20,2', 'rsi:14']);
    expect(indicatorsFor(hit('macd-bull-div'))[0].params).toEqual([12, 26, 9]);
    expect(needsOf(hit('liq-sweep-low')).liq).toBe(true);
    expect(indicatorsFor(hit('double-top', 'chart')).map((c) => c.kind)).toEqual(['atr']);
    expect(indicatorsFor(hit('nr7', 'volatility'))).toEqual([]);
  });
});

describe('closer look inside a window', () => {
  const cs = synthHistory(90000, 1200, 60_000, 5);
  const win = { t0: at(cs, 700), t1: at(cs, 1100), p0: 1, p1: 1e9 };

  it('finds smaller patterns than the full chart does, marked as such', () => {
    const full = detect(cs).patterns.filter((p) => p.family === 'chart' && p.start >= 700 && p.end <= 1100);
    const inWin = detectInWindow(cs, win)!.patterns.filter((p) => p.family === 'chart');
    expect(inWin.length).toBeGreaterThan(full.length);
    const minor = inWin.filter((p) => /smaller swings/.test(p.note ?? ''));
    expect(minor.length).toBeGreaterThan(0);
    expect(new Set(inWin.map((p) => p.id)).size).toBe(inWin.length); // ids stay unique across swing sizes
  });

  it('studies the window: trend, levels and counts, and explains it first', () => {
    const d = detectInWindow(cs, win)!;
    expect(d.study!.bars).toBe(401);
    expect(d.study!.high).toBeGreaterThan(d.study!.low);
    expect(Number.isFinite(d.study!.volRatio)).toBe(true);
    expect(d.study!.counts.chart).toBe(d.patterns.filter((p) => p.family === 'chart').length);
    const e = explain(d.patterns, { t: cs.map((c) => c.t), last: cs[cs.length - 1].c, decimals: 2, window: win, symbol: 'X', interval: 1, study: d.study });
    expect(e.items[0].heading).toBe('Inside the window');
    expect(e.items[0].text).toMatch(/401 bars/);
    expect(e.items[0].text).toMatch(/three swing sizes/);
  });
});
