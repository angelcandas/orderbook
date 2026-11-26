// wrangler module rules (wrangler.mcp.toml): fonts as bytes, wasm as a compiled module
declare module '*.ttf' { const bytes: ArrayBuffer; export default bytes; }
declare module '@resvg/resvg-wasm/index_bg.wasm' { const mod: WebAssembly.Module; export default mod; }
