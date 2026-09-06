import { Router, type Request } from 'express';
import { execute, query, queryOne, withTransaction } from '../config/database';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendList, sendSuccess } from '../utils/http';
import { buildPagination, parseListQuery, safeColumn, stableOrderBy, parseId } from '../utils/query';
import { hashPassword } from '../utils/security';
import { createUserSchema, updateUserSchema } from '../validators/resource.validators';

const router = Router();
router.use(authenticate);

/** password_hash is never part of the projection. */
const USER_SELECT = `SELECT u.id, u.role_id, u.first_name, u.last_name, u.email, u.phone, u.avatar_url, u.status,
    u.email_verified_at, u.last_login_at, u.created_at, u.updated_at,
    r.name AS role_name, r.description AS role_description,
    cu.company_id, cu.position, co.name AS company_name,
    (SELECT COUNT(*) FROM bookings bk WHERE bk.user_id = u.id AND bk.status IN ('CONFIRMED','COMPLETED')) AS bookings_count
  FROM users u
  JOIN roles r ON r.id = u.role_id
  LEFT JOIN company_users cu ON cu.user_id = u.id
  LEFT JOIN companies co ON co.id = cu.company_id`;

/** COMPANY_ADMIN manages only users of its own company; ADMIN manages everyone. */
function visibilityScope(req: Request): { sql: string; params: unknown[] } | null {
  const user = requireAuth(req);
  if (user.role === 'ADMIN') return null;
  if (user.companyIds.length === 0) return { sql: 'u.id = ?', params: [user.id] };
  return { sql: `cu.company_id IN (${user.companyIds.map(() => '?').join(', ')})`, params: [...user.companyIds] };
}

/**
 * Los roles asignables dependen de quién crea o edita. Sin esta comprobación un
 * COMPANY_ADMIN podía crear un usuario con `role_id` del rol ADMIN y escalar a
 * administrador de la plataforma. ADMIN asigna cualquier rol; el resto solo puede
 * asignar roles de empresa.
 */
const COMPANY_ASSIGNABLE_ROLES = ['COMPANY_ADMIN', 'OPERATOR'];

async function assertAssignableRole(req: Request, roleId: unknown): Promise<void> {
  if (roleId === undefined || roleId === null) return;
  const actor = requireAuth(req);
  if (actor.role === 'ADMIN') return;

  const role = await queryOne<{ name: string }>('SELECT name FROM roles WHERE id = ? LIMIT 1', [Number(roleId)]);
  if (!role) throw ApiError.badRequest('El rol indicado no existe');
  if (!COMPANY_ASSIGNABLE_ROLES.includes(role.name)) {
    throw ApiError.forbidden('Solo puedes asignar roles de empresa (COMPANY_ADMIN u OPERATOR)');
  }
}

/**
 * `PUT /users/:id` es un endpoint ADMINISTRATIVO: existe para gestionar a OTROS usuarios.
 * Sobre la cuenta propia hay dos campos que nadie debe tocar por aquí, porque cada uno
 * tiene su propio camino con una comprobación de identidad que este endpoint no hace:
 *
 *   · `role_id`  — nadie cambia su propio rol. La regla es esa, no una lista de roles
 *                  prohibidos: da igual a cuál se quiera pasar. Sin ella, un CUSTOMER
 *                  —que tiene `users.update` y cuyo alcance es su propia fila— se
 *                  promovía a COMPANY_ADMIN con una sola petición, porque
 *                  `assertAssignableRole` solo cierra el paso al rol ADMIN.
 *   · `password` — la contraseña propia se cambia en `PUT /auth/me/password`, que exige la
 *                  contraseña actual. Aceptarla aquí convertía este endpoint en un rodeo
 *                  para saltarse esa comprobación.
 *
 * Reenviar el `role_id` que ya se tiene NO es un cambio y se admite: el formulario del
 * panel devuelve la fila completa al editar, y rechazarlo rompería que un administrador
 * corrija su propio nombre o teléfono desde la gestión de usuarios.
 *
 * La comprobación vive aquí y no en `updateUserSchema` a propósito: el esquema valida la
 * forma del cuerpo, que es la misma para todos, mientras que esto es autorización y
 * depende de quién actúa sobre quién. Ambos campos siguen siendo legítimos cuando un
 * actor autorizado edita a otro usuario.
 */
function assertSelfEditIsSafe(
  req: Request,
  targetUserId: number,
  body: Record<string, unknown>,
  previousRoleId: unknown,
): void {
  const actor = requireAuth(req);
  if (actor.id !== targetUserId) return;

  if (body.role_id !== undefined && Number(body.role_id) !== Number(previousRoleId)) {
    throw ApiError.forbidden('No puedes cambiar tu propio rol. Debe hacerlo otro administrador.');
  }
  if (body.password !== undefined) {
    throw ApiError.forbidden('Para cambiar tu contraseña usa la opción de tu perfil, que pide la contraseña actual.');
  }
}

async function findUserOrFail(req: Request, userId: number): Promise<Record<string, unknown>> {
  const conditions = ['u.id = ?'];
  const params: unknown[] = [userId];
  const scope = visibilityScope(req);
  if (scope) {
    conditions.push(scope.sql);
    params.push(...scope.params);
  }
  const user = await queryOne<Record<string, unknown>>(`${USER_SELECT} WHERE ${conditions.join(' AND ')} LIMIT 1`, params);
  if (!user) throw ApiError.notFound('Usuario no encontrado');
  return user;
}

router.get(
  '/',
  requirePermission('users.view'),
  asyncHandler(async (req, res) => {
    const listQuery = parseListQuery(req.query as Record<string, unknown>);
    const conditions: string[] = [];
    const params: unknown[] = [];

    const scope = visibilityScope(req);
    if (scope) {
      conditions.push(scope.sql);
      params.push(...scope.params);
    }

    const filterMap: Record<string, string> = { status: 'u.status', role_id: 'u.role_id', company_id: 'cu.company_id', role: 'r.name' };
    for (const [key, column] of Object.entries(filterMap)) {
      const value = listQuery.filters[key];
      if (value !== undefined) {
        conditions.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (listQuery.search) {
      conditions.push('(u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)');
      params.push(...Array(4).fill(`%${listQuery.search}%`));
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const countRow = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM (${USER_SELECT}${where}) AS scoped`, params);
    const sortColumn = safeColumn(listQuery.sort, ['u.created_at', 'u.first_name', 'u.last_name', 'u.email', 'u.last_login_at'], 'u.created_at');

    const rows = await query(`${USER_SELECT}${where} ORDER BY ${stableOrderBy(sortColumn, listQuery.order, 'u')} LIMIT ? OFFSET ?`, [
      ...params,
      listQuery.limit,
      listQuery.offset,
    ]);

    sendList(res, rows, buildPagination(Number(countRow?.total ?? 0), listQuery.page, listQuery.limit));
  }),
);

/**
 * Cifras de la plataforma entera, exclusivas del ADMIN.
 *
 * Era el único endpoint del archivo que no aplicaba `visibilityScope`, y `users.view` lo
 * tienen también CUSTOMER y OPERATOR: cualquier cliente registrado obtenía el tamaño real
 * de la plataforma y cuántos administradores hay.
 *
 * Se restringe por ROL en vez de acotar por empresa porque estas cifras no tienen una
 * versión con sentido para una empresa —«administradores» o «clientes totales» no son
 * suyos— y el Portal Empresa nunca las pide: la pantalla de usuarios solo llama a este
 * endpoint cuando su `scope` es `admin`. Es el mismo criterio de `/dashboard/admin`.
 */
router.get(
  '/stats',
  requirePermission('users.view'),
  asyncHandler(async (req, res) => {
    if (requireAuth(req).role !== 'ADMIN') {
      throw ApiError.forbidden('Solo el administrador de la plataforma puede ver estas cifras');
    }

    const stats = await queryOne(
      `SELECT COUNT(*) AS total,
        SUM(u.status = 'ACTIVE') AS active,
        SUM(u.status = 'SUSPENDED') AS suspended,
        SUM(u.status = 'PENDING') AS pending,
        SUM(r.name = 'CUSTOMER') AS customers,
        SUM(r.name = 'ADMIN') AS admins,
        SUM(r.name IN ('COMPANY_ADMIN','OPERATOR')) AS company_users
       FROM users u JOIN roles r ON r.id = u.role_id`,
    );
    sendSuccess(res, stats);
  }),
);

router.get(
  '/:id',
  requirePermission('users.view'),
  asyncHandler(async (req, res) => {
    const user = await findUserOrFail(req, parseId(req.params.id));
    const permissions = await query<{ name: string; module: string; description: string | null }>(
      `SELECT p.name, p.module, p.description FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ? ORDER BY p.module, p.name`,
      [user.role_id],
    );
    sendSuccess(res, { ...user, permissions });
  }),
);

router.post(
  '/',
  requirePermission('users.create'),
  validate(createUserSchema),
  asyncHandler(async (req, res) => {
    const actor = requireAuth(req);
    const body = req.body as Record<string, unknown>;

    await assertAssignableRole(req, body.role_id);

    const existing = await queryOne<{ id: number }>('SELECT id FROM users WHERE email = ? LIMIT 1', [body.email]);
    if (existing) throw ApiError.conflict('Ya existe un usuario con ese correo electrónico');

    let companyId = body.company_id === undefined || body.company_id === null ? null : Number(body.company_id);
    if (actor.role !== 'ADMIN') {
      const [ownCompany] = actor.companyIds;
      if (ownCompany === undefined) throw ApiError.forbidden('Tu usuario no está asociado a ninguna empresa');
      if (companyId !== null && !actor.companyIds.includes(companyId)) {
        throw ApiError.forbidden('No puedes crear usuarios para otra empresa');
      }
      companyId = companyId ?? ownCompany;
    }

    const passwordHash = await hashPassword(String(body.password));
    const userId = await withTransaction(async (connection) => {
      const [result] = await connection.query(
        `INSERT INTO users (role_id, first_name, last_name, email, phone, password_hash, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [body.role_id, body.first_name, body.last_name, body.email, body.phone ?? null, passwordHash, body.status ?? 'ACTIVE'],
      );
      const newUserId = (result as { insertId: number }).insertId;

      if (companyId !== null) {
        await connection.query('INSERT INTO company_users (company_id, user_id, position) VALUES (?, ?, ?)', [
          companyId,
          newUserId,
          body.position ?? null,
        ]);
      }
      return newUserId;
    });

    await recordAudit(req, {
      action: 'CREATE',
      entityType: 'users',
      entityId: userId,
      description: `Creó el usuario ${body.email}`,
      newValues: { email: body.email, role_id: body.role_id, company_id: companyId },
    });

    sendSuccess(res, await findUserOrFail(req, userId), 201);
  }),
);

router.put(
  '/:id',
  requirePermission('users.update'),
  validate(updateUserSchema),
  asyncHandler(async (req, res) => {
    const userId = parseId(req.params.id);
    const previous = await findUserOrFail(req, userId);
    const body = req.body as Record<string, unknown>;

    // Primero la cuenta propia: rol y contraseña no se tocan desde aquí (BP-01 y BP-03).
    assertSelfEditIsSafe(req, userId, body, previous.role_id);

    // También al editar: un rol de empresa no puede promover a nadie a ADMIN.
    if (body.role_id !== undefined && Number(body.role_id) !== Number(previous.role_id)) {
      await assertAssignableRole(req, body.role_id);
    }

    const data: Record<string, unknown> = {};
    for (const column of ['role_id', 'first_name', 'last_name', 'phone', 'avatar_url', 'status']) {
      if (body[column] !== undefined) data[column] = body[column];
    }
    if (typeof body.password === 'string') data.password_hash = await hashPassword(body.password);

    const columns = Object.keys(data);
    if (columns.length === 0) throw ApiError.badRequest('No se enviaron cambios');

    await execute(`UPDATE users SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`, [
      ...columns.map((column) => data[column]),
      userId,
    ]);

    await recordAudit(req, {
      action: 'UPDATE',
      entityType: 'users',
      entityId: userId,
      description: `Actualizó el usuario ${previous.email}`,
      oldValues: previous,
      newValues: data,
    });

    sendSuccess(res, await findUserOrFail(req, userId));
  }),
);

router.delete(
  '/:id',
  requirePermission('users.delete'),
  asyncHandler(async (req, res) => {
    const userId = parseId(req.params.id);
    const actor = requireAuth(req);
    if (actor.id === userId) throw ApiError.badRequest('No puedes eliminar tu propia cuenta');

    const previous = await findUserOrFail(req, userId);
    await execute('DELETE FROM users WHERE id = ?', [userId]);
    await recordAudit(req, {
      action: 'DELETE',
      entityType: 'users',
      entityId: userId,
      description: `Eliminó el usuario ${previous.email}`,
      oldValues: previous,
    });
    sendSuccess(res, { id: userId });
  }),
);

export default router;
