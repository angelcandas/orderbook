import type { Series } from './series';

export interface Pivot { i: number; p: number; hi: boolean }

/**
 * ZigZag pivots: a swing high is confirmed once price has fallen `k` ATRs from
 * it (and vice versa). Uses highs for peaks and lows for troughs, closed candles
 * only. The final pivot is provisional (still extending).
 */
export function zigzag(s: Series, k = 2): Pivot[] {
  const out: Pivot[] = [];
  const end = s.lastClosed;
  if (end < 2) return out;
  let dir = 0; // 1 looking for a high, -1 for a low
  let ext = 0; // index of current extreme
  let hiI = 0, loI = 0;
  for (let i = 1; i <= end; i++) {
    const th = k * (s.atr[i] || (s.h[i] - s.l[i]));
    if (dir === 0) {
      if (s.h[i] > s.h[hiI]) hiI = i;
      if (s.l[i] < s.l[loI]) loI = i;
      if (s.h[hiI] - s.l[i] >= th && hiI < i) { out.push({ i: hiI, p: s.h[hiI], hi: true }); dir = -1; ext = i; }
      else if (s.h[i] - s.l[loI] >= th && loI < i) { out.push({ i: loI, p: s.l[loI], hi: false }); dir = 1; ext = i; }
      continue;
    }
    if (dir === 1) {
      if (s.h[i] >= s.h[ext]) ext = i;
      else if (s.h[ext] - s.l[i] >= th) { out.push({ i: ext, p: s.h[ext], hi: true }); dir = -1; ext = i; }
    } else {
      if (s.l[i] <= s.l[ext]) ext = i;
      else if (s.h[i] - s.l[ext] >= th) { out.push({ i: ext, p: s.l[ext], hi: false }); dir = 1; ext = i; }
    }
  }
  if (dir !== 0) out.push({ i: ext, p: dir === 1 ? s.h[ext] : s.l[ext], hi: dir === 1 });
  return out;
}
