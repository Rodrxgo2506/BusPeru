import { execute, query, queryOne } from '../config/database';
import type { AuthenticatedUser } from '../types/entities';
import { ApiError } from '../utils/ApiError';

export interface SeatAvailability {
  id: number;
  seat_number: string;
  row_number: number | null;
  column_number: number | null;
  is_window: 0 | 1;
  is_aisle: 0 | 1;
  status: 'AVAILABLE' | 'INACTIVE';
  seat_type_name: string | null;
  is_taken: 0 | 1;
}

/** Company id that owns a trip, resolved through routes. */
export async function tripCompanyId(tripId: number): Promise<number | null> {
  const row = await queryOne<{ company_id: number }>(
    'SELECT r.company_id FROM trips t JOIN routes r ON r.id = t.route_id WHERE t.id = ? LIMIT 1',
    [tripId],
  );
  return row?.company_id ?? null;
}

export async function assertTripBelongsToUser(tripId: number, user: AuthenticatedUser): Promise<void> {
  if (user.role === 'ADMIN') return;
  const companyId = await tripCompanyId(tripId);
  // Se responde 404, no 403: un 403 confirmaría que el viaje existe y permitiría
  // enumerar la operación de otras empresas. El resto de recursos ya responde 404.
  if (companyId === null || !user.companyIds.includes(companyId)) throw ApiError.notFound('Viaje no encontrado');
}

/**
 * Cuándo un asiento está retenido, en SQL. Espera que la reserva esté aliasada como `bk`.
 *
 * Es UNA sola definición a propósito (auditoría BP-19). Esta condición decide a la vez qué
 * se puede vender, qué muestra el mapa de asientos, qué cuenta `seats_available` y qué ve un
 * sistema externo; estaba copiada literalmente en cuatro consultas y la copia es justo el
 * modo en que dos pantallas acaban discrepando sobre el mismo asiento. Cambiar la política
 * de retención se hace aquí y se aplica a todo.
 *
 * Lo que NO ocupa: CANCELLED, EXPIRED y una PENDING cuyo plazo ya venció. Por eso un asiento
 * se puede volver a vender sin borrar nada del histórico.
 */
export const SEAT_HELD_SQL = `(bk.status IN ('CONFIRMED', 'COMPLETED')
     OR (bk.status = 'PENDING' AND (bk.expires_at IS NULL OR bk.expires_at > NOW())))`;

/**
 * Seat map for a trip. A seat counts as taken when it belongs to a booking that is
 * still holding it (PENDING within its expiry window, CONFIRMED or COMPLETED).
 */
export async function seatMap(tripId: number): Promise<SeatAvailability[]> {
  return query<SeatAvailability>(
    `SELECT s.id, s.seat_number, s.row_number, s.column_number, s.is_window, s.is_aisle, s.status,
            st.name AS seat_type_name,
            EXISTS (
              SELECT 1 FROM booking_seats bs
              JOIN bookings bk ON bk.id = bs.booking_id
              WHERE bs.trip_id = ? AND bs.seat_id = s.id AND ${SEAT_HELD_SQL}
            ) AS is_taken
     FROM trips t
     JOIN buses b ON b.id = t.bus_id
     JOIN seats s ON s.bus_id = b.id
     LEFT JOIN seat_types st ON st.id = s.seat_type_id
     WHERE t.id = ?
     ORDER BY s.row_number ASC, s.column_number ASC, s.seat_number ASC`,
    [tripId, tripId],
  );
}

// --- Ciclo de vida del viaje (PENDIENTES.md / auditoría BP-08) -----------------

export interface TripLifecycleResult {
  /** Viajes que pasaron de SCHEDULED a IN_PROGRESS. */
  started: number;
  /** Viajes que pasaron de IN_PROGRESS a COMPLETED. */
  completed: number;
  /** Reservas CONFIRMED que quedaron COMPLETED al cerrarse su viaje. */
  bookingsCompleted: number;
}

/**
 * Avanza el ciclo de vida de los viajes: SCHEDULED → IN_PROGRESS → COMPLETED.
 *
 * Los tres estados existían en el ENUM y decenas de consultas filtraban por ellos, pero
 * nada los escribía nunca: un viaje que ya había salido seguía SCHEDULED para siempre y sus
 * reservas seguían CONFIRMED. De ahí salían los indicadores de «viajes realizados» contando
 * viajes futuros y, sobre todo, la posibilidad de cancelar y pedir reembolso de un viaje ya
 * realizado.
 *
 * TRES SENTENCIAS, TRES GARANTÍAS:
 *
 *   · Cada `UPDATE` lleva el estado de partida en su `WHERE`, así que volver a ejecutarlo no
 *     encuentra nada que cambiar. La idempotencia no depende de leer antes: es la propia
 *     condición la que excluye lo ya transitado.
 *   · Son sentencias únicas y por tanto atómicas. Dos ejecuciones simultáneas —dos
 *     instancias del backend, o un reinicio a mitad— se serializan por los bloqueos de fila
 *     de InnoDB y ninguna puede aplicar la transición dos veces.
 *   · Las reservas se cierran mirando el ESTADO del viaje, no el momento de la transición.
 *     Si el proceso se cayera justo entre el segundo y el tercer paso, la siguiente
 *     ejecución las encontraría igualmente y las cerraría: se repara solo.
 *
 * Se compara siempre con `NOW()` de MySQL, que es el reloj que ya usan la expiración de
 * reservas y la búsqueda pública. No se introduce ninguna referencia horaria nueva.
 *
 * No se envía ninguna notificación: no existen plantillas de «viaje iniciado» ni «viaje
 * completado» en `notification_templates`, y esta fase no inventa contenido.
 */
export async function advanceTripLifecycle(): Promise<TripLifecycleResult> {
  // 1. Ha llegado la hora de salir. Solo desde SCHEDULED: un viaje CANCELLED, COMPLETED o
  //    ya IN_PROGRESS no entra, y BOARDING y DELAYED se dejan como están porque son estados
  //    que gestiona la empresa a mano.
  const started = await execute(
    `UPDATE trips SET status = 'IN_PROGRESS'
     WHERE status = 'SCHEDULED' AND departure_datetime <= NOW()`,
  );

  // 2. Ha llegado la hora de llegar. Se exige `arrival_datetime`: la columna es opcional en
  //    el esquema y un viaje sin hora de llegada no puede darse por terminado. Se queda en
  //    IN_PROGRESS hasta que alguien la complete, en lugar de inventarle una duración.
  const completed = await execute(
    `UPDATE trips SET status = 'COMPLETED'
     WHERE status = 'IN_PROGRESS' AND arrival_datetime IS NOT NULL AND arrival_datetime <= NOW()`,
  );

  // 3. Las reservas de los viajes ya cerrados. Solo CONFIRMED: PENDING sigue su propio
  //    camino de expiración, y CANCELLED y EXPIRED no se reviven jamás. No se tocan pagos,
  //    reembolsos, asientos ni movimientos financieros: completar un viaje no mueve dinero.
  const bookingsCompleted = await execute(
    `UPDATE bookings bk
     JOIN trips t ON t.id = bk.trip_id
     SET bk.status = 'COMPLETED'
     WHERE t.status = 'COMPLETED' AND bk.status = 'CONFIRMED'`,
  );

  return {
    started: started.affectedRows,
    completed: completed.affectedRows,
    bookingsCompleted: bookingsCompleted.affectedRows,
  };
}

export interface TripSearchParams {
  originCity?: string;
  destinationCity?: string;
  date?: string;
  companyId?: number;
  minPrice?: number;
  maxPrice?: number;
  page: number;
  limit: number;
  offset: number;
}

/**
 * Proyección pública de un viaje.
 *
 * DISPONIBILIDAD: se publica **solo `seats_available`**, calculado aquí abajo a partir de
 * `booking_seats`. La columna `trips.available_seats` NO sale en esta proyección, y es
 * deliberado (auditoría BP-15): antes salían las dos en la misma respuesta, así que el
 * mismo viaje traía dos números que podían no coincidir y cada pantalla usaba uno.
 *
 * La fuente de verdad es el cálculo, no la columna: quien decide si un asiento está libre
 * es `createBookingOnConnection`, y lo hace consultando `booking_seats`, nunca la columna.
 * `trips.available_seats` es una caché de operación que el ciclo de reservas mantiene, y
 * puede quedarse a `NULL` o desfasada sin que eso afecte a ninguna venta.
 */
const SEARCH_SELECT = `SELECT t.id, t.departure_datetime, t.arrival_datetime, t.base_price, t.status,
    t.boarding_notes,
    r.id AS route_id, r.distance_km, r.estimated_duration_minutes,
    ol.city AS origin_city, ol.name AS origin_terminal,
    dl.city AS destination_city, dl.name AS destination_terminal,
    co.id AS company_id, co.name AS company_name, co.logo_url AS company_logo,
    b.id AS bus_id, b.capacity, b.amenities, bt.name AS bus_type_name,
    (SELECT ROUND(AVG(rv.rating), 1) FROM reviews rv WHERE rv.company_id = co.id AND rv.status = 'PUBLISHED') AS company_rating,
    (SELECT COUNT(*) FROM reviews rv WHERE rv.company_id = co.id AND rv.status = 'PUBLISHED') AS company_reviews,
    (b.capacity - (
      SELECT COUNT(*) FROM booking_seats bs
      JOIN bookings bk ON bk.id = bs.booking_id
      WHERE bs.trip_id = t.id AND ${SEAT_HELD_SQL}
    )) AS seats_available
  FROM trips t
  JOIN routes r ON r.id = t.route_id
  JOIN locations ol ON ol.id = r.origin_location_id
  JOIN locations dl ON dl.id = r.destination_location_id
  JOIN companies co ON co.id = r.company_id
  JOIN buses b ON b.id = t.bus_id
  LEFT JOIN bus_types bt ON bt.id = b.bus_type_id`;

/** Public trip search: only scheduled future trips of ACTIVE companies are visible. */
export async function searchTrips(params: TripSearchParams): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const conditions = [
    "t.status IN ('SCHEDULED', 'BOARDING', 'DELAYED')",
    "co.status = 'ACTIVE'",
    "r.status = 'ACTIVE'",
    't.departure_datetime >= NOW()',
  ];
  const values: unknown[] = [];

  if (params.originCity) {
    conditions.push('ol.city = ?');
    values.push(params.originCity);
  }
  if (params.destinationCity) {
    conditions.push('dl.city = ?');
    values.push(params.destinationCity);
  }
  if (params.date) {
    conditions.push('DATE(t.departure_datetime) = ?');
    values.push(params.date);
  }
  if (params.companyId) {
    conditions.push('co.id = ?');
    values.push(params.companyId);
  }
  if (params.minPrice !== undefined) {
    conditions.push('t.base_price >= ?');
    values.push(params.minPrice);
  }
  if (params.maxPrice !== undefined) {
    conditions.push('t.base_price <= ?');
    values.push(params.maxPrice);
  }

  const where = ` WHERE ${conditions.join(' AND ')}`;
  const countRow = await queryOne<{ total: number }>(
    `SELECT COUNT(*) AS total FROM trips t
     JOIN routes r ON r.id = t.route_id
     JOIN locations ol ON ol.id = r.origin_location_id
     JOIN locations dl ON dl.id = r.destination_location_id
     JOIN companies co ON co.id = r.company_id${where}`,
    values,
  );

  const rows = await query<Record<string, unknown>>(
    `${SEARCH_SELECT}${where} ORDER BY t.departure_datetime ASC LIMIT ? OFFSET ?`,
    [...values, params.limit, params.offset],
  );

  return { rows, total: Number(countRow?.total ?? 0) };
}

/**
 * Viaje concreto para el detalle público y su mapa de asientos.
 *
 * Repite la visibilidad de `searchTrips` en lo que a empresa y ruta se refiere: filtrar
 * solo en la búsqueda dejaba el viaje accesible por su id —un enlace guardado, un correo
 * de promoción, un resultado cacheado—, de modo que suspender una empresa la retiraba del
 * escaparate pero no impedía llegar a su ficha y comprar.
 *
 * No se filtra por estado ni por hora de salida: eso pertenece al ciclo de vida del viaje
 * y aquí solo se cierra la visibilidad de empresas y rutas dadas de baja.
 */
export async function findPublicTrip(tripId: number): Promise<Record<string, unknown> | null> {
  return queryOne<Record<string, unknown>>(
    `${SEARCH_SELECT} WHERE t.id = ? AND co.status = 'ACTIVE' AND r.status = 'ACTIVE' LIMIT 1`,
    [tripId],
  );
}
