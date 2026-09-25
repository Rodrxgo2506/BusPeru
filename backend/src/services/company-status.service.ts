import type { PoolConnection } from 'mysql2/promise';
import { queryOne } from '../config/database';
import type { AuthenticatedUser } from '../types/entities';
import { ApiError } from '../utils/ApiError';

/**
 * Empresa no activa (SUSPENDED, INACTIVE, PENDING o REJECTED) · auditoría 11F, hallazgo H-36.
 *
 * POLÍTICA. Una empresa que no está ACTIVE no puede seguir comercializando, pero conserva su
 * historial y la plataforma la sigue administrando:
 *
 *   BLOQUEADO PARA TODOS (también ADMIN), porque es VENDER:
 *     · crear reservas (ya lo estaba), cobrarlas con tarjeta, registrar o aprobar pagos manuales,
 *       confirmar un pago —incluido el webhook de Culqi, que ante el rechazo abre el compensatorio—
 *       y crear API keys de la empresa (el uso de las existentes ya estaba bloqueado).
 *
 *   BLOQUEADO PARA LOS ROLES DE EMPRESA, porque prepara la venta:
 *     · crear o modificar viajes y configurar o conectar integraciones.
 *     El ADMIN sí puede, para revisar o corregir antes de reactivarla.
 *
 *   PERMITIDO: iniciar sesión y consultar (dashboard, viajes, reservas, pagos, documentos,
 *   cuentas bancarias, conductores), cancelar viajes y reservas —protege al pasajero y abre sus
 *   reembolsos—, procesar reembolsos, desconectar o eliminar integraciones y revocar API keys.
 *   La búsqueda pública ya excluía a las empresas no activas.
 */

const MENSAJE_VENTA = 'Esta empresa no está activa en este momento y no puede vender pasajes.';
const MENSAJE_OPERACION =
  'Tu empresa no está activa: puedes consultar tu información, pero no crear ni modificar viajes, integraciones ni credenciales. Contacta con BusPerú.';

async function estadoEmpresa(companyId: number, connection?: PoolConnection): Promise<string | null> {
  if (connection) {
    const [rows] = await connection.query('SELECT status FROM companies WHERE id = ? LIMIT 1', [companyId]);
    return (rows as Array<{ status: string }>)[0]?.status ?? null;
  }
  return (await queryOne<{ status: string }>('SELECT status FROM companies WHERE id = ? LIMIT 1', [companyId]))?.status ?? null;
}

/** Lanza 409 si la empresa no puede vender. Sirve para cualquier rol. */
export async function assertCompanyCanSell(companyId: number, connection?: PoolConnection): Promise<void> {
  if ((await estadoEmpresa(companyId, connection)) !== 'ACTIVE') throw ApiError.conflict(MENSAJE_VENTA);
}

/** Lanza 403 si un rol de empresa intenta preparar la venta de una empresa no activa. El ADMIN pasa. */
export async function assertCompanyOperable(user: AuthenticatedUser, companyId: number): Promise<void> {
  if (user.role === 'ADMIN') return;
  if ((await estadoEmpresa(companyId)) !== 'ACTIVE') throw ApiError.forbidden(MENSAJE_OPERACION);
}
