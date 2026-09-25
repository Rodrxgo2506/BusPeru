/**
 * Conteo de pasajeros del buscador (FASE 17). Sin dependencias, para probarlo con `node --test`.
 *
 * El buscador sigue enviando UN número (`passengers`), como antes: la búsqueda no aplica reglas por
 * tipo de pasajero y esta fase no inventa ninguna. El desglose solo ayuda a contar bien.
 */

export type PassengerKind = 'adults' | 'children' | 'infants';

export type PassengerCounts = Record<PassengerKind, number>;

export const DEFAULT_PASSENGERS: PassengerCounts = { adults: 1, children: 0, infants: 0 };

/** Mínimos por tipo: siempre viaja al menos un adulto. */
export const PASSENGER_MIN: PassengerCounts = { adults: 1, children: 0, infants: 0 };

export function totalPassengers(counts: PassengerCounts): number {
  return counts.adults + counts.children + counts.infants;
}

/**
 * Suma `delta` a un tipo respetando su mínimo y el máximo TOTAL (el límite de asientos por reserva
 * que publica la plataforma). Si el cambio no cabe, devuelve los mismos conteos.
 */
export function changePassengers(counts: PassengerCounts, kind: PassengerKind, delta: number, maxTotal: number): PassengerCounts {
  const next = Math.max(PASSENGER_MIN[kind], counts[kind] + delta);
  const candidate = { ...counts, [kind]: next };
  if (delta > 0 && totalPassengers(candidate) > maxTotal) return counts;
  return candidate;
}

export function passengerLabel(total: number): string {
  return `${total} ${total === 1 ? 'pasajero' : 'pasajeros'}`;
}
