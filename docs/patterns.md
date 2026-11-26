# Pattern detection

Detection runs in its own worker (`src/workers/analytics.worker.ts`) over up to
4,000 candles, only when a candle closes, and takes about 10 to 20 ms over the
3,000 bar history it loads (measured under Node and headless Chromium against
the emulator). Code: `src/patterns/`.

## History

Live subscriptions only carry a few hundred bars, too few for multi-week
patterns on short intervals, so each series is backfilled over public REST
(`src/feeds/history.ts`) to about 3,000 bars:

- **Binance**: the latest 1,000 klines load first so the chart fills at once,
  then two more pages of 1,000 are fetched backwards with `endTime`.
- **Kraken**: in production the WebSocket OHLC snapshot carries only about
  ten recent bars, and the REST OHLC endpoint stops at the latest 720. Kraken's
  own 720 come from REST (`/0/public/OHLC`, pair names like `XBTUSD`); older
  bars come from the same pair on Binance, rescaled to Kraken's price and volume
  level by the median ratio over the bars both venues share. If Kraken REST is
  unreachable, Binance bars are stitched straight onto the short snapshot. If
  the two don't overlap, nothing is stitched. The side panel says how many bars
  were backfilled and from where.

Backfilled bars survive a reconnect; switching pair or interval loads a fresh
history.

## Sources

- Fidelity, *Identifying Chart Patterns with Technical Analysis* (after
  Kirkpatrick and Dahlquist). Shapes, breakout rules, measuring targets and
  stops for every chart pattern below.
- forex.com: *Doji candle* and *Morning stars*. Doji variants and the morning /
  evening star.
- Six other forex.com pages (11 chart patterns, triangles, hammer, 5-3-1,
  Pine Script, pips) could not be fetched. Their topics are mostly covered by
  the Fidelity guide; the strategy and scripting ideas are listed under
  "Ideas not built yet".

Neither source gives numeric tolerances, so every threshold below is ours and
lives in one place per detector.

## Common rules

| Rule | Value | Where |
| --- | --- | --- |
| Swing pivots | ZigZag, reversal of 2 x ATR(14) | `pivots.ts` |
| "Roughly the same price" | max(0.75 x ATR, 0.2% of price) | `series.ts` `tolerance()` |
| Breakout | first candle **close** beyond the boundary | `chart.ts` `findBreakout()` |
| Stale | no breakout within the pattern's own length: dropped | `chart.ts` `finish()` |
| Protective stop | outside the breakout bar, opposite the breakout (Fidelity) | `chart.ts` `finish()` |
| Overlaps | keep confirmed over forming, then the better geometric fit | `detect.ts` `dedupe()` |

Each chart pattern is reported as `forming` (shape complete, no breakout yet),
`confirmed` (closed beyond the boundary in the expected direction) or `failed`
(broke the other way). The guide stresses that a pattern "is not complete or
activated until an actual breakout occurs", so targets are drawn only once
confirmed.

## Chart patterns

| Pattern | Shape test | Target (Fidelity) |
| --- | --- | --- |
| Double top / bottom | peak, trough, peak within tolerance; height >= 2 ATR; >= 5 bars apart | height from the extreme to the middle trough, from the breakout |
| Triple top / bottom | three extremes within 1.2 x tolerance | height from the extreme to the farthest trough, from the trough line |
| Head and shoulders (and inverse) | head beyond both shoulders by > tolerance; shoulders within 1.5 x tolerance; neckline through the two troughs | head to neckline, projected from the neckline |
| Rectangle | both boundary fits flat (total drift <= tolerance) | height added to resistance / subtracted from support |
| Ascending / descending triangle | one flat side, the other rising / falling, converging | height from the breakout |
| Symmetrical triangle | falling highs and rising lows, converging | height from the breakout, either direction |
| Rising / falling wedge | both sides the same direction, converging; at least 5 touches with 3 on one side (Fidelity) | down: lowest trough; up: height from the breakout |
| Flag / pennant | pole >= 4 ATR within 3 to 8 bars, then 4 to 20 bars in under half the pole, not extending it; pennant if the range narrows | pole height from the bottom (top) of the pennant |
| Cup and handle | two lips within 2 x tolerance, rounded bottom (lowest third lasts >= 25% of the cup, bottom in the middle half), handle pulls back <= half the depth | right lip to cup bottom, from the breakout |

Triangles and rectangles need five pivots, not four. With four, a double top
also fits a triangle, and the guide treats them as different patterns.

Ascending and descending triangles "can break either way"; a break against the
usual direction is kept as confirmed with a note rather than called a failure.

The side panel also shows, for this history, how many confirmed patterns of
each kind reached their target before their stop. That is a sample of the
candles on screen, not a backtest.

## Candle and volatility patterns

| Pattern | Rule |
| --- | --- |
| Doji | body <= 10% of range. Dragonfly: upper shadow <= 10%, lower >= 60%. Gravestone: the mirror. Long-legged: both shadows >= 30% and range >= 1.5 x the 10 bar mean |
| Hammer / hanging man | lower shadow >= 2 x body, upper <= 10% of range; hammer after a decline, hanging man after a rise |
| Inverted hammer / shooting star | the mirror |
| Engulfing | opposite colours, second body covers the first, after a trend the other way |
| Harami | big first body (>= 14 bar mean), second body <= half, opposite colour, inside the first |
| Piercing line / dark cloud cover | standard definitions (close past the midpoint of the prior body). The Fidelity deck's wording of these two looked inconsistent, so we used the usual ones |
| Morning / evening star | long first body, small middle body (<= 35%) beyond the first close, third closes past the midpoint of the first; "doji star" when the middle is a doji |
| Two-bar reversal (pipe) | two bars with range > 1.5 x mean, first closes in its bottom quarter, second in its top half (and the mirror) |
| Inside bar, NR4, NR7 | range inside the prior bar; narrowest of 4 / 7 |
| Gap | open more than 0.5 ATR from the prior close. Rare on 24/7 crypto venues |

"Trend" means the close moved at least 1 ATR over the previous 6 bars. Crypto
markets rarely gap, so star patterns accept a small body that sits beyond the
first close instead of a true gap.

## Ideas not built yet

- Fibonacci retracement overlay on the last swing (38.2, 50, 61.8, 78.6), and
  confluence: rank a candle signal higher when it sits on a Fibonacci level or
  near support or resistance.
- Alerts when a pattern changes state, with a sound or notification.
- A small user formula language for indicators and alerts, in the spirit of
  Pine Script, evaluated in the analytics worker.
- Spread shown in ticks ("pips") as well as basis points.

## Analysis window and explanations

Drag a box over the candle chart (the **window** button over the chart, or
shift+drag at any time) to search for patterns only inside it. Detection then
runs over the bars in the box, plus up to 60 bars before it that only warm up
ATR, EMAs and average bodies (`src/patterns/window.ts`); a pattern must start
inside the box, and its prices must overlap the box's price band. The box is
kept in candle times and prices, so it stays put while new candles arrive and
across interval changes, and is cleared on a pair or venue switch. **clear**
goes back to the whole history.

**explain** (over the chart, or under *Chart patterns*) writes a plain-language
note per pattern: what the shape is and usually implies, when it formed, whether
it is forming, confirmed or failed, the breakout, the measured target with its
distance from the last price, the stop, and how it played out since
(`src/patterns/explain.ts`). Neutral candle and volatility signals (doji, inside
bars, NR4 / NR7) are counted in the summary rather than listed. Without a window
it covers the chart patterns and the latest twelve directional candle signals.
The text is generated locally from fixed templates, not by a language model.

### A closer look inside the window

Inside a drawn window the search goes deeper than on the full chart
(`detectInWindow` passes `fine: true` to `detect`):

- chart patterns are searched on three swing sizes, zigzag pivots of 2, 1.5 and
  1 ATR, with the minimum heights of tops, bottoms and cups scaled to match.
  Smaller-swing finds that repeat a larger one of the same kind are dropped; the
  rest are marked "smaller swings (N ATR pivots)";
- candle patterns and indicator signals are kept for every bar of the window,
  not only the latest 150;
- the window itself is studied (`study()`): bars and change, the trend slope in
  ATR per bar and how straight it is (R squared), bar width and volume against
  the same stretch before the window, RSI at both ends, whether the Bollinger
  Bands are tightening, price levels touched by two or more 1 ATR swings, and the
  heaviest estimated liquidation bands either side at the window's end. This is
  the first paragraph of the explanation, "Inside the window".

### Indicators while a pattern is explained

Clicking a pattern or signal in the explanation highlights it and swaps the
chart's indicators for the ones it is computed from (`src/patterns/needs.ts`),
with the detector's own parameters: RSI 14 for RSI signals, Bollinger 20 / 2,
MACD 12 / 26 / 9, volume with its 20-bar average, ATR 14 for chart and candle
patterns (they are sized in ATR), nothing for NR4 / NR7 / inside bars, and the
liquidation bands for the liquidation signals. The user's own indicators are not
changed or saved over: deselecting the pattern or closing the explanation
removes the pattern's indicators and brings them back.

## Indicator signals

Twenty setups in `src/patterns/signals.ts` (family `signal`, listed under
*Indicator signals* in the side panel and drawn as markers, with their swing
lines when they have them). Thresholds are ours unless noted; the tests in
`test/signals.test.ts` pin them.

| Signal | Inputs | Rule |
|---|---|---|
| RSI bullish / bearish divergence | RSI 14, 1.5 ATR swings | consecutive swing lows (highs) 5 to 80 bars apart; price lower low (higher high), RSI higher low (lower high) by 3+ points; first RSI under 40 (over 60) |
| RSI hidden bullish / bearish divergence | RSI 14, EMA 50 | higher low with a lower RSI low above EMA 50 (mirror below) |
| RSI failure swing, bottom / top (Wilder) | RSI 14 | RSI under 30, bounce, pullback that stays over 30, then RSI clears the bounce high within 30 bars (mirror at 70) |
| Squeeze breakout up / down | Bollinger 20 / 2 | band width within 5% of its 120-bar low in the last 10 bars, then the first close outside a band |
| Bollinger W bottom / M top (Bollinger) | Bollinger 20 / 2 | first swing outside the band, retest at about the same price inside it, close past the middle band within 20 bars |
| BB + RSI oversold / overbought reversal | Bollinger 20 / 2, RSI 14 | close outside the band with RSI under 30 (over 70), next bar closes back inside in the opposite colour |
| MACD bullish / bearish divergence | MACD 12 / 26 / 9 | lower low (higher high) in price, MACD line higher (lower) by 0.1 ATR, first one below (above) zero |
| Selling / buying climax | volume SMA 20, ATR 14 | volume 3x average on a bar 1.5x the average range after a 3 ATR move over 10 bars, closing in the half opposite the move |
| Long liquidation flush / short squeeze exhaustion | liquidation map | estimated liquidations traded through by the bar 3x their 50-bar mean, bar 1.3x the average range, closing 40% off its extreme |
| Liquidity sweep below / above | liquidation map | the wick enters the heaviest band within 8% of the open (2x the average band) and the bar closes back on the near side with a 30% wick |

Liquidation signals read the estimated map the chart draws as bands
(`src/patterns/liq.ts`): the liquidation worker sends a copy of each frame and
tail to the analytics worker, which reduces each column to the notional the bar
traded through (longs below the prior close, shorts above) plus Binance's
actual liquidation prints, and the heaviest band either side of the open. They
are estimates; without the map (futures data unreachable) these signals stay
silent.
