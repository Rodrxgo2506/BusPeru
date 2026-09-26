import { Building2, Menu, Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { mediaUrl } from '@/services/api';
import { companySiteNav, companySitePath } from '@/utils/company-site';
import { cn } from '@/utils/cn';

/**
 * F18-20 · cabecera propia del sitio de la empresa. Va DEBAJO de la cabecera global de BusPerú (que sigue siendo la
 * del portal) y se distingue de ella: barra oscura con el logo y el nombre de la empresa, su menú interno y dos
 * acciones. Pegajosa bajo la global (`top-16`/`lg:top-[72px]`, `z-30` < `z-40`). En móvil el menú se despliega.
 */
export function CompanySiteHeader({ slug, name, logo, tripsUrl }: { slug: string; name: string; logo: string | null; tripsUrl: string }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const nav = companySiteNav(slug);
  const logoSrc = mediaUrl(logo);

  // Al navegar, el menú móvil se cierra.
  useEffect(() => setOpen(false), [location.pathname]);

  // Escape cierra el menú y devuelve el foco al botón que lo abrió.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'relative whitespace-nowrap rounded-md px-2.5 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 xl:px-3',
      isActive ? 'text-white' : 'text-slate-300 hover:text-white',
    );

  return (
    <div className="sticky top-16 z-30 border-b border-white/10 bg-ink/95 text-white shadow-lg shadow-ink/10 backdrop-blur lg:top-[72px]">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Link
          to={companySitePath(slug)}
          className="flex min-w-0 items-center gap-2.5 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          aria-label={`Inicio de ${name}`}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white">
            {logoSrc ? <img src={logoSrc} alt="" className="max-h-full max-w-full object-contain p-1" /> : <Building2 className="h-5 w-5 text-brand-500" aria-hidden />}
          </span>
          <span className="truncate text-sm font-bold sm:text-base lg:max-w-[9rem] xl:max-w-[14rem]">{name}</span>
        </Link>

        <nav aria-label={`Secciones de ${name}`} className="ml-auto hidden lg:block">
          <ul className="flex items-center">
            {nav.map((item) => (
              <li key={item.id}>
                <NavLink to={item.to} end={item.end} className={linkClass}>
                  {({ isActive }) => (
                    <>
                      {item.label}
                      <span className={cn('absolute inset-x-2.5 -bottom-[9px] h-[3px] rounded-full bg-brand-500 transition-opacity xl:inset-x-3', isActive ? 'opacity-100' : 'opacity-0')} aria-hidden />
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-2 lg:ml-3">
          <Link
            to={tripsUrl}
            className="hidden h-9 items-center gap-1.5 rounded-control bg-brand-500 px-3 text-sm font-semibold text-white transition hover:bg-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-white sm:inline-flex"
          >
            <Search className="h-4 w-4" aria-hidden /> Buscar viajes
          </Link>
          <Link
            to={companySitePath(slug, 'contacto')}
            className="hidden h-9 items-center rounded-control border border-white/30 px-3 text-sm font-semibold text-white transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white xl:inline-flex"
          >
            Contacto
          </Link>
          <button
            ref={buttonRef}
            type="button"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-white transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 lg:hidden"
            aria-expanded={open}
            aria-controls={menuId}
            aria-label={open ? `Cerrar el menú de ${name}` : `Abrir el menú de ${name}`}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
          </button>
        </div>
      </div>

      <div id={menuId} hidden={!open} className="border-t border-white/10 bg-ink lg:hidden">
        <nav aria-label={`Secciones de ${name} (móvil)`} className="mx-auto max-w-7xl px-4 py-3 sm:px-6">
          <ul className="grid grid-cols-2 gap-1 sm:grid-cols-4">
            {nav.map((item) => (
              <li key={item.id}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      'block rounded-lg px-3 py-2.5 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
                      isActive ? 'bg-brand-500 text-white' : 'text-slate-200 hover:bg-white/10',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
          <div className="mt-3 border-t border-white/10 pt-3 sm:hidden">
            <Link to={tripsUrl} className="flex h-11 items-center justify-center gap-2 rounded-control bg-brand-500 text-sm font-semibold text-white hover:bg-brand-600">
              <Search className="h-4 w-4" aria-hidden /> Buscar viajes
            </Link>
          </div>
        </nav>
      </div>
    </div>
  );
}
