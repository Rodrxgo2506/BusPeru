import { execute, query, queryOne } from '../config/database';

/**
 * Acceso a datos de `api_keys` para la AUTENTICACIÓN (auditoría BP-11). Todo el SQL del
 * mecanismo vive aquí; la gestión (alta, listado, revocación) sigue en `apikey.routes.ts`
 * y no se ha tocado.
 *
 * La búsqueda va por `key_hash`, que tiene índice único: nunca se recorre la tabla ni se
 * compara clave por clave.
 */

export interface ApiKeyRow {
  id: number;
  company_id: number | null;
  name: string;
  key_hash: string;
  environment: 'TEST' | 'PRODUCTION';
  /** JSON tal cual está en la base. `null` significa «sin restricción declarada». */
  permissions: string | null;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  expires_at: string | null;
  company_status: string | null;
}

/**
 * Candidatas cuyo prefijo coincide con el de la clave presentada.
 *
 * Se busca por `key_prefix`, que tiene índice y NO es secreto —se muestra en los listados—,
 * y la comparación del hash la hace después el servicio en tiempo constante. Buscar
 * directamente por `key_hash` delegaría esa comparación en el índice de la base.
 *
 * Devuelve varias filas a propósito: `key_prefix` no es único en el esquema (solo lo es
 * `key_hash`), así que dos llaves podrían compartir prefijo y hay que mirarlas todas.
 *
 * Se devuelven aunque estén revocadas o caducadas: quien decide es el servicio, para que
 * todos los motivos de rechazo den exactamente la misma respuesta y no se pueda distinguir
 * «no existe» de «está revocada».
 */
export async function findByPrefix(keyPrefix: string): Promise<ApiKeyRow[]> {
  return query<ApiKeyRow>(
    `SELECT ak.id, ak.company_id, ak.name, ak.key_hash, ak.environment, ak.permissions, ak.status,
            ak.expires_at, co.status AS company_status
     FROM api_keys ak
     LEFT JOIN companies co ON co.id = ak.company_id
     WHERE ak.key_prefix = ?`,
    [keyPrefix],
  );
}

/**
 * Permisos que puede llegar a tener una llave de empresa: los del rol COMPANY_ADMIN.
 *
 * Es el techo de lo que una empresa puede hacer en la plataforma, así que sirve de límite
 * superior para cualquier credencial suya. Se lee de `role_permissions`, de modo que si un
 * ADMIN cambia el reparto de permisos, el techo de las llaves cambia con él.
 */
export async function companyPermissionBaseline(): Promise<string[]> {
  const rows = await query<{ name: string }>(
    `SELECT p.name
     FROM roles r
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE r.name = 'COMPANY_ADMIN'
     ORDER BY p.name`,
  );
  return rows.map((row) => row.name);
}

/**
 * Marca el uso de la llave.
 *
 * Se limita a una escritura por minuto y por llave: sin esa condición cada petición
 * autenticada haría un UPDATE, que es mucho tráfico de escritura para un dato que solo
 * sirve de referencia operativa. Va por clave primaria y sin transacción.
 */
export async function touchLastUsed(id: number): Promise<void> {
  await execute(
    `UPDATE api_keys SET last_used_at = NOW()
     WHERE id = ? AND (last_used_at IS NULL OR last_used_at < DATE_SUB(NOW(), INTERVAL 60 SECOND))`,
    [id],
  );
}
