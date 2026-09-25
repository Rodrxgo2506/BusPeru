import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/services/api';

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
}

/** Runs an async loader on mount and whenever `deps` change, with a manual `reload`. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> & { reload: () => void; setData: (data: T) => void } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });
  const mounted = useRef(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await loaderRef.current();
      if (mounted.current) setState({ data, loading: false, error: null });
    } catch (error) {
      if (mounted.current) {
        setState({ data: null, loading: false, error: error instanceof ApiError ? error : new ApiError(500, 'Error inesperado') });
      }
    }
  }, []);

  useEffect(() => {
    void run();
    // Justificado (H-20): `deps` lo define quien llama, igual que en `useEffect`, así que la regla
    // no puede verificarlo aquí. `run` es estable y lee el loader más reciente por `loaderRef`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    ...state,
    reload: () => void run(),
    setData: (data: T) => setState({ data, loading: false, error: null }),
  };
}
