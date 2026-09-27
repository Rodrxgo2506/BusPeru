import { ArrowRight, Bus, CalendarDays, ChevronLeft, ChevronRight, Pencil, Search, SlidersHorizontal, Users, WifiOff, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Card } from '@/components/ui';
import { TARJETA_FLOTANTE as FLOTANTE, TravelBackdrop } from '@/components/common/TravelBackdrop';
import { TripSearchForm } from '@/components/common/TripSearchForm';
import { SearchLoading } from '@/components/search/SearchLoading';
import { TripCard } from '@/components/search/TripCard';
import { useAsync } from '@/hooks/useAsync';
import { ItineraryResultsPage } from './ItineraryResultsPage';
import { publicService } from '@/services';
import type { PublicTrip } from '@/types';
import { addDays, formatDayMonthYearEs, isIsoDate } from '@/utils/calendar';
import { formatCurrency, todayIso } from '@/utils/format';
import { passengerCountLabel, passengersFromParam, SORT_OPTIONS, sortTrips, type TripSort } from '@/utils/trip-results';
import { cn } from '@/utils/cn';

const TIME_BANDS = [
  { id: 'morning', label: 'Mañana', range: '(06:00 - 11:59)', from: 6, to: 11 },
  { id: 'afternoon', label: 'Tarde', range: '(12:00 - 17:59)', from: 12, to: 17 },
  { id: 'night', label: 'Noche', range: '(18:00 - 23:59)', from: 18, to: 23 },
  { id: 'dawn', label: 'Madrugada', range: '(00:00 - 05:59)', from: 0, to: 5 },
] as const;

const PRICE_BANDS = [
  { id: 'low', label: 'S/ 30 - S/ 50', min: 30, max: 50 },
  { id: 'mid', label: 'S/ 50 - S/ 70', min: 50, max: 70 },
  { id: 'high', label: 'S/ 70 - S/ 100', min: 70, max: 100 },
] as const;

const PAGE_SIZE = 6;

function departureHour(trip: PublicTrip): number {
  // La franja horaria es la del viaje en Perú, no la del navegador (BP-12).
  return Number(String(trip.departure_datetime).slice(11, 13));
}

/**
 * `/buscar` sirve dos pantallas distintas según `?type=`.
 *
 * Aquí solo se decide cuál, sin más hooks que `useSearchParams` (H-25). Antes la ida vivía en
 * este mismo componente, con sus hooks DESPUÉS del `return` del itinerario: al pasar en la
 * misma ruta de `?type=ROUND_TRIP` a `/buscar` (el «Buscar» de la barra inferior) React
 * ejecutaba más hooks que en el render anterior y rompía la pantalla. Como componentes
 * distintos, cambiar de modo desmonta uno y monta el otro, cada uno con sus hooks fijos.
 */
export function SearchResultsPage() {
  const [searchParams] = useSearchParams();

  // Ida y vuelta y multidestino tienen su propia pantalla; la búsqueda de IDA sigue igual.
  const tripType = searchParams.get('type');
  if (tripType === 'ROUND_TRIP' || tripType === 'MULTI_CITY') return <ItineraryResultsPage />;
  return <OneWayResultsPage />;
}

/**
 * Resultados de la búsqueda de IDA: resumen de la búsqueda, filtros, orden, tarjetas y paginación.
 *
 * Los estados salen del estado REAL de la petición (`useAsync`): cargando mientras la API responde,
 * resultados, sin resultados o error. No hay ninguna espera artificial.
 */
function OneWayResultsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const origin = searchParams.get('origin') ?? '';
  const destination = searchParams.get('destination') ?? '';
  const date = searchParams.get('date') ?? '';
  const companyParam = searchParams.get('company_id') ?? '';
  const passengers = passengersFromParam(searchParams.get('passengers'));

  const results = useAsync(
    () =>
      publicService.searchTrips({
        origin: origin || undefined,
        destination: destination || undefined,
        date: date || undefined,
        company_id: companyParam || undefined,
        limit: 100,
      }),
    [origin, destination, date, companyParam],
  );

  const allTrips = useMemo(() => results.data?.data ?? [], [results.data]);

  const [bands, setBands] = useState<string[]>([]);
  const [priceBands, setPriceBands] = useState<string[]>([]);
  const [companies, setCompanies] = useState<number[]>([]);
  const [services, setServices] = useState<string[]>([]);
  const [companyQuery, setCompanyQuery] = useState('');
  const [showAllCompanies, setShowAllCompanies] = useState(false);
  const [sort, setSort] = useState<TripSort>('recommended');
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const [favourites, setFavourites] = useState<number[]>([]);
  const [editing, setEditing] = useState(false);

  // Al cambiar la búsqueda (otra fecha, otra ruta) se cierra el panel de edición.
  useEffect(() => setEditing(false), [origin, destination, date, companyParam]);

  /** Counts shown next to each filter come from the loaded result set, so they always match. */
  const facets = useMemo(() => {
    const time: Record<string, number> = {};
    for (const band of TIME_BANDS) {
      time[band.id] = allTrips.filter((trip) => {
        const hour = departureHour(trip);
        return hour >= band.from && hour <= band.to;
      }).length;
    }

    const price: Record<string, number> = {};
    for (const band of PRICE_BANDS) {
      price[band.id] = allTrips.filter((trip) => Number(trip.base_price) >= band.min && Number(trip.base_price) < band.max).length;
    }

    const companyMap = new Map<number, { id: number; name: string; count: number }>();
    const serviceMap = new Map<string, number>();
    for (const trip of allTrips) {
      const companyId = Number(trip.company_id);
      const entry = companyMap.get(companyId) ?? { id: companyId, name: String(trip.company_name ?? ''), count: 0 };
      entry.count += 1;
      companyMap.set(companyId, entry);

      const service = trip.bus_type_name ?? 'Sin clasificar';
      serviceMap.set(service, (serviceMap.get(service) ?? 0) + 1);
    }

    return {
      time,
      price,
      companies: [...companyMap.values()].sort((a, b) => b.count - a.count),
      services: [...serviceMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    };
  }, [allTrips]);

  const priceBounds = useMemo(() => {
    if (allTrips.length === 0) return { min: 0, max: 100 };
    const values = allTrips.map((trip) => Number(trip.base_price));
    return { min: Math.floor(Math.min(...values)), max: Math.ceil(Math.max(...values)) };
  }, [allTrips]);

  const [maxPrice, setMaxPrice] = useState<number | null>(null);
  useEffect(() => setMaxPrice(null), [allTrips]);

  const filtered = useMemo(() => {
    const rows = allTrips.filter((trip) => {
      if (bands.length > 0) {
        const hour = departureHour(trip);
        const matches = bands.some((id) => {
          const band = TIME_BANDS.find((entry) => entry.id === id);
          return band ? hour >= band.from && hour <= band.to : false;
        });
        if (!matches) return false;
      }

      const price = Number(trip.base_price);
      if (priceBands.length > 0) {
        const matches = priceBands.some((id) => {
          const band = PRICE_BANDS.find((entry) => entry.id === id);
          return band ? price >= band.min && price < band.max : false;
        });
        if (!matches) return false;
      }
      if (maxPrice !== null && price > maxPrice) return false;
      if (companies.length > 0 && !companies.includes(Number(trip.company_id))) return false;
      if (services.length > 0 && !services.includes(trip.bus_type_name ?? 'Sin clasificar')) return false;
      return true;
    });
    return sortTrips(rows, sort);
  }, [allTrips, bands, priceBands, maxPrice, companies, services, sort]);

  useEffect(() => setPage(1), [bands, priceBands, maxPrice, companies, services, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const clearAll = () => {
    setBands([]);
    setPriceBands([]);
    setCompanies([]);
    setServices([]);
    setMaxPrice(null);
    setCompanyQuery('');
  };

  const toggle = <T,>(list: T[], value: T, setter: (next: T[]) => void) =>
    setter(list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);

  const activeFilterCount = bands.length + priceBands.length + companies.length + services.length + (maxPrice !== null ? 1 : 0);

  const visibleCompanies = facets.companies
    .filter((company) => company.name.toLowerCase().includes(companyQuery.toLowerCase()))
    .slice(0, showAllCompanies ? undefined : 5);

  /** Cambia solo la fecha de la búsqueda (día anterior / siguiente), conservando el resto. */
  const goToDate = (iso: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('date', iso);
    setSearchParams(next);
  };
  const today = todayIso();
  const validDate = isIsoDate(date) ? date : null;

  const filtersPanel = (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-ink">Filtros</h2>
        <button type="button" onClick={clearAll} disabled={activeFilterCount === 0} className="text-sm font-semibold text-brand-600 transition hover:text-brand-700 disabled:text-slate-300">
          Limpiar todo
        </button>
      </div>

      <FilterGroup title="Horario de salida">
        {TIME_BANDS.map((band) => (
          <FilterCheckbox
            key={band.id}
            label={
              <>
                {band.label} <span className="text-muted">{band.range}</span>
              </>
            }
            count={facets.time[band.id] ?? 0}
            checked={bands.includes(band.id)}
            onChange={() => toggle(bands, band.id, setBands)}
          />
        ))}
      </FilterGroup>

      <FilterGroup title="Rango de precio">
        <div className="pb-1">
          <div className="flex items-center justify-between text-sm font-medium text-slate-600">
            <span>{formatCurrency(priceBounds.min)}</span>
            <span className="font-semibold text-brand-600">{formatCurrency(maxPrice ?? priceBounds.max)}</span>
          </div>
          <input
            type="range"
            min={priceBounds.min}
            max={priceBounds.max}
            step={1}
            value={maxPrice ?? priceBounds.max}
            onChange={(event) => setMaxPrice(Number(event.target.value))}
            aria-label="Precio máximo"
            className="mt-2 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-200 accent-brand-500"
          />
        </div>
        <div className="space-y-2 pt-1">
          {PRICE_BANDS.map((band) => {
            const isActive = priceBands.includes(band.id);
            return (
              <button
                key={band.id}
                type="button"
                onClick={() => toggle(priceBands, band.id, setPriceBands)}
                aria-pressed={isActive}
                className={cn(
                  'flex w-full items-center justify-between rounded-control border px-3 py-2 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                  isActive ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-border text-slate-600 hover:border-brand-200',
                )}
              >
                <span className="font-medium">{band.label}</span>
                <span className={cn('text-xs font-semibold', isActive ? 'text-brand-600' : 'text-slate-400')}>{facets.price[band.id] ?? 0}</span>
              </button>
            );
          })}
        </div>
      </FilterGroup>

      <FilterGroup title="Empresas">
        <div className="relative pb-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={companyQuery}
            onChange={(event) => setCompanyQuery(event.target.value)}
            placeholder="Buscar empresa..."
            aria-label="Buscar empresa"
            className="h-10 w-full rounded-control border border-border pl-9 pr-3 text-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
        </div>
        {visibleCompanies.length === 0 ? (
          <p className="py-1 text-sm text-muted">Sin coincidencias</p>
        ) : (
          visibleCompanies.map((company) => (
            <FilterCheckbox
              key={company.id}
              label={company.name}
              count={company.count}
              checked={companies.includes(company.id)}
              onChange={() => toggle(companies, company.id, setCompanies)}
            />
          ))
        )}
        {facets.companies.length > 5 && (
          <button type="button" onClick={() => setShowAllCompanies((value) => !value)} className="pt-1 text-sm font-semibold text-brand-600 hover:text-brand-700">
            {showAllCompanies ? 'Ver menos' : 'Ver más'}
          </button>
        )}
      </FilterGroup>

      <FilterGroup title="Tipo de servicio" last>
        {facets.services.map((service) => (
          <FilterCheckbox
            key={service.name}
            label={service.name}
            count={service.count}
            checked={services.includes(service.name)}
            onChange={() => toggle(services, service.name, setServices)}
          />
        ))}
      </FilterGroup>

      <Button variant="outline" fullWidth onClick={() => setShowFilters(false)} className="lg:hidden">
        Ver {filtered.length} {filtered.length === 1 ? 'viaje' : 'viajes'}
      </Button>
    </div>
  );

  const loading = results.loading;
  // Sin ningún viaje para la búsqueda, los filtros no aportan nada: el estado vacío ocupa todo el ancho.
  const sinViajes = !loading && (Boolean(results.error) || allTrips.length === 0);

  return (
    <>
      {/* `isolate` crea el contexto de apilamiento que necesita la capa `-z-10` del paisaje;
          sin el, se escaparia al contexto raiz y la taparia el blanco del armazon publico.
          El cajon de filtros de movil se queda FUERA de este contexto a proposito: dentro,
          su `z-50` quedaria por debajo de la cabecera fija, que es `z-40` en el raiz. */}
      <div className="relative isolate mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <TravelBackdrop />

        {/* ---------------------------------------------------------- resumen de la búsqueda */}
        <section className={`mb-6 rounded-2xl border p-4 sm:p-5 ${FLOTANTE}`} aria-labelledby="resumen-busqueda">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-4">
              <span className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-500 text-white shadow-sm sm:flex" aria-hidden>
                <Bus className="h-6 w-6" />
              </span>
              <div className="min-w-0">
                <h1 id="resumen-busqueda" className="flex flex-wrap items-center gap-x-2 text-xl font-extrabold tracking-tight text-ink sm:text-2xl">
                  <span>{origin || 'Todos los orígenes'}</span>
                  <ArrowRight className="h-5 w-5 text-brand-500" aria-label="a" />
                  <span>{destination || 'Todos los destinos'}</span>
                </h1>
                <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarDays className="h-4 w-4 text-brand-500" aria-hidden />
                    {validDate ? formatDayMonthYearEs(validDate) : 'Todas las fechas'}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Users className="h-4 w-4 text-brand-500" aria-hidden />
                    {passengerCountLabel(passengers)}
                  </span>
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {validDate && (
                <div className="flex items-center rounded-control ring-1 ring-border" role="group" aria-label="Cambiar de día">
                  <button
                    type="button"
                    onClick={() => goToDate(addDays(validDate, -1))}
                    disabled={validDate <= today}
                    aria-label="Día anterior"
                    className="flex h-10 items-center gap-1 rounded-l-control px-3 text-sm font-semibold text-slate-600 transition hover:bg-brand-50 hover:text-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ChevronLeft className="h-4 w-4" aria-hidden />
                    <span className="hidden sm:inline">Anterior</span>
                  </button>
                  <span className="h-6 w-px bg-border" aria-hidden />
                  <button
                    type="button"
                    onClick={() => goToDate(addDays(validDate, 1))}
                    aria-label="Día siguiente"
                    className="flex h-10 items-center gap-1 rounded-r-control px-3 text-sm font-semibold text-slate-600 transition hover:bg-brand-50 hover:text-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <span className="hidden sm:inline">Siguiente</span>
                    <ChevronRight className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              )}
              <Button
                variant={editing ? 'secondary' : 'primary'}
                size="sm"
                className="h-10"
                icon={editing ? <X className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                onClick={() => setEditing((value) => !value)}
                aria-expanded={editing}
                aria-controls="modificar-busqueda"
              >
                {editing ? 'Cerrar' : 'Cambiar búsqueda'}
              </Button>
            </div>
          </div>

          {editing && (
            <div id="modificar-busqueda" className="mt-4 animate-slide-up border-t border-border pt-4">
              <ModifySearch origin={origin} destination={destination} date={validDate ?? today} />
            </div>
          )}
        </section>

        <div className={cn('grid gap-6', !sinViajes && 'lg:grid-cols-[276px_1fr]')}>
          <aside className={cn('hidden', !sinViajes && 'lg:block')} aria-label="Filtros">
            <Card className={`sticky top-24 p-5 ${FLOTANTE}`}>
              {loading ? <FiltersSkeleton /> : filtersPanel}
            </Card>
          </aside>

          <div className="min-w-0">
            {/* ---------------------------------------------------- recuento y orden */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-[15px] font-semibold text-ink" aria-live="polite">
                {loading ? (
                  <span className="text-muted">Buscando viajes…</span>
                ) : sinViajes ? null : (
                  <>
                    <span className="text-brand-600">{filtered.length}</span> {filtered.length === 1 ? 'viaje encontrado' : 'viajes encontrados'}
                    {activeFilterCount > 0 && <span className="ml-1 font-normal text-muted">de {allTrips.length}</span>}
                  </>
                )}
              </p>
              <Button
                variant="outline"
                size="sm"
                className={cn('h-10 lg:hidden', sinViajes && 'hidden')}
                icon={<SlidersHorizontal className="h-4 w-4" />}
                onClick={() => setShowFilters(true)}
                disabled={loading || allTrips.length === 0}
              >
                Filtros {activeFilterCount > 0 && `(${activeFilterCount})`}
              </Button>
            </div>

            {!loading && !results.error && allTrips.length > 0 && (
              <div className="scrollbar-none -mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1" role="radiogroup" aria-label="Ordenar resultados por">
                {SORT_OPTIONS.map((option) => {
                  const active = sort === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setSort(option.id)}
                      className={cn(
                        'shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1',
                        active ? 'bg-ink text-white shadow-sm' : 'bg-white/85 text-slate-600 ring-1 ring-border hover:bg-white hover:text-ink hover:ring-brand-200',
                      )}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            )}

            {results.error ? (
              <SearchError onRetry={results.reload} />
            ) : loading ? (
              <SearchLoading origin={origin} destination={destination} />
            ) : filtered.length === 0 ? (
              allTrips.length === 0 ? (
                <NoTrips
                  onChangeDate={() => setEditing(true)}
                  nextDay={validDate ? () => goToDate(addDays(validDate, 1)) : undefined}
                />
              ) : (
                <div className={`rounded-2xl border px-6 py-12 text-center ${FLOTANTE}`}>
                  <p className="text-base font-bold text-ink">Ningún viaje coincide con los filtros</p>
                  <p className="mx-auto mt-1 max-w-sm text-sm text-muted">Ajusta o limpia los filtros para ver más resultados.</p>
                  <Button variant="outline" className="mt-4" onClick={clearAll}>
                    Limpiar filtros
                  </Button>
                </div>
              )
            ) : (
              <>
                <div className="space-y-4">
                  {visible.map((trip, index) => (
                    <TripCard
                      key={trip.id}
                      trip={trip}
                      favourite={favourites.includes(trip.id)}
                      onToggleFavourite={() => toggle(favourites, trip.id, setFavourites)}
                      className="animate-rise-in"
                      style={{ animationDelay: `${Math.min(index, 6) * 45}ms` }}
                    />
                  ))}
                </div>

                {totalPages > 1 && (
                  <nav className={`mt-6 flex flex-wrap items-center justify-between gap-2 rounded-card border p-3 ${FLOTANTE}`} aria-label="Paginación de resultados">
                    <button
                      type="button"
                      onClick={() => setPage((value) => Math.max(1, value - 1))}
                      disabled={page === 1}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-control px-2 py-2 text-sm font-medium text-slate-500 transition hover:bg-slate-50 disabled:opacity-40 sm:px-3"
                    >
                      <ChevronLeft className="h-4 w-4" /> Anterior
                    </button>
                    <div className="scrollbar-none flex min-w-0 flex-1 items-center justify-center gap-1 overflow-x-auto">
                      {Array.from({ length: totalPages }).map((_, index) => (
                        <button
                          key={index}
                          type="button"
                          onClick={() => setPage(index + 1)}
                          aria-current={page === index + 1 ? 'page' : undefined}
                          className={cn(
                            'h-9 min-w-9 shrink-0 rounded-control px-2 text-sm font-semibold transition',
                            page === index + 1 ? 'bg-brand-500 text-white' : 'text-slate-600 hover:bg-slate-50',
                          )}
                        >
                          {index + 1}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                      disabled={page === totalPages}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-control px-2 py-2 text-sm font-semibold text-brand-600 transition hover:bg-brand-50 disabled:opacity-40 sm:px-3"
                    >
                      Siguiente <ChevronRight className="h-4 w-4" />
                    </button>
                  </nav>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {showFilters && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Filtros">
          <button type="button" className="absolute inset-0 animate-fade-in bg-ink/40" onClick={() => setShowFilters(false)} aria-label="Cerrar filtros" />
          <div className="absolute inset-x-0 bottom-0 max-h-[88vh] animate-slide-up overflow-y-auto rounded-t-2xl bg-white p-5 shadow-elevated">
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-200" aria-hidden />
            <div className="mb-1 flex justify-end">
              <button type="button" onClick={() => setShowFilters(false)} className="rounded-lg p-2 text-slate-500" aria-label="Cerrar">
                <X className="h-5 w-5" />
              </button>
            </div>
            {filtersPanel}
          </div>
        </div>
      )}
    </>
  );
}

/** Formulario de búsqueda precargado, dentro de la propia página de resultados. */
function ModifySearch({ origin, destination, date }: { origin: string; destination: string; date: string }) {
  const cities = useAsync(() => publicService.cities(), []);
  const names = useMemo(() => (cities.data ?? []).map((city) => city.city), [cities.data]);
  return <TripSearchForm cities={names} initialOrigin={origin} initialDestination={destination} initialDate={date} />;
}

/** Sin viajes para la búsqueda: invita a cambiar de fecha o de ruta. */
function NoTrips({ onChangeDate, nextDay }: { onChangeDate: () => void; nextDay?: () => void }) {
  return (
    <div className={`animate-rise-in rounded-2xl border px-6 py-12 text-center ${FLOTANTE}`}>
      <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50 text-brand-500 ring-8 ring-brand-50/50" aria-hidden>
        <Bus className="h-8 w-8" />
      </span>
      <p className="mt-5 text-lg font-bold text-ink">No encontramos viajes para esta fecha</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted">Prueba con otra fecha o ruta: las empresas publican nuevos viajes constantemente.</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button icon={<CalendarDays className="h-4 w-4" />} onClick={onChangeDate}>
          Cambiar fecha
        </Button>
        {nextDay && (
          <Button variant="outline" iconRight={<ChevronRight className="h-4 w-4" />} onClick={nextDay}>
            Ver el día siguiente
          </Button>
        )}
      </div>
    </div>
  );
}

/** Error al buscar: mensaje para el pasajero, nunca detalles técnicos. */
function SearchError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={`rounded-2xl border px-6 py-12 text-center ${FLOTANTE}`} role="alert">
      <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-danger-50 text-danger-600" aria-hidden>
        <WifiOff className="h-8 w-8" />
      </span>
      <p className="mt-5 text-lg font-bold text-ink">No pudimos cargar los viajes.</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted">Revisa tu conexión e inténtalo de nuevo en unos segundos.</p>
      <Button variant="outline" className="mt-5" onClick={onRetry}>
        Reintentar
      </Button>
    </div>
  );
}

function FiltersSkeleton() {
  return (
    <div className="space-y-5" aria-hidden>
      <div className="skeleton h-5 w-20" />
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="space-y-2.5">
          <div className="skeleton h-4 w-32" />
          <div className="skeleton h-3.5 w-full" />
          <div className="skeleton h-3.5 w-5/6" />
          <div className="skeleton h-3.5 w-2/3" />
        </div>
      ))}
    </div>
  );
}

function FilterGroup({ title, children, last = false }: { title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={cn(!last && 'border-b border-border pb-5')}>
      <h3 className="mb-3 text-sm font-semibold text-ink">{title}</h3>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function FilterCheckbox({
  label,
  count,
  checked,
  onChange,
}: {
  label: React.ReactNode;
  count: number;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg text-sm transition hover:text-ink">
      <span className="flex min-w-0 items-center gap-2.5">
        <input type="checkbox" checked={checked} onChange={onChange} className="h-4 w-4 shrink-0 rounded border-slate-300 text-brand-500 focus:ring-brand-500" />
        <span className="truncate text-slate-700">{label}</span>
      </span>
      <span className={cn('shrink-0 text-xs font-semibold', count === 0 ? 'text-slate-300' : 'text-slate-400')}>{count}</span>
    </label>
  );
}
