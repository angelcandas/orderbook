/**
 * Fixed log-linear histogram over microseconds: 8 sub-buckets per power of two,
 * 1 us to ~35 minutes. Recording does not allocate. Error is under ~9% per value,
 * which is plenty for frame and latency percentiles.
 */
const SUB = 8;
const BINS = 256;

export class Histogram {
  counts = new Uint32Array(BINS);
  total = 0;
  sum = 0;
  max = 0;

  /** record a value in milliseconds */
  record(ms: number): void {
    const us = ms * 1000;
    const i = us <= 1 ? 0 : Math.min(BINS - 1, Math.floor(Math.log2(us) * SUB));
    this.counts[i]++;
    this.total++;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  }

  /** upper edge of the bin holding percentile p (0..100), in ms */
  percentile(p: number): number {
    if (this.total === 0) return 0;
    const target = Math.ceil((p / 100) * this.total);
    let acc = 0;
    for (let i = 0; i < BINS; i++) {
      acc += this.counts[i];
      if (acc >= target) return Math.min(this.max, 2 ** ((i + 1) / SUB) / 1000);
    }
    return this.max;
  }

  /** count of values above `ms` (approximate at bin granularity) */
  countAbove(ms: number): number {
    const us = ms * 1000;
    const start = us <= 1 ? 0 : Math.floor(Math.log2(us) * SUB) + 1;
    let c = 0;
    for (let i = start; i < BINS; i++) c += this.counts[i];
    return c;
  }

  reset(): void {
    this.counts.fill(0);
    this.total = 0;
    this.sum = 0;
    this.max = 0;
  }

  summary(): HistSummary {
    return {
      n: this.total,
      mean: this.total ? this.sum / this.total : 0,
      p50: this.percentile(50),
      p90: this.percentile(90),
      p99: this.percentile(99),
      p999: this.percentile(99.9),
      max: this.max,
    };
  }
}

export interface HistSummary {
  n: number;
  mean: number;
  p50: number;
  p90: number;
  p99: number;
  p999: number;
  max: number;
}

export const nowAbs = (): number => performance.timeOrigin + performance.now();
