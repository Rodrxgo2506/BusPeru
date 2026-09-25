import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ApiError, isAbortError, isCacheMiss, isResponseCacheEnabled, withRequestScope, type CachePolicy, type QueryParams } from '@/services/api';
import { beginRefresh, reportRefreshFailure, reportRefreshSuccess } from '@/services/refresh-status';
import type { Pagination } from '@/types';

interface ListLoader<T> {
  (params: QueryParams): Promise<{ data: T[]; pagination?: Pagination }>;
}

interface UseListOptions {
  limit?: number;
  initialFilters?: Record<string, string>;
  initialSort?: { sort: string; order: 'ASC' | 'DESC' };
}

/**
 * F18-16 · un dato viejo solo se revalida si la pantalla sigue abierta pasado este tiempo: al
 * recorrer el menú a golpe de clic no se lanza nada por las secciones por las que solo se pasa.
 */
export const REVALIDATE_DELAY_MS = 250;

/**
 * Server-side list state: search (debounced), filters, sorting and pagination all
 * travel to the API, so the browser never loads thousands of rows.
 *
 * F18-16 · stale-while-revalidate:
 *   1. Si la caché de lecturas (panel ADMIN) ya tiene la página pedida —fresca o vieja— se pinta
 *      ANTES del primer fotograma: nada de esqueleto ni de tabla vacía al volver a una sección.
 *   2. Si el dato era viejo, se revalida en segundo plano (`refreshing`) sin quitar lo visible.
 *   3. Sin caché, se pide a la API. `loading` (esqueleto) solo es verdadero cuando NO hay nada que
 *      enseñar; al paginar, filtrar u ordenar se mantienen las filas actuales con `refreshing`.
 */
export function useList<T>(loader: ListLoader<T>, options: UseListOptions = {}) {
  const { limit = 10, initialFilters = {}, initialSort } = options;

  const [rows, setRows] = useState<T[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>(initialFilters);
  const [sort, setSort] = useState(initialSort ?? null);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  /**
   * Consulta (página, filtros, búsqueda, orden) a la que pertenecen las filas que hay en pantalla.
   * Solo se actualiza «en caliente» (`refreshing`, sin esqueleto) la MISMA consulta: si cambia la
   * consulta y no está en caché, se muestra el esqueleto; nunca filas de otra página u otro filtro.
   */
  const shownKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  const params = useMemo<QueryParams>(
    () => ({
      page,
      limit,
      search: debouncedSearch || undefined,
      sort: sort?.sort,
      order: sort?.order,
      ...filters,
    }),
    [page, limit, debouncedSearch, sort, filters],
  );
  const paramsKey = useMemo(() => JSON.stringify(params), [params]);

  // F18-11B: cada carga tiene su `AbortController`. Una carga nueva (otra página, filtro, orden…)
  // cancela la anterior y desmontar la página cancela la que esté en curso, así una respuesta
  // vieja nunca pisa a una nueva y la navegación rápida no deja peticiones colgando.
  const controllerRef = useRef<AbortController | null>(null);
  const revalidateTimerRef = useRef<number | undefined>(undefined);
  /** Fin de la «actualización visible» en curso (indicador global de la cabecera). */
  const refreshEndRef = useRef<(() => void) | null>(null);

  /** Hay datos a la vista que se están actualizando (o son viejos a la espera de revalidar). */
  const startRefreshing = useCallback(() => {
    if (!refreshEndRef.current) refreshEndRef.current = beginRefresh();
    setRefreshing(true);
  }, []);
  const stopRefreshing = useCallback(() => {
    refreshEndRef.current?.();
    refreshEndRef.current = null;
    setRefreshing(false);
  }, []);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      window.clearTimeout(revalidateTimerRef.current);
      refreshEndRef.current?.();
      refreshEndRef.current = null;
    },
    [],
  );

  const apply = useCallback(
    (result: { data: T[]; pagination?: Pagination }) => {
      shownKeyRef.current = paramsKey;
      setRows(result.data ?? []);
      setPagination(result.pagination ?? { page, limit, total: result.data?.length ?? 0, totalPages: 1 });
      setError(null);
      setLoading(false);
    },
    [page, limit, paramsKey],
  );

  /** Pide a la API. Con filas en pantalla no hay esqueleto: solo `refreshing`. */
  const fetchFromApi = useCallback(
    async (controller: AbortController, policy: CachePolicy) => {
      const updatingVisibleData = shownKeyRef.current === paramsKey;
      if (updatingVisibleData) startRefreshing();
      else setLoading(true);
      try {
        const result = await withRequestScope({ signal: controller.signal, policy }, () => loaderRef.current(params));
        if (controller.signal.aborted) return;
        apply(result);
        if (updatingVisibleData) reportRefreshSuccess();
        stopRefreshing();
      } catch (caught) {
        // Cancelada: la carga que la sustituyó (o el desmontaje) decide el estado, no esta.
        if (controller.signal.aborted || isAbortError(caught)) return;
        stopRefreshing();
        // Si ya hay filas, un fallo al actualizar NO vacía la tabla: se sigue viendo lo último bueno
        // y la cabecera avisa de que no se pudo actualizar.
        if (updatingVisibleData) {
          reportRefreshFailure();
          return;
        }
        setError(caught instanceof ApiError ? caught : new ApiError(500, 'Error inesperado'));
        setRows([]);
        setLoading(false);
      }
    },
    [params, paramsKey, apply, startRefreshing, stopRefreshing],
  );

  const load = useCallback(
    async (force = false) => {
      controllerRef.current?.abort();
      window.clearTimeout(revalidateTimerRef.current);
      // La actualización visible de la carga anterior (si la había) ya no está en curso.
      refreshEndRef.current?.();
      refreshEndRef.current = null;
      const controller = new AbortController();
      controllerRef.current = controller;

      if (!force && isResponseCacheEnabled()) {
        let stale = false;
        try {
          const cached = await withRequestScope(
            { signal: controller.signal, policy: 'cache-only', onCacheRead: (fresh) => { if (!fresh) stale = true; } },
            () => loaderRef.current(params),
          );
          if (controller.signal.aborted) return;
          // Se aplica de forma síncrona, antes de que el navegador pinte el esqueleto inicial.
          flushSync(() => {
            apply(cached);
            // Un dato viejo no se presenta como confirmado: se marca como «actualizando» desde el primer fotograma.
            if (stale) startRefreshing();
            else setRefreshing(false);
          });
          if (stale) revalidateTimerRef.current = window.setTimeout(() => void fetchFromApi(controller, 'network'), REVALIDATE_DELAY_MS);
          return;
        } catch (caught) {
          if (controller.signal.aborted || isAbortError(caught)) return;
          if (!isCacheMiss(caught)) {
            setError(caught instanceof ApiError ? caught : new ApiError(500, 'Error inesperado'));
            setLoading(false);
            return;
          }
        }
      }
      await fetchFromApi(controller, force ? 'network' : 'default');
    },
    [params, apply, fetchFromApi, startRefreshing],
  );

  // Antes del pintado: si la caché tiene la página, el primer fotograma ya la muestra.
  useLayoutEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(() => load(true), [load]);

  const setFilter = useCallback((key: string, value: string | null) => {
    setFilters((current) => {
      const next = { ...current };
      if (value === null || value === '') delete next[key];
      else next[key] = value;
      return next;
    });
    setPage(1);
  }, []);

  const toggleSort = useCallback((column: string) => {
    setSort((current) => {
      if (current?.sort !== column) return { sort: column, order: 'ASC' };
      return { sort: column, order: current.order === 'ASC' ? 'DESC' : 'ASC' };
    });
  }, []);

  return {
    rows,
    pagination,
    loading,
    refreshing,
    error,
    page,
    setPage,
    search,
    setSearch,
    filters,
    setFilter,
    setFilters,
    sort,
    toggleSort,
    reload,
    isEmpty: !loading && !error && rows.length === 0,
  };
}
