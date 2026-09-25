import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ApiError, isAbortError, isCacheMiss, isResponseCacheEnabled, withRequestScope, type CachePolicy } from '@/services/api';
import { beginRefresh, reportRefreshFailure, reportRefreshSuccess } from '@/services/refresh-status';
import { REVALIDATE_DELAY_MS } from './useList';

interface AsyncState<T> {
  data: T | null;
  /** Verdadero solo cuando todavía no hay nada que enseñar (primera carga sin caché). */
  loading: boolean;
  /** Hay datos en pantalla y se están actualizando en segundo plano. */
  refreshing: boolean;
  error: ApiError | null;
}

/**
 * Runs an async loader on mount and whenever `deps` change, with a manual `reload`.
 *
 * F18-11B: cada ejecución tiene su `AbortController`. Las GET que el cargador lanza se cancelan
 * si la página se desmonta (navegación rápida) o si una ejecución nueva sustituye a la anterior,
 * así una respuesta vieja nunca pisa a una nueva. Una cancelación no es un error: no se muestra.
 *
 * F18-16: stale-while-revalidate con la caché de lecturas del panel ADMIN (ver `useList`). Lo que
 * ya se conoce se pinta antes del primer fotograma y, si era viejo, se revalida en segundo plano;
 * un fallo al revalidar no borra lo que ya se ve.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[] = [],
): AsyncState<T> & { reload: () => void; setData: (data: T) => void } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, refreshing: false, error: null });
  const mounted = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);
  const revalidateTimerRef = useRef<number | undefined>(undefined);
  const hasDataRef = useRef(false);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  /** Fin de la «actualización visible» en curso (indicador global de la cabecera). */
  const refreshEndRef = useRef<(() => void) | null>(null);
  const endRefresh = () => {
    refreshEndRef.current?.();
    refreshEndRef.current = null;
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controllerRef.current?.abort();
      window.clearTimeout(revalidateTimerRef.current);
      endRefresh();
    };
  }, []);

  const fetchFromApi = useCallback(async (controller: AbortController, policy: CachePolicy) => {
    const updatingVisibleData = hasDataRef.current;
    if (updatingVisibleData && !refreshEndRef.current) refreshEndRef.current = beginRefresh();
    setState((current) => (updatingVisibleData ? { ...current, refreshing: true, error: null } : { ...current, loading: true, error: null }));
    try {
      const data = await withRequestScope({ signal: controller.signal, policy }, () => loaderRef.current());
      if (!mounted.current || controller.signal.aborted) return;
      hasDataRef.current = true;
      if (updatingVisibleData) reportRefreshSuccess();
      endRefresh();
      setState({ data, loading: false, refreshing: false, error: null });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error) || !mounted.current) return;
      endRefresh();
      if (hasDataRef.current) {
        // Fallo al actualizar: se conserva lo último bueno en pantalla y la cabecera lo avisa.
        reportRefreshFailure();
        setState((current) => ({ ...current, refreshing: false }));
        return;
      }
      setState({ data: null, loading: false, refreshing: false, error: error instanceof ApiError ? error : new ApiError(500, 'Error inesperado') });
    }
  }, []);

  const run = useCallback(
    async (force = false) => {
      controllerRef.current?.abort();
      window.clearTimeout(revalidateTimerRef.current);
      endRefresh();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (!force && isResponseCacheEnabled()) {
        let stale = false;
        try {
          const data = await withRequestScope(
            { signal: controller.signal, policy: 'cache-only', onCacheRead: (fresh) => { if (!fresh) stale = true; } },
            () => loaderRef.current(),
          );
          if (!mounted.current || controller.signal.aborted) return;
          hasDataRef.current = true;
          // Un dato viejo no se presenta como confirmado: «actualizando» desde el primer fotograma.
          if (stale && !refreshEndRef.current) refreshEndRef.current = beginRefresh();
          flushSync(() => setState({ data, loading: false, refreshing: stale, error: null }));
          if (stale) revalidateTimerRef.current = window.setTimeout(() => void fetchFromApi(controller, 'network'), REVALIDATE_DELAY_MS);
          return;
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error) || !mounted.current) return;
          if (!isCacheMiss(error)) {
            setState({ data: null, loading: false, refreshing: false, error: error instanceof ApiError ? error : new ApiError(500, 'Error inesperado') });
            return;
          }
        }
      }
      await fetchFromApi(controller, force ? 'network' : 'default');
    },
    [fetchFromApi],
  );

  // Antes del pintado: si la caché ya tiene el dato, el primer fotograma lo muestra.
  const firstRunRef = useRef(true);
  useLayoutEffect(() => {
    // Si cambian las dependencias (otro viaje, otra reserva…), lo que había es de OTRA entidad: no
    // se deja a la vista mientras llega lo nuevo. Mantener lo visible solo vale para la misma consulta.
    if (!firstRunRef.current) {
      hasDataRef.current = false;
      setState({ data: null, loading: true, refreshing: false, error: null });
    }
    firstRunRef.current = false;
    void run();
    // Justificado (H-20): `deps` lo define quien llama, igual que en `useEffect`, así que la regla
    // no puede verificarlo aquí. `run` es estable y lee el loader más reciente por `loaderRef`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    ...state,
    reload: () => void run(true),
    setData: (data: T) => {
      hasDataRef.current = true;
      setState({ data, loading: false, refreshing: false, error: null });
    },
  };
}
