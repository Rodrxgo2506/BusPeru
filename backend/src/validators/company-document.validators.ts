import { z } from 'zod';
import { DOCUMENT_TYPES } from '../repositories/company-document.repository';

/**
 * Validación de los documentos de verificación (mockups 13 y 14).
 *
 * Los esquemas describen SOLO lo que la empresa puede enviar. `id`, `company_id`,
 * `status`, `reviewed_by`, `reviewed_at`, `file_url` y `created_at` no aparecen: Zod los
 * descarta y el repositorio no los acepta. Un documento siempre nace PENDING.
 */

const notes = z
  .string()
  .trim()
  .max(500, 'El comentario es demasiado largo')
  .nullable()
  .optional()
  .transform((value) => value || undefined);

export const uploadDocumentSchema = z.object({
  type: z.enum(DOCUMENT_TYPES, { errorMap: () => ({ message: 'Tipo de documento inválido' }) }),
  notes,
});

/**
 * Revisión administrativa. Solo admite los dos desenlaces: verificar o rechazar.
 * `PENDING` no es un destino válido — un documento vuelve a pendiente subiendo otra
 * versión, no por decisión del revisor.
 */
export const reviewDocumentSchema = z
  .object({
    status: z.enum(['VERIFIED', 'REJECTED'], { errorMap: () => ({ message: 'La revisión solo puede verificar o rechazar' }) }),
    notes,
  })
  .refine((value) => value.status !== 'REJECTED' || Boolean(value.notes), {
    message: 'Indica el motivo del rechazo',
    path: ['notes'],
  });

export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>;
export type ReviewDocumentInput = z.infer<typeof reviewDocumentSchema>;
