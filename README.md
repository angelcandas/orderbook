# Depthline

A live order book, depth chart and candle chart for Kraken and Binance public
market data, built to stay at a steady frame rate under thousands of book
updates per second, with chart and candlestick pattern detection on top.

The point is performance, and the numbers are part of the product: the side
panel shows them live, and `npm run bench` writes them to JSON.

## Run it

```sh
npm install
npm run dev                         # http://localhost:5173, live Kraken + Binance
```

Offline, or for load tests, run the local venue emulator. It speaks the same
Kraken v2 and Binance protocols the app uses live, from a synthetic market:

```sh
npm run emulator -- --rate 20000 --pairs 10   # level changes per second, per venue
# then open http://localhost:5173/?src=local
```

## Using it

The bar shows the pair, venue and a live ticker (mid, 24 h change, high, low,
volume, spread), the feed status and the frame rate. Candle sizes 1m to 1D are
one click (more under "More"), the side panel has tabs for patterns, alerts,
liquidations, indicators and health, and the gear holds the data source, load
and display settings. Press `?` for keyboard shortcuts (`/` searches pairs,
`1`–`6` pick candle sizes, `V` switches venue, `F` fits every panel). Hover a
book row to see the average price and value of filling down to it. The design
audit behind the layout is in [docs/ux-audit.md](docs/ux-audit.md).

## Pairs and favourites

The Pair picker lists every pair either venue trades, read from the venues
themselves (Kraken's `instrument` channel, Binance's `exchangeInfo`, both in the
feed workers) and cached for a day. Type to search (`eth`, `eth/eur`,
`sol usdt`), filter by quote, and star pairs to keep them as one click chips in
the header; favourites live in `localStorage`. Each venue maps the pair to its
own symbol (`ETH/EUR` is `ETH/EUR` on Kraken, `ETHEUR` on Binance). Where a
venue has no exact listing, USD, USDT and USDC stand in for each other and the
panel says so; otherwise the book shows "not listed". Switching pair
resubscribes only the books that change on the open sockets, with no reconnect.

## Deploy

Pushes to `main` build the app and deploy it to Cloudflare Pages (project
`depthline`) with `.github/workflows/deploy.yml`. `public/_headers` sends
`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`, which the app
needs for SharedArrayBuffer; the workflow checks the live site returns them.
It needs two repository secrets: `CLOUDFLARE_API_TOKEN` (Account, Cloudflare
Pages: Edit) and `CLOUDFLARE_ACCOUNT_ID`. Without them the deploy is skipped.

The site is served at https://orderbook.aiwilltrade.com. The workflow attaches
that domain to the Pages project through the Cloudflare API; the
`aiwilltrade.com` zone needs a proxied `CNAME orderbook -> depthline.pages.dev`.

## How it works

```
 Kraken WS ─▶ feed worker ─┐                       ┌─▶ render worker ─▶ OffscreenCanvas (WebGL2)
                           ├─ SharedArrayBuffer ───┤      ▲
 Binance WS ─▶ feed worker ┘   (seqlock view)      │      │ indicators + patterns
            └─ candles ─────────▶ analytics worker ┘──────┘
 main thread: controls, side panel, text table. No market data on the hot path.
```

- **Feed workers** (one per venue) own the socket, parse, keep the books and
  check integrity. Every message is applied immediately; the screen only sees
  the newest state. Kraken: CRC32 checksum on every update, truncate to the
  subscribed depth, resubscribe on mismatch. Binance: buffer the diff stream,
  REST snapshot, `U`/`u` continuity, resync on gaps, each side capped at 1,000
  levels so ghost levels cannot pile up.
- **Book** (`src/engine/side.ts`): two typed arrays per side, sorted with the
  best price at the tail, so updates near the touch move only a few elements.
  No objects per update.
- **View**: the feed worker publishes the focused book (grouped ladder rows,
  depth curve) at most every 4 ms into a SharedArrayBuffer guarded by a
  sequence lock. Without cross-origin isolation it falls back to transferring
  buffers.
- **Render worker** draws everything with WebGL2 into an OffscreenCanvas: two
  draw calls per pane, text from a glyph atlas, numbers formatted without
  allocating strings. Panes that did not change are not redrawn, and the frame
  is skipped entirely when nothing changed.
- **Analytics worker** turns candles into EMA(20/50), ATR(14) and patterns
  ([docs/patterns.md](docs/patterns.md)) when a candle closes.
- **Price alerts** (`src/alerts/`): levels set in the side panel are kept in
  localStorage and handed to the feed worker of their venue, which checks the
  mid price of each live book every 200 ms on its own timer, never inside the
  per-message path. A hit shows an in-app toast and, if allowed, a desktop
  notification. A pair with an armed alert stays subscribed even when it is not
  on screen. A move that reverses within 200 ms can be missed.
- **Liquidation worker** (`src/workers/liquidation.worker.ts`) is separate from
  the book path and feeds the render worker, which draws liquidation levels as
  green to red bands behind the candles, with the hottest prices labelled and
  real liquidations as squares. Kraken spot has no liquidations, so it always
  uses the pair's Binance USD-M perpetual and the chart rescales onto its own
  price (EUR pairs, USD vs USDT). On a pair or interval change it rebuilds the
  history from futures klines and open-interest history (REST), then follows
  `aggTrade` and `forceOrder` on `wss://fstream.binance.com/market` (the
  unrouted `/stream` URL no longer carries them) and polls open interest. The
  levels are an estimate, as on every public liquidation heatmap: open-interest
  increases become positions at the prices traded, spread over 10/25/50/100x
  leverage, cleared when price trades through them and shrunk when open
  interest falls (`src/liquidation/`). If futures REST is blocked it falls back
  to spot klines and a volume estimate, and the side panel says so. Toggle it in
  the side panel or with `?liq=0`.

## Measurements

| Metric | Where it comes from |
| --- | --- |
| Frame interval, slow frames | `requestAnimationFrame` deltas in the render worker |
| Render CPU per frame | the render worker's own frame time |
| GPU time | `EXT_disjoint_timer_query_webgl2`, when the browser exposes it |
| Receive to draw latency | socket receive time carried in the view, compared at draw |
| Parse and apply time | per message, in the feed worker |
| Main thread long frames | Long Animation Frames (Chrome and Edge) |
| Integrity | checksum failures, sequence gaps, resyncs, crossed books |

All histograms are fixed log-linear buckets in typed arrays, so measuring
does not allocate.

### Benchmarks

```sh
npm run build
npm run bench                                  # 5 scenarios, 2k to 100k level changes/s
npm run bench -- --headed --channel chrome     # on a machine with a real GPU
```

Results and how to read them: [docs/results.md](docs/results.md).

### Record and replay real sessions

```sh
npm run record -- --minutes 10 --pairs 5 --out recordings/btc.jsonl   # needs exchange access
npm run replay -- --file recordings/btc.jsonl --speed 10              # serves it on :8787
npm run bench -- --replay recordings/btc.jsonl --speeds 1,10,100
```

The replay server rebuilds every book from the recording, so clients that join
mid-stream get a snapshot with a valid Kraken checksum and the right Binance
update id, then the recorded messages unchanged.

## Choices made so far

The plan left six decisions open. These are the defaults taken to get going;
each is easy to change.

1. UI shell: **React 19** (Angel's pick, 24 Nov 2026: the framework exchange
   frontend teams know best). It started as Svelte 5 and was ported with every
   feature and saved setting kept. The hot path is framework free either way:
   the feed, analytics and render workers never touch React.
2. Renderer: **WebGL2**, WebGPU later behind a flag.
3. First release extras: the benchmark corpus and replay, receive-to-pixel
   latency, the visible integrity panel and graceful overload. All but
   graceful overload are in.
4. Reference devices: not chosen yet. CI numbers are relative only (no GPU).
5. Results: a static page in this repository.
6. Hosting: needs COOP/COEP headers (`public/_headers` works on Cloudflare
   Pages and Netlify), so not GitHub Pages.

## Tests

```sh
npm test            # book engine, checksum, pattern detectors
npm run typecheck
```
