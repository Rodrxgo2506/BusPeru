import { Armchair, Plus, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { SeatLegend, SeatMap } from '@/components/common/SeatMap';
import { Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorState, LoadingState, PageHeader, Select } from '@/components/ui';
import { ResourceForm } from '@/components/common/ResourceForm';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { ApiError } from '@/services/api';
import { busService, seatService, seatTypeService } from '@/services';
import type { SeatAvailability } from '@/types';
import { formatNumber } from '@/utils/format';

/**
 * Seat editor for a bus. Seats are real `seats` rows: creating, editing the type and
 * deleting all hit the API, and the map reflects the stored row/column layout.
 */
export function SeatConfigPage({ scope }: { scope: 'company' | 'admin' }) {
  const { busId: busIdParam } = useParams();
  const busId = Number(busIdParam);
  const toast = useToast();
  const { hasPermission } = useAuth();

  const bus = useAsync(() => busService.get(busId), [busId]);
  const seats = useAsync(() => seatService.list({ bus_id: busId, limit: 100 }), [busId]);
  const seatTypes = useAsync(() => seatTypeService.list({ limit: 100 }), []);

  const [selectedSeat, setSelectedSeat] = useState<SeatAvailability | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<SeatAvailability | null>(null);
  const [busy, setBusy] = useState(false);

  const canEdit = hasPermission('buses.update');
  const rows = seats.data?.data ?? [];
  const available = rows.filter((seat) => seat.status === 'AVAILABLE').length;

  const updateSeat = async (values: Record<string, unknown>) => {
    if (!selectedSeat) return;
    await seatService.update(selectedSeat.id, values);
    toast.success('Asiento actualizado correctamente.');
    seats.reload();
    setSelectedSeat(null);
  };

  const deleteSeat = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await seatService.remove(deleting.id);
      toast.success('Asiento eliminado.');
      setDeleting(null);
      setSelectedSeat(null);
      seats.reload();
    } catch (error) {
      toast.error('No se pudo eliminar', error instanceof ApiError ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  if (bus.loading) return <LoadingState label="Cargando bus..." />;
  if (bus.error || !bus.data) {
    return (
      <Card padded={false}>
        <ErrorState error={bus.error} onRetry={bus.reload} />
      </Card>
    );
  }

  const seatTypeOptions = (seatTypes.data?.data ?? []).map((type) => ({ value: type.id, label: type.name }));
  const basePath = scope === 'company' ? '/company' : '/admin';

  return (
    <>
      <PageHeader
        title="Configuración de asientos"
        description="Personaliza la distribución y características de los asientos de tu bus."
        breadcrumbs={[
          { label: 'Buses', to: `${basePath}/buses` },
          { label: bus.data.code },
          { label: 'Asientos' },
        ]}
        actions={
          canEdit ? (
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              Agregar asiento
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-6 lg:grid-cols-[280px_1fr_300px]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Información del bus" />
            <dl className="mt-4 space-y-2.5 text-sm">
              <Row label="Código" value={bus.data.code} />
              <Row label="Placa" value={bus.data.plate_number} />
              <Row label="Modelo" value={`${bus.data.brand ?? ''} ${bus.data.model ?? ''}`.trim() || '—'} />
              <Row label="Tipo" value={bus.data.bus_type_name ?? '—'} />
              <Row label="Capacidad declarada" value={`${formatNumber(bus.data.capacity)} asientos`} />
              <Row label="Asientos creados" value={formatNumber(rows.length)} />
              <Row label="Disponibles" value={formatNumber(available)} />
            </dl>
          </Card>

          <Card>
            <CardHeader title="Leyenda" />
            <div className="mt-4">
              <SeatLegend />
            </div>
          </Card>
        </div>

        <Card>
          {seats.loading ? (
            <LoadingState />
          ) : seats.error ? (
            <ErrorState error={seats.error} onRetry={seats.reload} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="Este bus aún no tiene asientos"
              description={`La capacidad declarada es de ${bus.data.capacity} asientos. Créalos para poder venderlos.`}
              icon={<Armchair className="h-7 w-7" />}
              action={canEdit ? <Button onClick={() => setCreating(true)}>Agregar el primer asiento</Button> : undefined}
            />
          ) : (
            <>
              <p className="mb-4 text-center text-xs font-semibold uppercase tracking-wide text-slate-500">Frente del bus ↑</p>
              <SeatMap
                seats={rows}
                selected={[]}
                activeSeatId={selectedSeat?.id ?? null}
                onToggle={canEdit ? (seat) => setSelectedSeat(seat) : undefined}
              />
              <p className="mt-4 flex flex-wrap justify-center gap-4 border-t border-border pt-4 text-sm text-muted">
                <span>Total: {formatNumber(rows.length)}</span>
                <span>Disponibles: {formatNumber(available)}</span>
                <span>Inactivos: {formatNumber(rows.length - available)}</span>
              </p>
            </>
          )}
        </Card>

        <Card>
          <CardHeader title="Configuración del asiento" />
          {selectedSeat ? (
            <div className="mt-4 space-y-4">
              <p className="text-3xl font-extrabold text-brand-600">{selectedSeat.seat_number}</p>

              <Select
                label="Tipo de asiento"
                options={seatTypeOptions}
                placeholder="Sin tipo"
                value={String(selectedSeat.seat_type_id ?? '')}
                onChange={(event) => void updateSeat({ seat_type_id: event.target.value ? Number(event.target.value) : null })}
                disabled={!canEdit}
              />

              <Select
                label="Estado"
                options={[
                  { value: 'AVAILABLE', label: 'Disponible' },
                  { value: 'INACTIVE', label: 'Inactivo' },
                ]}
                value={selectedSeat.status}
                onChange={(event) => void updateSeat({ status: event.target.value })}
                disabled={!canEdit}
              />

              <dl className="space-y-2 border-t border-border pt-4 text-sm">
                <Row label="Fila" value={selectedSeat.row_number ?? '—'} />
                <Row label="Columna" value={selectedSeat.column_number ?? '—'} />
                <Row label="Ventana" value={selectedSeat.is_window === 1 ? 'Sí' : 'No'} />
                <Row label="Pasillo" value={selectedSeat.is_aisle === 1 ? 'Sí' : 'No'} />
              </dl>

              {canEdit && (
                <Button variant="outline" fullWidth icon={<Trash2 className="h-4 w-4" />} onClick={() => setDeleting(selectedSeat)}>
                  Eliminar asiento
                </Button>
              )}
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted">Selecciona un asiento en el mapa para editar sus características.</p>
          )}
        </Card>
      </div>

      <ResourceForm
        open={creating}
        onClose={() => setCreating(false)}
        title="Agregar asiento"
        submitLabel="Crear asiento"
        fields={[
          { name: 'seat_number', label: 'Número de asiento', required: true, placeholder: 'Ej: 21' },
          { name: 'seat_type_id', label: 'Tipo de asiento', type: 'select', options: seatTypeOptions },
          { name: 'row_number', label: 'Fila', type: 'number', required: true, placeholder: '6' },
          { name: 'column_number', label: 'Columna', type: 'number', required: true, placeholder: '1' },
          { name: 'is_window', label: 'Junto a la ventana', type: 'checkbox' },
          { name: 'is_aisle', label: 'Junto al pasillo', type: 'checkbox' },
          {
            name: 'status',
            label: 'Estado',
            type: 'select',
            options: [
              { value: 'AVAILABLE', label: 'Disponible' },
              { value: 'INACTIVE', label: 'Inactivo' },
            ],
          },
        ]}
        onSubmit={async (values) => {
          await seatService.create({ ...values, bus_id: busId });
          toast.success('El asiento se creó correctamente.');
          seats.reload();
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={deleteSeat}
        loading={busy}
        title="Eliminar asiento"
        confirmLabel="Sí, eliminar"
        message={`El asiento ${deleting?.seat_number} dejará de estar disponible. Si ya tiene reservas asociadas, la eliminación será rechazada.`}
      />
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium text-ink">{value}</dd>
    </div>
  );
}

export function SaveIndicator() {
  return <Save className="h-4 w-4" />;
}
