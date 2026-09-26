import { ChevronRight } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { mediaUrl } from '@/services/api';
import { cn } from '@/utils/cn';

/**
 * F18-20 · banner de cada página del sitio de empresa: imagen propia de la empresa con velo oscuro, título centrado
 * y breadcrumb. Sin imagen, degradado BusPerú (naranja → tinta) con un patrón geométrico en CSS: nunca una imagen
 * externa ni de catálogo.
 */
export function CompanyPageHero({
  title,
  eyebrow,
  subtitle,
  image,
  breadcrumb,
  size = 'md',
  leading,
  children,
}: {
  title: ReactNode;
  eyebrow?: string;
  subtitle?: ReactNode;
  /** Referencia de medio propio (`public/...`); se resuelve con `mediaUrl`. */
  image?: string | null;
  breadcrumb?: Array<{ label: string; to?: string }>;
  size?: 'md' | 'lg';
  /** Pieza sobre el título (p. ej. el logo de la empresa en Inicio). */
  leading?: ReactNode;
  children?: ReactNode;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [image]);
  // Si la imagen propia no carga, el banner vuelve al degradado (nunca un ícono de imagen rota).
  const src = broken ? null : mediaUrl(image);
  return (
    <section
      className={cn(
        'relative isolate flex items-center overflow-hidden bg-ink text-white',
        size === 'lg' ? 'min-h-[420px] py-16 sm:min-h-[480px] lg:min-h-[520px]' : 'min-h-[240px] py-14 sm:min-h-[280px] sm:py-16',
      )}
    >
      {src ? (
        <>
          <img src={src} alt="" aria-hidden className="absolute inset-0 -z-20 h-full w-full object-cover" decoding="async" onError={() => setBroken(true)} />
          <div className="absolute inset-0 -z-10 bg-gradient-to-b from-ink/70 via-ink/55 to-ink/80" aria-hidden />
        </>
      ) : (
        <div className="absolute inset-0 -z-10 bg-gradient-to-br from-brand-600 via-brand-700 to-ink" aria-hidden>
          {/* Patrón geométrico suave (CSS puro): da textura al banner sin ninguna imagen. */}
          <div className="absolute inset-0 opacity-[0.12] [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:22px_22px]" />
          <div className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-2xl" />
          <div className="absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-ink/40 blur-3xl" />
        </div>
      )}

      <div className="mx-auto w-full max-w-4xl px-4 text-center sm:px-6">
        {breadcrumb && breadcrumb.length > 0 && (
          <nav aria-label="Ruta de navegación" className="mb-4 flex justify-center">
            <ol className="flex flex-wrap items-center justify-center gap-1.5 rounded-full bg-white/10 px-4 py-1.5 text-sm backdrop-blur-sm">
              {breadcrumb.map((item, index) => {
                const last = index === breadcrumb.length - 1;
                return (
                  <li key={`${item.label}-${index}`} className="flex items-center gap-1.5">
                    {item.to && !last ? (
                      <Link to={item.to} className="text-white/85 underline-offset-4 transition hover:text-white hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-white">
                        {item.label}
                      </Link>
                    ) : (
                      <span className="font-semibold text-white" aria-current={last ? 'page' : undefined}>{item.label}</span>
                    )}
                    {!last && <ChevronRight className="h-3.5 w-3.5 text-white/60" aria-hidden />}
                  </li>
                );
              })}
            </ol>
          </nav>
        )}
        {leading && <div className="mb-5 flex justify-center">{leading}</div>}
        {eyebrow && <p className="text-xs font-bold uppercase tracking-[0.2em] text-brand-200">{eyebrow}</p>}
        <h1 className={cn('mt-2 break-words font-extrabold tracking-tight drop-shadow-sm', size === 'lg' ? 'text-4xl sm:text-5xl lg:text-6xl' : 'text-3xl sm:text-4xl lg:text-5xl')}>
          {title}
        </h1>
        {subtitle && <div className="mx-auto mt-4 max-w-2xl text-base text-white/85 sm:text-lg">{subtitle}</div>}
        {children && <div className="mt-7 flex flex-wrap items-center justify-center gap-3">{children}</div>}
      </div>
    </section>
  );
}
