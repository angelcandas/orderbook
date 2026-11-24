<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Engine, type Snapshot, type LadderRow } from './engine';
  import { INTERVALS, LIVE, intervalLabel, isInterval, localEndpoints, type Interval, type Venue } from '../shared/config';
  import Indicators from './Indicators.svelte';
  import { MAX_SUB_PANES, SPECS, type IndConfig } from '../indicators/spec';
  import {
    allPairs, builtinCatalog, loadCachedCatalog, loadFavourites, MarketIndex, quoteRanking,
    saveCachedCatalog, saveFavourites, splitLabel, toggleFavourite, type Catalog,
  } from '../shared/pairs';
  import PairPicker from './PairPicker.svelte';
  import type { SceneSettings } from '../render/scene';
  import type { PatternHit } from '../patterns/types';
  import type { AnalysisWindow } from '../patterns/window';
  import { explain, explanationText, type Explanation } from '../patterns/explain';
  import Alerts from './Alerts.svelte';
  import { midOf } from '../alerts/alerts';
  import { HEADER_CTRL_W, CANDLE_AXIS_W, CANDLE_TIME_H, CANDLE_TOOLS_W, PANE_HEADER, DEPTH_AXIS_H, candleGeom } from '../render/scene';
  import { computeLayout, dragSplit, DEFAULT_LAYOUT, ZOOM, type LayoutPrefs, type Rect } from '../render/layout';
  import type { ZoomPane } from '../workers/protocol';
  import {
    loadPrefs, savePrefs, defaultPrefs, loadChartPrefs, saveChartPrefs, SIDE_W, type ViewPrefs,
    loadUiPrefs, saveUiPrefs, PINNED_INTERVALS, GROUPS, groupLabel, type ThemeMode, type SideTab,
  } from './prefs';
  import Icon from './Icon.svelte';
  import { toasts, toast, dismissToast } from './toast.svelte';

  const q = new URLSearchParams(location.search);
  let source = $state<'live' | 'local'>(q.get('src') === 'local' ? 'local' : 'live');
  let host = q.get('host') ?? 'localhost:8787';
  let venue = $state<Venue>((q.get('venue') as Venue) ?? 'kraken');
  let pair = $state(splitLabel(q.get('pair') ?? '') ? q.get('pair')!.toUpperCase() : 'BTC/USD');
  let favourites = $state(loadFavourites());
  // what each venue lists: the built in pairs, then the cache, then the venues' own lists as they arrive
  const initialCatalog = (): Catalog => ({ ...builtinCatalog(), ...(source === 'live' ? loadCachedCatalog() : {}) });
  let catalog = $state.raw<Catalog>(initialCatalog());
  let entries = $derived(allPairs(catalog));
  let quotes = $derived(quoteRanking(catalog));
  let index = $derived({ kraken: new MarketIndex(catalog.kraken), binance: new MarketIndex(catalog.binance) });
  let res = $derived(index[venue].resolve(pair));
  let group = $state(Number(q.get('group') ?? 1));
  // candle size, indicators and overlay toggles, remembered in this browser; URL parameters win
  const chartSaved = loadChartPrefs();
  const qInterval = Number(q.get('interval'));
  let interval = $state<Interval>(isInterval(qInterval) ? qInterval : chartSaved.interval);
  let load = $state(Number(q.get('pairs') ?? 1));
  // theme: follows the system unless picked; a ?theme= parameter wins
  const ui = loadUiPrefs();
  const qTheme = q.get('theme');
  let themeMode = $state<ThemeMode>(qTheme === 'light' || qTheme === 'dark' ? qTheme : ui.themeMode);
  const sysDark = matchMedia('(prefers-color-scheme: dark)');
  let sysTheme = $state<'dark' | 'light'>(sysDark.matches ? 'dark' : 'light');
  sysDark.addEventListener?.('change', (e) => (sysTheme = e.matches ? 'dark' : 'light'));
  let theme = $derived<'dark' | 'light'>(themeMode === 'system' ? sysTheme : themeMode);
  let sideOpen = $state(ui.sideOpen);
  let tab = $state<SideTab>(ui.tab);
  let settingsOpen = $state(false);
  let helpOpen = $state(false);
  let picker: ReturnType<typeof PairPicker> | undefined = $state();
  const persistUi = () => saveUiPrefs({ themeMode, sideOpen, tab });
  function cycleTheme() {
    themeMode = themeMode === 'system' ? 'dark' : themeMode === 'dark' ? 'light' : 'system';
    persistUi();
    syncUrl();
    toast(`Theme: ${themeMode === 'system' ? `system (${sysTheme})` : themeMode}`);
  }
  function toggleSide() { sideOpen = !sideOpen; persistUi(); }
  function openTab(t: SideTab) { tab = t; if (!sideOpen) sideOpen = true; persistUi(); }
  let showChart = $state(chartSaved.showChartPatterns);
  let showCandle = $state(chartSaved.showCandlePatterns);
  let indicators = $state.raw<IndConfig[]>(chartSaved.indicators);
  let indMenu = $state(false);
  // lower panes and the volume strip change the candle pane's geometry (the axis handles follow it)
  let indPanes = $derived({
    sub: Math.min(MAX_SUB_PANES, indicators.filter((c) => c.on && SPECS[c.kind].pane === 'sub').length),
    vol: indicators.some((c) => c.on && c.kind === 'volume'),
  });
  const geom = (c: Rect) => candleGeom(c, indPanes.sub, indPanes.vol);
  let reducedMotion = $state(matchMedia('(prefers-reduced-motion: reduce)').matches);
  let showTable = $state(false);
  let showLiq = $state(q.has('liq') ? q.get('liq') !== '0' : chartSaved.showLiquidations);
  let selected = $state<string | null>(null);
  // analysis window: a box dragged on the candle chart; patterns are searched inside it only
  let win = $state.raw<AnalysisWindow | null>(null);
  let drawMode = $state(false);
  let explanation = $state.raw<Explanation | null>(null);
  let copied = $state(false);

  // layout + zoom, remembered in this browser ($state.raw: plain objects, so they can be posted to the worker)
  const saved = loadPrefs();
  let layoutPrefs = $state.raw<LayoutPrefs>(saved.layout);
  let sideW = $state(saved.sideW);
  let fontPx = $state(saved.fontPx);
  let zoomState = $state.raw({ candlesVisible: saved.candlesVisible, depthRangePct: saved.depthRangePct, ladderRowPad: saved.ladderRowPad, candlesPriceScale: saved.candlesPriceScale });
  let stageW = $state(0), stageH = $state(0);
  let panes = $derived(stageW ? computeLayout(stageW, stageH, layoutPrefs) : null);
  const persistChart = () => saveChartPrefs({ interval, indicators, showChartPatterns: showChart, showCandlePatterns: showCandle, showLiquidations: showLiq });
  function setIndicators(list: IndConfig[]) {
    indicators = list;
    engine?.setIndicators(list);
    persistChart();
  }
  const persist = () => savePrefs({ layout: layoutPrefs, sideW, fontPx, ...zoomState } satisfies ViewPrefs);

  let stats = $state<Snapshot | null>(null);
  let table = $state<ReturnType<Engine['ladder']>>(null);
  let alertsPanel: ReturnType<typeof Alerts> | undefined = $state();
  let engine: Engine | null = null;
  let canvasHost: HTMLDivElement;
  let generation = $state(0); // remounts the canvas: a canvas can only be transferred once
  let ro: ResizeObserver | null = null;
  let tableTimer: any;

  const settings = (): SceneSettings => ({
    depthRangePct: zoomState.depthRangePct, candlesVisible: zoomState.candlesVisible, ladderRowPad: zoomState.ladderRowPad, candlesPriceScale: zoomState.candlesPriceScale, reducedMotion,
    showChartPatterns: showChart, showCandlePatterns: showCandle, selectedPattern: selected, showLiquidations: showLiq,
    venueLabel: venue.toUpperCase(), pairLabel: res ? `${res.base}/${res.quote}` : pair, intervalLabel: intervalLabel(interval), intervalMin: interval,
  });

  function start() {
    engine?.destroy();
    const canvas = canvasHost.querySelector('canvas')!;
    engine = new Engine({
      canvas,
      endpoints: source === 'local' ? localEndpoints(host) : LIVE,
      pairCount: load,
      depth: { kraken: source === 'local' ? 1000 : 500, binance: 1000 },
      venue, pair, catalog, group, interval, settings: settings(), theme, layout: layoutPrefs, fontPx, indicators,
    });
    engine.onZoom = (z) => {
      zoomState = { candlesVisible: z.candlesVisible, depthRangePct: z.depthRangePct, ladderRowPad: z.ladderRowPad, candlesPriceScale: z.candlesPriceScale };
      persist();
    };
    engine.onStats = (s) => (stats = s);
    const src = source;
    engine.onMarkets = (v, markets) => {
      if (!markets.length) return;
      catalog = { ...catalog, [v]: markets };
      if (src === 'live') saveCachedCatalog(v, markets);
      engine?.setCatalog(catalog);
    };
    engine.onSelected = (id) => (selected = id);
    win = null; drawMode = false;
    engine.onWindow = (w) => {
      if (!w) return; // too small: keep the previous window
      win = w; drawMode = false; selected = null;
      engine?.setSettings({ selectedPattern: null });
    };
    alertsPanel?.attach(engine);
    (window as any).__depthline = engine;
  }

  function restart() {
    generation++;
    // wait for the keyed canvas to remount
    queueMicrotask(() => requestAnimationFrame(start));
  }

  function syncUrl() {
    const p = new URLSearchParams({ src: source, venue, pair, group: String(group), interval: String(interval), pairs: String(load) });
    if (themeMode !== 'system') p.set('theme', themeMode);
    if (source === 'local') p.set('host', host);
    if (!showLiq) p.set('liq', '0');
    history.replaceState(null, '', `?${p}`);
  }

  // theme reaches the page (CSS tokens) and the canvas together
  $effect(() => {
    document.documentElement.dataset.theme = theme;
    engine?.setTheme(theme);
  });
  // the tab title carries the live price, like an exchange's
  let lastTitle = '';
  $effect(() => {
    const m = tickerPrice;
    const label = res ? `${res.base}/${res.quote}` : pair;
    const tt = Number.isFinite(m) ? `${fmt(m, priceDec)} ${label} · Depthline` : `${label} · Depthline`;
    if (tt !== lastTitle) { document.title = tt; lastTitle = tt; }
  });

  onMount(() => {
    start();
    ro = new ResizeObserver(() => {
      const r = canvasHost.getBoundingClientRect();
      stageW = r.width; stageH = r.height;
      engine?.resize(r.width, r.height);
    });
    ro.observe(canvasHost);
    tableTimer = setInterval(() => { if (engine) table = engine.ladder(); }, 250);
  });
  onDestroy(() => { engine?.destroy(); ro?.disconnect(); clearInterval(tableTimer); });

  const ptr = (e: PointerEvent, inside = true) => {
    const r = canvasHost.getBoundingClientRect();
    engine?.pointer(e.clientX - r.left, e.clientY - r.top, inside);
  };
  // ---- drawing the analysis window: drag on the candle chart in draw mode, or shift+drag any time ----
  let brushFrom: { x: number; y: number } | null = null;
  let swallowClick = false;
  const local = (e: PointerEvent) => { const r = canvasHost.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function brushStart(e: PointerEvent) {
    if (!panes || e.button !== 0 || !(drawMode || e.shiftKey)) return;
    const p = local(e), c = panes.candles;
    // the plot only: not the header buttons or the price / time axis zoom handles
    if (p.x < c.x || p.x > c.x + c.w - CANDLE_AXIS_W || p.y < c.y + PANE_HEADER || p.y > geom(c).timeY) return;
    e.preventDefault();
    brushFrom = p;
    canvasHost.setPointerCapture(e.pointerId);
  }
  function brushMove(e: PointerEvent) {
    if (!brushFrom) return;
    const p = local(e);
    engine?.brush(brushFrom.x, brushFrom.y, p.x, p.y, 'move');
  }
  function brushEnd(e: PointerEvent, cancel = false) {
    if (!brushFrom) return;
    const p = local(e);
    engine?.brush(brushFrom.x, brushFrom.y, p.x, p.y, cancel ? 'cancel' : 'end');
    swallowClick = Math.abs(p.x - brushFrom.x) + Math.abs(p.y - brushFrom.y) > 4;
    brushFrom = null;
  }
  function clearWindow() {
    win = null;
    engine?.setWindow(null);
  }
  function openExplanation() {
    const pt = stats?.patterns ?? engine?.snapshot().patterns;
    if (!pt) return;
    // without a window: every chart pattern and the latest candle signals, as listed in the side panel
    const list = pt.window ? pt.list : [...pt.list.filter((p) => p.family === 'chart'), ...pt.list.filter((p) => p.family !== 'chart' && p.bias !== 0).slice(-12)];
    explanation = explain(list, {
      t: pt.t, last: pt.last, decimals: table?.decimals ?? 2, window: pt.window,
      symbol: res ? `${venueName(venue)} ${res.base}/${res.quote}` : pair, interval,
    });
    copied = false;
  }
  async function copyExplanation() {
    if (!explanation) return;
    try { await navigator.clipboard.writeText(explanationText(explanation)); copied = true; toast('Explanation copied', 'ok'); } catch { copied = false; toast('Could not copy: clipboard blocked', 'warn'); }
  }
  /** Keyboard shortcuts (listed in the ? dialog). Ignored while typing in a field. */
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (helpOpen) helpOpen = false;
      else if (settingsOpen) settingsOpen = false;
      else if (explanation) explanation = null;
      else if (indMenu) indMenu = false;
      else if (drawMode) drawMode = false;
      return;
    }
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName))) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); picker?.show(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    const act: Record<string, () => void> = {
      '/': () => picker?.show(),
      '?': () => (helpOpen = !helpOpen),
      t: cycleTheme,
      ']': toggleSide,
      b: toggleSide,
      v: () => switchVenue(venue === 'kraken' ? 'binance' : 'kraken'),
      w: () => (drawMode = !drawMode),
      e: openExplanation,
      i: () => (indMenu = !indMenu),
      f: () => { for (const p of ['ladder', 'depth', 'candles'] as ZoomPane[]) engine?.zoom(p, 0); },
      l: () => { showLiq = !showLiq; engine?.setSettings({ showLiquidations: showLiq }); syncUrl(); persistChart(); toast(`Liquidation levels ${showLiq ? 'on' : 'off'}`); },
      p: () => { showChart = !showChart; engine?.setSettings({ showChartPatterns: showChart }); persistChart(); toast(`Chart patterns ${showChart ? 'on' : 'off'}`); },
      ',': () => stepInterval(-1),
      '.': () => stepInterval(1),
    };
    const n = Number(k);
    if (n >= 1 && n <= PINNED_INTERVALS.length && Number.isInteger(n)) { e.preventDefault(); setInterval_(PINNED_INTERVALS[n - 1]); return; }
    const f = act[k] ?? act[k.toLowerCase()];
    if (f) { e.preventDefault(); f(); }
  };
  function setInterval_(m: Interval) {
    if (m === interval) return;
    interval = m;
    engine?.setInterval(interval);
    selected = null;
    syncUrl();
    persistChart();
  }
  function stepInterval(d: 1 | -1) {
    const i = INTERVALS.indexOf(interval);
    const j = Math.max(0, Math.min(INTERVALS.length - 1, i + d));
    setInterval_(INTERVALS[j]);
  }
  function switchVenue(v: Venue) {
    if (v === venue) return;
    venue = v;
    engine?.setVenue(venue);
    selected = null;
    win = null;
    syncUrl();
  }

  const click = (e: MouseEvent) => {
    if (swallowClick) { swallowClick = false; return; }
    const r = canvasHost.getBoundingClientRect();
    engine?.click(e.clientX - r.left, e.clientY - r.top);
  };
  // scrolling pans (two-finger trackpad scroll moves both ways); a pinch, which arrives with ctrl held, zooms
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = canvasHost.getBoundingClientRect();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1; // lines / pages to px
    let dx = e.deltaX * k, dy = e.deltaY * k;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; } // shift + mouse wheel scrolls sideways
    engine?.wheel(e.clientX - r.left, e.clientY - r.top, dx, dy, e.ctrlKey);
  };

  const fmt = (x: number | undefined, d = 1) => (x === undefined || !isFinite(x) ? '–' : x.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
  const usd = (v: number) => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : `$${v.toFixed(0)}`);
  const px = (p: number) => p.toLocaleString(undefined, { maximumSignificantDigits: 6 });
  const int = (x: number | undefined) => (x === undefined ? '–' : Math.round(x).toLocaleString());

  let totals = $derived.by(() => {
    if (!stats) return null;
    const fs = Object.values(stats.feeds);
    const sum = (f: (s: any) => number) => fs.reduce((a, s) => a + f(s), 0);
    return {
      msgs: sum((s) => s.msgsPerSec), levels: sum((s) => s.levelsPerSec),
      checksum: sum((s) => s.counters.checksumFails), gaps: sum((s) => s.counters.gaps),
      resyncs: sum((s) => s.counters.resyncs), reconnects: sum((s) => s.counters.reconnects), crossed: sum((s) => s.counters.crossed),
      books: sum((s) => s.books),
    };
  });
  let focusStatus = $derived(res ? stats?.feeds[venue]?.status[res.symbol] ?? 'connecting' : 'not listed');
  const venueName = (v: Venue) => (v === 'kraken' ? 'Kraken' : 'Binance');

  function pickPair(label: string) {
    pair = label;
    selected = null;
    win = null;
    engine?.setPair(pair);
    syncUrl();
  }
  function favourite(label: string) {
    favourites = toggleFavourite(favourites, label);
    saveFavourites(favourites);
  }
  const order = { forming: 0, confirmed: 1, failed: 2 } as const;
  let chartPatterns = $derived((stats?.patterns.list ?? []).filter((p: PatternHit) => p.family === 'chart').slice().sort((a, b) => order[a.status] - order[b.status] || b.end - a.end));
  let candlePats = $derived((stats?.patterns.list ?? []).filter((p: PatternHit) => p.family !== 'chart').slice(-12).reverse());

  function selectPattern(id: string) {
    selected = selected === id ? null : id;
    engine?.setSettings({ selectedPattern: selected });
  }
  // ---- ticker: live mid, its last move, and 24 h figures from the candles ----
  let tickerPrice = $derived(table && Number.isFinite(table.bestBid) && Number.isFinite(table.bestAsk) ? midOf(table.bestBid, table.bestAsk) : stats?.patterns.last ?? NaN);
  let priceDec = $derived(Math.max(0, Math.min(8, (table?.decimals ?? 2) + 1)));
  let prevTick = NaN;
  let tickDir = $state(0);
  $effect(() => {
    const m = tickerPrice;
    if (Number.isFinite(m) && Number.isFinite(prevTick) && m !== prevTick) tickDir = m > prevTick ? 1 : -1;
    prevTick = m;
  });
  let day = $derived(stats?.patterns.day ?? null);
  let dayChg = $derived(day && Number.isFinite(tickerPrice) ? tickerPrice - day.ref : NaN);
  let dayPct = $derived(day && day.ref ? (dayChg / day.ref) * 100 : NaN);
  let spreadBps = $derived(table && tickerPrice ? ((table.bestAsk - table.bestBid) / tickerPrice) * 1e4 : NaN);
  let fps = $derived(stats?.render?.frameInterval.p50 ? 1000 / stats.render.frameInterval.p50 : NaN);
  let live = $derived(focusStatus.startsWith('live'));
  const compact = (v: number) => (!Number.isFinite(v) ? '–' : v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(2));
  const signed = (v: number, d: number) => (!Number.isFinite(v) ? '–' : `${v >= 0 ? '+' : ''}${fmt(v, d)}`);
  let otherVenue = $derived<Venue>(venue === 'kraken' ? 'binance' : 'kraken');
  let patternCount = $derived(chartPatterns.filter((p) => p.status !== 'failed').length);

  // ---- zoom buttons and resize handles over the canvas ----
  const paneNames: Record<ZoomPane, string> = { ladder: 'order book', depth: 'depth chart', candles: 'candle chart' };
  const zoomTips: Record<ZoomPane, [string, string]> = {
    ladder: ['Shorter rows, more price levels', 'Taller rows, fewer price levels'],
    depth: ['Wider price range', 'Narrower price range'],
    candles: ['More candles', 'Fewer candles'],
  };
  const zoom = (e: Event, pane: ZoomPane, dir: 1 | -1 | 0) => { e.stopPropagation(); engine?.zoom(pane, dir); };

  function setLayout(next: LayoutPrefs) {
    layoutPrefs = next;
    engine?.setLayout(next);
  }
  /** Drag a split. `which`: the ladder edge or the depth / candles edge. */
  function dragStart(e: PointerEvent, which: 'ladder' | 'depth') {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let raf = 0, lx = 0, ly = 0;
    const apply = () => {
      raf = 0;
      const r = canvasHost.getBoundingClientRect();
      setLayout(dragSplit(layoutPrefs, which, lx - r.left, ly - r.top, r.width, r.height));
    };
    // at most one relayout per frame, however fast the pointer reports
    const move = (ev: PointerEvent) => { lx = ev.clientX; ly = ev.clientY; if (!raf) raf = requestAnimationFrame(apply); };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (raf) { cancelAnimationFrame(raf); apply(); }
      persist();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
  function splitKey(e: KeyboardEvent, which: 'ladder' | 'depth') {
    const vertical = panes && !panes.narrow && which === 'ladder';
    const d = (vertical ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 } as Record<string, number>)[e.key as 'ArrowLeft'];
    if (!d) return;
    e.preventDefault();
    const mode = panes?.narrow ? 'narrow' : 'wide';
    const cur = layoutPrefs[mode][which];
    setLayout({ ...layoutPrefs, [mode]: { ...layoutPrefs[mode], [which]: Math.max(0.05, Math.min(0.95, cur + d * 0.02)) } });
    persist();
  }
  function resetSplit(which: 'ladder' | 'depth') {
    const mode = panes?.narrow ? 'narrow' : 'wide';
    setLayout({ ...layoutPrefs, [mode]: { ...layoutPrefs[mode], [which]: DEFAULT_LAYOUT[mode][which] } });
    persist();
  }
  function dragSide(e: PointerEvent) {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => { sideW = Math.round(Math.max(SIDE_W.min, Math.min(SIDE_W.max, innerWidth - ev.clientX))); };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); persist(); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
  function sideKey(e: KeyboardEvent) {
    const d = e.key === 'ArrowLeft' ? 20 : e.key === 'ArrowRight' ? -20 : 0;
    if (!d) return;
    e.preventDefault();
    sideW = Math.max(SIDE_W.min, Math.min(SIDE_W.max, sideW + d));
    persist();
  }
  function setFont() { engine?.setFont(fontPx); persist(); }
  /**
   * Drag the candle chart's price axis (vertical zoom: up = in) or its time
   * strip (horizontal zoom: right = in). Double-click resets that axis.
   */
  function axisDrag(e: PointerEvent, axis: 'x' | 'y' | 'depth') {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let last = axis === 'y' ? e.clientY : e.clientX, pend = 0, raf = 0;
    const flush = () => { raf = 0; if (pend) engine?.axisScale(axis, Math.exp(pend / 120)); pend = 0; };
    const move = (ev: PointerEvent) => {
      const cur = axis === 'y' ? ev.clientY : ev.clientX;
      pend += axis === 'y' ? last - cur : cur - last;
      last = cur;
      if (!raf) raf = requestAnimationFrame(flush); // one zoom message per frame
    };
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      if (raf) { cancelAnimationFrame(raf); flush(); }
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  }
  function axisWheel(e: WheelEvent, axis: 'x' | 'y' | 'depth') {
    e.preventDefault();
    e.stopPropagation();
    engine?.axisScale(axis, e.deltaY > 0 ? 1 / 1.15 : 1.15);
  }
  function axisKey(e: KeyboardEvent, axis: 'x' | 'y' | 'depth') {
    const f = { ArrowUp: 1.15, ArrowRight: 1.15, ArrowDown: 1 / 1.15, ArrowLeft: 1 / 1.15, Home: 0 }[e.key];
    if (f === undefined) return;
    e.preventDefault();
    engine?.axisScale(axis, f);
  }

  function resetView() {
    const d = defaultPrefs();
    setLayout(d.layout);
    sideW = d.sideW;
    fontPx = d.fontPx;
    engine?.setFont(fontPx);
    for (const p of ['ladder', 'depth', 'candles'] as ZoomPane[]) engine?.zoom(p, 0);
    zoomState = { candlesVisible: d.candlesVisible, depthRangePct: d.depthRangePct, ladderRowPad: d.ladderRowPad, candlesPriceScale: d.candlesPriceScale };
    persist();
    toast('Layout and zoom reset', 'ok');
  }
</script>

<svelte:window onkeydown={onKey} />

<a class="skip" href="#book-table" onclick={() => (showTable = true)}>Skip to the order book table</a>

<div class="shell">
  <header class="topbar">
    <div class="brand" aria-label="Depthline">
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 20h4V12H2zM8 20h4V4H8zM14 20h4V9h-4zM20 20h2v-5h-2z" fill="var(--accent)" /></svg>
      <strong>Depthline</strong>
    </div>
    <div class="pairbox">
      <PairPicker bind:this={picker} {pair} {entries} {quotes} {favourites} {venue} showFavs={false} resolve={(v, l) => index[v].resolve(l)} onpick={pickPair} onfavourite={favourite} />
    </div>
    <div class="seg venue" role="group" aria-label="Venue (V)">
        {#each ['kraken', 'binance'] as v}
          <button class:on={venue === v} class:unlisted={!index[v as Venue].resolve(pair)} aria-pressed={venue === v}
            title={index[v as Venue].resolve(pair) ? `Show ${venueName(v as Venue)} (V)` : `${venueName(v as Venue)} doesn't list ${pair}`}
            onclick={() => switchVenue(v as Venue)}>{venueName(v as Venue)}</button>
        {/each}
    </div>

    <dl class="ticker mono" aria-label="Market summary">
      <div class="last">
        <dt class="sr-only">Mid price</dt>
        <dd class="price" class:up={tickDir > 0} class:down={tickDir < 0}>{Number.isFinite(tickerPrice) ? fmt(tickerPrice, priceDec) : '–'}</dd>
      </div>
      <div><dt>{day && day.hours < 23.5 ? `${Math.round(day.hours)}h` : '24h'} change</dt>
        <dd class:up={dayChg > 0} class:down={dayChg < 0}>{signed(dayChg, priceDec - 1)} <span>{signed(dayPct, 2)}%</span></dd></div>
      <div class="opt"><dt>24h high</dt><dd>{day ? fmt(Math.max(day.hi, tickerPrice || -Infinity), priceDec - 1) : '–'}</dd></div>
      <div class="opt"><dt>24h low</dt><dd>{day ? fmt(Math.min(day.lo, tickerPrice || Infinity), priceDec - 1) : '–'}</dd></div>
      <div class="opt"><dt>24h vol ({res?.base ?? ''})</dt><dd>{day ? compact(day.vol) : '–'}</dd></div>
      <div class="opt2"><dt>Spread</dt><dd>{Number.isFinite(spreadBps) ? `${fmt(spreadBps, 2)} bp` : '–'}</dd></div>
    </dl>

    <span class="spacer"></span>

    <button class="chip status" class:ok={live} class:bad={focusStatus.startsWith('error') || focusStatus === 'not listed'}
      title="Feed health: checksums, gaps and resyncs" onclick={() => openTab('health')}>
      <span class="dot" aria-hidden="true"></span><span class="stxt">{venueName(venue)} · {focusStatus}</span>
    </button>
    <button class="chip perf mono" class:warnc={fps < 50} title="Frame rate and receive-to-draw latency (p50). Click for the full numbers." onclick={() => openTab('health')}>
      {Number.isFinite(fps) ? Math.round(fps) : '–'} fps · {fmt(stats?.render?.latency.p50)} ms
    </button>
    <div class="icons">
      <button class="icon kbd" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onclick={() => (helpOpen = true)}><Icon name="keyboard" /></button>
      <button class="icon themeb" title="Theme: {themeMode} (T)" aria-label="Theme: {themeMode}. Change theme" onclick={cycleTheme}><Icon name={themeMode === 'system' ? 'monitor' : themeMode === 'dark' ? 'moon' : 'sun'} /></button>
      <div class="pop-anchor">
        <button class="icon" class:on={settingsOpen} title="Settings" aria-label="Settings" aria-expanded={settingsOpen} onclick={() => (settingsOpen = !settingsOpen)}><Icon name="gear" /></button>
        {#if settingsOpen}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="scrim" onclick={() => (settingsOpen = false)}></div>
          <div class="popover settings" role="dialog" aria-label="Settings">
            <h3>Data</h3>
            <label class="row">Source
              <select bind:value={source} onchange={() => { catalog = initialCatalog(); syncUrl(); restart(); }}>
                <option value="live">Live exchanges</option>
                <option value="local">Local emulator</option>
              </select>
            </label>
            <label class="row" title="Pairs kept live per venue. More pairs = more updates per second.">Load
              <select bind:value={load} onchange={() => { syncUrl(); restart(); }}>
                {#each [1, 5, 10, 25] as n}<option value={n}>{n} pair{n > 1 ? 's' : ''} / venue</option>{/each}
              </select>
            </label>
            <h3>Display</h3>
            <label class="row">Text size
              <select bind:value={fontPx} onchange={setFont}>
                {#each Array.from({ length: ZOOM.font.max - ZOOM.font.min + 1 }, (_, i) => ZOOM.font.min + i) as px}<option value={px}>{px}px</option>{/each}
              </select>
            </label>
            <label class="row">Theme
              <select bind:value={themeMode} onchange={() => { persistUi(); syncUrl(); }}>
                <option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option>
              </select>
            </label>
            <label class="check"><input type="checkbox" bind:checked={reducedMotion} onchange={() => engine?.setSettings({ reducedMotion })} /> Reduce motion (no flashes)</label>
            <label class="check"><input type="checkbox" bind:checked={showTable} /> Show the text table of the book</label>
            <div class="foot"><button class="ghost" onclick={resetView}>Reset layout and zoom</button></div>
          </div>
        {/if}
      </div>
      <button class="icon" class:on={sideOpen} title="{sideOpen ? 'Hide' : 'Show'} the side panel (B)" aria-label="{sideOpen ? 'Hide' : 'Show'} the side panel" aria-pressed={sideOpen} onclick={toggleSide}><Icon name="sidebar" /></button>
    </div>
  </header>

  <div class="toolbar" role="toolbar" aria-label="Chart controls">
    <div class="seg tf" role="group" aria-label="Candle size">
      {#each PINNED_INTERVALS as m, i}
        <button class:on={interval === m} aria-pressed={interval === m} title="{intervalLabel(m)} candles ({i + 1})" onclick={() => setInterval_(m)}>{intervalLabel(m)}</button>
      {/each}
      <select class:on={!PINNED_INTERVALS.includes(interval)} aria-label="More candle sizes" value={PINNED_INTERVALS.includes(interval) ? '' : String(interval)}
        onchange={(e) => { const v = Number((e.currentTarget as HTMLSelectElement).value); if (v) setInterval_(v); }}>
        <option value="" disabled>More</option>
        {#each INTERVALS.filter((m) => !PINNED_INTERVALS.includes(m)) as m}<option value={String(m)}>{intervalLabel(m)}</option>{/each}
      </select>
    </div>
    <span class="sep" aria-hidden="true"></span>
    <label class="inline" title="Price step the book is grouped by">Group
      <select bind:value={group} onchange={() => { engine?.setGroup(group); syncUrl(); }}>
        {#each GROUPS as g}<option value={g}>{groupLabel(g, table?.tick)}</option>{/each}
      </select>
    </label>
    <span class="sep" aria-hidden="true"></span>
    <div class="toggles" role="group" aria-label="Chart overlays">
      <button class="tg" class:on={showChart} aria-pressed={showChart} title="Chart patterns (P)" onclick={() => { showChart = !showChart; engine?.setSettings({ showChartPatterns: showChart }); persistChart(); }}>Patterns</button>
      <button class="tg" class:on={showCandle} aria-pressed={showCandle} title="Candle signals" onclick={() => { showCandle = !showCandle; engine?.setSettings({ showCandlePatterns: showCandle }); persistChart(); }}>Signals</button>
      <button class="tg" class:on={showLiq} aria-pressed={showLiq} title="Liquidation levels (L)" onclick={() => { showLiq = !showLiq; engine?.setSettings({ showLiquidations: showLiq }); syncUrl(); persistChart(); }}>Liquidations</button>
    </div>
    {#if favourites.length}
      <span class="sep" aria-hidden="true"></span>
      <div class="favs" role="group" aria-label="Favourite pairs">
        <span class="star" aria-hidden="true">★</span>
        {#each favourites as f (f)}
          <button class="fav mono" class:on={f === pair} aria-pressed={f === pair} onclick={() => pickPair(f)}>{f}</button>
        {/each}
      </div>
    {/if}
  </div>

  <main>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="stage" class:drawing={drawMode} bind:this={canvasHost}
      onpointerdown={brushStart} onpointerup={(e) => brushEnd(e)} onpointercancel={(e) => brushEnd(e, true)}
      onpointermove={(e) => { ptr(e); brushMove(e); }} onpointerleave={(e) => ptr(e, false)} onclick={click} onwheel={wheel}
      role="application" aria-label="Order book, depth chart and candle chart. A text table of the book follows the chart.">
      {#key generation}<canvas></canvas>{/key}
      {#if panes}
        {#each (['ladder', 'depth', 'candles'] as ZoomPane[]) as p}
          {@const r = panes[p]}
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="zoom" role="group" aria-label="Zoom {paneNames[p]}" style="left:{r.x + r.w - HEADER_CTRL_W}px; top:{r.y + 2}px; width:{HEADER_CTRL_W - 4}px" onclick={(e) => e.stopPropagation()}>
            <button title={zoomTips[p][0]} aria-label="Zoom out {paneNames[p]}" onclick={(e) => zoom(e, p, -1)}>−</button>
            <button title={zoomTips[p][1]} aria-label="Zoom in {paneNames[p]}" onclick={(e) => zoom(e, p, 1)}>+</button>
            <button title={p === 'depth' ? 'Auto-fit the price range' : 'Default zoom'} aria-label="Reset zoom {paneNames[p]}" onclick={(e) => zoom(e, p, 0)}>fit</button>
          </div>
        {/each}
        {@const c = panes.candles}
        {@const cg = geom(c)}
        {@const d = panes.depth}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
        <div class="axis x" role="slider" tabindex="0" aria-label="Depth chart price range zoom" aria-valuemin={ZOOM.depthPct.min} aria-valuemax={ZOOM.depthPct.max} aria-valuenow={zoomState.depthRangePct}
          title="Drag left or right to zoom the price range. Double-click to auto-fit."
          style="left:{d.x}px; top:{d.y + d.h - DEPTH_AXIS_H}px; width:{d.w - 60}px; height:{DEPTH_AXIS_H}px"
          onpointerdown={(e) => axisDrag(e, 'depth')} onwheel={(e) => axisWheel(e, 'depth')} onkeydown={(e) => axisKey(e, 'depth')}
          ondblclick={() => engine?.axisScale('depth', 0)} onclick={(e) => e.stopPropagation()}></div>
        <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
        <div class="zoom wintools" role="group" aria-label="Pattern analysis window and indicators" style="left:{c.x + c.w - HEADER_CTRL_W - CANDLE_TOOLS_W}px; top:{c.y + 2}px; width:{CANDLE_TOOLS_W - 4}px" onclick={(e) => e.stopPropagation()}>
          <button class:on={indMenu} aria-expanded={indMenu} title="Add, remove and configure indicators" onclick={() => (indMenu = !indMenu)}>indicators</button>
          <button class:on={drawMode} aria-pressed={drawMode} title="Drag a box over the candles to search for patterns only inside it (or shift+drag any time)" onclick={() => (drawMode = !drawMode)}>{drawMode ? 'drag a box…' : 'window'}</button>
          {#if win}<button title="Search the whole history again" onclick={clearWindow}>clear</button>{/if}
          <button title="Explain the detected patterns in plain words" onclick={openExplanation}>explain</button>
        </div>
        {#if indMenu}
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="indmenu" role="dialog" tabindex="-1" aria-label="Indicators" style="right:{stageW - (c.x + c.w - HEADER_CTRL_W)}px; top:{c.y + PANE_HEADER + 2}px"
            onclick={(e) => e.stopPropagation()} onpointerdown={(e) => e.stopPropagation()} onwheel={(e) => e.stopPropagation()}>
            <div class="ehead"><h2>Indicators</h2><button class="link" onclick={() => (indMenu = false)}>close</button></div>
            <Indicators list={indicators} {theme} onchange={setIndicators} />
          </div>
        {/if}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
        <div class="axis y" role="slider" tabindex="0" aria-label="Candle chart vertical zoom" aria-valuemin={ZOOM.priceScale.min} aria-valuemax={ZOOM.priceScale.max} aria-valuenow={zoomState.candlesPriceScale}
          title="Drag up or down to zoom prices. Double-click to fit."
          style="left:{c.x + c.w - CANDLE_AXIS_W}px; top:{c.y + PANE_HEADER}px; width:{CANDLE_AXIS_W}px; height:{cg.timeY - c.y - PANE_HEADER}px"
          onpointerdown={(e) => axisDrag(e, 'y')} onwheel={(e) => axisWheel(e, 'y')} onkeydown={(e) => axisKey(e, 'y')}
          ondblclick={() => engine?.axisScale('y', 0)} onclick={(e) => e.stopPropagation()}></div>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
        <div class="axis x" role="slider" tabindex="0" aria-label="Candle chart horizontal zoom" aria-valuemin={ZOOM.candles.min} aria-valuemax={ZOOM.candles.max} aria-valuenow={zoomState.candlesVisible}
          title="Drag left or right to zoom time. Double-click to reset."
          style="left:{c.x}px; top:{cg.timeY}px; width:{c.w - CANDLE_AXIS_W}px; height:{CANDLE_TIME_H}px"
          onpointerdown={(e) => axisDrag(e, 'x')} onwheel={(e) => axisWheel(e, 'x')} onkeydown={(e) => axisKey(e, 'x')}
          ondblclick={() => engine?.axisScale('x', 0)} onclick={(e) => e.stopPropagation()}></div>
        {#if panes.narrow}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
          <div class="split h" role="separator" aria-orientation="horizontal" aria-label="Resize order book" tabindex="0" aria-valuemin={5} aria-valuemax={95} aria-valuenow={Math.round(layoutPrefs[panes.narrow ? 'narrow' : 'wide']['ladder'] * 100)}
            style="top:{panes.ladder.h - 4}px; left:0; width:{stageW}px"
            onpointerdown={(e) => dragStart(e, 'ladder')} onkeydown={(e) => splitKey(e, 'ladder')} ondblclick={() => resetSplit('ladder')}></div>
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
          <div class="split h" role="separator" aria-orientation="horizontal" aria-label="Resize depth chart" tabindex="0" aria-valuemin={5} aria-valuemax={95} aria-valuenow={Math.round(layoutPrefs[panes.narrow ? 'narrow' : 'wide']['depth'] * 100)}
            style="top:{panes.candles.y - 4}px; left:0; width:{stageW}px"
            onpointerdown={(e) => dragStart(e, 'depth')} onkeydown={(e) => splitKey(e, 'depth')} ondblclick={() => resetSplit('depth')}></div>
        {:else}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
          <div class="split v" role="separator" aria-orientation="vertical" aria-label="Resize order book" tabindex="0" aria-valuemin={5} aria-valuemax={95} aria-valuenow={Math.round(layoutPrefs[panes.narrow ? 'narrow' : 'wide']['ladder'] * 100)}
            style="left:{panes.ladder.w - 4}px; top:0; height:{stageH}px"
            onpointerdown={(e) => dragStart(e, 'ladder')} onkeydown={(e) => splitKey(e, 'ladder')} ondblclick={() => resetSplit('ladder')}></div>
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
          <div class="split h" role="separator" aria-orientation="horizontal" aria-label="Resize depth chart" tabindex="0" aria-valuemin={5} aria-valuemax={95} aria-valuenow={Math.round(layoutPrefs[panes.narrow ? 'narrow' : 'wide']['depth'] * 100)}
            style="top:{panes.depth.h - 4}px; left:{panes.depth.x}px; width:{panes.depth.w}px"
            onpointerdown={(e) => dragStart(e, 'depth')} onkeydown={(e) => splitKey(e, 'depth')} ondblclick={() => resetSplit('depth')}></div>
        {/if}
      {/if}
      {#if !live}
        <div class="overlay" role="status" aria-live="polite">
          {#if focusStatus === 'not listed'}
            <span>{venueName(venue)} doesn't list {pair}.</span>
            {#if index[otherVenue].resolve(pair)}<button class="primary" onclick={() => switchVenue(otherVenue)}>Show {venueName(otherVenue)}</button>{/if}
          {:else if focusStatus.startsWith('error')}
            <span class="dotc bad" aria-hidden="true"></span><span>{venueName(venue)} feed error, retrying…</span>
          {:else}
            <span class="spin" aria-hidden="true"></span><span>{focusStatus === 'syncing' ? 'Syncing' : focusStatus === 'resyncing' ? 'Resyncing' : 'Connecting to'} {venueName(venue)} {res ? `${res.base}/${res.quote}` : pair}…</span>
          {/if}
        </div>
      {/if}
    </div>

    {#if sideOpen}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div class="split v side" role="separator" aria-orientation="vertical" aria-label="Resize side panel" tabindex="0" aria-valuemin={SIDE_W.min} aria-valuemax={SIDE_W.max} aria-valuenow={sideW}
        onpointerdown={dragSide} onkeydown={sideKey} ondblclick={() => { sideW = SIDE_W.def; persist(); }}></div>
    {/if}
    <!-- the panels stay mounted when hidden: price alerts keep checking while another tab is open -->
    <aside style="--side-w:{sideW}px" class:closed={!sideOpen} class:narrowside={sideW < 420} aria-label="Side panel">
      <div class="tabs" role="tablist" aria-label="Side panel">
        {#each [['signals', 'Patterns', 'shapes'], ['alerts', 'Alerts', 'bell'], ['liq', 'Liquidations', 'flame'], ['ind', 'Indicators', 'layers'], ['health', 'Health', 'pulse']] as [id, name, ic]}
          <button role="tab" id="tab-{id}" aria-selected={tab === id} aria-controls="panel-{id}" class:on={tab === id} title={name} onclick={() => openTab(id as SideTab)}>
            <Icon name={ic} size={15} /><span class="tname">{name}</span>
            {#if id === 'signals' && patternCount}<span class="badge">{patternCount}</span>{/if}
            {#if id === 'health' && (totals?.checksum || totals?.gaps || totals?.crossed)}<span class="badge bad">!</span>{/if}
          </button>
        {/each}
      </div>

      <div class="panel" role="tabpanel" id="panel-alerts" aria-labelledby="tab-alerts" hidden={tab !== 'alerts'}>
        <Alerts bind:this={alertsPanel} {venue} label={res ? `${res.base}/${res.quote}` : pair} symbol={res?.symbol ?? null} mid={table ? midOf(table.bestBid, table.bestAsk) : NaN} decimals={table?.decimals} />
      </div>

      <div class="panel" role="tabpanel" id="panel-signals" aria-labelledby="tab-signals" hidden={tab !== 'signals'}>
        <section>
          <h2>Chart patterns
            <label class="tog"><input type="checkbox" bind:checked={showChart} onchange={() => { engine?.setSettings({ showChartPatterns: showChart }); persistChart(); }} /> show</label>
          </h2>
          {#if win}<p class="dim small">Searching only inside the box drawn on the chart. <button class="link" onclick={clearWindow}>Clear window</button></p>
          {:else}<p class="dim small">Drag a box on the candles with <b>window</b> (<kbd>W</kbd>, or shift+drag) to analyse just that part.</p>{/if}
          <button class="explain" onclick={openExplanation}>Explain these patterns <kbd>E</kbd></button>
          {#if chartPatterns.length === 0}<p class="empty">{win ? 'No chart patterns inside the window.' : 'None in view yet. Patterns need closed candles; try 1m or 5m.'}</p>{/if}
          <ul class="pats">
            {#each chartPatterns as p (p.id)}
              <li class:sel={selected === p.id}>
                <button onclick={() => selectPattern(p.id)} aria-expanded={selected === p.id}>
                  <span class="dot" class:bull={p.bias > 0} class:bear={p.bias < 0}></span>
                  <span class="name">{p.label}</span>
                  <span class="st {p.status}">{p.status}</span>
                </button>
                {#if selected === p.id}
                  <div class="detail mono">
                    {#if p.breakout}breakout {fmt(p.breakout.p, 2)}<br />{/if}
                    {#if p.target !== undefined}target {fmt(p.target, 2)}<br />{/if}
                    {#if p.stop !== undefined}stop {fmt(p.stop, 2)}<br />{/if}
                    fit {fmt(p.score * 100, 0)}%{#if p.note}<br />{p.note}{/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
          {#if stats?.patterns.outcomes.length}
            <p class="dim small">In this history, confirmed patterns reached target / hit stop first:
              {#each stats.patterns.outcomes as o}<br /><span class="mono">{o.kind}: {o.hit} / {o.stopped}{o.open ? ` (${o.open} open)` : ''}</span>{/each}
            </p>
          {/if}
        </section>
        <section>
          <h2>Candle signals
            <label class="tog"><input type="checkbox" bind:checked={showCandle} onchange={() => { engine?.setSettings({ showCandlePatterns: showCandle }); persistChart(); }} /> show</label>
          </h2>
          {#if candlePats.length === 0}<p class="empty">No candle signals yet.</p>{/if}
          <ul class="pats">
            {#each candlePats as p (p.id)}
              <li><button onclick={() => selectPattern(p.id)}>
                <span class="dot" class:bull={p.bias > 0} class:bear={p.bias < 0}></span>
                <span class="name">{p.label}</span>
              </button></li>
            {/each}
          </ul>
          <p class="dim small">Detected in {fmt(stats?.patterns.computeMs, 1)} ms over {int(stats?.patterns.candles)} candles, in a worker.{#if stats?.patterns.backfill}{' '}{int(stats.patterns.backfill)} older bars were backfilled over REST{#if venue === 'kraken'}{' '}({stats.patterns.source === 'kraken' ? "Kraken's own" : stats.patterns.source === 'kraken+binance' ? "Kraken's latest 720, older from Binance rescaled to Kraken's price" : "from Binance, rescaled to Kraken's price"}){/if}.{/if}</p>
        </section>
      </div>

      <div class="panel" role="tabpanel" id="panel-liq" aria-labelledby="tab-liq" hidden={tab !== 'liq'}>
        <section>
          <h2>Liquidation levels
            <span class="pill" class:ok={stats?.liq?.status === 'live'} class:bad={/error|no /.test(stats?.liq?.status ?? '')}>{stats?.liq?.status ?? 'idle'}</span>
            <label class="tog"><input type="checkbox" bind:checked={showLiq} onchange={() => { engine?.setSettings({ showLiquidations: showLiq }); syncUrl(); persistChart(); }} /> show</label>
          </h2>
          {#if stats?.liq}
            <div class="cards">
              <div class="card"><span class="k">Largest long cluster</span><span class="v mono down">{stats.liq.long ? px(stats.liq.long.price) : '–'}</span><span class="s mono">{stats.liq.long ? usd(stats.liq.long.notional) : ''}</span></div>
              <div class="card"><span class="k">Largest short cluster</span><span class="v mono up">{stats.liq.short ? px(stats.liq.short.price) : '–'}</span><span class="s mono">{stats.liq.short ? usd(stats.liq.short.notional) : ''}</span></div>
            </div>
            <dl class="mono">
              <dt>Liquidations seen</dt><dd>{int(stats.liq.liquidations)} · {usd(stats.liq.liquidatedNotional)}</dd>
              <dt>Futures msgs / s</dt><dd>{int(stats.liq.msgsPerSec)}</dd>
            </dl>
          {/if}
          <p class="dim small">Bands on the candles are estimated liquidation levels for the {stats?.liq?.symbol || '…'} Binance perpetual (Kraken spot has no liquidations), rescaled to this chart's price: green is light, yellow and red are heavy, and the hottest levels are labelled. Built from {stats?.liq?.source === 'volume estimate' ? 'trade volume (open interest was not reachable)' : 'open interest changes'} and an assumed 10–100× leverage mix over {int(stats?.liq?.bars)} bars{#if stats?.liq?.backfillMs}{' '}(history rebuilt in {fmt(stats.liq.backfillMs, 0)} ms){/if}. Squares are real liquidations: red longs, green shorts. Cluster prices are in USDT.</p>
        </section>
      </div>

      <div class="panel" role="tabpanel" id="panel-ind" aria-labelledby="tab-ind" hidden={tab !== 'ind'}>
        <section>
          <h2>Indicators</h2>
          <Indicators list={indicators} {theme} onchange={setIndicators} />
        </section>
      </div>

      <div class="panel" role="tabpanel" id="panel-health" aria-labelledby="tab-health" hidden={tab !== 'health'}>
        <section>
          <div class="cards">
            <div class="card"><span class="k">Frame rate</span><span class="v mono" class:up={fps >= 55} class:warnt={fps < 55}>{Number.isFinite(fps) ? fmt(fps, 0) : '–'}<small> fps</small></span><span class="s mono">p99 {fmt(stats?.render?.frameInterval.p99)} ms</span></div>
            <div class="card"><span class="k">Receive → draw</span><span class="v mono">{fmt(stats?.render?.latency.p50)}<small> ms</small></span><span class="s mono">p99 {fmt(stats?.render?.latency.p99)} ms</span></div>
            <div class="card"><span class="k">Level changes / s</span><span class="v mono">{int(totals?.levels)}</span><span class="s mono">{int(totals?.msgs)} msgs / s</span></div>
            <div class="card"><span class="k">Render CPU</span><span class="v mono">{fmt(stats?.render?.cpu.p50, 2)}<small> ms</small></span><span class="s mono">p99 {fmt(stats?.render?.cpu.p99, 2)} ms</span></div>
          </div>
        </section>
        <section>
          <h2>Feed integrity <span class="pill" class:ok={live} class:bad={focusStatus.startsWith('error') || focusStatus === 'not listed'}>{focusStatus}</span></h2>
          {#if !res}<p class="dim small">{venueName(venue)} doesn't list {pair}.{#if index[otherVenue].resolve(pair)}{' '}{venueName(otherVenue)} does.{/if}</p>
          {:else if res.standIn}<p class="dim small">{venueName(venue)} has no {pair}; showing {res.base}/{res.quote}.</p>{/if}
          <dl class="mono">
            <dt>Books kept live</dt><dd>{int(totals?.books)}</dd>
            <dt>Checksum failures</dt><dd class:bad={!!totals?.checksum}>{int(totals?.checksum)}</dd>
            <dt>Sequence gaps</dt><dd class:bad={!!totals?.gaps}>{int(totals?.gaps)}</dd>
            <dt>Resyncs · reconnects</dt><dd>{int(totals?.resyncs)} · {int(totals?.reconnects)}</dd>
            <dt>Crossed books seen</dt><dd class:bad={!!totals?.crossed}>{int(totals?.crossed)}</dd>
          </dl>
        </section>
        <section>
          <h2>Performance <button class="link" onclick={() => { engine?.resetStats(); toast('Measurements reset'); }}>reset</button></h2>
          <dl class="mono">
            <dt>Slow frames (&gt;1.5× median)</dt><dd>{int(stats?.render?.dropped)} of {int(stats?.render?.frames)}</dd>
            <dt>GPU time</dt><dd>{stats?.render && stats.render.gpuMs >= 0 ? `${fmt(stats.render.gpuMs, 2)} ms` : 'n/a'}</dd>
            <dt>Frames skipped (idle)</dt><dd>{int(stats?.render?.skipped)}</dd>
            <dt>Parse + apply p99</dt><dd>{fmt((stats?.feeds[venue]?.parse.p99 ?? 0) + (stats?.feeds[venue]?.apply.p99 ?? 0), 3)} ms</dd>
            <dt>Main thread long frames</dt><dd>{int(stats?.main.loafCount)} ({fmt(stats?.main.loafBlockingMs, 0)} ms blocking)</dd>
            <dt>Heap</dt><dd>{stats?.main.heapMB != null ? `${fmt(stats.main.heapMB)} MB` : 'n/a'}</dd>
            <dt>Shared memory</dt><dd>{stats?.shared ? 'yes (SharedArrayBuffer)' : 'no (postMessage fallback)'}</dd>
          </dl>
        </section>
        <section>
          <h2>Navigating the charts</h2>
          <p class="dim small">Scroll (two fingers on a trackpad) to move around the candles, sideways through time and up or down in price; scroll sideways on the depth chart to move its price range. Pinch, the − + fit buttons, or dragging an axis zoom: the price axis on the right of the candles, the time strip just under them, and the price strip under the depth chart. Double-click an axis to reset it; fit (<kbd>F</kbd>) resets every panel and returns to live. Drag the lines between panels to resize them. Hover a book row to see what filling up to it costs. Press <kbd>?</kbd> for every shortcut.</p>
        </section>
      </div>
    </aside>
  </main>

  {#if explanation}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="backdrop" onclick={() => (explanation = null)}></div>
    <div class="explainer" role="dialog" aria-modal="true" aria-labelledby="explain-title">
      <div class="ehead">
        <h2 id="explain-title">{explanation.title}</h2>
        <button class="ghost" onclick={copyExplanation}>{copied ? 'Copied' : 'Copy'}</button>
        <button class="ghost icon" aria-label="Close" onclick={() => (explanation = null)}><Icon name="close" /></button>
      </div>
      <p class="summary">{explanation.summary}</p>
      {#each explanation.items as it (it.id)}
        <article class:sel={selected === it.id}>
          <h3><button class="link" title="Show on the chart" onclick={() => selectPattern(it.id)}>{it.heading}</button></h3>
          <p>{it.text}</p>
        </article>
      {/each}
    </div>
  {/if}

  <section class="table" id="book-table" tabindex="-1" class:sr-only={!showTable} aria-label="Order book table">
    <h2>{venue} {res ? `${res.base}/${res.quote}` : pair} order book ({table?.status ?? '…'})</h2>
    {#if table}
      <table class="mono">
        <thead><tr><th>Side</th><th>Price</th><th>Size</th><th>Total</th></tr></thead>
        <tbody>
          {#each table.asks.slice().reverse() as r}<tr class="ask"><td>ask</td><td>{fmt(r.price, table.decimals)}</td><td>{fmt(r.qty, 4)}</td><td>{fmt(r.cum, 4)}</td></tr>{/each}
          {#each table.bids as r}<tr class="bid"><td>bid</td><td>{fmt(r.price, table.decimals)}</td><td>{fmt(r.qty, 4)}</td><td>{fmt(r.cum, 4)}</td></tr>{/each}
        </tbody>
      </table>
    {:else}<p class="dim">Table needs shared memory (cross-origin isolation).</p>{/if}
  </section>
  {#if helpOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="backdrop" onclick={() => (helpOpen = false)}></div>
    <div class="explainer help" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <div class="ehead"><h2 id="help-title">Keyboard shortcuts</h2><button class="ghost icon" aria-label="Close" onclick={() => (helpOpen = false)}><Icon name="close" /></button></div>
      <div class="keys">
        {#each [
          [['/', 'Ctrl K'], 'Search pairs'], [['1', '–', '6'], 'Candle size 1m, 5m, 15m, 1h, 4h, 1D'], [[',', '.'], 'Smaller / larger candle size'],
          [['V'], 'Switch venue'], [['F'], 'Fit every panel, back to live'], [['W'], 'Draw a pattern window'], [['E'], 'Explain the patterns'],
          [['I'], 'Indicators'], [['P'], 'Chart patterns on / off'], [['L'], 'Liquidation levels on / off'], [['B'], 'Side panel'],
          [['T'], 'Theme: system, dark, light'], [['?'], 'This list'], [['Esc'], 'Close'],
        ] as [ks, what]}
          <div class="krow"><span class="kk">{#each ks as k}{#if k === '–'}<span class="dim">–</span>{:else}<kbd>{k}</kbd>{/if}{/each}</span><span>{what}</span></div>
        {/each}
      </div>
    </div>
  {/if}

  <div class="toasts" role="status" aria-live="polite">
    {#each toasts as t (t.id)}
      <div class="toast {t.tone}"><span>{t.text}</span><button class="link" aria-label="Dismiss" onclick={() => dismissToast(t.id)}><Icon name="close" size={14} /></button></div>
    {/each}
  </div>
</div>



<style>
  .shell { display: flex; flex-direction: column; height: 100%; }
  .skip { position: absolute; left: 8px; top: -40px; z-index: 50; background: var(--accent); color: var(--accent-ink); padding: 6px 10px; border-radius: var(--r-sm); }
  .skip:focus { top: 8px; }
  select, button { font: inherit; color: var(--text); background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 4px 8px; }
  select:hover, button:hover { border-color: var(--line-strong); }
  button { cursor: pointer; }
  label { display: inline-flex; gap: 6px; align-items: center; color: var(--dim); }

  /* ---- top bar: brand, pair, venue, ticker, status, actions ---- */
  .topbar { display: flex; align-items: center; gap: var(--s3); padding: 6px var(--s3) 6px var(--s4); min-height: 52px; background: var(--panel); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .brand { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; letter-spacing: 0.01em; }
  .pairbox { display: inline-flex; align-items: center; gap: var(--s2); }
  .seg { display: inline-flex; background: var(--bg); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 2px; gap: 2px; }
  .seg button, .seg select { border: 0; background: transparent; color: var(--dim); padding: 3px 9px; border-radius: 4px; }
  .seg button:hover, .seg select:hover { color: var(--text); background: var(--hover); }
  .seg button.on, .seg select.on { background: var(--raised); color: var(--text); box-shadow: 0 0 0 1px var(--line-strong); }
  .seg.venue button.on { color: var(--accent); }
  .seg button.unlisted:not(.on) { color: var(--faint); text-decoration: line-through; }
  .ticker { display: flex; align-items: center; gap: var(--s4); margin: 0 0 0 var(--s2); min-width: 0; }
  .ticker > div { display: flex; flex-direction: column; line-height: 1.2; white-space: nowrap; }
  .ticker dt { font: 11px ui-sans-serif, system-ui, sans-serif; color: var(--faint); }
  .ticker dd { margin: 0; font-size: 12px; }
  .ticker dd span { color: inherit; opacity: 0.85; }
  .ticker .price { font-size: 18px; font-weight: 650; letter-spacing: -0.01em; transition: color 0.2s; }
  .up { color: var(--bid); }
  .down { color: var(--ask); }
  .spacer { flex: 1; }
  .chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 13px; font-size: 12px; color: var(--dim); background: var(--bg); }
  .chip .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 25%, transparent); }
  .chip.ok .dot { background: var(--bid); box-shadow: 0 0 0 3px var(--bid-soft); }
  .chip.bad .dot { background: var(--ask); box-shadow: 0 0 0 3px var(--ask-soft); }
  .chip.perf.warnc { color: var(--warn); }
  .icons { display: inline-flex; gap: 2px; }
  .icon { display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; border-color: transparent; background: transparent; color: var(--dim); }
  .icon:hover, .icon.on { color: var(--text); background: var(--hover); border-color: transparent; }
  .pop-anchor { position: relative; }
  .scrim { position: fixed; inset: 0; z-index: 29; }
  .popover { position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; width: 280px; padding: var(--s3); background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); }
  .popover h3 { margin: 4px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
  .popover h3 + .row { margin-top: 0; }
  .popover .row { display: flex; justify-content: space-between; margin: 6px 0; width: 100%; }
  .popover .row select { min-width: 140px; }
  .popover .check { display: flex; margin: 8px 0; color: var(--text); }
  .popover .foot { border-top: 1px solid var(--line); margin-top: var(--s2); padding-top: var(--s2); }

  /* ---- toolbar: candle size, grouping, overlays, favourites ---- */
  .toolbar { display: flex; align-items: center; gap: var(--s2); padding: 5px var(--s4); border-bottom: 1px solid var(--line); background: var(--bg); overflow-x: auto; scrollbar-width: none; }
  .toolbar::-webkit-scrollbar { display: none; }
  .tf select { padding-right: 4px; }
  .sep { width: 1px; height: 18px; background: var(--line); flex: none; }
  .inline { white-space: nowrap; font-size: 12px; }
  .inline select { padding: 3px 6px; }
  .toggles { display: inline-flex; gap: 4px; }
  .tg { font-size: 12px; padding: 3px 10px; border-radius: 13px; color: var(--dim); background: transparent; white-space: nowrap; }
  .tg.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: var(--accent-soft); }
  .favs { display: inline-flex; align-items: center; gap: 4px; }
  .favs .star { color: var(--warn); font-size: 12px; }
  .fav { font-size: 12px; padding: 2px 8px; border-radius: 12px; background: transparent; white-space: nowrap; }
  .fav.on { color: var(--accent); border-color: var(--accent); }

  main { flex: 1; display: flex; min-height: 0; }
  .stage { flex: 1; position: relative; min-width: 0; touch-action: none; }
  .stage :global(canvas) { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .stage.drawing { cursor: crosshair; }
  .overlay { position: absolute; z-index: 5; top: 40px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 10px;
    padding: 8px 14px; background: var(--raised); border: 1px solid var(--line); border-radius: 20px; box-shadow: var(--shadow-lg); white-space: nowrap; }
  .overlay .primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); border-radius: 14px; padding: 3px 12px; }
  .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--line-strong); border-top-color: var(--accent); animation: spin 0.8s linear infinite; }
  .dotc { width: 8px; height: 8px; border-radius: 50%; background: var(--ask); }
  @keyframes spin { to { transform: rotate(360deg); } }
  .wintools button.on { color: var(--accent); border-color: var(--accent); }
  .indmenu { position: absolute; z-index: 4; width: min(300px, calc(100% - 32px)); max-height: 70%; overflow: auto; padding: 6px 12px 10px;
    background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-md); box-shadow: var(--shadow-lg); }
  .indmenu h2 { margin: 4px 0; }
  .zoom { position: absolute; display: flex; justify-content: flex-end; gap: 2px; z-index: 2; }
  .zoom button { padding: 0 6px; height: 18px; line-height: 16px; font-size: 12px; min-width: 22px; background: var(--panel); color: var(--dim); border-radius: 4px; }
  .zoom button:hover { color: var(--text); border-color: var(--dim); }
  .axis { position: absolute; z-index: 2; touch-action: none; }
  .axis.y { cursor: ns-resize; }
  .axis.x { cursor: ew-resize; }
  .axis:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  .split { position: absolute; z-index: 3; touch-action: none; }
  .split.v { width: 8px; cursor: col-resize; }
  .split.h { height: 8px; cursor: row-resize; }
  .split:hover, .split:focus-visible { background: color-mix(in srgb, var(--accent) 35%, transparent); outline: none; }
  .split.side { position: relative; flex: none; margin: 0 -4px; align-self: stretch; }

  /* ---- side panel: tabs ---- */
  aside { width: var(--side-w, 310px); display: flex; flex-direction: column; border-left: 1px solid var(--line); background: var(--panel); min-height: 0; }
  aside.closed { display: none; }
  .tabs { display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid var(--line); flex: none; }
  .tabs button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 5px; position: relative; padding: 7px 4px 8px; border: 0; border-radius: 6px 6px 0 0; background: transparent; color: var(--dim); font-size: 12px; min-width: 0; }
  .tabs button:hover { color: var(--text); background: var(--hover); }
  .tabs button.on { color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
  .tname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* a narrow panel names only the open tab; the others show their icon (and title on hover) */
  aside.narrowside .tabs button:not(.on) .tname { display: none; }
  aside.narrowside .tabs button.on { flex: none; padding: 7px 10px 8px; }
  .badge { font: 10px var(--mono); min-width: 16px; padding: 0 4px; border-radius: 8px; background: var(--accent-soft); color: var(--accent); }
  .badge.bad { background: var(--ask-soft); color: var(--ask); }
  .panel { overflow-y: auto; padding: 2px 14px 16px; flex: 1; }
  .panel[hidden] { display: none; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--faint); margin: 14px 0 8px; display: flex; align-items: center; gap: 8px; font-weight: 600; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 3px 10px; margin: 0; font-size: 12px; }
  dt { color: var(--dim); font-family: ui-sans-serif, system-ui, sans-serif; }
  dd { margin: 0; text-align: right; }
  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 12px 0 4px; }
  .card { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; background: var(--bg); border: 1px solid var(--line); border-radius: var(--r-md); min-width: 0; }
  .card .k { font-size: 11px; color: var(--faint); }
  .card .v { font-size: 17px; font-weight: 600; }
  .card .v small { font-size: 11px; font-weight: 400; color: var(--dim); }
  .card .s { font-size: 11px; color: var(--dim); }
  .warnt { color: var(--warn); }
  .bad { color: var(--ask); }
  .pill { font-size: 11px; text-transform: none; letter-spacing: 0; padding: 1px 8px; border-radius: 10px; background: var(--hover); color: var(--warn); font-weight: 400; }
  .pill.ok { color: var(--bid); }
  .pill.bad { color: var(--ask); }
  .link { border: 0; background: none; color: var(--accent); padding: 0; text-transform: none; letter-spacing: 0; font-size: 12px; }
  .tog { font-size: 12px; text-transform: none; letter-spacing: 0; margin-left: auto; font-weight: 400; }
  .explain { margin: 4px 0 8px; display: inline-flex; gap: 8px; align-items: center; }
  .empty { color: var(--faint); font-size: 12px; padding: 10px; border: 1px dashed var(--line); border-radius: var(--r-md); text-align: center; }
  .pats { list-style: none; margin: 0; padding: 0; }
  .pats li button { width: 100%; display: flex; align-items: center; gap: 8px; border: 0; background: none; padding: 5px 6px; text-align: left; border-radius: 6px; }
  .pats li button:hover { background: var(--hover); }
  .pats li.sel button { background: var(--accent-soft); }
  .name { flex: 1; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); flex: none; }
  .dot.bull { background: var(--bid); }
  .dot.bear { background: var(--ask); }
  .st { font-size: 11px; color: var(--dim); }
  .st.confirmed { color: var(--text); }
  .st.failed { color: var(--ask); }
  .detail { font-size: 12px; color: var(--dim); padding: 2px 0 6px 22px; }
  .dim { color: var(--dim); }
  .small { font-size: 12px; }

  /* ---- dialogs and toasts ---- */
  .backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / 0.45); z-index: 20; }
  .explainer { position: fixed; z-index: 21; top: 8vh; left: 50%; transform: translateX(-50%); width: min(720px, calc(100vw - 32px)); max-height: 84vh; overflow: auto;
    background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 14px 18px; box-shadow: var(--shadow-lg); }
  .explainer.help { width: min(520px, calc(100vw - 32px)); }
  .ehead { display: flex; gap: 8px; align-items: center; }
  .ehead h2 { flex: 1; margin: 0; font-size: 15px; text-transform: none; letter-spacing: 0; color: var(--text); }
  .ghost { background: transparent; }
  .ghost.icon { width: 28px; height: 28px; }
  .explainer .summary { color: var(--text); }
  .explainer article { border-top: 1px solid var(--line); padding: 6px 0; }
  .explainer article.sel h3 button { color: var(--accent); }
  .explainer h3 { margin: 4px 0; font-size: 13px; }
  .explainer h3 button { text-align: left; }
  .explainer p { margin: 4px 0; line-height: 1.45; color: var(--dim); }
  .keys { margin-top: 10px; display: grid; gap: 2px; }
  .krow { display: flex; align-items: center; gap: 12px; padding: 5px 0; border-top: 1px solid var(--line); }
  .kk { display: inline-flex; gap: 4px; min-width: 110px; }
  .toasts { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 8px; z-index: 40; pointer-events: none; }
  .toast { pointer-events: auto; display: flex; gap: 10px; align-items: center; background: var(--raised); border: 1px solid var(--line); border-radius: 18px; padding: 7px 10px 7px 14px; box-shadow: var(--shadow-lg); font-size: 13px; animation: rise 0.18s ease-out; }
  .toast.ok { border-color: color-mix(in srgb, var(--bid) 50%, var(--line)); }
  .toast.warn { border-color: color-mix(in srgb, var(--warn) 60%, var(--line)); }
  .toast .link { color: var(--dim); display: inline-grid; }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
  .table { padding: 0 16px 16px; max-height: 40vh; overflow: auto; border-top: 1px solid var(--line); }
  .table table { border-collapse: collapse; font-size: 12px; }
  .table td, .table th { padding: 2px 12px; text-align: right; }
  .table tr.ask td:nth-child(2) { color: var(--ask); }
  .table tr.bid td:nth-child(2) { color: var(--bid); }

  @media (max-width: 1280px) { .ticker .opt { display: none; } }
  @media (max-width: 1000px) { .ticker .opt2, .chip.perf { display: none; } .brand strong { display: none; } }
  @media (max-width: 760px) {
    .topbar { padding: 6px 10px; gap: 6px 8px; }
    .brand { order: 0; }
    .pairbox { order: 1; flex: 1; }
    .chip.status { order: 2; padding: 0 8px; }
    .chip.status .stxt { display: none; }
    .icons { order: 3; }
    .icons .kbd, .icons .themeb { display: none; }
    .seg.venue { order: 4; }
    .ticker { order: 5; flex: 1; margin: 0; justify-content: space-between; gap: 10px; }
    .ticker .price { font-size: 16px; }
    .ticker .opt { display: flex; }
    .ticker .opt:nth-of-type(n + 5) { display: none; }
    .toolbar { padding: 5px 10px; }
    .tf button, .tg, .fav { min-height: 30px; }
    main { flex-direction: column; overflow-y: auto; }
    .stage { flex: none; height: 78vh; }
    .split.side { display: none; }
    aside { width: auto; border-left: 0; border-top: 1px solid var(--line); }
    .panel { overflow: visible; }
    .tabs button:not(.on) .tname { display: none; }
    .tabs button { min-height: 40px; }
  }
</style>
