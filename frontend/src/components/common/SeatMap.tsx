import { Info } from 'lucide-react';
import { useMemo } from 'react';
import type { SeatAvailability } from '@/types';
import { cn } from '@/utils/cn';

interface SeatMapProps {
  seats: SeatAvailability[];
  selected: number[];
  onToggle?: (seat: SeatAvailability) => void;
  maxSelectable?: number;
  /** Highlights a single seat instead of a multi-selection (company seat editor). */
  activeSeatId?: number | null;
  /** Mockup 3 shows the bus body with the driver area; the editor reuses the same grid. */
  showBusShell?: boolean;
  showHint?: boolean;
}

/**
 * Seat grid built from `seats.row_number` / `column_number`, drawn inside the bus body
 * shown in mockup 3: driver header on top, two seats + aisle + two seats per row and the
 * row number on the left. Seat categories come from `seat_types`.
 */
export function SeatMap({
  seats,
  selected,
  onToggle,
  maxSelectable = 6,
  activeSeatId = null,
  showBusShell = true,
  showHint = true,
}: SeatMapProps) {
  const rows = useMemo(() => {
    const grouped = new Map<number, SeatAvailability[]>();
    seats.forEach((seat, index) => {
      const row = seat.row_number ?? Math.floor(index / 4) + 1;
      const list = grouped.get(row) ?? [];
      list.push(seat);
      grouped.set(row, list);
    });
    return [...grouped.entries()]
      .sort(([a], [b]) => a - b)
      .map(([row, list]) => [row, list.sort((a, b) => (a.column_number ?? 0) - (b.column_number ?? 0))] as const);
  }, [seats]);

  const columnsPerRow = Math.max(...rows.map(([, list]) => list.length), 4);
  const aisleAfter = Math.floor(columnsPerRow / 2);

  const grid = (
    <div className="space-y-[7px]">
      {rows.map(([row, rowSeats]) => (
        <div key={row} className="flex items-center gap-2.5">
          <span className="w-5 shrink-0 text-right text-[11px] font-medium tabular-nums text-slate-400">{String(row).padStart(2, '0')}</span>
          <div className="flex flex-1 items-center justify-center gap-[7px]">
            {rowSeats.map((seat, index) => (
              <span key={seat.id} className="flex items-center gap-[7px]">
                {index === aisleAfter && <span className="w-7 sm:w-10" aria-hidden />}
                <SeatButton
                  seat={seat}
                  selected={selected.includes(seat.id)}
                  active={activeSeatId === seat.id}
                  disabled={!onToggle || seat.is_taken === 1 || seat.status !== 'AVAILABLE'}
                  atLimit={selected.length >= maxSelectable && !selected.includes(seat.id)}
                  onToggle={onToggle}
                />
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div>
      {showBusShell ? (
        <div className="mx-auto max-w-[360px]">
          {/* Bus body: rounded nose, driver area, then the seat grid. */}
          <div className="rounded-t-[64px] rounded-b-3xl border border-border bg-white px-3 pb-5 pt-4 shadow-card">
            <div className="mx-auto mb-1 flex w-fit items-center gap-2 rounded-full bg-slate-100 px-4 py-1.5">
              <SteeringWheel />
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Conductor</span>
            </div>
            <div className="mx-auto mb-4 h-1.5 w-16 rounded-full bg-slate-200" aria-hidden />
            {grid}
          </div>
        </div>
      ) : (
        grid
      )}

      {showHint && onToggle && (
        <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted">
          <Info className="h-3.5 w-3.5" />
          Puedes seleccionar máximo {maxSelectable} asientos
        </p>
      )}
    </div>
  );
}

function SteeringWheel() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-slate-500" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 9.5V3M9.8 13.2 4.2 16.5M14.2 13.2l5.6 3.3" />
    </svg>
  );
}

function seatCategory(seat: SeatAvailability): 'taken' | 'inactive' | 'woman' | 'preferential' | 'standard' {
  if (seat.is_taken === 1) return 'taken';
  if (seat.status !== 'AVAILABLE') return 'inactive';
  const type = seat.seat_type_name ?? '';
  if (type === 'Mujer') return 'woman';
  if (type === 'Preferencial') return 'preferential';
  return 'standard';
}

function SeatButton({
  seat,
  selected,
  active,
  disabled,
  atLimit,
  onToggle,
}: {
  seat: SeatAvailability;
  selected: boolean;
  active: boolean;
  disabled: boolean;
  atLimit: boolean;
  onToggle?: (seat: SeatAvailability) => void;
}) {
  const category = seatCategory(seat);
  const isChosen = selected || active;

  const tone = isChosen
    ? 'border-slate-800 bg-slate-800 text-white'
    : category === 'taken'
      ? 'border-danger-200 bg-danger-100 text-danger-500'
      : category === 'inactive'
        ? 'border-slate-300 bg-slate-200 text-slate-400'
        : category === 'woman'
          ? 'border-warning-500 bg-white text-warning-600'
          : category === 'preferential'
            ? 'border-info-500 bg-white text-info-600'
            : 'border-success-500/70 bg-success-50 text-success-700 hover:border-success-600 hover:bg-success-100';

  const label = `Asiento ${seat.seat_number}${seat.seat_type_name ? `, ${seat.seat_type_name}` : ''}, ${
    category === 'taken' ? 'ocupado' : isChosen ? 'seleccionado' : category === 'inactive' ? 'no disponible' : 'disponible'
  }`;

  return (
    <button
      type="button"
      disabled={disabled || (atLimit && !selected)}
      onClick={() => onToggle?.(seat)}
      title={`Asiento ${seat.seat_number}${seat.seat_type_name ? ` · ${seat.seat_type_name}` : ''}`}
      aria-label={label}
      aria-pressed={selected}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md border-2 text-[10px] font-semibold tabular-nums transition',
        tone,
        (disabled || (atLimit && !selected)) && 'cursor-not-allowed',
      )}
    >
      {isChosen ? (
        <CheckGlyph />
      ) : category === 'taken' ? (
        <CrossGlyph />
      ) : category === 'woman' ? (
        <span className="h-1.5 w-1.5 rounded-full bg-warning-500" aria-hidden />
      ) : (
        <span className="sr-only">{seat.seat_number}</span>
      )}
    </button>
  );
}

function CheckGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

function CrossGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

const LEGEND = [
  { label: 'Disponible', className: 'border-success-500/70 bg-success-50' },
  { label: 'Seleccionado', className: 'border-slate-800 bg-slate-800' },
  { label: 'Ocupado', className: 'border-danger-200 bg-danger-100' },
  { label: 'Mujer', className: 'border-warning-500 bg-white' },
  { label: 'Preferencial', className: 'border-info-500 bg-white' },
];

export function SeatLegend({ inline = false, className }: { inline?: boolean; className?: string }) {
  return (
    <ul className={cn(inline ? 'flex flex-wrap items-center gap-x-4 gap-y-2' : 'space-y-3', className)}>
      {LEGEND.map((item) => (
        <li key={item.label} className="flex items-center gap-2.5 text-sm text-slate-600">
          <span className={cn('h-[18px] w-[18px] rounded border-2', item.className)} aria-hidden />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
