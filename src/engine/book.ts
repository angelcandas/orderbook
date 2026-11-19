import { BookSide } from './side';
import { crc32Ascii } from './crc32';

export interface Instrument {
  symbol: string;
  tickSize: number; // price increment
  priceDecimals: number;
  qtyDecimals: number;
}

/** Number of decimals in a decimal string such as "0.01000000" -> significant: 2 */
export function decimalsOfIncrement(s: string): number {
  const x = Number(s);
  for (let d = 0; d <= 12; d++) {
    if (Math.abs(Math.round(x * 10 ** d) - x * 10 ** d) < 1e-9) return d;
  }
  return 12;
}

export class Book {
  readonly bids: BookSide;
  readonly asks: BookSide;
  /** bumped on every change; the publisher uses it to skip idle work */
  version = 0;
  /** absolute ms (timeOrigin + now) of the newest message applied */
  lastRecv = 0;
  /** exchange event time of the newest message, ms epoch, if known */
  lastEventTime = 0;
  private invTick: number;

  constructor(readonly inst: Instrument, readonly maxDepth: number) {
    this.bids = new BookSide(1, maxDepth);
    this.asks = new BookSide(-1, maxDepth);
    this.invTick = 1 / inst.tickSize;
  }

  toTick(price: number): number {
    return Math.round(price * this.invTick);
  }

  priceOf(tick: number): number {
    return tick * this.inst.tickSize;
  }

  clear(): void {
    this.bids.clear();
    this.asks.clear();
    this.version++;
  }

  setBid(price: number, qty: number): boolean {
    return this.bids.set(this.toTick(price), qty);
  }

  setAsk(price: number, qty: number): boolean {
    return this.asks.set(this.toTick(price), qty);
  }

  /** true if bids and asks overlap, which a correct book never shows */
  crossed(): boolean {
    return this.bids.n > 0 && this.asks.n > 0 && this.bids.bestTick >= this.asks.bestTick;
  }

  /**
   * Kraken v2 checksum: top 10 asks (low to high) then top 10 bids (high to low);
   * for each level, price then qty, formatted with the instrument precision, with
   * the '.' removed and leading zeros stripped; CRC32 of the concatenation.
   */
  krakenChecksum(): number {
    let s = '';
    const { priceDecimals, qtyDecimals } = this.inst;
    const na = Math.min(10, this.asks.n);
    for (let i = 0; i < na; i++) {
      s += strip(this.priceOf(this.asks.tickAt(i)).toFixed(priceDecimals));
      s += strip(this.asks.qtyAt(i).toFixed(qtyDecimals));
    }
    const nb = Math.min(10, this.bids.n);
    for (let i = 0; i < nb; i++) {
      s += strip(this.priceOf(this.bids.tickAt(i)).toFixed(priceDecimals));
      s += strip(this.bids.qtyAt(i).toFixed(qtyDecimals));
    }
    return crc32Ascii(s);
  }
}

function strip(x: string): string {
  let i = 0;
  let out = '';
  for (; i < x.length; i++) {
    const c = x.charCodeAt(i);
    if (c === 46) continue; // '.'
    out += x[i];
  }
  // strip leading zeros
  let j = 0;
  while (j < out.length - 1 && out.charCodeAt(j) === 48) j++;
  return out.slice(j);
}
