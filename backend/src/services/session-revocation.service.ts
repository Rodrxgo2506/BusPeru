import { execute, queryOne } from '../config/database';
import { tokenLifetimeSeconds } from '../utils/security';

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

/** Margen de cortesia sobre la caducidad, para no apurar el borrado al segundo. */
const MARGEN_SEGUNDOS = 3600;

/**
 * Borra revocaciones cuyo token ya caducó: ya no pueden coincidir con ninguno vivo.
 *
 * DOS CONDICIONES, Y LA SEGUNDA ES LA QUE DA LA GARANTÍA (F17C-SEC-05).
 *
 *   1. `expires_at` —la caducidad del token— ya pasó hace más del margen.
 *   2. `revoked_at` —cuándo se revocó— es más antiguo que la vida máxima de un token
 *      más el margen.
 *
 * La primera basta MIENTRAS se cumpla la invariante de la que depende: que `expires_at`
 * sea el `exp` del token, que es lo que escribe `revokeSession`. La auditoría comprobó que
 * hoy se cumple al segundo, pero también que NADA la verificaba: una fila con un
 * `expires_at` más corto que su token —por un cambio futuro, una importación o un
 * arreglo a mano— se borraría con su token todavía vivo, y ese token volvería a entrar.
 *
 * La segunda condición quita esa dependencia. `revoked_at` lo pone la base al insertar, no
 * el llamante, y un token revocado en el instante T no puede vivir más allá de T + la vida
 * máxima de un token. Así que esperar ese tiempo desde la revocación es seguro AUNQUE
 * `expires_at` estuviera mal. En funcionamiento normal no cambia nada: las dos condiciones
 * se cumplen a la vez y se borra lo mismo que antes.
 */
export async function purgeExpiredRevocations(limit = 1000): Promise<number> {
  const antiguedadMinima = tokenLifetimeSeconds() + MARGEN_SEGUNDOS;
  const result = await execute(
    `DELETE FROM revoked_sessions
      WHERE expires_at < DATE_SUB(NOW(), INTERVAL ? SECOND)
        AND revoked_at < DATE_SUB(NOW(), INTERVAL ? SECOND)
      LIMIT ?`,
    [MARGEN_SEGUNDOS, antiguedadMinima, limit],
  );
  return result.affectedRows;
}
