/**
 * Pane layout of the market canvas, shared by the render worker (which draws
 * into the rects) and the main thread (which places the resize handles and
 * zoom buttons over them). Pure: no DOM, no GL.
 */
export interface Rect { x: number; y: number; w: number; h: number }

/** Split fractions. Wide: ladder = width share, depth = height share of the right column. Narrow: both are height shares. */
export interface Split { ladder: number; depth: number }
export interface LayoutPrefs { wide: Split; narrow: Split }

export const NARROW_BELOW = 760;
export const DEFAULT_LAYOUT: LayoutPrefs = {
  wide: { ladder: 0.28, depth: 0.36 },
  narrow: { ladder: 0.42, depth: 0.4 },
};

/** Smallest a pane may be dragged to, css px. */
const MIN_LADDER_W = 200, MIN_RIGHT_W = 260, MIN_PANE_H = 90;

export interface Layout { narrow: boolean; ladder: Rect; depth: Rect; candles: Rect }

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const frac = (x: unknown, d: number) => (typeof x === 'number' && x > 0 && x < 1 ? x : d);

/** Repair a stored or partial prefs object. */
export function normalizeLayout(p: Partial<LayoutPrefs> | null | undefined): LayoutPrefs {
  const w = p?.wide, n = p?.narrow;
  return {
    wide: { ladder: frac(w?.ladder, DEFAULT_LAYOUT.wide.ladder), depth: frac(w?.depth, DEFAULT_LAYOUT.wide.depth) },
    narrow: { ladder: frac(n?.ladder, DEFAULT_LAYOUT.narrow.ladder), depth: frac(n?.depth, DEFAULT_LAYOUT.narrow.depth) },
  };
}

export function computeLayout(w: number, h: number, p: LayoutPrefs = DEFAULT_LAYOUT): Layout {
  const narrow = w < NARROW_BELOW;
  if (narrow) {
    const lh = Math.round(clamp(h * p.narrow.ladder, Math.min(MIN_PANE_H, h / 3), h - 2 * Math.min(MIN_PANE_H, h / 3)));
    const rest = h - lh;
    const dh = Math.round(clamp(rest * p.narrow.depth, Math.min(MIN_PANE_H, rest / 2), rest - Math.min(MIN_PANE_H, rest / 2)));
    return {
      narrow,
      ladder: { x: 0, y: 0, w, h: lh },
      depth: { x: 0, y: lh, w, h: dh },
      candles: { x: 0, y: lh + dh, w, h: rest - dh },
    };
  }
  const lw = Math.round(clamp(w * p.wide.ladder, Math.min(MIN_LADDER_W, w / 2), w - Math.min(MIN_RIGHT_W, w / 2)));
  const dh = Math.round(clamp(h * p.wide.depth, Math.min(MIN_PANE_H, h / 2), h - Math.min(MIN_PANE_H, h / 2)));
  return {
    narrow,
    ladder: { x: 0, y: 0, w: lw, h },
    depth: { x: lw, y: 0, w: w - lw, h: dh },
    candles: { x: lw, y: dh, w: w - lw, h: h - dh },
  };
}

/**
 * Turn a splitter drag position (css px inside the canvas) into new prefs.
 * `which` is the ladder split or the depth/candles split.
 */
export function dragSplit(p: LayoutPrefs, which: 'ladder' | 'depth', x: number, y: number, w: number, h: number): LayoutPrefs {
  const narrow = w < NARROW_BELOW;
  const f = (v: number) => clamp(v, 0.05, 0.95);
  if (narrow) {
    if (which === 'ladder') return { ...p, narrow: { ...p.narrow, ladder: f(y / h) } };
    const lh = computeLayout(w, h, p).ladder.h;
    return { ...p, narrow: { ...p.narrow, depth: f((y - lh) / Math.max(1, h - lh)) } };
  }
  if (which === 'ladder') return { ...p, wide: { ...p.wide, ladder: f(x / w) } };
  return { ...p, wide: { ...p.wide, depth: f(y / h) } };
}

/** Zoom limits and defaults for each pane. */
export const ZOOM = {
  candles: { min: 30, max: 2000, def: 160 },
  depthPct: { min: 0.01, max: 20 },
  rowPad: { min: 0, max: 14, def: 3 },
  font: { min: 9, max: 14, def: 11 },
} as const;
