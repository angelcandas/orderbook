import { describe, it, expect } from 'vitest';
import { LiqMap, TIERS, MMR, shiftArray, futuresSymbol, rng } from '../src/liquidation/model';
import { niceStep, compact } from '../src/liquidation/heatmap';

const sum = (a: Float64Array) => a.reduce((x, y) => x + y, 0);

describe('LiqMap', () => {
  it('anchors a tidy grid around the first trade', () => {
    const m = new LiqMap({ bins: 400, binBps: 2.5 });
    m.trade(91_234, 1);
    expect(m.step).toBe(20); // 2.5 bps of 91k is ~22.8, rounded to 20
    expect(m.low).toBeLessThan(91_234);
    expect(m.high).toBeGreaterThan(91_234);
    expect(m.row(91_234)).toBe(200);
  });

  it('places new positions at leverage-tier liquidation prices, longs below and shorts above', () => {
    const m = new LiqMap({ bins: 4000, binBps: 1 });
    m.openInterest(1000);
    for (let i = 0; i < 10; i++) m.trade(100, 1);
    m.openInterest(1010); // +10 base units at 100 = $1,000 opened
    // entries are priced at the row centre
    const entry = m.priceOf(m.row(100));
    const notional = 10 * entry;
    expect(sum(m.longs)).toBeCloseTo(notional, 6);
    expect(sum(m.shorts)).toBeCloseTo(sum(m.longs), 6);
    for (const t of TIERS) {
      expect(m.longs[m.row(entry * (1 - 1 / t.leverage + MMR))]).toBeCloseTo(notional * t.weight, 6);
      expect(m.shorts[m.row(entry * (1 + 1 / t.leverage - MMR))]).toBeCloseTo(notional * t.weight, 6);
    }
    // everything long is below price, everything short above
    const r = m.row(100);
    for (let i = r; i < m.bins; i++) expect(m.longs[i]).toBe(0);
    for (let i = 0; i <= r; i++) expect(m.shorts[i]).toBe(0);
  });

  it('clears levels price trades through', () => {
    const m = new LiqMap({ bins: 4000, binBps: 1 });
    m.openInterest(0);
    m.trade(100, 1);
    m.openInterest(10);
    const before = sum(m.longs);
    m.trade(98.5, 1); // through the 100x (~99.4) and 50x (~98.4 is not reached) levels
    const r100 = m.row(m.priceOf(m.row(100)) * (1 - 1 / 100 + MMR));
    expect(m.longs[r100]).toBe(0);
    expect(sum(m.longs)).toBeCloseTo(before * 0.8, 6); // the 100x tier holds 20%
    expect(sum(m.shorts)).toBeGreaterThan(0); // shorts above untouched
  });

  it('closes positions pro rata when open interest drops', () => {
    const m = new LiqMap({ bins: 4000, binBps: 1 });
    m.openInterest(100);
    m.trade(100, 1);
    m.openInterest(200);
    const l = sum(m.longs);
    m.openInterest(150); // a quarter closed
    expect(sum(m.longs)).toBeCloseTo(l * 0.75, 6);
  });

  it('recentres when price drifts, keeping levels at the same prices', () => {
    const m = new LiqMap({ bins: 200, binBps: 10 });
    m.openInterest(0);
    m.trade(100, 1);
    m.openInterest(10);
    const p = m.priceOf(m.longs.findIndex((v) => v > 0));
    const v = m.longs[m.row(p)];
    // walk price up past the top 20% of the grid
    for (let x = 100; x < 108; x += 0.05) m.trade(x, 0.01);
    expect(m.shifted).toBeGreaterThan(0);
    if (m.row(p) >= 0) expect(m.longs[m.row(p)]).toBeCloseTo(v, 9);
    expect(m.row(m.lastPrice)).toBeGreaterThan(m.bins * 0.2);
    expect(m.row(m.lastPrice)).toBeLessThan(m.bins * 0.8);
  });

  it('falls back to volume when open interest is unavailable', () => {
    const m = new LiqMap();
    m.trade(100, 5);
    m.openFromVolume(0.1);
    expect(sum(m.longs)).toBeGreaterThan(0);
  });

  it('keeps the long-below/short-above invariant under a random walk', () => {
    const m = new LiqMap({ bins: 600, binBps: 2 });
    const rnd = rng(3);
    let p = 50, oi = 1000;
    for (let i = 0; i < 20_000; i++) {
      p *= 1 + (rnd() - 0.5) * 0.002;
      m.trade(p, rnd());
      if (i % 100 === 99) { oi *= 1 + (rnd() - 0.4) * 0.02; m.openInterest(oi); }
    }
    const r = m.row(m.lastPrice);
    for (let i = Math.max(0, r); i < m.bins; i++) expect(m.longs[i]).toBe(0);
    for (let i = 0; i <= Math.min(m.bins - 1, r); i++) expect(m.shorts[i]).toBe(0);
    const c = m.clusters();
    if (c.long) expect(c.long.price).toBeLessThan(m.lastPrice);
    if (c.short) expect(c.short.price).toBeGreaterThan(m.lastPrice);
  });
});

describe('helpers', () => {
  it('shifts arrays both ways', () => {
    const a = new Float64Array([1, 2, 3, 4]);
    shiftArray(a, 1);
    expect([...a]).toEqual([2, 3, 4, 0]);
    shiftArray(a, -2);
    expect([...a]).toEqual([0, 0, 2, 3]);
    shiftArray(a, 9);
    expect([...a]).toEqual([0, 0, 0, 0]);
  });
  it('maps spot symbols to USD-M perps', () => {
    expect(futuresSymbol('BTCUSDT')).toEqual({ symbol: 'BTCUSDT', mult: 1 });
    expect(futuresSymbol('PEPEUSDT')).toEqual({ symbol: '1000PEPEUSDT', mult: 1000 });
  });
  it('formats', () => {
    expect(niceStep(23)).toBe(20);
    expect(niceStep(0.0031)).toBeCloseTo(0.005);
    expect(compact(12_345_678)).toBe('$12M');
    expect(compact(1_500)).toBe('$1.5k');
  });
});
