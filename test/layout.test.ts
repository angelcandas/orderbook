import { describe, expect, it } from 'vitest';
import {
  computeLayout, dragSplitter, evenSplitter, setPaneHidden, movePane, applyPreset, dropSide, normalizeLayout, paneOrder,
  DEFAULT_LAYOUT, PANE_IDS, PRESETS, type LayoutPrefs, type Layout,
} from '../src/render/layout';
import { normalizePrefs } from '../src/ui/prefs';

const tiles = (l: Layout, w: number, h: number) => {
  const rs = PANE_IDS.filter((id) => l.shown[id]).map((id) => l[id]);
  expect(rs.reduce((a, r) => a + r.w * r.h, 0)).toBe(w * h);
  for (const r of rs) expect(r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h).toBe(true);
  // no two overlap
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const a = rs[i], b = rs[j];
    expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
  }
};

describe('pane layout', () => {
  it('tiles the canvas with no gaps or overlap', () => {
    for (const [w, h] of [[1400, 800], [500, 900], [760, 300]]) tiles(computeLayout(w, h, DEFAULT_LAYOUT), w, h);
    for (const pr of PRESETS) tiles(computeLayout(1400, 800, applyPreset(DEFAULT_LAYOUT, pr.id)), 1400, 800);
  });

  it('keeps the old default split on wide screens', () => {
    const l = computeLayout(1200, 800);
    expect(l.ladder.w).toBe(336); // 28%
    expect(l.depth.h).toBe(288); // 36%
    expect(l.splitters).toHaveLength(2);
  });

  it('follows a splitter drag and clamps to a minimum pane size', () => {
    let l = computeLayout(1200, 800);
    const v = l.splitters.find((s) => s.orient === 'v')!;
    let p = dragSplitter(DEFAULT_LAYOUT, v, 600, false);
    expect(computeLayout(1200, 800, p).ladder.w).toBe(600);
    p = dragSplitter(p, v, 5, false);
    expect(computeLayout(1200, 800, p).ladder.w).toBe(200);
    l = computeLayout(1200, 800, p);
    const hs = l.splitters.find((s) => s.orient === 'h')!;
    p = dragSplitter(p, hs, 790, false);
    expect(computeLayout(1200, 800, p).candles.h).toBe(90);
    p = evenSplitter(p, computeLayout(1200, 800, p).splitters.find((s) => s.orient === 'h')!, false);
    expect(computeLayout(1200, 800, p).candles.h).toBe(400);
  });

  it('stacks the panes on narrow screens and drags their edges', () => {
    const l = computeLayout(500, 1000);
    expect(l.narrow).toBe(true);
    expect(l.ladder.y).toBe(0);
    expect(l.depth.y).toBe(l.ladder.h);
    expect(l.candles.y).toBe(l.depth.y + l.depth.h);
    const s = l.splitters[1];
    const p = dragSplitter(DEFAULT_LAYOUT, s, l.ladder.h + 100, true);
    expect(computeLayout(500, 1000, p).depth.h).toBe(100);
  });

  it('hides panes and gives their space to the others, never all of them', () => {
    let p = setPaneHidden(DEFAULT_LAYOUT, 'depth', true);
    let l = computeLayout(1200, 800, p);
    expect(l.shown.depth).toBe(false);
    expect(l.depth.w * l.depth.h).toBe(0);
    expect(l.candles.h).toBe(800);
    tiles(l, 1200, 800);
    p = setPaneHidden(p, 'ladder', true);
    l = computeLayout(1200, 800, p);
    expect(l.candles).toEqual({ x: 0, y: 0, w: 1200, h: 800 });
    expect(l.splitters).toHaveLength(0);
    expect(setPaneHidden(p, 'candles', true)).toBe(p); // the last one stays
    // shown again: back where it was
    p = setPaneHidden(setPaneHidden(p, 'ladder', false), 'depth', false);
    expect(computeLayout(1200, 800, p)).toEqual(computeLayout(1200, 800, DEFAULT_LAYOUT));
  });

  it('moves a pane next to another or along an edge', () => {
    // book to the right of the candles: depth | ... the book becomes a column inside the right split
    let p = movePane(DEFAULT_LAYOUT, 'ladder', null, 'right');
    let l = computeLayout(1200, 800, p);
    tiles(l, 1200, 800);
    expect(l.ladder.x + l.ladder.w).toBe(1200);
    expect(l.ladder.h).toBe(800);
    // candles across the whole top
    p = movePane(DEFAULT_LAYOUT, 'candles', null, 'top');
    l = computeLayout(1200, 800, p);
    tiles(l, 1200, 800);
    expect(l.candles).toMatchObject({ x: 0, y: 0, w: 1200 });
    expect(l.ladder.y).toBe(l.candles.h);
    // depth beside the candles rather than above
    p = movePane(DEFAULT_LAYOUT, 'depth', 'candles', 'left');
    l = computeLayout(1200, 800, p);
    tiles(l, 1200, 800);
    expect(l.depth.h).toBe(800);
    expect(l.depth.x + l.depth.w).toBe(l.candles.x);
    // the tree stays flat: a split left with one child collapses
    expect((p.root as any).kids.map((k: any) => k.pane)).toEqual(['ladder', 'depth', 'candles']);
    // onto itself: nothing changes
    expect(movePane(DEFAULT_LAYOUT, 'depth', 'depth', 'left')).toBe(DEFAULT_LAYOUT);
    // moving changes the stacking order on narrow screens
    expect(paneOrder(movePane(DEFAULT_LAYOUT, 'candles', 'ladder', 'top'))).toEqual(['candles', 'ladder', 'depth']);
  });

  it('picks the drop side by the nearest edge', () => {
    const r = { x: 0, y: 0, w: 200, h: 100 };
    expect(dropSide(r, 10, 50)).toBe('left');
    expect(dropSide(r, 190, 50)).toBe('right');
    expect(dropSide(r, 100, 5)).toBe('top');
    expect(dropSide(r, 100, 95)).toBe('bottom');
  });

  it('reads the old two-split format', () => {
    const p = normalizeLayout({ wide: { ladder: 0.3, depth: 0.5 }, narrow: { ladder: 0.5, depth: 0.5 } });
    const l = computeLayout(1000, 800, p);
    expect(l.ladder.w).toBe(300);
    expect(l.depth.h).toBe(400);
    const n = computeLayout(500, 800, p);
    expect(n.ladder.h).toBe(400);
    expect(n.depth.h).toBe(200);
  });

  it('repairs bad stored prefs', () => {
    expect(normalizeLayout({ wide: { ladder: 7, depth: NaN } })).toEqual(DEFAULT_LAYOUT);
    expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT);
    // a duplicate pane is dropped, a missing one comes back, all hidden means none hidden
    const bad = { v: 2, root: { dir: 'row', size: 1, kids: [{ pane: 'ladder', size: 1 }, { pane: 'ladder', size: 1 }, { pane: 'x', size: 1 }] }, hidden: ['ladder', 'depth', 'candles'] };
    const p: LayoutPrefs = normalizeLayout(bad);
    expect(paneOrder(p).sort()).toEqual(['candles', 'depth', 'ladder']);
    expect(p.hidden).toEqual([]);
    tiles(computeLayout(1200, 800, p), 1200, 800);
    const v = normalizePrefs({ fontPx: 99, sideW: 'x', depthRangePct: 0, candlesVisible: 5 });
    expect(v.fontPx).toBe(14);
    expect(v.sideW).toBe(310);
    expect(v.depthRangePct).toBe(0);
    expect(v.candlesVisible).toBe(30);
  });
});
