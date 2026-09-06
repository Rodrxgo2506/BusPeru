import { Router, type Request } from 'express';
import { execute, query, queryOne, withTransaction } from '../config/database';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendList, sendSuccess } from '../utils/http';
import { buildPagination, parseListQuery, safeColumn, stableOrderBy, parseId } from '../utils/query';
import { createTicketMessageSchema, createTicketSchema, updateTicketSchema } from '../validators/resource.validators';

/**
 * The schema has no `support.*` permission module. Access is therefore scoped by identity:
 * a CUSTOMER sees its own tickets, company roles see tickets of their companies (or assigned
 * to them), and ADMIN sees all of them.
 */
const router = Router();
router.use(authenticate);

const TICKET_SELECT = `SELECT st.*, u.first_name, u.last_name, u.email AS user_email, u.avatar_url,
    co.name AS company_name, bk.booking_code,
    assignee.first_name AS assignee_first_name, assignee.last_name AS assignee_last_name,
    (SELECT COUNT(*) FROM support_messages sm WHERE sm.ticket_id = st.id) AS messages_count,
    (SELECT sm.created_at FROM support_messages sm WHERE sm.ticket_id = st.id ORDER BY sm.created_at DESC LIMIT 1) AS last_message_at
  FROM support_tickets st
  JOIN users u ON u.id = st.user_id
  LEFT JOIN companies co ON co.id = st.company_id
  LEFT JOIN bookings bk ON bk.id = st.booking_id
  LEFT JOIN users assignee ON assignee.id = st.assigned_to`;

function visibilityScope(req: Request): { sql: string; params: unknown[] } | null {
  const user = requireAuth(req);
  if (user.role === 'ADMIN') return null;
  if (user.role === 'CUSTOMER') return { sql: 'st.user_id = ?', params: [user.id] };
  if (user.companyIds.length === 0) return { sql: '(st.user_id = ? OR st.assigned_to = ?)', params: [user.id, user.id] };

  const placeholders = user.companyIds.map(() => '?').join(', ');
  return {
    sql: `(st.company_id IN (${placeholders}) OR st.user_id = ? OR st.assigned_to = ?)`,
    params: [...user.companyIds, user.id, user.id],
  };
}

async function findTicketOrFail(req: Request, ticketId: number): Promise<Record<string, unknown>> {
  const conditions = ['st.id = ?'];
  const params: unknown[] = [ticketId];
  const scope = visibilityScope(req);
  if (scope) {
    conditions.push(scope.sql);
    params.push(...scope.params);
  }
  const ticket = await queryOne<Record<string, unknown>>(`${TICKET_SELECT} WHERE ${conditions.join(' AND ')} LIMIT 1`, params);
  if (!ticket) throw ApiError.notFound('Ticket no encontrado');
  return ticket;
}

router.get(
  '/tickets',
  asyncHandler(async (req, res) => {
    const listQuery = parseListQuery(req.query as Record<string, unknown>);
    const conditions: string[] = [];
    const params: unknown[] = [];

    const scope = visibilityScope(req);
    if (scope) {
      conditions.push(scope.sql);
      params.push(...scope.params);
    }
    for (const [key, column] of Object.entries({ status: 'st.status', priority: 'st.priority', category: 'st.category', company_id: 'st.company_id' })) {
      const value = listQuery.filters[key];
      if (value !== undefined) {
        conditions.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (listQuery.search) {
      conditions.push('(st.ticket_code LIKE ? OR st.subject LIKE ? OR u.email LIKE ?)');
      params.push(...Array(3).fill(`%${listQuery.search}%`));
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const countRow = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM (${TICKET_SELECT}${where}) AS scoped`, params);
    const sortColumn = safeColumn(listQuery.sort, ['st.created_at', 'st.updated_at', 'st.priority', 'st.status'], 'st.updated_at');

    const rows = await query(`${TICKET_SELECT}${where} ORDER BY ${stableOrderBy(sortColumn, listQuery.order, 'st')} LIMIT ? OFFSET ?`, [
      ...params,
      listQuery.limit,
      listQuery.offset,
    ]);
    sendList(res, rows, buildPagination(Number(countRow?.total ?? 0), listQuery.page, listQuery.limit));
  }),
);

router.get(
  '/tickets/summary',
  asyncHandler(async (req, res) => {
    const scope = visibilityScope(req);
    const where = scope ? ` WHERE ${scope.sql}` : '';
    const summary = await queryOne(
      `SELECT COUNT(*) AS total,
        SUM(st.status = 'OPEN') AS open,
        SUM(st.status = 'IN_PROGRESS') AS in_progress,
        SUM(st.status = 'WAITING_USER') AS waiting_user,
        SUM(st.status = 'RESOLVED') AS resolved,
        SUM(st.status = 'CLOSED') AS closed
       FROM support_tickets st${where}`,
      scope?.params ?? [],
    );
    sendSuccess(res, summary);
  }),
);

router.get(
  '/tickets/:id',
  asyncHandler(async (req, res) => {
    const ticket = await findTicketOrFail(req, parseId(req.params.id));
    const user = requireAuth(req);

    // Internal notes are hidden from the customer who opened the ticket.
    const internalFilter = user.role === 'CUSTOMER' ? ' AND sm.is_internal = 0' : '';
    const messages = await query(
      `SELECT sm.*, u.first_name, u.last_name, u.avatar_url, r.name AS role_name
       FROM support_messages sm
       JOIN users u ON u.id = sm.user_id
       JOIN roles r ON r.id = u.role_id
       WHERE sm.ticket_id = ?${internalFilter}
       ORDER BY sm.created_at ASC`,
      [ticket.id],
    );
    sendSuccess(res, { ...ticket, messages });
  }),
);

router.post(
  '/tickets',
  validate(createTicketSchema),
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    const body = req.body as Record<string, unknown>;

    const ticketId = await withTransaction(async (connection) => {
      const ticketCode = `TKT-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const [result] = await connection.query(
        `INSERT INTO support_tickets (ticket_code, user_id, booking_id, company_id, subject, category, priority, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
        [
          ticketCode,
          user.id,
          body.booking_id ?? null,
          body.company_id ?? null,
          body.subject,
          body.category ?? 'OTHER',
          body.priority ?? 'MEDIUM',
        ],
      );
      const newTicketId = (result as { insertId: number }).insertId;

      await connection.query('INSERT INTO support_messages (ticket_id, user_id, message, is_internal) VALUES (?, ?, ?, 0)', [
        newTicketId,
        user.id,
        body.message,
      ]);
      return newTicketId;
    });

    sendSuccess(res, await findTicketOrFail(req, ticketId), 201);
  }),
);

router.post(
  '/tickets/:id/messages',
  validate(createTicketMessageSchema),
  asyncHandler(async (req, res) => {
    const ticketId = parseId(req.params.id);
    const user = requireAuth(req);
    await findTicketOrFail(req, ticketId);

    const isInternal = user.role === 'CUSTOMER' ? 0 : req.body.is_internal ? 1 : 0;
    const result = await execute(
      'INSERT INTO support_messages (ticket_id, user_id, message, attachments, is_internal) VALUES (?, ?, ?, ?, ?)',
      [ticketId, user.id, req.body.message, req.body.attachments ?? null, isInternal],
    );

    // Any reply reopens a waiting ticket so it does not get lost.
    await execute(
      "UPDATE support_tickets SET status = CASE WHEN status IN ('RESOLVED','CLOSED') THEN 'OPEN' ELSE status END WHERE id = ?",
      [ticketId],
    );

    sendSuccess(res, await queryOne('SELECT * FROM support_messages WHERE id = ?', [result.insertId]), 201);
  }),
);

router.put(
  '/tickets/:id',
  validate(updateTicketSchema),
  asyncHandler(async (req, res) => {
    const ticketId = parseId(req.params.id);
    const user = requireAuth(req);
    if (user.role === 'CUSTOMER') throw ApiError.forbidden('No puedes cambiar el estado del ticket');
    await findTicketOrFail(req, ticketId);

    const body = req.body as Record<string, unknown>;
    const columns = ['status', 'priority', 'assigned_to'].filter((column) => body[column] !== undefined);
    if (columns.length === 0) throw ApiError.badRequest('No se enviaron cambios');

    const assignments = columns.map((column) => `${column} = ?`);
    if (body.status === 'RESOLVED') assignments.push('resolved_at = NOW()');
    if (body.status === 'CLOSED') assignments.push('closed_at = NOW()');

    await execute(`UPDATE support_tickets SET ${assignments.join(', ')} WHERE id = ?`, [
      ...columns.map((column) => body[column]),
      ticketId,
    ]);

    await recordAudit(req, { action: 'UPDATE', entityType: 'support_tickets', entityId: ticketId, description: 'Actualizó un ticket', newValues: body });
    sendSuccess(res, await findTicketOrFail(req, ticketId));
  }),
);

export default router;
