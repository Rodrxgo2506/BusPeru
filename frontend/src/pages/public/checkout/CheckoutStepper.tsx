import { Check, Clock3, Lock, RotateCcw, Tag } from 'lucide-react';
import { TARJETA_FLOTANTE } from '@/components/common/TravelBackdrop';
import { cn } from '@/utils/cn';

const STEPS = ['Buscar', 'Resultados', 'Asientos', 'Pasajeros', 'Pago', 'Confirmación'] as const;

/**
 * Mockups 3–6: previous steps stay as grey numbered circles (not check marks); only the
 * current step is orange, and the last step shows a check once the purchase is confirmed.
 */
export function CheckoutStepper({ current }: { current: number }) {
  return (
    <nav aria-label="Progreso de la compra" className="mb-6 overflow-x-auto scrollbar-none">
      <ol className="flex min-w-max items-center gap-1.5 sm:gap-2">
        {STEPS.map((label, index) => {
          const step = index + 1;
          const isCurrent = step === current;
          const isDone = step < current;
          const showCheck = isCurrent && step === STEPS.length;

          return (
            <li key={label} className="flex items-center gap-1.5 sm:gap-2">
              {index > 0 && <span className={cn('h-px w-5 sm:w-12', isDone || isCurrent ? 'bg-brand-500' : 'bg-border')} />}
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold transition',
                    isCurrent ? 'bg-brand-500 text-white' : 'bg-slate-200 text-slate-500',
                  )}
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  {showCheck ? <Check className="h-4 w-4" strokeWidth={3} /> : step}
                </span>
                <span className={cn('whitespace-nowrap text-xs font-medium sm:text-sm', isCurrent ? 'font-semibold text-brand-600' : 'text-slate-500')}>
                  {label}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const TRUST_ITEMS = [
  { icon: Lock, title: 'Pago 100% seguro', description: 'Tus datos protegidos' },
  { icon: RotateCcw, title: 'Cancelación flexible', description: 'Hasta 24h antes del viaje' },
  { icon: Clock3, title: 'Atención 24/7', description: 'Siempre para ayudarte' },
  { icon: Tag, title: 'Mejores precios', description: 'Encuentra las mejores ofertas' },
];

/** Footer strip repeated across the checkout mockups: orange outlined circular icons. */
export function TrustBar({ className }: { className?: string }) {
  return (
    <div className={cn('mt-6 rounded-card border', TARJETA_FLOTANTE, className)}>
      <ul className="grid gap-5 p-5 sm:grid-cols-2 lg:grid-cols-4">
        {TRUST_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.title} className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-brand-200 bg-brand-50 text-brand-500">
                <Icon className="h-[18px] w-[18px]" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">{item.title}</span>
                <span className="block text-sm text-muted">{item.description}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
