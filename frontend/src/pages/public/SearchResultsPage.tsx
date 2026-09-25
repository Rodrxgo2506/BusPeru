import { Armchair, BadgeCheck, BedDouble, Bus, ChevronLeft, ChevronRight, Heart, Pencil, Search, Snowflake, SlidersHorizontal, Star, Tv, Usb, Wifi, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Card, EmptyState, ErrorState } from '@/components/ui';
import { CompanyIdentity } from '@/components/companies/CompanyCard';
import { TARJETA_FLOTANTE as FLOTANTE, TravelBackdrop } from '@/components/common/TravelBackdrop';
import { useAsync } from '@/hooks/useAsync';
import { ItineraryResultsPage } from './ItineraryResultsPage';
import { publicService } from '@/services';
import type { PublicTrip } from '@/types';
import { durationBetween, formatCurrency, formatDate, formatTime, parseJsonArray } from '@/utils/format';
import { cn } from '@/utils/cn';

const AMENITY_ICONS: Record<string, typeof Wifi> = {
  WiFi: Wifi,
  'Aire acondicionado': Snowflake,
  USB: Usb,
  TV: Tv,
  Baño: Armchair,
};

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

/** Resultados de la búsqueda de IDA: filtros, orden y paginación sobre los viajes encontrados. */
function OneWayResultsPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const origin = searchParams.get('origin') ?? '';
  const destination = searchParams.get('destination') ?? '';
  const date = searchParams.get('date') ?? '';
  const companyParam = searchParams.get('company_id') ?? '';

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
  const [sort, setSort] = useState<'recommended' | 'price' | 'departure' | 'rating'>('recommended');
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const [favourites, setFavourites] = useState<number[]>([]);

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
    let rows = allTrips.filter((trip) => {
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

    rows = [...rows];
    if (sort === 'price') rows.sort((a, b) => Number(a.base_price) - Number(b.base_price));
    else if (sort === 'departure') rows.sort((a, b) => a.departure_datetime.localeCompare(b.departure_datetime));
    else if (sort === 'rating') rows.sort((a, b) => Number(b.company_rating ?? 0) - Number(a.company_rating ?? 0));
    return rows;
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

  const filtersPanel = (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-ink">Filtros</h2>
        <button type="button" onClick={clearAll} className="text-sm font-semibold text-brand-600 hover:text-brand-700">
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
            <span>{formatCurrency(maxPrice ?? priceBounds.max)}</span>
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
                className={cn(
                  'flex w-full items-center justify-between rounded-control border px-3 py-2 text-sm transition',
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

      <Button variant="outline" fullWidth onClick={() => setShowFilters(false)}>
        Aplicar filtros
      </Button>
    </div>
  );

  return (
    <>
      {/* `isolate` crea el contexto de apilamiento que necesita la capa `-z-10` del paisaje;
          sin el, se escaparia al contexto raiz y la taparia el blanco del armazon publico.
          El cajon de filtros de movil se queda FUERA de este contexto a proposito: dentro,
          su `z-50` quedaria por debajo de la cabecera fija, que es `z-40` en el raiz. */}
      <div className="relative isolate mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <TravelBackdrop />
      {/* Cabecera de búsqueda */}
      <div className="relative mb-6 overflow-hidden rounded-card bg-gradient-to-r from-brand-500 via-brand-500 to-brand-600 shadow-panel">
        {/* Cordillera al fondo del banner: la misma silueta del paisaje de la página, para
            que la franja naranja no sea un rectángulo plano. Solo decoración. */}
        <svg
          viewBox="0 0 600 120"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-y-0 right-0 hidden h-full w-1/2 text-white/15 sm:block"
          fill="currentColor"
          aria-hidden
        >
          <path d="M0 120V78l78-32 66 26 84-44 80 48 72-30 98 42 92-36 30 12v56Z" />
          <path d="M0 120V98l104-22 84 24 92-18 78 26 114-22 90 20 38-10v24Z" className="text-white/10" fill="currentColor" />
        </svg>

        <div className="relative flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6">
          <div className="flex min-w-0 items-center gap-4">
            <span
              className="hidden h-14 w-14 shrink-0 items-center justify-center rounded-full bg-white/20 text-white ring-1 ring-white/30 sm:flex"
              aria-hidden
            >
              <Bus className="h-7 w-7" />
            </span>
            <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-white sm:text-[32px] sm:leading-tight">
              {origin || 'Todos los orígenes'} <span className="opacity-70">→</span> {destination || 'Todos los destinos'}
            </h1>
            <p className="mt-1 text-sm text-white/85">
              {date ? `Ida: ${formatDate(date)}` : 'Todas las fechas'} <span className="mx-1.5 opacity-60">•</span> 1 pasajero
            </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="inline-flex shrink-0 items-center gap-2 rounded-control bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-brand-50 hover:text-brand-700"
          >
            Modificar búsqueda
            <Pencil className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[276px_1fr]">
        <aside className="hidden lg:block">
          <Card className={`p-5 ${FLOTANTE}`}>{filtersPanel}</Card>
        </aside>

        <div className="lg:hidden">
          <div className="grid grid-cols-2 gap-3">
            <Button variant="outline" icon={<SlidersHorizontal className="h-4 w-4" />} onClick={() => setShowFilters(true)}>
              Filtros {activeFilterCount > 0 && `(${activeFilterCount})`}
            </Button>
            <label className="relative">
              <span className="sr-only">Ordenar por</span>
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as typeof sort)}
                className="h-11 w-full cursor-pointer rounded-control border border-white/70 bg-white/85 px-3 text-sm font-semibold text-slate-700 shadow-card backdrop-blur-md focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              >
                <option value="recommended">Recomendados</option>
                <option value="price">Menor precio</option>
                <option value="departure">Hora de salida</option>
                <option value="rating">Mejor calificados</option>
              </select>
            </label>
          </div>
        </div>


        <div className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[15px] font-semibold text-ink">
              {results.loading ? 'Buscando viajes...' : `${filtered.length} ${filtered.length === 1 ? 'viaje encontrado' : 'viajes encontrados'}`}
            </p>
            <label className="hidden items-center gap-2 text-sm lg:flex">
              <span className="text-muted">Ordenar por:</span>
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as typeof sort)}
                className="h-10 cursor-pointer rounded-control border border-white/70 bg-white/85 px-3 text-sm font-semibold text-slate-700 shadow-card backdrop-blur-md transition hover:border-brand-200 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              >
                <option value="recommended">Recomendados</option>
                <option value="price">Menor precio</option>
                <option value="departure">Hora de salida</option>
                <option value="rating">Mejor calificados</option>
              </select>
            </label>
          </div>

          {results.error ? (
            <Card padded={false} className={FLOTANTE}>
              <ErrorState error={results.error} onRetry={results.reload} />
            </Card>
          ) : results.loading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, index) => (
                <div key={index} className={`card p-5 ${FLOTANTE}`}>
                  {/* Reserva el hueco del logotipo para que al llegar los datos la tarjeta no salte. */}
                  <div className="skeleton h-14 w-20 rounded-control" />
                  <div className="mt-3 space-y-3">
                    <div className="skeleton h-5 w-1/3" />
                    <div className="skeleton h-4 w-2/3" />
                    <div className="skeleton h-10 w-full" />
                  </div>
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <Card padded={false} className={FLOTANTE}>
              <EmptyState
                title={allTrips.length === 0 ? 'No hay viajes programados para esta búsqueda' : 'Ningún viaje coincide con los filtros'}
                description={
                  allTrips.length === 0
                    ? 'Prueba con otra fecha o destino: las empresas publican nuevos viajes constantemente.'
                    : 'Ajusta o limpia los filtros para ver más resultados.'
                }
                icon={<BedDouble className="h-7 w-7" />}
                action={
                  allTrips.length === 0 ? (
                    <Button variant="outline" to="/">
                      Modificar búsqueda
                    </Button>
                  ) : (
                    <Button variant="outline" onClick={clearAll}>
                      Limpiar filtros
                    </Button>
                  )
                }
              />
            </Card>
          ) : (
            <>
              <div className="space-y-4">
                {visible.map((trip) => (
                  <TripResultCard
                    key={trip.id}
                    trip={trip}
                    favourite={favourites.includes(trip.id)}
                    onToggleFavourite={() => toggle(favourites, trip.id, setFavourites)}
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
          <div className="fixed inset-0 z-50 lg:hidden">
            <button type="button" className="absolute inset-0 bg-ink/40" onClick={() => setShowFilters(false)} aria-label="Cerrar filtros" />
            <div className="absolute inset-x-0 bottom-0 max-h-[88vh] animate-slide-up overflow-y-auto rounded-t-card bg-white p-5 shadow-elevated">
              <div className="mb-3 flex justify-end">
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
    <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
      <span className="flex min-w-0 items-center gap-2.5">
        <input type="checkbox" checked={checked} onChange={onChange} className="h-4 w-4 shrink-0 rounded border-slate-300 text-brand-500 focus:ring-brand-500" />
        <span className="truncate text-slate-700">{label}</span>
      </span>
      <span className="shrink-0 text-xs font-semibold text-slate-400">{count}</span>
    </label>
  );
}

function TripResultCard({ trip, favourite, onToggleFavourite }: { trip: PublicTrip; favourite: boolean; onToggleFavourite: () => void }) {
  const amenities = parseJsonArray(trip.amenities);
  const available = Number(trip.seats_available ?? 0);

  return (
    <Card className={`relative p-5 transition hover:shadow-elevated sm:p-6 ${FLOTANTE}`}>
      <button
        type="button"
        onClick={onToggleFavourite}
        aria-label={favourite ? 'Quitar de favoritos' : 'Guardar en favoritos'}
        aria-pressed={favourite}
        className="absolute right-4 top-4 rounded-full p-1.5 text-slate-300 transition hover:bg-slate-50 hover:text-brand-500"
      >
        <Heart className={cn('h-5 w-5', favourite && 'fill-brand-500 text-brand-500')} />
      </button>

      <div className="grid gap-5 lg:grid-cols-[164px_1fr_204px] lg:gap-6">
        <div>
          {/* F17C-UI-09 · `company_logo` ya viajaba en cada resultado y no se usaba. Mismo componente
              y mismo respaldo de iniciales que el catálogo de `/empresas`. */}
          <CompanyIdentity name={trip.company_name ?? 'Empresa'} logoUrl={trip.company_logo} size="sm" />
          <p className="mt-2.5 pr-8 text-base font-extrabold uppercase leading-tight tracking-tight text-ink">{trip.company_name}</p>
          {trip.company_rating !== null ? (
            <p className="mt-2 flex items-center gap-1 text-sm">
              <Star className="h-4 w-4 fill-warning-500 text-warning-500" />
              <span className="font-semibold text-ink">{trip.company_rating}</span>
            </p>
          ) : null}
          {trip.company_reviews > 0 && <p className="text-xs text-muted">{trip.company_reviews} opiniones</p>}
          <span className="mt-2.5 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-success-50 px-2.5 py-1 text-xs font-medium text-success-700">
            <BadgeCheck className="h-3.5 w-3.5 shrink-0" />
            Empresa verificada
          </span>
        </div>

        <div className="lg:border-l lg:border-border lg:pl-5">
          <div className="flex flex-wrap items-start gap-4">
            <div>
              <p className="text-2xl font-bold text-ink">{formatTime(trip.departure_datetime)}</p>
              <p className="text-sm text-muted">{trip.origin_terminal}</p>
              <p className="text-sm font-medium text-slate-600">{trip.origin_city}</p>
            </div>
            <div className="flex min-w-[100px] flex-1 flex-col items-center pt-2">
              <span className="text-xs text-muted">{durationBetween(trip.departure_datetime, trip.arrival_datetime)}</span>
              <span className="relative my-1.5 h-px w-full bg-border">
                <span className="absolute -left-0.5 -top-[3px] h-[7px] w-[7px] rounded-full bg-slate-300" />
                <span className="absolute -right-0.5 -top-[3px] h-[7px] w-[7px] rounded-full bg-slate-300" />
              </span>
              <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-slate-500">Directo</span>
            </div>
            <div>
              <p className="text-2xl font-bold text-ink">{formatTime(trip.arrival_datetime)}</p>
              <p className="text-sm text-muted">{trip.destination_terminal}</p>
              <p className="text-sm font-medium text-slate-600">{trip.destination_city}</p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-3 text-sm text-slate-600">
            <span className="flex items-center gap-1.5">
              <BedDouble className="h-4 w-4 text-slate-400" />
              {trip.bus_type_name ?? 'Bus'}
            </span>
            {amenities.slice(0, 4).map((amenity) => {
              const Icon = AMENITY_ICONS[amenity] ?? Snowflake;
              return (
                <span key={amenity} className="flex items-center gap-1.5">
                  <Icon className="h-4 w-4 text-slate-400" />
                  {amenity}
                </span>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col justify-center gap-2 border-t border-border pt-4 text-center lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
          <p className="text-xs text-muted">Desde</p>
          <p className="text-2xl font-extrabold text-brand-600">{formatCurrency(trip.base_price)}</p>
          <p className={cn('text-sm font-medium', available > 5 ? 'text-success-600' : available > 0 ? 'text-warning-600' : 'text-danger-600')}>
            {available > 0 ? `${available} asientos disponibles` : 'Sin asientos disponibles'}
          </p>
          <Link to={`/viaje/${trip.id}/asientos`} className={cn('mt-1', available === 0 && 'pointer-events-none opacity-50')}>
            <Button fullWidth disabled={available === 0} iconRight={<ChevronRight className="h-4 w-4" />}>
              Ver asientos
            </Button>
          </Link>
        </div>
      </div>
    </Card>
  );
}

