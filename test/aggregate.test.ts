import { describe, expect, it } from 'vitest';
import { aggregate, Aggregator } from '../src/feeds/aggregate';
import { bucketStart, nextBucket, MONTH, INTERVAL_DEFS, KRAKEN_NATIVE, binanceInterval } from '../src/shared/config';
import type { Candle } from '../src/patterns/candle';

const MIN = 60_000, DAY = 86_400_000;
const bars = (t0: number, step: number, n: number, closedAll = true): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ t: t0 + i * step, o: i + 1, h: i + 2, l: i, c: i + 1.5, v: 1, closed: closedAll || i < n - 1 }));

describe('intervals', () => {
  it('Kraken subscribes natively or to a smaller interval that divides it', () => {
    for (const d of INTERVAL_DEFS) {
      expect(KRAKEN_NATIVE).toContain(d.kraken);
      expect(d.kraken).toBeLessThanOrEqual(d.m);
      if (d.m !== MONTH && d.m !== 10080) expect(d.m % d.kraken).toBe(0);
    }
    expect(binanceInterval(MONTH)).toBe('1M');
    expect(binanceInterval(4320)).toBe('3d');
  });

  it('weeks start on Monday and months on the 1st (UTC)', () => {
    const wed = Date.UTC(2026, 10, 25, 13); // Wednesday 25 Nov 2026
    expect(new Date(bucketStart(wed, 10080)).toISOString()).toBe('2026-11-23T00:00:00.000Z');
    expect(new Date(bucketStart(wed, MONTH)).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(new Date(nextBucket(Date.UTC(2026, 11, 1), MONTH)).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(bucketStart(wed, 240)).toBe(Date.UTC(2026, 10, 25, 12));
  });
});

describe('aggregate', () => {
  it('rolls 1m into 3m with o/h/l/c/v', () => {
    const out = aggregate(bars(0, MIN, 6), 3, MIN);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ t: 0, o: 1, h: 4, l: 0, c: 3.5, v: 3, closed: true });
    expect(out[1]).toMatchObject({ t: 3 * MIN, o: 4, c: 6.5, closed: true });
  });

  it('drops a leading partial bucket, keeps the last one open until it ends', () => {
    const out = aggregate(bars(MIN, MIN, 4, false), 3, MIN); // 1,2 | 3,4(forming)
    expect(out).toHaveLength(1);
    expect(out[0].t).toBe(3 * MIN);
    expect(out[0].closed).toBe(false);
  });

  it('builds calendar months from days', () => {
    const t0 = Date.UTC(2026, 0, 1);
    const out = aggregate(bars(t0, DAY, 59), MONTH, DAY); // Jan (31) + Feb (28)
    expect(out.map((c) => new Date(c.t).getUTCMonth())).toEqual([0, 1]);
    expect(out[0].v).toBe(31);
    expect(out[1].v).toBe(28);
    expect(out[1].closed).toBe(true);
  });

  it('Aggregator merges snapshot, REST history and live updates', () => {
    const a = new Aggregator(3, MIN);
    a.merge(bars(6 * MIN, MIN, 2, false)); // snapshot: 6, 7
    const full = a.merge(bars(0, MIN, 7)); // REST: 0..6
    expect(full.map((c) => c.t)).toEqual([0, 3 * MIN, 6 * MIN]);
    const live = a.update({ t: 7 * MIN, o: 1, h: 100, l: 0, c: 50, v: 2, closed: false });
    expect(live).toMatchObject({ t: 6 * MIN, h: 100, c: 50, v: 3, closed: false });
    const next = a.update({ t: 9 * MIN, o: 50, h: 51, l: 49, c: 50, v: 1, closed: false });
    expect(next.t).toBe(9 * MIN);
    expect(next.v).toBe(1);
  });
});
