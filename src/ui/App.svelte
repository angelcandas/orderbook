<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Engine, type Snapshot, type LadderRow } from './engine';
  import { PAIRS, INTERVALS, LIVE, localEndpoints, type Interval, type Venue } from '../shared/config';
  import type { SceneSettings } from '../render/scene';
  import type { PatternHit } from '../patterns/types';

  const q = new URLSearchParams(location.search);
  let source = $state<'live' | 'local'>(q.get('src') === 'local' ? 'local' : 'live');
  let host = q.get('host') ?? 'localhost:8787';
  let venue = $state<Venue>((q.get('venue') as Venue) ?? 'kraken');
  let pair = $state(Math.max(0, PAIRS.findIndex((p) => p.label === (q.get('pair') ?? 'BTC/USD'))));
  let group = $state(Number(q.get('group') ?? 1));
  let interval = $state<Interval>((Number(q.get('interval')) as Interval) || 15);
  let load = $state(Number(q.get('pairs') ?? 1));
  let theme = $state<'dark' | 'light'>(q.get('theme') === 'light' ? 'light' : 'dark');
  let showChart = $state(true);
  let showCandle = $state(true);
  let reducedMotion = $state(matchMedia('(prefers-reduced-motion: reduce)').matches);
  let showTable = $state(false);
  let selected = $state<string | null>(null);

  let stats = $state<Snapshot | null>(null);
  let table = $state<{ status: string; bids: LadderRow[]; asks: LadderRow[]; decimals: number } | null>(null);
  let engine: Engine | null = null;
  let canvasHost: HTMLDivElement;
  let generation = $state(0); // remounts the canvas: a canvas can only be transferred once
  let ro: ResizeObserver | null = null;
  let tableTimer: any;

  const settings = (): SceneSettings => ({
    depthRangePct: 0, candlesVisible: 160, reducedMotion,
    showChartPatterns: showChart, showCandlePatterns: showCandle, selectedPattern: selected,
    venueLabel: venue.toUpperCase(), pairLabel: PAIRS[pair].label,
  });

  function start() {
    engine?.destroy();
    const canvas = canvasHost.querySelector('canvas')!;
    engine = new Engine({
      canvas,
      endpoints: source === 'local' ? localEndpoints(host) : LIVE,
      pairCount: load,
      depth: { kraken: source === 'local' ? 1000 : 500, binance: 1000 },
      venue, pair, group, interval, settings: settings(), theme,
    });
    engine.onStats = (s) => (stats = s);
    engine.onSelected = (id) => (selected = id);
    (window as any).__depthline = engine;
  }

  function restart() {
    generation++;
    // wait for the keyed canvas to remount
    queueMicrotask(() => requestAnimationFrame(start));
  }

  function syncUrl() {
    const p = new URLSearchParams({ src: source, venue, pair: PAIRS[pair].label, group: String(group), interval: String(interval), pairs: String(load), theme });
    if (source === 'local') p.set('host', host);
    history.replaceState(null, '', `?${p}`);
  }

  onMount(() => {
    document.documentElement.dataset.theme = theme;
    start();
    ro = new ResizeObserver(() => {
      const r = canvasHost.getBoundingClientRect();
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
  let focusStatus = $derived(stats?.feeds[venue]?.status[PAIRS[pair][venue]] ?? 'connecting');
  const order = { forming: 0, confirmed: 1, failed: 2 } as const;
  let chartPatterns = $derived((stats?.patterns.list ?? []).filter((p: PatternHit) => p.family === 'chart').slice().sort((a, b) => order[a.status] - order[b.status] || b.end - a.end));
  let candlePats = $derived((stats?.patterns.list ?? []).filter((p: PatternHit) => p.family !== 'chart').slice(-12).reverse());

  function selectPattern(id: string) {
    selected = selected === id ? null : id;
    engine?.setSettings({ selectedPattern: selected });
  }
  const groups = [1, 10, 100, 1000];
</script>

<div class="shell">
  <header>
    <strong class="brand">Depthline</strong>
    <label>Source
      <select bind:value={source} onchange={() => { syncUrl(); restart(); }}>
        <option value="live">Live exchanges</option>
        <option value="local">Local emulator</option>
      </select>
    </label>
    <div class="seg" role="group" aria-label="Venue">
      {#each ['kraken', 'binance'] as v}
        <button class:on={venue === v} onclick={() => { venue = v as Venue; engine?.setVenue(venue); selected = null; syncUrl(); }}>{v === 'kraken' ? 'Kraken' : 'Binance'}</button>
      {/each}
    </div>
    <label>Pair
      <select bind:value={pair} onchange={() => { selected = null; if (pair >= load) restart(); else engine?.setPair(pair); syncUrl(); }}>
        {#each PAIRS as p, i}<option value={i}>{p.label}</option>{/each}
      </select>
    </label>
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
    </div>

    <aside>
      <section>
        <h2>Feed integrity <span class="pill" class:ok={focusStatus.startsWith('live')} class:bad={focusStatus.startsWith('error')}>{focusStatus}</span></h2>
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
        <p class="dim small">Detected in {fmt(stats?.patterns.computeMs, 1)} ms over {int(stats?.patterns.candles)} candles, in a worker.{#if stats?.patterns.backfill}{' '}{int(stats.patterns.backfill)} older bars were backfilled over REST{#if venue === 'kraken' && stats.patterns.source === 'binance'}{' '}from Binance, rescaled to Kraken's price, since Kraken serves only its latest 720{/if}.{/if}</p>
      </section>

      <section>
        <h2>Options</h2>
        <label class="tog"><input type="checkbox" bind:checked={reducedMotion} onchange={() => engine?.setSettings({ reducedMotion })} /> Reduce motion (no flashes)</label>
        <label class="tog"><input type="checkbox" bind:checked={showTable} /> Show text table</label>
        <button class="link" onclick={() => engine?.setSettings({ depthRangePct: 0 })}>Auto-fit depth chart</button>
        <p class="dim small">Scroll over the depth chart or candles to zoom. Click a pattern label to select it.</p>
      </section>
    </aside>
  </main>

  <section class="table" class:sr-only={!showTable} aria-label="Order book table">
    <h2>{venue} {PAIRS[pair].label} order book ({table?.status ?? '…'})</h2>
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
  .spacer { flex: 1; }
  main { flex: 1; display: flex; min-height: 0; }
  .stage { flex: 1; position: relative; min-width: 0; touch-action: none; }
  .stage :global(canvas) { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  aside { width: 310px; overflow-y: auto; border-left: 1px solid var(--line); padding: 4px 14px 16px; }
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
    aside { width: auto; border-left: 0; border-top: 1px solid var(--line); overflow: visible; }
  }
</style>
