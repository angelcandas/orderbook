import { describe, it, expect } from 'vitest';
import { forecast, withLiquidity, readings, hasNoEdge, MIN_SAMPLES } from '../src/forecast/forecast';
import type { Candle } from '../src/patterns/candle';
import { synthHistory } from '../server/sim';

/** a random walk with a constant drift per bar */
function walk(n: number, drift: number, vol = 0.01, seed = 7): Candle[] {
  let s = seed, p = 100;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const g = Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
    const o = p;
    p = p * Math.exp(drift + vol * g);
    out.push({ t: i * 60_000, o, c: p, h: Math.max(o, p) * 1.002, l: Math.min(o, p) * 0.998, v: 1, closed: true });
  }
  return out;
}

describe('research forecast', () => {
  it('needs enough history', () => {
    expect(forecast(walk(100, 0))).toBeNull();
    expect(forecast(walk(60 + 20 + MIN_SAMPLES + 5, 0))).not.toBeNull();
  });

  it('brackets the last close and gives a probability', () => {
    const f = forecast(synthHistory(30000, 1500, 60_000, 3))!;
    expect(f.bottom).toBeLessThan(f.last);
    expect(f.top).toBeGreaterThan(f.last);
    expect(f.bottom).toBeLessThan(f.mid);
    expect(f.mid).toBeLessThan(f.top);
    expect(f.pUp).toBeGreaterThan(0);
    expect(f.pUp).toBeLessThan(1);
    expect(['buy', 'sell', 'wait']).toContain(f.verdict);
    expect(f.factors.map((k) => k.key)).toEqual(['trend', 'momentum', 'rsi', 'bollinger', 'patterns']);
  });

  it('range holds about 80% of closes out of sample', () => {
    const f = forecast(walk(3000, 0, 0.01, 11))!;
    expect(f.backtest.coverage).toBeGreaterThan(0.7);
    expect(f.backtest.coverage).toBeLessThan(0.9);
  });

  it('learns a steady uptrend', () => {
    const f = forecast(walk(2000, 0.003, 0.01, 5))!;
    expect(f.backtest.baseUp).toBeGreaterThan(0.75);
    expect(f.pUp).toBeGreaterThan(0.6);
  });

  it('gives no buy or sell lean on a pure random walk', () => {
    const verdicts = [1, 2, 3, 4, 5, 6].map((seed) => forecast(walk(2500, 0, 0.01, seed))!);
    const waits = verdicts.filter((f) => f.verdict === 'wait').length;
    expect(waits).toBeGreaterThanOrEqual(5);
    for (const f of verdicts) if (hasNoEdge(f)) expect(f.verdict).toBe('wait');
  });

  it('wider range for a longer horizon', () => {
    const cs = walk(2000, 0, 0.01, 9);
    const a = forecast(cs, { horizon: 10 })!, b = forecast(cs, { horizon: 50 })!;
    expect(b.top / b.bottom).toBeGreaterThan(a.top / a.bottom);
  });

  it('ignores the forming candle', () => {
    const cs = walk(1000, 0, 0.01, 4);
    const base = forecast(cs)!;
    const forming = [...cs, { ...cs[cs.length - 1], t: cs.length * 60_000, c: 1e6, h: 1e6, closed: false }];
    expect(forecast(forming)!.last).toBe(base.last);
  });

  it('liquidation clusters lean towards the bigger nearby side', () => {
    const f = forecast(walk(1500, 0, 0.01, 2))!;
    const up = withLiquidity(f, { price: f.last * 0.999 * (f.bottom / f.last), notional: 1e5 }, { price: (f.last + f.top) / 2, notional: 5e6 });
    expect(up.factors.find((k) => k.key === 'liquidity')!.score).toBeGreaterThan(0.5);
    expect(up.pUp).toBeGreaterThan(f.pUp);
    const far = withLiquidity(f, undefined, { price: f.top * 3, notional: 5e6 });
    expect(far.factors.find((k) => k.key === 'liquidity')!.score).toBe(0);
    // applying again replaces the factor, it does not stack
    expect(withLiquidity(up, undefined, undefined).factors.filter((k) => k.key === 'liquidity')).toHaveLength(1);
  });

  it('scores stay within -1..1', () => {
    const cs = synthHistory(100, 800, 60_000, 8);
    const rd = readings(cs.map((k) => k.c), cs.map((k) => k.h), cs.map((k) => k.l));
    for (const x of rd.score) expect(Math.abs(x)).toBeLessThanOrEqual(1);
  });
});
