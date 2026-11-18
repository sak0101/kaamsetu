import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export interface AsyncState<T> {
  data: T | undefined;
  error: ApiError | Error | undefined;
  /** True while fetching (also during a background reload; `data` keeps the previous value). */
  loading: boolean;
  reload: () => void;
}

/** Minimal data-fetching hook: latest-wins, keeps stale data during reloads, explicit reload(). */
export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ data?: T; error?: ApiError | Error; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    setState((prev) => ({ data: prev.data, loading: true }));
    fnRef.current().then(
      (data) => alive && setState({ data, loading: false }),
      (error: unknown) => alive && setState({ error: error instanceof Error ? error : new Error(String(error)), loading: false }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}
