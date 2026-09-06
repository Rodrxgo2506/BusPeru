import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../config/database';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import { cancelBooking, confirmBookingPayment, createBooking } from '../services/booking.service';
import { expireDueBookings } from '../services/booking-expiry.service';
import { createItinerary, findGroupBookingIds, findItinerary, payItinerary } from '../services/itinerary.service';
import { createItinerarySchema } from '../validators/itinerary.validators';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendList, sendSuccess } from '../utils/http';
import { buildPagination, parseListQuery, safeColumn, stableOrderBy, parseId } from '../utils/query';
import { id, optionalId, optionalText } from '../validators/common';

const router = Router();
router.use(authenticate);

const BOOKING_SELECT = `SELECT bk.*, t.departure_datetime, t.arrival_datetime, t.base_price,
    r.company_id, co.name AS company_name,
    ol.city AS origin_city, ol.name AS origin_terminal,
    dl.city AS destination_city, dl.name AS destination_terminal,
    b.code AS bus_code, b.plate_number, bt.name AS bus_type_name,
    u.first_name, u.last_name, u.email AS user_email,
    (SELECT GROUP_CONCAT(s.seat_number ORDER BY s.seat_number SEPARATOR ', ')
       FROM booking_seats bs JOIN seats s ON s.id = bs.seat_id WHERE bs.booking_id = bk.id) AS seat_numbers,
    (SELECT p.status FROM payments p WHERE p.booking_id = bk.id ORDER BY p.id DESC LIMIT 1) AS payment_status,
    (SELECT p.method FROM payments p WHERE p.booking_id = bk.id ORDER BY p.id DESC LIMIT 1) AS payment_method,
    bg.group_code, bg.trip_type,
    (SELECT COUNT(*) FROM bookings sib WHERE sib.group_id = bk.group_id) AS group_segments
  FROM bookings bk
  JOIN trips t ON t.id = bk.trip_id
  JOIN routes r ON r.id = t.route_id
  JOIN locations ol ON ol.id = r.origin_location_id
  JOIN locations dl ON dl.id = r.destination_location_id
  JOIN companies co ON co.id = r.company_id
  LEFT JOIN booking_groups bg ON bg.id = bk.group_id
  JOIN buses b ON b.id = t.bus_id
  LEFT JOIN bus_types bt ON bt.id = b.bus_type_id
  JOIN users u ON u.id = bk.user_id`;

const createBookingSchema = z.object({
  trip_id: id,
  seat_ids: z.array(id).min(1, 'Debes seleccionar al menos un asiento').max(10),
  origin_stop_id: optionalId,
  destination_stop_id: optionalId,
  passenger_name: optionalText(200),
  passenger_document: optionalText(50),
  passenger_phone: optionalText(30),
  passenger_email: z.string().email('Correo inválido').max(150).nullable().optional(),
  notes: optionalText(500),
  coupon_code: optionalText(50),
  payment_method: z.enum(['CARD', 'YAPE', 'PLIN', 'TRANSFER', 'CASH', 'OTHER']).optional(),
  passengers: z
    .array(z.object({ seat_id: id, name: z.string().trim().min(2).max(200), document: z.string().trim().min(6).max(50) }))
    .optional(),
});

const payBookingSchema = z.object({
  method: z.enum(['CARD', 'YAPE', 'PLIN', 'TRANSFER', 'CASH', 'OTHER']),
  provider_transaction_id: optionalText(150),
});

const cancelBookingSchema = z.object({
  reason: optionalText(500),
  request_refund: z.coerce.boolean().optional(),
});

/**
 * Visibility rules: CUSTOMER only sees its own bookings, company roles only bookings of
 * their company's trips, ADMIN sees everything. Enforced here, never from a client filter.
 */
function visibilityScope(req: Request): { sql: string; params: unknown[] } | null {
  const user = requireAuth(req);
  if (user.role === 'ADMIN') return null;
  if (user.role === 'CUSTOMER') return { sql: 'bk.user_id = ?', params: [user.id] };
  if (user.companyIds.length === 0) return { sql: '1 = 0', params: [] };
  return { sql: `r.company_id IN (${user.companyIds.map(() => '?').join(', ')})`, params: [...user.companyIds] };
}

async function findBookingOrFail(req: Request, bookingId: number): Promise<Record<string, unknown>> {
  const conditions = ['bk.id = ?'];
  const params: unknown[] = [bookingId];

  const scope = visibilityScope(req);
  if (scope) {
    conditions.push(scope.sql);
    params.push(...scope.params);
  }

  const booking = await queryOne<Record<string, unknown>>(
    `${BOOKING_SELECT} WHERE ${conditions.join(' AND ')} LIMIT 1`,
    params,
  );
  if (!booking) throw ApiError.notFound('Reserva no encontrada');
  return booking;
}

/**
 * ORDEN IMPORTANTE: estas rutas van antes que `GET /:id`. Si se declararan después,
 * `/bookings/itineraries/5` casaría con `/:id` tomando "itineraries" como id.
 *
 * Compra de varios tramos: ida y vuelta o multidestino.
 *
 * Crea una reserva por tramo dentro de UNA transacción. Si cualquier tramo falla, el
 * ROLLBACK deshace también los anteriores: nunca queda una compra a medias.
 * La compra de IDA sigue usando `POST /bookings` y no ha cambiado.
 */
router.post(
  '/itineraries',
  requirePermission('bookings.create'),
  validate(createItinerarySchema),
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    const result = await createItinerary(user, req.body as never);

    await recordAudit(req, {
      action: 'CREATE',
      entityType: 'booking_groups',
      entityId: result.group_id,
      description: `Creó el itinerario ${result.group_code} (${result.trip_type}, ${result.segments.length} tramos)`,
    });

    sendSuccess(res, await findItinerary(result.group_id, user), 201);
  }),
);

router.get(
  '/itineraries/:id',
  requirePermission('bookings.view'),
  asyncHandler(async (req, res) => {
    sendSuccess(res, await findItinerary(parseId(req.params.id), requireAuth(req)));
  }),
);

/**
 * Paga todos los tramos del itinerario.
 *
 * Cada tramo conserva su propio pago, comisión y liquidación —eso es lo que permite que
 * los tramos sean de empresas distintas—, pero la confirmación es **atómica**: si un tramo
 * falla, `payItinerary` revierte también los tramos ya confirmados.
 */
router.post(
  '/itineraries/:id/pay',
  requirePermission('payments.create', 'bookings.create'),
  validate(payBookingSchema),
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    const groupId = parseId(req.params.id);

    // La comprobación de visibilidad se hace ANTES de abrir la transacción, para no
    // sostenerla mientras se resuelven permisos.
    const bookingIds = await findGroupBookingIds(groupId, user);
    for (const bookingId of bookingIds) await findBookingOrFail(req, bookingId);

    await payItinerary(groupId, user, req.body.method, req.body.provider_transaction_id ?? null);

    await recordAudit(req, {
      action: 'PAYMENT',
      entityType: 'booking_groups',
      entityId: groupId,
      description: `Confirmó el pago del itinerario (${bookingIds.length} tramos)`,
    });

    sendSuccess(res, await findItinerary(groupId, user));
  }),
);

router.get(
  '/',
  requirePermission('bookings.view'),
  asyncHandler(async (req, res) => {
    const listQuery = parseListQuery(req.query as Record<string, unknown>);
    const conditions: string[] = [];
    const params: unknown[] = [];

    const scope = visibilityScope(req);
    if (scope) {
      conditions.push(scope.sql);
      params.push(...scope.params);
    }

    const filterMap: Record<string, string> = {
      status: 'bk.status',
      trip_id: 'bk.trip_id',
      user_id: 'bk.user_id',
      company_id: 'r.company_id',
    };
    for (const [key, column] of Object.entries(filterMap)) {
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
    if (listQuery.search) {
      conditions.push('(bk.booking_code LIKE ? OR bk.passenger_name LIKE ? OR bk.passenger_email LIKE ? OR u.email LIKE ?)');
      params.push(...Array(4).fill(`%${listQuery.search}%`));
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const countRow = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM bookings bk
       JOIN trips t ON t.id = bk.trip_id
       JOIN routes r ON r.id = t.route_id
       JOIN users u ON u.id = bk.user_id${where}`,
      params,
    );

    const sortColumn = safeColumn(listQuery.sort, ['bk.created_at', 'bk.total_amount', 't.departure_datetime', 'bk.status'], 'bk.created_at');
    const rows = await query(`${BOOKING_SELECT}${where} ORDER BY ${stableOrderBy(sortColumn, listQuery.order, 'bk')} LIMIT ? OFFSET ?`, [
      ...params,
      listQuery.limit,
      listQuery.offset,
    ]);

    sendList(res, rows, buildPagination(Number(countRow?.total ?? 0), listQuery.page, listQuery.limit));
  }),
);

router.get(
  '/:id',
  requirePermission('bookings.view'),
  asyncHandler(async (req, res) => {
    const booking = await findBookingOrFail(req, parseId(req.params.id));
    const [seats, payments] = await Promise.all([
      query(
        `SELECT bs.*, s.seat_number, s.row_number, s.column_number, st.name AS seat_type_name
         FROM booking_seats bs
         JOIN seats s ON s.id = bs.seat_id
         LEFT JOIN seat_types st ON st.id = s.seat_type_id
         WHERE bs.booking_id = ? ORDER BY s.seat_number`,
        [booking.id],
      ),
      query('SELECT * FROM payments WHERE booking_id = ? ORDER BY id DESC', [booking.id]),
    ]);
    sendSuccess(res, { ...booking, seats, payments });
  }),
);

router.post(
  '/',
  requirePermission('bookings.create'),
  validate(createBookingSchema),
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    const { payment_method: paymentMethod, ...input } = req.body as Record<string, unknown>;

    const result = await createBooking(
      user,
      input as unknown as Parameters<typeof createBooking>[1],
      paymentMethod as Parameters<typeof createBooking>[2],
    );

    await recordAudit(req, {
      action: 'CREATE',
      entityType: 'bookings',
      entityId: result.bookingId,
      description: `Creó la reserva ${result.bookingCode}`,
    });

    const booking = await findBookingOrFail(req, result.bookingId);
    sendSuccess(res, booking, 201);
  }),
);

router.post(
  '/:id/pay',
  requirePermission('payments.create', 'bookings.create'),
  validate(payBookingSchema),
  asyncHandler(async (req, res) => {
    const bookingId = parseId(req.params.id);
    await findBookingOrFail(req, bookingId);

    await confirmBookingPayment(bookingId, req.body.method, req.body.provider_transaction_id ?? null);
    await recordAudit(req, {
      action: 'PAYMENT',
      entityType: 'bookings',
      entityId: bookingId,
      description: `Confirmó el pago de la reserva`,
    });

    sendSuccess(res, await findBookingOrFail(req, bookingId));
  }),
);

/**
 * Ejecuta la expiración bajo demanda. El planificador ya corre cada minuto; este endpoint
 * permite forzarla (operación y pruebas). Es idempotente: solo afecta a reservas vencidas.
 */
router.post(
  '/expire',
  requirePermission('bookings.cancel'),
  asyncHandler(async (req, res) => {
    const result = await expireDueBookings();
    if (result.expired > 0) {
      await recordAudit(req, {
        action: 'EXPIRE',
        entityType: 'bookings',
        description: `Expiró ${result.expired} reserva(s) vencida(s)`,
        newValues: { booking_ids: result.bookingIds },
      });
    }
    sendSuccess(res, result);
  }),
);

router.post(
  '/:id/cancel',
  requirePermission('bookings.cancel'),
  validate(cancelBookingSchema),
  asyncHandler(async (req, res) => {
    const bookingId = parseId(req.params.id);
    await findBookingOrFail(req, bookingId);

    await cancelBooking(bookingId, req.body.reason ?? null, Boolean(req.body.request_refund));
    await recordAudit(req, {
      action: 'CANCEL',
      entityType: 'bookings',
      entityId: bookingId,
      description: `Canceló la reserva`,
      newValues: { reason: req.body.reason ?? null },
    });

    sendSuccess(res, await findBookingOrFail(req, bookingId));
  }),
);

export default router;
