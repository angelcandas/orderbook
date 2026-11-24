<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { LiqCmd, LiqStats } from '../workers/liquidation.worker';

  let { spot, mode, theme, wsBase = undefined, restBase = undefined }:
    { spot: string; mode: 'live' | 'synthetic'; theme: 'dark' | 'light'; wsBase?: string; restBase?: string } = $props();

  let host: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let worker: Worker | null = null;
  let ro: ResizeObserver | null = null;
  let stats = $state<LiqStats | null>(null);

  const send = (m: LiqCmd, t: Transferable[] = []) => worker?.postMessage(m, t);

  onMount(() => {
    worker = new Worker(new URL('../workers/liquidation.worker.ts', import.meta.url), { type: 'module', name: 'liquidations' });
    worker.onmessage = (e) => { if (e.data.type === 'stats') stats = e.data; };
    const r = host.getBoundingClientRect();
    const off = canvas.transferControlToOffscreen();
    send({ type: 'init', canvas: off, w: r.width, h: r.height, dpr: devicePixelRatio, theme, spot, mode, ws: wsBase, rest: restBase }, [off]);
    ro = new ResizeObserver(() => {
      const b = host.getBoundingClientRect();
      send({ type: 'resize', w: b.width, h: b.height, dpr: devicePixelRatio });
    });
    ro.observe(host);
    (window as any).__liquidations = worker;
  });
  onDestroy(() => { ro?.disconnect(); send({ type: 'stop' }); worker = null; });

  $effect(() => { send({ type: 'symbol', spot }); });
  $effect(() => { send({ type: 'theme', theme }); });

  const ptr = (e: PointerEvent, inside = true) => {
    const r = host.getBoundingClientRect();
    send({ type: 'pointer', x: e.clientX - r.left, y: e.clientY - r.top, in: inside });
  };
  const px = (p: number | undefined) => (p === undefined ? '–' : p.toLocaleString(undefined, { maximumSignificantDigits: 6 }));
  const usd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : `$${v.toFixed(0)}`);
</script>

<section class="liq" aria-label="Liquidation heatmap">
  <div class="bar">
    <strong>Liquidation heatmap</strong>
    <span class="mono dim">{stats?.symbol ?? '…'} perp · Binance futures{#if stats && stats.mult > 1} (price per 1000){/if}</span>
    <span class="pill" class:ok={stats?.status.startsWith('live')} class:bad={stats?.status.startsWith('error')}>{stats?.status ?? 'connecting'}</span>
    <span class="spacer"></span>
    <span class="mono small">
      <span class="lg long">●</span> longs liquidated <span class="lg short">●</span> shorts liquidated
      · {stats?.liquidations ?? 0} in view ({usd(stats?.liquidatedNotional ?? 0)})
    </span>
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="plot" bind:this={host} onpointermove={(e) => ptr(e)} onpointerleave={(e) => ptr(e, false)}>
    <canvas bind:this={canvas}></canvas>
  </div>
  <p class="foot small dim" aria-live="polite">
    Largest estimated clusters: longs at <span class="mono">{px(stats?.long?.price)}</span> (~{stats?.long?.notional ?? '–'}),
    shorts at <span class="mono">{px(stats?.short?.price)}</span> (~{stats?.short?.notional ?? '–'}).
    Levels are a model from {stats?.oi === false ? 'trade volume (open interest unavailable)' : 'open interest changes'} and an assumed 10–100× leverage mix; dots are real liquidations.
    Kraken spot has no liquidations, so this always shows Binance futures.
    <span class="mono">{stats?.msgsPerSec ?? 0} msg/s · draw p50/p99 {stats?.draw.p50.toFixed(2) ?? '–'} / {stats?.draw.p99.toFixed(2) ?? '–'} ms</span>
  </p>
</section>

<style>
  .liq { border-top: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 6px 16px; }
  .plot { position: relative; height: 230px; margin: 0 16px; touch-action: none; }
  .plot canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .foot { margin: 4px 16px 8px; }
  .spacer { flex: 1; }
  .dim { color: var(--dim); }
  .small { font-size: 12px; }
  .lg.long { color: var(--ask); }
  .lg.short { color: var(--bid); }
  .pill { font-size: 11px; padding: 1px 8px; border-radius: 10px; background: var(--line); color: var(--warn); }
  .pill.ok { color: var(--bid); }
  .pill.bad { color: var(--ask); }
  @media (max-width: 760px) { .plot { height: 200px; } }
</style>
