import { ChevronDown, Minus, Plus, Users } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FloatingPanel } from '@/components/common/FloatingPanel';
import type { ControlAppearance, ControlTone } from '@/components/common/LocationDropdown';
import { useClickOutside } from '@/hooks/useClickOutside';
import { cn } from '@/utils/cn';
import { changePassengers, PASSENGER_MIN, passengerLabel, totalPassengers, type PassengerCounts, type PassengerKind } from '@/utils/passengers';

/**
 * Selector de N° de pasajeros (FASE 17): adultos, niños y bebés con − / +.
 *
 * Adultos mínimo 1; niños y bebés mínimo 0; nunca negativos. El total no supera `maxTotal`, que es
 * el máximo de asientos por reserva que publica la plataforma. El buscador sigue enviando el TOTAL.
 */

const ROWS: Array<{ kind: PassengerKind; title: string; hint: string }> = [
  { kind: 'adults', title: 'Adultos', hint: 'De 18 en adelante' },
  { kind: 'children', title: 'Niños', hint: 'A partir de 5 hasta 17 años' },
  { kind: 'infants', title: 'Bebés', hint: 'Menores de 5 años' },
];

export function PassengerSelector({
  value,
  onChange,
  maxTotal,
  className,
  label = 'Pasajeros',
  appearance = 'field',
  tone = 'light',
}: {
  value: PassengerCounts;
  onChange: (value: PassengerCounts) => void;
  maxTotal: number;
  className?: string;
  label?: string;
  appearance?: ControlAppearance;
  tone?: ControlTone;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const total = totalPassengers(value);
  const onBrand = tone === 'onBrand';
  const bar = appearance === 'bar';
  useClickOutside([containerRef, panelRef], () => setOpen(false), open);

  return (
    <div ref={containerRef} className={cn('relative', className)} onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'block w-full text-left transition',
          bar
            ? cn('rounded-lg px-3 py-1.5', onBrand ? 'hover:bg-white/10' : 'hover:bg-slate-50', open && (onBrand ? 'bg-white/10' : 'bg-slate-50'))
            : cn('rounded-control border bg-white p-3', open ? 'border-brand-500 ring-2 ring-brand-500/20' : 'border-border hover:border-brand-300'),
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Pasajeros: ${passengerLabel(total)}`}
      >
        <span className={cn('block text-xs font-medium', bar ? 'mb-0.5' : 'mb-1', onBrand ? 'text-white/85' : 'text-muted')}>{label}</span>
        <span className="flex items-center gap-2">
          {!bar && <Users className="h-4 w-4 shrink-0 text-brand-500" aria-hidden />}
          <span className={cn('min-w-0 flex-1 truncate text-sm', bar ? 'font-semibold' : 'font-medium', onBrand ? 'text-white' : 'text-ink')}>
            {passengerLabel(total)}
          </span>
          {bar && <ChevronDown className={cn('h-4 w-4 shrink-0', onBrand ? 'text-white/80' : 'text-slate-400')} aria-hidden />}
        </span>
      </button>

      <FloatingPanel
        anchorRef={containerRef}
        panelRef={panelRef}
        open={open}
        width={320}
        preferredHeight={360}
        role="dialog"
        ariaLabel="Elegir pasajeros"
        className="overflow-y-auto p-4"
        onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}
      >
          <ul className="divide-y divide-border">
            {ROWS.map((row) => {
              const count = value[row.kind];
              const canRemove = count > PASSENGER_MIN[row.kind];
              const canAdd = total < maxTotal;
              return (
                <li key={row.kind} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-ink">{row.title}</span>
                    <span className="block text-xs text-muted">{row.hint}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <CounterButton
                      label={`Quitar ${row.title.toLowerCase()}`}
                      disabled={!canRemove}
                      onClick={() => onChange(changePassengers(value, row.kind, -1, maxTotal))}
                    >
                      <Minus className="h-4 w-4" />
                    </CounterButton>
                    <span className="w-5 text-center text-base font-bold tabular-nums text-ink" aria-live="polite">
                      {count}
                    </span>
                    <CounterButton
                      label={`Agregar ${row.title.toLowerCase()}`}
                      disabled={!canAdd}
                      onClick={() => onChange(changePassengers(value, row.kind, 1, maxTotal))}
                    >
                      <Plus className="h-4 w-4" />
                    </CounterButton>
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
            <Link to="/ayuda" className="text-xs font-semibold text-brand-600 underline-offset-2 hover:underline">
              Condiciones para el viaje
            </Link>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-control bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600"
            >
              Listo
            </button>
          </div>
          {total >= maxTotal && <p className="mt-2 text-xs text-muted">Máximo {maxTotal} pasajeros por reserva.</p>}
      </FloatingPanel>
    </div>
  );
}

function CounterButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-full border border-brand-500 text-brand-600 transition hover:bg-brand-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
