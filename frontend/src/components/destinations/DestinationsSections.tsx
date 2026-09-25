import { ChevronRight, MapPin } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { destinationImage, fallbackDestinationImage } from '@/constants/images';
import { mediaUrl } from '@/services/api';
import type { PublicDestinationCard } from '@/types';
import { formatPriceFrom } from '@/utils/destination-view';
import { formatCurrency } from '@/utils/format';

/**
 * Piezas visuales de la página de destinos.
 *
 * No hay lógica de negocio aquí: `DestinationsPage` sigue pidiendo los datos y decidiendo
 * qué mostrar. Estos componentes solo los pintan.
 */

/**
 * Tarjeta de destino.
 *
 * Todos los valores llegan del backend: ciudad, departamento, número de viajes y precio
 * mínimo. La fotografía sale del catálogo centralizado; una ciudad sin foto propia recibe la
 * de reserva, y si la descarga fallara se sustituye en caliente para no dejar un hueco roto.
 */
export function DestinationTile({
  city,
  department,
  trips,
  minPrice,
  to,
}: {
  city: string;
  department: string | null;
  trips: number;
  minPrice: number;
  to: string;
}) {
  const [src, setSrc] = useState(() => destinationImage(city));

  return (
    <Link
      to={to}
      className="group flex flex-col overflow-hidden rounded-card bg-white shadow-card ring-1 ring-black/5 transition duration-300 hover:-translate-y-1 hover:shadow-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-slate-100">
        <img
          src={src}
          alt={`Vista de ${city}`}
          loading="lazy"
          decoding="async"
          onError={() => setSrc(fallbackDestinationImage)}
          className="h-full w-full object-cover transition-transform duration-500 motion-safe:group-hover:scale-105"
        />
      </div>

      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-base font-bold text-ink">
              <MapPin className="h-4 w-4 shrink-0 text-brand-500" aria-hidden />
              <span className="truncate">{city}</span>
            </p>
            <p className="mt-0.5 truncate pl-[22px] text-sm text-muted">{department ?? 'Perú'}</p>
          </div>

          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-500 transition group-hover:bg-brand-500 group-hover:text-white">
            <ChevronRight className="h-4 w-4" />
          </span>
        </div>

        <p className="mt-4 border-t border-border pt-3 text-sm text-muted">
          {trips} {trips === 1 ? 'viaje' : 'viajes'} · desde{' '}
          <span className="font-bold text-brand-600">{formatCurrency(minPrice)}</span>
        </p>
      </div>
    </Link>
  );
}

/** Esqueleto con la misma forma que la tarjeta, para que la carga no dé saltos. */
export function DestinationTileSkeleton() {
  return (
    <div className="overflow-hidden rounded-card bg-white shadow-card ring-1 ring-black/5">
      <div className="skeleton aspect-[16/10] w-full rounded-none" />
      <div className="space-y-2 p-4">
        <div className="skeleton h-4 w-2/3" />
        <div className="skeleton h-3 w-1/2" />
        <div className="skeleton mt-3 h-3 w-3/4" />
      </div>
    </div>
  );
}

/**
 * Tarjeta del catálogo editorial de destinos (F17C-UI-06).
 *
 * Distinta de `DestinationTile`, que lista ciudades con viajes programados: esta muestra las fichas
 * que el ADMIN publica desde el CMS y lleva a `/destinos/:slug`. Comparte el lenguaje visual de la
 * tarjeta del carrusel de la portada —foto de fondo, velo desde abajo, barra naranja y píldora— para
 * que las dos superficies de destinos se reconozcan como la misma familia.
 *
 * Toda la tarjeta es el enlace y «Ver destino» es su remate visual: así hay un único destino de
 * tabulación por tarjeta y no queda un enlace dentro de otro.
 */
export function DestinationCatalogCard({ destination }: { destination: PublicDestinationCard }) {
  const [failed, setFailed] = useState(false);
  const image = failed ? fallbackDestinationImage : mediaUrl(destination.hero_image) ?? fallbackDestinationImage;
  const price = formatPriceFrom(destination.price_from);

  return (
    <Link
      to={`/destinos/${destination.slug}`}
      className="group relative flex aspect-[5/4] min-h-[14rem] w-full flex-col justify-end overflow-hidden rounded-card bg-slate-800 text-white shadow-card ring-1 ring-black/5 transition duration-300 hover:-translate-y-1 hover:shadow-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <img
        src={image}
        alt={`Vista de ${destination.name}`}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 motion-safe:group-hover:scale-105"
      />
      {/* Velo desde abajo: el nombre se lee sobre cualquier fotografía. */}
      <span className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent" aria-hidden />

      <span className="relative flex flex-col gap-2 pb-5 pl-4 pr-4">
        {price !== null && (
          <span className="text-xs font-medium text-white/85">
            Pasajes desde: <span className="font-extrabold text-white">{price}</span>
          </span>
        )}

        {/* La barra naranja arranca en el borde de la tarjeta, como en el carrusel de la portada. */}
        <span className="relative -ml-4 block pl-4">
          <span className="absolute bottom-0 left-0 top-0 w-1.5 bg-brand-500" aria-hidden />
          <span className="block truncate text-xl font-extrabold leading-tight sm:text-2xl">{destination.name}</span>
        </span>

        {destination.subtitle && <span className="line-clamp-1 text-xs text-white/80">{destination.subtitle}</span>}

        <span className="block pt-1">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/80 px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider text-white transition group-hover:bg-white group-hover:text-ink">
            Ver destino
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </span>
        </span>
      </span>
    </Link>
  );
}

/** Esqueleto con la forma de `DestinationCatalogCard`, para que la carga no dé saltos. */
export function DestinationCatalogSkeleton() {
  return <div className="skeleton aspect-[5/4] min-h-[14rem] w-full rounded-card" />;
}
