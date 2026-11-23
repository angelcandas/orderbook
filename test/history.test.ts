import { describe, it, expect } from 'vitest';
import { binanceHistory, krakenOhlc, krakenRestPair, stitchOlder, prepend, HISTORY_BARS } from '../src/feeds/history';
import { detect } from '../src/patterns/detect';
import { synthHistory } from '../server/sim';
import type { Candle } from '../src/patterns/candle';

const M = 60_000;
const bars = (t0: number, n: number, px = 100): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ t: t0 + i * M, o: px + i, h: px + i + 1, l: px + i - 1, c: px + i + 0.5, v: 2, closed: true }));

/** fake Binance klines endpoint over a fixed series, honouring limit and endTime */
function fakeKlines(all: Candle[]) {
  const calls: string[] = [];
  const fetchJson = async (u: string) => {
    calls.push(u);
    const q = new URL(u).searchParams;
    const limit = Math.min(1000, Number(q.get('limit')));
    const end = Number(q.get('endTime') ?? Infinity);
    return all.filter((c) => c.t <= end).slice(-limit).map((c) => [c.t, String(c.o), String(c.h), String(c.l), String(c.c), String(c.v)]);
  };
  return { fetchJson, calls };
}

describe('history backfill', () => {
  it('pages Binance klines backwards with endTime', async () => {
    const all = bars(0, 5000);
    const { fetchJson, calls } = fakeKlines(all);
    const before = all[4000].t;
    const got = await binanceHistory(fetchJson, 'http://x', 'BTCUSDT', '1m', before, 2500);
    expect(got.length).toBe(2500);
    expect(got[got.length - 1].t).toBe(all[3999].t);
    expect(got[0].t).toBe(all[1500].t);
    for (let i = 1; i < got.length; i++) expect(got[i].t - got[i - 1].t).toBe(M);
    expect(calls.length).toBe(3);
  });
  it('stops when the venue runs out of history', async () => {
    const all = bars(0, 1200);
    const { fetchJson } = fakeKlines(all);
    const got = await binanceHistory(fetchJson, 'http://x', 'BTCUSDT', '1m', all[1100].t, HISTORY_BARS);
    expect(got.length).toBe(1100);
  });
  it('rescales older bars from another venue to the recent price level', () => {
    const older = bars(0, 3000, 100);
    const recent = older.slice(2280).map((c) => ({ ...c, o: c.o * 1.001, h: c.h * 1.001, l: c.l * 1.001, c: c.c * 1.001, v: c.v / 4 }));
    const out = stitchOlder(older, recent);
    expect(out.length).toBe(2280);
    expect(out[out.length - 1].t).toBe(recent[0].t - M);
    expect(out[10].c).toBeCloseTo(older[10].c * 1.001, 6);
    expect(out[10].v).toBeCloseTo(0.5, 6);
  });
  it('stitches onto a short live snapshot', () => {
    const older = bars(0, 3000, 100);
    const snap = older.slice(2990).map((c, i) => ({ ...c, closed: i < 9 }));
    const out = stitchOlder(older, snap);
    expect(out.length).toBe(2990);
    expect(prepend(snap, out).length).toBe(3000);
  });
  it('reads Kraken REST OHLC and maps pair names', async () => {
    expect(krakenRestPair('BTC/USD')).toBe('XBTUSD');
    expect(krakenRestPair('DOGE/USD')).toBe('XDGUSD');
    expect(krakenRestPair('ETH/USD')).toBe('ETHUSD');
    const fetchJson = async (u: string) => {
      expect(u).toBe('http://k/0/public/OHLC?pair=XBTUSD&interval=5');
      return { error: [], result: { XXBTZUSD: [[1700000000, '1', '3', '0.5', '2', '1.9', '7.5', 4]], last: 1700000000 } };
    };
    const cs = await krakenOhlc(fetchJson, 'http://k', 'BTC/USD', 5);
    expect(cs).toEqual([{ t: 1700000000000, o: 1, h: 3, l: 0.5, c: 2, v: 7.5, closed: true }]);
  });
  it('refuses to stitch series that do not overlap', () => {
    expect(stitchOlder(bars(0, 100), bars(500 * M, 100))).toEqual([]);
  });
  it('prepends only contiguous bars and caps the length', () => {
    const list = bars(1000 * M, 500);
    expect(prepend(list, bars(0, 990)).length).toBe(500); // gap of 10 bars
    const merged = prepend(list, bars(0, 1000));
    expect(merged.length).toBe(1500);
    expect(merged[1000]).toBe(list[0]);
    expect(prepend(list, bars(0, 1000), 800).length).toBe(800);
  });
  it('detects patterns over a full backfilled history within a frame budget of the worker', () => {
    const cs = synthHistory(60_000, HISTORY_BARS, M, 7);
    detect(cs); // warm up
    const t0 = performance.now();
    const d = detect(cs);
    const ms = performance.now() - t0;
    expect(d.patterns.some((p) => p.family === 'chart')).toBe(true);
    console.log(`detect over ${cs.length} bars: ${ms.toFixed(1)} ms, ${d.patterns.filter((p) => p.family === 'chart').length} chart patterns`);
    expect(ms).toBeLessThan(250);
  });
});
