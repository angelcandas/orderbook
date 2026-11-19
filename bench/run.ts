/**
 * Benchmark harness: builds nothing, starts the venue emulator (or a replay)
 * and `vite preview`, drives Chromium through each scenario with Playwright,
 * and writes one JSON result plus a markdown table.
 *
 *   npm run build && npm run bench                      # all scenarios, 20 s each
 *   npm run bench -- --seconds 10 --only 10k,50k        # subset
 *   npm run bench -- --headed --channel chrome          # real GPU on your machine
 *   npm run bench -- --replay recordings/x.jsonl --speeds 1,10,100
 *
 * Headless Chromium in CI renders with SwiftShader (no GPU): use those numbers
 * to compare commits, not as headline figures.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) { args.set(a.slice(2), next); i++; } else args.set(a.slice(2), 'true');
}
const SECONDS = Number(args.get('seconds') ?? 20);
const WARMUP = Number(args.get('warmup') ?? 5);
const PORT = 8790;
const APP = 4173;

interface Scenario { name: string; pairs: number; rate?: number; speed?: number; throttle?: number; batch?: number }
let scenarios: Scenario[] = [
  // rates are totals across both venues (the emulator gets half per venue)
  { name: '1 pair, 2k/s', pairs: 1, rate: 2_000 },
  { name: '10 pairs, 10k/s', pairs: 10, rate: 10_000 },
  { name: '10 pairs, 50k/s', pairs: 10, rate: 50_000, batch: 12 },
  { name: '25 pairs, 100k/s', pairs: 25, rate: 100_000, batch: 25 },
  { name: '10 pairs, 10k/s, CPU 4x slower', pairs: 10, rate: 10_000, throttle: 4 },
];
const REPLAY = args.get('replay');
if (REPLAY) {
  const speeds = (args.get('speeds') ?? '1,10,100').split(',').map(Number);
  const pairs = Number(args.get('pairs') ?? 5);
  scenarios = speeds.map((s) => ({ name: `replay ${s}x`, pairs, speed: s }));
}
if (args.has('only')) {
  const keys = args.get('only')!.split(',');
  scenarios = scenarios.filter((s) => keys.some((k) => s.name.includes(k)));
}

const procs: ChildProcess[] = [];
function start(cmd: string, a: string[], ready: RegExp): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    const t = setTimeout(() => reject(new Error(`${cmd} ${a.join(' ')} did not start`)), 20_000);
    const on = (b: Buffer) => { if (ready.test(b.toString())) { clearTimeout(t); resolve(p); } };
    p.stdout!.on('data', on);
    p.stderr!.on('data', on);
  });
}
const stop = (p: ChildProcess) => new Promise<void>((r) => { p.once('exit', () => r()); p.kill(); });
process.on('exit', () => procs.forEach((p) => p.kill()));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync('dist/index.html')) execSync('npx vite build', { stdio: 'inherit' });
  await start(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(APP), '--strictPort'], /localhost/);

  const browser = await chromium.launch({
    headless: !args.has('headed'),
    channel: args.get('channel'),
    args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const cdp = await page.context().newCDPSession(page);
  const env = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return { ua: navigator.userAgent, gpu: gl ? gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : 'none', dpr: devicePixelRatio, cores: navigator.hardwareConcurrency };
  });
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* not a checkout */ }
  const meta = { date: new Date().toISOString(), commit, host: os.hostname(), os: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0]?.model, ...env, seconds: SECONDS, viewport: '1440x900' };
  console.log(meta);

  const results: any[] = [];
  for (const sc of scenarios) {
    const server = REPLAY
      ? await start(process.execPath, ['--import', 'tsx', 'server/replay.ts', '--file', REPLAY, '--speed', String(sc.speed), '--port', String(PORT)], /replay on/)
      : await start(process.execPath, ['--import', 'tsx', 'server/server.ts', '--rate', String(sc.rate! / 2), '--pairs', String(sc.pairs), '--port', String(PORT), '--kraken-batch', String(sc.batch ?? 4)], /emulator on/);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: sc.throttle ?? 1 });
    await page.goto(`http://localhost:${APP}/?src=local&host=localhost:${PORT}&pairs=${sc.pairs}&interval=1`);
    await page.waitForFunction(() => (window as any).__depthline?.snapshot().render, null, { timeout: 30_000 });
    await sleep(WARMUP * 1000);
    await page.evaluate(() => (window as any).__depthline.resetStats());
    // move the pointer over the charts during the run, like a user would
    const t0 = Date.now();
    let k = 0;
    while (Date.now() - t0 < SECONDS * 1000) {
      await page.mouse.move(500 + ((k * 37) % 800), 100 + ((k * 53) % 700));
      k++;
      await sleep(100);
    }
    const s = await page.evaluate(() => (window as any).__depthline.snapshot());
    const feeds = Object.values(s.feeds) as any[];
    const sum = (f: (x: any) => number) => feeds.reduce((a, x) => a + f(x), 0);
    const r = s.render;
    const row = {
      scenario: sc.name,
      levelsPerSec: Math.round(sum((f) => f.levelsPerSec)),
      msgsPerSec: Math.round(sum((f) => f.msgsPerSec)),
      frameP50: r.frameInterval.p50, frameP99: r.frameInterval.p99, frameMax: r.frameInterval.max,
      slowFramesPct: (100 * r.dropped) / Math.max(1, r.frames),
      renderCpuP50: r.cpu.p50, renderCpuP99: r.cpu.p99,
      latencyP50: r.latency.p50, latencyP99: r.latency.p99,
      parseApplyP99: Math.max(...feeds.map((f) => f.parse.p99 + f.apply.p99)),
      mainLongFrames: s.main.loafCount, mainBlockingMs: s.main.loafBlockingMs,
      heapMB: s.main.heapMB,
      checksumFails: sum((f) => f.counters.checksumFails), gaps: sum((f) => f.counters.gaps), resyncs: sum((f) => f.counters.resyncs),
      raw: { ...s, patterns: { computeMs: s.patterns.computeMs, candles: s.patterns.candles, count: s.patterns.list.length } },
    };
    results.push(row);
    console.log(`${sc.name}: ${row.levelsPerSec} levels/s, frame p50 ${row.frameP50.toFixed(1)} p99 ${row.frameP99.toFixed(1)} ms, slow ${row.slowFramesPct.toFixed(2)}%, render p99 ${row.renderCpuP99.toFixed(2)} ms, latency p50 ${row.latencyP50.toFixed(1)} p99 ${row.latencyP99.toFixed(1)} ms`);
    await stop(server);
  }
  await browser.close();

  const stamp = meta.date.replace(/[:.]/g, '-');
  const out = args.get('out') ?? `bench/results/${stamp}.json`;
  fs.writeFileSync(out, JSON.stringify({ meta, results }, null, 1));
  const f = (x: number, d = 1) => (x ?? 0).toFixed(d);
  const md = [
    `## ${meta.date.slice(0, 16).replace('T', ' ')} UTC · ${meta.commit} · ${meta.gpu}`,
    '',
    `${meta.cpu}, ${meta.cores} cores, ${meta.os}. ${SECONDS} s per scenario after ${WARMUP} s warmup, 1440x900.`,
    '',
    '| Scenario | Level changes/s | Frame p50 / p99 (ms) | Slow frames | Render CPU p50 / p99 (ms) | Receive→draw p50 / p99 (ms) | Parse+apply p99 (ms) | Main long frames | Checksum / gaps |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...results.map((r) => `| ${r.scenario} | ${r.levelsPerSec.toLocaleString('en-US')} | ${f(r.frameP50)} / ${f(r.frameP99)} | ${f(r.slowFramesPct, 2)}% | ${f(r.renderCpuP50, 2)} / ${f(r.renderCpuP99, 2)} | ${f(r.latencyP50)} / ${f(r.latencyP99)} | ${f(r.parseApplyP99, 3)} | ${r.mainLongFrames} | ${r.checksumFails} / ${r.gaps} |`),
    '',
  ].join('\n');
  fs.writeFileSync(out.replace(/\.json$/, '.md'), md);
  console.log('\n' + md);
  console.log(`wrote ${out}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
