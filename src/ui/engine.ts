import { allocView, sabSupported, H, LAD_ASK, LAD_BID, VIEW_LEN, seqRead, STATUS_NAMES } from '../shared/view';
import { PAIRS, type Endpoints, type Interval, type Venue } from '../shared/config';
import { Histogram, type HistSummary } from '../shared/hist';
import type { FeedStats, RenderStats } from '../workers/protocol';
import type { SceneSettings } from '../render/scene';
import type { PatternHit } from '../patterns/types';
import type { Outcome } from '../patterns/detect';
import { armed, type Alert, type AlertHit } from '../alerts/alerts';

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  endpoints: Endpoints;
  pairCount: number; // how many pairs each venue keeps live (load)
  depth: { kraken: number; binance: number };
  venue: Venue;
  pair: number;
  group: number;
  interval: Interval;
  settings: SceneSettings;
  theme: 'dark' | 'light';
}

export interface MainStats {
  frameInterval: HistSummary;
  loafCount: number;
  loafBlockingMs: number;
  loafTotalMs: number;
  longestLoaf: number;
  heapMB: number | null;
}

export interface Snapshot {
  t: number;
  shared: boolean;
  feeds: Partial<Record<Venue, FeedStats>>;
  render: RenderStats | null;
  main: MainStats;
  patterns: { list: PatternHit[]; outcomes: Outcome[]; computeMs: number; candles: number; backfill: number; source: string };
}

export interface LadderRow { price: number; qty: number; cum: number }

export class Engine {
  readonly shared = sabSupported();
  private views = { kraken: allocView(), binance: allocView() };
  private feeds: Record<Venue, Worker>;
  private analytics: Worker;
  private render: Worker;
  private snap: Snapshot;
  private rafH = new Histogram();
  private loaf = { count: 0, blocking: 0, total: 0, longest: 0 };
  private rafId = 0;
  private observer: PerformanceObserver | null = null;
  private timers: any[] = [];
  private local = new Float64Array(VIEW_LEN);
  onStats: (s: Snapshot) => void = () => {};
  onSelected: (id: string | null) => void = () => {};
  onAlert: (hit: AlertHit) => void = () => {};
  /** venue symbols each feed keeps live; alerts on other pairs wait until they are */
  readonly liveSymbols: Record<Venue, Set<string>>;

  constructor(private o: EngineOptions) {
    // written out in full so the bundler can find and build each worker
    this.feeds = {
      kraken: new Worker(new URL('../workers/feed.worker.ts', import.meta.url), { type: 'module', name: 'feed-kraken' }),
      binance: new Worker(new URL('../workers/feed.worker.ts', import.meta.url), { type: 'module', name: 'feed-binance' }),
    };
    this.analytics = new Worker(new URL('../workers/analytics.worker.ts', import.meta.url), { type: 'module', name: 'analytics' });
    this.render = new Worker(new URL('../workers/render.worker.ts', import.meta.url), { type: 'module', name: 'render' });
    this.snap = { t: 0, shared: this.shared, feeds: {}, render: null, main: this.mainStats(), patterns: { list: [], outcomes: [], computeMs: 0, candles: 0, backfill: 0, source: '' } };

    const fr = { kraken: new MessageChannel(), binance: new MessageChannel() };
    const fa = { kraken: new MessageChannel(), binance: new MessageChannel() };
    const ar = new MessageChannel();
    const pairs = PAIRS.slice(0, Math.max(1, o.pairCount));
    if (!pairs.includes(PAIRS[o.pair])) pairs.push(PAIRS[o.pair]);
    this.liveSymbols = { kraken: new Set(pairs.map((p) => p.kraken)), binance: new Set(pairs.map((p) => p.binance)) };

    for (const v of ['kraken', 'binance'] as Venue[]) {
      const w = this.feeds[v];
      w.onmessage = (e) => {
        if (e.data.type === 'stats') this.snap.feeds[v] = e.data;
        else if (e.data.type === 'alert') this.onAlert(e.data);
      };
      w.postMessage({
        type: 'init', venue: v, endpoints: o.endpoints,
        symbols: pairs.map((p) => p[v]), depth: o.depth[v],
        view: this.views[v].buffer, shared: this.shared,
        renderPort: fr[v].port1, analyticsPort: fa[v].port1,
      }, [fr[v].port1, fa[v].port1]);
    }
    this.analytics.postMessage({ type: 'init', renderPort: ar.port1, feedPorts: [fa.kraken.port2, fa.binance.port2] }, [ar.port1, fa.kraken.port2, fa.binance.port2]);
    this.analytics.onmessage = (e) => {
      if (e.data.type === 'patterns' && e.data.venue === this.o.venue) {
        this.snap.patterns = { list: e.data.patterns, outcomes: e.data.outcomes, computeMs: e.data.computeMs, candles: e.data.candles, backfill: e.data.backfill ?? 0, source: e.data.source ?? '' };
      }
    };

    const rect = o.canvas.getBoundingClientRect();
    const off = o.canvas.transferControlToOffscreen();
    this.render.postMessage({
      type: 'init', canvas: off, w: rect.width, h: rect.height, dpr: devicePixelRatio,
      views: { kraken: this.views.kraken.buffer, binance: this.views.binance.buffer }, shared: this.shared,
      feedPorts: { kraken: fr.kraken.port2, binance: fr.binance.port2 }, analyticsPort: ar.port2,
      settings: o.settings, theme: o.theme,
    }, [off, fr.kraken.port2, fr.binance.port2, ar.port2]);
    this.render.onmessage = (e) => {
      if (e.data.type === 'stats') this.snap.render = e.data;
      else if (e.data.type === 'selected') this.onSelected(e.data.id);
    };

    this.applyFocus();
    this.startMainMetrics();
    this.timers.push(setInterval(() => {
      this.snap.t = performance.now();
      this.snap.main = this.mainStats();
      this.onStats({ ...this.snap });
    }, 1000));
  }

  private startMainMetrics(): void {
    let last = 0;
    const tick = (ts: number) => {
      if (last) this.rafH.record(ts - last);
      last = ts;
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
    if (PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {
      this.observer = new PerformanceObserver((list) => {
        for (const en of list.getEntries() as any[]) {
          this.loaf.count++;
          this.loaf.blocking += en.blockingDuration ?? 0;
          this.loaf.total += en.duration;
          this.loaf.longest = Math.max(this.loaf.longest, en.duration);
        }
      });
      this.observer.observe({ type: 'long-animation-frame', buffered: false });
    }
    const mem = (performance as any).measureUserAgentSpecificMemory;
    if (mem && (globalThis as any).crossOriginIsolated) {
      const sample = async () => {
        try { this.heapMB = (await mem.call(performance)).bytes / 1048576; } catch { /* not allowed */ }
      };
      sample();
      this.timers.push(setInterval(sample, 10_000));
    }
  }
  private heapMB: number | null = null;

  private mainStats(): MainStats {
    return {
      frameInterval: this.rafH.summary(),
      loafCount: this.loaf.count, loafBlockingMs: this.loaf.blocking, loafTotalMs: this.loaf.total, longestLoaf: this.loaf.longest,
      heapMB: this.heapMB ?? ((performance as any).memory ? (performance as any).memory.usedJSHeapSize / 1048576 : null),
    };
  }

  private applyFocus(): void {
    const p = PAIRS[this.o.pair];
    for (const v of ['kraken', 'binance'] as Venue[]) {
      this.feeds[v].postMessage({ type: 'focus', symbol: p[v], pair: this.o.pair, group: this.o.group });
      this.feeds[v].postMessage({ type: 'candles', symbol: v === this.o.venue ? p[v] : null, interval: this.o.interval });
    }
    this.analytics.postMessage({ type: 'venue', venue: this.o.venue });
    this.render.postMessage({ type: 'venue', venue: this.o.venue });
    this.render.postMessage({ type: 'settings', settings: { venueLabel: this.o.venue.toUpperCase(), pairLabel: p.label } });
  }

  setVenue(v: Venue): void { this.o.venue = v; this.applyFocus(); }
  setPair(i: number): void { this.o.pair = i; this.analytics.postMessage({ type: 'reset' }); this.applyFocus(); }
  setGroup(g: number): void { this.o.group = g; this.applyFocus(); }
  setInterval(m: Interval): void { this.o.interval = m; this.analytics.postMessage({ type: 'reset' }); this.applyFocus(); }
  /** Hand each feed the armed alerts for its venue (replaces the previous set). */
  setAlerts(list: Alert[]): void {
    for (const v of ['kraken', 'binance'] as Venue[]) this.feeds[v].postMessage({ type: 'alerts', list: armed(list, v) });
  }
  setSettings(s: Partial<SceneSettings>): void { this.render.postMessage({ type: 'settings', settings: s }); }
  setTheme(t: 'dark' | 'light'): void { this.render.postMessage({ type: 'theme', theme: t }); }
  resize(w: number, h: number): void { this.render.postMessage({ type: 'resize', w, h, dpr: devicePixelRatio }); }
  pointer(x: number, y: number, inside: boolean): void { this.render.postMessage({ type: 'pointer', x, y, in: inside }); }
  click(x: number, y: number): void { this.render.postMessage({ type: 'click', x, y }); }
  wheel(x: number, y: number, dy: number): void { this.render.postMessage({ type: 'wheel', x, y, dy }); }

  resetStats(): void {
    this.rafH.reset();
    this.loaf = { count: 0, blocking: 0, total: 0, longest: 0 };
    this.render.postMessage({ type: 'resetStats' });
    for (const w of Object.values(this.feeds)) w.postMessage({ type: 'resetStats' });
  }

  snapshot(): Snapshot {
    return { ...this.snap, t: performance.now(), main: this.mainStats() };
  }

  /** Read the focused book for the accessible table (main thread, low rate). */
  ladder(): { status: string; bids: LadderRow[]; asks: LadderRow[]; decimals: number; bestBid: number; bestAsk: number } | null {
    if (!this.shared) return null;
    const v = this.views[this.o.venue];
    if (!seqRead(v.seq, v.data, this.local)) return null;
    const d = this.local;
    const rows = (base: number, n: number) => Array.from({ length: Math.min(n, 15) }, (_, i) => ({ price: d[base + i * 3], qty: d[base + i * 3 + 1], cum: d[base + i * 3 + 2] }));
    return { status: STATUS_NAMES[d[H.status]] ?? '', bids: rows(LAD_BID, d[H.nLadBid]), asks: rows(LAD_ASK, d[H.nLadAsk]), decimals: d[H.priceDecimals], bestBid: d[H.bestBid], bestAsk: d[H.bestAsk] };
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.observer?.disconnect();
    for (const t of this.timers) clearInterval(t);
    for (const w of [...Object.values(this.feeds), this.analytics, this.render]) w.terminate();
  }
}
