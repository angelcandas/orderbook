import { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { searchPairs, type PairEntry, type Resolved } from '../shared/pairs';
import type { Venue } from '../shared/config';
import './PairPicker.css';

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
export interface PairPickerHandle { show(): void }

const VENUES: [Venue, string, string][] = [['kraken', 'K', 'Kraken'], ['binance', 'B', 'Binance']];
const MAX_ROWS = 200; // a few thousand pairs exist; type to narrow

function fallbackEntry(label: string): PairEntry {
  const [base, q] = label.split('/');
  return { label, base, quote: q, kraken: false, binance: false };
}

const PairPicker = forwardRef<PairPickerHandle, Props>(function PairPicker(
  { pair, entries, quotes, favourites, venue, resolve, onpick, onfavourite, showFavs = true }, ref,
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [quote, setQuote] = useState<string | null>(null); // null = all, '★' = favourites
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listEl = useRef<HTMLUListElement>(null);

  function where(v: Venue, label: string, name: string): { cls: string; title: string } {
    const r = resolve(v, label);
    if (!r) return { cls: '', title: `Not on ${name}` };
    if (r.standIn) return { cls: 'has alt', title: `${name}: ${r.base}/${r.quote} stands in` };
    return { cls: 'has', title: `Listed on ${name}` };
  }

  const byLabel = useMemo(() => new Map(entries.map((e) => [e.label, e])), [entries]);
  const matches = useMemo(() => {
    if (quote === '★') return searchPairs(favourites.map((f) => byLabel.get(f) ?? fallbackEntry(f)), query, null);
    return searchPairs(entries, query, quote);
  }, [quote, favourites, byLabel, entries, query]);
  const shown = matches.slice(0, MAX_ROWS);
  const isFav = (label: string) => favourites.includes(label);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) { setQuery(''); setActive(0); }
  }
  // focus the search once it is on screen
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useImperativeHandle(ref, () => ({ show() { if (!open) toggle(); } }));

  function pick(label: string) {
    setOpen(false);
    if (label !== pair) onpick(label);
  }
  function key(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { setOpen(false); e.preventDefault(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = shown.length;
      if (!n) return;
      const a = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      setActive(a);
      listEl.current?.children[a]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const p = shown[active];
      if (p) pick(p.label);
    }
  }
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [open]);
  const chips = quotes.slice(0, 8);

  return (
    <div className="picker scope" ref={root}>
      <button className="current" aria-haspopup="listbox" aria-expanded={open} onClick={toggle} title="Search pairs ( / )" aria-label={`Pair ${pair}. Search pairs`}>
        <span className="mono">{pair}</span><span className="caret" aria-hidden="true">▾</span>
      </button>
      <button className={`star${isFav(pair) ? ' on' : ''}`} title={isFav(pair) ? 'Remove from favourites' : 'Add to favourites'}
        aria-label={isFav(pair) ? `Remove ${pair} from favourites` : `Add ${pair} to favourites`} aria-pressed={isFav(pair)}
        onClick={() => onfavourite(pair)}>{isFav(pair) ? '★' : '☆'}</button>

      {showFavs && favourites.length > 0 && (
        <div className="favs" role="group" aria-label="Favourite pairs">
          {favourites.map((f) => <button key={f} className={`chip mono${f === pair ? ' on' : ''}`} onClick={() => pick(f)}>{f}</button>)}
        </div>
      )}

      {open && (
        <div className="pop" role="dialog" aria-label="Choose a currency pair">
          <input ref={input} value={query} onChange={(e) => { setQuery(e.currentTarget.value); setActive(0); }} onKeyDown={key}
            placeholder="Search: eth, eth/eur, sol usdt" aria-label="Search pairs" autoComplete="off" spellCheck={false} />
          <div className="quotes" role="group" aria-label="Quote currency">
            <button className={quote === null ? 'on' : undefined} onClick={() => { setQuote(null); setActive(0); }}>All</button>
            <button className={quote === '★' ? 'on' : undefined} onClick={() => { setQuote('★'); setActive(0); }} title="Favourites">★</button>
            {chips.map((q) => <button key={q} className={quote === q ? 'on' : undefined} onClick={() => { setQuote(q); setActive(0); }}>{q}</button>)}
          </div>
          <ul ref={listEl} role="listbox" aria-label="Pairs">
            {shown.map((p, i) => (
              <li key={p.label} role="option" aria-selected={p.label === pair} className={[i === active && 'active', p.label === pair && 'cur'].filter(Boolean).join(' ') || undefined}>
                <button className={`star sm${isFav(p.label) ? ' on' : ''}`} aria-label={isFav(p.label) ? `Remove ${p.label} from favourites` : `Add ${p.label} to favourites`}
                  onClick={() => onfavourite(p.label)}>{isFav(p.label) ? '★' : '☆'}</button>
                <button className="row" onClick={() => pick(p.label)} onPointerEnter={() => setActive(i)}>
                  <span className="mono name">{p.label}</span>
                  <span className="venues">
                    {VENUES.map(([v, k, name]) => {
                      const w = where(v, p.label, name);
                      return <span key={v} className={`v ${w.cls}${venue === v ? ' here' : ''}`} title={w.title} aria-label={w.title}>{k}</span>;
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="foot">
            {quote === '★' && !favourites.length ? 'Star a pair to keep it here and in the header.'
              : !matches.length ? 'No pair matches.'
              : matches.length > MAX_ROWS ? `${matches.length.toLocaleString()} pairs, showing ${MAX_ROWS}. Type to narrow.`
              : `${matches.length.toLocaleString()} pair${matches.length === 1 ? '' : 's'}. K = Kraken, B = Binance, dashed = USD stand in.`}
          </p>
        </div>
      )}
    </div>
  );
});

export default memo(PairPicker);
