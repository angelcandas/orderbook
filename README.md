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

## Choices made so far

The plan left six decisions open. These are the defaults taken to get going;
each is easy to change.

1. UI shell: **Svelte 5**, the lighter of the recommended pair. The hot path is
   framework free.
2. Renderer: **WebGL2**, WebGPU later behind a flag.
3. First release extras: the benchmark corpus and replay, receive-to-pixel
   latency, the visible integrity panel and graceful overload. Latency and the
   integrity panel are in; replay and overload are next.
4. Reference devices: not chosen yet. CI numbers are relative only (no GPU).
5. Results: a static page in this repository.
6. Hosting: needs COOP/COEP headers (`public/_headers` works on Cloudflare
   Pages and Netlify), so not GitHub Pages.

## Tests

```sh
npm test            # book engine, checksum, pattern detectors
npm run typecheck
```
