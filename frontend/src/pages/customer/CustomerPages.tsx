import {
  AlertCircle,
  Armchair,
  ArrowRight,
  BedDouble,
  Bell,
  Building2,
  Bus,
  CalendarClock,
  CalendarDays,
  CheckCheck,
  ChevronRight,
  Coins,
  CreditCard,
  Headphones,
  IdCard,
  Mail,
  MapPin,
  MessageSquare,
  MessageSquareText,
  Phone,
  Plus,
  Send,
  Trash2,
  User,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Avatar, Badge, Breadcrumbs, Button, Card, ErrorState, LoadingState, PageHeader, StatusBadge, Textarea } from '@/components/ui';
import { ResourceForm } from '@/components/common/ResourceForm';
import { TARJETA_FLOTANTE as FLOTANTE, TravelBackdrop } from '@/components/common/TravelBackdrop';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { ApiError } from '@/services/api';
import { bookingService, notificationService, supportService } from '@/services';
import { PRIORITY_LABELS, TICKET_CATEGORY_LABELS } from '@/constants/labels';
import { formatCurrency, formatDateTime } from '@/utils/format';

/**
 * Detalle de una reserva. Mockup del panel de cliente.
 *
 * Solo cambia la presentación: la reserva se sigue leyendo con `bookingService.get()` a
 * partir del identificador de la URL, y todo lo que se pinta —código, estado, importes,
 * pagos— viene de esa respuesta. Aquí no hay ni un dato escrito a mano.
 *
 * La composición es la de las otras dos pantallas del área de cliente: el paisaje de
 * `TravelBackdrop` detrás y tarjetas de cristal encima. El reparto en dos columnas empieza
 * en `xl` por la misma razón que allí: hasta 1279 px la barra lateral ya se lleva 260 px y
 * un raíl fijo dejaba el contenido demasiado estrecho.
 */
export function BookingDetailPage() {
  const bookingId = Number(window.location.pathname.split('/').pop());
  const booking = useAsync(() => bookingService.get(bookingId), [bookingId]);

  if (booking.loading) {
    return (
      <>
        <TravelBackdrop />
        <LoadingState label="Cargando reserva..." />
      </>
    );
  }
  if (booking.error || !booking.data) {
    return (
      <>
        <TravelBackdrop />
        <Card padded={false} className={FLOTANTE}>
          <ErrorState error={booking.error} onRetry={booking.reload} />
        </Card>
      </>
    );
  }

  const data = booking.data;
  const pagos = data.payments ?? [];

  return (
    <>
      <TravelBackdrop />

      <PageHeader
        title={`Reserva ${data.booking_code}`}
        description={
          <span className="inline-flex items-center gap-2 text-[15px] font-semibold">
            <span className="text-brand-600">{data.origin_city}</span>
            <ArrowRight className="h-4 w-4 text-brand-400" aria-hidden />
            <span className="text-ink">{data.destination_city}</span>
          </span>
        }
        breadcrumbs={[{ label: 'Mis viajes', to: '/customer/trips' }, { label: data.booking_code }]}
        actions={<StatusBadge status={data.status} />}
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_312px] xl:gap-6">
        <div className="space-y-5">
          <Card padded={false} className={FLOTANTE}>
            <SectionHead icon={<Bus />} title="Información del viaje" subtitle="Detalles de tu pasaje y recorrido" />
            <TwoColumns>
              <Detail icon={<Building2 />} label="Empresa" value={data.company_name} />
              <Detail icon={<BedDouble />} label="Tipo de servicio" value={data.bus_type_name ?? '—'} />
              <Detail icon={<CalendarDays />} label="Salida" value={formatDateTime(data.departure_datetime)} />
              <Detail icon={<CalendarClock />} label="Llegada estimada" value={formatDateTime(data.arrival_datetime)} />
              <Detail icon={<MapPin />} label="Terminal de salida" value={data.origin_terminal} />
              <Detail icon={<MapPin />} label="Terminal de llegada" value={data.destination_terminal} />
              <Detail icon={<Bus />} label="Bus" value={data.bus_code ?? '—'} />
              <Detail icon={<Armchair />} label="Asiento(s)" value={data.seat_numbers ?? '—'} />
            </TwoColumns>
          </Card>

          <Card padded={false} className={FLOTANTE}>
            <SectionHead icon={<User />} title="Información del pasajero" subtitle="Datos del titular del pasaje" />
            <TwoColumns>
              <Detail icon={<User />} label="Nombre" value={data.passenger_name ?? '—'} />
              <Detail icon={<IdCard />} label="Documento" value={data.passenger_document ?? '—'} />
              <Detail icon={<Mail />} label="Correo" value={data.passenger_email ?? '—'} />
              <Detail icon={<Phone />} label="Teléfono" value={data.passenger_phone ?? '—'} />
            </TwoColumns>
          </Card>
        </div>

        <div className="space-y-5">
          <Card padded={false} className={FLOTANTE}>
            <SectionHead icon={<CreditCard />} title="Resumen de pago" subtitle="Detalle de tu compra" />
            <dl className="space-y-3 px-5 py-4 text-sm sm:px-6">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted">Subtotal</dt>
                <dd className="font-semibold text-ink">{formatCurrency(data.subtotal)}</dd>
              </div>
              {/* Solo aparece cuando de verdad hubo descuento, como hasta ahora. */}
              {Number(data.discount_amount) > 0 && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted">Descuento</dt>
                  <dd className="font-semibold text-success-600">- {formatCurrency(data.discount_amount)}</dd>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted">Servicio</dt>
                <dd className="font-semibold text-ink">{formatCurrency(data.service_fee)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-t border-border/70 pt-3.5">
                <dt className="text-[15px] font-bold text-ink">Total</dt>
                <dd className="text-xl font-extrabold tracking-tight text-brand-600">{formatCurrency(data.total_amount)}</dd>
              </div>
            </dl>
          </Card>

          {pagos.length > 0 && (
            <Card padded={false} className={FLOTANTE}>
              <SectionHead icon={<Coins />} title="Pagos" subtitle="Historial de pagos" />
              <ul className="divide-y divide-border/70">
                {pagos.map((payment) => (
                  <li key={payment.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-6">
                    <div className="min-w-0">
                      <p className="text-[15px] font-bold text-ink">{formatCurrency(payment.amount)}</p>
                      <p className="mt-0.5 text-xs text-muted">{formatDateTime(payment.paid_at ?? payment.created_at)}</p>
                    </div>
                    <StatusBadge status={payment.status} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

/** Cabecera de tarjeta del mockup: icono en pastilla, título y una línea que lo describe. */
function SectionHead({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle: string }) {
  return (
    <div className="flex items-start gap-3.5 border-b border-border/70 px-5 py-4 sm:px-6">
      <span
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control bg-brand-50 text-brand-500 ring-1 ring-brand-100 [&>svg]:h-5 [&>svg]:w-5"
        aria-hidden
      >
        {icon}
      </span>
      <div className="min-w-0">
        <h2 className="text-[15px] font-bold leading-tight text-ink">{title}</h2>
        <p className="mt-0.5 text-xs leading-snug text-muted">{subtitle}</p>
      </div>
    </div>
  );
}

/**
 * Rejilla de dos columnas con el filete vertical del mockup.
 *
 * La línea es un elemento aparte colocado en mitad del hueco, no un borde de las celdas:
 * así queda continua de arriba abajo en vez de partirse en tantos trozos como filas.
 */
function TwoColumns({ children }: { children: ReactNode }) {
  return (
    <div className="relative px-5 py-5 sm:px-6">
      <span className="absolute inset-y-5 left-1/2 hidden w-px bg-border/70 sm:block" aria-hidden />
      <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">{children}</dl>
    </div>
  );
}

/** Un dato: icono tenue, etiqueta pequeña y valor destacado. El mismo de «Mi perfil». */
function Detail({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0 text-slate-400 [&>svg]:h-[18px] [&>svg]:w-[18px]" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="text-[13px] leading-tight text-muted">{label}</dt>
        <dd className="mt-1 break-words text-[15px] font-semibold text-ink">{value}</dd>
      </div>
    </div>
  );
}

/**
 * Notificaciones del cliente.
 *
 * Solo cambia la presentación: se sigue leyendo con `notificationService.list`, y marcar
 * como leída, marcar todas y eliminar hacen exactamente lo mismo que antes.
 *
 * El estado vacío es lo que más cambia, y por una razón concreta: sin notificaciones la
 * pantalla era un icono gris y dos líneas dentro de una caja blanca en mitad de una página
 * enorme. Aquí ese vacío pasa a ser una escena —campana, estela de viaje y cordillera al
 * pie— que ocupa el ancho con holgura. No se inventa ni una notificación para rellenarlo:
 * los dos textos son los mismos de siempre y la decoración no es pulsable.
 */
export function CustomerNotificationsPage() {
  const notifications = useAsync(() => notificationService.list({ limit: 50 }), []);
  const toast = useToast();

  const markAll = async () => {
    await notificationService.markAllRead();
    toast.success('Notificaciones marcadas como leídas');
    notifications.reload();
  };

  const rows = notifications.data?.data ?? [];

  return (
    <>
      <TravelBackdrop />

      <PageHeader
        title="Notificaciones"
        description="Avisos sobre tus viajes, pagos y novedades de BusPerú."
        actions={
          rows.some((row) => row.is_read === 0) ? (
            <Button variant="outline" size="sm" icon={<CheckCheck className="h-4 w-4" />} onClick={() => void markAll()}>
              Marcar todas como leídas
            </Button>
          ) : undefined
        }
      />

      {notifications.error ? (
        <Card padded={false} className={FLOTANTE}>
          <ErrorState error={notifications.error} onRetry={notifications.reload} />
        </Card>
      ) : notifications.loading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyNotifications />
      ) : (
        <div className="space-y-4">
          {rows.map((notification) => (
            <Card
              key={notification.id}
              className={
                notification.is_read === 0
                  ? 'border-brand-200/80 bg-brand-50/70 p-5 shadow-panel backdrop-blur-md'
                  : `p-5 ${FLOTANTE}`
              }
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 gap-3.5">
                  {/* Distintivo del estado, no un control: repite en color lo que ya dice el
                      fondo de la tarjeta, para quien no distinga bien ese matiz. */}
                  <span
                    className={
                      notification.is_read === 0
                        ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-600'
                        : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-400'
                    }
                    aria-hidden
                  >
                    <Bell className="h-[18px] w-[18px]" />
                  </span>
                  <div className="min-w-0">
                    <p className="font-semibold leading-snug text-ink">{notification.title}</p>
                    <p className="mt-1 text-sm leading-relaxed text-muted">{notification.message}</p>
                    <p className="mt-2 text-xs text-slate-400">{formatDateTime(notification.created_at)}</p>
                  </div>
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
                    onClick={() => void notificationService.remove(notification.id).then(notifications.reload)}
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

/**
 * La bandeja vacía, como escena.
 *
 * Todo lo que rodea al texto es decoración: nubes, una estela de viaje que acaba en un
 * avioncito de papel y la cordillera al pie, la misma del fondo de la página. Nada de ello
 * es pulsable ni se anuncia al lector de pantalla, y ninguno de los dos textos cambió.
 *
 * Cada pieza se coloca por separado en vez de dibujarlas todas en un único SVG recortado
 * con `slice`: la tarjeta es ancha y baja, y ese recorte se comía las nubes y agrandaba las
 * montañas hasta tapar la frase. Así la cordillera se ancla abajo con su propia altura, las
 * nubes flotan donde toca y la estela sale del borde mismo de la campana.
 */
function EmptyNotifications() {
  return (
    <Card padded={false} className={`relative overflow-hidden ${FLOTANTE}`}>
      <Cloud className="left-[7%] top-[20%] hidden w-24 sm:block sm:w-28" />
      <Cloud className="left-[19%] bottom-[24%] hidden w-16 sm:block" />
      <Cloud className="right-[9%] top-[32%] hidden w-20 sm:block" />
      <Cloud className="right-[24%] bottom-[30%] hidden w-14 lg:block" />

      {/* Cordillera al pie, con su propia altura: no depende del alto de la tarjeta. */}
      <svg
        viewBox="0 0 900 120"
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-16 w-full sm:h-24 lg:h-28"
        aria-hidden
      >
        <path d="M0 120V64l112-40 96 34 122-46 104 52 112-34 124 44 104-30 126 32v44Z" fill="#FDBA74" opacity="0.22" />
        <path d="M0 120V94l132-22 108 24 118-18 104 26 140-20 118 18 180-14v32Z" fill="#F97316" opacity="0.09" />
      </svg>

      <div className="relative flex flex-col items-center px-6 pb-24 pt-20 text-center sm:pb-28 sm:pt-24 lg:pb-32 lg:pt-28">
        <div className="relative">
          <span
            className="flex h-24 w-24 items-center justify-center rounded-full bg-brand-50 text-brand-500 ring-1 ring-brand-100"
            aria-hidden
          >
            <Bell className="h-11 w-11" strokeWidth={1.75} />
          </span>

          {/* Estela de viaje: arranca en el borde de la campana y sube hacia la derecha. */}
          <svg
            viewBox="0 0 210 100"
            className="pointer-events-none absolute left-full top-0 hidden h-[100px] w-[210px] -translate-y-5 translate-x-3 md:block"
            aria-hidden
          >
            <path
              d="M4 86C48 98 92 82 124 52 140 37 152 24 168 16"
              fill="none"
              stroke="#FDBA74"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="2 10"
            />
            <path d="M172 30 206 4 194 44 184 33 172 30Z" fill="#F97316" opacity="0.9" />
          </svg>
        </div>

        <p className="mt-7 text-xl font-bold tracking-tight text-ink sm:text-2xl">No tienes notificaciones</p>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted sm:text-base">
          Te avisaremos aquí sobre tus viajes y reservas.
        </p>
      </div>
    </Card>
  );
}

/** Nube decorativa. Solo forma y color; la posición y el tamaño llegan por `className`. */
function Cloud({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 96 44" className={`pointer-events-none absolute text-brand-300/25 ${className}`} fill="currentColor" aria-hidden>
      <circle cx="26" cy="24" r="16" />
      <circle cx="52" cy="18" r="21" />
      <circle cx="76" cy="25" r="15" />
      <rect x="24" y="26" width="54" height="16" rx="8" />
    </svg>
  );
}

/**
 * Encabezado de las dos pantallas de soporte.
 *
 * Es una copia local de `PageHeader` con una sola diferencia: el icono en pastilla a la
 * izquierda, que abarca título y descripción. `PageHeader` apila esos dos y no deja sitio
 * para algo a su lado, y meter el icono dentro del título lo metería dentro del `<h1>`, que
 * es justo donde no debe estar. Las clases de tipografía y márgenes son las mismas, así que
 * la escala no se separa del resto del panel.
 */
function SupportHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-4">
        <span
          className="hidden h-14 w-14 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-500 ring-1 ring-brand-100 sm:flex"
          aria-hidden
        >
          <Headphones className="h-7 w-7" />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-[28px]">{title}</h1>
          <p className="mt-1 text-sm text-muted">{description}</p>
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Tono de la prioridad. Ámbar solo donde la prioridad ya es alta; no se inventa ninguna. */
const PRIORITY_TONES: Record<string, 'neutral' | 'warning'> = {
  LOW: 'neutral',
  MEDIUM: 'neutral',
  HIGH: 'warning',
  URGENT: 'warning',
};

export function CustomerSupportPage() {
  const tickets = useAsync(() => supportService.list({ limit: 50 }), []);
  const [formOpen, setFormOpen] = useState(false);
  const toast = useToast();

  const rows = tickets.data?.data ?? [];

  return (
    <>
      <TravelBackdrop />

      <SupportHeader
        title="Ayuda y soporte"
        description="Consulta el estado de tus solicitudes o crea una nueva."
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setFormOpen(true)}>
            Nueva consulta
          </Button>
        }
      />

      {tickets.error ? (
        <Card padded={false} className={FLOTANTE}>
          <ErrorState error={tickets.error} onRetry={tickets.reload} />
        </Card>
      ) : tickets.loading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptySupport onCreate={() => setFormOpen(true)} />
      ) : (
        <div className="space-y-4">
          {rows.map((ticket) => (
            <Link
              key={ticket.id}
              to={`/customer/support/${ticket.id}`}
              className={`group block rounded-card border p-4 transition hover:shadow-elevated sm:p-5 ${FLOTANTE}`}
            >
              <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
                <span
                  className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-500 ring-1 ring-brand-100 sm:flex"
                  aria-hidden
                >
                  <MessageSquareText className="h-5 w-5" />
                </span>

                <div className="min-w-0 flex-1 basis-[200px]">
                  <p className="text-sm font-semibold text-brand-600">{ticket.ticket_code}</p>
                  <p className="mt-0.5 font-bold leading-snug text-ink">{ticket.subject}</p>
                  <p className="mt-1 text-xs text-muted">
                    {TICKET_CATEGORY_LABELS[ticket.category] ?? ticket.category} · Actualizado {formatDateTime(ticket.updated_at)}
                  </p>
                </div>

                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <Badge tone={PRIORITY_TONES[ticket.priority] ?? 'neutral'}>
                    {ticket.priority === 'URGENT' && <AlertCircle className="h-3.5 w-3.5" aria-hidden />}
                    {PRIORITY_LABELS[ticket.priority]}
                  </Badge>
                  <StatusBadge status={ticket.status} />
                  {/* Decoración: quien navega es el enlace entero, no este icono. */}
                  <ChevronRight className="h-5 w-5 text-slate-300 transition group-hover:text-brand-500" aria-hidden />
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      <ResourceForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title="Nueva consulta"
        description="Cuéntanos qué necesitas y te responderemos a la brevedad."
        submitLabel="Enviar consulta"
        fields={[
          { name: 'subject', label: 'Asunto', required: true, full: true, placeholder: 'Ej: Consulta sobre mi reembolso' },
          {
            name: 'category',
            label: 'Categoría',
            type: 'select',
            options: Object.entries(TICKET_CATEGORY_LABELS).map(([value, labelText]) => ({ value, label: labelText })),
          },
          {
            name: 'priority',
            label: 'Prioridad',
            type: 'select',
            options: Object.entries(PRIORITY_LABELS).map(([value, labelText]) => ({ value, label: labelText })),
          },
          { name: 'message', label: 'Mensaje', type: 'textarea', required: true, placeholder: 'Describe tu consulta con el mayor detalle posible.' },
        ]}
        onSubmit={async (values) => {
          await supportService.create(values);
          toast.success('Consulta enviada', 'Nuestro equipo te responderá pronto.');
          tickets.reload();
        }}
      />
    </>
  );
}

/**
 * Sin consultas registradas. Misma escena que la bandeja de notificaciones vacía —nubes,
 * cordillera al pie— para que las dos ausencias del panel se lean igual. Los textos y el
 * botón son los que ya había: no se inventa ninguna consulta de ejemplo.
 */
function EmptySupport({ onCreate }: { onCreate: () => void }) {
  return (
    <Card padded={false} className={`relative overflow-hidden ${FLOTANTE}`}>
      <Cloud className="left-[8%] top-[18%] hidden w-24 sm:block sm:w-28" />
      <Cloud className="right-[10%] top-[28%] hidden w-20 sm:block" />
      <Cloud className="right-[26%] bottom-[32%] hidden w-14 lg:block" />

      <svg
        viewBox="0 0 900 120"
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-16 w-full sm:h-24 lg:h-28"
        aria-hidden
      >
        <path d="M0 120V64l112-40 96 34 122-46 104 52 112-34 124 44 104-30 126 32v44Z" fill="#FDBA74" opacity="0.22" />
        <path d="M0 120V94l132-22 108 24 118-18 104 26 140-20 118 18 180-14v32Z" fill="#F97316" opacity="0.09" />
      </svg>

      <div className="relative flex flex-col items-center px-6 pb-24 pt-16 text-center sm:pb-28 sm:pt-20 lg:pb-32 lg:pt-24">
        <span
          className="flex h-24 w-24 items-center justify-center rounded-full bg-brand-50 text-brand-500 ring-1 ring-brand-100"
          aria-hidden
        >
          <Headphones className="h-11 w-11" strokeWidth={1.75} />
        </span>
        <p className="mt-7 text-xl font-bold tracking-tight text-ink sm:text-2xl">No tienes consultas registradas</p>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted sm:text-base">
          Crea un ticket y nuestro equipo de soporte te responderá.
        </p>
        <Button className="mt-6" onClick={onCreate}>
          Crear consulta
        </Button>
      </div>
    </Card>
  );
}

export function CustomerTicketDetailPage() {
  const ticketId = Number(window.location.pathname.split('/').pop());
  const ticket = useAsync(() => supportService.get(ticketId), [ticketId]);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const toast = useToast();

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!message.trim()) return;
    setSending(true);
    try {
      await supportService.reply(ticketId, { message });
      setMessage('');
      ticket.reload();
    } catch (error) {
      toast.error('No se pudo enviar el mensaje', error instanceof ApiError ? error.message : undefined);
    } finally {
      setSending(false);
    }
  };

  if (ticket.loading) {
    return (
      <>
        <TravelBackdrop />
        <LoadingState />
      </>
    );
  }
  if (ticket.error || !ticket.data) {
    return (
      <>
        <TravelBackdrop />
        <Card padded={false} className={FLOTANTE}>
          <ErrorState error={ticket.error} onRetry={ticket.reload} />
        </Card>
      </>
    );
  }

  return (
    <>
      <TravelBackdrop />

      <Breadcrumbs
        items={[{ label: 'Soporte', to: '/customer/support' }, { label: ticket.data.ticket_code }]}
        className="mb-3"
      />
      <SupportHeader
        title={ticket.data.subject}
        description={`${ticket.data.ticket_code} · ${TICKET_CATEGORY_LABELS[ticket.data.category] ?? ticket.data.category}`}
        actions={<StatusBadge status={ticket.data.status} />}
      />

      <Card padded={false} className={FLOTANTE}>
        <ul className="space-y-4 p-4 sm:p-6">
          {(ticket.data.messages ?? []).map((entry) => (
            <li key={entry.id}>
              {/* El papel de quien escribe se distingue por el color del globo y por el
                  avatar, no por el lado: la referencia coloca todos a lo ancho. */}
              <div
                className={
                  entry.role_name === 'CUSTOMER'
                    ? 'flex gap-3.5 rounded-card bg-slate-50/80 p-4 ring-1 ring-slate-100 sm:p-5'
                    : 'flex gap-3.5 rounded-card bg-brand-50/70 p-4 ring-1 ring-brand-100 sm:p-5'
                }
              >
                <Avatar firstName={entry.first_name} lastName={entry.last_name} size="sm" />
                <div className="min-w-0">
                  <p className="text-sm font-bold text-ink">
                    {entry.first_name} {entry.last_name}
                  </p>
                  <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-slate-700">{entry.message}</p>
                  <p className="mt-2 text-xs text-slate-400">{formatDateTime(entry.created_at)}</p>
                </div>
              </div>
            </li>
          ))}
        </ul>

        <form onSubmit={send} className="border-t border-border/70 p-4 sm:p-6">
          <label htmlFor="respuesta-soporte" className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
            <MessageSquare className="h-4 w-4 text-brand-500" aria-hidden />
            Responder
          </label>
          <Textarea
            id="respuesta-soporte"
            placeholder="Escribe tu mensaje..."
            rows={5}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
          <Button type="submit" className="mt-4" icon={<Send className="h-4 w-4" />} loading={sending} disabled={!message.trim()}>
            Enviar respuesta
          </Button>
        </form>
      </Card>
    </>
  );
}
