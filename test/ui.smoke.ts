/**
 * Drives the built page in Chromium against the venue emulator and checks that
 * the shell's features work and that what it remembers survives a reload:
 * shortcuts, overlay toggles, alerts, indicators, favourites, panel resizing,
 * the analysis window, the explain dialog, the trading game, and wheel panning without page scroll.
 *
 *   npm run build && npm run test:ui
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const VENUE = 8793, APP = 4183;
const procs: ChildProcess[] = [];
function start(cmd: string, a: string[], ready: RegExp): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    const t = setTimeout(() => reject(new Error(`${a.join(' ')} did not start`)), 30_000);
    const on = (b: Buffer) => { if (ready.test(b.toString())) { clearTimeout(t); resolve(p); } };
    p.stdout!.on('data', on);
    p.stderr!.on('data', on);
  });
}
process.on('exit', () => procs.forEach((p) => p.kill()));

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
}

async function main() {
  await start(process.execPath, ['--import', 'tsx', 'server/server.ts', '--rate', '2000', '--pairs', '3', '--port', String(VENUE)], /emulator on/);
  await start(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(APP), '--strictPort'], /localhost/);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push(m.text()); });
  const base = `http://localhost:${APP}/?src=local&host=localhost:${VENUE}`;
  const ready = () => page.waitForFunction(() => (window as any).__depthline?.snapshot().render, null, { timeout: 30_000 });
  await page.goto(base);
  await ready();
  await page.waitForFunction(() => document.querySelector('.chip.status')?.textContent?.includes('live'), null, { timeout: 20_000 });
  check('ticker shows a live mid', await page.evaluate(() => /\d/.test(document.querySelector('.ticker .price')?.textContent ?? '')));
  check('tab title carries the price', /^\d[\d,.]* BTC\/USD · Depthline$/.test(await page.title()), await page.title());

  const k = (key: string) => page.keyboard.press(key);
  await k('5'); await k('l'); await k('t'); await k('t'); await k('p');
  check('shortcut 5 picks 4h', (await page.textContent('.seg.tf button.on')) === '4h');
  check('toasts appear', (await page.locator('.toasts .toast').count()) > 0);

  await page.click('#tab-alerts');
  await page.fill('input[aria-label^="Alert price"]', '1');
  await page.click('#panel-alerts form button[type=submit]');
  check('alert added', (await page.locator('#panel-alerts li').count()) === 1);

  await page.click('#tab-game');
  await page.click('#panel-game button[aria-pressed]:has-text("5 min")');
  await page.click('#panel-game .primary');
  check('game starts with a clock', /^\d+:\d\d$/.test((await page.textContent('#panel-game .clock .time')) ?? ''));
  await page.fill('#panel-game input[aria-label="Order amount in dollars"]', '1000');
  await page.click('#panel-game .btns .buy');
  check('game buy fills', (await page.locator('#panel-game .trades li').count()) >= 1);
  check('game cash drops by the order', (await page.textContent('#panel-game .side .small'))?.includes('9,000.00') ?? false, await page.textContent('#panel-game .side .small'));
  check('game tab shows the clock', /\dm$/.test((await page.textContent('#tab-game .badge')) ?? ''));

  await page.click('#tab-ind');
  await page.selectOption('#panel-ind select[aria-label="Add indicator"]', { index: 2 });
  const period = page.locator('#panel-ind input[type=number]').first();
  await period.fill('33');
  await period.press('Enter');
  check('indicator added', (await page.locator('#panel-ind li').count()) === 4);

  await page.click('#tab-forecast');
  check('forecast says research only', /Research only, not financial advice/.test(await page.textContent('#panel-forecast') ?? ''));
  const gotForecast = await page.waitForSelector('#panel-forecast .verdict', { timeout: 20_000 }).then(() => true, () => false);
  check('forecast gives a top, a bottom and a probability', gotForecast && await page.evaluate(() => {
    const t = document.querySelector('#panel-forecast')!.textContent ?? '';
    return /Top/.test(t) && /Bottom/.test(t) && /\d+% chance higher/.test(t);
  }), await page.textContent('#panel-forecast'));
  await page.click('#panel-forecast .seg button:has-text("50")');
  check('forecast horizon switches', (await page.textContent('#panel-forecast .seg button.on')) === '50');
  await page.click('#tab-ind'); // the reload check below expects the Indicators tab

  await page.click('button[aria-label^="Add BTC/USD to favourites"]');
  await page.focus('[aria-label="Resize side panel"]'); await k('ArrowLeft'); await k('ArrowLeft');
  await page.focus('[aria-label^="Resize order book"]'); await k('ArrowRight');
  const ladderShare = await page.evaluate(() => JSON.parse(localStorage.getItem('depthline.view.v1')!).layout.root.kids[0].size);
  check('book resized from the keyboard', Math.abs(ladderShare - 0.28) > 0.005, ladderShare);

  // shift+drag a window over the candle plot, then explain it
  const box = await page.evaluate(() => { const s = document.querySelector('.stage')!.getBoundingClientRect(); return { x: s.x, y: s.y, w: s.width, h: s.height }; });
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + box.w * 0.55, box.y + box.h * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.75, box.y + box.h * 0.8, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(500);
  check('analysis window drawn', (await page.locator('.wintools button', { hasText: 'clear' }).count()) === 1);
  await k('e');
  check('explain dialog opens', ((await page.textContent('#explain-title')) ?? '').includes('patterns'));
  if (await page.locator('.explainer article').count()) {
    await page.locator('.explainer article').first().click();
    check('clicking an explained pattern selects it', (await page.locator('.explainer article.sel').count()) === 1);
  }
  await k('Escape');
  await k('/');
  check('pair search opens', await page.locator('.picker .pop input').isVisible());
  await k('Escape');
  await k('?');
  check('shortcut sheet opens', await page.locator('#help-title').isVisible());
  await k('Escape');

  await page.mouse.move(box.x + box.w * 0.6, box.y + box.h * 0.5);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(200);
  check('wheel over the charts does not scroll the page', (await page.evaluate(() => document.scrollingElement!.scrollTop)) === 0);

  // panels: hide the depth chart, move the candles across the top, put the side panel on the left
  await k('d');
  check('D hides the depth chart', (await page.locator('[aria-label="Zoom depth chart"]').count()) === 0);
  const grip = await page.locator('button[aria-label="Move candle chart"]').boundingBox();
  await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w / 2, box.y + 30, { steps: 4 });
  await page.mouse.move(box.x + box.w / 2, box.y + 8, { steps: 4 });
  check('drop preview shows while moving a panel', await page.locator('.droppreview').isVisible());
  await page.mouse.up();
  const zc = await page.locator('[aria-label="Zoom candle chart"]').boundingBox();
  const zl = await page.locator('[aria-label="Zoom order book"]').boundingBox();
  check('candles moved to the top, full width', !!zc && !!zl && zc.y < zl.y && Math.abs(zc.x + zc.width - (zl.x + zl.width)) < 2, { zc, zl });
  await page.click('button[aria-label="Panels"]');
  await page.selectOption('.layoutpop select', 'left');
  await k('Escape');
  check('side panel moves to the left', await page.evaluate(() => document.querySelector('aside')!.getBoundingClientRect().x < document.querySelector('.stage')!.getBoundingClientRect().x));
  const layoutBefore = await page.evaluate(() => localStorage.getItem('depthline.view.v1'));

  await page.goto(base);
  await ready();
  const after = await page.evaluate(() => ({
    interval: document.querySelector('.seg.tf button.on')?.textContent,
    theme: document.documentElement.dataset.theme,
    tab: document.querySelector('.tabs button.on')?.textContent,
    sideW: (document.querySelector('aside') as HTMLElement).style.getPropertyValue('--side-w'),
    liq: document.querySelector('.tg[title^="Liquidation"]')!.getAttribute('aria-pressed'),
    patterns: document.querySelector('.tg[title^="Chart patterns"]')!.getAttribute('aria-pressed'),
    alerts: document.querySelectorAll('#panel-alerts li').length,
    indicators: document.querySelectorAll('#panel-ind li').length,
    period: (document.querySelector('#panel-ind input[type=number]') as HTMLInputElement).value,
    favourites: [...document.querySelectorAll('.favs .fav')].map((b) => b.textContent),
    view: localStorage.getItem('depthline.view.v1'),
    depthShown: document.querySelectorAll('[aria-label="Zoom depth chart"]').length,
    sideLeft: document.querySelector('aside')!.getBoundingClientRect().x < document.querySelector('.stage')!.getBoundingClientRect().x,
  }));
  const want = { interval: '4h', theme: 'light', tab: 'Indicators', sideW: '350px', liq: 'false', patterns: 'false', alerts: 1, indicators: 4, period: '33', favourites: ['BTC/USD'] };
  for (const [key, v] of Object.entries(want)) check(`remembered after reload: ${key}`, JSON.stringify((after as any)[key]) === JSON.stringify(v), (after as any)[key]);
  check('remembered after reload: panel layout and sizes', after.view === layoutBefore, after.view);
  check('remembered after reload: depth chart hidden', after.depthShown === 0);
  check('remembered after reload: side panel on the left', after.sideLeft);
  check('no page errors', errors.length === 0, errors);

  await browser.close();
  console.log(failed ? `${failed} checks failed` : 'all checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
