#!/usr/bin/env node
/**
 * Depthline MCP server: market status, research forecasts and candle charts
 * (PNG) with the app's pattern detection, for Claude Desktop, Claude Code or
 * any MCP client.
 *
 *   npx tsx mcp/server.ts              stdio (Claude Desktop / Claude Code)
 *   npx tsx mcp/server.ts --http 8790  Streamable HTTP on /mcp
 *
 * DEPTHLINE_ENDPOINTS=local uses the repo's emulator instead of the exchanges.
 * See docs/mcp.md.
 */
// every date in replies and charts is UTC, whatever the computer's zone
process.env.TZ = 'UTC';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { PAIRS, INTERVAL_DEFS } from '../src/shared/config';
import { chart, forecast, liquidations, patterns, status } from './analysis';
import { png } from './chart';
import { PERIODS } from './market';

const pair = z.string().describe('Pair or asset, e.g. "BTC", "ETH/USD", "SOLUSDT". A bare asset means its USD pair (USDT on Binance).');
const venue = z.enum(['binance', 'kraken']).optional().describe('Exchange for candles and book. Default binance.');
const interval = z.string().optional().describe(`Candle size: ${INTERVAL_DEFS.map((d) => d.label).join(', ')} (1M = month). Picked automatically from the range when left out.`);
const theme = z.enum(['dark', 'light']).optional().describe('Chart colours. Default dark.');
const period = z.string().optional().describe(`Look-back ending now (or at "to"): ${Object.keys(PERIODS).join(', ')}; in a period "m" means months. Ignored when "from" is given.`);
const from = z.string().optional().describe('Range start, YYYY-MM-DD or ISO date-time (UTC).');
const to = z.string().optional().describe('Range end, YYYY-MM-DD or ISO date-time (UTC). Default now.');

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

function image(svg: string): Content {
  return { type: 'image', data: png(svg, 1.5).toString('base64'), mimeType: 'image/png' };
}

async function run(fn: () => Promise<Content[]>, structured?: () => object) {
  try {
    const content = await fn();
    return { content, ...(structured ? { structuredContent: structured() as Record<string, unknown> } : {}) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = /fetch failed|ENOTFOUND|ECONNREFUSED|abort/i.test(msg) ? ' (the exchange could not be reached from this computer)' : '';
    return { content: [{ type: 'text' as const, text: `Error: ${msg}${hint}` }], isError: true };
  }
}

export function build(): McpServer {
  const server = new McpServer(
    { name: 'depthline', version: '0.1.0' },
    {
      instructions:
        'Crypto market data from public Kraken and Binance feeds, analysed with the Depthline app\'s own pattern detectors, research forecast and liquidation model. '
        + 'Start with market_status for a quick read. Use price_chart for the last day, week, month or year; pattern_chart for patterns between two dates; forecast for a probabilistic range. '
        + 'Charts come back as PNG images with numbered pattern labels that match the text. Everything is research, not financial advice: say so when you pass numbers on.',
    },
  );

  server.registerTool('list_markets', {
    title: 'List markets',
    description: 'The pairs, candle intervals and look-back periods this server knows. Any Binance spot pair or Kraken pair also works by name.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => ({
    content: [{
      type: 'text', text: [
        `Built-in pairs: ${PAIRS.map((p) => p.label).join(', ')} (any other Binance or Kraken pair works by name too).`,
        `Intervals: ${INTERVAL_DEFS.map((d) => d.label).join(', ')} (1M = month).`,
        `Periods: ${Object.keys(PERIODS).join(', ')} (m = months), or from/to dates.`,
        'Venues: binance (default, full history), kraken (latest 720 bars, older ones from Binance rescaled).',
      ].join('\n'),
    }],
  }));

  server.registerTool('market_status', {
    title: 'Market status',
    description: 'Current price, 1h/24h/7d/30d change, 24h range and volume, volatility, order book spread and depth, trend, patterns of the last 24h, estimated liquidation clusters and a 24-hour research forecast.',
    inputSchema: { pair, venue },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (a) => {
    let data: object = {};
    return run(async () => { const r = await status(a); data = r.data; return [{ type: 'text', text: r.text }]; }, () => data);
  });

  server.registerTool('price_chart', {
    title: 'Price chart',
    description: 'Candle chart (PNG) for a recent period (1d, 1w, 1m, 3m, 1y...) or a date range, with EMA 20/50, volume and numbered pattern markers; optional Bollinger Bands and the estimated liquidation map. Returns the image plus a text summary (open, close, high, low, change, patterns).',
    inputSchema: {
      pair, period, from, to, interval, venue, theme,
      patterns: z.boolean().optional().describe('Mark detected patterns. Default true.'),
      bollinger: z.boolean().optional().describe('Draw Bollinger Bands 20, 2. Default false.'),
      liquidations: z.boolean().optional().describe('Draw the estimated liquidation map at the right edge. Default false.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (a) => {
    let data: object = {};
    return run(async () => { const r = await chart(a); data = r.data; return [image(r.svg), { type: 'text', text: r.text }]; }, () => data);
  });

  server.registerTool('pattern_chart', {
    title: 'Patterns in a date range',
    description: 'Find chart patterns (double tops, head and shoulders, triangles, wedges, flags, cup and handle...) and candlestick signals that start and end inside a date range, the way the app\'s analysis window does, and draw them on a PNG chart with the range shaded. Returns the image and a plain-language explanation of each pattern: what it means, whether it is confirmed, target, stop and how it played out.',
    inputSchema: {
      pair, from, to, period, interval, venue, theme,
      kinds: z.enum(['all', 'chart', 'candle']).optional().describe('all (default), chart (multi-bar formations only) or candle (candlestick and volatility signals only).'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (a) => {
    let data: object = {};
    return run(async () => { const r = await patterns(a); data = r.data; return [image(r.svg), { type: 'text', text: r.text }]; }, () => data);
  });

  server.registerTool('forecast', {
    title: 'Research forecast',
    description: 'Where price may close N candles ahead: 80% range, median, chance of closing higher, the indicator factors behind it, warning flags, and an out-of-sample backtest that says whether the model has any edge. Returns a PNG with the forecast cone and the text. Research only.',
    inputSchema: {
      pair, venue, theme,
      interval: z.string().optional().describe('Candle size the forecast runs on. Default 4h.'),
      horizon: z.number().int().min(1).max(200).optional().describe('Candles ahead. Default 20 (the app offers 10, 20, 50).'),
      liquidations: z.boolean().optional().describe('Let estimated liquidation clusters nudge the forecast, as the app does. Default true.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (a) => {
    let data: object = {};
    return run(async () => { const r = await forecast(a); data = r.data; return [image(r.svg), { type: 'text', text: r.text }]; }, () => data);
  });

  server.registerTool('liquidation_levels', {
    title: 'Liquidation levels',
    description: 'Estimated prices where leveraged Binance futures positions would be liquidated: the largest long and short clusters and the biggest rows each side.',
    inputSchema: { pair, interval: z.string().optional().describe('Bar size the map is rebuilt from (1D at most). Default 1h.') },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (a) => {
    let data: object = {};
    return run(async () => { const r = await liquidations(a); data = r.data; return [{ type: 'text', text: r.text }]; }, () => data);
  });

  return server;
}

async function main(): Promise<void> {
  const k = process.argv.indexOf('--http');
  if (k < 0) {
    await build().connect(new StdioServerTransport());
    return;
  }
  const port = Number(process.argv[k + 1] ?? process.env.PORT ?? 8790);
  const host = process.env.HOST ?? '127.0.0.1';
  // stateless: a fresh server and transport per request
  const http = createServer(async (req, res) => {
    if (!req.url?.startsWith('/mcp')) { res.writeHead(404).end('MCP endpoint is /mcp'); return; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end('bad JSON'); return; }
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  http.listen(port, host, () => console.error(`depthline MCP on http://${host}:${port}/mcp`));
}

if (process.argv[1] && /server\.(ts|js|mjs)$/.test(process.argv[1]) && process.argv[1].includes('mcp')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
