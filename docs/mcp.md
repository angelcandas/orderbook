# Ask Claude about the market (MCP server)

`mcp/server.ts` is a [Model Context Protocol](https://modelcontextprotocol.io) server. Connect it to Claude and you can ask things like:

- "How is BTC doing right now?"
- "Show me ETH over the last week" / "SOL for the last 3 months with Bollinger Bands"
- "Find chart patterns on BTC between 2026-10-01 and 2026-11-15 on the 4h"
- "What's the 4h forecast for ETH for the next 20 candles?"
- "Where are the big liquidation clusters on SOL?"

It uses the app's own code: the pattern detectors and explanations (`src/patterns`), the research forecast (`src/forecast`) and the liquidation model (`src/liquidation`), over the same public Binance and Kraken REST endpoints. No API keys. Charts come back as PNG images that Claude can see and show you.

## Tools

| Tool | What it returns |
|---|---|
| `market_status` | Price; 1h, 24h, 7d and 30d change; 24h range and volume; 7-day volatility; book spread and depth within 1%; trend; patterns of the last 24h; liquidation clusters; a 24-hour research forecast. |
| `price_chart` | Candle chart for a period (`1d`, `1w`, `1m`, `3m`, `6m`, `1y`, `2y`, `5y`; `m` is months) or `from`/`to` dates. EMA 20/50, volume and numbered pattern labels, with optional Bollinger Bands and the liquidation map. Candle size is picked from the range unless you give `interval`. |
| `pattern_chart` | Patterns that start and end inside a date range, found the way the app's drawn analysis window finds them. The range is shaded with some context on either side; each pattern is numbered and explained: what it means, confirmed or forming, target, stop and how it played out. `kinds`: `all`, `chart` (formations only) or `candle`. |
| `forecast` | The app's Forecast tab for any interval and horizon: 80% range, median, chance of closing higher, factors, flags and the out-of-sample backtest, plus a chart with the cone. It gives no buy or sell lean unless the model beat "always guess the majority" out of sample. |
| `liquidation_levels` | Largest estimated long and short liquidation clusters and the biggest rows on each side. |
| `list_markets` | Pairs, intervals and periods it understands. |

Pairs: `BTC`, `ETH/USD`, `SOLUSDT` and so on. A bare asset means its USD pair (USDT on Binance). `venue: "kraken"` uses Kraken's candles and book; Kraken only serves its latest 720 candles over REST, so older ones come from Binance rescaled, as in the app. All times are UTC.

Everything is a mechanical reading of public data, not financial advice.

## Set up

You need Node 20 or newer and a copy of this repository:

```sh
git clone https://github.com/angelcandas/orderbook.git
cd orderbook
npm install
npm run mcp   # should sit silently waiting on stdin; Ctrl+C to stop
```

### Claude Desktop

1. Find the full paths you'll need: run `pwd` in the repo folder, and `which npx` (on Windows `where npx`).
2. In Claude Desktop open **Settings → Developer → Edit Config**. This opens `claude_desktop_config.json`.
3. Add the server (keep any other servers you already have):

   ```json
   {
     "mcpServers": {
       "depthline": {
         "command": "/full/path/to/npx",
         "args": ["tsx", "/full/path/to/orderbook/mcp/server.ts"]
       }
     }
   }
   ```

   Use full paths: Claude Desktop does not read your shell's PATH, so a bare `npx` often fails on macOS (Homebrew or nvm installs).
4. Quit Claude Desktop completely and open it again. "depthline" appears under the tools (sliders) button in a new chat.

### Claude Code

From anywhere:

```sh
claude mcp add depthline -- npx tsx /full/path/to/orderbook/mcp/server.ts
```

Add `--scope user` to have it in every project. `/mcp` inside Claude Code shows whether it connected.

### claude.ai (web and mobile)

claude.ai connects to remote servers over HTTPS, so run the server in HTTP mode and expose it:

```sh
npm run mcp -- --http 8790          # http://127.0.0.1:8790/mcp
cloudflared tunnel --url http://localhost:8790
```

`cloudflared` prints an `https://….trycloudflare.com` address. In claude.ai open **Settings → Connectors → Add custom connector** and enter that address with `/mcp` on the end. A quick tunnel's address changes every time it starts; a named Cloudflare tunnel on your own domain keeps it fixed. The server has no login: anyone with the address can ask it for public market data, nothing else. Set `HOST=0.0.0.0` only if you want it reachable on your network without a tunnel.

## Notes

- **Network:** it needs to reach `data-api.binance.vision` (spot candles and book), `fapi.binance.com` (futures, for liquidations) and `api.kraken.com`. Binance futures is blocked in some countries; liquidation levels then fall back to a volume estimate and say so.
- **Offline / testing:** `npm run emulator` in one terminal and `DEPTHLINE_ENDPOINTS=local npm run mcp` in another runs everything against the repo's synthetic market.
- **Speed:** a status call makes 4 requests; charts 1 to 3 (5,000 candles at most); a forecast loads 1,500 candles.
- **Tests:** `test/mcp.test.ts` runs every tool against a stubbed exchange.
