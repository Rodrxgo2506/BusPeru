/**
 * F18-20 · utilidades puras del sitio público de cada empresa (`/empresas/:slug/*`). Sin React ni DOM: se prueban con
 * `node --test`. La navegación, los metadatos por ruta, los destacados del Inicio y los mensajes de contacto salen de
 * aquí para que las páginas solo pinten.
 */
import { whatsappUrl } from './company-profile.ts';

export type CompanySection = 'inicio' | 'nosotros' | 'servicios' | 'agencias' | 'destinos' | 'flota' | 'opiniones' | 'contacto';

/**
 * Secciones del sitio, en el orden del menú. Cada una es una ruta propia; la galería NO es una ruta: vive en Nosotros.
 */
export const COMPANY_SITE_SECTIONS: ReadonlyArray<{ id: CompanySection; label: string; path: string }> = [
  { id: 'inicio', label: 'Inicio', path: '' },
  { id: 'nosotros', label: 'Nosotros', path: 'nosotros' },
  { id: 'servicios', label: 'Servicios', path: 'servicios' },
  { id: 'agencias', label: 'Agencias', path: 'agencias' },
  { id: 'destinos', label: 'Destinos', path: 'destinos' },
  { id: 'flota', label: 'Flota', path: 'flota' },
  { id: 'opiniones', label: 'Opiniones', path: 'opiniones' },
  { id: 'contacto', label: 'Contacto', path: 'contacto' },
];

const LABELS = Object.fromEntries(COMPANY_SITE_SECTIONS.map((s) => [s.id, s.label])) as Record<CompanySection, string>;

export function sectionLabel(section: CompanySection): string {
  return LABELS[section];
}

/** Ruta de una sección. El slug es el del backend (nunca derivado del nombre) y va codificado. */
export function companySitePath(slug: string, section: CompanySection = 'inicio'): string {
  const base = `/empresas/${encodeURIComponent(slug)}`;
  const entry = COMPANY_SITE_SECTIONS.find((s) => s.id === section);
  return entry && entry.path ? `${base}/${entry.path}` : base;
}

/** Enlaces del menú interno: `end` en Inicio para que no quede activo en todas las subpáginas. */
export function companySiteNav(slug: string): Array<{ id: CompanySection; label: string; to: string; end: boolean }> {
  return COMPANY_SITE_SECTIONS.map((s) => ({ id: s.id, label: s.label, to: companySitePath(slug, s.id), end: s.id === 'inicio' }));
}

// ------------------------------------------------------------------------------------------------ SEO
const DESCRIPTION_MAX = 160;

export function clip(text: string, max = DESCRIPTION_MAX): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:—-]+$/, '')}…`;
}

export interface SiteMetaInput {
  name: string;
  tagline?: string | null;
  description?: string | null;
  aboutBody?: string | null;
}

/**
 * Título y descripción de cada ruta. Inicio: «<Empresa> | BusPerú»; subpáginas: «<Sección> | <Empresa>».
 * La descripción usa texto de la empresa cuando existe y una frase neutra si no (nunca datos inventados).
 */
export function companyPageMeta(section: CompanySection, input: SiteMetaInput): { title: string; description: string } {
  const { name } = input;
  const own = input.tagline || input.description || null;
  const descriptions: Record<CompanySection, string> = {
    inicio: own ?? `${name}: empresa de transporte interprovincial en BusPerú. Destinos, agencias, servicios y viajes disponibles.`,
    nosotros: input.aboutBody || `Conoce a ${name}: quiénes somos, misión, visión, valores y galería de fotos.`,
    servicios: `Servicios de viaje de ${name}: modalidades, comodidades y características a bordo.`,
    agencias: `Agencias de ${name}: direcciones, horarios de atención y servicios por ciudad.`,
    destinos: `Destinos de ${name}: rutas, orígenes, viajes programados y precios desde. Busca y compra tu pasaje en BusPerú.`,
    flota: `Flota de ${name}: tipos de bus, capacidad y comodidades.`,
    opiniones: `Opiniones de pasajeros que viajaron con ${name}: valoración media, distribución y respuestas de la empresa.`,
    contacto: `Contacta con ${name}: teléfono, correo, WhatsApp y redes sociales.`,
  };
  return {
    title: section === 'inicio' ? `${name} | BusPerú` : `${sectionLabel(section)} | ${name}`,
    description: clip(descriptions[section]),
  };
}

/** JSON-LD `BreadcrumbList` de una subpágina (Inicio usa `Organization`). URLs con el origen real. */
export function breadcrumbJsonLd(origin: string, slug: string, name: string, section: CompanySection): Record<string, unknown> {
  const base = origin.replace(/\/+$/, '');
  const items = [
    { name: 'Empresas', url: `${base}/empresas` },
    { name, url: `${base}${companySitePath(slug)}` },
    ...(section === 'inicio' ? [] : [{ name: sectionLabel(section), url: `${base}${companySitePath(slug, section)}` }]),
  ];
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({ '@type': 'ListItem', position: index + 1, name: item.name, item: item.url })),
  };
}

// ------------------------------------------------------------------------------------------------ Inicio
/** El Inicio muestra un RESUMEN: pocas tarjetas y un enlace a la página completa. */
export const HOME_LIMITS = { destinations: 3, services: 3 } as const;

export function homeHighlights<D, S>(destinations: readonly D[], services: readonly S[]) {
  return {
    destinations: destinations.slice(0, HOME_LIMITS.destinations),
    moreDestinations: destinations.length > HOME_LIMITS.destinations,
    services: services.slice(0, HOME_LIMITS.services),
    moreServices: services.length > HOME_LIMITS.services,
  };
}

// ------------------------------------------------------------------------------------------------ viajes
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Fecha para el buscador: la próxima salida si el backend la conoce (y es válida y no pasada); si no, hoy. */
export function tripDate(next: string | null | undefined, today: string): string {
  return next && ISO_DATE.test(next) && next >= today ? next : today;
}

/** Origen con la salida más próxima hacia un destino (o el primero si ninguno tiene salidas). */
export function bestOrigin(origins: ReadonlyArray<{ city: string; next_departure_date?: string | null }>): { city: string; next_departure_date?: string | null } | null {
  const withTrips = origins.filter((o) => o.next_departure_date && ISO_DATE.test(o.next_departure_date));
  if (withTrips.length) return [...withTrips].sort((a, b) => String(a.next_departure_date).localeCompare(String(b.next_departure_date)))[0]!;
  return origins[0] ?? null;
}

/** Buscador de viajes de la empresa (flujo real de `/buscar`). */
export function companyTripsUrl(companyId: number, next: string | null | undefined, today: string): string {
  const query = new URLSearchParams({ company_id: String(companyId), date: tripDate(next, today) });
  return `/buscar?${query.toString()}`;
}

// ------------------------------------------------------------------------------------------------ contacto
export interface ContactDraft {
  name: string;
  phone: string;
  email: string;
  message: string;
}

export type ContactErrors = Partial<Record<keyof ContactDraft, string>>;

export const CONTACT_LIMITS = { name: 80, phone: 20, email: 120, messageMin: 10, messageMax: 1000 } as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateContact(draft: ContactDraft): ContactErrors {
  const errors: ContactErrors = {};
  const name = draft.name.trim();
  const phone = draft.phone.trim();
  const email = draft.email.trim();
  const message = draft.message.trim();
  if (!name) errors.name = 'Escribe tu nombre.';
  else if (name.length > CONTACT_LIMITS.name) errors.name = `Máximo ${CONTACT_LIMITS.name} caracteres.`;
  if (phone && (!/^[+\d][\d\s-]*$/.test(phone) || phone.replace(/\D/g, '').length < 6 || phone.length > CONTACT_LIMITS.phone)) {
    errors.phone = 'Escribe un teléfono válido (solo números, espacios, «+» o «-»).';
  }
  if (email && (!EMAIL.test(email) || email.length > CONTACT_LIMITS.email)) errors.email = 'Escribe un correo válido.';
  if (!phone && !email) errors.email = errors.email ?? 'Indica un correo o un teléfono para que puedan responderte.';
  if (message.length < CONTACT_LIMITS.messageMin) errors.message = `Escribe tu consulta (mínimo ${CONTACT_LIMITS.messageMin} caracteres).`;
  else if (message.length > CONTACT_LIMITS.messageMax) errors.message = `Máximo ${CONTACT_LIMITS.messageMax} caracteres.`;
  return errors;
}

function contactBody(draft: ContactDraft): string {
  const lines = [draft.message.trim(), '', `— ${draft.name.trim()}`];
  if (draft.phone.trim()) lines.push(`Teléfono: ${draft.phone.trim()}`);
  if (draft.email.trim()) lines.push(`Correo: ${draft.email.trim()}`);
  lines.push('', 'Enviado desde el sitio de la empresa en BusPerú.');
  return lines.join('\n');
}

/** Solo direcciones de correo simples: nada de `?`, `&` ni saltos que puedan alterar el `mailto:`. */
export function isSafeEmail(value: string | null | undefined): value is string {
  return Boolean(value && EMAIL.test(value) && !/[?&#\s,;<>"']/.test(value));
}

/**
 * Correo prellenado para la empresa. BusPerú no guarda el mensaje: se abre el cliente de correo del visitante.
 * `null` si la empresa no tiene un correo válido.
 */
export function contactMailto(to: string | null | undefined, companyName: string, subject: string, draft: ContactDraft): string | null {
  if (!isSafeEmail(to)) return null;
  const params = `subject=${encodeURIComponent(`${subject} · ${companyName}`)}&body=${encodeURIComponent(contactBody(draft))}`;
  return `mailto:${to}?${params}`;
}

/** Mismo mensaje por WhatsApp (si la empresa lo configuró). */
export function contactWhatsapp(phone: string | null | undefined, draft: ContactDraft): string | null {
  const base = phone ? whatsappUrl(phone) : null;
  return base ? `${base}?text=${encodeURIComponent(contactBody(draft))}` : null;
}

// ------------------------------------------------------------------------------------------------ imágenes
/**
 * Imagen del banner de cada página: solo imágenes de la propia empresa (portada; en Nosotros, la de «Nosotros» si
 * no hay portada). Nunca una imagen externa ni de catálogo: sin imagen, el banner usa el degradado de BusPerú.
 */
export function heroImagePath(section: CompanySection, profile: { cover_image?: string | null; about_image?: string | null }): string | null {
  if (profile.cover_image) return profile.cover_image;
  if (section === 'nosotros' && profile.about_image) return profile.about_image;
  return null;
}

/** Índice circular del carrusel de la galería. */
export function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}
