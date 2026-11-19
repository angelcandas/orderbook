/**
 * One side of an L2 book, stored as a sorted pair of typed arrays with the best
 * level at the TAIL. Keys are ascending: bids use key = tick, asks use key = -tick,
 * so for both sides the best price has the largest key.
 *
 * Why the tail: almost all activity is near the touch, so inserts and deletes there
 * move only a handful of elements (copyWithin), while the search is O(log n).
 * Depth is bounded (Kraken <= 1000, Binance pruned to a fixed depth), which keeps
 * the worst case small too. No objects are allocated per update.
 */
export class BookSide {
  keys: Float64Array;
  qtys: Float64Array;
  n = 0;

  constructor(readonly sign: 1 | -1, readonly maxDepth: number) {
    this.keys = new Float64Array(maxDepth + 1);
    this.qtys = new Float64Array(maxDepth + 1);
  }

  clear(): void {
    this.n = 0;
  }

  /** index of key, or -(insertionPoint + 1) */
  private find(key: number): number {
    let lo = 0;
    let hi = this.n - 1;
    const keys = this.keys;
    // fast path: most updates hit the last few levels
    if (hi >= 0 && key > keys[hi]) return -(this.n + 1);
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const k = keys[mid];
      if (k < key) lo = mid + 1;
      else if (k > key) hi = mid - 1;
      else return mid;
    }
    return -(lo + 1);
  }

  /**
   * Set the quantity at a tick (qty 0 removes it). Returns true if the book changed.
   * When the side is full, a new level worse than every resting level is ignored and
   * a better one evicts the worst level (this is the pruning that prevents ghosts).
   */
  set(tick: number, qty: number): boolean {
    const key = this.sign * tick;
    const i = this.find(key);
    const keys = this.keys;
    const qtys = this.qtys;
    if (i >= 0) {
      if (qty === 0) {
        keys.copyWithin(i, i + 1, this.n);
        qtys.copyWithin(i, i + 1, this.n);
        this.n--;
        return true;
      }
      if (qtys[i] === qty) return false;
      qtys[i] = qty;
      return true;
    }
    if (qty === 0) return false;
    let ins = -i - 1;
    if (this.n === this.maxDepth) {
      if (ins === 0) return false; // worse than everything we keep
      // drop the worst (head) to make room
      keys.copyWithin(0, 1, ins);
      qtys.copyWithin(0, 1, ins);
      ins--;
      keys[ins] = key;
      qtys[ins] = qty;
      return true;
    }
    keys.copyWithin(ins + 1, ins, this.n);
    qtys.copyWithin(ins + 1, ins, this.n);
    keys[ins] = key;
    qtys[ins] = qty;
    this.n++;
    return true;
  }

  /** Keep only the best `depth` levels. Returns number removed. */
  truncate(depth: number): number {
    const extra = this.n - depth;
    if (extra <= 0) return 0;
    this.keys.copyWithin(0, extra, this.n);
    this.qtys.copyWithin(0, extra, this.n);
    this.n = depth;
    return extra;
  }

  /** Tick of the i-th best level (0 = best). */
  tickAt(i: number): number {
    return this.sign * this.keys[this.n - 1 - i];
  }

  qtyAt(i: number): number {
    return this.qtys[this.n - 1 - i];
  }

  get bestTick(): number {
    return this.n > 0 ? this.sign * this.keys[this.n - 1] : NaN;
  }

  qtyAtTick(tick: number): number {
    const i = this.find(this.sign * tick);
    return i >= 0 ? this.qtys[i] : 0;
  }
}
