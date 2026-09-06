import { Router } from 'express';
import { query, queryOne } from '../config/database';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { asyncHandler, sendList, sendSuccess } from '../utils/http';
import { buildPagination, parseListQuery } from '../utils/query';

export const auditRouter = Router();
auditRouter.use(authenticate);

const AUDIT_SELECT = `SELECT al.*, u.first_name, u.last_name, u.email AS user_email, r.name AS role_name
  FROM audit_logs al
  LEFT JOIN users u ON u.id = al.user_id
  LEFT JOIN roles r ON r.id = u.role_id`;

auditRouter.get(
  '/',
  requirePermission('audit_logs.view'),
  asyncHandler(async (req, res) => {
    const listQuery = parseListQuery(req.query as Record<string, unknown>);
    const conditions: string[] = [];
    const params: unknown[] = [];

    for (const [key, column] of Object.entries({ action: 'al.action', entity_type: 'al.entity_type', user_id: 'al.user_id' })) {
      const value = listQuery.filters[key];
      if (value !== undefined) {
        conditions.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (listQuery.filters.from) {
      conditions.push('al.created_at >= ?');
      params.push(listQuery.filters.from);
    }
    if (listQuery.filters.to) {
      conditions.push('al.created_at <= ?');
      params.push(listQuery.filters.to);
    }
    if (listQuery.search) {
      conditions.push('(al.description LIKE ? OR al.action LIKE ? OR u.email LIKE ? OR al.ip_address LIKE ?)');
      params.push(...Array(4).fill(`%${listQuery.search}%`));
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const countRow = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM (${AUDIT_SELECT}${where}) AS scoped`, params);
    const rows = await query(`${AUDIT_SELECT}${where} ORDER BY al.created_at DESC, al.id DESC LIMIT ? OFFSET ?`, [
      ...params,
      listQuery.limit,
      listQuery.offset,
    ]);

    sendList(res, rows, buildPagination(Number(countRow?.total ?? 0), listQuery.page, listQuery.limit));
  }),
);

auditRouter.get(
  '/actions',
  requirePermission('audit_logs.view'),
  asyncHandler(async (_req, res) => {
    const [actions, entities] = await Promise.all([
      query<{ action: string }>('SELECT DISTINCT action FROM audit_logs ORDER BY action'),
      query<{ entity_type: string }>('SELECT DISTINCT entity_type FROM audit_logs WHERE entity_type IS NOT NULL ORDER BY entity_type'),
    ]);
    sendSuccess(res, { actions: actions.map((row) => row.action), entities: entities.map((row) => row.entity_type) });
  }),
);
