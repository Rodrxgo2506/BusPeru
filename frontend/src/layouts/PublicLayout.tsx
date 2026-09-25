import { Bell, Gift, Home, Menu, Search, Ticket, User, X } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { RouteSuspense } from '@/components/common/RouteSuspense';
import { WhatsAppButton } from '@/components/common/WhatsAppButton';
import { Button, Logo } from '@/components/ui';
import { PUBLIC_NAV_LINKS as NAV_LINKS } from '@/constants/navigation';
import { useAuth } from '@/context/AuthContext';
import { homePathFor } from '@/guards';
import { cn } from '@/utils/cn';

const MOBILE_TABS = [
  { label: 'Inicio', to: '/', icon: Home },
  { label: 'Buscar', to: '/buscar', icon: Search },
  { label: 'Mis viajes', to: '/customer/trips', icon: Ticket },
  { label: 'Ofertas', to: '/ofertas', icon: Gift },
  { label: 'Perfil', to: '/customer/profile', icon: User },
];

/** Mockups 3–7: en móvil las pantallas de compra y de cliente usan una cabecera naranja. */
const ORANGE_HEADER_PREFIXES = ['/viaje/', '/reserva/', '/customer'];

export function PublicLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const orangeOnMobile = ORANGE_HEADER_PREFIXES.some((prefix) => location.pathname.startsWith(prefix));

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header
        className={cn(
          'sticky top-0 z-40 border-b backdrop-blur transition-colors',
          orangeOnMobile ? 'border-brand-600 bg-brand-500 lg:border-border lg:bg-white/95' : 'border-border bg-white/95',
        )}
      >
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6 lg:h-[72px] lg:px-8">
          <Link to="/" aria-label="Ir al inicio de BusPerú" className="shrink-0">
            <Logo onOrange={orangeOnMobile} />
          </Link>

          {/* Navegación centrada en escritorio, como en el mockup. */}
          <nav className="hidden flex-1 items-center justify-center gap-1 lg:flex" aria-label="Navegación principal">
            {NAV_LINKS.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.to === '/'}
                className={({ isActive }) =>
                  cn(
                    'relative rounded-lg px-3 py-2 text-sm font-medium transition',
                    isActive ? 'text-brand-600' : 'text-slate-600 hover:bg-slate-50 hover:text-ink',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {link.label}
                    {isActive && <span className="absolute inset-x-3 -bottom-0.5 h-0.5 rounded-full bg-brand-500" />}
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <Link
              to="/customer/trips"
              className="hidden items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-ink sm:flex"
            >
              <Gift className="h-[18px] w-[18px] text-brand-500" />
              Mis viajes
            </Link>

            {user ? (
              <div className="hidden items-center gap-2 sm:flex">
                <Link
                  to={homePathFor(user.role)}
                  className="flex items-center gap-2 rounded-control border border-brand-200 px-3 py-2 text-sm font-semibold text-brand-600 transition hover:bg-brand-50"
                >
                  <User className="h-4 w-4" />
                  Hola, {user.first_name}
                </Link>
                <Button variant="ghost" size="sm" onClick={() => void logout().then(() => navigate('/'))}>
                  Salir
                </Button>
              </div>
            ) : (
              // El mockup separa las dos acciones: entrar (secundaria) y registrarse (principal).
              <div className="hidden items-center gap-2 sm:flex">
                <Button variant="outline" size="sm" icon={<User className="h-4 w-4" />} to="/login">
                  Iniciar sesión
                </Button>
                <Button variant="primary" size="sm" to="/registro" className="hidden md:inline-flex">
                  Registrarse
                </Button>
              </div>
            )}

            <button
              type="button"
              className={cn(
                'rounded-lg p-2 transition lg:hidden',
                orangeOnMobile ? 'text-white hover:bg-white/15' : 'text-slate-600 hover:bg-slate-100',
              )}
              onClick={() => setMenuOpen((open) => !open)}
              aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}
              aria-expanded={menuOpen}
            >
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {menuOpen && (
          <div className="animate-slide-up border-t border-border bg-white lg:hidden">
            <nav className="mx-auto max-w-7xl px-4 py-3" aria-label="Navegación móvil">
              {NAV_LINKS.map((link) => (
                <NavLink
                  key={link.to}
                  to={link.to}
                  end={link.to === '/'}
                  onClick={() => setMenuOpen(false)}
                  className={({ isActive }) =>
                    cn('block rounded-lg px-3 py-2.5 text-sm font-medium', isActive ? 'bg-brand-50 text-brand-600' : 'text-slate-700 hover:bg-slate-50')
                  }
                >
                  {link.label}
                </NavLink>
              ))}
              <NavLink
                to="/customer/trips"
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'block rounded-lg px-3 py-2.5 text-sm font-medium',
                    isActive ? 'bg-brand-50 text-brand-600' : 'text-slate-700 hover:bg-slate-50',
                  )
                }
              >
                Mis viajes
              </NavLink>
              <div className="mt-3 flex gap-2 border-t border-border pt-3">
                {user ? (
                  <>
                    <Button variant="outline" fullWidth to={homePathFor(user.role)} onClick={() => setMenuOpen(false)}>
                      Mi cuenta
                    </Button>
                    <Button variant="secondary" fullWidth onClick={() => void logout()}>
                      Salir
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" fullWidth to="/login" onClick={() => setMenuOpen(false)}>
                      Iniciar sesión
                    </Button>
                    <Button variant="primary" fullWidth to="/registro" onClick={() => setMenuOpen(false)}>
                      Crear cuenta
                    </Button>
                  </>
                )}
              </div>
            </nav>
          </div>
        )}
      </header>

      <main className="flex-1 pb-16 lg:pb-0">
        {/* El límite de carga vive aquí y no sobre `<Routes>`: la cabecera y el pie no se despintan. */}
        <RouteSuspense>
          <Outlet />
        </RouteSuspense>
      </main>

      <PublicFooter />

      {/* F17C-UI-05 · contacto flotante. Solo en el armazón público: el panel ADMIN no lo muestra. */}
      <WhatsAppButton />

      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-white lg:hidden" aria-label="Navegación inferior">
        {MOBILE_TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.to === '/'}
              className={({ isActive }) =>
                cn('flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium', isActive ? 'text-brand-600' : 'text-slate-500')
              }
            >
              <Icon className="h-5 w-5" />
              {tab.label}
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}

function PublicFooter() {
  return (
    <footer className="relative isolate overflow-hidden border-t border-border bg-slate-50">
      {/*
        Silueta de cordillera, puramente decorativa: llena el aire del pie sin competir con
        el contenido ni añadir nada en lo que se pueda hacer clic.
      */}
      <AndesSilhouette />

      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-9 sm:px-6 md:grid-cols-2 lg:grid-cols-4 lg:px-8 lg:py-10">
        <div className="lg:pr-6">
          <Logo />
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted">
            Compra tus pasajes de bus interprovincial en todo el Perú de forma rápida, segura y al mejor precio.
          </p>
        </div>
        <FooterColumn
          title="Explorar"
          links={[
            { label: 'Destinos', to: '/destinos' },
            { label: 'Empresas', to: '/empresas' },
            { label: 'Ofertas', to: '/ofertas' },
          ]}
        />
        <FooterColumn
          title="Ayuda"
          links={[
            { label: 'Centro de ayuda', to: '/ayuda' },
            { label: 'Mis viajes', to: '/customer/trips' },
            { label: 'Contactar soporte', to: '/customer/support' },
          ]}
        />
        <FooterColumn
          title="Empresas"
          links={[
            { label: 'Portal Empresa', to: '/empresa/login' },
            { label: 'Registrar mi empresa', to: '/empresa/registro' },
          ]}
        />
      </div>
      <div className="border-t border-border">
        <p className="mx-auto max-w-7xl px-4 py-3.5 text-center text-xs text-muted sm:px-6 lg:px-8">
          © {new Date().getFullYear()} BusPerú. Todos los derechos reservados.
        </p>
      </div>
    </footer>
  );
}

/** Decoración del pie. Sin texto, sin enlaces y fuera del árbol de accesibilidad. */
function AndesSilhouette() {
  return (
    /* Solo en escritorio: en móvil el pie es una columna alta y la silueta se cruzaría con
       los enlaces, que es justo lo que una decoración no debe hacer. */
    <svg
      viewBox="0 0 1440 160"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 hidden h-32 w-full text-brand-200/40 lg:block"
      fill="currentColor"
      aria-hidden
    >
      {/* Coordenadas absolutas y cierre en x=1440: con deltas relativos el perfil se cortaba
          antes del borde derecho y dejaba un escalón visible. */}
      <path d="M0 160V104L160 60L300 96L470 42L640 108L820 56L1010 112L1200 64L1440 106V160Z" />
      <path
        d="M0 160V132L210 96L390 128L560 86L760 134L940 104L1140 140L1320 112L1440 132V160Z"
        className="text-brand-300/35"
        fill="currentColor"
      />
    </svg>
  );
}

function FooterColumn({ title, links }: { title: string; links: Array<{ label: string; to: string }> }) {
  return (
    <div>
      {/* `h2` y no `h3`: en páginas cuyo contenido no usa `h2` —/ayuda, /ofertas— el pie saltaba de
          `h1` a `h3` y un lector de pantalla anunciaba un nivel inexistente. */}
      <h2 className="text-xs font-bold uppercase tracking-wider text-ink">{title}</h2>
      <ul className="mt-3 space-y-2">
        {links.map((link) => (
          <li key={link.to}>
            <Link to={link.to} className="text-sm text-muted transition hover:text-brand-600">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function NotificationBell({ count }: { count: number }) {
  return (
    <span className="relative">
      <Bell className="h-5 w-5" />
      {count > 0 && (
        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger-600 px-1 text-[10px] font-bold text-white">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </span>
  );
}
