import { CreditCard, DollarSign, Eye, RotateCcw, Ticket, XCircle } from 'lucide-react';
import { useState } from 'react';
import { ResourcePage } from '@/components/common/ResourcePage';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  Modal,
  PageHeader,
  SearchBar,
  Select,
  StatCard,
  StatusBadge,
  TablePagination,
  TableSkeleton,
  type Column,
} from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { useList } from '@/hooks/useList';
import { ApiError } from '@/services/api';
import { bookingService, paymentService, refundService } from '@/services';
import type { Booking, Payment, Refund } from '@/types';
import { PAYMENT_METHOD_LABELS } from '@/constants/labels';
import { formatCurrency, formatDateTime, formatNumber } from '@/utils/format';

const BOOKING_STATUS_OPTIONS = [
  { value: 'PENDING', label: 'Pendiente' },
  { value: 'CONFIRMED', label: 'Confirmada' },
  { value: 'COMPLETED', label: 'Completada' },
  { value: 'CANCELLED', label: 'Cancelada' },
  { value: 'EXPIRED', label: 'Expirada' },
];

export function BookingsPage({ scope }: { scope: 'company' | 'admin' }) {
  const toast = useToast();
  const [detail, setDetail] = useState<Booking | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Booking | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const detailData = useAsync(() => (detail ? bookingService.get(detail.id) : Promise.resolve(null)), [detail?.id]);

  const columns: Array<Column<Booking>> = [
    { key: 'code', header: 'Código', render: (booking) => <span className="font-semibold text-brand-600">{booking.booking_code}</span> },
    {
      key: 'trip',
      header: 'Viaje',
      render: (booking) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">
            {booking.origin_city} → {booking.destination_city}
          </p>
          <p className="text-xs text-muted">{formatDateTime(booking.departure_datetime)}</p>
        </div>
      ),
    },
    { key: 'passenger', header: 'Pasajero', render: (booking) => booking.passenger_name ?? (`${booking.first_name ?? ''} ${booking.last_name ?? ''}`.trim() || '—') },
    { key: 'seats', header: 'Asientos', render: (booking) => booking.seat_numbers ?? '—', hideOnMobile: true },
    { key: 'total', header: 'Total', sortColumn: 'bk.total_amount', render: (booking) => <span className="font-semibold">{formatCurrency(booking.total_amount)}</span> },
    ...(scope === 'admin' ? [{ key: 'company', header: 'Empresa', render: (booking: Booking) => booking.company_name ?? '—', hideOnMobile: true }] : []),
    { key: 'payment', header: 'Pago', render: (booking) => <StatusBadge status={booking.payment_status ?? undefined} />, hideOnMobile: true },
    { key: 'status', header: 'Estado', render: (booking) => <StatusBadge status={booking.status} /> },
  ];

  const handleCancel = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      await bookingService.cancel(cancelTarget.id, { reason: 'Cancelada desde el portal', request_refund: true });
      toast.success('Reserva cancelada', 'Se generó la solicitud de reembolso si el pago estaba aprobado.');
      setCancelTarget(null);
      setReloadToken((token) => token + 1);
    } catch (error) {
      toast.error('No se pudo cancelar', error instanceof ApiError ? error.message : undefined);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <ResourcePage<Booking>
        title="Reservas"
        description="Gestiona todas las reservas realizadas en tus viajes."
        breadcrumbs={[{ label: scope === 'company' ? 'Portal Empresa' : 'Administración' }, { label: 'Reservas' }]}
        loader={(params) => bookingService.list(params)}
        reloadToken={reloadToken}
        columns={columns}
        permissionModule="bookings"
        entityLabel="Reserva"
      entityGender="f"
        searchPlaceholder="Buscar por código, pasajero o correo..."
        filters={[{ key: 'status', placeholder: 'Todos los estados', options: BOOKING_STATUS_OPTIONS }]}
        onRowClick={(booking) => setDetail(booking)}
        extraActions={(booking) => (
          <>
            <button
              type="button"
              onClick={() => setDetail(booking)}
              className="rounded-lg p-2 text-slate-500 transition hover:bg-brand-50 hover:text-brand-600"
              aria-label="Ver detalle"
            >
              <Eye className="h-4 w-4" />
            </button>
            {booking.status !== 'CANCELLED' && booking.status !== 'COMPLETED' && (
              <button
                type="button"
                onClick={() => setCancelTarget(booking)}
                className="rounded-lg p-2 text-slate-500 transition hover:bg-danger-50 hover:text-danger-600"
                aria-label="Cancelar reserva"
              >
                <XCircle className="h-4 w-4" />
              </button>
            )}
          </>
        )}
        emptyTitle="No hay reservas"
        emptyDescription="Las reservas realizadas por los pasajeros aparecerán aquí."
      />

      <Modal open={detail !== null} onClose={() => setDetail(null)} size="lg" title={`Reserva ${detail?.booking_code ?? ''}`}>
        {detailData.loading ? (
          <TableSkeleton rows={4} columns={2} />
        ) : detailData.data ? (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Detail label="Viaje" value={`${detailData.data.origin_city} → ${detailData.data.destination_city}`} />
              <Detail label="Salida" value={formatDateTime(detailData.data.departure_datetime)} />
              <Detail label="Empresa" value={detailData.data.company_name ?? '—'} />
              <Detail label="Bus" value={detailData.data.bus_code ?? '—'} />
              <Detail label="Pasajero" value={detailData.data.passenger_name ?? '—'} />
              <Detail label="Documento" value={detailData.data.passenger_document ?? '—'} />
              <Detail label="Correo" value={detailData.data.passenger_email ?? '—'} />
              <Detail label="Teléfono" value={detailData.data.passenger_phone ?? '—'} />
            </div>

            <div className="rounded-card border border-border p-4">
              <p className="mb-3 font-semibold text-ink">Asientos</p>
              <div className="flex flex-wrap gap-2">
                {(detailData.data.seats ?? []).map((seat) => (
                  <Badge key={seat.id} tone="brand">
                    {seat.seat_number} · {formatCurrency(seat.price)}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="rounded-card border border-border p-4">
              <p className="mb-3 font-semibold text-ink">Resumen de pago</p>
              <dl className="space-y-1.5 text-sm">
                <Row label="Subtotal" value={formatCurrency(detailData.data.subtotal)} />
                {Number(detailData.data.discount_amount) > 0 && <Row label="Descuento" value={`- ${formatCurrency(detailData.data.discount_amount)}`} />}
                <Row label="Cargo por servicio" value={formatCurrency(detailData.data.service_fee)} />
                <Row label="Total" value={formatCurrency(detailData.data.total_amount)} strong />
              </dl>
            </div>

            {(detailData.data.payments ?? []).length > 0 && (
              <div className="rounded-card border border-border p-4">
                <p className="mb-3 font-semibold text-ink">Pagos</p>
                <ul className="space-y-2 text-sm">
                  {(detailData.data.payments ?? []).map((payment) => (
                    <li key={payment.id} className="flex items-center justify-between gap-3">
                      <span className="text-slate-600">
                        {PAYMENT_METHOD_LABELS[payment.method] ?? payment.method} · {formatDateTime(payment.paid_at ?? payment.created_at)}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{formatCurrency(payment.amount)}</span>
                        <StatusBadge status={payment.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <ErrorState error={detailData.error} onRetry={detailData.reload} />
        )}
      </Modal>

      <ConfirmDialog
        open={cancelTarget !== null}
        onClose={() => setCancelTarget(null)}
        onConfirm={handleCancel}
        loading={cancelling}
        title="Cancelar reserva"
        confirmLabel="Sí, cancelar"
        message={`¿Confirmas la cancelación de la reserva ${cancelTarget?.booking_code}? Si el pago fue aprobado se generará una solicitud de reembolso.`}
      />
    </>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 font-medium text-ink">{value}</p>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={strong ? 'text-base font-bold text-brand-600' : 'font-medium text-ink'}>{value}</dd>
    </div>
  );
}

export function PaymentsPage({ scope }: { scope: 'company' | 'admin' }) {
  const summary = useAsync(() => paymentService.summary(), []);
  const list = useList<Payment>((params) => paymentService.list(params));

  const columns: Array<Column<Payment>> = [
    { key: 'code', header: 'Código', render: (payment) => <span className="font-medium text-brand-600">{payment.transaction_code ?? `#${payment.id}`}</span> },
    { key: 'date', header: 'Fecha', sortColumn: 'p.created_at', render: (payment) => formatDateTime(payment.paid_at ?? payment.created_at) },
    {
      key: 'trip',
      header: 'Viaje',
      render: (payment) => (
        <span className="text-slate-600">
          {payment.origin_city} → {payment.destination_city}
        </span>
      ),
      hideOnMobile: true,
    },
    { key: 'booking', header: 'Reserva', render: (payment) => payment.booking_code ?? '—' },
    { key: 'method', header: 'Método', render: (payment) => <Badge>{PAYMENT_METHOD_LABELS[payment.method] ?? payment.method}</Badge> },
    { key: 'amount', header: 'Monto', sortColumn: 'p.amount', render: (payment) => <span className="font-semibold">{formatCurrency(payment.amount)}</span> },
    ...(scope === 'admin' ? [{ key: 'company', header: 'Empresa', render: (payment: Payment) => payment.company_name ?? '—', hideOnMobile: true }] : []),
    { key: 'status', header: 'Estado', render: (payment) => <StatusBadge status={payment.status} /> },
  ];

  return (
    <>
      <PageHeader title="Pagos" description="Consulta y gestiona todos los pagos recibidos." breadcrumbs={[{ label: scope === 'company' ? 'Portal Empresa' : 'Administración' }, { label: 'Pagos' }]} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total recaudado" value={formatCurrency(summary.data?.total_collected ?? 0)} icon={<DollarSign className="h-5 w-5" />} tone="success" />
        <StatCard label="Hoy" value={formatCurrency(summary.data?.today_collected ?? 0)} icon={<CreditCard className="h-5 w-5" />} tone="brand" />
        <StatCard label="Ayer" value={formatCurrency(summary.data?.yesterday_collected ?? 0)} icon={<CreditCard className="h-5 w-5" />} tone="info" />
        <StatCard label="Reembolsos" value={formatCurrency(summary.data?.refunded ?? 0)} icon={<RotateCcw className="h-5 w-5" />} tone="danger" />
      </div>

      <Card padded={false}>
        <div className="border-b border-border p-4">
          <FilterBar>
            <SearchBar className="min-w-0 flex-1 sm:max-w-sm" placeholder="Buscar por código, reserva o correo..." value={list.search} onChange={(event) => list.setSearch(event.target.value)} />
            <Select
              options={Object.entries(PAYMENT_METHOD_LABELS).map(([value, labelText]) => ({ value, label: labelText }))}
              placeholder="Todos los métodos"
              value={list.filters.method ?? ''}
              onChange={(event) => list.setFilter('method', event.target.value || null)}
              containerClassName="w-full sm:w-auto sm:min-w-[180px]"
            />
            <Select
              options={[
                { value: 'PAID', label: 'Pagado' },
                { value: 'PENDING', label: 'Pendiente' },
                { value: 'REFUNDED', label: 'Reembolsado' },
                { value: 'FAILED', label: 'Fallido' },
              ]}
              placeholder="Todos los estados"
              value={list.filters.status ?? ''}
              onChange={(event) => list.setFilter('status', event.target.value || null)}
              containerClassName="w-full sm:w-auto sm:min-w-[180px]"
            />
          </FilterBar>
        </div>

        {list.error ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={list.rows}
              rowKey={(payment) => payment.id}
              sort={list.sort}
              onSort={list.toggleSort}
              loading={list.loading}
              loadingState={<TableSkeleton />}
              emptyState={<EmptyState title="No hay pagos registrados" description="Los pagos aparecerán cuando los pasajeros confirmen sus reservas." icon={<CreditCard className="h-7 w-7" />} />}
            />
            {!list.loading && list.rows.length > 0 && <TablePagination pagination={list.pagination} onPageChange={list.setPage} />}
          </>
        )}
      </Card>
    </>
  );
}

export function RefundsPage({ scope }: { scope: 'company' | 'admin' }) {
  const toast = useToast();
  const summary = useAsync(() => refundService.summary(), []);
  const list = useList<Refund>((params) => refundService.list(params));
  const [target, setTarget] = useState<{ refund: Refund; action: 'COMPLETED' | 'CANCELLED' } | null>(null);
  const [processing, setProcessing] = useState(false);

  const process = async () => {
    if (!target) return;
    setProcessing(true);
    try {
      await refundService.process(target.refund.id, { status: target.action });
      toast.success(target.action === 'COMPLETED' ? 'Reembolso procesado correctamente.' : 'Solicitud rechazada.');
      setTarget(null);
      list.reload();
      summary.reload();
    } catch (error) {
      toast.error('No se pudo procesar', error instanceof ApiError ? error.message : undefined);
    } finally {
      setProcessing(false);
    }
  };

  const columns: Array<Column<Refund>> = [
    { key: 'booking', header: 'Reserva', render: (refund) => <span className="font-semibold text-brand-600">{refund.booking_code ?? `#${refund.booking_id}`}</span> },
    {
      key: 'trip',
      header: 'Viaje',
      render: (refund) => (
        <div className="min-w-0">
          <p className="truncate text-slate-700">
            {refund.origin_city} → {refund.destination_city}
          </p>
          <p className="text-xs text-muted">{formatDateTime(refund.departure_datetime)}</p>
        </div>
      ),
      hideOnMobile: true,
    },
    { key: 'passenger', header: 'Pasajero', render: (refund) => refund.passenger_name ?? refund.user_email ?? '—' },
    { key: 'date', header: 'Solicitud', sortColumn: 'rf.created_at', render: (refund) => formatDateTime(refund.created_at) },
    { key: 'amount', header: 'Monto', sortColumn: 'rf.amount', render: (refund) => <span className="font-semibold">{formatCurrency(refund.amount)}</span> },
    ...(scope === 'admin' ? [{ key: 'company', header: 'Empresa', render: (refund: Refund) => refund.company_name ?? '—', hideOnMobile: true }] : []),
    { key: 'status', header: 'Estado', render: (refund) => <StatusBadge status={refund.status} /> },
    {
      key: 'actions',
      header: 'Acciones',
      headerClassName: 'text-right',
      className: 'text-right',
      render: (refund) =>
        refund.status === 'PENDING' || refund.status === 'PROCESSING' ? (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="success" onClick={() => setTarget({ refund, action: 'COMPLETED' })}>
              Aprobar
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setTarget({ refund, action: 'CANCELLED' })}>
              Rechazar
            </Button>
          </div>
        ) : (
          <span className="text-xs text-muted">{formatDateTime(refund.processed_at)}</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Cancelaciones y reembolsos"
        description="Gestiona las solicitudes de reembolso de los pasajeros."
        breadcrumbs={[{ label: scope === 'company' ? 'Portal Empresa' : 'Administración' }, { label: 'Reembolsos' }]}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total solicitudes" value={formatNumber(summary.data?.total_requests ?? 0)} icon={<Ticket className="h-5 w-5" />} tone="info" />
        <StatCard label="Pendientes" value={formatNumber(summary.data?.pending ?? 0)} icon={<RotateCcw className="h-5 w-5" />} tone="warning" />
        <StatCard label="Ya reembolsado" value={formatCurrency(summary.data?.refunded_amount ?? 0)} icon={<DollarSign className="h-5 w-5" />} tone="success" />
        <StatCard label="Pendiente de reembolso" value={formatCurrency(summary.data?.pending_amount ?? 0)} icon={<DollarSign className="h-5 w-5" />} tone="danger" />
      </div>

      <Card padded={false}>
        <div className="border-b border-border p-4">
          <FilterBar>
            <SearchBar className="min-w-0 flex-1 sm:max-w-sm" placeholder="Buscar por reserva, pasajero o correo..." value={list.search} onChange={(event) => list.setSearch(event.target.value)} />
            <Select
              options={[
                { value: 'PENDING', label: 'Pendiente' },
                { value: 'PROCESSING', label: 'Procesando' },
                { value: 'COMPLETED', label: 'Completado' },
                { value: 'CANCELLED', label: 'Rechazado' },
              ]}
              placeholder="Todos los estados"
              value={list.filters.status ?? ''}
              onChange={(event) => list.setFilter('status', event.target.value || null)}
              containerClassName="w-full sm:w-auto sm:min-w-[180px]"
            />
          </FilterBar>
        </div>

        {list.error ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={list.rows}
              rowKey={(refund) => refund.id}
              sort={list.sort}
              onSort={list.toggleSort}
              loading={list.loading}
              loadingState={<TableSkeleton />}
              emptyState={<EmptyState title="No hay solicitudes de reembolso" description="Las cancelaciones con pago aprobado generan solicitudes aquí." icon={<RotateCcw className="h-7 w-7" />} />}
            />
            {!list.loading && list.rows.length > 0 && <TablePagination pagination={list.pagination} onPageChange={list.setPage} />}
          </>
        )}
      </Card>

      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        onConfirm={process}
        loading={processing}
        destructive={target?.action === 'CANCELLED'}
        title={target?.action === 'COMPLETED' ? 'Aprobar reembolso' : 'Rechazar solicitud'}
        confirmLabel={target?.action === 'COMPLETED' ? 'Sí, reembolsar' : 'Sí, rechazar'}
        message={
          target?.action === 'COMPLETED'
            ? `Se marcará el pago como reembolsado y se registrará la transacción financiera por ${formatCurrency(target?.refund.amount ?? 0)}.`
            : 'La solicitud quedará marcada como rechazada. El pasajero podrá contactar a soporte si tiene dudas.'
        }
      />
    </>
  );
}
