import { CalendarClock, Download, Eye, Users, XCircle } from 'lucide-react';
import { useState } from 'react';
import { ResourcePage } from '@/components/common/ResourcePage';
import { SeatMap } from '@/components/common/SeatMap';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, LoadingState, Modal, PageHeader, StatusBadge, type Column } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { ApiError } from '@/services/api';
import { busService, driverService, routeService, tripService } from '@/services';
import type { Trip } from '@/types';
import { formatCurrency, formatDate, formatDateTime, formatNumber, formatTime } from '@/utils/format';

const TRIP_STATUS_OPTIONS = [
  { value: 'SCHEDULED', label: 'Programado' },
  { value: 'BOARDING', label: 'En embarque' },
  { value: 'IN_PROGRESS', label: 'En viaje' },
  { value: 'COMPLETED', label: 'Completado' },
  { value: 'DELAYED', label: 'Retrasado' },
  { value: 'CANCELLED', label: 'Cancelado' },
];

export function TripsPage({ scope }: { scope: 'company' | 'admin' }) {
  const routes = useAsync(() => routeService.list({ limit: 200 }), []);
  const buses = useAsync(() => busService.list({ limit: 200 }), []);
  // Solo personal ACTIVO de la propia empresa: el backend acota la consulta por la sesión
  // y vuelve a validarlo al guardar, así que el selector nunca ofrece gente de otra empresa.
  const drivers = useAsync(() => driverService.list({ status: 'ACTIVE' }), []);
  const toast = useToast();

  const [seatsTrip, setSeatsTrip] = useState<Trip | null>(null);
  const [cancelTrip, setCancelTrip] = useState<Trip | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const seatMap = useAsync(() => (seatsTrip ? tripService.seats(seatsTrip.id) : Promise.resolve([])), [seatsTrip?.id]);

  const columns: Array<Column<Trip>> = [
    {
      key: 'departure',
      header: 'Salida',
      sortColumn: 't.departure_datetime',
      render: (trip) => (
        <div>
          <p className="font-semibold text-ink">{formatTime(trip.departure_datetime)}</p>
          <p className="text-xs text-muted">{formatDate(trip.departure_datetime)}</p>
        </div>
      ),
    },
    {
      key: 'route',
      header: 'Ruta',
      render: (trip) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">
            {trip.origin_city} → {trip.destination_city}
          </p>
          <p className="truncate text-xs text-muted">{trip.origin_terminal}</p>
        </div>
      ),
    },
    { key: 'bus', header: 'Bus', render: (trip) => <span className="font-medium">{trip.bus_code ?? '—'}</span>, hideOnMobile: true },
    {
      key: 'crew',
      header: 'Tripulación',
      render: (trip) => (
        <span className="min-w-0">
          <span className="block truncate text-sm text-ink">{trip.driver_name ?? 'Sin asignar'}</span>
          {trip.co_driver_name && <span className="block truncate text-xs text-muted">{trip.co_driver_name}</span>}
        </span>
      ),
      hideOnMobile: true,
    },
    {
      key: 'occupancy',
      header: 'Ocupación',
      render: (trip) => {
        const sold = Number(trip.seats_sold ?? 0);
        const capacity = Number(trip.capacity ?? 0);
        const percent = capacity > 0 ? Math.round((sold / capacity) * 100) : 0;
        return (
          <div className="min-w-[90px]">
            <p className="text-sm font-medium text-ink">
              {sold}/{capacity}
            </p>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div className={`h-full rounded-full ${percent >= 70 ? 'bg-success-500' : percent >= 30 ? 'bg-warning-500' : 'bg-danger-500'}`} style={{ width: `${percent}%` }} />
            </div>
          </div>
        );
      },
      hideOnMobile: true,
    },
    { key: 'price', header: 'Precio', sortColumn: 't.base_price', render: (trip) => formatCurrency(trip.base_price) },
    { key: 'revenue', header: 'Ingresos', render: (trip) => formatCurrency(trip.revenue ?? 0), hideOnMobile: true },
    ...(scope === 'admin' ? [{ key: 'company', header: 'Empresa', render: (trip: Trip) => trip.company_name ?? '—', hideOnMobile: true }] : []),
    { key: 'status', header: 'Estado', render: (trip) => <StatusBadge status={trip.status} /> },
  ];

  const handleCancel = async () => {
    if (!cancelTrip) return;
    setCancelling(true);
    try {
      await tripService.cancel(cancelTrip.id);
      toast.success('Viaje cancelado correctamente.');
      setCancelTrip(null);
      setReloadToken((token) => token + 1);
    } catch (error) {
      toast.error('No se pudo cancelar el viaje', error instanceof ApiError ? error.message : undefined);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <ResourcePage<Trip>
        title="Viajes"
        description="Programa y administra los viajes de tus rutas."
        breadcrumbs={[{ label: scope === 'company' ? 'Portal Empresa' : 'Administración' }, { label: 'Viajes' }]}
        loader={(params) => tripService.list(params)}
        reloadToken={reloadToken}
        columns={columns}
        permissionModule="trips"
        entityLabel="Viaje"
        searchPlaceholder="Buscar por ciudad, bus o placa..."
        filters={[
          { key: 'status', placeholder: 'Todos los estados', options: TRIP_STATUS_OPTIONS },
          {
            key: 'route_id',
            placeholder: 'Todas las rutas',
            options: (routes.data?.data ?? []).map((route) => ({ value: String(route.id), label: `${route.origin_city} → ${route.destination_city}` })),
          },
        ]}
        formFields={[
          {
            name: 'route_id',
            label: 'Ruta',
            type: 'select',
            required: true,
            options: (routes.data?.data ?? []).map((route) => ({ value: route.id, label: `${route.origin_city} → ${route.destination_city}` })),
          },
          {
            name: 'bus_id',
            label: 'Bus asignado',
            type: 'select',
            required: true,
            options: (buses.data?.data ?? []).map((bus) => ({ value: bus.id, label: `${bus.code} · ${bus.plate_number} (${bus.capacity} asientos)` })),
          },
          {
            name: 'driver_id',
            label: 'Conductor',
            type: 'select',
            options: (drivers.data ?? []).map((driver) => ({
              value: driver.id,
              label: `${driver.first_name} ${driver.last_name}${driver.phone ? ` (${driver.phone})` : ''}`,
            })),
            hint: (drivers.data ?? []).length === 0 ? 'Registra conductores para poder asignarlos' : undefined,
          },
          {
            name: 'co_driver_id',
            label: 'Copiloto',
            type: 'select',
            options: (drivers.data ?? []).map((driver) => ({
              value: driver.id,
              label: `${driver.first_name} ${driver.last_name}${driver.phone ? ` (${driver.phone})` : ''}`,
            })),
            hint: 'Debe ser distinto del conductor',
          },
          { name: 'departure_datetime', label: 'Fecha y hora de salida', type: 'datetime-local', required: true },
          { name: 'arrival_datetime', label: 'Llegada estimada', type: 'datetime-local' },
          { name: 'base_price', label: 'Precio base (S/)', type: 'number', step: '0.01', required: true, placeholder: '45.00' },
          { name: 'status', label: 'Estado', type: 'select', options: TRIP_STATUS_OPTIONS },
          { name: 'boarding_notes', label: 'Notas de embarque', type: 'textarea', placeholder: 'Ej: Presentarse 30 minutos antes.' },
        ]}
        onCreate={(values) => tripService.create(values).then(() => undefined)}
        onUpdate={(id, values) => tripService.update(id, values).then(() => undefined)}
        onDelete={(id) => tripService.remove(id).then(() => undefined)}
        extraActions={(trip) => (
          <>
            <button
              type="button"
              onClick={() => setSeatsTrip(trip)}
              className="rounded-lg p-2 text-slate-500 transition hover:bg-brand-50 hover:text-brand-600"
              aria-label="Ver asientos"
              title="Ver asientos y pasajeros"
            >
              <Eye className="h-4 w-4" />
            </button>
            {trip.status !== 'CANCELLED' && (
              <button
                type="button"
                onClick={() => setCancelTrip(trip)}
                className="rounded-lg p-2 text-slate-500 transition hover:bg-danger-50 hover:text-danger-600"
                aria-label="Cancelar viaje"
                title="Cancelar viaje"
              >
                <XCircle className="h-4 w-4" />
              </button>
            )}
          </>
        )}
        emptyTitle="No hay viajes programados"
        emptyDescription="Programa tu primer viaje seleccionando una ruta y un bus."
        mobileCard={(trip) => (
          <div className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-ink">
                  {trip.origin_city} → {trip.destination_city}
                </p>
                <p className="text-sm text-muted">{formatDateTime(trip.departure_datetime)}</p>
              </div>
              <StatusBadge status={trip.status} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge>{trip.bus_code}</Badge>
              <Badge tone="brand">{formatCurrency(trip.base_price)}</Badge>
              <Badge>
                {formatNumber(trip.seats_sold ?? 0)}/{formatNumber(trip.capacity ?? 0)}
              </Badge>
            </div>
          </div>
        )}
      />

      <Modal
        open={seatsTrip !== null}
        onClose={() => setSeatsTrip(null)}
        size="lg"
        title={seatsTrip ? `Asientos del viaje ${seatsTrip.origin_city} → ${seatsTrip.destination_city}` : 'Asientos'}
        description={seatsTrip ? formatDateTime(seatsTrip.departure_datetime) : undefined}
      >
        {seatMap.loading ? (
          <LoadingState />
        ) : seatMap.error ? (
          <ErrorState error={seatMap.error} onRetry={seatMap.reload} />
        ) : (seatMap.data ?? []).length === 0 ? (
          <EmptyState title="Este bus no tiene asientos configurados" description="Configura los asientos del bus para poder venderlos." />
        ) : (
          <SeatMap seats={seatMap.data ?? []} selected={[]} />
        )}
      </Modal>

      <ConfirmDialog
        open={cancelTrip !== null}
        onClose={() => setCancelTrip(null)}
        onConfirm={handleCancel}
        loading={cancelling}
        title="Cancelar viaje"
        confirmLabel="Sí, cancelar viaje"
        message="El viaje quedará marcado como cancelado. Las reservas asociadas deberán gestionarse desde el módulo de reservas."
      />
    </>
  );
}

export function PassengersPage() {
  const trips = useAsync(() => tripService.list({ limit: 100, sort: 't.departure_datetime', order: 'DESC' }), []);
  const [selectedTrip, setSelectedTrip] = useState<number | null>(null);
  const passengers = useAsync(() => (selectedTrip ? tripService.passengers(selectedTrip) : Promise.resolve([])), [selectedTrip]);

  const rows = (passengers.data ?? []) as Array<Record<string, unknown>>;

  return (
    <>
      <PageHeader
        title="Lista de pasajeros"
        description="Consulta el manifiesto de pasajeros de cada viaje."
        breadcrumbs={[{ label: 'Portal Empresa' }, { label: 'Pasajeros' }]}
        actions={
          <Button variant="outline" size="sm" icon={<Download className="h-4 w-4" />} disabled={rows.length === 0} onClick={() => window.print()}>
            Exportar / imprimir
          </Button>
        }
      />

      <Card className="mb-6">
        <label className="field-label" htmlFor="trip-select">
          Selecciona un viaje
        </label>
        <select
          id="trip-select"
          value={selectedTrip ?? ''}
          onChange={(event) => setSelectedTrip(event.target.value ? Number(event.target.value) : null)}
          className="h-11 w-full rounded-control border border-border px-3.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        >
          <option value="">Selecciona un viaje...</option>
          {(trips.data?.data ?? []).map((trip) => (
            <option key={trip.id} value={trip.id}>
              {formatDateTime(trip.departure_datetime)} · {trip.origin_city} → {trip.destination_city} · {trip.bus_code}
            </option>
          ))}
        </select>
      </Card>

      <Card padded={false}>
        {selectedTrip === null ? (
          <EmptyState title="Selecciona un viaje" description="Elige un viaje para ver la lista de pasajeros." icon={<CalendarClock className="h-7 w-7" />} />
        ) : passengers.loading ? (
          <LoadingState />
        ) : passengers.error ? (
          <ErrorState error={passengers.error} onRetry={passengers.reload} />
        ) : rows.length === 0 ? (
          <EmptyState title="Este viaje aún no tiene pasajeros" description="Cuando se registren reservas confirmadas aparecerán aquí." icon={<Users className="h-7 w-7" />} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border bg-slate-50/80 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3">Asiento</th>
                  <th className="px-4 py-3">Pasajero</th>
                  <th className="px-4 py-3">Documento</th>
                  <th className="px-4 py-3">Reserva</th>
                  <th className="px-4 py-3">Contacto</th>
                  <th className="px-4 py-3">Estado</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index} className="border-b border-border/70 last:border-0">
                    <td className="px-4 py-3 font-semibold text-ink">{String(row.seat_number ?? '—')}</td>
                    <td className="px-4 py-3">{String(row.passenger_name ?? (`${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || '—'))}</td>
                    <td className="px-4 py-3 text-slate-600">{String(row.passenger_document ?? '—')}</td>
                    <td className="px-4 py-3 font-medium text-brand-600">{String(row.booking_code ?? '—')}</td>
                    <td className="px-4 py-3 text-slate-600">{String(row.passenger_phone ?? row.user_email ?? '—')}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={String(row.status ?? '')} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
