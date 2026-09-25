import { Router } from 'express';
import { execute, query, queryOne, withTransaction } from '../config/database';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { requirePermission, requireRole } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import { cancelTrip } from '../services/booking.service';
import { assertCompanyOperable } from '../services/company-status.service';
import { assertCrewAssignable } from '../services/driver.service';
import { TRIP_CREATION_STATUSES, TRIP_MANUAL_TRANSITIONS, TRIP_SEAT_CAPACITY_SQL, assertTripBelongsToUser, seatMap, tripCompanyId } from '../services/trip.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendList, sendSuccess } from '../utils/http';
import { buildPagination, parseListQuery, safeColumn, stableOrderBy, parseId } from '../utils/query';
import { createTripSchema, updateTripSchema } from '../validators/resource.validators';

const router = Router();
router.use(authenticate);

const TRIP_SELECT = `SELECT t.*, r.company_id, r.distance_km, r.estimated_duration_minutes,
    ol.city AS origin_city, ol.name AS origin_terminal,
    dl.city AS destination_city, dl.name AS destination_terminal,
    co.name AS company_name, b.code AS bus_code, b.plate_number, ${TRIP_SEAT_CAPACITY_SQL} AS capacity, bt.name AS bus_type_name,
    (SELECT COUNT(*) FROM bookings bk WHERE bk.trip_id = t.id AND bk.status IN ('CONFIRMED','COMPLETED')) AS bookings_count,
    (SELECT COUNT(*) FROM booking_seats bs JOIN bookings bk ON bk.id = bs.booking_id
      WHERE bs.trip_id = t.id AND bk.status IN ('CONFIRMED','COMPLETED')) AS seats_sold,
    (SELECT COALESCE(SUM(bk.total_amount), 0) FROM bookings bk
      WHERE bk.trip_id = t.id AND bk.status IN ('CONFIRMED','COMPLETED')) AS revenue,
    CONCAT_WS(' ', dr.first_name, dr.last_name) AS driver_name, dr.phone AS driver_phone,
    CONCAT_WS(' ', cd.first_name, cd.last_name) AS co_driver_name, cd.phone AS co_driver_phone
  FROM trips t
  JOIN routes r ON r.id = t.route_id
  JOIN locations ol ON ol.id = r.origin_location_id
  JOIN locations dl ON dl.id = r.destination_location_id
  JOIN companies co ON co.id = r.company_id
  JOIN buses b ON b.id = t.bus_id
  LEFT JOIN bus_types bt ON bt.id = b.bus_type_id
  LEFT JOIN drivers dr ON dr.id = t.driver_id
  LEFT JOIN drivers cd ON cd.id = t.co_driver_id`;

const SORT_COLUMNS = ['t.departure_datetime', 't.base_price', 't.created_at', 't.status'];

function scopeCondition(req: Parameters<typeof requireAuth>[0]): { sql: string; params: number[] } | null {
  const user = requireAuth(req);
  if (user.role === 'ADMIN') return null;
  if (user.companyIds.length === 0) return { sql: '1 = 0', params: [] };
  return { sql: `r.company_id IN (${user.companyIds.map(() => '?').join(', ')})`, params: [...user.companyIds] };
}

/**
 * Empresa propietaria de una ruta. La tripulación se valida contra ella, no contra la
 * empresa del usuario: así el ADMIN de la plataforma tampoco puede mezclar personal.
 */
async function companyOfRoute(routeId: number): Promise<number> {
  const route = await queryOne<{ company_id: number }>('SELECT company_id FROM routes WHERE id = ?', [routeId]);
  if (!route) throw ApiError.badRequest('La ruta seleccionada no existe');
  return route.company_id;
}

/** Ensures the route and bus referenced by a trip belong to the caller's company. */
async function assertRouteAndBusOwnership(req: Parameters<typeof requireAuth>[0], routeId?: number, busId?: number): Promise<void> {
  const user = requireAuth(req);
  if (user.role === 'ADMIN') return;

  if (routeId !== undefined) {
    const route = await queryOne<{ company_id: number }>('SELECT company_id FROM routes WHERE id = ?', [routeId]);
    if (!route) throw ApiError.badRequest('La ruta seleccionada no existe');
    if (!user.companyIds.includes(route.company_id)) throw ApiError.forbidden('La ruta pertenece a otra empresa');
  }
  if (busId !== undefined) {
    const bus = await queryOne<{ company_id: number }>('SELECT company_id FROM buses WHERE id = ?', [busId]);
    if (!bus) throw ApiError.badRequest('El bus seleccionado no existe');
    if (!user.companyIds.includes(bus.company_id)) throw ApiError.forbidden('El bus pertenece a otra empresa');
  }
}

router.get(
  '/',
  requirePermission('trips.view'),
  asyncHandler(async (req, res) => {
    const listQuery = parseListQuery(req.query as Record<string, unknown>);
    const conditions: string[] = [];
    const params: unknown[] = [];

    const scope = scopeCondition(req);
    if (scope) {
      conditions.push(scope.sql);
      params.push(...scope.params);
    }

    const filterMap: Record<string, string> = {
      status: 't.status',
      route_id: 't.route_id',
      bus_id: 't.bus_id',
      company_id: 'r.company_id',
    };
    for (const [key, column] of Object.entries(filterMap)) {
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
    if (listQuery.search) {
      conditions.push('(ol.city LIKE ? OR dl.city LIKE ? OR b.code LIKE ? OR b.plate_number LIKE ?)');
      params.push(...Array(4).fill(`%${listQuery.search}%`));
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const countRow = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM trips t
       JOIN routes r ON r.id = t.route_id
       JOIN locations ol ON ol.id = r.origin_location_id
       JOIN locations dl ON dl.id = r.destination_location_id
       JOIN buses b ON b.id = t.bus_id${where}`,
      params,
    );

    const sortColumn = safeColumn(listQuery.sort, SORT_COLUMNS, 't.departure_datetime');
    const rows = await query(`${TRIP_SELECT}${where} ORDER BY ${stableOrderBy(sortColumn, listQuery.order, 't')} LIMIT ? OFFSET ?`, [
      ...params,
      listQuery.limit,
      listQuery.offset,
    ]);

    sendList(res, rows, buildPagination(Number(countRow?.total ?? 0), listQuery.page, listQuery.limit));
  }),
);

router.get(
  '/:id',
  requirePermission('trips.view'),
  asyncHandler(async (req, res) => {
    const tripId = parseId(req.params.id);
    await assertTripBelongsToUser(tripId, requireAuth(req));
    const trip = await queryOne(`${TRIP_SELECT} WHERE t.id = ? LIMIT 1`, [tripId]);
    if (!trip) throw ApiError.notFound('Viaje no encontrado');
    sendSuccess(res, trip);
  }),
);

router.get(
  '/:id/seats',
  requirePermission('trips.view'),
  asyncHandler(async (req, res) => {
    const tripId = parseId(req.params.id);
    await assertTripBelongsToUser(tripId, requireAuth(req));
    sendSuccess(res, await seatMap(tripId));
  }),
);

router.get(
  '/:id/passengers',
  requirePermission('bookings.view'),
  asyncHandler(async (req, res) => {
    const tripId = parseId(req.params.id);
    await assertTripBelongsToUser(tripId, requireAuth(req));

    const rows = await query(
      `SELECT bs.id, bs.passenger_name, bs.passenger_document, bs.price,
              s.seat_number, bk.booking_code, bk.status, bk.passenger_phone, bk.passenger_email,
              u.first_name, u.last_name, u.email AS user_email
       FROM booking_seats bs
       JOIN bookings bk ON bk.id = bs.booking_id
       JOIN seats s ON s.id = bs.seat_id
       JOIN users u ON u.id = bk.user_id
       WHERE bs.trip_id = ? AND bk.status <> 'CANCELLED'
       ORDER BY s.seat_number ASC`,
      [tripId],
    );
    sendSuccess(res, rows);
  }),
);

router.post(
  '/',
  requirePermission('trips.create'),
  validate(createTripSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    await assertRouteAndBusOwnership(req, Number(body.route_id), Number(body.bus_id));

    // La tripulación se comprueba contra la empresa de la ruta, nunca contra lo que envíe
    // el cliente: un driver_id de otra empresa se rechaza aquí.
    const companyId = await companyOfRoute(Number(body.route_id));
    // H-36: una empresa no activa no pone viajes a la venta.
    await assertCompanyOperable(requireAuth(req), companyId);
    await assertCrewAssignable(
      companyId,
      body.driver_id === undefined || body.driver_id === null ? null : Number(body.driver_id),
      body.co_driver_id === undefined || body.co_driver_id === null ? null : Number(body.co_driver_id),
    );

    /**
     * El viaje nace anclado a la version publicada del bus (migracion 010).
     *
     * La version la determina el BACKEND a partir del bus ya validado como propio; el cliente
     * no puede enviar `bus_layout_id` —no esta en el esquema del recurso ni en la lista de
     * columnas escribibles—, de modo que no hay forma de colar la distribucion de otro bus.
     *
     * Sin version publicada no se crea el viaje: un bus sin distribucion no tiene asientos
     * que vender, y dejar nacer el viaje con `bus_layout_id` NULL lo dejaria dependiendo de
     * la red de compatibilidad, que existe solo para los datos anteriores a la migracion.
     */
    const layout = await queryOne<{ id: number; seat_count: number }>(
      "SELECT id, seat_count FROM bus_layouts WHERE bus_id = ? AND status = 'PUBLISHED' LIMIT 1",
      [body.bus_id],
    );
    if (!layout) {
      throw ApiError.badRequest('El bus seleccionado no tiene una distribución de asientos publicada');
    }
    // H-30: un viaje nace programado, en embarque o retrasado; no ya en curso, realizado ni cancelado.
    if (body.status !== undefined && !(TRIP_CREATION_STATUSES as readonly string[]).includes(String(body.status))) {
      throw ApiError.badRequest('Un viaje nuevo solo puede crearse programado, en embarque o retrasado');
    }

    const result = await execute(
      `INSERT INTO trips (route_id, bus_id, bus_layout_id, driver_id, co_driver_id, departure_datetime, arrival_datetime, base_price, available_seats, status, boarding_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.route_id,
        body.bus_id,
        layout.id,
        body.driver_id ?? null,
        body.co_driver_id ?? null,
        body.departure_datetime,
        body.arrival_datetime ?? null,
        body.base_price,
        body.available_seats ?? layout.seat_count,
        body.status ?? 'SCHEDULED',
        body.boarding_notes ?? null,
      ],
    );

    await recordAudit(req, { action: 'CREATE', entityType: 'trips', entityId: result.insertId, description: 'Creó viaje', newValues: body });
    sendSuccess(res, await queryOne(`${TRIP_SELECT} WHERE t.id = ?`, [result.insertId]), 201);
  }),
);

router.put(
  '/:id',
  requirePermission('trips.update'),
  validate(updateTripSchema),
  asyncHandler(async (req, res) => {
    const tripId = parseId(req.params.id);
    const user = requireAuth(req);
    await assertTripBelongsToUser(tripId, user);
    // H-36: tampoco los modifica. Cancelar sigue disponible por `POST /trips/:id/cancel`.
    const empresaDelViaje = await tripCompanyId(tripId);
    if (empresaDelViaje !== null) await assertCompanyOperable(user, empresaDelViaje);

    const body = req.body as Record<string, unknown>;
    await assertRouteAndBusOwnership(
      req,
      body.route_id === undefined ? undefined : Number(body.route_id),
      body.bus_id === undefined ? undefined : Number(body.bus_id),
    );

    if (body.driver_id !== undefined || body.co_driver_id !== undefined) {
      const current = await queryOne<{ route_id: number; driver_id: number | null; co_driver_id: number | null }>(
        'SELECT route_id, driver_id, co_driver_id FROM trips WHERE id = ?',
        [tripId],
      );
      if (!current) throw ApiError.notFound('Viaje no encontrado');

      // Se valida la tripulación RESULTANTE, no solo la que llega: si el viaje ya tenía
      // un conductor y ahora se le asigna como copiloto, hay que detectar la colisión.
      const routeId = body.route_id === undefined ? current.route_id : Number(body.route_id);
      const nextDriver = body.driver_id === undefined ? current.driver_id : (body.driver_id === null ? null : Number(body.driver_id));
      const nextCoDriver = body.co_driver_id === undefined ? current.co_driver_id : (body.co_driver_id === null ? null : Number(body.co_driver_id));

      await assertCrewAssignable(await companyOfRoute(routeId), nextDriver, nextCoDriver);
    }

    /**
     * `available_seats` no está: la mantiene el ciclo de reservas (creación, cancelación y
     * expiración) y escribirla a mano la pondría en contradicción inmediata con los
     * asientos realmente ocupados (auditoría BP-15). Se sigue fijando al crear el viaje,
     * donde por defecto vale la capacidad del bus.
     */
    const allowed = [
      'route_id', 'bus_id', 'driver_id', 'co_driver_id', 'departure_datetime', 'arrival_datetime', 'base_price', 'status', 'boarding_notes',
    ];
    const columns = allowed.filter((column) => body[column] !== undefined);
    if (columns.length === 0) throw ApiError.badRequest('No se enviaron cambios');

    /**
     * `bus_layout_id` NO esta en `allowed`: el cliente no lo escribe nunca. Pero si cambia el
     * bus, la version tiene que cambiar con el, o el viaje quedaria apuntando a la
     * distribucion de un bus que ya no es el suyo y venderia asientos inexistentes.
     *
     * UN VIAJE CON VENTAS YA NO CAMBIA DE BUS (auditoria 6F, hallazgo H-01). Cambiarlo
     * reanclaba la version y dejaba las filas de `booking_seats` apuntando a asientos de la
     * distribucion anterior: el asiento vendido desaparecia del mapa, el viaje volvia a
     * figurar entero libre y se podia vender dos veces. Se comprobo empiricamente antes de
     * escribir esto. La unica correccion segura es no permitir el cambio.
     *
     * TODO ESTO VA EN UNA TRANSACCION Y TRAS BLOQUEAR EL VIAJE. Sin el cerrojo quedaria una
     * ventana entre «no hay ventas» y el UPDATE por la que una compra simultanea se colaria.
     * El viaje es ademas el PRIMER cerrojo que toma el ciclo de reservas (BP-19/BP-21:
     * TRIP -> BOOKING -> BOOKING_SEATS), asi que tomarlo aqui primero respeta ese orden y no
     * puede formar un ciclo. No se pide ninguna conexion adicional dentro de la transaccion.
     */
    const valores: unknown[] = columns.map((column) => body[column]);
    const asignaciones = columns.map((column) => `${column} = ?`);

    await withTransaction(async (connection) => {
      const [filas] = await connection.query(
        'SELECT id, bus_id, bus_layout_id, status FROM trips WHERE id = ? LIMIT 1 FOR UPDATE',
        [tripId],
      );
      const actual = (filas as Array<{ id: number; bus_id: number; bus_layout_id: number | null; status: string }>)[0];
      if (!actual) throw ApiError.notFound('Viaje no encontrado');

      /**
       * Transiciones hacia y desde CANCELLED (FASE 8H), comprobadas bajo el cerrojo del viaje.
       *
       * · Un viaje cancelado no vuelve a ningún otro estado: sus reservas ya se cancelaron y
       *   sus reembolsos ya se abrieron, así que reactivarlo lo dejaría a la venta sin nada
       *   de lo que tenía.
       * · Y a CANCELLED no se llega por aquí: cancelar tiene efectos —reservas, cupos,
       *   reembolsos, avisos— que solo aplica `POST /trips/:id/cancel`. Cambiar la columna a
       *   secas es justo el estado a medias que esa acción existe para evitar.
       */
      if (body.status !== undefined) {
        const siguiente = String(body.status);
        if (actual.status === 'CANCELLED' && siguiente !== 'CANCELLED') {
          throw ApiError.badRequest('Un viaje cancelado no puede cambiar de estado');
        }
        if (siguiente === 'CANCELLED' && actual.status !== 'CANCELLED') {
          throw ApiError.badRequest('Para cancelar un viaje usa la acción «Cancelar viaje»: gestiona sus reservas y reembolsos');
        }
        // H-30: el resto de transiciones siguen el ciclo de vida; no se reabre un viaje realizado
        // ni se completa uno que no ha salido.
        if (siguiente !== actual.status && !(TRIP_MANUAL_TRANSITIONS[actual.status] ?? []).includes(siguiente)) {
          throw ApiError.badRequest(`Un viaje en estado ${actual.status} no puede pasar a ${siguiente}`);
        }
      }

      /**
       * Enviar el MISMO bus no es cambiar de bus: no se toca el anclaje.
       *
       * Antes si se tocaba, y ahi habia una segunda puerta al mismo destrozo: un viaje
       * anclado a la v1 de su bus, con ventas, al que se le reenviaba su propio `bus_id`
       * —cosa que hace cualquier formulario que mande el registro entero— saltaba a la
       * version publicada de hoy. Mismo bus, misma peticion inocente, mismo histórico roto.
       */
      const cambiaDeBus = body.bus_id !== undefined && Number(body.bus_id) !== Number(actual.bus_id);

      if (cambiaDeBus) {
        // QUE CUENTA COMO VENTA: cualquier fila de `booking_seats` del viaje, sin mirar el
        // estado de la reserva. Esas filas no se borran nunca —una reserva cancelada o
        // caducada conserva las suyas como histórico (BP-19)—, y todas apuntan a asientos de
        // la distribucion actual. Limitarse a las que hoy retienen asiento dejaria que el
        // cambio rompiera el histórico de las canceladas, que es histórico igual.
        const [ventas] = await connection.query(
          'SELECT COUNT(*) AS total FROM booking_seats WHERE trip_id = ?',
          [tripId],
        );
        const cuantas = Number((ventas as Array<{ total: number }>)[0]?.total ?? 0);
        if (cuantas > 0) {
          throw ApiError.badRequest(
            'El bus no puede cambiarse porque el viaje ya tiene reservas: cancélalas o crea un viaje nuevo con el otro bus',
          );
        }

        const [publicadas] = await connection.query(
          "SELECT id, seat_count FROM bus_layouts WHERE bus_id = ? AND status = 'PUBLISHED' LIMIT 1",
          [body.bus_id],
        );
        const layout = (publicadas as Array<{ id: number; seat_count: number }>)[0];
        if (!layout) throw ApiError.badRequest('El bus seleccionado no tiene una distribución de asientos publicada');

        asignaciones.push('bus_layout_id = ?');
        valores.push(layout.id);
        // Sin ventas, el viaje entero esta libre: la disponibilidad es la capacidad de la
        // version nueva. Dejarla como estaba era lo que permitia sobrevender al cambiar a un
        // bus mas pequeño.
        asignaciones.push('available_seats = ?');
        valores.push(layout.seat_count);
      }

      await connection.query(`UPDATE trips SET ${asignaciones.join(', ')} WHERE id = ?`, [...valores, tripId]);
    });

    await recordAudit(req, { action: 'UPDATE', entityType: 'trips', entityId: tripId, description: 'Actualizó viaje', newValues: body });
    sendSuccess(res, await queryOne(`${TRIP_SELECT} WHERE t.id = ?`, [tripId]));
  }),
);

/**
 * Cancela un viaje con todos sus efectos (FASE 8H): reservas, cupos, reembolsos y avisos, en
 * una transacción. Ver `cancelTrip`.
 *
 * QUIÉN. `trips.update` y además rol ADMIN o COMPANY_ADMIN. OPERATOR conserva `trips.update`
 * para operar el viaje —estado de embarque, tripulación, notas—, pero cancelarlo mueve dinero
 * de los pasajeros y es una decisión de la empresa. No se tocó `role_permissions`.
 *
 * Repetir la llamada sobre un viaje ya cancelado responde 200 sin hacer nada.
 */
router.post(
  '/:id/cancel',
  requirePermission('trips.update'),
  requireRole('ADMIN', 'COMPANY_ADMIN'),
  asyncHandler(async (req, res) => {
    const tripId = parseId(req.params.id);
    await assertTripBelongsToUser(tripId, requireAuth(req));

    const resultado = await cancelTrip(tripId);

    if (!resultado.alreadyCancelled) {
      const reembolsos = resultado.bookings.filter((booking) => booking.refundId !== null);
      await recordAudit(req, {
        action: 'CANCEL',
        entityType: 'trips',
        entityId: tripId,
        description: `Canceló el viaje: ${resultado.bookings.length} reserva(s) cancelada(s), ${reembolsos.length} reembolso(s) abierto(s)`,
        newValues: {
          bookings_cancelled: resultado.bookings.map((booking) => booking.bookingId),
          refunds_created: reembolsos.map((booking) => booking.refundId),
        },
      });
      for (const booking of resultado.bookings) {
        await recordAudit(req, {
          action: 'CANCEL',
          entityType: 'bookings',
          entityId: booking.bookingId,
          description: `Canceló la reserva ${booking.bookingCode} por cancelación del viaje`,
        });
        if (booking.refundId !== null) {
          await recordAudit(req, {
            action: 'CREATE',
            entityType: 'refunds',
            entityId: booking.refundId,
            description: `Abrió un reembolso de la reserva ${booking.bookingCode} por cancelación del viaje`,
          });
        }
      }
    }

    const viaje = await queryOne<Record<string, unknown>>(`${TRIP_SELECT} WHERE t.id = ?`, [tripId]);
    sendSuccess(res, {
      ...viaje,
      cancellation: {
        already_cancelled: resultado.alreadyCancelled,
        bookings_cancelled: resultado.bookings.length,
        refunds_created: resultado.bookings.filter((booking) => booking.refundId !== null).length,
      },
    });
  }),
);

router.delete(
  '/:id',
  requirePermission('trips.delete'),
  asyncHandler(async (req, res) => {
    const tripId = parseId(req.params.id);
    await assertTripBelongsToUser(tripId, requireAuth(req));

    const bookings = await queryOne<{ total: number }>(
      "SELECT COUNT(*) AS total FROM bookings WHERE trip_id = ? AND status <> 'CANCELLED'",
      [tripId],
    );
    if (Number(bookings?.total ?? 0) > 0) {
      throw ApiError.conflict('No se puede eliminar un viaje con reservas activas. Cancélalo en su lugar.');
    }

    await execute('DELETE FROM trips WHERE id = ?', [tripId]);
    await recordAudit(req, { action: 'DELETE', entityType: 'trips', entityId: tripId, description: 'Eliminó viaje' });
    sendSuccess(res, { id: tripId });
  }),
);

export default router;
