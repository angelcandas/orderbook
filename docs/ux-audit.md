# UI/UX audit and revamp (November 2026)

An audit of Depthline as it stood after PR #17, the competitor set it was
compared against, and the 30 changes this revamp makes. Performance was the
constraint throughout: every canvas change is a few extra quads or glyphs per
pane redraw, and the frame budget is unchanged (numbers at the end).

## Audit: what stood out

1. **No price where traders look first.** The header held a form (Source,
   Venue, Pair, Group, Candles, Load) but not the price. Every exchange
   terminal leads with symbol, last price, 24 h change, high, low and volume.
2. **Developer controls compete with trading controls.** "Source: local
   emulator" and "Load: pairs per venue" sat beside the pair and candle size
   with the same weight. They are benchmark settings and belong behind a gear.
3. **Candle size was a dropdown of 13 values.** The most used sizes need one
   click (TradingView, Binance, Kraken Pro all pin 5 to 7 of them).
4. **The side panel was one long scroll** of seven sections: alerts, feed
   integrity, performance, indicators, patterns, liquidations, signals, options
   plus a paragraph of help. Finding the pattern list meant scrolling past
   twelve rows of counters. Indicators appeared twice (menu and panel).
5. **Health was invisible until scrolled to.** For a product whose point is
   performance, the frame rate and feed status were buried. A status dot and an
   fps chip in the bar make them always visible and cost nothing.
6. **Chart reading lacked the basics:** no OHLC legend on the left, no price
   or time label on the crosshair, no countdown to the candle close, the live
   price tag was always blue regardless of direction, and once scrolled back
   there was no way back to live except the "fit" button.
7. **The ladder showed numbers but not meaning:** no units on the columns, no
   direction on the mid, no hint of large resting orders, and no answer to
   "what does it cost to take liquidity down to here", which Binance and Bybit
   show on hover.
8. **The depth chart tooltip** gave price and cumulative size only, with no
   value or distance from the mid, and the pane header said only "DEPTH".
9. **Grouping was in ticks** ("10 ticks") instead of prices ("1", "10").
10. **No keyboard path.** Pair search, candle size and venue all needed the
    mouse; there was no shortcut list.
11. **Theme ignored the system** and the toggle label said the opposite of the
    current state ("Light" while dark).
12. **Loading and empty states were silent:** a pair a venue does not list
    showed a red pill in the side panel, but nothing on the chart, and nothing
    offered the other venue.
13. **Feedback for actions was ad hoc** (a "Copied" button label, nothing for
    reset layout).
14. **Mobile** stacked a five-row header of selects above the chart.

## Competitor set

TradingView (chart conventions: legend, crosshair labels, countdown, shortcuts,
go-to-realtime button), Binance and Bybit spot/futures (ticker bar, ladder
hover cost, buy/sell ratio bar, last-price arrow, tab title price), Kraken Pro
(ticker strip, grouping by price step, compact tabs), Hyperliquid (dense
single-screen layout, status in the chrome), Bookmap (large order emphasis),
Coinglass (liquidation context), Coinbase Advanced (depth chart readouts).

## The 30 changes

Page shell (Svelte, main thread):

1. **Design tokens**: layered surfaces (bg, panel, raised, hover), three text
   weights, radii and a spacing scale, with dark and light palettes matched in
   the canvas theme.
2. **Ticker bar**: pair, venue, big live mid coloured by its last move, 24 h
   change and %, 24 h high, low and base volume (from the candles), spread in bp.
3. **Live price in the browser tab title**, updated at most once a second.
4. **Feed status chip** (dot + venue + state) in the bar; click opens Health.
5. **Performance chip**: fps and receive-to-draw latency, always visible.
6. **Pinned candle sizes** (1m 5m 15m 1h 4h 1D) as a segmented control, the
   other seven under "More".
7. **Settings popover** for Source, Load, text size, theme, reduced motion,
   text table and reset: developer controls out of the main bar.
8. **Theme follows the system** by default; cycle system, dark, light.
9. **Icon set** (inline SVG, no font) for the bar and tabs.
10. **Tabbed side panel**: Patterns, Alerts, Liquidations, Indicators, Health.
    Panels stay mounted so alerts keep checking on any tab.
11. **Collapsible side panel** for a full width chart.
12. **Keyboard shortcuts**: `/` or Ctrl K pair search, 1 to 6 candle sizes,
    `,` `.` step size, V venue, F fit, W window, E explain, I indicators,
    P patterns, L liquidations, B panel, T theme, Esc closes.
13. **Shortcut sheet** on `?`.
14. **Toasts** for copy, reset, toggles and errors (aria-live).
15. **Connecting / not listed overlay** on the chart, with one click to the
    venue that does list the pair.
16. **Grouping by price step** ("0.1", "1", "10") from the instrument's tick.
17. **Accessibility**: one keyboard focus ring, skip link to the text table,
    proper tabs and pressed states, badges for pattern count and feed alarms.
18. **Mobile layout**: two-row bar (pair and actions, then venue and ticker),
    scrollable chip toolbar, larger touch targets.
19. **Remembered chrome**: theme mode, panel open and tab in
    `localStorage` (`depthline.ui.v1`), next to the existing view and chart prefs.

Canvas (render worker):

20. **OHLC legend** top left of the candles with change from the previous close,
    % and volume; follows the crosshair, else shows the newest candle.
21. **Crosshair labels**: price on the price axis, date and time on the time strip.
22. **Candle close countdown** under the live price tag (calendar months for 1M).
23. **Price tag and line coloured** by the forming candle's direction.
24. **"LIVE >>" button** when scrolled back into history; one click returns.
25. **Column units** on the ladder: PRICE USD, SIZE BTC, TOTAL BTC.
26. **Large orders marked**: levels at 3× the average visible size get an edge
    marker and an amber size.
27. **Mid arrow and colour** on the spread row, from the last mid move.
28. **Buy / sell share** labelled on the imbalance bar (B 54% · 46% S).
29. **Depth chart readouts**: mid and spread in the pane header; hover shows
    price, cumulative size, value and distance from the mid.
30. **Ladder hover cost**: hovering a row highlights the levels between it and
    the touch and shows average fill price, total size and value.

## Performance

Same machine, same headless SwiftShader harness (`npm run bench`, 10 s per
scenario after 5 s warm-up, 1440×900), before and after:

| Scenario | Frame p50 / p99 before | after | Render CPU p99 before | after | Receive→draw p50 before | after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 pair, 2k/s | 17.9 / 17.9 | 17.9 / 17.9 | 1.02 | 1.02 | 3.8 | 4.1 |
| 10 pairs, 10k/s | 17.9 / 17.9 | 17.9 / 17.9 | 1.12 | 1.12 | 3.2 | 2.9 |
| 10 pairs, 50k/s | 17.9 / 17.9 | 16.7 / 16.7 | 1.12 | 1.02 | 3.4 | 3.4 |
| 10k/s, CPU 4× slower | 17.9 / 17.9 | 17.9 / 17.9 | 1.02 | 1.22 | 3.2 | 3.2 |

SwiftShader numbers compare commits, not devices. The one structural cost is
that the candle pane now redraws at least once a second (the countdown), which
is one pane redraw of ~0.2 ms per second when the book is idle. The ticker
reads the book the page already polls at 4 Hz for the text table; no new
messages run on the hot path.
