import { Armchair, Bell, Building2, Bus, CheckCheck, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ResourcePage } from '@/components/common/ResourcePage';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  PageHeader,
  PermissionDenied,
  StatusBadge,
  Textarea,
  type Column,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { ApiError } from '@/services/api';
import { busTypeService, companyService, notificationService, seatTypeService } from '@/services';
import type { BusType, Company, SeatType } from '@/types';
import { formatDateTime, formatNumber } from '@/utils/format';

/**
 * Bandeja de notificaciones del usuario del portal empresa.
 * El catálogo de plantillas y el envío masivo viven solo en el panel admin:
 * `notification_templates` usa el módulo de permisos `settings`, que ningún rol de
 * empresa tiene, y abrirlo mezclaría datos entre empresas.
 */
export function CompanyNotificationsPage() {
  const toast = useToast();
  const notifications = useAsync(() => notificationService.list({ limit: 50 }), []);
  const rows = notifications.data?.data ?? [];
  const unread = rows.filter((row) => row.is_read === 0).length;

  const markAll = async () => {
    try {
      await notificationService.markAllRead();
      toast.success('Notificaciones marcadas como leídas');
      notifications.reload();
    } catch (error) {
      toast.error('No se pudo actualizar', error instanceof ApiError ? error.message : undefined);
    }
  };

  const remove = async (id: number) => {
    try {
      await notificationService.remove(id);
      notifications.reload();
    } catch (error) {
      toast.error('No se pudo eliminar', error instanceof ApiError ? error.message : undefined);
    }
  };

  return (
    <>
      <PageHeader
        title="Notificaciones"
        description="Avisos de reservas, pagos, cancelaciones y reembolsos de tu empresa."
        breadcrumbs={[{ label: 'Portal Empresa' }, { label: 'Notificaciones' }]}
        actions={
          unread > 0 ? (
            <Button variant="outline" size="sm" icon={<CheckCheck className="h-4 w-4" />} onClick={() => void markAll()}>
              Marcar todas como leídas ({formatNumber(unread)})
            </Button>
          ) : undefined
        }
      />

      {notifications.error ? (
        <Card padded={false}>
          <ErrorState error={notifications.error} onRetry={notifications.reload} />
        </Card>
      ) : notifications.loading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            title="No tienes notificaciones"
            description="Aquí aparecerán los avisos automáticos de reservas, pagos y reembolsos."
            icon={<Bell className="h-7 w-7" />}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((notification) => (
            <Card key={notification.id} className={notification.is_read === 0 ? 'border-brand-200 bg-brand-50/40' : undefined}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-ink">{notification.title}</p>
                    <Badge>{notification.type}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted">{notification.message}</p>
                  <p className="mt-2 text-xs text-slate-400">{formatDateTime(notification.created_at)}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  {notification.is_read === 0 && (
                    <button
                      type="button"
                      onClick={() => void notificationService.markRead(notification.id).then(notifications.reload)}
                      className="rounded-lg p-2 text-slate-500 transition hover:bg-white hover:text-brand-600"
                      aria-label="Marcar como leída"
                    >
                      <CheckCheck className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void remove(notification.id)}
                    className="rounded-lg p-2 text-slate-500 transition hover:bg-danger-50 hover:text-danger-600"
                    aria-label="Eliminar notificación"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

const COMPANY_FIELDS: Array<{ name: keyof Company & string; label: string; type?: 'text' | 'email'; adminOnly?: boolean }> = [
  { name: 'name', label: 'Nombre comercial' },
  { name: 'legal_name', label: 'Razón social' },
  // El RUC es el dato fiscal que verifica la plataforma: el backend rechaza cambiarlo
  // desde un rol de empresa, así que aquí se muestra pero no se ofrece editar.
  { name: 'tax_id', label: 'RUC', adminOnly: true },
  { name: 'email', label: 'Correo de contacto', type: 'email' },
  { name: 'phone', label: 'Teléfono' },
  { name: 'logo_url', label: 'URL del logotipo' },
];

/**
 * "Configuración" del portal empresa: la ficha de la propia empresa.
 * La configuración global (`system_settings`) sigue siendo exclusiva del panel admin;
 * una empresa no debe leer ni tocar parámetros de la plataforma.
 */
export function CompanyProfilePage() {
  const { user, hasPermission } = useAuth();
  const toast = useToast();
  const companyId = user?.companyIds[0];

  const company = useAsync(() => (companyId ? companyService.get(companyId) : Promise.resolve(null)), [companyId]);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);

  const canEdit = hasPermission('companies.update');

  if (!hasPermission('companies.view')) return <PermissionDenied />;

  if (companyId === undefined) {
    return (
      <>
        <PageHeader title="Configuración" breadcrumbs={[{ label: 'Portal Empresa' }, { label: 'Configuración' }]} />
        <Card padded={false}>
          <EmptyState
            title="Tu usuario no está asociado a ninguna empresa"
            description="Pide a un administrador que te vincule a una empresa para poder editar su ficha."
            icon={<Building2 className="h-7 w-7" />}
          />
        </Card>
      </>
    );
  }

  const loaded = company.data;
  const values =
    draft ??
    (loaded
      ? {
          ...Object.fromEntries(COMPANY_FIELDS.map((field) => [field.name, String(loaded[field.name] ?? '')])),
          description: String(loaded.description ?? ''),
        }
      : null);

  const save = async () => {
    if (!values) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { description: values.description?.trim() || null };
      for (const field of COMPANY_FIELDS) payload[field.name] = values[field.name]?.trim() || null;

      await companyService.update(companyId, payload);
      toast.success('Datos de la empresa actualizados.');
      setDraft(null);
      company.reload();
    } catch (error) {
      toast.error('No se pudieron guardar los cambios', error instanceof ApiError ? error.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Configuración"
        description="Datos de tu empresa, visibles para los pasajeros en el portal público."
        breadcrumbs={[{ label: 'Portal Empresa' }, { label: 'Configuración' }]}
        actions={
          canEdit ? (
            <Button icon={<Save className="h-4 w-4" />} loading={saving} disabled={!values || draft === null} onClick={() => void save()}>
              Guardar cambios
            </Button>
          ) : undefined
        }
      />

      {company.error ? (
        <Card padded={false}>
          <ErrorState error={company.error} onRetry={company.reload} />
        </Card>
      ) : company.loading || !values || !loaded ? (
        <LoadingState />
      ) : (
        <Card>
          <div className="mb-6 flex items-center justify-between gap-4 border-b border-border pb-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                <Building2 className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="truncate font-semibold text-ink">{loaded.name}</p>
                <p className="text-xs text-muted">Registrada el {formatDateTime(loaded.created_at)}</p>
              </div>
            </div>
            <StatusBadge status={loaded.status} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {COMPANY_FIELDS.map((field) => (
              <Input
                key={field.name}
                label={field.label}
                type={field.type ?? 'text'}
                value={values[field.name] ?? ''}
                disabled={!canEdit || (field.adminOnly && user?.role !== 'ADMIN')}
                hint={field.adminOnly && user?.role !== 'ADMIN' ? 'Solo un administrador de la plataforma puede cambiarlo.' : undefined}
                onChange={(event) => setDraft({ ...values, [field.name]: event.target.value })}
              />
            ))}
            <div className="sm:col-span-2">
              <Textarea
                label="Descripción"
                rows={4}
                value={values.description ?? ''}
                disabled={!canEdit}
                onChange={(event) => setDraft({ ...values, description: event.target.value })}
              />
            </div>
          </div>

          <p className="mt-4 text-xs text-muted">El estado de la empresa solo puede cambiarlo un administrador de la plataforma.</p>
        </Card>
      )}
    </>
  );
}

const ACTIVE_OPTIONS = [
  { value: 'ACTIVE', label: 'Activo' },
  { value: 'INACTIVE', label: 'Inactivo' },
];

/** Catálogo global de tipos de bus: se lee con `buses.view`, solo el ADMIN lo escribe. */
export function BusTypesPage() {
  const columns: Array<Column<BusType>> = [
    {
      key: 'name',
      header: 'Tipo de bus',
      sortColumn: 'bt.name',
      render: (type) => (
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            <Bus className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block font-semibold text-ink">{type.name}</span>
            <span className="block truncate text-xs text-muted">{type.description ?? '—'}</span>
          </span>
        </div>
      ),
    },
    {
      key: 'capacity',
      header: 'Capacidad por defecto',
      render: (type) => (type.default_capacity ? `${type.default_capacity} asientos` : '—'),
    },
    { key: 'status', header: 'Estado', render: (type) => <StatusBadge status={type.status} /> },
  ];

  return (
    <ResourcePage<BusType>
      title="Tipos de bus"
      description="Catálogo compartido por todas las empresas (Cama, Semicama, Ejecutivo...)."
      breadcrumbs={[{ label: 'Administración' }, { label: 'Tipos de bus' }]}
      loader={(params) => busTypeService.list(params)}
      columns={columns}
      permissionModule="buses"
      adminOnlyWrites
      entityLabel="Tipo de bus"
      searchPlaceholder="Buscar por nombre..."
      filters={[{ key: 'status', placeholder: 'Todos los estados', options: ACTIVE_OPTIONS }]}
      formFields={[
        { name: 'name', label: 'Nombre', required: true, placeholder: 'Ej: Cama 160' },
        { name: 'default_capacity', label: 'Capacidad por defecto', type: 'number', placeholder: '40' },
        { name: 'description', label: 'Descripción', type: 'textarea', full: true },
        { name: 'status', label: 'Estado', type: 'select', options: ACTIVE_OPTIONS },
      ]}
      onCreate={(values) => busTypeService.create(values).then(() => undefined)}
      onUpdate={(id, values) => busTypeService.update(id, values).then(() => undefined)}
      onDelete={(id) => busTypeService.remove(id).then(() => undefined)}
      emptyTitle="No hay tipos de bus"
      emptyDescription="Crea los tipos de bus que las empresas podrán asignar a su flota."
    />
  );
}

/** Catálogo global de tipos de asiento: se lee con `buses.view`, solo el ADMIN lo escribe. */
export function SeatTypesPage() {
  const columns: Array<Column<SeatType>> = [
    {
      key: 'name',
      header: 'Tipo de asiento',
      sortColumn: 'st.name',
      render: (type) => (
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            <Armchair className="h-5 w-5" />
          </span>
          <span className="font-semibold text-ink">{type.name}</span>
        </div>
      ),
    },
    { key: 'description', header: 'Descripción', render: (type) => type.description ?? '—' },
  ];

  return (
    <ResourcePage<SeatType>
      title="Tipos de asiento"
      description="Categorías de asiento usadas al configurar la distribución de cada bus."
      breadcrumbs={[{ label: 'Administración' }, { label: 'Tipos de asiento' }]}
      loader={(params) => seatTypeService.list(params)}
      columns={columns}
      permissionModule="buses"
      adminOnlyWrites
      entityLabel="Tipo de asiento"
      searchPlaceholder="Buscar por nombre..."
      formFields={[
        { name: 'name', label: 'Nombre', required: true, placeholder: 'Ej: Cama' },
        { name: 'description', label: 'Descripción', type: 'textarea', full: true },
      ]}
      onCreate={(values) => seatTypeService.create(values).then(() => undefined)}
      onUpdate={(id, values) => seatTypeService.update(id, values).then(() => undefined)}
      onDelete={(id) => seatTypeService.remove(id).then(() => undefined)}
      emptyTitle="No hay tipos de asiento"
      emptyDescription="Crea las categorías de asiento que usarán las empresas."
    />
  );
}
