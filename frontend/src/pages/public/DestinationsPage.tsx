import { MapPin, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { TripSearchForm } from '@/components/common/TripSearchForm';
import {
  DestinationCatalogCard,
  DestinationCatalogSkeleton,
  DestinationTile,
  DestinationTileSkeleton,
} from '@/components/destinations/DestinationsSections';
import { Card, EmptyState, ErrorState, Input, Select } from '@/components/ui';
import { destinationsHeroImage } from '@/constants/images';
import { useAsync } from '@/hooks/useAsync';
import { publicService } from '@/services';
import type { PublicDestinationCard } from '@/types';
import { todayIso } from '@/utils/format';
import { cn } from '@/utils/cn';
import { normalizeForSearch } from '@/utils/text';

/**
 * Catálogo público de destinos (F17C-UI-06).
 *
 * Reúne las dos caras de «destinos» que tiene la plataforma:
 *
 *   · Arriba, las fichas editoriales que el ADMIN publica desde el CMS. Son las que llevan a
 *     `/destinos/:slug` y las mismas que alimentan «Descubre más destinos» de la portada.
 *   · Abajo, las ciudades con viajes realmente programados, que ya vivían en esta ruta y llevan
 *     al buscador. Se conservan para no perder ese atajo.
 *
 * Filtrar y ordenar se hace en memoria: la API devuelve la lista completa de fichas publicadas,
 * sin paginación, así que no hace falta ir al servidor en cada tecla.
 */

type Order = 'editorial' | 'name';

const ORDER_OPTIONS = [
  { value: 'editorial', label: 'Orden recomendado' },
  { value: 'name', label: 'Nombre (A-Z)' },
];

export function DestinationsPage() {
  const destinations = useAsync(() => publicService.featuredDestinations(), []);
  const cities = useAsync(() => publicService.cities(), []);

  const [search, setSearch] = useState('');
  const [order, setOrder] = useState<Order>('editorial');

  const cityNames = useMemo(() => (cities.data ?? []).map((city) => city.city), [cities.data]);
  const all = useMemo(() => destinations.data ?? [], [destinations.data]);

  /** Nombre o slug, sin distinguir tildes ni mayúsculas: «caja» encuentra «Cajamarca». */
  const list = useMemo(() => {
    const needle = normalizeForSearch(search);
    const matches = needle
      ? all.filter((item) => normalizeForSearch(item.name).includes(needle) || normalizeForSearch(item.slug).includes(needle))
      : [...all];
    return order === 'name' ? matches.sort((a, b) => a.name.localeCompare(b.name, 'es')) : matches;
  }, [all, search, order]);

  return (
    <>
      <CatalogHero cities={cityNames} />

      <section className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-12">
        <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
          <Filters
            search={search}
            onSearch={setSearch}
            order={order}
            onOrder={setOrder}
            total={all.length}
            shown={list.length}
            loading={destinations.loading}
          />

          {/* El indicador vive aquí dentro: la cabecera, el hero y los filtros no se despintan. */}
          <div className="min-w-0">
            {destinations.error ? (
              <Card padded={false}>
                <ErrorState error={destinations.error} onRetry={destinations.reload} />
              </Card>
            ) : destinations.loading ? (
              <CatalogGrid>
                {Array.from({ length: 6 }).map((_, index) => (
                  <DestinationCatalogSkeleton key={index} />
                ))}
              </CatalogGrid>
            ) : all.length === 0 ? (
              <Card padded={false}>
                <EmptyState
                  title="Aún no hay destinos publicados"
                  description="Cuando BusPerú publique sus destinos, aparecerán aquí."
                  icon={<MapPin className="h-7 w-7" />}
                />
              </Card>
            ) : list.length === 0 ? (
              <Card padded={false}>
                <EmptyState
                  title="No encontramos destinos"
                  description={`Ningún destino coincide con «${search.trim()}». Prueba con otro nombre.`}
                  icon={<Search className="h-7 w-7" />}
                />
              </Card>
            ) : (
              <CatalogGrid>
                {list.map((destination: PublicDestinationCard) => (
                  <DestinationCatalogCard key={destination.id} destination={destination} />
                ))}
              </CatalogGrid>
            )}
          </div>
        </div>
      </section>

      <ScheduledCities />
    </>
  );
}

/**
 * 1 tarjeta en móvil, 2 en tableta y 3 desde `xl`.
 *
 * El tope son 3: la columna de filtros se lleva 260 px y el contenedor del Home no pasa de 1280, así
 * que con 4 por fila la tarjeta bajaba a 218 px y el nombre y la píldora quedaban apretados.
 */
function CatalogGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

/** Alto de la cabecera pública: 64 px en móvil y 72 px desde `lg`. La barra se fija justo debajo. */
const HEADER_HEIGHT = 72;

/**
 * Hero con la fotografía a todo el ancho y, montada sobre su borde, la barra de compra de pasajes.
 * Es el mismo `TripSearchForm` compacto de la ficha de destino: una sola lógica de búsqueda.
 *
 * Al bajar, la barra se queda fija bajo la cabecera y se viste de naranja, como en `/destinos/:slug`
 * (F17C-UI-07). La diferencia con aquella página es que aquí **no hay dos formularios**: es el mismo
 * elemento con `position: sticky`, así que conserva lo que el usuario haya escrito al fijarse y al
 * soltarse, y vuelve solo a su sitio dentro del hero.
 *
 * Solo desde `lg`: en móvil el buscador ocupa tres filas y fijarlo se comería media pantalla, igual
 * que se decidió en la ficha de destino.
 */
function CatalogHero({ cities }: { cities: string[] }) {
  const barRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    /* El cambio de aspecto se decide con la posición real de la barra, no con un centinela aparte:
       así el naranja entra exactamente cuando `sticky` la engancha, sin desfase. */
    const check = () => {
      const fixable = window.innerWidth >= 1024;
      setStuck(fixable && bar.getBoundingClientRect().top <= HEADER_HEIGHT + 1);
    };

    check();
    window.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    return () => {
      window.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    };
  }, []);

  return (
    <>
      <section className="relative isolate flex h-[220px] items-end overflow-hidden bg-slate-800 sm:h-[260px] lg:h-[300px]">
        <img src={destinationsHeroImage} alt="" aria-hidden className="absolute inset-0 -z-10 h-full w-full object-cover" style={{ objectPosition: '30% 58%' }} />
        <span className="absolute inset-0 -z-10 bg-gradient-to-r from-black/70 via-black/40 to-black/20" aria-hidden />

        <div className="mx-auto w-full max-w-7xl px-4 pb-10 text-white sm:px-6 lg:px-8 lg:pb-14">
          <p className="text-sm font-medium tracking-wide text-white/90">Explora el Perú</p>
          <h1 className="text-3xl font-extrabold leading-tight tracking-tight drop-shadow-sm sm:text-4xl lg:text-5xl">Descubre nuestros destinos</h1>
          <p className="mt-2 max-w-xl text-sm text-white/90 sm:text-base">
            Encuentra tu próximo viaje y descubre nuevos lugares con BusPerú.
          </p>
        </div>
      </section>

      {/* El margen negativo no se toca al fijarse: solo mueve su posición en el flujo, así que la
          barra no puede entrar y salir del estado fijo en bucle. */}
      <div
        ref={barRef}
        className={cn(
          'relative z-30 -mt-6 lg:sticky lg:top-[72px] lg:-mt-8',
          stuck && 'bg-brand-500 shadow-md transition-colors',
        )}
      >
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          {/* Mismo relleno fijada o no: al cambiar de aspecto la página no da ningún salto. */}
          <div
            className={cn(
              'p-3 lg:py-2 lg:pl-2 lg:pr-3',
              !stuck && 'rounded-2xl bg-white shadow-elevated ring-1 ring-black/5 lg:rounded-full',
            )}
          >
            <TripSearchForm cities={cities} variant="bar" tone={stuck ? 'onBrand' : 'light'} />
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Columna de búsqueda y orden.
 *
 * No hay filtros por tipo de servicio: el modelo de destinos no guarda ese dato, y prefiero no
 * ofrecer un filtro que no pueda cumplir. La API pública solo devuelve destinos publicados, así
 * que tampoco tiene sentido un filtro de estado.
 */
function Filters({
  search,
  onSearch,
  order,
  onOrder,
  total,
  shown,
  loading,
}: {
  search: string;
  onSearch: (value: string) => void;
  order: Order;
  onOrder: (value: Order) => void;
  total: number;
  shown: number;
  loading: boolean;
}) {
  return (
    <aside className="lg:sticky lg:top-24 lg:self-start">
      <Card>
        <Input
          label="Buscar destino"
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Ej: Cajamarca"
          icon={<Search className="h-4 w-4" />}
          autoComplete="off"
        />

        <Select
          label="Ordenar por"
          value={order}
          onChange={(event) => onOrder(event.target.value as Order)}
          options={ORDER_OPTIONS}
          containerClassName="mt-4"
        />

        <p className="mt-4 border-t border-border pt-3 text-sm text-muted" aria-live="polite">
          {loading ? 'Cargando destinos...' : shown === total ? `${total} ${total === 1 ? 'destino' : 'destinos'}` : `${shown} de ${total} destinos`}
        </p>
      </Card>
    </aside>
  );
}

/** Ciudades con viajes programados: el contenido que esta ruta ya mostraba antes del catálogo. */
function ScheduledCities() {
  const cities = useAsync(() => publicService.destinations(), []);
  const list = cities.data ?? [];

  if (!cities.loading && (cities.error || list.length === 0)) return null;

  return (
    <section className="border-t border-border bg-slate-50/60">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-12">
        <h2 className="flex items-center gap-3 text-2xl font-extrabold text-ink sm:text-[28px]">
          <span className="h-8 w-1.5 shrink-0 rounded-sm bg-brand-500" aria-hidden />
          Ciudades con viajes programados
        </h2>
        <p className="mb-5 mt-1 text-sm text-muted">Consulta horarios y precios reales para tu fecha de viaje.</p>

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {cities.loading
            ? Array.from({ length: 4 }).map((_, index) => <DestinationTileSkeleton key={index} />)
            : list.map((city) => (
                <DestinationTile
                  key={city.city}
                  city={city.city}
                  department={city.department}
                  trips={city.trips}
                  minPrice={city.min_price}
                  to={`/buscar?destination=${encodeURIComponent(city.city)}&date=${todayIso()}`}
                />
              ))}
        </div>
      </div>
    </section>
  );
}
