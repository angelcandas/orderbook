import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { autoInterval, parseDate, parseInterval, parsePair, parsePeriod, summariseBook } from '../mcp/market';
import { chartSvg, decimals, png } from '../mcp/chart';
import { build } from '../mcp/server';
import { synthHistory } from '../server/sim';
import { MONTH } from '../src/shared/config';

describe('mcp input parsing', () => {
  it('reads pairs the way people type them', () => {
    expect(parsePair('btc')).toMatchObject({ base: 'BTC', quote: 'USD', binance: 'BTCUSDT', kraken: 'BTC/USD' });
    expect(parsePair('ETH/USDT')).toMatchObject({ binance: 'ETHUSDT', kraken: 'ETH/USD' });
    expect(parsePair('solusdc').binance).toBe('SOLUSDC');
    expect(parsePair('XBT-EUR')).toMatchObject({ base: 'BTC', binance: 'BTCEUR', kraken: 'BTC/EUR' });
    expect(() => parsePair('')).toThrow();
  });
  it('tells minutes from months', () => {
    expect(parseInterval('1m')).toBe(1);
    expect(parseInterval('1M')).toBe(MONTH);
    expect(parseInterval('1mo')).toBe(MONTH);
    expect(parseInterval('4h')).toBe(240);
    expect(parseInterval('1d')).toBe(1440);
    expect(parseInterval('1w')).toBe(10080);
    expect(() => parseInterval('7h')).toThrow();
  });
  it('reads periods, with m as months', () => {
    const day = 86_400_000;
    expect(parsePeriod('1d')).toBe(day);
    expect(parsePeriod('24h')).toBe(day);
    expect(parsePeriod('1m')).toBe(30 * day);
    expect(parsePeriod('3 months')).toBe(91 * day);
    expect(parsePeriod('2 weeks')).toBe(14 * day);
    expect(parsePeriod('10d')).toBe(10 * day);
  });
  it('reads dates', () => {
    expect(parseDate('2026-11-01')).toBe(Date.UTC(2026, 10, 1));
    expect(parseDate('1764000000')).toBe(1764000000_000);
    expect(() => parseDate('soon')).toThrow();
  });
  it('picks a candle size that fits the range', () => {
    const day = 86_400_000;
    expect(autoInterval(day)).toBe(15);
    expect(autoInterval(7 * day)).toBe(60);
    expect(autoInterval(30 * day)).toBe(240);
    expect(autoInterval(365 * day)).toBe(4320);
  });
  it('summarises a book', () => {
    const b = summariseBook([[100, 2], [99.5, 2], [90, 100]], [[100.1, 1], [100.5, 1], [120, 100]]);
    expect(b.mid).toBeCloseTo(100.05);
    expect(b.spreadBps).toBeCloseTo(10, 0);
    expect(b.imbalance).toBeGreaterThan(0);
  });
});

describe('mcp chart', () => {
  const cs = synthHistory(100, 300, 3_600_000, 7).map((c, i) => ({ ...c, t: Date.UTC(2026, 9, 1) + i * 3_600_000 }));
  it('draws candles, a pattern, a window and a forecast cone, and rasterises', () => {
    const svg = chartSvg({
      title: 'T <&>', interval: 60, candles: cs, first: 50,
      patterns: [{ n: 1, id: 'x', kind: 'double-top', label: 'Double top', bias: -1, family: 'chart', start: 100, end: 140, pivots: [{ i: 100, p: cs[100].h }, { i: 120, p: cs[120].l }, { i: 140, p: cs[140].h }], lines: [[{ i: 100, p: cs[120].l }, { i: 140, p: cs[120].l }]], status: 'confirmed', target: cs[120].l * 0.98, score: 0.8 }],
      window: { t0: cs[90].t, t1: cs[200].t },
      forecast: { horizon: 20, top: cs[299].c * 1.05, mid: cs[299].c, bottom: cs[299].c * 0.95 },
      liquidity: { rows: [[cs[299].c * 0.97, 10, 0], [cs[299].c * 1.03, 0, 8]], long: { price: cs[299].c * 0.97 }, short: { price: cs[299].c * 1.03 } },
    });
    expect(svg).toContain('#1 Double top');
    expect(svg).toContain('T &lt;&amp;&gt;');
    expect(svg).toContain('Forecast, 20 bars');
    const img = png(svg);
    expect([...img.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
  });
  it('shows prices with about five significant digits', () => {
    expect(decimals(108000)).toBe(2);
    expect(decimals(1.2345)).toBe(4);
    expect(decimals(0.00001234)).toBe(8);
  });
});

describe('mcp server', () => {
  afterEach(() => vi.unstubAllGlobals());

  // Binance-shaped REST answers from the synthetic history
  function stubExchange() {
    const hist = new Map<string, any[]>();
    vi.stubGlobal('fetch', async (url: string) => {
      const u = new URL(url);
      const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
      if (u.pathname.endsWith('/depth')) return json({ bids: [['100', '5'], ['99.9', '5']], asks: [['100.1', '4'], ['100.2', '4']] });
      if (u.pathname.endsWith('/openInterestHist')) return json([]);
      if (u.pathname.endsWith('/klines')) {
        const iv = u.searchParams.get('interval')!;
        const ms = { '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000, '15m': 900_000 }[iv] ?? 3_600_000;
        const end = Number(u.searchParams.get('endTime') ?? Date.now());
        const limit = Number(u.searchParams.get('limit') ?? 500);
        const key = iv;
        if (!hist.has(key)) {
          const n = 3000, last = Math.floor(Date.now() / ms) * ms;
          hist.set(key, synthHistory(100, n, ms, 3).map((c, i) => [last - (n - 1 - i) * ms, `${c.o}`, `${c.h}`, `${c.l}`, `${c.c}`, `${c.v}`]));
        }
        const rows = hist.get(key)!.filter((r) => r[0] <= end);
        return json(rows.slice(-limit));
      }
      return new Response('nope', { status: 404 });
    });
  }

  async function client() {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'test', version: '1' });
    await Promise.all([build().connect(a), c.connect(b)]);
    return c;
  }

  it('lists its tools', async () => {
    const c = await client();
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['forecast', 'liquidation_levels', 'list_markets', 'market_status', 'pattern_chart', 'price_chart']);
  });

  it('answers status, charts and forecasts from the exchange data', async () => {
    stubExchange();
    const c = await client();
    const st: any = await c.callTool({ name: 'market_status', arguments: { pair: 'BTC' } });
    expect(st.isError).toBeFalsy();
    expect(st.content[0].text).toMatch(/BTC\/USD on Binance/);
    expect(st.structuredContent.last).toBeGreaterThan(0);

    const ch: any = await c.callTool({ name: 'price_chart', arguments: { pair: 'BTC', period: '1w' } });
    expect(ch.isError).toBeFalsy();
    expect(ch.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(ch.content[1].text).toMatch(/1h candles/);

    const pc: any = await c.callTool({ name: 'pattern_chart', arguments: { pair: 'ETH', period: '2m', interval: '1d' } });
    expect(pc.isError).toBeFalsy();
    expect(pc.content[0].type).toBe('image');
    expect(pc.content[1].text).toMatch(/patterns/);

    const fc: any = await c.callTool({ name: 'forecast', arguments: { pair: 'BTC', interval: '4h', horizon: 10 } });
    expect(fc.isError).toBeFalsy();
    expect(fc.structuredContent.horizon).toBe(10);
    expect(fc.structuredContent.bottom).toBeLessThan(fc.structuredContent.top);

    const long: any = await c.callTool({ name: 'forecast', arguments: { pair: 'BTC', interval: '1h', horizon: 150 } });
    expect(long.isError).toBeFalsy();
    expect(long.structuredContent.horizon).toBe(150);
  }, 30_000);

  it('turns bad input into a readable error', async () => {
    const c = await client();
    const r: any = await c.callTool({ name: 'price_chart', arguments: { pair: 'BTC', interval: '7h' } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown interval/);
  });
});
