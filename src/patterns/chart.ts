import type { PatternHit, Pt, Bias } from './types';
import { tolerance, type Series } from './series';
import type { Pivot } from './pivots';

/**
 * Multi-bar chart patterns from "Identifying Chart Patterns" (Fidelity, after
 * Kirkpatrick & Dahlquist). The guide defines shapes, breakout rules and
 * measuring targets but no numeric tolerances, so the thresholds here are ours:
 *   - "same price": within tolerance() (max of 0.75 ATR, 0.2% of price)
 *   - a breakout needs a candle CLOSE beyond the boundary (the "multiple closes"
 *     / close filter family in the guide, using one close)
 *   - a pattern is shown as forming only while price is still inside it and for
 *     at most as many bars as the pattern took to form
 *   - protective stop: outside the breakout bar, opposite the breakout (guide)
 */

const pt = (i: number, p: number): Pt => ({ i, p });

function lineAt(a: Pt, b: Pt, i: number): number {
  return b.i === a.i ? a.p : a.p + ((b.p - a.p) * (i - a.i)) / (b.i - a.i);
}

interface Boundary { above: (i: number) => number; below: (i: number) => number }

/**
 * Walk forward from `from` looking for the first close outside the boundary.
 * Returns the breakout, or null. Bars after `maxWait` stop the search.
 */
function findBreakout(s: Series, from: number, maxWait: number, b: Boundary): { i: number; dir: 1 | -1 } | null {
  const end = Math.min(s.lastClosed, from + maxWait);
  for (let i = from; i <= end; i++) {
    if (s.c[i] > b.above(i)) return { i, dir: 1 };
    if (s.c[i] < b.below(i)) return { i, dir: -1 };
  }
  return null;
}

function finish(
  s: Series,
  base: Omit<PatternHit, 'status' | 'family'>,
  expectDir: 1 | -1 | 0,
  bo: { i: number; dir: 1 | -1 } | null,
  waitedTooLong: boolean,
  targetFor: (dir: 1 | -1, boPrice: number) => number,
): PatternHit | null {
  if (!bo) {
    if (waitedTooLong) return null; // stale, never activated
    return { ...base, family: 'chart', status: 'forming' };
  }
  const boPrice = s.c[bo.i];
  const ok = expectDir === 0 || bo.dir === expectDir;
  const hit: PatternHit = {
    ...base,
    family: 'chart',
    bias: (expectDir === 0 ? bo.dir : base.bias) as Bias,
    end: Math.max(base.end, bo.i),
    breakout: pt(bo.i, boPrice),
    status: ok ? 'confirmed' : 'failed',
    target: ok ? targetFor(bo.dir, boPrice) : undefined,
    stop: ok ? (bo.dir > 0 ? s.l[bo.i] : s.h[bo.i]) : undefined,
  };
  if (!ok) hit.note = 'broke the wrong way';
  return hit;
}

// ---------------- double / triple tops and bottoms, head and shoulders ----------------

export function tops(s: Series, pv: Pivot[], out: PatternHit[]): void {
  for (let k = 0; k + 2 < pv.length; k++) {
    const a = pv[k], m = pv[k + 1], b = pv[k + 2];
    const top = a.hi;
    const tol = tolerance(s, b.i);
    const height = top ? Math.max(a.p, b.p) - m.p : m.p - Math.min(a.p, b.p);
    if (height < 2 * s.atr[b.i] || b.i - a.i < 5) continue;

    // triple: a m b m2 c
    if (k + 4 < pv.length) {
      const m2 = pv[k + 3], c = pv[k + 4];
      const peaks = [a.p, b.p, c.p];
      const spread = Math.max(...peaks) - Math.min(...peaks);
      if (spread <= tol * 1.2) {
        const ext = top ? Math.max(...peaks) : Math.min(...peaks);
        const neckEx = top ? Math.min(m.p, m2.p) : Math.max(m.p, m2.p);
        const h3 = Math.abs(ext - neckEx);
        const wait = c.i - a.i;
        const bo = findBreakout(s, c.i + 1, wait, top
          ? { above: () => ext + tol, below: () => neckEx }
          : { above: () => neckEx, below: () => ext - tol });
        const hit = finish(s, {
          id: `${top ? 'triple-top' : 'triple-bottom'}:${s.t[a.i]}`,
          kind: top ? 'triple-top' : 'triple-bottom',
          label: top ? 'Triple top' : 'Triple bottom',
          bias: top ? -1 : 1,
          start: a.i, end: c.i,
          pivots: [a, m, b, m2, c].map((p) => pt(p.i, p.p)),
          lines: [[pt(a.i, ext), pt(c.i, ext)], [pt(m.i, neckEx), pt(c.i, neckEx)]],
          score: 1 - spread / (tol * 1.2 + 1e-12),
        }, top ? -1 : 1, bo, s.lastClosed - c.i > wait,
        // guide: subtract height from the lowest trough (top) / add to the highest peak (bottom)
        (dir) => (dir < 0 ? neckEx - h3 : neckEx + h3));
        if (hit) out.push(hit);
        // head and shoulders: middle extreme beyond both shoulders, shoulders level
        continue;
      }
      // head and shoulders
      const headBeyond = top ? b.p - Math.max(a.p, c.p) : Math.min(a.p, c.p) - b.p;
      const shoulders = Math.abs(a.p - c.p);
      if (headBeyond > tol && shoulders <= tol * 1.5 && (top ? m.p < a.p && m2.p < c.p : m.p > a.p && m2.p > c.p)) {
        const n0 = pt(m.i, m.p), n1 = pt(m2.i, m2.p);
        const neck = (i: number) => lineAt(n0, n1, i);
        const headToNeck = Math.abs(b.p - neck(b.i));
        const wait = c.i - a.i;
        const bo = findBreakout(s, c.i + 1, wait, top
          ? { above: () => Math.max(a.p, c.p) + tol, below: neck }
          : { above: neck, below: () => Math.min(a.p, c.p) - tol });
        const hit = finish(s, {
          id: `${top ? 'hs-top' : 'hs-bottom'}:${s.t[a.i]}`,
          kind: top ? 'head-shoulders-top' : 'head-shoulders-bottom',
          label: top ? 'Head & shoulders' : 'Inverse H&S',
          bias: top ? -1 : 1,
          start: a.i, end: c.i,
          pivots: [a, m, b, m2, c].map((p) => pt(p.i, p.p)),
          lines: [[n0, pt(c.i + Math.max(3, Math.round(wait / 3)), neck(c.i + Math.max(3, Math.round(wait / 3))))]],
          score: Math.min(1, headBeyond / (2 * tol)) * (1 - shoulders / (tol * 1.5 + 1e-12)) ** 0.5,
        }, top ? -1 : 1, bo, s.lastClosed - c.i > wait,
        // guide: distance from head to neckline, projected from the neckline
        (dir, px) => (dir < 0 ? px - headToNeck : px + headToNeck));
        if (hit) out.push(hit);
        continue;
      }
    }

    // double
    if (Math.abs(a.p - b.p) <= tol) {
      const ext = top ? Math.max(a.p, b.p) : Math.min(a.p, b.p);
      const wait = b.i - a.i;
      const bo = findBreakout(s, b.i + 1, wait, top
        ? { above: () => ext + tol, below: () => m.p }
        : { above: () => m.p, below: () => ext - tol });
      const hit = finish(s, {
        id: `${top ? 'double-top' : 'double-bottom'}:${s.t[a.i]}`,
        kind: top ? 'double-top' : 'double-bottom',
        label: top ? 'Double top' : 'Double bottom',
        bias: top ? -1 : 1,
        start: a.i, end: b.i,
        pivots: [a, m, b].map((p) => pt(p.i, p.p)),
        lines: [[pt(a.i, ext), pt(b.i, ext)], [pt(m.i, m.p), pt(b.i + Math.round(wait / 3), m.p)]],
        score: 1 - Math.abs(a.p - b.p) / (tol + 1e-12),
      }, top ? -1 : 1, bo, s.lastClosed - b.i > wait,
      // guide: height from the highest peak to the trough, from the breakout price
      (dir, px) => (dir < 0 ? px - height : px + height));
      if (hit) out.push(hit);
    }
  }
}

// ---------------- triangles, wedges, rectangles ----------------

interface Fit { a: Pt; b: Pt; slope: number; maxDev: number }

/** least squares line through points (x = bar index) */
function fit(ps: Pivot[]): Fit {
  const n = ps.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of ps) { sx += p.i; sy += p.p; sxx += p.i * p.i; sxy += p.i * p.p; }
  const den = n * sxx - sx * sx;
  const slope = den ? (n * sxy - sx * sy) / den : 0;
  const icpt = (sy - slope * sx) / n;
  let maxDev = 0;
  for (const p of ps) maxDev = Math.max(maxDev, Math.abs(p.p - (icpt + slope * p.i)));
  const i0 = ps[0].i, i1 = ps[n - 1].i;
  return { a: pt(i0, icpt + slope * i0), b: pt(i1, icpt + slope * i1), slope, maxDev };
}

export function converging(s: Series, pv: Pivot[], out: PatternHit[]): void {
  // windows of 4..7 consecutive pivots; keep the longest valid one per end pivot
  const taken = new Set<number>();
  for (let end = pv.length - 1; end >= 4; end--) {
    // five pivots minimum: with only four, a double top or bottom also reads as a
    // triangle, and the guide treats those as distinct patterns
    for (let len = Math.min(7, end + 1); len >= 5; len--) {
      const w = pv.slice(end - len + 1, end + 1);
      if (taken.has(w[0].i)) break;
      const highs = w.filter((p) => p.hi);
      const lows = w.filter((p) => !p.hi);
      if (highs.length < 2 || lows.length < 2) continue;
      const i0 = w[0].i, i1 = w[w.length - 1].i;
      const span = i1 - i0;
      if (span < 10) continue;
      const tol = tolerance(s, i1);
      const up = fit(highs), lo = fit(lows);
      if (up.maxDev > tol * 0.8 || lo.maxDev > tol * 0.8) continue;
      // slopes as total change across the span, compared with the tolerance
      const du = up.slope * span, dl = lo.slope * span;
      const flatU = Math.abs(du) <= tol, flatL = Math.abs(dl) <= tol;
      const upperAt = (i: number) => up.a.p + up.slope * (i - up.a.i);
      const lowerAt = (i: number) => lo.a.p + lo.slope * (i - lo.a.i);
      const width0 = upperAt(i0) - lowerAt(i0), width1 = upperAt(i1) - lowerAt(i1);
      if (width1 <= 0 || width0 <= 0) continue;
      // bars inside the window must not CLOSE far outside the lines
      let clean = true;
      for (let i = i0; i <= i1 && clean; i++) if (s.c[i] > upperAt(i) + tol * 0.5 || s.c[i] < lowerAt(i) - tol * 0.5) clean = false;
      if (!clean) continue;

      let kind = '', label = '', bias: Bias = 0, minTouches = 4;
      if (flatU && flatL) { kind = 'rectangle'; label = 'Rectangle'; }
      else if (flatU && dl > tol) { kind = 'ascending-triangle'; label = 'Ascending triangle'; bias = 1; }
      else if (flatL && du < -tol) { kind = 'descending-triangle'; label = 'Descending triangle'; bias = -1; }
      else if (du < -tol && dl > tol) { kind = 'symmetrical-triangle'; label = 'Symmetrical triangle'; }
      else if (du > tol && dl > tol && dl > du && width1 < width0 * 0.8) { kind = 'rising-wedge'; label = 'Rising wedge'; bias = -1; minTouches = 5; }
      else if (du < -tol && dl < -tol && du < dl && width1 < width0 * 0.8) { kind = 'falling-wedge'; label = 'Falling wedge'; bias = 1; minTouches = 5; }
      else continue;
      // guide: triangles touch each bound at least twice; wedges at least 5 touches (3 + 2)
      if (highs.length + lows.length < minTouches) continue;
      if (minTouches === 5 && Math.max(highs.length, lows.length) < 3) continue;
      if (kind.endsWith('triangle') && width1 > width0 * 0.85) continue; // must converge

      let hiP = -Infinity, loP = Infinity;
      for (const p of w) { if (p.hi) hiP = Math.max(hiP, p.p); else loP = Math.min(loP, p.p); }
      const height = hiP - loP;
      const wait = Math.round(span * 0.6);
      const bo = findBreakout(s, i1 + 1, wait, { above: upperAt, below: lowerAt });
      const ext = i1 + Math.max(3, Math.round(span * 0.25));
      const isWedge = kind.endsWith('wedge');
      // directional patterns are confirmed in their bias direction; the rest either way
      const hit = finish(s, {
        id: `${kind}:${s.t[i0]}`,
        kind, label, bias,
        start: i0, end: i1,
        pivots: w.map((p) => pt(p.i, p.p)),
        lines: [[pt(i0, upperAt(i0)), pt(ext, upperAt(ext))], [pt(i0, lowerAt(i0)), pt(ext, lowerAt(ext))]],
        score: 1 - Math.max(up.maxDev, lo.maxDev) / (tol * 0.8),
      }, kind === 'rectangle' || kind === 'symmetrical-triangle' ? 0 : (bias as 1 | -1), bo, s.lastClosed - i1 > wait,
      (dir, px) => (isWedge && dir < 0 ? loP : dir > 0 ? (kind === 'rectangle' ? hiP + height : px + height) : (kind === 'rectangle' ? loP - height : px - height)));
      // ascending / descending triangles can break either way (guide); keep the
      // break as confirmed in its own direction rather than calling it failed
      if (hit && hit.status === 'failed' && kind.endsWith('triangle') && hit.breakout) {
        const dir = (hit.breakout.p > upperAt(hit.breakout.i) ? 1 : -1) as 1 | -1;
        hit.status = 'confirmed';
        hit.bias = dir;
        hit.note = 'broke against the usual direction';
        hit.target = dir > 0 ? hit.breakout.p + height : hit.breakout.p - height;
        hit.stop = dir > 0 ? s.l[hit.breakout.i] : s.h[hit.breakout.i];
      }
      if (hit) {
        out.push(hit);
        for (const p of w) taken.add(p.i);
        break;
      }
    }
  }
}

// ---------------- flags and pennants ----------------

export function flags(s: Series, out: PatternHit[]): void {
  const end = s.lastClosed;
  // pole: >= 4 ATR move within <= 8 bars, then 4..20 bars of consolidation
  for (let pe = 10; pe <= end - 4; pe++) {
    const a = s.atr[pe];
    if (!(a > 0)) continue;
    for (let len = 3; len <= 8; len++) {
      const ps = pe - len;
      if (ps < 0) break;
      const move = s.c[pe] - s.o[ps + 1];
      if (Math.abs(move) < 4 * a) continue;
      const dir = move > 0 ? 1 : -1;
      const poleTop = dir > 0 ? s.h[pe] : s.l[pe];
      const poleStart = dir > 0 ? s.l[ps + 1] : s.h[ps + 1];
      const pole = Math.abs(poleTop - poleStart);
      // consolidation: range under half the pole, drifting slightly against the trend
      let hi = -Infinity, lo = Infinity, j = pe + 1;
      for (; j <= Math.min(end, pe + 20); j++) {
        const nh = Math.max(hi, s.h[j]), nl = Math.min(lo, s.l[j]);
        if (nh - nl > pole * 0.5) break;
        hi = nh; lo = nl;
      }
      const cEnd = j - 1;
      const bars = cEnd - pe;
      if (bars < 4) continue;
      const drift = s.c[cEnd] - s.c[pe + 1];
      if (drift * dir > 0.25 * pole) continue; // should not extend the pole
      // converging range = pennant, otherwise flag
      const half = pe + 1 + Math.floor(bars / 2);
      let r1 = 0, r2 = 0;
      for (let i = pe + 1; i <= cEnd; i++) (i < half ? (r1 = Math.max(r1, s.h[i] - s.l[i])) : (r2 = Math.max(r2, s.h[i] - s.l[i])));
      const pennant = r2 < r1 * 0.7;
      const kind = `${pennant ? 'pennant' : 'flag'}-${dir > 0 ? 'bull' : 'bear'}`;
      const label = `${dir > 0 ? 'Bull' : 'Bear'} ${pennant ? 'pennant' : 'flag'}`;
      const top = hi, bot = lo;
      const bo = findBreakout(s, cEnd + 1, 10, { above: () => top, below: () => bot });
      const hit = finish(s, {
        id: `${kind}:${s.t[ps]}`,
        kind, label, bias: dir as Bias,
        start: ps + 1, end: cEnd,
        pivots: [pt(ps + 1, poleStart), pt(pe, poleTop)],
        lines: [[pt(pe + 1, top), pt(cEnd, top)], [pt(pe + 1, bot), pt(cEnd, bot)]],
        score: Math.min(1, Math.abs(move) / (6 * a)),
      }, dir as 1 | -1, bo, end - cEnd > 10,
      // guide: pole height added to the bottom of the pennant (mirrored for bear)
      (d) => (d > 0 ? bot + pole : top - pole));
      if (hit) out.push(hit);
      pe = cEnd; // skip past this consolidation
      break;
    }
  }
}

// ---------------- cup and handle ----------------

export function cups(s: Series, pv: Pivot[], out: PatternHit[]): void {
  const highs = pv.filter((p) => p.hi);
  for (let x = 0; x + 1 < highs.length; x++) {
    const L = highs[x], R = highs[x + 1];
    const span = R.i - L.i;
    if (span < 15) continue;
    const tol = tolerance(s, R.i);
    if (Math.abs(L.p - R.p) > tol * 2) continue;
    // bottom and roundness: fit a parabola to closes between the lips
    let bi = L.i;
    for (let i = L.i; i <= R.i; i++) if (s.l[i] < s.l[bi]) bi = i;
    const depth = Math.min(L.p, R.p) - s.l[bi];
    if (depth < 3 * s.atr[R.i]) continue;
    const pos = (bi - L.i) / span;
    if (pos < 0.25 || pos > 0.75) continue; // bottom roughly centred, not a V at one end
    // "not a V": the lowest third of the cup should last a while
    let nearBottom = 0;
    for (let i = L.i; i <= R.i; i++) if (s.c[i] < s.l[bi] + depth / 3) nearBottom++;
    if (nearBottom < span * 0.25) continue;
    // handle: a pullback after the right lip of at most half the cup depth
    let hl = Infinity, he = R.i;
    for (let i = R.i + 1; i <= Math.min(s.lastClosed, R.i + Math.round(span / 2)); i++) {
      if (s.c[i] > Math.max(L.p, R.p)) break;
      hl = Math.min(hl, s.l[i]);
      he = i;
    }
    if (he - R.i < 2 || R.p - hl > depth * 0.5) continue;
    const lip = Math.max(L.p, R.p);
    const bo = findBreakout(s, he + 1, Math.round(span / 2), { above: () => lip, below: () => hl });
    const hit = finish(s, {
      id: `cup-handle:${s.t[L.i]}`,
      kind: 'cup-handle', label: 'Cup & handle', bias: 1,
      start: L.i, end: he,
      pivots: [pt(L.i, L.p), pt(bi, s.l[bi]), pt(R.i, R.p), pt(he, hl)],
      lines: [[pt(L.i, lip), pt(he + 3, lip)]],
      score: nearBottom / span,
    }, 1, bo, s.lastClosed - he > span / 2,
    // guide: height from right lip to the bottom of the cup, added to the breakout
    (_d, px) => px + (R.p - s.l[bi]));
    if (hit) out.push(hit);
  }
}
