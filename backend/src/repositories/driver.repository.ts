import { execute, query, queryOne } from '../config/database';

/**
 * Acceso a datos de `drivers`. Todo el SQL del módulo vive aquí.
 *
 * El `companyId` siempre lo resuelve el servicio a partir del usuario autenticado; el
 * repositorio se limita a acotar cada consulta por él, de modo que un id de otra empresa
 * nunca devuelve ni modifica nada.
 */

export interface Driver {
  id: number;
  company_id: number;
  first_name: string;
  last_name: string;
  document_number: string;
  license_number: string;
  license_expires_at: string | null;
  phone: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: string;
}

export interface DriverRow extends Driver {
  /** Viajes en los que figura como conductor o copiloto. */
  trips_count: number;
}

/** Columnas escribibles desde una petición. `company_id` no está: no es negociable. */
export const WRITABLE_COLUMNS = [
  'first_name',
  'last_name',
  'document_number',
  'license_number',
  'license_expires_at',
  'phone',
  'status',
] as const;

export type WritableColumn = (typeof WRITABLE_COLUMNS)[number];

const SELECT = `SELECT d.*,
    (SELECT COUNT(*) FROM trips t WHERE t.driver_id = d.id OR t.co_driver_id = d.id) AS trips_count
  FROM drivers d`;

export interface ListFilters {
  status?: string;
  search?: string;
}

export async function findByCompany(companyId: number, filters: ListFilters = {}): Promise<DriverRow[]> {
  const conditions = ['d.company_id = ?'];
  const params: unknown[] = [companyId];

  if (filters.status) {
    conditions.push('d.status = ?');
    params.push(filters.status);
  }
  if (filters.search) {
    conditions.push('(d.first_name LIKE ? OR d.last_name LIKE ? OR d.document_number LIKE ? OR d.license_number LIKE ?)');
    params.push(...Array(4).fill(`%${filters.search}%`));
  }

  return query<DriverRow>(
    `${SELECT} WHERE ${conditions.join(' AND ')} ORDER BY d.status ASC, d.last_name ASC, d.first_name ASC, d.id ASC`,
    params,
  );
}

/** Devuelve el conductor solo si pertenece a la empresa indicada. */
export async function findByIdForCompany(id: number, companyId: number): Promise<DriverRow | null> {
  return queryOne<DriverRow>(`${SELECT} WHERE d.id = ? AND d.company_id = ? LIMIT 1`, [id, companyId]);
}

/**
 * Busca el documento en TODA la tabla, no solo en la empresa: el índice `document_number`
 * de la migración es único global. El servicio traduce el hallazgo a un mensaje neutro
 * para no revelar que esa persona está registrada en otra empresa.
 */
export async function findByDocument(documentNumber: string, excludeId?: number): Promise<Driver | null> {
  const params: unknown[] = [documentNumber];
  let sql = 'SELECT * FROM drivers WHERE document_number = ?';
  if (excludeId !== undefined) {
    sql += ' AND id <> ?';
    params.push(excludeId);
  }
  return queryOne<Driver>(`${sql} LIMIT 1`, params);
}

export async function create(companyId: number, data: Partial<Record<WritableColumn, unknown>>): Promise<number> {
  const columns = WRITABLE_COLUMNS.filter((column) => data[column] !== undefined);
  const result = await execute(
    `INSERT INTO drivers (company_id${columns.length ? ', ' + columns.join(', ') : ''})
     VALUES (?${columns.map(() => ', ?').join('')})`,
    [companyId, ...columns.map((column) => data[column])],
  );
  return result.insertId;
}

export async function update(id: number, companyId: number, data: Partial<Record<WritableColumn, unknown>>): Promise<void> {
  const columns = WRITABLE_COLUMNS.filter((column) => data[column] !== undefined);
  if (columns.length === 0) return;

  // El WHERE incluye company_id: un id de otra empresa no actualiza ninguna fila.
  await execute(
    `UPDATE drivers SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ? AND company_id = ?`,
    [...columns.map((column) => data[column]), id, companyId],
  );
}

export async function remove(id: number, companyId: number): Promise<number> {
  const result = await execute('DELETE FROM drivers WHERE id = ? AND company_id = ?', [id, companyId]);
  return result.affectedRows;
}

/** Viajes futuros en los que el conductor sigue asignado. */
export async function countUpcomingTrips(driverId: number): Promise<number> {
  const row = await queryOne<{ total: number }>(
    `SELECT COUNT(*) AS total FROM trips
     WHERE (driver_id = ? OR co_driver_id = ?)
       AND departure_datetime >= NOW()
       AND status NOT IN ('COMPLETED', 'CANCELLED')`,
    [driverId, driverId],
  );
  return Number(row?.total ?? 0);
}

/**
 * Comprueba que un conductor exista, sea de la empresa indicada y esté activo.
 * Lo usa el módulo de viajes antes de asignar tripulación.
 */
export async function findAssignable(id: number, companyId: number): Promise<Driver | null> {
  return queryOne<Driver>(
    "SELECT * FROM drivers WHERE id = ? AND company_id = ? AND status = 'ACTIVE' LIMIT 1",
    [id, companyId],
  );
}
