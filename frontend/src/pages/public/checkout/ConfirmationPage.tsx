import { Armchair, BedDouble, CalendarDays, CheckCircle2, Download, Gift, Mail, Search, Smartphone, Ticket, User } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button, Card, ErrorState, LoadingState } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { bookingService } from '@/services';
import { durationBetween, formatCurrency, formatDate, formatTime } from '@/utils/format';
import { CheckoutStepper } from './CheckoutStepper';
import { useCheckout } from './CheckoutContext';

const NEXT_STEPS = [
  { icon: Mail, title: '1. Revisa tu correo', description: 'Hemos enviado los detalles de tu viaje.', tone: 'bg-success-100 text-success-600' },
  { icon: Smartphone, title: '2. Prepárate para tu viaje', description: 'Llega al terminal con anticipación y lleva tu DNI.', tone: 'bg-info-100 text-info-600' },
  { icon: BedDouble, title: '3. Aborda tu bus', description: 'Muestra tu código QR o código de reserva.', tone: 'bg-brand-100 text-brand-600' },
  { icon: Armchair, title: '4. ¡Disfruta tu viaje!', description: 'Que tengas un excelente viaje.', tone: 'bg-purple-100 text-purple-600' },
];

export function ConfirmationPage() {
  const { bookingId } = useParams();
  const checkout = useCheckout();
  const booking = useAsync(() => bookingService.get(Number(bookingId)), [bookingId]);
  const [qr, setQr] = useState<string | null>(null);

  // `checkout` cambia con cada cambio del contexto, incluido el propio `reset`: se lee por ref
  // para limpiar una sola vez por reserva cargada.
  const checkoutRef = useRef(checkout);
  checkoutRef.current = checkout;
  const loadedBookingId = booking.data?.id ?? null;

  useEffect(() => {
    // The purchase is done; clear the in-progress selection so a new search starts clean.
    if (loadedBookingId !== null) checkoutRef.current.reset();
  }, [loadedBookingId]);

  useEffect(() => {
    if (!booking.data?.booking_code) return;
    void QRCode.toDataURL(booking.data.booking_code, { width: 320, margin: 1, color: { dark: '#0F172A', light: '#FFFFFF' } })
      .then(setQr)
      .catch(() => setQr(null));
  }, [booking.data?.booking_code]);

  if (booking.loading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10">
        <LoadingState label="Confirmando tu reserva..." />
      </div>
    );
  }

  if (booking.error || !booking.data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Card padded={false}>
          <ErrorState error={booking.error} onRetry={booking.reload} />
        </Card>
      </div>
    );
  }

  const data = booking.data;

  const downloadTicket = () => {
    if (!qr) return;
    const link = document.createElement('a');
    link.href = qr;
    link.download = `pasaje-${data.booking_code}.png`;
    link.click();
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <CheckoutStepper current={6} />

      <Card className="mb-5">
        <div className="flex items-start gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-success-100 text-success-600">
            <CheckCircle2 className="h-7 w-7" />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-ink">¡Tu pasaje ha sido confirmado!</h1>
            <p className="mt-1 text-sm text-muted">Hemos enviado los detalles de tu viaje a {data.passenger_email ?? data.user_email}</p>
          </div>
        </div>

        <div className="mt-6 grid gap-6 border-t border-border pt-6 lg:grid-cols-[1fr_auto]">
          <div className="flex flex-wrap items-center gap-6">
            <div>
              <p className="text-lg font-extrabold uppercase leading-tight text-ink">{data.company_name}</p>
              <p className="mt-1 flex items-center gap-1.5 text-sm text-muted">
                <BedDouble className="h-4 w-4" />
                {data.bus_type_name ?? 'Bus'}
              </p>
            </div>
            <div>
              <p className="text-2xl font-bold text-ink">{formatTime(data.departure_datetime)}</p>
              <p className="text-sm text-muted">{data.origin_terminal}</p>
              <p className="text-sm font-semibold">{data.origin_city}</p>
            </div>
            <div className="flex min-w-[92px] flex-col items-center">
              <span className="text-xs text-muted">{durationBetween(data.departure_datetime, data.arrival_datetime)}</span>
              <span className="my-1.5 h-px w-full bg-border" />
              <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-slate-500">Directo</span>
            </div>
            <div>
              <p className="text-2xl font-bold text-ink">{formatTime(data.arrival_datetime)}</p>
              <p className="text-sm text-muted">{data.destination_terminal}</p>
              <p className="text-sm font-semibold">{data.destination_city}</p>
            </div>
          </div>

          <dl className="space-y-2.5 text-sm lg:min-w-[230px] lg:border-l lg:border-border lg:pl-6">
            <Row icon={<CalendarDays className="h-4 w-4 text-brand-500" />} label="Fecha de viaje" value={formatDate(data.departure_datetime)} />
            <Row icon={<User className="h-4 w-4 text-brand-500" />} label="Pasajero" value={`${data.passenger_count} ${data.passenger_count === 1 ? 'pasajero' : 'pasajeros'}`} />
            <Row icon={<Ticket className="h-4 w-4 text-brand-500" />} label="Asiento" value={data.seat_numbers ?? '—'} />
            <Row icon={<BedDouble className="h-4 w-4 text-brand-500" />} label="Servicio" value={data.bus_type_name ?? '—'} />
          </dl>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
        <Card className="border-success-200 bg-success-50/40">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm text-muted">Código de reserva</p>
              <p className="text-2xl font-extrabold tracking-wide text-success-700">{data.booking_code}</p>
            </div>
            <div className="text-right">
              <p className="text-sm text-muted">Estado</p>
              <p className="flex items-center gap-1.5 font-semibold text-success-700">
                Confirmado <CheckCircle2 className="h-4 w-4" />
              </p>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-5 border-t border-success-200/70 pt-5">
            {qr ? (
              <img src={qr} alt={`Código QR de la reserva ${data.booking_code}`} className="h-28 w-28 rounded-lg border border-border bg-white p-1" />
            ) : (
              <div className="h-28 w-28 animate-pulse rounded-lg bg-slate-200" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-ink">Muestra este código al abordar</p>
              <p className="mt-0.5 text-sm text-muted">También lo enviamos a tu correo electrónico</p>
              <Button variant="outline" size="sm" className="mt-3" icon={<Download className="h-4 w-4" />} onClick={downloadTicket} disabled={!qr}>
                Descargar pasaje
              </Button>
            </div>
          </div>
        </Card>

        <Card>
          <h2 className="font-semibold text-ink">Resumen de pago</h2>
          <dl className="mt-4 space-y-2.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">Precio por pasaje</dt>
              <dd className="font-medium text-ink">{formatCurrency(data.subtotal)}</dd>
            </div>
            {Number(data.discount_amount) > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted">Descuento</dt>
                <dd className="font-medium text-success-600">- {formatCurrency(data.discount_amount)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-muted">Cargo por servicio</dt>
              <dd className="font-medium text-ink">{formatCurrency(data.service_fee)}</dd>
            </div>
            <div className="flex items-center justify-between border-t border-border pt-3">
              <dt className="font-semibold text-ink">Total pagado</dt>
              <dd className="text-xl font-extrabold text-brand-600">{formatCurrency(data.total_amount)}</dd>
            </div>
          </dl>
          {data.payment_status === 'PAID' && (
            <p className="mt-4 flex justify-end">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-success-100 px-3 py-1 text-xs font-semibold text-success-700">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Pago aprobado
              </span>
            </p>
          )}
        </Card>
      </div>

      <Card className="mt-5">
        <h2 className="font-semibold text-ink">¿Qué sigue?</h2>
        <ol className="mt-5 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {NEXT_STEPS.map((step) => {
            const Icon = step.icon;
            return (
              <li key={step.title} className="text-center">
                <span className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full ${step.tone}`}>
                  <Icon className="h-6 w-6" />
                </span>
                <p className="mt-3 text-sm font-semibold text-ink">{step.title}</p>
                <p className="mt-1 text-sm text-muted">{step.description}</p>
              </li>
            );
          })}
        </ol>
      </Card>

      <div className="mt-5 flex flex-col gap-3 sm:flex-row">
        <Button variant="outline" fullWidth to="/customer/trips" icon={<Gift className="h-4 w-4" />}>
          Ir a mis viajes
        </Button>
        <Button fullWidth to="/" icon={<Search className="h-4 w-4" />}>
          Buscar otro pasaje
        </Button>
      </div>
    </div>
  );
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="flex items-center gap-2 text-muted">
        {icon}
        {label}
      </dt>
      <dd className="text-right font-medium text-ink">{value}</dd>
    </div>
  );
}
