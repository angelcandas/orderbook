import type { IndOut } from '../indicators/spec';
export type Bias = 1 | -1 | 0;

export interface Pt { i: number; p: number } // candle index, price

export interface PatternHit {
  id: string; // stable across recomputes: kind + anchor index
  kind: string;
  label: string;
  bias: Bias;
  /** multi-bar chart pattern, or single/2/3-bar candle pattern */
  family: 'chart' | 'candle' | 'volatility';
  start: number; // candle index
  end: number;
  /** polyline through the defining pivots */
  pivots: Pt[];
  /** boundary lines (trendlines, necklines, support/resistance) */
  lines: [Pt, Pt][];
  status: 'forming' | 'confirmed' | 'failed';
  breakout?: Pt;
  target?: number;
  stop?: number;
  /** 0..1, how cleanly the geometry fits */
  score: number;
  note?: string;
}

export interface AnalyticsOut {
  symbol: string;
  /** candle open times plus OHLCV, last N */
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
  /** the enabled indicators, computed over all candles */
  ind: IndOut[];
  patterns: PatternHit[];
  computeMs: number;
}
