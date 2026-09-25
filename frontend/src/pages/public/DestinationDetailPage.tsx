import { ArrowDown, ArrowUp, CalendarDays, Clock3, MapPin, MoveVertical, Package, Search, Thermometer } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { TripSearchForm } from '@/components/common/TripSearchForm';
import { DiscoverDestinationsSection } from '@/components/destinations/DiscoverDestinations';
import { Button, Card, EmptyState, ErrorState } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { publicService } from '@/services';
import { mediaUrl } from '@/services/api';
import type { PublicDestinationDetail } from '@/types';
import { cn } from '@/utils/cn';
import { badgeFitsInCircle, formatAltitude, searchPrefill, stepIndex } from '@/utils/destination-view';

/**
 * Página pública de UN destino (FASE 17, composición corregida en la FASE 17B).
 *
 * Una sola ruta `/destinos/:slug` para todos los destinos; el contenido llega de
 * `GET /public/destinations/:slug`. No hay componentes por ciudad ni textos escritos a mano.
 *
 * Todo el texto se pinta como texto (React lo escapa): el contenido del CMS nunca se interpreta
 * como HTML. Los bloques sin datos no se muestran.
 */
export function DestinationDetailPage() {
  const { slug = '' } = useParams();
  const destination = useAsync(() => publicService.destinationBySlug(slug), [slug]);
  const cities = useAsync(() => publicService.cities(), []);
  const cityNames = useMemo(() => (cities.data ?? []).map((city) => city.city), [cities.data]);

  if (destination.loading) {
    return (
      /* F17C-NAV-03: altura reservada mientras llega la ficha, para no encoger el documento. */
      <div className="mx-auto min-h-[70vh] max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="skeleton h-40 rounded-card" />
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <div className="skeleton h-64 rounded-card" />
          <div className="skeleton h-64 rounded-card" />
        </div>
      </div>
    );
  }

  if (destination.error || !destination.data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        {destination.error?.status === 404 ? (
          <Card>
            <EmptyState
              title="Destino no disponible"
              description="Este destino no existe o ya no está publicado."
              icon={<MapPin className="h-7 w-7" />}
              action={<Button to="/">Volver al inicio</Button>}
            />
          </Card>
        ) : (
          <Card padded={false}>
            <ErrorState error={destination.error} onRetry={destination.reload} />
          </Card>
        )}
      </div>
    );
  }

  const data = destination.data;

  return (
    <>
      <DestinationHeader destination={data} cities={cityNames} />
      <DestinationInfo destination={data} />
      <Attractions destination={data} />
      <Festivities destination={data} />
      <CallToAction name={data.name} />
      <DiscoverDestinationsSection excludeSlug={data.slug} />
    </>
  );
}

/* ------------------------------------------------------------------ hero + buscador */

/**
 * Hero bajo con el nombre pegado a su borde inferior y la barra de compra montada encima, como en
 * la referencia. Al perderse de vista, la misma barra se fija bajo la cabecera en naranja: es el
 * MISMO buscador (`TripSearchForm`), con su estado y su validación; solo cambia el envoltorio.
 */
function DestinationHeader({ destination, cities }: { destination: PublicDestinationDetail; cities: string[] }) {
  const [heroFailed, setHeroFailed] = useState(false);
  const [stuck, setStuck] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const image = heroFailed ? null : mediaUrl(destination.hero_image);
  const prefill = searchPrefill(destination, cities);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry?.isIntersecting), { rootMargin: '-80px 0px 0px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <section className="relative isolate flex h-[200px] items-end overflow-hidden bg-slate-800 sm:h-[220px] lg:h-[260px]">
        {image ? (
          <img
            src={image}
            alt={`Vista de ${destination.name}`}
            onError={() => setHeroFailed(true)}
            className="absolute inset-0 -z-10 h-full w-full object-cover object-center"
          />
        ) : (
          <span className="absolute inset-0 -z-10 bg-gradient-to-br from-brand-500 to-brand-800" aria-hidden />
        )}
        <span className="absolute inset-0 -z-10 bg-gradient-to-r from-black/70 via-black/35 to-black/20" aria-hidden />

        <div className="mx-auto w-full max-w-6xl px-4 pb-9 text-white sm:px-6 lg:px-8 lg:pb-12">
          <p className="text-sm font-medium tracking-wide text-white/90">Destino</p>
          <h1 className="text-4xl font-extrabold leading-none tracking-tight drop-shadow-sm sm:text-5xl lg:text-[64px]">{destination.name}</h1>
        </div>
      </section>

      {/* La barra monta sobre el borde del hero en escritorio, como la referencia. */}
      <div id="buscar-pasajes" className="relative z-20 mx-auto -mt-6 max-w-6xl scroll-mt-28 px-4 sm:px-6 lg:-mt-8 lg:px-8">
        <div className="rounded-2xl bg-white p-3 shadow-elevated ring-1 ring-black/5 lg:rounded-full lg:py-2 lg:pl-2 lg:pr-3">
          <TripSearchForm cities={cities} initialOrigin={prefill.origin} initialDestination={prefill.destination} variant="bar" />
        </div>
      </div>
      <div ref={sentinelRef} aria-hidden className="h-px" />

      {/* Barra fija naranja al hacer scroll. Solo en escritorio: en móvil ocuparía media pantalla. */}
      <div
        className={cn(
          'fixed inset-x-0 top-[72px] z-30 hidden bg-brand-500 shadow-md transition-transform duration-200 lg:block',
          stuck ? 'translate-y-0' : '-translate-y-[150%]',
        )}
      >
        <div className="mx-auto max-w-7xl px-4 py-2 sm:px-6 lg:px-8">
          <TripSearchForm cities={cities} initialOrigin={prefill.origin} initialDestination={prefill.destination} variant="bar" tone="onBrand" />
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ información */

function DestinationInfo({ destination }: { destination: PublicDestinationDetail }) {
  const [failed, setFailed] = useState(false);
  const image = failed ? null : mediaUrl(destination.hero_image);
  const rows = [
    { icon: <MapPin className="h-4 w-4" />, label: null, value: destination.address },
    { icon: <Clock3 className="h-4 w-4" />, label: 'Horario Pasajes:', value: destination.ticket_schedule },
    { icon: <Package className="h-4 w-4" />, label: 'Horario Encomiendas:', value: destination.package_schedule },
    { icon: <Clock3 className="h-4 w-4" />, label: 'Duración del viaje:', value: destination.travel_duration },
  ].filter((row) => row.value);

  const badges = [
    { icon: <MoveVertical className="h-5 w-5" />, text: null, caption: formatAltitude(destination.altitude_masl) },
    { icon: <Thermometer className="h-5 w-5" />, text: null, caption: destination.temperature },
    { icon: <Clock3 className="h-5 w-5" />, text: destination.time_from_lima, caption: destination.origin_city ? `Desde ${destination.origin_city}` : 'Tiempo de viaje' },
  ].filter((badge) => badge.caption || badge.text);

  const hasText = destination.subtitle || destination.description;
  if (!hasText && rows.length === 0 && badges.length === 0 && !image) return null;

  return (
    <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:gap-10">
        <div>
          {/* Barra naranja + título + subtítulo naranja, como en la referencia. */}
          <div className="flex gap-3">
            <span className="mt-1 w-1.5 shrink-0 rounded-sm bg-brand-500" aria-hidden />
            <div>
              <h2 className="text-2xl font-extrabold text-ink sm:text-[28px]">{destination.name}</h2>
              {destination.subtitle && <p className="mt-1 text-base font-medium text-brand-500">{destination.subtitle}</p>}
            </div>
          </div>

          {destination.description && (
            <p className="mt-5 whitespace-pre-line text-[15px] leading-relaxed text-slate-600">{destination.description}</p>
          )}

          {rows.length > 0 && (
            <ul className="mt-6 space-y-4">
              {rows.map((row, index) => (
                <li key={index} className="flex gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-brand-400 text-brand-500" aria-hidden>
                    {row.icon}
                  </span>
                  <span className="min-w-0 text-sm text-slate-600">
                    {row.label && <span className="block font-semibold text-ink">{row.label}</span>}
                    <span className="block break-words">{row.value}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {badges.length > 0 && (
            <ul className="mt-8 flex flex-wrap gap-8">
              {badges.map((badge, index) => (
                <li key={index} className="w-[90px] text-center">
                  <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border-2 border-brand-400 text-brand-500" aria-hidden>
                    {badgeFitsInCircle(badge.text) ? <span className="text-sm font-extrabold">{badge.text}</span> : badge.icon}
                  </span>
                  <span className="mt-2 block text-xs text-slate-600">
                    {!badgeFitsInCircle(badge.text) && badge.text ? `${badge.text} · ` : ''}
                    {badge.caption}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {image && (
          <img
            src={image}
            alt={destination.name}
            loading="lazy"
            onError={() => setFailed(true)}
            className="aspect-[4/3] w-full rounded-sm object-cover shadow-card lg:aspect-[7/5]"
          />
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ atractivos */

/**
 * Slider de «Atractivos turísticos» a ancho completo: la fotografía ocupa la sección y el texto va
 * en una caja translúcida, como la referencia. Sin librerías: una lámina visible y dos flechas.
 */
function Attractions({ destination }: { destination: PublicDestinationDetail }) {
  const attractions = destination.attractions;
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  if (attractions.length === 0) return null;

  const current = attractions[Math.min(index, attractions.length - 1)]!;
  const image = failed[current.id] ? null : mediaUrl(current.image);
  const move = (delta: -1 | 1) => setIndex((value) => stepIndex(value, delta, attractions.length));

  return (
    <section
      className="relative isolate min-h-[360px] overflow-hidden bg-slate-800 lg:min-h-[420px]"
      aria-roledescription="carrusel"
      aria-label="Atractivos turísticos"
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') move(1);
        if (event.key === 'ArrowLeft') move(-1);
      }}
    >
      {image ? (
        <img src={image} alt={current.name} onError={() => setFailed((f) => ({ ...f, [current.id]: true }))} className="absolute inset-0 -z-10 h-full w-full object-cover" />
      ) : (
        <span className="absolute inset-0 -z-10 bg-gradient-to-br from-slate-700 to-slate-900" aria-hidden />
      )}
      <span className="absolute inset-0 -z-10 bg-black/25 lg:bg-black/10" aria-hidden />

      <div className="mx-auto flex min-h-[360px] max-w-6xl items-center justify-end px-4 py-10 sm:px-6 lg:min-h-[420px] lg:px-8">
        <div className="w-full max-w-md bg-black/55 p-6 text-white backdrop-blur-sm sm:p-7">
          <h2 className="text-3xl font-extrabold leading-tight sm:text-4xl">
            Atractivos
            <br />
            turísticos
          </h2>
          <p className="mt-4 text-lg text-white/95" aria-live="polite">
            {current.name}
          </p>
          {current.description && <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-white/85">{current.description}</p>}
          {attractions.length > 1 && (
            <p className="mt-4 text-xs text-white/70">
              {index + 1} de {attractions.length}
            </p>
          )}
        </div>
      </div>

      {attractions.length > 1 && (
        <div className="absolute right-3 top-1/2 flex -translate-y-1/2 flex-col gap-3 sm:right-6">
          <SliderArrow label="Siguiente atractivo" onClick={() => move(1)}>
            <ArrowUp className="h-5 w-5 rotate-90" />
          </SliderArrow>
          <SliderArrow label="Atractivo anterior" onClick={() => move(-1)}>
            <ArrowDown className="h-5 w-5 rotate-90" />
          </SliderArrow>
        </div>
      )}
    </section>
  );
}

function SliderArrow({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-11 w-11 items-center justify-center rounded-full border border-white/80 text-white transition hover:bg-white hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ calendario festivo */

/** Panel naranja con corte diagonal y fotografía a la derecha. Sin imagen, el naranja ocupa todo. */
function Festivities({ destination }: { destination: PublicDestinationDetail }) {
  const [failed, setFailed] = useState(false);
  const festivities = destination.festivities;
  const image = failed ? null : mediaUrl(destination.festivities_image);
  if (festivities.length === 0) return null;

  return (
    <section className="relative isolate overflow-hidden bg-brand-500">
      {image && (
        <img
          src={image}
          alt=""
          aria-hidden
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-y-0 right-0 -z-10 hidden h-full w-1/2 object-cover lg:block"
        />
      )}
      {image && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 -z-10 hidden w-[58%] bg-brand-500 lg:block"
          style={{ clipPath: 'polygon(0 0, 100% 0, 78% 100%, 0 100%)' }}
        />
      )}

      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
        <div className="lg:max-w-md">
          <h2 className="text-3xl font-extrabold leading-tight text-white sm:text-4xl">
            Calendario
            <br />
            Festivo
          </h2>
          <ol className="mt-6 space-y-4">
            {festivities.map((festivity) => (
              <li key={festivity.id} className="flex gap-3 text-white">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/70" aria-hidden>
                  <CalendarDays className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[15px] font-semibold leading-snug">{festivity.name}</span>
                  <span className="block text-sm text-white/85">{festivity.date_label}</span>
                  {festivity.description && <span className="mt-1 block whitespace-pre-line text-xs text-white/80">{festivity.description}</span>}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ CTA */

function CallToAction({ name }: { name: string }) {
  return (
    <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex flex-col items-center gap-4 rounded-card bg-slate-50 px-6 py-8 text-center sm:flex-row sm:justify-between sm:text-left">
        <div>
          <p className="text-xl font-extrabold text-ink">¿Listo para viajar a {name}?</p>
          <p className="mt-1 text-sm text-muted">Consulta horarios y precios reales de las empresas.</p>
        </div>
        <a
          href="#buscar-pasajes"
          className="inline-flex items-center gap-2 rounded-full bg-brand-500 px-6 py-3 text-sm font-bold uppercase tracking-wide text-white transition hover:bg-brand-600"
        >
          <Search className="h-4 w-4" /> Buscar pasajes
        </a>
      </div>
    </section>
  );
}
