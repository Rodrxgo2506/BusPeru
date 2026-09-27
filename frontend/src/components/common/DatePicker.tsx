import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { FloatingPanel } from '@/components/common/FloatingPanel';
import { useClickOutside } from '@/hooks/useClickOutside';
import {
  addMonths,
  clampIso,
  compareMonths,
  formatLongEs,
  formatShortEs,
  isIsoDate,
  isSelectable,
  keyboardTarget,
  monthGrid,
  monthTitle,
  monthTitleLong,
  WEEKDAY_INITIALS_ES,
  WEEKDAYS_ES,
  yearMonthOf,
  type YearMonth,
} from '@/utils/calendar';
import { todayIso } from '@/utils/format';
import { cn } from '@/utils/cn';

/**
 * Calendario propio del buscador (sustituye al `<input type="date">` nativo).
 *
 * EL VALOR ES EL MISMO DE SIEMPRE: una cadena `AAAA-MM-DD` que el formulario pone en la URL y el
 * backend recibe tal cual. «Hoy» sale de `todayIso()` (hora de Lima) y las fechas anteriores a
 * `min` no se pueden elegir. Accesible con teclado (patrón «date picker dialog» de WAI-ARIA):
 * flechas, Inicio/Fin, RePág/AvPág (con Mayús, un año), Intro para elegir y Esc para cerrar.
 */
export function DatePicker({
  label,
  value,
  onChange,
  min,
  max,
  placeholder = 'Elegir fecha',
  clearable = false,
  appearance = 'field',
  tone = 'light',
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  placeholder?: string;
  /** Permite vaciar el campo (fecha de vuelta opcional). */
  clearable?: boolean;
  appearance?: 'field' | 'bar';
  tone?: 'light' | 'onBrand';
  className?: string;
}) {
  const today = todayIso();
  const [open, setOpen] = useState(false);
  const selected = isIsoDate(value) ? value : null;
  // Día que tiene el foco dentro del calendario (roving tabindex).
  const [focusIso, setFocusIso] = useState(() => clampIso(selected ?? today, min, max));
  const [view, setView] = useState<YearMonth>(() => yearMonthOf(focusIso));
  const [direction, setDirection] = useState<'next' | 'prev'>('next');

  const wrapperRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const labelId = useId();

  useClickOutside([wrapperRef, panelRef], () => setOpen(false), open);

  const openCalendar = () => {
    const start = clampIso(selected ?? today, min, max);
    setFocusIso(start);
    setView(yearMonthOf(start));
    setOpen(true);
  };

  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  // Al abrir y al moverse con el teclado, el foco va al día activo.
  // El panel vive en un portal que se coloca en su propio efecto: si aún no está, se reintenta
  // en el siguiente fotograma.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const enfocar = () => gridRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${focusIso}"]`)?.focus({ preventScroll: true });
    if (gridRef.current) {
      enfocar();
      return undefined;
    }
    const frame = requestAnimationFrame(enfocar);
    return () => cancelAnimationFrame(frame);
  }, [open, focusIso, view]);

  const cells = useMemo(() => monthGrid(view), [view]);
  const minMonth = min ? yearMonthOf(min) : null;
  const maxMonth = max ? yearMonthOf(max) : null;
  const canPrev = !minMonth || compareMonths(view, minMonth) > 0;
  const canNext = !maxMonth || compareMonths(view, maxMonth) < 0;

  const goMonth = (delta: number) => {
    const next = addMonths(view, delta);
    setDirection(delta > 0 ? 'next' : 'prev');
    setView(next);
    // El foco se queda en el mismo día del nuevo mes, dentro del rango permitido.
    const candidate = clampIso(`${next.year}-${String(next.month + 1).padStart(2, '0')}-${focusIso.slice(8, 10)}`, min, max);
    setFocusIso(isIsoDate(candidate) ? candidate : clampIso(`${next.year}-${String(next.month + 1).padStart(2, '0')}-01`, min, max));
  };

  const choose = (iso: string) => {
    if (!isSelectable(iso, min, max)) return;
    onChange(iso);
    close();
  };

  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    const target = keyboardTarget(focusIso, event.key, event.shiftKey);
    if (!target) return;
    event.preventDefault();
    const clamped = clampIso(target, min, max);
    const ym = yearMonthOf(clamped);
    if (compareMonths(ym, view) !== 0) {
      setDirection(compareMonths(ym, view) > 0 ? 'next' : 'prev');
      setView(ym);
    }
    setFocusIso(clamped);
  };

  const bar = appearance === 'bar';
  const onBrand = tone === 'onBrand';

  return (
    <div ref={wrapperRef} className={cn('relative', className)}>
      <div
        ref={fieldRef}
        className={cn(
          'block transition',
          bar ? 'rounded-lg px-3 py-1.5' : 'rounded-control border bg-white p-3',
          !bar && (open ? 'border-brand-500 ring-2 ring-brand-500/15' : 'border-border hover:border-brand-300'),
        )}
      >
        <span id={labelId} className={cn('block text-xs font-medium', bar ? 'mb-0.5' : 'mb-1', onBrand ? 'text-white/85' : 'text-muted')}>
          {label}
        </span>
        <span className="flex items-center gap-2">
          {!bar && <CalendarDays className="h-4 w-4 shrink-0 text-brand-500" aria-hidden />}
          <button
            ref={triggerRef}
            type="button"
            onClick={() => (open ? close(false) : openCalendar())}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && !open) {
                event.preventDefault();
                openCalendar();
              }
            }}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? dialogId : undefined}
            aria-labelledby={labelId}
            aria-describedby={`${labelId}-valor`}
            className={cn(
              'min-w-0 flex-1 truncate text-left text-sm font-medium focus:outline-none focus-visible:underline',
              selected ? (onBrand ? 'text-white' : 'text-ink') : onBrand ? 'text-white/70' : 'text-slate-400',
            )}
          >
            <span id={`${labelId}-valor`}>{selected ? formatShortEs(selected) : placeholder}</span>
            <span className="sr-only">{selected ? `, ${formatLongEs(selected)}. Pulsa para cambiar la fecha` : '. Pulsa para elegir una fecha'}</span>
          </button>
          {clearable && selected && (
            <button
              type="button"
              onClick={() => onChange('')}
              aria-label={`Quitar ${label.toLowerCase()}`}
              className={cn('rounded-full p-0.5 transition', onBrand ? 'text-white/80 hover:bg-white/15' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600')}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </span>
      </div>

      {/* En un portal con posición fija (`FloatingPanel`): ningún contenedor con `overflow-hidden`
          —la portada lo tiene por su imagen— recorta el calendario; si no cabe debajo, se abre encima. */}
      <FloatingPanel anchorRef={fieldRef} panelRef={panelRef} open={open} width={320} preferredHeight={420} className="overflow-y-auto rounded-2xl border-0 p-3 ring-1 ring-black/5">
        <div id={dialogId} role="dialog" aria-modal="false" aria-label={`${label}: elegir fecha`} className="origin-top animate-pop-in">
          <div className="flex items-center justify-between rounded-xl bg-brand-500 px-2 py-2 text-white">
            <button
              type="button"
              onClick={() => goMonth(-1)}
              disabled={!canPrev}
              aria-label="Mes anterior"
              className="flex h-8 w-8 items-center justify-center rounded-lg transition hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <p className="text-sm font-bold tracking-wide" aria-live="polite">
              <span aria-hidden>{monthTitle(view)}</span>
              <span className="sr-only">{monthTitleLong(view)}</span>
            </p>
            <button
              type="button"
              onClick={() => goMonth(1)}
              disabled={!canNext}
              aria-label="Mes siguiente"
              className="flex h-8 w-8 items-center justify-center rounded-lg transition hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <div className="mt-2 grid grid-cols-7 text-center" aria-hidden>
            {WEEKDAY_INITIALS_ES.map((initial, index) => (
              <span key={index} title={WEEKDAYS_ES[index]} className="py-1.5 text-xs font-semibold text-brand-500">
                {initial}
              </span>
            ))}
          </div>

          <div
            ref={gridRef}
            key={`${view.year}-${view.month}`}
            role="grid"
            aria-label={monthTitleLong(view)}
            onKeyDown={onGridKey}
            className={cn('grid grid-cols-7 gap-y-1', direction === 'next' ? 'animate-month-next' : 'animate-month-prev')}
          >
            {cells.map((iso, index) => {
              if (!iso) return <span key={`hueco-${index}`} aria-hidden />;
              const enabled = isSelectable(iso, min, max);
              const isSelected = iso === selected;
              const isToday = iso === today;
              return (
                <button
                  key={iso}
                  type="button"
                  data-iso={iso}
                  tabIndex={iso === focusIso ? 0 : -1}
                  disabled={!enabled}
                  onClick={() => choose(iso)}
                  aria-label={`${formatLongEs(iso)}${isToday ? ', hoy' : ''}${!enabled ? ', no disponible' : ''}`}
                  aria-pressed={isSelected}
                  aria-current={isToday ? 'date' : undefined}
                  className={cn(
                    'relative mx-auto flex h-9 w-9 items-center justify-center rounded-full text-sm tabular-nums transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1',
                    isSelected
                      ? 'bg-brand-500 font-bold text-white shadow-sm'
                      : enabled
                        ? cn('font-medium text-ink hover:bg-brand-50 hover:text-brand-700', isToday && 'bg-brand-50 font-bold text-brand-700 ring-1 ring-brand-300')
                        : 'cursor-not-allowed text-slate-300',
                  )}
                >
                  {Number(iso.slice(8, 10))}
                  {isToday && !isSelected && <span className="absolute bottom-1 h-1 w-1 rounded-full bg-brand-500" aria-hidden />}
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
            <button
              type="button"
              onClick={() => choose(clampIso(today, min, max))}
              disabled={!isSelectable(today, min, max)}
              className="rounded-lg px-2 py-1 text-xs font-semibold text-brand-600 transition hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-40"
            >
              Hoy
            </button>
            <button
              type="button"
              onClick={() => close()}
              className="rounded-lg px-2 py-1 text-xs font-semibold text-slate-500 transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Cerrar
            </button>
          </div>
        </div>
      </FloatingPanel>
    </div>
  );
}
