import { Armchair, DoorOpen, Footprints, Square, Users } from 'lucide-react';
import { useMemo } from 'react';
import type { LayoutElementType, SeatAvailability, TripLayoutDeck } from '@/types';
import { formatCurrency } from '@/utils/format';
import { cn } from '@/utils/cn';

/**
 * Mapa de asientos que ve el pasajero.
 *
 * LA GEOMETRÍA VIENE DEL BACKEND. `deck.row_count` y `deck.column_count` dan la rejilla, y
 * cada asiento y cada elemento se coloca en su `row_number`/`column_number` con `gridRow` y
 * `gridColumn` explícitos. Antes esta pantalla partía las filas en dos con
 * `Math.floor(columnas / 2)` y daba por supuestas cuatro columnas; con eso, un bus de tres
 * columnas o con el pasillo a un lado se dibujaba mal y nadie se enteraba. El pasillo no se
 * calcula: es una columna donde la empresa no puso nada.
 *
 * SIN PISO NO HAY ELEMENTOS. `deck` es opcional para que la ficha de viaje del portal de
 * empresa —que solo consulta asientos— siga funcionando igual: sin piso, la rejilla se
 * deduce de las posiciones de los asientos y no se dibuja ningún baño ni escalera.
 *
 * EL PRECIO NO SE CALCULA AQUÍ. Cada asiento trae el suyo ya resuelto por el backend
 * (`trip_seat_type_prices` o `trips.base_price`); esta pantalla solo lo muestra.
 */

const ELEMENT_ICONS: Record<LayoutElementType, typeof Armchair> = {
  BATHROOM: Users,
  STAIRS: Footprints,
  DRIVER: Armchair,
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
  BATHROOM: 'border-purple-300 bg-purple-100 text-purple-700',
  STAIRS: 'border-slate-300 bg-slate-200 text-slate-600',
  DRIVER: 'border-warning-500 bg-warning-50 text-warning-700',
  DOOR: 'border-info-400 bg-info-50 text-info-600',
  EMPTY: 'border-dashed border-slate-300 bg-white text-slate-400',
};

/**
 * Tonos por categoría de asiento.
 *
 * El catálogo `seat_types` lo administra cada empresa, así que no se puede escribir aquí
 * «Cama 180° es naranja»: mañana hay una categoría más y se quedaría sin color. Se reparten
 * por orden alfabético de la categoría, que es estable entre pisos y entre recargas.
 */
const SEAT_TONES = [
  'border-info-500 bg-info-50 text-info-700 hover:border-info-600',
  'border-brand-500 bg-brand-100 text-brand-700 hover:border-brand-600',
  'border-brand-300 bg-brand-50 text-brand-600 hover:border-brand-500',
  'border-success-500 bg-success-50 text-success-700 hover:border-success-600',
  'border-warning-500 bg-warning-50 text-warning-700 hover:border-warning-600',
  'border-purple-300 bg-purple-50 text-purple-700 hover:border-purple-400',
];

/** Categorías presentes, en el orden en que se reparten los tonos. */
function seatTypeOrder(seats: SeatAvailability[]): string[] {
  return [...new Set(seats.map((seat) => seat.seat_type_name ?? 'Estándar'))].sort((a, b) => a.localeCompare(b, 'es'));
}

function toneForSeat(seat: SeatAvailability, order: string[]): string {
  const indice = order.indexOf(seat.seat_type_name ?? 'Estándar');
  return SEAT_TONES[(indice < 0 ? 0 : indice) % SEAT_TONES.length]!;
}

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
  /** Muestra el precio dentro de la casilla. Se apaga solo cuando estorba. */
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
  const orden = useMemo(() => seatTypeOrder(seats), [seats]);

  // SIN PISO, UNA REJILLA POR PISO. La ficha del portal de empresa no pide la geometria y
  // llega con los asientos de todo el bus; dibujarlos en una sola rejilla haria que el
  // asiento (1,1) del piso de arriba tapara al (1,1) del de abajo y desaparecieran asientos
  // sin avisar. Con piso indicado se dibuja ese y solo ese.
  const grupos = useMemo(() => {
    if (deck) return [{ clave: deck.id, deck, asientos: seats.filter((seat) => seat.deck_id === deck.id) }];

    // Se empuja sobre el array que ya esta en el mapa en vez de copiarlo entero en cada
    // vuelta: copiarlo hacia un array nuevo convertia el agrupado en O(n²) —n(n+1)/2 copias
    // para n asientos del mismo piso— sin ninguna ventaja. El orden de insercion es el mismo.
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
    <div className="space-y-4">
      {grupos.map((grupo) => (
        <div key={grupo.clave}>
          {grupos.length > 1 && (
            <p className="mb-2 text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Piso {grupo.clave}
            </p>
          )}
          {/* El bus puede ser mas ancho que un telefono. Se desplaza DENTRO de su caja; la
              pagina nunca crece a lo ancho. */}
          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <DeckGrid
              deck={grupo.deck}
              seats={grupo.asientos}
              orden={orden}
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
        <div className="mx-auto w-fit max-w-full overflow-hidden">
          <div className="rounded-[40px] border border-white/70 bg-white/70 p-2.5 shadow-panel backdrop-blur-md">
            <div className="rounded-[32px] border border-border/70 bg-white px-3 pb-5 pt-4">
              <div className="mx-auto mb-3 flex w-fit items-center gap-2 rounded-full bg-brand-50 px-4 py-1.5 ring-1 ring-brand-100">
                <SteeringWheel />
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-600">Frente</span>
              </div>
              {contenido}
              <div className="mx-auto mt-4 h-1.5 w-24 rounded-full bg-slate-200" aria-hidden />
            </div>
          </div>
        </div>
      ) : (
        contenido
      )}

      {showHint && onToggle && (
        <p className="mt-3 text-center text-xs text-muted">Puedes seleccionar máximo {maxSelectable} asientos</p>
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
  orden,
  selected,
  activeSeatId,
  maxSelectable,
  onToggle,
  showPrices,
}: {
  deck: TripLayoutDeck | null;
  seats: SeatAvailability[];
  orden: string[];
  selected: number[];
  activeSeatId: number | null;
  maxSelectable: number;
  onToggle?: (seat: SeatAvailability) => void;
  showPrices: boolean;
}) {
  /**
   * La geometria del piso se calcula una vez por cambio de DATOS, no en cada render.
   *
   * Antes se rehacia entera en cada pasada, y hay una pasada por cada clic en un asiento
   * porque la seleccion vive en la pantalla y baja por props. Pero la rejilla y el mapa de
   * casillas ocupadas no dependen de la seleccion: dependen del piso y de los asientos. Por
   * eso `selected`, `activeSeatId` y `maxSelectable` NO estan en las dependencias; si lo
   * estuvieran, el `useMemo` no ahorraria nada.
   */
  const { filas, columnas, ocupadas } = useMemo(() => {
    const elementos = deck?.elements ?? [];

    // La rejilla declarada manda. Solo si no la hay —o si algo quedo fuera de ella— se amplia
    // con lo que de verdad hay colocado, para no recortar el bus.
    //
    // Se recorre con `reduce` en vez de esparcir dos arrays dentro de `Math.max`: el
    // resultado es el mismo —un array vacio deja el 0 inicial— y evita crear arrays
    // intermedios y pasar miles de argumentos en un piso grande.
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

  return (
    <div
      className="grid gap-1.5"
      style={{
        gridTemplateColumns: `20px repeat(${columnas}, 38px)`,
        gridTemplateRows: `repeat(${filas}, 38px)`,
      }}
    >
      {Array.from({ length: filas }, (_, indiceFila) => {
        const fila = indiceFila + 1;
        return (
          <Fragmento key={`fila-${fila}`}>
            <span className="flex items-center justify-end pr-0.5 text-[10px] font-medium tabular-nums text-slate-400">
              {String(fila).padStart(2, '0')}
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
              return (
                <SeatItem
                  key={seat.id}
                  seat={seat}
                  tone={toneForSeat(seat, orden)}
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

/** Selector de pisos. Se construye con los pisos que devuelve el backend, sin lista fija. */
export function DeckSelector({
  decks,
  activeDeckId,
  onChange,
  seatCountByDeck,
  className,
}: {
  decks: TripLayoutDeck[];
  activeDeckId: number | null;
  onChange: (deckId: number) => void;
  seatCountByDeck: Map<number, number>;
  className?: string;
}) {
  if (decks.length <= 1) return null;
  return (
    <div className={cn('flex flex-wrap gap-2', className)} role="tablist" aria-label="Pisos del bus">
      {decks.map((deck) => {
        const activo = deck.id === activeDeckId;
        return (
          <button
            key={deck.id}
            type="button"
            role="tab"
            aria-selected={activo}
            onClick={() => onChange(deck.id)}
            className={cn(
              'rounded-control border px-4 py-2 text-left transition',
              activo ? 'border-brand-500 bg-brand-50 text-brand-700 shadow-sm' : 'border-border bg-white text-slate-600 hover:border-brand-300',
            )}
          >
            <span className="block text-sm font-semibold">{deck.name ?? `Piso ${deck.deck_number}`}</span>
            <span className="block text-xs text-muted">{seatCountByDeck.get(deck.id) ?? 0} asientos</span>
          </button>
        );
      })}
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
      className={cn('flex flex-col items-center justify-center gap-0.5 rounded-lg border-2', ELEMENT_TONES[element.element_type])}
    >
      <Icono className="h-4 w-4" aria-hidden />
      {(element.row_span > 1 || element.col_span > 1) && (
        <span className="px-0.5 text-[9px] font-semibold leading-none">{etiqueta}</span>
      )}
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
  tone: string;
  selected: boolean;
  active: boolean;
  atLimit: boolean;
  onToggle?: (seat: SeatAvailability) => void;
  showPrice: boolean;
}) {
  const ocupado = seat.is_taken === 1;
  const inactivo = seat.status !== 'AVAILABLE';
  const elegido = selected || active;
  const bloqueado = !onToggle || ocupado || inactivo || (atLimit && !selected);

  const estado = ocupado ? 'ocupado' : inactivo ? 'no disponible' : elegido ? 'seleccionado' : 'disponible';
  const precio = Number(seat.price);
  const tipo = seat.seat_type_name ?? 'Estándar';

  const aspecto = elegido
    ? 'border-brand-600 bg-brand-500 text-white shadow-sm'
    : ocupado
      ? 'border-slate-300 bg-slate-300 text-slate-500'
      : inactivo
        ? 'border-slate-200 bg-slate-100 text-slate-300'
        : tone;

  return (
    <button
      type="button"
      disabled={bloqueado}
      onClick={() => onToggle?.(seat)}
      title={`Asiento ${seat.seat_number} · ${tipo}${Number.isFinite(precio) ? ` · ${formatCurrency(precio)}` : ''}`}
      aria-label={
        estado === 'disponible'
          ? `Seleccionar asiento ${seat.seat_number}, ${tipo}, ${formatCurrency(precio)}`
          : `Asiento ${seat.seat_number}, ${tipo}, ${estado}`
      }
      aria-pressed={selected}
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border-2 leading-none tabular-nums transition',
        aspecto,
        bloqueado && 'cursor-not-allowed',
      )}
    >
      {ocupado ? (
        <CrossGlyph />
      ) : (
        <>
          <span className="text-[11px] font-bold">{seat.seat_number}</span>
          {showPrice && Number.isFinite(precio) && (
            <span className={cn('mt-0.5 text-[8px] font-semibold', elegido ? 'text-white/80' : 'opacity-70')}>
              {Math.round(precio)}
            </span>
          )}
        </>
      )}
    </button>
  );
}

function CrossGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
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

/**
 * Leyenda construida con lo que el viaje tiene de verdad: una entrada por categoría de
 * asiento presente, con su precio real, y una por tipo de elemento que aparezca en algún
 * piso. Nada de categorías inventadas ni de precios de ejemplo.
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
  const { categorias, elementos } = useMemo(() => {
    const orden = seatTypeOrder(seats);
    const porTipo = new Map<string, number>();
    for (const seat of seats) {
      const tipo = seat.seat_type_name ?? 'Estándar';
      const precio = Number(seat.price);
      if (!porTipo.has(tipo) && Number.isFinite(precio)) porTipo.set(tipo, precio);
    }
    return {
      categorias: orden.map((tipo, indice) => ({
        label: tipo,
        price: porTipo.get(tipo) ?? null,
        className: SEAT_TONES[indice % SEAT_TONES.length]!,
      })),
      elementos: [...new Set(decks.flatMap((deck) => deck.elements.map((elemento) => elemento.element_type)))],
    };
  }, [seats, decks]);

  return (
    <ul className={cn(inline ? 'flex flex-wrap items-center gap-x-4 gap-y-2' : 'space-y-2.5', className)}>
      {categorias.map((item) => (
        <li key={item.label} className="flex items-center gap-2.5 text-sm text-slate-600">
          <span className={cn('h-[18px] w-[18px] shrink-0 rounded border-2', item.className)} aria-hidden />
          <span className="flex-1">{item.label}</span>
          {item.price !== null && <span className="font-semibold tabular-nums text-ink">{formatCurrency(item.price)}</span>}
        </li>
      ))}
      <li className="flex items-center gap-2.5 text-sm text-slate-600">
        <span className="h-[18px] w-[18px] shrink-0 rounded border-2 border-brand-600 bg-brand-500" aria-hidden />
        Seleccionado
      </li>
      <li className="flex items-center gap-2.5 text-sm text-slate-600">
        <span className="h-[18px] w-[18px] shrink-0 rounded border-2 border-slate-300 bg-slate-300" aria-hidden />
        Asiento no disponible
      </li>
      <li className="flex items-center gap-2.5 text-sm text-slate-600">
        <span className="h-[18px] w-[18px] shrink-0 rounded border-2 border-slate-200 bg-slate-100" aria-hidden />
        Asiento inactivo
      </li>
      {elementos.map((tipo) => {
        const Icono = ELEMENT_ICONS[tipo];
        return (
          <li key={tipo} className="flex items-center gap-2.5 text-sm text-slate-600">
            <span className={cn('flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border-2', ELEMENT_TONES[tipo])} aria-hidden>
              <Icono className="h-2.5 w-2.5" />
            </span>
            {ELEMENT_LABELS[tipo]}
          </li>
        );
      })}
    </ul>
  );
}
