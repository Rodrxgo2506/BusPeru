import { ArrowLeft, ArrowRight, Armchair, BedDouble, Bus, CalendarDays, Headphones, Lock, Snowflake, Star, Trash2, Tv, Usb, User, Wifi, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DeckSelector, SeatLegend, SeatMap } from '@/components/common/SeatMap';
import { Button, Card, ErrorState, LoadingState } from '@/components/ui';
import { TARJETA_FLOTANTE as FLOTANTE, TravelBackdrop } from '@/components/common/TravelBackdrop';
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
  // La geometria del bus viaja por su propia puerta: el mapa de asientos dice que se vende y
  // a que precio, y este dice que forma tiene el vehiculo. Son dos preguntas distintas.
  const layout = useAsync(() => publicService.tripLayout(tripId), [tripId]);
  const settings = useAsync(() => publicService.settings(), []);

  const [selected, setSelected] = useState<SeatAvailability[]>([]);
  const [activeDeckId, setActiveDeckId] = useState<number | null>(null);

  const decks = layout.data?.decks ?? [];

  // Cuantos asientos tiene cada piso, para el selector. Sale de los asientos reales.
  const seatCountByDeck = useMemo(() => {
    const cuenta = new Map<number, number>();
    for (const seat of seats.data ?? []) {
      if (seat.deck_id === null) continue;
      cuenta.set(seat.deck_id, (cuenta.get(seat.deck_id) ?? 0) + 1);
    }
    return cuenta;
  }, [seats.data]);

  useEffect(() => {
    // Se entra por el primer piso, y si el viaje cambia se vuelve a el.
    const pisos = layout.data?.decks ?? [];
    setActiveDeckId(pisos.length > 0 ? pisos[0]!.id : null);
  }, [layout.data, tripId]);

  const activeDeck = decks.find((deck) => deck.id === activeDeckId) ?? decks[0] ?? null;

  /**
   * Un asiento se puede elegir si el backend lo da por libre. Es el MISMO criterio que usa
   * `SeatMap` para deshabilitar el boton, escrito una sola vez para que no puedan divergir.
   */
  const seleccionable = (seat: SeatAvailability) => seat.is_taken === 0 && seat.status === 'AVAILABLE';

  useEffect(() => {
    if (!seats.data) return;
    // Se repuebla la selección previa: la del tramo si es un itinerario, o la de la
    // compra simple si no lo es.
    //
    // Se filtra ademas por disponibilidad ACTUAL. La seleccion vive en `sessionStorage` y
    // sobrevive a un intento fallido, asi que sin este filtro se restauraba un asiento que
    // entretanto habia quedado ocupado —a veces por la propia reserva PENDING del intento
    // anterior— y la compra moria despues con un 409 imposible de entender desde la
    // pantalla. `setSelected` REEMPLAZA la lista: nunca acumula ni duplica.
    const previos = segment ? (segment.tripId === tripId ? segment.seatIds : []) : checkout.tripId === tripId ? checkout.seatIds : [];
    setSelected(seats.data.filter((seat) => previos.includes(seat.id) && seleccionable(seat)));
  }, [seats.data, checkout.tripId, checkout.seatIds, tripId, segment]);

  const serviceFee = Number(settings.data?.['booking.service_fee'] ?? SERVICE_FEE_FALLBACK);
  const maxSeats = Number(settings.data?.['booking.max_seats_per_booking'] ?? 6);

  const toggleSeat = (seat: SeatAvailability) => {
    // El mapa ya deshabilita los ocupados; esto lo vuelve a comprobar aqui para que la lista
    // no pueda contener un asiento invendible por ninguna via.
    if (!seleccionable(seat)) return;
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
    // Los precios efectivos viajan con la seleccion para que las pantallas siguientes no
    // tengan que recalcular nada. Son de presentacion: el backend recalcula al reservar.
    const seatPrices = selected.map((seat) => Number(seat.price));

    if (segmentOrder) {
      checkout.setSegmentSeats(segmentOrder, tripId, seatIds, seatNumbers, seatPrices);
      // Quedan tramos por configurar: se salta al siguiente antes de pedir los pasajeros.
      if (nextSegment?.tripId) {
        navigate(`/viaje/${nextSegment.tripId}/asientos?segment=${nextSegment.order}`);
        return;
      }
      navigate('/reserva/pasajeros');
      return;
    }

    checkout.setSeats(tripId, seatIds, seatNumbers, seatPrices);
    navigate('/reserva/pasajeros');
  };

  if (trip.loading || seats.loading || layout.loading) {
    return (
      <div className="relative isolate mx-auto max-w-7xl px-4 py-10">
        <TravelBackdrop />
        <LoadingState label="Cargando asientos disponibles..." />
      </div>
    );
  }

  if (trip.error || !trip.data) {
    return (
      <div className="relative isolate mx-auto max-w-3xl px-4 py-10">
        <TravelBackdrop />
        <Card padded={false} className={FLOTANTE}>
          <ErrorState error={trip.error} onRetry={trip.reload} />
        </Card>
      </div>
    );
  }

  const data = trip.data;
  // EL SUBTOTAL ES LA SUMA DE LOS PRECIOS DE LOS ASIENTOS ELEGIDOS, no `base_price` por la
  // cantidad. Desde la migracion 010 dos asientos del mismo viaje pueden costar distinto
  // —`trip_seat_type_prices` fija un precio por tipo— y el backend ya lo resuelve asiento a
  // asiento. Multiplicar aqui volveria a inventar una cifra que el cobro luego desmiente.
  const subtotal = selected.reduce((suma, seat) => suma + Number(seat.price), 0);
  const fees = serviceFee * selected.length;
  const amenities = parseJsonArray(data.amenities);

  return (
    <div className="relative isolate mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      {/* `isolate` da a la capa `-z-10` del paisaje un contexto propio; sin el, quedaria
          por debajo del blanco del armazon publico y no se veria. */}
      <TravelBackdrop />

      <CheckoutStepper current={3} />

      {/* Resumen del viaje en móvil: tarjeta naranja compacta (mockup 3, versión phone). */}
      <div className="mb-5 rounded-card bg-gradient-to-br from-brand-500 via-brand-500 to-brand-600 p-4 text-white shadow-panel lg:hidden">
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
      <Card className={`mb-5 hidden p-5 lg:block ${FLOTANTE}`}>
        {/* Separadores verticales entre bloques, como en la referencia: `divide-x` sobre la
            propia rejilla, sin filetes sueltos que haya que mantener a mano. */}
        <div className="grid gap-5 divide-x divide-border/70 lg:grid-cols-[190px_1fr_auto_268px] lg:items-center">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-control bg-brand-50 text-brand-500 ring-1 ring-brand-100" aria-hidden>
              <Bus className="h-6 w-6" />
            </span>
            <p className="min-w-0 text-[15px] font-extrabold uppercase leading-tight tracking-tight text-ink">{data.company_name}</p>
          </div>

          <div className="flex flex-wrap items-center gap-5 lg:pl-5">
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

          <ul className="space-y-2 text-sm lg:min-w-[190px] lg:pl-5">
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

          <div className="lg:pl-5">
          <div className="rounded-card bg-brand-50/70 p-4 ring-1 ring-brand-100">
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
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[260px_1fr_300px]">
        {/* Columna izquierda */}
        <div className="space-y-5">
          <Card className={`p-5 ${FLOTANTE}`}>
            <h2 className="text-lg font-bold text-ink">Selecciona tus asientos</h2>
            <p className="mt-0.5 text-sm text-muted">Elige los asientos que deseas para tu viaje</p>
            {/* La leyenda se arma con lo que este viaje tiene: una entrada por categoria
                presente con su precio real, y una por elemento que aparezca en algun piso. */}
            <div className="mt-4 rounded-card border border-border/70 bg-white/60 p-4">
              <SeatLegend seats={seats.data ?? []} decks={decks} inline className="lg:hidden" />
              <div className="hidden lg:block">
                <SeatLegend seats={seats.data ?? []} decks={decks} />
              </div>
            </div>
          </Card>

          <Card className={`p-5 ${FLOTANTE}`}>
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

          <div className="flex items-start gap-3 rounded-card border border-brand-100/80 bg-brand-50/85 p-4 shadow-panel backdrop-blur-md">
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

        {/* Mapa de asientos. `min-w-0` es lo que impide que un bus muy ancho empuje la
            pagina: sin el, la pista `1fr` de la rejilla crece con su contenido —su minimo
            es `auto`— y el desplazamiento se lo come el body en lugar del mapa. */}
        <Card className={`min-w-0 p-4 sm:p-6 ${FLOTANTE}`}>
          {seats.error || layout.error ? (
            <ErrorState
              error={seats.error ?? layout.error}
              onRetry={() => {
                seats.reload();
                layout.reload();
              }}
            />
          ) : (seats.data ?? []).length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">Este bus todavía no tiene asientos configurados.</p>
          ) : (
            <div className="w-full">
              {/* El selector sale de los pisos que devuelve el backend; con uno solo no
                  aparece, porque no hay nada entre lo que elegir. */}
              <DeckSelector
                decks={decks}
                activeDeckId={activeDeck?.id ?? null}
                onChange={setActiveDeckId}
                seatCountByDeck={seatCountByDeck}
                className="mb-4 justify-center"
              />
              <SeatMap
                seats={seats.data ?? []}
                deck={activeDeck}
                selected={selected.map((seat) => seat.id)}
                onToggle={toggleSeat}
                maxSelectable={maxSeats}
              />
            </div>
          )}
        </Card>

        {/* Tu selección. En móvil va debajo del mapa —no oculta, porque es donde se ve el
            precio de cada asiento—; la barra fija de abajo se queda solo con el total y el
            botón, que es lo que tiene que estar siempre a mano. */}
        <div className="space-y-5 lg:sticky lg:top-24 lg:self-start">
          <Card className={`p-5 ${FLOTANTE}`}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-bold text-ink">Asientos seleccionados ({selected.length})</h3>
              {selected.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelected([])}
                  className="flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:text-brand-700"
                >
                  <Trash2 className="h-4 w-4" /> Limpiar
                </button>
              )}
            </div>

            {/* Cada asiento con SU precio. No hay un «precio por pasajero» porque no existe:
                el precio depende de la categoria del asiento en este viaje. */}
            <ul className="mt-4 space-y-2.5">
              {selected.length === 0 ? (
                <li className="rounded-card border border-dashed border-border bg-white/60 px-4 py-6 text-center text-sm text-slate-400">
                  Aún no seleccionaste asientos
                </li>
              ) : (
                selected.map((seat) => (
                  <li key={seat.id} className="flex items-center gap-3 rounded-card border border-border/70 bg-white/70 p-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-brand-500 text-xs font-bold tabular-nums text-white">
                      {seat.seat_number}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold text-ink">{seat.seat_number}</span>
                      <span className="block truncate text-xs text-muted">{seat.seat_type_name ?? 'Estándar'}</span>
                    </span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">{formatCurrency(Number(seat.price))}</span>
                    <button
                      type="button"
                      onClick={() => toggleSeat(seat)}
                      aria-label={`Quitar el asiento ${seat.seat_number}`}
                      className="shrink-0 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-danger-600"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                ))
              )}
            </ul>

            <div className="mt-4 rounded-card border border-border/70 bg-white/60 p-4">
              <h4 className="text-sm font-bold text-ink">Resumen de pago</h4>
              <dl className="mt-3 space-y-2.5 text-sm">
                {selected.map((seat) => (
                  <div key={seat.id} className="flex justify-between gap-3">
                    <dt className="min-w-0 truncate text-muted">
                      Asiento {seat.seat_number}
                      {seat.seat_type_name ? ` (${seat.seat_type_name})` : ''}
                    </dt>
                    <dd className="shrink-0 font-medium tabular-nums text-ink">{formatCurrency(Number(seat.price))}</dd>
                  </div>
                ))}
                <div className="flex justify-between border-t border-border pt-2.5">
                  <dt className="font-semibold text-ink">Subtotal</dt>
                  <dd className="font-semibold tabular-nums text-ink">{formatCurrency(subtotal)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">Cargo por servicio</dt>
                  <dd className="font-medium tabular-nums text-ink">{formatCurrency(fees)}</dd>
                </div>
                <div className="flex items-center justify-between border-t border-border pt-3">
                  <dt className="font-semibold text-ink">TOTAL</dt>
                  <dd className="text-xl font-extrabold tabular-nums text-brand-600">{formatCurrency(subtotal + fees)}</dd>
                </div>
              </dl>
            </div>

            <div className="mt-4 flex gap-3 rounded-card bg-warning-50 p-4 ring-1 ring-warning-100">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-warning-600" />
              <p className="text-xs leading-relaxed text-slate-600">
                <span className="block font-semibold text-ink">Tu reserva está segura</span>
                Nadie más podrá seleccionar estos asientos mientras completas tu compra.
              </p>
            </div>

            <div className="hidden lg:block">
              <Button fullWidth size="lg" className="mt-4" disabled={selected.length === 0} onClick={handleContinue} iconRight={<ArrowRight className="h-4 w-4" />}>
                Continuar
              </Button>

              <Link to="/buscar" className="mt-3 flex items-center justify-center gap-1.5 text-sm font-semibold text-brand-600 hover:text-brand-700">
                <ArrowLeft className="h-4 w-4" /> Volver a resultados
              </Link>
            </div>
          </Card>
        </div>
      </div>

      <TrustBar className="mb-24 lg:mb-0" />

      {/* Barra inferior fija en móvil (mockup 3, versión phone). */}
      <div className="fixed inset-x-0 bottom-[62px] z-30 border-t border-border bg-white/95 p-4 shadow-[0_-4px_16px_rgba(15,23,42,0.08)] backdrop-blur-md lg:hidden">
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
