import { Armchair, Check, DoorOpen, Footprints, Square, Users } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { LayoutElementType, SeatAvailability, TripLayoutDeck } from '@/types';
import { formatCurrency } from '@/utils/format';
import { deckLabel, placeTooltip, seatCategories, type TooltipPlacement } from '@/utils/seat-map';
import { cn } from '@/utils/cn';

/**
 * Mapa de asientos que ve el pasajero.
 *
 * LA GEOMETRÍA VIENE DEL BACKEND. `deck.row_count` y `deck.column_count` dan la rejilla, y
 * cada asiento y cada elemento se coloca en su `row_number`/`column_number` con `gridRow` y
 * `gridColumn` explícitos. El pasillo no se calcula: es una columna donde la empresa no puso
 * nada. Nada está pensado para un bus concreto: cualquier número de filas, columnas y pisos.
 *
 * SIN PISO NO HAY ELEMENTOS. `deck` es opcional para que la ficha de viaje del portal de
 * empresa —que solo consulta asientos— siga funcionando igual: sin piso, la rejilla se
 * deduce de las posiciones de los asientos y no se dibuja ningún baño ni escalera.
 *
 * EL PRECIO NO SE CALCULA AQUÍ. Cada asiento trae el suyo ya resuelto por el backend
 * (`trip_seat_type_prices` o `trips.base_price`); esta pantalla solo lo muestra.
 */

/**
 * `Armchair` (lucide-react) es el icono de los ASIENTOS; el puesto del conductor usa el volante del propio
 * mapa para que nunca se confunda con un asiento a la venta.
 */
const ELEMENT_ICONS: Record<LayoutElementType, ComponentType<{ className?: string }>> = {
  BATHROOM: Users,
  STAIRS: Footprints,
  DRIVER: SteeringWheel,
  DOOR: DoorOpen,
  EMPTY: Square,
};

const ELEMENT_LABELS: Record<LayoutElementType, string> = {
  BATHROOM: 'Baño',
  STAIRS: 'Escalera',
  DRIVER: 'Conductor',
  DOOR: 'Puerta',
  EMPTY: 'Espacio vacío',
};

const ELEMENT_TONES: Record<LayoutElementType, string> = {
  BATHROOM: 'border-sky-200 bg-sky-50 text-sky-600',
  STAIRS: 'border-slate-300 bg-slate-100 text-slate-600',
  DRIVER: 'border-ink/15 bg-ink/5 text-ink',
  DOOR: 'border-emerald-200 bg-emerald-50 text-emerald-600',
  EMPTY: 'border-dashed border-slate-200 bg-transparent text-slate-300',
};

/**
 * Marcador de categoría (solo cuando el viaje tiene varias). El catálogo `seat_types` lo
 * administra cada empresa, así que los colores se reparten por orden alfabético de la
 * categoría: es estable entre pisos y entre recargas, y no depende de ninguna empresa.
 */
const CATEGORY_DOTS = ['bg-sky-500', 'bg-violet-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-slate-500'];

export interface SeatMapProps {
  seats: SeatAvailability[];
  selected: number[];
  onToggle?: (seat: SeatAvailability) => void;
  maxSelectable?: number;
  /** Piso a dibujar. Sin él la rejilla se deduce de los asientos y no hay elementos. */
  deck?: TripLayoutDeck | null;
  /** Resalta un único asiento en lugar de una selección múltiple. */
  activeSeatId?: number | null;
  showBusShell?: boolean;
  showHint?: boolean;
  /** Muestra el precio dentro de la casilla. En el mapa del pasajero va en el tooltip y el resumen. */
  showPrices?: boolean;
}

export function SeatMap({
  seats,
  selected,
  onToggle,
  maxSelectable = 6,
  deck = null,
  activeSeatId = null,
  showBusShell = true,
  showHint = true,
  showPrices = true,
}: SeatMapProps) {
  const categorias = useMemo(() => seatCategories(seats).map((c) => c.name), [seats]);

  /**
   * UN tooltip por mapa, pintado en un portal (ver `SeatTooltip`): el asiento solo lleva su texto en
   * `data-tip`. Aparece con el ratón encima o con el foco del teclado; en táctil no hace falta (el asiento
   * elegido sale en el resumen). Al cambiar de piso o de datos se cierra.
   */
  const [tipAnchor, setTipAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => setTipAnchor(null), [seats, deck]);
  const asientoDe = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>('[data-tip]') : null);
  const tipHandlers = {
    onPointerOver: (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'mouse') return;
      const asiento = asientoDe(event.target);
      if (asiento) setTipAnchor(asiento);
    },
    onPointerOut: (event: PointerEvent<HTMLDivElement>) => {
      const asiento = asientoDe(event.target);
      if (asiento && !(event.relatedTarget instanceof Node && asiento.contains(event.relatedTarget))) setTipAnchor((actual) => (actual === asiento ? null : actual));
    },
    onFocus: (event: FocusEvent<HTMLDivElement>) => {
      const asiento = asientoDe(event.target);
      if (asiento?.matches(':focus-visible')) setTipAnchor(asiento);
    },
    onBlur: (event: FocusEvent<HTMLDivElement>) => {
      const asiento = asientoDe(event.target);
      setTipAnchor((actual) => (actual === asiento ? null : actual));
    },
  };

  // SIN PISO, UNA REJILLA POR PISO. La ficha del portal de empresa no pide la geometria y
  // llega con los asientos de todo el bus; dibujarlos en una sola rejilla haria que el
  // asiento (1,1) del piso de arriba tapara al (1,1) del de abajo y desaparecieran asientos
  // sin avisar. Con piso indicado se dibuja ese y solo ese.
  const grupos = useMemo(() => {
    if (deck) return [{ clave: deck.id, deck, asientos: seats.filter((seat) => seat.deck_id === deck.id) }];

    const porPiso = new Map<number, SeatAvailability[]>();
    for (const seat of seats) {
      const clave = seat.deck_number ?? 1;
      const grupo = porPiso.get(clave);
      if (grupo) grupo.push(seat);
      else porPiso.set(clave, [seat]);
    }
    return [...porPiso.entries()]
      .sort(([a], [b]) => a - b)
      .map(([clave, asientos]) => ({ clave, deck: null as TripLayoutDeck | null, asientos }));
  }, [seats, deck]);

  const contenido = (
    <div className="space-y-4" {...tipHandlers}>
      {grupos.map((grupo) => (
        // La clave del piso reinicia la animación: al cambiar de piso, el nuevo entra con un fundido corto.
        <div key={grupo.clave} className="animate-rise-in">
          {grupos.length > 1 && (
            <p className="mb-2 text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">Piso {grupo.clave}</p>
          )}
          {/* El bus puede ser mas ancho que un telefono. Se desplaza DENTRO de su caja; la
              pagina nunca crece a lo ancho. El tooltip va en un portal: esta caja no lo recorta. */}
          <div className="-mx-1 overflow-x-auto px-1 pb-1 pt-3">
            <DeckGrid
              deck={grupo.deck}
              seats={grupo.asientos}
              categorias={categorias}
              selected={selected}
              activeSeatId={activeSeatId}
              maxSelectable={maxSelectable}
              onToggle={onToggle}
              showPrices={showPrices}
            />
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div>
      {showBusShell ? (
        <div className="mx-auto w-fit max-w-full">
          <div className="rounded-[44px] bg-gradient-to-b from-slate-100 to-slate-50 p-2 ring-1 ring-slate-200/80">
            <div className="rounded-[36px] bg-white px-3 pb-5 pt-4 shadow-inner ring-1 ring-slate-200/70 sm:px-5">
              <div className="mx-auto flex w-fit items-center gap-2 rounded-full bg-ink px-4 py-1.5 text-white">
                <SteeringWheel />
                <span className="text-[10px] font-semibold uppercase tracking-[0.16em]">Frente del bus</span>
              </div>
              {contenido}
              <div className="mx-auto mt-3 flex w-fit items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-300" aria-hidden>
                <span className="h-px w-8 bg-slate-200" /> Parte trasera <span className="h-px w-8 bg-slate-200" />
              </div>
            </div>
          </div>
        </div>
      ) : (
        contenido
      )}

      <SeatTooltip anchor={tipAnchor} />

      {showHint && onToggle && (
        <p className="mt-3 text-center text-xs text-muted">Puedes seleccionar como máximo {maxSelectable} {maxSelectable === 1 ? 'asiento' : 'asientos'} por compra</p>
      )}
    </div>
  );
}

/**
 * Una rejilla: la de un piso. `row_count` y `column_count` mandan y cada cosa se coloca en
 * su fila y su columna. Sin piso declarado la rejilla se deduce de lo que hay colocado.
 */
function DeckGrid({
  deck,
  seats,
  categorias,
  selected,
  activeSeatId,
  maxSelectable,
  onToggle,
  showPrices,
}: {
  deck: TripLayoutDeck | null;
  seats: SeatAvailability[];
  categorias: string[];
  selected: number[];
  activeSeatId: number | null;
  maxSelectable: number;
  onToggle?: (seat: SeatAvailability) => void;
  showPrices: boolean;
}) {
  /**
   * La geometria del piso se calcula una vez por cambio de DATOS, no en cada render: la rejilla
   * y el mapa de casillas ocupadas dependen del piso y de los asientos, no de la selección.
   */
  const { filas, columnas, ocupadas } = useMemo(() => {
    const elementos = deck?.elements ?? [];
    const filasContenido = elementos.reduce(
      (maximo, elemento) => Math.max(maximo, elemento.row_number + elemento.row_span - 1),
      seats.reduce((maximo, seat) => Math.max(maximo, seat.row_number ?? 0), 0),
    );
    const columnasContenido = elementos.reduce(
      (maximo, elemento) => Math.max(maximo, elemento.column_number + elemento.col_span - 1),
      seats.reduce((maximo, seat) => Math.max(maximo, seat.column_number ?? 0), 0),
    );

    const casillas = new Map<string, { kind: 'seat'; seat: SeatAvailability } | { kind: 'element'; element: TripLayoutDeck['elements'][number] }>();
    for (const seat of seats) {
      if (seat.row_number === null || seat.column_number === null) continue;
      casillas.set(`${seat.row_number}:${seat.column_number}`, { kind: 'seat', seat });
    }
    for (const elemento of elementos) {
      for (let fila = elemento.row_number; fila < elemento.row_number + elemento.row_span; fila += 1) {
        for (let columna = elemento.column_number; columna < elemento.column_number + elemento.col_span; columna += 1) {
          casillas.set(`${fila}:${columna}`, { kind: 'element', element: elemento });
        }
      }
    }

    return {
      filas: Math.max(deck?.row_count ?? 0, filasContenido, 1),
      columnas: Math.max(deck?.column_count ?? 0, columnasContenido, 1),
      ocupadas: casillas,
    };
  }, [deck, seats]);

  const gridRef = useRef<HTMLDivElement>(null);

  /**
   * Teclado: las flechas mueven el foco al asiento vecino (arriba/abajo/izquierda/derecha) saltando
   * pasillos y huecos. Intro o Espacio eligen, como cualquier botón.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const deltas: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const delta = deltas[event.key];
    const target = event.target as HTMLElement;
    const fila = Number(target.dataset.row);
    const columna = Number(target.dataset.col);
    if (!delta || !fila || !columna) return;
    for (let paso = 1; paso <= Math.max(filas, columnas); paso += 1) {
      const next = gridRef.current?.querySelector<HTMLButtonElement>(`[data-row="${fila + delta[0] * paso}"][data-col="${columna + delta[1] * paso}"]`);
      if (next) {
        event.preventDefault();
        next.focus();
        return;
      }
    }
  };

  return (
    <div
      ref={gridRef}
      onKeyDown={onKeyDown}
      className="grid gap-1.5 [--seat:38px] sm:gap-2 sm:[--seat:42px]"
      style={{
        gridTemplateColumns: `18px repeat(${columnas}, var(--seat))`,
        gridTemplateRows: `repeat(${filas}, var(--seat))`,
      }}
    >
      {Array.from({ length: filas }, (_, indiceFila) => {
        const fila = indiceFila + 1;
        return (
          <Fragmento key={`fila-${fila}`}>
            <span className="flex items-center justify-end pr-0.5 text-[10px] font-medium tabular-nums text-slate-300" aria-hidden>
              {fila}
            </span>
            {Array.from({ length: columnas }, (_, indiceColumna) => {
              const columna = indiceColumna + 1;
              const casilla = ocupadas.get(`${fila}:${columna}`);

              // Casilla vacia: el pasillo, sin mas. No se dibuja nada.
              if (!casilla) return <span key={`${fila}:${columna}`} aria-hidden />;

              if (casilla.kind === 'element') {
                const elemento = casilla.element;
                // Solo la casilla de origen pinta el bloque; el resto las cubre el `span`.
                if (elemento.row_number !== fila || elemento.column_number !== columna) return null;
                return <LayoutElement key={`e${elemento.id}`} element={elemento} />;
              }

              const seat = casilla.seat;
              const indice = categorias.indexOf(seat.seat_type_name ?? 'Estándar');
              return (
                <SeatItem
                  key={seat.id}
                  seat={seat}
                  tone={categorias.length > 1 ? CATEGORY_DOTS[(indice < 0 ? 0 : indice) % CATEGORY_DOTS.length]! : ''}
                  selected={selected.includes(seat.id)}
                  active={activeSeatId === seat.id}
                  atLimit={selected.length >= maxSelectable && !selected.includes(seat.id)}
                  onToggle={onToggle}
                  showPrice={showPrices}
                />
              );
            })}
          </Fragmento>
        );
      })}
    </div>
  );
}

/** `<>` no admite `key`, y la rejilla necesita una clave estable por fila. */
function Fragmento({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/**
 * Selector de pisos. Se construye con los pisos que devuelve el backend, sin lista fija; con un
 * solo piso no aparece. Pestañas accesibles: ←/→ cambian de piso.
 */
export function DeckSelector({
  decks,
  activeDeckId,
  onChange,
  seatCountByDeck,
  countSuffix = 'asientos',
  className,
}: {
  decks: TripLayoutDeck[];
  activeDeckId: number | null;
  onChange: (deckId: number) => void;
  seatCountByDeck: Map<number, number>;
  /** Texto tras el número de cada pestaña («libres», «asientos»…). */
  countSuffix?: string;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  if (decks.length <= 1) return null;
  const index = Math.max(0, decks.findIndex((deck) => deck.id === activeDeckId));
  const onKey = (event: KeyboardEvent) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % decks.length : event.key === 'ArrowLeft' ? (index - 1 + decks.length) % decks.length : null;
    if (next === null) return;
    event.preventDefault();
    onChange(decks[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div className={cn('flex', className)}>
      <div className="inline-flex gap-1 rounded-2xl bg-slate-100 p-1" role="tablist" aria-label="Pisos del bus" onKeyDown={onKey}>
        {decks.map((deck, i) => {
          const activo = i === index;
          return (
            <button
              key={deck.id}
              ref={(el) => { refs.current[i] = el; }}
              type="button"
              role="tab"
              aria-selected={activo}
              tabIndex={activo ? 0 : -1}
              onClick={() => onChange(deck.id)}
              className={cn(
                'min-w-[112px] rounded-xl px-4 py-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                activo ? 'bg-white text-ink shadow-sm ring-1 ring-black/5' : 'text-slate-500 hover:text-ink',
              )}
            >
              <span className={cn('block text-sm font-bold', activo && 'text-brand-600')}>{deckLabel(deck)}</span>
              <span className="block text-xs text-muted">
                {seatCountByDeck.get(deck.id) ?? 0} {countSuffix}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Elemento físico del bus. Ocupa de verdad sus casillas: un 2×2 mide 2×2. */
export function LayoutElement({ element }: { element: TripLayoutDeck['elements'][number] }) {
  const Icono = ELEMENT_ICONS[element.element_type];
  const etiqueta = element.label ?? ELEMENT_LABELS[element.element_type];
  return (
    <div
      style={{ gridRow: `span ${element.row_span}`, gridColumn: `span ${element.col_span}` }}
      title={etiqueta}
      role="img"
      aria-label={`${etiqueta}, fila ${element.row_number}, columna ${element.column_number}`}
      className={cn('flex flex-col items-center justify-center gap-0.5 rounded-xl border', ELEMENT_TONES[element.element_type])}
    >
      <Icono className="h-4 w-4" aria-hidden />
      {(element.row_span > 1 || element.col_span > 1) && <span className="px-0.5 text-[9px] font-semibold leading-none">{etiqueta}</span>}
    </div>
  );
}

export function SeatItem({
  seat,
  tone,
  selected,
  active,
  atLimit,
  onToggle,
  showPrice,
}: {
  seat: SeatAvailability;
  /** Color del marcador de categoría (vacío si el viaje tiene una sola categoría). */
  tone: string;
  selected: boolean;
  active: boolean;
  atLimit: boolean;
  onToggle?: (seat: SeatAvailability) => void;
  showPrice: boolean;
}) {
  const ocupado = Number(seat.is_taken) === 1;
  const inactivo = seat.status !== 'AVAILABLE';
  const elegido = selected || active;
  const bloqueado = !onToggle || ocupado || inactivo || (atLimit && !selected);

  const estado = ocupado ? 'ocupado' : inactivo ? 'no disponible' : elegido ? 'seleccionado' : 'disponible';
  const precio = Number(seat.price);
  const tipo = seat.seat_type_name ?? 'Estándar';
  const detalle = `Asiento ${seat.seat_number} · ${tipo}${Number.isFinite(precio) ? ` · ${formatCurrency(precio)}` : ''}`;

  const aspecto = elegido
    ? 'border-brand-600 bg-brand-500 text-white shadow-md shadow-brand-500/30'
    : ocupado
      ? 'border-slate-200 bg-slate-100 text-slate-400'
      : inactivo
        ? 'border-dashed border-slate-200 bg-white text-slate-300'
        : cn(
            'border-brand-300 bg-brand-50 text-brand-700',
            onToggle && !atLimit && 'hover:border-brand-500 hover:bg-brand-100 motion-safe:hover:-translate-y-0.5',
          );

  return (
    <button
      type="button"
      disabled={bloqueado && !selected}
      onClick={() => onToggle?.(seat)}
      data-row={seat.row_number ?? undefined}
      data-col={seat.column_number ?? undefined}
      data-tip={`${detalle}${ocupado ? ' · Ocupado' : inactivo ? ' · No disponible' : ''}`}
      aria-label={
        estado === 'disponible'
          ? `Seleccionar asiento ${seat.seat_number}, ${tipo}, ${formatCurrency(precio)}`
          : `Asiento ${seat.seat_number}, ${tipo}, ${estado}`
      }
      aria-pressed={onToggle ? selected : undefined}
      className={cn(
        'relative flex flex-col items-center justify-center rounded-b-md rounded-t-[12px] border-2 leading-none tabular-nums transition duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2',
        aspecto,
        selected && 'animate-seat-pop',
        bloqueado && !selected && 'cursor-not-allowed',
        !onToggle && 'cursor-default',
      )}
    >
      {/* Icono de asiento (lucide `Armchair`) y, DEBAJO, el número: el icono nunca lo tapa. */}
      <Armchair className={cn('shrink-0', showPrice ? 'h-3.5 w-3.5' : 'h-4 w-4 sm:h-[18px] sm:w-[18px]', ocupado && 'opacity-70')} strokeWidth={2} aria-hidden />
      <span className="mt-0.5 text-[10px] font-bold sm:text-[11px]">{seat.seat_number}</span>
      {showPrice && !ocupado && Number.isFinite(precio) && <span className="mt-px text-[8px] font-semibold opacity-70">{Math.round(precio)}</span>}
      {/* El estado no depende solo del color: ✓ si está elegido, ✕ si está ocupado. */}
      {elegido && <StateBadge tone="bg-ink text-white"><Check className="h-2.5 w-2.5" strokeWidth={3.5} /></StateBadge>}
      {ocupado && <StateBadge tone="bg-slate-400 text-white"><CrossGlyph className="h-2 w-2" /></StateBadge>}
      {tone && !ocupado && <span className={cn('absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full', tone)} aria-hidden />}

    </button>
  );
}

/**
 * Tooltip del asiento. Vive en un portal con `position: fixed`, así que el `overflow-x-auto` del mapa
 * (necesario para que un bus ancho no ensanche la página) no lo corta: ni en las columnas extremas ni en
 * la primera fila. `placeTooltip` lo mantiene entero dentro de la ventana y la flecha apunta al asiento.
 * Se recoloca al hacer scroll o redimensionar. El `aria-label` del asiento sigue siendo lo que se lee.
 */
function SeatTooltip({ anchor }: { anchor: HTMLElement | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<TooltipPlacement | null>(null);
  const texto = anchor?.dataset.tip ?? '';

  useLayoutEffect(() => {
    if (!anchor) {
      setPos(null);
      return;
    }
    const place = () => {
      const tip = ref.current;
      if (!tip || !anchor.isConnected) {
        setPos(null);
        return;
      }
      const r = anchor.getBoundingClientRect();
      setPos(placeTooltip({ left: r.left, top: r.top, width: r.width, height: r.height }, { width: tip.offsetWidth, height: tip.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, texto]);

  if (!anchor || !texto) return null;
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={{ position: 'fixed', left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      className="pointer-events-none z-[70] w-max max-w-[min(18rem,calc(100vw-16px))] whitespace-normal break-words rounded-lg bg-ink px-2.5 py-1.5 text-center text-[11px] font-semibold leading-snug text-white shadow-elevated"
    >
      {/* Texto COMPLETO: sin elipsis ni recorte; si no cabe en una línea, se parte en varias. */}
      {texto}
      {pos && (
        <span
          aria-hidden
          style={{ left: pos.arrowLeft }}
          className={cn('absolute h-2 w-2 -translate-x-1/2 rotate-45 bg-ink', pos.placement === 'top' ? '-bottom-1' : '-top-1')}
        />
      )}
    </div>,
    document.body,
  );
}

/** Insignia de estado en la esquina del asiento (dentro del margen del mapa, así no se recorta). */
function StateBadge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className={cn('absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full ring-2 ring-white', tone)} aria-hidden>
      {children}
    </span>
  );
}

function CrossGlyph({ className = 'h-3 w-3' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function SteeringWheel({ className = 'h-3.5 w-3.5 text-brand-400' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 9.5V3M9.8 13.2 4.2 16.5M14.2 13.2l5.6 3.3" />
    </svg>
  );
}

/**
 * Leyenda construida con lo que el viaje tiene de verdad: los estados, una entrada por categoría
 * de asiento presente (con su precio real, solo si hay más de una) y una por tipo de elemento que
 * aparezca en algún piso. Nada de categorías inventadas ni de precios de ejemplo.
 */
export function SeatLegend({
  seats,
  decks = [],
  inline = false,
  className,
}: {
  seats: SeatAvailability[];
  decks?: TripLayoutDeck[];
  inline?: boolean;
  className?: string;
}) {
  const { categorias, elementos } = useMemo(
    () => ({
      categorias: seatCategories(seats),
      elementos: [...new Set(decks.flatMap((deck) => deck.elements.map((elemento) => elemento.element_type)))].filter((tipo) => tipo !== 'EMPTY'),
    }),
    [seats, decks],
  );

  const item = 'flex items-center gap-2 text-sm text-slate-600';
  const muestra = 'relative flex h-6 w-6 shrink-0 items-center justify-center rounded-b-[4px] rounded-t-[7px] border-2';
  return (
    <ul className={cn(inline ? 'flex flex-wrap items-center gap-x-5 gap-y-2' : 'space-y-2.5', className)}>
      <li className={item}>
        <span className={cn(muestra, 'border-brand-300 bg-brand-50 text-brand-700')} aria-hidden>
          <Armchair className="h-3.5 w-3.5" />
        </span>
        Disponible
      </li>
      <li className={item}>
        <span className={cn(muestra, 'border-brand-600 bg-brand-500 text-white')} aria-hidden>
          <Armchair className="h-3.5 w-3.5" />
          <StateBadge tone="bg-ink text-white"><Check className="h-2.5 w-2.5" strokeWidth={3.5} /></StateBadge>
        </span>
        Seleccionado
      </li>
      <li className={item}>
        <span className={cn(muestra, 'border-slate-200 bg-slate-100 text-slate-400')} aria-hidden>
          <Armchair className="h-3.5 w-3.5 opacity-70" />
          <StateBadge tone="bg-slate-400 text-white"><CrossGlyph className="h-2 w-2" /></StateBadge>
        </span>
        Ocupado
      </li>
      {categorias.length > 1 &&
        categorias.map((categoria, indice) => (
          <li key={categoria.name} className={item}>
            <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', CATEGORY_DOTS[indice % CATEGORY_DOTS.length])} aria-hidden />
            <span>
              {categoria.name}
              {categoria.price !== null && <span className="ml-1 font-semibold tabular-nums text-ink">{formatCurrency(categoria.price)}</span>}
            </span>
          </li>
        ))}
      {elementos.map((tipo) => {
        const Icono = ELEMENT_ICONS[tipo];
        return (
          <li key={tipo} className={item}>
            <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-md border', ELEMENT_TONES[tipo])} aria-hidden>
              <Icono className="h-3 w-3" />
            </span>
            {ELEMENT_LABELS[tipo]}
          </li>
        );
      })}
    </ul>
  );
}
