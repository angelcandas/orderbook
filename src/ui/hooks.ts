import { useCallback, useRef, useState, type MutableRefObject } from 'react';

/**
 * State that imperative code (pointer drags, worker callbacks, persistence)
 * can read back right after setting it: the ref updates synchronously, the
 * state schedules the render.
 */
export function useLive<T>(initial: T | (() => T)): [T, (v: T) => void, MutableRefObject<T>] {
  const [value, setValue] = useState(initial);
  const ref = useRef(value);
  const set = useCallback((v: T) => { ref.current = v; setValue(v); }, []);
  return [value, set, ref];
}

/** A ref that always holds the latest value, for listeners attached once. */
export function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
