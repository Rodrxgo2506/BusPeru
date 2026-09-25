import type { PoolConnection } from 'mysql2/promise';
import { query, withTransaction } from '../config/database';
import { isEncryptedWithCurrentKey, isEncryptionConfigured } from './encryption.service';
import { decryptBankField, encryptBankField } from './bank-account.service';

/**
 * F18-07 · migración de los datos bancarios EXISTENTES a su forma cifrada (migración 019).
 *
 * SQL no puede cifrar —la clave no vive en la base—, así que las filas anteriores a la 019 se
 * convierten aquí, con el mismo `encryptBankField` que usa la API. En cuatro pasos separados, y
 * ninguno imprime ni devuelve un número de cuenta: solo recuentos.
 *
 *   1. `encryptPending`   cifra las filas que aún tienen texto en claro y comprueba cada una
 *                         descifrándola al momento. El texto en claro NO se toca todavía.
 *   2. `verify`           recorre todas las filas: cada sobre debe descifrar, y si la fila aún
 *                         conserva el valor en claro, debe coincidir exactamente.
 *   3. `purgePlaintext`   vacía las columnas en claro SOLO si la verificación sale perfecta, y
 *                         vuelve a comprobar cada fila, bloqueada, justo antes de vaciarla.
 *   4. `revert`           vuelta atrás lógica: repone el valor en claro a partir del cifrado.
 *   5. `reencryptWithCurrentKey` (F18-07A) rotación: vuelve a cifrar con la clave VIGENTE lo que
 *                         aún solo abre con `INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS`, para poder retirarla.
 *
 * Cada fila va en su propia transacción con `FOR UPDATE`: una ejecución a medias deja filas ya
 * convertidas y filas pendientes, nunca una fila a medio escribir, y repetir el paso es seguro.
 */

type Campo = 'account_number' | 'interbank_code';
const CAMPOS: Campo[] = ['account_number', 'interbank_code'];

interface Fila {
  id: number;
  company_id: number;
  account_number: string | null;
  account_number_encrypted: string | null;
  interbank_code: string | null;
  interbank_code_encrypted: string | null;
}

const COLUMNAS = 'id, company_id, account_number, account_number_encrypted, interbank_code, interbank_code_encrypted';

export class BankMigrationError extends Error {}

function exigirClave(): void {
  if (!isEncryptionConfigured()) throw new BankMigrationError('INTEGRATIONS_ENCRYPTION_KEY no está configurada: no se puede cifrar ni verificar');
}

async function filaBloqueada(connection: PoolConnection, id: number): Promise<Fila | undefined> {
  const [filas] = await connection.query(`SELECT ${COLUMNAS} FROM company_bank_accounts WHERE id = ? FOR UPDATE`, [id]);
  return (filas as Fila[])[0];
}

export interface EncryptReport { revisadas: number; cifradas: number; yaCifradas: number }

export async function encryptPending(): Promise<EncryptReport> {
  exigirClave();
  const ids = await query<{ id: number }>(
    `SELECT id FROM company_bank_accounts
     WHERE (account_number IS NOT NULL AND account_number_encrypted IS NULL)
        OR (interbank_code IS NOT NULL AND interbank_code_encrypted IS NULL)
     ORDER BY id`,
  );
  const informe: EncryptReport = { revisadas: ids.length, cifradas: 0, yaCifradas: 0 };
  for (const { id } of ids) {
    const cambio = await withTransaction(async (connection) => {
      const fila = await filaBloqueada(connection, id);
      if (!fila) return false;
      const sets: string[] = [];
      const valores: unknown[] = [];
      for (const campo of CAMPOS) {
        const claro = fila[campo];
        if (claro === null || fila[`${campo}_encrypted`] !== null) continue;
        const sobre = encryptBankField(campo, fila.company_id, claro);
        // Se comprueba ANTES de escribir: si no descifra a su valor exacto, la fila no se toca.
        if (decryptBankField(campo, fila.company_id, sobre) !== claro) {
          throw new BankMigrationError(`la cuenta ${id} no supera la comprobación de ida y vuelta`);
        }
        sets.push(`${campo}_encrypted = ?`, `${campo}_last4 = ?`);
        valores.push(sobre, claro.slice(-4));
      }
      if (sets.length === 0) return false;
      await connection.query(`UPDATE company_bank_accounts SET ${sets.join(', ')} WHERE id = ?`, [...valores, id]);
      return true;
    });
    if (cambio) informe.cifradas += 1;
    else informe.yaCifradas += 1;
  }
  return informe;
}

export interface VerifyReport {
  cuentas: number;
  cifradas: number;
  conTextoPlano: number;
  sinCifrar: number;
  ilegibles: number;
  discrepancias: number;
  /** Cuentas con algún sobre que solo abre la clave anterior: mientras no sea 0, `…_PREVIOUS` no se retira. */
  conClaveAnterior: number;
}

/** Comprueba una fila. Devuelve lo que le falta, sin exponer ningún valor. */
function revisar(fila: Fila): { sinCifrar: boolean; ilegible: boolean; discrepa: boolean; conClaro: boolean; conAnterior: boolean } {
  let sinCifrar = false, ilegible = false, discrepa = false, conClaro = false, conAnterior = false;
  for (const campo of CAMPOS) {
    const claro = fila[campo];
    const sobre = fila[`${campo}_encrypted`];
    if (claro !== null) conClaro = true;
    if (sobre === null) {
      if (claro !== null) sinCifrar = true;
      continue;
    }
    const descifrado = decryptBankField(campo, fila.company_id, sobre);
    if (descifrado === null) ilegible = true;
    else if (claro !== null && descifrado !== claro) discrepa = true;
    if (descifrado !== null && !isEncryptedWithCurrentKey(sobre)) conAnterior = true;
  }
  return { sinCifrar, ilegible, discrepa, conClaro, conAnterior };
}

export async function verify(): Promise<VerifyReport> {
  exigirClave();
  const filas = await query<Fila>(`SELECT ${COLUMNAS} FROM company_bank_accounts ORDER BY id`);
  const informe: VerifyReport = { cuentas: filas.length, cifradas: 0, conTextoPlano: 0, sinCifrar: 0, ilegibles: 0, discrepancias: 0, conClaveAnterior: 0 };
  for (const fila of filas) {
    const r = revisar(fila);
    if (fila.account_number_encrypted !== null) informe.cifradas += 1;
    if (r.conClaro) informe.conTextoPlano += 1;
    if (r.sinCifrar) informe.sinCifrar += 1;
    if (r.ilegible) informe.ilegibles += 1;
    if (r.discrepa) informe.discrepancias += 1;
    if (r.conAnterior) informe.conClaveAnterior += 1;
  }
  return informe;
}

export interface RewrapReport { revisadas: number; recifradas: number; yaConLaVigente: number }

/**
 * F18-07A · rotación de clave: todo sobre que solo abre `INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS` se
 * vuelve a cifrar con la vigente. Se niega de entrada si la verificación encuentra una fila ilegible
 * o con discrepancias; cada fila va bloqueada en su transacción y el sobre nuevo se comprueba (abre con
 * la vigente y da el mismo valor) antes de escribirlo. `last4` y el texto en claro no se tocan.
 */
export async function reencryptWithCurrentKey(): Promise<RewrapReport> {
  const previa = await verify();
  if (previa.ilegibles || previa.discrepancias) {
    throw new BankMigrationError(
      `la verificación no es perfecta (ilegibles ${previa.ilegibles}, discrepancias ${previa.discrepancias}): no se re-cifra ninguna cuenta`,
    );
  }
  const ids = await query<{ id: number }>(
    'SELECT id FROM company_bank_accounts WHERE account_number_encrypted IS NOT NULL OR interbank_code_encrypted IS NOT NULL ORDER BY id',
  );
  const informe: RewrapReport = { revisadas: ids.length, recifradas: 0, yaConLaVigente: 0 };
  for (const { id } of ids) {
    const cambio = await withTransaction(async (connection) => {
      const fila = await filaBloqueada(connection, id);
      if (!fila) return false;
      const sets: string[] = [];
      const valores: unknown[] = [];
      for (const campo of CAMPOS) {
        const sobre = fila[`${campo}_encrypted`];
        if (sobre === null || isEncryptedWithCurrentKey(sobre)) continue;
        const valor = decryptBankField(campo, fila.company_id, sobre);
        if (valor === null) throw new BankMigrationError(`la cuenta ${id} no descifra: se detiene sin tocarla`);
        const nuevo = encryptBankField(campo, fila.company_id, valor);
        if (!isEncryptedWithCurrentKey(nuevo) || decryptBankField(campo, fila.company_id, nuevo) !== valor) {
          throw new BankMigrationError(`la cuenta ${id} no supera la comprobación de ida y vuelta`);
        }
        sets.push(`${campo}_encrypted = ?`);
        valores.push(nuevo);
      }
      if (sets.length === 0) return false;
      await connection.query(`UPDATE company_bank_accounts SET ${sets.join(', ')} WHERE id = ?`, [...valores, id]);
      return true;
    });
    if (cambio) informe.recifradas += 1;
    else informe.yaConLaVigente += 1;
  }
  return informe;
}

export async function purgePlaintext(): Promise<{ vaciadas: number; verificacion: VerifyReport }> {
  const verificacion = await verify();
  if (verificacion.sinCifrar || verificacion.ilegibles || verificacion.discrepancias) {
    throw new BankMigrationError(
      `la verificación no es perfecta (sin cifrar ${verificacion.sinCifrar}, ilegibles ${verificacion.ilegibles}, discrepancias ${verificacion.discrepancias}): no se borra ningún valor en claro`,
    );
  }
  const ids = await query<{ id: number }>('SELECT id FROM company_bank_accounts WHERE account_number IS NOT NULL OR interbank_code IS NOT NULL ORDER BY id');
  let vaciadas = 0;
  for (const { id } of ids) {
    await withTransaction(async (connection) => {
      const fila = await filaBloqueada(connection, id);
      if (!fila) return;
      const r = revisar(fila);
      // Segunda comprobación con la fila bloqueada: entre la verificación y este punto pudo cambiar.
      if (r.sinCifrar || r.ilegible || r.discrepa) throw new BankMigrationError(`la cuenta ${id} cambió durante la purga: se detiene sin tocarla`);
      await connection.query('UPDATE company_bank_accounts SET account_number = NULL, interbank_code = NULL WHERE id = ?', [id]);
      vaciadas += 1;
    });
  }
  return { vaciadas, verificacion };
}

/** Vuelta atrás lógica: repone el valor en claro desde el cifrado. No borra el cifrado. */
export async function revert(): Promise<{ repuestas: number; ilegibles: number }> {
  exigirClave();
  const ids = await query<{ id: number }>('SELECT id FROM company_bank_accounts WHERE account_number_encrypted IS NOT NULL OR interbank_code_encrypted IS NOT NULL ORDER BY id');
  let repuestas = 0, ilegibles = 0;
  for (const { id } of ids) {
    await withTransaction(async (connection) => {
      const fila = await filaBloqueada(connection, id);
      if (!fila) return;
      const valores: Partial<Record<Campo, string>> = {};
      for (const campo of CAMPOS) {
        const sobre = fila[`${campo}_encrypted`];
        if (!sobre) continue;
        const claro = decryptBankField(campo, fila.company_id, sobre);
        if (claro === null) { ilegibles += 1; return; }
        valores[campo] = claro;
      }
      const sets = Object.keys(valores).map((c) => `${c} = ?`);
      if (sets.length === 0) return;
      await connection.query(`UPDATE company_bank_accounts SET ${sets.join(', ')} WHERE id = ?`, [...Object.values(valores), id]);
      repuestas += 1;
    });
  }
  return { repuestas, ilegibles };
}
