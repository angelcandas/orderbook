/**
 * Drives the built page in Chromium against the venue emulator and checks that
 * the shell's features work and that what it remembers survives a reload:
 * shortcuts, overlay toggles, alerts, indicators, favourites, panel resizing,
 * the analysis window, the explain dialog, and wheel panning without page scroll.
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

  await page.click('#tab-ind');
  await page.selectOption('#panel-ind select[aria-label="Add indicator"]', { index: 2 });
  const period = page.locator('#panel-ind input[type=number]').first();
  await period.fill('33');
  await period.press('Enter');
  check('indicator added', (await page.locator('#panel-ind li').count()) === 4);

  await page.click('button[aria-label^="Add BTC/USD to favourites"]');
  await page.focus('[aria-label="Resize side panel"]'); await k('ArrowLeft'); await k('ArrowLeft');
  await page.focus('[aria-label="Resize order book"]'); await k('ArrowRight');

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
  check('the window is studied first', ((await page.locator('.explainer article.study h3').first().textContent()) ?? '') === 'Inside the window', await page.locator('.explainer article h3').first().textContent());
  if (!(await page.locator('.explainer article:not(.study)').count())) {
    // nothing inside this small window: explain the whole history instead
    await page.locator('.explainer [aria-label="Close"]').click();
    await page.locator('.wintools button', { hasText: 'clear' }).click();
    await page.waitForTimeout(600);
    await k('e');
  }
  if (await page.locator('.explainer article:not(.study)').count()) {
    await page.locator('.explainer article:not(.study)').first().click();
    check('clicking an explained pattern selects it', (await page.locator('.explainer article.sel').count()) === 1);
    check('the chart shows only the pattern\'s indicators', (await page.locator('.focusind').count()) === 1);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/explain-focus.png` });
    await page.locator('.explainer [aria-label="Close"]').click();
    check('closing the explanation removes them', (await page.locator('.focusind').count()) === 0);
  } else check('the window held a pattern to explain', false);
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
    layout: JSON.parse(localStorage.getItem('depthline.view.v1')!).layout.wide.ladder,
  }));
  const want = { interval: '4h', theme: 'light', tab: 'Indicators', sideW: '350px', liq: 'false', patterns: 'false', alerts: 1, indicators: 4, period: '33', favourites: ['BTC/USD'] };
  for (const [key, v] of Object.entries(want)) check(`remembered after reload: ${key}`, JSON.stringify((after as any)[key]) === JSON.stringify(v), (after as any)[key]);
  check('remembered after reload: split', Math.abs(after.layout - 0.3) < 1e-9, after.layout);
  check('no page errors', errors.length === 0, errors);

  await browser.close();
  console.log(failed ? `${failed} checks failed` : 'all checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
