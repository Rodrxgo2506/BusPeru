import { Router } from 'express';
import { execute, query, queryOne, withTransaction } from '../config/database';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import { ApiError } from '../utils/ApiError';
import { parseId } from '../utils/query';
import { asyncHandler, sendSuccess } from '../utils/http';
import { createRoleSchema, setRolePermissionsSchema, updateRoleSchema } from '../validators/resource.validators';

export const roleRouter = Router();
roleRouter.use(authenticate);

const ROLE_SELECT = `SELECT r.*,
    (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS users_count,
    (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permissions_count
  FROM roles r`;

roleRouter.get(
  '/',
  requirePermission('roles.view'),
  asyncHandler(async (_req, res) => {
    const roles = await query(`${ROLE_SELECT} ORDER BY r.id ASC`);
    sendSuccess(res, roles);
  }),
);

roleRouter.get(
  '/:id',
  requirePermission('roles.view'),
  asyncHandler(async (req, res) => {
    const roleId = parseId(req.params.id);
    const role = await queryOne(`${ROLE_SELECT} WHERE r.id = ? LIMIT 1`, [roleId]);
    if (!role) throw ApiError.notFound('Rol no encontrado');

    const permissions = await query(
      `SELECT p.id, p.name, p.module, p.description FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ? ORDER BY p.module, p.name`,
      [roleId],
    );
    sendSuccess(res, { ...role, permissions });
  }),
);

roleRouter.post(
  '/',
  requirePermission('roles.create'),
  validate(createRoleSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const result = await execute('INSERT INTO roles (name, description, status) VALUES (?, ?, ?)', [
      body.name,
      body.description ?? null,
      body.status ?? 'ACTIVE',
    ]);
    await recordAudit(req, { action: 'CREATE', entityType: 'roles', entityId: result.insertId, description: `Creó el rol ${body.name}`, newValues: body });
    sendSuccess(res, await queryOne(`${ROLE_SELECT} WHERE r.id = ?`, [result.insertId]), 201);
  }),
);

roleRouter.put(
  '/:id',
  requirePermission('roles.update'),
  validate(updateRoleSchema),
  asyncHandler(async (req, res) => {
    const roleId = parseId(req.params.id);
    const previous = await queryOne<Record<string, unknown>>('SELECT * FROM roles WHERE id = ?', [roleId]);
    if (!previous) throw ApiError.notFound('Rol no encontrado');

    const body = req.body as Record<string, unknown>;
    const columns = ['name', 'description', 'status'].filter((column) => body[column] !== undefined);
    if (columns.length === 0) throw ApiError.badRequest('No se enviaron cambios');

    await execute(`UPDATE roles SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`, [
      ...columns.map((column) => body[column]),
      roleId,
    ]);

    await recordAudit(req, { action: 'UPDATE', entityType: 'roles', entityId: roleId, description: `Actualizó el rol`, oldValues: previous, newValues: body });
    sendSuccess(res, await queryOne(`${ROLE_SELECT} WHERE r.id = ?`, [roleId]));
  }),
);

roleRouter.put(
  '/:id/permissions',
  requirePermission('roles.update'),
  validate(setRolePermissionsSchema),
  asyncHandler(async (req, res) => {
    const roleId = parseId(req.params.id);
    const role = await queryOne<{ id: number; name: string }>('SELECT id, name FROM roles WHERE id = ?', [roleId]);
    if (!role) throw ApiError.notFound('Rol no encontrado');

    const permissionIds = (req.body.permission_ids as number[]) ?? [];

    await withTransaction(async (connection) => {
      await connection.query('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
      if (permissionIds.length > 0) {
        const values = permissionIds.map(() => '(?, ?)').join(', ');
        const params = permissionIds.flatMap((permissionId) => [roleId, permissionId]);
        await connection.query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ${values}`, params);
      }
    });

    await recordAudit(req, {
      action: 'UPDATE',
      entityType: 'role_permissions',
      entityId: roleId,
      description: `Actualizó los permisos del rol ${role.name}`,
      newValues: { permission_ids: permissionIds },
    });

    const permissions = await query(
      `SELECT p.id, p.name, p.module FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ? ORDER BY p.module, p.name`,
      [roleId],
    );
    sendSuccess(res, { role_id: roleId, permissions });
  }),
);

roleRouter.delete(
  '/:id',
  requirePermission('roles.delete'),
  asyncHandler(async (req, res) => {
    const roleId = parseId(req.params.id);
    const usersUsingRole = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM users WHERE role_id = ?', [roleId]);
    if (Number(usersUsingRole?.total ?? 0) > 0) {
      throw ApiError.conflict('No se puede eliminar el rol porque hay usuarios asignados a él');
    }

    await execute('DELETE FROM roles WHERE id = ?', [roleId]);
    await recordAudit(req, { action: 'DELETE', entityType: 'roles', entityId: roleId, description: 'Eliminó un rol' });
    sendSuccess(res, { id: roleId });
  }),
);

/* ------------------------------------------------------------------ permissions */
export const permissionRouter = Router();
permissionRouter.use(authenticate);

permissionRouter.get(
  '/',
  requirePermission('roles.view'),
  asyncHandler(async (_req, res) => {
    const permissions = await query<{ id: number; name: string; module: string; description: string | null }>(
      'SELECT id, name, module, description FROM permissions ORDER BY module, name',
    );

    const grouped = permissions.reduce<Record<string, typeof permissions>>((accumulator, permission) => {
      (accumulator[permission.module] ??= []).push(permission);
      return accumulator;
    }, {});

    sendSuccess(res, { permissions, grouped });
  }),
);
