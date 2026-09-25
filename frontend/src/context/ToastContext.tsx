import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/utils/cn';

type ToastVariant = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: number;
  variant: ToastVariant;
  title: string;
  description?: string;
}

interface ToastContextValue {
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  warning: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const VARIANT_STYLES: Record<ToastVariant, { icon: typeof CheckCircle2; className: string; iconClass: string }> = {
  success: { icon: CheckCircle2, className: 'border-success-500/30 bg-white', iconClass: 'text-success-600' },
  error: { icon: XCircle, className: 'border-danger-500/30 bg-white', iconClass: 'text-danger-600' },
  warning: { icon: AlertTriangle, className: 'border-warning-500/30 bg-white', iconClass: 'text-warning-600' },
  info: { icon: Info, className: 'border-info-500/30 bg-white', iconClass: 'text-info-600' },
};

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (variant: ToastVariant, title: string, description?: string) => {
      const id = nextId++;
      setToasts((current) => [...current, { id, variant, title, description }]);
      window.setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      success: (title, description) => push('success', title, description),
      error: (title, description) => push('error', title, description),
      warning: (title, description) => push('warning', title, description),
      info: (title, description) => push('info', title, description),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Por debajo de `lg` el armazón público ocupa la parte baja de la pantalla con la barra de
          navegación inferior (60 px) y el botón flotante de WhatsApp (hasta 144 px desde el borde).
          Un aviso anclado a `bottom-4` quedaba TAPADO por ellos justo cuando más importa: al fallar
          un formulario. Por eso arranca por encima de ambos y solo vuelve a la esquina en `lg`,
          donde ni la barra ni el botón están en esa posición. */}
      <div className="pointer-events-none fixed inset-x-4 bottom-[9.5rem] z-[100] flex flex-col gap-3 lg:inset-x-auto lg:bottom-4 lg:right-4 lg:w-full lg:max-w-sm" role="region" aria-live="polite">
        {toasts.map((toast) => {
          const style = VARIANT_STYLES[toast.variant];
          const Icon = style.icon;
          return (
            <div
              key={toast.id}
              className={cn('pointer-events-auto flex animate-slide-in-right items-start gap-3 rounded-card border p-4 shadow-elevated', style.className)}
              role="alert"
            >
              <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', style.iconClass)} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">{toast.title}</p>
                {toast.description && <p className="mt-0.5 text-sm text-muted">{toast.description}</p>}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                aria-label="Cerrar notificación"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast debe usarse dentro de ToastProvider');
  return context;
}
