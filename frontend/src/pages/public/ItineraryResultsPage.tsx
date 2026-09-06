import { ArrowRight, ArrowRightLeft, Check, Clock3, Pencil, Route as RouteIcon } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { decodeSegments } from '@/components/common/TripSearchForm';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { publicService } from '@/services';
import { formatCurrency, formatDate, formatTime } from '@/utils/format';
import { cn } from '@/utils/cn';
import { useCheckout, type TripType } from './checkout/CheckoutContext';

/**
 * Resultados de un itinerario de varios tramos (ida y vuelta / multidestino).
 *
 * La búsqueda de IDA sigue en `SearchResultsPage` sin cambios; esta pantalla solo se
 * monta cuando la URL trae `type=ROUND_TRIP` o `type=MULTI_CITY`.
 *
 * El usuario elige un viaje por tramo y la selección vive en el contexto del checkout,
 * de modo que sobrevive a recargas y a moverse entre pasos.
 */
export function ItineraryResultsPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const checkout = useCheckout();

  const tripType = (searchParams.get('type') ?? 'ROUND_TRIP') as TripType;
  const drafts = useMemo(() => decodeSegments(searchParams.get('segments')), [searchParams]);

  const results = useAsync(
    () =>
      drafts.length >= 2
        ? publicService.searchItinerary({ trip_type: tripType, segments: drafts })
        : Promise.resolve([]),
    [searchParams.get('segments'), tripType],
  );

  // Al llegar con una búsqueda nueva se reinicia el itinerario del contexto.
  const firmaBusqueda = `${tripType}|${searchParams.get('segments') ?? ''}`;
  useEffect(() => {
    const actual = checkout.segments.map((s) => `${s.origin}>${s.destination}@${s.date}`).join('|');
    if (drafts.length >= 2 && (checkout.tripType !== tripType || actual !== (searchParams.get('segments') ?? ''))) {
      checkout.startItinerary(tripType, drafts);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firmaBusqueda]);

  const seleccionados = checkout.segments.filter((segment) => segment.tripId !== null).length;
  const completo = checkout.segments.length >= 2 && seleccionados === checkout.segments.length;

  const totalEstimado = useMemo(() => {
    if (!results.data) return 0;
    return checkout.segments.reduce((sum, segment) => {
      const bloque = results.data!.find((block) => block.segment_order === segment.order);
      const viaje = bloque?.trips.find((trip) => Number((trip as { id: number }).id) === segment.tripId);
      return sum + Number((viaje as { base_price?: number } | undefined)?.base_price ?? 0);
    }, 0);
  }, [results.data, checkout.segments]);

  if (drafts.length < 2) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Card padded={false}>
          <EmptyState
            title="Búsqueda incompleta"
            description="Vuelve al buscador y define los tramos de tu viaje."
            action={<Button onClick={() => navigate('/')}>Volver al buscador</Button>}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6 overflow-hidden rounded-card bg-gradient-to-r from-brand-500 to-brand-600">
        <div className="flex flex-wrap items-center justify-between gap-4 p-6">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 text-white/85">
              {tripType === 'ROUND_TRIP' ? <ArrowRightLeft className="h-4 w-4" /> : <RouteIcon className="h-4 w-4" />}
              <span className="text-sm font-semibold uppercase tracking-wide">
                {tripType === 'ROUND_TRIP' ? 'Ida y vuelta' : 'Multidestino'}
              </span>
            </div>
            <h1 className="text-2xl font-bold text-white sm:text-3xl">
              {drafts[0]!.origin} <span className="opacity-70">→</span> {drafts[drafts.length - 1]!.destination}
            </h1>
            <p className="mt-1 text-sm text-white/85">
              {drafts.length} tramos <span className="mx-1.5 opacity-60">•</span> {formatDate(drafts[0]!.date)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="inline-flex items-center gap-2 rounded-control bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
          >
            Modificar búsqueda
            <Pencil className="h-4 w-4" />
          </button>
        </div>
      </div>

      {results.error ? (
        <Card padded={false}>
          <ErrorState error={results.error} onRetry={results.reload} />
        </Card>
      ) : results.loading ? (
        <LoadingState />
      ) : (
        <div className="space-y-6">
          {(results.data ?? []).map((bloque) => {
            const segmento = checkout.segments.find((s) => s.order === bloque.segment_order);
            return (
              <section key={bloque.segment_order}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-lg font-bold text-ink">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-500 text-sm text-white">
                      {bloque.segment_order}
                    </span>
                    {tripType === 'ROUND_TRIP'
                      ? bloque.segment_order === 1
                        ? 'Viaje de ida'
                        : 'Viaje de vuelta'
                      : `Tramo ${bloque.segment_order}`}
                    <span className="text-sm font-medium text-muted">
                      {bloque.origin} → {bloque.destination} · {formatDate(bloque.date)}
                    </span>
                  </h2>
                  {segmento?.tripId && <Badge tone="success">Seleccionado</Badge>}
                </div>

                {bloque.trips.length === 0 ? (
                  <Card padded={false}>
                    <EmptyState
                      title="Sin viajes para este tramo"
                      description="Prueba con otra fecha o con otra ciudad."
                      icon={<Clock3 className="h-7 w-7" />}
                    />
                  </Card>
                ) : (
                  <div className="space-y-3">
                    {bloque.trips.map((raw) => {
                      const trip = raw as Record<string, unknown>;
                      const id = Number(trip.id);
                      const elegido = segmento?.tripId === id;
                      const disponibles = Number(trip.available_seats ?? 0);

                      return (
                        <Card
                          key={id}
                          className={cn('transition', elegido && 'border-brand-500 ring-1 ring-brand-500/30')}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-4">
                            <div className="min-w-0">
                              <p className="font-semibold text-ink">{String(trip.company_name ?? '')}</p>
                              <p className="mt-1 flex items-center gap-2 text-sm text-muted">
                                <span className="font-medium text-ink">{formatTime(String(trip.departure_datetime))}</span>
                                <ArrowRight className="h-3.5 w-3.5" />
                                <span>{String(trip.destination_city ?? '')}</span>
                                <span className="text-slate-300">|</span>
                                <span>{String(trip.bus_type_name ?? 'Bus')}</span>
                              </p>
                            </div>

                            <div className="flex items-center gap-4">
                              <div className="text-right">
                                <p className="text-xl font-extrabold text-brand-600">{formatCurrency(Number(trip.base_price))}</p>
                                <p className={cn('text-xs', disponibles > 0 ? 'text-success-600' : 'text-danger-600')}>
                                  {disponibles > 0 ? `${disponibles} asientos` : 'Sin asientos'}
                                </p>
                              </div>
                              <Button
                                variant={elegido ? 'primary' : 'outline'}
                                disabled={disponibles === 0}
                                icon={elegido ? <Check className="h-4 w-4" /> : undefined}
                                onClick={() => checkout.selectSegmentTrip(bloque.segment_order, id)}
                              >
                                {elegido ? 'Elegido' : 'Elegir'}
                              </Button>
                            </div>
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}

          <Card className="sticky bottom-4 border-brand-200 shadow-elevated">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm text-muted">
                  {seleccionados} de {checkout.segments.length} tramos elegidos
                </p>
                {totalEstimado > 0 && (
                  <p className="text-xl font-extrabold text-brand-600">
                    {formatCurrency(totalEstimado)} <span className="text-xs font-medium text-muted">por pasajero</span>
                  </p>
                )}
              </div>
              <Button
                size="lg"
                disabled={!completo}
                onClick={() => {
                  const primero = checkout.segments[0];
                  if (primero?.tripId) navigate(`/viaje/${primero.tripId}/asientos?segment=1`);
                }}
              >
                {completo ? 'Continuar con los asientos' : 'Elige un viaje por tramo'}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
