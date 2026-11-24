<script lang="ts">
  import {
    KINDS, MAX_INDICATORS, MAX_SUB_PANES, PALETTE_SIZE, SPECS, defaultIndicators, indLabel, newIndicator,
    type IndConfig, type IndKind,
  } from '../indicators/spec';
  import { IND_DARK, IND_LIGHT } from '../render/theme';

  interface Props {
    list: IndConfig[];
    theme: 'dark' | 'light';
    onchange: (list: IndConfig[]) => void;
  }
  let { list, theme, onchange }: Props = $props();

  let palette = $derived(theme === 'light' ? IND_LIGHT : IND_DARK);
  let subs = $derived(list.filter((c) => c.on && SPECS[c.kind].pane === 'sub').length);
  let adding = $state('');
  const groups: { label: string; kinds: IndKind[] }[] = [
    { label: 'On the price', kinds: KINDS.filter((k) => SPECS[k].pane !== 'sub') },
    { label: 'Own pane below', kinds: KINDS.filter((k) => SPECS[k].pane === 'sub') },
  ];

  const set = (i: number, patch: Partial<IndConfig>) => onchange(list.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  function add() {
    const k = adding as IndKind;
    adding = '';
    if (!SPECS[k] || list.length >= MAX_INDICATORS) return;
    onchange([...list, newIndicator(k, list)]);
  }

  function param(i: number, k: number, e: Event) {
    const p = SPECS[list[i].kind].params[k];
    const x = Number((e.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(x)) return;
    const v = Math.max(p.min, Math.min(p.max, p.step && p.step < 1 ? x : Math.round(x)));
    const params = list[i].params.slice();
    params[k] = v;
    set(i, { params });
  }
</script>

<div class="ind">
  {#if list.length === 0}<p class="dim small">No indicators. Add one below.</p>{/if}
  <ul>
    {#each list as c, i (c.id)}
      {@const spec = SPECS[c.kind]}
      <li class:off={!c.on}>
        <div class="row">
          <input type="checkbox" checked={c.on} aria-label="Show {indLabel(c)}" onchange={(e) => set(i, { on: e.currentTarget.checked })} />
          <button class="swatch" style="background:{palette[c.color % palette.length]}" title="Change colour" aria-label="Change colour of {indLabel(c)}"
            onclick={() => set(i, { color: (c.color + 1) % PALETTE_SIZE })}></button>
          <span class="name" title={spec.help}>{spec.name}</span>
          <button class="x" title="Remove" aria-label="Remove {indLabel(c)}" onclick={() => onchange(list.filter((_, j) => j !== i))}>×</button>
        </div>
        {#if spec.params.length}
          <div class="params">
            {#each spec.params as p, k}
              <label>{p.label}
                <input type="number" min={p.min} max={p.max} step={p.step ?? 1} value={c.params[k]} onchange={(e) => param(i, k, e)} />
              </label>
            {/each}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
  <div class="add">
    <select bind:value={adding} onchange={add} disabled={list.length >= MAX_INDICATORS} aria-label="Add indicator">
      <option value="">Add indicator…</option>
      {#each groups as g}
        <optgroup label={g.label}>
          {#each g.kinds as k}<option value={k}>{SPECS[k].name}</option>{/each}
        </optgroup>
      {/each}
    </select>
    <button class="link" onclick={() => onchange(defaultIndicators())}>Reset</button>
  </div>
  {#if subs > MAX_SUB_PANES}<p class="dim small">Only the first {MAX_SUB_PANES} lower panes are drawn, so the candles keep room.</p>{/if}
</div>

<style>
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 4px 0; border-bottom: 1px solid var(--line); }
  li.off .name { color: var(--dim); }
  .row { display: flex; align-items: center; gap: 6px; }
  .name { flex: 1; font-size: 13px; cursor: help; }
  .swatch { width: 14px; height: 14px; padding: 0; border-radius: 3px; border: 1px solid var(--line); flex: none; }
  .x { border: 0; background: none; color: var(--dim); padding: 0 4px; font-size: 15px; line-height: 1; }
  .x:hover { color: var(--ask); }
  .params { display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 3px 0 2px 22px; }
  .params label { display: inline-flex; align-items: center; color: var(--dim); font-size: 11px; gap: 4px; }
  .params input { width: 58px; font: inherit; font-size: 12px; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; }
  .add { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
  .add select { flex: 1; min-width: 0; }
  .link { border: 0; background: none; color: var(--accent); padding: 0; font-size: 12px; }
  .dim { color: var(--dim); }
  .small { font-size: 12px; }
</style>
