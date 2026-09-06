import { execute, queryOne, withTransaction } from '../config/database';
import {
  findByEmailWithHash,
  findPasswordHash,
  loadAuthenticatedUser,
  touchLastLogin,
} from '../repositories/user.repository';
import type { AuthenticatedUser, RoleName } from '../types/entities';
import { ApiError } from '../utils/ApiError';
import { hashPassword, signToken, verifyPassword } from '../utils/security';
import type { LoginInput, RegisterCompanyInput, RegisterInput } from '../validators/auth.validators';

export interface AuthResult {
  token: string;
  user: AuthenticatedUser;
}

export async function roleIdByName(name: RoleName): Promise<number> {
  const role = await queryOne<{ id: number }>('SELECT id FROM roles WHERE name = ? AND status = ? LIMIT 1', [name, 'ACTIVE']);
  if (!role) throw ApiError.internal(`El rol ${name} no existe en la base de datos`);
  return role.id;
}

/**
 * Estados que impiden abrir sesión, sea con contraseña o con OAuth.
 *
 * Sin esto se entregaba un token a cuentas PENDING que el middleware luego rechaza con 403
 * en cada petición: sesión inservible y mensaje confuso. Lo comparten los dos mecanismos de
 * autenticación para que ninguno pueda relajar las reglas del otro.
 */
export function assertAccountCanSignIn(status: string): void {
  if (status === 'SUSPENDED') throw ApiError.forbidden('Tu cuenta ha sido suspendida. Contacta con soporte.');
  if (status === 'INACTIVE') throw ApiError.forbidden('Tu cuenta está inactiva. Contacta con soporte.');
  if (status === 'PENDING') {
    throw ApiError.forbidden('Tu cuenta aún está pendiente de aprobación. Te avisaremos cuando esté activa.');
  }
}

/** Emite la sesión de un usuario ya autenticado por cualquiera de los dos mecanismos. */
export async function issueSession(userId: number): Promise<AuthResult> {
  await touchLastLogin(userId);
  const user = await loadAuthenticatedUser(userId);
  if (!user) throw ApiError.internal();

  return { token: signToken({ sub: user.id, roleId: user.role_id, role: user.role }), user };
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const account = await findByEmailWithHash(input.email);
  // Same message for unknown email and wrong password: do not reveal which accounts exist.
  if (!account) throw ApiError.unauthorized('Correo o contraseña incorrectos');

  const passwordMatches = await verifyPassword(input.password, account.password_hash);
  if (!passwordMatches) throw ApiError.unauthorized('Correo o contraseña incorrectos');

  assertAccountCanSignIn(account.status);

  await touchLastLogin(account.id);
  const user = await loadAuthenticatedUser(account.id);
  if (!user) throw ApiError.internal();

  return { token: signToken({ sub: user.id, roleId: user.role_id, role: user.role }), user };
}

export async function registerCustomer(input: RegisterInput): Promise<AuthResult> {
  const existing = await queryOne<{ id: number }>('SELECT id FROM users WHERE email = ? LIMIT 1', [input.email]);
  if (existing) throw ApiError.conflict('Ya existe una cuenta con ese correo electrónico');

  const roleId = await roleIdByName('CUSTOMER');
  const passwordHash = await hashPassword(input.password);

  const result = await execute(
    `INSERT INTO users (role_id, first_name, last_name, email, phone, password_hash, status)
     VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
    [roleId, input.first_name, input.last_name, input.email, input.phone ?? null, passwordHash],
  );

  const user = await loadAuthenticatedUser(result.insertId);
  if (!user) throw ApiError.internal();

  return { token: signToken({ sub: user.id, roleId: user.role_id, role: user.role }), user };
}

/**
 * Company sign-up creates the company in PENDING status plus its COMPANY_ADMIN user,
 * linked through company_users. The platform admin approves the company afterwards.
 */
export async function registerCompany(input: RegisterCompanyInput): Promise<{ companyId: number; userId: number }> {
  const [emailTaken, taxIdTaken] = await Promise.all([
    queryOne<{ id: number }>('SELECT id FROM users WHERE email = ? LIMIT 1', [input.admin.email]),
    queryOne<{ id: number }>('SELECT id FROM companies WHERE tax_id = ? LIMIT 1', [input.company.tax_id]),
  ]);
  if (emailTaken) throw ApiError.conflict('Ya existe una cuenta con ese correo electrónico');
  if (taxIdTaken) throw ApiError.conflict('Ya existe una empresa registrada con ese RUC');

  const roleId = await roleIdByName('COMPANY_ADMIN');
  const passwordHash = await hashPassword(input.admin.password);

  return withTransaction(async (connection) => {
    const [companyResult] = await connection.query(
      `INSERT INTO companies (name, legal_name, tax_id, email, phone, description, status)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
      [
        input.company.name,
        input.company.legal_name,
        input.company.tax_id,
        input.company.email,
        input.company.phone ?? null,
        input.company.description ?? null,
      ],
    );
    const companyId = (companyResult as { insertId: number }).insertId;

    const [userResult] = await connection.query(
      `INSERT INTO users (role_id, first_name, last_name, email, phone, password_hash, status)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
      [
        roleId,
        input.admin.first_name,
        input.admin.last_name,
        input.admin.email,
        input.admin.phone ?? null,
        passwordHash,
      ],
    );
    const userId = (userResult as { insertId: number }).insertId;

    await connection.query('INSERT INTO company_users (company_id, user_id, position) VALUES (?, ?, ?)', [
      companyId,
      userId,
      input.admin.position ?? 'Representante legal',
    ]);

    return { companyId, userId };
  });
}

export async function changePassword(userId: number, currentPassword: string, newPassword: string): Promise<void> {
  const currentHash = await findPasswordHash(userId);
  if (!currentHash) throw ApiError.notFound('Usuario no encontrado');

  const matches = await verifyPassword(currentPassword, currentHash);
  if (!matches) throw ApiError.badRequest('La contraseña actual no es correcta');

  await execute('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(newPassword), userId]);
}
