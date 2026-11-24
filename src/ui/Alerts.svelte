<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Engine } from './engine';
  import type { Venue } from '../shared/config';
  import { STORAGE_KEY, inferDirection, loadAlerts, newId, parseAlerts, saveAlerts, type Alert, type AlertHit, type Direction } from '../alerts/alerts';
  import { fmtPrice, priceDigits, permission, requestPermission, systemNotify, type Permission } from '../alerts/notify';

  let { venue, label, symbol, mid, decimals }: { venue: Venue; label: string; symbol: string | null; mid: number; decimals?: number } = $props();

  let list = $state<Alert[]>(loadAlerts());
  let level = $state<number | null>(null);
  let dir = $state<'auto' | Direction>('auto');
  let perm = $state<Permission>(permission());
  let toasts = $state<{ key: string; text: string }[]>([]);
  let engine: Engine | null = null;
  const toastTimers = new Set<any>();

  /** Called by the app each time it starts an engine. */
  export function attach(e: Engine): void {
    engine = e;
    e.onAlert = fired;
    e.setAlerts($state.snapshot(list) as Alert[]);
  }

  function commit(): void {
    const plain = $state.snapshot(list) as Alert[];
    saveAlerts(plain);
    engine?.setAlerts(plain);
  }

  const venueName = (v: Venue) => (v === 'kraken' ? 'Kraken' : 'Binance');
  const effectiveDir = $derived<Direction>(dir === 'auto' ? inferDirection(level ?? NaN, mid) : dir);

  function add(): void {
    if (!symbol || level == null || !Number.isFinite(level) || level <= 0) return;
    list.push({ id: newId(), venue, symbol, label, price: level, dir: effectiveDir, created: Date.now() });
    level = null;
    commit();
  }

  function remove(id: string): void {
    list = list.filter((a) => a.id !== id);
    commit();
  }

  function rearm(a: Alert): void {
    delete a.firedAt;
    delete a.firedPrice;
    commit();
  }

  function clearFired(): void {
    list = list.filter((a) => a.firedAt === undefined);
    commit();
  }

  function fired(hit: AlertHit): void {
    const a = list.find((x) => x.id === hit.id);
    if (!a || a.firedAt !== undefined) return;
    a.firedAt = hit.t;
    a.firedPrice = hit.price;
    saveAlerts($state.snapshot(list) as Alert[]);
    const text = `${a.label} on ${venueName(a.venue)} is ${a.dir} ${fmtPrice(a.price)}: mid price ${fmtPrice(hit.price)}`;
    systemNotify('Depthline price alert', text, a.id);
    toast(text);
  }

  function toast(text: string): void {
    const key = newId();
    toasts.push({ key, text });
    const t = setTimeout(() => { dismiss(key); toastTimers.delete(t); }, 10_000);
    toastTimers.add(t);
  }
  const dismiss = (key: string) => { toasts = toasts.filter((t) => t.key !== key); };

  async function enableNotifications(): Promise<void> {
    perm = await requestPermission();
  }

  // keep tabs in step: another tab adding or firing alerts updates this list
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    list = parseAlerts(e.newValue);
    engine?.setAlerts($state.snapshot(list) as Alert[]);
  };
  onMount(() => addEventListener('storage', onStorage));
  onDestroy(() => { removeEventListener('storage', onStorage); for (const t of toastTimers) clearTimeout(t); });

  const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  let sorted = $derived(list.slice().sort((a, b) => Number(a.firedAt !== undefined) - Number(b.firedAt !== undefined) || b.created - a.created));
</script>

<section>
  <h2>Price alerts
    {#if list.some((a) => a.firedAt !== undefined)}<button class="link" onclick={clearFired}>clear fired</button>{/if}
  </h2>
  <form class="add" onsubmit={(e) => { e.preventDefault(); add(); }}>
    <input class="mono" type="number" step="any" min="0" inputmode="decimal" bind:value={level}
      placeholder={Number.isFinite(mid) ? mid.toFixed(decimals ?? priceDigits(mid)) : 'price'}
      aria-label={`Alert price for ${label} on ${venueName(venue)}`} />
    <select bind:value={dir} aria-label="Direction">
      <option value="auto">{level != null && Number.isFinite(mid) ? (effectiveDir === 'above' ? 'auto (above)' : 'auto (below)') : 'auto'}</option>
      <option value="above">above</option>
      <option value="below">below</option>
    </select>
    <button type="submit" disabled={!symbol || level == null || !(level > 0)}>Add</button>
  </form>
  <p class="dim small">For {label} on {venueName(venue)}, checked against the mid price five times a second while the book is live.</p>
  {#if perm === 'default'}
    <button class="link" onclick={enableNotifications}>Enable desktop notifications</button>
  {:else if perm === 'denied'}
    <p class="dim small">Desktop notifications are blocked for this site, so alerts show here only.</p>
  {:else if perm === 'unsupported'}
    <p class="dim small">This browser has no desktop notifications, so alerts show here only.</p>
  {/if}
  {#if sorted.length}
    <ul class="alerts">
      {#each sorted as a (a.id)}
        <li class:fired={a.firedAt !== undefined}>
          <span class="arrow" class:up={a.dir === 'above'} aria-label={a.dir}>{a.dir === 'above' ? '▲' : '▼'}</span>
          <span class="what"><span class="mono">{fmtPrice(a.price)}</span> <span class="dim">{a.label} · {venueName(a.venue)}</span>
            {#if a.firedAt !== undefined}<br /><span class="dim small">fired {time(a.firedAt)} at {fmtPrice(a.firedPrice ?? NaN)}</span>
{/if}
          </span>
          {#if a.firedAt !== undefined}<button class="link" onclick={() => rearm(a)}>re-arm</button>{/if}
          <button class="link" onclick={() => remove(a.id)} aria-label={`Remove alert ${a.label} ${a.dir} ${a.price}`}>✕</button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<div class="toasts" role="status" aria-live="polite">
  {#each toasts as t (t.key)}
    <div class="toast"><span>{t.text}</span><button class="link" onclick={() => dismiss(t.key)} aria-label="Dismiss">✕</button></div>
  {/each}
</div>

<style>
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); margin: 14px 0 6px; display: flex; align-items: center; gap: 8px; }
  .add { display: flex; gap: 6px; }
  .add input { flex: 1; min-width: 0; font-size: 12px; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
  select, button { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  .link { border: 0; background: none; color: var(--accent); padding: 0; font-size: 12px; text-transform: none; letter-spacing: 0; }
  .dim { color: var(--dim); }
  .small { font-size: 12px; }
  p { margin: 4px 0; }
  .alerts { list-style: none; margin: 6px 0 0; padding: 0; font-size: 12px; }
  .alerts li { display: flex; align-items: flex-start; gap: 8px; padding: 3px 2px; }
  .alerts li.fired { opacity: 0.65; }
  .what { flex: 1; }
  .arrow { color: var(--ask); width: 10px; }
  .arrow.up { color: var(--bid); }
  .toasts { position: fixed; right: 16px; bottom: 16px; display: flex; flex-direction: column; gap: 8px; z-index: 10; max-width: min(360px, calc(100vw - 32px)); }
  .toast { display: flex; gap: 10px; align-items: flex-start; background: var(--panel); border: 1px solid var(--accent); border-radius: 8px; padding: 10px 12px; box-shadow: 0 4px 16px rgb(0 0 0 / 0.3); font-size: 13px; }
  .toast span { flex: 1; }
</style>
