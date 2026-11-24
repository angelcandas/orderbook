import type { Market } from '../shared/pairs';
import type { Endpoints, Venue } from '../shared/config';
import type { HistSummary } from '../shared/hist';
import type { FeedCounters } from '../feeds/types';
import type { SceneSettings } from '../render/scene';
import type { ArmedAlert } from '../alerts/alerts';
import type { LayoutPrefs } from '../render/layout';

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
  /** the books to keep live; the feed diffs it against what it has and resubscribes in place */
  | { type: 'symbols'; symbols: string[] }
  /** `alt`: the same pair's Binance symbol, which Kraken backfills older candles from */
  | { type: 'candles'; symbol: string | null; interval: number; alt?: string | null }
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

/** everything a venue lists, sent once per connection for the pair picker */
export interface FeedMarkets { type: 'markets'; venue: Venue; markets: Market[] }

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
  /** liquidation level columns from the liquidation worker */
  liqPort?: MessagePort;
  settings: SceneSettings;
  theme: 'dark' | 'light';
  layout?: LayoutPrefs;
  fontPx?: number;
}
export type RenderCmd =
  | RenderInit
  | { type: 'resize'; w: number; h: number; dpr: number }
  | { type: 'venue'; venue: Venue }
  | { type: 'pointer'; x: number; y: number; in: boolean }
  | { type: 'click'; x: number; y: number }
  | { type: 'wheel'; x: number; y: number; dy: number }
  /** dir: +1 zoom in, -1 zoom out, 0 back to the default */
  | { type: 'zoom'; pane: ZoomPane; dir: 1 | -1 | 0 }
  | { type: 'layout'; layout: LayoutPrefs }
  | { type: 'font'; px: number }
  | { type: 'settings'; settings: Partial<SceneSettings> }
  | { type: 'theme'; theme: 'dark' | 'light' }
  | { type: 'resetStats' };

export type ZoomPane = 'ladder' | 'depth' | 'candles';
/** Sent by the render worker after a zoom so the page can remember it. */
export interface ZoomState { type: 'zoom'; candlesVisible: number; depthRangePct: number; ladderRowPad: number }

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
