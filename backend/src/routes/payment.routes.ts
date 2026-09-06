import { Router, type Request } from 'express';
import { execute, query, queryOne, withTransaction } from '../config/database';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import { NOTIFICATION_EVENTS, notify } from '../services/notification.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendList, sendSuccess } from '../utils/http';
import { buildPagination, parseListQuery, safeColumn, stableOrderBy, parseId } from '../utils/query';
import { createRefundSchema, updateRefundSchema } from '../validators/resource.validators';

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

    const summary = await queryOne(
      `SELECT
        COALESCE(SUM(CASE WHEN p.status = 'PAID' THEN p.amount ELSE 0 END), 0) AS total_collected,
        COALESCE(SUM(CASE WHEN p.status = 'PAID' AND DATE(p.paid_at) = CURDATE() THEN p.amount ELSE 0 END), 0) AS today_collected,
        COALESCE(SUM(CASE WHEN p.status = 'PAID' AND DATE(p.paid_at) = CURDATE() - INTERVAL 1 DAY THEN p.amount ELSE 0 END), 0) AS yesterday_collected,
        COALESCE(SUM(CASE WHEN p.status = 'REFUNDED' THEN p.amount ELSE 0 END), 0) AS refunded,
        COUNT(*) AS total_payments
       FROM payments p
       JOIN bookings bk ON bk.id = p.booking_id
       JOIN trips t ON t.id = bk.trip_id
       JOIN routes r ON r.id = t.route_id${where}`,
      params,
    );
    sendSuccess(res, summary);
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
    const result = await execute(
      `INSERT INTO refunds (payment_id, booking_id, amount, reason, status) VALUES (?, ?, ?, ?, ?)`,
      [body.payment_id, body.booking_id, body.amount, body.reason ?? null, body.status ?? 'PENDING'],
    );
    await recordAudit(req, { action: 'CREATE', entityType: 'refunds', entityId: result.insertId, description: 'Registró un reembolso', newValues: body });
    sendSuccess(res, await queryOne(`${REFUND_SELECT} WHERE rf.id = ?`, [result.insertId]), 201);
  }),
);

/**
 * Processing a refund updates the refund, the payment and the booking, and records the
 * negative financial transaction — all atomically.
 */
refundRouter.post(
  '/:id/process',
  requirePermission('payments.refund'),
  validate(updateRefundSchema),
  asyncHandler(async (req, res) => {
    const refundId = parseId(req.params.id);
    const status = (req.body.status as string) ?? 'COMPLETED';

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
      if (refund.status === 'COMPLETED') throw ApiError.badRequest('El reembolso ya fue procesado');

      await connection.query('UPDATE refunds SET status = ?, processed_at = NOW() WHERE id = ?', [status, refundId]);

      if (status === 'COMPLETED') {
        await connection.query("UPDATE payments SET status = 'REFUNDED' WHERE id = ?", [refund.payment_id]);
        await connection.query(
          `INSERT INTO financial_transactions (company_id, booking_id, payment_id, type, direction, amount, currency, description, status, transaction_date)
           VALUES (?, ?, ?, 'REFUND', 'DEBIT', ?, 'PEN', ?, 'COMPLETED', NOW())`,
          [refund.company_id, refund.booking_id, refund.payment_id, refund.amount, `Reembolso de la reserva #${refund.booking_id}`],
        );

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

    await recordAudit(req, { action: 'REFUND', entityType: 'refunds', entityId: refundId, description: `Procesó reembolso (${status})` });
    sendSuccess(res, await queryOne(`${REFUND_SELECT} WHERE rf.id = ?`, [refundId]));
  }),
);

export default router;
