import { useSyncExternalStore } from 'react';
import type { Engine, Snapshot } from './engine';
import type { Venue } from '../shared/config';
import type { Resolved } from '../shared/pairs';

/**
 * The engine's low rate readouts for the page: the stats snapshot (1 Hz) and
 * the focused book's top levels (4 Hz). They live outside React state so only
 * the parts of the page that show them re-render, not the whole shell.
 */
export type Ladder = ReturnType<Engine['ladder']>;

function store<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
  const get = () => value;
  return {
    get,
    set(v: T) { value = v; for (const f of subs) f(); },
    use: () => useSyncExternalStore(subscribe, get, get),
  };
}

export const statsStore = store<Snapshot | null>(null);
export const ladderStore = store<Ladder>(null);
export const useStats = statsStore.use;
export const useLadder = ladderStore.use;

/** The focused book's feed state: 'live', 'syncing', 'error …', or 'not listed' when the venue lacks the pair. */
export const focusStatusOf = (stats: Snapshot | null, venue: Venue, res: Resolved | null): string =>
  res ? stats?.feeds[venue]?.status[res.symbol] ?? 'connecting' : 'not listed';
