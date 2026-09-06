import { ArrowLeft, ArrowRight, Armchair, BedDouble, CalendarDays, Headphones, Lock, Snowflake, Star, Tv, Usb, User, Wifi } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { SeatLegend, SeatMap } from '@/components/common/SeatMap';
import { Button, Card, ErrorState, LoadingState } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { publicService } from '@/services';
import type { SeatAvailability } from '@/types';
import { durationBetween, formatCurrency, formatDate, formatTime, parseJsonArray } from '@/utils/format';
import { CheckoutStepper, TrustBar } from './CheckoutStepper';
import { useCheckout } from './CheckoutContext';

const SERVICE_FEE_FALLBACK = 2.5;

const AMENITY_ICONS: Record<string, typeof Wifi> = {
  WiFi: Wifi,
  'Aire acondicionado': Snowflake,
  USB: Usb,
  TV: Tv,
  Baño: Armchair,
};

export function SeatSelectionPage() {
  const { tripId: tripIdParam } = useParams();
  const tripId = Number(tripIdParam);
  const navigate = useNavigate();
  const checkout = useCheckout();
  const [searchParams] = useSearchParams();

  /**
   * En una compra de varios tramos la URL trae `?segment=N`. Los asientos se guardan en
   * ese tramo y, al continuar, se pasa al siguiente tramo en lugar de a los pasajeros.
   * Sin ese parámetro el comportamiento es exactamente el de IDA.
   */
  const segmentParam = Number(searchParams.get('segment') ?? 0);
  const segmentOrder = Number.isInteger(segmentParam) && segmentParam > 0 ? segmentParam : null;
  const segment = segmentOrder ? checkout.segments.find((entry) => entry.order === segmentOrder) ?? null : null;
  const nextSegment = segmentOrder ? checkout.segments.find((entry) => entry.order === segmentOrder + 1) ?? null : null;

  const trip = useAsync(() => publicService.trip(tripId), [tripId]);
  const seats = useAsync(() => publicService.tripSeats(tripId), [tripId]);
  const settings = useAsync(() => publicService.settings(), []);

  const [selected, setSelected] = useState<SeatAvailability[]>([]);

  useEffect(() => {
    if (!seats.data) return;
    // Se repuebla la selección previa: la del tramo si es un itinerario, o la de la
    // compra simple si no lo es.
    const previos = segment ? (segment.tripId === tripId ? segment.seatIds : []) : checkout.tripId === tripId ? checkout.seatIds : [];
    setSelected(seats.data.filter((seat) => previos.includes(seat.id)));
  }, [seats.data, checkout.tripId, checkout.seatIds, tripId, segment]);

  const serviceFee = Number(settings.data?.['booking.service_fee'] ?? SERVICE_FEE_FALLBACK);
  const maxSeats = Number(settings.data?.['booking.max_seats_per_booking'] ?? 6);

  const toggleSeat = (seat: SeatAvailability) => {
    setSelected((current) => {
      const exists = current.some((entry) => entry.id === seat.id);
      if (exists) return current.filter((entry) => entry.id !== seat.id);
      if (current.length >= maxSeats) return current;
      return [...current, seat];
    });
  };

  const handleContinue = () => {
    const seatIds = selected.map((seat) => seat.id);
    const seatNumbers = selected.map((seat) => seat.seat_number);

    if (segmentOrder) {
      checkout.setSegmentSeats(segmentOrder, tripId, seatIds, seatNumbers);
      // Quedan tramos por configurar: se salta al siguiente antes de pedir los pasajeros.
      if (nextSegment?.tripId) {
        navigate(`/viaje/${nextSegment.tripId}/asientos?segment=${nextSegment.order}`);
        return;
      }
      navigate('/reserva/pasajeros');
      return;
    }

    checkout.setSeats(tripId, seatIds, seatNumbers);
    navigate('/reserva/pasajeros');
  };

  if (trip.loading || seats.loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10">
        <LoadingState label="Cargando asientos disponibles..." />
      </div>
    );
  }

  if (trip.error || !trip.data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Card padded={false}>
          <ErrorState error={trip.error} onRetry={trip.reload} />
        </Card>
      </div>
    );
  }

  const data = trip.data;
  const basePrice = Number(data.base_price);
  const subtotal = basePrice * selected.length;
  const fees = serviceFee * selected.length;
  const amenities = parseJsonArray(data.amenities);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <CheckoutStepper current={3} />

      {/* Resumen del viaje en móvil: tarjeta naranja compacta (mockup 3, versión phone). */}
      <div className="mb-5 rounded-card bg-gradient-to-br from-brand-500 to-brand-600 p-4 text-white lg:hidden">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-bold uppercase tracking-tight">{data.company_name}</p>
          {data.company_rating !== null && (
            <span className="flex items-center gap-1 text-sm font-semibold">
              <Star className="h-3.5 w-3.5 fill-white text-white" />
              {data.company_rating}
            </span>
          )}
        </div>
        <div className="mt-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-2xl font-bold">{formatTime(data.departure_datetime)}</p>
            <p className="text-xs text-white/85">{data.origin_terminal}</p>
            <p className="text-sm font-semibold">{data.origin_city}</p>
          </div>
          <div className="flex flex-col items-center pt-1.5">
            <span className="text-[11px] text-white/85">{durationBetween(data.departure_datetime, data.arrival_datetime)}</span>
            <span className="my-1 h-px w-14 bg-white/40" />
            <span className="rounded-full border border-white/50 px-2 py-0.5 text-[11px]">Directo</span>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold">{formatTime(data.arrival_datetime)}</p>
            <p className="text-xs text-white/85">{data.destination_terminal}</p>
            <p className="text-sm font-semibold">{data.destination_city}</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/25 pt-3 text-sm">
          <span className="flex items-center gap-1.5">
            <BedDouble className="h-4 w-4" />
            {data.bus_type_name ?? 'Bus'}
          </span>
          <span className="flex items-center gap-1.5">
            <Armchair className="h-4 w-4" />
            {data.capacity ?? seats.data?.length ?? 0} asientos
          </span>
          <span className="flex items-center gap-1.5">
            <CalendarDays className="h-4 w-4" />
            {formatDate(data.departure_datetime)}
          </span>
        </div>
      </div>

      {/* Resumen del viaje (mockup 3, versión escritorio) */}
      <Card className="mb-5 hidden lg:block">
        <div className="grid gap-5 lg:grid-cols-[170px_1fr_auto_260px] lg:items-center">
          <p className="text-lg font-extrabold uppercase leading-tight tracking-tight text-ink">{data.company_name}</p>

          <div className="flex flex-wrap items-center gap-5">
            <div>
              <p className="text-2xl font-bold text-ink">{formatTime(data.departure_datetime)}</p>
              <p className="text-sm text-muted">{data.origin_terminal}</p>
              <p className="text-sm font-semibold text-ink">{data.origin_city}</p>
            </div>
            <div className="flex min-w-[92px] flex-col items-center">
              <span className="text-xs text-muted">{durationBetween(data.departure_datetime, data.arrival_datetime)}</span>
              <span className="my-1.5 h-px w-full bg-border" />
              <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-slate-500">Directo</span>
            </div>
            <div>
              <p className="text-2xl font-bold text-ink">{formatTime(data.arrival_datetime)}</p>
              <p className="text-sm text-muted">{data.destination_terminal}</p>
              <p className="text-sm font-semibold text-ink">{data.destination_city}</p>
            </div>
          </div>

          <ul className="space-y-2 text-sm lg:min-w-[190px]">
            <li className="flex items-center gap-2 text-slate-700">
              <BedDouble className="h-4 w-4 shrink-0 text-slate-400" />
              {data.bus_type_name ?? 'Bus'}
            </li>
            <li className="flex items-center gap-2 text-slate-700">
              <Armchair className="h-4 w-4 shrink-0 text-slate-400" />
              {data.capacity ?? seats.data?.length ?? 0} asientos
            </li>
            {data.company_rating !== null && (
              <li className="flex items-center gap-2 text-slate-700">
                <Star className="h-4 w-4 shrink-0 fill-warning-500 text-warning-500" />
                <span className="font-semibold text-ink">{data.company_rating}</span>
                <span className="text-muted">({data.company_reviews} opiniones)</span>
              </li>
            )}
          </ul>

          <div className="rounded-card bg-brand-50/70 p-4">
            <p className="text-xs text-muted">Fecha de viaje</p>
            <p className="mt-1 flex items-center gap-2 font-semibold text-ink">
              <CalendarDays className="h-4 w-4 text-brand-500" />
              {formatDate(data.departure_datetime)}
            </p>
            <p className="mt-3 flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 font-semibold text-ink">
                <User className="h-4 w-4 text-brand-500" />
                {selected.length || 1} {selected.length === 1 || selected.length === 0 ? 'pasajero' : 'pasajeros'}
              </span>
              <Link to="/buscar" className="text-sm font-semibold text-brand-600 hover:text-brand-700">
                Editar
              </Link>
            </p>
          </div>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[260px_1fr_300px]">
        {/* Columna izquierda */}
        <div className="space-y-5">
          <Card>
            <h2 className="text-lg font-bold text-ink">Selecciona tus asientos</h2>
            <p className="mt-0.5 text-sm text-muted">Elige los asientos que deseas para tu viaje</p>
            <div className="mt-4 rounded-card border border-border p-4">
              <SeatLegend inline className="lg:hidden" />
              <div className="hidden lg:block">
                <SeatLegend />
              </div>
            </div>
          </Card>

          <Card>
            <h3 className="font-semibold text-ink">Información del bus</h3>
            <ul className="mt-4 space-y-3 text-sm text-slate-700">
              <li className="flex items-center gap-2.5">
                <BedDouble className="h-4 w-4 shrink-0 text-slate-400" />
                {data.bus_type_name ?? 'Bus'}
              </li>
              {amenities.map((amenity) => {
                const Icon = AMENITY_ICONS[amenity] ?? Snowflake;
                return (
                  <li key={amenity} className="flex items-center gap-2.5">
                    <Icon className="h-4 w-4 shrink-0 text-slate-400" />
                    {amenity}
                  </li>
                );
              })}
            </ul>
          </Card>

          <div className="flex items-start gap-3 rounded-card bg-brand-50 p-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-brand-500">
              <Headphones className="h-[18px] w-[18px]" />
            </span>
            <p className="text-sm">
              <span className="block font-semibold text-ink">¿Necesitas ayuda?</span>
              <span className="block text-muted">Nuestro equipo está disponible</span>
              <span className="block text-lg font-bold text-brand-600">24/7</span>
            </p>
          </div>
        </div>

        {/* Mapa de asientos */}
        <Card className="flex items-center justify-center">
          {seats.error ? (
            <ErrorState error={seats.error} onRetry={seats.reload} />
          ) : (seats.data ?? []).length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">Este bus todavía no tiene asientos configurados.</p>
          ) : (
            <div className="w-full">
              <SeatMap seats={seats.data ?? []} selected={selected.map((seat) => seat.id)} onToggle={toggleSeat} maxSelectable={maxSeats} />
            </div>
          )}
        </Card>

        {/* Tu selección */}
        <div className="hidden space-y-5 lg:sticky lg:top-24 lg:block lg:self-start">
          <Card>
            <h3 className="text-lg font-bold text-ink">Tu selección</h3>

            <div className="mt-4 rounded-card border border-border p-4">
              <p className="text-sm text-muted">Asiento seleccionado</p>
              <div className="mt-2 flex min-h-[30px] flex-wrap gap-1.5">
                {selected.length === 0 ? (
                  <span className="text-sm text-slate-400">Aún no seleccionaste asientos</span>
                ) : (
                  selected.map((seat) => (
                    <span key={seat.id} className="rounded bg-slate-200 px-2.5 py-1 text-sm font-semibold text-slate-700">
                      {seat.seat_number}
                    </span>
                  ))
                )}
              </div>
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3 text-sm">
                <span className="text-muted">Total pasajeros</span>
                <span className="flex items-center gap-3">
                  <span className="font-semibold text-ink">{selected.length}</span>
                  {selected.length > 0 && (
                    <button type="button" onClick={() => setSelected([])} className="text-sm font-semibold text-brand-600 hover:text-brand-700">
                      Editar
                    </button>
                  )}
                </span>
              </div>
            </div>

            <div className="mt-4 rounded-card border border-border p-4">
              <dl className="space-y-2.5 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted">Precio por pasajero</dt>
                  <dd className="font-medium text-ink">{formatCurrency(basePrice)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">Cargo por servicio</dt>
                  <dd className="font-medium text-ink">{formatCurrency(serviceFee)}</dd>
                </div>
                <div className="flex items-center justify-between border-t border-border pt-3">
                  <dt className="font-semibold text-ink">TOTAL</dt>
                  <dd className="text-xl font-extrabold text-brand-600">{formatCurrency(subtotal + fees)}</dd>
                </div>
              </dl>
            </div>

            <div className="mt-4 flex gap-3 rounded-card bg-brand-50/70 p-4">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-warning-600" />
              <p className="text-xs leading-relaxed text-slate-600">
                <span className="block font-semibold text-ink">Tu reserva está segura</span>
                Nadie más podrá seleccionar estos asientos mientras completas tu compra.
              </p>
            </div>

            <Button fullWidth size="lg" className="mt-4" disabled={selected.length === 0} onClick={handleContinue} iconRight={<ArrowRight className="h-4 w-4" />}>
              Continuar
            </Button>

            <Link to="/buscar" className="mt-3 flex items-center justify-center gap-1.5 text-sm font-semibold text-brand-600 hover:text-brand-700">
              <ArrowLeft className="h-4 w-4" /> Volver a resultados
            </Link>
          </Card>
        </div>
      </div>

      <TrustBar className="mb-24 lg:mb-0" />

      {/* Barra inferior fija en móvil (mockup 3, versión phone). */}
      <div className="fixed inset-x-0 bottom-[62px] z-30 border-t border-border bg-white p-4 shadow-[0_-4px_16px_rgba(15,23,42,0.08)] lg:hidden">
        <div className="mb-3 flex items-center justify-between gap-3 rounded-control border border-border p-3">
          <span className="min-w-0">
            <span className="block text-xs text-muted">Asiento seleccionado</span>
            <span className="mt-1 flex flex-wrap gap-1.5">
              {selected.length === 0 ? (
                <span className="text-sm text-slate-400">Ninguno</span>
              ) : (
                selected.map((seat) => (
                  <span key={seat.id} className="rounded bg-slate-200 px-2 py-0.5 text-sm font-semibold text-slate-700">
                    {seat.seat_number}
                  </span>
                ))
              )}
            </span>
          </span>
          <span className="shrink-0 text-right">
            <span className="block text-xs text-muted">Total pasajeros</span>
            <span className="block font-semibold text-ink">{selected.length}</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="shrink-0">
            <span className="block text-xs text-muted">TOTAL</span>
            <span className="block text-lg font-extrabold text-brand-600">{formatCurrency(subtotal + fees)}</span>
          </span>
          <Button fullWidth disabled={selected.length === 0} onClick={handleContinue} iconRight={<ArrowRight className="h-4 w-4" />}>
            Continuar
          </Button>
        </div>
      </div>
    </div>
  );
}
