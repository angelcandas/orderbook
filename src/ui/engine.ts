import { allocView, sabSupported, H, LAD_ASK, LAD_BID, VIEW_LEN, seqRead, STATUS_NAMES } from '../shared/view';
import { PAIRS, type Endpoints, type Interval, type Venue } from '../shared/config';
import { MarketIndex, liveSymbols, splitLabel, type Catalog, type Market, type Resolved } from '../shared/pairs';
import { Histogram, type HistSummary } from '../shared/hist';
import type { FeedStats, RenderStats } from '../workers/protocol';
import type { SceneSettings } from '../render/scene';
import type { PatternHit } from '../patterns/types';
import type { LayoutPrefs } from '../render/layout';
import type { ZoomPane, ZoomState } from '../workers/protocol';
import type { Outcome } from '../patterns/detect';
import type { LiqStats } from '../workers/liquidation.worker';
import { armed, type Alert, type AlertHit } from '../alerts/alerts';

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  endpoints: Endpoints;
  pairCount: number; // how many pairs each venue keeps live (load)
  depth: { kraken: number; binance: number };
  venue: Venue;
  /** common label, e.g. "ETH/EUR"; each venue resolves it to its own symbol */
  pair: string;
  /** what each venue lists; starts as the cache or the built in pairs, updated as venues answer */
  catalog: Catalog;
  group: number;
  interval: Interval;
  settings: SceneSettings;
  theme: 'dark' | 'light';
  layout?: LayoutPrefs;
  fontPx?: number;
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
  liq: LiqStats | null;
}

export interface LadderRow { price: number; qty: number; cum: number }

export class Engine {
  readonly shared = sabSupported();
  private views = { kraken: allocView(), binance: allocView() };
  private feeds: Record<Venue, Worker>;
  private analytics: Worker;
  private render: Worker;
  private liq: Worker;
  private liqKey = '';
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
  /** symbols with armed alerts, kept live so their alerts can fire */
  private alertSyms: Record<Venue, string[]> = { kraken: [], binance: [] };
  /** a venue sent its full market list */
  onMarkets: (venue: Venue, markets: Market[]) => void = () => {};
  private idx: Record<Venue, MarketIndex>;
  /** bumped on each pair switch; the render worker sees it in the view and redraws */
  private focusId = 0;
  private sent: Record<Venue, string> = { kraken: '', binance: '' };
  onZoom: (z: ZoomState) => void = () => {};

  constructor(private o: EngineOptions) {
    // written out in full so the bundler can find and build each worker
    this.feeds = {
      kraken: new Worker(new URL('../workers/feed.worker.ts', import.meta.url), { type: 'module', name: 'feed-kraken' }),
      binance: new Worker(new URL('../workers/feed.worker.ts', import.meta.url), { type: 'module', name: 'feed-binance' }),
    };
    this.analytics = new Worker(new URL('../workers/analytics.worker.ts', import.meta.url), { type: 'module', name: 'analytics' });
    this.render = new Worker(new URL('../workers/render.worker.ts', import.meta.url), { type: 'module', name: 'render' });
    this.liq = new Worker(new URL('../workers/liquidation.worker.ts', import.meta.url), { type: 'module', name: 'liquidations' });
    this.snap = { t: 0, shared: this.shared, feeds: {}, render: null, main: this.mainStats(), patterns: { list: [], outcomes: [], computeMs: 0, candles: 0, backfill: 0, source: '' }, liq: null };

    const fr = { kraken: new MessageChannel(), binance: new MessageChannel() };
    const fa = { kraken: new MessageChannel(), binance: new MessageChannel() };
    const ar = new MessageChannel();
    const lr = new MessageChannel();
    this.idx = { kraken: new MarketIndex(o.catalog.kraken), binance: new MarketIndex(o.catalog.binance) };

    for (const v of ['kraken', 'binance'] as Venue[]) {
      const w = this.feeds[v];
      w.onmessage = (e) => {
        if (e.data.type === 'stats') this.snap.feeds[v] = e.data;
        else if (e.data.type === 'markets') this.onMarkets(v, e.data.markets);
        else if (e.data.type === 'alert') this.onAlert(e.data);
      };
      const symbols = this.symbolsFor(v);
      this.sent[v] = symbols.join(',');
      w.postMessage({
        type: 'init', venue: v, endpoints: o.endpoints,
        symbols, depth: o.depth[v],
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
      feedPorts: { kraken: fr.kraken.port2, binance: fr.binance.port2 }, analyticsPort: ar.port2, liqPort: lr.port2,
      settings: o.settings, theme: o.theme, layout: o.layout, fontPx: o.fontPx,
    }, [off, fr.kraken.port2, fr.binance.port2, ar.port2, lr.port2]);
    this.liq.onmessage = (e) => { if (e.data.type === 'liqStats') this.snap.liq = e.data; };
    this.liq.postMessage({
      type: 'init', renderPort: lr.port1,
      futuresWs: o.endpoints.futuresWs ?? 'wss://fstream.binance.com',
      futuresRest: o.endpoints.futuresRest ?? 'https://fapi.binance.com',
      spotRest: o.endpoints.binanceRest,
    }, [lr.port1]);
    this.render.onmessage = (e) => {
      if (e.data.type === 'stats') this.snap.render = e.data;
      else if (e.data.type === 'selected') this.onSelected(e.data.id);
      else if (e.data.type === 'zoom') this.onZoom(e.data);
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

  /** the venue's market for the focused pair, or null when it doesn't list it */
  resolved(v: Venue): Resolved | null { return this.idx[v].resolve(this.o.pair); }

  /** the focused pair's book plus built in pairs up to the load setting */
  private symbolsFor(v: Venue): string[] {
    const builtin = PAIRS.map((p) => p[v]).filter((s) => !this.idx[v].size || this.idx[v].markets.some((m) => m.symbol === s));
    const live = liveSymbols(this.resolved(v)?.symbol ?? null, builtin, this.o.pairCount);
    for (const s of this.alertSyms[v]) if (!live.includes(s)) live.push(s);
    return live;
  }

  /** tell each feed which books to keep, only when that changed */
  private syncSymbols(): void {
    for (const v of ['kraken', 'binance'] as Venue[]) {
      const symbols = this.symbolsFor(v);
      const key = symbols.join(',');
      if (key === this.sent[v]) continue;
      this.sent[v] = key;
      this.feeds[v].postMessage({ type: 'symbols', symbols });
    }
  }

  private applyFocus(): void {
    const r = { kraken: this.resolved('kraken'), binance: this.resolved('binance') };
    for (const v of ['kraken', 'binance'] as Venue[]) {
      const sym = r[v]?.symbol ?? '';
      this.feeds[v].postMessage({ type: 'focus', symbol: sym, pair: this.focusId, group: this.o.group });
      this.feeds[v].postMessage({
        type: 'candles', symbol: v === this.o.venue && sym ? sym : null, interval: this.o.interval,
        alt: v === 'kraken' ? r.binance?.symbol ?? null : null,
      });
    }
    const here = r[this.o.venue];
    const label = here ? `${here.base}/${here.quote}` : this.o.pair;
    this.analytics.postMessage({ type: 'venue', venue: this.o.venue });
    this.render.postMessage({ type: 'venue', venue: this.o.venue });
    // liquidation levels follow the pair's base asset on Binance futures, whatever the venue
    const base = r.binance?.base ?? r.kraken?.base ?? splitLabel(this.o.pair)?.base ?? null;
    const key = `${base}:${this.o.interval}`;
    if (key !== this.liqKey) {
      this.liqKey = key;
      this.liq.postMessage({ type: 'focus', base, interval: this.o.interval });
    }
    this.render.postMessage({ type: 'settings', settings: { venueLabel: this.o.venue.toUpperCase(), pairLabel: label } });
  }

  setVenue(v: Venue): void { this.o.venue = v; this.applyFocus(); }
  /** switch pair in place: feeds resubscribe only the books that change, no reconnect */
  setPair(label: string): void {
    this.o.pair = label;
    this.focusId++;
    this.analytics.postMessage({ type: 'reset' });
    this.syncSymbols();
    this.applyFocus();
  }
  /** new market lists: re-resolve the focused pair, which may only now be listed */
  setCatalog(c: Catalog): void {
    const before = [this.resolved('kraken')?.symbol, this.resolved('binance')?.symbol].join();
    this.idx = { kraken: new MarketIndex(c.kraken), binance: new MarketIndex(c.binance) };
    const after = [this.resolved('kraken')?.symbol, this.resolved('binance')?.symbol].join();
    this.syncSymbols();
    if (before !== after) { this.focusId++; this.analytics.postMessage({ type: 'reset' }); this.applyFocus(); }
  }
  setGroup(g: number): void { this.o.group = g; this.applyFocus(); }
  setInterval(m: Interval): void { this.o.interval = m; this.analytics.postMessage({ type: 'reset' }); this.applyFocus(); }
  /** Hand each feed the armed alerts for its venue (replaces the previous set). */
  setAlerts(list: Alert[]): void {
    for (const v of ['kraken', 'binance'] as Venue[]) {
      const a = armed(list, v);
      this.alertSyms[v] = [...new Set(a.map((x) => x.symbol))];
      this.feeds[v].postMessage({ type: 'alerts', list: a });
    }
    // pairs with armed alerts stay subscribed even when they are not on screen
    this.syncSymbols();
  }
  setSettings(s: Partial<SceneSettings>): void { this.render.postMessage({ type: 'settings', settings: s }); }
  setTheme(t: 'dark' | 'light'): void { this.render.postMessage({ type: 'theme', theme: t }); }
  resize(w: number, h: number): void { this.render.postMessage({ type: 'resize', w, h, dpr: devicePixelRatio }); }
  pointer(x: number, y: number, inside: boolean): void { this.render.postMessage({ type: 'pointer', x, y, in: inside }); }
  click(x: number, y: number): void { this.render.postMessage({ type: 'click', x, y }); }
  wheel(x: number, y: number, dy: number, shift = false): void { this.render.postMessage({ type: 'wheel', x, y, dy, shift }); }
  /** Zoom one candle chart axis by `factor` (>1 = in), or reset it with 0. */
  candleScale(axis: 'x' | 'y', factor: number): void { this.render.postMessage({ type: 'candleScale', axis, factor }); }
  zoom(pane: ZoomPane, dir: 1 | -1 | 0): void { this.render.postMessage({ type: 'zoom', pane, dir }); }
  setLayout(layout: LayoutPrefs): void { this.o.layout = layout; this.render.postMessage({ type: 'layout', layout }); }
  setFont(px: number): void { this.o.fontPx = px; this.render.postMessage({ type: 'font', px }); }

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
    for (const w of [...Object.values(this.feeds), this.analytics, this.render, this.liq]) w.terminate();
  }
}
