import { z } from 'zod';
import { id } from './common';

/**
 * Itinerarios de varios tramos (mockup 1): ida y vuelta, y multidestino.
 *
 * `ONE_WAY` no aparece aquí a propósito: la ida simple sigue usando los endpoints que ya
 * existían (`GET /public/trips` y `POST /bookings`) sin ningún cambio.
 */

export const TRIP_TYPES = ['ROUND_TRIP', 'MULTI_CITY'] as const;

/** Fecha AAAA-MM-DD que además exista de verdad (rechaza 2026-02-31). */
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener el formato AAAA-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00`);
    return !Number.isNaN(parsed.getTime()) && value === parsed.toISOString().slice(0, 10);
  }, 'La fecha no existe');

const city = z.string().trim().min(2, 'Indica la ciudad').max(100);

const searchSegment = z
  .object({ origin: city, destination: city, date: isoDate })
  .refine((value) => value.origin.toLowerCase() !== value.destination.toLowerCase(), {
    message: 'El origen y el destino no pueden ser la misma ciudad',
    path: ['destination'],
  });

/** Las fechas de los tramos deben ir en orden: no se puede volver antes de haber ido. */
function assertChronological(segments: Array<{ date: string }>, ctx: z.RefinementCtx): void {
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index]!.date < segments[index - 1]!.date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `La fecha del tramo ${index + 1} no puede ser anterior a la del tramo ${index}`,
        path: ['segments', index, 'date'],
      });
    }
  }
}

export const searchItinerarySchema = z
  .object({
    trip_type: z.enum(TRIP_TYPES, { errorMap: () => ({ message: 'Tipo de viaje inválido' }) }),
    // 2 tramos para ida y vuelta; hasta 5 para multidestino.
    segments: z.array(searchSegment).min(2, 'Un itinerario necesita al menos dos tramos').max(5, 'Como máximo 5 tramos'),
  })
  .superRefine((value, ctx) => {
    if (value.trip_type === 'ROUND_TRIP' && value.segments.length !== 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Un ida y vuelta tiene exactamente dos tramos', path: ['segments'] });
    }
    assertChronological(value.segments, ctx);
  });

/** Texto opcional que acepta `null` y lo normaliza a `undefined`. */
const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => value || undefined);

const bookingSegment = z.object({
  trip_id: id,
  seat_ids: z.array(id).min(1, 'Selecciona al menos un asiento').max(6),
  origin_stop_id: id.nullable().optional(),
  destination_stop_id: id.nullable().optional(),
  passengers: z
    .array(z.object({ seat_id: id, name: z.string().trim().max(150).optional(), document: z.string().trim().max(30).optional() }))
    .optional(),
});

export const createItinerarySchema = z
  .object({
    trip_type: z.enum(TRIP_TYPES, { errorMap: () => ({ message: 'Tipo de viaje inválido' }) }),
    segments: z.array(bookingSegment).min(2, 'Un itinerario necesita al menos dos tramos').max(5, 'Como máximo 5 tramos'),
    // Datos del titular, comunes a toda la compra: el mismo pasajero recorre el itinerario.
    // Todos admiten `null`: es lo que envía el formulario cuando el campo se deja vacío, y
    // se traduce a `undefined` para que el servicio los trate como "no enviado".
    passenger_name: nullableText(150),
    passenger_document: nullableText(30),
    passenger_phone: nullableText(30),
    passenger_email: z
      .string()
      .email('Correo inválido')
      .max(150)
      .nullable()
      .optional()
      .transform((value) => value ?? undefined),
    notes: nullableText(500),
    coupon_code: nullableText(50),
    payment_method: z
      .enum(['CARD', 'YAPE', 'PLIN', 'TRANSFER', 'CASH', 'OTHER'])
      .nullable()
      .optional()
      .transform((value) => value ?? undefined),
  })
  .superRefine((value, ctx) => {
    if (value.trip_type === 'ROUND_TRIP' && value.segments.length !== 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Un ida y vuelta tiene exactamente dos tramos', path: ['segments'] });
    }
    // El mismo viaje no puede repetirse: sería comprar dos veces el mismo tramo.
    const tripIds = value.segments.map((segment) => segment.trip_id);
    if (new Set(tripIds).size !== tripIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'No puedes repetir el mismo viaje en dos tramos', path: ['segments'] });
    }
  });

export type SearchItineraryInput = z.infer<typeof searchItinerarySchema>;
export type CreateItineraryInput = z.infer<typeof createItinerarySchema>;
