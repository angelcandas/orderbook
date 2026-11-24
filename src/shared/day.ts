/**
 * The ticker's 24 hour figures from the candles: the close 24 h before the
 * newest candle, and the high, low and base volume since. `hours` < 24 when the
 * history is shorter (or the candles are longer than a day: then it is the last candle's).
 */
export function dayStats(candles: { t: number; h: number; l: number; c: number; v: number }[]): { ref: number; hi: number; lo: number; vol: number; hours: number } | null {
  const n = candles.length;
  if (n < 2) return null;
  const end = candles[n - 1].t;
  const from = end - 86_400_000;
  let i = n - 1;
  while (i > 0 && candles[i - 1].t > from) i--;
  // the candle before the window holds the reference close
  const refIdx = Math.max(0, i - 1);
  let hi = -Infinity, lo = Infinity, vol = 0;
  for (let k = i; k < n; k++) { const c = candles[k]; if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; vol += c.v; }
  return { ref: candles[refIdx].c, hi, lo, vol, hours: Math.min(24, (end - candles[refIdx].t) / 3_600_000) };
}
