import { describe, expect, it } from 'vitest';
import { bollinger, macd, rsi, sma, stochastic, vwap, obv, donchian } from '../src/patterns/indicators';
import { computeAll, defaultIndicators, indLabel, newIndicator, normalizeIndicators, MAX_SUB_PANES } from '../src/indicators/spec';
import { normalizeChartPrefs } from '../src/ui/prefs';

const ramp = (n: number, f = (i: number) => i + 1) => Array.from({ length: n }, (_, i) => f(i));

describe('indicator math', () => {
  it('sma averages the last n values', () => {
    const s = sma([1, 2, 3, 4, 5], 3);
    expect(Number.isNaN(s[1])).toBe(true);
    expect([...s.slice(2)]).toEqual([2, 3, 4]);
  });

  it('bollinger bands are symmetric around the sma', () => {
    const c = [1, 3, 1, 3, 1, 3];
    const [m, up, lo] = bollinger(c, 2, 2);
    expect(m[5]).toBe(2);
    expect(up[5]).toBeCloseTo(4); // sd 1
    expect(lo[5]).toBeCloseTo(0);
  });

  it('rsi is 100 on a straight climb and 0 on a straight fall', () => {
    expect(rsi(ramp(30), 14)[29]).toBe(100);
    expect(rsi(ramp(30, (i) => 100 - i), 14)[29]).toBe(0);
    const r = rsi(ramp(40, (i) => 100 + (i % 2 ? 1 : -1)), 14)[39];
    expect(r).toBeGreaterThan(40);
    expect(r).toBeLessThan(60);
  });

  it('macd histogram is macd minus signal, signal starts after slow + signal bars', () => {
    const c = ramp(80, (i) => 100 + Math.sin(i / 5) * 10);
    const [line, sig, hist] = macd(c, 12, 26, 9);
    expect(Number.isNaN(sig[25 + 7])).toBe(true);
    expect(Number.isNaN(sig[25 + 8])).toBe(false);
    expect(hist[60]).toBeCloseTo(line[60] - sig[60]);
  });

  it('stochastic sits at 100 when closing at the high', () => {
    const h = ramp(30), l = ramp(30, (i) => i), c = h;
    const [k, d] = stochastic(h, l, c, 14, 3, 3);
    expect(k[29]).toBeCloseTo(100);
    expect(d[29]).toBeCloseTo(100);
  });

  it('session vwap restarts at each UTC day; rolling vwap uses the window', () => {
    const day = 86_400_000;
    const t = [0, 3_600_000, day, day + 3_600_000];
    const p = [10, 20, 30, 40];
    const v = [1, 3, 1, 1];
    const s = vwap(t, p, p, p, v, 0);
    expect(s[1]).toBeCloseTo((10 + 60) / 4);
    expect(s[2]).toBe(30); // new day
    const r = vwap(t, p, p, p, v, 2);
    expect(r[3]).toBeCloseTo(35);
  });

  it('obv and donchian', () => {
    expect([...obv([1, 2, 1, 1], [5, 5, 3, 9])]).toEqual([0, 5, 2, 2]);
    const [mid, up, lo] = donchian([5, 7, 6], [1, 2, 3], 2);
    expect([up[2], lo[2], mid[2]]).toEqual([7, 2, 4.5]);
  });
});

describe('indicator settings', () => {
  it('defaults keep the old EMA 20 / EMA 50 and volume', () => {
    expect(defaultIndicators().map(indLabel)).toEqual(['EMA 20', 'EMA 50', 'VOL']);
  });

  it('repairs stored lists', () => {
    const l = normalizeIndicators([
      { id: 'a', kind: 'rsi', params: [9999], color: 3, on: true },
      { id: 'a', kind: 'bb', params: [20, 2.04], color: -1 },
      { kind: 'nope' },
      'junk',
    ]);
    expect(l.map((c) => c.kind)).toEqual(['rsi', 'bb']);
    expect(l[0].params).toEqual([200]);
    expect(l[1].id).not.toBe('a');
    expect(l[1].params[1]).toBeCloseTo(2);
    expect(l[1].color).toBe(7);
    expect(normalizeIndicators('x')).toEqual(defaultIndicators());
  });

  it('new indicators get unique ids and an unused colour', () => {
    const d = defaultIndicators();
    const n = newIndicator('ema', d);
    expect(n.id).toBe('ema-3');
    expect(n.color).toBe(2);
    expect(n.params).toEqual([20]);
  });

  it('computes enabled ones only and caps the lower panes', () => {
    const n = 60;
    const c = new Float64Array(ramp(n));
    const s = { t: c, o: c, h: c, l: c, c, v: c };
    const list = [
      ...defaultIndicators(),
      { ...newIndicator('sma', []), on: false },
      ...Array.from({ length: MAX_SUB_PANES + 2 }, (_, i) => ({ ...newIndicator('rsi', []), id: `rsi-${i}` })),
    ];
    const out = computeAll(list, s);
    expect(out.filter((x) => x.pane === 'sub')).toHaveLength(MAX_SUB_PANES);
    expect(out.some((x) => x.kind === 'sma')).toBe(false);
    expect(out.every((x) => x.lines.every((a) => a.length === n))).toBe(true);
  });

  it('chart prefs fall back to defaults', () => {
    const p = normalizeChartPrefs({ interval: 7, showLiquidations: false });
    expect(p.interval).toBe(15);
    expect(p.showLiquidations).toBe(false);
    expect(p.showChartPatterns).toBe(true);
    expect(normalizeChartPrefs({ interval: 1440 }).interval).toBe(1440);
  });
});
