import { Router, type Request } from 'express';
import { query, queryOne, withTransaction } from '../config/database';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendList, sendSuccess } from '../utils/http';
import { buildPagination, parseListQuery, safeColumn, parseId, stableOrderBy } from '../utils/query';
import { createSettlementSchema, updateSettlementSchema } from '../validators/resource.validators';

/** Financial data is gated behind `reports.view`; generating settlements requires `settings.update`. */
function companyScope(req: Request, column: string): { sql: string; params: number[] } | null {
  const user = requireAuth(req);
  if (user.role === 'ADMIN') return null;
  if (user.companyIds.length === 0) return { sql: '1 = 0', params: [] };
  return { sql: `${column} IN (${user.companyIds.map(() => '?').join(', ')})`, params: [...user.companyIds] };
}

/* ------------------------------------------------------- financial transactions */
export const transactionRouter = Router();
transactionRouter.use(authenticate);

const TRANSACTION_SELECT = `SELECT ft.*, co.name AS company_name, bk.booking_code,
    u.first_name, u.last_name, u.email AS user_email
  FROM financial_transactions ft
  LEFT JOIN companies co ON co.id = ft.company_id
  LEFT JOIN bookings bk ON bk.id = ft.booking_id
  LEFT JOIN users u ON u.id = ft.user_id`;

transactionRouter.get(
  '/',
  requirePermission('reports.view'),
  asyncHandler(async (req, res) => {
    const listQuery = parseListQuery(req.query as Record<string, unknown>);
    const conditions: string[] = [];
    const params: unknown[] = [];

    const scope = companyScope(req, 'ft.company_id');
    if (scope) {
      conditions.push(scope.sql);
      params.push(...scope.params);
    }
    for (const [key, column] of Object.entries({ type: 'ft.type', status: 'ft.status', direction: 'ft.direction', company_id: 'ft.company_id' })) {
      const value = listQuery.filters[key];
      if (value !== undefined) {
        conditions.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (listQuery.filters.from) {
      conditions.push('ft.transaction_date >= ?');
      params.push(listQuery.filters.from);
    }
    if (listQuery.filters.to) {
      conditions.push('ft.transaction_date <= ?');
      params.push(listQuery.filters.to);
    }
    if (listQuery.search) {
      conditions.push('(ft.reference_code LIKE ? OR ft.description LIKE ? OR bk.booking_code LIKE ?)');
      params.push(...Array(3).fill(`%${listQuery.search}%`));
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const countRow = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM (${TRANSACTION_SELECT}${where}) AS scoped`, params);
    const sortColumn = safeColumn(listQuery.sort, ['ft.transaction_date', 'ft.amount', 'ft.created_at'], 'ft.transaction_date');

    const rows = await query(`${TRANSACTION_SELECT}${where} ORDER BY ${stableOrderBy(sortColumn, listQuery.order, 'ft')} LIMIT ? OFFSET ?`, [
      ...params,
      listQuery.limit,
      listQuery.offset,
    ]);
    sendList(res, rows, buildPagination(Number(countRow?.total ?? 0), listQuery.page, listQuery.limit));
  }),
);

transactionRouter.get(
  '/summary',
  requirePermission('reports.view'),
  asyncHandler(async (req, res) => {
    const scope = companyScope(req, 'ft.company_id');
    const where = scope ? ` WHERE ${scope.sql}` : '';
    const summary = await queryOne(
      `SELECT
        COALESCE(SUM(CASE WHEN ft.type = 'PAYMENT' AND ft.status = 'COMPLETED' THEN ft.amount ELSE 0 END), 0) AS gross_income,
        COALESCE(SUM(CASE WHEN ft.type = 'COMMISSION' AND ft.status = 'COMPLETED' THEN ft.amount ELSE 0 END), 0) AS commissions,
        COALESCE(SUM(CASE WHEN ft.type = 'REFUND' AND ft.status = 'COMPLETED' THEN ft.amount ELSE 0 END), 0) AS refunds,
        COALESCE(SUM(CASE WHEN ft.type = 'PAYOUT' AND ft.status = 'COMPLETED' THEN ft.amount ELSE 0 END), 0) AS payouts,
        COUNT(*) AS total_transactions
       FROM financial_transactions ft${where}`,
      scope?.params ?? [],
    );
    sendSuccess(res, summary);
  }),
);

/* ------------------------------------------------------------------ settlements */
export const settlementRouter = Router();
settlementRouter.use(authenticate);

const SETTLEMENT_SELECT = `SELECT s.*, co.name AS company_name,
    (SELECT COUNT(*) FROM settlement_items si WHERE si.settlement_id = s.id) AS items_count
  FROM settlements s JOIN companies co ON co.id = s.company_id`;

settlementRouter.get(
  '/',
  requirePermission('reports.view'),
  asyncHandler(async (req, res) => {
    const listQuery = parseListQuery(req.query as Record<string, unknown>);
    const conditions: string[] = [];
    const params: unknown[] = [];

    const scope = companyScope(req, 's.company_id');
    if (scope) {
      conditions.push(scope.sql);
      params.push(...scope.params);
    }
    for (const [key, column] of Object.entries({ status: 's.status', company_id: 's.company_id' })) {
      const value = listQuery.filters[key];
      if (value !== undefined) {
        conditions.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (listQuery.search) {
      conditions.push('(s.settlement_code LIKE ? OR co.name LIKE ?)');
      params.push(`%${listQuery.search}%`, `%${listQuery.search}%`);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const countRow = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM (${SETTLEMENT_SELECT}${where}) AS scoped`, params);
    const sortColumn = safeColumn(listQuery.sort, ['s.created_at', 's.period_start', 's.net_amount'], 's.created_at');

    const rows = await query(`${SETTLEMENT_SELECT}${where} ORDER BY ${stableOrderBy(sortColumn, listQuery.order, 's')} LIMIT ? OFFSET ?`, [
      ...params,
      listQuery.limit,
      listQuery.offset,
    ]);
    sendList(res, rows, buildPagination(Number(countRow?.total ?? 0), listQuery.page, listQuery.limit));
  }),
);

settlementRouter.get(
  '/summary',
  requirePermission('reports.view'),
  asyncHandler(async (req, res) => {
    const scope = companyScope(req, 's.company_id');
    const where = scope ? ` WHERE ${scope.sql}` : '';
    const summary = await queryOne(
      `SELECT COALESCE(SUM(s.net_amount), 0) AS total,
        COALESCE(SUM(CASE WHEN s.status = 'PENDING' THEN s.net_amount ELSE 0 END), 0) AS pending,
        COALESCE(SUM(CASE WHEN s.status = 'PAID' THEN s.net_amount ELSE 0 END), 0) AS paid,
        COALESCE(SUM(CASE WHEN s.status = 'CANCELLED' THEN s.net_amount ELSE 0 END), 0) AS cancelled,
        COUNT(*) AS total_settlements
       FROM settlements s${where}`,
      scope?.params ?? [],
    );
    sendSuccess(res, summary);
  }),
);

settlementRouter.get(
  '/:id',
  requirePermission('reports.view'),
  asyncHandler(async (req, res) => {
    const settlementId = parseId(req.params.id);
    const conditions = ['s.id = ?'];
    const params: unknown[] = [settlementId];
    const scope = companyScope(req, 's.company_id');
    if (scope) {
      conditions.push(scope.sql);
      params.push(...scope.params);
    }

    const settlement = await queryOne(`${SETTLEMENT_SELECT} WHERE ${conditions.join(' AND ')} LIMIT 1`, params);
    if (!settlement) throw ApiError.notFound('Liquidación no encontrada');

    const items = await query(
      `SELECT si.*, bk.booking_code FROM settlement_items si
       LEFT JOIN bookings bk ON bk.id = si.booking_id
       WHERE si.settlement_id = ? ORDER BY si.id ASC`,
      [settlementId],
    );
    sendSuccess(res, { ...settlement, items });
  }),
);

/**
 * Builds a settlement for a company and period from its completed financial transactions:
 * sales credit the company, commissions and refunds are deducted.
 */
settlementRouter.post(
  '/',
  requirePermission('settings.update'),
  validate(createSettlementSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as { company_id: number; period_start: string; period_end: string; status?: string };
    const user = requireAuth(req);
    if (user.role !== 'ADMIN' && !user.companyIds.includes(body.company_id)) {
      throw ApiError.forbidden('No puedes generar liquidaciones de otra empresa');
    }

    const settlementId = await withTransaction(async (connection) => {
      const [transactionRows] = await connection.query(
        `SELECT ft.id, ft.type, ft.amount, ft.booking_id, ft.description
         FROM financial_transactions ft
         WHERE ft.company_id = ? AND ft.status = 'COMPLETED'
           AND DATE(ft.transaction_date) BETWEEN ? AND ?
           AND NOT EXISTS (SELECT 1 FROM settlement_items si WHERE si.financial_transaction_id = ft.id)`,
        [body.company_id, body.period_start, body.period_end],
      );
      const transactions = transactionRows as Array<{ id: number; type: string; amount: number; booking_id: number | null; description: string | null }>;

      let gross = 0;
      let commission = 0;
      let refund = 0;
      for (const transaction of transactions) {
        if (transaction.type === 'PAYMENT') gross += Number(transaction.amount);
        else if (transaction.type === 'COMMISSION') commission += Number(transaction.amount);
        else if (transaction.type === 'REFUND') refund += Number(transaction.amount);
      }
      const net = Number((gross - commission - refund).toFixed(2));

      const code = `L-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;
      const [result] = await connection.query(
        `INSERT INTO settlements (company_id, settlement_code, period_start, period_end, gross_amount,
          commission_amount, refund_amount, adjustment_amount, net_amount, currency, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'PEN', ?)`,
        [body.company_id, code, body.period_start, body.period_end, gross.toFixed(2), commission.toFixed(2), refund.toFixed(2), net, body.status ?? 'PENDING'],
      );
      const newSettlementId = (result as { insertId: number }).insertId;

      for (const transaction of transactions) {
        const itemType = transaction.type === 'PAYMENT' ? 'SALE' : transaction.type === 'COMMISSION' ? 'COMMISSION' : transaction.type === 'REFUND' ? 'REFUND' : 'ADJUSTMENT';
        await connection.query(
          `INSERT INTO settlement_items (settlement_id, booking_id, financial_transaction_id, type, amount, description)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [newSettlementId, transaction.booking_id, transaction.id, itemType, transaction.amount, transaction.description],
        );
      }

      return newSettlementId;
    });

    await recordAudit(req, { action: 'CREATE', entityType: 'settlements', entityId: settlementId, description: 'Generó una liquidación', newValues: body });
    sendSuccess(res, await queryOne(`${SETTLEMENT_SELECT} WHERE s.id = ?`, [settlementId]), 201);
  }),
);

settlementRouter.put(
  '/:id',
  requirePermission('settings.update'),
  validate(updateSettlementSchema),
  asyncHandler(async (req, res) => {
    const settlementId = parseId(req.params.id);
    const user = requireAuth(req);
    const body = req.body as Record<string, unknown>;
    const columns = ['status', 'payment_reference'].filter((column) => body[column] !== undefined);
    if (columns.length === 0) throw ApiError.badRequest('No se enviaron cambios');

    await withTransaction(async (connection) => {
      /**
       * La liquidación se bloquea ANTES de decidir nada. De ahí salen las dos garantías:
       *
       *  · Alcance (BP-23): `POST /settlements` sí comprobaba la empresa y este endpoint no.
       *    Hoy solo el ADMIN tiene `settings.update`, así que no era explotable, pero el día
       *    que un rol de empresa lo obtenga no debe poder tocar la liquidación de otra.
       *  · Idempotencia (BP-10): el PAYOUT se insertaba en cada petición con `status: PAID`,
       *    de modo que un doble clic o un reintento duplicaba el pago a la empresa en
       *    `financial_transactions`. Ahora solo se emite en la TRANSICIÓN a PAID.
       */
      const [rows] = await connection.query(
        'SELECT id, company_id, status, net_amount, settlement_code FROM settlements WHERE id = ? LIMIT 1 FOR UPDATE',
        [settlementId],
      );
      const settlement = (rows as Array<{
        id: number;
        company_id: number;
        status: string;
        net_amount: number;
        settlement_code: string;
      }>)[0];
      // 404 y no 403: no se confirma que exista la liquidación de otra empresa.
      if (!settlement) throw ApiError.notFound('Liquidación no encontrada');
      if (user.role !== 'ADMIN' && !user.companyIds.includes(settlement.company_id)) {
        throw ApiError.notFound('Liquidación no encontrada');
      }

      const marcaComoPagada = body.status === 'PAID' && settlement.status !== 'PAID';

      const assignments = columns.map((column) => `${column} = ?`);
      // `paid_at` solo se sella en la transición: reintentar no reescribe la fecha del pago.
      if (marcaComoPagada) assignments.push('paid_at = NOW()');

      await connection.query(`UPDATE settlements SET ${assignments.join(', ')} WHERE id = ?`, [
        ...columns.map((column) => body[column]),
        settlementId,
      ]);

      if (marcaComoPagada) {
        await connection.query(
          `INSERT INTO financial_transactions (company_id, type, direction, amount, currency, description, reference_code, status, transaction_date)
           VALUES (?, 'PAYOUT', 'DEBIT', ?, 'PEN', ?, ?, 'COMPLETED', NOW())`,
          [settlement.company_id, settlement.net_amount, `Pago de liquidación ${settlement.settlement_code}`, settlement.settlement_code],
        );
      }
    });

    await recordAudit(req, { action: 'UPDATE', entityType: 'settlements', entityId: settlementId, description: 'Actualizó una liquidación', newValues: body });
    sendSuccess(res, await queryOne(`${SETTLEMENT_SELECT} WHERE s.id = ?`, [settlementId]));
  }),
);
