export function ema(src: ArrayLike<number>, n: number, out: Float64Array = new Float64Array(src.length)): Float64Array {
  const k = 2 / (n + 1);
  let e = NaN;
  for (let i = 0; i < src.length; i++) {
    if (i < n - 1) { out[i] = NaN; continue; }
    if (i === n - 1) {
      let s = 0;
      for (let j = 0; j < n; j++) s += src[j];
      e = s / n;
    } else e = src[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/** Wilder's average true range */
export function atr(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, n = 14, out: Float64Array = new Float64Array(c.length)): Float64Array {
  let a = NaN;
  let sum = 0;
  for (let i = 0; i < c.length; i++) {
    const tr = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i < n) {
      sum += tr;
      out[i] = i === n - 1 ? (a = sum / n) : sum / (i + 1);
    } else {
      a = (a * (n - 1) + tr) / n;
      out[i] = a;
    }
  }
  return out;
}

/** simple moving average; NaN until `n` values */
export function sma(src: ArrayLike<number>, n: number, out: Float64Array = new Float64Array(src.length)): Float64Array {
  let s = 0;
  for (let i = 0; i < src.length; i++) {
    s += src[i];
    if (i >= n) s -= src[i - n];
    out[i] = i >= n - 1 ? s / n : NaN;
  }
  return out;
}

/** EMA that skips leading NaNs (for indicators of indicators, e.g. the MACD signal) */
export function emaFrom(src: ArrayLike<number>, n: number, out: Float64Array = new Float64Array(src.length)): Float64Array {
  let start = 0;
  while (start < src.length && src[start] !== src[start]) out[start++] = NaN;
  const k = 2 / (n + 1);
  let e = NaN, s = 0;
  for (let i = start; i < src.length; i++) {
    const j = i - start;
    if (j < n - 1) { s += src[i]; out[i] = NaN; continue; }
    if (j === n - 1) e = (s + src[i]) / n;
    else e = src[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/** Bollinger bands: SMA `n` +- `k` population standard deviations. */
export function bollinger(c: ArrayLike<number>, n: number, k: number): [Float64Array, Float64Array, Float64Array] {
  const len = c.length;
  const mid = new Float64Array(len), up = new Float64Array(len), lo = new Float64Array(len);
  let s = 0, s2 = 0;
  for (let i = 0; i < len; i++) {
    s += c[i]; s2 += c[i] * c[i];
    if (i >= n) { s -= c[i - n]; s2 -= c[i - n] * c[i - n]; }
    if (i < n - 1) { mid[i] = up[i] = lo[i] = NaN; continue; }
    const m = s / n;
    const sd = Math.sqrt(Math.max(0, s2 / n - m * m));
    mid[i] = m; up[i] = m + k * sd; lo[i] = m - k * sd;
  }
  return [mid, up, lo];
}

/** Wilder's RSI */
export function rsi(c: ArrayLike<number>, n: number, out: Float64Array = new Float64Array(c.length)): Float64Array {
  let g = 0, l = 0;
  out[0] = NaN;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    const up = d > 0 ? d : 0, dn = d < 0 ? -d : 0;
    if (i <= n) {
      g += up; l += dn;
      if (i < n) { out[i] = NaN; continue; }
      g /= n; l /= n;
    } else {
      g = (g * (n - 1) + up) / n;
      l = (l * (n - 1) + dn) / n;
    }
    out[i] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  }
  return out;
}

/** MACD line, signal line and histogram */
export function macd(c: ArrayLike<number>, fast: number, slow: number, signal: number): [Float64Array, Float64Array, Float64Array] {
  const f = ema(c, fast), s = ema(c, slow);
  const line = new Float64Array(c.length);
  for (let i = 0; i < c.length; i++) line[i] = f[i] - s[i];
  const sig = emaFrom(line, signal);
  const hist = new Float64Array(c.length);
  for (let i = 0; i < c.length; i++) hist[i] = line[i] - sig[i];
  return [line, sig, hist];
}

/** Stochastic oscillator: %K over `n` bars smoothed by `smooth`, and %D = SMA(%K, d) */
export function stochastic(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, n: number, smooth: number, d: number): [Float64Array, Float64Array] {
  const len = c.length;
  const raw = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    if (i < n - 1) { raw[i] = NaN; continue; }
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) { if (h[j] > hi) hi = h[j]; if (l[j] < lo) lo = l[j]; }
    raw[i] = hi > lo ? ((c[i] - lo) / (hi - lo)) * 100 : 50;
  }
  const k = smaFrom(raw, smooth);
  return [k, smaFrom(k, d)];
}

/** SMA that skips leading NaNs */
export function smaFrom(src: ArrayLike<number>, n: number): Float64Array {
  const out = new Float64Array(src.length);
  let start = 0;
  while (start < src.length && src[start] !== src[start]) out[start++] = NaN;
  const tail = sma(Array.prototype.slice.call(src, start) as number[], n);
  out.set(tail, start);
  return out;
}

/**
 * Volume weighted average price of the typical price (h + l + c) / 3. With
 * `period` 0 it restarts at each UTC day (the usual session VWAP), otherwise it
 * is a rolling window of `period` bars.
 */
export function vwap(t: ArrayLike<number>, h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, v: ArrayLike<number>, period: number): Float64Array {
  const len = c.length;
  const out = new Float64Array(len);
  let pv = 0, vv = 0, day = -1;
  for (let i = 0; i < len; i++) {
    const tp = (h[i] + l[i] + c[i]) / 3;
    if (period <= 0) {
      const d = Math.floor(t[i] / 86_400_000);
      if (d !== day) { day = d; pv = 0; vv = 0; }
    } else if (i >= period) {
      const j = i - period;
      pv -= ((h[j] + l[j] + c[j]) / 3) * v[j];
      vv -= v[j];
    }
    pv += tp * v[i]; vv += v[i];
    out[i] = vv > 0 ? pv / vv : tp;
    if (period > 0 && i < period - 1) out[i] = NaN;
  }
  return out;
}

/** Donchian channel: highest high and lowest low of `n` bars, and their middle */
export function donchian(h: ArrayLike<number>, l: ArrayLike<number>, n: number): [Float64Array, Float64Array, Float64Array] {
  const len = h.length;
  const mid = new Float64Array(len), up = new Float64Array(len), lo = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    if (i < n - 1) { mid[i] = up[i] = lo[i] = NaN; continue; }
    let hi = -Infinity, lw = Infinity;
    for (let j = i - n + 1; j <= i; j++) { if (h[j] > hi) hi = h[j]; if (l[j] < lw) lw = l[j]; }
    up[i] = hi; lo[i] = lw; mid[i] = (hi + lw) / 2;
  }
  return [mid, up, lo];
}

/** On-balance volume */
export function obv(c: ArrayLike<number>, v: ArrayLike<number>): Float64Array {
  const out = new Float64Array(c.length);
  let s = 0;
  for (let i = 0; i < c.length; i++) {
    if (i > 0) s += c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0;
    out[i] = s;
  }
  return out;
}
