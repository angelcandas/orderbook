/**
 * System notifications where the browser allows them. The in-app toast is
 * always shown as well, so an alert is never silent: iOS Safari outside a home
 * screen app has no Notification API, and Android Chrome only notifies through
 * a service worker (the constructor throws there).
 */
export type Permission = NotificationPermission | 'unsupported';

export function permission(): Permission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export async function requestPermission(): Promise<Permission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

/** Returns true if a system notification was shown. */
export function systemNotify(title: string, body: string, tag: string): boolean {
  if (permission() !== 'granted') return false;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => { window.focus(); n.close(); };
    return true;
  } catch {
    return false;
  }
}

/** Decimals that read well for a price of this size. */
export const priceDigits = (x: number): number => (x >= 1000 ? 2 : x >= 1 ? 4 : x >= 0.01 ? 6 : 8);

export const fmtPrice = (x: number, decimals?: number): string =>
  Number.isFinite(x) ? x.toLocaleString(undefined, { maximumFractionDigits: decimals ?? priceDigits(x), minimumFractionDigits: 0 }) : '–';
