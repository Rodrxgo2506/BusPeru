import { Router } from 'express';
import { execute, query, queryOne } from '../config/database';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import { ApiError } from '../utils/ApiError';
import { parseId } from '../utils/query';
import { asyncHandler, sendSuccess } from '../utils/http';
import { generateApiKey } from '../utils/security';
import { createApiKeySchema } from '../validators/resource.validators';

export const apiKeyRouter = Router();
apiKeyRouter.use(authenticate);

/** key_hash is never selected: only the prefix is ever shown after creation. */
const API_KEY_SELECT = `SELECT ak.id, ak.company_id, ak.user_id, ak.name, ak.key_prefix, ak.environment,
    ak.permissions, ak.last_used_at, ak.expires_at, ak.status, ak.created_at, ak.updated_at,
    co.name AS company_name
  FROM api_keys ak LEFT JOIN companies co ON co.id = ak.company_id`;

apiKeyRouter.get(
  '/',
  requirePermission('settings.view'),
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (user.role !== 'ADMIN') {
      if (user.companyIds.length === 0) {
        conditions.push('1 = 0');
      } else {
        conditions.push(`ak.company_id IN (${user.companyIds.map(() => '?').join(', ')})`);
        params.push(...user.companyIds);
      }
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    sendSuccess(res, await query(`${API_KEY_SELECT}${where} ORDER BY ak.created_at DESC`, params));
  }),
);

apiKeyRouter.post(
  '/',
  requirePermission('settings.update'),
  validate(createApiKeySchema),
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    const body = req.body as Record<string, unknown>;

    let companyId = body.company_id === undefined || body.company_id === null ? null : Number(body.company_id);
    if (user.role !== 'ADMIN') {
      const [ownCompany] = user.companyIds;
      if (ownCompany === undefined) throw ApiError.forbidden('Tu usuario no está asociado a ninguna empresa');
      if (companyId !== null && !user.companyIds.includes(companyId)) throw ApiError.forbidden('No puedes crear llaves para otra empresa');
      companyId = companyId ?? ownCompany;
    }

    const { plain, prefix, hash } = generateApiKey();
    const result = await execute(
      `INSERT INTO api_keys (company_id, user_id, name, key_prefix, key_hash, environment, permissions, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      [companyId, user.id, body.name, prefix, hash, body.environment ?? 'TEST', body.permissions ?? null, body.expires_at ?? null],
    );

    await recordAudit(req, {
      action: 'CREATE',
      entityType: 'api_keys',
      entityId: result.insertId,
      description: `Creó la API key ${String(body.name)}`,
    });

    const created = await queryOne(`${API_KEY_SELECT} WHERE ak.id = ?`, [result.insertId]);
    // The plain key is returned exactly once; only its hash is stored.
    sendSuccess(res, { ...(created as Record<string, unknown>), plain_key: plain }, 201);
  }),
);

apiKeyRouter.post(
  '/:id/revoke',
  requirePermission('settings.update'),
  asyncHandler(async (req, res) => {
    const keyId = parseId(req.params.id);
    const user = requireAuth(req);

    const key = await queryOne<{ id: number; company_id: number | null }>('SELECT id, company_id FROM api_keys WHERE id = ?', [keyId]);
    if (!key) throw ApiError.notFound('API key no encontrada');
    if (user.role !== 'ADMIN' && (key.company_id === null || !user.companyIds.includes(key.company_id))) {
      throw ApiError.forbidden('No puedes revocar llaves de otra empresa');
    }

    await execute("UPDATE api_keys SET status = 'REVOKED' WHERE id = ?", [keyId]);
    await recordAudit(req, { action: 'UPDATE', entityType: 'api_keys', entityId: keyId, description: 'Revocó una API key' });
    sendSuccess(res, await queryOne(`${API_KEY_SELECT} WHERE ak.id = ?`, [keyId]));
  }),
);
