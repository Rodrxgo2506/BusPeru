import {
  BadgeCheck as BadgeCheckIcon,
  Gift as GiftIcon,
  Headphones as HeadphonesIcon,
  Lock as LockIcon,
  User as UserIcon,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Button, Logo } from '@/components/ui';
import { PUBLIC_NAV_LINKS } from '@/constants/navigation';
import { authImages } from '@/constants/images';
import { useAsync } from '@/hooks/useAsync';
import { oauthService } from '@/services';
import { cn } from '@/utils/cn';

export interface AuthBenefit {
  icon: LucideIcon;
  title: string;
  description: string;
}

/** Franja inferior de confianza, común a las tres pantallas de las referencias. */
const DEFAULT_TRUST: Array<{ icon: LucideIcon; title: string; description: string }> = [
  { icon: HeadphonesIcon, title: 'Atención 24/7', description: 'Estamos para ayudarte' },
  { icon: LockIcon, title: 'Pagos 100% seguros', description: 'Tus datos protegidos' },
  { icon: BadgeCheckIcon, title: 'Empresas verificadas', description: 'Viaja con confianza' },
];

/**
 * Cabecera de las pantallas de autenticación.
 *
 * Reproduce la del layout público —mismos enlaces, tomados de `PUBLIC_NAV_LINKS`— porque
 * estas rutas viven fuera de los layouts con navegación. **No añade ningún enlace ni acción
 * que no exista ya en la aplicación.**
 */
function AuthHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-white/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6 lg:h-[72px] lg:px-8">
        <Link to="/" aria-label="Ir al inicio de BusPerú" className="shrink-0">
          <Logo />
        </Link>

        <nav className="hidden flex-1 items-center justify-center gap-1 lg:flex" aria-label="Navegación principal">
          {PUBLIC_NAV_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.to === '/'}
              className={({ isActive }) =>
                cn(
                  'rounded-lg px-3 py-2 text-sm font-medium transition',
                  isActive ? 'text-brand-600' : 'text-slate-600 hover:bg-slate-50 hover:text-ink',
                )
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link
            to="/customer/trips"
            className="hidden items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-ink sm:flex"
          >
            <GiftIcon className="h-[18px] w-[18px] text-brand-500" />
            Mis viajes
          </Link>
          <Button variant="outline" size="sm" icon={<UserIcon className="h-4 w-4" />} to="/login">
            Iniciar sesión
          </Button>
          <Button variant="primary" size="sm" to="/registro" className="hidden md:inline-flex">
            Registrarse
          </Button>
        </div>
      </div>
    </header>
  );
}

export interface AuthPromo {
  /** Línea pequeña en versalitas sobre el titular de la tarjeta. */
  label: string;
  /** Dos líneas de titular. */
  lines: [string, string];
}

/**
 * Tarjeta naranja decorativa de las referencias. **No lleva ninguna acción**: es un
 * remate visual de la columna izquierda, no un botón ni un enlace.
 */
function PromoCard({ promo }: { promo: AuthPromo }) {
  return (
    <div className="mt-8 hidden overflow-hidden rounded-card bg-gradient-to-br from-brand-500 to-brand-600 p-6 text-white shadow-elevated lg:block">
      <div className="flex items-center gap-5">
        <BusGlyph />
        <span className="h-14 w-px bg-white/30" aria-hidden />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/85">{promo.label}</p>
          <p className="mt-1 text-xl font-bold leading-snug">
            {promo.lines[0]}
            <br />
            {promo.lines[1]}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Cascarón compartido por inicio de sesión, registro y recuperación de contraseña.
 *
 * Reproduce la composición de las referencias: fotografía a sangre muy velada, columna
 * izquierda con antetítulo, titular a dos líneas —la marca en naranja—, lista de ventajas y
 * tarjeta naranja; columna derecha con el formulario en una tarjeta blanca elevada; y una
 * franja de confianza al pie.
 *
 * Es solo estructura: cada pantalla sigue aportando su propio formulario y su lógica.
 */
export function AuthShell({
  eyebrow,
  title,
  highlight,
  subtitle,
  benefits,
  promo,
  children,
  footerNote,
  trustItems = DEFAULT_TRUST,
}: {
  eyebrow?: string;
  title: string;
  highlight?: string;
  subtitle: string;
  benefits: AuthBenefit[];
  promo?: AuthPromo;
  children: ReactNode;
  footerNote?: ReactNode;
  trustItems?: Array<{ icon: LucideIcon; title: string; description: string }>;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <AuthHeader />

      <main className="relative isolate flex-1">
        {/* Fotografía de fondo. Va detrás de todo y muy velada: el contenido nunca depende
            de que cargue, porque el texto descansa sobre el propio velo, no sobre la foto. */}
        <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          <picture>
            <source media="(max-width: 640px)" srcSet={authImages.backgroundSmall} />
            <img
              src={authImages.background}
              alt=""
              aria-hidden
              className="h-full w-full object-cover object-[60%_62%]"
              loading="eager"
              decoding="async"
            />
          </picture>

          {/* En móvil el velo es casi opaco: ahí el formulario ocupa toda la pantalla. */}
          <div className="absolute inset-0 bg-white/[0.93] lg:hidden" aria-hidden />
          {/* En escritorio se abre hacia la derecha, que es donde la referencia deja ver la foto. */}
          <div
            className="absolute inset-0 hidden bg-gradient-to-r from-white from-20% via-white/70 via-55% to-white/5 lg:block"
            aria-hidden
          />
          <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-white to-transparent" aria-hidden />
        </div>

        <div className="mx-auto grid max-w-7xl items-start gap-10 px-4 py-10 sm:px-6 lg:grid-cols-2 lg:gap-14 lg:px-8 lg:py-16">
          <section className="order-2 lg:order-1">
            {eyebrow && (
              <p className="mb-3 flex items-center gap-3 text-sm font-semibold text-brand-600">
                <span className="h-px w-7 bg-brand-500" aria-hidden />
                {eyebrow}
              </p>
            )}

            <h1 className="text-3xl font-extrabold leading-[1.1] tracking-tight text-ink sm:text-4xl lg:text-[2.75rem]">
              {title}
              {highlight && (
                <>
                  <br />
                  <span className="text-brand-500">{highlight}</span>
                </>
              )}
            </h1>

            <p className="mt-4 max-w-md text-base leading-relaxed text-slate-600 lg:text-lg">{subtitle}</p>

            <ul className="mt-8 space-y-5">
              {benefits.map((benefit) => {
                const Icon = benefit.icon;
                return (
                  <li key={benefit.title} className="flex gap-4">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-500">
                      <Icon className="h-5 w-5" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[15px] font-bold text-ink">{benefit.title}</span>
                      <span className="mt-0.5 block max-w-sm text-sm leading-snug text-muted">{benefit.description}</span>
                    </span>
                  </li>
                );
              })}
            </ul>

            {promo && <PromoCard promo={promo} />}
          </section>

          <section className="order-1 lg:order-2">
            <div className="mx-auto w-full max-w-[440px] rounded-card border border-border/70 bg-white p-6 shadow-elevated sm:p-8">
              {children}
            </div>
            {footerNote && <div className="mx-auto mt-4 max-w-[440px] text-center text-sm text-muted">{footerNote}</div>}
          </section>
        </div>
      </main>

      <div className="border-t border-border bg-slate-50">
        <ul className="mx-auto grid max-w-7xl gap-5 px-4 py-6 sm:grid-cols-3 sm:px-6 lg:px-8">
          {trustItems.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.title} className="flex items-center gap-3 sm:justify-center">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-500">
                  <Icon className="h-[18px] w-[18px]" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-ink">{item.title}</span>
                  <span className="block text-sm text-muted">{item.description}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** Cabecera del formulario: título y subtítulo, como en las tres referencias. */
export function AuthCardHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6 text-center">
      <h2 className="text-2xl font-bold text-ink">{title}</h2>
      <p className="mt-1 text-sm text-muted">{subtitle}</p>
    </div>
  );
}

function BusGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-12 w-12 shrink-0 text-white"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 17h16M6 17v2M18 17v2" />
      <rect x="3" y="5" width="18" height="12" rx="3" />
      <path d="M3 11h18M8 5v6M16 5v6" />
    </svg>
  );
}

export function AuthError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mb-4 rounded-control border border-danger-200 bg-danger-50 p-3 text-sm text-danger-700" role="alert">
      {message}
    </div>
  );
}

export function AuthDivider({ label = 'o continúa con' }: { label?: string }) {
  return (
    <div className="my-5 flex items-center gap-3">
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs text-muted">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * Botones de "Continuar con…" (mockups 8, 12 y 30).
 *
 * Son reales: navegan al backend, que conduce el flujo Authorization Code + PKCE. No es
 * una llamada AJAX sino una navegación de primer nivel, porque el siguiente paso es la
 * pantalla de consentimiento del proveedor.
 *
 * Un proveedor sin credenciales configuradas en el servidor sencillamente NO se pinta: es
 * preferible no ofrecer la opción a mostrar un botón que va a fallar.
 */
export function OAuthButtons({
  providers = ['GOOGLE'],
  scope,
}: {
  providers?: OAuthProviderName[];
  /** Portal desde el que se inicia. Solo puede restringir: el rol lo decide el backend. */
  scope: 'CUSTOMER' | 'COMPANY' | 'ADMIN';
}) {
  const available = useAsync(() => oauthService.providers(), []);

  // Mientras se comprueba la configuración no se pinta nada, para no mostrar y esconder.
  if (available.loading || available.error) return null;

  const configured = providers.filter(
    (provider) => available.data?.some((entry) => entry.provider === provider && entry.configured),
  );
  if (configured.length === 0) return null;

  return (
    <>
      <AuthDivider />
      <div className={cn('grid gap-3', configured.length > 1 && 'sm:grid-cols-2')}>
        {configured.map((provider) => (
          <a
            key={provider}
            href={oauthService.startUrl(provider, scope)}
            className="flex h-11 items-center justify-center gap-2 rounded-control border border-border bg-white text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            <ProviderGlyph provider={PROVIDER_LABELS[provider]} />
            Continuar con {PROVIDER_LABELS[provider]}
          </a>
        ))}
      </div>
    </>
  );
}

export type OAuthProviderName = 'GOOGLE' | 'MICROSOFT';

export const PROVIDER_LABELS: Record<OAuthProviderName, string> = {
  GOOGLE: 'Google',
  MICROSOFT: 'Microsoft',
};

function ProviderGlyph({ provider }: { provider: string }) {
  if (provider === 'Microsoft') {
    return (
      <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
        <rect x="1" y="1" width="8" height="8" fill="#F25022" />
        <rect x="11" y="1" width="8" height="8" fill="#7FBA00" />
        <rect x="1" y="11" width="8" height="8" fill="#00A4EF" />
        <rect x="11" y="11" width="8" height="8" fill="#FFB900" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.9z" />
      <path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.4 14.4a7.2 7.2 0 0 1 0-4.6V6.7H1.4a12 12 0 0 0 0 10.8l4-3.1z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.5 1.8l3.4-3.4C17.9 1.2 15.2 0 12 0A12 12 0 0 0 1.4 6.7l4 3.1C6.3 6.9 8.9 4.8 12 4.8z" />
    </svg>
  );
}
