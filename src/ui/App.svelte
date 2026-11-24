<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Engine, type Snapshot, type LadderRow } from './engine';
  import { INTERVALS, LIVE, localEndpoints, type Interval, type Venue } from '../shared/config';
  import {
    allPairs, builtinCatalog, loadCachedCatalog, loadFavourites, MarketIndex, quoteRanking,
    saveCachedCatalog, saveFavourites, splitLabel, toggleFavourite, type Catalog,
  } from '../shared/pairs';
  import PairPicker from './PairPicker.svelte';
  import type { SceneSettings } from '../render/scene';
  import type { PatternHit } from '../patterns/types';
  import Alerts from './Alerts.svelte';
  import { midOf } from '../alerts/alerts';
  import { HEADER_CTRL_W } from '../render/scene';
  import { computeLayout, dragSplit, DEFAULT_LAYOUT, ZOOM, type LayoutPrefs } from '../render/layout';
  import type { ZoomPane } from '../workers/protocol';
  import { loadPrefs, savePrefs, defaultPrefs, SIDE_W, type ViewPrefs } from './prefs';

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
  let interval = $state<Interval>((Number(q.get('interval')) as Interval) || 15);
  let load = $state(Number(q.get('pairs') ?? 1));
  let theme = $state<'dark' | 'light'>(q.get('theme') === 'light' ? 'light' : 'dark');
  let showChart = $state(true);
  let showCandle = $state(true);
  let reducedMotion = $state(matchMedia('(prefers-reduced-motion: reduce)').matches);
  let showTable = $state(false);
  let selected = $state<string | null>(null);

  // layout + zoom, remembered in this browser ($state.raw: plain objects, so they can be posted to the worker)
  const saved = loadPrefs();
  let layoutPrefs = $state.raw<LayoutPrefs>(saved.layout);
  let sideW = $state(saved.sideW);
  let fontPx = $state(saved.fontPx);
  let zoomState = { candlesVisible: saved.candlesVisible, depthRangePct: saved.depthRangePct, ladderRowPad: saved.ladderRowPad };
  let stageW = $state(0), stageH = $state(0);
  let panes = $derived(stageW ? computeLayout(stageW, stageH, layoutPrefs) : null);
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
    depthRangePct: zoomState.depthRangePct, candlesVisible: zoomState.candlesVisible, ladderRowPad: zoomState.ladderRowPad, reducedMotion,
    showChartPatterns: showChart, showCandlePatterns: showCandle, selectedPattern: selected,
    venueLabel: venue.toUpperCase(), pairLabel: res ? `${res.base}/${res.quote}` : pair,
  });

  function start() {
    engine?.destroy();
    const canvas = canvasHost.querySelector('canvas')!;
    engine = new Engine({
      canvas,
      endpoints: source === 'local' ? localEndpoints(host) : LIVE,
      pairCount: load,
      depth: { kraken: source === 'local' ? 1000 : 500, binance: 1000 },
      venue, pair, catalog, group, interval, settings: settings(), theme, layout: layoutPrefs, fontPx,
    });
    engine.onZoom = (z) => {
      zoomState = { candlesVisible: z.candlesVisible, depthRangePct: z.depthRangePct, ladderRowPad: z.ladderRowPad };
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
    alertsPanel?.attach(engine);
    (window as any).__depthline = engine;
  }

  function restart() {
    generation++;
    // wait for the keyed canvas to remount
    queueMicrotask(() => requestAnimationFrame(start));
  }

  function syncUrl() {
    const p = new URLSearchParams({ src: source, venue, pair, group: String(group), interval: String(interval), pairs: String(load), theme });
    if (source === 'local') p.set('host', host);
    history.replaceState(null, '', `?${p}`);
  }

  onMount(() => {
    document.documentElement.dataset.theme = theme;
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
  const click = (e: MouseEvent) => {
    const r = canvasHost.getBoundingClientRect();
    engine?.click(e.clientX - r.left, e.clientY - r.top);
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = canvasHost.getBoundingClientRect();
    engine?.wheel(e.clientX - r.left, e.clientY - r.top, e.deltaY);
  };

  const fmt = (x: number | undefined, d = 1) => (x === undefined || !isFinite(x) ? '–' : x.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
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
  const groups = [1, 10, 100, 1000];

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
  function resetView() {
    const d = defaultPrefs();
    setLayout(d.layout);
    sideW = d.sideW;
    fontPx = d.fontPx;
    engine?.setFont(fontPx);
    for (const p of ['ladder', 'depth', 'candles'] as ZoomPane[]) engine?.zoom(p, 0);
    zoomState = { candlesVisible: d.candlesVisible, depthRangePct: d.depthRangePct, ladderRowPad: d.ladderRowPad };
    persist();
  }
</script>

<div class="shell">
  <header>
    <strong class="brand">Depthline</strong>
    <label>Source
      <select bind:value={source} onchange={() => { catalog = initialCatalog(); syncUrl(); restart(); }}>
        <option value="live">Live exchanges</option>
        <option value="local">Local emulator</option>
      </select>
    </label>
    <div class="seg" role="group" aria-label="Venue">
      {#each ['kraken', 'binance'] as v}
        <button class:on={venue === v} class:unlisted={!index[v as Venue].resolve(pair)}
          title={index[v as Venue].resolve(pair) ? '' : `${venueName(v as Venue)} doesn't list ${pair}`}
          onclick={() => { venue = v as Venue; engine?.setVenue(venue); selected = null; syncUrl(); }}>{venueName(v as Venue)}</button>
      {/each}
    </div>
    <PairPicker {pair} {entries} {quotes} {favourites} {venue} resolve={(v, l) => index[v].resolve(l)} onpick={pickPair} onfavourite={favourite} />
    <label>Group
      <select bind:value={group} onchange={() => { engine?.setGroup(group); syncUrl(); }}>
        {#each groups as g}<option value={g}>{g === 1 ? 'tick' : `${g} ticks`}</option>{/each}
      </select>
    </label>
    <label>Candles
      <select bind:value={interval} onchange={() => { engine?.setInterval(interval); selected = null; syncUrl(); }}>
        {#each INTERVALS as m}<option value={m}>{m < 60 ? `${m}m` : `${m / 60}h`}</option>{/each}
      </select>
    </label>
    <label title="Pairs kept live per venue. More pairs = more updates per second.">Load
      <select bind:value={load} onchange={() => { syncUrl(); restart(); }}>
        {#each [1, 5, 10, 25] as n}<option value={n}>{n} pair{n > 1 ? 's' : ''}/venue</option>{/each}
      </select>
    </label>
    <span class="spacer"></span>
    <button class="ghost" onclick={() => { theme = theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; engine?.setTheme(theme); syncUrl(); }}>{theme === 'dark' ? 'Light' : 'Dark'}</button>
  </header>

  <main>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="stage" bind:this={canvasHost}
      onpointermove={(e) => ptr(e)} onpointerleave={(e) => ptr(e, false)} onclick={click} onwheel={wheel}
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
    </div>

    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div class="split v side" role="separator" aria-orientation="vertical" aria-label="Resize side panel" tabindex="0" aria-valuemin={SIDE_W.min} aria-valuemax={SIDE_W.max} aria-valuenow={sideW}
      onpointerdown={dragSide} onkeydown={sideKey} ondblclick={() => { sideW = SIDE_W.def; persist(); }}></div>
    <aside style="--side-w:{sideW}px">
      <Alerts bind:this={alertsPanel} {venue} label={res ? `${res.base}/${res.quote}` : pair} symbol={res?.symbol ?? null} mid={table ? midOf(table.bestBid, table.bestAsk) : NaN} decimals={table?.decimals} />

      <section>
        <h2>Feed integrity <span class="pill" class:ok={focusStatus.startsWith('live')} class:bad={focusStatus.startsWith('error') || focusStatus === 'not listed'}>{focusStatus}</span></h2>
        {#if !res}<p class="dim small">{venueName(venue)} doesn't list {pair}.{#if index[venue === 'kraken' ? 'binance' : 'kraken'].resolve(pair)}{' '}{venueName(venue === 'kraken' ? 'binance' : 'kraken')} does.{/if}</p>
        {:else if res.standIn}<p class="dim small">{venueName(venue)} has no {pair}; showing {res.base}/{res.quote}.</p>{/if}
        <dl class="mono">
          <dt>Books kept live</dt><dd>{int(totals?.books)}</dd>
          <dt>Messages / s</dt><dd>{int(totals?.msgs)}</dd>
          <dt>Level changes / s</dt><dd>{int(totals?.levels)}</dd>
          <dt>Checksum failures</dt><dd class:bad={!!totals?.checksum}>{int(totals?.checksum)}</dd>
          <dt>Sequence gaps</dt><dd class:bad={!!totals?.gaps}>{int(totals?.gaps)}</dd>
          <dt>Resyncs · reconnects</dt><dd>{int(totals?.resyncs)} · {int(totals?.reconnects)}</dd>
          <dt>Crossed books seen</dt><dd class:bad={!!totals?.crossed}>{int(totals?.crossed)}</dd>
        </dl>
      </section>

      <section>
        <h2>Performance <button class="link" onclick={() => engine?.resetStats()}>reset</button></h2>
        <dl class="mono">
          <dt>Frame interval p50 / p99</dt><dd>{fmt(stats?.render?.frameInterval.p50)} / {fmt(stats?.render?.frameInterval.p99)} ms</dd>
          <dt>Slow frames (&gt;1.5× median)</dt><dd>{int(stats?.render?.dropped)} of {int(stats?.render?.frames)}</dd>
          <dt>Render CPU p50 / p99</dt><dd>{fmt(stats?.render?.cpu.p50, 2)} / {fmt(stats?.render?.cpu.p99, 2)} ms</dd>
          <dt>GPU time</dt><dd>{stats?.render && stats.render.gpuMs >= 0 ? `${fmt(stats.render.gpuMs, 2)} ms` : 'n/a'}</dd>
          <dt>Receive → draw p50 / p99</dt><dd>{fmt(stats?.render?.latency.p50)} / {fmt(stats?.render?.latency.p99)} ms</dd>
          <dt>Frames skipped (idle)</dt><dd>{int(stats?.render?.skipped)}</dd>
          <dt>Parse + apply p99</dt><dd>{fmt((stats?.feeds[venue]?.parse.p99 ?? 0) + (stats?.feeds[venue]?.apply.p99 ?? 0), 3)} ms</dd>
          <dt>Main thread long frames</dt><dd>{int(stats?.main.loafCount)} ({fmt(stats?.main.loafBlockingMs, 0)} ms blocking)</dd>
          <dt>Heap</dt><dd>{stats?.main.heapMB != null ? `${fmt(stats.main.heapMB)} MB` : 'n/a'}</dd>
          <dt>Shared memory</dt><dd>{stats?.shared ? 'yes (SharedArrayBuffer)' : 'no (postMessage fallback)'}</dd>
        </dl>
      </section>

      <section>
        <h2>Chart patterns
          <label class="tog"><input type="checkbox" bind:checked={showChart} onchange={() => engine?.setSettings({ showChartPatterns: showChart })} /> show</label>
        </h2>
        {#if chartPatterns.length === 0}<p class="dim">None in view yet. Patterns need closed candles; try 1m or 5m.</p>{/if}
        <ul class="pats">
          {#each chartPatterns as p (p.id)}
            <li class:sel={selected === p.id}>
              <button onclick={() => selectPattern(p.id)}>
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
          <label class="tog"><input type="checkbox" bind:checked={showCandle} onchange={() => engine?.setSettings({ showCandlePatterns: showCandle })} /> show</label>
        </h2>
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

      <section>
        <h2>Options</h2>
        <label class="tog"><input type="checkbox" bind:checked={reducedMotion} onchange={() => engine?.setSettings({ reducedMotion })} /> Reduce motion (no flashes)</label>
        <label class="tog"><input type="checkbox" bind:checked={showTable} /> Show text table</label>
        <label class="tog">Text size
          <select bind:value={fontPx} onchange={setFont}>
            {#each Array.from({ length: ZOOM.font.max - ZOOM.font.min + 1 }, (_, i) => ZOOM.font.min + i) as px}<option value={px}>{px}px</option>{/each}
          </select>
        </label>
        <button class="link" onclick={resetView}>Reset layout and zoom</button>
        <p class="dim small">Scroll over a panel, or use its − + fit buttons, to zoom it. Drag the lines between panels to resize them (double-click one to reset it). Layout and zoom are remembered in this browser. Click a pattern label to select it.</p>
      </section>
    </aside>
  </main>

  <section class="table" class:sr-only={!showTable} aria-label="Order book table">
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
</div>

<style>
  .shell { display: flex; flex-direction: column; height: 100%; }
  header { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .brand { font-size: 15px; letter-spacing: 0.02em; margin-right: 6px; }
  label { display: inline-flex; gap: 6px; align-items: center; color: var(--dim); }
  select, button { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
  button { cursor: pointer; }
  .seg { display: inline-flex; }
  .seg button { border-radius: 0; }
  .seg button:first-child { border-radius: 6px 0 0 6px; }
  .seg button:last-child { border-radius: 0 6px 6px 0; border-left: 0; }
  .seg button.on { background: var(--accent); color: var(--bg); border-color: var(--accent); }
  .seg button.unlisted:not(.on) { color: var(--dim); text-decoration: line-through; }
  .spacer { flex: 1; }
  main { flex: 1; display: flex; min-height: 0; }
  .stage { flex: 1; position: relative; min-width: 0; touch-action: none; }
  .stage :global(canvas) { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .zoom { position: absolute; display: flex; justify-content: flex-end; gap: 2px; z-index: 2; }
  .zoom button { padding: 0 6px; height: 18px; line-height: 16px; font-size: 12px; min-width: 22px; background: var(--panel); color: var(--dim); }
  .zoom button:hover { color: var(--text); border-color: var(--dim); }
  .split { position: absolute; z-index: 3; touch-action: none; }
  .split.v { width: 8px; cursor: col-resize; }
  .split.h { height: 8px; cursor: row-resize; }
  .split:hover, .split:focus-visible { background: color-mix(in srgb, var(--accent) 35%, transparent); outline: none; }
  .split.side { position: relative; flex: none; margin: 0 -4px; align-self: stretch; }
  aside { width: var(--side-w, 310px); overflow-y: auto; border-left: 1px solid var(--line); padding: 4px 14px 16px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); margin: 14px 0 6px; display: flex; align-items: center; gap: 8px; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; margin: 0; font-size: 12px; }
  dt { color: var(--dim); font-family: ui-sans-serif, system-ui, sans-serif; }
  dd { margin: 0; text-align: right; }
  .bad { color: var(--ask); }
  .pill { font-size: 11px; text-transform: none; letter-spacing: 0; padding: 1px 8px; border-radius: 10px; background: var(--line); color: var(--warn); }
  .pill.ok { color: var(--bid); }
  .pill.bad { color: var(--ask); }
  .link { border: 0; background: none; color: var(--accent); padding: 0; text-transform: none; letter-spacing: 0; font-size: 12px; }
  .tog { font-size: 12px; text-transform: none; letter-spacing: 0; margin-left: auto; }
  section > .tog { display: flex; margin: 4px 0; }
  .pats { list-style: none; margin: 0; padding: 0; }
  .pats li button { width: 100%; display: flex; align-items: center; gap: 8px; border: 0; background: none; padding: 4px 2px; text-align: left; }
  .pats li.sel button { background: var(--line); border-radius: 6px; }
  .name { flex: 1; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); flex: none; }
  .dot.bull { background: var(--bid); }
  .dot.bear { background: var(--ask); }
  .st { font-size: 11px; color: var(--dim); }
  .st.confirmed { color: var(--text); }
  .st.failed { color: var(--ask); }
  .detail { font-size: 12px; color: var(--dim); padding: 2px 0 6px 18px; }
  .dim { color: var(--dim); }
  .small { font-size: 12px; }
  .table { padding: 0 16px 16px; max-height: 40vh; overflow: auto; border-top: 1px solid var(--line); }
  .table table { border-collapse: collapse; font-size: 12px; }
  .table td, .table th { padding: 2px 12px; text-align: right; }
  .table tr.ask td:nth-child(2) { color: var(--ask); }
  .table tr.bid td:nth-child(2) { color: var(--bid); }
  @media (max-width: 760px) {
    header { padding: 8px 16px; }
    main { flex-direction: column; overflow-y: auto; }
    .stage { flex: none; height: 78vh; }
    .split.side { display: none; }
    aside { width: auto; border-left: 0; border-top: 1px solid var(--line); overflow: visible; }
  }
</style>
