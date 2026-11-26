import { describe, expect, it } from 'vitest';
import { closeIn, countdown, timeLabel } from '../src/render/scene';
import { groupLabel, normalizeUiPrefs } from '../src/ui/prefs';
import { dayStats } from '../src/shared/day';

describe('candle close countdown', () => {
  it('counts down to the end of the candle', () => {
    const open = Date.UTC(2026, 10, 24, 22, 0);
    expect(closeIn(open, 15, open + 60_000)).toBe(14 * 60_000);
    expect(closeIn(open, 15, open + 20 * 60_000)).toBe(0);
    expect(closeIn(open, 0, open)).toBe(0);
  });
  it('uses calendar months for 1M', () => {
    const open = Date.UTC(2026, 1, 1); // February 2026: 28 days
    expect(closeIn(open, 43200, open)).toBe(28 * 86_400_000);
  });
  it('formats short and long spans', () => {
    expect(countdown(42_000)).toBe('00:42');
    expect(countdown(3 * 60_000 + 12_000)).toBe('03:12');
    expect(countdown(3_909_000)).toBe('1:05:09');
    expect(countdown(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 04h');
  });
  it('labels the crosshair time by candle size', () => {
    const t = new Date(2026, 10, 24, 9, 5).getTime();
    expect(timeLabel(t, 15)).toBe('2026-11-24 09:05');
    expect(timeLabel(t, 1440)).toBe('2026-11-24');
  });
});

describe('page prefs', () => {
  it('labels groups with real price steps', () => {
    expect(groupLabel(1, 0.1)).toBe('0.1');
    expect(groupLabel(10, 0.1)).toBe('1');
    expect(groupLabel(100, 0.01)).toBe('1');
    expect(groupLabel(1, 0.00001)).toBe('0.00001');
    expect(groupLabel(10, undefined)).toBe('10 ticks');
  });
  it('repairs stored ui prefs', () => {
    expect(normalizeUiPrefs(null)).toEqual({ themeMode: 'system', sideOpen: true, tab: 'signals', sideLeft: false });
    expect(normalizeUiPrefs({ themeMode: 'light', sideOpen: false, tab: 'health', sideLeft: 'x' })).toEqual({ themeMode: 'light', sideOpen: false, tab: 'health', sideLeft: false });
    expect(normalizeUiPrefs({ themeMode: 'pink', tab: 'nope' }).tab).toBe('signals');
  });
});

describe('24 h ticker figures', () => {
  const H = 3_600_000;
  const bars = Array.from({ length: 30 }, (_, i) => ({ t: i * H, h: 100 + i + 1, l: 100 + i - 1, c: 100 + i, v: 2 }));
  it('takes the close 24 h back and the range since', () => {
    const d = dayStats(bars)!;
    // newest opens at 29 h: the window holds bars opening after 5 h, the reference is the 5 h bar
    expect(d.ref).toBe(105);
    expect(d.hi).toBe(130);
    expect(d.lo).toBe(105);
    expect(d.vol).toBe(48);
    expect(d.hours).toBe(24);
  });
  it('says how many hours a short history covers', () => {
    expect(dayStats(bars.slice(0, 5))!.hours).toBe(4);
    expect(dayStats(bars.slice(0, 1))).toBeNull();
  });
});
