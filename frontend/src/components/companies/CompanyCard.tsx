import { ArrowRight, BadgeCheck, Bus, Star } from 'lucide-react';
import { Link } from 'react-router-dom';
import { mediaUrl } from '@/services/api';
import { cn } from '@/utils/cn';
import type { CompanyCardActions } from '@/utils/company-links';

/**
 * Tarjeta de empresa de transporte (composición revisada en F17C-UI-08).
 *
 * Todo lo que muestra viene del backend: nombre, descripción, valoración, número de reseñas y rutas
 * activas. Nada se completa a mano.
 *
 * SOBRE LOS LOGOS: desde F17C-COMPANY-LOGO-01 cada empresa sube el suyo desde su panel, y el
 * endpoint devuelve la referencia en `logo_url`. Mientras no lo haya, se pinta un monograma con sus
 * iniciales, **nunca un logotipo corporativo inventado**: presentar una imagen ajena como el logo
 * oficial de una empresa sería falso.
 */
export function CompanyCard({
  name,
  description,
  logoUrl,
  rating,
  reviewsCount,
  routesCount,
  actions,
}: {
  name: string;
  description: string | null;
  logoUrl: string | null;
  rating: number | null;
  reviewsCount: number;
  routesCount: number;
  /** F18-19D: «Ver perfil» solo si hay perfil público aprobado (slug del backend); «Ver viajes» siempre. */
  actions: CompanyCardActions;
}) {
  const { profile, trips } = actions;
  return (
    <article className="group flex flex-col rounded-card bg-white p-5 shadow-card ring-1 ring-black/5 transition duration-300 hover:-translate-y-1 hover:shadow-elevated sm:p-6">
      <div className="flex items-start justify-between gap-4">
        {/* El logo repite el destino del nombre: se deja fuera del orden de tabulación y de los lectores de pantalla. */}
        {profile ? (
          <Link to={profile.href} tabIndex={-1} aria-hidden className="rounded-control">
            <CompanyIdentity name={name} logoUrl={logoUrl} />
          </Link>
        ) : (
          <CompanyIdentity name={name} logoUrl={logoUrl} />
        )}
        <RatingPill rating={rating} reviewsCount={reviewsCount} />
      </div>

      {/* El listado público solo incluye empresas ACTIVE, es decir, las que superaron la
          verificación de documentos: la insignia no afirma nada que no sea cierto. */}
      <p className="mt-4 flex w-fit items-center gap-1.5 rounded-full bg-success-50 px-2.5 py-1 text-xs font-semibold text-success-700">
        <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
        Empresa verificada
      </p>

      <h2 className="mt-3 text-lg font-bold leading-snug text-ink">
        {profile ? (
          <Link to={profile.href} className="rounded hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            {name}
          </Link>
        ) : (
          name
        )}
      </h2>
      <p className="mt-1.5 line-clamp-3 text-sm text-slate-600">{description ?? 'Transporte interprovincial en el Perú.'}</p>

      <dl className="mt-4 flex items-center gap-2.5 border-t border-border pt-4 text-sm">
        <dt className="sr-only">Rutas activas</dt>
        <Bus className="h-[18px] w-[18px] shrink-0 text-brand-500" aria-hidden />
        <dd className="text-slate-600">
          {routesCount} {routesCount === 1 ? 'ruta activa' : 'rutas activas'}
        </dd>
      </dl>

      {/* `mt-auto`: con descripciones de distinto largo, los botones quedan a la misma altura en toda la fila. */}
      <div className={cn('mt-auto grid gap-2 pt-5', profile && 'grid-cols-2')}>
        {profile && (
          <Link
            to={profile.href}
            aria-label={profile.ariaLabel}
            className="flex h-11 items-center justify-center gap-2 rounded-control bg-brand-500 px-4 text-sm font-semibold text-white transition-colors hover:bg-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            {profile.label}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        )}
        <Link
          to={trips.href}
          aria-label={trips.ariaLabel}
          className={cn(
            'flex h-11 items-center justify-center gap-2 rounded-control px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2',
            profile
              ? 'border border-brand-500 bg-white text-brand-600 hover:bg-brand-50'
              : 'w-full bg-brand-500 text-white hover:bg-brand-600 group-hover:bg-brand-600',
          )}
        >
          {trips.label}
          {!profile && <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />}
        </Link>
      </div>
    </article>
  );
}

/**
 * Logo real si el backend lo tiene; si no, un monograma neutro con las iniciales.
 *
 * Exportado desde F17C-COMPANY-LOGO-01 para que el resto de superficies que hoy solo muestran el
 * nombre puedan usar la MISMA regla de respaldo, en vez de reinventarla cada una.
 */
export function CompanyIdentity({ name, logoUrl, size = 'md' }: { name: string; logoUrl: string | null; size?: 'sm' | 'md' }) {
  // `logo_url` guarda una referencia del almacen publico; `mediaUrl` la convierte y descarta
  // cualquier valor que no tenga esa forma, asi que una URL externa nunca se pinta.
  const src = mediaUrl(logoUrl);
  // `sm` para listados densos, como los resultados de búsqueda; `md` para el catálogo de empresas.
  const box = size === 'sm' ? 'h-14 w-20' : 'h-20 w-28';

  if (src) {
    return (
      <span className={cn('flex items-center justify-center overflow-hidden rounded-control border border-border bg-slate-50', box, size === 'sm' ? 'p-1.5' : 'p-2.5')}>
        <img src={src} alt={`Logotipo de ${name}`} className="max-h-full max-w-full object-contain" loading="lazy" />
      </span>
    );
  }

  return (
    <span
      className={cn(
        'flex items-center justify-center rounded-control bg-brand-50 font-extrabold tracking-tight text-brand-600',
        box,
        size === 'sm' ? 'text-lg' : 'text-2xl',
      )}
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
    <div className="rounded-card bg-white p-5 shadow-card ring-1 ring-black/5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="skeleton h-20 w-28 rounded-control" />
        <div className="skeleton h-9 w-16 rounded-full" />
      </div>
      <div className="skeleton mt-4 h-6 w-36 rounded-full" />
      <div className="mt-3 space-y-2">
        <div className="skeleton h-5 w-2/3" />
        <div className="skeleton h-4 w-full" />
        <div className="skeleton h-4 w-4/5" />
      </div>
      <div className="mt-4 border-t border-border pt-4">
        <div className="skeleton h-4 w-24" />
      </div>
      <div className="skeleton mt-5 h-11 w-full rounded-control" />
    </div>
  );
}
