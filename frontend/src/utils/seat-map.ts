/**
 * Utilidades puras de la selección de asientos (sin React ni DOM: se prueban con `node --test`).
 *
 * LA FUENTE DE VERDAD ES EL BACKEND. Un asiento se puede elegir si `GET /public/trips/:id/seats` lo da
 * por libre (`is_taken = 0` y `status = 'AVAILABLE'`), y su precio es el que ya resolvió el backend por
 * categoría. Los pisos son los `decks` del layout congelado del viaje (`GET /public/trips/:id/layout`):
 * un bus es de dos pisos porque su layout tiene dos, no por la empresa ni por el modelo.
 */

export interface SeatLike {
  id: number;
  seat_number: string;
  is_taken: 0 | 1 | number;
  status: string;
  price: string | number;
  deck_id: number | null;
  seat_type_name?: string | null;
}

export type SeatState = 'available' | 'selected' | 'taken' | 'inactive';

export function isSeatSelectable(seat: SeatLike): boolean {
  return Number(seat.is_taken) === 0 && seat.status === 'AVAILABLE';
}

export function seatState(seat: SeatLike, selectedIds: readonly number[]): SeatState {
  if (Number(seat.is_taken) === 1) return 'taken';
  if (seat.status !== 'AVAILABLE') return 'inactive';
  return selectedIds.includes(seat.id) ? 'selected' : 'available';
}

/**
 * Añade o quita un asiento de la selección con la MISMA regla de siempre: solo asientos libres y
 * como máximo `max` (el límite por reserva de la plataforma). Devuelve una lista nueva.
 */
export function toggleSeatSelection<T extends SeatLike>(current: readonly T[], seat: T, max: number): T[] {
  if (!isSeatSelectable(seat)) return [...current];
  if (current.some((entry) => entry.id === seat.id)) return current.filter((entry) => entry.id !== seat.id);
  if (current.length >= max) return [...current];
  return [...current, seat];
}

/** Asientos libres por piso (para las pestañas «Piso 1 · 12 libres»). */
export function freeSeatsByDeck(seats: readonly SeatLike[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const seat of seats) {
    if (seat.deck_id === null) continue;
    if (!map.has(seat.deck_id)) map.set(seat.deck_id, 0);
    if (isSeatSelectable(seat)) map.set(seat.deck_id, map.get(seat.deck_id)! + 1);
  }
  return map;
}

export interface SelectionSummary {
  count: number;
  numbers: string[];
  subtotal: number;
  /** Precio único si todos los asientos elegidos cuestan lo mismo (para «S/ 60 × 2»); si no, null. */
  unitPrice: number | null;
}

/** Resumen de la selección. El subtotal es la SUMA de los precios reales de cada asiento. */
export function selectionSummary(selected: readonly SeatLike[]): SelectionSummary {
  const prices = selected.map((seat) => Number(seat.price)).filter((p) => Number.isFinite(p));
  const subtotal = Math.round(prices.reduce((sum, p) => sum + p, 0) * 100) / 100;
  const unique = [...new Set(prices)];
  return {
    count: selected.length,
    numbers: selected.map((seat) => seat.seat_number),
    subtotal,
    unitPrice: selected.length > 0 && unique.length === 1 ? unique[0]! : null,
  };
}

/** «Piso 1», o el nombre que la empresa le dio en el layout. */
export function deckLabel(deck: { deck_number: number; name: string | null }): string {
  return deck.name?.trim() || `Piso ${deck.deck_number}`;
}

/** Categorías de asiento presentes, ordenadas, con su precio real (la primera que aparezca). */
export function seatCategories(seats: readonly SeatLike[]): Array<{ name: string; price: number | null }> {
  const map = new Map<string, number | null>();
  for (const seat of seats) {
    const name = seat.seat_type_name ?? 'Estándar';
    const price = Number(seat.price);
    if (!map.has(name)) map.set(name, Number.isFinite(price) ? price : null);
  }
  return [...map.entries()].map(([name, price]) => ({ name, price })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TooltipPlacement {
  left: number;
  top: number;
  placement: 'top' | 'bottom';
  /** Posición horizontal de la flecha dentro del tooltip: siempre apunta al centro del asiento. */
  arrowLeft: number;
}

/**
 * Dónde pintar el tooltip de un asiento (coordenadas de la ventana, para `position: fixed`).
 *
 * Centrado sobre el asiento; si no cabe a lo ancho se desliza hasta quedar entero dentro de la ventana
 * (columnas extremas) y la flecha sigue señalando el asiento. Si arriba no hay sitio (primera fila pegada
 * al borde) va debajo. Como se pinta en un portal, ningún contenedor con `overflow` lo recorta.
 */
export function placeTooltip(anchor: Box, tip: { width: number; height: number }, viewport: { width: number; height: number }, margin = 8, gap = 8): TooltipPlacement {
  const centro = anchor.left + anchor.width / 2;
  const maxLeft = Math.max(margin, viewport.width - margin - tip.width);
  const left = Math.min(Math.max(margin, centro - tip.width / 2), maxLeft);
  const arriba = anchor.top - gap - tip.height;
  const placement = arriba >= margin || anchor.top + anchor.height + gap + tip.height > viewport.height - margin ? 'top' : 'bottom';
  const top = placement === 'top' ? arriba : anchor.top + anchor.height + gap;
  const arrowLeft = Math.min(Math.max(10, centro - left), Math.max(10, tip.width - 10));
  return { left: Math.round(left), top: Math.round(top), placement, arrowLeft: Math.round(arrowLeft) };
}
