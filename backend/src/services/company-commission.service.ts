import type { PoolConnection } from 'mysql2/promise';
import { queryOne, withTransaction } from '../config/database';
import { ApiError } from '../utils/ApiError';
import { logError } from '../utils/logger';

/**
 * Comisión de cada empresa (auditoría 11E-0, hallazgo H-46).
 *
 * FUENTE DE VERDAD. La tasa con la que vende una empresa es su fila vigente de
 * `company_commission_settings`. `platform.default_commission` NO se consulta al vender: solo se
 * COPIA a la empresa cuando el ADMIN la aprueba (pasa a ACTIVE). Cambiar después el valor por
 * defecto no toca a las empresas existentes; una empresa aprobada más tarde recibe el vigente.
 *
 * SIN CONFIGURACIÓN NO SE VENDE. Antes, una empresa activa sin fila vendía con comisión 0 en
 * silencio. Ahora la venta se bloquea con un error controlado —sin detalles internos para el
 * cliente— y el caso queda registrado en el log para diagnóstico.
 */

export interface CompanyCommission {
  commission_type: 'PERCENTAGE' | 'FIXED';
  /** Texto decimal exacto, tal como lo guarda la base ("12.50"). */
  commission_value: string;
}

const DEFAULT_COMMISSION_KEY = 'platform.default_commission';
/** Porcentaje con hasta dos decimales: lo que admite `commission_value DECIMAL(10,2)`. */
const PORCENTAJE_VALIDO = /^\d{1,3}(\.\d{1,2})?$/;
const IMPORTE_VALIDO = /^\d{1,8}(\.\d{1,2})?$/;

const MENSAJE_VENTA_BLOQUEADA = 'Esta empresa no puede vender pasajes en este momento. Inténtalo más tarde o contacta con soporte.';

function porcentajeValido(texto: string): boolean {
  return PORCENTAJE_VALIDO.test(texto) && Number(texto) <= 100;
}

/**
 * Tasa vigente de la empresa, leída en la conexión de la operación. Lanza 409 si no hay una fila
 * ACTIVE y en vigor, o si la que hay no es interpretable: nunca se vende asumiendo 0.
 */
export async function loadCompanyCommission(connection: PoolConnection, companyId: number): Promise<CompanyCommission> {
  const [rows] = await connection.query(
    `SELECT id, commission_type, CAST(commission_value AS CHAR) AS commission_value FROM company_commission_settings
     WHERE company_id = ? AND status = 'ACTIVE'
       AND effective_from <= NOW() AND (effective_until IS NULL OR effective_until >= NOW())
     ORDER BY effective_from DESC, id DESC LIMIT 1`,
    [companyId],
  );
  const fila = (rows as Array<{ id: number; commission_type: string; commission_value: string }>)[0];

  if (!fila) {
    logError('Venta bloqueada: empresa sin configuración de comisión vigente', new Error('company_commission_settings sin fila vigente'), {
      companyId,
    });
    throw ApiError.conflict(MENSAJE_VENTA_BLOQUEADA);
  }
  const valor = String(fila.commission_value).trim();
  const valida =
    (fila.commission_type === 'PERCENTAGE' && porcentajeValido(valor)) || (fila.commission_type === 'FIXED' && IMPORTE_VALIDO.test(valor));
  if (!valida) {
    logError('Venta bloqueada: la configuración de comisión de la empresa no es válida', new Error(`tipo ${fila.commission_type}`), {
      companyId,
    });
    throw ApiError.conflict(MENSAJE_VENTA_BLOQUEADA);
  }
  return { commission_type: fila.commission_type === 'FIXED' ? 'FIXED' : 'PERCENTAGE', commission_value: valor };
}

/**
 * `platform.default_commission` como porcentaje exacto en texto. Lanza 409 si falta o no es un
 * porcentaje válido: aprobar una empresa con una tasa inventada produciría balances incorrectos.
 */
export async function readDefaultCommissionPercent(): Promise<string> {
  const fila = await queryOne<{ setting_value: string | null; setting_type: string }>(
    'SELECT setting_value, setting_type FROM system_settings WHERE setting_key = ? LIMIT 1',
    [DEFAULT_COMMISSION_KEY],
  );
  const valor = fila?.setting_value?.trim() ?? '';
  if (!fila || !['DECIMAL', 'INTEGER', 'STRING'].includes(fila.setting_type) || !porcentajeValido(valor)) {
    logError('No se puede inicializar la comisión de una empresa: platform.default_commission falta o no es válida', new Error('configuración inválida'), {});
    throw ApiError.conflict('La comisión por defecto de la plataforma no está configurada correctamente. Corrígela antes de aprobar empresas.');
  }
  return valor;
}

/** ¿Tiene la empresa alguna configuración de comisión ACTIVE? Una reactivación conserva la suya. */
async function tieneConfiguracion(connection: PoolConnection | null, companyId: number): Promise<boolean> {
  const sql = "SELECT id FROM company_commission_settings WHERE company_id = ? AND status = 'ACTIVE' LIMIT 1";
  if (connection) {
    const [rows] = await connection.query(sql, [companyId]);
    return (rows as unknown[]).length > 0;
  }
  return (await queryOne(sql, [companyId])) !== null;
}

/**
 * Antes de activar una empresa: si todavía no tiene tasa, el valor por defecto tiene que ser
 * utilizable. Así la aprobación falla ANTES de escribir nada en vez de dejar una empresa activa
 * que no puede vender.
 */
export async function assertCommissionCanBeInitialized(companyId: number | null): Promise<void> {
  if (companyId !== null && (await tieneConfiguracion(null, companyId))) return;
  await readDefaultCommissionPercent();
}

/**
 * Copia `platform.default_commission` a la empresa si no tiene configuración. Idempotente y
 * seguro ante dos aprobaciones simultáneas: se serializa sobre la fila de la empresa.
 * Devuelve la tasa copiada, o `null` si la empresa ya tenía la suya (no se sobrescribe).
 */
export async function ensureCompanyCommission(companyId: number): Promise<string | null> {
  return withTransaction(async (connection) => {
    await connection.query('SELECT id FROM companies WHERE id = ? LIMIT 1 FOR UPDATE', [companyId]);
    if (await tieneConfiguracion(connection, companyId)) return null;
    const porcentaje = await readDefaultCommissionPercent();
    await connection.query(
      `INSERT INTO company_commission_settings (company_id, commission_type, commission_value, effective_from, status)
       VALUES (?, 'PERCENTAGE', ?, NOW(), 'ACTIVE')`,
      [companyId, porcentaje],
    );
    return porcentaje;
  });
}
