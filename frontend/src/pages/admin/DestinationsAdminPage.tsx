import { ArrowDown, ArrowUp, Eye, EyeOff, ImageOff, LayoutList, MapPinned, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ResourceForm } from '@/components/common/ResourceForm';
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
  StatusBadge,
  TableSkeleton,
  type Column,
} from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { destinationService, locationService } from '@/services';
import { ApiError, mediaUrl } from '@/services/api';
import type { Destination } from '@/types';
import { formatCurrency } from '@/utils/format';
import { normalizeForSearch } from '@/utils/text';
import { destinationFields, destinationPayload } from './destination-forms';

/**
 * Contenido › Destinos (FASE 17). Tabla con búsqueda, filtro de estado, orden de aparición (↑ ↓),
 * alta y edición, activar/desactivar y eliminación segura.
 *
 * Los destinos son pocos (contenido editorial), así que se cargan todos de una vez ordenados por
 * `display_order` y el filtro se aplica en el navegador; así reordenar trabaja siempre con la lista
 * completa. La API aplica el mismo control que la interfaz: `settings.update` y rol ADMIN.
 */
export function DestinationsAdminPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const destinations = useAsync(() => destinationService.list({ limit: 100, sort: 'd.display_order', order: 'ASC' }), []);
  // FASE 17B · las ciudades del formulario son ubicaciones reales, no texto libre.
  const locations = useAsync(() => locationService.list({ limit: 100, sort: 'l.city', order: 'ASC', type: 'TERMINAL' }), []);

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Destination | null>(null);
  const [deleting, setDeleting] = useState<Destination | null>(null);
  const [busy, setBusy] = useState(false);

  const all = useMemo(() => destinations.data?.data ?? [], [destinations.data]);
  const fields = useMemo(() => destinationFields(locations.data?.data ?? []), [locations.data]);
  const filtering = search.trim() !== '' || status !== '';
  const rows = useMemo(() => {
    const needle = normalizeForSearch(search);
    return all.filter(
      (row) =>
        (!status || row.status === status) &&
        (!needle || normalizeForSearch(`${row.name} ${row.slug} ${row.subtitle ?? ''}`).includes(needle)),
    );
  }, [all, search, status]);

  const fail = (title: string, error: unknown) => toast.error(title, error instanceof ApiError ? error.message : undefined);

  const submit = async (values: Record<string, unknown>) => {
    const payload = destinationPayload(values);
    if (editing) {
      await destinationService.update(editing.id, payload);
      toast.success('Destino actualizado.');
    } else {
      const created = await destinationService.create({ ...payload, display_order: payload.display_order ?? all.length + 1 });
      toast.success('Destino creado.', 'Ahora puedes subir su imagen y agregar atractivos y festividades.');
      navigate(`/admin/destinations/${created.id}`);
    }
    destinations.reload();
  };

  const toggleStatus = async (row: Destination) => {
    try {
      await destinationService.update(row.id, { status: row.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' });
      toast.success(row.status === 'ACTIVE' ? `«${row.name}» ya no es visible en la web.` : `«${row.name}» está publicado.`);
      destinations.reload();
    } catch (error) {
      fail('No se pudo cambiar el estado', error);
    }
  };

  const move = async (row: Destination, direction: -1 | 1) => {
    const index = all.findIndex((item) => item.id === row.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= all.length) return;
    const ids = all.map((item) => item.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    try {
      await destinationService.reorder(ids);
      destinations.reload();
    } catch (error) {
      fail('No se pudo reordenar', error);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await destinationService.remove(deleting.id);
      toast.success(`«${deleting.name}» eliminado.`);
      setDeleting(null);
      destinations.reload();
    } catch (error) {
      fail('No se pudo eliminar', error);
    } finally {
      setBusy(false);
    }
  };

  const columns: Array<Column<Destination>> = [
    { key: 'image', header: 'Imagen', render: (row) => <Thumbnail reference={row.hero_image} name={row.name} /> },
    {
      key: 'name',
      header: 'Destino',
      render: (row) => (
        <span>
          <span className="block font-semibold text-ink">{row.name}</span>
          {row.subtitle && <span className="block text-xs text-muted">{row.subtitle}</span>}
        </span>
      ),
    },
    { key: 'slug', header: 'Slug', render: (row) => <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">/destinos/{row.slug}</code> },
    { key: 'price', header: 'Precio desde', render: (row) => (row.price_from === null ? <span className="text-muted">—</span> : formatCurrency(row.price_from)) },
    { key: 'status', header: 'Estado', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'order',
      header: 'Orden',
      render: (row) => {
        const index = all.findIndex((item) => item.id === row.id);
        return (
          <span className="flex items-center gap-1">
            <span className="w-6 text-center font-semibold tabular-nums">{index + 1}</span>
            <IconButton label={`Subir ${row.name}`} disabled={filtering || index <= 0} onClick={() => void move(row, -1)}>
              <ArrowUp className="h-4 w-4" />
            </IconButton>
            <IconButton label={`Bajar ${row.name}`} disabled={filtering || index >= all.length - 1} onClick={() => void move(row, 1)}>
              <ArrowDown className="h-4 w-4" />
            </IconButton>
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: 'Acciones',
      render: (row) => <RowActions row={row} onEdit={() => { setEditing(row); setFormOpen(true); }} onContent={() => navigate(`/admin/destinations/${row.id}`)} onToggle={() => void toggleStatus(row)} onDelete={() => setDeleting(row)} />,
    },
  ];

  return (
    <>
      <PageHeader
        title="Gestión de destinos"
        description="Contenido de «Descubre más destinos» y de las páginas /destinos/:slug. El precio «desde» es informativo: no cambia el precio real de los viajes."
        breadcrumbs={[{ label: 'Contenido' }, { label: 'Destinos' }]}
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => { setEditing(null); setFormOpen(true); }}>
            Nuevo destino
          </Button>
        }
      />

      <Card padded={false}>
        <div className="border-b border-border p-4">
          <FilterBar>
            <SearchBar placeholder="Buscar por nombre o slug" value={search} onChange={(event) => setSearch(event.target.value)} className="min-w-[220px] flex-1" />
            <Select
              aria-label="Filtrar por estado"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              options={[
                { value: 'ACTIVE', label: 'Publicados' },
                { value: 'INACTIVE', label: 'Ocultos' },
              ]}
              placeholder="Todos los estados"
              containerClassName="w-full sm:w-48"
            />
          </FilterBar>
          {filtering && <p className="mt-2 text-xs text-muted">Quita la búsqueda y el filtro para cambiar el orden.</p>}
        </div>

        {destinations.error ? (
          <ErrorState error={destinations.error} onRetry={destinations.reload} />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            loading={destinations.loading}
            loadingState={<TableSkeleton rows={4} columns={6} />}
            emptyState={
              <EmptyState
                icon={<MapPinned className="h-7 w-7" />}
                title={filtering ? 'Ningún destino coincide' : 'Aún no hay destinos'}
                description={filtering ? 'Prueba con otra búsqueda.' : 'Crea el primero para mostrarlo en «Descubre más destinos».'}
              />
            }
            mobileCard={(row) => (
              <div className="flex gap-3 p-4">
                <Thumbnail reference={row.hero_image} name={row.name} />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-ink">{row.name}</p>
                  <p className="truncate text-xs text-muted">/destinos/{row.slug}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <StatusBadge status={row.status} />
                    <span className="text-xs text-muted">Orden {all.findIndex((item) => item.id === row.id) + 1}</span>
                  </div>
                  <div className="mt-2">
                    <RowActions row={row} onEdit={() => { setEditing(row); setFormOpen(true); }} onContent={() => navigate(`/admin/destinations/${row.id}`)} onToggle={() => void toggleStatus(row)} onDelete={() => setDeleting(row)} />
                  </div>
                </div>
              </div>
            )}
          />
        )}
      </Card>

      <ResourceForm
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        onSubmit={submit}
        title={editing ? `Editar «${editing.name}»` : 'Nuevo destino'}
        description={editing ? 'Cambiar el nombre no cambia la URL publicada.' : 'Si dejas el slug vacío se genera a partir del nombre. La imagen se sube después, en «Gestionar contenido».'}
        fields={fields}
        size="lg"
        initialValues={editing ? (editing as unknown as Record<string, unknown>) : null}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        loading={busy}
        title="Eliminar destino"
        confirmLabel="Eliminar"
        message={
          deleting?.status === 'ACTIVE' ? (
            <>«{deleting.name}» está publicado. Desactívalo primero: un destino publicado no se elimina directamente.</>
          ) : (
            <>Se eliminará «{deleting?.name}» con sus atractivos, festividades e imágenes. Esta acción no se puede deshacer.</>
          )
        }
      />
    </>
  );
}

function Thumbnail({ reference, name }: { reference: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  const url = failed ? null : mediaUrl(reference);
  return (
    <span className="flex h-12 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100">
      {url ? <img src={url} alt={name} onError={() => setFailed(true)} className="h-full w-full object-cover" /> : <ImageOff className="h-5 w-5 text-slate-300" aria-hidden />}
    </span>
  );
}

function IconButton({ label, disabled, onClick, children, tone = 'neutral' }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode; tone?: 'neutral' | 'danger' }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={
        tone === 'danger'
          ? 'rounded-lg p-1.5 text-slate-500 transition hover:bg-danger-50 hover:text-danger-600 disabled:opacity-30'
          : 'rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30'
      }
    >
      {children}
    </button>
  );
}

function RowActions({ row, onEdit, onContent, onToggle, onDelete }: { row: Destination; onEdit: () => void; onContent: () => void; onToggle: () => void; onDelete: () => void }) {
  return (
    <span className="flex items-center gap-0.5">
      <IconButton label={`Editar ${row.name}`} onClick={onEdit}>
        <Pencil className="h-4 w-4" />
      </IconButton>
      <IconButton label={`Gestionar contenido de ${row.name}`} onClick={onContent}>
        <LayoutList className="h-4 w-4" />
      </IconButton>
      <IconButton label={row.status === 'ACTIVE' ? `Desactivar ${row.name}` : `Activar ${row.name}`} onClick={onToggle}>
        {row.status === 'ACTIVE' ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </IconButton>
      <IconButton label={`Eliminar ${row.name}`} tone="danger" onClick={onDelete}>
        <Trash2 className="h-4 w-4" />
      </IconButton>
    </span>
  );
}
