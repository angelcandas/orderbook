import type { Endpoints, Venue } from '../shared/config';
import type { HistSummary } from '../shared/hist';
import type { FeedCounters } from '../feeds/types';
import type { SceneSettings } from '../render/scene';
import type { ArmedAlert } from '../alerts/alerts';

export interface FeedInit {
  type: 'init';
  venue: Venue;
  endpoints: Endpoints;
  symbols: string[];
  depth: number;
  view: ArrayBuffer | SharedArrayBuffer;
  shared: boolean;
  renderPort: MessagePort; // view fallback (no SAB) + nothing else
  analyticsPort: MessagePort;
}
export type FeedCmd =
  | FeedInit
  | { type: 'focus'; symbol: string; pair: number; /** grouping as a multiple of the tick size */ group: number }
  | { type: 'candles'; symbol: string | null; interval: number }
  /** replaces the armed price alerts for this venue */
  | { type: 'alerts'; list: ArmedAlert[] }
  | { type: 'stop' };

export interface FeedStats {
  type: 'stats';
  venue: Venue;
  counters: FeedCounters;
  msgsPerSec: number;
  levelsPerSec: number;
  publishesPerSec: number;
  parse: HistSummary;
  apply: HistSummary;
  publish: HistSummary;
  status: Record<string, string>;
  books: number;
}

export interface RenderInit {
  type: 'init';
  canvas: OffscreenCanvas;
  w: number;
  h: number;
  dpr: number;
  views: { kraken: ArrayBuffer | SharedArrayBuffer; binance: ArrayBuffer | SharedArrayBuffer };
  shared: boolean;
  feedPorts: { kraken: MessagePort; binance: MessagePort };
  analyticsPort: MessagePort;
  settings: SceneSettings;
  theme: 'dark' | 'light';
}
export type RenderCmd =
  | RenderInit
  | { type: 'resize'; w: number; h: number; dpr: number }
  | { type: 'venue'; venue: Venue }
  | { type: 'pointer'; x: number; y: number; in: boolean }
  | { type: 'click'; x: number; y: number }
  | { type: 'wheel'; x: number; y: number; dy: number }
  | { type: 'settings'; settings: Partial<SceneSettings> }
  | { type: 'theme'; theme: 'dark' | 'light' }
  | { type: 'resetStats' };

export interface RenderStats {
  type: 'stats';
  frames: number;
  drawn: number;
  skipped: number;
  frameInterval: HistSummary;
  cpu: HistSummary;
  latency: HistSummary;
  gpuMs: number;
  dropped: number; // intervals > 1.5x the median interval
  renderer: string;
}
