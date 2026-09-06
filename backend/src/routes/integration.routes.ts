import { Router } from 'express';
import { query, queryOne } from '../config/database';
import { authenticateApiKeyRequest, requireApiKey, requireApiKeyPermission } from '../middleware/api-key.middleware';
import { seatMap } from '../services/trip.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendList, sendSuccess } from '../utils/http';
import { buildPagination, parseListQuery, parseId, safeColumn, stableOrderBy } from '../utils/query';

/**
 * API de integración para las empresas de transporte (auditoría BP-11).
 *
 * Es la superficie que faltaba: hasta ahora se podían emitir API Keys pero no había nada
 * que consumirlas, así que una llave emitida no abría absolutamente nada.
 *
 * CUATRO REGLAS QUE GOBIERNAN TODO ESTE ARCHIVO:
 *
 *   · **Solo lectura.** No hay ni un `INSERT`, `UPDATE` ni `DELETE`. Reservar, pagar,
 *     cancelar y modificar viajes siguen siendo exclusivos de los portales con sesión.
 *   · **Una sola credencial.** Todo pasa por `authenticateApiKeyRequest`, que lee
 *     `X-API-Key`. Un JWT no sirve aquí, y una API Key tampoco sirve en el resto de la API.
 *   · **La empresa la pone el servidor.** Sale siempre de `req.apiKey.companyId`. Este
 *     archivo NO lee `company_id` de la query, del cuerpo, de los parámetros ni de ninguna
 *     cabecera: no aparece esa lectura en ninguna parte, así que no hay nada que manipular.
 *   · **Permisos existentes.** `trips.view` y `bookings.view`, los mismos que usan los
 *     portales. No se inventó ningún permiso ni módulo nuevo, y ambos están dentro del
 *     techo de empresa, de modo que una llave nunca podrá tener más que su empresa.
 *
 * Sobre las proyecciones: no se reutilizan las de los portales a propósito. La del panel
 * incluye recaudación y el nombre y el teléfono de la tripulación, que un sistema externo
 * no necesita para operar. Aquí se publica lo justo, y en reservas se reduce además la
 * información del pasajero.
 */
const router = Router();

// Toda la superficie exige una API Key válida antes que ninguna otra cosa.
router.use(authenticateApiKeyRequest);

/* ------------------------------------------------------------------------ viajes */

/**
 * Proyección de viaje para un sistema externo: itinerario, bus y ocupación.
 * Sin datos de la tripulación ni recaudación.
 */
const TRIP_SELECT = `SELECT t.id, t.departure_datetime, t.arrival_datetime, t.base_price, t.status,
    t.boarding_notes,
    r.id AS route_id, r.name AS route_name,
    ol.city AS origin_city, ol.name AS origin_terminal,
    dl.city AS destination_city, dl.name AS destination_terminal,
    b.code AS bus_code, b.plate_number, b.capacity, bt.name AS bus_type_name,
    (SELECT COUNT(*) FROM booking_seats bs
      JOIN bookings bk ON bk.id = bs.booking_id
      WHERE bs.trip_id = t.id AND (bk.status IN ('CONFIRMED','COMPLETED')
        OR (bk.status = 'PENDING' AND (bk.expires_at IS NULL OR bk.expires_at > NOW())))) AS seats_taken
  FROM trips t
  JOIN routes r ON r.id = t.route_id
  JOIN locations ol ON ol.id = r.origin_location_id
  JOIN locations dl ON dl.id = r.destination_location_id
  JOIN buses b ON b.id = t.bus_id
  LEFT JOIN bus_types bt ON bt.id = b.bus_type_id`;

const TRIP_SORT = ['t.departure_datetime', 't.base_price', 't.status', 't.created_at'];

router.get(
  '/trips',
  requireApiKeyPermission('trips.view'),
  asyncHandler(async (req, res) => {
    const apiKey = requireApiKey(req);
    const listQuery = parseListQuery(req.query as Record<string, unknown>);

    // La empresa encabeza siempre las condiciones y no procede de la petición.
    const conditions = ['r.company_id = ?'];
    const params: unknown[] = [apiKey.companyId];

    // Los mismos filtros que ya ofrece el listado interno de viajes, menos `company_id`,
    // que aquí no tendría sentido: la empresa ya está fijada por la credencial.
    for (const [key, column] of Object.entries({ status: 't.status', route_id: 't.route_id', bus_id: 't.bus_id' })) {
      const value = listQuery.filters[key];
      if (value !== undefined) {
        conditions.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (listQuery.filters.date) {
      conditions.push('DATE(t.departure_datetime) = ?');
      params.push(listQuery.filters.date);
    }
    if (listQuery.filters.from) {
      conditions.push('t.departure_datetime >= ?');
      params.push(listQuery.filters.from);
    }
    if (listQuery.filters.to) {
      conditions.push('t.departure_datetime <= ?');
      params.push(listQuery.filters.to);
    }

    const where = ` WHERE ${conditions.join(' AND ')}`;
    const countRow = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM trips t JOIN routes r ON r.id = t.route_id${where}`,
      params,
    );

    const sortColumn = safeColumn(listQuery.sort, TRIP_SORT, 't.departure_datetime');
    const rows = await query(
      `${TRIP_SELECT}${where} ORDER BY ${stableOrderBy(sortColumn, listQuery.order, 't')} LIMIT ? OFFSET ?`,
      [...params, listQuery.limit, listQuery.offset],
    );

    sendList(res, rows, buildPagination(Number(countRow?.total ?? 0), listQuery.page, listQuery.limit));
  }),
);

/**
 * Viaje concreto, acotado por empresa en la propia consulta.
 *
 * La condición de empresa va en el `WHERE`, no en una comprobación posterior: así un viaje
 * ajeno y uno inexistente producen exactamente la misma respuesta —404— y no se puede
 * averiguar qué identificadores existen en otras empresas.
 */
async function findOwnTrip(companyId: number, tripId: number): Promise<Record<string, unknown>> {
  const trip = await queryOne<Record<string, unknown>>(
    `${TRIP_SELECT} WHERE t.id = ? AND r.company_id = ? LIMIT 1`,
    [tripId, companyId],
  );
  if (!trip) throw ApiError.notFound('Viaje no encontrado');
  return trip;
}

router.get(
  '/trips/:id',
  requireApiKeyPermission('trips.view'),
  asyncHandler(async (req, res) => {
    const apiKey = requireApiKey(req);
    sendSuccess(res, await findOwnTrip(apiKey.companyId, parseId(req.params.id)));
  }),
);

/**
 * Disponibilidad del viaje.
 *
 * Reutiliza `seatMap`, el mismo servicio que alimenta el mapa de asientos del portal y del
 * buscador público, para que la disponibilidad que ve un sistema externo sea exactamente la
 * que ve el resto de la plataforma. La comprobación de empresa va primero.
 */
router.get(
  '/trips/:id/availability',
  requireApiKeyPermission('trips.view'),
  asyncHandler(async (req, res) => {
    const apiKey = requireApiKey(req);
    const tripId = parseId(req.params.id);
    const trip = await findOwnTrip(apiKey.companyId, tripId);

    const seats = await seatMap(tripId);
    const taken = seats.filter((seat) => seat.is_taken === 1).length;
    const inactive = seats.filter((seat) => seat.status !== 'AVAILABLE').length;

    sendSuccess(res, {
      trip_id: tripId,
      departure_datetime: trip.departure_datetime,
      status: trip.status,
      capacity: seats.length,
      seats_taken: taken,
      seats_inactive: inactive,
      seats_available: seats.length - taken - inactive,
      seats,
    });
  }),
);

/* ---------------------------------------------------------------------- reservas */

/**
 * Proyección de reserva para un sistema externo.
 *
 * Se reduce la información del pasajero al mínimo con el que se puede operar: el nombre y
 * el código de reserva. **No salen** el documento, el teléfono ni el correo del pasajero,
 * ni los datos de la cuenta que compró, ni las notas. Para embarcar existe el manifiesto
 * del portal, que sí es una pantalla de operación con identidad de persona detrás.
 */
const BOOKING_SELECT = `SELECT bk.id, bk.booking_code, bk.status, bk.passenger_count,
    bk.subtotal, bk.discount_amount, bk.service_fee, bk.total_amount,
    bk.passenger_name, bk.created_at, bk.confirmed_at, bk.cancelled_at, bk.expires_at,
    bk.trip_id, t.departure_datetime, t.arrival_datetime,
    ol.city AS origin_city, dl.city AS destination_city,
    (SELECT GROUP_CONCAT(s.seat_number ORDER BY s.seat_number SEPARATOR ', ')
       FROM booking_seats bs JOIN seats s ON s.id = bs.seat_id WHERE bs.booking_id = bk.id) AS seat_numbers
  FROM bookings bk
  JOIN trips t ON t.id = bk.trip_id
  JOIN routes r ON r.id = t.route_id
  JOIN locations ol ON ol.id = r.origin_location_id
  JOIN locations dl ON dl.id = r.destination_location_id`;

const BOOKING_SORT = ['bk.created_at', 'bk.total_amount', 't.departure_datetime', 'bk.status'];

router.get(
  '/bookings',
  requireApiKeyPermission('bookings.view'),
  asyncHandler(async (req, res) => {
    const apiKey = requireApiKey(req);
    const listQuery = parseListQuery(req.query as Record<string, unknown>);

    // Una reserva es de la empresa cuando su viaje lo es: booking → trip → route.
    const conditions = ['r.company_id = ?'];
    const params: unknown[] = [apiKey.companyId];

    for (const [key, column] of Object.entries({ status: 'bk.status', trip_id: 'bk.trip_id' })) {
      const value = listQuery.filters[key];
      if (value !== undefined) {
        conditions.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (listQuery.filters.from) {
      conditions.push('bk.created_at >= ?');
      params.push(listQuery.filters.from);
    }
    if (listQuery.filters.to) {
      conditions.push('bk.created_at <= ?');
      params.push(listQuery.filters.to);
    }

    const where = ` WHERE ${conditions.join(' AND ')}`;
    const countRow = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM bookings bk
       JOIN trips t ON t.id = bk.trip_id
       JOIN routes r ON r.id = t.route_id${where}`,
      params,
    );

    const sortColumn = safeColumn(listQuery.sort, BOOKING_SORT, 'bk.created_at');
    const rows = await query(
      `${BOOKING_SELECT}${where} ORDER BY ${stableOrderBy(sortColumn, listQuery.order, 'bk')} LIMIT ? OFFSET ?`,
      [...params, listQuery.limit, listQuery.offset],
    );

    sendList(res, rows, buildPagination(Number(countRow?.total ?? 0), listQuery.page, listQuery.limit));
  }),
);

export default router;
