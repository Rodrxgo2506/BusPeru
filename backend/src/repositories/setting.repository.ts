import { query, queryOne } from '../config/database';

/**
 * Acceso a datos de `system_settings` (auditoría BP-13). Todo el SQL de lectura vive aquí.
 *
 * La configuración es GLOBAL: la tabla no tiene `company_id` ni ninguna otra dimensión, y
 * la clave es única. No hay forma de que una empresa o un usuario obtenga una fila distinta,
 * porque no existe tal fila.
 */

export interface SettingRow {
  setting_key: string;
  setting_value: string | null;
  setting_type: 'STRING' | 'INTEGER' | 'DECIMAL' | 'BOOLEAN' | 'JSON';
}

/** Una configuración por su clave, o `null` si no está definida. */
export async function findByKey(key: string): Promise<SettingRow | null> {
  return queryOne<SettingRow>(
    'SELECT setting_key, setting_value, setting_type FROM system_settings WHERE setting_key = ? LIMIT 1',
    [key],
  );
}

/** Configuraciones marcadas como públicas, para el endpoint abierto. */
export async function findPublic(): Promise<SettingRow[]> {
  return query<SettingRow>(
    'SELECT setting_key, setting_value, setting_type FROM system_settings WHERE is_public = 1',
  );
}
