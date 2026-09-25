import { z } from 'zod';
import { activeStatus, id, money, optionalId, optionalText, shortText, toUpdateSchema } from './common';

/**
 * Contenido público de destinos (FASE 17).
 *
 * Todos los textos son TEXTO PLANO: el frontend los muestra escapados, nunca como HTML. No se
 * aceptan referencias de imagen por el cuerpo: las imágenes solo entran por los endpoints de
 * subida, que las validan y generan la referencia en el servidor.
 */

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX = 120;

/** «La Merced» → «la-merced»; «Cañón del Colca» → «canon-del-colca». */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .max(SLUG_MAX, `El slug admite como máximo ${SLUG_MAX} caracteres`)
  .regex(SLUG_PATTERN, 'El slug solo admite minúsculas sin tildes, números y guiones (ej. la-merced)');

const displayOrder = z.coerce.number().int().min(0, 'El orden no puede ser negativo').max(100000);

const destinationShape = {
  name: shortText(120),
  slug: slug.optional(),
  subtitle: optionalText(200),
  description: optionalText(10000),
  price_from: money.max(99999999.99).nullable().optional(),
  address: optionalText(255),
  /** FASE 17B · horarios separados. `schedule` y `weather` (015) quedan obsoletos; ver migración 016. */
  ticket_schedule: optionalText(255),
  package_schedule: optionalText(255),
  travel_duration: optionalText(120),
  temperature: optionalText(60),
  /** Altitud en msnm: el punto más alto del Perú no llega a 6 800, así que 9 000 sobra de tope. */
  altitude_masl: z.coerce.number().int().min(0).max(9000).nullable().optional(),
  time_from_lima: optionalText(30),
  /** Ciudades reales de `locations`: el destino no guarda nombres sueltos. */
  location_id: optionalId,
  origin_location_id: optionalId,
  status: activeStatus.optional(),
  display_order: displayOrder.optional(),
};

/** Sin slug explícito se deriva del nombre. Un nombre sin letras ni números no produce slug. */
export const createDestinationSchema = z
  .object(destinationShape)
  .transform((value, ctx) => {
    const derived = value.slug ?? slugify(value.name);
    if (!SLUG_PATTERN.test(derived)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slug'], message: 'No se pudo generar un slug válido: indícalo manualmente' });
      return z.NEVER;
    }
    return { ...value, slug: derived };
  });

/** El slug NO cambia solo al renombrar: las URLs publicadas deben ser estables. */
export const updateDestinationSchema = toUpdateSchema(destinationShape);

const attractionShape = {
  destination_id: id,
  name: shortText(150),
  description: optionalText(5000),
  status: activeStatus.optional(),
  display_order: displayOrder.optional(),
};
export const createAttractionSchema = z.object(attractionShape);
/** `destination_id` no se acepta al editar: un atractivo no se mueve a otro destino. */
const { destination_id: _attractionParent, ...attractionEditable } = attractionShape;
export const updateAttractionSchema = toUpdateSchema(attractionEditable);

const festivityShape = {
  destination_id: id,
  name: shortText(150),
  date_label: shortText(80),
  description: optionalText(5000),
  status: activeStatus.optional(),
  display_order: displayOrder.optional(),
};
export const createFestivitySchema = z.object(festivityShape);
const { destination_id: _festivityParent, ...festivityEditable } = festivityShape;
export const updateFestivitySchema = toUpdateSchema(festivityEditable);

/** Nuevo orden: la lista completa de ids en el orden deseado, sin repetidos. */
export const reorderSchema = z.object({
  ids: z
    .array(id)
    .min(1, 'Envía al menos un elemento')
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'La lista tiene elementos repetidos' }),
});

export const reorderChildrenSchema = reorderSchema.extend({ destination_id: id });
