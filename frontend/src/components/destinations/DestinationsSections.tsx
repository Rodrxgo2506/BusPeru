import { ChevronRight, MapPin } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PublicHero } from '@/components/common/PublicHero';
import { destinationImage, destinationsHeroImage, fallbackDestinationImage } from '@/constants/images';
import { formatCurrency } from '@/utils/format';

/**
 * Piezas visuales de la página de destinos.
 *
 * No hay lógica de negocio aquí: `DestinationsPage` sigue pidiendo los datos y decidiendo
 * qué mostrar. Estos componentes solo los pintan.
 */

/**
 * Cabecera de la página de destinos.
 *
 * Es la cabecera compartida `PublicHero` con el contenido propio de esta página; la
 * estructura y los velos viven allí para no repetirlos en cada catálogo público.
 */
export function DestinationsHero({ children }: { children: ReactNode }) {
  return (
    <PublicHero
      eyebrow="Explora el Perú"
      title="Destinos"
      description="Explora los destinos con viajes programados en BusPerú."
      image={destinationsHeroImage}
      // El encuadre se desplaza a la izquierda de la foto, que es donde están los buses.
      imagePosition="30% 58%"
      aside={['Grandes destinos,', 'más historias']}
    >
      {children}
    </PublicHero>
  );
}

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
