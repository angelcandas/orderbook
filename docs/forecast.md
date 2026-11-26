# Research forecast

**Research only. Not financial advice.** The Forecast tab is a small statistical
model you can read end to end in `src/forecast/forecast.ts`. It tests itself on
the history it is shown and says when it has no edge.

## What it shows

For a length of 5, 10, 20, 50, 100 or 200 candles of the chart's current size, or
any custom whole number from 1 to 1000 (type it in the box and press Enter; the
MCP `forecast` tool takes the same range):

| Output | How it is made |
| --- | --- |
| **Chance higher** | Share of past candles with a similar indicator score that closed higher `horizon` candles later, smoothed towards the overall rate (20 pseudo samples). |
| **Top / bottom** | 90th and 10th percentile of past `horizon`-candle moves, each divided by the volatility at the time, then multiplied by today's volatility (std of log returns over 50 candles). So about 80% of closes should land inside. |
| **Median** | 50th percentile of the same moves. |
| **Up / down room** | (top − last) ÷ (last − bottom). |
| **Flags** | Buy lean, sell lean, no clear edge / no tested edge, overbought, oversold, outside Bollinger, volatility squeeze, liquidations above or below. |

## The score

Four readings, each from −1 (bearish) to +1 (bullish), weighted and summed:

| Reading | Weight | Rule |
| --- | --- | --- |
| Trend | 0.35 | tanh((EMA 20 − EMA 50) ÷ ATR 14 ÷ 2) |
| Momentum | 0.25 | tanh(MACD 12/26/9 histogram ÷ ATR × 2) |
| RSI 14 | 0.20 | above 70 leans down, below 30 leans up, between: (RSI − 50) ÷ 40 |
| Bollinger 20, 2 | 0.20 | outside a band leans back in; inside, a mild lean with the position |

The score is bucketed at −0.5, −0.2, 0.2, 0.5 and each bucket's up-rate is learned.

Live only, not backtested (no history for them here), each capped at ±4 points:

- **Patterns**: confirmed and forming chart patterns that ended in the last 30
  candles (weighted by fit; forming counts half), candle signals on the last 3.
- **Liquidations**: the largest long and short clusters from the Liquidations tab
  that fall inside the forecast range. The nearer and larger side pulls.

## The backtest

Learn on the first half of the history, score the second half:

- **Inside the range**: share of closes inside the 10th–90th range (aim 80%).
- **Direction right**: share where the learned chance (above 50% means up) called
  the direction.
- **Always guessing up/down**: the same for always calling the first half's usual
  direction.

There is **no buy or sell lean** unless the model beat always guessing by at least
2 points over at least 100 candles and at least 5 separate (non-overlapping) outcomes. Then a buy lean needs a chance of 58% or more
and more room up than down; a sell lean needs 42% or less and more room down.
"Strong" means 65% / 35%.

## Limits

- One market's own history. Regimes change; past rates are not future rates.
- Candles only: no order flow, funding, news or cross-market data.
- The liquidation map itself is an estimate (see the Liquidations tab).
- Up to 4000 candles; at 1W or 1M, or for long lengths, there may not be enough
  history and the panel says so.
- Long lengths overlap: a 200-candle forecast checked on 1400 candles has only 7
  separate outcomes. The panel shows "separate outcomes" (windows checked ÷ length)
  and gives no lean below 5; under 10 it flags "Few separate outcomes".
