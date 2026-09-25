import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../config/database';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import {
  canVerifyManualPayments,
  cancelBooking,
  confirmBookingPayment,
  createBooking,
  registerManualPayment,
} from '../services/booking.service';
import { payBookingWithCard } from '../services/payment.service';
import { expireDueBookings, type ExpiryScope } from '../services/booking-expiry.service';
import {
  assertItineraryMethodSupported,
  createItinerary,
  findGroupBookingIds,
  findItinerary,
  payItinerary,
  registerItineraryManualPayment,
} from '../services/itinerary.service';
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

/**
 * Cuerpo del pago.
 *
 * `provider_transaction_id` **ya no se acepta del cliente**. Antes se guardaba tal cual como
 * prueba de cobro, de modo que cualquiera podía confirmar una reserva inventando un
 * identificador. Ahora, con tarjeta, el único dato que llega es el token que Culqi entregó
 * al navegador; el identificador de la transacción lo devuelve Culqi al backend.
 */
const payBookingSchema = z
  .object({
    method: z.enum(['CARD', 'YAPE', 'PLIN', 'TRANSFER', 'CASH', 'OTHER']),
    /** `tkn_…` de Culqi. Obligatorio con tarjeta, prohibido en el resto. */
    token: optionalText(120),
  })
  .superRefine((value, ctx) => {
    if (value.method === 'CARD' && !value.token) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Falta el token de pago', path: ['token'] });
    }
  });

/**
 * Pago de un itinerario. Solo el metodo: aqui NO se acepta token de Culqi.
 *
 * El cobro con tarjeta por pasarela esta implementado para la compra de un tramo. Un
 * itinerario son N reservas de N empresas y un token de Culqi sirve para un unico cargo, asi
 * que cobrar un grupo exige decidir antes si se hace un cargo por el total o uno por tramo.
 * Hasta esa decision no se acepta token y `CARD` se rechaza con 400 en la ruta
 * (`assertItineraryMethodSupported`, hallazgo H-23): no se aparenta un cobro que no ocurre.
 */
const payItinerarySchema = z.object({
  method: z.enum(['CARD', 'YAPE', 'PLIN', 'TRANSFER', 'CASH', 'OTHER']),
});

/**
 * `request_refund` se sigue aceptando por compatibilidad, pero ya no decide nada (H-50): una reserva
 * pagada abre su reembolso siempre. Antes, además, `z.coerce.boolean` convertía el texto "false" en
 * `true`; como el valor se ignora, eso deja de importar.
 */
const cancelBookingSchema = z.object({
  reason: optionalText(500),
  request_refund: z.unknown().optional(),
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

/**
 * El mismo alcance de `visibilityScope`, expresado como dato en vez de como SQL.
 *
 * La expiración vive en un servicio y ese servicio también lo usa el planificador, que no
 * tiene petición ni sesión; pasarle un fragmento de SQL desde una ruta lo ataría a la capa
 * HTTP. Se le pasa quién pregunta y el servicio decide.
 */
function expiryScope(req: Request): ExpiryScope {
  const user = requireAuth(req);
  if (user.role === 'ADMIN') return { kind: 'all' };
  if (user.role === 'CUSTOMER') return { kind: 'user', userId: user.id };
  return { kind: 'companies', companyIds: user.companyIds };
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
  validate(payItinerarySchema),
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    const groupId = parseId(req.params.id);

    // H-23: la tarjeta se rechaza antes de cualquier lectura o efecto (ver el servicio).
    assertItineraryMethodSupported(req.body.method);

    // La comprobación de visibilidad se hace ANTES de abrir la transacción, para no
    // sostenerla mientras se resuelven permisos.
    const bookingIds = await findGroupBookingIds(groupId, user);
    for (const bookingId of bookingIds) await findBookingOrFail(req, bookingId);

    // PENDIENTE DECLARADO: el cobro con tarjeta por Culqi está implementado para la compra
    // de un solo tramo. Un itinerario son N reservas de N empresas y un token de Culqi sirve
    // para un único cargo, así que cobrar un grupo exige decidir antes si se hace un cargo
    // por el total o uno por tramo. Hasta esa decisión la tarjeta queda rechazada arriba y
    // los demás métodos siguen igual, sin pasarela.
    //
    // H-22: igual que en la reserva suelta, el pasajero no confirma un pago manual. Sus
    // tramos quedan con el pago PENDING y los verifica el backoffice de cada empresa.
    if (!canVerifyManualPayments(user)) {
      await registerItineraryManualPayment(groupId, user, req.body.method);
      await recordAudit(req, {
        action: 'PAYMENT',
        entityType: 'booking_groups',
        entityId: groupId,
        description: `Registró un pago ${req.body.method} del itinerario pendiente de verificación (${bookingIds.length} tramos)`,
      });
      const itinerario = await findItinerary(groupId, user);
      const segmentos = (itinerario.segments ?? []) as Array<{ status?: unknown }>;
      sendSuccess(res, itinerario, segmentos.some((segmento) => segmento.status === 'PENDING') ? 202 : 200);
      return;
    }

    await payItinerary(groupId, user, req.body.method, null);

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

    // Con tarjeta se cobra de verdad contra Culqi antes de confirmar nada. El resto de
    // métodos son cobros presenciales o por transferencia, sin pasarela: ver H-22 abajo.
    if (req.body.method === 'CARD') {
      const resultado = await payBookingWithCard(requireAuth(req), bookingId, String(req.body.token));

      if (resultado.status !== 'PAID') {
        await recordAudit(req, {
          action: 'PAYMENT',
          entityType: 'bookings',
          entityId: bookingId,
          description: `Intento de pago con tarjeta no completado (${resultado.status})`,
        });
        // Un rechazo del banco no es un fallo del servidor: se devuelve 402, que es lo que
        // significa exactamente «hace falta un medio de pago que funcione». Un resultado
        // desconocido (H-29, `UNCONFIRMED`) conserva el código, pero su mensaje no afirma nada.
        throw new ApiError(402, resultado.message);
      }

      await recordAudit(req, {
        action: 'PAYMENT',
        entityType: 'bookings',
        entityId: bookingId,
        description: 'Confirmó el pago con tarjeta (Culqi)',
      });
      sendSuccess(res, await findBookingOrFail(req, bookingId));
      return;
    }

    // H-22: un pago manual solo lo da por cobrado el backoffice (ADMIN o COMPANY_ADMIN, este
    // dentro de su empresa, que ya comprobó `findBookingOrFail`). Cualquier otro rol —el
    // pasajero— lo deja registrado y PENDING, sin confirmar la reserva ni escribir movimientos:
    // lo aprueba o rechaza después `POST /payments/:id/approve|reject`. Lo decide el ROL
    // autenticado, nunca un campo del cuerpo, que el esquema además descarta.
    const user = requireAuth(req);
    if (!canVerifyManualPayments(user)) {
      const registro = await registerManualPayment(bookingId, req.body.method, user.id);
      if (registro === 'REGISTERED') {
        await recordAudit(req, {
          action: 'PAYMENT',
          entityType: 'bookings',
          entityId: bookingId,
          description: `Registró un pago ${req.body.method} pendiente de verificación`,
        });
      }
      const booking = await findBookingOrFail(req, bookingId);
      // 202: aceptado y registrado, pero el cobro todavía no está verificado.
      sendSuccess(res, booking, booking.status === 'PENDING' ? 202 : 200);
      return;
    }

    await confirmBookingPayment(bookingId, req.body.method, null);
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
 *
 * ALCANCE (auditoría BP-22). Antes lanzaba el barrido GLOBAL del sistema, y `bookings.cancel`
 * lo tienen los cuatro roles: una empresa caducaba reservas de otra y recibía sus
 * identificadores en la respuesta, y un CUSTOMER podía barrer toda la plataforma. Ahora
 * alcanza exactamente lo que esa persona ya puede ver, como cualquier otro endpoint. Lo
 * ajeno que haya vencido lo sigue caducando el planificador, que sí es global porque no
 * actúa en nombre de nadie.
 */
router.post(
  '/expire',
  requirePermission('bookings.cancel'),
  asyncHandler(async (req, res) => {
    const result = await expireDueBookings({ scope: expiryScope(req) });
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

    await cancelBooking(bookingId, req.body.reason ?? null);
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
