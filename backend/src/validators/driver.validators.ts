import { z } from 'zod';

/**
 * Validación del personal de conducción (mockup 31).
 *
 * Los esquemas describen solo las columnas escribibles de `drivers`. Zod descarta el
 * resto, así que `id`, `company_id`, `created_at` o `trips_count` que llegaran en el
 * cuerpo se pierden aquí; la lista blanca del repositorio es la segunda barrera.
 */

/** DNI peruano (8 dígitos) o carné de extranjería (9 a 12 caracteres alfanuméricos). */
const documentNumber = z
  .string()
  .trim()
  .min(8, 'El documento debe tener al menos 8 caracteres')
  .max(30, 'El documento es demasiado largo')
  .regex(/^[A-Za-z0-9-]+$/, 'El documento solo admite letras, números y guiones');

/** Licencia de conducir del MTC: una letra y ocho dígitos, con separadores opcionales. */
const licenseNumber = z
  .string()
  .trim()
  .min(6, 'El número de licencia es demasiado corto')
  .max(50, 'El número de licencia es demasiado largo')
  .regex(/^[A-Za-z0-9-]+$/, 'La licencia solo admite letras, números y guiones');

const phone = z
  .string()
  .trim()
  .max(30, 'El teléfono es demasiado largo')
  .regex(/^[0-9+()\s-]+$/, 'El teléfono solo admite dígitos y los signos + ( ) -')
  .nullable()
  .optional();

const licenseExpiresAt = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener el formato AAAA-MM-DD')
  .nullable()
  .optional();

const shape = {
  first_name: z.string().trim().min(2, 'Ingresa los nombres').max(100),
  last_name: z.string().trim().min(2, 'Ingresa los apellidos').max(100),
  document_number: documentNumber,
  license_number: licenseNumber,
  license_expires_at: licenseExpiresAt,
  phone,
  /**
   * `null` equivale a "no lo toques": el formulario genérico envía null cuando un campo
   * opcional se deja vacío, y `status` es NOT NULL en la base. Se traduce a undefined para
   * que la lista blanca del repositorio lo descarte en lugar de intentar escribir NULL.
   */
  status: z
    .enum(['ACTIVE', 'INACTIVE'], { errorMap: () => ({ message: 'Estado inválido' }) })
    .nullable()
    .optional()
    .transform((value) => value ?? undefined),
};

export const createDriverSchema = z.object(shape);

export const updateDriverSchema = z
  .object({
    first_name: shape.first_name.optional(),
    last_name: shape.last_name.optional(),
    document_number: documentNumber.optional(),
    license_number: licenseNumber.optional(),
    license_expires_at: licenseExpiresAt,
    phone,
    status: shape.status,
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Debes enviar al menos un campo para actualizar' });

export type CreateDriverInput = z.infer<typeof createDriverSchema>;
export type UpdateDriverInput = z.infer<typeof updateDriverSchema>;
