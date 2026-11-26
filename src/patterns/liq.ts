/**
 * Liquidation context for the pattern detectors: the estimated liquidation map
 * (the same columns the chart draws as bands) reduced to a few numbers per
 * candle, in the chart's own prices.
 *
 * The map is a model built from open interest and volume (src/liquidation),
 * so these are estimates: "longs that would have been liquidated" means the
 * modelled long positions whose liquidation price the bar traded through.
 */

/** The liquidation map as the analytics worker holds it (a LiqFrame, kept up to date with tails). */
export interface LiqData {
  stepMs: number;
  t0: number;
  cols: number;
  bins: number;
  /** futures price of row 0's lower edge, and row height */
  origin: number;
  binStep: number;
  /** futures last price, to rescale onto the chart */
  lastPrice: number;
  /** cols * bins, column-major */
  data: Float32Array;
  /** actual liquidation prints: [t, price, notional, side(1 long, -1 short)] * n */
  events: Float64Array;
}

export interface LiqCtx {
  /** estimated notional of longs liquidated by bar i (bar traded down through them), plus actual long prints */
  longLiq: Float64Array;
  /** the same for shorts (bar traded up through them) */
  shortLiq: Float64Array;
  /** heaviest band below bar i's open in the map as it stood before the bar: price and notional (NaN / 0 when none) */
  belowP: Float64Array;
  belowN: Float64Array;
  /** heaviest band above bar i's open */
  aboveP: Float64Array;
  aboveN: Float64Array;
  /** mean band notional within the search range, for "is this band heavy" */
  bandMean: Float64Array;
}

/** Bands are summed over this many rows. */
const SPAN = 4;
/** How far from the open the heaviest band is searched (share of price). */
const REACH = 0.08;

/** Candle i -> the last column that opens inside the candle (as src/render/liq.ts draws it). */
function colOf(t: ArrayLike<number>, i: number, d: LiqData): number {
  const end = i + 1 < t.length ? t[i + 1] - 1 : t[i] + d.stepMs - 1;
  const c = Math.floor((end - d.t0) / d.stepMs);
  return c < 0 ? -1 : Math.min(c, d.cols - 1);
}

/**
 * Per-candle liquidation numbers, or null when the map does not line up with
 * the candles (no data, or prices more than e^3 apart, like the chart's check).
 * `last` is the chart's latest price when the candles are a slice of it.
 */
export function liqContext(t: ArrayLike<number>, o: ArrayLike<number>, h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, d: LiqData | null, last?: number): LiqCtx | null {
  const n = t.length;
  if (!d || !n || d.cols <= 0 || !(d.lastPrice > 0) || d.stepMs <= 0) return null;
  // futures -> chart price, matched at the latest price (a window in the past passes the live close)
  const k = (last ?? c[n - 1]) / d.lastPrice;
  if (!(k > 0) || Math.abs(Math.log(k)) > 3) return null;
  const out: LiqCtx = {
    longLiq: new Float64Array(n), shortLiq: new Float64Array(n),
    belowP: new Float64Array(n).fill(NaN), belowN: new Float64Array(n), aboveP: new Float64Array(n).fill(NaN), aboveN: new Float64Array(n),
    bandMean: new Float64Array(n),
  };
  const B = d.bins;
  const row = (p: number) => Math.floor((p / k - d.origin) / d.binStep);
  const priceOf = (r: number) => (d.origin + (r + 0.5) * d.binStep) * k;
  const clampR = (r: number) => Math.max(0, Math.min(B - 1, r));
  for (let i = 1; i < n; i++) {
    const cPrev = colOf(t, i - 1, d);
    if (cPrev < 0) continue;
    const base = cPrev * B;
    const col = d.data;
    // traded through: below the prior close down to the low (longs), above it up to the high (shorts)
    const ref = c[i - 1];
    const rRef = row(ref);
    const rLo = clampR(row(l[i])), rHi = clampR(row(h[i]));
    let ll = 0, sl = 0;
    for (let r = rLo; r < clampR(rRef); r++) ll += col[base + r];
    for (let r = clampR(rRef) + 1; r <= rHi; r++) sl += col[base + r];
    out.longLiq[i] = ll; out.shortLiq[i] = sl;
    // heaviest band either side of the open
    const r0 = row(o[i]);
    const reach = Math.max(SPAN, Math.round((o[i] * REACH) / k / d.binStep));
    let best = 0, bestR = -1, sum = 0, cnt = 0;
    for (let r = Math.max(0, r0 - reach); r + SPAN <= Math.min(B, r0); r++) {
      let s = 0;
      for (let j = 0; j < SPAN; j++) s += col[base + r + j];
      sum += s; cnt++;
      if (s > best) { best = s; bestR = r; }
    }
    if (bestR >= 0 && best > 0) { out.belowP[i] = priceOf(bestR + SPAN / 2 - 0.5); out.belowN[i] = best; }
    best = 0; bestR = -1;
    for (let r = Math.max(0, r0 + 1); r + SPAN <= Math.min(B, r0 + 1 + reach); r++) {
      let s = 0;
      for (let j = 0; j < SPAN; j++) s += col[base + r + j];
      sum += s; cnt++;
      if (s > best) { best = s; bestR = r; }
    }
    if (bestR >= 0 && best > 0) { out.aboveP[i] = priceOf(bestR + SPAN / 2 - 0.5); out.aboveN[i] = best; }
    out.bandMean[i] = cnt ? sum / cnt : 0;
  }
  // actual prints add to their bar
  const ev = d.events;
  for (let e = 0; e + 3 < ev.length; e += 4) {
    const te = ev[e];
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] <= te) lo = m + 1; else hi = m; }
    const i = lo - 1;
    if (i < 0) continue;
    if (ev[e + 3] > 0) out.longLiq[i] += ev[e + 2]; else out.shortLiq[i] += ev[e + 2];
  }
  return out;
}

/** Keep a LiqData up to date with a tail message (newest column). */
export function applyTail(d: LiqData, tail: { col: number; lastPrice: number; data: Float32Array; events: Float64Array }): void {
  if (!d.bins || tail.data.length !== d.bins) return;
  const need = (tail.col + 1) * d.bins;
  if (need > d.data.length) {
    const grown = new Float32Array(Math.max(need, d.data.length * 2));
    grown.set(d.data.subarray(0, d.cols * d.bins));
    d.data = grown;
  }
  d.data.set(tail.data, tail.col * d.bins);
  d.cols = Math.max(d.cols, tail.col + 1);
  if (tail.lastPrice > 0) d.lastPrice = tail.lastPrice;
  d.events = tail.events;
}
