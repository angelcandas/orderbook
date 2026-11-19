/// <reference lib="webworker" />
import { Gfx } from '../render/gl';
import { Scene, PANE_ALL, PANE_CANDLES, PANE_DEPTH, PANE_LADDER, type SceneSettings } from '../render/scene';
import { DARK, LIGHT, type Theme } from '../render/theme';
import { Histogram, nowAbs } from '../shared/hist';
import { H, VIEW_LEN, seqRead, wrapView } from '../shared/view';
import type { Venue } from '../shared/config';
import type { AnalyticsOut } from '../patterns/types';
import type { RenderCmd, RenderStats } from './protocol';

const FONT = 11;
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
      theme = m.theme === 'light' ? LIGHT : DARK;
      gfx = new Gfx(m.canvas, FONT);
      gfx.resize(m.w, m.h, m.dpr, FONT);
      scene = new Scene(gfx);
      scene.layout(m.w, m.h);
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
      m.analyticsPort.onmessage = (ev) => {
        analytics = ev.data as AnalyticsOut;
        dirty |= PANE_CANDLES;
      };
      requestAnimationFrame(frame);
      setInterval(stats, 1000);
      break;
    }
    case 'resize':
      gfx.resize(m.w, m.h, m.dpr, FONT);
      scene.layout(m.w, m.h);
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
      const hit = scene.patternBoxes.find((b) => m.x >= b.x && m.x <= b.x + b.w && m.y >= b.y && m.y <= b.y + b.h);
      settings.selectedPattern = hit ? (settings.selectedPattern === hit.id ? null : hit.id) : settings.selectedPattern;
      if (hit) postMessage({ type: 'selected', id: settings.selectedPattern });
      dirty = PANE_ALL;
      break;
    }
    case 'wheel': {
      const c = scene.candles, d = scene.depth;
      if (m.x >= c.x && m.y >= c.y && m.y <= c.y + c.h) settings.candlesVisible = Math.max(30, Math.min(720, Math.round(settings.candlesVisible * (m.dy > 0 ? 1.15 : 0.87))));
      else if (m.x >= d.x && m.y >= d.y && m.y <= d.y + d.h) settings.depthRangePct = Math.max(0.01, Math.min(20, scene.depthPct * (m.dy > 0 ? 1.2 : 0.83)));
      dirty = PANE_ALL;
      break;
    }
    case 'settings':
      Object.assign(settings, m.settings);
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
