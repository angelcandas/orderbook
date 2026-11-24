import { normalizeLayout, ZOOM, type LayoutPrefs } from '../render/layout';

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
