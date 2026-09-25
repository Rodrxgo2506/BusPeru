import { Router, type Request } from 'express';
import { query, queryOne, withTransaction } from '../config/database';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import { ApiError } from '../utils/ApiError';
import { centsToDecimal, toCentsExact } from '../utils/money';
import { asyncHandler, sendList, sendSuccess } from '../utils/http';
import { buildPagination, parseListQuery, safeColumn, parseId, stableOrderBy } from '../utils/query';
import { createSettlementSchema, settlementPeriodErrors, updateSettlementSchema } from '../validators/resource.validators';

/** Importe de un movimiento con su signo contable: CREDIT suma, DEBIT resta (H-47 · H-48). */
const FIRMADO = "(CASE WHEN ft.direction = 'CREDIT' THEN ft.amount ELSE -ft.amount END)";

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
    /**
     * VISTA CONTABLE (H-47). La fuente es `financial_transactions` con su dirección —CREDIT suma,
     * DEBIT resta—, nunca el estado de los pagos. Las métricas de empresa leen solo el LIBRO DE
     * EMPRESAS (`company_id` no nulo): los compensatorios de la plataforma (`company_id` NULL, H-26)
     * no son ventas y se informan aparte, solo al ADMIN. Las claves antiguas se mantienen con su
     * significado corregido: `gross_income` = ventas, `commissions` = comisión neta de reversiones,
     * `refunds` = reembolsos de ventas.
     */
    const scope = companyScope(req, 'ft.company_id');
    const conditions = ["ft.status = 'COMPLETED'", 'ft.company_id IS NOT NULL'];
    if (scope) conditions.push(scope.sql);
    const firmado = FIRMADO;
    const summary = await queryOne<Record<string, unknown>>(
      `SELECT
        COALESCE(SUM(CASE WHEN ft.type = 'PAYMENT' THEN ${firmado} ELSE 0 END), 0) AS sales_gross,
        COALESCE(-SUM(CASE WHEN ft.type = 'REFUND' THEN ${firmado} ELSE 0 END), 0) AS sales_refunded,
        COALESCE(-SUM(CASE WHEN ft.type = 'COMMISSION' THEN ${firmado} ELSE 0 END), 0) AS commission_net,
        COALESCE(SUM(CASE WHEN ft.type = 'ADJUSTMENT' THEN ${firmado} ELSE 0 END), 0) AS adjustments,
        COALESCE(-SUM(CASE WHEN ft.type = 'PAYOUT' THEN ${firmado} ELSE 0 END), 0) AS payouts,
        COALESCE(SUM(${firmado}), 0) AS company_balance,
        COUNT(*) AS total_transactions
       FROM financial_transactions ft WHERE ${conditions.join(' AND ')}`,
      scope?.params ?? [],
    );
    // Libro de la plataforma, solo para el ADMIN. Una fila de plataforma es de una VENTA si su pago
    // tiene PAYMENT de empresa (service fee y cupón de plataforma, H-45); si no, es un compensatorio.
    const esVenta = `EXISTS (SELECT 1 FROM financial_transactions v WHERE v.payment_id = ft.payment_id AND v.type = 'PAYMENT' AND v.company_id IS NOT NULL)`;
    const compensaciones = scope
      ? null
      : await queryOne<Record<string, unknown>>(
          `SELECT
            COALESCE(SUM(CASE WHEN NOT ${esVenta} AND ft.type = 'PAYMENT' THEN ${firmado} ELSE 0 END), 0) AS compensations_collected,
            COALESCE(-SUM(CASE WHEN NOT ${esVenta} AND ft.type = 'REFUND' THEN ${firmado} ELSE 0 END), 0) AS compensations_refunded,
            COALESCE(SUM(CASE WHEN NOT ${esVenta} AND ft.type IN ('PAYMENT', 'REFUND') THEN ${firmado} ELSE 0 END), 0) AS platform_compensation_balance,
            COALESCE(SUM(CASE WHEN ${esVenta} AND ft.type = 'PAYMENT' THEN ${firmado} ELSE 0 END), 0) AS platform_service_fees,
            COALESCE(-SUM(CASE WHEN ${esVenta} AND ft.type = 'REFUND' THEN ${firmado} ELSE 0 END), 0) AS platform_service_fees_refunded,
            COALESCE(-SUM(CASE WHEN ${esVenta} AND ft.type = 'ADJUSTMENT' THEN ${firmado} ELSE 0 END), 0) AS platform_coupon_subsidies,
            COALESCE(SUM(CASE WHEN ${esVenta} THEN ${firmado} ELSE 0 END), 0) AS platform_sales_balance
           FROM financial_transactions ft WHERE ft.status = 'COMPLETED' AND ft.company_id IS NULL AND ft.type IN ('PAYMENT', 'REFUND', 'ADJUSTMENT')`,
        );
    sendSuccess(res, {
      ...summary,
      gross_income: summary?.sales_gross,
      commissions: summary?.commission_net,
      refunds: summary?.sales_refunded,
      ...(compensaciones ?? {}),
    });
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
 * F12-03 · máquina de estados de una liquidación. Toda transición se valida en el servidor,
 * bajo el cerrojo de la fila. PAID y CANCELLED son terminales. Repetir el estado actual no es
 * una transición y se rechaza (un reintento de «pagar» ya no puede ejecutarse otra vez).
 */
export const SETTLEMENT_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  PENDING: ['PROCESSING', 'PAID', 'CANCELLED'],
  PROCESSING: ['PAID', 'FAILED', 'CANCELLED'],
  FAILED: ['PROCESSING', 'CANCELLED'],
  PAID: [],
  CANCELLED: [],
};

/**
 * Builds a settlement for a company and period from its completed financial transactions:
 * sales credit the company, commissions and refunds are deducted.
 *
 * F12-02 · CONCURRENCIA E IDEMPOTENCIA. Antes dos generaciones simultáneas leían los mismos
 * movimientos «sin liquidar» y creaban dos liquidaciones con ellos. Ahora, en UNA transacción:
 *   1. se bloquea la fila de la empresa (`FOR UPDATE`): dos generaciones de la MISMA empresa se
 *      serializan; las de empresas distintas no se esperan entre sí;
 *   2. si ya hay una liquidación no anulada de esa empresa con el MISMO periodo, se devuelve esa
 *      (200) en vez de crear otra: repetir la petición no duplica nada;
 *   3. los movimientos se leen con `FOR UPDATE` —lectura bloqueante, que ve lo último confirmado,
 *      incluidos los ítems que otra generación acaba de insertar— y se insertan sus ítems.
 * Un periodo DISTINTO sigue generando con lo que quede sin liquidar, como antes. La base lo
 * respalda con UNIQUE (`settlement_items.financial_transaction_id`), migración 013.
 *
 * F12-03 · la liquidación nace SIEMPRE en PENDING: el cliente no elige el estado inicial.
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
    if (body.status !== undefined && body.status !== 'PENDING') {
      throw ApiError.badRequest('Una liquidación se crea siempre pendiente; su estado se cambia después');
    }
    // F12-04: fechas reales AAAA-MM-DD y un periodo que no esté invertido.
    const erroresPeriodo = settlementPeriodErrors(body.period_start, body.period_end);
    if (Object.keys(erroresPeriodo).length > 0) {
      throw ApiError.badRequest('El periodo de la liquidación no es válido', erroresPeriodo);
    }

    const { settlementId, created } = await withTransaction(async (connection) => {
      const [empresas] = await connection.query('SELECT id FROM companies WHERE id = ? LIMIT 1 FOR UPDATE', [body.company_id]);
      if ((empresas as unknown[]).length === 0) throw ApiError.notFound('Empresa no encontrada');

      const [existentes] = await connection.query(
        `SELECT id FROM settlements
         WHERE company_id = ? AND period_start = ? AND period_end = ? AND status <> 'CANCELLED'
         ORDER BY id ASC LIMIT 1`,
        [body.company_id, body.period_start, body.period_end],
      );
      const existente = (existentes as Array<{ id: number }>)[0];
      if (existente) return { settlementId: Number(existente.id), created: false };

      /**
       * H-48: la liquidación suma movimientos FIRMADOS por su dirección —CREDIT +, DEBIT −—, en
       * céntimos. Antes sumaba importes por tipo y restaba comisión y reembolsos sin mirar la
       * dirección, así que una reversión de comisión (COMMISSION/CREDIT) o un ajuste a favor se
       * habrían restado. Entran PAYMENT, COMMISSION, REFUND y ADJUSTMENT de la empresa; PAYOUT queda
       * fuera: es el pago de una liquidación, no operación del periodo. Los movimientos de la
       * plataforma (`company_id` NULL) nunca entran porque se filtra por empresa.
       *
       *   gross       = Σ PAYMENT firmado        commission = −Σ COMMISSION firmado (neta)
       *   refund      = −Σ REFUND firmado        adjustment =  Σ ADJUSTMENT firmado
       *   net         =  Σ firmado = gross − commission − refund + adjustment
       */
      const [transactionRows] = await connection.query(
        `SELECT ft.id, ft.type, ft.direction, ft.amount, ft.booking_id, ft.description
         FROM financial_transactions ft
         WHERE ft.company_id = ? AND ft.status = 'COMPLETED'
           AND ft.type IN ('PAYMENT', 'COMMISSION', 'REFUND', 'ADJUSTMENT')
           AND DATE(ft.transaction_date) BETWEEN ? AND ?
           AND NOT EXISTS (SELECT 1 FROM settlement_items si WHERE si.financial_transaction_id = ft.id)
         ORDER BY ft.id ASC
         FOR UPDATE`,
        [body.company_id, body.period_start, body.period_end],
      );
      const transactions = (transactionRows as Array<{ id: number; type: string; direction: string; amount: string; booking_id: number | null; description: string | null }>).map(
        (transaction) => ({ ...transaction, signedCents: (transaction.direction === 'CREDIT' ? 1 : -1) * toCentsExact(String(transaction.amount)) }),
      );

      const sumaFirmada = (type: string) => transactions.filter((t) => t.type === type).reduce((total, t) => total + t.signedCents, 0);
      const grossCents = sumaFirmada('PAYMENT');
      const commissionCents = -sumaFirmada('COMMISSION');
      const refundCents = -sumaFirmada('REFUND');
      const adjustmentCents = sumaFirmada('ADJUSTMENT');
      const netCents = transactions.reduce((total, t) => total + t.signedCents, 0);

      const code = `L-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;
      const [result] = await connection.query(
        `INSERT INTO settlements (company_id, settlement_code, period_start, period_end, gross_amount,
          commission_amount, refund_amount, adjustment_amount, net_amount, currency, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PEN', ?)`,
        [
          body.company_id, code, body.period_start, body.period_end,
          centsToDecimal(grossCents), centsToDecimal(commissionCents), centsToDecimal(refundCents), centsToDecimal(adjustmentCents),
          centsToDecimal(netCents), 'PENDING',
        ],
      );
      const newSettlementId = (result as { insertId: number }).insertId;

      for (const transaction of transactions) {
        const itemType = transaction.type === 'PAYMENT' ? 'SALE' : transaction.type === 'COMMISSION' ? 'COMMISSION' : transaction.type === 'REFUND' ? 'REFUND' : 'ADJUSTMENT';
        await connection.query(
          `INSERT INTO settlement_items (settlement_id, booking_id, financial_transaction_id, type, amount, description)
           VALUES (?, ?, ?, ?, ?, ?)`,
          // Importe firmado: el detalle suma exactamente el neto y una reversión se distingue de un cargo.
          [newSettlementId, transaction.booking_id, transaction.id, itemType, centsToDecimal(transaction.signedCents), transaction.description],
        );
      }

      return { settlementId: newSettlementId, created: true };
    });

    if (created) {
      await recordAudit(req, { action: 'CREATE', entityType: 'settlements', entityId: settlementId, description: 'Generó una liquidación', newValues: body });
    }
    sendSuccess(res, await queryOne(`${SETTLEMENT_SELECT} WHERE s.id = ?`, [settlementId]), created ? 201 : 200);
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
    let liberados: number[] = [];

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

      // F12-03: toda transición de estado pasa por la máquina de estados. Solo cambiar la
      // referencia de pago (sin `status`) no es una transición.
      if (body.status !== undefined) {
        const siguiente = String(body.status);
        if (!(SETTLEMENT_TRANSITIONS[settlement.status] ?? []).includes(siguiente)) {
          throw ApiError.conflict(
            settlement.status === siguiente
              ? `La liquidación ya está en estado ${settlement.status}`
              : `Una liquidación en estado ${settlement.status} no puede pasar a ${siguiente}`,
          );
        }
      }
      const marcaComoPagada = body.status === 'PAID';

      if (marcaComoPagada) {
        // Defensa adicional: nunca dos PAYOUT para la misma liquidación.
        const [pagos] = await connection.query(
          "SELECT id FROM financial_transactions WHERE type = 'PAYOUT' AND company_id = ? AND reference_code = ? LIMIT 1 FOR UPDATE",
          [settlement.company_id, settlement.settlement_code],
        );
        if ((pagos as unknown[]).length > 0) throw ApiError.conflict('Esta liquidación ya tiene su pago registrado');
      }

      const assignments = columns.map((column) => `${column} = ?`);
      // `paid_at` se sella en la única transición a PAID.
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

      /**
       * F12-03 · ANULAR libera los movimientos. Los ítems se conservan como traza (tipo, importe,
       * reserva y descripción) pero dejan de apuntar a su movimiento, que vuelve a ser liquidable:
       * la selección de movimientos solo excluye los que tienen un ítem vinculado. Sin esto una
       * liquidación anulada los bloqueaba para siempre. Los identificadores liberados quedan en la
       * auditoría. FAILED no libera: sigue siendo el mismo pago pendiente de reintento.
       */
      if (body.status === 'CANCELLED') {
        const [vinculados] = await connection.query(
          'SELECT financial_transaction_id FROM settlement_items WHERE settlement_id = ? AND financial_transaction_id IS NOT NULL FOR UPDATE',
          [settlementId],
        );
        liberados = (vinculados as Array<{ financial_transaction_id: number }>).map((fila) => Number(fila.financial_transaction_id));
        await connection.query('UPDATE settlement_items SET financial_transaction_id = NULL WHERE settlement_id = ?', [settlementId]);
      }
    });

    await recordAudit(req, {
      action: 'UPDATE',
      entityType: 'settlements',
      entityId: settlementId,
      description: 'Actualizó una liquidación',
      newValues: liberados.length > 0 ? { ...body, released_financial_transaction_ids: liberados } : body,
    });
    sendSuccess(res, await queryOne(`${SETTLEMENT_SELECT} WHERE s.id = ?`, [settlementId]));
  }),
);
