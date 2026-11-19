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
