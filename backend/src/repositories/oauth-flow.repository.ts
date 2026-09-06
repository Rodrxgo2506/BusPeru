import { execute, queryOne } from '../config/database';
import type { OAuthProvider } from '../services/oauth-provider.service';

/**
 * Acceso a datos de `oauth_flows` (PENDIENTES.md §2). Todo el SQL del módulo vive aquí.
 *
 * La tabla sustituye al almacenamiento en memoria que tenía la primera implementación, de
 * modo que `/start`, `/callback` y `/session` puedan atenderse en instancias distintas del
 * backend y sobrevivir a un reinicio.
 *
 * Los dos consumos son **un único UPDATE condicional** cada uno. Esa es la garantía de
 * atomicidad: InnoDB bloquea la fila, así que de dos peticiones concurrentes con el mismo
 * `state` solo una obtiene `affectedRows = 1`; la otra recibe 0 y se rechaza. No hace falta
 * transacción explícita porque una sentencia única ya es atómica.
 */

export type OAuthMode = 'LOGIN' | 'LINK';
export type OAuthScopeName = 'CUSTOMER' | 'COMPANY' | 'ADMIN';

export interface OAuthFlowRow {
  id: number;
  provider: OAuthProvider;
  scope: OAuthScopeName;
  mode: OAuthMode;
  user_id: number | null;
}

/** Registra un intento. `stateHash` es único: dos flujos nunca comparten state. */
export async function createFlow(input: {
  stateHash: string;
  provider: OAuthProvider;
  scope: OAuthScopeName;
  mode: OAuthMode;
  userId: number | null;
  ttlSeconds: number;
}): Promise<number> {
  const result = await execute(
    `INSERT INTO oauth_flows (state_hash, provider, scope, mode, user_id, expires_at)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [input.stateHash, input.provider, input.scope, input.mode, input.userId, input.ttlSeconds],
  );
  return result.insertId;
}

/**
 * Consume el `state` y devuelve el flujo, o `null` si no existe, ya se usó o caducó.
 *
 * El UPDATE va primero a propósito: quien lo gana es el único que puede seguir. Solo
 * después se lee la fila, que ya está marcada y no puede ganarla nadie más.
 */
export async function consumeState(stateHash: string): Promise<OAuthFlowRow | null> {
  const result = await execute(
    `UPDATE oauth_flows SET state_used_at = NOW()
     WHERE state_hash = ? AND state_used_at IS NULL AND expires_at > NOW()`,
    [stateHash],
  );
  if (result.affectedRows !== 1) return null;

  return queryOne<OAuthFlowRow>(
    'SELECT id, provider, scope, mode, user_id FROM oauth_flows WHERE state_hash = ? LIMIT 1',
    [stateHash],
  );
}

/** Cuelga el ticket del flujo ya autenticado y fija la cuenta a la que pertenece. */
export async function attachTicket(input: {
  id: number;
  ticketHash: string;
  userId: number;
  ttlSeconds: number;
}): Promise<void> {
  await execute(
    `UPDATE oauth_flows
     SET ticket_hash = ?, user_id = ?, ticket_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
     WHERE id = ?`,
    [input.ticketHash, input.userId, input.ttlSeconds, input.id],
  );
}

/** Consume el ticket y devuelve la cuenta, o `null` si no existe, ya se usó o caducó. */
export async function consumeTicket(ticketHash: string): Promise<number | null> {
  const result = await execute(
    `UPDATE oauth_flows SET ticket_used_at = NOW()
     WHERE ticket_hash = ? AND ticket_used_at IS NULL AND ticket_expires_at > NOW()`,
    [ticketHash],
  );
  if (result.affectedRows !== 1) return null;

  const row = await queryOne<{ user_id: number | null }>(
    'SELECT user_id FROM oauth_flows WHERE ticket_hash = ? LIMIT 1',
    [ticketHash],
  );
  return row?.user_id ?? null;
}

/**
 * Purga acotada de flujos caducados. La llama el planificador que ya existe para la
 * expiración de reservas; no se añade ningún proceso periódico nuevo.
 *
 * Filtra por `expires_at`, que tiene índice propio, y limita el trabajo por ejecución: no
 * hay ningún barrido completo, ni aquí ni —sobre todo— en las peticiones.
 */
export async function purgeExpired(limit = 500): Promise<number> {
  const result = await execute(
    'DELETE FROM oauth_flows WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 HOUR) LIMIT ?',
    [limit],
  );
  return result.affectedRows;
}
