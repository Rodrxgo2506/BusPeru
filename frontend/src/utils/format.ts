const CURRENCY_FORMATTER = new Intl.NumberFormat('es-PE', {
  style: 'currency',
  currency: 'PEN',
  minimumFractionDigits: 2,
});

const NUMBER_FORMATTER = new Intl.NumberFormat('es-PE');

export function formatCurrency(value: number | string | null | undefined): string {
  const amount = Number(value ?? 0);
  return CURRENCY_FORMATTER.format(Number.isFinite(amount) ? amount : 0).replace('PEN', 'S/');
}

export function formatNumber(value: number | string | null | undefined): string {
  const amount = Number(value ?? 0);
  return NUMBER_FORMATTER.format(Number.isFinite(amount) ? amount : 0);
}

/**
 * Zona operativa del negocio (auditoría BP-12).
 *
 * Todas las fechas de BusPerú son hora de pared de Perú: `departure_datetime` a las 08:00
 * significa que el bus sale a las 08:00 en Perú, lo mire quien lo mire. Fijar la zona al
 * formatear hace que un navegador en Madrid o en Tokio vea esa misma hora, en vez de
 * desplazarla a la suya.
 */
export const PERU_TIME_ZONE = 'America/Lima';

/**
 * Convierte una fecha del backend —`YYYY-MM-DD HH:mm:ss`, sin zona— en el instante que
 * representa, leyéndola SIEMPRE como hora de Perú.
 *
 * Antes se hacía `new Date(cadena.replace(' ', 'T'))`, que la interpreta en la zona del
 * NAVEGADOR. Al mostrarla volvía a formatearse en esa misma zona, así que la hora salía
 * bien por casualidad; pero al COMPARARLA con `Date.now()` —el filtro de próximos viajes o
 * el plazo de cancelación— el resultado se desplazaba tantas horas como el desfase del
 * visitante. Un pasajero en España veía mal clasificado su viaje y el botón de cancelar
 * aparecía o desaparecía a destiempo.
 *
 * Perú no aplica horario de verano, de modo que el desfase es constante; aun así se deriva
 * de la zona IANA y no de un número escrito a mano.
 */
function peruOffsetMinutes(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PERU_TIME_ZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const part = (type: string): number => Number(parts.find((entry) => entry.type === type)?.value ?? '0');
  const asIfUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour') % 24, part('minute'), part('second'));
  return (asIfUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000;
}

export function toBusinessDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;

  // Si ya trae zona es un instante y no una hora de pared: se respeta.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    const withZone = new Date(value);
    return Number.isNaN(withZone.getTime()) ? null : withZone;
  }

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value.replace(' ', 'T');
  const provisional = new Date(`${normalized}Z`);
  if (Number.isNaN(provisional.getTime())) return null;

  return new Date(provisional.getTime() - peruOffsetMinutes(provisional) * 60_000);
}

/** Alias interno: el resto del archivo ya usaba este nombre. */
const toDate = toBusinessDate;

export function formatDate(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleDateString('es-PE', { timeZone: PERU_TIME_ZONE, day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatLongDate(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleDateString('es-PE', { timeZone: PERU_TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatTime(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleTimeString('es-PE', { timeZone: PERU_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  return `${formatDate(date)} · ${formatTime(date)}`;
}

export function formatDuration(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return '—';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return `${hours}h ${String(rest).padStart(2, '0')}m`;
}

export function durationBetween(start: string | null | undefined, end: string | null | undefined): string {
  const from = toDate(start);
  const to = toDate(end);
  if (!from || !to) return '—';
  return formatDuration(Math.round((to.getTime() - from.getTime()) / 60000));
}

export function initials(firstName?: string | null, lastName?: string | null): string {
  return `${firstName?.[0] ?? ''}${lastName?.[0] ?? ''}`.toUpperCase() || '?';
}

export function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Fecha de hoy EN PERÚ, en `YYYY-MM-DD`.
 *
 * Antes usaba `toISOString()`, que da la fecha en UTC: entre las 19:00 y la medianoche de
 * Perú ya devolvía el día siguiente, así que el buscador se abría con la fecha equivocada
 * justo en las horas de más consulta (BP-12).
 */
export function todayIso(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: PERU_TIME_ZONE }).format(new Date());
}
