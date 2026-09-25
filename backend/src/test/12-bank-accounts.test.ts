import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execute, query, queryOne } from '../config/database';
import { env } from '../config/env';
import { encryptBankField } from '../services/bank-account.service';
import { del, get, post, put } from './helpers/api';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * Datos bancarios de la empresa (mockup 36).
 *
 * El foco es el aislamiento multiempresa: la empresa sale siempre de `company_users` del
 * usuario autenticado y nunca del cuerpo o de la query de la petición.
 */
describe('Datos bancarios de la empresa', () => {
  let ctx: SuiteContext;

  const RUTA = '/company/bank-accounts';

  const CUENTA_VALIDA = {
    bank_name: 'Banco de Crédito del Perú',
    account_type: 'CHECKING',
    currency: 'PEN',
    account_number: '193-2456789-0-12',
    interbank_code: '00219300245678901256',
    holder_name: 'Empresa A SAC',
    holder_document: '20111111111',
  };

  // F18-07 · los datos bancarios se guardan cifrados: la suite necesita una clave, que vive solo
  // en la memoria de este proceso (mismo criterio que 18-company-integrations). `.env` no se toca.
  let claveOriginal = '';

  before(async () => {
    ctx = await prepareSuite();
    claveOriginal = env.integrations.encryptionKey;
    (env.integrations as { encryptionKey: string }).encryptionKey = crypto.randomBytes(32).toString('base64');
  });
  after(async () => {
    (env.integrations as { encryptionKey: string }).encryptionKey = claveOriginal;
    await teardownSuite();
  });

  beforeEach(async () => {
    await execute('DELETE FROM company_bank_accounts');
    await execute("DELETE FROM audit_logs WHERE entity_type = 'company_bank_accounts'");
  });

  /**
   * Crea una cuenta para la empresa indicada saltándose la API. F18-07: la guarda como la guarda
   * la aplicación —número y CCI cifrados, sus 4 últimos caracteres y las columnas en claro a NULL—.
   */
  async function sembrarCuenta(companyId: number, overrides: Record<string, unknown> = {}): Promise<number> {
    const data = { ...CUENTA_VALIDA, is_primary: 1, ...overrides };
    const cifrar = (campo: 'account_number' | 'interbank_code', valor: unknown) =>
      valor === null || valor === undefined ? null : encryptBankField(campo, companyId, String(valor));
    const ultimos = (valor: unknown) => (valor === null || valor === undefined ? null : String(valor).slice(-4));
    const result = await execute(
      `INSERT INTO company_bank_accounts
       (company_id, bank_name, account_type, currency, account_number_encrypted, account_number_last4,
        interbank_code_encrypted, interbank_code_last4, holder_name, holder_document, is_primary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        companyId, data.bank_name, data.account_type, data.currency,
        cifrar('account_number', data.account_number), ultimos(data.account_number),
        cifrar('interbank_code', data.interbank_code), ultimos(data.interbank_code),
        data.holder_name, data.holder_document, data.is_primary,
      ],
    );
    return result.insertId;
  }

  describe('Gestión por el COMPANY_ADMIN', () => {
    it('sin cuentas registradas devuelve una lista vacía', async () => {
      const res = await get(RUTA, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data, []);
    });

    it('registra su primera cuenta y queda como principal', async () => {
      const res = await post(RUTA, CUENTA_VALIDA, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 201);
      assert.equal(Number(res.body.data.company_id), ctx.fixtures.companyA, 'se asocia a su propia empresa');
      assert.equal(Number(res.body.data.is_primary), 1, 'la primera cuenta es la principal');
      assert.equal(res.body.data.status, 'PENDING', 'nace pendiente de verificación');
      assert.equal(res.body.data.account_number, CUENTA_VALIDA.account_number, 'quien puede editar ve el número completo');
    });

    it('consulta las cuentas que registró', async () => {
      await post(RUTA, CUENTA_VALIDA, ctx.sessions.companyAdmin.token);
      const res = await get(RUTA, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].bank_name, CUENTA_VALIDA.bank_name);
      assert.equal(res.body.data[0].account_number_masked, 'XXXX XXXX 0-12');
    });

    it('actualiza una cuenta existente', async () => {
      const id = await sembrarCuenta(ctx.fixtures.companyA);
      const res = await put(`${RUTA}/${id}`, { bank_name: 'Interbank', holder_name: 'Empresa A S.A.C.' }, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.bank_name, 'Interbank');

      const fila = await queryOne<{ bank_name: string; holder_name: string }>(
        'SELECT bank_name, holder_name FROM company_bank_accounts WHERE id = ?', [id],
      );
      assert.equal(fila?.bank_name, 'Interbank', 'el cambio se persiste');
      assert.equal(fila?.holder_name, 'Empresa A S.A.C.');
    });

    it('registra cuentas adicionales y solo una es la principal', async () => {
      await post(RUTA, CUENTA_VALIDA, ctx.sessions.companyAdmin.token);
      const segunda = await post(
        RUTA,
        { ...CUENTA_VALIDA, account_number: '193-9999999-0-99', bank_name: 'Interbank', is_primary: true },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(segunda.status, 201);

      const principales = await query('SELECT id FROM company_bank_accounts WHERE company_id = ? AND is_primary = 1', [ctx.fixtures.companyA]);
      assert.equal(principales.length, 1, 'solo puede haber una cuenta principal');
      assert.equal(Number(segunda.body.data.is_primary), 1, 'la nueva pasa a ser la principal');
    });

    it('no permite quitar la marca de principal sin designar otra', async () => {
      const id = await sembrarCuenta(ctx.fixtures.companyA);
      const res = await put(`${RUTA}/${id}`, { is_primary: false }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 400);
    });

    it('elimina una cuenta y asciende otra a principal', async () => {
      const principal = await sembrarCuenta(ctx.fixtures.companyA);
      const secundaria = await sembrarCuenta(ctx.fixtures.companyA, { account_number: '193-1111111-0-11', is_primary: 0 });

      const res = await del(`${RUTA}/${principal}`, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200);

      assert.equal((await query('SELECT id FROM company_bank_accounts WHERE id = ?', [principal])).length, 0);
      const restante = await queryOne<{ is_primary: number }>('SELECT is_primary FROM company_bank_accounts WHERE id = ?', [secundaria]);
      assert.equal(Number(restante?.is_primary), 1, 'la cuenta que queda pasa a ser la principal');
    });

    it('rechaza una cuenta duplicada dentro de la misma empresa', async () => {
      await post(RUTA, CUENTA_VALIDA, ctx.sessions.companyAdmin.token);
      const repetida = await post(RUTA, CUENTA_VALIDA, ctx.sessions.companyAdmin.token);

      assert.equal(repetida.status, 409);
      assert.equal((await query('SELECT id FROM company_bank_accounts')).length, 1, 'no se crea una segunda fila');
    });

    it('dos empresas pueden tener el mismo número sin colisionar', async () => {
      await post(RUTA, CUENTA_VALIDA, ctx.sessions.companyAdmin.token);
      const otra = await post(RUTA, { ...CUENTA_VALIDA, holder_name: 'Empresa B SAC' }, ctx.sessions.companyAdminB.token);
      assert.equal(otra.status, 201);
    });
  });

  describe('Aislamiento multiempresa', () => {
    it('cada empresa solo ve sus propias cuentas', async () => {
      await sembrarCuenta(ctx.fixtures.companyA, { bank_name: 'Banco de A' });
      await sembrarCuenta(ctx.fixtures.companyB, { bank_name: 'Banco de B', account_number: '999-0000000-0-99' });

      const a = await get(RUTA, ctx.sessions.companyAdmin.token);
      assert.equal(a.body.data.length, 1);
      assert.equal(a.body.data[0].bank_name, 'Banco de A');
      assert.equal(Number(a.body.data[0].company_id), ctx.fixtures.companyA);

      const b = await get(RUTA, ctx.sessions.companyAdminB.token);
      assert.equal(b.body.data.length, 1);
      assert.equal(b.body.data[0].bank_name, 'Banco de B');
    });

    it('el parámetro company_id de la query no amplía el alcance', async () => {
      await sembrarCuenta(ctx.fixtures.companyB, { bank_name: 'Banco de B', account_number: '999-0000000-0-99' });

      const res = await get(`${RUTA}?company_id=${ctx.fixtures.companyB}`, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data, [], 'sigue viendo solo lo suyo');
    });

    it('no puede leer una cuenta de otra empresa por su id', async () => {
      const ajena = await sembrarCuenta(ctx.fixtures.companyB, { account_number: '999-0000000-0-99' });
      const res = await put(`${RUTA}/${ajena}`, { bank_name: 'Intruso' }, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 404, 'se responde 404, no 403: no se confirma que exista');
      const fila = await queryOne<{ bank_name: string }>('SELECT bank_name FROM company_bank_accounts WHERE id = ?', [ajena]);
      assert.notEqual(fila?.bank_name, 'Intruso', 'la cuenta ajena no se modifica');
    });

    it('no puede eliminar una cuenta de otra empresa', async () => {
      const ajena = await sembrarCuenta(ctx.fixtures.companyB, { account_number: '999-0000000-0-99' });
      assert.equal((await del(`${RUTA}/${ajena}`, ctx.sessions.companyAdmin.token)).status, 404);
      assert.equal((await query('SELECT id FROM company_bank_accounts WHERE id = ?', [ajena])).length, 1, 'sigue existiendo');
    });

    it('inyectar company_id en el cuerpo no crea la cuenta en otra empresa', async () => {
      const res = await post(
        RUTA,
        { ...CUENTA_VALIDA, company_id: ctx.fixtures.companyB },
        ctx.sessions.companyAdmin.token,
      );

      assert.equal(res.status, 201);
      assert.equal(Number(res.body.data.company_id), ctx.fixtures.companyA, 'se ignora el company_id enviado');
      assert.equal(
        (await query('SELECT id FROM company_bank_accounts WHERE company_id = ?', [ctx.fixtures.companyB])).length,
        0,
        'la empresa B no recibe nada',
      );
    });

    it('inyectar company_id al actualizar tampoco cambia de empresa', async () => {
      const id = await sembrarCuenta(ctx.fixtures.companyA);
      const res = await put(`${RUTA}/${id}`, { bank_name: 'BBVA', company_id: ctx.fixtures.companyB }, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 200);
      const fila = await queryOne<{ company_id: number }>('SELECT company_id FROM company_bank_accounts WHERE id = ?', [id]);
      assert.equal(Number(fila?.company_id), ctx.fixtures.companyA, 'la cuenta no cambia de empresa');
    });

    it('la respuesta nunca incluye datos de otra empresa', async () => {
      await sembrarCuenta(ctx.fixtures.companyB, { bank_name: 'Banco secreto de B', account_number: '999-0000000-0-99' });
      const res = await get(RUTA, ctx.sessions.companyAdmin.token);
      assert.doesNotMatch(JSON.stringify(res.body), /Banco secreto de B/);
    });
  });

  describe('Permisos por rol', () => {
    it('un CUSTOMER no puede consultar ni escribir aunque tenga companies.view', async () => {
      await sembrarCuenta(ctx.fixtures.companyA);

      assert.equal((await get(RUTA, ctx.sessions.customer.token)).status, 403, 'no pertenece a ninguna empresa');
      assert.equal((await post(RUTA, CUENTA_VALIDA, ctx.sessions.customer.token)).status, 403);
      assert.equal((await put(`${RUTA}/1`, { bank_name: 'X' }, ctx.sessions.customer.token)).status, 403);
      assert.equal((await del(`${RUTA}/1`, ctx.sessions.customer.token)).status, 403);
    });

    it('un OPERATOR consulta pero no modifica, y ve la cuenta enmascarada', async () => {
      await sembrarCuenta(ctx.fixtures.companyA);

      const lectura = await get(RUTA, ctx.sessions.operator.token);
      assert.equal(lectura.status, 200);
      assert.equal(lectura.body.data.length, 1);
      assert.equal(lectura.body.data[0].account_number, null, 'no recibe el número completo');
      assert.equal(lectura.body.data[0].interbank_code, null, 'ni el CCI');
      assert.equal(lectura.body.data[0].masked, true);
      assert.equal(lectura.body.data[0].account_number_masked, 'XXXX XXXX 0-12');

      assert.equal((await post(RUTA, CUENTA_VALIDA, ctx.sessions.operator.token)).status, 403, 'no tiene companies.update');
      assert.equal((await put(`${RUTA}/1`, { bank_name: 'X' }, ctx.sessions.operator.token)).status, 403);
      assert.equal((await del(`${RUTA}/1`, ctx.sessions.operator.token)).status, 403);
    });

    it('el ADMIN consulta la cuenta de cualquier empresa indicándola', async () => {
      await sembrarCuenta(ctx.fixtures.companyB, { bank_name: 'Banco de B', account_number: '999-0000000-0-99' });

      const res = await get(`${RUTA}?company_id=${ctx.fixtures.companyB}`, ctx.sessions.admin.token);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].bank_name, 'Banco de B');
    });

    it('sin token no se accede', async () => {
      assert.equal((await get(RUTA)).status, 401);
      assert.equal((await post(RUTA, CUENTA_VALIDA)).status, 401);
      assert.equal((await put(`${RUTA}/1`, { bank_name: 'X' })).status, 401);
      assert.equal((await del(`${RUTA}/1`)).status, 401);
    });
  });

  describe('Validaciones', () => {
    const invalidas: Array<[string, Record<string, unknown>]> = [
      ['sin banco', { ...CUENTA_VALIDA, bank_name: '' }],
      ['banco demasiado corto', { ...CUENTA_VALIDA, bank_name: 'A' }],
      ['sin número de cuenta', { ...CUENTA_VALIDA, account_number: '' }],
      ['número de cuenta con letras', { ...CUENTA_VALIDA, account_number: 'ABC-123456' }],
      ['número de cuenta demasiado corto', { ...CUENTA_VALIDA, account_number: '123' }],
      ['tipo de cuenta inexistente', { ...CUENTA_VALIDA, account_type: 'CREDITO' }],
      ['moneda no admitida', { ...CUENTA_VALIDA, currency: 'EUR' }],
      ['CCI con menos de 20 dígitos', { ...CUENTA_VALIDA, interbank_code: '00219300245' }],
      ['CCI con letras', { ...CUENTA_VALIDA, interbank_code: 'CCI-002193002456789012' }],
      ['sin titular', { ...CUENTA_VALIDA, holder_name: '' }],
      ['documento del titular inválido', { ...CUENTA_VALIDA, holder_document: '123' }],
      ['cuerpo vacío', {}],
    ];

    for (const [nombre, cuerpo] of invalidas) {
      it(`rechaza: ${nombre}`, async () => {
        const res = await post(RUTA, cuerpo, ctx.sessions.companyAdmin.token);
        assert.equal(res.status, 422, JSON.stringify(res.body.errors ?? res.body.message));
        assert.equal((await query('SELECT id FROM company_bank_accounts')).length, 0, 'no se guarda nada');
      });
    }

    it('acepta un CCI nulo y un documento nulo', async () => {
      const res = await post(
        RUTA,
        { ...CUENTA_VALIDA, interbank_code: null, holder_document: null },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(res.status, 201);
      assert.equal(res.body.data.interbank_code, null);
    });

    it('actualizar sin enviar campos se rechaza', async () => {
      const id = await sembrarCuenta(ctx.fixtures.companyA);
      assert.equal((await put(`${RUTA}/${id}`, {}, ctx.sessions.companyAdmin.token)).status, 422);
    });

    it('un id inexistente o no numérico devuelve 404', async () => {
      assert.equal((await put(`${RUTA}/999999`, { bank_name: 'Interbank' }, ctx.sessions.companyAdmin.token)).status, 404);
      assert.equal((await put(`${RUTA}/abc`, { bank_name: 'Interbank' }, ctx.sessions.companyAdmin.token)).status, 404);
      assert.equal((await del(`${RUTA}/999999`, ctx.sessions.companyAdmin.token)).status, 404);
    });
  });

  describe('Seguridad', () => {
    it('ignora los campos que no son escribibles (mass assignment)', async () => {
      const res = await post(
        RUTA,
        {
          ...CUENTA_VALIDA,
          id: 9999,
          company_id: ctx.fixtures.companyB,
          status: 'VERIFIED',
          created_at: '2000-01-01 00:00:00',
          updated_at: '2000-01-01 00:00:00',
        },
        ctx.sessions.companyAdmin.token,
      );

      assert.equal(res.status, 201);
      assert.notEqual(Number(res.body.data.id), 9999, 'el id lo asigna la base');
      assert.equal(Number(res.body.data.company_id), ctx.fixtures.companyA);
      assert.equal(res.body.data.status, 'PENDING', 'una empresa no puede verificarse a sí misma');
      assert.ok(!String(res.body.data.created_at).startsWith('2000'), 'created_at no es escribible');
    });

    it('el estado de verificación no puede cambiarse desde la API', async () => {
      const id = await sembrarCuenta(ctx.fixtures.companyA);
      await put(`${RUTA}/${id}`, { status: 'VERIFIED', bank_name: 'Interbank' }, ctx.sessions.companyAdmin.token);

      const fila = await queryOne<{ status: string }>('SELECT status FROM company_bank_accounts WHERE id = ?', [id]);
      assert.equal(fila?.status, 'PENDING', 'el estado sigue siendo el de la base');
    });

    it('resiste inyección SQL en los campos de texto', async () => {
      const ataques = [
        "Banco'; DROP TABLE company_bank_accounts; --",
        "Banco' OR '1'='1",
        "'; UPDATE company_bank_accounts SET company_id = 2; --",
      ];
      for (const bank_name of ataques) {
        const res = await post(
          RUTA,
          { ...CUENTA_VALIDA, bank_name, account_number: `193-${Date.now() % 10_000_000}-0-12` },
          ctx.sessions.companyAdmin.token,
        );
        assert.ok([201, 409, 422].includes(res.status), `${bank_name} -> ${res.status}`);
      }

      const tabla = await query<{ id: number; company_id: number }>('SELECT id, company_id FROM company_bank_accounts');
      assert.ok(Array.isArray(tabla), 'la tabla sigue existiendo');
      assert.ok(tabla.every((fila) => Number(fila.company_id) === ctx.fixtures.companyA), 'ninguna fila cambió de empresa');
    });

    it('resiste inyección SQL en el id de la ruta', async () => {
      const res = await put(`${RUTA}/1 OR 1=1`, { bank_name: 'Interbank' }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 404);
    });

    it('la respuesta no filtra el hash de contraseña ni datos de usuarios', async () => {
      await sembrarCuenta(ctx.fixtures.companyA);
      const cuerpo = JSON.stringify((await get(RUTA, ctx.sessions.companyAdmin.token)).body);
      assert.doesNotMatch(cuerpo, /password/i);
      assert.doesNotMatch(cuerpo, /\$2[aby]\$/);
    });

    it('la integridad referencial impide una cuenta sin empresa', async () => {
      await assert.rejects(
        () => execute(
          `INSERT INTO company_bank_accounts (company_id, bank_name, account_number, holder_name)
           VALUES (999999, 'Banco fantasma', '111-2222222-0-11', 'Nadie')`,
        ),
        /foreign key|FOREIGN KEY|ER_NO_REFERENCED_ROW/i,
        'la clave foránea debe rechazarlo',
      );
    });

    it('al borrar la empresa se borran sus cuentas en cascada', async () => {
      const empresa = await execute(
        "INSERT INTO companies (name, legal_name, tax_id, email, status) VALUES ('Temporal', 'Temporal SAC', '20333333333', 'temp@test.pe', 'ACTIVE')",
      );
      await sembrarCuenta(empresa.insertId, { account_number: '555-5555555-0-55' });

      await execute('DELETE FROM companies WHERE id = ?', [empresa.insertId]);
      const restantes = await query('SELECT id FROM company_bank_accounts WHERE company_id = ?', [empresa.insertId]);
      assert.equal(restantes.length, 0);
    });
  });

  describe('Auditoría e historial', () => {
    it('registra el alta sin guardar el número de cuenta completo', async () => {
      const creada = await post(RUTA, CUENTA_VALIDA, ctx.sessions.companyAdmin.token);

      const entrada = await queryOne<{ action: string; description: string; new_values: string | null; user_id: number }>(
        "SELECT action, description, new_values, user_id FROM audit_logs WHERE entity_type = 'company_bank_accounts' ORDER BY id DESC LIMIT 1",
      );
      assert.ok(entrada, 'debe existir la entrada de auditoría');
      assert.equal(entrada!.action, 'CREATE');
      assert.equal(Number(entrada!.user_id), ctx.sessions.companyAdmin.user.id, 'registra quién lo hizo');
      assert.match(entrada!.description, /XXXX XXXX/, 'el número aparece enmascarado');
      assert.doesNotMatch(entrada!.description, new RegExp(CUENTA_VALIDA.account_number), 'nunca el número completo');
      assert.doesNotMatch(String(entrada!.new_values ?? ''), /2456789/, 'ni en new_values');
      assert.doesNotMatch(String(entrada!.new_values ?? ''), new RegExp(CUENTA_VALIDA.interbank_code), 'ni el CCI');
      assert.equal(creada.status, 201);
    });

    it('registra la actualización y la eliminación', async () => {
      const id = await sembrarCuenta(ctx.fixtures.companyA);
      await put(`${RUTA}/${id}`, { bank_name: 'Interbank' }, ctx.sessions.companyAdmin.token);
      await del(`${RUTA}/${id}`, ctx.sessions.companyAdmin.token);

      const acciones = await query<{ action: string }>(
        "SELECT action FROM audit_logs WHERE entity_type = 'company_bank_accounts' ORDER BY id ASC",
      );
      assert.deepEqual(acciones.map((a) => a.action), ['UPDATE', 'DELETE']);
    });

    it('el historial solo muestra los cambios de la propia empresa', async () => {
      await post(RUTA, CUENTA_VALIDA, ctx.sessions.companyAdmin.token);
      await post(
        RUTA,
        { ...CUENTA_VALIDA, bank_name: 'Banco de B', account_number: '999-0000000-0-99' },
        ctx.sessions.companyAdminB.token,
      );

      const propio = await get(`${RUTA}/history`, ctx.sessions.companyAdmin.token);
      assert.equal(propio.status, 200);
      assert.equal(propio.body.data.length, 1, 'solo su propio cambio');
      assert.doesNotMatch(JSON.stringify(propio.body), /Banco de B/);

      const ajeno = await get(`${RUTA}/history`, ctx.sessions.companyAdminB.token);
      assert.equal(ajeno.body.data.length, 1);
      assert.match(JSON.stringify(ajeno.body), /Banco de B/);
    });

    it('el historial no exige el permiso de auditoría general', async () => {
      assert.equal((await get(`${RUTA}/history`, ctx.sessions.companyAdmin.token)).status, 200);
      assert.equal((await get('/audit-logs', ctx.sessions.companyAdmin.token)).status, 403, 'la auditoría global sigue cerrada');
    });
  });
});
