import { describe, it, expect } from 'vitest';
import {
  MarketIndex, allPairs, binanceMarkets, builtinCatalog, krakenMarkets, liveSymbols, normAsset,
  quoteRanking, searchPairs, splitLabel, toggleFavourite, type Catalog,
} from '../src/shared/pairs';

const catalog: Catalog = {
  kraken: krakenMarkets([
    { symbol: 'BTC/USD', base: 'BTC', quote: 'USD', status: 'online' },
    { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', status: 'online' },
    { symbol: 'ETH/EUR', base: 'ETH', quote: 'EUR', status: 'online' },
    { symbol: 'DOGE/USD', status: 'online' },
    { symbol: 'OLD/USD', status: 'delisted' },
  ]),
  binance: binanceMarkets({
    symbols: [
      { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' },
      { symbol: 'ETHEUR', baseAsset: 'ETH', quoteAsset: 'EUR', status: 'TRADING' },
      { symbol: 'ETHBTC', baseAsset: 'ETH', quoteAsset: 'BTC', status: 'TRADING' },
      { symbol: 'SOLUSDC', baseAsset: 'SOL', quoteAsset: 'USDC', status: 'TRADING' },
      { symbol: 'HALTUSDT', baseAsset: 'HALT', quoteAsset: 'USDT', status: 'BREAK' },
    ],
  }),
};

describe('pairs', () => {
  it('normalises Kraken legacy asset codes and labels', () => {
    expect(normAsset('XBT')).toBe('BTC');
    expect(normAsset('xdg')).toBe('DOGE');
    expect(splitLabel('xbt/eur')).toEqual({ base: 'BTC', quote: 'EUR' });
    expect(splitLabel('BTCUSD')).toBeNull();
  });

  it('reads only tradable markets from each venue', () => {
    expect(catalog.kraken.map((m) => m.symbol)).toEqual(['BTC/USD', 'BTC/USDT', 'ETH/EUR', 'DOGE/USD']);
    expect(catalog.binance.map((m) => m.symbol)).toEqual(['BTCUSDT', 'ETHEUR', 'ETHBTC', 'SOLUSDC']);
  });

  it('maps a pair to each venue symbol, exact first, then a USD stand in', () => {
    const k = new MarketIndex(catalog.kraken);
    const b = new MarketIndex(catalog.binance);
    expect(k.resolve('ETH/EUR')).toEqual({ symbol: 'ETH/EUR', base: 'ETH', quote: 'EUR', standIn: false });
    expect(b.resolve('ETH/EUR')?.symbol).toBe('ETHEUR');
    expect(k.resolve('BTC/USDT')?.symbol).toBe('BTC/USDT');
    expect(b.resolve('BTC/USD')).toEqual({ symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', standIn: true });
    expect(b.resolve('SOL/USD')?.symbol).toBe('SOLUSDC');
    expect(k.resolve('ETH/BTC')).toBeNull(); // no stand in across non dollar quotes
    expect(b.resolve('ETH/GBP')).toBeNull();
  });

  it('lists each pair once with where it trades', () => {
    const list = allPairs(catalog);
    const eth = list.find((p) => p.label === 'ETH/EUR')!;
    expect(eth).toMatchObject({ kraken: true, binance: true });
    expect(list.find((p) => p.label === 'ETH/BTC')).toMatchObject({ kraken: false, binance: true });
    expect(new Set(list.map((p) => p.label)).size).toBe(list.length);
    expect(list[0].base).toBe('BTC'); // well known assets first
  });

  it('searches by base, by base/quote, and by quote filter', () => {
    const list = allPairs(catalog);
    expect(searchPairs(list, 'eth', null).map((p) => p.label)).toEqual(['ETH/EUR', 'ETH/BTC']);
    expect(searchPairs(list, 'eth/eu', null).map((p) => p.label)).toEqual(['ETH/EUR']);
    expect(searchPairs(list, 'eth eur', null).map((p) => p.label)).toEqual(['ETH/EUR']);
    expect(searchPairs(list, 'btcusdt', null).map((p) => p.label)).toEqual(['BTC/USDT']);
    expect(searchPairs(list, '', 'EUR').map((p) => p.label)).toEqual(['ETH/EUR']);
    expect(quoteRanking(catalog).slice(0, 3)).toEqual(['USD', 'USDT', 'USDC']);
  });

  it('keeps the focused book plus built ins up to the load', () => {
    const builtin = ['BTC/USD', 'ETH/USD', 'SOL/USD'];
    expect(liveSymbols('ETH/EUR', builtin, 1)).toEqual(['ETH/EUR']);
    expect(liveSymbols('ETH/EUR', builtin, 3)).toEqual(['ETH/EUR', 'BTC/USD', 'ETH/USD']);
    expect(liveSymbols('ETH/USD', builtin, 2)).toEqual(['ETH/USD', 'BTC/USD']);
    expect(liveSymbols(null, builtin, 1)).toEqual(['BTC/USD']);
  });

  it('toggles favourites and keeps the built in catalogue consistent', () => {
    expect(toggleFavourite(['BTC/USD'], 'ETH/EUR')).toEqual(['BTC/USD', 'ETH/EUR']);
    expect(toggleFavourite(['BTC/USD', 'ETH/EUR'], 'BTC/USD')).toEqual(['ETH/EUR']);
    const c = builtinCatalog();
    expect(new MarketIndex(c.binance).resolve('BTC/USD')?.symbol).toBe('BTCUSDT');
    expect(new MarketIndex(c.kraken).resolve('BTC/USD')?.symbol).toBe('BTC/USD');
  });
});
