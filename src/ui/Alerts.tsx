import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Engine } from './engine';
import type { Venue } from '../shared/config';
import { STORAGE_KEY, inferDirection, loadAlerts, newId, parseAlerts, saveAlerts, type Alert, type AlertHit, type Direction } from '../alerts/alerts';
import { fmtPrice, priceDigits, permission, requestPermission, systemNotify, type Permission } from '../alerts/notify';
import { useLive } from './hooks';
import './Alerts.css';

interface Props { venue: Venue; label: string; symbol: string | null; mid: number; decimals?: number }
export interface AlertsHandle { attach(e: Engine): void }

const venueName = (v: Venue) => (v === 'kraken' ? 'Kraken' : 'Binance');
const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

const Alerts = forwardRef<AlertsHandle, Props>(function Alerts({ venue, label, symbol, mid, decimals }, ref) {
  const [list, setList, listRef] = useLive<Alert[]>(loadAlerts);
  const [levelText, setLevelText] = useState('');
  const [dir, setDir] = useState<'auto' | Direction>('auto');
  const [perm, setPerm] = useState<Permission>(permission);
  const [toasts, setToasts] = useState<{ key: string; text: string }[]>([]);
  const engine = useRef<Engine | null>(null);
  const toastTimers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const level = levelText.trim() === '' || !Number.isFinite(Number(levelText)) ? null : Number(levelText);
  const effectiveDir: Direction = dir === 'auto' ? inferDirection(level ?? NaN, mid) : dir;

  /** Save the list and hand the armed alerts to the feeds. */
  const commit = useCallback((next: Alert[]) => {
    setList(next);
    saveAlerts(next);
    engine.current?.setAlerts(next);
  }, [setList]);

  const dismiss = useCallback((key: string) => setToasts((ts) => ts.filter((t) => t.key !== key)), []);
  const toast = useCallback((text: string) => {
    const key = newId();
    setToasts((ts) => [...ts, { key, text }]);
    const t = setTimeout(() => { dismiss(key); toastTimers.current.delete(t); }, 10_000);
    toastTimers.current.add(t);
  }, [dismiss]);

  const fired = useCallback((hit: AlertHit) => {
    const a = listRef.current.find((x) => x.id === hit.id);
    if (!a || a.firedAt !== undefined) return;
    const next = listRef.current.map((x) => (x.id === hit.id ? { ...x, firedAt: hit.t, firedPrice: hit.price } : x));
    setList(next);
    saveAlerts(next);
    const text = `${a.label} on ${venueName(a.venue)} is ${a.dir} ${fmtPrice(a.price)}: mid price ${fmtPrice(hit.price)}`;
    systemNotify('Depthline price alert', text, a.id);
    toast(text);
  }, [listRef, setList, toast]);

  // called by the app each time it starts an engine
  useImperativeHandle(ref, () => ({
    attach(e: Engine) {
      engine.current = e;
      e.onAlert = fired;
      e.setAlerts(listRef.current);
    },
  }), [fired, listRef]);

  function add(): void {
    if (!symbol || level == null || !Number.isFinite(level) || level <= 0) return;
    commit([...listRef.current, { id: newId(), venue, symbol, label, price: level, dir: effectiveDir, created: Date.now() }]);
    setLevelText('');
  }
  const remove = (id: string) => commit(listRef.current.filter((a) => a.id !== id));
  const rearm = (id: string) => commit(listRef.current.map((a) => {
    if (a.id !== id) return a;
    const { firedAt: _f, firedPrice: _p, ...rest } = a;
    return rest;
  }));
  const clearFired = () => commit(listRef.current.filter((a) => a.firedAt === undefined));

  useEffect(() => {
    // keep tabs in step: another tab adding or firing alerts updates this list
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const next = parseAlerts(e.newValue);
      setList(next);
      engine.current?.setAlerts(next);
    };
    addEventListener('storage', onStorage);
    const timers = toastTimers.current;
    return () => { removeEventListener('storage', onStorage); for (const t of timers) clearTimeout(t); };
  }, [setList]);

  const sorted = list.slice().sort((a, b) => Number(a.firedAt !== undefined) - Number(b.firedAt !== undefined) || b.created - a.created);

  return (
    <div className="alerts scope">
      <section>
        <h2>Price alerts
          {list.some((a) => a.firedAt !== undefined) && <button className="link" onClick={clearFired}>clear fired</button>}
        </h2>
        <form className="add" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input className="mono" type="number" step="any" min="0" inputMode="decimal" value={levelText} onChange={(e) => setLevelText(e.currentTarget.value)}
            placeholder={Number.isFinite(mid) ? mid.toFixed(decimals ?? priceDigits(mid)) : 'price'}
            aria-label={`Alert price for ${label} on ${venueName(venue)}`} />
          <select value={dir} onChange={(e) => setDir(e.currentTarget.value as 'auto' | Direction)} aria-label="Direction">
            <option value="auto">{level != null && Number.isFinite(mid) ? (effectiveDir === 'above' ? 'auto (above)' : 'auto (below)') : 'auto'}</option>
            <option value="above">above</option>
            <option value="below">below</option>
          </select>
          <button type="submit" disabled={!symbol || level == null || !(level > 0)}>Add</button>
        </form>
        <p className="dim small">For {label} on {venueName(venue)}, checked against the mid price five times a second while the book is live.</p>
        {perm === 'default' ? <button className="link" onClick={async () => setPerm(await requestPermission())}>Enable desktop notifications</button>
          : perm === 'denied' ? <p className="dim small">Desktop notifications are blocked for this site, so alerts show here only.</p>
          : perm === 'unsupported' ? <p className="dim small">This browser has no desktop notifications, so alerts show here only.</p>
          : null}
        {sorted.length > 0 && (
          <ul className="list">
            {sorted.map((a) => (
              <li key={a.id} className={a.firedAt !== undefined ? 'fired' : undefined}>
                <span className={`arrow${a.dir === 'above' ? ' up' : ''}`} aria-label={a.dir}>{a.dir === 'above' ? '▲' : '▼'}</span>
                <span className="what"><span className="mono">{fmtPrice(a.price)}</span> <span className="dim">{a.label} · {venueName(a.venue)}</span>
                  {a.firedAt !== undefined && <><br /><span className="dim small">fired {time(a.firedAt)} at {fmtPrice(a.firedPrice ?? NaN)}</span></>}
                </span>
                {a.firedAt !== undefined && <button className="link" onClick={() => rearm(a.id)}>re-arm</button>}
                <button className="link" onClick={() => remove(a.id)} aria-label={`Remove alert ${a.label} ${a.dir} ${a.price}`}>✕</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.key} className="toast"><span>{t.text}</span><button className="link" onClick={() => dismiss(t.key)} aria-label="Dismiss">✕</button></div>
        ))}
      </div>
    </div>
  );
});

export default memo(Alerts);
