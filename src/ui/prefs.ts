import { DEFAULT_HORIZON, HORIZONS } from '../forecast/forecast';
import { normalizeLayout, ZOOM, type LayoutPrefs } from '../render/layout';
import { isInterval, type Interval } from '../shared/config';
import { normalizeIndicators, type IndConfig } from '../indicators/spec';

/** Layout and zoom the page remembers between visits, per browser. */
export interface ViewPrefs {
  layout: LayoutPrefs;
  sideW: number;
  fontPx: number;
  candlesVisible: number;
  depthRangePct: number; // 0 = auto-fit
  ladderRowPad: number;
  candlesPriceScale: number; // 1 = fit
}

const KEY = 'depthline.view.v1';
export const SIDE_W = { min: 220, max: 600, def: 310 };

const num = (x: unknown, lo: number, hi: number, d: number) =>
  typeof x === 'number' && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d;

export function defaultPrefs(): ViewPrefs {
  return normalizePrefs({});
}

export function normalizePrefs(p: any): ViewPrefs {
  return {
    layout: normalizeLayout(p?.layout),
    sideW: num(p?.sideW, SIDE_W.min, SIDE_W.max, SIDE_W.def),
    fontPx: Math.round(num(p?.fontPx, ZOOM.font.min, ZOOM.font.max, ZOOM.font.def)),
    candlesVisible: Math.round(num(p?.candlesVisible, ZOOM.candles.min, ZOOM.candles.max, ZOOM.candles.def)),
    depthRangePct: p?.depthRangePct === 0 ? 0 : num(p?.depthRangePct, ZOOM.depthPct.min, ZOOM.depthPct.max, 0),
    ladderRowPad: Math.round(num(p?.ladderRowPad, ZOOM.rowPad.min, ZOOM.rowPad.max, ZOOM.rowPad.def)),
    candlesPriceScale: num(p?.candlesPriceScale, ZOOM.priceScale.min, ZOOM.priceScale.max, ZOOM.priceScale.def),
  };
}

export function loadPrefs(): ViewPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return normalizePrefs(raw ? JSON.parse(raw) : {});
  } catch {
    return defaultPrefs(); // private mode or blocked storage: defaults, nothing remembered
  }
}

export function savePrefs(p: ViewPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}

/**
 * Chart state the page remembers, per browser: candle size, indicators and
 * which overlays are shown. A URL parameter (?interval=, ?liq=0) wins over it.
 */
export interface ChartPrefs {
  interval: Interval;
  indicators: IndConfig[];
  showChartPatterns: boolean;
  showCandlePatterns: boolean;
  showLiquidations: boolean;
  /** candles ahead the research forecast looks */
  forecastHorizon: number;
}

const CHART_KEY = 'depthline.chart.v1';
const bool = (x: unknown, d: boolean) => (typeof x === 'boolean' ? x : d);

export function normalizeChartPrefs(p: any): ChartPrefs {
  return {
    interval: isInterval(p?.interval) ? p.interval : 15,
    indicators: normalizeIndicators(p?.indicators),
    showChartPatterns: bool(p?.showChartPatterns, true),
    showCandlePatterns: bool(p?.showCandlePatterns, true),
    showLiquidations: bool(p?.showLiquidations, true),
    forecastHorizon: (HORIZONS as readonly number[]).includes(p?.forecastHorizon) ? p.forecastHorizon : DEFAULT_HORIZON,
  };
}

export function loadChartPrefs(): ChartPrefs {
  try {
    const raw = localStorage.getItem(CHART_KEY);
    return normalizeChartPrefs(raw ? JSON.parse(raw) : {});
  } catch {
    return normalizeChartPrefs({});
  }
}

export function saveChartPrefs(p: ChartPrefs): void {
  try { localStorage.setItem(CHART_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}

/** Page chrome the page remembers: theme mode, side panel open and its tab. */
export type ThemeMode = 'system' | 'dark' | 'light';
export type SideTab = 'alerts' | 'signals' | 'forecast' | 'liq' | 'ind' | 'game' | 'health';
export const SIDE_TABS: SideTab[] = ['alerts', 'signals', 'forecast', 'liq', 'ind', 'game', 'health'];
export interface UiPrefs { themeMode: ThemeMode; sideOpen: boolean; tab: SideTab; sideLeft: boolean }

const UI_KEY = 'depthline.ui.v1';

export function normalizeUiPrefs(p: any): UiPrefs {
  return {
    themeMode: p?.themeMode === 'dark' || p?.themeMode === 'light' ? p.themeMode : 'system',
    sideOpen: bool(p?.sideOpen, true),
    tab: SIDE_TABS.includes(p?.tab) ? p.tab : 'signals',
    sideLeft: bool(p?.sideLeft, false),
  };
}

export function loadUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(UI_KEY);
    return normalizeUiPrefs(raw ? JSON.parse(raw) : {});
  } catch {
    return normalizeUiPrefs({});
  }
}

export function saveUiPrefs(p: UiPrefs): void {
  try { localStorage.setItem(UI_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}

/** Candle sizes shown as one-click buttons; the rest sit in the "more" menu. Keys 1-6 pick them. */
export const PINNED_INTERVALS = [1, 5, 15, 60, 240, 1440];

/** Group sizes offered in the book, as multiples of the tick. */
export const GROUPS = [1, 10, 100, 1000];

/** "0.1", "1", "10" ... for a group of `mult` ticks of `tick`; "10 ticks" when the tick is unknown. */
export function groupLabel(mult: number, tick: number | undefined): string {
  if (!(tick && tick > 0)) return mult === 1 ? 'tick' : `${mult} ticks`;
  const step = mult * tick;
  const dec = Math.max(0, Math.min(10, Math.ceil(-Math.log10(step) - 1e-9)));
  return step.toFixed(dec);
}
