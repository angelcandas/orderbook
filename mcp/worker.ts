/**
 * The Depthline MCP server as a Cloudflare Worker: stateless Streamable HTTP
 * on /mcp, served at https://orderbookmcp.aiwilltrade.com/mcp so claude.ai
 * can add it as a custom connector. Same tools as the Node entry (tools.ts);
 * charts go through resvg's wasm build with Inter bundled, since a Worker has
 * no system fonts or native modules. Deployed by .github/workflows/deploy.yml.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
// wrangler imports .wasm as a compiled module and .ttf as bytes (rules in wrangler.toml)
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import interRegular from './fonts/Inter-Regular.ttf';
import interSemiBold from './fonts/Inter-SemiBold.ttf';
import { build } from './tools';

let ready: Promise<void> | null = null;
const fonts = [new Uint8Array(interRegular), new Uint8Array(interSemiBold)];

async function render(svg: string): Promise<string> {
  ready ??= initWasm(resvgWasm);
  await ready;
  const r = new Resvg(svg, { fitTo: { mode: 'zoom', value: 1.5 }, font: { fontBuffers: fonts, defaultFontFamily: 'Inter', loadSystemFonts: false } });
  const png = r.render().asPng();
  r.free();
  // base64 without Buffer: chunked so String.fromCharCode doesn't overflow the stack
  let bin = '';
  for (let i = 0; i < png.length; i += 0x8000) bin += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return btoa(bin);
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
};

function withCors(r: Response): Response {
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

const INFO = `Depthline MCP server: crypto market status, research forecasts and candle charts with chart patterns, from public Binance and Kraken data.

Add it to Claude: claude.ai -> Settings -> Connectors -> Add custom connector -> URL https://orderbookmcp.aiwilltrade.com/mcp
Source and docs: https://github.com/angelcandas/orderbook/blob/main/docs/mcp.md
Not financial advice.
`;

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(INFO, { headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } });
    }
    if (url.pathname !== '/mcp') return new Response('Not found. The MCP endpoint is /mcp\n', { status: 404 });
    // stateless: a fresh server and transport per request, JSON answers (no SSE stream to hold open)
    const server = build(render);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return withCors(await transport.handleRequest(req));
    } catch (err) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(err) }, id: null }), { status: 500, headers: { 'content-type': 'application/json', ...CORS } });
    }
  },
};
