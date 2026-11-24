<script lang="ts">
  import { searchPairs, type PairEntry, type Resolved } from '../shared/pairs';
  import type { Venue } from '../shared/config';

  interface Props {
    pair: string;
    entries: PairEntry[];
    quotes: string[];
    favourites: string[];
    venue: Venue;
    /** each venue's symbol for a pair, including USD stand ins (BTC/USD on Binance is BTCUSDT) */
    resolve: (venue: Venue, label: string) => Resolved | null;
    onpick: (label: string) => void;
    onfavourite: (label: string) => void;
    /** favourite chips next to the button (the app may show them elsewhere) */
    showFavs?: boolean;
  }
  let { pair, entries, quotes, favourites, venue, resolve, onpick, onfavourite, showFavs = true }: Props = $props();
  /** Open the search (keyboard shortcut). */
  export function show(): void { if (!open) toggle(); }
  const VENUES: [Venue, string, string][] = [['kraken', 'K', 'Kraken'], ['binance', 'B', 'Binance']];
  function where(v: Venue, label: string, name: string): { cls: string; title: string } {
    const r = resolve(v, label);
    if (!r) return { cls: '', title: `Not on ${name}` };
    if (r.standIn) return { cls: 'has alt', title: `${name}: ${r.base}/${r.quote} stands in` };
    return { cls: 'has', title: `Listed on ${name}` };
  }

  const MAX_ROWS = 200; // a few thousand pairs exist; type to narrow
  let open = $state(false);
  let query = $state('');
  let quote = $state<string | null>(null); // null = all, '★' = favourites
  let active = $state(0);
  let root: HTMLDivElement;
  let input = $state<HTMLInputElement>();
  let listEl = $state<HTMLUListElement>();

  const byLabel = $derived(new Map(entries.map((e) => [e.label, e])));
  const favEntries = $derived(favourites.map((f) => byLabel.get(f) ?? fallbackEntry(f)));
  function fallbackEntry(label: string): PairEntry {
    const [base, q] = label.split('/');
    return { label, base, quote: q, kraken: false, binance: false };
  }
  const matches = $derived.by(() => {
    if (quote === '★') return searchPairs(favEntries, query, null);
    return searchPairs(entries, query, quote);
  });
  const shown = $derived(matches.slice(0, MAX_ROWS));
  const isFav = (label: string) => favourites.includes(label);

  function toggle() {
    open = !open;
    if (open) {
      query = '';
      active = 0;
      queueMicrotask(() => input?.focus());
    }
  }
  function pick(label: string) {
    open = false;
    if (label !== pair) onpick(label);
  }
  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') { open = false; e.preventDefault(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = shown.length;
      if (!n) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      listEl?.children[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const p = shown[active];
      if (p) pick(p.label);
    }
  }
  function outside(e: PointerEvent) {
    if (open && root && !root.contains(e.target as Node)) open = false;
  }
  const chips = $derived(quotes.slice(0, 8));
</script>

<svelte:window onpointerdown={outside} />

<div class="picker" bind:this={root}>
  <button class="current" aria-haspopup="listbox" aria-expanded={open} onclick={toggle} title="Search pairs ( / )" aria-label="Pair {pair}. Search pairs">
    <span class="mono">{pair}</span><span class="caret" aria-hidden="true">▾</span>
  </button>
  <button class="star" class:on={isFav(pair)} title={isFav(pair) ? 'Remove from favourites' : 'Add to favourites'}
    aria-label={isFav(pair) ? `Remove ${pair} from favourites` : `Add ${pair} to favourites`} aria-pressed={isFav(pair)}
    onclick={() => onfavourite(pair)}>{isFav(pair) ? '★' : '☆'}</button>

  {#if showFavs && favourites.length}
    <div class="favs" role="group" aria-label="Favourite pairs">
      {#each favourites as f (f)}
        <button class="chip mono" class:on={f === pair} onclick={() => pick(f)}>{f}</button>
      {/each}
    </div>
  {/if}

  {#if open}
    <div class="pop" role="dialog" aria-label="Choose a currency pair">
      <input bind:this={input} bind:value={query} oninput={() => (active = 0)} onkeydown={key}
        placeholder="Search: eth, eth/eur, sol usdt" aria-label="Search pairs" autocomplete="off" spellcheck="false" />
      <div class="quotes" role="group" aria-label="Quote currency">
        <button class:on={quote === null} onclick={() => { quote = null; active = 0; }}>All</button>
        <button class:on={quote === '★'} onclick={() => { quote = '★'; active = 0; }} title="Favourites">★</button>
        {#each chips as q}
          <button class:on={quote === q} onclick={() => { quote = q; active = 0; }}>{q}</button>
        {/each}
      </div>
      <ul bind:this={listEl} role="listbox" aria-label="Pairs">
        {#each shown as p, i (p.label)}
          <li role="option" aria-selected={p.label === pair} class:active={i === active} class:cur={p.label === pair}>
            <button class="star sm" class:on={isFav(p.label)} aria-label={isFav(p.label) ? `Remove ${p.label} from favourites` : `Add ${p.label} to favourites`}
              onclick={() => onfavourite(p.label)}>{isFav(p.label) ? '★' : '☆'}</button>
            <button class="row" onclick={() => pick(p.label)} onpointerenter={() => (active = i)}>
              <span class="mono name">{p.label}</span>
              <span class="venues">
                {#each VENUES as [v, k, name]}
                  {@const w = where(v, p.label, name)}
                  <span class="v {w.cls}" class:here={venue === v} title={w.title} aria-label={w.title}>{k}</span>
                {/each}
              </span>
            </button>
          </li>
        {/each}
      </ul>
      <p class="foot">
        {#if quote === '★' && !favourites.length}Star a pair to keep it here and in the header.
        {:else if !matches.length}No pair matches.
        {:else if matches.length > MAX_ROWS}{matches.length.toLocaleString()} pairs, showing {MAX_ROWS}. Type to narrow.
        {:else}{matches.length.toLocaleString()} pair{matches.length === 1 ? '' : 's'}. K = Kraken, B = Binance, dashed = USD stand in.{/if}
      </p>
    </div>
  {/if}
</div>

<style>
  .picker { position: relative; display: inline-flex; align-items: center; gap: 6px; flex-wrap: nowrap; }
  button { font: inherit; color: var(--text); background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 4px 8px; cursor: pointer; }
  button:hover { border-color: var(--line-strong); }
  .current { display: inline-flex; gap: 8px; align-items: center; min-width: 112px; justify-content: space-between; height: 32px;
    font-size: 15px; font-weight: 650; letter-spacing: 0.01em; background: transparent; border-color: transparent; padding: 4px 8px; }
  .current:hover, .current[aria-expanded='true'] { background: var(--raised); border-color: var(--line); }
  .caret { color: var(--dim); font-size: 10px; }
  .star { color: var(--dim); padding: 4px 7px; line-height: 1; background: transparent; border-color: transparent; }
  .star.on { color: var(--warn); }
  .star.sm { border: 0; background: none; padding: 2px 6px; }
  .favs { display: inline-flex; gap: 4px; flex-wrap: wrap; }
  .chip { font-size: 12px; padding: 2px 8px; border-radius: 10px; }
  .chip.on { background: var(--accent); color: var(--bg); border-color: var(--accent); }
  .pop { position: absolute; top: calc(100% + 6px); left: 0; z-index: 30; width: min(360px, calc(100vw - 32px));
    background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 10px; box-shadow: var(--shadow-lg); }
  input { width: 100%; font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
  input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .quotes { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0 6px; }
  .quotes button { font-size: 12px; padding: 2px 8px; border-radius: 10px; }
  .quotes button.on { background: var(--accent); color: var(--bg); border-color: var(--accent); }
  ul { list-style: none; margin: 0; padding: 0; max-height: min(360px, 55vh); overflow-y: auto; }
  li { display: flex; align-items: center; border-radius: 6px; }
  li.active { background: var(--line); }
  li.cur .name { color: var(--accent); }
  .row { flex: 1; display: flex; align-items: center; border: 0; background: none; padding: 4px 6px 4px 0; text-align: left; }
  .name { flex: 1; }
  .venues { display: inline-flex; gap: 3px; }
  .v { font-size: 10px; width: 16px; text-align: center; border-radius: 3px; color: var(--dim); opacity: 0.35; }
  .v.has { opacity: 1; border: 1px solid var(--line); }
  .v.has.here { color: var(--bid); border-color: var(--bid); }
  .v.alt { border-style: dashed; }
  .foot { margin: 6px 2px 0; font-size: 11px; color: var(--dim); }
</style>
