import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  PageHeader,
  SearchBar,
  Select,
  TablePagination,
  TableSkeleton,
  type Column,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useList } from '@/hooks/useList';
import { useToast } from '@/context/ToastContext';
import type { QueryParams } from '@/services/api';
import type { Pagination } from '@/types';
import { ResourceForm, type FormField } from './ResourceForm';

export interface FilterDefinition {
  key: string;
  placeholder: string;
  options: Array<{ value: string; label: string }>;
}

interface ResourcePageProps<T extends { id: number }> {
  title: string;
  description?: string;
  breadcrumbs?: Array<{ label: string; to?: string }>;
  /** Server-side list loader; pagination and filters are handled by the API. */
  loader: (params: QueryParams) => Promise<{ data: T[]; pagination?: Pagination }>;
  columns: Array<Column<T>>;
  mobileCard?: (row: T) => ReactNode;
  searchPlaceholder?: string;
  filters?: FilterDefinition[];
  initialFilters?: Record<string, string>;
  /** Permission prefix, e.g. "buses" -> buses.create / buses.update / buses.delete. */
  permissionModule: string;
  /**
   * Catálogos globales (terminales, tipos de bus, tipos de asiento): el rol de empresa los
   * lee con su permiso de módulo, pero solo el ADMIN de la plataforma puede escribirlos.
   * Refleja en la interfaz la misma regla que aplica la API (`adminOnlyActions`).
   */
  adminOnlyWrites?: boolean;
  /** Cambiar este valor fuerza una recarga de la lista sin recargar la página. */
  reloadToken?: number;
  entityLabel: string;
  /** Género gramatical del nombre de la entidad, para "Nuevo bus" frente a "Nueva ruta". */
  entityGender?: 'm' | 'f';
  formFields?: FormField[];
  formSize?: 'sm' | 'md' | 'lg' | 'xl';
  onCreate?: (values: Record<string, unknown>) => Promise<void>;
  onUpdate?: (id: number, values: Record<string, unknown>) => Promise<void>;
  onDelete?: (id: number) => Promise<void>;
  /** Values fed into the edit form; defaults to the row itself. */
  toFormValues?: (row: T) => Record<string, unknown>;
  headerActions?: ReactNode;
  stats?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  onRowClick?: (row: T) => void;
  extraActions?: (row: T) => ReactNode;
}

export function ResourcePage<T extends { id: number }>({
  title,
  description,
  breadcrumbs,
  loader,
  columns,
  mobileCard,
  searchPlaceholder = 'Buscar...',
  filters = [],
  initialFilters,
  permissionModule,
  adminOnlyWrites = false,
  reloadToken,
  entityLabel,
  entityGender = 'm',
  formFields,
  formSize = 'md',
  onCreate,
  onUpdate,
  onDelete,
  toFormValues,
  headerActions,
  stats,
  emptyTitle,
  emptyDescription,
  onRowClick,
  extraActions,
}: ResourcePageProps<T>) {
  const { hasPermission, user } = useAuth();
  const toast = useToast();
  const list = useList<T>(loader, { initialFilters });

  // Recarga solicitada desde fuera (p. ej. tras cancelar un viaje o aprobar una empresa).
  // Se compara contra el valor anterior para no recargar de más cuando cambian los filtros.
  const reload = list.reload;
  const lastReloadToken = useRef(reloadToken);
  useEffect(() => {
    if (reloadToken === undefined || reloadToken === lastReloadToken.current) return;
    lastReloadToken.current = reloadToken;
    reload();
  }, [reloadToken, reload]);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<T | null>(null);
  const [deleting, setDeleting] = useState<T | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  const nuevo = entityGender === 'f' ? 'Nueva' : 'Nuevo';
  const writesAllowed = !adminOnlyWrites || user?.role === 'ADMIN';
  const canCreate = writesAllowed && Boolean(onCreate && formFields && hasPermission(`${permissionModule}.create`));
  const canUpdate = writesAllowed && Boolean(onUpdate && formFields && hasPermission(`${permissionModule}.update`));
  const canDelete = writesAllowed && Boolean(onDelete && hasPermission(`${permissionModule}.delete`));

  const actionsColumn: Column<T> = {
    key: '__actions',
    header: 'Acciones',
    headerClassName: 'text-right',
    className: 'text-right',
    render: (row) => (
      <div className="flex items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
        {extraActions?.(row)}
        {canUpdate && (
          <button
            type="button"
            onClick={() => {
              setEditing(row);
              setFormOpen(true);
            }}
            className="rounded-lg p-2 text-slate-500 transition hover:bg-brand-50 hover:text-brand-600"
            aria-label={`Editar ${entityLabel}`}
          >
            <Pencil className="h-4 w-4" />
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={() => setDeleting(row)}
            className="rounded-lg p-2 text-slate-500 transition hover:bg-danger-50 hover:text-danger-600"
            aria-label={`Eliminar ${entityLabel}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    ),
  };

  const showActions = canUpdate || canDelete || Boolean(extraActions);
  const allColumns = showActions ? [...columns, actionsColumn] : columns;

  const handleSubmit = async (values: Record<string, unknown>) => {
    if (editing && onUpdate) {
      await onUpdate(editing.id, values);
      toast.success(`${entityLabel} ${entityGender === 'f' ? 'actualizada' : 'actualizado'} correctamente.`);
    } else if (onCreate) {
      await onCreate(values);
      toast.success(`${entityLabel} ${entityGender === 'f' ? 'creada' : 'creado'} correctamente.`);
    }
    list.reload();
  };

  const handleDelete = async () => {
    if (!deleting || !onDelete) return;
    setDeletingBusy(true);
    try {
      await onDelete(deleting.id);
      toast.success(`${entityLabel} ${entityGender === 'f' ? 'eliminada' : 'eliminado'} correctamente.`);
      setDeleting(null);
      list.reload();
    } catch (error) {
      toast.error('No se pudo eliminar', error instanceof Error ? error.message : undefined);
    } finally {
      setDeletingBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={title}
        description={description}
        breadcrumbs={breadcrumbs}
        actions={
          <>
            {headerActions}
            {canCreate && (
              <Button
                icon={<Plus className="h-4 w-4" />}
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                {nuevo} {entityLabel.toLowerCase()}
              </Button>
            )}
          </>
        }
      />

      {stats && <div className="mb-6">{stats}</div>}

      <Card padded={false}>
        <div className="border-b border-border p-4">
          <FilterBar>
            <SearchBar
              className="min-w-0 flex-1 sm:max-w-sm"
              placeholder={searchPlaceholder}
              value={list.search}
              onChange={(event) => list.setSearch(event.target.value)}
              aria-label={searchPlaceholder}
            />
            {filters.map((filter) => (
              <Select
                key={filter.key}
                options={filter.options}
                placeholder={filter.placeholder}
                value={list.filters[filter.key] ?? ''}
                onChange={(event) => list.setFilter(filter.key, event.target.value || null)}
                containerClassName="w-full sm:w-auto sm:min-w-[180px]"
                aria-label={filter.placeholder}
              />
            ))}
          </FilterBar>
        </div>

        {list.error ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : (
          <>
            <DataTable
              columns={allColumns}
              rows={list.rows}
              rowKey={(row) => row.id}
              onRowClick={onRowClick}
              sort={list.sort}
              onSort={list.toggleSort}
              loading={list.loading}
              loadingState={<TableSkeleton columns={Math.min(allColumns.length, 6)} />}
              mobileCard={mobileCard}
              emptyState={
                <EmptyState
                  title={emptyTitle ?? `No hay ${entityLabel.toLowerCase()}s ${entityGender === 'f' ? 'registradas' : 'registrados'}`}
                  description={emptyDescription ?? 'Cuando existan registros aparecerán en esta tabla.'}
                  action={
                    canCreate ? (
                      <Button
                        icon={<Plus className="h-4 w-4" />}
                        onClick={() => {
                          setEditing(null);
                          setFormOpen(true);
                        }}
                      >
                        Crear el primero
                      </Button>
                    ) : undefined
                  }
                />
              }
            />
            {!list.loading && list.rows.length > 0 && <TablePagination pagination={list.pagination} onPageChange={list.setPage} />}
          </>
        )}
      </Card>

      {formFields && (
        <ResourceForm
          open={formOpen}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onSubmit={handleSubmit}
          title={editing ? `Editar ${entityLabel.toLowerCase()}` : `${nuevo} ${entityLabel.toLowerCase()}`}
          fields={formFields}
          size={formSize}
          initialValues={editing ? ((toFormValues?.(editing) ?? editing) as Record<string, unknown>) : null}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        loading={deletingBusy}
        title={`Eliminar ${entityLabel.toLowerCase()}`}
        confirmLabel="Sí, eliminar"
        message="Esta acción no se puede deshacer. Si el registro está siendo usado por otros datos, la eliminación será rechazada."
      />
    </>
  );
}
