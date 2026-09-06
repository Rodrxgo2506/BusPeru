import type { Request } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { hasPermission } from '../middleware/permission.middleware';
import * as repository from '../repositories/bank-account.repository';
import type { BankAccount, WritableColumn } from '../repositories/bank-account.repository';
import { ApiError } from '../utils/ApiError';

/**
 * Datos bancarios de la empresa (mockup 36).
 *
 * Reglas de aislamiento, todas resueltas aquí y nunca a partir del cuerpo de la petición:
 *
 *   · La empresa sale de `company_users` del usuario autenticado. Un `company_id` enviado
 *     por el cliente se ignora por completo (no está en las columnas escribibles).
 *   · El ADMIN de la plataforma puede consultar la de cualquier empresa indicándola en
 *     `?company_id=`; para el resto ese parámetro no existe.
 *   · Quien no pertenece a ninguna empresa (p. ej. un CUSTOMER) recibe 403 aunque tenga
 *     `companies.view`: ese permiso existe para el listado público de empresas.
 *   · Escribir exige `companies.update`, que OPERATOR no tiene. No se creó ningún permiso.
 */

/** Deja visibles solo los últimos 4 dígitos: "XXXX XXXX 1234". */
export function maskAccountNumber(value: string | null): string | null {
  if (!value) return value;
  const visible = value.slice(-4);
  return value.length <= 4 ? value : `XXXX XXXX ${visible}`;
}

export interface BankAccountView extends Omit<BankAccount, 'account_number' | 'interbank_code'> {
  account_number: string | null;
  interbank_code: string | null;
  account_number_masked: string | null;
  interbank_code_masked: string | null;
  /** El cliente sabe así si recibió los valores completos o enmascarados. */
  masked: boolean;
}

/**
 * Los números completos solo viajan a quien puede editarlos (`companies.update`).
 * Un OPERATOR con `companies.view` ve la cuenta enmascarada.
 */
function toView(account: BankAccount, full: boolean): BankAccountView {
  return {
    ...account,
    account_number: full ? account.account_number : null,
    interbank_code: full ? account.interbank_code : null,
    account_number_masked: maskAccountNumber(account.account_number),
    interbank_code_masked: maskAccountNumber(account.interbank_code),
    masked: !full,
  };
}

/** Resuelve la empresa sobre la que se opera. Nunca lee `company_id` del cuerpo. */
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
  if (companyId === undefined) {
    throw ApiError.forbidden('Tu usuario no está asociado a ninguna empresa');
  }
  return companyId;
}

function canWrite(req: Request): boolean {
  return hasPermission(req, 'companies.update');
}

export async function list(req: Request, requestedCompanyId?: unknown): Promise<BankAccountView[]> {
  const companyId = resolveCompanyId(req, requestedCompanyId);
  const accounts = await repository.findByCompany(companyId);
  const full = canWrite(req);
  return accounts.map((account) => toView(account, full));
}

export async function history(req: Request, requestedCompanyId?: unknown) {
  const companyId = resolveCompanyId(req, requestedCompanyId);
  return repository.findHistory(companyId, 50);
}

/** Extrae solo las columnas permitidas: cualquier otra clave del cuerpo se descarta. */
function pickWritable(body: Record<string, unknown>): Partial<Record<WritableColumn, unknown>> {
  const data: Partial<Record<WritableColumn, unknown>> = {};
  for (const column of repository.WRITABLE_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(body, column)) data[column] = body[column];
  }
  if (data.is_primary !== undefined) data.is_primary = data.is_primary ? 1 : 0;
  return data;
}

export interface WriteResult {
  account: BankAccountView;
  previous: BankAccount | null;
  companyId: number;
}

export async function create(req: Request, body: Record<string, unknown>): Promise<WriteResult> {
  const companyId = resolveCompanyId(req, body.company_id);
  const data = pickWritable(body);

  const duplicate = await repository.findDuplicate(companyId, String(data.account_number));
  if (duplicate) throw ApiError.conflict('Ya registraste una cuenta con ese número');

  // La primera cuenta de la empresa es siempre la principal.
  if ((await repository.countByCompany(companyId)) === 0) data.is_primary = 1;

  const id = await repository.create(companyId, data);
  const created = await repository.findByIdForCompany(id, companyId);
  if (!created) throw ApiError.internal();

  return { account: toView(created, true), previous: null, companyId };
}

export async function update(req: Request, id: number, body: Record<string, unknown>): Promise<WriteResult> {
  const companyId = resolveCompanyId(req, body.company_id);

  // Si la cuenta es de otra empresa esto devuelve null: se responde 404, no 403, para no
  // confirmar que existe. Es el mismo criterio del resto de la API.
  const previous = await repository.findByIdForCompany(id, companyId);
  if (!previous) throw ApiError.notFound('Cuenta bancaria no encontrada');

  const data = pickWritable(body);
  if (Object.keys(data).length === 0) throw ApiError.badRequest('No se enviaron cambios');

  if (data.account_number !== undefined) {
    const duplicate = await repository.findDuplicate(companyId, String(data.account_number), id);
    if (duplicate) throw ApiError.conflict('Ya registraste una cuenta con ese número');
  }

  // Una empresa no puede degradar su única cuenta principal: quedaría sin cuenta de cobro.
  if (data.is_primary === 0 && previous.is_primary === 1) {
    throw ApiError.badRequest('Marca otra cuenta como principal antes de quitar esta');
  }

  await repository.update(id, companyId, data);
  const updated = await repository.findByIdForCompany(id, companyId);
  if (!updated) throw ApiError.internal();

  return { account: toView(updated, true), previous, companyId };
}

export async function remove(req: Request, id: number): Promise<{ previous: BankAccount; companyId: number }> {
  const companyId = resolveCompanyId(req);

  const previous = await repository.findByIdForCompany(id, companyId);
  if (!previous) throw ApiError.notFound('Cuenta bancaria no encontrada');

  const affected = await repository.remove(id, companyId);
  if (affected === 0) throw ApiError.notFound('Cuenta bancaria no encontrada');

  // Si se borró la principal, la más antigua de las que quedan ocupa su lugar.
  if (previous.is_primary === 1) await repository.promoteOldest(companyId);

  return { previous, companyId };
}
