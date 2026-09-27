/**
 * Utilidades puras de la pantalla de resultados (sin React ni DOM: se prueban con `node --test`).
 *
 * Solo trabajan con datos reales del viaje (`departure_datetime`, `arrival_datetime`, `base_price`,
 * `company_rating`, `seats_available`). Las fechas llegan del backend como `AAAA-MM-DD HH:MM:SS` en
 * hora de Perú; la duración se calcula como diferencia de esas dos marcas, sin zona horaria.
 */

export type TripSort = 'recommended' | 'departure' | 'price' | 'duration' | 'rating';

export const SORT_OPTIONS: Array<{ id: TripSort; label: string; short: string }> = [
  { id: 'recommended', label: 'Recomendados', short: 'Recomendados' },
  { id: 'departure', label: 'Hora de salida', short: 'Salida' },
  { id: 'price', label: 'Menor precio', short: 'Precio' },
  { id: 'duration', label: 'Más rápido', short: 'Duración' },
  { id: 'rating', label: 'Mejor calificados', short: 'Calificación' },
];

export interface SortableTrip {
  id: number;
  departure_datetime: string;
  arrival_datetime: string | null;
  base_price: string | number;
  company_rating: number | null;
}

function epochMinutes(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) / 60000;
}

/** Minutos de viaje, o null si falta la llegada o las marcas no son válidas. */
export function durationMinutes(departure: string, arrival: string | null | undefined): number | null {
  if (!arrival) return null;
  const a = epochMinutes(departure);
  const b = epochMinutes(arrival);
  if (a === null || b === null || b < a) return null;
  return b - a;
}

/**
 * Ordena sin mutar. «Recomendados» respeta el orden del backend (por hora de salida). En cada
 * criterio, los empates se deshacen por hora de salida para que el orden sea estable.
 */
export function sortTrips<T extends SortableTrip>(trips: T[], sort: TripSort): T[] {
  const rows = [...trips];
  const bySalida = (a: T, b: T) => a.departure_datetime.localeCompare(b.departure_datetime);
  switch (sort) {
    case 'departure':
      return rows.sort(bySalida);
    case 'price':
      return rows.sort((a, b) => Number(a.base_price) - Number(b.base_price) || bySalida(a, b));
    case 'duration':
      // Sin llegada conocida, al final: no se puede afirmar que sea rápido.
      return rows.sort((a, b) => {
        const da = durationMinutes(a.departure_datetime, a.arrival_datetime);
        const db = durationMinutes(b.departure_datetime, b.arrival_datetime);
        if (da === null && db === null) return bySalida(a, b);
        if (da === null) return 1;
        if (db === null) return -1;
        return da - db || bySalida(a, b);
      });
    case 'rating':
      // Sin opiniones, al final: una empresa sin valoraciones no es «peor» ni «mejor».
      return rows.sort((a, b) => {
        if (a.company_rating === null && b.company_rating === null) return bySalida(a, b);
        if (a.company_rating === null) return 1;
        if (b.company_rating === null) return -1;
        return Number(b.company_rating) - Number(a.company_rating) || bySalida(a, b);
      });
    default:
      return rows;
  }
}

/** Pasajeros de la búsqueda (`?passengers=`): entero entre 1 y 20; si no, 1. */
export function passengersFromParam(raw: string | null | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 1;
}

export function passengerCountLabel(n: number): string {
  return `${n} ${n === 1 ? 'pasajero' : 'pasajeros'}`;
}

export type Availability = 'none' | 'few' | 'ok';

/** Nivel de disponibilidad para el aviso de la tarjeta: «últimos asientos» con 5 o menos. */
export function availabilityLevel(seatsAvailable: number): Availability {
  if (seatsAvailable <= 0) return 'none';
  if (seatsAvailable <= 5) return 'few';
  return 'ok';
}

export function availabilityLabel(seatsAvailable: number): string {
  if (seatsAvailable <= 0) return 'Sin asientos disponibles';
  if (seatsAvailable === 1) return '¡Último asiento!';
  if (seatsAvailable <= 5) return `¡Últimos ${seatsAvailable} asientos!`;
  return `${seatsAvailable} asientos disponibles`;
}

/** ¿La llegada es otro día? Para mostrar «+1» junto a la hora de llegada. */
export function arrivalDayOffset(departure: string, arrival: string | null | undefined): number {
  if (!arrival) return 0;
  const d = departure.slice(0, 10);
  const a = arrival.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{4}-\d{2}-\d{2}$/.test(a)) return 0;
  return Math.round((Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))) / 86400000);
}

/** Texto del «+N» de la hora de llegada (título y lectores de pantalla); null si llega el mismo día. */
export function arrivalDayNote(offset: number): string | null {
  if (!(offset > 0)) return null;
  return offset === 1 ? 'Llega al día siguiente' : `Llega ${offset} días después`;
}
