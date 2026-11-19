import { describe, it, expect } from 'vitest';
import { crc32Ascii } from '../src/engine/crc32';
import { BookSide } from '../src/engine/side';
import { Book } from '../src/engine/book';

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32Ascii('123456789')).toBe(0xcbf43926);
  });
});

describe('BookSide', () => {
  it('keeps bids best-first and removes on zero', () => {
    const s = new BookSide(1, 5);
    s.set(100, 1); s.set(102, 2); s.set(101, 3);
    expect([s.tickAt(0), s.tickAt(1), s.tickAt(2)]).toEqual([102, 101, 100]);
    s.set(102, 0);
    expect(s.bestTick).toBe(101);
    expect(s.n).toBe(2);
  });
  it('keeps asks best-first', () => {
    const s = new BookSide(-1, 5);
    s.set(105, 1); s.set(103, 2); s.set(104, 3);
    expect([s.tickAt(0), s.tickAt(1), s.tickAt(2)]).toEqual([103, 104, 105]);
  });
  it('evicts the worst level when full and ignores worse inserts', () => {
    const s = new BookSide(1, 3);
    s.set(10, 1); s.set(11, 1); s.set(12, 1);
    expect(s.set(9, 1)).toBe(false);
    s.set(13, 1);
    expect([s.tickAt(0), s.tickAt(2), s.n]).toEqual([13, 11, 3]);
  });
  it('matches a reference map under random updates', () => {
    const s = new BookSide(-1, 10_000);
    const ref = new Map<number, number>();
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 50_000; i++) {
      const t = Math.floor(rnd() * 500);
      const q = rnd() < 0.3 ? 0 : Math.round(rnd() * 100) / 10;
      s.set(t, q);
      if (q === 0) ref.delete(t); else ref.set(t, q);
    }
    const sorted = [...ref.entries()].sort((a, b) => a[0] - b[0]);
    expect(s.n).toBe(sorted.length);
    sorted.forEach(([t, q], i) => { expect(s.tickAt(i)).toBe(t); expect(s.qtyAt(i)).toBe(q); });
  });
  it('truncates the worst levels', () => {
    const s = new BookSide(1, 10);
    for (let t = 1; t <= 8; t++) s.set(t, 1);
    expect(s.truncate(5)).toBe(3);
    expect([s.tickAt(0), s.tickAt(4)]).toEqual([8, 4]);
  });
});

describe('Kraken checksum string', () => {
  it('formats asks then bids with dots and leading zeros removed', () => {
    const b = new Book({ symbol: 'X', tickSize: 0.1, priceDecimals: 1, qtyDecimals: 8 }, 100);
    b.setAsk(45285.2, 0.001); b.setBid(45283.5, 0.5);
    // "452852" + "100000" + "452835" + "50000000"
    expect(b.krakenChecksum()).toBe(crc32Ascii('452852' + '100000' + '452835' + '50000000'));
  });
});
