#!/usr/bin/env node
/**
 * Depthline MCP server, Node entry: market status, research forecasts and
 * candle charts (PNG) with the app's pattern detection, for Claude Desktop,
 * Claude Code or any MCP client. The tools live in tools.ts; the hosted copy
 * at https://orderbookmcp.aiwilltrade.com/mcp runs worker.ts.
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
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Resvg } from '@resvg/resvg-js';
import { build as buildWith } from './tools';

/** PNG through the native resvg, at 1.5x for sharp text. */
export async function renderNode(svg: string): Promise<string> {
  const r = new Resvg(svg, { fitTo: { mode: 'zoom', value: 1.5 }, font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } });
  return Buffer.from(r.render().asPng()).toString('base64');
}

export const build = () => buildWith(renderNode);

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
