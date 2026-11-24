# Results

Every number here comes from `npm run bench`, which drives Chromium through
scripted scenarios against the local venue emulator (or a recorded session)
and writes JSON to `bench/results/`. Anyone can re-run it.

## How to read these

- **Level changes/s**: book levels applied per second across all books, both
  venues. One exchange message carries several.
- **Frame p50 / p99**: interval between the render worker's animation frames.
  16.7 ms is a steady 60 Hz.
- **Slow frames**: intervals over 1.5x the median, roughly a missed vsync.
- **Render CPU**: time the render worker spends building and submitting a
  frame. This is the part the app controls.
- **Receive → draw**: from the moment the feed worker reads a socket message
  to the frame that draws it.
- **Checksum / gaps**: Kraken CRC32 failures and Binance sequence gaps. Both
  should be zero.

## Reference machines

Not measured yet. Headline numbers need a real GPU: run
`npm run bench -- --headed --channel chrome` on the machine and commit the
JSON and markdown it writes.

## Cloud container (software GL, relative only)

This is a 4 core VM with no GPU. Chromium renders through SwiftShader, and the
emulator, the browser and its GPU process share the same four cores. Use it to
compare commits, not to judge frame rate.

| Scenario | Level changes/s | Frame p50 / p99 (ms) | Slow frames | Render CPU p50 / p99 (ms) | Receive→draw p50 / p99 (ms) | Parse+apply p99 (ms) | Main long frames | Checksum / gaps |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 pair, 2k/s | 2,029 | 17.9 / 33.3 | 2.39% | 0.26 / 0.66 | 4.1 / 7.5 | 0.800 | 0 | 0 / 0 |
| 10 pairs, 10k/s | 11,636 | 17.9 / 33.3 | 17.45% | 0.36 / 1.22 | 3.2 / 6.9 | 0.513 | 0 | 0 / 0 |
| 10 pairs, 50k/s | 51,661 | 17.9 / 33.3 | 32.45% | 0.36 / 1.22 | 3.4 / 7.5 | 2.238 | 0 | 0 / 0 |
| 25 pairs, 100k/s | 103,338 | 17.9 / 33.3 | 31.36% | 0.36 / 1.45 | 3.2 / 7.5 | 1.663 | 0 | 0 / 0 |
| 10 pairs, 10k/s, CPU 4x slower | 11,708 | 17.9 / 33.3 | 28.88% | 0.33 / 1.22 | 3.2 / 8.9 | 0.611 | 1 | 0 / 0 |

Commit b9a9381, 19 Nov 2026, Chromium 157 headless, 10 s per scenario after a
4 s warmup, 1440x900. Raw data: `bench/results/2026-11-19-cloud-swiftshader.json`.

What this shows:

- **The data path holds at 100,000 level changes per second**: zero checksum
  failures or gaps, receive to draw p99 under 8 ms, and the render worker
  needs under 1.5 ms per frame at p99.
- **The main thread stays idle**: no long animation frames except one under
  4x CPU throttling.
- **Missed frames here come from software rasterization**, not from the app:
  render CPU per frame stays flat from 2k to 100k updates per second while the
  share of 33 ms frames grows with emulator load on the shared cores. A real
  GPU run is needed to confirm the 60 fps target.

### What changed the numbers

| Change | Before | After |
| --- | --- | --- |
| Quads expanded to triangles instead of instanced draws (SwiftShader costs about 25 µs per instance) | 101 ms frames | 17.9 ms frames |
| Per-pane redraw, unchanged panes keep their pixels | all panes every frame | only changed panes |

### Page shell ported from Svelte to React (24 Nov 2026)

The shell around the canvas (top bar, toolbar, side panel, dialogs) moved to
React 19. The feed, analytics, liquidation and render workers are untouched:
their built bundles are byte for byte the same before and after. Same cloud
VM, `npm run bench -- --seconds 8 --warmup 3 --only "10k/s,100k/s"`, two runs
of each build back to back:

| Scenario | Svelte: frame p99 · slow frames · render CPU p99 | React: frame p99 · slow frames · render CPU p99 |
| --- | --- | --- |
| 10 pairs, 10k/s | 17.9 ms · 0.63–0.84% · 1.22–1.33 ms | 17.9 ms · 0.21–0.42% · 1.22 ms |
| 25 pairs, 100k/s | 17.9 ms · 0.63% · 1.22 ms | 16.7–17.9 ms · 0.00–0.63% · 1.45 ms |
| 10 pairs, 10k/s, CPU 4x slower | 33.3 ms · 1.05–2.35% · 1.33–1.58 ms | 17.9 ms · 0.63–0.84% · 1.33–1.45 ms |

Main thread work, from Chrome's performance counters over 15 s at 25 pairs and
50,000 level changes per second with the pointer moving over the charts:

| | Svelte | React |
| --- | ---: | ---: |
| Script time per second | 19–22 ms | 20–24 ms |
| JS heap at the end | 11.5 MB | 4.5 MB |
| Long animation frames | 0 | 0 |

A first cut that kept the live readouts in the shell's own state re-rendered
the whole page four times a second and doubled main thread script time (about
38 ms per second). The engine's 1 Hz stats and 4 Hz book read now sit in small
stores outside React (`src/ui/live.ts`), and only the ticker, status chips,
book table and side panel tabs that show them re-render.
