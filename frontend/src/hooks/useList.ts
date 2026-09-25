import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, isAbortError, withRequestSignal, type QueryParams } from '@/services/api';
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
 * Server-side list state: search (debounced), filters, sorting and pagination all
 * travel to the API, so the browser never loads thousands of rows.
 */
export function useList<T>(loader: ListLoader<T>, options: UseListOptions = {}) {
  const { limit = 10, initialFilters = {}, initialSort } = options;

  const [rows, setRows] = useState<T[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>(initialFilters);
  const [sort, setSort] = useState(initialSort ?? null);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

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

  // F18-11B: cada carga tiene su `AbortController`. Una carga nueva (otra página, filtro, orden…)
  // cancela la anterior y desmontar la página cancela la que esté en curso, así una respuesta
  // vieja nunca pisa a una nueva y la navegación rápida no deja peticiones colgando.
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const result = await withRequestSignal(controller.signal, () => loaderRef.current(params));
      if (controller.signal.aborted) return;
      setRows(result.data ?? []);
      setPagination(result.pagination ?? { page, limit, total: result.data?.length ?? 0, totalPages: 1 });
      setLoading(false);
    } catch (caught) {
      // Cancelada: la carga que la sustituyó (o el desmontaje) decide el estado, no esta.
      if (controller.signal.aborted || isAbortError(caught)) return;
      setError(caught instanceof ApiError ? caught : new ApiError(500, 'Error inesperado'));
      setRows([]);
      setLoading(false);
    }
  }, [params, page, limit]);

  useEffect(() => {
    void load();
  }, [load]);

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
    reload: load,
    isEmpty: !loading && !error && rows.length === 0,
  };
}
