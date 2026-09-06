import type { Request } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import * as repository from '../repositories/driver.repository';
import type { Driver, DriverRow, WritableColumn } from '../repositories/driver.repository';
import { ApiError } from '../utils/ApiError';

/**
 * Conductores y copilotos de la empresa (mockup 31).
 *
 * `drivers` no son usuarios de BusPerú: son personal de la empresa, tal como plantea
 * PENDIENTES.md §4. La tabla no distingue conductor de copiloto; la distinción vive en el
 * viaje (`trips.driver_id` frente a `trips.co_driver_id`), así que cualquier conductor
 * activo puede ocupar cualquiera de los dos puestos.
 *
 * Aislamiento: la empresa sale de `company_users` del usuario autenticado. `company_id`
 * no es una columna escribible, de modo que enviarlo en el cuerpo no cambia nada.
 */

/** Resuelve la empresa sobre la que se opera. Nunca desde el cuerpo de la petición. */
export function resolveCompanyId(req: Request, requestedCompanyId?: unknown): number {
  const user = requireAuth(req);

  if (user.role === 'ADMIN') {
    if (requestedCompanyId === undefined || requestedCompanyId === null || requestedCompanyId === '') {
      const [own] = user.companyIds;
      if (own !== undefined) return own;
      throw ApiError.badRequest('Indica la empresa con el parámetro company_id');
    }
    const companyId = Number(requestedCompanyId);
    if (!Number.isInteger(companyId) || companyId <= 0) throw ApiError.badRequest('company_id inválido');
    return companyId;
  }

  const [companyId] = user.companyIds;
  if (companyId === undefined) throw ApiError.forbidden('Tu usuario no está asociado a ninguna empresa');
  return companyId;
}

function pickWritable(body: Record<string, unknown>): Partial<Record<WritableColumn, unknown>> {
  const data: Partial<Record<WritableColumn, unknown>> = {};
  for (const column of repository.WRITABLE_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(body, column)) data[column] = body[column];
  }
  return data;
}

/**
 * El índice `document_number` es único en toda la tabla, así que un documento de otra
 * empresa también choca. El mensaje es deliberadamente neutro: decir "ya existe en otra
 * empresa" filtraría dónde trabaja esa persona.
 */
async function assertDocumentAvailable(documentNumber: unknown, excludeId?: number): Promise<void> {
  if (documentNumber === undefined) return;
  const existing = await repository.findByDocument(String(documentNumber), excludeId);
  if (existing) throw ApiError.conflict('Ese número de documento ya está registrado');
}

export async function list(req: Request, params: { company_id?: unknown; status?: unknown; search?: unknown }): Promise<DriverRow[]> {
  const companyId = resolveCompanyId(req, params.company_id);
  return repository.findByCompany(companyId, {
    status: params.status === 'ACTIVE' || params.status === 'INACTIVE' ? params.status : undefined,
    search: typeof params.search === 'string' && params.search.trim() !== '' ? params.search.trim() : undefined,
  });
}

export async function detail(req: Request, id: number): Promise<DriverRow> {
  const companyId = resolveCompanyId(req);
  const driver = await repository.findByIdForCompany(id, companyId);
  // 404 y no 403: un 403 confirmaría que el conductor existe en otra empresa.
  if (!driver) throw ApiError.notFound('Conductor no encontrado');
  return driver;
}

export async function create(req: Request, body: Record<string, unknown>): Promise<{ driver: DriverRow; companyId: number }> {
  const companyId = resolveCompanyId(req, body.company_id);
  const data = pickWritable(body);

  await assertDocumentAvailable(data.document_number);

  const id = await repository.create(companyId, data);
  const driver = await repository.findByIdForCompany(id, companyId);
  if (!driver) throw ApiError.internal();

  return { driver, companyId };
}

export async function update(
  req: Request,
  id: number,
  body: Record<string, unknown>,
): Promise<{ driver: DriverRow; previous: DriverRow; companyId: number }> {
  const companyId = resolveCompanyId(req, body.company_id);

  const previous = await repository.findByIdForCompany(id, companyId);
  if (!previous) throw ApiError.notFound('Conductor no encontrado');

  const data = pickWritable(body);
  if (Object.keys(data).length === 0) throw ApiError.badRequest('No se enviaron cambios');

  await assertDocumentAvailable(data.document_number, id);

  // Desactivar a alguien con viajes futuros dejaría esos viajes con tripulación inactiva.
  if (data.status === 'INACTIVE' && previous.status === 'ACTIVE') {
    const upcoming = await repository.countUpcomingTrips(id);
    if (upcoming > 0) {
      throw ApiError.badRequest(
        `No puedes desactivarlo: tiene ${upcoming} viaje(s) por delante. Reasigna la tripulación primero.`,
      );
    }
  }

  await repository.update(id, companyId, data);
  const driver = await repository.findByIdForCompany(id, companyId);
  if (!driver) throw ApiError.internal();

  return { driver, previous, companyId };
}

export async function remove(req: Request, id: number): Promise<{ previous: DriverRow; companyId: number }> {
  const companyId = resolveCompanyId(req);

  const previous = await repository.findByIdForCompany(id, companyId);
  if (!previous) throw ApiError.notFound('Conductor no encontrado');

  const upcoming = await repository.countUpcomingTrips(id);
  if (upcoming > 0) {
    throw ApiError.badRequest(
      `No puedes eliminarlo: tiene ${upcoming} viaje(s) por delante. Reasigna la tripulación primero.`,
    );
  }

  const affected = await repository.remove(id, companyId);
  if (affected === 0) throw ApiError.notFound('Conductor no encontrado');

  return { previous, companyId };
}

/**
 * Valida la tripulación que un viaje quiere asignar. La usa el módulo de viajes antes de
 * escribir, de modo que el `driver_id` que llegue del cliente siempre se comprueba contra
 * la empresa dueña del viaje.
 *
 * @param companyId empresa del viaje, resuelta por el propio módulo de viajes.
 */
export async function assertCrewAssignable(
  companyId: number,
  driverId: number | null | undefined,
  coDriverId: number | null | undefined,
): Promise<void> {
  const check = async (value: number | null | undefined, label: string): Promise<Driver | null> => {
    if (value === undefined || value === null) return null;
    const driver = await repository.findAssignable(value, companyId);
    if (!driver) {
      // Mismo mensaje si no existe, si es de otra empresa o si está inactivo: no se
      // filtra la plantilla de las demás empresas.
      throw ApiError.badRequest(`El ${label} seleccionado no existe, no es de tu empresa o está inactivo`);
    }
    return driver;
  };

  const driver = await check(driverId, 'conductor');
  const coDriver = await check(coDriverId, 'copiloto');

  if (driver && coDriver && driver.id === coDriver.id) {
    throw ApiError.badRequest('El conductor y el copiloto no pueden ser la misma persona');
  }
}
