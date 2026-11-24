/** Short status messages in the corner of the page (copied, layout reset, ...). */
export interface Toast { id: number; text: string; tone: 'info' | 'ok' | 'warn' }

export const toasts = $state<Toast[]>([]);
let next = 1;

export function toast(text: string, tone: Toast['tone'] = 'info', ms = 2600): void {
  const id = next++;
  toasts.push({ id, text, tone });
  if (toasts.length > 4) toasts.shift();
  setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: number): void {
  const i = toasts.findIndex((t) => t.id === id);
  if (i >= 0) toasts.splice(i, 1);
}
