import { describe, expect, it } from 'vitest';
import { computeLayout, dragSplit, DEFAULT_LAYOUT, normalizeLayout } from '../src/render/layout';
import { normalizePrefs } from '../src/ui/prefs';

describe('pane layout', () => {
  it('tiles the canvas with no gaps or overlap', () => {
    for (const [w, h] of [[1400, 800], [500, 900], [760, 300]]) {
      const l = computeLayout(w, h, DEFAULT_LAYOUT);
      const area = [l.ladder, l.depth, l.candles].reduce((a, r) => a + r.w * r.h, 0);
      expect(area).toBe(w * h);
      for (const r of [l.ladder, l.depth, l.candles]) expect(r.w > 0 && r.h > 0).toBe(true);
    }
  });

  it('keeps the old default split on wide screens', () => {
    const l = computeLayout(1200, 800);
    expect(l.ladder.w).toBe(336); // 28%
    expect(l.depth.h).toBe(288); // 36%
  });

  it('follows a drag and clamps to a minimum pane size', () => {
    let p = dragSplit(DEFAULT_LAYOUT, 'ladder', 600, 0, 1200, 800);
    expect(computeLayout(1200, 800, p).ladder.w).toBe(600);
    p = dragSplit(p, 'ladder', 5, 0, 1200, 800);
    expect(computeLayout(1200, 800, p).ladder.w).toBe(200);
    p = dragSplit(p, 'depth', 0, 790, 1200, 800);
    const l = computeLayout(1200, 800, p);
    expect(l.candles.h).toBe(90);
  });

  it('drags the depth split relative to the space under the ladder when narrow', () => {
    const base = computeLayout(500, 1000);
    const p = dragSplit(DEFAULT_LAYOUT, 'depth', 0, base.ladder.h + 100, 500, 1000);
    expect(computeLayout(500, 1000, p).depth.h).toBe(100);
  });

  it('repairs bad stored prefs', () => {
    expect(normalizeLayout({ wide: { ladder: 7, depth: NaN } } as any)).toEqual(DEFAULT_LAYOUT);
    const v = normalizePrefs({ fontPx: 99, sideW: 'x', depthRangePct: 0, candlesVisible: 5 });
    expect(v.fontPx).toBe(14);
    expect(v.sideW).toBe(310);
    expect(v.depthRangePct).toBe(0);
    expect(v.candlesVisible).toBe(30);
  });
});
