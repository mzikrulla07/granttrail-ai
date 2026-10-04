import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';

/** Load data with loading/error state; `reload()` re-runs; stale responses are ignored. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    fn()
      .then((d) => my === seq.current && setData(d))
      .catch((e) => my === seq.current && setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.'))
      .finally(() => my === seq.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, setData, loading, error, reload };
}
