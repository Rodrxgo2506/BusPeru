import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne } from '../config/database';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendList, sendSuccess } from '../utils/http';
import { buildPagination, parseListQuery, parseId } from '../utils/query';
import { id, optionalId, shortText } from '../validators/common';

/**
 * The schema has no `notifications.*` permission module, so personal notifications are
 * available to any authenticated user (own rows only) and broadcasting requires
 * `settings.update`, the closest administrative permission that exists.
 */
const router = Router();
router.use(authenticate);

const sendNotificationSchema = z.object({
  user_ids: z.array(id).min(1, 'Selecciona al menos un destinatario').max(5000),
  template_id: optionalId,
  type: z.enum(['EMAIL', 'PUSH', 'SMS', 'IN_APP']).optional(),
  title: shortText(255),
  message: shortText(10000),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    const listQuery = parseListQuery(req.query as Record<string, unknown>);

    const conditions = ['n.user_id = ?'];
    const params: unknown[] = [user.id];

    if (listQuery.filters.is_read !== undefined) {
      conditions.push('n.is_read = ?');
      params.push(listQuery.filters.is_read === 'true' || listQuery.filters.is_read === '1' ? 1 : 0);
    }
    if (listQuery.filters.type !== undefined) {
      conditions.push('n.type = ?');
      params.push(listQuery.filters.type);
    }

    const where = ` WHERE ${conditions.join(' AND ')}`;
    const countRow = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM notifications n${where}`, params);
    const rows = await query(`SELECT n.* FROM notifications n${where} ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`, [
      ...params,
      listQuery.limit,
      listQuery.offset,
    ]);

    sendList(res, rows, buildPagination(Number(countRow?.total ?? 0), listQuery.page, listQuery.limit));
  }),
);

router.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    const row = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND is_read = 0', [user.id]);
    sendSuccess(res, { unread: Number(row?.total ?? 0) });
  }),
);

router.put(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    const notificationId = parseId(req.params.id);

    const notification = await queryOne<{ id: number }>('SELECT id FROM notifications WHERE id = ? AND user_id = ?', [
      notificationId,
      user.id,
    ]);
    if (!notification) throw ApiError.notFound('Notificación no encontrada');

    await execute("UPDATE notifications SET is_read = 1, read_at = NOW(), status = 'READ' WHERE id = ?", [notificationId]);
    sendSuccess(res, await queryOne('SELECT * FROM notifications WHERE id = ?', [notificationId]));
  }),
);

router.put(
  '/read-all',
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    const result = await execute(
      "UPDATE notifications SET is_read = 1, read_at = NOW(), status = 'READ' WHERE user_id = ? AND is_read = 0",
      [user.id],
    );
    sendSuccess(res, { updated: result.affectedRows });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    const notificationId = parseId(req.params.id);
    const result = await execute('DELETE FROM notifications WHERE id = ? AND user_id = ?', [notificationId, user.id]);
    if (result.affectedRows === 0) throw ApiError.notFound('Notificación no encontrada');
    sendSuccess(res, { id: notificationId });
  }),
);

router.post(
  '/send',
  requirePermission('settings.update'),
  validate(sendNotificationSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof sendNotificationSchema>;
    const values = body.user_ids.map(() => '(?, ?, ?, ?, ?, ?, NOW())').join(', ');
    const params = body.user_ids.flatMap((userId) => [
      userId,
      body.template_id ?? null,
      body.type ?? 'IN_APP',
      body.title,
      body.message,
      'SENT',
    ]);

    await execute(
      `INSERT INTO notifications (user_id, template_id, type, title, message, status, sent_at) VALUES ${values}`,
      params,
    );
    sendSuccess(res, { sent: body.user_ids.length }, 201);
  }),
);

export default router;
