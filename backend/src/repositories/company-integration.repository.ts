import { execute, query, queryOne } from '../config/database';
import type { IntegrationCategory, IntegrationStatus } from '../services/integration-catalog';

/**
 * Acceso a datos de `company_integrations` (PENDIENTES.md §5). Todo el SQL del módulo vive aquí.
 *
 * El alcance lo resuelve siempre el servicio a partir del usuario autenticado. Aquí se
 * distingue de forma explícita entre una empresa concreta y la **plataforma**
 * (`company_id IS NULL`), que solo el ADMIN puede tocar: las dos consultas están separadas
 * para que un `null` accidental no acabe leyendo o escribiendo la fila equivocada.
 */

export interface CompanyIntegrationRow {
  id: number;
  company_id: number | null;
  provider: string;
  category: IntegrationCategory;
  /** Sobre cifrado tal y como está en la base. Nunca sale del servicio. */
  credentials: string | null;
  status: IntegrationStatus;
  connected_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = 'id, company_id, provider, category, credentials, status, connected_at, created_at, updated_at';

/** Integraciones de una empresa concreta, o de la plataforma si `companyId` es `null`. */
export async function findAllForScope(companyId: number | null): Promise<CompanyIntegrationRow[]> {
  const where = companyId === null ? 'company_id IS NULL' : 'company_id = ?';
  const params = companyId === null ? [] : [companyId];

  return query<CompanyIntegrationRow>(
    `SELECT ${COLUMNS} FROM company_integrations WHERE ${where} ORDER BY provider ASC`,
    params,
  );
}

export async function findForScope(companyId: number | null, provider: string): Promise<CompanyIntegrationRow | null> {
  const where = companyId === null ? 'company_id IS NULL' : 'company_id = ?';
  const params = companyId === null ? [provider] : [companyId, provider];

  return queryOne<CompanyIntegrationRow>(
    `SELECT ${COLUMNS} FROM company_integrations WHERE ${where} AND provider = ? LIMIT 1`,
    params,
  );
}

/**
 * Alta o actualización de la configuración.
 *
 * `company_id` y `provider` forman la identidad de la fila y **nunca se actualizan**: el
 * `ON DUPLICATE KEY` solo toca credenciales, categoría y estado. Así, aunque llegara un
 * `company_id` manipulado, no podría reasignarse una fila existente a otra empresa.
 */
export async function upsert(input: {
  companyId: number | null;
  provider: string;
  category: IntegrationCategory;
  credentials: string | null;
  status: IntegrationStatus;
}): Promise<void> {
  await execute(
    `INSERT INTO company_integrations (company_id, provider, category, credentials, status)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE credentials = VALUES(credentials), category = VALUES(category), status = VALUES(status)`,
    [input.companyId, input.provider, input.category, input.credentials, input.status],
  );
}

/** Cambia el estado. `CONNECTED` sella la fecha; cualquier otro estado la borra. */
export async function updateStatus(
  companyId: number | null,
  provider: string,
  status: IntegrationStatus,
  clearCredentials: boolean,
): Promise<number> {
  const where = companyId === null ? 'company_id IS NULL' : 'company_id = ?';
  const params = companyId === null ? [provider] : [companyId, provider];

  const result = await execute(
    `UPDATE company_integrations
     SET status = ?,
         connected_at = ${status === 'CONNECTED' ? 'NOW()' : 'NULL'}
         ${clearCredentials ? ', credentials = NULL' : ''}
     WHERE ${where} AND provider = ?`,
    [status, ...params],
  );
  return result.affectedRows;
}

export async function remove(companyId: number | null, provider: string): Promise<number> {
  const where = companyId === null ? 'company_id IS NULL' : 'company_id = ?';
  const params = companyId === null ? [provider] : [companyId, provider];

  const result = await execute(`DELETE FROM company_integrations WHERE ${where} AND provider = ?`, params);
  return result.affectedRows;
}
