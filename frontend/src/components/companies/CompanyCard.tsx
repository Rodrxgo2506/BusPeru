import { ArrowRight, Building2, Bus, Star } from 'lucide-react';
import { Link } from 'react-router-dom';

/**
 * Tarjeta de empresa de transporte.
 *
 * Todo lo que muestra viene del backend: nombre, descripción, valoración, número de reseñas
 * y rutas activas. Nada se completa a mano.
 *
 * SOBRE LOS LOGOS: el endpoint devuelve `logo_url` y hoy es `null` en todas las empresas.
 * En ese caso se pinta un monograma con sus iniciales, **nunca un logotipo corporativo
 * inventado**: presentar una imagen ajena como el logo oficial de una empresa sería falso.
 * Si algún día el backend devuelve un logo real, se usa ese.
 */
export function CompanyCard({
  name,
  description,
  logoUrl,
  rating,
  reviewsCount,
  routesCount,
  to,
}: {
  name: string;
  description: string | null;
  logoUrl: string | null;
  rating: number | null;
  reviewsCount: number;
  routesCount: number;
  to: string;
}) {
  return (
    <article className="group flex flex-col rounded-card bg-white p-5 shadow-card ring-1 ring-black/5 transition duration-300 hover:-translate-y-1 hover:shadow-elevated sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <CompanyIdentity name={name} logoUrl={logoUrl} />
        <RatingPill rating={rating} reviewsCount={reviewsCount} />
      </div>

      <h2 className="mt-5 text-lg font-bold leading-snug text-ink">{name}</h2>

      <dl className="mt-3 space-y-2.5 text-sm">
        <div className="flex items-start gap-2.5">
          <dt className="sr-only">Descripción</dt>
          <Building2 className="mt-0.5 h-[18px] w-[18px] shrink-0 text-brand-500" aria-hidden />
          <dd className="text-slate-600">{description ?? 'Transporte interprovincial en el Perú.'}</dd>
        </div>
        <div className="flex items-center gap-2.5">
          <dt className="sr-only">Rutas activas</dt>
          <Bus className="h-[18px] w-[18px] shrink-0 text-brand-500" aria-hidden />
          <dd className="text-slate-600">
            {routesCount} {routesCount === 1 ? 'ruta activa' : 'rutas activas'}
          </dd>
        </div>
      </dl>

      <Link
        to={to}
        className="mt-5 flex items-center gap-1.5 border-t border-border pt-4 text-sm font-semibold text-brand-600 transition hover:text-brand-700"
      >
        Ver viajes
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </Link>
    </article>
  );
}

/** Logo real si el backend lo tiene; si no, un monograma neutro con las iniciales. */
function CompanyIdentity({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  if (logoUrl) {
    return (
      <span className="flex h-16 w-32 items-center justify-center overflow-hidden rounded-control border border-border bg-white p-2">
        <img src={logoUrl} alt={`Logotipo de ${name}`} className="max-h-full max-w-full object-contain" loading="lazy" />
      </span>
    );
  }

  return (
    <span
      className="flex h-16 w-16 items-center justify-center rounded-control bg-brand-50 text-xl font-extrabold tracking-tight text-brand-600"
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

/** Dos iniciales, saltándose las formas societarias (S.A.C., S.A., E.I.R.L.). */
function initials(name: string): string {
  const ignored = new Set(['sac', 'sa', 'srl', 'eirl', 'sac.', 'de', 'del', 'la', 'las', 'los', 'y']);
  const words = name
    .split(/\s+/)
    .map((word) => word.replace(/[.,]/g, ''))
    .filter((word) => word.length > 0 && !ignored.has(word.toLowerCase()));

  return words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? '').join('') || '—';
}

/**
 * Valoración media y número de reseñas. Cuando una empresa aún no tiene reseñas, el hueco no
 * se rellena con un cero engañoso: se muestra un guion y se explica en el texto accesible.
 */
function RatingPill({ rating, reviewsCount }: { rating: number | null; reviewsCount: number }) {
  if (rating === null) {
    return (
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-400"
        title="Sin reseñas todavía"
      >
        <span aria-hidden>—</span>
        <span className="sr-only">Sin reseñas todavía</span>
      </span>
    );
  }

  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-warning-50 px-3 py-1.5 text-sm">
      <Star className="h-4 w-4 fill-warning-500 text-warning-500" aria-hidden />
      <span className="font-bold text-ink">{rating}</span>
      <span className="text-muted">({reviewsCount})</span>
      <span className="sr-only">
        de valoración media con {reviewsCount} {reviewsCount === 1 ? 'reseña' : 'reseñas'}
      </span>
    </span>
  );
}

/** Esqueleto con la misma forma que la tarjeta, para que la carga no dé saltos. */
export function CompanyCardSkeleton() {
  return (
    <div className="rounded-card bg-white p-6 shadow-card ring-1 ring-black/5">
      <div className="flex items-start justify-between gap-4">
        <div className="skeleton h-16 w-16 rounded-control" />
        <div className="skeleton h-9 w-16 rounded-full" />
      </div>
      <div className="mt-5 space-y-3">
        <div className="skeleton h-5 w-2/3" />
        <div className="skeleton h-4 w-full" />
        <div className="skeleton h-4 w-1/3" />
      </div>
      <div className="mt-5 border-t border-border pt-4">
        <div className="skeleton h-4 w-24" />
      </div>
    </div>
  );
}
