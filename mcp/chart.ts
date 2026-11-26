/**
 * Candle charts as SVG, rasterised to PNG for MCP image replies. Same colours
 * as the app's themes (src/render/theme.ts). Pure string building, so it runs
 * anywhere Node runs; `png()` uses resvg (a prebuilt binary, no system deps).
 */
import { Resvg } from '@resvg/resvg-js';
import type { Candle } from '../src/patterns/candle';
import type { PatternHit } from '../src/patterns/types';
import { bollinger, ema } from '../src/patterns/indicators';
import { MONTH, type Interval } from '../src/shared/config';

export type ChartTheme = 'dark' | 'light';

const THEMES = {
  dark: { bg: '#0b0e14', panel: '#10141b', grid: '#1c232d', text: '#e3e8ef', dim: '#8b95a5', bull: '#2ebd85', bear: '#e5534b', up: '#3fb950', down: '#f85149', neutral: '#d4a72c', vol: '#7d8796', ema20: '#6ea8fe', ema50: '#bc8cff', bb: '#8b949e', accent: '#5b9dff', band: '#5b9dff' },
  light: { bg: '#ffffff', panel: '#f6f8fa', grid: '#e8ebf0', text: '#1a1f26', dim: '#59636e', bull: '#1a7f37', bear: '#cf222e', up: '#1a7f37', down: '#cf222e', neutral: '#9a6700', vol: '#59636e', ema20: '#0969da', ema50: '#8250df', bb: '#59636e', accent: '#0969da', band: '#0969da' },
};

export interface ForecastBand { horizon: number; top: number; mid: number; bottom: number }
export interface LiqProfile { rows: [number, number, number][]; long?: { price: number }; short?: { price: number } }

export interface ChartSpec {
  title: string;
  subtitle?: string;
  interval: Interval;
  candles: Candle[];
  /** draw candles from this index on; earlier ones only warm up the EMAs */
  first?: number;
  theme?: ChartTheme;
  width?: number;
  height?: number;
  ema?: boolean;
  bollinger?: boolean;
  volume?: boolean;
  /** numbered pattern overlays; `n` is the number shown on the chart */
  patterns?: (PatternHit & { n: number })[];
  /** shade [t0, t1] (open times) as the analysed window */
  window?: { t0: number; t1: number };
  forecast?: ForecastBand;
  liquidity?: LiqProfile;
  /** extra text lines under the title, right aligned */
  note?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f1 = (x: number) => (Math.round(x * 10) / 10).toString();

/** Decimals that show a price with about 5 significant digits (at least 2). */
export function decimals(p: number): number {
  if (!(p > 0)) return 2;
  return Math.max(2, Math.min(8, 4 - Math.floor(Math.log10(p))));
}

export function fmtPrice(p: number, dp = decimals(p)): string {
  return p.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtCompact(x: number): string {
  const a = Math.abs(x);
  return a >= 1e9 ? `${(x / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(x / 1e3).toFixed(1)}K` : x.toFixed(a >= 10 ? 0 : 2);
}

function niceStep(span: number, target: number): number {
  const raw = span / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtTime(t: number, interval: Interval): string {
  const d = new Date(t);
  const day = `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (interval >= MONTH || interval >= 10080) return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (interval >= 1440) return day;
  return `${day} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** A date for titles: YYYY-MM-DD, with the time for intraday candles. */
export function fmtDate(t: number, interval: Interval): string {
  const s = new Date(t).toISOString();
  return interval < 1440 ? `${s.slice(0, 10)} ${s.slice(11, 16)}` : s.slice(0, 10);
}

export function chartSvg(spec: ChartSpec): string {
  const th = THEMES[spec.theme ?? 'dark'];
  const W = spec.width ?? 1200, H = spec.height ?? 700;
  const cs = spec.candles;
  const first = Math.max(0, Math.min(spec.first ?? 0, cs.length - 1));
  const n = cs.length - first;
  const ahead = spec.forecast ? spec.forecast.horizon : 0;
  const liqW = spec.liquidity?.rows.length ? 90 : 0;
  const L = 16, R = 84, T = 76, B = 30;
  const volH = spec.volume === false ? 0 : 84;
  const plotR = W - R - liqW;
  const priceB = H - B - (volH ? volH + 8 : 0);
  const slots = Math.max(1, n + ahead);
  const cw = (plotR - L) / slots;
  const x = (i: number) => L + (i - first + 0.5) * cw;

  // price range: visible bars, overlays that are near them, and the forecast
  let lo = Infinity, hi = -Infinity;
  for (let i = first; i < cs.length; i++) { lo = Math.min(lo, cs[i].l); hi = Math.max(hi, cs[i].h); }
  if (spec.forecast) { lo = Math.min(lo, spec.forecast.bottom); hi = Math.max(hi, spec.forecast.top); }
  const span0 = hi - lo || hi * 0.01 || 1;
  for (const p of spec.patterns ?? []) for (const v of [p.target, p.stop]) {
    if (v !== undefined && v > lo - span0 * 0.25 && v < hi + span0 * 0.25) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  const pad = (hi - lo) * 0.06 || hi * 0.01;
  lo -= pad; hi += pad;
  const y = (p: number) => T + ((hi - p) / (hi - lo)) * (priceB - T);
  const out: string[] = [];
  const font = `font-family="Inter, 'Helvetica Neue', Helvetica, Arial, 'DejaVu Sans', sans-serif"`;
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${font}>`);
  out.push(`<rect width="${W}" height="${H}" fill="${th.bg}"/>`);
  out.push(`<defs><clipPath id="plot"><rect x="${L}" y="${T}" width="${plotR - L}" height="${priceB - T}"/></clipPath></defs>`);

  // title
  out.push(`<text x="${L}" y="26" font-size="18" font-weight="600" fill="${th.text}">${esc(spec.title)}</text>`);
  if (spec.subtitle) out.push(`<text x="${L}" y="48" font-size="13" fill="${th.dim}">${esc(spec.subtitle)}</text>`);
  if (spec.note) out.push(`<text x="${W - 16}" y="26" font-size="13" fill="${th.dim}" text-anchor="end">${esc(spec.note)}</text>`);

  // analysed window
  if (spec.window) {
    const i0 = cs.findIndex((c) => c.t >= spec.window!.t0);
    let i1 = -1;
    for (let i = cs.length - 1; i >= 0; i--) if (cs[i].t <= spec.window.t1) { i1 = i; break; }
    if (i0 >= 0 && i1 >= i0) {
      const a = Math.max(L, x(Math.max(i0, first)) - cw / 2), b = Math.min(plotR, x(i1) + cw / 2);
      out.push(`<rect x="${f1(a)}" y="${T}" width="${f1(b - a)}" height="${priceB - T}" fill="${th.band}" fill-opacity="0.07"/>`);
      out.push(`<line x1="${f1(a)}" x2="${f1(a)}" y1="${T}" y2="${priceB}" stroke="${th.band}" stroke-opacity="0.5" stroke-dasharray="4 4"/>`);
      out.push(`<line x1="${f1(b)}" x2="${f1(b)}" y1="${T}" y2="${priceB}" stroke="${th.band}" stroke-opacity="0.5" stroke-dasharray="4 4"/>`);
    }
  }

  // grid + price axis
  const dp = decimals(cs[cs.length - 1]?.c ?? 1);
  const step = niceStep(hi - lo, 6);
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    const yy = f1(y(p));
    out.push(`<line x1="${L}" x2="${plotR}" y1="${yy}" y2="${yy}" stroke="${th.grid}" stroke-width="1"/>`);
    out.push(`<text x="${W - R + 8}" y="${+yy + 4}" font-size="12" fill="${th.dim}">${esc(fmtPrice(p, Math.max(0, dp - (step >= 1 ? dp : 0))))}</text>`);
  }
  // time axis
  const every = Math.max(1, Math.ceil(n / 8));
  for (let i = first; i < cs.length; i += every) {
    const xx = f1(x(i));
    out.push(`<line x1="${xx}" x2="${xx}" y1="${T}" y2="${H - B}" stroke="${th.grid}" stroke-width="1" stroke-opacity="0.6"/>`);
    const anchor = +xx < L + 50 ? 'start' : +xx > plotR - 50 ? 'end' : 'middle';
    out.push(`<text x="${anchor === 'start' ? L : xx}" y="${H - 10}" font-size="12" fill="${th.dim}" text-anchor="${anchor}">${esc(fmtTime(cs[i].t, spec.interval))}</text>`);
  }

  // liquidation profile, right of the plot: longs (would sell) and shorts (would buy) per price row
  if (liqW && spec.liquidity) {
    const rows = spec.liquidity.rows.filter((r) => r[0] >= lo && r[0] <= hi);
    let mx = 0;
    for (const r of rows) mx = Math.max(mx, r[1] + r[2]);
    const x0 = plotR + 6, rowH = Math.max(1, Math.abs(y(rows[0]?.[0] ?? 0) - y((rows[1]?.[0] ?? 0))) || 2);
    out.push(`<text x="${x0}" y="${T - 4}" font-size="11" fill="${th.dim}">Liquidations</text>`);
    for (const [p, lg, sh] of rows) {
      if (!mx) break;
      const yy = y(p) - rowH / 2;
      if (lg > 0) out.push(`<rect x="${x0}" y="${f1(yy)}" width="${f1((lg / mx) * (liqW - 12))}" height="${f1(rowH)}" fill="${th.bear}" fill-opacity="0.6"/>`);
      if (sh > 0) out.push(`<rect x="${x0}" y="${f1(yy)}" width="${f1((sh / mx) * (liqW - 12))}" height="${f1(rowH)}" fill="${th.bull}" fill-opacity="0.6"/>`);
    }
    const mark = (pr: number | undefined, col: string, label: string) => {
      if (pr === undefined || pr < lo || pr > hi) return;
      out.push(`<line x1="${L}" x2="${plotR}" y1="${f1(y(pr))}" y2="${f1(y(pr))}" stroke="${col}" stroke-opacity="0.55" stroke-dasharray="2 4"/>`);
      out.push(`<text x="${plotR - 4}" y="${f1(y(pr) - 4)}" font-size="11" fill="${th.dim}" text-anchor="end">${esc(label)} ${esc(fmtPrice(pr, dp))}</text>`);
    };
    mark(spec.liquidity.long?.price, th.bear, 'long liquidations');
    mark(spec.liquidity.short?.price, th.bull, 'short liquidations');
  }

  out.push(`<g clip-path="url(#plot)">`);
  // indicators under the candles
  const closes = cs.map((c) => c.c);
  const path = (vals: ArrayLike<number>, from: number) => {
    let d = '';
    for (let i = Math.max(first, from); i < cs.length; i++) if (Number.isFinite(vals[i])) d += `${d ? 'L' : 'M'}${f1(x(i))},${f1(y(vals[i]))}`;
    return d;
  };
  const legend: [string, string][] = [];
  if (spec.bollinger) {
    const [mid, up, dn] = bollinger(closes, 20, 2);
    for (const v of [up, dn]) out.push(`<path d="${path(v, 19)}" fill="none" stroke="${th.bb}" stroke-width="1.2" stroke-opacity="0.8"/>`);
    out.push(`<path d="${path(mid, 19)}" fill="none" stroke="${th.bb}" stroke-width="1" stroke-dasharray="3 3" stroke-opacity="0.7"/>`);
    legend.push(['Bollinger 20, 2', th.bb]);
  }
  if (spec.ema !== false) {
    out.push(`<path d="${path(ema(closes, 20), 19)}" fill="none" stroke="${th.ema20}" stroke-width="1.6"/>`);
    out.push(`<path d="${path(ema(closes, 50), 49)}" fill="none" stroke="${th.ema50}" stroke-width="1.6"/>`);
    legend.push(['EMA 20', th.ema20], ['EMA 50', th.ema50]);
  }

  // candles
  const bw = Math.max(1, Math.min(14, cw * 0.7));
  for (let i = first; i < cs.length; i++) {
    const c = cs[i], col = c.c >= c.o ? th.bull : th.bear, xx = x(i);
    out.push(`<line x1="${f1(xx)}" x2="${f1(xx)}" y1="${f1(y(c.h))}" y2="${f1(y(c.l))}" stroke="${col}" stroke-width="1"/>`);
    const top = y(Math.max(c.o, c.c)), h = Math.max(1, Math.abs(y(c.o) - y(c.c)));
    out.push(`<rect x="${f1(xx - bw / 2)}" y="${f1(top)}" width="${f1(bw)}" height="${f1(h)}" fill="${col}"${c.closed ? '' : ' fill-opacity="0.55"'}/>`);
  }

  // forecast cone from the last close
  if (spec.forecast && cs.length) {
    const f = spec.forecast, i = cs.length - 1, j = i + f.horizon;
    const x0 = x(i), x1 = x(j), y0 = y(cs[i].c);
    out.push(`<path d="M${f1(x0)},${f1(y0)} L${f1(x1)},${f1(y(f.top))} L${f1(x1)},${f1(y(f.bottom))} Z" fill="${th.accent}" fill-opacity="0.13" stroke="${th.accent}" stroke-opacity="0.5"/>`);
    out.push(`<line x1="${f1(x0)}" y1="${f1(y0)}" x2="${f1(x1)}" y2="${f1(y(f.mid))}" stroke="${th.accent}" stroke-width="1.6" stroke-dasharray="5 4"/>`);
    for (const [v, k] of [[f.top, 'top'], [f.mid, 'median'], [f.bottom, 'bottom']] as const) {
      out.push(`<text x="${f1(x1 - 4)}" y="${f1(y(v) + (k === 'bottom' ? 14 : -5))}" font-size="12" fill="${th.text}" text-anchor="end">${k} ${esc(fmtPrice(v, dp))}</text>`);
    }
  }

  // patterns
  const pats = spec.patterns ?? [];
  const placed: [number, number][] = [];
  for (const p of pats) {
    if (p.end < first) continue;
    const col = p.bias > 0 ? th.up : p.bias < 0 ? th.down : th.neutral;
    if (p.family === 'chart') {
      if (p.pivots.length > 1) {
        const d = p.pivots.map((q, k) => `${k ? 'L' : 'M'}${f1(x(q.i))},${f1(y(q.p))}`).join('');
        out.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="1.2" stroke-opacity="0.55" stroke-dasharray="3 3"/>`);
      }
      for (const [a, b] of p.lines) out.push(`<line x1="${f1(x(a.i))}" y1="${f1(y(a.p))}" x2="${f1(x(b.i))}" y2="${f1(y(b.p))}" stroke="${col}" stroke-width="2"/>`);
      for (const q of p.pivots) out.push(`<circle cx="${f1(x(q.i))}" cy="${f1(y(q.p))}" r="3" fill="${col}" stroke="${th.bg}" stroke-width="2"/>`);
      const from = p.breakout?.i ?? p.end;
      const reach = Math.min(cs.length - 1 + ahead, from + Math.max(8, Math.round((p.end - p.start) * 0.6)));
      const hl = (v: number | undefined, dash: string, what: string) => {
        if (v === undefined || v < lo || v > hi) return;
        out.push(`<line x1="${f1(x(from))}" x2="${f1(x(reach))}" y1="${f1(y(v))}" y2="${f1(y(v))}" stroke="${col}" stroke-width="1.2" stroke-dasharray="${dash}"/>`);
        out.push(`<text x="${f1(x(reach) + 3)}" y="${f1(y(v) + 4)}" font-size="11" fill="${th.dim}">#${p.n} ${what}</text>`);
      };
      hl(p.target, '6 3', 'target');
      hl(p.stop, '2 3', 'stop');
      if (p.breakout) out.push(`<circle cx="${f1(x(p.breakout.i))}" cy="${f1(y(p.breakout.p))}" r="5" fill="none" stroke="${col}" stroke-width="2"/>`);
      // label above the highest pivot, nudged down past labels already placed
      let top = Infinity, ti = p.start;
      for (const q of p.pivots) if (y(q.p) < top) { top = y(q.p); ti = q.i; }
      if (top === Infinity) { top = y(cs[p.end].h); ti = p.end; }
      const text = `#${p.n} ${p.label}${p.status === 'forming' ? ' (forming)' : p.status === 'failed' ? ' (failed)' : ''}`;
      const w = text.length * 6.6 + 10;
      let lx = Math.min(plotR - w - 2, Math.max(L + 2, x(ti) - w / 2)), ly = Math.max(T + 2, top - 26);
      while (placed.some(([px, py]) => Math.abs(px - lx) < w && Math.abs(py - ly) < 20)) ly += 20;
      placed.push([lx, ly]);
      out.push(`<rect x="${f1(lx)}" y="${f1(ly)}" width="${f1(w)}" height="18" rx="4" fill="${th.panel}" stroke="${col}" stroke-opacity="0.8"/>`);
      out.push(`<text x="${f1(lx + 5)}" y="${f1(ly + 13)}" font-size="12" fill="${th.text}">${esc(text)}</text>`);
    } else {
      // candle / volatility signals: a marker on the bar with its number
      const c = cs[p.end], xx = x(p.end);
      const below = p.bias >= 0;
      const yy = below ? y(c.l) + 10 : y(c.h) - 10;
      const tri = below ? `M${f1(xx)},${f1(yy - 5)} l5,8 l-10,0 Z` : `M${f1(xx)},${f1(yy + 5)} l5,-8 l-10,0 Z`;
      out.push(`<path d="${tri}" fill="${col}"/>`);
      out.push(`<text x="${f1(xx)}" y="${f1(below ? yy + 16 : yy - 9)}" font-size="11" fill="${th.text}" text-anchor="middle">${p.n}</text>`);
    }
  }
  out.push(`</g>`);

  // volume
  if (volH) {
    const vt = priceB + 8, vb = H - B;
    let vmax = 0;
    for (let i = first; i < cs.length; i++) vmax = Math.max(vmax, cs[i].v);
    out.push(`<line x1="${L}" x2="${plotR}" y1="${vb}" y2="${vb}" stroke="${th.grid}"/>`);
    out.push(`<text x="${W - R + 8}" y="${vt + 12}" font-size="12" fill="${th.dim}">vol ${esc(fmtCompact(vmax))}</text>`);
    for (let i = first; i < cs.length && vmax > 0; i++) {
      const c = cs[i], h = (c.v / vmax) * (vb - vt);
      out.push(`<rect x="${f1(x(i) - bw / 2)}" y="${f1(vb - h)}" width="${f1(bw)}" height="${f1(Math.max(0.5, h))}" fill="${c.c >= c.o ? th.bull : th.bear}" fill-opacity="0.45"/>`);
    }
  }

  // last price tag
  const last = cs[cs.length - 1];
  if (last) {
    const yy = y(last.c), col = last.c >= last.o ? th.bull : th.bear;
    out.push(`<line x1="${L}" x2="${plotR}" y1="${f1(yy)}" y2="${f1(yy)}" stroke="${col}" stroke-opacity="0.6" stroke-dasharray="1 3"/>`);
    out.push(`<rect x="${W - R + 2}" y="${f1(yy - 10)}" width="${R - 4}" height="20" rx="3" fill="${col}"/>`);
    out.push(`<text x="${W - R + 8}" y="${f1(yy + 4)}" font-size="12" font-weight="600" fill="#ffffff">${esc(fmtPrice(last.c, dp))}</text>`);
  }

  // legend
  let lx = L + 4;
  if (spec.forecast) legend.push([`Forecast, ${spec.forecast.horizon} bars`, th.accent]);
  for (const [name, col] of legend) {
    out.push(`<line x1="${lx}" x2="${lx + 16}" y1="${T + 12}" y2="${T + 12}" stroke="${col}" stroke-width="2"/>`);
    out.push(`<text x="${lx + 21}" y="${T + 16}" font-size="12" fill="${th.dim}">${esc(name)}</text>`);
    lx += 21 + name.length * 6.8 + 16;
  }
  out.push(`<text x="${W - 16}" y="48" font-size="11" fill="${th.dim}" text-anchor="end">Times in UTC · Depthline · not financial advice</text>`);
  out.push(`</svg>`);
  return out.join('\n');
}

/** PNG bytes for an SVG. */
export function png(svg: string, scale = 1): Buffer {
  const r = new Resvg(svg, { fitTo: { mode: 'zoom', value: scale }, font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } });
  return r.render().asPng();
}
