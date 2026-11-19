import type { Book } from '../engine/book';
import type { Candle } from '../patterns/candle';
import type { Status } from '../shared/view';

export interface FeedCounters {
  msgs: number;
  levels: number;
  bytes: number;
  checksumFails: number;
  gaps: number;
  resyncs: number;
  reconnects: number;
  crossed: number;
}

export const newCounters = (): FeedCounters => ({
  msgs: 0, levels: 0, bytes: 0, checksumFails: 0, gaps: 0, resyncs: 0, reconnects: 0, crossed: 0,
});

export interface FeedSink {
  /** a book changed; `recv` is the absolute receive time of the message */
  onBook(symbol: string, book: Book): void;
  onStatus(symbol: string, status: Status, detail?: string): void;
  /** full candle history (replaces) */
  onCandles(symbol: string, candles: Candle[]): void;
  /** one candle created or updated (matched by open time) */
  onCandle(symbol: string, candle: Candle): void;
  /** parse + apply time of one message, ms */
  onTiming(parseMs: number, applyMs: number, levels: number): void;
  log(msg: string): void;
}

/** Minimal WebSocket surface, so feeds run in a browser worker or under Node tests. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  readyState: number;
}
export type SocketFactory = (url: string) => SocketLike;
export type Fetcher = (url: string) => Promise<any>;
