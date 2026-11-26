import { describe, expect, it } from 'vitest';
import {
  AI_CHECK_MS, AI_COOLDOWN_MS, FEE, START_CASH, buy, decide, equity, finish, newGame, observe, parseSaved, record, sell, serialize, signals, tick, trade, wallet,
  type AiMemory, type Game,
} from '../src/game/game';
import type { PatternHit } from '../src/patterns/types';

const T0 = Date.UTC(2026, 10, 26, 12);
const game = (minutes = 15): Game => newGame({ venue: 'kraken', symbol: 'BTC/USD', label: 'BTC/USD', base: 'BTC', minutes, now: T0, id: 'g' });

describe('wallets', () => {
  it('buys at the ask and sells at the bid with a fee each way', () => {
    const b = buy(wallet(), 1000, 100)!;
    expect(b.fee).toBeCloseTo(1);
    expect(b.qty).toBeCloseTo(9.99);
    expect(b.wallet.cash).toBeCloseTo(9000);
    const s = sell(b.wallet, b.qty, 100)!;
    expect(s.wallet.qty).toBe(0);
    expect(s.wallet.cash).toBeCloseTo(9000 + 999 * (1 - FEE));
  });
  it('refuses orders under the minimum and caps buys at the cash held', () => {
    expect(buy(wallet(), 5, 100)).toBeNull();
    expect(buy(wallet(), 50_000, 100)!.wallet.cash).toBe(0);
    const w = buy(wallet(), 1000, 100)!.wallet;
    expect(sell(w, 0.01, 100)).toBeNull(); // $1 of coin, not all of it
    expect(sell({ ...w, qty: 0.01 }, 0.01, 100)!.wallet.qty).toBe(0); // the last crumbs can always go
  });
  it('values holdings at what they would fetch now', () => {
    const w = buy(wallet(), START_CASH, 100)!.wallet;
    expect(equity(w, 110)).toBeCloseTo(w.qty * 110 * (1 - FEE));
    expect(equity(wallet(), NaN)).toBe(START_CASH);
  });
});

describe('a game', () => {
  it('records trades and picks the winner when sold out at the bid', () => {
    let g = trade(game(), 'you', 'buy', 10_000, 99.9, 100, T0 + 1000)!;
    g = finish(g, 110, g.endsAt);
    expect(g.result!.winner).toBe('you');
    expect(g.result!.you).toBeGreaterThan(10_900);
    expect(g.result!.ai).toBe(START_CASH);
    expect(g.you.qty).toBe(0);
    expect(trade(g, 'you', 'buy', 100, 1, 1, g.endsAt + 1)).toBeNull(); // over: no more trading
  });
  it('is a tie when nobody trades', () => {
    expect(finish(game(), 100, T0).result!.winner).toBe('tie');
  });
  it('ends on the clock', () => {
    const g = tick(game(5), T0 + 5 * 60_000, 100, 100.1, [], 0);
    expect(g.result).toBeDefined();
    expect(g.result!.minutes).toBe(5);
  });
});

/** a memory that has watched `closes`, one per 5 s bar */
function watched(closes: number[]): AiMemory {
  let m = game().mem;
  closes.forEach((c, i) => { m = observe(m, T0 + i * 5000, c); });
  return m;
}

describe('the AI', () => {
  const up = Array.from({ length: 40 }, (_, i) => 100 + i * 0.05);
  const down = Array.from({ length: 40 }, (_, i) => 100 - i * 0.05);

  it('reads trend from the prices it watched', () => {
    expect(signals(watched(up), [], 0).find((s) => s.name === 'trend')!.value).toBeGreaterThan(0.5);
    expect(signals(watched(down), [], 0).find((s) => s.name === 'trend')!.value).toBeLessThan(-0.5);
    expect(signals(watched([100, 101]), [], 0)).toEqual([]); // not enough to go on yet
  });

  it('counts recent patterns on the chart and ignores old or failed ones', () => {
    const p = (o: Partial<PatternHit>): PatternHit => ({ id: 'x', kind: 'k', label: 'Bull flag', bias: 1, family: 'chart', start: 90, end: 99, pivots: [], lines: [], status: 'confirmed', score: 0.8, ...o });
    expect(signals(game().mem, [p({})], 100).find((s) => s.name === 'patterns')!.value).toBeGreaterThan(0.5);
    expect(signals(game().mem, [p({ end: 50 })], 100)).toEqual([]);
    expect(signals(game().mem, [p({ status: 'failed' })], 100)).toEqual([]);
  });

  it('buys into an uptrend and sells a downtrend, then waits', () => {
    const t = T0 + 600_000;
    const m = watched(up);
    const b = decide(m, wallet(), 102, 102.01, signals(m, [], 0), t);
    expect(b.move?.side).toBe('buy');
    expect(b.move!.amount).toBeGreaterThan(5000);
    // right after: no new check yet, then the cooldown holds it
    expect(decide(b.mem, wallet(), 102, 102.01, signals(m, [], 0), t + 1000).move).toBeNull();
    const md = watched(down);
    const held = buy(wallet(), 8000, 100)!.wallet;
    const s = decide({ ...md, lastTrade: t - AI_COOLDOWN_MS - 1 }, held, 98, 98.01, signals(md, [], 0), t + AI_CHECK_MS);
    expect(s.move?.side).toBe('sell');
  });

  it('cuts a loss below its entry even inside the cooldown', () => {
    const held = buy(wallet(), 8000, 100)!.wallet;
    const m: AiMemory = { ...watched([100, 100]), entry: 100, peak: 100, lastTrade: T0, lastCheck: 0 };
    const d = decide(m, held, 99.2, 99.21, [], T0 + 1000 + AI_CHECK_MS);
    expect(d.move).toMatchObject({ side: 'sell', amount: held.qty });
  });

  it('plays a whole game on a rising market and beats a player who does nothing', () => {
    let g = game(5);
    for (let t = 0; t <= 5 * 60_000; t += 1000) {
      const mid = 100 * (1 + 0.00002 * (t / 1000)); // about +0.6% over 5 minutes
      g = tick(g, T0 + t, mid - 0.005, mid + 0.005, [], 0);
    }
    expect(g.result).toBeDefined();
    expect(g.trades.some((x) => x.who === 'ai' && x.side === 'buy')).toBe(true);
    expect(g.result!.winner).toBe('ai');
  });
});

describe('saving', () => {
  it('round-trips a game and drops junk', () => {
    const g = trade(game(), 'you', 'buy', 1000, 99, 100, T0)!;
    const s = parseSaved(serialize({ game: g, results: [{ at: 1, label: 'BTC/USD', minutes: 5, you: 1, ai: 2, winner: 'ai' }], minutes: 30 }));
    expect(s.game!.you.qty).toBeCloseTo(g.you.qty);
    expect(Number.isNaN(s.game!.mem.entry)).toBe(true);
    expect(s.minutes).toBe(30);
    expect(parseSaved('nope')).toEqual({ game: null, results: [], minutes: 15 });
    expect(parseSaved(JSON.stringify({ game: { symbol: 1 }, minutes: 7 })).game).toBeNull();
  });
  it('keeps a win/loss record', () => {
    const r = (winner: 'you' | 'ai' | 'tie') => ({ at: 0, label: '', minutes: 5, you: 0, ai: 0, winner });
    expect(record([r('you'), r('ai'), r('you'), r('tie')])).toEqual({ wins: 2, losses: 1, ties: 1 });
  });
});
