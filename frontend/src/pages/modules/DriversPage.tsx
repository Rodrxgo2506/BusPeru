import { CalendarClock, IdCard, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';
import { ResourceForm, type FormField } from '@/components/common/ResourceForm';
import {
  Badge,
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
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { ApiError } from '@/services/api';
import { driverService } from '@/services';
import type { Driver } from '@/types';
import { formatDate, formatNumber } from '@/utils/format';

const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Activo' },
  { value: 'INACTIVE', label: 'Inactivo' },
];

const FORM_FIELDS: FormField[] = [
  { name: 'first_name', label: 'Nombres', required: true, placeholder: 'Carlos' },
  { name: 'last_name', label: 'Apellidos', required: true, placeholder: 'Mendoza' },
  { name: 'document_number', label: 'Documento (DNI o carné)', required: true, placeholder: '44556677' },
  { name: 'license_number', label: 'Número de licencia', required: true, placeholder: 'Q44556677' },
  { name: 'license_expires_at', label: 'Vencimiento de la licencia', type: 'date' },
  { name: 'phone', label: 'Teléfono', type: 'tel', placeholder: '987 654 321' },
  { name: 'status', label: 'Estado', type: 'select', options: STATUS_OPTIONS },
];

/**
 * Conductores y copilotos de la empresa (mockup 31).
 *
 * La tabla `drivers` no distingue conductor de copiloto: el puesto lo decide el viaje,
 * así que esta pantalla gestiona una única plantilla de personal de conducción.
 */
export function DriversPage() {
  const { hasPermission } = useAuth();
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const drivers = useAsync(() => driverService.list({ search: search || undefined, status: status || undefined }), [search, status]);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Driver | null>(null);
  const [deleting, setDeleting] = useState<Driver | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  const canCreate = hasPermission('buses.create');
  const canUpdate = hasPermission('buses.update');
  const canDelete = hasPermission('buses.delete');

  const rows = drivers.data ?? [];

  const submit = async (values: Record<string, unknown>) => {
    const payload = {
      ...values,
      license_expires_at: values.license_expires_at ? String(values.license_expires_at) : null,
      phone: values.phone ? String(values.phone) : null,
    };

    if (editing) await driverService.update(editing.id, payload);
    else await driverService.create(payload);

    toast.success(editing ? 'Conductor actualizado.' : 'Conductor registrado.');
    drivers.reload();
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      await driverService.remove(deleting.id);
      toast.success('Conductor eliminado.');
      setDeleting(null);
      drivers.reload();
    } catch (error) {
      toast.error('No se pudo eliminar', error instanceof ApiError ? error.message : undefined);
    } finally {
      setDeletingBusy(false);
    }
  };

  const columns: Array<Column<Driver>> = [
    {
      key: 'name',
      header: 'Conductor',
      render: (driver) => (
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
            <UserRound className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block font-semibold text-ink">
              {driver.first_name} {driver.last_name}
            </span>
            <span className="block truncate text-xs text-muted">{driver.phone ?? 'Sin teléfono'}</span>
          </span>
        </div>
      ),
    },
    { key: 'document', header: 'Documento', render: (driver) => driver.document_number },
    {
      key: 'license',
      header: 'Licencia',
      render: (driver) => (
        <span className="min-w-0">
          <span className="block font-medium text-ink">{driver.license_number}</span>
          {driver.license_expires_at && (
            <span className="block text-xs text-muted">Vence {formatDate(driver.license_expires_at)}</span>
          )}
        </span>
      ),
      hideOnMobile: true,
    },
    { key: 'trips', header: 'Viajes', render: (driver) => formatNumber(driver.trips_count ?? 0), hideOnMobile: true },
    { key: 'status', header: 'Estado', render: (driver) => <StatusBadge status={driver.status} /> },
    {
      key: '__actions',
      header: 'Acciones',
      headerClassName: 'text-right',
      className: 'text-right',
      render: (driver) => (
        <div className="flex items-center justify-end gap-1">
          {canUpdate && (
            <button
              type="button"
              onClick={() => {
                setEditing(driver);
                setFormOpen(true);
              }}
              className="rounded-lg p-2 text-slate-500 transition hover:bg-brand-50 hover:text-brand-600"
              aria-label="Editar conductor"
            >
              <Pencil className="h-4 w-4" />
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={() => setDeleting(driver)}
              className="rounded-lg p-2 text-slate-500 transition hover:bg-danger-50 hover:text-danger-600"
              aria-label="Eliminar conductor"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Conductores"
        description="Personal de conducción que puedes asignar como conductor o copiloto de tus viajes."
        breadcrumbs={[{ label: 'Portal Empresa' }, { label: 'Conductores' }]}
        actions={
          canCreate ? (
            <Button
              icon={<Plus className="h-4 w-4" />}
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              Nuevo conductor
            </Button>
          ) : undefined
        }
      />

      <Card padded={false}>
        <div className="border-b border-border p-4">
          <FilterBar>
            <SearchBar
              className="min-w-0 flex-1 sm:max-w-sm"
              placeholder="Buscar por nombre, documento o licencia..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Buscar conductores"
            />
            <Select
              options={STATUS_OPTIONS}
              placeholder="Todos los estados"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              containerClassName="w-full sm:w-auto sm:min-w-[180px]"
              aria-label="Filtrar por estado"
            />
          </FilterBar>
        </div>

        {drivers.error ? (
          <ErrorState error={drivers.error} onRetry={drivers.reload} />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(driver) => driver.id}
            loading={drivers.loading}
            loadingState={<TableSkeleton columns={5} />}
            mobileCard={(driver) => (
              <div className="card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">
                      {driver.first_name} {driver.last_name}
                    </p>
                    <p className="truncate text-sm text-muted">{driver.phone ?? 'Sin teléfono'}</p>
                  </div>
                  <StatusBadge status={driver.status} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  <Badge>
                    <IdCard className="h-3 w-3" /> {driver.document_number}
                  </Badge>
                  <Badge>{driver.license_number}</Badge>
                  {driver.license_expires_at && (
                    <Badge>
                      <CalendarClock className="h-3 w-3" /> {formatDate(driver.license_expires_at)}
                    </Badge>
                  )}
                </div>
              </div>
            )}
            emptyState={
              <EmptyState
                title="Aún no registraste conductores"
                description="Registra a tu personal de conducción para poder asignarlo a los viajes."
                icon={<UserRound className="h-7 w-7" />}
                action={
                  canCreate ? (
                    <Button
                      icon={<Plus className="h-4 w-4" />}
                      onClick={() => {
                        setEditing(null);
                        setFormOpen(true);
                      }}
                    >
                      Registrar el primero
                    </Button>
                  ) : undefined
                }
              />
            }
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
        title={editing ? 'Editar conductor' : 'Nuevo conductor'}
        description="Estos datos identifican al personal que conduce tus buses."
        fields={FORM_FIELDS}
        size="lg"
        initialValues={editing ? (editing as unknown as Record<string, unknown>) : null}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        loading={deletingBusy}
        title="Eliminar conductor"
        confirmLabel="Sí, eliminar"
        message="Solo puedes eliminarlo si no tiene viajes por delante. Los viajes ya completados conservarán el registro sin tripulación."
      />
    </>
  );
}
