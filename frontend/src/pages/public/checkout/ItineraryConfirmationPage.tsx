import { ArrowRightLeft, CalendarDays, CheckCircle2, Download, Route as RouteIcon, Ticket, User } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, Button, Card, ErrorState, LoadingState, StatusBadge } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { itineraryService } from '@/services';
import { formatCurrency, formatDate, formatTime } from '@/utils/format';
import { CheckoutStepper } from './CheckoutStepper';
import { useCheckout } from './CheckoutContext';

/**
 * Confirmación de una compra de varios tramos (mockup 1).
 *
 * El QR se mantiene como estaba: uno por reserva, porque cada tramo es la reserva que el
 * pasajero presenta al abordar ese bus. Además se muestra el código de la compra completa,
 * que es lo que agrupa los tramos.
 */
export function ItineraryConfirmationPage() {
  const { groupId } = useParams();
  const checkout = useCheckout();
  const itinerary = useAsync(() => itineraryService.get(Number(groupId)), [groupId]);
  const [codes, setCodes] = useState<Record<string, string>>({});

  useEffect(() => {
    // La compra terminó: se limpia la selección para que una búsqueda nueva empiece limpia.
    if (itinerary.data) checkout.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itinerary.data?.group_id]);

  const segments = (itinerary.data?.segments ?? []) as Array<Record<string, unknown>>;

  useEffect(() => {
    if (segments.length === 0) return;
    void Promise.all(
      segments.map(async (segment) => {
        const code = String(segment.booking_code);
        const url = await QRCode.toDataURL(code, { width: 320, margin: 1, color: { dark: '#0F172A', light: '#FFFFFF' } });
        return [code, url] as const;
      }),
    )
      .then((pairs) => setCodes(Object.fromEntries(pairs)))
      .catch(() => setCodes({}));
  }, [segments.map((segment) => String(segment.booking_code)).join('|')]);

  if (itinerary.loading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10">
        <LoadingState label="Confirmando tu compra..." />
      </div>
    );
  }

  if (itinerary.error || !itinerary.data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Card padded={false}>
          <ErrorState error={itinerary.error} onRetry={itinerary.reload} />
        </Card>
      </div>
    );
  }

  const data = itinerary.data;
  const esIdaVuelta = data.trip_type === 'ROUND_TRIP';

  const descargar = (code: string) => {
    const url = codes[code];
    if (!url) return;
    const link = document.createElement('a');
    link.href = url;
    link.download = `busperu-${code}.png`;
    link.click();
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
      <CheckoutStepper current={6} />

      <Card className="mb-6 text-center">
        <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success-50 text-success-600">
          <CheckCircle2 className="h-9 w-9" />
        </span>
        <h1 className="mt-4 text-2xl font-bold text-ink">¡Compra confirmada!</h1>
        <p className="mt-1 text-sm text-muted">
          Tu {esIdaVuelta ? 'viaje de ida y vuelta' : 'itinerario'} de {segments.length} tramos está listo.
        </p>

        <div className="mt-4 inline-flex items-center gap-2 rounded-control bg-brand-50 px-4 py-2">
          {esIdaVuelta ? <ArrowRightLeft className="h-4 w-4 text-brand-600" /> : <RouteIcon className="h-4 w-4 text-brand-600" />}
          <span className="text-sm text-muted">Código de compra</span>
          <span className="font-bold text-brand-600">{String(data.group_code)}</span>
        </div>

        <p className="mt-4 text-3xl font-extrabold text-ink">{formatCurrency(Number(data.total_amount))}</p>
      </Card>

      <div className="space-y-4">
        {segments.map((segment) => {
          const code = String(segment.booking_code);
          const order = Number(segment.segment_order);

          return (
            <Card key={code}>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-500 text-sm font-bold text-white">
                    {order}
                  </span>
                  <div>
                    <p className="font-bold text-ink">
                      {esIdaVuelta ? (order === 1 ? 'Viaje de ida' : 'Viaje de vuelta') : `Tramo ${order}`}
                    </p>
                    <p className="text-xs text-muted">{String(segment.company_name ?? '')}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={String(segment.status ?? '')} />
                  <Badge tone="brand">{code}</Badge>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
                <dl className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted">Ruta</dt>
                    <dd className="font-semibold text-ink">
                      {String(segment.origin_city ?? '')} → {String(segment.destination_city ?? '')}
                    </dd>
                    <dd className="text-xs text-muted">{String(segment.origin_terminal ?? '')}</dd>
                  </div>
                  <div>
                    <dt className="flex items-center gap-1.5 text-xs text-muted">
                      <CalendarDays className="h-3.5 w-3.5" /> Salida
                    </dt>
                    <dd className="font-semibold text-ink">{formatTime(String(segment.departure_datetime))}</dd>
                    <dd className="text-xs text-muted">{formatDate(String(segment.departure_datetime))}</dd>
                  </div>
                  <div>
                    <dt className="flex items-center gap-1.5 text-xs text-muted">
                      <Ticket className="h-3.5 w-3.5" /> Asientos
                    </dt>
                    <dd className="font-semibold text-ink">{String(segment.seat_numbers ?? '—')}</dd>
                  </div>
                  <div>
                    <dt className="flex items-center gap-1.5 text-xs text-muted">
                      <User className="h-3.5 w-3.5" /> Importe
                    </dt>
                    <dd className="font-semibold text-ink">{formatCurrency(Number(segment.total_amount))}</dd>
                  </div>
                </dl>

                <div className="flex flex-col items-center gap-2">
                  {codes[code] ? (
                    <img src={codes[code]} alt={`Código QR de la reserva ${code}`} className="h-28 w-28 rounded-control border border-border" />
                  ) : (
                    <div className="h-28 w-28 animate-pulse rounded-control bg-slate-100" />
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<Download className="h-3.5 w-3.5" />}
                    disabled={!codes[code]}
                    onClick={() => descargar(code)}
                  >
                    Descargar
                  </Button>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link to="/customer/trips">
          <Button>Ver mis viajes</Button>
        </Link>
        <Link to="/">
          <Button variant="outline">Volver al inicio</Button>
        </Link>
      </div>
    </div>
  );
}
