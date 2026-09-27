import { ArrowLeft, ArrowRight, BadgeCheck, BedDouble, CalendarDays, Headphones, Info, Snowflake, Star, Tag, Trash2, Tv, Usb, Wifi, X, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CompanyIdentity } from '@/components/companies/CompanyCard';
import { DeckSelector, SeatLegend, SeatMap } from '@/components/common/SeatMap';
import { ArrivalDayBadge } from '@/components/search/ArrivalDayBadge';
import { Button, Card, ErrorState } from '@/components/ui';
import { TARJETA_FLOTANTE as FLOTANTE, TravelBackdrop } from '@/components/common/TravelBackdrop';
import { useAsync } from '@/hooks/useAsync';
import { publicService } from '@/services';
import type { SeatAvailability } from '@/types';
import { formatShortEs } from '@/utils/calendar';
import { durationBetween, formatCurrency, formatTime, parseJsonArray } from '@/utils/format';
import { freeSeatsByDeck, isSeatSelectable, selectionSummary, toggleSeatSelection } from '@/utils/seat-map';
import { CheckoutStepper, TrustBar } from './CheckoutStepper';
import { useCheckout } from './CheckoutContext';

const SERVICE_FEE_FALLBACK = 2.5;

const AMENITY_ICONS: Record<string, LucideIcon> = {
  WiFi: Wifi,
  'Aire acondicionado': Snowflake,
  USB: Usb,
  TV: Tv,
};

/**
 * Selección de asientos de un viaje.
 *
 * TODO SALE DEL SISTEMA REAL: los asientos y su precio de `GET /public/trips/:id/seats`, la forma del
 * bus y sus pisos del layout congelado del viaje (`GET /public/trips/:id/layout`), y el límite por
 * compra de `booking.max_seats_per_booking`. Un bus tiene uno o dos pisos porque su layout los tiene;
 * con uno solo no hay selector. Cambiar de piso no borra la selección: la lista no depende del piso.
 */
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

  // Asientos LIBRES de cada piso, para las pestañas. Sale de los asientos reales del viaje.
  const freeByDeck = useMemo(() => freeSeatsByDeck(seats.data ?? []), [seats.data]);

  useEffect(() => {
    // Se entra por el primer piso, y si el viaje cambia se vuelve a el.
    const pisos = layout.data?.decks ?? [];
    setActiveDeckId(pisos.length > 0 ? pisos[0]!.id : null);
  }, [layout.data, tripId]);

  const activeDeck = decks.find((deck) => deck.id === activeDeckId) ?? decks[0] ?? null;

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
    setSelected(seats.data.filter((seat) => previos.includes(seat.id) && isSeatSelectable(seat)));
  }, [seats.data, checkout.tripId, checkout.seatIds, tripId, segment]);

  const serviceFee = Number(settings.data?.['booking.service_fee'] ?? SERVICE_FEE_FALLBACK);
  // Regla de siempre: el tope es el máximo de asientos por compra de la plataforma.
  const maxSeats = Number(settings.data?.['booking.max_seats_per_booking'] ?? 6);

  // El mapa ya deshabilita los ocupados; la regla se vuelve a aplicar aqui para que la lista
  // no pueda contener un asiento invendible por ninguna via.
  const toggleSeat = (seat: SeatAvailability) => setSelected((current) => toggleSeatSelection(current, seat, maxSeats));

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

  /** Vuelve a los resultados de la búsqueda de la que se vino (con su fecha y filtros). */
  const backToResults = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/buscar');
  };

  if (trip.loading || seats.loading || layout.loading) return <SeatPageSkeleton />;

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
  const summary = selectionSummary(selected);
  const fees = serviceFee * selected.length;
  const total = summary.subtotal + fees;
  const amenities = parseJsonArray(data.amenities);
  const departureDay = String(data.departure_datetime).slice(0, 10);

  const summaryBody = (
    <>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-ink">Tu selección</h2>
        {selected.length > 0 && (
          <button type="button" onClick={() => setSelected([])} className="flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:text-brand-700">
            <Trash2 className="h-4 w-4" /> Limpiar
          </button>
        )}
      </div>
      <p className="mt-0.5 text-sm text-muted" aria-live="polite">
        Asientos seleccionados: <strong className="text-ink">{selected.length}</strong> de máx. {maxSeats}
      </p>

      {/* Cada asiento con SU precio: depende de la categoría del asiento en este viaje. */}
      <ul className="mt-4 space-y-2">
        {selected.length === 0 ? (
          <li className="rounded-xl border border-dashed border-border bg-slate-50/70 px-4 py-6 text-center text-sm text-slate-400">
            Elige uno o más asientos en el mapa
          </li>
        ) : (
          selected.map((seat) => (
            <li key={seat.id} className="flex animate-rise-in items-center gap-3 rounded-xl bg-white p-2.5 ring-1 ring-border">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-500 text-xs font-bold tabular-nums text-white">
                {seat.seat_number}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold text-ink">Asiento {seat.seat_number}</span>
                <span className="block text-xs leading-snug text-muted">
                  {seat.seat_type_name ?? 'Estándar'}
                  {seat.deck_number && decks.length > 1 ? ` · Piso ${seat.deck_number}` : ''}
                </span>
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

      <dl className="mt-4 space-y-2 border-t border-border pt-4 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted">
            {summary.count === 0
              ? 'Pasajes'
              : summary.unitPrice !== null
                ? `${formatCurrency(summary.unitPrice)} × ${summary.count}`
                : `${summary.count} ${summary.count === 1 ? 'pasaje' : 'pasajes'}`}
          </dt>
          <dd className="font-medium tabular-nums text-ink">{formatCurrency(summary.subtotal)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Cargo por servicio</dt>
          <dd className="font-medium tabular-nums text-ink">{formatCurrency(fees)}</dd>
        </div>
        <div className="flex items-center justify-between border-t border-border pt-3">
          <dt className="font-bold text-ink">Total</dt>
          <dd className="text-2xl font-extrabold tabular-nums text-brand-600">{formatCurrency(total)}</dd>
        </div>
      </dl>

      <div className="mt-4 flex gap-2.5 rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-600 ring-1 ring-slate-200/70">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" aria-hidden />
        <p>Tus asientos quedan reservados durante unos minutos cuando confirmas la compra en el paso de pago. Hasta entonces, otra persona podría elegirlos.</p>
      </div>
    </>
  );

  return (
    <div className="relative isolate mx-auto max-w-7xl px-4 pb-6 pt-6 sm:px-6 lg:px-8">
      {/* `isolate` da a la capa `-z-10` del paisaje un contexto propio; sin el, quedaria
          por debajo del blanco del armazon publico y no se veria. */}
      <TravelBackdrop />

      <CheckoutStepper current={3} />

      {/* ------------------------------------------------ el viaje, siempre a la vista */}
      <section className={`mb-5 rounded-2xl border p-4 sm:p-5 ${FLOTANTE}`} aria-label="Datos del viaje">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          <div className="flex min-w-0 items-center gap-3">
            <CompanyIdentity name={data.company_name ?? 'Empresa'} logoUrl={data.company_logo} size="sm" />
            <div className="min-w-0">
              <p className="truncate text-[15px] font-extrabold uppercase leading-tight tracking-tight text-ink">{data.company_name}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
                {data.company_rating !== null && (
                  <span className="inline-flex items-center gap-1 font-semibold text-ink">
                    <Star className="h-3.5 w-3.5 fill-warning-500 text-warning-500" aria-hidden />
                    {data.company_rating}
                  </span>
                )}
                <span className="inline-flex items-center gap-1 text-success-700">
                  <BadgeCheck className="h-3.5 w-3.5" aria-hidden /> Verificada
                </span>
              </p>
            </div>
          </div>

          <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto sm:flex-1 sm:gap-4">
            <div>
              <p className="text-xl font-extrabold tabular-nums text-ink sm:text-2xl">{formatTime(data.departure_datetime)}</p>
              <p className="text-sm font-semibold text-slate-700">{data.origin_city}</p>
            </div>
            <div className="flex min-w-[64px] flex-1 flex-col items-center">
              <span className="text-[11px] font-medium text-muted">{durationBetween(data.departure_datetime, data.arrival_datetime)}</span>
              <span className="my-1 h-px w-full bg-slate-200" aria-hidden />
            </div>
            <div className="text-right">
              <p className="text-xl font-extrabold tabular-nums text-ink sm:text-2xl">
                {formatTime(data.arrival_datetime)}
                <ArrivalDayBadge departure={data.departure_datetime} arrival={data.arrival_datetime} />
              </p>
              <p className="text-sm font-semibold text-slate-700">{data.destination_city}</p>
            </div>
          </div>

          <ul className="flex flex-wrap items-center gap-2 text-xs font-medium text-slate-600">
            <li className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1.5 text-brand-700 ring-1 ring-brand-100">
              <CalendarDays className="h-3.5 w-3.5" aria-hidden />
              {formatShortEs(departureDay)} · {formatTime(data.departure_datetime)}
            </li>
            {data.bus_type_name && (
              <li className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-3 py-1.5 ring-1 ring-slate-200/70">
                <BedDouble className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                {data.bus_type_name}
              </li>
            )}
            <li className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-3 py-1.5 ring-1 ring-slate-200/70">
              <Tag className="h-3.5 w-3.5 text-slate-400" aria-hidden />
              Desde {formatCurrency(data.base_price)}
            </li>
          </ul>
        </div>
        {amenities.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5 border-t border-border pt-3" aria-label="Comodidades del bus">
            {amenities.map((amenity) => {
              const Icon = AMENITY_ICONS[amenity] ?? BadgeCheck;
              return (
                <li key={amenity} className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs text-slate-600">
                  <Icon className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                  {amenity}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* ------------------------------------------------ mapa de asientos
            `min-w-0` impide que un bus muy ancho empuje la pagina: el desplazamiento se queda
            dentro del mapa. */}
        <Card className={`min-w-0 p-4 sm:p-6 ${FLOTANTE}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-extrabold tracking-tight text-ink">Elige tus asientos</h1>
              <p className="mt-0.5 text-sm text-muted">Toca un asiento disponible para seleccionarlo.</p>
            </div>
          </div>

          <SeatLegend seats={seats.data ?? []} decks={decks} inline className="mt-4 rounded-xl bg-slate-50/80 px-4 py-3 ring-1 ring-slate-200/60" />

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
            <div className="mt-5 w-full">
              {/* El selector sale de los pisos que devuelve el backend; con uno solo no
                  aparece, porque no hay nada entre lo que elegir. */}
              <DeckSelector
                decks={decks}
                activeDeckId={activeDeck?.id ?? null}
                onChange={setActiveDeckId}
                seatCountByDeck={freeByDeck}
                countSuffix="libres"
                className="mb-4 justify-center"
              />
              <SeatMap
                seats={seats.data ?? []}
                deck={activeDeck}
                selected={selected.map((seat) => seat.id)}
                onToggle={toggleSeat}
                maxSelectable={maxSeats}
                showPrices={false}
              />
            </div>
          )}
        </Card>

        {/* ------------------------------------------------ resumen */}
        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start" aria-label="Resumen de la selección">
          <Card className={`p-5 ${FLOTANTE}`}>
            {summaryBody}
            <div className="hidden lg:block">
              <Button fullWidth size="lg" className="mt-4" disabled={selected.length === 0} onClick={handleContinue} iconRight={<ArrowRight className="h-4 w-4" />}>
                Continuar
              </Button>
              <button type="button" onClick={backToResults} className="mt-3 flex w-full items-center justify-center gap-1.5 text-sm font-semibold text-brand-600 hover:text-brand-700">
                <ArrowLeft className="h-4 w-4" /> Volver a resultados
              </button>
            </div>
          </Card>

          <div className="flex items-start gap-3 rounded-2xl border border-brand-100/80 bg-brand-50/85 p-4 shadow-panel backdrop-blur-md">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-brand-500">
              <Headphones className="h-[18px] w-[18px]" />
            </span>
            <p className="text-sm">
              <span className="block font-semibold text-ink">¿Necesitas ayuda?</span>
              <span className="block text-muted">Nuestro equipo está disponible</span>
              <span className="block text-lg font-bold text-brand-600">24/7</span>
            </p>
          </div>
        </aside>
      </div>

      <TrustBar className="mb-28 lg:mb-0" />

      {/* ------------------------------------------------ barra fija en móvil */}
      <div className="fixed inset-x-0 bottom-[62px] z-30 border-t border-border bg-white/95 px-4 py-3 shadow-[0_-4px_16px_rgba(15,23,42,0.08)] backdrop-blur-md lg:hidden">
        <div className="mx-auto flex max-w-xl items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-muted" aria-live="polite">
              {selected.length === 0
                ? 'Ningún asiento elegido'
                : `${selected.length} ${selected.length === 1 ? 'asiento' : 'asientos'}: ${summary.numbers.join(', ')}`}
            </p>
            <p className="text-lg font-extrabold tabular-nums text-brand-600">{formatCurrency(total)}</p>
          </div>
          <Button disabled={selected.length === 0} onClick={handleContinue} iconRight={<ArrowRight className="h-4 w-4" />}>
            Continuar
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Carga de la pantalla de asientos con la misma estructura que la final (sin saltos). */
function SeatPageSkeleton() {
  return (
    <div className="relative isolate mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8" aria-busy="true" aria-label="Cargando asientos disponibles">
      <TravelBackdrop />
      <div className="skeleton mb-6 h-10 w-full max-w-lg rounded-full" />
      <div className="skeleton mb-5 h-24 w-full rounded-2xl" />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="rounded-2xl bg-white/85 p-6 shadow-panel">
          <div className="skeleton h-6 w-48" />
          <div className="skeleton mt-4 h-10 w-full rounded-xl" />
          <div className="mx-auto mt-6 grid w-fit grid-cols-5 gap-2">
            {Array.from({ length: 30 }).map((_, index) => (
              <div key={index} className={index % 5 === 2 ? 'h-10 w-10' : 'skeleton h-10 w-10 rounded-lg'} />
            ))}
          </div>
        </div>
        <div className="skeleton h-72 w-full rounded-2xl" />
      </div>
      <p className="sr-only">Cargando asientos disponibles…</p>
    </div>
  );
}
