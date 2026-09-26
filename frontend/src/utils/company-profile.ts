/**
 * F18-19 · utilidades puras del perfil público de empresas (sin React ni DOM: se prueban con `node --test`).
 */
import type { AgencyService, DayHours, GalleryCategory, ReviewStatus, SocialNetwork, SpecialHours, WeeklyHours } from '../types/company-profile';

export const AGENCY_SERVICE_LABELS: Record<AgencyService, string> = {
  TICKET_SALES: 'Venta de pasajes',
  BOARDING: 'Embarque',
  PARCELS: 'Encomiendas',
  CUSTOMER_SERVICE: 'Atención al cliente',
  BAGGAGE_STORAGE: 'Custodia de equipaje',
  WAITING_ROOM: 'Sala de espera',
};

export const GALLERY_CATEGORY_LABELS: Record<GalleryCategory, string> = {
  BUS: 'Buses',
  INTERIOR: 'Interiores',
  EXTERIOR: 'Exteriores',
  AGENCY: 'Agencias',
  OFFICE: 'Oficinas',
  FACILITIES: 'Instalaciones',
  OTHER: 'Otras',
};

export const SOCIAL_LABELS: Record<SocialNetwork, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  x: 'X',
  linkedin: 'LinkedIn',
};

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  DRAFT: 'Borrador',
  PENDING: 'En revisión',
  APPROVED: 'Aprobado',
  REJECTED: 'Rechazado',
};

/** Libro de Reclamaciones: estados y eventos del historial en castellano. */
export const COMPLAINT_STATUS_LABELS: Record<string, string> = {
  RECEIVED: 'Recibida',
  IN_REVIEW: 'En revisión',
  ANSWERED: 'Respondida',
  CLOSED: 'Cerrada',
};

export const COMPLAINT_EVENT_LABELS: Record<string, string> = {
  CREATED: 'Hoja registrada',
  COPY_EMAILED: 'Copia enviada al consumidor',
  STATUS_CHANGED: 'Cambio de estado',
  RESPONSE_SENT: 'Respuesta registrada',
  INTERNAL_NOTE: 'Nota interna',
  COMPANY_NOTE: 'Descargo de la empresa',
};

/** «Cambio de estado → Cerrada» (el código se muestra tal cual si no se conoce). */
export function complaintEventLabel(event: string, toStatus: string | null | undefined): string {
  const label = COMPLAINT_EVENT_LABELS[event] ?? event;
  return toStatus ? `${label} → ${COMPLAINT_STATUS_LABELS[toStatus] ?? toStatus}` : label;
}

/** ISO: 1 = lunes … 7 = domingo. */
export const WEEK_DAYS: Array<{ key: '1' | '2' | '3' | '4' | '5' | '6' | '7'; label: string; short: string }> = [
  { key: '1', label: 'Lunes', short: 'Lun' },
  { key: '2', label: 'Martes', short: 'Mar' },
  { key: '3', label: 'Miércoles', short: 'Mié' },
  { key: '4', label: 'Jueves', short: 'Jue' },
  { key: '5', label: 'Viernes', short: 'Vie' },
  { key: '6', label: 'Sábado', short: 'Sáb' },
  { key: '7', label: 'Domingo', short: 'Dom' },
];

/** «06:00 – 13:00 · 14:00 – 22:00», «Cerrado» o «No informado» (nunca se inventa un horario). */
export function formatDayHours(day: DayHours | undefined | null): string {
  if (!day) return 'No informado';
  if ('closed' in day) return 'Cerrado';
  return day.ranges.map((range) => `${range.open} – ${range.close}`).join(' · ');
}

export function hasAnyHours(weekly: WeeklyHours | null | undefined): boolean {
  return Boolean(weekly && Object.keys(weekly).length > 0);
}

/** Fechas especiales de hoy en adelante, ordenadas (como mucho `max`). */
export function upcomingSpecialHours(special: SpecialHours[] | null | undefined, todayIso: string, max = 5): SpecialHours[] {
  return (special ?? []).filter((day) => day.date >= todayIso).sort((a, b) => a.date.localeCompare(b.date)).slice(0, max);
}

export function formatSpecialHours(day: SpecialHours): string {
  return day.closed ? 'Cerrado' : (day.ranges ?? []).map((range) => `${range.open} – ${range.close}`).join(' · ');
}

/** Agencias agrupadas por ciudad: primero la ciudad con más agencias, luego alfabético. */
export function groupByCity<T extends { city: string }>(items: T[]): Array<{ city: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(item.city, [...(groups.get(item.city) ?? []), item]);
  return [...groups.entries()]
    .map(([city, list]) => ({ city, items: list }))
    .sort((a, b) => b.items.length - a.items.length || a.city.localeCompare(b.city, 'es'));
}

/** El Perú está dentro de este recuadro (mismo criterio que la API). */
export const PERU_BOUNDS = { minLat: -18.6, maxLat: 0.2, minLng: -81.6, maxLng: -68.4 };

export function isValidCoordinate(lat: number | null | undefined, lng: number | null | undefined): lat is number {
  return (
    typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= PERU_BOUNDS.minLat && lat <= PERU_BOUNDS.maxLat && lng >= PERU_BOUNDS.minLng && lng <= PERU_BOUNDS.maxLng
  );
}

const fixed = (value: number) => value.toFixed(6);

/** Mapa embebido de OpenStreetMap (sin clave ni coste). Solo se carga cuando el usuario lo pide. */
export function osmEmbedUrl(lat: number, lng: number): string {
  const bbox = [lng - 0.006, lat - 0.004, lng + 0.006, lat + 0.004].map(fixed).join(',');
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${fixed(lat)},${fixed(lng)}`;
}

export function osmLinkUrl(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${fixed(lat)}&mlon=${fixed(lng)}#map=17/${fixed(lat)}/${fixed(lng)}`;
}

/** «Cómo llegar»: esquema de URL público de Google Maps (navegación, sin API ni clave). */
export function directionsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${fixed(lat)},${fixed(lng)}`;
}

/** wa.me exige el número con código de país: un celular peruano de 9 dígitos recibe el 51. */
export function whatsappUrl(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return null;
  const full = digits.length === 9 && digits.startsWith('9') ? `51${digits}` : digits;
  return `https://wa.me/${full}`;
}

export function telUrl(phone: string): string | null {
  const clean = phone.replace(/[^\d+]/g, '');
  return clean.replace(/\D/g, '').length >= 6 ? `tel:${clean}` : null;
}

/** Enlace externo seguro para pintar: solo https. Cualquier otra cosa no se enlaza. */
export function safeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** «Ver viajes»: el buscador existente, filtrado por la empresa, el origen y el destino. */
export function searchTripsUrl(params: { origin?: string | null; destination: string; companyId: number; date: string }): string {
  const query = new URLSearchParams();
  if (params.origin) query.set('origin', params.origin);
  query.set('destination', params.destination);
  query.set('date', params.date);
  query.set('company_id', String(params.companyId));
  return `/buscar?${query.toString()}`;
}

/** Porcentaje de cada nota en la distribución de opiniones (0 si no hay opiniones). */
export function ratingShare(distribution: Record<string, number>, stars: number, total: number): number {
  if (!total) return 0;
  return Math.round(((distribution[String(stars)] ?? 0) / total) * 100);
}

/** Capacidad «40 asientos» o «40–52 asientos». */
export function capacityLabel(min: number, max: number): string {
  return min === max ? `${min} asientos` : `${min}–${max} asientos`;
}
