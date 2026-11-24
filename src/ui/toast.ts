import { useSyncExternalStore } from 'react';

/** Short status messages in the corner of the page (copied, layout reset, ...). */
export interface Toast { id: number; text: string; tone: 'info' | 'ok' | 'warn' }

let toasts: Toast[] = [];
let next = 1;
const subs = new Set<() => void>();
const emit = () => { for (const f of subs) f(); };

export function toast(text: string, tone: Toast['tone'] = 'info', ms = 2600): void {
  const id = next++;
  toasts = [...toasts, { id, text, tone }].slice(-4);
  emit();
  setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: number): void {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const get = () => toasts;

/** The toasts on screen; re-renders only the component that shows them. */
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, get, get);
}
