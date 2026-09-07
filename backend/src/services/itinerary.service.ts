import type { PoolConnection } from 'mysql2/promise';
import { query, queryOne, withTransaction } from '../config/database';
import type { AuthenticatedUser, PaymentMethod } from '../types/entities';
import { ApiError } from '../utils/ApiError';
import { randomCode } from '../utils/security';
import {
  assertBookingInput,
  confirmBookingPaymentOnConnection,
  createBookingOnConnection,
  type BookingSettings,
} from './booking.service';
import { searchTrips } from './trip.service';
import type { CreateItineraryInput, SearchItineraryInput } from '../validators/itinerary.validators';

/**
 * Itinerarios de varios tramos: ida y vuelta y multidestino (mockup 1).
 *
 * Modelo elegido (PENDIENTES.md §8 dejaba abiertas dos opciones):
 *
 *   booking_groups            una compra
 *     └── bookings            un tramo cada una, con `segment_order`
 *           └── booking_seats los asientos de ESE tramo, con su propio trip_id
 *
 * Cada tramo sigue siendo una reserva normal, así que la ida simple no cambia y los
 * pagos, reembolsos, comisiones y liquidaciones siguen funcionando por empresa: en un
 * ida y vuelta los dos tramos pueden pertenecer a empresas distintas.
 */

export interface SegmentResults {
  segment_order: number;
  origin: string;
  destination: string;
  date: string;
  trips: Record<string, unknown>[];
  total: number;
}

/**
 * Busca los viajes de cada tramo. Reutiliza la misma búsqueda pública que usa la ida, de
 * modo que la visibilidad (solo viajes futuros de empresas y rutas activas) es idéntica.
 */
export async function searchItinerary(input: SearchItineraryInput, limit: number): Promise<SegmentResults[]> {
  const results: SegmentResults[] = [];

  for (const [index, segment] of input.segments.entries()) {
    const { rows, total } = await searchTrips({
      originCity: segment.origin,
      destinationCity: segment.destination,
      date: segment.date,
      page: 1,
      limit,
      offset: 0,
    });

    results.push({
      segment_order: index + 1,
      origin: segment.origin,
      destination: segment.destination,
      date: segment.date,
      trips: rows,
      total,
    });
  }

  return results;
}

/**
 * Toma por adelantado el cerrojo de cada viaje del itinerario, SIEMPRE de menor a mayor
 * `trip_id` (auditoría BP-21).
 *
 * EL PROBLEMA. Cada tramo se reservaba en el orden en que lo pidió el usuario, y reservar
 * empieza bloqueando la fila del viaje. Dos compras simultáneas de los mismos dos viajes en
 * sentidos opuestos —una Lima→Huánuco y vuelta, otra Huánuco→Lima y vuelta— tomaban los
 * cerrojos en orden inverso:
 *
 *     A: bloquea viaje 1 … y espera el 3
 *     B: bloquea viaje 3 … y espera el 1
 *
 * Ninguna puede avanzar. InnoDB mata una con ER_LOCK_DEADLOCK (1213) y las demás que se
 * amontonan detrás agotan `innodb_lock_wait_timeout` —50 segundos en este servidor— y salen
 * con ER_LOCK_WAIT_TIMEOUT (1205). Medido: de diez compras cruzadas simultáneas, **nueve
 * fallaban con 500** tras casi un minuto colgadas.
 *
 * LA SOLUCIÓN. Un orden total: si todo el mundo pide los cerrojos de menor a mayor id, no
 * puede formarse un ciclo. No es un reintento —un reintento esconde el problema y bajo carga
 * lo repite—, es la eliminación estructural de la posibilidad.
 *
 * Esto NO cambia el itinerario: el orden de bloqueo es interno y no tiene nada que ver con
 * `segment_order`, que sigue siendo el que el usuario envió. Un ida y vuelta cuya vuelta
 * tenga un id menor que la ida se bloquea empezando por la vuelta y se guarda, se cobra y
 * se muestra empezando por la ida.
 *
 * Los duplicados se descartan: dos tramos del mismo viaje comparten fila y el cerrojo ya lo
 * tomó el primero.
 */
async function lockTripsInOrder(connection: PoolConnection, tripIds: number[]): Promise<void> {
  const enOrden = [...new Set(tripIds)].sort((a, b) => a - b);
  for (const tripId of enOrden) {
    await connection.query('SELECT id FROM trips WHERE id = ? LIMIT 1 FOR UPDATE', [tripId]);
  }
}

export interface ItineraryBooking {
  segment_order: number;
  booking_id: number;
  booking_code: string;
  trip_id: number;
  total: number;
}

export interface ItineraryResult {
  group_id: number;
  group_code: string;
  trip_type: string;
  total_amount: number;
  segments: ItineraryBooking[];
}

/**
 * Crea la compra completa: una reserva por tramo, todas dentro de UNA transacción.
 *
 * Si cualquier tramo falla —asiento ya tomado, viaje partido, cupón inválido— el ROLLBACK
 * deshace también los tramos anteriores. Nunca queda una compra a medias.
 *
 * La concurrencia es la que ya existía: `createBookingOnConnection` mantiene intactos los
 * `SELECT ... FOR UPDATE` sobre viaje, asientos y reservas solapadas. La disponibilidad se
 * evalúa por `trip_id` + `seat_id`, así que el asiento 5 de la ida y el 5 de la vuelta son
 * asientos distintos y no entran en conflicto.
 */
export async function createItinerary(user: AuthenticatedUser, input: CreateItineraryInput): Promise<ItineraryResult> {
  // Validaciones y lectura de configuración fuera de la transacción, para no sostenerla
  // más tiempo del necesario mientras se bloquean asientos.
  const ajustes: BookingSettings[] = [];
  for (const segment of input.segments) {
    ajustes.push(await assertBookingInput({ ...segment, trip_id: segment.trip_id, seat_ids: segment.seat_ids } as never));
  }

  return withTransaction(async (connection) => {
    await lockTripsInOrder(connection, input.segments.map((segment) => segment.trip_id));

    let groupCode = randomCode('IT', 6);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const [existing] = await connection.query('SELECT id FROM booking_groups WHERE group_code = ? LIMIT 1', [groupCode]);
      if ((existing as unknown[]).length === 0) break;
      groupCode = randomCode('IT', 6);
    }

    const [groupResult] = await connection.query(
      'INSERT INTO booking_groups (group_code, user_id, trip_type) VALUES (?, ?, ?)',
      [groupCode, user.id, input.trip_type],
    );
    const groupId = (groupResult as { insertId: number }).insertId;

    const segments: ItineraryBooking[] = [];
    let totalAmount = 0;

    for (const [index, segment] of input.segments.entries()) {
      const created = await createBookingOnConnection(
        connection,
        user,
        {
          trip_id: segment.trip_id,
          seat_ids: segment.seat_ids,
          origin_stop_id: segment.origin_stop_id ?? null,
          destination_stop_id: segment.destination_stop_id ?? null,
          passengers: segment.passengers,
          passenger_name: input.passenger_name,
          passenger_document: input.passenger_document,
          passenger_phone: input.passenger_phone,
          passenger_email: input.passenger_email,
          notes: input.notes,
          // El cupón se aplica una sola vez, al primer tramo: aplicarlo a todos multiplicaría
          // el descuento y dispararía el contador de usos del cupón.
          coupon_code: index === 0 ? input.coupon_code : undefined,
        } as never,
        input.payment_method,
        ajustes[index]!,
        { groupId, segmentOrder: index + 1 },
      );

      segments.push({
        segment_order: index + 1,
        booking_id: created.bookingId,
        booking_code: created.bookingCode,
        trip_id: segment.trip_id,
        total: created.total,
      });
      totalAmount += created.total;
    }

    return {
      group_id: groupId,
      group_code: groupCode,
      trip_type: input.trip_type,
      total_amount: Number(totalAmount.toFixed(2)),
      segments,
    };
  });
}

/**
 * Devuelve el itinerario completo. Acotado al dueño: un CUSTOMER solo ve sus compras.
 * El ADMIN y los roles de empresa acceden a través de los endpoints de reservas que ya
 * existían, con su propio alcance; aquí no se amplía la visibilidad de nadie.
 */
export async function findItinerary(groupId: number, user: AuthenticatedUser): Promise<Record<string, unknown>> {
  const group = await queryOne<Record<string, unknown>>(
    'SELECT id AS group_id, group_code, user_id, trip_type, created_at FROM booking_groups WHERE id = ? LIMIT 1',
    [groupId],
  );
  // 404 y no 403: no se confirma la existencia de compras ajenas.
  if (!group || (user.role !== 'ADMIN' && Number(group.user_id) !== user.id)) {
    throw ApiError.notFound('Itinerario no encontrado');
  }

  const bookings = await query(
    `SELECT bk.id AS booking_id, bk.booking_code, bk.segment_order, bk.trip_id, bk.status, bk.total_amount, bk.expires_at,
            t.departure_datetime, t.arrival_datetime,
            ol.city AS origin_city, ol.name AS origin_terminal,
            dl.city AS destination_city, dl.name AS destination_terminal,
            co.name AS company_name,
            (SELECT GROUP_CONCAT(s.seat_number ORDER BY s.seat_number SEPARATOR ', ')
             FROM booking_seats bs JOIN seats s ON s.id = bs.seat_id WHERE bs.booking_id = bk.id) AS seat_numbers
     FROM bookings bk
     JOIN trips t ON t.id = bk.trip_id
     JOIN routes r ON r.id = t.route_id
     JOIN locations ol ON ol.id = r.origin_location_id
     JOIN locations dl ON dl.id = r.destination_location_id
     JOIN companies co ON co.id = r.company_id
     WHERE bk.group_id = ?
     ORDER BY bk.segment_order ASC`,
    [groupId],
  );

  const total = bookings.reduce((sum, booking) => sum + Number((booking as { total_amount: number }).total_amount), 0);
  return { ...group, total_amount: Number(total.toFixed(2)), segments: bookings };
}

/** Ids de las reservas de un grupo, en orden. Lo usa el pago del itinerario. */
export async function findGroupBookingIds(groupId: number, user: AuthenticatedUser): Promise<number[]> {
  const group = await queryOne<{ user_id: number }>('SELECT user_id FROM booking_groups WHERE id = ? LIMIT 1', [groupId]);
  if (!group || (user.role !== 'ADMIN' && Number(group.user_id) !== user.id)) {
    throw ApiError.notFound('Itinerario no encontrado');
  }

  const rows = await query<{ id: number }>(
    'SELECT id FROM bookings WHERE group_id = ? ORDER BY segment_order ASC',
    [groupId],
  );
  return rows.map((row) => row.id);
}

/**
 * Confirma el pago de TODOS los tramos del itinerario en UNA sola transacción.
 *
 * El bucle anterior llamaba a `confirmBookingPayment`, que abre su propia transacción por
 * reserva: si el tercer tramo fallaba, los dos primeros ya habían quedado PAID de forma
 * irreversible. Ahora se abre una única transacción y cada tramo se confirma sobre esa
 * misma conexión, de modo que un fallo revierte también los tramos ya procesados: pagos,
 * movimientos financieros, estados de reserva y notificaciones.
 *
 * Se mantiene UN PAGO POR TRAMO, no uno por grupo: cada `payments.booking_id` apunta a su
 * reserva y de ahí se deriva la empresa (booking → trip → route → company_id). Es lo que
 * permite que un ida y vuelta combine empresas distintas y que cada una cobre y liquide
 * lo suyo.
 *
 * La idempotencia es la de siempre: `confirmBookingPaymentOnConnection` sale sin tocar
 * nada si la reserva ya está confirmada y reutiliza el pago PENDING si existe.
 */
export async function payItinerary(
  groupId: number,
  user: AuthenticatedUser,
  method: PaymentMethod,
  providerTransactionId?: string | null,
): Promise<number[]> {
  const bookingIds = await findGroupBookingIds(groupId, user);
  if (bookingIds.length === 0) throw ApiError.notFound('Itinerario no encontrado');

  await withTransaction(async (connection) => {
    // Mismo orden global que al crear (BP-21): confirmar también empieza bloqueando el
    // viaje de cada tramo, así que pagar dos itinerarios cruzados a la vez tenía
    // exactamente el mismo interbloqueo. Se leen los viajes del grupo sin bloquear —el
    // `trip_id` de una reserva no cambia nunca— y se toman los cerrojos de menor a mayor.
    const [tripRows] = await connection.query(
      'SELECT DISTINCT trip_id FROM bookings WHERE group_id = ?',
      [groupId],
    );
    await lockTripsInOrder(connection, (tripRows as Array<{ trip_id: number }>).map((row) => row.trip_id));

    // El pago sigue recorriendo los tramos por `segment_order`: el orden de cobro y de
    // notificación es el del itinerario, no el de los cerrojos.
    for (const bookingId of bookingIds) {
      await confirmBookingPaymentOnConnection(connection, bookingId, method, providerTransactionId ?? null);
    }
  });

  return bookingIds;
}
