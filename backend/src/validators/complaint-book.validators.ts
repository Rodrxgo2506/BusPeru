import { z } from 'zod';

/**
 * F18-19 · Libro de Reclamaciones virtual.
 *
 * TEXTO PLANO SIEMPRE. El frontend pinta estos textos escapados (React), así que un `<script>` nunca
 * se ejecutaría; aun así se RECHAZA cualquier cosa con forma de etiqueta HTML, para que el contenido
 * guardado no dependa de cómo lo pinte quien lo lea (correo, exportación, otro cliente).
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
