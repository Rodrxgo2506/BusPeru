import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbortError, withRequestSignal } from '@/services/api';

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
}

/**
 * Runs an async loader on mount and whenever `deps` change, with a manual `reload`.
 *
 * F18-11B: cada ejecución tiene su `AbortController`. Las GET que el cargador lanza se cancelan
 * si la página se desmonta (navegación rápida) o si una ejecución nueva sustituye a la anterior,
 * así una respuesta vieja nunca pisa a una nueva. Una cancelación no es un error: no se muestra.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> & { reload: () => void; setData: (data: T) => void } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });
  const mounted = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const run = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await withRequestSignal(controller.signal, () => loaderRef.current());
      if (mounted.current && !controller.signal.aborted) setState({ data, loading: false, error: null });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
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
