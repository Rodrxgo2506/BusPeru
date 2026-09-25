import './helpers/testEnv';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execute, query, queryOne } from '../config/database';
import { env } from '../config/env';
import { decryptBankField, encryptBankField } from '../services/bank-account.service';
import * as migracion from '../services/bank-account-migration.service';
import { get, post, put } from './helpers/api';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * F18-07 · cifrado de los datos bancarios de las empresas (migración 019).
 *
 * `account_number` e `interbank_code` pasan a guardarse con el mecanismo ya existente de las
 * credenciales de integraciones (AES-256-GCM, nonce aleatorio, sobre versionado, rotación con la
 * clave anterior). Aquí se defiende que el valor en claro no llegue nunca a la base, a los
 * registros ni a la auditoría; que solo lo descifre quien puede editar la cuenta; y que la
 * migración de las filas existentes sea verificable y reversible.
 *
 * Los números de cuenta son inventados y las claves, aleatorias y solo en memoria. `.env` no se
 * toca y ninguna prueba imprime una clave, un sobre o un número completo.
 */

const RUTA = '/company/bank-accounts';
const CUENTA = '193-7654321-0-45';
const CCI = '00219300765432104512';
const CUERPO = {
  bank_name: 'Banco de prueba F18-07',
  account_type: 'CHECKING',
  currency: 'PEN',
  account_number: CUENTA,
  interbank_code: CCI,
  holder_name: 'Empresa A SAC',
  holder_document: '20111111111',
};
const CLAVE_A = crypto.randomBytes(32).toString('base64');
const CLAVE_B = crypto.randomBytes(32).toString('base64');

function usarClaves(vigente: string, anterior = ''): void {
  (env.integrations as { encryptionKey: string }).encryptionKey = vigente;
  (env.integrations as { previousEncryptionKey: string }).previousEncryptionKey = anterior;
}

interface FilaBanco {
  id: number;
  company_id: number;
  account_number: string | null;
  interbank_code: string | null;
  account_number_encrypted: string | null;
  interbank_code_encrypted: string | null;
  account_number_last4: string | null;
  interbank_code_last4: string | null;
}
const fila = (id: number) => queryOne<FilaBanco>('SELECT * FROM company_bank_accounts WHERE id = ?', [id]);
const sobre = (texto: string) => JSON.parse(texto) as { v: number; alg: string; iv: string; tag: string; data: string };

/** Captura todo lo que la aplicación escribe por consola mientras dura la acción. */
async function capturar(accion: () => Promise<void>): Promise<string> {
  const lineas: string[] = [];
  const originales = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const anotar = (...args: unknown[]) => { lineas.push(args.map(String).join(' ')); };
  console.log = anotar; console.error = anotar; console.warn = anotar; console.info = anotar;
  try { await accion(); } finally { Object.assign(console, originales); }
  return lineas.join('\n');
}

describe('F18-07 · cifrado de los datos bancarios', () => {
  let ctx: SuiteContext;
  let claveOriginal = '';
  let anteriorOriginal = '';

  before(async () => {
    ctx = await prepareSuite();
    claveOriginal = env.integrations.encryptionKey;
    anteriorOriginal = env.integrations.previousEncryptionKey;
  });
  after(async () => {
    usarClaves(claveOriginal, anteriorOriginal);
    await teardownSuite();
  });
  beforeEach(async () => {
    usarClaves(CLAVE_A);
    await execute('DELETE FROM company_bank_accounts');
    await execute("DELETE FROM audit_logs WHERE entity_type = 'company_bank_accounts'");
  });

  const alta = async (cuerpo: Record<string, unknown> = CUERPO, token = ctx.sessions.companyAdmin.token) => {
    const r = await post(RUTA, cuerpo, token);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return Number(r.body.data.id);
  };

  /* ------------------------------------------------------------------ almacenamiento */
  describe('almacenamiento', () => {
    it('1 · el texto en claro nunca llega a la base', async () => {
      const id = await alta();
      const f = (await fila(id))!;
      assert.equal(f.account_number, null, 'la columna en claro queda vacía');
      assert.equal(f.interbank_code, null);
      assert.ok(f.account_number_encrypted && f.interbank_code_encrypted, 'hay sobre cifrado');
      const todo = JSON.stringify(f);
      assert.ok(!todo.includes(CUENTA) && !todo.includes(CCI), 'ningún campo de la fila contiene el valor');
      assert.ok(!todo.includes('7654321'), 'ni un fragmento significativo');
      assert.equal(f.account_number_last4, '0-45');
      assert.equal(f.interbank_code_last4, '4512');
      const s = sobre(f.account_number_encrypted!);
      assert.equal(s.alg, 'AES-256-GCM'); assert.equal(s.v, 1);
    });

    it('2 · cada escritura produce un texto cifrado distinto, aun con el mismo valor', async () => {
      const id = await alta();
      const antes = (await fila(id))!.account_number_encrypted;
      assert.equal((await put(`${RUTA}/${id}`, { account_number: CUENTA }, ctx.sessions.companyAdmin.token)).status, 200);
      const despues = (await fila(id))!.account_number_encrypted;
      assert.notEqual(antes, despues);
      assert.equal(decryptBankField('account_number', ctx.fixtures.companyA, despues), CUENTA);
    });

    it('3 · el nonce (IV) es único en cada cifrado', () => {
      const ivs = new Set<string>();
      for (let i = 0; i < 200; i += 1) ivs.add(sobre(encryptBankField('account_number', 1, CUENTA)).iv);
      assert.equal(ivs.size, 200);
      assert.equal(Buffer.from([...ivs][0]!, 'base64').length, 12, 'IV de 96 bits (GCM)');
    });

    it('4 · la etiqueta GCM valida y el sobre descifra a su valor', () => {
      const s = encryptBankField('interbank_code', 7, CCI);
      assert.equal(decryptBankField('interbank_code', 7, s), CCI);
    });

    it('14 · asignación masiva: no se pueden escribir el sobre, los últimos 4 ni la empresa', async () => {
      const id = await alta({ ...CUERPO, account_number_encrypted: '{"v":1}', account_number_last4: '9999', company_id: ctx.fixtures.companyB });
      const f = (await fila(id))!;
      assert.equal(Number(f.company_id), ctx.fixtures.companyA, 'la empresa sale de la sesión');
      assert.equal(f.account_number_last4, '0-45', 'last4 lo calcula el servidor');
      assert.equal(decryptBankField('account_number', ctx.fixtures.companyA, f.account_number_encrypted), CUENTA);
    });

    it('sin clave configurada NO se guarda nada: 503 antes que texto en claro', async () => {
      usarClaves('');
      const r = await post(RUTA, CUERPO, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 503);
      assert.equal((await query('SELECT id FROM company_bank_accounts')).length, 0);
    });

    it('el duplicado se sigue detectando aunque el número esté cifrado', async () => {
      await alta();
      const r = await post(RUTA, { ...CUERPO, bank_name: 'Otro' }, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 409);
      const otraEmpresa = await post(RUTA, { ...CUERPO, holder_name: 'Empresa B SAC' }, ctx.sessions.companyAdminB.token);
      assert.equal(otraEmpresa.status, 201, 'el mismo número en otra empresa no es duplicado');
    });
  });

  /* ------------------------------------------------------------------ integridad */
  describe('integridad del sobre', () => {
    const leerComoAdmin = async () => (await get(RUTA, ctx.sessions.companyAdmin.token)).body.data[0];

    it('5 · un sobre manipulado no descifra: la API no sirve un valor y lo marca ilegible', async () => {
      const id = await alta();
      const s = sobre((await fila(id))!.account_number_encrypted!);
      const datos = Buffer.from(s.data, 'base64'); datos[0] = datos[0]! ^ 0xff;
      await execute('UPDATE company_bank_accounts SET account_number_encrypted = ? WHERE id = ?', [JSON.stringify({ ...s, data: datos.toString('base64') }), id]);
      const v = await leerComoAdmin();
      assert.equal(v.account_number, null);
      assert.equal(v.unreadable, true);
      assert.equal(v.account_number_masked, 'XXXX XXXX 0-45', 'el enmascarado sigue disponible');
      assert.equal(v.interbank_code, CCI, 'el otro campo, intacto, sí se lee');
    });

    it('5b · el sobre de otra empresa o de otro campo no se acepta (vinculación al contexto)', async () => {
      const id = await alta();
      const ajeno = encryptBankField('account_number', ctx.fixtures.companyB, '999-1111111-0-11');
      await execute('UPDATE company_bank_accounts SET account_number_encrypted = ? WHERE id = ?', [ajeno, id]);
      assert.equal((await leerComoAdmin()).account_number, null, 'sobre de la empresa B pegado en la A');
      const cci = (await fila(id))!.interbank_code_encrypted;
      await execute('UPDATE company_bank_accounts SET account_number_encrypted = ? WHERE id = ?', [cci, id]);
      assert.equal((await leerComoAdmin()).account_number, null, 'sobre del CCI pegado en el número');
    });

    it('6 · una versión de sobre desconocida no se abre', async () => {
      const id = await alta();
      const s = sobre((await fila(id))!.account_number_encrypted!);
      await execute('UPDATE company_bank_accounts SET account_number_encrypted = ? WHERE id = ?', [JSON.stringify({ ...s, v: 2 }), id]);
      assert.equal((await leerComoAdmin()).account_number, null);
    });

    it('F18-07A · una etiqueta GCM alterada no descifra, aunque el texto cifrado esté intacto', async () => {
      const id = await alta();
      const s = sobre((await fila(id))!.account_number_encrypted!);
      const etiqueta = Buffer.from(s.tag, 'base64'); etiqueta[0] = etiqueta[0]! ^ 0x01;
      await execute('UPDATE company_bank_accounts SET account_number_encrypted = ? WHERE id = ?', [JSON.stringify({ ...s, tag: etiqueta.toString('base64') }), id]);
      const v = await leerComoAdmin();
      assert.equal(v.account_number, null);
      assert.equal(v.unreadable, true);
    });

    it('F18-07A · un sobre cifrado con una clave desconocida (ni la vigente ni la anterior) no se abre', async () => {
      const id = await alta();
      usarClaves(crypto.randomBytes(32).toString('base64'));
      const ajeno = encryptBankField('account_number', ctx.fixtures.companyA, CUENTA);
      usarClaves(CLAVE_A, CLAVE_B);
      await execute('UPDATE company_bank_accounts SET account_number_encrypted = ? WHERE id = ?', [ajeno, id]);
      const v = await leerComoAdmin();
      assert.equal(v.account_number, null, 'ninguna de las dos claves configuradas lo abre');
      assert.equal(v.unreadable, true);
      assert.equal(v.interbank_code, CCI, 'el CCI, escrito con la vigente, sí se lee');
    });
  });

  /* ------------------------------------------------------------------ rotación */
  describe('rotación de clave', () => {
    it('7 · 8 · con la clave nueva y la anterior se leen las cuentas viejas; lo nuevo va con la nueva', async () => {
      const id = await alta();                          // escrita con A
      usarClaves(CLAVE_B, CLAVE_A);
      const v = (await get(RUTA, ctx.sessions.companyAdmin.token)).body.data[0];
      assert.equal(v.account_number, CUENTA, 'la clave anterior sigue sirviendo para leer');

      assert.equal((await put(`${RUTA}/${id}`, { account_number: CUENTA }, ctx.sessions.companyAdmin.token)).status, 200);
      usarClaves(CLAVE_B);                              // ya sin la anterior
      assert.equal((await get(RUTA, ctx.sessions.companyAdmin.token)).body.data[0].account_number, CUENTA, 'reescrita con B');
      assert.equal((await get(RUTA, ctx.sessions.companyAdmin.token)).body.data[0].interbank_code, null, 'el CCI sigue con A y ya no se lee');
      usarClaves(CLAVE_A);
      assert.equal(decryptBankField('account_number', ctx.fixtures.companyA, (await fila(id))!.account_number_encrypted), null, 'A no abre lo escrito con B');
    });

    it('F18-07A · rotación completa: vigente → anterior → --recifrar → la anterior se retira y todo se sigue leyendo', async () => {
      const a = await alta();                                                      // cifrada con A
      const b = await alta({ ...CUERPO, account_number: '193-7654321-0-77', interbank_code: null, is_primary: false });
      usarClaves(CLAVE_B, CLAVE_A);                                                // rotación: B vigente, A anterior
      const antes = await migracion.verify();
      assert.equal(antes.conClaveAnterior, 2, 'las dos dependen todavía de la anterior');
      assert.equal(antes.ilegibles, 0);

      assert.deepEqual(await migracion.reencryptWithCurrentKey(), { revisadas: 2, recifradas: 2, yaConLaVigente: 0 });
      assert.deepEqual(await migracion.reencryptWithCurrentKey(), { revisadas: 2, recifradas: 0, yaConLaVigente: 2 }, 'idempotente');
      assert.equal((await migracion.verify()).conClaveAnterior, 0);
      assert.equal((await fila(a))!.account_number_last4, '0-45', 'last4 no cambia');

      usarClaves(CLAVE_B);                                                         // la anterior, retirada
      const vista = (await get(RUTA, ctx.sessions.companyAdmin.token)).body.data as Array<{ id: number; account_number: string; interbank_code: string | null }>;
      assert.equal(vista.find((v) => v.id === a)!.account_number, CUENTA);
      assert.equal(vista.find((v) => v.id === a)!.interbank_code, CCI);
      assert.equal(vista.find((v) => v.id === b)!.account_number, '193-7654321-0-77');
      usarClaves(CLAVE_A);
      assert.equal(decryptBankField('account_number', ctx.fixtures.companyA, (await fila(a))!.account_number_encrypted), null, 'ya no abre con A');
    });

    it('F18-07A · --recifrar se niega si una cuenta no descifra y no re-cifra ninguna', async () => {
      const a = await alta();
      const b = await alta({ ...CUERPO, account_number: '193-7654321-0-77', is_primary: false });
      usarClaves(CLAVE_B, CLAVE_A);
      const s = sobre((await fila(b))!.account_number_encrypted!);
      const datos = Buffer.from(s.data, 'base64'); datos[0] = datos[0]! ^ 0xff;
      await execute('UPDATE company_bank_accounts SET account_number_encrypted = ? WHERE id = ?', [JSON.stringify({ ...s, data: datos.toString('base64') }), b]);
      const sobreDeA = (await fila(a))!.account_number_encrypted;
      await assert.rejects(migracion.reencryptWithCurrentKey(), migracion.BankMigrationError);
      assert.equal((await fila(a))!.account_number_encrypted, sobreDeA, 'la cuenta sana tampoco se tocó');
    });
  });

  /* ------------------------------------------------------------------ acceso */
  describe('quién ve qué', () => {
    it('9 · 10 · OPERATOR recibe solo el enmascarado, sin valor ni sobre, y sin provocar descifrado', async () => {
      await alta();
      usarClaves('');                                  // sin clave: si se descifrara, fallaría
      const r = await get(RUTA, ctx.sessions.operator.token);
      assert.equal(r.status, 200);
      const v = r.body.data[0];
      assert.equal(v.account_number, null); assert.equal(v.interbank_code, null);
      assert.equal(v.account_number_masked, 'XXXX XXXX 0-45');
      assert.equal(v.interbank_code_masked, 'XXXX XXXX 4512');
      assert.equal(v.masked, true);
      assert.equal(v.unreadable, undefined, 'no hubo intento de descifrar');
      const texto = JSON.stringify(r.body);
      assert.ok(!texto.includes(CUENTA) && !texto.includes(CCI));
      assert.ok(!/_encrypted|_last4|AES-256-GCM/.test(texto), 'ni sobre ni columnas internas');
    });

    it('11 · COMPANY_ADMIN de la empresa recibe el valor completo', async () => {
      await alta();
      const v = (await get(RUTA, ctx.sessions.companyAdmin.token)).body.data[0];
      assert.equal(v.account_number, CUENTA); assert.equal(v.interbank_code, CCI); assert.equal(v.masked, false);
      assert.ok(!/_encrypted|_last4/.test(JSON.stringify(v)), 'tampoco para él salen las columnas internas');
    });

    it('F18-07A · el ADMIN de la plataforma descifra la cuenta de una empresa indicándola', async () => {
      await alta();
      const r = await get(`${RUTA}?company_id=${ctx.fixtures.companyA}`, ctx.sessions.admin.token);
      assert.equal(r.status, 200);
      const v = r.body.data[0];
      assert.equal(v.account_number, CUENTA); assert.equal(v.interbank_code, CCI); assert.equal(v.masked, false);
      assert.ok(!/_encrypted|_last4/.test(JSON.stringify(v)));
    });

    it('F18-07A · un CUSTOMER no recibe nada: ni valor, ni enmascarado, ni sobre', async () => {
      await alta();
      for (const ruta of [RUTA, `${RUTA}?company_id=${ctx.fixtures.companyA}`]) {
        const r = await get(ruta, ctx.sessions.customer.token);
        assert.equal(r.status, 403);
        const texto = JSON.stringify(r.body);
        assert.ok(!texto.includes(CUENTA) && !texto.includes(CCI) && !texto.includes('0-45') && !/_encrypted|AES-256-GCM/.test(texto));
      }
    });

    it('COMPANY_ADMIN de otra empresa no ve nada de la A, ni cifrado ni enmascarado', async () => {
      await alta();
      const texto = JSON.stringify((await get(RUTA, ctx.sessions.companyAdminB.token)).body);
      assert.ok(!texto.includes('0-45') && !texto.includes(CUENTA));
    });
  });

  /* ------------------------------------------------------------------ registros y auditoría */
  describe('registros y auditoría', () => {
    it('12 · los registros de la aplicación no contienen el valor ni el sobre', async () => {
      let sobreGuardado = '';
      const salida = await capturar(async () => {
        const id = await alta();
        sobreGuardado = (await fila(id))!.account_number_encrypted!;
        await put(`${RUTA}/${id}`, { account_number: '193-7654321-0-46' }, ctx.sessions.companyAdmin.token);
        await execute('UPDATE company_bank_accounts SET account_number_encrypted = ? WHERE id = ?', ['{"v":1,"alg":"AES-256-GCM","iv":"x","tag":"y","data":"z"}', id]);
        await get(RUTA, ctx.sessions.companyAdmin.token);   // provoca el registro de «ilegible»
      });
      assert.ok(!salida.includes(CUENTA) && !salida.includes('193-7654321-0-46') && !salida.includes(CCI));
      assert.ok(!salida.includes(sobre(sobreGuardado).data), 'ni el texto cifrado');
    });

    it('13 · la auditoría no guarda el valor, el CCI ni el sobre', async () => {
      const id = await alta();
      await put(`${RUTA}/${id}`, { account_number: '193-7654321-0-46', interbank_code: '00219300765432104699' }, ctx.sessions.companyAdmin.token);
      const filas = await query<{ description: string; old_values: string | null; new_values: string | null }>(
        "SELECT description, old_values, new_values FROM audit_logs WHERE entity_type = 'company_bank_accounts'",
      );
      assert.ok(filas.length >= 2);
      const texto = JSON.stringify(filas);
      for (const prohibido of [CUENTA, CCI, '193-7654321-0-46', '00219300765432104699', 'AES-256-GCM', '_encrypted']) {
        assert.ok(!texto.includes(prohibido), `la auditoría contiene ${prohibido.slice(0, 6)}…`);
      }
      assert.match(texto, /XXXX XXXX 0-45/, 'sí el enmascarado');
    });
  });

  /* ------------------------------------------------------------------ migración de filas existentes */
  describe('migración de las filas anteriores a la 019 (bank:encrypt)', () => {
    const legado = (companyId: number, numero: string, cci: string | null) =>
      execute(
        `INSERT INTO company_bank_accounts (company_id, bank_name, account_number, interbank_code, holder_name)
         VALUES (?, 'Banco legado', ?, ?, 'Titular legado')`,
        [companyId, numero, cci],
      ).then((r) => r.insertId);

    it('una fila heredada en claro se sigue leyendo por la API antes de migrarla', async () => {
      await legado(ctx.fixtures.companyA, CUENTA, CCI);
      const v = (await get(RUTA, ctx.sessions.companyAdmin.token)).body.data[0];
      assert.equal(v.account_number, CUENTA);
      assert.equal(v.account_number_masked, 'XXXX XXXX 0-45');
    });

    it('cifrar → verificar → purgar deja solo texto cifrado y la API sigue igual; es idempotente', async () => {
      const a = await legado(ctx.fixtures.companyA, CUENTA, CCI);
      const b = await legado(ctx.fixtures.companyB, '999-2222222-0-22', null);

      const r1 = await migracion.encryptPending();
      assert.deepEqual(r1, { revisadas: 2, cifradas: 2, yaCifradas: 0 });
      assert.equal((await fila(a))!.account_number, CUENTA, 'cifrar NO borra el texto en claro');
      assert.deepEqual(await migracion.encryptPending(), { revisadas: 0, cifradas: 0, yaCifradas: 0 }, 'repetir no hace nada');

      const v = await migracion.verify();
      assert.equal(v.cuentas, 2); assert.equal(v.cifradas, 2); assert.equal(v.sinCifrar, 0); assert.equal(v.ilegibles, 0); assert.equal(v.discrepancias, 0);

      const p = await migracion.purgePlaintext();
      assert.equal(p.vaciadas, 2);
      for (const id of [a, b]) {
        const f = (await fila(id))!;
        assert.equal(f.account_number, null); assert.equal(f.interbank_code, null);
      }
      assert.equal((await get(RUTA, ctx.sessions.companyAdmin.token)).body.data[0].account_number, CUENTA, 'la API lee el cifrado');
      assert.equal((await fila(a))!.account_number_last4, '0-45');
    });

    it('la purga se niega si hay una sola fila sin cifrar o ilegible, y no borra nada', async () => {
      const a = await legado(ctx.fixtures.companyA, CUENTA, CCI);
      await migracion.encryptPending();
      await legado(ctx.fixtures.companyA, '193-3333333-0-33', null);          // otra, sin cifrar
      await assert.rejects(() => migracion.purgePlaintext(), migracion.BankMigrationError);
      assert.equal((await fila(a))!.account_number, CUENTA, 'no se vació ninguna');

      await migracion.encryptPending();
      await execute('UPDATE company_bank_accounts SET account_number_encrypted = ? WHERE id = ?', ['{"v":1,"alg":"AES-256-GCM","iv":"x","tag":"y","data":"z"}', a]);
      await assert.rejects(() => migracion.purgePlaintext(), /ilegibles 1/);
      assert.equal((await fila(a))!.account_number, CUENTA);
    });

    it('revertir repone el texto en claro desde el cifrado (vuelta atrás lógica)', async () => {
      const a = await legado(ctx.fixtures.companyA, CUENTA, CCI);
      await migracion.encryptPending();
      await migracion.purgePlaintext();
      const r = await migracion.revert();
      assert.deepEqual(r, { repuestas: 1, ilegibles: 0 });
      const f = (await fila(a))!;
      assert.equal(f.account_number, CUENTA); assert.equal(f.interbank_code, CCI);
    });

    it('sin clave, la migración se niega en vez de trabajar a medias', async () => {
      await legado(ctx.fixtures.companyA, CUENTA, null);
      usarClaves('');
      await assert.rejects(() => migracion.encryptPending(), migracion.BankMigrationError);
      await assert.rejects(() => migracion.verify(), migracion.BankMigrationError);
    });
  });
});
