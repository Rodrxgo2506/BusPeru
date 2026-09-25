import { execute, queryOne } from '../config/database';

/**
 * Revocación de sesiones al cerrar sesión (auditoría final FASE 12, hallazgo F12-07).
 *
 * DECISIÓN. El token sigue viajando en la cabecera `Authorization: Bearer` y el frontend lo
 * guarda en `localStorage`. Pasar a cookie HttpOnly obligaría a añadir protección CSRF, cambiar
 * CORS con credenciales, el canje del ticket OAuth, el cliente del frontend y todas las suites:
 * un cambio de alto riesgo para la ganancia en este momento. Se endurece lo que sí se puede sin
 * rehacer la autenticación: cada token lleva un `jti` aleatorio y `POST /auth/logout` lo revoca en
 * `revoked_sessions` (migración 014). Un token copiado antes del cierre deja de valer.
 *
 * Cambiar la contraseña sigue expulsando TODAS las sesiones por la huella de BP-18. Los tokens
 * emitidos antes de este cambio no llevan `jti`: no se pueden revocar uno a uno y caducan solos
 * (8 h como máximo).
 */

/** ¿Está revocado este `jti`? Una consulta por clave primaria. */
export async function isSessionRevoked(jti: string): Promise<boolean> {
  return (await queryOne('SELECT jti FROM revoked_sessions WHERE jti = ? LIMIT 1', [jti])) !== null;
}

/**
 * Revoca el token. Idempotente: cerrar sesión dos veces con el mismo token no falla.
 * `expiresAtEpoch` es el `exp` del JWT, en segundos.
 */
export async function revokeSession(jti: string, userId: number, expiresAtEpoch: number): Promise<void> {
  await execute(
    'INSERT IGNORE INTO revoked_sessions (jti, user_id, expires_at) VALUES (?, ?, FROM_UNIXTIME(?))',
    [jti, userId, Math.floor(expiresAtEpoch)],
  );
}

/** Borra revocaciones cuyo token ya caducó: ya no pueden coincidir con ninguno vivo. */
export async function purgeExpiredRevocations(limit = 1000): Promise<number> {
  const result = await execute('DELETE FROM revoked_sessions WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 HOUR) LIMIT ?', [limit]);
  return result.affectedRows;
}
