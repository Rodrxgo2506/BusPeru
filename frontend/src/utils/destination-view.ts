/**
 * Lógica pura de las vistas de destinos (FASE 17B). Sin dependencias, para probarla con `node --test`.
 */

/** Cuántas tarjetas del carrusel caben a cada ancho. Los mismos cortes que usan las clases Tailwind. */
export function visibleCards(viewportWidth: number): number {
  if (viewportWidth >= 1280) return 4;
  if (viewportWidth >= 1024) return 3;
  if (viewportWidth >= 640) return 2;
  return 1;
}

/** Índice siguiente/anterior de un slider circular. Con una sola lámina no se mueve. */
export function stepIndex(current: number, delta: number, total: number): number {
  if (total <= 0) return 0;
  return (((current + delta) % total) + total) % total;
}

export interface PrefillSource {
  city: string | null;
  origin_city: string | null;
}

/**
 * Valores con los que llega precargado el buscador de la ficha.
 *
 * Solo se precarga lo que EXISTE como ciudad del sistema (`GET /public/cities`): el destino guarda
 * una referencia a `locations`, y si esa ciudad no está disponible el campo se deja vacío en lugar
 * de escribir un nombre que el buscador no reconocería. Nunca se deduce del nombre ni del slug.
 */
export function searchPrefill(destination: PrefillSource, cities: readonly string[]): { origin: string; destination: string } {
  const match = (value: string | null) => (value && cities.includes(value) ? value : '');
  return { origin: match(destination.origin_city), destination: match(destination.city) };
}

/** Altitud con separador de millares, como en la referencia: «2,750 msnm». */
export function formatAltitude(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return `${new Intl.NumberFormat('en-US').format(Math.round(value))} msnm`;
}

/**
 * Las insignias son círculos pequeños: un texto corto cabe dentro («18hr») y uno largo se muestra
 * debajo, con un icono en el círculo.
 */
export const BADGE_TEXT_MAX = 5;

export function badgeFitsInCircle(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= BADGE_TEXT_MAX;
}

/**
 * Precio «desde» tal y como lo muestra la referencia: «S/110», sin decimales cuando no los tiene.
 * Es contenido comercial; los importes reales del viaje siguen usando `formatCurrency`.
 */
export function formatPriceFrom(value: number | string | null | undefined): string | null {
  const price = typeof value === 'string' ? Number(value) : value;
  if (price === null || price === undefined || !Number.isFinite(price)) return null;
  return `S/${Number.isInteger(price) ? price : price.toFixed(2)}`;
}
