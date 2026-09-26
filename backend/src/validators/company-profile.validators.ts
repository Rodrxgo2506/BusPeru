import { z } from 'zod';

/**
 * F18-19 · perfil público de empresas y Libro de Reclamaciones.
 *
 * TEXTO PLANO SIEMPRE. El frontend pinta estos textos escapados (React), así que un `<script>` nunca
 * se ejecutaría; aun así se RECHAZA cualquier cosa con forma de etiqueta HTML, para que el contenido
 * guardado no dependa de cómo lo pinte quien lo lea (correo, exportación, otro cliente).
 *
 * Nada de imágenes por el cuerpo: entran solo por los endpoints de subida, que validan el archivo y
 * generan la referencia en el servidor. Nada de `company_id` por el cuerpo: la empresa sale de la sesión.
 */

const HTML_TAG = /<\s*\/?\s*[a-z!?][^>]*>|<\s*\/?\s*(script|style|iframe|img|svg|object|embed|a)\b/i;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function limpio(value: string): string {
  return value.replace(CONTROL, '').replace(/\r\n?/g, '\n').trim();
}

/** Texto plano obligatorio, sin HTML, con longitud acotada. */
export const plainText = (max: number, min = 1) =>
  z
    .string()
    .transform(limpio)
    .pipe(
      z
        .string()
        .min(min, 'Este campo es obligatorio')
        .max(max, `Admite como máximo ${max} caracteres`)
        .refine((v) => !HTML_TAG.test(v), 'No se admite HTML: escribe texto plano'),
    );

/** Texto plano opcional: vacío → null. */
export const optionalPlainText = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === null ? null : limpio(v) || null))
    .pipe(
      z
        .string()
        .max(max, `Admite como máximo ${max} caracteres`)
        .refine((v) => !HTML_TAG.test(v), 'No se admite HTML: escribe texto plano')
        .nullable()
        .optional(),
    );

/** Teléfono peruano o internacional: dígitos, espacios, guiones y paréntesis; de 6 a 15 dígitos. */
export const PHONE = /^\+?[0-9 ()-]{6,24}$/;
const phoneValue = z
  .string()
  .transform(limpio)
  .pipe(
    z
      .string()
      .regex(PHONE, 'Teléfono inválido: usa solo dígitos, espacios, guiones o +')
      .refine((v) => {
        const digits = v.replace(/\D/g, '').length;
        return digits >= 6 && digits <= 15;
      }, 'El teléfono debe tener entre 6 y 15 dígitos'),
  );
export const optionalPhone = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === null || limpio(v) === '' ? null : v))
  .pipe(z.union([phoneValue, z.null()]).optional());

const emailValue = z.string().trim().toLowerCase().max(150).email('Correo electrónico inválido');
export const optionalEmail = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v))
  .pipe(z.union([emailValue, z.null()]).optional());

/** Solo https: una web de empresa servida sin cifrar no se enlaza desde BusPerú. */
export function isSafeHttpsUrl(value: string, hosts?: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (!hosts) return /\./.test(url.hostname);
  const host = url.hostname.toLowerCase();
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

const httpsUrl = z
  .string()
  .trim()
  .max(300, 'Admite como máximo 300 caracteres')
  .refine((v) => isSafeHttpsUrl(v), 'Usa una dirección completa que empiece por https://');
export const optionalHttpsUrl = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v))
  .pipe(z.union([httpsUrl, z.null()]).optional());

/** Redes sociales admitidas y sus dominios oficiales: un enlace de «Facebook» a otro sitio se rechaza. */
export const SOCIAL_NETWORKS = {
  facebook: ['facebook.com', 'fb.com'],
  instagram: ['instagram.com'],
  tiktok: ['tiktok.com'],
  youtube: ['youtube.com', 'youtu.be'],
  x: ['x.com', 'twitter.com'],
  linkedin: ['linkedin.com'],
} as const;
export type SocialNetwork = keyof typeof SOCIAL_NETWORKS;

const socialLinks = z
  .record(z.string(), z.union([z.string(), z.null()]))
  .nullable()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const out: Partial<Record<SocialNetwork, string>> = {};
    for (const [network, raw] of Object.entries(value)) {
      if (!(network in SOCIAL_NETWORKS)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Red social no admitida: ${network}` });
        continue;
      }
      const url = (raw ?? '').trim();
      if (url === '') continue;
      if (url.length > 300 || !isSafeHttpsUrl(url, SOCIAL_NETWORKS[network as SocialNetwork])) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `El enlace de ${network} debe ser https://…${SOCIAL_NETWORKS[network as SocialNetwork][0]}` });
        continue;
      }
      out[network as SocialNetwork] = url;
    }
    return Object.keys(out).length > 0 ? out : null;
  });

/** Lista de textos cortos sin repetidos (valores, características). */
const textList = (maxItems: number, maxLength: number, label: string) =>
  z
    .array(plainText(maxLength))
    .max(maxItems, `Como máximo ${maxItems} ${label}`)
    .nullable()
    .optional()
    .transform((list) => {
      if (list === undefined) return undefined;
      if (list === null) return null;
      const seen = new Set<string>();
      const unique = list.filter((item) => {
        const key = item.toLocaleLowerCase('es');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return unique.length > 0 ? unique : null;
    });

// ---------------------------------------------------------------------------- perfil
export const updateCompanyProfileSchema = z
  .object({
    tagline: optionalPlainText(300),
    about_title: optionalPlainText(150),
    about_body: optionalPlainText(6000),
    history: optionalPlainText(6000),
    mission: optionalPlainText(2000),
    vision: optionalPlainText(2000),
    values_list: textList(12, 80, 'valores'),
    contact_phone: optionalPhone,
    contact_whatsapp: optionalPhone,
    contact_email: optionalEmail,
    website_url: optionalHttpsUrl,
    social_links: socialLinks,
    main_address: optionalPlainText(255),
  })
  .strict()
  .refine((value) => Object.values(value).some((v) => v !== undefined), { message: 'Debes enviar al menos un campo para actualizar' });

/** Solo el ADMIN cambia la URL pública: es información crítica (enlaces compartidos, SEO). */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const updateProfileSlugSchema = z.object({
  slug: z.string().trim().toLowerCase().min(3).max(120).regex(SLUG_PATTERN, 'El slug solo admite minúsculas sin tildes, números y guiones'),
});

// ---------------------------------------------------------------------------- servicios
const serviceShape = {
  name: plainText(100),
  description: optionalPlainText(2000),
  features: textList(20, 100, 'características'),
  display_order: z.coerce.number().int().min(0).max(100000).optional(),
};
export const createCompanyServiceSchema = z.object(serviceShape).strict();
export const updateCompanyServiceSchema = z
  .object(serviceShape)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Debes enviar al menos un campo para actualizar' });

// ---------------------------------------------------------------------------- agencias
/** Servicios que puede prestar una agencia. Catálogo cerrado: se muestran con su etiqueta en español. */
export const AGENCY_SERVICES = ['TICKET_SALES', 'BOARDING', 'PARCELS', 'CUSTOMER_SERVICE', 'BAGGAGE_STORAGE', 'WAITING_ROOM'] as const;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const range = z
  .object({ open: z.string().regex(TIME, 'Hora inválida (HH:MM)'), close: z.string().regex(TIME, 'Hora inválida (HH:MM)') })
  .strict()
  .refine((r) => r.open < r.close, 'La hora de apertura debe ser anterior a la de cierre');

/** Un día: cerrado, o de 1 a 3 tramos (horario dividido) sin solaparse. Un día ausente = «no informado». */
const dayHours = z
  .union([z.object({ closed: z.literal(true) }).strict(), z.object({ ranges: z.array(range).min(1).max(3) }).strict()])
  .refine((day) => {
    if (!('ranges' in day)) return true;
    const sorted = [...day.ranges].sort((a, b) => a.open.localeCompare(b.open));
    return sorted.every((r, i) => i === 0 || sorted[i - 1]!.close <= r.open);
  }, 'Los tramos del día se solapan');

export const WEEK_DAYS = ['1', '2', '3', '4', '5', '6', '7'] as const; // ISO: 1 = lunes … 7 = domingo
const weeklyHours = z
  .record(z.enum(WEEK_DAYS), dayHours)
  .nullable()
  .optional()
  .transform((v) => (v === undefined ? undefined : v === null || Object.keys(v).length === 0 ? null : v));

const specialDay = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)'),
    closed: z.boolean().optional(),
    ranges: z.array(range).min(1).max(3).optional(),
    note: optionalPlainText(120),
  })
  .strict()
  .refine((d) => Boolean(d.closed) !== Boolean(d.ranges), 'Un horario especial es «cerrado» o tiene tramos, no ambos')
  .refine((d) => !Number.isNaN(Date.parse(`${d.date}T00:00:00Z`)), 'Fecha inválida');
const specialHours = z
  .array(specialDay)
  .max(30, 'Como máximo 30 fechas especiales')
  .nullable()
  .optional()
  .transform((v) => (v === undefined ? undefined : v === null || v.length === 0 ? null : v))
  .refine((v) => !v || new Set(v.map((d) => d.date)).size === v.length, 'Hay fechas especiales repetidas');

/** El Perú está dentro de este recuadro: una coordenada fuera suele ser latitud y longitud cruzadas. */
export const PERU_BOUNDS = { minLat: -18.6, maxLat: 0.2, minLng: -81.6, maxLng: -68.4 };
const latitude = z.coerce.number().min(PERU_BOUNDS.minLat, 'Latitud fuera del Perú').max(PERU_BOUNDS.maxLat, 'Latitud fuera del Perú');
const longitude = z.coerce.number().min(PERU_BOUNDS.minLng, 'Longitud fuera del Perú').max(PERU_BOUNDS.maxLng, 'Longitud fuera del Perú');

const agencyShape = {
  name: plainText(150),
  city: plainText(150),
  department: optionalPlainText(150),
  location_id: z.coerce.number().int().positive().nullable().optional(),
  address: plainText(255),
  reference: optionalPlainText(255),
  phone: optionalPhone,
  whatsapp: optionalPhone,
  email: optionalEmail,
  latitude: latitude.nullable().optional(),
  longitude: longitude.nullable().optional(),
  services: z
    .array(z.enum(AGENCY_SERVICES))
    .max(AGENCY_SERVICES.length)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === null || v.length === 0 ? null : [...new Set(v)])),
  weekly_hours: weeklyHours,
  special_hours: specialHours,
  display_order: z.coerce.number().int().min(0).max(100000).optional(),
};
const coordinatesTogether = (v: { latitude?: number | null; longitude?: number | null }) =>
  (v.latitude === undefined) === (v.longitude === undefined) && (v.latitude === null) === (v.longitude === null);

export const createCompanyAgencySchema = z
  .object(agencyShape)
  .strict()
  .refine(coordinatesTogether, 'Latitud y longitud van juntas');
export const updateCompanyAgencySchema = z
  .object(agencyShape)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Debes enviar al menos un campo para actualizar' })
  .refine(coordinatesTogether, 'Latitud y longitud van juntas');

// ---------------------------------------------------------------------------- galería
export const GALLERY_CATEGORIES = ['BUS', 'INTERIOR', 'EXTERIOR', 'AGENCY', 'OFFICE', 'FACILITIES', 'OTHER'] as const;
const galleryShape = {
  title: optionalPlainText(120),
  description: optionalPlainText(500),
  category: z.enum(GALLERY_CATEGORIES).optional(),
  display_order: z.coerce.number().int().min(0).max(100000).optional(),
};
/** Metadatos que acompañan al archivo en el multipart (todos opcionales). */
export const createGalleryImageSchema = z.object(galleryShape).strict();
export const updateGalleryImageSchema = z
  .object(galleryShape)
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Debes enviar al menos un campo para actualizar' });

// ---------------------------------------------------------------------------- comunes
export const setActiveSchema = z.object({ is_active: z.boolean() }).strict();
export const reorderSchema = z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(200) }).strict();

export const MODERATION_ENTITIES = ['profile', 'service', 'agency', 'gallery'] as const;
export const MODERATION_ACTIONS = ['approve', 'reject', 'suspend', 'unsuspend'] as const;
export const moderationSchema = z
  .object({
    entity: z.enum(MODERATION_ENTITIES),
    id: z.coerce.number().int().positive().optional(),
    action: z.enum(MODERATION_ACTIONS),
    note: optionalPlainText(500),
  })
  .strict()
  .refine((v) => v.entity === 'profile' || v.id !== undefined, { message: 'Indica el id del elemento' })
  .refine((v) => !['reject', 'suspend'].includes(v.action) || Boolean(v.note), { message: 'Indica el motivo: se muestra a la empresa' });

// ---------------------------------------------------------------------------- Libro de Reclamaciones
export const DOCUMENT_TYPES = ['DNI', 'CE', 'PASAPORTE', 'RUC', 'OTRO'] as const;
const DOCUMENT_FORMATS: Record<(typeof DOCUMENT_TYPES)[number], RegExp> = {
  DNI: /^\d{8}$/,
  CE: /^[A-Za-z0-9]{8,12}$/,
  PASAPORTE: /^[A-Za-z0-9]{6,12}$/,
  RUC: /^(10|15|17|20)\d{9}$/,
  OTRO: /^[A-Za-z0-9-]{4,20}$/,
};

const requiredPhone = phoneValue;
const requiredEmail = emailValue;

/**
 * Hoja de Reclamación virtual (DS 011-2011-PCM, art. 5 y Anexo 1). Todos los campos mínimos son
 * obligatorios: el reglamento considera «no puesto» un reclamo sin ellos. `accepted` reemplaza la firma.
 */
export const createComplaintSchema = z
  .object({
    kind: z.enum(['RECLAMO', 'QUEJA']),
    consumer_name: plainText(150, 3),
    consumer_document_type: z.enum(DOCUMENT_TYPES),
    consumer_document_number: z.string().trim().min(4).max(20),
    consumer_address: plainText(255, 5),
    consumer_phone: requiredPhone,
    consumer_email: requiredEmail,
    is_minor: z.boolean().default(false),
    guardian_name: optionalPlainText(150),
    guardian_address: optionalPlainText(255),
    guardian_phone: optionalPhone,
    guardian_email: optionalEmail,
    item_type: z.enum(['PRODUCTO', 'SERVICIO']).default('SERVICIO'),
    item_description: plainText(500, 3),
    claimed_amount: z.coerce.number().min(0).max(99999999.99).nullable().optional(),
    booking_code: optionalPlainText(30),
    company_id: z.coerce.number().int().positive().nullable().optional(),
    detail: plainText(3000, 10),
    request: plainText(2000, 5),
    accepted: z.literal(true, { errorMap: () => ({ message: 'Debes confirmar que los datos de la hoja son correctos' }) }),
  })
  .strict()
  .refine((v) => DOCUMENT_FORMATS[v.consumer_document_type].test(v.consumer_document_number), {
    message: 'Número de documento inválido para el tipo elegido',
    path: ['consumer_document_number'],
  })
  .refine((v) => !v.is_minor || Boolean(v.guardian_name && v.guardian_address && v.guardian_phone && v.guardian_email), {
    message: 'Si el consumidor es menor de edad, completa los datos de su padre, madre o representante',
    path: ['guardian_name'],
  });

export const lookupComplaintSchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^LR-\d{4}-\d{6}$/, 'Código inválido (LR-AAAA-000000)'),
    document_number: z.string().trim().min(4).max(20),
  })
  .strict();

export const COMPLAINT_STATUSES = ['RECEIVED', 'IN_REVIEW', 'ANSWERED', 'CLOSED'] as const;
export const updateComplaintSchema = z
  .object({
    status: z.enum(['IN_REVIEW', 'CLOSED']).optional(),
    response: optionalPlainText(5000),
    response_channel: z.enum(['EMAIL', 'CARTA']).optional(),
  })
  .strict()
  .refine((v) => v.status !== undefined || Boolean(v.response), { message: 'Indica un estado o una respuesta' })
  .refine((v) => !v.response || v.response_channel !== undefined, { message: 'Indica el canal de la respuesta', path: ['response_channel'] });

export const complaintNoteSchema = z.object({ note: plainText(2000, 3) }).strict();
