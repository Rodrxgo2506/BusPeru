import { ArrowRight, Headphones, MapPin, Route, ShieldCheck, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { destinationImage, fallbackDestinationImage, heroImages } from '@/constants/images';
import { cn } from '@/utils/cn';
import { formatCurrency } from '@/utils/format';

/**
 * Piezas visuales de la portada (mockup de rediseño).
 *
 * Aquí no hay lógica de negocio ni llamadas a la API: `HomePage` sigue siendo quien pide los
 * datos y quien decide qué mostrar. Estos componentes solo los pintan.
 */

// --- Hero -------------------------------------------------------------------

const TRUST_SIGNALS: Array<{ icon: LucideIcon; title: string; subtitle: string }> = [
  { icon: ShieldCheck, title: 'Seguro', subtitle: 'y confiable' },
  { icon: Route, title: 'Miles de rutas', subtitle: 'en todo el país' },
  { icon: Headphones, title: 'Atención al cliente', subtitle: '24/7' },
];

/**
 * Cabecera con fotografía real del Huascarán, en los Andes peruanos.
 *
 * La foto se acota a la franja derecha en escritorio y va a sangre en móvil. El motivo no es
 * estético sino práctico: a pantalla completa, una foto apaisada dentro de una banda ancha y
 * baja se recorta a una tira de cielo. Acotándola, el recorte conserva la montaña entera.
 *
 * El texto nunca depende de que la foto cargue: vive sobre blanco, no sobre la imagen.
 */
export function HomeHero({ children }: { children: React.ReactNode }) {
  return (
    <section className="relative isolate overflow-hidden bg-white lg:min-h-[620px]">
      {/*
        En móvil la fotografía va detrás de todo, a sangre. A partir de `lg` se acota a la
        franja derecha, como en el mockup: así el recorte deja ver la montaña entera en vez de
        una banda de cielo, y el texto descansa sobre blanco limpio.
      */}
      <div className="pointer-events-none absolute inset-0 -z-10 lg:left-[38%]">
        <picture>
          <source media="(max-width: 640px)" srcSet={heroImages.mainSmall} />
          <img
            src={heroImages.main}
            alt="El nevado Huascarán, en la Cordillera Blanca de los Andes peruanos"
            className="h-full w-full object-cover object-center"
            loading="eager"
            decoding="async"
          />
        </picture>

        {/* Velo para que el titular se lea cuando el texto va encima de la foto. */}
        <div className="absolute inset-0 bg-gradient-to-b from-white/85 via-white/75 to-white/90 lg:hidden" aria-hidden />
        {/* Fundido lateral: disuelve el borde recto de la foto contra el blanco de la página. */}
        <div className="absolute inset-y-0 left-0 hidden w-56 bg-gradient-to-r from-white via-white/80 to-transparent lg:block" aria-hidden />
        {/* Y arriba y abajo, para que no quede un recorte duro contra el header ni contra la página. */}
        <div className="absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-white/85 to-transparent" aria-hidden />
        <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-white to-transparent" aria-hidden />
      </div>

      <div className="mx-auto max-w-7xl px-4 pb-8 pt-10 sm:px-6 sm:pb-12 sm:pt-16 lg:px-8 lg:pt-24">
        <div className="max-w-xl">
          <h1 className="text-[2.1rem] font-extrabold uppercase leading-[1.05] tracking-tight text-ink sm:text-5xl lg:text-6xl">
            Viaja por todo
            <br />
            el <span className="text-brand-500">Perú</span>
          </h1>

          <p className="mt-4 max-w-md text-base leading-relaxed text-slate-600 sm:text-lg">
            Encuentra los mejores pasajes de bus a los mejores precios. Viaja seguro, cómodo y con las mejores
            empresas.
          </p>

          <ul className="mt-7 flex flex-wrap gap-x-7 gap-y-4">
            {TRUST_SIGNALS.map(({ icon: Icon, title, subtitle }) => (
              <li key={title} className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-brand-500 shadow-card ring-1 ring-black/5">
                  <Icon className="h-[18px] w-[18px]" />
                </span>
                <span className="text-sm leading-tight">
                  <span className="block font-semibold text-ink">{title}</span>
                  <span className="block text-muted">{subtitle}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* El buscador entra aquí, superpuesto sobre la fotografía como en el mockup. */}
        <div className="mt-8 sm:mt-12 lg:mt-16">{children}</div>
      </div>
    </section>
  );
}

// --- Encabezado de sección ---------------------------------------------------

export function SectionHeading({ title, action }: { title: string; action?: { label: string; to: string } }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <h2 className="flex items-center gap-2.5 text-xl font-bold text-ink sm:text-2xl">
        <span className="h-6 w-1 rounded-full bg-brand-500" aria-hidden />
        {title}
      </h2>
      {action && (
        <Link
          to={action.to}
          className="group flex items-center gap-1 text-sm font-semibold text-brand-600 transition hover:text-brand-700"
        >
          {action.label}
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      )}
    </div>
  );
}

// --- Tarjeta de destino -------------------------------------------------------

/**
 * Destino con fotografía real. La imagen sale de `constants/images`; una ciudad sin foto
 * propia recibe la de reserva, y si la descarga falla se sustituye en caliente, de modo que
 * nunca queda un hueco roto.
 */
export function DestinationCard({ city, minPrice, to }: { city: string; minPrice: number; to: string }) {
  const [src, setSrc] = useState(() => destinationImage(city));

  return (
    <Link
      to={to}
      className="group block overflow-hidden rounded-card bg-white shadow-card ring-1 ring-black/5 transition duration-300 hover:-translate-y-1 hover:shadow-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
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
        <span className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/25 to-transparent" aria-hidden />
      </div>

      <div className="flex items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="truncate text-base font-bold text-ink">{city}</p>
          <p className="mt-0.5 text-sm text-muted">
            Desde <span className="font-bold text-brand-600">{formatCurrency(minPrice)}</span>
          </p>
        </div>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-brand-200 text-brand-500 transition group-hover:bg-brand-500 group-hover:text-white">
          <ArrowRight className="h-4 w-4" />
        </span>
      </div>
    </Link>
  );
}

/** Esqueleto con la misma forma que la tarjeta, para que la carga no salte. */
export function DestinationCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-card bg-white shadow-card ring-1 ring-black/5">
      <div className="skeleton aspect-[16/10] w-full rounded-none" />
      <div className="space-y-2 p-4">
        <div className="skeleton h-4 w-2/3" />
        <div className="skeleton h-3 w-1/2" />
      </div>
    </div>
  );
}

// --- Estadísticas y beneficios --------------------------------------------------

export function StatCard({ icon: Icon, value, label }: { icon: LucideIcon; value: string; label: string }) {
  return (
    <div className="flex items-center gap-3.5 lg:justify-center">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-brand-500 shadow-card ring-1 ring-black/5">
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-[22px] font-extrabold leading-tight text-ink">{value}</span>
        <span className="block truncate text-sm text-muted">{label}</span>
      </span>
    </div>
  );
}

export function BenefitCard({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return (
    <div className="flex items-center gap-3.5 lg:justify-center">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-500">
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-bold text-ink">{title}</span>
        <span className="mt-0.5 block text-sm leading-snug text-muted">{description}</span>
      </span>
    </div>
  );
}

// --- Ofertas -----------------------------------------------------------------------

/**
 * Estado vacío de ofertas. No inventa promociones: dice con claridad que aún no hay
 * ninguna y de dónde saldrán cuando existan.
 */
export function EmptyOffers() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border bg-slate-50/70 px-6 py-6 text-center sm:flex-row sm:gap-4 sm:py-5 sm:text-left">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-brand-400 shadow-card ring-1 ring-black/5">
        <MapPin className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="font-semibold text-ink">No hay promociones activas por ahora</p>
        <p className="mt-0.5 text-sm text-muted">Cuando las empresas publiquen ofertas, aparecerán aquí.</p>
      </div>
    </div>
  );
}

/** Tarjeta de promoción real. El destacado va a la primera, como en el mockup. */
export function OfferCard({
  name,
  description,
  featured,
}: {
  name: string;
  description: string;
  featured: boolean;
}) {
  return (
    <div
      className={cn(
        'group relative flex min-h-[168px] flex-col justify-between overflow-hidden rounded-card p-6 transition duration-300 hover:shadow-elevated',
        featured
          ? 'bg-gradient-to-br from-brand-500 to-brand-600 text-white'
          : 'bg-white text-ink shadow-card ring-1 ring-black/5',
      )}
    >
      <div>
        <p className={cn('text-lg font-bold leading-snug', featured ? 'text-white' : 'text-ink')}>{name}</p>
        <p className={cn('mt-1.5 text-sm leading-relaxed', featured ? 'text-white/90' : 'text-muted')}>{description}</p>
      </div>

      <Link
        to="/ofertas"
        className={cn(
          'mt-5 inline-flex w-fit items-center gap-1.5 rounded-control px-4 py-2 text-sm font-semibold transition',
          featured ? 'bg-white text-brand-600 hover:bg-brand-50' : 'bg-brand-500 text-white hover:bg-brand-600',
        )}
      >
        Ver ofertas
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </Link>
    </div>
  );
}
