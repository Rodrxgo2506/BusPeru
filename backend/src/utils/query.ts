import { ApiError } from './ApiError';
import type { PaginationMeta } from './http';

export interface ListQuery {
  page: number;
  limit: number;
  offset: number;
  search: string | null;
  sort: string | null;
  order: 'ASC' | 'DESC';
  filters: Record<string, string>;
}

const RESERVED_KEYS = new Set(['page', 'limit', 'search', 'sort', 'order']);

export function parseListQuery(raw: Record<string, unknown>): ListQuery {
  const page = Math.max(1, Number(raw.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(raw.limit) || 20));
  const order = String(raw.order ?? '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (RESERVED_KEYS.has(key) || value === undefined || value === null || value === '') continue;
    if (typeof value === 'string' || typeof value === 'number') filters[key] = String(value);
  }

  const search = typeof raw.search === 'string' && raw.search.trim() !== '' ? raw.search.trim() : null;
  const sort = typeof raw.sort === 'string' && raw.sort.trim() !== '' ? raw.sort.trim() : null;

  return { page, limit, offset: (page - 1) * limit, search, sort, order, filters };
}

export function buildPagination(total: number, page: number, limit: number): PaginationMeta {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

/**
 * Column names cannot be parameterized in prepared statements, so any identifier
 * reaching SQL must come from this allow-list rather than from the request.
 */
export function safeColumn(candidate: string | null, allowed: readonly string[], fallback: string): string {
  if (candidate && allowed.includes(candidate)) return candidate;
  return fallback;
}

/**
 * LIMIT/OFFSET over a non-unique ORDER BY is not deterministic in MySQL: rows with the
 * same sort value can repeat or disappear between pages. Every listing appends the primary
 * key as the final tiebreaker.
 */
export function stableOrderBy(sortColumn: string, order: 'ASC' | 'DESC', alias: string): string {
  return `${sortColumn} ${order}, ${alias}.id ${order}`;
}

/** Route ids arrive as strings; anything that is not a positive integer is simply not found. */
export function parseId(value: string | undefined): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.notFound('Recurso no encontrado');
  return id;
}
