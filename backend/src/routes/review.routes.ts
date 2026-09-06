import { Router, type Request } from 'express';
import { execute, query, queryOne } from '../config/database';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendList, sendSuccess } from '../utils/http';
import { buildPagination, parseListQuery, safeColumn, stableOrderBy, parseId } from '../utils/query';
import { createReviewSchema, reviewResponseSchema, updateReviewSchema } from '../validators/resource.validators';

const router = Router();
router.use(authenticate);

const REVIEW_SELECT = `SELECT rv.*, co.name AS company_name, u.first_name, u.last_name, u.avatar_url,
    bk.booking_code, ol.city AS origin_city, dl.city AS destination_city, t.departure_datetime,
    (SELECT COUNT(*) FROM review_responses rr WHERE rr.review_id = rv.id) AS responses_count
  FROM reviews rv
  JOIN companies co ON co.id = rv.company_id
  JOIN users u ON u.id = rv.user_id
  JOIN bookings bk ON bk.id = rv.booking_id
  JOIN trips t ON t.id = rv.trip_id
  JOIN routes r ON r.id = t.route_id
  JOIN locations ol ON ol.id = r.origin_location_id
  JOIN locations dl ON dl.id = r.destination_location_id`;

function visibilityScope(req: Request): { sql: string; params: unknown[] } | null {
  const user = requireAuth(req);
  if (user.role === 'ADMIN') return null;
  if (user.role === 'CUSTOMER') return { sql: 'rv.user_id = ?', params: [user.id] };
  if (user.companyIds.length === 0) return { sql: '1 = 0', params: [] };
  return { sql: `rv.company_id IN (${user.companyIds.map(() => '?').join(', ')})`, params: [...user.companyIds] };
}

router.get(
  '/',
  requirePermission('reviews.view'),
  asyncHandler(async (req, res) => {
    const listQuery = parseListQuery(req.query as Record<string, unknown>);
    const conditions: string[] = [];
    const params: unknown[] = [];

    const scope = visibilityScope(req);
    if (scope) {
      conditions.push(scope.sql);
      params.push(...scope.params);
    }
    for (const [key, column] of Object.entries({ status: 'rv.status', rating: 'rv.rating', company_id: 'rv.company_id', trip_id: 'rv.trip_id' })) {
      const value = listQuery.filters[key];
      if (value !== undefined) {
        conditions.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (listQuery.search) {
      conditions.push('(rv.title LIKE ? OR rv.comment LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?)');
      params.push(...Array(4).fill(`%${listQuery.search}%`));
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const countRow = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM (${REVIEW_SELECT}${where}) AS scoped`, params);
    const sortColumn = safeColumn(listQuery.sort, ['rv.created_at', 'rv.rating'], 'rv.created_at');

    const rows = await query(`${REVIEW_SELECT}${where} ORDER BY ${stableOrderBy(sortColumn, listQuery.order, 'rv')} LIMIT ? OFFSET ?`, [
      ...params,
      listQuery.limit,
      listQuery.offset,
    ]);
    sendList(res, rows, buildPagination(Number(countRow?.total ?? 0), listQuery.page, listQuery.limit));
  }),
);

router.get(
  '/:id',
  requirePermission('reviews.view'),
  asyncHandler(async (req, res) => {
    const reviewId = parseId(req.params.id);
    const conditions = ['rv.id = ?'];
    const params: unknown[] = [reviewId];
    const scope = visibilityScope(req);
    if (scope) {
      conditions.push(scope.sql);
      params.push(...scope.params);
    }

    const review = await queryOne(`${REVIEW_SELECT} WHERE ${conditions.join(' AND ')} LIMIT 1`, params);
    if (!review) throw ApiError.notFound('Reseña no encontrada');

    const responses = await query(
      `SELECT rr.*, u.first_name, u.last_name FROM review_responses rr
       JOIN users u ON u.id = rr.user_id WHERE rr.review_id = ? ORDER BY rr.created_at ASC`,
      [reviewId],
    );
    sendSuccess(res, { ...review, responses });
  }),
);

router.post(
  '/',
  requirePermission('reviews.create'),
  validate(createReviewSchema),
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    const body = req.body as Record<string, unknown>;

    /**
     * `trip_id` y `company_id` se derivan de la reserva, nunca del cuerpo de la petición:
     * si se confiaran, un cliente podría reseñar su propio viaje pero atribuir la reseña a
     * otra empresa, ensuciando su calificación y su cola de moderación.
     */
    const booking = await queryOne<{ id: number; status: string; user_id: number; trip_id: number; company_id: number }>(
      `SELECT bk.id, bk.status, bk.user_id, bk.trip_id, r.company_id
       FROM bookings bk
       JOIN trips t ON t.id = bk.trip_id
       JOIN routes r ON r.id = t.route_id
       WHERE bk.id = ? LIMIT 1`,
      [body.booking_id],
    );
    if (!booking) throw ApiError.notFound('La reserva no existe');
    if (booking.user_id !== user.id && user.role !== 'ADMIN') throw ApiError.forbidden('Solo puedes reseñar tus propios viajes');
    if (!['CONFIRMED', 'COMPLETED'].includes(booking.status)) throw ApiError.badRequest('Solo puedes reseñar viajes realizados');

    const result = await execute(
      `INSERT INTO reviews (user_id, booking_id, trip_id, company_id, rating, title, comment, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [user.id, booking.id, booking.trip_id, booking.company_id, body.rating, body.title ?? null, body.comment ?? null],
    );
    sendSuccess(res, await queryOne(`${REVIEW_SELECT} WHERE rv.id = ?`, [result.insertId]), 201);
  }),
);

router.put(
  '/:id',
  requirePermission('reviews.update'),
  validate(updateReviewSchema),
  asyncHandler(async (req, res) => {
    const reviewId = parseId(req.params.id);
    const user = requireAuth(req);
    const body = req.body as Record<string, unknown>;

    /**
     * `reviews.update` lo tienen ADMIN y CUSTOMER, así que el permiso por sí solo no basta:
     * sin esta comprobación un cliente podía editar y publicar la reseña de cualquier otro.
     */
    const existing = await queryOne<{ id: number; user_id: number; company_id: number }>(
      'SELECT id, user_id, company_id FROM reviews WHERE id = ? LIMIT 1',
      [reviewId],
    );
    if (!existing) throw ApiError.notFound('Reseña no encontrada');

    if (user.role === 'CUSTOMER') {
      if (existing.user_id !== user.id) throw ApiError.forbidden('Solo puedes editar tus propias reseñas');
      // La moderación no es del autor: publicar u ocultar corresponde a la plataforma.
      if (body.status !== undefined) throw ApiError.forbidden('No puedes cambiar el estado de moderación de una reseña');
    } else if (user.role !== 'ADMIN') {
      if (!user.companyIds.includes(existing.company_id)) {
        throw ApiError.forbidden('Solo puedes moderar reseñas de tu empresa');
      }

      /**
       * Moderar es decidir si la reseña se publica, no reescribirla. Sin esta comprobación
       * una empresa convertía una reseña de 1 estrella en una de 5 firmada con el nombre
       * del cliente, y la calificación pública dejaba de significar nada.
       *
       * Se compara con el valor guardado en lugar de rechazar la presencia de la clave,
       * por el mismo motivo que en la ficha de empresa: un formulario que reenvíe la fila
       * completa no debe romperse. Para responder a una reseña, la empresa ya tiene
       * `POST /reviews/:id/responses`.
       */
      const opinion = await queryOne<{ rating: number; title: string | null; comment: string | null }>(
        'SELECT rating, title, comment FROM reviews WHERE id = ? LIMIT 1',
        [reviewId],
      );
      const normalize = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

      for (const column of ['rating', 'title', 'comment'] as const) {
        if (body[column] === undefined) continue;
        if (normalize(body[column]) === normalize(opinion?.[column])) continue;
        throw ApiError.forbidden('Solo puedes cambiar el estado de moderación: el contenido de la reseña es del pasajero');
      }
    }

    const columns = ['rating', 'title', 'comment', 'status'].filter((column) => body[column] !== undefined);
    if (columns.length === 0) throw ApiError.badRequest('No se enviaron cambios');

    await execute(`UPDATE reviews SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`, [
      ...columns.map((column) => body[column]),
      reviewId,
    ]);
    await recordAudit(req, { action: 'UPDATE', entityType: 'reviews', entityId: reviewId, description: 'Actualizó una reseña', newValues: body });
    sendSuccess(res, await queryOne(`${REVIEW_SELECT} WHERE rv.id = ?`, [reviewId]));
  }),
);

router.post(
  '/:id/responses',
  requirePermission('reviews.update'),
  validate(reviewResponseSchema.omit({ review_id: true })),
  asyncHandler(async (req, res) => {
    const reviewId = parseId(req.params.id);
    const user = requireAuth(req);

    const review = await queryOne<{ company_id: number }>('SELECT company_id FROM reviews WHERE id = ?', [reviewId]);
    if (!review) throw ApiError.notFound('Reseña no encontrada');
    if (user.role !== 'ADMIN' && !user.companyIds.includes(review.company_id)) {
      throw ApiError.forbidden('Solo puedes responder reseñas de tu empresa');
    }

    const result = await execute('INSERT INTO review_responses (review_id, user_id, response) VALUES (?, ?, ?)', [
      reviewId,
      user.id,
      req.body.response,
    ]);
    sendSuccess(res, await queryOne('SELECT * FROM review_responses WHERE id = ?', [result.insertId]), 201);
  }),
);

router.delete(
  '/:id',
  requirePermission('reviews.delete'),
  asyncHandler(async (req, res) => {
    const reviewId = parseId(req.params.id);
    const user = requireAuth(req);

    // Mismo aislamiento que en la moderación, por si el permiso se concede a más roles.
    const existing = await queryOne<{ id: number; company_id: number }>('SELECT id, company_id FROM reviews WHERE id = ? LIMIT 1', [reviewId]);
    if (!existing) throw ApiError.notFound('Reseña no encontrada');
    if (user.role !== 'ADMIN' && !user.companyIds.includes(existing.company_id)) {
      throw ApiError.forbidden('Solo puedes eliminar reseñas de tu empresa');
    }

    await execute('DELETE FROM reviews WHERE id = ?', [reviewId]);
    await recordAudit(req, { action: 'DELETE', entityType: 'reviews', entityId: reviewId, description: 'Eliminó una reseña' });
    sendSuccess(res, { id: reviewId });
  }),
);

export default router;
