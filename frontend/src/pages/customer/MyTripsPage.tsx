import { ArrowLeftRight, ArrowRightLeft, BedDouble, CalendarDays, Headphones, MapPin, QrCode, Route as RouteIcon, ShieldCheck, Ticket, X } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, LoadingState, Modal, PageHeader, StatusBadge, Tabs } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { ApiError } from '@/services/api';
import { bookingService } from '@/services';
import type { Booking } from '@/types';
import { formatCurrency, formatDate, formatLongDate, formatTime, toBusinessDate } from '@/utils/format';

type TripTab = 'upcoming' | 'past' | 'cancelled';

/**
 * Horas de antelación con las que se admite una cancelación.
 *
 * La regla la aplica el servidor, que lee `booking.cancellation_hours` y rechaza cualquier
 * cancelación fuera de plazo; esto solo evita ofrecer un botón que ya se sabe que va a
 * fallar. Si algún día ese ajuste cambia en el panel, el servidor sigue mandando.
 */
const CANCELLATION_HOURS = 24;

/** `true` mientras falte más del plazo para la salida. */
function isCancellable(booking: Booking): boolean {
  const departure = toBusinessDate(booking.departure_datetime);
  if (!departure) return false;
  return departure.getTime() - Date.now() > CANCELLATION_HOURS * 60 * 60 * 1000;
}

const FOOTER_ITEMS = [
  { icon: ArrowLeftRight, title: 'Cambios flexibles', description: 'Realiza cambios en tu pasaje hasta 24h antes del viaje.' },
  { icon: X, title: 'Cancelación fácil', description: 'Cancela tu pasaje de forma rápida y segura.' },
  { icon: ShieldCheck, title: 'Viaja seguro', description: 'Todos nuestros buses cumplen con altos estándares de seguridad.' },
  { icon: Headphones, title: 'Atención 24/7', description: 'Nuestro equipo está disponible para ayudarte siempre.' },
];

export function MyTripsPage() {
  const [tab, setTab] = useState<TripTab>('upcoming');
  const toast = useToast();
  const navigate = useNavigate();

  const bookings = useAsync(() => bookingService.list({ limit: 50 }), []);
  const [cancelTarget, setCancelTarget] = useState<Booking | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [ticket, setTicket] = useState<Booking | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (!ticket) return;
    setQr(null);
    void QRCode.toDataURL(ticket.booking_code, { width: 320, margin: 1, color: { dark: '#0F172A', light: '#FFFFFF' } })
      .then(setQr)
      .catch(() => setQr(null));
  }, [ticket]);

  const now = new Date();
  const rows = bookings.data?.data ?? [];
  const filtered = rows.filter((booking) => {
    const departure = toBusinessDate(booking.departure_datetime);
    if (tab === 'cancelled') return booking.status === 'CANCELLED' || booking.status === 'EXPIRED';
    if (tab === 'past') return booking.status !== 'CANCELLED' && departure !== null && departure < now;
    return booking.status !== 'CANCELLED' && booking.status !== 'EXPIRED' && (departure === null || departure >= now);
  });

  const handleCancel = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      await bookingService.cancel(cancelTarget.id, { reason: 'Cancelación solicitada por el pasajero', request_refund: true });
      toast.success('Reserva cancelada', 'Si tu pago fue aprobado, se generó una solicitud de reembolso.');
      setCancelTarget(null);
      bookings.reload();
    } catch (error) {
      toast.error('No se pudo cancelar', error instanceof ApiError ? error.message : undefined);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <PageHeader title="Mis viajes" description="Aquí puedes ver todos tus pasajes y reservas." />

      <Tabs
        tabs={[
          { id: 'upcoming', label: 'Próximos viajes' },
          { id: 'past', label: 'Viajes anteriores' },
          { id: 'cancelled', label: 'Cancelados' },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-6"
      />

      {bookings.error ? (
        <Card padded={false}>
          <ErrorState error={bookings.error} onRetry={bookings.reload} />
        </Card>
      ) : bookings.loading ? (
        <LoadingState label="Cargando tus viajes..." />
      ) : filtered.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            title={tab === 'upcoming' ? 'No tienes viajes próximos' : tab === 'past' ? 'Aún no tienes viajes realizados' : 'No tienes viajes cancelados'}
            description={tab === 'upcoming' ? 'Busca tu próximo destino y compra tu pasaje en minutos.' : 'Aquí aparecerán tus viajes cuando corresponda.'}
            icon={<Ticket className="h-7 w-7" />}
            action={tab === 'upcoming' ? <Button onClick={() => navigate('/')}>Buscar pasajes</Button> : undefined}
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {filtered.map((booking) => (
            <Card key={booking.id}>
              <div className="grid gap-5 lg:grid-cols-[150px_1fr_210px]">
                {/* Imagen del destino: placeholder con la forma exacta del mockup. */}
                <div>
                  <div className="relative flex h-[130px] w-full items-center justify-center overflow-hidden rounded-card bg-gradient-to-br from-brand-400 to-brand-600">
                    <MapPin className="h-9 w-9 text-white/90" aria-hidden />
                    {tab === 'upcoming' && (
                      <span className="absolute left-2 top-2 rounded-full bg-success-100 px-2.5 py-1 text-[11px] font-semibold text-success-700">
                        Próximo viaje
                      </span>
                    )}
                  </div>
                  <div className="mt-3 flex flex-col gap-2">
                    <Button size="sm" variant="outline" icon={<QrCode className="h-4 w-4" />} onClick={() => setTicket(booking)}>
                      Ver pasaje
                    </Button>
                    <Button size="sm" variant="secondary" to={`/customer/bookings/${booking.id}`}>
                      Detalles del viaje
                    </Button>
                  </div>
                </div>

                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Empresa</p>
                  <p className="text-lg font-bold text-brand-600">{booking.company_name}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-muted">
                    <BedDouble className="h-4 w-4" />
                    {booking.bus_type_name ?? 'Bus'}
                  </p>

                  <div className="mt-4 flex flex-wrap items-start gap-5">
                    <div>
                      <p className="text-sm font-medium text-slate-600">{booking.origin_city}</p>
                      <p className="text-xl font-bold text-ink">{formatTime(booking.departure_datetime)}</p>
                      <p className="text-xs text-muted">{booking.origin_terminal}</p>
                    </div>
                    <div className="flex min-w-[92px] flex-col items-center pt-2">
                      <span className="text-xs text-muted">Directo</span>
                      <span className="my-1.5 h-px w-full bg-border" />
                      <StatusBadge status={booking.status} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-600">{booking.destination_city}</p>
                      <p className="text-xl font-bold text-ink">{formatTime(booking.arrival_datetime)}</p>
                      <p className="text-xs text-muted">{booking.destination_terminal}</p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 border-t border-border pt-4 text-sm lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
                  <div className="flex items-start gap-2">
                    <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
                    <span>
                      <span className="block font-semibold text-ink">{formatDate(booking.departure_datetime)}</span>
                      <span className="block text-xs capitalize text-muted">{formatLongDate(booking.departure_datetime).split(',')[0]}</span>
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <Ticket className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
                    <span>
                      <span className="block text-xs text-muted">Asiento</span>
                      <span className="block font-semibold text-ink">{booking.seat_numbers ?? '—'}</span>
                    </span>
                  </div>
                  <div className="border-t border-border pt-3">
                    {/* Los tramos de una misma compra son reservas distintas: este
                        distintivo evita que parezcan compras independientes. */}
                    {booking.group_code && (
                      <p className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-semibold text-brand-700">
                        {booking.trip_type === 'ROUND_TRIP' ? (
                          <ArrowRightLeft className="h-3 w-3" />
                        ) : (
                          <RouteIcon className="h-3 w-3" />
                        )}
                        {booking.trip_type === 'ROUND_TRIP'
                          ? booking.segment_order === 1
                            ? 'Ida y vuelta · Ida'
                            : 'Ida y vuelta · Vuelta'
                          : `Multidestino · Tramo ${booking.segment_order} de ${booking.group_segments}`}
                      </p>
                    )}
                    <p className="text-xs text-muted">Código de reserva</p>
                    <p className="text-base font-bold text-brand-600">{booking.booking_code}</p>
                    <p className="mt-1 text-sm font-semibold text-ink">{formatCurrency(booking.total_amount)}</p>
                  </div>
                  {tab === 'upcoming' && booking.status !== 'CANCELLED' && isCancellable(booking) && (
                    <Button size="sm" variant="ghost" onClick={() => setCancelTarget(booking)}>
                      Cancelar viaje
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card className="mt-6 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <span className="flex h-14 w-20 shrink-0 items-center justify-center rounded-card bg-brand-50 text-brand-500">
            <BedDouble className="h-7 w-7" />
          </span>
          <div>
            <p className="font-semibold text-ink">¿Necesitas ayuda con tu viaje?</p>
            <p className="text-sm text-muted">Si tienes alguna consulta o necesitas hacer cambios en tu pasaje, estamos aquí para ayudarte.</p>
          </div>
        </div>
        <Button variant="outline" icon={<Headphones className="h-4 w-4" />} to="/customer/support">
          Contactar soporte
        </Button>
      </Card>

      <div className="mt-6 grid gap-5 border-t border-border pt-6 sm:grid-cols-2 lg:grid-cols-4">
        {FOOTER_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.title} className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-500">
                <Icon className="h-[18px] w-[18px]" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">{item.title}</span>
                <span className="block text-sm text-muted">{item.description}</span>
              </span>
            </div>
          );
        })}
      </div>

      <Modal
        open={ticket !== null}
        onClose={() => setTicket(null)}
        size="sm"
        title="Tu pasaje"
        description={ticket ? `${ticket.origin_city} → ${ticket.destination_city}` : undefined}
      >
        {ticket && (
          <div className="text-center">
            {qr ? (
              <img src={qr} alt={`Código QR de la reserva ${ticket.booking_code}`} className="mx-auto h-44 w-44 rounded-lg border border-border bg-white p-2" />
            ) : (
              <div className="mx-auto h-44 w-44 animate-pulse rounded-lg bg-slate-200" aria-hidden />
            )}
            <p className="mt-4 text-sm text-muted">Código de reserva</p>
            <p className="text-2xl font-extrabold tracking-wide text-brand-600">{ticket.booking_code}</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Badge tone="neutral">{formatDate(ticket.departure_datetime)}</Badge>
              <Badge tone="neutral">{formatTime(ticket.departure_datetime)}</Badge>
              <Badge tone="brand">Asiento {ticket.seat_numbers ?? '—'}</Badge>
            </div>
            <p className="mt-4 text-sm text-muted">Muestra este código al abordar.</p>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={cancelTarget !== null}
        onClose={() => setCancelTarget(null)}
        onConfirm={handleCancel}
        loading={cancelling}
        title="Cancelar reserva"
        confirmLabel="Sí, cancelar"
        message={
          <>
            ¿Seguro que deseas cancelar la reserva <strong>{cancelTarget?.booking_code}</strong>? Si tu pago ya fue aprobado, se generará una
            solicitud de reembolso que será revisada por la empresa.
          </>
        }
      />
    </>
  );
}
