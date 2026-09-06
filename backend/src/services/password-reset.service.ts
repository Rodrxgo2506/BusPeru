import crypto from 'crypto';
import { execute, query, queryOne, withTransaction } from '../config/database';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';
import { hashPassword } from '../utils/security';
import { sendEmail } from './email.service';
import { PASSWORD_RESET_EMAIL, renderTemplate } from './notification.service';

/**
 * Recuperación de contraseña con código de verificación (mockup 10).
 *
 * Flujo en dos fases, para que el código no pueda reutilizarse contra el endpoint que
 * cambia la contraseña:
 *
 *   1. forgot-password  → genera un código de 6 dígitos, guarda solo su hash y lo envía.
 *   2. verify-reset-code → comprueba el código y emite un *ticket* opaco de un solo uso.
 *   3. reset-password   → exige el ticket, cambia la contraseña y consume la solicitud.
 *
 * Reglas de seguridad aplicadas:
 *   · El código se genera con `crypto.randomInt`, nunca con `Math.random`.
 *   · En la base solo vive `sha256(user_id:codigo:JWT_SECRET)`; el código en claro no se
 *     guarda, no se registra en logs de producción y no se devuelve en la respuesta.
 *   · Incluir el `user_id` en el hash impide que el código de un usuario sirva para otro.
 *   · Expiración corta, número máximo de intentos y un solo uso.
 *   · Las respuestas son siempre genéricas: nunca revelan si el correo existe.
 */

interface ResetRow {
  id: number;
  user_id: number;
  token_hash: string;
  attempts: number;
  ticket_hash: string | null;
  ticket_expires_at: string | null;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

/** Respuesta idéntica exista o no la cuenta: evita enumerar usuarios. */
export const GENERIC_MESSAGE =
  'Si el correo está registrado, recibirás un código para recuperar tu contraseña.';

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** El secreto liga el hash a esta instalación: una filtración de la tabla no basta. */
function hashCode(userId: number, code: string): string {
  return digest(`${userId}:${code}:${env.jwt.secret}`);
}

function hashTicket(ticket: string): string {
  return digest(`${ticket}:${env.jwt.secret}`);
}

/** Código de 6 dígitos criptográficamente seguro, con ceros a la izquierda. */
function generateCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function generateTicket(): string {
  return crypto.randomBytes(32).toString('hex');
}

async function findUserByEmail(email: string): Promise<{ id: number; first_name: string; email: string; status: string } | null> {
  return queryOne('SELECT id, first_name, email, status FROM users WHERE email = ? LIMIT 1', [email]);
}

/** Marca como consumidas todas las solicitudes vivas del usuario. */
async function invalidateActiveRequests(userId: number): Promise<void> {
  await execute('UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [userId]);
}

/** Última solicitud viva del usuario, si la hay. */
async function findActiveRequest(userId: number): Promise<ResetRow | null> {
  return queryOne<ResetRow>(
    `SELECT * FROM password_reset_tokens
     WHERE user_id = ? AND used_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    [userId],
  );
}

async function createRequest(userId: number): Promise<string> {
  const code = generateCode();
  await execute(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
    [userId, hashCode(userId, code), env.passwordReset.codeTtlMinutes],
  );
  return code;
}

async function deliverCode(user: { id: number; first_name: string; email: string }, code: string): Promise<void> {
  const context = {
    first_name: user.first_name,
    code,
    minutes: env.passwordReset.codeTtlMinutes,
  };
  const { subject, body } = await renderTemplate(PASSWORD_RESET_EMAIL, context);
  await sendEmail({ to: user.email, subject, text: body });
}

/**
 * Paso 1. Siempre devuelve el mismo mensaje: quien pregunta no puede distinguir un
 * correo registrado de uno que no lo está.
 */
export async function requestReset(email: string, options: { resend?: boolean } = {}): Promise<{ message: string }> {
  const user = await findUserByEmail(email);

  // Cuentas inexistentes o no activas: se responde igual, sin generar ni enviar nada.
  if (!user || user.status !== 'ACTIVE') return { message: GENERIC_MESSAGE };

  // Cooldown de reenvío (mockup 10: 00:45). Se aplica al usuario, no a la IP, para que
  // el limitador global no sea la única defensa contra el spam de correos.
  const active = await findActiveRequest(user.id);
  if (active) {
    const elapsedSeconds = (Date.now() - new Date(active.created_at).getTime()) / 1000;
    if (elapsedSeconds < env.passwordReset.resendCooldownSeconds) {
      if (options.resend) {
        throw ApiError.tooManyRequests(
          `Espera ${Math.ceil(env.passwordReset.resendCooldownSeconds - elapsedSeconds)} segundos antes de solicitar otro código.`,
        );
      }
      // En el primer paso el cooldown no se comunica: delataría que la cuenta existe.
      return { message: GENERIC_MESSAGE };
    }
  }

  await invalidateActiveRequests(user.id);
  const code = await createRequest(user.id);
  await deliverCode(user, code);

  return { message: GENERIC_MESSAGE };
}

export interface VerifyResult {
  ticket: string;
  expires_in_minutes: number;
}

/**
 * Paso 2. Comprueba el código y emite el ticket que autoriza el cambio.
 * No inicia sesión ni devuelve un JWT: el ticket solo sirve para `resetPassword`.
 *
 * La transacción NUNCA lanza: devuelve el desenlace y el error se lanza después de
 * confirmarla. Si se lanzara dentro, el ROLLBACK desharía el incremento de `attempts`
 * y el límite de intentos no serviría de nada.
 */
type VerifyOutcome =
  | { ok: true; ticket: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'blocked' };

export async function verifyCode(email: string, code: string): Promise<VerifyResult> {
  const user = await findUserByEmail(email);
  if (!user || user.status !== 'ACTIVE') throw ApiError.badRequest('El código no es válido o ha expirado.');

  const outcome = await withTransaction<VerifyOutcome>(async (connection) => {
    // FOR UPDATE serializa los intentos: dos peticiones simultáneas no pueden gastar
    // el mismo intento ni emitir dos tickets del mismo código.
    const [rows] = await connection.query(
      `SELECT * FROM password_reset_tokens
       WHERE user_id = ? AND used_at IS NULL
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [user.id],
    );
    const request = (rows as ResetRow[])[0];
    if (!request) return { ok: false, reason: 'invalid' };

    if (new Date(request.expires_at).getTime() <= Date.now()) {
      await connection.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?', [request.id]);
      return { ok: false, reason: 'expired' };
    }

    if (request.attempts >= env.passwordReset.maxAttempts) {
      await connection.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?', [request.id]);
      return { ok: false, reason: 'blocked' };
    }

    // Comparación en tiempo constante sobre los hashes, no sobre el código.
    const expected = Buffer.from(request.token_hash, 'utf8');
    const received = Buffer.from(hashCode(user.id, code), 'utf8');
    const matches = expected.length === received.length && crypto.timingSafeEqual(expected, received);

    if (!matches) {
      const attempts = request.attempts + 1;
      await connection.query('UPDATE password_reset_tokens SET attempts = ? WHERE id = ?', [attempts, request.id]);

      if (attempts >= env.passwordReset.maxAttempts) {
        await connection.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?', [request.id]);
        return { ok: false, reason: 'blocked' };
      }
      return { ok: false, reason: 'invalid' };
    }

    const ticket = generateTicket();
    await connection.query(
      `UPDATE password_reset_tokens
       SET ticket_hash = ?, ticket_expires_at = DATE_ADD(NOW(), INTERVAL ? MINUTE), attempts = 0
       WHERE id = ?`,
      [hashTicket(ticket), env.passwordReset.ticketTtlMinutes, request.id],
    );
    return { ok: true, ticket };
  });

  if (outcome.ok) return { ticket: outcome.ticket, expires_in_minutes: env.passwordReset.ticketTtlMinutes };

  if (outcome.reason === 'expired') throw ApiError.badRequest('El código ha expirado. Solicita uno nuevo.');
  if (outcome.reason === 'blocked') throw ApiError.tooManyRequests('Demasiados intentos fallidos. Solicita un código nuevo.');
  throw ApiError.badRequest('El código no es válido o ha expirado.');
}

/**
 * Paso 3. Cambia la contraseña contra el ticket, nunca contra el código.
 * El ticket es de un solo uso: la solicitud queda consumida en la misma transacción.
 */
export async function resetPassword(email: string, ticket: string, newPassword: string): Promise<{ message: string }> {
  const invalid = ApiError.badRequest('La solicitud de recuperación no es válida o ha expirado.');

  const user = await findUserByEmail(email);
  if (!user || user.status !== 'ACTIVE') throw invalid;

  const passwordHash = await hashPassword(newPassword);

  // Igual que en la verificación: la transacción no lanza, para que la invalidación de un
  // ticket caducado se confirme en lugar de deshacerse con el ROLLBACK.
  const outcome = await withTransaction<'ok' | 'invalid' | 'expired'>(async (connection) => {
    // El ticket se busca acotado al usuario: el ticket de una cuenta no sirve en otra.
    const [rows] = await connection.query(
      `SELECT * FROM password_reset_tokens
       WHERE user_id = ? AND ticket_hash = ? AND used_at IS NULL
       LIMIT 1 FOR UPDATE`,
      [user.id, hashTicket(ticket)],
    );
    const request = (rows as ResetRow[])[0];
    if (!request) return 'invalid';

    if (!request.ticket_expires_at || new Date(request.ticket_expires_at).getTime() <= Date.now()) {
      await connection.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?', [request.id]);
      return 'expired';
    }

    await connection.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, user.id]);

    // Se consumen todas las solicitudes vivas del usuario, no solo la usada: tras cambiar
    // la contraseña ningún código anterior debe seguir sirviendo.
    await connection.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [user.id]);
    return 'ok';
  });

  if (outcome === 'invalid') throw invalid;
  if (outcome === 'expired') throw ApiError.badRequest('La solicitud de recuperación ha expirado. Vuelve a empezar.');

  await sendEmail({
    to: user.email,
    subject: 'Tu contraseña de BusPerú fue actualizada',
    text:
      `Hola ${user.first_name}:\n\n` +
      'Te confirmamos que la contraseña de tu cuenta de BusPerú se actualizó correctamente.\n\n' +
      'Si no fuiste tú, contacta con soporte de inmediato: alguien podría tener acceso a tu correo.\n\n' +
      'BusPerú',
  });

  return { message: 'Tu contraseña se actualizó correctamente. Ya puedes iniciar sesión.' };
}

/**
 * Purga las solicitudes que ya no sirven: consumidas o expiradas hace más de un día.
 * La llama el planificador que ya existe para la expiración de reservas; no se añade
 * ningún proceso periódico nuevo.
 */
export async function purgeExpiredResetTokens(): Promise<number> {
  const result = await execute(
    `DELETE FROM password_reset_tokens
     WHERE (used_at IS NOT NULL AND used_at < DATE_SUB(NOW(), INTERVAL 1 DAY))
        OR expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)`,
  );
  return result.affectedRows;
}

/** Solo para la suite: comprueba que en la base no queda ningún código en claro. */
export async function debugStoredHashes(userId: number): Promise<Array<{ token_hash: string; ticket_hash: string | null }>> {
  return query('SELECT token_hash, ticket_hash FROM password_reset_tokens WHERE user_id = ?', [userId]);
}
