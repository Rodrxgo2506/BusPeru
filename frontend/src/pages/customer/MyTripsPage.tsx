import {
  ArrowLeftRight,
  ArrowRightLeft,
  Armchair,
  BedDouble,
  Bus,
  CalendarDays,
  Headphones,
  MapPin,
  QrCode,
  Route as RouteIcon,
  ShieldCheck,
  Tag,
  Ticket,
  X,
  XCircle,
} from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, LoadingState, Modal, PageHeader, StatusBadge, Tabs } from '@/components/ui';
import { TARJETA_FLOTANTE as FLOTANTE, TravelBackdrop } from '@/components/common/TravelBackdrop';
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
      <TravelBackdrop />

      <PageHeader title="Mis viajes" description="Aquí puedes ver todos tus pasajes y reservas." />

      {/* Las pestañas viven en su propia tarjeta de cristal: sobre el paisaje, un simple
          filete inferior se perdía y el conjunto se leía como texto suelto. */}
      <Card padded={false} className={`mb-6 px-1.5 ${FLOTANTE}`}>
        <Tabs
          tabs={[
            { id: 'upcoming', label: 'Próximos viajes', icon: <Ticket /> },
            { id: 'past', label: 'Viajes anteriores', icon: <CalendarDays /> },
            { id: 'cancelled', label: 'Cancelados', icon: <XCircle /> },
          ]}
          active={tab}
          onChange={setTab}
          className="border-b-0"
        />
      </Card>

      {bookings.error ? (
        <Card padded={false} className={FLOTANTE}>
          <ErrorState error={bookings.error} onRetry={bookings.reload} />
        </Card>
      ) : bookings.loading ? (
        <LoadingState label="Cargando tus viajes..." />
      ) : filtered.length === 0 ? (
        <Card padded={false} className={FLOTANTE}>
          <EmptyState
            title={tab === 'upcoming' ? 'No tienes viajes próximos' : tab === 'past' ? 'Aún no tienes viajes realizados' : 'No tienes viajes cancelados'}
            description={tab === 'upcoming' ? 'Busca tu próximo destino y compra tu pasaje en minutos.' : 'Aquí aparecerán tus viajes cuando corresponda.'}
            icon={<Ticket className="h-7 w-7" />}
            action={tab === 'upcoming' ? <Button onClick={() => navigate('/')}>Buscar pasajes</Button> : undefined}
          />
        </Card>
      ) : (
        <div className="space-y-5">
          {filtered.map((booking) => (
            <Card key={booking.id} className={`p-4 sm:p-5 ${FLOTANTE}`}>
              {/* Tres franjas, como en la referencia: el visual con sus acciones, el trayecto
                  —que es lo que se lee primero— y el resumen del billete a la derecha.

                  Las tres solo caben en fila desde `xl`. Antes de ahí la barra lateral del
                  área de cliente ya se lleva 260 px y el trayecto quedaba en unos 330: las
                  ciudades se recortaban a «L.» y «H.», que es no decir nada. Entre medias el
                  resumen del billete pasa debajo, a lo ancho de la tarjeta. */}
              <div className="grid gap-5 sm:grid-cols-[164px_minmax(0,1fr)] xl:grid-cols-[164px_minmax(0,1fr)_232px] xl:gap-6">
                <div>
                  <div className="relative flex h-[132px] w-full items-end overflow-hidden rounded-card bg-gradient-to-br from-brand-400 via-brand-500 to-brand-600">
                    {/* Cordillera dentro del recuadro: el mismo perfil del fondo de la página,
                        para que el bloque no sea un rectángulo naranja sin más. */}
                    <svg viewBox="0 0 200 70" preserveAspectRatio="none" className="h-14 w-full text-white/25" fill="currentColor" aria-hidden>
                      <path d="M0 70V44l30-18 26 16 28-22 30 26 26-16 34 22 26-12v30Z" />
                      <path d="M0 70V58l34-10 30 12 32-8 28 14 40-10 36 8v6Z" className="text-white/20" fill="currentColor" />
                    </svg>
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/20 text-white ring-1 ring-white/40">
                        <MapPin className="h-6 w-6" aria-hidden />
                      </span>
                    </span>
                    {tab === 'upcoming' && (
                      <span className="absolute left-2.5 top-2.5 rounded-full bg-success-100 px-2.5 py-1 text-[11px] font-semibold text-success-700 shadow-sm">
                        Próximo viaje
                      </span>
                    )}
                  </div>
                  <div className="mt-3 flex flex-col gap-2">
                    <Button size="sm" variant="outline" fullWidth icon={<QrCode className="h-4 w-4" />} onClick={() => setTicket(booking)}>
                      Ver pasaje
                    </Button>
                    <Button size="sm" variant="secondary" fullWidth to={`/customer/bookings/${booking.id}`}>
                      Detalles del viaje
                    </Button>
                  </div>
                </div>

                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Empresa</p>
                  <p className="mt-0.5 text-lg font-bold leading-tight text-brand-600 sm:text-xl">{booking.company_name}</p>
                  <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600">
                    <BedDouble className="h-3.5 w-3.5" />
                    {booking.bus_type_name ?? 'Bus'}
                  </p>

                  {/* Origen · trayecto · destino. El conector se estira, así que las dos horas
                      quedan ancladas a los extremos y el viaje se lee de un vistazo. */}
                  <div className="mt-5 flex items-start gap-x-3 sm:gap-x-4">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-600">{booking.origin_city}</p>
                      <p className="text-xl font-bold leading-tight tracking-tight text-ink sm:text-2xl">{formatTime(booking.departure_datetime)}</p>
                      <p className="mt-0.5 truncate text-xs text-muted">{booking.origin_terminal}</p>
                    </div>

                    <div className="flex min-w-[76px] flex-1 flex-col items-center gap-1.5 pt-1 sm:min-w-[128px]">
                      <span className="text-xs text-muted">Directo</span>
                      <span className="flex w-full items-center gap-1.5">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" aria-hidden />
                        <span className="h-0 flex-1 border-t border-dashed border-brand-200" aria-hidden />
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-brand-500 ring-1 ring-brand-100" aria-hidden>
                          <Bus className="h-4 w-4" />
                        </span>
                        <span className="h-0 flex-1 border-t border-dashed border-brand-200" aria-hidden />
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" aria-hidden />
                      </span>
                      <StatusBadge status={booking.status} />
                    </div>

                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-600">{booking.destination_city}</p>
                      <p className="text-xl font-bold leading-tight tracking-tight text-ink sm:text-2xl">{formatTime(booking.arrival_datetime)}</p>
                      <p className="mt-0.5 truncate text-xs text-muted">{booking.destination_terminal}</p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3.5 border-t border-border/70 pt-4 text-sm sm:col-span-2 xl:col-span-1 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0">
                  <div className="flex items-start gap-2.5">
                    <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" aria-hidden />
                    <span>
                      <span className="block font-semibold text-ink">{formatDate(booking.departure_datetime)}</span>
                      <span className="block text-xs capitalize text-muted">{formatLongDate(booking.departure_datetime).split(',')[0]}</span>
                    </span>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <Armchair className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" aria-hidden />
                    <span>
                      <span className="block text-xs text-muted">Asiento</span>
                      <span className="block font-semibold text-ink">{booking.seat_numbers ?? '—'}</span>
                    </span>
                  </div>

                  <div className="border-t border-border/70 pt-3.5">
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
                    <div className="flex items-start gap-2.5">
                      <Ticket className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" aria-hidden />
                      <span className="min-w-0">
                        <span className="block text-xs text-muted">Código de reserva</span>
                        <span className="block text-base font-bold text-brand-600">{booking.booking_code}</span>
                      </span>
                    </div>
                    <div className="mt-3 flex items-center gap-2.5">
                      <Tag className="h-4 w-4 shrink-0 text-brand-500" aria-hidden />
                      <span className="text-[15px] font-bold text-ink">{formatCurrency(booking.total_amount)}</span>
                    </div>
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

      {/* ─────────────────────────────────────────────────────────────── ayuda */}
      <Card padded={false} className={`relative mt-6 overflow-hidden ${FLOTANTE}`}>
        {/* Decoración: carretera y cordillera hacia la derecha, por debajo del texto. */}
        <svg
          viewBox="0 0 520 120"
          preserveAspectRatio="none"
          className="pointer-events-none absolute bottom-0 right-0 hidden h-20 w-2/3 text-brand-200/50 sm:block"
          fill="currentColor"
          aria-hidden
        >
          <path d="M0 120V78l72-30 60 24 78-42 74 44 66-28 90 40 80-24v58Z" />
          <path d="M0 120v-18l96-18 78 20 84-16 72 22 106-18 84 16v12Z" className="text-brand-300/40" fill="currentColor" />
        </svg>

        <div className="relative flex flex-col items-start gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <div className="flex items-center gap-4">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-500 ring-1 ring-brand-100">
              <Headphones className="h-7 w-7" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-[17px] font-bold text-ink">¿Necesitas ayuda con tu viaje?</p>
              <p className="mt-0.5 text-sm leading-relaxed text-muted">
                Si tienes alguna consulta o necesitas hacer cambios en tu pasaje, estamos aquí para ayudarte.
              </p>
            </div>
          </div>
          <Button icon={<Headphones className="h-4 w-4" />} to="/customer/support" className="shrink-0">
            Contactar soporte
          </Button>
        </div>
      </Card>

      {/* ──────────────────────────────────────────────────────────── beneficios */}
      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {FOOTER_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <Card key={item.title} className={`p-4 ${FLOTANTE}`}>
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-brand-500 ring-1 ring-brand-100">
                <Icon className="h-[18px] w-[18px]" aria-hidden />
              </span>
              <p className="mt-3 text-sm font-bold text-ink">{item.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">{item.description}</p>
            </Card>
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
