import { ArrowLeft, ArrowRight, ImageOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, ErrorState } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { publicService } from '@/services';
import { mediaUrl } from '@/services/api';
import type { PublicDestinationCard } from '@/types';
import { cn } from '@/utils/cn';
import { formatPriceFrom } from '@/utils/destination-view';

/**
 * «Descubre más destinos» (FASE 17, composición corregida en la FASE 17B).
 *
 * Carrusel horizontal a ancho completo, como la referencia: tarjetas apaisadas con la fotografía de
 * fondo, el precio como protagonista y flechas discretas junto al título.
 *
 * Todo sale de `GET /public/featured-destinations`: el ADMIN crea, ordena, publica u oculta destinos
 * y la sección lo refleja sin tocar código. Si no hay ninguno publicado, la sección no se muestra.
 *
 * El desplazamiento es scroll nativo con `scroll-snap` (sin librerías): las flechas solo empujan el
 * carril, así que el gesto táctil, la rueda y el teclado siguen funcionando por sí solos.
 */
export function DiscoverDestinationsSection({ excludeSlug }: { excludeSlug?: string }) {
  const destinations = useAsync(() => publicService.featuredDestinations(), []);
  const list = (destinations.data ?? []).filter((item) => item.slug !== excludeSlug);

  const trackRef = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const readEdges = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const max = track.scrollWidth - track.clientWidth;
    setEdges({ start: track.scrollLeft <= 4, end: track.scrollLeft >= max - 4 });
  }, []);

  useEffect(() => {
    readEdges();
    window.addEventListener('resize', readEdges);
    return () => window.removeEventListener('resize', readEdges);
  }, [readEdges, list.length]);

  const scrollByCard = (direction: -1 | 1) => {
    const track = trackRef.current;
    if (!track) return;
    const card = track.querySelector('li');
    const step = card ? card.getBoundingClientRect().width + 16 : track.clientWidth;
    track.scrollBy({ left: step * direction, behavior: 'smooth' });
  };

  if (!destinations.loading && !destinations.error && list.length === 0) return null;

  /* F17C-UI-02 · la sección usa el mismo contenedor que el resto del Home. */
  return (
    <section className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-12" aria-labelledby="descubre-destinos">
      <div className="mb-5 flex items-center justify-between gap-4">
        <h2 id="descubre-destinos" className="flex items-center gap-3 text-2xl font-extrabold text-ink sm:text-[28px]">
          <span className="h-8 w-1.5 shrink-0 rounded-sm bg-brand-500" aria-hidden />
          Descubre más destinos
        </h2>
        <div className="flex shrink-0 gap-2">
          <ArrowButton label="Anterior" disabled={edges.start} onClick={() => scrollByCard(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </ArrowButton>
          <ArrowButton label="Siguiente" disabled={edges.end} onClick={() => scrollByCard(1)}>
            <ArrowRight className="h-5 w-5" />
          </ArrowButton>
        </div>
      </div>

      {destinations.error ? (
        <Card padded={false}>
          <ErrorState error={destinations.error} onRetry={destinations.reload} />
        </Card>
      ) : (
        <ul
          ref={trackRef}
          onScroll={readEdges}
          className="flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth pb-2 scrollbar-none"
        >
          {destinations.loading
            ? Array.from({ length: 4 }).map((_, index) => (
                <li key={index} className={cn(CARD_WIDTH, 'shrink-0 snap-start')}>
                  <div className={cn('skeleton w-full rounded-lg', CARD_SHAPE)} />
                </li>
              ))
            : list.map((destination) => (
                <li key={destination.id} className={cn(CARD_WIDTH, 'shrink-0 snap-start')}>
                  <DiscoverDestinationCard destination={destination} />
                </li>
              ))}
        </ul>
      )}

      {/* F17C-UI-06 · acceso al catálogo completo. `Button` con `to` navega con React Router: sin recarga. */}
      <div className="mt-8 flex justify-center">
        <Button to="/destinos" className="uppercase tracking-wider">
          Ver todos los destinos
        </Button>
      </div>
    </section>
  );
}

/**
 * Altura reservada para la línea secundaria (F17C-UI-03). Con precio o sin él el bloque mide lo
 * mismo, así que el título y el botón caen a la misma altura en todas las tarjetas del carril.
 * Crece en `sm` porque allí la cifra pasa de 26 a 30 px.
 */
const SECONDARY_BLOCK = 'min-h-[2.75rem] sm:min-h-[3rem]';

/**
 * Cuántas tarjetas se ven: 1 en móvil, 2 en tableta y 3 desde `xl` (F17C-UI-04).
 *
 * Antes se mostraban 4 desde `xl`. Dentro del contenedor del Home (1280 px como máximo) eso dejaba
 * tarjetas de 292×163 px, demasiado bajas para su contenido: el botón se salía por abajo. Con 3 la
 * tarjeta ronda los 416 px de ancho, cerca del tamaño de la referencia, y el resto del carril sigue
 * accesible con las flechas y el desplazamiento.
 */
const CARD_WIDTH = 'w-[86%] sm:w-[calc((100%-1rem)/2)] xl:w-[calc((100%-2rem)/3)]';

/**
 * Proporción de la referencia (458×255) con un suelo de altura: cuando la tarjeta es estrecha
 * —móvil o tableta— crece a lo alto en vez de aplastar el contenido.
 *
 * `w-full` es imprescindible: sin un ancho explícito, el suelo de altura hace que el navegador
 * ensanche la tarjeta para respetar la proporción y se sale de su hueco del carril.
 */
const CARD_SHAPE = 'w-full aspect-[458/255] min-h-[15rem]';

function ArrowButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-10 w-10 items-center justify-center rounded-full border border-ink/25 text-ink transition hover:border-brand-500 hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-ink/25 disabled:hover:text-ink"
    >
      {children}
    </button>
  );
}

export function DiscoverDestinationCard({ destination }: { destination: PublicDestinationCard }) {
  const [failed, setFailed] = useState(false);
  const image = failed ? null : mediaUrl(destination.hero_image);
  const price = formatPriceFrom(destination.price_from);

  return (
    <Link
      to={`/destinos/${destination.slug}`}
      className={cn(
        'group relative flex flex-col justify-end overflow-hidden rounded-lg bg-slate-800 text-white ring-1 ring-black/5 transition duration-300 hover:shadow-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        CARD_SHAPE,
      )}
    >
      {image ? (
        <img
          src={image}
          alt={`Vista de ${destination.name}`}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 motion-safe:group-hover:scale-105"
        />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-brand-500 to-brand-700" aria-hidden>
          <ImageOff className="h-10 w-10 text-white/40" />
        </span>
      )}
      {/* Velo desde la izquierda: el texto se lee sobre cualquier fotografía. */}
      <span className="absolute inset-0 bg-gradient-to-r from-black/75 via-black/35 to-transparent" aria-hidden />

      {/* Contenido anclado al pie con un margen propio: el botón nunca llega al borde de la tarjeta. */}
      <span className="relative flex flex-col gap-2 pb-6 pl-5 pr-4 sm:pl-6">
        <span className="block text-sm text-white/85">Descubre la magia de</span>
        <span className="block text-2xl font-extrabold leading-tight sm:text-[28px]">{destination.name}</span>

        {/* F17C-UI-03 · espacio reservado: con precio o sin él este bloque mide lo mismo, así que el
            título y «CONOCE MÁS» caen a la misma altura en todas las tarjetas del carril. */}
        <span className={cn('flex flex-col justify-end', SECONDARY_BLOCK)}>
          {price === null ? (
            <span className="block text-sm text-white/85">Consulta precios y horarios</span>
          ) : (
            <>
              <span className="block text-[11px] font-medium text-white/85">Pasajes desde:</span>
              {/* La barra naranja arranca en el borde de la tarjeta, como en la referencia. */}
              <span className="relative -ml-5 block pl-5 sm:-ml-6 sm:pl-6">
                <span className="absolute bottom-0 left-0 top-0 w-2 bg-brand-500" aria-hidden />
                <span className="block text-[26px] font-extrabold leading-none sm:text-[30px]">{price}</span>
              </span>
            </>
          )}
        </span>

        <span className="block pt-1">
          <span className="inline-flex items-center rounded-full border border-white/80 px-5 py-2 text-[11px] font-bold uppercase tracking-wider text-white transition group-hover:bg-white group-hover:text-ink">
            Conoce más
          </span>
        </span>
      </span>
    </Link>
  );
}
