import { withAlpha, type Gfx, type RGBA } from './gl';
import type { Theme } from './theme';
import type { IndOut } from '../indicators/spec';
import type { Rect } from './layout';

/**
 * Indicator drawing for the candle chart: overlays on the price plot, the
 * volume strip under it, and one pane per oscillator below. Allocation free:
 * labels are the strings the analytics worker already sent.
 */

/** the candle chart's horizontal mapping for this frame */
export interface XMap { first: number; N: number; step: number; bw: number; X: (i: number) => number }

const SUB = { min: 44, max: 120, share: 0.22, total: 0.5 };

/** Height of each oscillator pane: up to 22% of the chart each, together at most half of it. */
export function subPaneHeight(avail: number, n: number): number {
  if (n <= 0) return 0;
  return Math.max(SUB.min, Math.floor(Math.min(SUB.max, avail * SUB.share, (avail * SUB.total) / n)));
}

export const indColor = (t: Theme, x: IndOut, k = 0): RGBA => t.ind[(x.color + k) % t.ind.length];

function polyline(g: Gfx, arr: Float64Array, m: XMap, Y: (v: number) => number, w: number, col: RGBA): void {
  for (let i = Math.max(m.first + 1, 1); i < m.N; i++) {
    const a = arr[i - 1], b = arr[i];
    if (a === a && b === b) g.line(m.X(i - 1), Y(a), m.X(i), Y(b), w, col);
  }
}

/** Overlays on the price plot (called inside the plot's scissor). */
export function drawPriceIndicators(g: Gfx, ind: IndOut[], m: XMap, Y: (p: number) => number, t: Theme): void {
  for (const x of ind) {
    if (x.pane !== 'price') continue;
    const col = indColor(t, x);
    if (x.lines.length === 3) {
      // channel: faint fill between the bands, bands solid, middle faint
      const [mid, up, lo] = x.lines;
      const fill = withAlpha(col, 0.06);
      for (let i = m.first; i < m.N; i++) {
        if (up[i] !== up[i] || lo[i] !== lo[i]) continue;
        const y0 = Y(up[i]);
        g.rect(m.X(i) - m.step / 2, y0, m.step, Y(lo[i]) - y0, fill);
      }
      polyline(g, up, m, Y, 1, col);
      polyline(g, lo, m, Y, 1, col);
      polyline(g, mid, m, Y, 1, withAlpha(col, 0.55));
    } else if (x.lines[0]) polyline(g, x.lines[0], m, Y, 1.2, col);
  }
}

/** Volume bars in [top, top + h], with the optional moving average. */
export function drawVolume(g: Gfx, x: IndOut, o: Float64Array, c: Float64Array, v: Float64Array, m: XMap, top: number, h: number, t: Theme): void {
  let vmax = 0;
  for (let i = m.first; i < m.N; i++) if (v[i] > vmax) vmax = v[i];
  if (!(vmax > 0)) return;
  const base = top + h;
  const up = withAlpha(t.bid, 0.35), dn = withAlpha(t.ask, 0.35);
  for (let i = m.first; i < m.N; i++) {
    const vh = (v[i] / vmax) * h;
    g.rect(m.X(i) - m.bw / 2, base - vh, m.bw, vh, c[i] >= o[i] ? up : dn);
  }
  const ma = x.lines[0];
  if (ma) polyline(g, ma, m, (y) => base - (y / vmax) * h, 1.2, indColor(t, x));
}

const decimalsFor = (v: number): number => {
  const a = Math.abs(v);
  return a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
};

/**
 * One oscillator pane. `r` is the plot (left of the price axis), `axisRight`
 * where the axis numbers end, `hover` the candle under the pointer or -1.
 */
export function drawSubPane(g: Gfx, x: IndOut, r: Rect, axisRight: number, m: XMap, hover: number, t: Theme): void {
  const ch = g.atlas.cellH, cw = g.atlas.cellW;
  g.rect(r.x - 8, r.y, r.w + 16 + (axisRight - r.x - r.w), 1, t.grid);
  const top = r.y + ch + 4, bot = r.y + r.h - 3;
  let lo: number, hi: number;
  if (x.range) [lo, hi] = x.range;
  else {
    lo = Infinity; hi = -Infinity;
    for (const arr of x.lines) for (let i = m.first; i < m.N; i++) { const v = arr[i]; if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    if (x.kind === 'macd') { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (!(hi >= lo)) { lo = 0; hi = 1; }
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1;
    lo -= pad; hi += pad;
  }
  const Y = (v: number) => bot - ((v - lo) / (hi - lo)) * (bot - top);
  if (x.levels) for (const l of x.levels) if (l > lo && l < hi) g.dashed(r.x, Y(l), r.x + r.w, Y(l), 1, 3, withAlpha(t.dim, 0.4));
  const col = indColor(t, x);
  if (x.kind === 'macd') {
    const [line, sig, hist] = x.lines;
    const y0 = Y(0);
    const up = withAlpha(t.bull, 0.45), dn = withAlpha(t.bear, 0.45);
    for (let i = m.first; i < m.N; i++) {
      const v = hist[i];
      if (v !== v) continue;
      const y = Y(v);
      g.rect(m.X(i) - m.bw / 2, Math.min(y, y0), m.bw, Math.max(1, Math.abs(y - y0)), v >= 0 ? up : dn);
    }
    polyline(g, line, m, Y, 1.2, col);
    polyline(g, sig, m, Y, 1.2, indColor(t, x, 1));
  } else {
    for (let k = x.lines.length - 1; k >= 0; k--) polyline(g, x.lines[k], m, Y, 1.2, indColor(t, x, k));
  }
  // label and value at the hovered (or last) candle; axis bounds on the right
  const i = hover >= 0 ? hover : m.N - 1;
  let lx = r.x + 2;
  lx += g.text(lx, r.y + 3, x.label, t.dim) + cw * 2;
  for (let k = 0; k < x.lines.length && k < 3; k++) {
    const v = x.lines[k][i];
    if (v !== v) continue;
    // fixed 12-character slots: right-aligned numbers, no strings per frame
    g.number(lx + 12 * cw, r.y + 3, v, decimalsFor(v), indColor(t, x, k), false);
    lx += 13 * cw;
  }
  if (!x.range) {
    g.number(axisRight, top - ch / 2, hi, decimalsFor(hi), t.dim, false);
    g.number(axisRight, bot - ch, lo, decimalsFor(lo), t.dim, false);
  } else if (x.levels) {
    for (const l of x.levels) g.number(axisRight, Y(l) - ch / 2, l, 0, t.dim, false);
  }
}
