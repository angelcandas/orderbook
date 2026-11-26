import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { Venue } from '../shared/config';
import {
  DURATIONS, FEE, GAME_KEY, MIN_ORDER, START_CASH, equity, finish, isDollar, newGame, parseSaved, record, serialize, tick, trade,
  type CurvePoint, type Game as GameState, type Saved, type Trade,
} from '../game/game';
import { fmtPrice } from '../alerts/notify';
import { gameBadgeStore, ladderStore, statsStore, useLadder } from './live';
import { useLive } from './hooks';
import { toast } from './toast';
import './Game.css';

interface Props { venue: Venue; symbol: string | null; label: string; base: string; quote: string }

const usd = (x: number) => Number.isFinite(x) ? x.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2, minimumFractionDigits: 2 }) : '–';
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
const qtyFmt = (x: number) => x === 0 ? '0' : x.toLocaleString(undefined, { maximumSignificantDigits: 6 });
const clock = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const venueName = (v: string) => (v === 'kraken' ? 'Kraken' : 'Binance');

function load(): Saved {
  try { return parseSaved(localStorage.getItem(GAME_KEY)); } catch { return parseSaved(null); }
}
function save(s: Saved): void {
  try { localStorage.setItem(GAME_KEY, serialize(s)); } catch { /* storage unavailable */ }
}

/** The best bid and ask of the focused book, from the 4 Hz read; the chart's last price when the book can't be read. */
function quoteNow(): { bid: number; ask: number; live: boolean } {
  const l = ladderStore.get();
  if (l && l.status === 'live' && l.bestBid > 0 && l.bestAsk > 0) return { bid: l.bestBid, ask: l.bestAsk, live: true };
  const last = statsStore.get()?.patterns.last ?? NaN;
  return { bid: last, ask: last, live: false };
}

/**
 * Trading game: you against the house AI, both from $10,000, on the pair in
 * view. The clock and the AI run once a second while the tab is hidden too.
 */
function Game({ venue, symbol, label, base, quote }: Props) {
  const [saved, setSaved, savedRef] = useLive<Saved>(load);
  const [amount, setAmount] = useState('1000');
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [now, setNow] = useState(Date.now);
  const lastSave = useRef(0);
  const g = saved.game;
  const here = !!g && g.venue === venue && g.symbol === symbol;
  const hereRef = useRef(here);
  hereRef.current = here;

  const commit = useCallback((next: Saved, persist = true) => {
    setSaved(next);
    if (persist) { save(next); lastSave.current = Date.now(); }
  }, [setSaved]);

  // the game clock: the AI looks at the book, the money curve is sampled, the game ends on time
  useEffect(() => {
    const step = () => {
      const t = Date.now();
      setNow(t);
      const s = savedRef.current;
      const cur = s.game;
      if (!cur || cur.result) { gameBadgeStore.set(null); return; }
      const left = cur.endsAt - t;
      gameBadgeStore.set(left > 60_000 ? `${Math.ceil(left / 60_000)}m` : `${Math.max(0, Math.ceil(left / 1000))}s`);
      // away from the game's pair the AI waits too (it can't see that book); the clock still runs
      const q = hereRef.current ? quoteNow() : { bid: NaN, ask: NaN, live: false };
      const st = statsStore.get();
      const pats = st && st.patterns.symbol === cur.symbol ? st.patterns.list : [];
      const next = tick(cur, t, q.live ? q.bid : NaN, q.live ? q.ask : NaN, pats, st?.patterns.candles ?? 0);
      if (next === cur) return;
      if (next.result && !cur.result) {
        const r = next.result;
        const results = [...s.results, { at: r.at, label: r.label, minutes: r.minutes, you: r.you, ai: r.ai, winner: r.winner }];
        commit({ ...s, game: next, results });
        toast(r.winner === 'you' ? `You won the game: ${usd(r.you)} to ${usd(r.ai)}` : r.winner === 'ai' ? `The AI won the game: ${usd(r.ai)} to ${usd(r.you)}` : 'The game is a tie', r.winner === 'you' ? 'ok' : 'info', 6000);
        return;
      }
      const traded = next.trades.length !== cur.trades.length;
      commit({ ...s, game: next }, traded || t - lastSave.current > 5000);
    };
    step();
    const id = setInterval(step, 1000);
    return () => clearInterval(id);
  }, [commit, savedRef]);

  // another tab of the app playing too: follow its game
  useEffect(() => {
    const f = (e: StorageEvent) => { if (e.key === GAME_KEY) setSaved(parseSaved(e.newValue)); };
    addEventListener('storage', f);
    return () => removeEventListener('storage', f);
  }, [setSaved]);

  const dollar = isDollar(quote);
  function start() {
    if (!symbol || !dollar) return;
    const s = savedRef.current;
    commit({ ...s, game: newGame({ venue, symbol, label, base, minutes: s.minutes, now: Date.now() }) });
    setConfirmEnd(false);
  }
  function endNow() {
    const s = savedRef.current;
    const cur = s.game;
    if (!cur || cur.result) return;
    const q = here ? quoteNow() : { bid: cur.curve[cur.curve.length - 1]?.price ?? NaN };
    const next = finish(cur, q.bid, Date.now());
    const r = next.result!;
    commit({ ...s, game: next, results: [...s.results, { at: r.at, label: r.label, minutes: r.minutes, you: r.you, ai: r.ai, winner: r.winner }] });
    setConfirmEnd(false);
  }
  function order(side: 'buy' | 'sell', all = false) {
    const s = savedRef.current;
    const cur = s.game;
    if (!cur || cur.result || !here) return;
    const q = quoteNow();
    if (!q.live) { toast('The book is not live: orders wait until it is', 'warn'); return; }
    const want = Number(amount);
    const size = side === 'buy' ? (all ? cur.you.cash : want) : (all ? cur.you.qty : Math.min(cur.you.qty, want / q.bid));
    const next = trade(cur, 'you', side, size, q.bid, q.ask, Date.now());
    if (!next) { toast(side === 'buy' ? `Can't buy: orders start at ${usd(MIN_ORDER)} and you have ${usd(cur.you.cash)} cash` : `Can't sell: you hold ${qtyFmt(cur.you.qty)} ${cur.base}`, 'warn'); return; }
    commit({ ...s, game: next });
  }

  const results = saved.results;
  const rec = record(results);

  return (
    <div className="game scope">
      <section>
        <h2>Trading game {results.length > 0 && <span className="rec" title="Your record against the AI">{rec.wins}W · {rec.losses}L{rec.ties ? ` · ${rec.ties}T` : ''}</span>}</h2>
        {g && !g.result ? <Running g={g} here={here} now={now} amount={amount} setAmount={setAmount} order={order}
          confirmEnd={confirmEnd} setConfirmEnd={setConfirmEnd} endNow={endNow} />
          : (
            <>
              {g?.result && <ResultCard g={g} />}
              <p className="dim small">You and the AI each get {usd(START_CASH)} of play money on <b>{label}</b> on {venueName(venue)}. Trade at the live book: buys fill at the best ask, sells at the best bid, {(FEE * 100).toFixed(1)}% fee each way. When time runs out everything is sold at the bid and whoever has more dollars wins.</p>
              <p className="dim small">The AI trades on the app's own signals: patterns on the chart's latest candles, plus the trend and RSI of the prices it watches during the game. It cuts losses at 0.6%.</p>
              <div className="row">
                <div className="seg" role="group" aria-label="Game length">
                  {DURATIONS.map((m) => (
                    <button key={m} className={saved.minutes === m ? 'on' : undefined} aria-pressed={saved.minutes === m}
                      onClick={() => commit({ ...savedRef.current, minutes: m })}>{m} min</button>
                  ))}
                </div>
                <button className="primary" onClick={start} disabled={!symbol || !dollar}>{g?.result ? 'Play again' : 'Start game'}</button>
              </div>
              {!dollar && symbol && <p className="warn small">The game counts in dollars: pick a pair quoted in USD, USDT or USDC.</p>}
            </>
          )}
      </section>
      {g && g.trades.length > 0 && <Trades list={g.trades} base={g.base} />}
      {results.length > 0 && (
        <section>
          <h2>Past games</h2>
          <ul className="past">
            {results.slice().reverse().slice(0, 8).map((r, i) => (
              <li key={i}><span className={`tag ${r.winner}`}>{r.winner === 'you' ? 'Won' : r.winner === 'ai' ? 'Lost' : 'Tie'}</span>
                <span className="dim">{r.label} · {r.minutes} min</span><span className="mono">{usd(r.you)} vs {usd(r.ai)}</span></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

interface RunningProps {
  g: GameState; here: boolean; now: number; amount: string; setAmount: (s: string) => void; order: (side: 'buy' | 'sell', all?: boolean) => void;
  confirmEnd: boolean; setConfirmEnd: (v: boolean) => void; endNow: () => void;
}
function Running({ g, here, now, amount, setAmount, order, confirmEnd, setConfirmEnd, endNow }: RunningProps) {
  const book = useLadder();
  const live = here && !!book && book.status === 'live' && book.bestBid > 0;
  const bid = live ? book!.bestBid : g.curve[g.curve.length - 1]?.price ?? NaN;
  const ask = live ? book!.bestAsk : NaN;
  const you = equity(g.you, bid), ai = equity(g.ai, bid);
  const left = g.endsAt - now;
  const lead = Math.abs(you - ai) < 0.005 ? null : you > ai ? 'you' : 'ai';
  const want = Number(amount);
  const fills = (frac: number) => setAmount((Math.floor(g.you.cash * frac * 100) / 100).toFixed(2));

  return (
    <>
      <div className="clock">
        <span className={`time mono${left < 30_000 ? ' soon' : ''}`} aria-label="Time left">{clock(left)}</span>
        <span className="dim small">{g.label} · {venueName(g.venue)} · {g.minutes} min game</span>
      </div>
      {!here && <p className="warn small">The game is on {g.label} on {venueName(g.venue)}. Switch back to it to trade; the AI waits too, the clock keeps running.</p>}
      <div className="board">
        <Side name="You" w={g.you} value={you} bid={bid} base={g.base} lead={lead === 'you'} />
        <Side name="AI" w={g.ai} value={ai} bid={bid} base={g.base} lead={lead === 'ai'} />
      </div>
      <p className="ai small"><span className="dim">AI's read:</span> {g.mem.view}</p>
      <Curve pts={g.curve} />
      <form className="order" onSubmit={(e) => e.preventDefault()}>
        <label className="amt"><span className="dim small">Amount</span>
          <input className="mono" type="number" min={MIN_ORDER} step="any" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.currentTarget.value)} aria-label="Order amount in dollars" />
          <span className="dim small">USD</span>
        </label>
        <div className="chips">
          {[0.25, 0.5, 1].map((f) => <button type="button" key={f} className="link" onClick={() => fills(f)}>{f === 1 ? 'all cash' : `${f * 100}%`}</button>)}
        </div>
        <div className="btns">
          <button type="button" className="buy" disabled={!live || !(want >= MIN_ORDER) || g.you.cash < MIN_ORDER} onClick={() => order('buy')}>Buy <span className="mono">{fmtPrice(ask)}</span></button>
          <button type="button" className="sell" disabled={!live || g.you.qty <= 0} onClick={() => order('sell')}>Sell <span className="mono">{fmtPrice(bid)}</span></button>
          <button type="button" className="sell ghost" disabled={!live || g.you.qty <= 0} onClick={() => order('sell', true)}>Sell all</button>
        </div>
        {!live && here && <p className="dim small">Waiting for the book to be live.</p>}
      </form>
      <div className="end">
        {confirmEnd
          ? <><span className="small">End now and sell at the bid?</span><button className="link" onClick={endNow}>End game</button><button className="link" onClick={() => setConfirmEnd(false)}>Keep playing</button></>
          : <button className="link" onClick={() => setConfirmEnd(true)}>End game early</button>}
      </div>
    </>
  );
}

function Side({ name, w, value, bid, base, lead }: { name: string; w: GameState['you']; value: number; bid: number; base: string; lead: boolean }) {
  const pl = value / START_CASH - 1;
  const avg = w.qty > 0 ? w.cost / w.qty : NaN;
  return (
    <div className={`side${lead ? ' lead' : ''}`}>
      <div className="who">{name}{lead && <span className="crown" aria-label="leading"> ahead</span>}</div>
      <div className="val mono">{usd(value)}</div>
      <div className={`pl mono ${pl > 0 ? 'up' : pl < 0 ? 'down' : ''}`}>{pct(pl)}</div>
      <div className="small dim mono">{usd(w.cash)} cash</div>
      <div className="small dim mono" title={Number.isFinite(avg) ? `average entry ${fmtPrice(avg)}, now ${fmtPrice(bid)}` : undefined}>{qtyFmt(w.qty)} {base}</div>
    </div>
  );
}

/** Both players' money over the game, from the 5 s samples. */
function Curve({ pts }: { pts: CurvePoint[] }) {
  if (pts.length < 2) return <div className="curve empty dim small">The money chart starts in a few seconds.</div>;
  const W = 300, H = 70;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  let lo = START_CASH, hi = START_CASH;
  for (const p of pts) { lo = Math.min(lo, p.you, p.ai); hi = Math.max(hi, p.you, p.ai); }
  const pad = Math.max((hi - lo) * 0.1, 2);
  lo -= pad; hi += pad;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const line = (k: 'you' | 'ai') => pts.map((p) => `${x(p.t).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
  return (
    <figure className="curve">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Money over the game: you and the AI">
        <line x1="0" x2={W} y1={y(START_CASH)} y2={y(START_CASH)} className="base" />
        <polyline points={line('ai')} className="ai" />
        <polyline points={line('you')} className="you" />
      </svg>
      <figcaption className="small dim"><span className="key you"></span>You <span className="key ai"></span>AI <span className="key base"></span>{usd(START_CASH)} start</figcaption>
    </figure>
  );
}

function Trades({ list, base }: { list: Trade[]; base: string }) {
  return (
    <section>
      <h2>Trades</h2>
      <ul className="trades">
        {list.slice().reverse().slice(0, 40).map((x, i) => (
          <li key={i}>
            <span className={`tag ${x.who}`}>{x.who === 'you' ? 'You' : 'AI'}</span>
            <span className={x.side === 'buy' ? 'up' : 'down'}>{x.side === 'buy' ? 'Buy' : 'Sell'}</span>
            <span className="mono">{qtyFmt(x.qty)} {base} @ {fmtPrice(x.price)}</span>
            <span className="dim small t">{time(x.t)}</span>
            {x.reason && <span className="why dim small">{x.reason}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ResultCard({ g }: { g: GameState }) {
  const r = g.result!;
  const title = r.winner === 'you' ? 'You won' : r.winner === 'ai' ? 'The AI won' : 'A tie';
  const margin = Math.abs(r.you - r.ai);
  return (
    <div className={`result ${r.winner}`} role="status">
      <div className="title">{title}{r.winner !== 'tie' && <span className="dim small"> by {usd(margin)}</span>}</div>
      <div className="mono">You {usd(r.you)} ({pct(r.you / START_CASH - 1)}) · AI {usd(r.ai)} ({pct(r.ai / START_CASH - 1)})</div>
      <div className="dim small">{r.label} · {r.minutes} min · ended at {fmtPrice(r.price)} · {g.trades.filter((t) => t.who === 'you').length} trades by you, {g.trades.filter((t) => t.who === 'ai').length} by the AI</div>
    </div>
  );
}

export default memo(Game);
