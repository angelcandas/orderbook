/**
 * Pane layout of the market canvas, shared by the render worker (which draws
 * into the rects) and the main thread (which places the resize handles, the
 * move grips and the zoom buttons over them). Pure: no DOM, no GL.
 *
 * The panes sit in a small split tree: a `row` node lays its children out
 * side by side, a `col` node stacks them. Each node's `size` is its weight
 * among its siblings. Hidden panes keep their place in the tree (showing one
 * again puts it back where it was); they just take no space. On narrow
 * screens the visible panes are stacked in tree order with their own heights.
 */
export interface Rect { x: number; y: number; w: number; h: number }

export type PaneId = 'ladder' | 'depth' | 'candles';
export const PANE_IDS: readonly PaneId[] = ['ladder', 'depth', 'candles'];

export type LayoutNode =
  | { pane: PaneId; size: number }
  | { dir: 'row' | 'col'; size: number; kids: LayoutNode[] };

export interface LayoutPrefs {
  v: 2;
  root: LayoutNode;
  hidden: PaneId[];
  /** height weights of the stacked panes on narrow screens */
  narrow: Record<PaneId, number>;
}

/** Where a dragged pane lands next to the pane under the pointer. */
export type DropSide = 'left' | 'right' | 'top' | 'bottom';

/** A resize handle between two visible siblings of a split node. */
export interface Splitter {
  /** child indices from the root to the split node; empty on narrow screens (the flat stack) */
  path: number[];
  /** the visible siblings on each side */
  a: number;
  b: number;
  /** 'v': a vertical bar, drags left and right; 'h': drags up and down */
  orient: 'v' | 'h';
  /** where the pair starts and how much space they share, px along the drag axis */
  start: number;
  span: number;
  /** the edge between them, px along the drag axis */
  at: number;
  /** the bar's extent across the drag axis */
  cross0: number;
  cross1: number;
  /** what the two sides hold, for labels */
  label: string;
}

export const NARROW_BELOW = 760;
const leaf = (pane: PaneId, size: number): LayoutNode => ({ pane, size });
export const DEFAULT_LAYOUT: LayoutPrefs = {
  v: 2,
  root: { dir: 'row', size: 1, kids: [leaf('ladder', 0.28), { dir: 'col', size: 0.72, kids: [leaf('depth', 0.36), leaf('candles', 0.64)] }] },
  hidden: [],
  narrow: { ladder: 0.42, depth: (1 - 0.42) * 0.4, candles: (1 - 0.42) * (1 - 0.4) }, // the old narrow default, as height shares
};

/** Smallest a pane may be dragged to, css px. */
const MIN_W = 200, MIN_H = 90;

export interface Layout {
  narrow: boolean;
  ladder: Rect;
  depth: Rect;
  candles: Rect;
  /** which panes take space (a hidden pane's rect is empty) */
  shown: Record<PaneId, boolean>;
  splitters: Splitter[];
}

const EMPTY: Rect = { x: 0, y: 0, w: 0, h: 0 };
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const pos = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : d);
const isPane = (x: unknown): x is PaneId => x === 'ladder' || x === 'depth' || x === 'candles';
const isLeaf = (n: LayoutNode): n is { pane: PaneId; size: number } => 'pane' in n;
export const paneLabel: Record<PaneId, string> = { ladder: 'order book', depth: 'depth chart', candles: 'candle chart' };

/** Repair a stored or partial prefs object, including the old fixed two-split format. */
export function normalizeLayout(p: any): LayoutPrefs {
  if (p && p.v !== 2 && (p.wide || p.narrow)) return fromV1(p);
  if (!p || p.v !== 2) return clone(DEFAULT_LAYOUT);
  const seen = new Set<PaneId>();
  const fix = (n: any): LayoutNode | null => {
    if (!n || typeof n !== 'object') return null;
    if (isPane(n.pane)) {
      if (seen.has(n.pane)) return null;
      seen.add(n.pane);
      return leaf(n.pane, pos(n.size, 1));
    }
    if ((n.dir === 'row' || n.dir === 'col') && Array.isArray(n.kids)) {
      const kids = n.kids.map(fix).filter(Boolean) as LayoutNode[];
      if (!kids.length) return null;
      if (kids.length === 1) return { ...kids[0], size: pos(n.size, 1) };
      return { dir: n.dir, size: pos(n.size, 1), kids };
    }
    return null;
  };
  let root = fix(p.root);
  // a pane missing from the tree goes back to the end of the outer split
  for (const id of PANE_IDS) if (!seen.has(id)) root = root ? insertAt(root, [], 'right', id) : leaf(id, 1);
  const hidden = Array.isArray(p.hidden) ? PANE_IDS.filter((id) => p.hidden.includes(id)) : [];
  return {
    v: 2,
    root: { ...root!, size: 1 },
    hidden: hidden.length >= PANE_IDS.length ? [] : hidden,
    narrow: {
      ladder: pos(p.narrow?.ladder, DEFAULT_LAYOUT.narrow.ladder),
      depth: pos(p.narrow?.depth, DEFAULT_LAYOUT.narrow.depth),
      candles: pos(p.narrow?.candles, DEFAULT_LAYOUT.narrow.candles),
    },
  };
}

/** The layout before panes could move: book on the left, depth over candles on the right. */
function fromV1(p: any): LayoutPrefs {
  const f = (x: unknown, d: number) => (typeof x === 'number' && x > 0 && x < 1 ? x : d);
  const wl = f(p.wide?.ladder, 0.28), wd = f(p.wide?.depth, 0.36);
  const nl = f(p.narrow?.ladder, 0.42), nd = f(p.narrow?.depth, 0.4);
  return {
    v: 2,
    root: { dir: 'row', size: 1, kids: [leaf('ladder', wl), { dir: 'col', size: 1 - wl, kids: [leaf('depth', wd), leaf('candles', 1 - wd)] }] },
    hidden: [],
    narrow: { ladder: nl, depth: (1 - nl) * nd, candles: (1 - nl) * (1 - nd) },
  };
}

const clone = (p: LayoutPrefs): LayoutPrefs => JSON.parse(JSON.stringify(p));

function visible(n: LayoutNode, hidden: readonly PaneId[]): boolean {
  return isLeaf(n) ? !hidden.includes(n.pane) : n.kids.some((k) => visible(k, hidden));
}

/** Visible panes in tree order. */
export function paneOrder(p: LayoutPrefs): PaneId[] {
  const out: PaneId[] = [];
  const walk = (n: LayoutNode) => { if (isLeaf(n)) { if (!p.hidden.includes(n.pane)) out.push(n.pane); } else n.kids.forEach(walk); };
  walk(p.root);
  return out;
}

/**
 * Split `len` px among weighted parts, whole pixels, each at least `min`
 * when there is room (less, evenly, when there is not).
 */
function share(len: number, weights: number[], min: number): number[] {
  const n = weights.length;
  const lo = Math.min(min, Math.floor(len / n));
  const tot = weights.reduce((a, b) => a + b, 0) || 1;
  const px = weights.map((w) => (len * w) / tot);
  // lift the parts under the minimum, taking the space from the others in proportion
  for (let pass = 0; pass < n; pass++) {
    const small = px.map((v) => v < lo);
    if (!small.some(Boolean)) break;
    const need = px.reduce((a, v, i) => a + (small[i] ? lo - v : 0), 0);
    const big = px.reduce((a, v, i) => a + (small[i] ? 0 : v - lo), 0);
    for (let i = 0; i < n; i++) px[i] = small[i] ? lo : lo + (px[i] - lo) * (big > 0 ? (big - need) / big : 0);
  }
  // round, giving the rounding remainder to the last part so the parts tile exactly
  const out: number[] = [];
  let acc = 0, done = 0;
  for (let i = 0; i < n; i++) {
    acc += px[i];
    const end = i === n - 1 ? len : Math.round(acc);
    out.push(end - done);
    done = end;
  }
  return out;
}

export function computeLayout(w: number, h: number, p: LayoutPrefs = DEFAULT_LAYOUT): Layout {
  const out: Layout = { narrow: w < NARROW_BELOW, ladder: EMPTY, depth: EMPTY, candles: EMPTY, shown: { ladder: false, depth: false, candles: false }, splitters: [] };
  const put = (id: PaneId, r: Rect) => { out[id] = r; out.shown[id] = true; };
  const names = (n: LayoutNode): string => (isLeaf(n) ? paneLabel[n.pane] : n.kids.filter((k) => visible(k, p.hidden)).map(names).join(' and '));

  if (out.narrow) {
    const order = paneOrder(p);
    const hs = share(h, order.map((id) => p.narrow[id]), MIN_H);
    let y = 0;
    order.forEach((id, i) => {
      put(id, { x: 0, y, w, h: hs[i] });
      if (i > 0) out.splitters.push({ path: [], a: i - 1, b: i, orient: 'h', start: y - hs[i - 1], span: hs[i - 1] + hs[i], at: y, cross0: 0, cross1: w, label: paneLabel[id] });
      y += hs[i];
    });
    return out;
  }

  const place = (n: LayoutNode, r: Rect, path: number[]) => {
    if (isLeaf(n)) { put(n.pane, r); return; }
    const vis = n.kids.map((k, i) => [k, i] as const).filter(([k]) => visible(k, p.hidden));
    const row = n.dir === 'row';
    const sizes = share(row ? r.w : r.h, vis.map(([k]) => k.size), row ? MIN_W : MIN_H);
    let off = row ? r.x : r.y;
    vis.forEach(([k, i], j) => {
      const s = sizes[j];
      if (j > 0) {
        const [pk, pi] = vis[j - 1];
        out.splitters.push({
          path, a: pi, b: i, orient: row ? 'v' : 'h', start: off - sizes[j - 1], span: sizes[j - 1] + s, at: off,
          cross0: row ? r.y : r.x, cross1: row ? r.y + r.h : r.x + r.w, label: `${names(pk)} and ${names(k)}`,
        });
      }
      place(k, row ? { x: off, y: r.y, w: s, h: r.h } : { x: r.x, y: off, w: r.w, h: s }, [...path, i]);
      off += s;
    });
  };
  place(p.root, { x: 0, y: 0, w, h }, []);
  return out;
}

function nodeAt(root: LayoutNode, path: number[]): LayoutNode {
  let n = root;
  for (const i of path) n = (n as { kids: LayoutNode[] }).kids[i];
  return n;
}

/**
 * Move splitter `s` (from computeLayout of the same prefs and size) so the
 * edge sits at `at` px along its axis. Only the two sides' weights change.
 */
export function dragSplitter(p: LayoutPrefs, s: Splitter, at: number, narrow: boolean): LayoutPrefs {
  const min = Math.min(s.orient === 'v' ? MIN_W : MIN_H, Math.floor(s.span / 2));
  const first = clamp(at - s.start, min, s.span - min);
  const next = clone(p);
  if (narrow) {
    const order = paneOrder(p);
    const ia = order[s.a], ib = order[s.b];
    const tot = p.narrow[ia] + p.narrow[ib];
    next.narrow[ia] = (tot * first) / s.span;
    next.narrow[ib] = tot - next.narrow[ia];
    return next;
  }
  const kids = (nodeAt(next.root, s.path) as { kids: LayoutNode[] }).kids;
  const tot = kids[s.a].size + kids[s.b].size;
  kids[s.a].size = (tot * first) / s.span;
  kids[s.b].size = tot - kids[s.a].size;
  return next;
}

/** Give two sides of a splitter equal space (double-click on a handle). */
export function evenSplitter(p: LayoutPrefs, s: Splitter, narrow: boolean): LayoutPrefs {
  return dragSplitter(p, s, s.start + s.span / 2, narrow);
}

/** Show or hide a pane. The last visible pane cannot be hidden. */
export function setPaneHidden(p: LayoutPrefs, id: PaneId, hide: boolean): LayoutPrefs {
  const hidden = hide ? [...new Set([...p.hidden, id])] : p.hidden.filter((x) => x !== id);
  if (hidden.length >= PANE_IDS.length) return p;
  return { ...p, hidden: PANE_IDS.filter((x) => hidden.includes(x)) };
}

/** Remove a pane's leaf, collapsing splits left with one child. */
function removePane(n: LayoutNode, id: PaneId): LayoutNode | null {
  if (isLeaf(n)) return n.pane === id ? null : n;
  const kids = n.kids.map((k) => removePane(k, id)).filter(Boolean) as LayoutNode[];
  if (!kids.length) return null;
  if (kids.length === 1) return { ...kids[0], size: n.size };
  // a child split that now runs the same way as this one merges into it
  const flat: LayoutNode[] = [];
  for (const k of kids) {
    if (!isLeaf(k) && k.dir === n.dir) {
      const t = k.kids.reduce((a, c) => a + c.size, 0) || 1;
      for (const c of k.kids) flat.push({ ...c, size: (c.size / t) * k.size });
    } else flat.push(k);
  }
  return { dir: n.dir, size: n.size, kids: flat };
}

/** Put pane `id` on `side` of the node at `path` (the root when empty). */
function insertAt(root: LayoutNode, path: number[], side: DropSide, id: PaneId): LayoutNode {
  const dir = side === 'left' || side === 'right' ? 'row' : 'col';
  const before = side === 'left' || side === 'top';
  const wrap = (target: LayoutNode): LayoutNode => {
    const fresh = leaf(id, 1);
    if (!isLeaf(target) && target.dir === dir) {
      // same direction: one more sibling, sized like an average one
      const avg = target.kids.reduce((a, k) => a + k.size, 0) / target.kids.length;
      fresh.size = avg;
      return { ...target, kids: before ? [fresh, ...target.kids] : [...target.kids, fresh] };
    }
    const t = { ...target, size: 1 };
    return { dir, size: target.size, kids: before ? [fresh, t] : [t, fresh] };
  };
  if (!path.length) return { ...wrap(root), size: 1 };
  const parent = nodeAt(root, path.slice(0, -1)) as { dir: 'row' | 'col'; kids: LayoutNode[] };
  const i = path[path.length - 1];
  const target = parent.kids[i];
  if (parent.dir === dir) {
    // the target's parent already runs this way: split the target's share between the two
    const fresh = leaf(id, target.size / 2);
    target.size /= 2;
    parent.kids.splice(before ? i : i + 1, 0, fresh);
  } else parent.kids[i] = wrap(target);
  return root;
}

function pathOf(n: LayoutNode, id: PaneId, path: number[] = []): number[] | null {
  if (isLeaf(n)) return n.pane === id ? path : null;
  for (let i = 0; i < n.kids.length; i++) {
    const r = pathOf(n.kids[i], id, [...path, i]);
    if (r) return r;
  }
  return null;
}

/**
 * Move pane `id` to `side` of pane `target`; `target` null means `side` of
 * the whole canvas. On narrow screens only the stacking order matters.
 */
export function movePane(p: LayoutPrefs, id: PaneId, target: PaneId | null, side: DropSide): LayoutPrefs {
  if (id === target) return p;
  const next = clone(p);
  const rest = removePane(next.root, id);
  if (!rest) return p;
  const path = target ? pathOf(rest, target) : [];
  if (!path) return p;
  next.root = insertAt(rest, path, side, id);
  next.root.size = 1;
  return next;
}

/** Which side of `r` the point is nearest, by the diagonals. */
export function dropSide(r: Rect, x: number, y: number): DropSide {
  const u = (x - r.x) / Math.max(1, r.w) - 0.5, v = (y - r.y) / Math.max(1, r.h) - 0.5;
  return Math.abs(u) > Math.abs(v) ? (u < 0 ? 'left' : 'right') : (v < 0 ? 'top' : 'bottom');
}

/** The half of `r` a pane dropped on `side` would take, for the drop preview. */
export function dropPreview(r: Rect, side: DropSide): Rect {
  const hw = Math.round(r.w / 2), hh = Math.round(r.h / 2);
  switch (side) {
    case 'left': return { x: r.x, y: r.y, w: hw, h: r.h };
    case 'right': return { x: r.x + r.w - hw, y: r.y, w: hw, h: r.h };
    case 'top': return { x: r.x, y: r.y, w: r.w, h: hh };
    case 'bottom': return { x: r.x, y: r.y + r.h - hh, w: r.w, h: hh };
  }
}

/** Ready-made arrangements offered in the layout menu. */
export const PRESETS: { id: string; name: string; root: LayoutNode }[] = [
  { id: 'classic', name: 'Book left, depth over candles', root: DEFAULT_LAYOUT.root },
  { id: 'book-right', name: 'Candles left, book right', root: { dir: 'row', size: 1, kids: [{ dir: 'col', size: 0.72, kids: [leaf('candles', 0.64), leaf('depth', 0.36)] }, leaf('ladder', 0.28)] } },
  { id: 'chart-top', name: 'Candles on top, book and depth below', root: { dir: 'col', size: 1, kids: [leaf('candles', 0.6), { dir: 'row', size: 0.4, kids: [leaf('ladder', 0.5), leaf('depth', 0.5)] }] } },
  { id: 'columns', name: 'Three columns', root: { dir: 'row', size: 1, kids: [leaf('ladder', 0.25), leaf('candles', 0.5), leaf('depth', 0.25)] } },
];

export function applyPreset(p: LayoutPrefs, id: string): LayoutPrefs {
  const pr = PRESETS.find((x) => x.id === id);
  return pr ? { ...p, root: JSON.parse(JSON.stringify(pr.root)) } : p;
}

/** Zoom limits and defaults for each pane. */
export const ZOOM = {
  candles: { min: 30, max: 2000, def: 160 },
  priceScale: { min: 0.2, max: 40, def: 1 },
  depthPct: { min: 0.01, max: 20 },
  rowPad: { min: 0, max: 14, def: 3 },
  font: { min: 9, max: 14, def: 11 },
} as const;
