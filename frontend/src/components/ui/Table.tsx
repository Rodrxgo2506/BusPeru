import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Pagination } from '@/types';
import { cn } from '@/utils/cn';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  sortColumn?: string;
  className?: string;
  headerClassName?: string;
  /** Hidden on small screens; the card view below shows the same data instead. */
  hideOnMobile?: boolean;
}

interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  sort?: { sort: string; order: 'ASC' | 'DESC' } | null;
  onSort?: (column: string) => void;
  emptyState?: ReactNode;
  loading?: boolean;
  loadingState?: ReactNode;
  /** Compact card rendering used on narrow screens. */
  mobileCard?: (row: T) => ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  sort,
  onSort,
  emptyState,
  loading,
  loadingState,
  mobileCard,
}: DataTableProps<T>) {
  if (loading && loadingState) return <>{loadingState}</>;
  if (!loading && rows.length === 0 && emptyState) return <>{emptyState}</>;

  return (
    <>
      <div className={cn('overflow-x-auto', mobileCard && 'hidden md:block')}>
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-slate-50/80">
              {columns.map((column) => {
                const sortable = Boolean(column.sortColumn && onSort);
                const isSorted = sort?.sort === column.sortColumn;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    className={cn(
                      'px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500',
                      column.hideOnMobile && 'hidden lg:table-cell',
                      column.headerClassName,
                    )}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => onSort?.(column.sortColumn!)}
                        className="inline-flex items-center gap-1 transition hover:text-slate-800"
                      >
                        {column.header}
                        {isSorted ? (
                          sort?.order === 'ASC' ? (
                            <ChevronUp className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5" />
                          )
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5 opacity-30" />
                        )}
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  'border-b border-border/70 last:border-0 transition',
                  onRowClick && 'cursor-pointer hover:bg-slate-50',
                )}
              >
                {columns.map((column) => (
                  <td key={column.key} className={cn('px-4 py-3.5 align-middle text-slate-700', column.hideOnMobile && 'hidden lg:table-cell', column.className)}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {mobileCard && (
        <div className="space-y-3 p-4 md:hidden">
          {rows.map((row) => (
            <div key={rowKey(row)} onClick={onRowClick ? () => onRowClick(row) : undefined} className={onRowClick ? 'cursor-pointer' : undefined}>
              {mobileCard(row)}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function TablePagination({ pagination, onPageChange }: { pagination: Pagination; onPageChange: (page: number) => void }) {
  const { page, limit, total, totalPages } = pagination;
  if (total === 0) return null;

  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  const pages: Array<number | '…'> = [];
  const window = 1;
  for (let index = 1; index <= totalPages; index += 1) {
    if (index === 1 || index === totalPages || (index >= page - window && index <= page + window)) {
      pages.push(index);
    } else if (pages[pages.length - 1] !== '…') {
      pages.push('…');
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
      <p className="text-sm text-muted">
        Mostrando {from} a {to} de {total.toLocaleString('es-PE')} registros
      </p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-slate-500 transition hover:bg-slate-50 disabled:opacity-40"
          aria-label="Página anterior"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        {pages.map((entry, index) =>
          entry === '…' ? (
            <span key={`gap-${index}`} className="px-2 text-sm text-slate-400">
              …
            </span>
          ) : (
            <button
              key={entry}
              type="button"
              onClick={() => onPageChange(entry)}
              aria-current={entry === page ? 'page' : undefined}
              className={cn(
                'h-8 min-w-8 rounded-lg px-2 text-sm font-medium transition',
                entry === page ? 'bg-brand-500 text-white' : 'border border-border text-slate-600 hover:bg-slate-50',
              )}
            >
              {entry}
            </button>
          ),
        )}
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-slate-500 transition hover:bg-slate-50 disabled:opacity-40"
          aria-label="Página siguiente"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
