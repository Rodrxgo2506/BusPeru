import type { Request } from 'express';
import { execute } from '../config/database';
import { logError } from '../utils/logger';

/**
 * Claves que nunca se guardan en `audit_logs`. Los datos bancarios se añaden aquí: el
 * historial registra quién, cuándo y sobre qué cuenta, pero no el número ni el CCI.
 */
const SENSITIVE_KEYS = new Set([
  'password', 'password_hash', 'passwordConfirmation', 'token', 'key_hash', 'cvv', 'card_number',
  'account_number', 'interbank_code',
  // Credenciales de integraciones (§5): el historial guarda qué campos se tocaron, nunca su valor.
  'credentials', 'public_key', 'private_key', 'secret_key', 'api_key', 'access_key',
  'access_token', 'client_secret', 'webhook_secret',
]);

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: number | null;
  description?: string;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  /**
   * Autor de la acción cuando todavía no está en `req.user`: es el caso del inicio de
   * sesión, donde el usuario acaba de autenticarse en esa misma petición.
   */
  actorId?: number | null;
}

function redact(values: Record<string, unknown> | null | undefined): string | null {
  if (!values) return null;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (SENSITIVE_KEYS.has(key)) continue;
    safe[key] = value;
  }
  return JSON.stringify(safe);
}

/** Audit failures must never break the operation being audited. */
export async function recordAudit(req: Request, input: AuditInput): Promise<void> {
  try {
    await execute(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description, old_values, new_values, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.actorId ?? req.user?.id ?? null,
        input.action,
        input.entityType,
        input.entityId ?? null,
        input.description?.slice(0, 500) ?? null,
        redact(input.oldValues),
        redact(input.newValues),
        (req.ip ?? '').slice(0, 45) || null,
        (req.headers?.['user-agent'] ?? '').toString().slice(0, 500) || null,
      ],
    );
  } catch (error) {
    // H-31: por el registrador saneado; el objeto de error de mysql2 lleva la sentencia con valores.
    logError('No se pudo registrar la auditoría', error);
  }
}
