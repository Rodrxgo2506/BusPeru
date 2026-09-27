/**
 * Utilidades puras del calendario del buscador (sin React ni DOM: se prueban con `node --test`).
 *
 * TODO TRABAJA CON CADENAS `AAAA-MM-DD`. Es el formato que ya viaja en la URL y al backend
 * (`/buscar?date=…`, `GET /public/trips?date=…`), así que el calendario no introduce otro. La
 * aritmética se hace en UTC (`Date.UTC`) para que la zona horaria del navegador nunca mueva un
 * día: «hoy» lo decide `todayIso()` con la hora de Lima, y aquí solo se cuentan días.
 */

export const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const MONTHS_SHORT_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** La semana empieza en lunes, como en el Perú. */
export const WEEKDAYS_ES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
export const WEEKDAY_INITIALS_ES = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const WEEKDAYS_SHORT_ES = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface YearMonth {
  year: number;
  /** 0 = enero … 11 = diciembre. */
  month: number;
}

export function isIsoDate(value: string | null | undefined): value is string {
  if (!value) return false;
  const m = ISO.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function toUtc(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

export function toIso(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month, day));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function yearMonthOf(iso: string): YearMonth {
  const date = toUtc(iso);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
}

export function addDays(iso: string, days: number): string {
  const date = toUtc(iso);
  return toIso(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days);
}

export function addMonths(ym: YearMonth, months: number): YearMonth {
  const date = new Date(Date.UTC(ym.year, ym.month + months, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
}

/** Compara dos meses: negativo si `a` va antes que `b`. */
export function compareMonths(a: YearMonth, b: YearMonth): number {
  return a.year * 12 + a.month - (b.year * 12 + b.month);
}

/** Días del mes, lunes primero: `null` para los huecos antes del día 1 y al final de la última semana. */
export function monthGrid(ym: YearMonth): Array<string | null> {
  const first = new Date(Date.UTC(ym.year, ym.month, 1));
  const daysInMonth = new Date(Date.UTC(ym.year, ym.month + 1, 0)).getUTCDate();
  const leading = (first.getUTCDay() + 6) % 7; // getUTCDay: 0 = domingo → lunes = 0
  const cells: Array<string | null> = Array.from({ length: leading }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(toIso(ym.year, ym.month, day));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/** Índice del día de la semana con el lunes = 0. */
export function weekdayIndex(iso: string): number {
  return (toUtc(iso).getUTCDay() + 6) % 7;
}

/** ¿Se puede elegir? Entre `min` y `max`, ambos incluidos (las cadenas ISO se comparan como fechas). */
export function isSelectable(iso: string, min?: string | null, max?: string | null): boolean {
  if (min && iso < min) return false;
  if (max && iso > max) return false;
  return true;
}

/** Acerca una fecha al rango permitido. */
export function clampIso(iso: string, min?: string | null, max?: string | null): string {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

/** «SEP 2026», para la cabecera del calendario. */
export function monthTitle(ym: YearMonth): string {
  return `${MONTHS_SHORT_ES[ym.month]!.toUpperCase()} ${ym.year}`;
}

/** «septiembre de 2026», para lectores de pantalla. */
export function monthTitleLong(ym: YearMonth): string {
  return `${MONTHS_ES[ym.month]} de ${ym.year}`;
}

/** «domingo, 27 de septiembre de 2026». */
export function formatLongEs(iso: string): string {
  const date = toUtc(iso);
  return `${WEEKDAYS_ES[weekdayIndex(iso)]}, ${date.getUTCDate()} de ${MONTHS_ES[date.getUTCMonth()]} de ${date.getUTCFullYear()}`;
}

/** «dom 27 sep 2026», para el campo del buscador. */
export function formatShortEs(iso: string): string {
  const date = toUtc(iso);
  return `${WEEKDAYS_SHORT_ES[weekdayIndex(iso)]} ${date.getUTCDate()} ${MONTHS_SHORT_ES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** «27 de septiembre de 2026», para el resumen de la búsqueda. */
export function formatDayMonthYearEs(iso: string): string {
  const date = toUtc(iso);
  return `${date.getUTCDate()} de ${MONTHS_ES[date.getUTCMonth()]} de ${date.getUTCFullYear()}`;
}

/**
 * Movimiento del foco con el teclado dentro del calendario (patrón «date picker» de WAI-ARIA):
 * ←/→ un día, ↑/↓ una semana, Inicio/Fin principio/fin de la semana, RePág/AvPág un mes
 * (con Mayús, un año). Devuelve null si la tecla no mueve el foco.
 */
export function keyboardTarget(iso: string, key: string, shiftKey = false): string | null {
  switch (key) {
    case 'ArrowLeft': return addDays(iso, -1);
    case 'ArrowRight': return addDays(iso, 1);
    case 'ArrowUp': return addDays(iso, -7);
    case 'ArrowDown': return addDays(iso, 7);
    case 'Home': return addDays(iso, -weekdayIndex(iso));
    case 'End': return addDays(iso, 6 - weekdayIndex(iso));
    case 'PageUp': return shiftMonths(iso, shiftKey ? -12 : -1);
    case 'PageDown': return shiftMonths(iso, shiftKey ? 12 : 1);
    default: return null;
  }
}

/** Mismo día en otro mes; si no existe (31 → febrero), el último día de ese mes. */
export function shiftMonths(iso: string, months: number): string {
  const date = toUtc(iso);
  const target = addMonths({ year: date.getUTCFullYear(), month: date.getUTCMonth() }, months);
  const last = new Date(Date.UTC(target.year, target.month + 1, 0)).getUTCDate();
  return toIso(target.year, target.month, Math.min(date.getUTCDate(), last));
}
