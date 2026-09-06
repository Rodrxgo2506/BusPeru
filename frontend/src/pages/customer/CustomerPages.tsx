import { Bell, CheckCheck, Headphones, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge, Textarea } from '@/components/ui';
import { ResourceForm } from '@/components/common/ResourceForm';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { ApiError } from '@/services/api';
import { bookingService, notificationService, supportService } from '@/services';
import { PRIORITY_LABELS, TICKET_CATEGORY_LABELS } from '@/constants/labels';
import { formatCurrency, formatDateTime } from '@/utils/format';

export function BookingDetailPage() {
  const bookingId = Number(window.location.pathname.split('/').pop());
  const booking = useAsync(() => bookingService.get(bookingId), [bookingId]);

  if (booking.loading) return <LoadingState label="Cargando reserva..." />;
  if (booking.error || !booking.data) {
    return (
      <Card padded={false}>
        <ErrorState error={booking.error} onRetry={booking.reload} />
      </Card>
    );
  }

  const data = booking.data;

  return (
    <>
      <PageHeader
        title={`Reserva ${data.booking_code}`}
        description={`${data.origin_city} → ${data.destination_city}`}
        breadcrumbs={[{ label: 'Mis viajes', to: '/customer/trips' }, { label: data.booking_code }]}
        actions={<StatusBadge status={data.status} />}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="font-semibold text-ink">Información del viaje</h2>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <Detail label="Empresa" value={data.company_name} />
            <Detail label="Tipo de servicio" value={data.bus_type_name ?? '—'} />
            <Detail label="Salida" value={`${formatDateTime(data.departure_datetime)}`} />
            <Detail label="Llegada estimada" value={formatDateTime(data.arrival_datetime)} />
            <Detail label="Terminal de salida" value={data.origin_terminal} />
            <Detail label="Terminal de llegada" value={data.destination_terminal} />
            <Detail label="Bus" value={data.bus_code ?? '—'} />
            <Detail label="Asiento(s)" value={data.seat_numbers ?? '—'} />
          </dl>

          <h2 className="mt-6 border-t border-border pt-6 font-semibold text-ink">Información del pasajero</h2>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <Detail label="Nombre" value={data.passenger_name ?? '—'} />
            <Detail label="Documento" value={data.passenger_document ?? '—'} />
            <Detail label="Correo" value={data.passenger_email ?? '—'} />
            <Detail label="Teléfono" value={data.passenger_phone ?? '—'} />
          </dl>
        </Card>

        <div className="space-y-6">
          <Card>
            <h2 className="font-semibold text-ink">Resumen de pago</h2>
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Subtotal</dt>
                <dd className="font-medium">{formatCurrency(data.subtotal)}</dd>
              </div>
              {Number(data.discount_amount) > 0 && (
                <div className="flex justify-between">
                  <dt className="text-muted">Descuento</dt>
                  <dd className="font-medium text-success-600">- {formatCurrency(data.discount_amount)}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-muted">Servicio</dt>
                <dd className="font-medium">{formatCurrency(data.service_fee)}</dd>
              </div>
              <div className="flex justify-between border-t border-border pt-2">
                <dt className="font-semibold text-ink">Total</dt>
                <dd className="text-lg font-bold text-brand-600">{formatCurrency(data.total_amount)}</dd>
              </div>
            </dl>
          </Card>

          {(data.payments ?? []).length > 0 && (
            <Card>
              <h2 className="font-semibold text-ink">Pagos</h2>
              <ul className="mt-3 space-y-3">
                {(data.payments ?? []).map((payment) => (
                  <li key={payment.id} className="flex items-center justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0">
                    <div>
                      <p className="text-sm font-medium text-ink">{formatCurrency(payment.amount)}</p>
                      <p className="text-xs text-muted">{formatDateTime(payment.paid_at ?? payment.created_at)}</p>
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

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium text-ink">{value}</dd>
    </div>
  );
}

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
        <Card padded={false}>
          <ErrorState error={notifications.error} onRetry={notifications.reload} />
        </Card>
      ) : notifications.loading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <Card padded={false}>
          <EmptyState title="No tienes notificaciones" description="Te avisaremos aquí sobre tus viajes y reservas." icon={<Bell className="h-7 w-7" />} />
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((notification) => (
            <Card key={notification.id} className={notification.is_read === 0 ? 'border-brand-200 bg-brand-50/40' : undefined}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-semibold text-ink">{notification.title}</p>
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

export function CustomerSupportPage() {
  const tickets = useAsync(() => supportService.list({ limit: 50 }), []);
  const [formOpen, setFormOpen] = useState(false);
  const toast = useToast();

  const rows = tickets.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Ayuda y soporte"
        description="Consulta el estado de tus solicitudes o crea una nueva."
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setFormOpen(true)}>
            Nueva consulta
          </Button>
        }
      />

      {tickets.error ? (
        <Card padded={false}>
          <ErrorState error={tickets.error} onRetry={tickets.reload} />
        </Card>
      ) : tickets.loading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            title="No tienes consultas registradas"
            description="Crea un ticket y nuestro equipo de soporte te responderá."
            icon={<Headphones className="h-7 w-7" />}
            action={<Button onClick={() => setFormOpen(true)}>Crear consulta</Button>}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((ticket) => (
            <Link key={ticket.id} to={`/customer/support/${ticket.id}`} className="card block p-5 transition hover:shadow-panel">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-brand-600">{ticket.ticket_code}</p>
                  <p className="mt-0.5 font-semibold text-ink">{ticket.subject}</p>
                  <p className="mt-1 text-xs text-muted">
                    {TICKET_CATEGORY_LABELS[ticket.category] ?? ticket.category} · Actualizado {formatDateTime(ticket.updated_at)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone="neutral">{PRIORITY_LABELS[ticket.priority]}</Badge>
                  <StatusBadge status={ticket.status} />
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

  if (ticket.loading) return <LoadingState />;
  if (ticket.error || !ticket.data) {
    return (
      <Card padded={false}>
        <ErrorState error={ticket.error} onRetry={ticket.reload} />
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        title={ticket.data.subject}
        description={`${ticket.data.ticket_code} · ${TICKET_CATEGORY_LABELS[ticket.data.category] ?? ticket.data.category}`}
        breadcrumbs={[{ label: 'Soporte', to: '/customer/support' }, { label: ticket.data.ticket_code }]}
        actions={<StatusBadge status={ticket.data.status} />}
      />

      <Card>
        <ul className="space-y-4">
          {(ticket.data.messages ?? []).map((entry) => (
            <li key={entry.id} className={entry.role_name === 'CUSTOMER' ? 'ml-0 mr-auto max-w-[85%]' : 'ml-auto mr-0 max-w-[85%]'}>
              <div className={entry.role_name === 'CUSTOMER' ? 'rounded-card bg-slate-100 p-4' : 'rounded-card bg-brand-50 p-4'}>
                <p className="text-xs font-semibold text-ink">
                  {entry.first_name} {entry.last_name}
                </p>
                <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{entry.message}</p>
                <p className="mt-2 text-xs text-slate-400">{formatDateTime(entry.created_at)}</p>
              </div>
            </li>
          ))}
        </ul>

        <form onSubmit={send} className="mt-6 border-t border-border pt-5">
          <Textarea label="Responder" placeholder="Escribe tu mensaje..." value={message} onChange={(event) => setMessage(event.target.value)} />
          <Button type="submit" className="mt-3" loading={sending} disabled={!message.trim()}>
            Enviar respuesta
          </Button>
        </form>
      </Card>
    </>
  );
}
