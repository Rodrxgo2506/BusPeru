import { execute, query, queryOne } from '../config/database';
import { businessNow } from '../utils/businessTime';
import type { AuthenticatedUser, RoleName, User } from '../types/entities';

const USER_COLUMNS = `u.id, u.role_id, u.first_name, u.last_name, u.email, u.phone, u.avatar_url,
  u.status, u.email_verified_at, u.last_login_at, u.created_at, u.updated_at`;

interface UserWithHash extends User {
  password_hash: string;
  role: RoleName;
}

export async function findByEmailWithHash(email: string): Promise<UserWithHash | null> {
  return queryOne<UserWithHash>(
    `SELECT ${USER_COLUMNS}, u.password_hash, r.name AS role
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.email = ? LIMIT 1`,
    [email],
  );
}

export async function findPasswordHash(userId: number): Promise<string | null> {
  const row = await queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [userId]);
  return row?.password_hash ?? null;
}

/**
 * Lo que el middleware necesita para decidir si una sesión sigue viva (F17C-SEC-10).
 *
 * Va en UNA consulta porque las dos comprobaciones —huella de la contraseña y marca de
 * terminación— se hacen juntas en cada petición autenticada; pedirlas por separado doblaría
 * el trabajo sin ganar nada.
 *
 * `sessions_valid_from` se devuelve como SEGUNDOS desde epoch, en la misma escala que el `iat`
 * del JWT. La conversión se deja a `UNIX_TIMESTAMP`, que interpreta el DATETIME con la misma
 * zona horaria con la que `NOW()` lo escribió: así no hay que reconstruir la fecha en Node ni
 * arriesgar un desfase de zona. `NULL` significa que la cuenta nunca se suspendió.
 */
export interface SessionGuard {
  passwordHash: string;
  sessionsValidFrom: number | null;
}

export async function findSessionGuard(userId: number): Promise<SessionGuard | null> {
  const row = await queryOne<{ password_hash: string; sessions_valid_from: number | string | null }>(
    'SELECT password_hash, UNIX_TIMESTAMP(sessions_valid_from) AS sessions_valid_from FROM users WHERE id = ? LIMIT 1',
    [userId],
  );
  if (!row) return null;
  return {
    passwordHash: row.password_hash,
    sessionsValidFrom: row.sessions_valid_from === null ? null : Number(row.sessions_valid_from),
  };
}

/**
 * Avanza la marca de terminación: a partir de este instante, ninguna sesión emitida antes vale.
 * Se llama al dejar la cuenta en un estado distinto de ACTIVE. Reactivar NO la retrocede, que es
 * justamente lo que impide que un token anterior reviva.
 */
export async function terminateSessions(userId: number): Promise<void> {
  await query('UPDATE users SET sessions_valid_from = NOW() WHERE id = ?', [userId]);
}

export async function findById(userId: number): Promise<(User & { role: RoleName }) | null> {
  return queryOne<User & { role: RoleName }>(
    `SELECT ${USER_COLUMNS}, r.name AS role
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = ? LIMIT 1`,
    [userId],
  );
}

export async function findPermissionNames(roleId: number): Promise<string[]> {
  const rows = await query<{ name: string }>(
    `SELECT p.name FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = ? ORDER BY p.name`,
    [roleId],
  );
  return rows.map((row) => row.name);
}

export async function findCompanyIds(userId: number): Promise<number[]> {
  const rows = await query<{ company_id: number }>('SELECT company_id FROM company_users WHERE user_id = ?', [userId]);
  return rows.map((row) => row.company_id);
}

/** Builds the full auth context (role + permissions + company scope) for a user id. */
export async function loadAuthenticatedUser(userId: number): Promise<AuthenticatedUser | null> {
  const user = await findById(userId);
  if (!user) return null;

  const [permissions, companyIds] = await Promise.all([findPermissionNames(user.role_id), findCompanyIds(user.id)]);
  return { ...user, permissions, companyIds };
}

export async function touchLastLogin(userId: number): Promise<void> {
  await query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [userId]);
}

// --- OAuth (PENDIENTES.md §2) -----------------------------------------------

export interface OAuthAccount {
  id: number;
  email: string;
  status: User['status'];
  oauth_provider: 'GOOGLE' | 'MICROSOFT' | null;
  oauth_id: string | null;
}

const OAUTH_COLUMNS = 'id, email, status, oauth_provider, oauth_id';

/** Cuenta vinculada a una identidad concreta del proveedor. */
export async function findByOAuthIdentity(provider: string, oauthId: string): Promise<OAuthAccount | null> {
  return queryOne<OAuthAccount>(
    `SELECT ${OAUTH_COLUMNS} FROM users WHERE oauth_provider = ? AND oauth_id = ? LIMIT 1`,
    [provider, oauthId],
  );
}

export async function findByEmailForOAuth(email: string): Promise<OAuthAccount | null> {
  return queryOne<OAuthAccount>(`SELECT ${OAUTH_COLUMNS} FROM users WHERE email = ? LIMIT 1`, [email]);
}

export async function findOAuthLink(userId: number): Promise<OAuthAccount | null> {
  return queryOne<OAuthAccount>(`SELECT ${OAUTH_COLUMNS} FROM users WHERE id = ? LIMIT 1`, [userId]);
}

/**
 * Vincula una identidad externa a una cuenta existente.
 *
 * Las dos condiciones del WHERE son la salvaguarda contra una carrera: si entre la
 * comprobación y esta escritura alguien vinculó otro proveedor a la misma cuenta,
 * `affectedRows` es 0 y el servicio lo trata como conflicto. La clave única
 * `uq_users_oauth` cubre el otro lado (misma identidad en dos cuentas).
 */
export async function linkOAuthIdentity(userId: number, provider: string, oauthId: string): Promise<number> {
  const result = await execute(
    'UPDATE users SET oauth_provider = ?, oauth_id = ? WHERE id = ? AND oauth_provider IS NULL',
    [provider, oauthId, userId],
  );
  return result.affectedRows;
}

export async function unlinkOAuthIdentity(userId: number): Promise<number> {
  const result = await execute(
    'UPDATE users SET oauth_provider = NULL, oauth_id = NULL WHERE id = ? AND oauth_provider IS NOT NULL',
    [userId],
  );
  return result.affectedRows;
}

/**
 * Alta de una cuenta creada por OAuth. El rol y el estado los fija el servicio, nunca el
 * cliente. `password_hash` recibe un hash de 32 bytes aleatorios que nadie conoce: la
 * cuenta no tiene contraseña utilizable, pero la columna sigue siendo NOT NULL como en el
 * dump (PENDIENTES.md §2 dejaba elegir entre esto y permitir NULL).
 */
export async function createOAuthUser(input: {
  roleId: number;
  firstName: string;
  lastName: string;
  email: string;
  provider: string;
  oauthId: string;
  passwordHash: string;
  emailVerified: boolean;
}): Promise<number> {
  const result = await execute(
    `INSERT INTO users (role_id, first_name, last_name, email, password_hash, oauth_provider, oauth_id, status, email_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
    [
      input.roleId,
      input.firstName,
      input.lastName,
      input.email,
      input.passwordHash,
      input.provider,
      input.oauthId,
      // Se escribe con el mismo reloj que el resto de la fila. Pasar un `Date` funcionaba
      // solo porque el conector ahora lo serializa en hora de Perú (BP-12); esto lo hace
      // explícito y no depende de esa configuración.
      input.emailVerified ? businessNow() : null,
    ],
  );
  return result.insertId;
}
