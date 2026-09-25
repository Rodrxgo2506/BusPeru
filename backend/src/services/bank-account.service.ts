import type { Request } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { hasPermission } from '../middleware/permission.middleware';
import * as repository from '../repositories/bank-account.repository';
import type { BankAccount, StorageColumn, WritableColumn } from '../repositories/bank-account.repository';
import { ApiError } from '../utils/ApiError';
import { logError } from '../utils/logger';
import { decryptJson, encryptJson, isEncryptionConfigured } from './encryption.service';

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

/**
 * F18-07 · CIFRADO DE LOS DATOS BANCARIOS.
 *
 * `account_number` e `interbank_code` se guardan con el mismo mecanismo que las credenciales de
 * integraciones (`encryptJson`: AES-256-GCM, nonce aleatorio de 12 bytes en CADA escritura, sobre
 * versionado, rotación con la clave anterior). No hay un segundo sistema criptográfico.
 *
 * El texto cifrado lleva dentro el campo y la empresa, y al descifrar se exige que coincidan:
 * alguien con acceso de escritura a la base no puede copiar el sobre de una cuenta a otra fila,
 * a otro campo o a otra empresa y hacer que la API lo sirva como propio.
 *
 * Para enmascarar basta con `*_last4`: quien no puede ver el número (OPERATOR) no provoca
 * ningún descifrado. Solo se descifra para quien tiene `companies.update`.
 */
type CampoBancario = 'account_number' | 'interbank_code';

export function encryptBankField(campo: CampoBancario, companyId: number, valor: string): string {
  return encryptJson({ f: campo, c: companyId, value: valor });
}

/** Valor en claro, o `null` si el sobre no descifra, no es de ese campo o no es de esa empresa. */
export function decryptBankField(campo: CampoBancario, companyId: number, sobre: string | null): string | null {
  if (!sobre) return null;
  const datos = decryptJson(sobre);
  if (!datos || datos.f !== campo || Number(datos.c) !== companyId || typeof datos.value !== 'string') return null;
  return datos.value;
}

const ultimos4 = (valor: string | null | undefined): string | null => (valor ? valor.slice(-4) : null);

/** Últimos 4 caracteres: de la columna nueva o, en una fila aún sin migrar, del valor heredado. */
function last4Of(account: BankAccount, campo: CampoBancario): string | null {
  return account[`${campo}_last4`] ?? ultimos4(account[campo]);
}

/** Enmascarado a partir de los 4 últimos caracteres, sin descifrar nada. */
export function maskedOf(account: BankAccount, campo: CampoBancario): string | null {
  const last4 = last4Of(account, campo);
  return last4 ? `XXXX XXXX ${last4}` : null;
}

/** Resultado de leer un campo: su valor, o la marca de que existe pero no se puede leer. */
function leerCampo(account: BankAccount, campo: CampoBancario): { valor: string | null; ilegible: boolean } {
  const sobre = account[`${campo}_encrypted`];
  if (sobre) {
    const valor = decryptBankField(campo, account.company_id, sobre);
    return { valor, ilegible: valor === null };
  }
  // Fila anterior a la 019 que todavía no pasó por `bank:encrypt`: se sirve su valor heredado.
  return { valor: account[campo], ilegible: false };
}

type ColumnasInternas = 'account_number_encrypted' | 'interbank_code_encrypted' | 'account_number_last4' | 'interbank_code_last4';

export interface BankAccountView extends Omit<BankAccount, 'account_number' | 'interbank_code' | ColumnasInternas> {
  account_number: string | null;
  interbank_code: string | null;
  account_number_masked: string | null;
  interbank_code_masked: string | null;
  /** El cliente sabe así si recibió los valores completos o enmascarados. */
  masked: boolean;
  /** F18-07 · el dato existe pero no se pudo descifrar (clave rotada sin la anterior, o sobre manipulado). */
  unreadable?: boolean;
}

/**
 * Los números completos solo viajan a quien puede editarlos (`companies.update`).
 * Un OPERATOR con `companies.view` ve la cuenta enmascarada. Ni el sobre cifrado ni las columnas
 * internas salen nunca de la API.
 */
function toView(account: BankAccount, full: boolean): BankAccountView {
  const {
    account_number_encrypted: _sobreCuenta,
    interbank_code_encrypted: _sobreCci,
    account_number_last4: _ultimosCuenta,
    interbank_code_last4: _ultimosCci,
    ...visible
  } = account;
  const vista: BankAccountView = {
    ...visible,
    account_number: null,
    interbank_code: null,
    account_number_masked: maskedOf(account, 'account_number'),
    interbank_code_masked: maskedOf(account, 'interbank_code'),
    masked: !full,
  };
  if (!full) return vista;

  const cuenta = leerCampo(account, 'account_number');
  const cci = leerCampo(account, 'interbank_code');
  vista.account_number = cuenta.valor;
  vista.interbank_code = cci.valor;
  if (cuenta.ilegible || cci.ilegible) {
    vista.unreadable = true;
    // Solo identificadores: ni el sobre ni ningún valor van al registro.
    logError('Una cuenta bancaria no se puede descifrar', new Error(`sobre ilegible en la cuenta ${account.id}`), { companyId: account.company_id });
  }
  return vista;
}

/**
 * Convierte los campos de la petición en columnas de almacenamiento: el valor cifrado y sus
 * 4 últimos caracteres, y la columna en claro a NULL. Sin clave configurada NO se guarda nada:
 * antes que escribir un número de cuenta en claro, la operación falla con 503.
 */
function toStorage(companyId: number, data: Partial<Record<WritableColumn, unknown>>): Partial<Record<StorageColumn, unknown>> {
  const salida: Partial<Record<StorageColumn, unknown>> = {};
  for (const [columna, valor] of Object.entries(data) as Array<[WritableColumn, unknown]>) {
    if (columna === 'account_number' || columna === 'interbank_code') continue;
    salida[columna] = valor;
  }
  for (const campo of ['account_number', 'interbank_code'] as const) {
    if (data[campo] === undefined) continue;
    const valor = data[campo] === null || data[campo] === '' ? null : String(data[campo]);
    if (valor !== null && !isEncryptionConfigured()) {
      throw ApiError.serviceUnavailable('El cifrado de datos bancarios no está configurado en este servidor');
    }
    salida[campo] = null;
    salida[`${campo}_encrypted`] = valor === null ? null : encryptBankField(campo, companyId, valor);
    salida[`${campo}_last4`] = ultimos4(valor);
  }
  return salida;
}

/**
 * ¿Ya tiene la empresa una cuenta con ese número? Antes era `WHERE account_number = ?`, que no
 * funciona sobre texto cifrado (cada escritura produce un sobre distinto). Una empresa tiene muy
 * pocas cuentas, así que se comparan en memoria, descifradas en el servidor, sin necesidad de un
 * índice ciego. Una cuenta que no se pueda descifrar no bloquea el alta.
 */
async function isDuplicate(companyId: number, numero: string, excludeId?: number): Promise<boolean> {
  const cuentas = await repository.findByCompany(companyId);
  return cuentas.some((c) => c.id !== excludeId && leerCampo(c, 'account_number').valor === numero);
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

  if (await isDuplicate(companyId, String(data.account_number))) throw ApiError.conflict('Ya registraste una cuenta con ese número');

  // La primera cuenta de la empresa es siempre la principal.
  if ((await repository.countByCompany(companyId)) === 0) data.is_primary = 1;

  const id = await repository.create(companyId, toStorage(companyId, data));
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

  if (data.account_number !== undefined && (await isDuplicate(companyId, String(data.account_number), id))) {
    throw ApiError.conflict('Ya registraste una cuenta con ese número');
  }

  // Una empresa no puede degradar su única cuenta principal: quedaría sin cuenta de cobro.
  if (data.is_primary === 0 && previous.is_primary === 1) {
    throw ApiError.badRequest('Marca otra cuenta como principal antes de quitar esta');
  }

  await repository.update(id, companyId, toStorage(companyId, data));
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
