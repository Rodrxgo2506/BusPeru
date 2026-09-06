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
 * MySQL returns `YYYY-MM-DD HH:mm:ss`; Safari needs the ISO separator.
 *
 * Una fecha suelta `YYYY-MM-DD` la interpreta JavaScript como medianoche UTC, así que al
 * mostrarla en hora de Perú (UTC-5) retrocedía un día: 2026-09-06 se veía como el 05. Se
 * le añade la hora para que se lea como medianoche local.
 */
function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value.replace(' ', 'T');
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDate(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatLongDate(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatTime(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', hour12: false });
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

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
