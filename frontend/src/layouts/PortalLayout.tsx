import { CheckCircle2, ChevronDown, HelpCircle, LogOut, Menu, Search, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { NotificationBell } from '@/layouts/PublicLayout';
import { RouteSuspense } from '@/components/common/RouteSuspense';
import { Avatar, Button, Logo } from '@/components/ui';
import { visibleNav, type NavItem } from '@/constants/navigation';
import { useAuth } from '@/context/AuthContext';
import { notificationService } from '@/services';
import { ROLE_LABELS } from '@/constants/labels';
import { cn } from '@/utils/cn';

interface PortalLayoutProps {
  items: NavItem[];
  theme: 'light' | 'dark';
  brandSubtitle?: string;
  searchPlaceholder?: string;
}

/**
 * Shared shell for the company (light sidebar) and admin (navy sidebar) portals.
 * The sidebar is built from the user's permissions, not from a static list.
 */
export function PortalLayout({ items, theme, brandSubtitle, searchPlaceholder }: PortalLayoutProps) {
  const { user, logout, hasPermission } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  const navItems = visibleNav(items, hasPermission);
  const isDark = theme === 'dark';

  useEffect(() => {
    setSidebarOpen(false);
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    notificationService
      .unreadCount()
      .then((result) => setUnread(result.unread))
      .catch(() => setUnread(0));
  }, [location.pathname]);

  const sections = navItems.reduce<Array<{ title: string | null; items: NavItem[] }>>((accumulator, item) => {
    const title = item.section ?? null;
    const last = accumulator[accumulator.length - 1];
    if (last && last.title === title) last.items.push(item);
    else accumulator.push({ title, items: [item] });
    return accumulator;
  }, []);

  const sidebar = (
    <div className={cn('flex h-full flex-col', isDark ? 'bg-admin-900 text-slate-300' : 'bg-white')}>
      <div className={cn('flex h-16 shrink-0 items-center justify-between px-5', isDark ? 'border-b border-white/5' : 'border-b border-border')}>
        <Link to={navItems[0]?.to ?? '/'}>
          <Logo variant={isDark ? 'dark' : 'light'} subtitle={brandSubtitle} />
        </Link>
        <button type="button" className="rounded-lg p-1.5 lg:hidden" onClick={() => setSidebarOpen(false)} aria-label="Cerrar menú">
          <X className="h-5 w-5" />
        </button>
      </div>

      <nav className="scrollbar-none flex-1 overflow-y-auto px-3 py-4" aria-label="Navegación del portal">
        {sections.map((section, index) => (
          <div key={section.title ?? `section-${index}`} className={index > 0 ? 'mt-5' : undefined}>
            {section.title && (
              <p className={cn('px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider', isDark ? 'text-slate-500' : 'text-slate-400')}>
                {section.title}
              </p>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-3 rounded-control px-3 py-2.5 text-sm font-medium transition',
                        isActive
                          ? isDark
                            ? 'bg-danger-600 text-white'
                            : 'bg-brand-500 text-white'
                          : isDark
                            ? 'text-slate-300 hover:bg-white/5 hover:text-white'
                            : 'text-slate-600 hover:bg-slate-100 hover:text-ink',
                      )
                    }
                  >
                    {item.icon}
                    <span className="truncate">{item.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className={cn('shrink-0 p-4', isDark ? 'border-t border-white/5' : 'border-t border-border')}>
        <div className={cn('rounded-card p-4', isDark ? 'bg-white/5' : 'bg-brand-50')}>
          <p className={cn('flex items-center gap-2 text-sm font-semibold', isDark ? 'text-white' : 'text-ink')}>
            <HelpCircle className="h-4 w-4" />
            ¿Necesitas ayuda?
          </p>
          <p className={cn('mt-1 text-xs', isDark ? 'text-slate-400' : 'text-muted')}>Estamos para apoyarte</p>
          <Button variant={isDark ? 'admin' : 'outline'} size="sm" fullWidth className="mt-3" to="/ayuda">
            Centro de ayuda
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-background">
      <aside className={cn('hidden w-64 shrink-0 lg:block', isDark ? 'bg-admin-900' : 'border-r border-border bg-white')}>
        <div className="sticky top-0 h-screen">{sidebar}</div>
      </aside>

      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button type="button" className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} aria-label="Cerrar menú" />
          <div className="relative h-full w-72 max-w-[85vw] animate-slide-in-right shadow-elevated">{sidebar}</div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-white px-4 sm:px-6">
          <button
            type="button"
            className="rounded-lg p-2 text-slate-600 transition hover:bg-slate-100 lg:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="Abrir menú"
          >
            <Menu className="h-5 w-5" />
          </button>

          {searchPlaceholder && (
            <div className="relative hidden min-w-0 flex-1 md:block lg:max-w-md">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                placeholder={searchPlaceholder}
                className="h-10 w-full rounded-control border border-border bg-slate-50 pl-10 pr-3 text-sm placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
            </div>
          )}

          <div className="ml-auto flex items-center gap-2">
            <Link
              to={isDark ? '/admin/notifications' : '/company/notifications'}
              className="relative rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
              aria-label={`Notificaciones${unread > 0 ? ` (${unread} sin leer)` : ''}`}
            >
              <NotificationBell count={unread} />
            </Link>

            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                className="flex items-center gap-2 rounded-control px-2 py-1.5 transition hover:bg-slate-100"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
              >
                <Avatar firstName={user?.first_name} lastName={user?.last_name} src={user?.avatar_url} size="sm" />
                <span className="hidden text-left sm:block">
                  <span className="block text-sm font-semibold leading-tight text-ink">
                    {user?.first_name} {user?.last_name}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-muted">
                    {ROLE_LABELS[user?.role ?? ''] ?? user?.role}
                    {user?.email_verified_at && <CheckCircle2 className="h-3 w-3 text-success-600" />}
                  </span>
                </span>
                <ChevronDown className="h-4 w-4 text-slate-400" />
              </button>

              {menuOpen && (
                <>
                  <button type="button" className="fixed inset-0 z-10 cursor-default" onClick={() => setMenuOpen(false)} aria-label="Cerrar menú" />
                  <div className="absolute right-0 z-20 mt-2 w-56 animate-slide-up rounded-card border border-border bg-white p-1.5 shadow-elevated" role="menu">
                    <div className="border-b border-border px-3 py-2">
                      <p className="truncate text-sm font-medium text-ink">{user?.email}</p>
                    </div>
                    <MenuLink to={isDark ? '/admin/settings' : '/company/settings'} label="Configuración" />
                    <MenuLink to="/customer/profile" label="Mi perfil" />
                    <button
                      type="button"
                      onClick={() => void logout().then(() => navigate(isDark ? '/admin/login' : '/empresa/login'))}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-danger-600 transition hover:bg-danger-50"
                      role="menuitem"
                    >
                      <LogOut className="h-4 w-4" />
                      Cerrar sesión
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
          {/* Solo el área de contenido muestra el indicador: cabecera y barra lateral se mantienen. */}
          <RouteSuspense>
            <Outlet />
          </RouteSuspense>
        </main>
      </div>
    </div>
  );
}

function MenuLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="block rounded-lg px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100" role="menuitem">
      {label}
    </Link>
  );
}

export function PortalPage({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1400px]">{children}</div>;
}
