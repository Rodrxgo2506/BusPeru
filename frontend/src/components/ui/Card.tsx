import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={cn('card', padded && 'p-5', className)}>{children}</div>;
}

/**
 * `as` NO cambia nada visible: fija el nivel del encabezado.
 *
 * El valor por defecto (`h3`) sirve cuando la tarjeta cuelga de una sección con su propio `h2`. En
 * las pantallas donde el título de la tarjeta ES el de la sección —los dos paneles de inicio— el
 * documento saltaba de `h1` a `h3`; ahí se pasa `as="h2"` y el orden vuelve a ser continuo.
 */
export function CardHeader({ title, description, action, className, as: Heading = 'h3' }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string; as?: 'h2' | 'h3' }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <Heading className="text-base font-semibold text-ink">{title}</Heading>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  tone?: 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'purple';
  delta?: { value: string; positive: boolean } | null;
  hint?: string;
}

const TONES: Record<NonNullable<StatCardProps['tone']>, string> = {
  brand: 'bg-brand-100 text-brand-600',
  success: 'bg-success-100 text-success-600',
  warning: 'bg-warning-100 text-warning-600',
  danger: 'bg-danger-100 text-danger-600',
  info: 'bg-info-100 text-info-600',
  purple: 'bg-purple-100 text-purple-600',
};

export function StatCard({ label, value, icon, tone = 'brand', delta, hint }: StatCardProps) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Labels wrap instead of truncating: dense KPI grids leave little width per card. */}
          <p className="text-sm leading-snug text-muted">{label}</p>
          <p className="mt-1.5 text-2xl font-bold tracking-tight text-ink">{value}</p>
        </div>
        {icon && <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', TONES[tone])}>{icon}</span>}
      </div>
      {delta ? (
        <p className={cn('mt-3 text-xs font-medium', delta.positive ? 'text-success-600' : 'text-danger-600')}>
          {delta.positive ? '▲' : '▼'} {delta.value}
        </p>
      ) : hint ? (
        <p className="mt-3 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
