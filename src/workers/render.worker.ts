/// <reference lib="webworker" />
import { Gfx } from '../render/gl';
import { Scene, PANE_ALL, PANE_CANDLES, PANE_DEPTH, PANE_LADDER, type SceneSettings } from '../render/scene';
import { DARK, LIGHT, type Theme } from '../render/theme';
import { Histogram, nowAbs } from '../shared/hist';
import { H, VIEW_LEN, seqRead, wrapView } from '../shared/view';
import type { Venue } from '../shared/config';
import type { AnalyticsOut } from '../patterns/types';
import type { RenderCmd, RenderStats, WindowPicked, ZoomPane, ZoomState } from './protocol';
import { DEFAULT_LAYOUT, ZOOM, normalizeLayout, type LayoutPrefs } from '../render/layout';

let FONT: number = ZOOM.font.def;
let layoutPrefs: LayoutPrefs = DEFAULT_LAYOUT;
let viewW = 0, viewH = 0;
let gfx: Gfx;
let scene: Scene;
let theme: Theme = DARK;
let settings: SceneSettings;
let venue: Venue = 'kraken';
let shared = true;
const views: Record<Venue, { seq: Int32Array; data: Float64Array } | null> = { kraken: null, binance: null };
const fallback: Record<Venue, Float64Array | null> = { kraken: null, binance: null };
const ports: Partial<Record<Venue, MessagePort>> = {};
const local = new Float64Array(VIEW_LEN);
let analytics: AnalyticsOut | null = null;
const ptr = { x: 0, y: 0, in: false };
let dirty = PANE_ALL;
let lastCandleDraw = 0;
let lastPtrPane = 0;
const COUNTDOWN_MS = 1000;
const PRICE_LINE_MS = 100; // the live price line on the candle chart refreshes at 10 Hz
let animating = false;
let lastVersion = -1;
let lastFrameTs = 0;

const intervalH = new Histogram();
const cpuH = new Histogram();
const latencyH = new Histogram();
let frames = 0, drawn = 0, skipped = 0;
let lastLatencyRecv = 0;

function readView(): boolean {
  if (shared) {
    const v = views[venue];
    return !!v && seqRead(v.seq, v.data, local);
  }
  const f = fallback[venue];
  if (!f) return false;
  local.set(f);
  return true;
}

function frame(ts: number): void {
  requestAnimationFrame(frame);
  frames++;
  if (lastFrameTs) intervalH.record(ts - lastFrameTs);
  lastFrameTs = ts;
  const t0 = performance.now();
  const ok = readView();
  const version = ok ? local[H.version] + local[H.pair] * 1e12 : -1;
  const changed = version !== lastVersion;
  if (changed) dirty |= PANE_LADDER | PANE_DEPTH;
  if (animating) dirty |= PANE_LADDER;
  if (changed && ts - lastCandleDraw >= PRICE_LINE_MS) dirty |= PANE_CANDLES;
  // the close countdown under the price tag ticks once a second even when the book is quiet
  if (ts - lastCandleDraw >= COUNTDOWN_MS) dirty |= PANE_CANDLES;
  if (!dirty) {
    skipped++;
    return; // nothing new: skip the frame, save power
  }
  lastVersion = version;
  if (dirty & PANE_CANDLES) lastCandleDraw = ts;
  if (!ok) local.fill(NaN);
  const d = dirty;
  dirty = 0;
  animating = scene.draw(local, analytics, ptr, settings, theme, ts, d);
  drawn++;
  cpuH.record(performance.now() - t0);
  // receive-to-draw latency: newest message the frame shows vs now
  const recv = local[H.lastRecv];
  if (changed && recv > 0 && recv !== lastLatencyRecv) {
    lastLatencyRecv = recv;
    latencyH.record(nowAbs() - recv);
  }
}

function clampFont(px: number): number {
  return Math.max(ZOOM.font.min, Math.min(ZOOM.font.max, Math.round(px) || ZOOM.font.def));
}

/** Zoom one pane in (+1), out (-1) or back to its default (0), then report the new state. */
function zoom(pane: ZoomPane, dir: 1 | -1 | 0): void {
  if (pane === 'candles') {
    const c = ZOOM.candles;
    settings.candlesVisible = dir === 0 ? c.def : Math.max(c.min, Math.min(c.max, Math.round(settings.candlesVisible * (dir < 0 ? 1.15 : 0.87))));
    if (dir === 0) {
      // fit resets both axes and scrolls back to live
      settings.candlesPriceScale = ZOOM.priceScale.def;
      settings.candlesOffset = 0;
      settings.candlesPricePan = 0;
    }
    dirty |= PANE_CANDLES;
  } else if (pane === 'depth') {
    const d = ZOOM.depthPct;
    // 0 = auto-fit; zooming starts from whatever range auto-fit is showing
    settings.depthRangePct = dir === 0 ? 0 : Math.max(d.min, Math.min(d.max, scene.depthPct * (dir < 0 ? 1.2 : 0.83)));
    if (dir === 0) settings.depthShiftPct = 0;
    dirty |= PANE_DEPTH;
  } else {
    const r = ZOOM.rowPad;
    const cur = settings.ladderRowPad ?? r.def;
    settings.ladderRowPad = dir === 0 ? r.def : Math.max(r.min, Math.min(r.max, cur + dir * 2));
    dirty |= PANE_LADDER;
  }
  reportZoom();
}

function reportZoom(): void {
  const z: ZoomState = { type: 'zoom', candlesVisible: settings.candlesVisible, depthRangePct: settings.depthRangePct, ladderRowPad: settings.ladderRowPad ?? ZOOM.rowPad.def, candlesPriceScale: settings.candlesPriceScale ?? 1 };
  postMessage(z);
}

/**
 * Zoom one axis by `factor` (>1 = in); 0 resets it. 'x' / 'y' are the candle
 * chart's time and price axes, 'depth' the depth chart's price axis.
 */
function axisScale(axis: 'x' | 'y' | 'depth', factor: number): void {
  if (axis === 'y') {
    const p = ZOOM.priceScale;
    settings.candlesPriceScale = factor === 0 ? p.def : Math.max(p.min, Math.min(p.max, (settings.candlesPriceScale ?? 1) * factor));
    if (factor === 0) settings.candlesPricePan = 0;
    dirty |= PANE_CANDLES;
  } else if (axis === 'x') {
    const c = ZOOM.candles;
    settings.candlesVisible = factor === 0 ? c.def : Math.max(c.min, Math.min(c.max, settings.candlesVisible / factor));
    if (factor === 0) settings.candlesOffset = 0;
    dirty |= PANE_CANDLES;
  } else {
    const d = ZOOM.depthPct;
    settings.depthRangePct = factor === 0 ? 0 : Math.max(d.min, Math.min(d.max, scene.depthPct / factor));
    if (factor === 0) settings.depthShiftPct = 0;
    dirty |= PANE_DEPTH;
  }
  reportZoom();
}

/**
 * Scroll (and if needed zoom out) the candles so the whole pattern sits in
 * view with a few bars of context; leave the view alone if it already does.
 */
function reveal(id: string): void {
  const a = analytics;
  const p = a?.patterns.find((x) => x.id === id);
  if (!a || !p) return;
  const N = a.c.length;
  const c = ZOOM.candles;
  const lastBar = Math.max(p.end, p.breakout?.i ?? 0);
  const need = lastBar - p.start + 1 + 6;
  let zoomed = false;
  if (need > settings.candlesVisible) { settings.candlesVisible = Math.min(c.max, need); zoomed = true; }
  const vis = Math.max(Math.min(20, N), Math.min(N, Math.round(settings.candlesVisible)));
  const end = N - Math.max(0, Math.min(N - vis, Math.round(settings.candlesOffset ?? 0)));
  if (p.start < end - vis || lastBar >= end || zoomed) {
    // centre the pattern; offset counts bars back from the newest
    const mid = Math.round((p.start + lastBar) / 2);
    const wantEnd = Math.min(N, mid + Math.ceil(vis / 2));
    settings.candlesOffset = Math.max(0, Math.min(N - vis, N - wantEnd));
    settings.candlesPricePan = 0;
  }
  if (zoomed) reportZoom();
  dirty |= PANE_CANDLES;
}

/**
 * Wheel / trackpad scroll. A plain scroll pans (candles: time with dx, price
 * with dy; depth: price with dx). A pinch, which browsers send as a wheel with
 * ctrl held, zooms the pane under the pointer instead.
 */
function scroll(x: number, y: number, dx: number, dy: number, pinch: boolean): void {
  const pane = scene.paneAt(x, y);
  if (pinch) {
    const f = Math.exp(-dy / 100); // pinch out (negative dy) zooms in
    if (pane === PANE_CANDLES) axisScale('x', f);
    else if (pane === PANE_DEPTH) axisScale('depth', f);
    else if (pane === PANE_LADDER && Math.abs(dy) > 2) zoom('ladder', dy < 0 ? 1 : -1);
    return;
  }
  if (pane === PANE_CANDLES) {
    const m = scene.candleScroll();
    if (!m) return;
    const vis = Math.min(m.n, Math.round(settings.candlesVisible));
    // scrolling right (dx > 0) moves towards the newest bar
    const off = (settings.candlesOffset ?? 0) - dx / m.step;
    settings.candlesOffset = Math.max(0, Math.min(Math.max(0, m.n - vis), off));
    // scrolling down (dy > 0) moves the view to lower prices
    settings.candlesPricePan = Math.max(-20, Math.min(20, (settings.candlesPricePan ?? 0) - dy / m.ph / 2));
    dirty |= PANE_CANDLES;
  } else if (pane === PANE_DEPTH) {
    const pw = Math.max(1, scene.depth.w - 76);
    const shift = (settings.depthShiftPct ?? 0) + (dx / pw) * 2 * scene.depthPct;
    settings.depthShiftPct = Math.max(-20, Math.min(20, shift));
    dirty |= PANE_DEPTH;
  }
}

function stats(): void {
  const iv = intervalH.summary();
  const s: RenderStats = {
    type: 'stats',
    frames, drawn, skipped,
    frameInterval: iv,
    cpu: cpuH.summary(),
    latency: latencyH.summary(),
    gpuMs: gfx.gpuMs,
    dropped: intervalH.countAbove(1.5 * (iv.p50 || 16.7)),
    renderer: 'webgl2-offscreen',
    ...({ quadAreaPerFrame: gfx.area / Math.max(1, drawn), glyphVerts: gfx.glyphs.n, shapeVerts: gfx.shapes.n } as any),
  };
  postMessage(s);
}

self.onmessage = (e: MessageEvent<RenderCmd>) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      shared = m.shared;
      settings = m.settings;
      layoutPrefs = normalizeLayout(m.layout);
      FONT = clampFont(m.fontPx ?? FONT);
      viewW = m.w; viewH = m.h;
      theme = m.theme === 'light' ? LIGHT : DARK;
      gfx = new Gfx(m.canvas, FONT);
      gfx.resize(m.w, m.h, m.dpr, FONT);
      scene = new Scene(gfx);
      scene.layout(m.w, m.h, layoutPrefs);
      if (shared) {
        views.kraken = wrapView(m.views.kraken);
        views.binance = wrapView(m.views.binance);
      }
      for (const v of ['kraken', 'binance'] as Venue[]) {
        const p = (ports[v] = m.feedPorts[v]);
        p.onmessage = (ev) => {
          if (ev.data?.type !== 'view') return;
          const old = fallback[v];
          fallback[v] = ev.data.data;
          if (old) p.postMessage({ type: 'return', data: old }, [old.buffer]);
        };
      }
      if (m.liqPort) m.liqPort.onmessage = (ev) => {
        const d = ev.data;
        if (d.type === 'liq') scene.liq.frame(d);
        else if (d.type === 'liqTail') scene.liq.tail(d);
        else if (d.type === 'liqClear') scene.liq.clear();
        dirty |= PANE_CANDLES;
      };
      m.analyticsPort.onmessage = (ev) => {
        const next = ev.data as AnalyticsOut;
        // scrolled back: keep the same bars in view as new ones arrive
        const grew = analytics && next.symbol === analytics.symbol ? next.c.length - analytics.c.length : 0;
        if (settings.candlesOffset && grew > 0 && grew < 5) settings.candlesOffset += grew;
        analytics = next;
        dirty |= PANE_CANDLES;
      };
      requestAnimationFrame(frame);
      setInterval(stats, 1000);
      break;
    }
    case 'resize':
      gfx.resize(m.w, m.h, m.dpr, FONT);
      viewW = m.w; viewH = m.h;
      scene.layout(m.w, m.h, layoutPrefs);
      dirty = PANE_ALL;
      break;
    case 'venue':
      venue = m.venue;
      analytics = null;
      dirty = PANE_ALL;
      break;
    case 'pointer':
      ptr.x = m.x; ptr.y = m.y; ptr.in = m.in;
      {
        const pane = m.in ? scene.paneAt(m.x, m.y) : 0;
        dirty |= pane | lastPtrPane; // redraw where the crosshair is and where it was
        lastPtrPane = pane;
      }
      break;
    case 'click': {
      const lb = scene.liveBox;
      if (lb && m.x >= lb.x && m.x <= lb.x + lb.w && m.y >= lb.y && m.y <= lb.y + lb.h) {
        settings.candlesOffset = 0;
        settings.candlesPricePan = 0;
        dirty |= PANE_CANDLES;
        break;
      }
      const hit = scene.patternBoxes.find((b) => m.x >= b.x && m.x <= b.x + b.w && m.y >= b.y && m.y <= b.y + b.h);
      settings.selectedPattern = hit ? (settings.selectedPattern === hit.id ? null : hit.id) : settings.selectedPattern;
      if (hit) postMessage({ type: 'selected', id: settings.selectedPattern });
      dirty = PANE_ALL;
      break;
    }
    case 'brush': {
      if (m.phase === 'move') scene.brush = { x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1 };
      else {
        scene.brush = null;
        if (m.phase === 'end') {
          const w = scene.windowFromPx(m.x0, m.y0, m.x1, m.y1);
          if (w) settings.analysisWindow = w;
          const out: WindowPicked = { type: 'window', window: w };
          postMessage(out);
        }
      }
      dirty |= PANE_CANDLES;
      break;
    }
    case 'wheel':
      scroll(m.x, m.y, m.dx, m.dy, m.pinch);
      break;
    case 'zoom':
      zoom(m.pane, m.dir);
      break;
    case 'axisScale':
      axisScale(m.axis, m.factor);
      break;
    case 'layout':
      layoutPrefs = normalizeLayout(m.layout);
      scene.layout(viewW, viewH, layoutPrefs);
      dirty = PANE_ALL;
      break;
    case 'font':
      FONT = clampFont(m.px);
      gfx.setFontPx(FONT);
      dirty = PANE_ALL;
      break;
    case 'settings':
      Object.assign(settings, m.settings);
      dirty = PANE_ALL;
      break;
    case 'reveal':
      settings.selectedPattern = m.id;
      if (m.id) reveal(m.id);
      dirty = PANE_ALL;
      break;
    case 'theme':
      theme = m.theme === 'light' ? LIGHT : DARK;
      dirty = PANE_ALL;
      break;
    case 'resetStats':
      intervalH.reset(); cpuH.reset(); latencyH.reset();
      frames = drawn = skipped = 0;
      break;
  }
};
