import { memo, useEffect, useRef } from 'react';
import {
  KINDS, MAX_INDICATORS, MAX_SUB_PANES, PALETTE_SIZE, SPECS, defaultIndicators, indLabel, newIndicator,
  type IndConfig, type IndKind,
} from '../indicators/spec';
import { IND_DARK, IND_LIGHT } from '../render/theme';
import './Indicators.css';

interface Props {
  list: IndConfig[];
  theme: 'dark' | 'light';
  onchange: (list: IndConfig[]) => void;
}

const groups: { label: string; kinds: IndKind[] }[] = [
  { label: 'On the price', kinds: KINDS.filter((k) => SPECS[k].pane !== 'sub') },
  { label: 'Own pane below', kinds: KINDS.filter((k) => SPECS[k].pane === 'sub') },
];

/**
 * A number input that applies its value on the native change event (enter,
 * blur or the spinner), not on every keystroke, so a half typed value is never
 * clamped under the cursor.
 */
function NumberField({ value, onCommit, ...rest }: { value: number; min: number; max: number; step: number; onCommit: (v: string) => void }) {
  const el = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    const input = el.current!;
    const f = () => commit.current(input.value);
    input.addEventListener('change', f);
    return () => input.removeEventListener('change', f);
  }, []);
  useEffect(() => { const input = el.current!; if (input.value !== String(value)) input.value = String(value); }, [value]);
  return <input ref={el} type="number" defaultValue={value} {...rest} />;
}

function Indicators({ list, theme, onchange }: Props) {
  const palette = theme === 'light' ? IND_LIGHT : IND_DARK;
  const subs = list.filter((c) => c.on && SPECS[c.kind].pane === 'sub').length;

  const set = (i: number, patch: Partial<IndConfig>) => onchange(list.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  function add(k: IndKind) {
    if (!SPECS[k] || list.length >= MAX_INDICATORS) return;
    onchange([...list, newIndicator(k, list)]);
  }

  function param(i: number, k: number, value: string) {
    const p = SPECS[list[i].kind].params[k];
    const x = Number(value);
    if (!Number.isFinite(x)) return;
    const v = Math.max(p.min, Math.min(p.max, p.step && p.step < 1 ? x : Math.round(x)));
    const params = list[i].params.slice();
    params[k] = v;
    set(i, { params });
  }

  return (
    <div className="ind scope">
      {list.length === 0 && <p className="dim small">No indicators. Add one below.</p>}
      <ul>
        {list.map((c, i) => {
          const spec = SPECS[c.kind];
          return (
            <li key={c.id} className={c.on ? undefined : 'off'}>
              <div className="row">
                <input type="checkbox" checked={c.on} aria-label={`Show ${indLabel(c)}`} onChange={(e) => set(i, { on: e.currentTarget.checked })} />
                <button className="swatch" style={{ background: palette[c.color % palette.length] }} title="Change colour" aria-label={`Change colour of ${indLabel(c)}`}
                  onClick={() => set(i, { color: (c.color + 1) % PALETTE_SIZE })}></button>
                <span className="name" title={spec.help}>{spec.name}</span>
                <button className="x" title="Remove" aria-label={`Remove ${indLabel(c)}`} onClick={() => onchange(list.filter((_, j) => j !== i))}>×</button>
              </div>
              {spec.params.length > 0 && (
                <div className="params">
                  {spec.params.map((p, k) => (
                    <label key={k}>{p.label}
                      <NumberField min={p.min} max={p.max} step={p.step ?? 1} value={c.params[k]} onCommit={(v) => param(i, k, v)} />
                    </label>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="add">
        <select value="" onChange={(e) => add(e.currentTarget.value as IndKind)} disabled={list.length >= MAX_INDICATORS} aria-label="Add indicator">
          <option value="">Add indicator…</option>
          {groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.kinds.map((k) => <option key={k} value={k}>{SPECS[k].name}</option>)}
            </optgroup>
          ))}
        </select>
        <button className="link" onClick={() => onchange(defaultIndicators())}>Reset</button>
      </div>
      {subs > MAX_SUB_PANES && <p className="dim small">Only the first {MAX_SUB_PANES} lower panes are drawn, so the candles keep room.</p>}
    </div>
  );
}

export default memo(Indicators);
