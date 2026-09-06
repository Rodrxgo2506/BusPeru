import { z } from 'zod';

export const id = z.coerce.number().int().positive();
export const optionalId = id.nullable().optional();
export const money = z.coerce.number().min(0, 'El monto no puede ser negativo');
export const shortText = (max: number) => z.string().trim().min(1).max(max);
export const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
export const datetime = z.string().min(1, 'Fecha requerida');

export const activeStatus = z.enum(['ACTIVE', 'INACTIVE']);

/** Turns a create schema into an update schema where every field is optional but at least one is required. */
export function toUpdateSchema<T extends z.ZodRawShape>(shape: T) {
  return z
    .object(shape)
    .partial()
    .refine((value) => Object.keys(value).length > 0, { message: 'Debes enviar al menos un campo para actualizar' });
}

/** JSON columns in the schema are stored as text; accept an object/array and serialize it. */
export const jsonColumn = z
  .union([z.record(z.unknown()), z.array(z.unknown()), z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined || value === null) return value ?? null;
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
