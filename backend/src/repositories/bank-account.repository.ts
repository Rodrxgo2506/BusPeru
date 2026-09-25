import type { PoolConnection } from 'mysql2/promise';
import { execute, query, queryOne, withTransaction } from '../config/database';

/**
 * Acceso a datos de `company_bank_accounts`. Aquí vive todo el SQL del módulo: ni las
 * rutas ni el servicio construyen consultas.
 *
 * Todos los métodos reciben el `companyId` ya resuelto por el servicio a partir del
 * usuario autenticado. El repositorio nunca decide de qué empresa son los datos, pero
 * siempre acota por `company_id` para que un id de otra empresa no devuelva nada.
 */

export interface BankAccount {
  id: number;
  company_id: number;
  bank_name: string;
  account_type: 'CHECKING' | 'SAVINGS';
  currency: string;
  /**
   * F18-07 · columnas EN CLARO heredadas. La aplicación ya no las escribe (van a NULL); solo
   * conservan valor las filas anteriores a la migración 019 hasta que `bank:encrypt` las cifre.
   */
  account_number: string | null;
  interbank_code: string | null;
  /** Sobre AES-256-GCM (encryption.service). Nunca sale de la API. */
  account_number_encrypted: string | null;
  interbank_code_encrypted: string | null;
  /** Lo único que necesita el enmascarado; no es sensible por sí solo. */
  account_number_last4: string | null;
  interbank_code_last4: string | null;
  holder_name: string;
  holder_document: string | null;
  is_primary: 0 | 1;
  status: 'PENDING' | 'VERIFIED' | 'REJECTED';
  created_at: string;
  updated_at: string;
}

/** Columnas que pueden escribirse desde una petición. `company_id` nunca está aquí. */
export const WRITABLE_COLUMNS = [
  'bank_name',
  'account_type',
  'currency',
  'account_number',
  'interbank_code',
  'holder_name',
  'holder_document',
  'is_primary',
] as const;

export type WritableColumn = (typeof WRITABLE_COLUMNS)[number];

/**
 * F18-07 · columnas que se ESCRIBEN en la tabla. No son las de la petición: el servicio
 * convierte `account_number`/`interbank_code` en su sobre cifrado y sus 4 últimos caracteres,
 * y deja las columnas en claro a NULL. `company_id` tampoco está aquí.
 */
export const STORAGE_COLUMNS = [
  'bank_name',
  'account_type',
  'currency',
  'account_number',
  'account_number_encrypted',
  'account_number_last4',
  'interbank_code',
  'interbank_code_encrypted',
  'interbank_code_last4',
  'holder_name',
  'holder_document',
  'is_primary',
] as const;

export type StorageColumn = (typeof STORAGE_COLUMNS)[number];

const SELECT = 'SELECT * FROM company_bank_accounts';

export async function findByCompany(companyId: number): Promise<BankAccount[]> {
  return query<BankAccount>(
    `${SELECT} WHERE company_id = ? ORDER BY is_primary DESC, created_at ASC, id ASC`,
    [companyId],
  );
}

/** Devuelve la cuenta solo si pertenece a la empresa indicada. */
export async function findByIdForCompany(id: number, companyId: number): Promise<BankAccount | null> {
  return queryOne<BankAccount>(`${SELECT} WHERE id = ? AND company_id = ? LIMIT 1`, [id, companyId]);
}

export async function countByCompany(companyId: number): Promise<number> {
  const row = await queryOne<{ total: number }>(
    'SELECT COUNT(*) AS total FROM company_bank_accounts WHERE company_id = ?',
    [companyId],
  );
  return Number(row?.total ?? 0);
}

/** Solo puede haber una cuenta principal por empresa. */
async function clearPrimary(connection: PoolConnection, companyId: number, exceptId?: number): Promise<void> {
  const params: unknown[] = [companyId];
  let sql = 'UPDATE company_bank_accounts SET is_primary = 0 WHERE company_id = ?';
  if (exceptId !== undefined) {
    sql += ' AND id <> ?';
    params.push(exceptId);
  }
  await connection.query(sql, params);
}

export async function create(companyId: number, data: Partial<Record<StorageColumn, unknown>>): Promise<number> {
  return withTransaction(async (connection) => {
    if (data.is_primary === 1) await clearPrimary(connection, companyId);

    const columns = STORAGE_COLUMNS.filter((column) => data[column] !== undefined);
    const [result] = await connection.query(
      `INSERT INTO company_bank_accounts (company_id${columns.length ? ', ' + columns.join(', ') : ''})
       VALUES (?${columns.map(() => ', ?').join('')})`,
      [companyId, ...columns.map((column) => data[column])],
    );
    return (result as { insertId: number }).insertId;
  });
}

export async function update(id: number, companyId: number, data: Partial<Record<StorageColumn, unknown>>): Promise<void> {
  await withTransaction(async (connection) => {
    if (data.is_primary === 1) await clearPrimary(connection, companyId, id);

    const columns = STORAGE_COLUMNS.filter((column) => data[column] !== undefined);
    if (columns.length === 0) return;

    // El WHERE incluye company_id: aunque llegara un id de otra empresa, no se actualiza nada.
    await connection.query(
      `UPDATE company_bank_accounts SET ${columns.map((column) => `${column} = ?`).join(', ')}
       WHERE id = ? AND company_id = ?`,
      [...columns.map((column) => data[column]), id, companyId],
    );
  });
}

export async function remove(id: number, companyId: number): Promise<number> {
  const result = await execute('DELETE FROM company_bank_accounts WHERE id = ? AND company_id = ?', [id, companyId]);
  return result.affectedRows;
}

/** Asciende la cuenta más antigua a principal cuando se borra la que lo era. */
export async function promoteOldest(companyId: number): Promise<void> {
  const oldest = await queryOne<{ id: number }>(
    'SELECT id FROM company_bank_accounts WHERE company_id = ? ORDER BY created_at ASC, id ASC LIMIT 1',
    [companyId],
  );
  if (oldest) await execute('UPDATE company_bank_accounts SET is_primary = 1 WHERE id = ?', [oldest.id]);
}

export interface HistoryEntry {
  id: number;
  action: string;
  description: string | null;
  created_at: string;
  user_name: string | null;
  user_email: string | null;
}

/**
 * Historial de cambios de las cuentas de la empresa ("Historial de cambios" del mockup).
 * Se lee de `audit_logs`, acotado a las cuentas de esa empresa: no expone la auditoría
 * general de la plataforma ni requiere el permiso `audit_logs.view`.
 */
export async function findHistory(companyId: number, limit: number): Promise<HistoryEntry[]> {
  return query<HistoryEntry>(
    `SELECT al.id, al.action, al.description, al.created_at,
            CONCAT(u.first_name, ' ', u.last_name) AS user_name, u.email AS user_email
     FROM audit_logs al
     LEFT JOIN users u ON u.id = al.user_id
     WHERE al.entity_type = 'company_bank_accounts'
       AND al.entity_id IN (SELECT id FROM company_bank_accounts WHERE company_id = ?)
     ORDER BY al.id DESC
     LIMIT ?`,
    [companyId, limit],
  );
}
