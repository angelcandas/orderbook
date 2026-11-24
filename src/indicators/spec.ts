import { atr, bollinger, donchian, ema, macd, obv, rsi, sma, stochastic, vwap } from '../patterns/indicators';

/**
 * The chart's indicators: what can be added, their parameters, and how each is
 * computed. Shared by the page (menu, saved settings) and the analytics worker
 * (computation); the render worker only draws what the worker sends.
 */
export type IndKind = 'sma' | 'ema' | 'bb' | 'vwap' | 'donchian' | 'volume' | 'rsi' | 'macd' | 'stoch' | 'atr' | 'obv';

/** where it is drawn: over the candles, as the volume strip under them, or in its own pane below */
export type IndPane = 'price' | 'volume' | 'sub';

export interface IndParam { label: string; def: number; min: number; max: number; step?: number }

export interface IndSpec {
  kind: IndKind;
  name: string;
  short: string;
  pane: IndPane;
  params: IndParam[];
  /** horizontal guide levels in a sub pane */
  levels?: number[];
  /** fixed value range of a sub pane (otherwise fitted to what is visible) */
  range?: [number, number];
  /** where the values come from, for the menu's tooltip */
  help: string;
}

const P = (label: string, def: number, min: number, max: number, step = 1): IndParam => ({ label, def, min, max, step });

export const SPECS: Record<IndKind, IndSpec> = {
  sma: { kind: 'sma', name: 'Simple moving average', short: 'SMA', pane: 'price', params: [P('period', 20, 2, 500)], help: 'Average close of the last N candles.' },
  ema: { kind: 'ema', name: 'Exponential moving average', short: 'EMA', pane: 'price', params: [P('period', 20, 2, 500)], help: 'Moving average that weights recent closes more.' },
  bb: { kind: 'bb', name: 'Bollinger Bands', short: 'BB', pane: 'price', params: [P('period', 20, 2, 500), P('std dev', 2, 0.5, 5, 0.1)], help: 'SMA with bands K standard deviations above and below.' },
  vwap: { kind: 'vwap', name: 'VWAP', short: 'VWAP', pane: 'price', params: [P('bars (0 = daily)', 0, 0, 1000)], help: 'Volume weighted average price. 0 restarts every UTC day; N is a rolling window of N candles.' },
  donchian: { kind: 'donchian', name: 'Donchian channel', short: 'DC', pane: 'price', params: [P('period', 20, 2, 500)], help: 'Highest high and lowest low of the last N candles.' },
  volume: { kind: 'volume', name: 'Volume', short: 'VOL', pane: 'volume', params: [P('average (0 = off)', 20, 0, 500)], help: 'Volume bars under the candles, with an optional moving average.' },
  rsi: { kind: 'rsi', name: 'Relative strength index', short: 'RSI', pane: 'sub', params: [P('period', 14, 2, 200)], levels: [30, 50, 70], range: [0, 100], help: "Wilder's RSI: above 70 is often read as overbought, below 30 as oversold." },
  macd: { kind: 'macd', name: 'MACD', short: 'MACD', pane: 'sub', params: [P('fast', 12, 2, 200), P('slow', 26, 3, 400), P('signal', 9, 2, 200)], levels: [0], help: 'Fast EMA minus slow EMA, its signal EMA, and the histogram between them.' },
  stoch: { kind: 'stoch', name: 'Stochastic', short: 'STOCH', pane: 'sub', params: [P('period', 14, 2, 200), P('smooth', 3, 1, 50), P('%D', 3, 1, 50)], levels: [20, 80], range: [0, 100], help: 'Where the close sits in the high-low range of the last N candles (%K), and its average (%D).' },
  atr: { kind: 'atr', name: 'Average true range', short: 'ATR', pane: 'sub', params: [P('period', 14, 2, 200)], help: "Wilder's average true range: how far price typically moves in one candle." },
  obv: { kind: 'obv', name: 'On-balance volume', short: 'OBV', pane: 'sub', params: [], help: 'Running total of volume, added on up closes and subtracted on down closes.' },
};
export const KINDS = Object.keys(SPECS) as IndKind[];

/** colours come from the theme's indicator palette, by index */
export const PALETTE_SIZE = 8;

export interface IndConfig {
  id: string;
  kind: IndKind;
  params: number[];
  color: number;
  on: boolean;
}

/** Most indicators at once, and most sub panes, so the price chart keeps room. */
export const MAX_INDICATORS = 16;
export const MAX_SUB_PANES = 4;

/** What the chart shows before anything is saved: the old EMA 20 / EMA 50 and volume. */
export function defaultIndicators(): IndConfig[] {
  return [
    { id: 'ema-1', kind: 'ema', params: [20], color: 0, on: true },
    { id: 'ema-2', kind: 'ema', params: [50], color: 1, on: true },
    { id: 'volume-1', kind: 'volume', params: [0], color: 7, on: true },
  ];
}

const clampParam = (p: IndParam, x: unknown): number => {
  if (typeof x !== 'number' || !Number.isFinite(x)) return p.def;
  const v = Math.max(p.min, Math.min(p.max, x));
  return p.step && p.step < 1 ? Math.round(v / p.step) * p.step : Math.round(v);
};

/** Repair a stored list: unknown kinds dropped, parameters clamped, ids unique. */
export function normalizeIndicators(x: unknown): IndConfig[] {
  if (!Array.isArray(x)) return defaultIndicators();
  const out: IndConfig[] = [];
  const ids = new Set<string>();
  for (const it of x) {
    const spec = SPECS[(it as any)?.kind as IndKind];
    if (!spec || out.length >= MAX_INDICATORS) continue;
    let id = typeof it.id === 'string' && it.id ? it.id : `${spec.kind}-${out.length + 1}`;
    while (ids.has(id)) id += '+';
    ids.add(id);
    const params = spec.params.map((p, i) => clampParam(p, Array.isArray(it.params) ? it.params[i] : undefined));
    const color = Number.isInteger(it.color) ? ((it.color % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE : out.length % PALETTE_SIZE;
    out.push({ id, kind: spec.kind, params, color, on: it.on !== false });
  }
  return out;
}

/** A new indicator of `kind` with default parameters and the next unused colour. */
export function newIndicator(kind: IndKind, list: IndConfig[]): IndConfig {
  const spec = SPECS[kind];
  let n = 1;
  while (list.some((c) => c.id === `${kind}-${n}`)) n++;
  const used = new Set(list.map((c) => c.color));
  let color = 0;
  while (used.has(color) && color < PALETTE_SIZE - 1) color++;
  return { id: `${kind}-${n}`, kind, params: spec.params.map((p) => p.def), color, on: true };
}

/** "EMA 20", "BB 20 2", "VWAP", "MACD 12 26 9" */
export function indLabel(c: IndConfig): string {
  const spec = SPECS[c.kind];
  if (c.kind === 'vwap') return c.params[0] > 0 ? `VWAP ${c.params[0]}` : 'VWAP';
  if (c.kind === 'volume') return c.params[0] > 0 ? `VOL MA${c.params[0]}` : 'VOL';
  return [spec.short, ...c.params.map((p) => String(p))].join(' ');
}

/** One computed indicator, as the analytics worker sends it to the render worker. */
export interface IndOut {
  id: string;
  kind: IndKind;
  pane: IndPane;
  label: string;
  color: number;
  /** series aligned with the candles; meaning per kind (see `compute`) */
  lines: Float64Array[];
  levels?: number[];
  range?: [number, number];
}

export interface Ohlcv {
  t: ArrayLike<number>; o: ArrayLike<number>; h: ArrayLike<number>; l: ArrayLike<number>; c: ArrayLike<number>; v: ArrayLike<number>;
}

/**
 * Compute one indicator. Lines per kind:
 *   sma, ema, vwap: [value]          bb, donchian: [middle, upper, lower]
 *   volume: [volume average] (empty when off; the bars come from the candles)
 *   rsi, atr, obv: [value]           macd: [macd, signal, histogram]
 *   stoch: [%K, %D]
 */
export function compute(c: IndConfig, s: Ohlcv): IndOut {
  const spec = SPECS[c.kind];
  const p = c.params;
  let lines: Float64Array[];
  switch (c.kind) {
    case 'sma': lines = [sma(s.c, p[0])]; break;
    case 'ema': lines = [ema(s.c, p[0])]; break;
    case 'bb': lines = bollinger(s.c, p[0], p[1]); break;
    case 'vwap': lines = [vwap(s.t, s.h, s.l, s.c, s.v, p[0])]; break;
    case 'donchian': lines = donchian(s.h, s.l, p[0]); break;
    case 'volume': lines = p[0] > 0 ? [sma(s.v, p[0])] : []; break;
    case 'rsi': lines = [rsi(s.c, p[0])]; break;
    case 'macd': lines = macd(s.c, p[0], p[1], p[2]); break;
    case 'stoch': lines = stochastic(s.h, s.l, s.c, p[0], p[1], p[2]); break;
    case 'atr': lines = [atr(s.h, s.l, s.c, p[0])]; break;
    case 'obv': lines = [obv(s.c, s.v)]; break;
  }
  return { id: c.id, kind: c.kind, pane: spec.pane, label: indLabel(c), color: c.color, lines, levels: spec.levels, range: spec.range };
}

/** All enabled indicators; at most MAX_SUB_PANES of them get a pane of their own. */
export function computeAll(list: IndConfig[], s: Ohlcv): IndOut[] {
  const out: IndOut[] = [];
  let subs = 0;
  for (const c of list) {
    if (!c.on) continue;
    if (SPECS[c.kind].pane === 'sub' && ++subs > MAX_SUB_PANES) continue;
    out.push(compute(c, s));
  }
  return out;
}
