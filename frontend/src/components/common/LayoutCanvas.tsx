import { Armchair, DoorOpen, Footprints, Square, Users } from 'lucide-react';
import type { BusLayoutDeck, BusLayoutElement, LayoutElementType, LayoutSeat } from '@/types';
import { cn } from '@/utils/cn';

/**
 * Lienzo de un piso: la rejilla real, con sus asientos y sus elementos.
 *
 * QUÉ LO DIFERENCIA DE `SeatMap`. Aquel dibuja el mapa que ve el pasajero y sabe de asientos
 * ocupados; este dibuja la DISTRIBUCIÓN que edita la empresa y sabe de elementos físicos y de
 * casillas vacías donde colocar cosas. Son dos problemas distintos, y mezclarlos habría
 * obligado a `SeatMap` —que usan tres pantallas más— a cargar con la mitad de un editor.
 *
 * LA REJILLA SALE DE LOS DATOS. `row_count` y `column_count` del piso mandan, y cada asiento
 * y cada elemento se coloca en su `row_number`/`column_number`. No hay ninguna suposición
 * sobre cuántas columnas tiene un bus ni sobre dónde cae el pasillo: un elemento con
 * `row_span: 2` ocupa de verdad dos filas, y el pasillo es simplemente una columna donde no
 * hay nada colocado.
 *
 * Si el piso todavía no declara su rejilla —`row_count` en 0, como los pisos que vienen de la
 * migración— se deduce del contenido, para que un bus heredado no aparezca vacío.
 */

export const ELEMENT_ICONS: Record<LayoutElementType, typeof Armchair> = {
  BATHROOM: Users,
  STAIRS: Footprints,
  DRIVER: Armchair,
  DOOR: DoorOpen,
  EMPTY: Square,
};

export const ELEMENT_LABELS: Record<LayoutElementType, string> = {
  BATHROOM: 'Baño',
  STAIRS: 'Escalera',
  DRIVER: 'Conductor',
  DOOR: 'Puerta',
  EMPTY: 'Espacio vacío',
};

const ELEMENT_TONES: Record<LayoutElementType, string> = {
  BATHROOM: 'border-purple-300 bg-purple-100 text-purple-700',
  STAIRS: 'border-slate-300 bg-slate-200 text-slate-600',
  DRIVER: 'border-warning-500 bg-warning-50 text-warning-600',
  DOOR: 'border-info-500 bg-info-50 text-info-600',
  EMPTY: 'border-dashed border-slate-300 bg-white text-slate-400',
};

export interface CanvasSelection {
  kind: 'seat' | 'element';
  id: number;
}

interface LayoutCanvasProps {
  deck: BusLayoutDeck;
  seats: LayoutSeat[];
  elements: BusLayoutElement[];
  selection: CanvasSelection | null;
  onSelect: (selection: CanvasSelection) => void;
  /** Clic en una casilla libre. Sin esto el lienzo es de solo lectura. */
  onPickCell?: (row: number, column: number) => void;
  /** Escala de la vista, 1 = 100%. */
  zoom?: number;
  busy?: boolean;
}

export function LayoutCanvas({ deck, seats, elements, selection, onSelect, onPickCell, zoom = 1, busy = false }: LayoutCanvasProps) {
  // La rejilla declarada manda; si no la hay, se deduce de lo que ya está colocado para no
  // dejar en blanco un piso heredado de la migración.
  const filasContenido = Math.max(
    0,
    ...seats.map((asiento) => asiento.row_number ?? 0),
    ...elements.map((elemento) => elemento.row_number + elemento.row_span - 1),
  );
  const columnasContenido = Math.max(
    0,
    ...seats.map((asiento) => asiento.column_number ?? 0),
    ...elements.map((elemento) => elemento.column_number + elemento.col_span - 1),
  );
  const filas = Math.max(deck.row_count || 0, filasContenido, 1);
  const columnas = Math.max(deck.column_count || 0, columnasContenido, 1);

  // Qué hay en cada casilla. Un elemento con extensión reclama todas las suyas, de modo que
  // no se puede pulsar «vacío» en el centro de una escalera de 2×2.
  const ocupadas = new Map<string, { kind: 'seat' | 'element'; id: number }>();
  for (const asiento of seats) {
    if (asiento.row_number === null || asiento.column_number === null) continue;
    ocupadas.set(`${asiento.row_number}:${asiento.column_number}`, { kind: 'seat', id: asiento.id });
  }
  for (const elemento of elements) {
    for (let fila = elemento.row_number; fila < elemento.row_number + elemento.row_span; fila += 1) {
      for (let columna = elemento.column_number; columna < elemento.column_number + elemento.col_span; columna += 1) {
        ocupadas.set(`${fila}:${columna}`, { kind: 'element', id: elemento.id });
      }
    }
  }

  const seleccionado = (kind: 'seat' | 'element', id: number) => selection?.kind === kind && selection.id === id;

  return (
    <div className="scrollbar-none overflow-x-auto">
      <div
        className="mx-auto w-fit origin-top transition-transform"
        style={{ transform: `scale(${zoom})` }}
      >
        {/* Carrocería: morro redondeado arriba y cola abajo, la misma silueta del mapa del
            pasajero para que la empresa reconozca lo que está editando. */}
        <div className="rounded-[40px] border border-border bg-slate-50 p-2.5 shadow-card">
          <div className="rounded-[32px] border border-border/70 bg-white px-3 pb-5 pt-4">
            <div className="mx-auto mb-3 flex w-fit items-center gap-2 rounded-full bg-brand-50 px-4 py-1.5 ring-1 ring-brand-100">
              <SteeringWheel />
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-600">Frente</span>
            </div>

            <div
              className="grid gap-1.5"
              style={{
                gridTemplateColumns: `28px repeat(${columnas}, minmax(0, 44px))`,
                gridTemplateRows: `20px repeat(${filas}, 44px)`,
              }}
            >
              {/* Cabecera de columnas */}
              <span aria-hidden />
              {Array.from({ length: columnas }, (_, indice) => (
                <span key={`col-${indice}`} className="text-center text-[10px] font-medium tabular-nums text-slate-400">
                  {indice + 1}
                </span>
              ))}

              {Array.from({ length: filas }, (_, indiceFila) => {
                const fila = indiceFila + 1;
                return (
                  <Fragmento key={`fila-${fila}`}>
                    <span className="flex items-center justify-end pr-1 text-[11px] font-medium tabular-nums text-slate-400">
                      {String(fila).padStart(2, '0')}
                    </span>
                    {Array.from({ length: columnas }, (_, indiceColumna) => {
                      const columna = indiceColumna + 1;
                      const ocupa = ocupadas.get(`${fila}:${columna}`);

                      if (!ocupa) {
                        return (
                          <CeldaLibre
                            key={`${fila}:${columna}`}
                            disabled={!onPickCell || busy}
                            onClick={() => onPickCell?.(fila, columna)}
                            fila={fila}
                            columna={columna}
                          />
                        );
                      }

                      if (ocupa.kind === 'seat') {
                        const asiento = seats.find((entrada) => entrada.id === ocupa.id);
                        if (!asiento) return <span key={`${fila}:${columna}`} />;
                        return (
                          <BotonAsiento
                            key={`${fila}:${columna}`}
                            asiento={asiento}
                            activo={seleccionado('seat', asiento.id)}
                            onSelect={() => onSelect({ kind: 'seat', id: asiento.id })}
                            disabled={busy}
                          />
                        );
                      }

                      const elemento = elements.find((entrada) => entrada.id === ocupa.id);
                      if (!elemento) return <span key={`${fila}:${columna}`} />;
                      // Solo la casilla de origen pinta el bloque; las demás las cubre el
                      // `span`, que es lo que hace que un 2×2 ocupe de verdad cuatro casillas.
                      if (elemento.row_number !== fila || elemento.column_number !== columna) return null;
                      return (
                        <BotonElemento
                          key={`${fila}:${columna}`}
                          elemento={elemento}
                          activo={seleccionado('element', elemento.id)}
                          onSelect={() => onSelect({ kind: 'element', id: elemento.id })}
                          disabled={busy}
                        />
                      );
                    })}
                  </Fragmento>
                );
              })}
            </div>

            <div className="mx-auto mt-4 h-1.5 w-24 rounded-full bg-slate-200" aria-hidden />
          </div>
        </div>
      </div>
    </div>
  );
}

/** `<>` no admite `key`, y la rejilla necesita una clave estable por fila. */
function Fragmento({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function CeldaLibre({
  fila,
  columna,
  disabled,
  onClick,
}: {
  fila: number;
  columna: number;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={`Casilla libre fila ${fila}, columna ${columna}`}
      className={cn(
        'rounded-lg border border-dashed border-slate-200 transition',
        disabled ? 'cursor-default' : 'hover:border-brand-400 hover:bg-brand-50',
      )}
    />
  );
}

function BotonAsiento({
  asiento,
  activo,
  onSelect,
  disabled,
}: {
  asiento: LayoutSeat;
  activo: boolean;
  onSelect: () => void;
  disabled: boolean;
}) {
  const inactivo = asiento.status === 'INACTIVE';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      title={`Asiento ${asiento.seat_number}${asiento.seat_type_name ? ` · ${asiento.seat_type_name}` : ''}`}
      aria-label={`Asiento ${asiento.seat_number}${inactivo ? ', inactivo' : ''}`}
      aria-pressed={activo}
      className={cn(
        'flex items-center justify-center rounded-lg border-2 text-[11px] font-bold leading-none tabular-nums transition',
        activo
          ? 'border-brand-600 bg-brand-500 text-white shadow-sm'
          : inactivo
            ? 'border-slate-300 bg-slate-200 text-slate-400'
            : 'border-info-500 bg-info-50 text-info-600 hover:border-brand-400',
      )}
    >
      {asiento.seat_number}
    </button>
  );
}

function BotonElemento({
  elemento,
  activo,
  onSelect,
  disabled,
}: {
  elemento: BusLayoutElement;
  activo: boolean;
  onSelect: () => void;
  disabled: boolean;
}) {
  const Icono = ELEMENT_ICONS[elemento.element_type];
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      style={{ gridRow: `span ${elemento.row_span}`, gridColumn: `span ${elemento.col_span}` }}
      title={elemento.label ?? ELEMENT_LABELS[elemento.element_type]}
      aria-label={`${ELEMENT_LABELS[elemento.element_type]} en fila ${elemento.row_number}, columna ${elemento.column_number}`}
      aria-pressed={activo}
      className={cn(
        'flex flex-col items-center justify-center gap-0.5 rounded-lg border-2 transition',
        ELEMENT_TONES[elemento.element_type],
        activo && 'ring-2 ring-brand-500 ring-offset-1',
      )}
    >
      <Icono className="h-4 w-4" />
      <span className="px-0.5 text-[9px] font-semibold leading-none">{ELEMENT_LABELS[elemento.element_type]}</span>
    </button>
  );
}

function SteeringWheel() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-brand-500" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 9.5V3M9.8 13.2 4.2 16.5M14.2 13.2l5.6 3.3" />
    </svg>
  );
}
