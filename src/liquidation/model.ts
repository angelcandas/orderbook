/**
 * Liquidation map: where leveraged futures positions would be force-closed.
 *
 * Exchanges don't publish anyone's liquidation price, so the levels are an
 * estimate built from public data, the same way the well-known heatmaps do it:
 *
 *  - every open-interest increase over a poll interval is treated as new
 *    positions opened at the prices traded in that interval (weighted by the
 *    interval's trade volume per price bin);
 *  - each new position is spread over a few common leverage tiers, and its
 *    liquidation price is entry * (1 -/+ 1/L +/- maintenance margin), longs
 *    below the entry and shorts above;
 *  - an open-interest drop closes positions pro rata everywhere;
 *  - when price trades through a level, those positions are gone (liquidated
 *    or stopped), so the level is cleared.
 *
 * Actual liquidations (Binance's forceOrder stream) are kept separately as
 * events; they are facts, the map is a model.
 *
 * Prices are binned in fixed relative steps around an anchor price. The grid
 * recentres (shifting the arrays) when price drifts towards an edge.
 */

export interface Tier { leverage: number; weight: number }

/** Leverage mix. A guess, like every public liquidation heatmap's. */
export const TIERS: Tier[] = [
  { leverage: 10, weight: 0.2 },
  { leverage: 25, weight: 0.3 },
  { leverage: 50, weight: 0.3 },
  { leverage: 100, weight: 0.2 },
];
/** Maintenance margin rate used for every tier (Binance's lowest bracket is 0.4%). */
export const MMR = 0.004;

export interface LiqEvent {
  t: number;
  price: number;
  qty: number;
  /** 'long' = a long was liquidated (the exchange SELLs), 'short' = BUY */
  side: 'long' | 'short';
}

export interface MapOptions {
  bins?: number; // rows in the grid
  binBps?: number; // bin height in basis points of the anchor price
}

export class LiqMap {
  readonly bins: number;
  readonly binBps: number;
  /** price of row 0's lower edge, and row height, in price units */
  origin = 0;
  step = 0;
  /** estimated notional (quote currency) that would be liquidated in each row */
  readonly longs: Float64Array;
  readonly shorts: Float64Array;
  /** traded volume (base units) per row since the last open-interest sample */
  private vol: Float64Array;
  private volTotal = 0;
  private lastRow = -1;
  lastPrice = 0;
  private oi = NaN;
  /** counts for the stats line */
  trades = 0;
  oiSamples = 0;
  /** set after a recentre so a renderer knows its history rows moved */
  shifted = 0;

  constructor(o: MapOptions = {}) {
    this.bins = o.bins ?? 480;
    this.binBps = o.binBps ?? 2.5;
    this.longs = new Float64Array(this.bins);
    this.shorts = new Float64Array(this.bins);
    this.vol = new Float64Array(this.bins);
  }

  get ready(): boolean { return this.step > 0; }

  row(price: number): number { return Math.floor((price - this.origin) / this.step); }
  priceOf(row: number): number { return this.origin + (row + 0.5) * this.step; }
  get low(): number { return this.origin; }
  get high(): number { return this.origin + this.bins * this.step; }

  private anchor(price: number): void {
    const raw = (price * this.binBps) / 10_000;
    // round the step to 1, 2 or 5 times a power of ten so labels stay tidy
    const p = 10 ** Math.floor(Math.log10(raw));
    const m = raw / p;
    this.step = (m < 1.5 ? 1 : m < 3.5 ? 2 : 5) * p;
    this.origin = Math.floor(price / this.step - this.bins / 2) * this.step;
  }

  /** Keep price in the middle 60% of the grid; returns rows shifted (+ = grid moved up). */
  private recentre(price: number): number {
    const r = this.row(price);
    const lo = this.bins * 0.2, hi = this.bins * 0.8;
    if (r >= lo && r < hi) return 0;
    const shift = r - Math.floor(this.bins / 2);
    for (const a of [this.longs, this.shorts, this.vol]) shiftArray(a, shift);
    this.origin += shift * this.step;
    this.lastRow -= shift;
    this.shifted += shift;
    return shift;
  }

  /** A trade on the futures market. */
  trade(price: number, qty: number): void {
    if (!(price > 0)) return;
    if (!this.ready) this.anchor(price);
    this.recentre(price);
    const r = this.row(price);
    this.trades++;
    if (r >= 0 && r < this.bins) { this.vol[r] += qty; this.volTotal += qty; }
    // price moved through levels: those positions no longer exist
    if (this.lastRow >= 0) {
      if (r < this.lastRow) clear(this.longs, Math.max(0, r), Math.min(this.bins - 1, this.lastRow));
      else if (r > this.lastRow) clear(this.shorts, Math.max(0, this.lastRow), Math.min(this.bins - 1, r));
    }
    // a level at the current row is hit too
    if (r >= 0 && r < this.bins) {
      this.longs[r] = 0;
      this.shorts[r] = 0;
    }
    this.lastRow = r;
    this.lastPrice = price;
  }

  /**
   * An open-interest sample (base units). The first sample only sets the
   * baseline. Without OI (endpoint unreachable) call `openFromVolume` instead.
   */
  openInterest(oi: number): void {
    if (!(oi >= 0)) return;
    this.oiSamples++;
    if (Number.isNaN(this.oi)) { this.oi = oi; this.resetVolume(); return; }
    const d = oi - this.oi;
    if (d > 0) this.open(d);
    else if (d < 0 && this.oi > 0) this.close(-d / this.oi);
    this.oi = oi;
    this.resetVolume();
  }

  /** Fallback without open interest: assume a fixed share of volume opened positions. */
  openFromVolume(share = 0.1): void {
    this.open(this.volTotal * share);
    this.resetVolume();
  }

  private resetVolume(): void { this.vol.fill(0); this.volTotal = 0; }

  /** New positions of `qty` base units, both a long and a short side for each. */
  private open(qty: number): void {
    if (!(this.volTotal > 0) || !(qty > 0)) return;
    const scale = qty / this.volTotal;
    for (let r = 0; r < this.bins; r++) {
      const v = this.vol[r];
      if (!v) continue;
      const entry = this.priceOf(r);
      const notional = v * scale * entry;
      for (const t of TIERS) {
        const n = notional * t.weight;
        const lr = this.row(entry * (1 - 1 / t.leverage + MMR));
        const sr = this.row(entry * (1 + 1 / t.leverage - MMR));
        // a long's level is always below price and a short's above, which keeps
        // the "clear between last and current row" rule in trade() exact
        if (lr >= 0 && lr < this.bins && lr < this.lastRow) this.longs[lr] += n;
        if (sr >= 0 && sr < this.bins && sr > this.lastRow) this.shorts[sr] += n;
      }
    }
  }

  /** Close `frac` of every open position. */
  private close(frac: number): void {
    const k = Math.max(0, 1 - frac);
    for (let r = 0; r < this.bins; r++) { this.longs[r] *= k; this.shorts[r] *= k; }
  }

  /** Largest long cluster below and short cluster above price, merged over `span` rows. */
  clusters(span = 4): { long?: { price: number; notional: number }; short?: { price: number; notional: number } } {
    const best = (a: Float64Array) => {
      let bi = -1, bv = 0;
      for (let r = 0; r + span <= this.bins; r++) {
        let s = 0;
        for (let j = 0; j < span; j++) s += a[r + j];
        if (s > bv) { bv = s; bi = r; }
      }
      if (bi < 0) return undefined;
      // report the heaviest row within the window
      let peak = bi;
      for (let j = 1; j < span; j++) if (a[bi + j] > a[peak]) peak = bi + j;
      return { price: this.priceOf(peak), notional: bv };
    };
    return { long: best(this.longs), short: best(this.shorts) };
  }
}

function clear(a: Float64Array, from: number, to: number): void {
  if (from <= to) a.fill(0, from, to + 1);
}

/** Shift contents so that new[i] = old[i + k], zero-filling. */
export function shiftArray(a: Float64Array | Float32Array, k: number): void {
  if (k === 0) return;
  const n = a.length;
  if (Math.abs(k) >= n) { a.fill(0); return; }
  if (k > 0) { a.copyWithin(0, k); a.fill(0, n - k); }
  else { a.copyWithin(-k, 0, n + k); a.fill(0, 0, -k); }
}

/** Binance USD-M symbol for a spot symbol (a few meme coins trade per 1000 units). */
export function futuresSymbol(spot: string): { symbol: string; mult: number } {
  const thousand = ['PEPEUSDT', 'SHIBUSDT', 'BONKUSDT', 'FLOKIUSDT'];
  return thousand.includes(spot) ? { symbol: `1000${spot}`, mult: 1000 } : { symbol: spot, mult: 1 };
}

/** Small seeded PRNG for the synthetic feed and tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
