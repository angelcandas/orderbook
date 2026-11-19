export interface Candle {
  /** open time, ms epoch */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** false while the candle is still forming */
  closed: boolean;
}
