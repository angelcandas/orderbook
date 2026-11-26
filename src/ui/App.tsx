import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from 'react';
import { Engine, type Snapshot } from './engine';
import { focusStatusOf, gameBadgeStore, ladderStore, statsStore, useLadder, useStats } from './live';
import { INTERVALS, LIVE, intervalLabel, isInterval, localEndpoints, type Interval, type Venue } from '../shared/config';
import Indicators from './Indicators';
import { MAX_SUB_PANES, SPECS, type IndConfig } from '../indicators/spec';
import {
  allPairs, builtinCatalog, loadCachedCatalog, loadFavourites, MarketIndex, quoteRanking,
  saveCachedCatalog, saveFavourites, splitLabel, toggleFavourite, type Catalog,
} from '../shared/pairs';
import PairPicker, { type PairPickerHandle } from './PairPicker';
import type { SceneSettings } from '../render/scene';
import type { PatternHit } from '../patterns/types';
import type { AnalysisWindow } from '../patterns/window';
import { explain, explanationText, type Explanation } from '../patterns/explain';
import Alerts, { type AlertsHandle } from './Alerts';
import Game from './Game';
import { midOf } from '../alerts/alerts';
import type { Resolved } from '../shared/pairs';
import { HEADER_CTRL_W, CANDLE_AXIS_W, CANDLE_TIME_H, CANDLE_TOOLS_W, PANE_HEADER, DEPTH_AXIS_H, candleGeom } from '../render/scene';
import { computeLayout, dragSplit, DEFAULT_LAYOUT, ZOOM, type LayoutPrefs, type Rect } from '../render/layout';
import type { ZoomPane } from '../workers/protocol';
import {
  loadPrefs, savePrefs, defaultPrefs, loadChartPrefs, saveChartPrefs, SIDE_W, type ViewPrefs,
  loadUiPrefs, saveUiPrefs, PINNED_INTERVALS, GROUPS, groupLabel, type ThemeMode, type SideTab, type UiPrefs, type ChartPrefs,
} from './prefs';
import Icon from './Icon';
import { useToasts, toast, dismissToast } from './toast';
import { useLatest, useLive } from './hooks';
import './App.css';

/** class names from a list of names and conditions */
const cx = (...xs: (string | false | null | undefined | 0)[]) => xs.filter(Boolean).join(' ') || undefined;

type ZoomFields = Pick<ViewPrefs, 'candlesVisible' | 'depthRangePct' | 'ladderRowPad' | 'candlesPriceScale'>;

const venueName = (v: Venue) => (v === 'kraken' ? 'Kraken' : 'Binance');
const fmt = (x: number | undefined, d = 1) => (x === undefined || !isFinite(x) ? '–' : x.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
const usd = (v: number) => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : `$${v.toFixed(0)}`);
const px = (p: number) => p.toLocaleString(undefined, { maximumSignificantDigits: 6 });
const int = (x: number | undefined) => (x === undefined ? '–' : Math.round(x).toLocaleString());
const compact = (v: number) => (!Number.isFinite(v) ? '–' : v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(2));
const signed = (v: number, d: number) => (!Number.isFinite(v) ? '–' : `${v >= 0 ? '+' : ''}${fmt(v, d)}`);

const PANES: ZoomPane[] = ['ladder', 'depth', 'candles'];
const paneNames: Record<ZoomPane, string> = { ladder: 'order book', depth: 'depth chart', candles: 'candle chart' };
const zoomTips: Record<ZoomPane, [string, string]> = {
  ladder: ['Shorter rows, more price levels', 'Taller rows, fewer price levels'],
  depth: ['Wider price range', 'Narrower price range'],
  candles: ['More candles', 'Fewer candles'],
};
const TABS: [SideTab, string, string][] = [['signals', 'Patterns', 'shapes'], ['alerts', 'Alerts', 'bell'], ['liq', 'Liquidations', 'flame'], ['ind', 'Indicators', 'layers'], ['game', 'Game', 'trophy'], ['health', 'Health', 'pulse']];
const SHORTCUTS: [string[], string][] = [
  [['/', 'Ctrl K'], 'Search pairs'], [['1', '–', '6'], 'Candle size 1m, 5m, 15m, 1h, 4h, 1D'], [[',', '.'], 'Smaller / larger candle size'],
  [['V'], 'Switch venue'], [['F'], 'Fit every panel, back to live'], [['W'], 'Draw a pattern window'], [['E'], 'Explain the patterns'],
  [['I'], 'Indicators'], [['P'], 'Chart patterns on / off'], [['L'], 'Liquidation levels on / off'], [['B'], 'Side panel'],
  [['T'], 'Theme: system, dark, light'], [['?'], 'This list'], [['Esc'], 'Close'],
];
const statusOrder = { forming: 0, confirmed: 1, failed: 2 } as const;

/** What the page starts from: URL parameters win over what this browser remembers. */
function readInitial() {
  const q = new URLSearchParams(location.search);
  const chart = loadChartPrefs();
  const ui = loadUiPrefs();
  const view = loadPrefs();
  const qInterval = Number(q.get('interval'));
  const qTheme = q.get('theme');
  return {
    source: (q.get('src') === 'local' ? 'local' : 'live') as 'live' | 'local',
    host: q.get('host') ?? 'localhost:8787',
    venue: ((q.get('venue') as Venue) ?? 'kraken') as Venue,
    pair: splitLabel(q.get('pair') ?? '') ? q.get('pair')!.toUpperCase() : 'BTC/USD',
    group: Number(q.get('group') ?? 1),
    interval: (isInterval(qInterval) ? qInterval : chart.interval) as Interval,
    load: Number(q.get('pairs') ?? 1),
    themeMode: (qTheme === 'light' || qTheme === 'dark' ? qTheme : ui.themeMode) as ThemeMode,
    showLiq: q.has('liq') ? q.get('liq') !== '0' : chart.showLiquidations,
    chart, ui, view,
  };
}

// what each venue lists: the built in pairs, then the cache, then the venues' own lists as they arrive
const initialCatalog = (source: 'live' | 'local'): Catalog => ({ ...builtinCatalog(), ...(source === 'live' ? loadCachedCatalog() : {}) });

/** Short status messages; only this list re-renders when one comes or goes. */
function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}><span>{t.text}</span><button className="link" aria-label="Dismiss" onClick={() => dismissToast(t.id)}><Icon name="close" size={14} /></button></div>
      ))}
    </div>
  );
}

// ---- live readouts: each reads the engine's stats or book itself, so the shell does not re-render ----

const tickerPriceOf = (table: ReturnType<typeof ladderStore.get>, stats: Snapshot | null) =>
  table && Number.isFinite(table.bestBid) && Number.isFinite(table.bestAsk) ? midOf(table.bestBid, table.bestAsk) : stats?.patterns.last ?? NaN;

/** Live mid coloured by its last move, 24 h figures from the candles, spread; the tab title carries the price, like an exchange's. */
const Ticker = memo(function Ticker({ res, pair }: { res: Resolved | null; pair: string }) {
  const table = useLadder();
  const stats = useStats();
  const tickerPrice = tickerPriceOf(table, stats);
  const priceDec = Math.max(0, Math.min(8, (table?.decimals ?? 2) + 1));
  const prevTick = useRef(NaN);
  const [tickDir, setTickDir] = useState(0);
  useEffect(() => {
    const m = tickerPrice, p = prevTick.current;
    if (Number.isFinite(m) && Number.isFinite(p) && m !== p) setTickDir(m > p ? 1 : -1);
    prevTick.current = m;
  }, [tickerPrice]);
  const pairText = res ? `${res.base}/${res.quote}` : pair;
  useEffect(() => {
    const tt = Number.isFinite(tickerPrice) ? `${fmt(tickerPrice, priceDec)} ${pairText} · Depthline` : `${pairText} · Depthline`;
    if (document.title !== tt) document.title = tt;
  }, [tickerPrice, priceDec, pairText]);
  const day = stats?.patterns.day ?? null;
  const dayChg = day && Number.isFinite(tickerPrice) ? tickerPrice - day.ref : NaN;
  const dayPct = day && day.ref ? (dayChg / day.ref) * 100 : NaN;
  const spreadBps = table && tickerPrice ? ((table.bestAsk - table.bestBid) / tickerPrice) * 1e4 : NaN;
  return (
    <dl className="ticker mono" aria-label="Market summary">
      <div className="last">
        <dt className="sr-only">Mid price</dt>
        <dd className={cx('price', tickDir > 0 && 'up', tickDir < 0 && 'down')}>{Number.isFinite(tickerPrice) ? fmt(tickerPrice, priceDec) : '–'}</dd>
      </div>
      <div><dt>{day && day.hours < 23.5 ? `${Math.round(day.hours)}h` : '24h'} change</dt>
        <dd className={cx(dayChg > 0 && 'up', dayChg < 0 && 'down')}>{signed(dayChg, priceDec - 1)} <span>{signed(dayPct, 2)}%</span></dd></div>
      <div className="opt"><dt>24h high</dt><dd>{day ? fmt(Math.max(day.hi, tickerPrice || -Infinity), priceDec - 1) : '–'}</dd></div>
      <div className="opt"><dt>24h low</dt><dd>{day ? fmt(Math.min(day.lo, tickerPrice || Infinity), priceDec - 1) : '–'}</dd></div>
      <div className="opt"><dt>24h vol ({res?.base ?? ''})</dt><dd>{day ? compact(day.vol) : '–'}</dd></div>
      <div className="opt2"><dt>Spread</dt><dd>{Number.isFinite(spreadBps) ? `${fmt(spreadBps, 2)} bp` : '–'}</dd></div>
    </dl>
  );
});

/** Feed status (dot, venue, state) and the frame rate / latency chip; both open Health. */
const StatusChips = memo(function StatusChips({ venue, res, onHealth }: { venue: Venue; res: Resolved | null; onHealth: () => void }) {
  const stats = useStats();
  const focusStatus = focusStatusOf(stats, venue, res);
  const live = focusStatus.startsWith('live');
  const fps = stats?.render?.frameInterval.p50 ? 1000 / stats.render.frameInterval.p50 : NaN;
  return (
    <>
      <button className={cx('chip status', live && 'ok', (focusStatus.startsWith('error') || focusStatus === 'not listed') && 'bad')}
        title="Feed health: checksums, gaps and resyncs" onClick={onHealth}>
        <span className="dot" aria-hidden="true"></span><span className="stxt">{venueName(venue)} · {focusStatus}</span>
      </button>
      <button className={cx('chip perf mono', fps < 50 && 'warnc')} title="Frame rate and receive-to-draw latency (p50). Click for the full numbers." onClick={onHealth}>
        {Number.isFinite(fps) ? Math.round(fps) : '–'} fps · {fmt(stats?.render?.latency.p50)} ms
      </button>
    </>
  );
});

/** Book grouping; the labels follow the focused market's tick. */
const GroupSelect = memo(function GroupSelect({ group, onChange }: { group: number; onChange: (g: number) => void }) {
  const tick = useLadder()?.tick;
  return (
    <label className="inline" title="Price step the book is grouped by">Group
      <select value={group} onChange={(e) => onChange(Number(e.currentTarget.value))}>
        {GROUPS.map((g) => <option key={g} value={g}>{groupLabel(g, tick)}</option>)}
      </select>
    </label>
  );
});

/** Over the canvas until the focused book is live: connecting, syncing, an error, or not listed here. */
const FeedOverlay = memo(function FeedOverlay({ venue, res, pair, other, onSwitch }: { venue: Venue; res: Resolved | null; pair: string; other: Venue | null; onSwitch: (v: Venue) => void }) {
  const focusStatus = focusStatusOf(useStats(), venue, res);
  if (focusStatus.startsWith('live')) return null;
  const pairText = res ? `${res.base}/${res.quote}` : pair;
  return (
    <div className="overlay" role="status" aria-live="polite">
      {focusStatus === 'not listed' ? (
        <>
          <span>{venueName(venue)} doesn't list {pair}.</span>
          {other && <button className="primary" onClick={() => onSwitch(other)}>Show {venueName(other)}</button>}
        </>
      ) : focusStatus.startsWith('error') ? (
        <><span className="dotc bad" aria-hidden="true"></span><span>{venueName(venue)} feed error, retrying…</span></>
      ) : (
        <><span className="spin" aria-hidden="true"></span><span>{focusStatus === 'syncing' ? 'Syncing' : focusStatus === 'resyncing' ? 'Resyncing' : 'Connecting to'} {venueName(venue)} {pairText}…</span></>
      )}
    </div>
  );
});

const chartPatternsOf = (stats: Snapshot | null) =>
  (stats?.patterns.list ?? []).filter((p: PatternHit) => p.family === 'chart').slice().sort((a, b) => b.end - a.end || statusOrder[a.status] - statusOrder[b.status]);

function totalsOf(stats: Snapshot | null) {
  if (!stats) return null;
  const fs = Object.values(stats.feeds);
  const sum = (f: (s: any) => number) => fs.reduce((a, s) => a + f(s), 0);
  return {
    msgs: sum((s) => s.msgsPerSec), levels: sum((s) => s.levelsPerSec),
    checksum: sum((s) => s.counters.checksumFails), gaps: sum((s) => s.counters.gaps),
    resyncs: sum((s) => s.counters.resyncs), reconnects: sum((s) => s.counters.reconnects), crossed: sum((s) => s.counters.crossed),
    books: sum((s) => s.books),
  };
}

/** Pattern count on the Patterns tab, the game clock on Game, a warning mark on Health when the feeds saw integrity problems. */
function TabBadge({ id }: { id: SideTab }) {
  if (id === 'game') return <GameBadge />;
  return <StatsBadge id={id} />;
}
function GameBadge() {
  const left = gameBadgeStore.use();
  return left ? <span className="badge">{left}</span> : null;
}
function StatsBadge({ id }: { id: SideTab }) {
  const stats = useStats();
  if (id === 'signals') {
    const n = chartPatternsOf(stats).filter((p) => p.status !== 'failed').length;
    return n > 0 ? <span className="badge">{n}</span> : null;
  }
  if (id === 'health') {
    const t = totalsOf(stats);
    return t?.checksum || t?.gaps || t?.crossed ? <span className="badge bad">!</span> : null;
  }
  return null;
}

/** The alerts panel, fed the live mid. */
function AlertsLive({ alertsRef, ...p }: { alertsRef: Ref<AlertsHandle>; venue: Venue; label: string; symbol: string | null }) {
  const table = useLadder();
  return <Alerts ref={alertsRef} {...p} mid={table ? midOf(table.bestBid, table.bestAsk) : NaN} decimals={table?.decimals} />;
}

interface SignalsProps {
  venue: Venue; win: AnalysisWindow | null; selected: string | null; showChart: boolean; showCandle: boolean;
  onShowChart: (v: boolean) => void; onShowCandle: (v: boolean) => void; onClearWindow: () => void; onExplain: () => void; onSelect: (id: string) => void;
}
function SignalsPanel({ venue, win, selected, showChart, showCandle, onShowChart, onShowCandle, onClearWindow, onExplain, onSelect }: SignalsProps) {
  const stats = useStats();
  const chartPatterns = useMemo(() => chartPatternsOf(stats), [stats]);
  const candlePats = useMemo(() => (stats?.patterns.list ?? []).filter((p: PatternHit) => p.family !== 'chart').slice(-12).reverse(), [stats]);
  return (
    <>
      <section>
        <h2>Chart patterns
          <label className="tog"><input type="checkbox" checked={showChart} onChange={(e) => onShowChart(e.currentTarget.checked)} /> show</label>
        </h2>
        {win ? <p className="dim small">Searching only inside the box drawn on the chart. <button className="link" onClick={onClearWindow}>Clear window</button></p>
          : <p className="dim small">Drag a box on the candles with <b>window</b> (<kbd>W</kbd>, or shift+drag) to analyse just that part.</p>}
        <button className="explain" onClick={onExplain}>Explain these patterns <kbd>E</kbd></button>
        {chartPatterns.length === 0 && <p className="empty">{win ? 'No chart patterns inside the window.' : 'None in view yet. Patterns need closed candles; try 1m or 5m.'}</p>}
        <ul className="pats">
          {chartPatterns.map((p) => (
            <li key={p.id} className={cx(selected === p.id && 'sel')}>
              <button onClick={() => onSelect(p.id)} aria-expanded={selected === p.id}>
                <span className={cx('dot', p.bias > 0 && 'bull', p.bias < 0 && 'bear')}></span>
                <span className="name">{p.label}</span>
                <span className={`st ${p.status}`}>{p.status}</span>
              </button>
              {selected === p.id && (
                <div className="detail mono">
                  {p.breakout && <>breakout {fmt(p.breakout.p, 2)}<br /></>}
                  {p.target !== undefined && <>target {fmt(p.target, 2)}<br /></>}
                  {p.stop !== undefined && <>stop {fmt(p.stop, 2)}<br /></>}
                  fit {fmt(p.score * 100, 0)}%{p.note && <><br />{p.note}</>}
                </div>
              )}
            </li>
          ))}
        </ul>
        {!!stats?.patterns.outcomes.length && (
          <p className="dim small">In this history, confirmed patterns reached target / hit stop first:
            {stats.patterns.outcomes.map((o, i) => <Fragment key={i}><br /><span className="mono">{o.kind}: {o.hit} / {o.stopped}{o.open ? ` (${o.open} open)` : ''}</span></Fragment>)}
          </p>
        )}
      </section>
      <section>
        <h2>Candle signals
          <label className="tog"><input type="checkbox" checked={showCandle} onChange={(e) => onShowCandle(e.currentTarget.checked)} /> show</label>
        </h2>
        {candlePats.length === 0 && <p className="empty">No candle signals yet.</p>}
        <ul className="pats">
          {candlePats.map((p) => (
            <li key={p.id} className={cx(selected === p.id && 'sel')}><button onClick={() => onSelect(p.id)} aria-pressed={selected === p.id}>
              <span className={cx('dot', p.bias > 0 && 'bull', p.bias < 0 && 'bear')}></span>
              <span className="name">{p.label}</span>
            </button></li>
          ))}
        </ul>
        <p className="dim small">Detected in {fmt(stats?.patterns.computeMs, 1)} ms over {int(stats?.patterns.candles)} candles, in a worker.{!!stats?.patterns.backfill && <>
          {' '}{int(stats.patterns.backfill)} older bars were backfilled over REST{venue === 'kraken' && <>{' '}({stats.patterns.source === 'kraken' ? "Kraken's own" : stats.patterns.source === 'kraken+binance' ? "Kraken's latest 720, older from Binance rescaled to Kraken's price" : "from Binance, rescaled to Kraken's price"})</>}.</>}</p>
      </section>
    </>
  );
}

function LiqPanel({ showLiq, onShowLiq }: { showLiq: boolean; onShowLiq: (v: boolean) => void }) {
  const stats = useStats();
  return (
    <section>
      <h2>Liquidation levels
        <span className={cx('pill', stats?.liq?.status === 'live' && 'ok', /error|no /.test(stats?.liq?.status ?? '') && 'bad')}>{stats?.liq?.status ?? 'idle'}</span>
        <label className="tog"><input type="checkbox" checked={showLiq} onChange={(e) => onShowLiq(e.currentTarget.checked)} /> show</label>
      </h2>
      {stats?.liq && (
        <>
          <div className="cards">
            <div className="card"><span className="k">Largest long cluster</span><span className="v mono down">{stats.liq.long ? px(stats.liq.long.price) : '–'}</span><span className="s mono">{stats.liq.long ? usd(stats.liq.long.notional) : ''}</span></div>
            <div className="card"><span className="k">Largest short cluster</span><span className="v mono up">{stats.liq.short ? px(stats.liq.short.price) : '–'}</span><span className="s mono">{stats.liq.short ? usd(stats.liq.short.notional) : ''}</span></div>
          </div>
          <dl className="mono">
            <dt>Liquidations seen</dt><dd>{int(stats.liq.liquidations)} · {usd(stats.liq.liquidatedNotional)}</dd>
            <dt>Futures msgs / s</dt><dd>{int(stats.liq.msgsPerSec)}</dd>
          </dl>
        </>
      )}
      <p className="dim small">Bands on the candles are estimated liquidation levels for the {stats?.liq?.symbol || '…'} Binance perpetual (Kraken spot has no liquidations), rescaled to this chart's price: green is light, yellow and red are heavy, and the hottest levels are labelled. Built from {stats?.liq?.source === 'volume estimate' ? 'trade volume (open interest was not reachable)' : 'open interest changes'} and an assumed 10–100× leverage mix over {int(stats?.liq?.bars)} bars{!!stats?.liq?.backfillMs && <>{' '}(history rebuilt in {fmt(stats.liq.backfillMs, 0)} ms)</>}. Squares are real liquidations: red longs, green shorts. Cluster prices are in USDT.</p>
    </section>
  );
}

function HealthPanel({ venue, res, pair, other, onReset }: { venue: Venue; res: Resolved | null; pair: string; other: Venue | null; onReset: () => void }) {
  const stats = useStats();
  const totals = totalsOf(stats);
  const focusStatus = focusStatusOf(stats, venue, res);
  const live = focusStatus.startsWith('live');
  const fps = stats?.render?.frameInterval.p50 ? 1000 / stats.render.frameInterval.p50 : NaN;
  return (
    <>
      <section>
        <div className="cards">
          <div className="card"><span className="k">Frame rate</span><span className={cx('v mono', fps >= 55 && 'up', fps < 55 && 'warnt')}>{Number.isFinite(fps) ? fmt(fps, 0) : '–'}<small> fps</small></span><span className="s mono">p99 {fmt(stats?.render?.frameInterval.p99)} ms</span></div>
          <div className="card"><span className="k">Receive → draw</span><span className="v mono">{fmt(stats?.render?.latency.p50)}<small> ms</small></span><span className="s mono">p99 {fmt(stats?.render?.latency.p99)} ms</span></div>
          <div className="card"><span className="k">Level changes / s</span><span className="v mono">{int(totals?.levels)}</span><span className="s mono">{int(totals?.msgs)} msgs / s</span></div>
          <div className="card"><span className="k">Render CPU</span><span className="v mono">{fmt(stats?.render?.cpu.p50, 2)}<small> ms</small></span><span className="s mono">p99 {fmt(stats?.render?.cpu.p99, 2)} ms</span></div>
        </div>
      </section>
      <section>
        <h2>Feed integrity <span className={cx('pill', live && 'ok', (focusStatus.startsWith('error') || focusStatus === 'not listed') && 'bad')}>{focusStatus}</span></h2>
        {!res ? <p className="dim small">{venueName(venue)} doesn't list {pair}.{other && <>{' '}{venueName(other)} does.</>}</p>
          : res.standIn ? <p className="dim small">{venueName(venue)} has no {pair}; showing {res.base}/{res.quote}.</p> : null}
        <dl className="mono">
          <dt>Books kept live</dt><dd>{int(totals?.books)}</dd>
          <dt>Checksum failures</dt><dd className={cx(!!totals?.checksum && 'bad')}>{int(totals?.checksum)}</dd>
          <dt>Sequence gaps</dt><dd className={cx(!!totals?.gaps && 'bad')}>{int(totals?.gaps)}</dd>
          <dt>Resyncs · reconnects</dt><dd>{int(totals?.resyncs)} · {int(totals?.reconnects)}</dd>
          <dt>Crossed books seen</dt><dd className={cx(!!totals?.crossed && 'bad')}>{int(totals?.crossed)}</dd>
        </dl>
      </section>
      <section>
        <h2>Performance <button className="link" onClick={onReset}>reset</button></h2>
        <dl className="mono">
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
        <p className="dim small">Scroll (two fingers on a trackpad) to move around the candles, sideways through time and up or down in price; scroll sideways on the depth chart to move its price range. Pinch, the − + fit buttons, or dragging an axis zoom: the price axis on the right of the candles, the time strip just under them, and the price strip under the depth chart. Double-click an axis to reset it; fit (<kbd>F</kbd>) resets every panel and returns to live. Drag the lines between panels to resize them. Hover a book row to see what filling up to it costs. Press <kbd>?</kbd> for every shortcut.</p>
      </section>
    </>
  );
}

/** The book as a text table, for screen readers (and on demand); read four times a second. */
function BookTable({ show, venue, pairText }: { show: boolean; venue: Venue; pairText: string }) {
  const table = useLadder();
  return (
    <section className={cx('table', !show && 'sr-only')} id="book-table" tabIndex={-1} aria-label="Order book table">
      <h2>{venue} {pairText} order book ({table?.status ?? '…'})</h2>
      {table ? (
        <table className="mono">
          <thead><tr><th>Side</th><th>Price</th><th>Size</th><th>Total</th></tr></thead>
          <tbody>
            {table.asks.slice().reverse().map((r, i) => <tr key={`a${i}`} className="ask"><td>ask</td><td>{fmt(r.price, table.decimals)}</td><td>{fmt(r.qty, 4)}</td><td>{fmt(r.cum, 4)}</td></tr>)}
            {table.bids.map((r, i) => <tr key={`b${i}`} className="bid"><td>bid</td><td>{fmt(r.price, table.decimals)}</td><td>{fmt(r.qty, 4)}</td><td>{fmt(r.cum, 4)}</td></tr>)}
          </tbody>
        </table>
      ) : <p className="dim">Table needs shared memory (cross-origin isolation).</p>}
    </section>
  );
}

export default function App() {
  const [init] = useState(readInitial);
  const host = init.host;
  const [source, setSource] = useState(init.source);
  const [venue, setVenue] = useState<Venue>(init.venue);
  const [pair, setPair] = useState(init.pair);
  const [favourites, setFavourites] = useState(loadFavourites);
  const [catalog, setCatalog, catalogRef] = useLive<Catalog>(() => initialCatalog(init.source));
  const entries = useMemo(() => allPairs(catalog), [catalog]);
  const quotes = useMemo(() => quoteRanking(catalog), [catalog]);
  const index = useMemo(() => ({ kraken: new MarketIndex(catalog.kraken), binance: new MarketIndex(catalog.binance) }), [catalog]);
  const res = useMemo(() => index[venue].resolve(pair), [index, venue, pair]);
  const [group, setGroup] = useState(init.group);
  // candle size, indicators and overlay toggles, remembered in this browser; URL parameters win
  const [interval, setIntervalState] = useState<Interval>(init.interval);
  const [load, setLoad] = useState(init.load);
  // theme: follows the system unless picked; a ?theme= parameter wins
  const [themeMode, setThemeMode] = useState<ThemeMode>(init.themeMode);
  const [sysTheme, setSysTheme] = useState<'dark' | 'light'>(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const theme: 'dark' | 'light' = themeMode === 'system' ? sysTheme : themeMode;
  const [sideOpen, setSideOpen] = useState(init.ui.sideOpen);
  const [tab, setTab] = useState<SideTab>(init.ui.tab);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const picker = useRef<PairPickerHandle>(null);
  const [showChart, setShowChart] = useState(init.chart.showChartPatterns);
  const [showCandle, setShowCandle] = useState(init.chart.showCandlePatterns);
  const [indicators, setIndicatorsState] = useState<IndConfig[]>(init.chart.indicators);
  const [indMenu, setIndMenu] = useState(false);
  // lower panes and the volume strip change the candle pane's geometry (the axis handles follow it)
  const indPanes = useMemo(() => ({
    sub: Math.min(MAX_SUB_PANES, indicators.filter((c) => c.on && SPECS[c.kind].pane === 'sub').length),
    vol: indicators.some((c) => c.on && c.kind === 'volume'),
  }), [indicators]);
  const geom = (c: Rect) => candleGeom(c, indPanes.sub, indPanes.vol);
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [showTable, setShowTable] = useState(false);
  const [showLiq, setShowLiq] = useState(init.showLiq);
  const [selected, setSelected] = useState<string | null>(null);
  // analysis window: a box dragged on the candle chart; patterns are searched inside it only
  const [win, setWin] = useState<AnalysisWindow | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [copied, setCopied] = useState(false);

  // layout + zoom, remembered in this browser (refs too: drags and persistence read them back at once)
  const [layoutPrefs, setLayoutPrefs, layoutRef] = useLive<LayoutPrefs>(init.view.layout);
  const [sideW, setSideW, sideWRef] = useLive(init.view.sideW);
  const [fontPx, setFontPx, fontRef] = useLive(init.view.fontPx);
  const [zoomState, setZoomState, zoomRef] = useLive<ZoomFields>({
    candlesVisible: init.view.candlesVisible, depthRangePct: init.view.depthRangePct, ladderRowPad: init.view.ladderRowPad, candlesPriceScale: init.view.candlesPriceScale,
  });
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const panes = useMemo(() => (stage.w ? computeLayout(stage.w, stage.h, layoutPrefs) : null), [stage, layoutPrefs]);

  const alertsPanel = useRef<AlertsHandle>(null);
  const engineRef = useRef<Engine | null>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const [generation, setGeneration] = useState(0); // a new engine and canvas: a canvas can only be transferred once

  // ---- persistence: each takes the values just changed, the rest come from this render ----
  const persistUi = (o: Partial<UiPrefs> = {}) => saveUiPrefs({ themeMode, sideOpen, tab, ...o });
  const persistChart = (o: Partial<ChartPrefs> = {}) => saveChartPrefs({ interval, indicators, showChartPatterns: showChart, showCandlePatterns: showCandle, showLiquidations: showLiq, ...o });
  const persist = useCallback(() => savePrefs({ layout: layoutRef.current, sideW: sideWRef.current, fontPx: fontRef.current, ...zoomRef.current } satisfies ViewPrefs), [layoutRef, sideWRef, fontRef, zoomRef]);
  function syncUrl(o: Partial<{ source: string; venue: Venue; pair: string; group: number; interval: Interval; load: number; themeMode: ThemeMode; showLiq: boolean }> = {}) {
    const s = { source, venue, pair, group, interval, load, themeMode, showLiq, ...o };
    const p = new URLSearchParams({ src: s.source, venue: s.venue, pair: s.pair, group: String(s.group), interval: String(s.interval), pairs: String(s.load) });
    if (s.themeMode !== 'system') p.set('theme', s.themeMode);
    if (s.source === 'local') p.set('host', host);
    if (!s.showLiq) p.set('liq', '0');
    history.replaceState(null, '', `?${p}`);
  }

  function setThemeTo(m: ThemeMode) { setThemeMode(m); persistUi({ themeMode: m }); syncUrl({ themeMode: m }); }
  function cycleTheme() {
    const m: ThemeMode = themeMode === 'system' ? 'dark' : themeMode === 'dark' ? 'light' : 'system';
    setThemeTo(m);
    toast(`Theme: ${m === 'system' ? `system (${sysTheme})` : m}`);
  }
  function toggleSide() { setSideOpen(!sideOpen); persistUi({ sideOpen: !sideOpen }); }
  const openHealth = () => openTab('health');
  function openTab(t: SideTab) { setTab(t); setSideOpen(true); persistUi({ tab: t, sideOpen: true }); }
  function setIndicators(list: IndConfig[]) {
    setIndicatorsState(list);
    engineRef.current?.setIndicators(list);
    persistChart({ indicators: list });
  }
  function setShowChartTo(v: boolean) { setShowChart(v); engineRef.current?.setSettings({ showChartPatterns: v }); persistChart({ showChartPatterns: v }); }
  function setShowCandleTo(v: boolean) { setShowCandle(v); engineRef.current?.setSettings({ showCandlePatterns: v }); persistChart({ showCandlePatterns: v }); }
  function setShowLiqTo(v: boolean) { setShowLiq(v); engineRef.current?.setSettings({ showLiquidations: v }); syncUrl({ showLiq: v }); persistChart({ showLiquidations: v }); }

  // ---- the engine: workers, shared buffers and the canvas, started once per generation ----
  const latest = useLatest({ source, host, load, venue, pair, catalogRef, group, interval, theme, layoutRef, fontRef, zoomRef, indicators, reducedMotion, showChart, showCandle, selected, showLiq, res });
  const settings = (): SceneSettings => {
    const s = latest.current;
    const z = s.zoomRef.current;
    return {
      depthRangePct: z.depthRangePct, candlesVisible: z.candlesVisible, ladderRowPad: z.ladderRowPad, candlesPriceScale: z.candlesPriceScale, reducedMotion: s.reducedMotion,
      showChartPatterns: s.showChart, showCandlePatterns: s.showCandle, selectedPattern: s.selected, showLiquidations: s.showLiq,
      venueLabel: s.venue.toUpperCase(), pairLabel: s.res ? `${s.res.base}/${s.res.quote}` : s.pair, intervalLabel: intervalLabel(s.interval), intervalMin: s.interval,
    };
  };

  useEffect(() => {
    const s = latest.current;
    const host = canvasHost.current!;
    const canvas = document.createElement('canvas');
    host.prepend(canvas);
    const engine = new Engine({
      canvas,
      endpoints: s.source === 'local' ? localEndpoints(s.host) : LIVE,
      pairCount: s.load,
      depth: { kraken: s.source === 'local' ? 1000 : 500, binance: 1000 },
      venue: s.venue, pair: s.pair, catalog: s.catalogRef.current, group: s.group, interval: s.interval, settings: settings(), theme: s.theme,
      layout: s.layoutRef.current, fontPx: s.fontRef.current, indicators: s.indicators,
    });
    engineRef.current = engine;
    engine.onZoom = (z) => {
      setZoomState({ candlesVisible: z.candlesVisible, depthRangePct: z.depthRangePct, ladderRowPad: z.ladderRowPad, candlesPriceScale: z.candlesPriceScale });
      persist();
    };
    engine.onStats = statsStore.set;
    const src = s.source;
    engine.onMarkets = (v, markets) => {
      if (!markets.length) return;
      const next = { ...catalogRef.current, [v]: markets };
      setCatalog(next);
      if (src === 'live') saveCachedCatalog(v, markets);
      engine.setCatalog(next);
    };
    engine.onSelected = setSelected;
    setWin(null); setDrawMode(false);
    engine.onWindow = (w) => {
      if (!w) return; // too small: keep the previous window
      setWin(w); setDrawMode(false); setSelected(null);
      engine.setSettings({ selectedPattern: null });
    };
    alertsPanel.current?.attach(engine);
    (window as any).__depthline = engine;
    return () => {
      engine.destroy();
      canvas.remove();
      if (engineRef.current === engine) engineRef.current = null;
    };
    // a restart is asked for by bumping the generation; everything else reaches the running engine by message
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);
  const restart = () => setGeneration((g) => g + 1);

  // stage size and the low rate book read for the ticker and the text table
  useEffect(() => {
    const el = canvasHost.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setStage({ w: r.width, h: r.height });
      engineRef.current?.resize(r.width, r.height);
    });
    ro.observe(el);
    const t = setInterval(() => { const e = engineRef.current; if (e) ladderStore.set(e.ladder()); }, 250);
    return () => { ro.disconnect(); clearInterval(t); };
  }, []);

  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const f = (e: MediaQueryListEvent) => setSysTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener?.('change', f);
    return () => mq.removeEventListener?.('change', f);
  }, []);
  // theme reaches the page (CSS tokens) and the canvas together
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    engineRef.current?.setTheme(theme);
  }, [theme]);

  const pairText = res ? `${res.base}/${res.quote}` : pair;
  const otherVenue: Venue = venue === 'kraken' ? 'binance' : 'kraken';

  // ---- pair, venue, candle size ----
  function pickPair(label: string) {
    setPair(label); setSelected(null); setWin(null);
    engineRef.current?.setPair(label);
    syncUrl({ pair: label });
  }
  const pickPairLatest = useLatest(pickPair);
  const onPick = useCallback((label: string) => pickPairLatest.current(label), [pickPairLatest]);
  const onFavourite = useCallback((label: string) => {
    setFavourites((f) => { const next = toggleFavourite(f, label); saveFavourites(next); return next; });
  }, []);
  const resolve = useCallback((v: Venue, l: string) => index[v].resolve(l), [index]);
  function setIntervalTo(m: Interval) {
    if (m === interval) return;
    setIntervalState(m);
    engineRef.current?.setInterval(m);
    setSelected(null);
    syncUrl({ interval: m });
    persistChart({ interval: m });
  }
  function stepInterval(d: 1 | -1) {
    const i = INTERVALS.indexOf(interval);
    setIntervalTo(INTERVALS[Math.max(0, Math.min(INTERVALS.length - 1, i + d))]);
  }
  function switchVenue(v: Venue) {
    if (v === venue) return;
    setVenue(v);
    engineRef.current?.setVenue(v);
    setSelected(null); setWin(null);
    syncUrl({ venue: v });
  }
  function selectPattern(id: string) {
    const next = selected === id ? null : id;
    setSelected(next);
    engineRef.current?.revealPattern(next);
  }

  // a pattern picked on the chart scrolls its explanation into view
  useEffect(() => {
    if (explanation && selected) document.querySelector('.explainer.drawer article.sel')?.scrollIntoView({ block: 'nearest' });
  }, [selected, explanation]);

  // ---- analysis window and explanation ----
  function clearWindow() { setWin(null); engineRef.current?.setWindow(null); }
  function openExplanation() {
    const pt = statsStore.get()?.patterns ?? engineRef.current?.snapshot().patterns;
    if (!pt) return;
    // without a window: every chart pattern and the latest candle signals, as listed in the side panel
    const list = pt.window ? pt.list : [...pt.list.filter((p) => p.family === 'chart'), ...pt.list.filter((p) => p.family !== 'chart' && p.bias !== 0).slice(-12)];
    setExplanation(explain(list, {
      t: pt.t, last: pt.last, decimals: ladderStore.get()?.decimals ?? 2, window: pt.window,
      symbol: res ? `${venueName(venue)} ${res.base}/${res.quote}` : pair, interval,
    }));
    setCopied(false);
  }
  async function copyExplanation() {
    if (!explanation) return;
    try { await navigator.clipboard.writeText(explanationText(explanation)); setCopied(true); toast('Explanation copied', 'ok'); } catch { setCopied(false); toast('Could not copy: clipboard blocked', 'warn'); }
  }

  /** Keyboard shortcuts (listed in the ? dialog). Ignored while typing in a field. */
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (helpOpen) setHelpOpen(false);
      else if (settingsOpen) setSettingsOpen(false);
      else if (explanation) setExplanation(null);
      else if (indMenu) setIndMenu(false);
      else if (drawMode) setDrawMode(false);
      return;
    }
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName))) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); picker.current?.show(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    const act: Record<string, () => void> = {
      '/': () => picker.current?.show(),
      '?': () => setHelpOpen(!helpOpen),
      t: cycleTheme,
      ']': toggleSide,
      b: toggleSide,
      v: () => switchVenue(otherVenue),
      w: () => setDrawMode(!drawMode),
      e: openExplanation,
      i: () => setIndMenu(!indMenu),
      f: () => { for (const p of PANES) engineRef.current?.zoom(p, 0); },
      l: () => { setShowLiqTo(!showLiq); toast(`Liquidation levels ${!showLiq ? 'on' : 'off'}`); },
      p: () => { setShowChartTo(!showChart); toast(`Chart patterns ${!showChart ? 'on' : 'off'}`); },
      ',': () => stepInterval(-1),
      '.': () => stepInterval(1),
    };
    const n = Number(k);
    if (n >= 1 && n <= PINNED_INTERVALS.length && Number.isInteger(n)) { e.preventDefault(); setIntervalTo(PINNED_INTERVALS[n - 1]); return; }
    const f = act[k] ?? act[k.toLowerCase()];
    if (f) { e.preventDefault(); f(); }
  };
  const onKeyLatest = useLatest(onKey);
  useEffect(() => {
    const f = (e: KeyboardEvent) => onKeyLatest.current(e);
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [onKeyLatest]);

  // ---- pointer on the canvas ----
  const local = (e: { clientX: number; clientY: number }) => { const r = canvasHost.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const ptr = (e: React.PointerEvent, inside = true) => { const p = local(e); engineRef.current?.pointer(p.x, p.y, inside); };
  // drawing the analysis window: drag on the candle chart in draw mode, or shift+drag any time
  const brushFrom = useRef<{ x: number; y: number } | null>(null);
  const swallowClick = useRef(false);
  function brushStart(e: React.PointerEvent) {
    if (!panes || e.button !== 0 || !(drawMode || e.shiftKey)) return;
    const p = local(e), c = panes.candles;
    // the plot only: not the header buttons or the price / time axis zoom handles
    if (p.x < c.x || p.x > c.x + c.w - CANDLE_AXIS_W || p.y < c.y + PANE_HEADER || p.y > geom(c).timeY) return;
    e.preventDefault();
    brushFrom.current = p;
    canvasHost.current!.setPointerCapture(e.pointerId);
  }
  function brushMove(e: React.PointerEvent) {
    const from = brushFrom.current;
    if (!from) return;
    const p = local(e);
    engineRef.current?.brush(from.x, from.y, p.x, p.y, 'move');
  }
  function brushEnd(e: React.PointerEvent, cancel = false) {
    const from = brushFrom.current;
    if (!from) return;
    const p = local(e);
    engineRef.current?.brush(from.x, from.y, p.x, p.y, cancel ? 'cancel' : 'end');
    swallowClick.current = Math.abs(p.x - from.x) + Math.abs(p.y - from.y) > 4;
    brushFrom.current = null;
  }
  const click = (e: React.MouseEvent) => {
    if (swallowClick.current) { swallowClick.current = false; return; }
    const p = local(e);
    engineRef.current?.click(p.x, p.y);
  };
  // Wheel listeners must be non-passive to stop the page scrolling, which React's are not, so one
  // native listener on the stage handles the canvas and the axis handles (marked data-axis).
  useEffect(() => {
    const el = canvasHost.current!;
    const onWheel = (e: WheelEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.indmenu')) return; // the indicator menu scrolls itself
      e.preventDefault();
      const engine = engineRef.current;
      const axis = (t.closest('[data-axis]') as HTMLElement | null)?.dataset.axis as 'x' | 'y' | 'depth' | undefined;
      if (axis) { engine?.axisScale(axis, e.deltaY > 0 ? 1 / 1.15 : 1.15); return; }
      // scrolling pans (two-finger trackpad scroll moves both ways); a pinch, which arrives with ctrl held, zooms
      const r = el.getBoundingClientRect();
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1; // lines / pages to px
      let dx = e.deltaX * k, dy = e.deltaY * k;
      if (e.shiftKey && !dx) { dx = dy; dy = 0; } // shift + mouse wheel scrolls sideways
      engine?.wheel(e.clientX - r.left, e.clientY - r.top, dx, dy, e.ctrlKey);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ---- zoom buttons and resize handles over the canvas ----
  const zoom = (e: React.MouseEvent, pane: ZoomPane, dir: 1 | -1 | 0) => { e.stopPropagation(); engineRef.current?.zoom(pane, dir); };
  const setLayout = useCallback((next: LayoutPrefs) => { setLayoutPrefs(next); engineRef.current?.setLayout(next); }, [setLayoutPrefs]);
  /** Drag a split. `which`: the ladder edge or the depth / candles edge. */
  function dragStart(e: React.PointerEvent, which: 'ladder' | 'depth') {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let raf = 0, lx = 0, ly = 0;
    const apply = () => {
      raf = 0;
      const r = canvasHost.current!.getBoundingClientRect();
      setLayout(dragSplit(layoutRef.current, which, lx - r.left, ly - r.top, r.width, r.height));
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
  function splitKey(e: React.KeyboardEvent, which: 'ladder' | 'depth') {
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
  function dragSide(e: React.PointerEvent) {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => { setSideW(Math.round(Math.max(SIDE_W.min, Math.min(SIDE_W.max, innerWidth - ev.clientX)))); };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); persist(); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
  function sideKey(e: React.KeyboardEvent) {
    const d = e.key === 'ArrowLeft' ? 20 : e.key === 'ArrowRight' ? -20 : 0;
    if (!d) return;
    e.preventDefault();
    setSideW(Math.max(SIDE_W.min, Math.min(SIDE_W.max, sideW + d)));
    persist();
  }
  function setFont(n: number) { setFontPx(n); engineRef.current?.setFont(n); persist(); }
  /**
   * Drag the candle chart's price axis (vertical zoom: up = in) or its time
   * strip (horizontal zoom: right = in). Double-click resets that axis.
   */
  function axisDrag(e: React.PointerEvent, axis: 'x' | 'y' | 'depth') {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let last = axis === 'y' ? e.clientY : e.clientX, pend = 0, raf = 0;
    const flush = () => { raf = 0; if (pend) engineRef.current?.axisScale(axis, Math.exp(pend / 120)); pend = 0; };
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
  function axisKey(e: React.KeyboardEvent, axis: 'x' | 'y' | 'depth') {
    const f = ({ ArrowUp: 1.15, ArrowRight: 1.15, ArrowDown: 1 / 1.15, ArrowLeft: 1 / 1.15, Home: 0 } as Record<string, number>)[e.key];
    if (f === undefined) return;
    e.preventDefault();
    engineRef.current?.axisScale(axis, f);
  }
  const axisProps = (axis: 'x' | 'y' | 'depth') => ({
    'data-axis': axis,
    onPointerDown: (e: React.PointerEvent) => axisDrag(e, axis),
    onKeyDown: (e: React.KeyboardEvent) => axisKey(e, axis),
    onDoubleClick: () => engineRef.current?.axisScale(axis, 0),
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  });

  function resetView() {
    const d = defaultPrefs();
    setLayout(d.layout);
    setSideW(d.sideW);
    setFontPx(d.fontPx);
    engineRef.current?.setFont(d.fontPx);
    for (const p of PANES) engineRef.current?.zoom(p, 0);
    setZoomState({ candlesVisible: d.candlesVisible, depthRangePct: d.depthRangePct, ladderRowPad: d.ladderRowPad, candlesPriceScale: d.candlesPriceScale });
    persist();
    toast('Layout and zoom reset', 'ok');
  }

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const splitPct = (which: 'ladder' | 'depth') => Math.round(layoutPrefs[panes?.narrow ? 'narrow' : 'wide'][which] * 100);
  const c = panes?.candles, d = panes?.depth;
  const cg = c ? geom(c) : null;

  return (
    <>
      <a className="skip" href="#book-table" onClick={() => setShowTable(true)}>Skip to the order book table</a>

      <div className="shell">
        <header className="topbar">
          <div className="brand" aria-label="Depthline">
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 20h4V12H2zM8 20h4V4H8zM14 20h4V9h-4zM20 20h2v-5h-2z" fill="var(--accent)" /></svg>
            <strong>Depthline</strong>
          </div>
          <div className="pairbox">
            <PairPicker ref={picker} pair={pair} entries={entries} quotes={quotes} favourites={favourites} venue={venue} showFavs={false} resolve={resolve} onpick={onPick} onfavourite={onFavourite} />
          </div>
          <div className="seg venue" role="group" aria-label="Venue (V)">
            {(['kraken', 'binance'] as Venue[]).map((v) => (
              <button key={v} className={cx(venue === v && 'on', !index[v].resolve(pair) && 'unlisted')} aria-pressed={venue === v}
                title={index[v].resolve(pair) ? `Show ${venueName(v)} (V)` : `${venueName(v)} doesn't list ${pair}`}
                onClick={() => switchVenue(v)}>{venueName(v)}</button>
            ))}
          </div>

          <Ticker res={res} pair={pair} />

          <span className="spacer"></span>

          <StatusChips venue={venue} res={res} onHealth={openHealth} />
          <div className="icons">
            <button className="icon kbd" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => setHelpOpen(true)}><Icon name="keyboard" /></button>
            <button className="icon themeb" title={`Theme: ${themeMode} (T)`} aria-label={`Theme: ${themeMode}. Change theme`} onClick={cycleTheme}><Icon name={themeMode === 'system' ? 'monitor' : themeMode === 'dark' ? 'moon' : 'sun'} /></button>
            <div className="pop-anchor">
              <button className={cx('icon', settingsOpen && 'on')} title="Settings" aria-label="Settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><Icon name="gear" /></button>
              {settingsOpen && (
                <>
                  <div className="scrim" onClick={() => setSettingsOpen(false)}></div>
                  <div className="popover settings" role="dialog" aria-label="Settings">
                    <h3>Data</h3>
                    <label className="row">Source
                      <select value={source} onChange={(e) => {
                        const v = e.currentTarget.value as 'live' | 'local';
                        setSource(v); setCatalog(initialCatalog(v)); syncUrl({ source: v }); restart();
                      }}>
                        <option value="live">Live exchanges</option>
                        <option value="local">Local emulator</option>
                      </select>
                    </label>
                    <label className="row" title="Pairs kept live per venue. More pairs = more updates per second.">Load
                      <select value={load} onChange={(e) => { const n = Number(e.currentTarget.value); setLoad(n); syncUrl({ load: n }); restart(); }}>
                        {[1, 5, 10, 25].map((n) => <option key={n} value={n}>{n} pair{n > 1 ? 's' : ''} / venue</option>)}
                      </select>
                    </label>
                    <h3>Display</h3>
                    <label className="row">Text size
                      <select value={fontPx} onChange={(e) => setFont(Number(e.currentTarget.value))}>
                        {Array.from({ length: ZOOM.font.max - ZOOM.font.min + 1 }, (_, i) => ZOOM.font.min + i).map((n) => <option key={n} value={n}>{n}px</option>)}
                      </select>
                    </label>
                    <label className="row">Theme
                      <select value={themeMode} onChange={(e) => setThemeTo(e.currentTarget.value as ThemeMode)}>
                        <option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option>
                      </select>
                    </label>
                    <label className="check"><input type="checkbox" checked={reducedMotion} onChange={(e) => { const v = e.currentTarget.checked; setReducedMotion(v); engineRef.current?.setSettings({ reducedMotion: v }); }} /> Reduce motion (no flashes)</label>
                    <label className="check"><input type="checkbox" checked={showTable} onChange={(e) => setShowTable(e.currentTarget.checked)} /> Show the text table of the book</label>
                    <div className="foot"><button className="ghost" onClick={resetView}>Reset layout and zoom</button></div>
                  </div>
                </>
              )}
            </div>
            <button className={cx('icon', sideOpen && 'on')} title={`${sideOpen ? 'Hide' : 'Show'} the side panel (B)`} aria-label={`${sideOpen ? 'Hide' : 'Show'} the side panel`} aria-pressed={sideOpen} onClick={toggleSide}><Icon name="sidebar" /></button>
          </div>
        </header>

        <div className="toolbar" role="toolbar" aria-label="Chart controls">
          <div className="seg tf" role="group" aria-label="Candle size">
            {PINNED_INTERVALS.map((m, i) => (
              <button key={m} className={cx(interval === m && 'on')} aria-pressed={interval === m} title={`${intervalLabel(m)} candles (${i + 1})`} onClick={() => setIntervalTo(m as Interval)}>{intervalLabel(m)}</button>
            ))}
            <select className={cx(!PINNED_INTERVALS.includes(interval) && 'on')} aria-label="More candle sizes" value={PINNED_INTERVALS.includes(interval) ? '' : String(interval)}
              onChange={(e) => { const v = Number(e.currentTarget.value); if (v) setIntervalTo(v as Interval); }}>
              <option value="" disabled>More</option>
              {INTERVALS.filter((m) => !PINNED_INTERVALS.includes(m)).map((m) => <option key={m} value={String(m)}>{intervalLabel(m)}</option>)}
            </select>
          </div>
          <span className="sep" aria-hidden="true"></span>
          <GroupSelect group={group} onChange={(g) => { setGroup(g); engineRef.current?.setGroup(g); syncUrl({ group: g }); }} />
          <span className="sep" aria-hidden="true"></span>
          <div className="toggles" role="group" aria-label="Chart overlays">
            <button className={cx('tg', showChart && 'on')} aria-pressed={showChart} title="Chart patterns (P)" onClick={() => setShowChartTo(!showChart)}>Patterns</button>
            <button className={cx('tg', showCandle && 'on')} aria-pressed={showCandle} title="Candle signals" onClick={() => setShowCandleTo(!showCandle)}>Signals</button>
            <button className={cx('tg', showLiq && 'on')} aria-pressed={showLiq} title="Liquidation levels (L)" onClick={() => setShowLiqTo(!showLiq)}>Liquidations</button>
          </div>
          {favourites.length > 0 && (
            <>
              <span className="sep" aria-hidden="true"></span>
              <div className="favs" role="group" aria-label="Favourite pairs">
                <span className="star" aria-hidden="true">★</span>
                {favourites.map((f) => (
                  <button key={f} className={cx('fav mono', f === pair && 'on')} aria-pressed={f === pair} onClick={() => pickPair(f)}>{f}</button>
                ))}
              </div>
            </>
          )}
        </div>

        <main>
          <div className={cx('stage', drawMode && 'drawing')} ref={canvasHost}
            onPointerDown={brushStart} onPointerUp={(e) => brushEnd(e)} onPointerCancel={(e) => brushEnd(e, true)}
            onPointerMove={(e) => { ptr(e); brushMove(e); }} onPointerLeave={(e) => ptr(e, false)} onClick={click}
            role="application" aria-label="Order book, depth chart and candle chart. A text table of the book follows the chart.">
            {/* the canvas is created by the engine effect: it is handed to the render worker once */}
            {panes && c && d && cg && (
              <>
                {PANES.map((p) => {
                  const r = panes[p];
                  return (
                    <div key={p} className="zoom" role="group" aria-label={`Zoom ${paneNames[p]}`} style={{ left: r.x + r.w - HEADER_CTRL_W, top: r.y + 2, width: HEADER_CTRL_W - 4 }} onClick={stop}>
                      <button title={zoomTips[p][0]} aria-label={`Zoom out ${paneNames[p]}`} onClick={(e) => zoom(e, p, -1)}>−</button>
                      <button title={zoomTips[p][1]} aria-label={`Zoom in ${paneNames[p]}`} onClick={(e) => zoom(e, p, 1)}>+</button>
                      <button title={p === 'depth' ? 'Auto-fit the price range' : 'Default zoom'} aria-label={`Reset zoom ${paneNames[p]}`} onClick={(e) => zoom(e, p, 0)}>fit</button>
                    </div>
                  );
                })}
                <div className="axis x" role="slider" tabIndex={0} aria-label="Depth chart price range zoom" aria-valuemin={ZOOM.depthPct.min} aria-valuemax={ZOOM.depthPct.max} aria-valuenow={zoomState.depthRangePct}
                  title="Drag left or right to zoom the price range. Double-click to auto-fit."
                  style={{ left: d.x, top: d.y + d.h - DEPTH_AXIS_H, width: d.w - 60, height: DEPTH_AXIS_H }}
                  {...axisProps('depth')}></div>
                <div className="zoom wintools" role="group" aria-label="Pattern analysis window and indicators" style={{ left: c.x + c.w - HEADER_CTRL_W - CANDLE_TOOLS_W, top: c.y + 2, width: CANDLE_TOOLS_W - 4 }} onClick={stop}>
                  <button className={cx(indMenu && 'on')} aria-expanded={indMenu} title="Add, remove and configure indicators" onClick={() => setIndMenu(!indMenu)}>indicators</button>
                  <button className={cx(drawMode && 'on')} aria-pressed={drawMode} title="Drag a box over the candles to search for patterns only inside it (or shift+drag any time)" onClick={() => setDrawMode(!drawMode)}>{drawMode ? 'drag a box…' : 'window'}</button>
                  {win && <button title="Search the whole history again" onClick={clearWindow}>clear</button>}
                  <button title="Explain the detected patterns in plain words" onClick={openExplanation}>explain</button>
                </div>
                {indMenu && (
                  <div className="indmenu" role="dialog" tabIndex={-1} aria-label="Indicators" style={{ right: stage.w - (c.x + c.w - HEADER_CTRL_W), top: c.y + PANE_HEADER + 2 }}
                    onClick={stop} onPointerDown={stop}>
                    <div className="ehead"><h2>Indicators</h2><button className="link" onClick={() => setIndMenu(false)}>close</button></div>
                    <Indicators list={indicators} theme={theme} onchange={setIndicators} />
                  </div>
                )}
                <div className="axis y" role="slider" tabIndex={0} aria-label="Candle chart vertical zoom" aria-valuemin={ZOOM.priceScale.min} aria-valuemax={ZOOM.priceScale.max} aria-valuenow={zoomState.candlesPriceScale}
                  title="Drag up or down to zoom prices. Double-click to fit."
                  style={{ left: c.x + c.w - CANDLE_AXIS_W, top: c.y + PANE_HEADER, width: CANDLE_AXIS_W, height: cg.timeY - c.y - PANE_HEADER }}
                  {...axisProps('y')}></div>
                <div className="axis x" role="slider" tabIndex={0} aria-label="Candle chart horizontal zoom" aria-valuemin={ZOOM.candles.min} aria-valuemax={ZOOM.candles.max} aria-valuenow={zoomState.candlesVisible}
                  title="Drag left or right to zoom time. Double-click to reset."
                  style={{ left: c.x, top: cg.timeY, width: c.w - CANDLE_AXIS_W, height: CANDLE_TIME_H }}
                  {...axisProps('x')}></div>
                {panes.narrow ? (
                  <>
                    <div className="split h" role="separator" aria-orientation="horizontal" aria-label="Resize order book" tabIndex={0} aria-valuemin={5} aria-valuemax={95} aria-valuenow={splitPct('ladder')}
                      style={{ top: panes.ladder.h - 4, left: 0, width: stage.w }}
                      onPointerDown={(e) => dragStart(e, 'ladder')} onKeyDown={(e) => splitKey(e, 'ladder')} onDoubleClick={() => resetSplit('ladder')}></div>
                    <div className="split h" role="separator" aria-orientation="horizontal" aria-label="Resize depth chart" tabIndex={0} aria-valuemin={5} aria-valuemax={95} aria-valuenow={splitPct('depth')}
                      style={{ top: panes.candles.y - 4, left: 0, width: stage.w }}
                      onPointerDown={(e) => dragStart(e, 'depth')} onKeyDown={(e) => splitKey(e, 'depth')} onDoubleClick={() => resetSplit('depth')}></div>
                  </>
                ) : (
                  <>
                    <div className="split v" role="separator" aria-orientation="vertical" aria-label="Resize order book" tabIndex={0} aria-valuemin={5} aria-valuemax={95} aria-valuenow={splitPct('ladder')}
                      style={{ left: panes.ladder.w - 4, top: 0, height: stage.h }}
                      onPointerDown={(e) => dragStart(e, 'ladder')} onKeyDown={(e) => splitKey(e, 'ladder')} onDoubleClick={() => resetSplit('ladder')}></div>
                    <div className="split h" role="separator" aria-orientation="horizontal" aria-label="Resize depth chart" tabIndex={0} aria-valuemin={5} aria-valuemax={95} aria-valuenow={splitPct('depth')}
                      style={{ top: panes.depth.h - 4, left: panes.depth.x, width: panes.depth.w }}
                      onPointerDown={(e) => dragStart(e, 'depth')} onKeyDown={(e) => splitKey(e, 'depth')} onDoubleClick={() => resetSplit('depth')}></div>
                  </>
                )}
              </>
            )}
            <FeedOverlay venue={venue} res={res} pair={pair} other={index[otherVenue].resolve(pair) ? otherVenue : null} onSwitch={switchVenue} />
          </div>

          {sideOpen && (
            <div className="split v side" role="separator" aria-orientation="vertical" aria-label="Resize side panel" tabIndex={0} aria-valuemin={SIDE_W.min} aria-valuemax={SIDE_W.max} aria-valuenow={sideW}
              onPointerDown={dragSide} onKeyDown={sideKey} onDoubleClick={() => { setSideW(SIDE_W.def); persist(); }}></div>
          )}
          {/* the panels stay mounted when hidden: price alerts keep checking while another tab is open */}
          <aside style={{ '--side-w': `${sideW}px` } as CSSProperties} className={cx(!sideOpen && 'closed', sideW < 420 && 'narrowside')} aria-label="Side panel">
            <div className="tabs" role="tablist" aria-label="Side panel">
              {TABS.map(([id, name, ic]) => (
                <button key={id} role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} className={cx(tab === id && 'on')} title={name} onClick={() => openTab(id)}>
                  <Icon name={ic} size={15} /><span className="tname">{name}</span>
                  <TabBadge id={id} />
                </button>
              ))}
            </div>

            <div className="panel" role="tabpanel" id="panel-alerts" aria-labelledby="tab-alerts" hidden={tab !== 'alerts'}>
              <AlertsLive alertsRef={alertsPanel} venue={venue} label={pairText} symbol={res?.symbol ?? null} />
            </div>

            <div className="panel" role="tabpanel" id="panel-signals" aria-labelledby="tab-signals" hidden={tab !== 'signals'}>
              <SignalsPanel venue={venue} win={win} selected={selected} showChart={showChart} showCandle={showCandle}
                onShowChart={setShowChartTo} onShowCandle={setShowCandleTo} onClearWindow={clearWindow} onExplain={openExplanation} onSelect={selectPattern} />
            </div>

            <div className="panel" role="tabpanel" id="panel-liq" aria-labelledby="tab-liq" hidden={tab !== 'liq'}>
              <LiqPanel showLiq={showLiq} onShowLiq={setShowLiqTo} />
            </div>

            <div className="panel" role="tabpanel" id="panel-ind" aria-labelledby="tab-ind" hidden={tab !== 'ind'}>
              <section>
                <h2>Indicators</h2>
                <Indicators list={indicators} theme={theme} onchange={setIndicators} />
              </section>
            </div>

            <div className="panel" role="tabpanel" id="panel-game" aria-labelledby="tab-game" hidden={tab !== 'game'}>
              <Game venue={venue} symbol={res?.symbol ?? null} label={pairText} base={res?.base ?? ''} quote={res?.quote ?? ''} />
            </div>

            <div className="panel" role="tabpanel" id="panel-health" aria-labelledby="tab-health" hidden={tab !== 'health'}>
              <HealthPanel venue={venue} res={res} pair={pair} other={index[otherVenue].resolve(pair) ? otherVenue : null} onReset={() => { engineRef.current?.resetStats(); toast('Measurements reset'); }} />
            </div>
          </aside>
        </main>

        {explanation && (
          <>
            {/* no backdrop: the chart stays visible so a clicked pattern can be seen highlighted on it */}
            <div className="explainer drawer" role="dialog" aria-modal="false" aria-labelledby="explain-title">
              <div className="ehead">
                <h2 id="explain-title">{explanation.title}</h2>
                <button className="ghost" onClick={copyExplanation}>{copied ? 'Copied' : 'Copy'}</button>
                <button className="ghost icon" aria-label="Close" onClick={() => setExplanation(null)}><Icon name="close" /></button>
              </div>
              <p className="summary">{explanation.summary}</p>
              {!!explanation.items.length && <p className="dim small">Newest first. Click a pattern to highlight its markers on the chart; click it again to clear.</p>}
              {explanation.items.map((it) => (
                <article key={it.id} className={cx(selected === it.id && 'sel')} onClick={() => selectPattern(it.id)}>
                  <h3><button className="link" title="Highlight on the chart" aria-pressed={selected === it.id} onClick={(e) => { e.stopPropagation(); selectPattern(it.id); }}>{it.heading}</button></h3>
                  <p>{it.text}</p>
                </article>
              ))}
            </div>
          </>
        )}

        <BookTable show={showTable} venue={venue} pairText={pairText} />
        {helpOpen && (
          <>
            <div className="backdrop" onClick={() => setHelpOpen(false)}></div>
            <div className="explainer help" role="dialog" aria-modal="true" aria-labelledby="help-title">
              <div className="ehead"><h2 id="help-title">Keyboard shortcuts</h2><button className="ghost icon" aria-label="Close" onClick={() => setHelpOpen(false)}><Icon name="close" /></button></div>
              <div className="keys">
                {SHORTCUTS.map(([ks, what]) => (
                  <div key={what} className="krow"><span className="kk">{ks.map((k, i) => (k === '–' ? <span key={i} className="dim">–</span> : <kbd key={i}>{k}</kbd>))}</span><span>{what}</span></div>
                ))}
              </div>
            </div>
          </>
        )}

        <Toasts />
      </div>
    </>
  );
}
