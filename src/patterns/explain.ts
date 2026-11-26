import type { PatternHit } from './types';
import type { AnalysisWindow, WindowStudy } from './window';
import { needsOf } from './needs';
import { indLabel } from '../indicators/spec';

/** What each pattern is and what it usually implies, in plain words (after docs/patterns.md and its sources). */
const ABOUT: Record<string, string> = {
  'double-top': 'Price rallied to roughly the same high twice and failed both times. Breaking below the low between the two peaks (the neckline) usually starts a decline about as deep as the pattern is tall.',
  'double-bottom': 'Price fell to roughly the same low twice and held both times. Closing above the high between the two troughs (the neckline) usually starts a rise about as large as the pattern is tall.',
  'triple-top': 'Three failed attempts at the same high. A close below the lows between them confirms that sellers have taken over.',
  'triple-bottom': 'Three successful tests of the same low. A close above the highs between them confirms that buyers have taken over.',
  'head-shoulders-top': 'A high (left shoulder), a higher high (head) and a lower high (right shoulder), with a neckline under them. A close below the neckline is a classic topping signal; the target is the head-to-neckline height projected down.',
  'head-shoulders-bottom': 'The mirror image of a head and shoulders top: three lows with the middle one deepest. A close above the neckline signals a bottom; the target is the head-to-neckline height projected up.',
  'rectangle': 'Price bounced between flat support and flat resistance. It says nothing about direction until it closes outside the range; the target is the range height added in the breakout direction.',
  'ascending-triangle': 'Flat resistance with rising lows: buyers keep paying more while sellers hold one price. It usually breaks upward; the target is the triangle height added to the breakout.',
  'descending-triangle': 'Flat support with falling highs: sellers keep asking less while buyers defend one price. It usually breaks downward; the target is the triangle height taken from the breakout.',
  'symmetrical-triangle': 'Lower highs and higher lows squeezing price into a point. Volatility is contracting; the breakout direction decides the trade, and the target is the triangle height from the breakout.',
  'rising-wedge': 'Both trendlines slope up but converge, so each new high gains less. It usually resolves downward, often back to where the wedge began.',
  'falling-wedge': 'Both trendlines slope down but converge, so selling pressure is fading. It usually resolves upward.',
  'flag-bull': 'A sharp rise (the pole) followed by a short, orderly pullback in a small channel. A close above the channel usually continues the rise by about the pole length.',
  'flag-bear': 'A sharp drop (the pole) followed by a short, orderly bounce in a small channel. A close below the channel usually continues the drop by about the pole length.',
  'pennant-bull': 'Like a bull flag, but the pause is a small converging triangle. A breakout upward usually continues the rise by about the pole length.',
  'pennant-bear': 'Like a bear flag, but the pause is a small converging triangle. A breakout downward usually continues the drop by about the pole length.',
  'cup-handle': 'A rounded base (the cup) followed by a small dip (the handle) below the old high. A close above the rim is a bullish continuation signal.',
  'doji': 'Open and close are almost equal: neither buyers nor sellers won this bar. On its own it means indecision; it matters at support, resistance or after a long trend.',
  'dragonfly-doji': 'Sellers pushed price well down, but it closed back at the open. After a decline this is a bullish rejection of lower prices.',
  'gravestone-doji': 'Buyers pushed price well up, but it closed back at the open. After a rise this is a bearish rejection of higher prices.',
  'long-legged-doji': 'A wide range in both directions with the close near the open: strong indecision, often near turning points.',
  'hammer': 'After a decline, a small body near the top with a long lower wick: sellers drove price down but buyers pushed it back. A bullish reversal hint that wants confirmation from the next bar.',
  'hanging-man': 'The same shape as a hammer, but after a rise. It warns that selling appeared intrabar; bearish if the next bar confirms.',
  'inverted-hammer': 'After a decline, a small body near the bottom with a long upper wick: buyers tried to lift price. A tentative bullish reversal hint.',
  'shooting-star': 'After a rise, a small body near the bottom with a long upper wick: buyers lifted price, then sellers pushed it back. A bearish reversal hint.',
  'bullish-engulfing': 'After a decline, an up bar whose body fully covers the previous down bar. Buyers have overwhelmed sellers; a common bullish reversal signal.',
  'bearish-engulfing': 'After a rise, a down bar whose body fully covers the previous up bar. Sellers have overwhelmed buyers; a common bearish reversal signal.',
  'bullish-harami': 'A small up body inside a large down body. The selling has paused; direction afterwards is close to a coin flip, so wait for the next bars.',
  'bearish-harami': 'A small down body inside a large up body. The buying has paused; direction afterwards is close to a coin flip, so wait for the next bars.',
  'piercing-line': 'After a decline, an up bar that opens low and closes above the middle of the previous down bar. Buyers reclaimed more than half the loss; bullish.',
  'dark-cloud': 'After a rise, a down bar that opens high and closes below the middle of the previous up bar. Sellers erased more than half the gain; bearish.',
  'pipe-bottom': 'Two wide bars after a decline: the first closes near its low, the second recovers strongly. A sharp two-bar bullish reversal.',
  'pipe-top': 'Two wide bars after a rise: the first closes near its high, the second falls back hard. A sharp two-bar bearish reversal.',
  'morning-star': 'Three bars after a decline: a big down bar, a small pause bar, then a strong up bar closing well into the first. A classic bullish reversal.',
  'evening-star': 'Three bars after a rise: a big up bar, a small pause bar, then a strong down bar closing well into the first. A classic bearish reversal.',
  'nr4': 'The narrowest range of the last four bars. Volatility is compressed; a move often follows, in the direction of the break of this bar\'s high or low.',
  'nr7': 'The narrowest range of the last seven bars. Volatility is very compressed; watch for a break of this bar\'s high or low.',
  'inside-bar': 'This bar traded entirely inside the previous one. A pause; the break of the mother bar\'s range tends to set the next move.',
  'gap-up': 'The bar opened well above the previous close (more than half an ATR). Strong demand at the open; gaps sometimes get filled later.',
  'gap-down': 'The bar opened well below the previous close (more than half an ATR). Strong supply at the open; gaps sometimes get filled later.',
  // indicator signals (src/patterns/signals.ts)
  'rsi-bull-div': 'Price made a lower low but RSI made a higher low. Selling momentum is fading even though price is still falling; a common early sign of a bottom, stronger when the first low was oversold.',
  'rsi-bear-div': 'Price made a higher high but RSI made a lower high. Buying momentum is fading even though price is still rising; a common early sign of a top, stronger when the first high was overbought.',
  'rsi-hidden-bull-div': 'In an uptrend, price made a higher low while RSI made a lower low. The pullback was deep in momentum terms but shallow in price, which tends to mean the uptrend resumes.',
  'rsi-hidden-bear-div': 'In a downtrend, price made a lower high while RSI made a higher high. The bounce was strong in momentum terms but weak in price, which tends to mean the downtrend resumes.',
  'rsi-failure-swing-bull': "Wilder's failure swing: RSI dropped under 30, bounced, pulled back without going under 30 again, then rose past its bounce high. RSI turned up before price had to, a bottoming signal.",
  'rsi-failure-swing-bear': "Wilder's failure swing: RSI rose over 70, dipped, rallied without reaching 70 again, then fell past its dip low. RSI turned down before price had to, a topping signal.",
  'bb-squeeze-up': 'The Bollinger Bands were the narrowest in about 120 bars (a squeeze, meaning unusually low volatility), and then price closed above the upper band. Volatility expansions after a squeeze often run in the breakout direction; a close back under the middle band undoes it.',
  'bb-squeeze-down': 'The Bollinger Bands were the narrowest in about 120 bars (a squeeze), and then price closed below the lower band. Volatility expansions after a squeeze often run in the breakout direction; a close back over the middle band undoes it.',
  'bb-w-bottom': "John Bollinger's W bottom: a first low outside the lower band, a second low at about the same price that stays inside the band, then a close above the middle band. Weaker selling on the retest; bullish.",
  'bb-m-top': "John Bollinger's M top: a first high outside the upper band, a second high at about the same price that stays inside the band, then a close below the middle band. Weaker buying on the retest; bearish.",
  'bb-rsi-oversold': 'A close below the lower Bollinger Band with RSI under 30, then an up bar closing back inside the band. Price was stretched and sellers ran out; a mean-reversion setup toward the middle band.',
  'bb-rsi-overbought': 'A close above the upper Bollinger Band with RSI over 70, then a down bar closing back inside the band. Price was stretched and buyers ran out; a mean-reversion setup toward the middle band.',
  'macd-bull-div': 'Price made a lower low below zero on MACD, but the MACD line made a higher low. Downward momentum is slowing; often precedes a turn up.',
  'macd-bear-div': 'Price made a higher high above zero on MACD, but the MACD line made a lower high. Upward momentum is slowing; often precedes a turn down.',
  'selling-climax': 'After a steep decline, a wide bar on at least three times the usual volume that closed in its upper half. Panic selling met large buyers; such climaxes often mark the low of a move, at least for a while.',
  'buying-climax': 'After a steep rally, a wide bar on at least three times the usual volume that closed in its lower half. Euphoric buying met large sellers; such climaxes often mark the high of a move, at least for a while.',
  'long-flush': 'A wide down move that ran through a heavy band of estimated long liquidations (at least three times the recent norm), and the bar closed well off its low. Forced selling is done for now and the overhang is cleared; bounces often follow.',
  'short-squeeze': 'A wide up move that ran through a heavy band of estimated short liquidations (at least three times the recent norm), and the bar closed well off its high. Forced buying is exhausted; once the squeeze ends price often gives some back.',
  'liq-sweep-low': 'The wick dipped into the heaviest band of estimated long liquidations below price and the bar closed back above it. Stops and liquidations were taken out (a liquidity grab) and then the market reversed; bullish while the wick low holds.',
  'liq-sweep-high': 'The wick rose into the heaviest band of estimated short liquidations above price and the bar closed back below it. Stops and liquidations were taken out (a liquidity grab) and then the market reversed; bearish while the wick high holds.',
};

export interface ExplainContext {
  /** open time of each candle, indexed like the pattern indices */
  t: ArrayLike<number>;
  /** latest price, for distance to targets */
  last: number;
  decimals: number;
  window: AnalysisWindow | null;
  symbol: string;
  /** candle length in minutes */
  interval: number;
  /** the closer look at the window, when one is drawn */
  study?: WindowStudy | null;
}

export interface Explanation { title: string; summary: string; items: { id: string; heading: string; text: string }[] }

const biasWord = (b: number) => (b > 0 ? 'bullish' : b < 0 ? 'bearish' : 'neutral');

function when(ms: number): string {
  if (!isFinite(ms)) return '?';
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function price(x: number, dp: number): string {
  return x.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function pct(from: number, to: number): string {
  const v = ((to - from) / from) * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

/** One plain-language paragraph per pattern: what it is, where it is, and what it implies now. */
export function explain(ps: PatternHit[], c: ExplainContext): Explanation {
  const dp = c.decimals;
  // neutral candle and volatility signals (doji, inside bars, NR4/NR7) are many and say little: counted, not listed
  const quiet = ps.filter((p) => p.family !== 'chart' && p.bias === 0);
  // newest first, like the side panel
  const items = ps.filter((p) => !quiet.includes(p)).sort((p, q) => q.end - p.end || q.start - p.start).map((p) => {
    const span = p.start === p.end ? `on the bar of ${when(c.t[p.end])}` : `from ${when(c.t[p.start])} to ${when(c.t[p.end])}`;
    const parts: string[] = [];
    parts.push(ABOUT[p.kind] ?? `${p.label}: no description yet.`);
    if (p.family === 'chart') {
      const st = p.status === 'confirmed'
        ? `It is confirmed: price closed beyond the boundary${p.breakout ? ` at ${price(p.breakout.p, dp)} on ${when(c.t[p.breakout.i])}` : ''}.`
        : p.status === 'failed'
          ? `It failed: price broke out the opposite way${p.breakout ? ` at ${price(p.breakout.p, dp)} on ${when(c.t[p.breakout.i])}` : ''}, so its usual reading no longer holds.`
          : 'It is still forming: no candle has closed beyond the boundary yet, so treat it as a possibility, not a signal.';
      parts.push(st);
      if (p.target !== undefined) {
        parts.push(`The measured target is ${price(p.target, dp)} (${pct(c.last, p.target)} from the last price ${price(c.last, dp)}).`);
      }
      if (p.stop !== undefined) parts.push(`A protective stop would sit at ${price(p.stop, dp)}.`);
      parts.push(`Geometric fit: ${Math.round(p.score * 100)}%.`);
    } else if (p.stop !== undefined) {
      parts.push(`The ${p.family === 'signal' ? 'signal' : 'pattern'} is invalidated beyond ${price(p.stop, dp)}.`);
    }
    const OUT: Record<string, string> = {
      hit: 'Since the breakout, price has reached the target.',
      stopped: 'Since the breakout, price hit the stop before the target.',
      open: 'Since the breakout, price has reached neither the target nor the stop.',
    };
    for (const n of (p.note ?? '').split('; ').filter(Boolean)) {
      const o = /^outcome: (\w+)$/.exec(n);
      parts.push(o ? OUT[o[1]] ?? '' : `Note: ${n}.`);
    }
    const need = needsOf(p);
    const shown = [...need.indicators.map((x) => indLabel({ id: '', kind: x.kind, params: x.params, color: 0, on: true })), ...(need.liq ? ['liquidation bands'] : [])];
    parts.push(shown.length ? `Selecting it shows only ${shown.join(', ')} on the chart. ${need.why}` : `Selecting it hides the indicators: ${need.why[0].toLowerCase()}${need.why.slice(1)}`);
    return { id: p.id, heading: `${p.label} (${biasWord(p.bias)}), ${span}`, text: parts.join(' ') };
  });
  if (c.window && c.study) items.unshift({ id: 'window-study', heading: 'Inside the window', text: studyText(c.study, dp) });

  const where = c.window
    ? `inside the window ${when(Math.min(c.window.t0, c.window.t1))} to ${when(Math.max(c.window.t0, c.window.t1))}, between ${price(Math.min(c.window.p0, c.window.p1), dp)} and ${price(Math.max(c.window.p0, c.window.p1), dp)}`
    : 'over the loaded history';
  const bull = ps.filter((p) => p.bias > 0).length, bear = ps.filter((p) => p.bias < 0).length;
  const confirmed = ps.filter((p) => p.family === 'chart' && p.status === 'confirmed');
  let summary: string;
  if (!ps.length) summary = `No patterns were found ${where}. Try a wider window or a shorter candle interval.`;
  else {
    summary = `${ps.length} pattern${ps.length === 1 ? '' : 's'} found ${where}: ${bull} bullish, ${bear} bearish, ${ps.length - bull - bear} neutral.`;
    if (confirmed.length) summary += ` ${confirmed.length} chart pattern${confirmed.length === 1 ? ' is' : 's are'} confirmed by a breakout.`;
    const lean = bull - bear;
    summary += lean > 1 ? ' On balance the signals lean bullish.' : lean < -1 ? ' On balance the signals lean bearish.' : ' The signals are mixed.';
  }
  if (quiet.length) {
    const by = new Map<string, number>();
    for (const p of quiet) by.set(p.label, (by.get(p.label) ?? 0) + 1);
    const list = [...by].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ');
    summary += ` Not listed below: ${list}. These mark indecision or compressed volatility rather than a direction; a move often follows when price leaves their range.`;
  }
  summary += ' These are mechanical detections, not advice.';
  const iv = c.interval === 10080 ? '1W' : c.interval === 43200 ? '1M' : c.interval >= 1440 ? `${c.interval / 1440}d` : c.interval >= 60 ? `${c.interval / 60}h` : `${c.interval}m`;
  return { title: `${c.symbol} ${iv} patterns`, summary, items };
}

/** A paragraph on the window itself: trend, volatility, volume, momentum and levels. */
export function studyText(w: WindowStudy, dp: number): string {
  const parts: string[] = [];
  const dir = w.slopeAtr > 0.05 ? 'up' : w.slopeAtr < -0.05 ? 'down' : 'sideways';
  const fit = w.r2 >= 0.7 ? 'a steady' : w.r2 >= 0.35 ? 'an uneven' : 'a choppy';
  parts.push(`${w.bars} bars, ${w.changePct >= 0 ? '+' : ''}${w.changePct.toFixed(2)}% from first open to last close, between ${price(w.low, dp)} and ${price(w.high, dp)}.`);
  parts.push(dir === 'sideways'
    ? `Price moved sideways (${fit} range, fit of a straight line ${Math.round(w.r2 * 100)}%).`
    : `Price trended ${dir} at ${Math.abs(w.slopeAtr).toFixed(2)} ATR per bar in ${fit} line (fit ${Math.round(w.r2 * 100)}%).`);
  if (isFinite(w.volRatio)) parts.push(`Bars were ${w.volRatio >= 1.15 ? `${w.volRatio.toFixed(1)}x wider` : w.volRatio <= 0.87 ? `${(1 / w.volRatio).toFixed(1)}x narrower` : 'about as wide'} than in the same stretch before the window${isFinite(w.volumeRatio) && w.volumeRatio > 0 ? `, on ${w.volumeRatio.toFixed(1)}x the volume` : ''}.`);
  if (isFinite(w.rsiStart) && isFinite(w.rsiEnd)) {
    const zone = (r: number) => (r >= 70 ? ' (overbought)' : r <= 30 ? ' (oversold)' : '');
    parts.push(`RSI 14 went from ${w.rsiStart.toFixed(0)}${zone(w.rsiStart)} to ${w.rsiEnd.toFixed(0)}${zone(w.rsiEnd)}.`);
  }
  if (isFinite(w.bandWidthRatio)) {
    parts.push(w.bandWidthRatio <= 0.7 ? 'The Bollinger Bands are tighter at the end than on average in the window: volatility is contracting, which often comes before a larger move.'
      : w.bandWidthRatio >= 1.4 ? 'The Bollinger Bands are wider at the end than on average in the window: volatility is expanding.' : '');
  }
  if (w.levels.length) parts.push(`Levels touched more than once: ${w.levels.map((l) => `${price(l.price, dp)} (${l.kind}, ${l.touches} touches)`).join(', ')}.`);
  if (w.liqBelow || w.liqAbove) {
    const f = (x: { price: number; notional: number }) => `${price(x.price, dp)} (about ${compact(x.notional)} estimated)`;
    parts.push(`Heaviest estimated liquidation bands at the window's end: ${[w.liqBelow && `longs below at ${f(w.liqBelow)}`, w.liqAbove && `shorts above at ${f(w.liqAbove)}`].filter(Boolean).join(', ')}. Price is often drawn toward large bands.`);
  }
  parts.push(`Searched with three swing sizes (2, 1.5 and 1 ATR): ${w.counts.chart} chart pattern${w.counts.chart === 1 ? '' : 's'}, ${w.counts.candle} candle signal${w.counts.candle === 1 ? '' : 's'} and ${w.counts.signal} indicator signal${w.counts.signal === 1 ? '' : 's'}.`);
  return parts.filter(Boolean).join(' ');
}

function compact(x: number): string {
  return x >= 1e9 ? `${(x / 1e9).toFixed(1)}B` : x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(0)}k` : x.toFixed(0);
}

/** Plain text, for copying. */
export function explanationText(e: Explanation): string {
  return [e.title, '', e.summary, '', ...e.items.flatMap((i) => [i.heading, i.text, ''])].join('\n').trim();
}
