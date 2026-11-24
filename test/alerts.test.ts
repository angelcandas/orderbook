import { describe, it, expect } from 'vitest';
import { AlertChecker, armed, inferDirection, midOf, parseAlerts, reached, saveAlerts, loadAlerts, STORAGE_KEY, type Alert } from '../src/alerts/alerts';

const mk = (o: Partial<Alert>): Alert => ({ id: 'a', venue: 'kraken', symbol: 'BTC/USD', label: 'BTC/USD', price: 100, dir: 'above', created: 1, ...o });

describe('alert rules', () => {
  it('infers direction from the current price', () => {
    expect(inferDirection(110, 100)).toBe('above');
    expect(inferDirection(90, 100)).toBe('below');
    expect(inferDirection(90, NaN)).toBe('above');
  });
  it('fires at or past the level only', () => {
    expect(reached({ price: 100, dir: 'above' }, 99.99)).toBe(false);
    expect(reached({ price: 100, dir: 'above' }, 100)).toBe(true);
    expect(reached({ price: 100, dir: 'below' }, 100.01)).toBe(false);
    expect(reached({ price: 100, dir: 'below' }, 99)).toBe(true);
    expect(reached({ price: 100, dir: 'below' }, NaN)).toBe(false);
  });
  it('mid is NaN with an empty side', () => {
    expect(midOf(99, 101)).toBe(100);
    expect(midOf(NaN, 101)).toBeNaN();
  });
  it('sends each venue only its armed alerts', () => {
    const list = [mk({ id: '1' }), mk({ id: '2', venue: 'binance', symbol: 'BTCUSDT' }), mk({ id: '3', firedAt: 5 })];
    expect(armed(list, 'kraken').map((a) => a.id)).toEqual(['1']);
    expect(armed(list, 'binance')).toEqual([{ id: '2', symbol: 'BTCUSDT', price: 100, dir: 'above' }]);
  });
});

describe('AlertChecker', () => {
  it('fires once per alert and ignores books that are not live', () => {
    const c = new AlertChecker();
    c.set([
      { id: 'up', symbol: 'BTC/USD', price: 100, dir: 'above' },
      { id: 'down', symbol: 'BTC/USD', price: 90, dir: 'below' },
      { id: 'eth', symbol: 'ETH/USD', price: 1, dir: 'above' },
    ]);
    const px: Record<string, number> = { 'BTC/USD': 95, 'ETH/USD': NaN };
    const priceOf = (s: string) => px[s] ?? NaN;
    expect(c.check(priceOf, 1)).toEqual([]);
    px['BTC/USD'] = 101;
    expect(c.check(priceOf, 2)).toEqual([{ type: 'alert', id: 'up', price: 101, t: 2 }]);
    expect(c.check(priceOf, 3)).toEqual([]);
    px['BTC/USD'] = 80;
    expect(c.check(priceOf, 4).map((h) => h.id)).toEqual(['down']);
    expect(c.size).toBe(1); // eth still waiting for a live book
  });
});

describe('alert storage', () => {
  it('round-trips and drops malformed entries', () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    saveAlerts([mk({ id: 'x' })], st);
    expect(loadAlerts(st).map((a) => a.id)).toEqual(['x']);
    m.set(STORAGE_KEY, JSON.stringify([mk({ id: 'ok' }), { id: 'bad', price: 'x' }, mk({ id: 'neg', price: -1 })]));
    expect(loadAlerts(st).map((a) => a.id)).toEqual(['ok']);
    expect(parseAlerts('{not json')).toEqual([]);
    expect(parseAlerts(null)).toEqual([]);
  });
});
