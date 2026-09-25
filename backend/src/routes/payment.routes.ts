import { Router, type Request } from 'express';
import { query, queryOne, withTransaction } from '../config/database';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { z } from 'zod';
import { requirePermission, requireRole } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import { NOTIFICATION_EVENTS, notify } from '../services/notification.service';
import {
  REFUND_CLOSING_STATUSES,
  assertRefundCanClose,
  consultarFilas,
  recordCompletedRefund,
  refundThroughCulqi,
  reviewManualPayment,
  withRefundLock,
  type ManualPaymentDecision,
  type RefundClosingStatus,
} from '../services/payment.service';
import { optionalText } from '../validators/common';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendList, sendSuccess } from '../utils/http';
import { buildPagination, parseListQuery, safeColumn, stableOrderBy, parseId } from '../utils/query';
import { centsToDecimal, toCentsExact } from '../utils/money';
import { createRefundSchema } from '../validators/resource.validators';

const router = Router();
router.use(authenticate);

const PAYMENT_SELECT = `SELECT p.*, bk.booking_code, bk.passenger_name, bk.user_id, r.company_id, co.name AS company_name,
    ol.city AS origin_city, dl.city AS destination_city, t.departure_datetime,
    u.first_name, u.last_name, u.email AS user_email
  FROM payments p
  JOIN bookings bk ON bk.id = p.booking_id
  JOIN trips t ON t.id = bk.trip_id
  JOIN routes r ON r.id = t.route_id
  JOIN locations ol ON ol.id = r.origin_location_id
  JOIN locations dl ON dl.id = r.destination_location_id
  JOIN companies co ON co.id = r.company_id
  JOIN users u ON u.id = bk.user_id`;

const REFUND_SELECT = `SELECT rf.*, bk.booking_code, bk.passenger_name, r.company_id, co.name AS company_name,
    p.method AS payment_method, p.transaction_code, u.first_name, u.last_name, u.email AS user_email,
    ol.city AS origin_city, dl.city AS destination_city, t.departure_datetime
  FROM refunds rf
  JOIN bookings bk ON bk.id = rf.booking_id
  JOIN payments p ON p.id = rf.payment_id
  JOIN trips t ON t.id = bk.trip_id
  JOIN routes r ON r.id = t.route_id
  JOIN locations ol ON ol.id = r.origin_location_id
  JOIN locations dl ON dl.id = r.destination_location_id
  JOIN companies co ON co.id = r.company_id
  JOIN users u ON u.id = bk.user_id`;

function visibilityScope(req: Request): { sql: string; params: unknown[] } | null {
  const user = requireAuth(req);
  if (user.role === 'ADMIN') return null;
  if (user.role === 'CUSTOMER') return { sql: 'bk.user_id = ?', params: [user.id] };
  if (user.companyIds.length === 0) return { sql: '1 = 0', params: [] };
  return { sql: `r.company_id IN (${user.companyIds.map(() => '?').join(', ')})`, params: [...user.companyIds] };
}

/**
 * Comprobación de alcance para las ESCRITURAS financieras, donde la empresa no sale de un
 * `WHERE` sino de la cadena `payment → booking → trip → route → company_id` (BP-23).
 *
 * Hoy solo el ADMIN tiene `payments.refund`, así que ninguna de las dos escrituras era
 * explotable entre empresas. Pero el permiso está a una decisión de producto de abrirse a
 * los roles de empresa, y entonces el aislamiento tiene que estar ya puesto: por eso se
 * comprueba aquí y no se deja para más adelante. `POST /settlements` ya usaba este mismo
 * criterio; los dos endpoints de reembolso eran los que no lo hacían.
 *
 * Responde 404 y no 403: el resto de la API tampoco confirma la existencia de un recurso
 * de otra empresa.
 */
function assertCompanyInScope(req: Request, companyId: number): void {
  const user = requireAuth(req);
  if (user.role === 'ADMIN') return;
  if (!user.companyIds.includes(Number(companyId))) throw ApiError.notFound('Recurso no encontrado');
}

function buildListHandler(select: string, alias: string, filterMap: Record<string, string>, searchColumns: string[], sortColumns: string[], defaultSort: string) {
  return asyncHandler(async (req: Request, res) => {
    const listQuery = parseListQuery(req.query as Record<string, unknown>);
    const conditions: string[] = [];
    const params: unknown[] = [];

    const scope = visibilityScope(req);
    if (scope) {
      conditions.push(scope.sql);
      params.push(...scope.params);
    }
    for (const [key, column] of Object.entries(filterMap)) {
      const value = listQuery.filters[key];
      if (value !== undefined) {
        conditions.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (listQuery.filters.from) {
      conditions.push(`${alias}.created_at >= ?`);
      params.push(listQuery.filters.from);
    }
    if (listQuery.filters.to) {
      conditions.push(`${alias}.created_at <= ?`);
      params.push(listQuery.filters.to);
    }
    if (listQuery.search && searchColumns.length > 0) {
      conditions.push(`(${searchColumns.map((column) => `${column} LIKE ?`).join(' OR ')})`);
      params.push(...searchColumns.map(() => `%${listQuery.search}%`));
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const countRow = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM (${select}${where}) AS scoped`, params);
    const sortColumn = safeColumn(listQuery.sort, sortColumns, defaultSort);
    const rows = await query(`${select}${where} ORDER BY ${stableOrderBy(sortColumn, listQuery.order, alias)} LIMIT ? OFFSET ?`, [
      ...params,
      listQuery.limit,
      listQuery.offset,
    ]);

    sendList(res, rows, buildPagination(Number(countRow?.total ?? 0), listQuery.page, listQuery.limit));
  });
}

/* --------------------------------------------------------------------- payments */
export const paymentRouter = Router();
paymentRouter.use(authenticate);

paymentRouter.get(
  '/',
  requirePermission('payments.view'),
  buildListHandler(
    PAYMENT_SELECT,
    'p',
    { status: 'p.status', method: 'p.method', booking_id: 'p.booking_id', company_id: 'r.company_id' },
    ['p.transaction_code', 'bk.booking_code', 'bk.passenger_name', 'u.email'],
    ['p.created_at', 'p.amount', 'p.status'],
    'p.created_at',
  ),
);

paymentRouter.get(
  '/summary',
  requirePermission('payments.view'),
  asyncHandler(async (req, res) => {
    const scope = visibilityScope(req);
    const where = scope ? ` WHERE ${scope.sql}` : '';
    const params = scope?.params ?? [];

    /**
     * VISTA DE CAJA (H-47): el dinero que entró y salió, no la contabilidad de empresas.
     *   cash_collected = Σ pagos que llegaron a cobrarse (PAID o REFUNDED)
     *   cash_refunded  = Σ reembolsos COMPLETED
     *   cash_net       = cash_collected − cash_refunded
     * Antes `total_collected` sumaba solo PAID y `refunded` sumaba el importe ENTERO de los pagos
     * REFUNDED: un reembolso parcial dejaba «cobrado 0» y «reembolsado 100». Las claves antiguas se
     * mantienen con el significado de caja.
     */
    const cobros = await queryOne<{ cash_collected: string; today_collected: string; yesterday_collected: string; total_payments: number }>(
      `SELECT
        COALESCE(SUM(CASE WHEN p.status IN ('PAID','REFUNDED') THEN p.amount ELSE 0 END), 0) AS cash_collected,
        COALESCE(SUM(CASE WHEN p.status IN ('PAID','REFUNDED') AND DATE(p.paid_at) = CURDATE() THEN p.amount ELSE 0 END), 0) AS today_collected,
        COALESCE(SUM(CASE WHEN p.status IN ('PAID','REFUNDED') AND DATE(p.paid_at) = CURDATE() - INTERVAL 1 DAY THEN p.amount ELSE 0 END), 0) AS yesterday_collected,
        COUNT(*) AS total_payments
       FROM payments p
       JOIN bookings bk ON bk.id = p.booking_id
       JOIN trips t ON t.id = bk.trip_id
       JOIN routes r ON r.id = t.route_id${where}`,
      params,
    );
    const devoluciones = await queryOne<{ cash_refunded: string }>(
      `SELECT COALESCE(SUM(rf.amount), 0) AS cash_refunded
       FROM refunds rf
       JOIN payments p ON p.id = rf.payment_id
       JOIN bookings bk ON bk.id = p.booking_id
       JOIN trips t ON t.id = bk.trip_id
       JOIN routes r ON r.id = t.route_id
       WHERE rf.status = 'COMPLETED'${scope ? ` AND ${scope.sql}` : ''}`,
      params,
    );
    const cobradoCents = toCentsExact(String(cobros?.cash_collected ?? '0'));
    const devueltoCents = toCentsExact(String(devoluciones?.cash_refunded ?? '0'));
    sendSuccess(res, {
      cash_collected: centsToDecimal(cobradoCents),
      cash_refunded: centsToDecimal(devueltoCents),
      cash_net: centsToDecimal(cobradoCents - devueltoCents),
      total_collected: centsToDecimal(cobradoCents),
      today_collected: cobros?.today_collected ?? '0.00',
      yesterday_collected: cobros?.yesterday_collected ?? '0.00',
      refunded: centsToDecimal(devueltoCents),
      total_payments: Number(cobros?.total_payments ?? 0),
    });
  }),
);

paymentRouter.get(
  '/:id',
  requirePermission('payments.view'),
  asyncHandler(async (req, res) => {
    const conditions = ['p.id = ?'];
    const params: unknown[] = [parseId(req.params.id)];
    const scope = visibilityScope(req);
    if (scope) {
      conditions.push(scope.sql);
      params.push(...scope.params);
    }
    const payment = await queryOne(`${PAYMENT_SELECT} WHERE ${conditions.join(' AND ')} LIMIT 1`, params);
    if (!payment) throw ApiError.notFound('Pago no encontrado');
    sendSuccess(res, payment);
  }),
);

/**
 * Verificación manual de pagos (auditoría FASE 9, hallazgo H-22).
 *
 * Un pago con Yape, Plin, transferencia, efectivo u otro que registra el pasajero queda
 * PENDING hasta que alguien que responde del dinero lo verifica. Pueden hacerlo ADMIN (todas
 * las empresas) y COMPANY_ADMIN (solo la suya): `payments.create`, que ya tienen, más el rol,
 * el mismo patrón que la cancelación de viajes. OPERATOR no tiene `payments.create` y
 * CUSTOMER sí lo tiene para pagar, pero no el rol: ninguno de los dos verifica.
 *
 * Alcance: el pago se busca con la misma visibilidad que `GET /payments/:id`; uno de otra
 * empresa responde 404, como el resto de la API.
 */
const reviewPaymentSchema = z.object({ reason: optionalText(500) });

function reviewHandler(decision: ManualPaymentDecision) {
  return asyncHandler(async (req, res) => {
    const paymentId = parseId(req.params.id);
    const user = requireAuth(req);

    const conditions = ['p.id = ?'];
    const params: unknown[] = [paymentId];
    const scope = visibilityScope(req);
    if (scope) {
      conditions.push(scope.sql);
      params.push(...scope.params);
    }
    const visible = await queryOne(`${PAYMENT_SELECT} WHERE ${conditions.join(' AND ')} LIMIT 1`, params);
    if (!visible) throw ApiError.notFound('Pago no encontrado');

    const { outcome, bookingId } = await reviewManualPayment(paymentId, decision, user.id, (req.body.reason as string | undefined) ?? null);

    if (outcome === 'APPROVED' || outcome === 'REJECTED') {
      await recordAudit(req, {
        action: 'PAYMENT',
        entityType: 'payments',
        entityId: paymentId,
        description: outcome === 'APPROVED' ? `Aprobó el pago manual de la reserva #${bookingId}` : `Rechazó el pago manual de la reserva #${bookingId}`,
        newValues: { outcome, reason: req.body.reason ?? null },
      });
    }

    const payment = await queryOne<Record<string, unknown>>(`${PAYMENT_SELECT} WHERE p.id = ? LIMIT 1`, [paymentId]);
    sendSuccess(res, { ...payment, review_outcome: outcome });
  });
}

paymentRouter.post(
  '/:id/approve',
  requirePermission('payments.create'),
  requireRole('ADMIN', 'COMPANY_ADMIN'),
  validate(reviewPaymentSchema),
  reviewHandler('APPROVE'),
);

paymentRouter.post(
  '/:id/reject',
  requirePermission('payments.create'),
  requireRole('ADMIN', 'COMPANY_ADMIN'),
  validate(reviewPaymentSchema),
  reviewHandler('REJECT'),
);

/* ---------------------------------------------------------------------- refunds */
export const refundRouter = Router();
refundRouter.use(authenticate);

refundRouter.get(
  '/',
  requirePermission('payments.view'),
  buildListHandler(
    REFUND_SELECT,
    'rf',
    { status: 'rf.status', booking_id: 'rf.booking_id', company_id: 'r.company_id' },
    ['bk.booking_code', 'bk.passenger_name', 'u.email'],
    ['rf.created_at', 'rf.amount', 'rf.status'],
    'rf.created_at',
  ),
);

refundRouter.get(
  '/summary',
  requirePermission('payments.view'),
  asyncHandler(async (req, res) => {
    const scope = visibilityScope(req);
    const where = scope ? ` WHERE ${scope.sql}` : '';
    const summary = await queryOne(
      `SELECT COUNT(*) AS total_requests,
        SUM(rf.status = 'PENDING') AS pending,
        SUM(rf.status = 'COMPLETED') AS completed,
        SUM(rf.status = 'CANCELLED') AS rejected,
        COALESCE(SUM(rf.amount), 0) AS total_amount,
        COALESCE(SUM(CASE WHEN rf.status = 'COMPLETED' THEN rf.amount ELSE 0 END), 0) AS refunded_amount,
        COALESCE(SUM(CASE WHEN rf.status IN ('PENDING','PROCESSING') THEN rf.amount ELSE 0 END), 0) AS pending_amount
       FROM refunds rf
       JOIN bookings bk ON bk.id = rf.booking_id
       JOIN trips t ON t.id = bk.trip_id
       JOIN routes r ON r.id = t.route_id${where}`,
      scope?.params ?? [],
    );
    sendSuccess(res, summary);
  }),
);

refundRouter.post(
  '/',
  requirePermission('payments.refund'),
  validate(createRefundSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const paymentId = Number(body.payment_id);
    const bookingId = Number(body.booking_id);
    const amount = Number(body.amount);

    /**
     * Los identificadores llegaban del cliente y se insertaban sin comprobar nada: se podía
     * ligar el pago de una reserva con la reserva de otra, reembolsar un pago no cobrado o
     * pedir más de lo pagado. Aquí se deriva y se valida la cadena completa.
     *
     * Todo ocurre dentro de una transacción que empieza bloqueando el pago. Ese bloqueo es
     * lo que hace segura la suma de reembolsos anteriores: dos solicitudes simultáneas
     * sobre el mismo pago se serializan, así que entre las dos no pueden pasarse del
     * importe cobrado.
     */
    const refundId = await withTransaction(async (connection) => {
      const [paymentRows] = await connection.query(
        `SELECT p.id, p.booking_id, p.amount, p.status, r.company_id
         FROM payments p
         JOIN bookings bk ON bk.id = p.booking_id
         JOIN trips t ON t.id = bk.trip_id
         JOIN routes r ON r.id = t.route_id
         WHERE p.id = ? LIMIT 1 FOR UPDATE`,
        [paymentId],
      );
      const payment = (paymentRows as Array<{
        id: number;
        booking_id: number;
        amount: number;
        status: string;
        company_id: number;
      }>)[0];
      if (!payment) throw ApiError.notFound('Pago no encontrado');

      assertCompanyInScope(req, payment.company_id);

      if (Number(payment.booking_id) !== bookingId) {
        throw ApiError.badRequest('El pago indicado no pertenece a esa reserva');
      }
      if (payment.status !== 'PAID') {
        throw ApiError.badRequest('Solo se puede reembolsar un pago cobrado');
      }
      // El importe llega validado como número no negativo; aquí se descarta también el cero.
      if (!(amount > 0)) throw ApiError.badRequest('El importe del reembolso debe ser mayor que cero');

      // Un reembolso PENDING o PROCESSING ya tiene ese dinero comprometido y cuenta contra
      // el pago. Los FAILED y CANCELLED no llegaron a ninguna parte y se ignoran.
      const [sumRows] = await connection.query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM refunds
         WHERE payment_id = ? AND status NOT IN ('FAILED', 'CANCELLED')`,
        [paymentId],
      );
      // En céntimos enteros (H-51): el saldo reembolsable no se decide con coma flotante.
      const yaReembolsadoCents = toCentsExact(String((sumRows as Array<{ total: string }>)[0]?.total ?? '0'));
      const disponibleCents = toCentsExact(String(payment.amount)) - yaReembolsadoCents;

      if (disponibleCents <= 0) throw ApiError.badRequest('El pago ya está reembolsado por completo');
      if (toCentsExact(amount) > disponibleCents) {
        throw ApiError.badRequest(`El importe supera lo reembolsable de este pago (S/ ${centsToDecimal(disponibleCents)})`);
      }

      /**
       * El reembolso nace pendiente de procesar. Crearlo ya COMPLETED consumiría el importe
       * del pago sin haber escrito nunca el movimiento REFUND ni haber marcado el pago como
       * reembolsado, porque eso lo hace `POST /refunds/:id/process`, que además rechazaría
       * después el reembolso por considerarlo ya procesado.
       */
      const status = body.status === undefined ? 'PENDING' : String(body.status);
      if (!['PENDING', 'PROCESSING'].includes(status)) {
        throw ApiError.badRequest('Un reembolso se crea pendiente y se cierra al procesarlo');
      }

      const [result] = await connection.query(
        `INSERT INTO refunds (payment_id, booking_id, amount, reason, status) VALUES (?, ?, ?, ?, ?)`,
        [paymentId, bookingId, centsToDecimal(toCentsExact(amount)), body.reason ?? null, status],
      );
      return (result as { insertId: number }).insertId;
    });

    await recordAudit(req, { action: 'CREATE', entityType: 'refunds', entityId: refundId, description: 'Registró un reembolso', newValues: body });
    sendSuccess(res, await queryOne(`${REFUND_SELECT} WHERE rf.id = ?`, [refundId]), 201);
  }),
);

/**
 * Processing a refund updates the refund, the payment and the booking, and records the
 * negative financial transaction — all atomically.
 */
/**
 * Cuerpo de `process`: solo un estado de cierre (H-44). PENDING o PROCESSING no cierran nada y
 * antes se aceptaban sellando `processed_at`.
 */
const processRefundSchema = z.object({ status: z.enum(REFUND_CLOSING_STATUSES).optional() });

refundRouter.post(
  '/:id/process',
  requirePermission('payments.refund'),
  validate(processRefundSchema),
  asyncHandler(async (req, res) => {
    const refundId = parseId(req.params.id);
    const status: RefundClosingStatus = (req.body.status as RefundClosingStatus | undefined) ?? 'COMPLETED';

    // El dinero se devuelve por Culqi ANTES de cerrar el reembolso, y fuera de la
    // transaccion: sostener sus cerrojos durante una llamada de red bloquearia el pago y la
    // reserva. Si Culqi falla, esto lanza y el reembolso se queda como estaba, reintentable.
    // Devuelve null cuando el cobro no paso por la pasarela (efectivo, transferencia): en
    // ese caso el reembolso se cierra como siempre porque el dinero se mueve por fuera.
    // Todo el procesamiento —Culqi y cierre— va bajo un cerrojo por reembolso (FASE 8H): dos
    // peticiones simultáneas ya no pueden pedir dos devoluciones del mismo dinero.
    // H-44: el cerrojo es por PAGO y las reglas de cierre se comprueban ANTES de pedir nada a
    // Culqi —alcance, estado terminal y límite de lo cobrado— y otra vez dentro de la transacción.
    await withRefundLock(refundId, async () => {
      const alcance = await queryOne<{ company_id: number }>(
        `SELECT r.company_id FROM refunds rf
         JOIN bookings bk ON bk.id = rf.booking_id
         JOIN trips t ON t.id = bk.trip_id
         JOIN routes r ON r.id = t.route_id
         WHERE rf.id = ? LIMIT 1`,
        [refundId],
      );
      if (!alcance) throw ApiError.notFound('Reembolso no encontrado');
      assertCompanyInScope(req, Number(alcance.company_id));
      await assertRefundCanClose(consultarFilas, refundId, status);

      const providerRefundId = status === 'COMPLETED' ? await refundThroughCulqi(refundId) : null;

      await withTransaction(async (connection) => {
        const [rows] = await connection.query(
          `SELECT rf.*, r.company_id, bk.user_id, bk.booking_code,
                  ol.city AS origin_city, dl.city AS destination_city
           FROM refunds rf
           JOIN bookings bk ON bk.id = rf.booking_id
           JOIN trips t ON t.id = bk.trip_id
           JOIN routes r ON r.id = t.route_id
           JOIN locations ol ON ol.id = r.origin_location_id
           JOIN locations dl ON dl.id = r.destination_location_id
           WHERE rf.id = ? LIMIT 1 FOR UPDATE`,
          [refundId],
        );
        const refund = (rows as Record<string, unknown>[])[0];
        if (!refund) throw ApiError.notFound('Reembolso no encontrado');
        // Alcance por empresa (BP-23): la empresa ya viene resuelta por el JOIN de arriba.
        assertCompanyInScope(req, Number(refund.company_id));
        // Segunda comprobación, sobre la fila ya bloqueada: nada pudo cambiar bajo el cerrojo del
        // pago, pero el cierre no se escribe sin volver a verificarlo.
        await assertRefundCanClose(
          async <T>(sql: string, params: unknown[]) => (await connection.query(sql, params))[0] as T[],
          refundId,
          status,
        );

        await connection.query(
          'UPDATE refunds SET status = ?, processed_at = NOW(), provider_refund_id = COALESCE(?, provider_refund_id) WHERE id = ?',
          [status, providerRefundId, refundId],
        );

        if (status === 'COMPLETED') {
          // H-26 · H-27 · H-28: libro de la empresa o de la plataforma, reversión proporcional de la
          // comisión y estado del pago según lo devuelto. Ver `recordCompletedRefund`.
          await recordCompletedRefund(connection, {
            id: refundId,
            payment_id: Number(refund.payment_id),
            booking_id: Number(refund.booking_id),
            amount: String(refund.amount),
            company_id: Number(refund.company_id),
          });

          await notify(connection, {
            userId: Number(refund.user_id),
            event: NOTIFICATION_EVENTS.REFUND_COMPLETED,
            eventKey: `${NOTIFICATION_EVENTS.REFUND_COMPLETED}:${refundId}`,
            context: {
              booking_code: String(refund.booking_code),
              booking_id: Number(refund.booking_id),
              origin_city: String(refund.origin_city),
              destination_city: String(refund.destination_city),
              amount: `S/ ${Number(refund.amount).toFixed(2)}`,
            },
          });
        }
      });
    });

    await recordAudit(req, { action: 'REFUND', entityType: 'refunds', entityId: refundId, description: `Procesó reembolso (${status})` });
    sendSuccess(res, await queryOne(`${REFUND_SELECT} WHERE rf.id = ?`, [refundId]));
  }),
);

export default router;
