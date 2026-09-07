import { Router } from 'express';
import { execute, query, queryOne } from '../config/database';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import { assertCrewAssignable } from '../services/driver.service';
import { assertTripBelongsToUser, seatMap } from '../services/trip.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendList, sendSuccess } from '../utils/http';
import { buildPagination, parseListQuery, safeColumn, stableOrderBy, parseId } from '../utils/query';
import { createTripSchema, updateTripSchema } from '../validators/resource.validators';

const router = Router();
router.use(authenticate);

const TRIP_SELECT = `SELECT t.*, r.company_id, r.distance_km, r.estimated_duration_minutes,
    ol.city AS origin_city, ol.name AS origin_terminal,
    dl.city AS destination_city, dl.name AS destination_terminal,
    co.name AS company_name, b.code AS bus_code, b.plate_number, b.capacity, bt.name AS bus_type_name,
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
    await assertCrewAssignable(
      companyId,
      body.driver_id === undefined || body.driver_id === null ? null : Number(body.driver_id),
      body.co_driver_id === undefined || body.co_driver_id === null ? null : Number(body.co_driver_id),
    );

    const bus = await queryOne<{ capacity: number }>('SELECT capacity FROM buses WHERE id = ?', [body.bus_id]);
    const result = await execute(
      `INSERT INTO trips (route_id, bus_id, driver_id, co_driver_id, departure_datetime, arrival_datetime, base_price, available_seats, status, boarding_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.route_id,
        body.bus_id,
        body.driver_id ?? null,
        body.co_driver_id ?? null,
        body.departure_datetime,
        body.arrival_datetime ?? null,
        body.base_price,
        body.available_seats ?? bus?.capacity ?? null,
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

    await execute(`UPDATE trips SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`, [
      ...columns.map((column) => body[column]),
      tripId,
    ]);

    await recordAudit(req, { action: 'UPDATE', entityType: 'trips', entityId: tripId, description: 'Actualizó viaje', newValues: body });
    sendSuccess(res, await queryOne(`${TRIP_SELECT} WHERE t.id = ?`, [tripId]));
  }),
);

router.post(
  '/:id/cancel',
  requirePermission('trips.update'),
  asyncHandler(async (req, res) => {
    const tripId = parseId(req.params.id);
    await assertTripBelongsToUser(tripId, requireAuth(req));

    await execute("UPDATE trips SET status = 'CANCELLED' WHERE id = ?", [tripId]);
    await recordAudit(req, { action: 'CANCEL', entityType: 'trips', entityId: tripId, description: 'Canceló viaje' });
    sendSuccess(res, await queryOne(`${TRIP_SELECT} WHERE t.id = ?`, [tripId]));
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
