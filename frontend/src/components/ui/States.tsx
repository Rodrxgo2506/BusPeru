import { AlertTriangle, Inbox, Loader2, Lock, ServerCrash, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '@/services/api';
import { cn } from '@/utils/cn';
import { Button } from './Button';

export function LoadingState({ label = 'Cargando...', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 py-16 text-center', className)} role="status">
      <Loader2 className="h-8 w-8 animate-spin text-brand-500" aria-hidden />
      <p className="text-sm text-muted">{label}</p>
    </div>
  );
}

export function TableSkeleton({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-3 p-5" aria-hidden>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-4">
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <div key={columnIndex} className={cn('skeleton h-5', columnIndex === 0 ? 'w-1/4' : 'flex-1')} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="card space-y-3 p-5">
          <div className="skeleton h-4 w-1/3" />
          <div className="skeleton h-7 w-1/2" />
          <div className="skeleton h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-16 text-center', className)}>
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        {icon ?? <Inbox className="h-7 w-7" />}
      </span>
      <div>
        <p className="text-base font-semibold text-ink">{title}</p>
        {description && <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** Renders network / permission / server failures differently, as the mockups' state guide shows. */
export function ErrorState({ error, onRetry, className }: { error: ApiError | Error | null; onRetry?: () => void; className?: string }) {
  const apiError = error instanceof ApiError ? error : null;

  let icon = <ServerCrash className="h-7 w-7" />;
  let title = 'Algo salió mal';
  let description = error?.message ?? 'No pudimos completar la operación. Inténtalo nuevamente.';

  if (apiError?.isNetworkError) {
    icon = <WifiOff className="h-7 w-7" />;
    title = 'Sin conexión con el servidor';
    description = 'Verifica que el backend esté ejecutándose y que tu conexión funcione.';
  } else if (apiError?.isForbidden) {
    icon = <Lock className="h-7 w-7" />;
    title = 'No tienes permisos';
    description = apiError.message;
  } else if (apiError?.status === 404) {
    icon = <AlertTriangle className="h-7 w-7" />;
    title = 'No encontrado';
  }

  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-16 text-center', className)} role="alert">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-danger-50 text-danger-600">{icon}</span>
      <div>
        <p className="text-base font-semibold text-ink">{title}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">{description}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Reintentar
        </Button>
      )}
    </div>
  );
}

export function PermissionDenied() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-danger-50 text-danger-600">
        <Lock className="h-8 w-8" />
      </span>
      <div>
        <h1 className="text-2xl font-bold text-ink">No tienes permisos</h1>
        <p className="mt-2 max-w-md text-muted">
          Tu rol no tiene acceso a esta sección. Si crees que es un error, contacta con el administrador de tu cuenta.
        </p>
      </div>
      <Link to="/">
        <Button variant="primary">Volver al inicio</Button>
      </Link>
    </div>
  );
}
