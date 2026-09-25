import { ChevronRight, Search } from 'lucide-react';
import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useBranding } from '@/context/BrandingContext';
import { initials } from '@/utils/format';
import { cn } from '@/utils/cn';

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: Array<{ label: string; to?: string }>;
  className?: string;
}) {
  return (
    <div className={cn('mb-6', className)}>
      {breadcrumbs && breadcrumbs.length > 0 && <Breadcrumbs items={breadcrumbs} className="mb-3" />}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {/* Algunas pantallas reutilizan esta cabecera solo por sus acciones y pasan `title=""`
              (p. ej. la tabla de ajustes, que ya tiene su propio título arriba). Antes eso dejaba un
              `<h1>` VACÍO en el documento: invisible en pantalla, pero un segundo encabezado de
              primer nivel sin texto para un lector de pantalla. */}
          {title ? <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-[28px]">{title}</h1> : null}
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Breadcrumbs({ items, className }: { items: Array<{ label: string; to?: string }>; className?: string }) {
  return (
    <nav aria-label="Ruta de navegación" className={cn('flex flex-wrap items-center gap-1.5 text-sm', className)}>
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <span key={`${item.label}-${index}`} className="flex items-center gap-1.5">
            {item.to && !isLast ? (
              <Link to={item.to} className="text-brand-600 transition hover:text-brand-700">
                {item.label}
              </Link>
            ) : (
              <span className={isLast ? 'font-medium text-slate-500' : 'text-brand-600'}>{item.label}</span>
            )}
            {!isLast && <ChevronRight className="h-3.5 w-3.5 text-slate-300" aria-hidden />}
          </span>
        );
      })}
    </nav>
  );
}

export function SearchBar({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
      <input
        type="search"
        className="h-11 w-full rounded-control border border-border bg-white pl-10 pr-3.5 text-sm text-ink placeholder:text-slate-400 transition focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        {...props}
      />
    </div>
  );
}

export function Avatar({
  firstName,
  lastName,
  src,
  size = 'md',
  className,
}: {
  firstName?: string | null;
  lastName?: string | null;
  src?: string | null;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const sizes = { sm: 'h-8 w-8 text-xs', md: 'h-10 w-10 text-sm', lg: 'h-12 w-12 text-base', xl: 'h-20 w-20 text-2xl' } as const;

  if (src) {
    return <img src={src} alt="" className={cn('rounded-full object-cover', sizes[size], className)} />;
  }
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700', sizes[size], className)}
      aria-hidden
    >
      {initials(firstName, lastName)}
    </span>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  /** `icon` es opcional: las pestañas que no lo pasan se pintan exactamente igual que antes. */
  tabs: Array<{ id: T; label: string; count?: number; icon?: ReactNode }>;
  active: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('scrollbar-none -mx-1 flex gap-1 overflow-x-auto border-b border-border', className)} role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            'relative inline-flex items-center gap-2 whitespace-nowrap px-4 py-3 text-sm font-medium transition',
            active === tab.id ? 'text-brand-600' : 'text-slate-500 hover:text-slate-800',
          )}
        >
          {tab.icon && (
            <span className="shrink-0 [&>svg]:h-[18px] [&>svg]:w-[18px]" aria-hidden>
              {tab.icon}
            </span>
          )}
          {tab.label}
          {tab.count !== undefined && (
            <span className={cn('ml-1.5 rounded-full px-1.5 py-0.5 text-xs', active === tab.id ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-500')}>
              {tab.count}
            </span>
          )}
          {active === tab.id && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-brand-500" />}
        </button>
      ))}
    </div>
  );
}

export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-3', className)}>{children}</div>;
}

export function Logo({
  variant = 'light',
  subtitle,
  onOrange = false,
}: {
  variant?: 'light' | 'dark';
  subtitle?: string;
  /** On the mobile orange app bar the mark inverts so it stays legible. */
  onOrange?: boolean;
}) {
  // FASE 17: si el ADMIN subió un logo, se usa; si falla la descarga, vuelve la marca de siempre.
  // FASE 17A: cada imagen falla por separado. Antes un logo móvil roto anulaba también un logo
  // principal válido. El móvil usa el principal si no hay (o si falla), y cada tamaño cae a la marca
  // de siempre solo cuando no le queda ninguna imagen utilizable.
  const { logoUrl, logoMobileUrl } = useBranding();
  const [mainFailed, setMainFailed] = useState(false);
  const [mobileFailed, setMobileFailed] = useState(false);
  useEffect(() => setMainFailed(false), [logoUrl]);
  useEffect(() => setMobileFailed(false), [logoMobileUrl]);

  const main = logoUrl && !mainFailed ? logoUrl : null;
  const mobile = logoMobileUrl && !mobileFailed ? logoMobileUrl : main;

  const defaultMark = (
    <span className="flex items-center gap-2">
      <span className={cn('flex h-9 w-9 items-center justify-center rounded-xl', onOrange ? 'bg-white text-brand-500 lg:bg-brand-500 lg:text-white' : 'bg-brand-500 text-white')}>
        <BusGlyph />
      </span>
      <span className="leading-none">
        <span
          className={cn(
            'block text-xl font-extrabold tracking-tight',
            variant === 'dark' ? 'text-white' : onOrange ? 'text-white lg:text-ink' : 'text-ink',
          )}
        >
          Bus<span className={onOrange ? 'text-white lg:text-brand-500' : 'text-brand-500'}>Perú</span>
        </span>
        {subtitle && <span className="mt-0.5 block text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">{subtitle}</span>}
      </span>
    </span>
  );

  if (!main && !mobile) return defaultMark;

  const brandedSubtitle = subtitle && <span className="mt-1 block text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">{subtitle}</span>;
  return (
    <>
      <span className="lg:hidden">
        {mobile ? (
          <span className="block leading-none">
            <img
              src={mobile}
              alt="BusPerú"
              onError={() => (mobile === logoMobileUrl ? setMobileFailed(true) : setMainFailed(true))}
              className="h-9 w-auto max-w-[150px] object-contain"
            />
            {brandedSubtitle}
          </span>
        ) : (
          defaultMark
        )}
      </span>
      <span className="hidden lg:block">
        {main ? (
          <span className="block leading-none">
            <img src={main} alt="BusPerú" onError={() => setMainFailed(true)} className="h-10 w-auto max-w-[190px] object-contain" />
            {brandedSubtitle}
          </span>
        ) : (
          defaultMark
        )}
      </span>
    </>
  );
}

function BusGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 17h16M6 17v2M18 17v2" />
      <rect x="3" y="5" width="18" height="12" rx="3" />
      <path d="M3 11h18M8 5v6M16 5v6" />
    </svg>
  );
}
