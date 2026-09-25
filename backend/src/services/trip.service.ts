import { execute, query, queryOne, withTransaction } from '../config/database';
import { recordSystemAudit } from './audit.service';
import { resolveTripLayoutId } from './bus-layout.service';
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
  /** Piso al que pertenece el asiento (migración 010). Un bus puede tener uno o dos. */
  deck_id: number | null;
  deck_number: number | null;
  /** Precio de ESTE asiento en ESTE viaje. Ver `seatMap` para cómo se resuelve. */
  price: string;
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
 * Capacidad de un viaje. Espera que el viaje esté aliasado como `t`.
 *
 * NO es `buses.capacity`. Un bus puede ir por su versión 7 mientras un viaje de marzo sigue
 * anclado a la 1: preguntarle al bus de hoy cuántas plazas tenía aquel viaje da la cifra
 * equivocada. La capacidad de un viaje es la de la versión que congeló.
 *
 * `buses.capacity` queda como respaldo SOLO para los viajes anteriores a la migración 010,
 * que pueden no tener versión propia. Es una caché, no una fuente de verdad.
 *
 * Vive aquí y no en `booking.service` —donde nació— porque la usan además la búsqueda
 * pública, el listado de viajes, el panel y la API de integración. Una sola definición: si
 * algún día cambia la política de capacidad, cambia en un único sitio.
 */
export const TRIP_SEAT_CAPACITY_SQL = `COALESCE(
        (SELECT bl.seat_count FROM bus_layouts bl WHERE bl.id = t.bus_layout_id),
        (SELECT b.capacity FROM buses b WHERE b.id = t.bus_id)
      )`;

/**
 * Mapa de asientos de un viaje. Un asiento cuenta como tomado cuando pertenece a una reserva
 * que todavía lo retiene (PENDING dentro de su plazo, CONFIRMED o COMPLETED).
 *
 * DE DÓNDE SALEN LOS ASIENTOS (migración 010). Ya no del bus, sino de la VERSIÓN de
 * distribución que el viaje tiene congelada. `resolveTripLayoutId` decide cuál es: la del
 * viaje si la tiene, y si no la publicada del bus como red de transición. Así, reordenar un
 * bus no le cambia el mapa a un viaje ya vendido.
 *
 * SOLO DEVUELVE ASIENTOS. Los baños, escaleras, puertas, huecos y el puesto del conductor
 * viven en `bus_layout_elements` y NO salen por aquí. No es un descuido: esta misma función
 * alimenta `GET /integration/trips/:id/availability`, que publica `capacity: seats.length`
 * a sistemas de terceros. Colar un baño en esta lista le sumaría un pasajero inexistente a
 * la capacidad de todos los integradores. Quien necesite el bus entero pide el árbol de la
 * versión con `getLayoutTree`.
 *
 * EL PRECIO ES POR ASIENTO. `trip_seat_type_prices` puede fijar un precio distinto para cada
 * tipo de asiento en cada viaje; donde no haya fila rige `trips.base_price`. Se proyecta
 * aquí, junto al asiento, para que la pantalla muestre exactamente lo que se va a cobrar.
 */
export async function seatMap(tripId: number): Promise<SeatAvailability[]> {
  const layoutId = await resolveTripLayoutId(tripId);
  return query<SeatAvailability>(
    `SELECT s.id, s.seat_number, s.row_number, s.column_number, s.is_window, s.is_aisle, s.status,
            st.name AS seat_type_name,
            s.deck_id, d.deck_number,
            CAST(COALESCE(tsp.price, t.base_price) AS DECIMAL(10,2)) AS price,
            EXISTS (
              SELECT 1 FROM booking_seats bs
              JOIN bookings bk ON bk.id = bs.booking_id
              WHERE bs.trip_id = ? AND bs.seat_id = s.id AND ${SEAT_HELD_SQL}
            ) AS is_taken
     FROM trips t
     JOIN seats s ON s.layout_id = ?
     LEFT JOIN bus_layout_decks d ON d.id = s.deck_id
     LEFT JOIN seat_types st ON st.id = s.seat_type_id
     LEFT JOIN trip_seat_type_prices tsp ON tsp.trip_id = t.id AND tsp.seat_type_id = s.seat_type_id
     WHERE t.id = ?
     ORDER BY d.deck_number ASC, s.row_number ASC, s.column_number ASC, s.seat_number ASC`,
    [tripId, layoutId, tripId],
  );
}

// --- Geometría pública de la distribución del viaje ----------------------------

export interface PublicLayoutElement {
  id: number;
  element_type: 'BATHROOM' | 'STAIRS' | 'DRIVER' | 'DOOR' | 'EMPTY';
  row_number: number;
  column_number: number;
  row_span: number;
  col_span: number;
  label: string | null;
}

export interface PublicLayoutDeck {
  id: number;
  deck_number: number;
  name: string | null;
  row_count: number;
  column_count: number;
  elements: PublicLayoutElement[];
}

export interface PublicTripLayout {
  layout_id: number;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  name: string | null;
  decks: PublicLayoutDeck[];
}

/**
 * Geometría de la distribución que le toca a un viaje: pisos, rejilla y elementos físicos.
 *
 * POR QUÉ NO ESTÁ EN `seatMap`. Aquella función publica la lista de ASIENTOS, y de su
 * longitud sale la `capacity` que lee la API de integración; un baño colado ahí le sumaría
 * un pasajero inexistente a todos los integradores. Son dos preguntas distintas —«qué se
 * puede vender» y «qué forma tiene el bus»— y se responden por separado a propósito.
 *
 * QUÉ VERSIÓN DEVUELVE. La del viaje, vía `resolveTripLayoutId`: la congelada en
 * `trips.bus_layout_id` si la tiene y, solo si no la tiene, la publicada del bus. De modo
 * que un viaje vendido sobre la v1 sigue dibujándose con la v1 aunque el bus ya vaya por la
 * v2. Esa es justamente la garantía que la migración 010 vino a dar.
 *
 * QUÉ NO DEVUELVE. Asientos, precios y cualquier dato de la empresa. Es público y se queda
 * en la forma del vehículo; el identificador del layout ni siquiera se acepta como entrada,
 * se deduce del viaje, así que no hay parámetro con el que pedir la distribución de otro.
 */
export async function getTripLayout(tripId: number): Promise<PublicTripLayout> {
  const layoutId = await resolveTripLayoutId(tripId);

  const layout = await queryOne<{ id: number; version: number; status: PublicTripLayout['status']; name: string | null }>(
    'SELECT id, version, status, name FROM bus_layouts WHERE id = ? LIMIT 1',
    [layoutId],
  );
  if (!layout) throw ApiError.badRequest('El viaje no tiene una distribución de asientos disponible');

  const decks = await query<Omit<PublicLayoutDeck, 'elements'>>(
    `SELECT id, deck_number, name, row_count, column_count
     FROM bus_layout_decks WHERE layout_id = ? ORDER BY deck_number ASC`,
    [layoutId],
  );

  // Los elementos se piden de una vez para todos los pisos y se reparten en memoria: un
  // bus tiene uno o dos pisos, y una consulta por piso solo añadiría viajes a la base.
  const elements = decks.length === 0
    ? []
    : await query<PublicLayoutElement & { deck_id: number }>(
        `SELECT e.id, e.deck_id, e.element_type, e.row_number, e.column_number, e.row_span, e.col_span, e.label
         FROM bus_layout_elements e
         JOIN bus_layout_decks d ON d.id = e.deck_id
         WHERE d.layout_id = ?
         ORDER BY e.row_number ASC, e.column_number ASC`,
        [layoutId],
      );

  return {
    layout_id: layout.id,
    version: layout.version,
    status: layout.status,
    name: layout.name,
    decks: decks.map((deck) => ({
      ...deck,
      elements: elements
        .filter((elemento) => elemento.deck_id === deck.id)
        .map(({ deck_id: _deckId, ...elemento }) => elemento),
    })),
  };
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
 * Transiciones MANUALES permitidas por `PUT /trips/:id` (H-30). CANCELLED no aparece: se llega
 * solo por `POST /trips/:id/cancel` y de ahí no se sale. Mantener el mismo estado siempre vale.
 *
 *   SCHEDULED · BOARDING · DELAYED  ⇄ entre sí, y → IN_PROGRESS
 *   IN_PROGRESS                     → COMPLETED (nunca vuelve atrás)
 *   COMPLETED                       → nada: un viaje realizado no se reabre
 *
 * COMPLETED solo desde IN_PROGRESS: completar a mano un viaje que no ha salido lo cerraría antes
 * de tiempo (y el cierre completa sus reservas).
 */
export const TRIP_MANUAL_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  SCHEDULED: ['BOARDING', 'DELAYED', 'IN_PROGRESS'],
  BOARDING: ['SCHEDULED', 'DELAYED', 'IN_PROGRESS'],
  DELAYED: ['SCHEDULED', 'BOARDING', 'IN_PROGRESS'],
  IN_PROGRESS: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

/** Estados con los que se puede CREAR un viaje: los que aún admiten venta. */
export const TRIP_CREATION_STATUSES = ['SCHEDULED', 'BOARDING', 'DELAYED'] as const;

/**
 * Avanza el ciclo de vida de los viajes: SCHEDULED/BOARDING → IN_PROGRESS → COMPLETED.
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
  /**
   * F18-07 · AUDITORÍA DEL CICLO DE VIDA. Cada transición automática deja su fila en
   * `audit_logs` (actor `system:trip-lifecycle`, `user_id` NULL) DENTRO de la misma transacción
   * que la aplica: o quedan el cambio y su rastro, o ninguno. Para saber QUÉ filas cambian, se
   * seleccionan primero con `FOR UPDATE`; así, si dos procesos corrieran a la vez, el segundo
   * espera, vuelve a leer y ya no encuentra nada que mover: ni transiciones ni registros dobles.
   * Las reglas de cada paso no cambian.
   */
  return withTransaction(async (connection) => {
    const filas = async <T>(sql: string): Promise<T[]> => (await connection.query(sql))[0] as T[];
    const auditar = (entityType: 'trips' | 'bookings', entityId: number, action: string, antes: string, despues: string, description: string) =>
      recordSystemAudit(
        { action, entityType, entityId, actor: 'system:trip-lifecycle', description, oldValues: { status: antes }, newValues: { status: despues } },
        connection,
      );

    // 1. Ha llegado la hora de salir. Desde SCHEDULED y, desde 11F (H-30), también desde
    //    BOARDING: el embarque ocurre ANTES de la salida, así que un viaje en embarque cuya hora
    //    de salida ya pasó ha salido; antes se quedaba en BOARDING para siempre.
    //    DELAYED NO avanza solo: «retrasado» significa justamente que no salió a su hora y el
    //    sistema no conoce la hora real; la empresa lo pasa a BOARDING o IN_PROGRESS (o corrige
    //    la salida y lo vuelve a SCHEDULED). CANCELLED, COMPLETED e IN_PROGRESS no entran.
    const salen = await filas<{ id: number; status: string }>(
      `SELECT id, status FROM trips
       WHERE status IN ('SCHEDULED', 'BOARDING') AND departure_datetime <= NOW() ORDER BY id FOR UPDATE`,
    );
    if (salen.length) {
      await connection.query("UPDATE trips SET status = 'IN_PROGRESS' WHERE id IN (?) AND status IN ('SCHEDULED', 'BOARDING')", [salen.map((t) => t.id)]);
      for (const t of salen) await auditar('trips', t.id, 'START', t.status, 'IN_PROGRESS', `El viaje #${t.id} salió automáticamente al llegar su hora de salida`);
    }

    // 2. Ha llegado la hora de llegar. Se exige `arrival_datetime`: la columna es opcional en
    //    el esquema y un viaje sin hora de llegada no puede darse por terminado. Se queda en
    //    IN_PROGRESS hasta que alguien la complete, en lugar de inventarle una duración.
    const llegan = await filas<{ id: number }>(
      `SELECT id FROM trips
       WHERE status = 'IN_PROGRESS' AND arrival_datetime IS NOT NULL AND arrival_datetime <= NOW() ORDER BY id FOR UPDATE`,
    );
    if (llegan.length) {
      await connection.query("UPDATE trips SET status = 'COMPLETED' WHERE id IN (?) AND status = 'IN_PROGRESS'", [llegan.map((t) => t.id)]);
      for (const t of llegan) await auditar('trips', t.id, 'COMPLETE', 'IN_PROGRESS', 'COMPLETED', `El viaje #${t.id} se completó automáticamente al llegar su hora de llegada`);
    }

    // 3. Las reservas de los viajes ya cerrados. Solo CONFIRMED: PENDING sigue su propio
    //    camino de expiración, y CANCELLED y EXPIRED no se reviven jamás. No se tocan pagos,
    //    reembolsos, asientos ni movimientos financieros: completar un viaje no mueve dinero.
    const reservas = await filas<{ id: number; trip_id: number }>(
      `SELECT bk.id, bk.trip_id FROM bookings bk JOIN trips t ON t.id = bk.trip_id
       WHERE t.status = 'COMPLETED' AND bk.status = 'CONFIRMED' ORDER BY bk.id FOR UPDATE`,
    );
    if (reservas.length) {
      await connection.query("UPDATE bookings SET status = 'COMPLETED' WHERE id IN (?) AND status = 'CONFIRMED'", [reservas.map((b) => b.id)]);
      for (const b of reservas) await auditar('bookings', b.id, 'COMPLETE', 'CONFIRMED', 'COMPLETED', `La reserva #${b.id} se completó con su viaje #${b.trip_id}`);
    }

    return { started: salen.length, completed: llegan.length, bookingsCompleted: reservas.length };
  });
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
    b.id AS bus_id, ${TRIP_SEAT_CAPACITY_SQL} AS capacity, b.amenities, bt.name AS bus_type_name,
    (SELECT ROUND(AVG(rv.rating), 1) FROM reviews rv WHERE rv.company_id = co.id AND rv.status = 'PUBLISHED') AS company_rating,
    (SELECT COUNT(*) FROM reviews rv WHERE rv.company_id = co.id AND rv.status = 'PUBLISHED') AS company_reviews,
    (${TRIP_SEAT_CAPACITY_SQL} - (
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
