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

/**
 * Resuelve la reserva y la empresa de un ticket nuevo. Ninguna de las dos se toma del
 * cuerpo de la petición.
 *
 * `booking_id` y `company_id` se insertaban tal como llegaban, sin comprobar nada: un
 * cliente abría un ticket apuntando a la reserva de otro —y la respuesta le devolvía su
 * `booking_code`, que es el código que se muestra al abordar— y contra una empresa con la
 * que no tenía ninguna relación, cuya bandeja de soporte quedaba a merced de cualquiera.
 *
 * La regla es la que ya usa `POST /reviews`, que resolvió bien este mismo problema: la
 * empresa se deriva de la cadena `booking → trip → route → company_id`, nunca del cliente.
 *
 * Sin reserva se conserva el comportamiento actual —los tickets sueltos siguen siendo
 * válidos—, con la empresa del propio autor si la tiene, y sin empresa si no.
 */
async function resolveTicketOrigin(
  req: Request,
  requestedBookingId: unknown,
): Promise<{ bookingId: number | null; companyId: number | null }> {
  const user = requireAuth(req);
  const [ownCompany] = user.companyIds;

  if (requestedBookingId === undefined || requestedBookingId === null) {
    return { bookingId: null, companyId: ownCompany ?? null };
  }

  const bookingId = Number(requestedBookingId);
  const booking = await queryOne<{ id: number; user_id: number; company_id: number }>(
    `SELECT bk.id, bk.user_id, r.company_id
     FROM bookings bk
     JOIN trips t ON t.id = bk.trip_id
     JOIN routes r ON r.id = t.route_id
     WHERE bk.id = ? LIMIT 1`,
    [bookingId],
  );

  // Mismo alcance que el resto de reservas: el pasajero la suya, la empresa las de sus
  // viajes, el ADMIN todas. Fuera de ahí se responde 404 y no 403, para no confirmar que
  // la reserva existe ni permitir enumerarlas.
  const allowed =
    booking !== null &&
    (user.role === 'ADMIN' || booking.user_id === user.id || user.companyIds.includes(booking.company_id));
  if (!allowed) throw ApiError.notFound('Reserva no encontrada');

  return { bookingId: booking!.id, companyId: booking!.company_id };
}

/**
 * Comprueba que quien se pone en `assigned_to` pueda hacerse cargo del ticket (BP-24).
 *
 * QUÉ PASABA. El campo se escribía tal como llegaba: bastaba con `optionalId`, un entero
 * positivo. No se miraba si esa persona existe, si su cuenta está activa, qué rol tiene ni
 * de qué empresa es. Y eso no era solo un dato feo: `visibilityScope` incluye
 * `st.assigned_to = ?`, así que **asignar es conceder lectura**. Un administrador de la
 * empresa A asignaba su ticket al administrador de la empresa B y este pasaba a ver el
 * ticket entero —nombre de la empresa A, correo del pasajero y su `booking_code`—.
 * Comprobado: `{"company_name":"Empresa A","user_email":"cliente@test.pe",
 * "booking_code":"BP-746654"}` servido a la empresa B.
 *
 * LA REGLA, sin inventar nada. No hay módulo de permisos `support.*` —se comprobó: la tabla
 * no tiene ninguno—, así que el acceso a soporte se rige por identidad. La regla es
 * exactamente esa misma, aplicada al candidato: **solo puede ser responsable de un ticket
 * quien ya podría verlo por sí mismo**.
 *
 *   · ADMIN de plataforma: siempre. Ve todos los tickets, y escalarle uno es legítimo.
 *   · Rol de empresa: solo si pertenece a la empresa DEL TICKET, que se deriva del recurso
 *     y nunca del cuerpo de la petición.
 *   · CUSTOMER: nunca. Su alcance son «los tickets que abrí», no los que atiendo.
 *   · Cuenta no activa: nunca. `authenticate` ya rechaza a quien no está ACTIVE, así que
 *     asignarle un ticket sería dárselo a alguien que no puede ni entrar.
 *   · Ticket sin empresa (de plataforma): solo ADMIN, porque no hay empresa a la que
 *     pertenecer. `cu.company_id = NULL` no casa con nadie y la regla sale sola.
 *
 * UN SOLO MENSAJE para todos los rechazos, a propósito: distinguir «no existe» de «es de
 * otra empresa» convertiría este endpoint en un oráculo para enumerar usuarios ajenos.
 */
async function assertAssignable(ticket: Record<string, unknown>, assignedTo: unknown): Promise<void> {
  // Desasignar sigue valiendo: es como se devuelve un ticket a la bandeja común.
  if (assignedTo === null || assignedTo === undefined) return;

  const companyId = ticket.company_id === null || ticket.company_id === undefined ? null : Number(ticket.company_id);

  const candidate = await queryOne<{ status: string; role: string; in_company: number }>(
    `SELECT u.status, ro.name AS role,
            EXISTS (SELECT 1 FROM company_users cu WHERE cu.user_id = u.id AND cu.company_id = ?) AS in_company
     FROM users u
     JOIN roles ro ON ro.id = u.role_id
     WHERE u.id = ? LIMIT 1`,
    [companyId, Number(assignedTo)],
  );

  const puedeAtender =
    candidate !== null &&
    candidate.status === 'ACTIVE' &&
    (candidate.role === 'ADMIN' || (candidate.role !== 'CUSTOMER' && Number(candidate.in_company) === 1));

  if (!puedeAtender) throw ApiError.badRequest('El usuario indicado no puede atender este ticket');
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

    // La reserva y la empresa las decide el servidor; `company_id` del cuerpo se descarta.
    const origin = await resolveTicketOrigin(req, body.booking_id);

    const ticketId = await withTransaction(async (connection) => {
      const ticketCode = `TKT-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const [result] = await connection.query(
        `INSERT INTO support_tickets (ticket_code, user_id, booking_id, company_id, subject, category, priority, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
        [
          ticketCode,
          user.id,
          origin.bookingId,
          origin.companyId,
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
    // La empresa del ticket sale de aquí, del recurso real: `company_id` no está en la lista
    // de columnas escribibles y enviarlo en el cuerpo no cambia nada.
    const ticket = await findTicketOrFail(req, ticketId);

    const body = req.body as Record<string, unknown>;
    const columns = ['status', 'priority', 'assigned_to'].filter((column) => body[column] !== undefined);
    if (columns.length === 0) throw ApiError.badRequest('No se enviaron cambios');

    // Se valida ANTES de tocar la fila: un rechazo no deja el ticket a medio modificar.
    if (body.assigned_to !== undefined) await assertAssignable(ticket, body.assigned_to);

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
