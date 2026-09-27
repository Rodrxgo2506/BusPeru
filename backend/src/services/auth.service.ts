import { execute, queryOne, withTransaction } from '../config/database';
import {
  findByEmailWithHash,
  findPasswordHash,
  loadAuthenticatedUser,
  touchLastLogin,
} from '../repositories/user.repository';
import type { AuthenticatedUser, RoleName } from '../types/entities';
import { ApiError } from '../utils/ApiError';
import { hashPassword, sessionFingerprint, signToken, verifyPassword } from '../utils/security';
import type { LoginInput, RegisterCompanyInput, RegisterInput } from '../validators/auth.validators';
import type { IdentityDocumentType } from '../validators/identity.validators';

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

  // La huella ata la sesión a la credencial vigente: si la contraseña cambia, este token
  // deja de valer. En una cuenta creada por OAuth el hash es aleatorio pero estable, así
  // que la regla se aplica igual sin tratar a esas cuentas de forma distinta.
  const passwordHash = await findPasswordHash(userId);
  if (!passwordHash) throw ApiError.internal();

  return {
    token: signToken({ sub: user.id, roleId: user.role_id, role: user.role, pwd: sessionFingerprint(passwordHash) }),
    user,
  };
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

  return {
    token: signToken({ sub: user.id, roleId: user.role_id, role: user.role, pwd: sessionFingerprint(account.password_hash) }),
    user,
  };
}

export async function registerCustomer(input: RegisterInput): Promise<AuthResult> {
  const existing = await queryOne<{ id: number }>('SELECT id FROM users WHERE email = ? LIMIT 1', [input.email]);
  if (existing) throw ApiError.conflict('Ya existe una cuenta con ese correo electrónico');

  const roleId = await roleIdByName('CUSTOMER');
  const passwordHash = await hashPassword(input.password);

  const result = await execute(
    `INSERT INTO users (role_id, first_name, last_name, email, phone, document_type, document_number, birth_date, password_hash, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
    [
      roleId, input.first_name, input.last_name, input.email, input.phone ?? null,
      input.document_type, input.document_number, input.birth_date, passwordHash,
    ],
  );

  const user = await loadAuthenticatedUser(result.insertId);
  if (!user) throw ApiError.internal();

  return {
    token: signToken({ sub: user.id, roleId: user.role_id, role: user.role, pwd: sessionFingerprint(passwordHash) }),
    user,
  };
}

export interface IdentityInput {
  document_type?: IdentityDocumentType;
  document_number?: string;
  birth_date?: string;
}

const DOCUMENTO_FIJO = 'Tu documento de identidad ya está registrado y no se puede cambiar desde el perfil';
const NACIMIENTO_FIJO = 'Tu fecha de nacimiento ya está registrada y no se puede cambiar desde el perfil';

/**
 * El CLIENTE completa su documento y su fecha de nacimiento UNA sola vez (cuentas antiguas o creadas por
 * Google/Microsoft, que nacen sin ellos). Una vez guardados no se cambian desde el perfil: no hay todavía
 * un flujo de soporte para corregirlos.
 *
 * La regla la hace cumplir la base: el UPDATE solo escribe si la columna sigue vacía (`IS NULL`), así que
 * dos peticiones simultáneas no pueden pisarse. Reenviar exactamente lo que ya está guardado no es un
 * cambio y no falla. Devuelve si se guardó algo nuevo.
 */
export async function completeIdentity(user: AuthenticatedUser, input: IdentityInput): Promise<boolean> {
  const pideDocumento = input.document_type !== undefined && input.document_number !== undefined;
  const pideNacimiento = input.birth_date !== undefined;
  if (!pideDocumento && !pideNacimiento) return false;
  if (user.role !== 'CUSTOMER') throw ApiError.forbidden('Solo los clientes registran su documento y su fecha de nacimiento');

  const actual = await queryOne<{ document_type: string | null; document_number: string | null; birth_date: string | null }>(
    "SELECT document_type, document_number, DATE_FORMAT(birth_date, '%Y-%m-%d') AS birth_date FROM users WHERE id = ? LIMIT 1",
    [user.id],
  );
  if (!actual) throw ApiError.notFound('Usuario no encontrado');

  let guardado = false;
  if (pideDocumento) {
    const mismo = actual.document_type === input.document_type && actual.document_number === input.document_number;
    if (actual.document_type !== null || actual.document_number !== null) {
      if (!mismo) throw ApiError.conflict(DOCUMENTO_FIJO);
    } else {
      const r = await execute(
        'UPDATE users SET document_type = ?, document_number = ? WHERE id = ? AND document_type IS NULL AND document_number IS NULL',
        [input.document_type, input.document_number, user.id],
      );
      if (r.affectedRows !== 1) throw ApiError.conflict(DOCUMENTO_FIJO);
      guardado = true;
    }
  }
  if (pideNacimiento) {
    if (actual.birth_date !== null) {
      if (actual.birth_date !== input.birth_date) throw ApiError.conflict(NACIMIENTO_FIJO);
    } else {
      const r = await execute('UPDATE users SET birth_date = ? WHERE id = ? AND birth_date IS NULL', [input.birth_date, user.id]);
      if (r.affectedRows !== 1) throw ApiError.conflict(NACIMIENTO_FIJO);
      guardado = true;
    }
  }
  return guardado;
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
