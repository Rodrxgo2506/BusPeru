import { Armchair, Bus, CheckCircle2, MapPin, Plus, Route as RouteIcon, Trash2, Wrench, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ResourcePage } from '@/components/common/ResourcePage';
import { Badge, Button, EmptyState, ErrorState, Input, LoadingState, Modal, Select, StatCard, StatusBadge, type Column } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { ApiError } from '@/services/api';
import { busService, busTypeService, companyService, locationService, routeService, routeStopService } from '@/services';
import type { Bus as BusEntity, Location, Route } from '@/types';
import { LOCATION_TYPE_LABELS } from '@/constants/labels';
import { formatNumber } from '@/utils/format';

const STATUS_FILTER = {
  key: 'status',
  placeholder: 'Todos los estados',
  options: [
    { value: 'ACTIVE', label: 'Activo' },
    { value: 'INACTIVE', label: 'Inactivo' },
    { value: 'MAINTENANCE', label: 'En mantenimiento' },
  ],
};

export function BusesPage({ scope }: { scope: 'company' | 'admin' }) {
  const busTypes = useAsync(() => busTypeService.list({ limit: 100 }), []);
  const companies = useAsync(() => (scope === 'admin' ? companyService.list({ limit: 200 }) : Promise.resolve({ data: [] })), [scope]);

  /** Counts come from the API's own pagination totals, one cheap request per status. */
  const stats = useAsync(async () => {
    const [total, active, maintenance, inactive] = await Promise.all([
      busService.list({ limit: 1 }),
      busService.list({ limit: 1, status: 'ACTIVE' }),
      busService.list({ limit: 1, status: 'MAINTENANCE' }),
      busService.list({ limit: 1, status: 'INACTIVE' }),
    ]);
    return {
      total: total.pagination?.total ?? 0,
      active: active.pagination?.total ?? 0,
      maintenance: maintenance.pagination?.total ?? 0,
      inactive: inactive.pagination?.total ?? 0,
    };
  }, []);

  const columns: Array<Column<BusEntity>> = [
    {
      key: 'code',
      header: 'Bus',
      sortColumn: 'b.code',
      render: (bus) => (
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            <Bus className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block font-semibold text-ink">{bus.code}</span>
            <span className="block truncate text-xs text-muted">
              {bus.brand} {bus.model}
            </span>
          </span>
        </div>
      ),
    },
    { key: 'plate', header: 'Placa', sortColumn: 'b.plate_number', render: (bus) => <span className="font-medium">{bus.plate_number}</span> },
    { key: 'type', header: 'Tipo', render: (bus) => bus.bus_type_name ?? '—', hideOnMobile: true },
    { key: 'capacity', header: 'Capacidad', sortColumn: 'b.capacity', render: (bus) => `${bus.capacity} asientos` },
    { key: 'seats', header: 'Asientos creados', render: (bus) => formatNumber(bus.seats_count ?? 0), hideOnMobile: true },
    ...(scope === 'admin' ? [{ key: 'company', header: 'Empresa', render: (bus: BusEntity) => bus.company_name ?? '—', hideOnMobile: true }] : []),
    { key: 'status', header: 'Estado', render: (bus) => <StatusBadge status={bus.status} /> },
  ];

  return (
    <ResourcePage<BusEntity>
      title={scope === 'company' ? 'Mis buses' : 'Buses'}
      description={scope === 'company' ? 'Gestiona tu flota de buses' : 'Todos los buses registrados en la plataforma'}
      breadcrumbs={[{ label: scope === 'company' ? 'Portal Empresa' : 'Administración' }, { label: 'Buses' }]}
      loader={(params) => busService.list(params)}
      columns={columns}
      permissionModule="buses"
      entityLabel="Bus"
      searchPlaceholder="Buscar por código, placa o modelo..."
      filters={[
        STATUS_FILTER,
        {
          key: 'bus_type_id',
          placeholder: 'Todos los tipos',
          options: (busTypes.data?.data ?? []).map((type) => ({ value: String(type.id), label: type.name })),
        },
      ]}
      stats={
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Total de buses" value={stats.loading ? '—' : formatNumber(stats.data?.total ?? 0)} icon={<Bus className="h-5 w-5" />} tone="brand" />
          <StatCard label="Activos" value={stats.loading ? '—' : formatNumber(stats.data?.active ?? 0)} icon={<CheckCircle2 className="h-5 w-5" />} tone="success" />
          <StatCard label="En mantenimiento" value={stats.loading ? '—' : formatNumber(stats.data?.maintenance ?? 0)} icon={<Wrench className="h-5 w-5" />} tone="warning" />
          <StatCard label="Inactivos" value={stats.loading ? '—' : formatNumber(stats.data?.inactive ?? 0)} icon={<XCircle className="h-5 w-5" />} tone="danger" />
        </div>
      }
      formFields={[
        ...(scope === 'admin'
          ? [
              {
                name: 'company_id',
                label: 'Empresa',
                type: 'select' as const,
                required: true,
                options: (companies.data?.data ?? []).map((company) => ({ value: company.id, label: company.name })),
              },
            ]
          : []),
        { name: 'code', label: 'Código interno', required: true, placeholder: 'Ej: EA-001' },
        { name: 'plate_number', label: 'Placa', required: true, placeholder: 'Ej: B2X-963' },
        { name: 'brand', label: 'Marca', placeholder: 'Ej: Marcopolo' },
        { name: 'model', label: 'Modelo', placeholder: 'Ej: Paradiso G8 1800 DD' },
        { name: 'year', label: 'Año', type: 'number', placeholder: '2023' },
        { name: 'capacity', label: 'Capacidad total', type: 'number', required: true, placeholder: '42' },
        {
          name: 'bus_type_id',
          label: 'Tipo de bus',
          type: 'select',
          options: (busTypes.data?.data ?? []).map((type) => ({ value: type.id, label: type.name })),
        },
        {
          name: 'status',
          label: 'Estado',
          type: 'select',
          options: [
            { value: 'ACTIVE', label: 'Activo' },
            { value: 'INACTIVE', label: 'Inactivo' },
            { value: 'MAINTENANCE', label: 'En mantenimiento' },
          ],
        },
      ]}
      onCreate={(values) => busService.create(values).then(() => undefined)}
      onUpdate={(id, values) => busService.update(id, values).then(() => undefined)}
      onDelete={(id) => busService.remove(id).then(() => undefined)}
      extraActions={(bus) => (
        <Link
          to={`${scope === 'company' ? '/company' : '/admin'}/buses/${bus.id}/asientos`}
          className="rounded-lg p-2 text-slate-500 transition hover:bg-brand-50 hover:text-brand-600"
          aria-label="Configurar asientos"
          title="Configurar asientos"
        >
          <Armchair className="h-4 w-4" />
        </Link>
      )}
      emptyTitle="No hay buses registrados"
      emptyDescription="Registra tu primer bus para poder programar viajes."
      mobileCard={(bus) => (
        <div className="card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold text-ink">{bus.code}</p>
              <p className="truncate text-sm text-muted">
                {bus.brand} {bus.model}
              </p>
            </div>
            <StatusBadge status={bus.status} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted">
            <Badge>{bus.plate_number}</Badge>
            <Badge>{bus.capacity} asientos</Badge>
            {bus.bus_type_name && <Badge>{bus.bus_type_name}</Badge>}
          </div>
        </div>
      )}
    />
  );
}

export function LocationsPage({ scope }: { scope: 'company' | 'admin' }) {
  const columns: Array<Column<Location>> = [
    {
      key: 'name',
      header: 'Terminal / Ciudad',
      sortColumn: 'l.name',
      render: (location) => (
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            <MapPin className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block font-semibold text-ink">{location.name}</span>
            <span className="block truncate text-xs text-muted">{location.address ?? '—'}</span>
          </span>
        </div>
      ),
    },
    { key: 'city', header: 'Ciudad', sortColumn: 'l.city', render: (location) => location.city },
    { key: 'department', header: 'Departamento', render: (location) => location.department ?? '—', hideOnMobile: true },
    { key: 'type', header: 'Tipo', render: (location) => <Badge>{LOCATION_TYPE_LABELS[location.type] ?? location.type}</Badge> },
    { key: 'status', header: 'Estado', render: (location) => <StatusBadge status={location.status} /> },
  ];

  return (
    <ResourcePage<Location>
      title={scope === 'company' ? 'Mis terminales' : 'Ciudades y terminales'}
      description={
        scope === 'company'
          ? 'Catálogo de terminales de la plataforma. Solo lectura: las gestiona el administrador.'
          : 'Ubicaciones utilizadas como origen, destino y paradas de las rutas.'
      }
      breadcrumbs={[{ label: scope === 'company' ? 'Portal Empresa' : 'Administración' }, { label: 'Terminales' }]}
      loader={(params) => locationService.list(params)}
      columns={columns}
      permissionModule="routes"
      adminOnlyWrites
      entityLabel="Terminal"
      searchPlaceholder="Buscar por nombre, ciudad o dirección..."
      filters={[
        {
          key: 'type',
          placeholder: 'Todos los tipos',
          options: Object.entries(LOCATION_TYPE_LABELS).map(([value, labelText]) => ({ value, label: labelText })),
        },
        {
          key: 'status',
          placeholder: 'Todos los estados',
          options: [
            { value: 'ACTIVE', label: 'Activo' },
            { value: 'INACTIVE', label: 'Inactivo' },
          ],
        },
      ]}
      formFields={[
        { name: 'name', label: 'Nombre', required: true, placeholder: 'Ej: Terminal Plaza Norte' },
        { name: 'city', label: 'Ciudad', required: true, placeholder: 'Ej: Lima' },
        { name: 'province', label: 'Provincia', placeholder: 'Ej: Lima' },
        { name: 'department', label: 'Departamento', placeholder: 'Ej: Lima' },
        { name: 'address', label: 'Dirección', full: true, placeholder: 'Av. Tomás Valle 3600, Independencia' },
        { name: 'latitude', label: 'Latitud', type: 'number', step: 'any', placeholder: '-11.97854' },
        { name: 'longitude', label: 'Longitud', type: 'number', step: 'any', placeholder: '-77.06372' },
        {
          name: 'type',
          label: 'Tipo',
          type: 'select',
          options: Object.entries(LOCATION_TYPE_LABELS).map(([value, labelText]) => ({ value, label: labelText })),
        },
        {
          name: 'status',
          label: 'Estado',
          type: 'select',
          options: [
            { value: 'ACTIVE', label: 'Activo' },
            { value: 'INACTIVE', label: 'Inactivo' },
          ],
        },
      ]}
      onCreate={(values) => locationService.create(values).then(() => undefined)}
      onUpdate={(id, values) => locationService.update(id, values).then(() => undefined)}
      onDelete={(id) => locationService.remove(id).then(() => undefined)}
      emptyTitle="No hay terminales registradas"
      emptyDescription="Registra las terminales que utilizarás en tus rutas."
    />
  );
}

export function RoutesPage({ scope }: { scope: 'company' | 'admin' }) {
  const [stopsRoute, setStopsRoute] = useState<Route | null>(null);
  const locations = useAsync(() => locationService.list({ limit: 200, status: 'ACTIVE' }), []);
  const companies = useAsync(() => (scope === 'admin' ? companyService.list({ limit: 200 }) : Promise.resolve({ data: [] })), [scope]);

  const locationOptions = (locations.data?.data ?? []).map((location) => ({ value: location.id, label: `${location.name} (${location.city})` }));

  const columns: Array<Column<Route>> = [
    {
      key: 'route',
      header: 'Ruta',
      render: (route) => (
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            <RouteIcon className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block font-semibold text-ink">
              {route.origin_city} → {route.destination_city}
            </span>
            <span className="block truncate text-xs text-muted">
              {route.origin_name} → {route.destination_name}
            </span>
          </span>
        </div>
      ),
    },
    { key: 'distance', header: 'Distancia', sortColumn: 'r.distance_km', render: (route) => (route.distance_km ? `${formatNumber(route.distance_km)} km` : '—') },
    { key: 'trips', header: 'Viajes', render: (route) => formatNumber(route.trips_count ?? 0), hideOnMobile: true },
    { key: 'stops', header: 'Paradas', render: (route) => formatNumber(route.stops_count ?? 0), hideOnMobile: true },
    ...(scope === 'admin' ? [{ key: 'company', header: 'Empresa', render: (route: Route) => route.company_name ?? '—', hideOnMobile: true }] : []),
    { key: 'status', header: 'Estado', render: (route) => <StatusBadge status={route.status} /> },
  ];

  const page = (
    <ResourcePage<Route>
      title={scope === 'company' ? 'Mis rutas' : 'Rutas'}
      description={scope === 'company' ? 'Administra las rutas que ofrece tu empresa.' : 'Administra las rutas de todas las empresas de la plataforma.'}
      breadcrumbs={[{ label: scope === 'company' ? 'Portal Empresa' : 'Administración' }, { label: 'Rutas' }]}
      loader={(params) => routeService.list(params)}
      columns={columns}
      permissionModule="routes"
      entityLabel="Ruta"
      entityGender="f"
      searchPlaceholder="Buscar por nombre o destino..."
      filters={[
        {
          key: 'status',
          placeholder: 'Todos los estados',
          options: [
            { value: 'ACTIVE', label: 'Activa' },
            { value: 'INACTIVE', label: 'Inactiva' },
          ],
        },
      ]}
      formFields={[
        ...(scope === 'admin'
          ? [
              {
                name: 'company_id',
                label: 'Empresa',
                type: 'select' as const,
                required: true,
                options: (companies.data?.data ?? []).map((company) => ({ value: company.id, label: company.name })),
              },
            ]
          : []),
        { name: 'origin_location_id', label: 'Terminal de origen', type: 'select', required: true, options: locationOptions },
        { name: 'destination_location_id', label: 'Terminal de destino', type: 'select', required: true, options: locationOptions },
        { name: 'name', label: 'Nombre de la ruta', full: true, placeholder: 'Ej: Lima → Huánuco' },
        { name: 'distance_km', label: 'Distancia (km)', type: 'number', step: 'any', placeholder: '398' },
        { name: 'estimated_duration_minutes', label: 'Duración estimada (minutos)', type: 'number', placeholder: '510' },
        {
          name: 'status',
          label: 'Estado',
          type: 'select',
          options: [
            { value: 'ACTIVE', label: 'Activa' },
            { value: 'INACTIVE', label: 'Inactiva' },
          ],
        },
      ]}
      onCreate={(values) => routeService.create(values).then(() => undefined)}
      onUpdate={(id, values) => routeService.update(id, values).then(() => undefined)}
      onDelete={(id) => routeService.remove(id).then(() => undefined)}
      extraActions={(route) => (
        <button
          type="button"
          onClick={() => setStopsRoute(route)}
          className="rounded-lg p-2 text-slate-500 transition hover:bg-brand-50 hover:text-brand-600"
          aria-label="Gestionar paradas"
          title="Paradas intermedias"
        >
          <MapPin className="h-4 w-4" />
        </button>
      )}
      emptyTitle="No hay rutas creadas"
      emptyDescription="Crea tu primera ruta para comenzar a programar viajes."
    />
  );

  return (
    <>
      {page}
      <RouteStopsModal route={stopsRoute} onClose={() => setStopsRoute(null)} locations={locationOptions} />
    </>
  );
}

interface RouteStop {
  id: number;
  route_id: number;
  location_id: number;
  stop_order: number;
  arrival_offset_minutes: number | null;
  departure_offset_minutes: number | null;
  location_name: string;
  location_city: string;
}

/**
 * Paradas intermedias de una ruta (`route_stops`). El endpoint está acotado por
 * `r.company_id`, así que una empresa solo puede tocar las paradas de sus propias rutas.
 */
function RouteStopsModal({
  route,
  onClose,
  locations,
}: {
  route: Route | null;
  onClose: () => void;
  locations: Array<{ value: number; label: string }>;
}) {
  const toast = useToast();
  const { hasPermission } = useAuth();
  const stops = useAsync(
    () => (route ? routeStopService.list({ route_id: route.id, limit: 50 }) : Promise.resolve({ data: [] })),
    [route?.id],
  );

  const [locationId, setLocationId] = useState('');
  const [offset, setOffset] = useState('');
  const [saving, setSaving] = useState(false);

  const rows = (stops.data?.data ?? []) as unknown as RouteStop[];
  const canEdit = hasPermission('routes.update');

  const add = async () => {
    if (!route || !locationId) return;
    setSaving(true);
    try {
      await routeStopService.create({
        route_id: route.id,
        location_id: Number(locationId),
        stop_order: rows.length + 1,
        arrival_offset_minutes: offset === '' ? null : Number(offset),
        departure_offset_minutes: offset === '' ? null : Number(offset),
      });
      toast.success('Parada añadida a la ruta.');
      setLocationId('');
      setOffset('');
      stops.reload();
    } catch (error) {
      toast.error('No se pudo añadir la parada', error instanceof ApiError ? error.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (stopId: number) => {
    try {
      await routeStopService.remove(stopId);
      toast.success('Parada eliminada.');
      stops.reload();
    } catch (error) {
      toast.error('No se pudo eliminar la parada', error instanceof ApiError ? error.message : undefined);
    }
  };

  return (
    <Modal
      open={route !== null}
      onClose={onClose}
      size="md"
      title="Paradas intermedias"
      description={route ? `${route.origin_city} → ${route.destination_city}` : undefined}
    >
      {stops.loading ? (
        <LoadingState />
      ) : stops.error ? (
        <ErrorState error={stops.error} onRetry={stops.reload} />
      ) : (
        <div className="space-y-4">
          {rows.length === 0 ? (
            <EmptyState
              title="Esta ruta no tiene paradas intermedias"
              description="El viaje va directo del terminal de origen al de destino."
              icon={<MapPin className="h-7 w-7" />}
            />
          ) : (
            <ol className="space-y-2">
              {rows.map((stop) => (
                <li key={stop.id} className="flex items-center justify-between gap-3 rounded-control border border-border px-3 py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-600">
                      {stop.stop_order}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">{stop.location_name}</span>
                      <span className="block truncate text-xs text-muted">
                        {stop.location_city}
                        {stop.arrival_offset_minutes !== null ? ` · +${stop.arrival_offset_minutes} min` : ''}
                      </span>
                    </span>
                  </div>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => void remove(stop.id)}
                      className="shrink-0 rounded-lg p-2 text-slate-500 transition hover:bg-danger-50 hover:text-danger-600"
                      aria-label="Eliminar parada"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}

          {canEdit && (
            <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-[1fr_140px_auto] sm:items-end">
              <Select
                label="Terminal"
                options={locations}
                placeholder="Selecciona una terminal..."
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
              />
              <Input
                label="Minutos desde la salida"
                type="number"
                min={0}
                value={offset}
                placeholder="120"
                onChange={(event) => setOffset(event.target.value)}
              />
              <Button icon={<Plus className="h-4 w-4" />} loading={saving} disabled={!locationId} onClick={() => void add()}>
                Añadir
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
