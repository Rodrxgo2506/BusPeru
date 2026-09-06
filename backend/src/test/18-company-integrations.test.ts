import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execute, query, queryOne } from '../config/database';
import { env } from '../config/env';
import { decryptJson } from '../services/encryption.service';
import { del, get, post, put } from './helpers/api';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * Integraciones por empresa (PENDIENTES.md §5, mockup 37).
 *
 * ALCANCE de la funcionalidad probada: **solo configuración**. Ninguna integración procesa
 * nada; estos tests comprueban que se guarda, se cifra, se aísla y se audita, no que se
 * cobre — porque el cobro real no forma parte de §5.
 */
describe('Integraciones por empresa', () => {
  let ctx: SuiteContext;

  const RUTA = '/company/integrations';
  const ADMIN_RUTA = '/admin/integrations';

  /** Credenciales de PRUEBA. No son de ningún comercio real. */
  const CULQI = { public_key: 'pk_test_0000000000001234', private_key: 'sk_test_0000000000005678' };

  before(async () => {
    ctx = await prepareSuite();
    // Clave de 32 bytes solo para la suite.
    env.integrations.encryptionKey = Buffer.alloc(32, 7).toString('base64');
  });

  after(async () => {
    await teardownSuite();
  });

  beforeEach(async () => {
    await execute('DELETE FROM company_integrations');
    await execute("DELETE FROM audit_logs WHERE entity_type = 'company_integrations'");
    env.integrations.encryptionKey = Buffer.alloc(32, 7).toString('base64');
  });

  /** Configura Culqi para la empresa A y devuelve la respuesta. */
  const guardarCulqi = (token = ctx.sessions.companyAdmin.token, credentials: Record<string, string> = CULQI) =>
    put(`${RUTA}/CULQI`, { credentials }, token);

  // --- Catálogo -------------------------------------------------------------

  describe('Catálogo', () => {
    it('lista los siete proveedores del mockup con su categoría', async () => {
      const res = await get(RUTA, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 200);
      assert.deepEqual(
        res.body.data.integrations.map((i: { provider: string }) => i.provider),
        ['IZIPAY', 'NIUBIZ', 'CULQI', 'PAYPAL', 'GOOGLE_ANALYTICS', 'GOOGLE_MAPS', 'WHATSAPP_BUSINESS'],
      );

      const pasarelas = res.body.data.integrations.filter((i: { category: string }) => i.category === 'PAYMENT_GATEWAY');
      assert.equal(pasarelas.length, 4, 'Izipay, Niubiz, Culqi y PayPal');
    });

    it('sin configurar, todo aparece como DISCONNECTED', async () => {
      const res = await get(RUTA, ctx.sessions.companyAdmin.token);

      for (const integracion of res.body.data.integrations) {
        assert.equal(integracion.status, 'DISCONNECTED', integracion.provider);
        assert.deepEqual(integracion.configured_fields, []);
        assert.equal(integracion.connected_at, null);
      }
    });

    it('declara que el procesamiento todavía no está activo', async () => {
      const res = await get(RUTA, ctx.sessions.companyAdmin.token);
      for (const integracion of res.body.data.integrations) {
        assert.equal(integracion.processing_active, false, 'configurar no es operar');
      }
    });

    it('publica los campos que espera cada proveedor', async () => {
      const res = await get(`${RUTA}/CULQI`, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 200);
      assert.deepEqual(
        res.body.data.fields.map((f: { name: string; secret: boolean }) => [f.name, f.secret]),
        [['public_key', false], ['private_key', true]],
      );
    });

    it('un proveedor que no está en el catálogo devuelve 404', async () => {
      for (const provider of ['STRIPE', 'culqi', 'X', "' OR 1=1 --"]) {
        assert.equal((await get(`${RUTA}/${encodeURIComponent(provider)}`, ctx.sessions.companyAdmin.token)).status, 404, provider);
      }
    });

    it('avisa de si el servidor puede cifrar', async () => {
      assert.equal((await get(RUTA, ctx.sessions.companyAdmin.token)).body.data.encryption_configured, true);

      env.integrations.encryptionKey = '';
      assert.equal((await get(RUTA, ctx.sessions.companyAdmin.token)).body.data.encryption_configured, false);
    });
  });

  // --- Configuración --------------------------------------------------------

  describe('Configuración', () => {
    it('guarda la configuración y queda pendiente de conectar', async () => {
      const res = await guardarCulqi();

      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.status, 'DISCONNECTED', 'guardar no conecta');
      assert.deepEqual(res.body.data.configured_fields, ['public_key', 'private_key']);
      assert.deepEqual(res.body.data.missing_fields, []);
    });

    it('con campos obligatorios ausentes queda en NEEDS_CONFIG', async () => {
      const res = await put(`${RUTA}/CULQI`, { credentials: { public_key: 'pk_test_solo_publica' } }, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 201);
      assert.equal(res.body.data.status, 'NEEDS_CONFIG');
      assert.deepEqual(res.body.data.missing_fields, ['private_key']);
    });

    it('actualizar devuelve 200 y no duplica la fila', async () => {
      await guardarCulqi();
      const segunda = await guardarCulqi(ctx.sessions.companyAdmin.token, { ...CULQI, public_key: 'pk_test_9999' });

      assert.equal(segunda.status, 200, 'ya existía');
      assert.equal((await query('SELECT id FROM company_integrations')).length, 1);
    });

    it('un campo vacío conserva el valor anterior', async () => {
      await guardarCulqi();
      const res = await put(`${RUTA}/CULQI`, { credentials: { public_key: 'pk_test_nueva_publica' } }, ctx.sessions.companyAdmin.token);

      assert.deepEqual(res.body.data.configured_fields, ['public_key', 'private_key'], 'la privada sigue puesta');

      const fila = await queryOne<{ credentials: string }>('SELECT credentials FROM company_integrations LIMIT 1');
      const descifrado = decryptJson(fila!.credentials)!;
      assert.equal(descifrado.public_key, 'pk_test_nueva_publica');
      assert.equal(descifrado.private_key, CULQI.private_key, 'no se perdió');
    });

    it('ignora las claves que el proveedor no declara', async () => {
      const res = await put(
        `${RUTA}/CULQI`,
        { credentials: { ...CULQI, campo_inventado: 'valor', private_key_2: 'otro' } },
        ctx.sessions.companyAdmin.token,
      );

      assert.equal(res.status, 201);
      const fila = await queryOne<{ credentials: string }>('SELECT credentials FROM company_integrations LIMIT 1');
      const descifrado = decryptJson(fila!.credentials)!;
      assert.deepEqual(Object.keys(descifrado).sort(), ['private_key', 'public_key']);
    });

    it('rechaza valores con saltos de línea o desmesurados', async () => {
      const conSalto = await put(`${RUTA}/CULQI`, { credentials: { public_key: 'pk\ninyectado' } }, ctx.sessions.companyAdmin.token);
      assert.equal(conSalto.status, 422);

      const largo = await put(`${RUTA}/CULQI`, { credentials: { public_key: 'x'.repeat(501) } }, ctx.sessions.companyAdmin.token);
      assert.equal(largo.status, 422);
    });

    it('sin clave de cifrado no se guarda nada en claro', async () => {
      env.integrations.encryptionKey = '';

      const res = await guardarCulqi();
      assert.equal(res.status, 503, 'se rechaza en vez de guardar sin cifrar');
      assert.equal((await query('SELECT id FROM company_integrations')).length, 0);
    });
  });

  // --- Cifrado ---------------------------------------------------------------

  describe('Cifrado en reposo', () => {
    it('las credenciales no aparecen en claro en la base', async () => {
      await guardarCulqi();

      const fila = await queryOne<{ credentials: string }>('SELECT credentials FROM company_integrations LIMIT 1');
      assert.ok(fila?.credentials);
      assert.ok(!fila.credentials.includes(CULQI.private_key), 'la llave privada no está en claro');
      assert.ok(!fila.credentials.includes(CULQI.public_key), 'la pública tampoco');
    });

    it('el sobre es JSON válido y declara el algoritmo', async () => {
      await guardarCulqi();

      const fila = await queryOne<{ credentials: string }>('SELECT credentials FROM company_integrations LIMIT 1');
      const sobre = JSON.parse(fila!.credentials);
      assert.equal(sobre.alg, 'AES-256-GCM');
      assert.equal(sobre.v, 1);
      assert.ok(sobre.iv && sobre.tag && sobre.data);

      // La columna lleva CHECK (json_valid): si no fuera JSON, la propia base lo habría rechazado.
      const valido = await queryOne<{ ok: number }>('SELECT json_valid(credentials) AS ok FROM company_integrations LIMIT 1');
      assert.equal(Number(valido?.ok), 1);
    });

    it('cada escritura usa un IV distinto', async () => {
      await guardarCulqi();
      const primero = await queryOne<{ credentials: string }>('SELECT credentials FROM company_integrations LIMIT 1');

      await guardarCulqi();
      const segundo = await queryOne<{ credentials: string }>('SELECT credentials FROM company_integrations LIMIT 1');

      assert.notEqual(JSON.parse(primero!.credentials).iv, JSON.parse(segundo!.credentials).iv);
      assert.notEqual(primero!.credentials, segundo!.credentials, 'el mismo texto cifra distinto cada vez');
    });

    it('una fila manipulada no descifra', async () => {
      await guardarCulqi();
      const fila = await queryOne<{ id: number; credentials: string }>('SELECT id, credentials FROM company_integrations LIMIT 1');

      // Se altera un byte del texto cifrado: GCM debe detectarlo por la etiqueta.
      const sobre = JSON.parse(fila!.credentials);
      const datos = Buffer.from(sobre.data, 'base64');
      datos[0] = datos[0]! ^ 0xff;
      sobre.data = datos.toString('base64');
      await execute('UPDATE company_integrations SET credentials = ? WHERE id = ?', [JSON.stringify(sobre), fila!.id]);

      assert.equal(decryptJson(JSON.stringify(sobre)), null, 'la manipulación se detecta');

      // Y la API lo trata como «sin configurar», no revienta ni entrega basura.
      const res = await get(`${RUTA}/CULQI`, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data.configured_fields, []);
    });

    it('con otra clave no se puede descifrar', async () => {
      await guardarCulqi();
      const fila = await queryOne<{ credentials: string }>('SELECT credentials FROM company_integrations LIMIT 1');

      env.integrations.encryptionKey = Buffer.alloc(32, 9).toString('base64');
      assert.equal(decryptJson(fila!.credentials), null);
    });

    it('una clave de longitud incorrecta se rechaza', async () => {
      env.integrations.encryptionKey = Buffer.alloc(16, 7).toString('base64');
      assert.equal((await guardarCulqi()).status, 503, 'no se rellena ni se deriva en silencio');
    });
  });

  // --- Enmascarado -----------------------------------------------------------

  describe('Enmascarado en las respuestas', () => {
    it('nunca devuelve las credenciales completas', async () => {
      await guardarCulqi();

      for (const respuesta of [await get(RUTA, ctx.sessions.companyAdmin.token), await get(`${RUTA}/CULQI`, ctx.sessions.companyAdmin.token)]) {
        const cuerpo = JSON.stringify(respuesta.body);
        assert.ok(!cuerpo.includes(CULQI.private_key), 'la llave privada nunca sale');
        assert.ok(!cuerpo.includes(CULQI.public_key), 'la pública tampoco');
        assert.ok(!cuerpo.includes('AES-256-GCM'), 'el sobre cifrado tampoco se publica');
      }
    });

    it('muestra solo los cuatro últimos caracteres', async () => {
      await guardarCulqi();
      const res = await get(`${RUTA}/CULQI`, ctx.sessions.companyAdmin.token);

      assert.equal(res.body.data.credentials_preview.private_key, '•••• 5678');
      assert.equal(res.body.data.credentials_preview.public_key, '•••• 1234');
    });

    it('un campo sin configurar no tiene vista parcial', async () => {
      await put(`${RUTA}/CULQI`, { credentials: { public_key: 'pk_test_0000abcd' } }, ctx.sessions.companyAdmin.token);
      const res = await get(`${RUTA}/CULQI`, ctx.sessions.companyAdmin.token);

      assert.equal(res.body.data.credentials_preview.public_key, '•••• abcd');
      assert.equal(res.body.data.credentials_preview.private_key, null);
    });
  });

  // --- Conectar y desconectar -------------------------------------------------

  describe('Conectar y desconectar', () => {
    it('conecta cuando la configuración está completa', async () => {
      await guardarCulqi();
      const res = await post(`${RUTA}/CULQI/connect`, undefined, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'CONNECTED');
      assert.ok(res.body.data.connected_at, 'queda la fecha de conexión');
    });

    it('no conecta si faltan datos obligatorios', async () => {
      await put(`${RUTA}/CULQI`, { credentials: { public_key: 'pk_test_incompleta' } }, ctx.sessions.companyAdmin.token);

      const res = await post(`${RUTA}/CULQI/connect`, undefined, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 400);
      assert.match(res.body.message ?? '', /private_key/);
    });

    it('no conecta lo que nunca se configuró', async () => {
      assert.equal((await post(`${RUTA}/PAYPAL/connect`, undefined, ctx.sessions.companyAdmin.token)).status, 400);
    });

    it('desconectar borra las credenciales', async () => {
      await guardarCulqi();
      await post(`${RUTA}/CULQI/connect`, undefined, ctx.sessions.companyAdmin.token);

      const res = await post(`${RUTA}/CULQI/disconnect`, undefined, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'DISCONNECTED');
      assert.equal(res.body.data.connected_at, null);
      assert.deepEqual(res.body.data.configured_fields, [], 'las llaves ya no están');

      const fila = await queryOne<{ credentials: string | null }>('SELECT credentials FROM company_integrations LIMIT 1');
      assert.equal(fila?.credentials, null, 'no se conservan llaves vivas de una integración desconectada');
    });

    it('reconfigurar tras conectar mantiene el estado conectado', async () => {
      await guardarCulqi();
      await post(`${RUTA}/CULQI/connect`, undefined, ctx.sessions.companyAdmin.token);

      const res = await guardarCulqi(ctx.sessions.companyAdmin.token, { ...CULQI, public_key: 'pk_test_rotada_4321' });
      assert.equal(res.body.data.status, 'CONNECTED', 'rotar una llave no desconecta');
    });

    it('elimina la integración por completo', async () => {
      await guardarCulqi();
      assert.equal((await del(`${RUTA}/CULQI`, ctx.sessions.companyAdmin.token)).status, 200);
      assert.equal((await query('SELECT id FROM company_integrations')).length, 0);

      assert.equal((await del(`${RUTA}/CULQI`, ctx.sessions.companyAdmin.token)).status, 404, 'ya no existe');
    });
  });

  // --- Aislamiento multiempresa ------------------------------------------------

  describe('Aislamiento multiempresa', () => {
    /** Integración de la empresa B, creada directamente para preparar el escenario. */
    async function integracionDeB(): Promise<void> {
      await execute(
        "INSERT INTO company_integrations (company_id, provider, category, status) VALUES (?, 'CULQI', 'PAYMENT_GATEWAY', 'CONNECTED')",
        [ctx.fixtures.companyB],
      );
    }

    it('A → A: cada empresa ve solo lo suyo', async () => {
      await guardarCulqi();
      await integracionDeB();

      const a = await get(`${RUTA}/CULQI`, ctx.sessions.companyAdmin.token);
      assert.equal(a.body.data.status, 'DISCONNECTED', 'la suya, recién guardada');

      const b = await get(`${RUTA}/CULQI`, ctx.sessions.companyAdminB.token);
      assert.equal(b.body.data.status, 'CONNECTED', 'la de B es otra fila');
    });

    it('A → B: el company_id del cuerpo no cambia el tenant', async () => {
      await put(
        `${RUTA}/CULQI`,
        { credentials: CULQI, company_id: ctx.fixtures.companyB, id: 999, status: 'CONNECTED' },
        ctx.sessions.companyAdmin.token,
      );

      const filas = await query<{ company_id: number; status: string }>('SELECT company_id, status FROM company_integrations');
      assert.equal(filas.length, 1);
      assert.equal(Number(filas[0]!.company_id), ctx.fixtures.companyA, 'se guardó en la empresa de la sesión');
      assert.notEqual(filas[0]!.status, 'CONNECTED', 'el estado no se acepta del cuerpo');
    });

    it('A → B: la query tampoco amplía el alcance', async () => {
      await integracionDeB();

      const res = await get(`${RUTA}?company_id=${ctx.fixtures.companyB}`, ctx.sessions.companyAdmin.token);
      assert.equal(res.body.data.integrations.find((i: { provider: string }) => i.provider === 'CULQI').status, 'DISCONNECTED');
    });

    it('A no puede desconectar ni borrar la integración de B', async () => {
      await integracionDeB();

      assert.equal((await post(`${RUTA}/CULQI/disconnect`, undefined, ctx.sessions.companyAdmin.token)).status, 404);
      assert.equal((await del(`${RUTA}/CULQI`, ctx.sessions.companyAdmin.token)).status, 404);

      const fila = await queryOne<{ status: string }>('SELECT status FROM company_integrations WHERE company_id = ?', [
        ctx.fixtures.companyB,
      ]);
      assert.equal(fila?.status, 'CONNECTED', 'la de B sigue intacta');
    });

    it('B → B permitido y B → A rechazado', async () => {
      await guardarCulqi();

      const propia = await put(`${RUTA}/PAYPAL`, { credentials: { client_id: 'id-b', client_secret: 'secreto-b' } }, ctx.sessions.companyAdminB.token);
      assert.equal(propia.status, 201, 'B configura lo suyo');

      const ajena = await get(`${RUTA}/CULQI`, ctx.sessions.companyAdminB.token);
      assert.deepEqual(ajena.body.data.configured_fields, [], 'B no ve la configuración de A');
    });

    it('las credenciales de otra empresa no se filtran en ninguna respuesta', async () => {
      await guardarCulqi();

      const listado = JSON.stringify((await get(RUTA, ctx.sessions.companyAdminB.token)).body);
      assert.ok(!listado.includes(CULQI.private_key));
      assert.ok(!listado.includes('1234'), 'ni siquiera la vista parcial de A');
    });

    it('borrar la empresa arrastra sus integraciones en cascada', async () => {
      const empresa = await execute(
        "INSERT INTO companies (name, legal_name, tax_id, email, status) VALUES ('Cascada', 'Cascada SAC', '20777777777', 'cascada@test.pe', 'ACTIVE')",
      );
      await execute(
        "INSERT INTO company_integrations (company_id, provider, category) VALUES (?, 'CULQI', 'PAYMENT_GATEWAY')",
        [empresa.insertId],
      );

      await execute('DELETE FROM companies WHERE id = ?', [empresa.insertId]);
      assert.equal((await query('SELECT id FROM company_integrations WHERE company_id = ?', [empresa.insertId])).length, 0);
    });

    it('la clave única impide dos filas del mismo proveedor en una empresa', async () => {
      await guardarCulqi();
      await assert.rejects(
        () => execute("INSERT INTO company_integrations (company_id, provider, category) VALUES (?, 'CULQI', 'PAYMENT_GATEWAY')", [
          ctx.fixtures.companyA,
        ]),
        /Duplicate entry|ER_DUP_ENTRY/i,
      );
    });
  });

  // --- Integración de plataforma ------------------------------------------------

  describe('Integración a nivel de plataforma', () => {
    it('el ADMIN la configura y queda con company_id NULL', async () => {
      const res = await put(`${ADMIN_RUTA}/CULQI`, { credentials: CULQI }, ctx.sessions.admin.token);

      assert.equal(res.status, 201);
      const fila = await queryOne<{ company_id: number | null }>('SELECT company_id FROM company_integrations LIMIT 1');
      assert.equal(fila?.company_id, null, 'modelo agregador: la integración es de la plataforma');
    });

    it('un COMPANY_ADMIN no puede tocarla', async () => {
      assert.equal((await get(ADMIN_RUTA, ctx.sessions.companyAdmin.token)).status, 403);
      assert.equal((await put(`${ADMIN_RUTA}/CULQI`, { credentials: CULQI }, ctx.sessions.companyAdmin.token)).status, 403);
      assert.equal((await post(`${ADMIN_RUTA}/CULQI/connect`, undefined, ctx.sessions.companyAdmin.token)).status, 403);
      assert.equal((await del(`${ADMIN_RUTA}/CULQI`, ctx.sessions.companyAdmin.token)).status, 403);
    });

    it('un OPERATOR tampoco', async () => {
      assert.equal((await get(ADMIN_RUTA, ctx.sessions.operator.token)).status, 403);
    });

    it('la integración de plataforma no aparece en el listado de una empresa', async () => {
      await put(`${ADMIN_RUTA}/CULQI`, { credentials: CULQI }, ctx.sessions.admin.token);

      const res = await get(`${RUTA}/CULQI`, ctx.sessions.companyAdmin.token);
      assert.equal(res.body.data.status, 'DISCONNECTED');
      assert.deepEqual(res.body.data.configured_fields, [], 'no ve las llaves de la plataforma');
    });

    it('la plataforma y una empresa pueden tener el mismo proveedor por separado', async () => {
      await put(`${ADMIN_RUTA}/CULQI`, { credentials: CULQI }, ctx.sessions.admin.token);
      await guardarCulqi();

      const filas = await query<{ company_id: number | null }>('SELECT company_id FROM company_integrations ORDER BY id');
      assert.equal(filas.length, 2, 'son dos filas distintas');
      assert.equal(filas[0]!.company_id, null);
      assert.equal(Number(filas[1]!.company_id), ctx.fixtures.companyA);
    });

    it('la columna generada impide DOS integraciones de plataforma del mismo proveedor', async () => {
      await put(`${ADMIN_RUTA}/CULQI`, { credentials: CULQI }, ctx.sessions.admin.token);

      // Sin `company_scope`, la clave única de §5 dejaría pasar esto: los NULL no colisionan.
      await assert.rejects(
        () => execute("INSERT INTO company_integrations (company_id, provider, category) VALUES (NULL, 'CULQI', 'PAYMENT_GATEWAY')"),
        /Duplicate entry|ER_DUP_ENTRY/i,
      );
      assert.equal((await query('SELECT id FROM company_integrations')).length, 1);
    });
  });

  // --- Permisos ------------------------------------------------------------------

  describe('Permisos por rol', () => {
    it('un OPERATOR consulta pero no modifica', async () => {
      await guardarCulqi();

      assert.equal((await get(RUTA, ctx.sessions.operator.token)).status, 200);
      assert.equal((await get(`${RUTA}/CULQI`, ctx.sessions.operator.token)).status, 200);

      assert.equal((await put(`${RUTA}/CULQI`, { credentials: CULQI }, ctx.sessions.operator.token)).status, 403);
      assert.equal((await post(`${RUTA}/CULQI/connect`, undefined, ctx.sessions.operator.token)).status, 403);
      assert.equal((await post(`${RUTA}/CULQI/disconnect`, undefined, ctx.sessions.operator.token)).status, 403);
      assert.equal((await del(`${RUTA}/CULQI`, ctx.sessions.operator.token)).status, 403);
    });

    it('un OPERATOR tampoco ve las credenciales completas', async () => {
      await guardarCulqi();
      const cuerpo = JSON.stringify((await get(`${RUTA}/CULQI`, ctx.sessions.operator.token)).body);

      assert.ok(!cuerpo.includes(CULQI.private_key));
      assert.ok(!cuerpo.includes(CULQI.public_key));
    });

    it('un CUSTOMER no accede', async () => {
      assert.equal((await get(RUTA, ctx.sessions.customer.token)).status, 403, 'no pertenece a ninguna empresa');
      assert.equal((await get(`${RUTA}/CULQI`, ctx.sessions.customer.token)).status, 403);
      assert.equal((await put(`${RUTA}/CULQI`, { credentials: CULQI }, ctx.sessions.customer.token)).status, 403);
    });

    it('sin token no se accede', async () => {
      assert.equal((await get(RUTA)).status, 401);
      assert.equal((await get(ADMIN_RUTA)).status, 401);
      assert.equal((await put(`${RUTA}/CULQI`, { credentials: CULQI })).status, 401);
      assert.equal((await post(`${RUTA}/CULQI/connect`)).status, 401);
      assert.equal((await del(`${RUTA}/CULQI`)).status, 401);
    });
  });

  // --- Auditoría --------------------------------------------------------------------

  describe('Auditoría', () => {
    it('registra la configuración sin volcar las credenciales', async () => {
      await guardarCulqi();

      const entrada = await queryOne<{ action: string; description: string; new_values: string | null; user_id: number }>(
        "SELECT action, description, new_values, user_id FROM audit_logs WHERE entity_type = 'company_integrations' ORDER BY id DESC LIMIT 1",
      );

      assert.equal(entrada?.action, 'CREATE');
      assert.equal(Number(entrada!.user_id), ctx.sessions.companyAdmin.user.id);
      assert.match(entrada!.description, /Culqi/);

      const valores = String(entrada!.new_values ?? '');
      assert.ok(!valores.includes(CULQI.private_key), 'la llave privada no llega a audit_logs');
      assert.ok(!valores.includes(CULQI.public_key));
      assert.match(valores, /configured_fields/, 'sí se registran los nombres de los campos');
    });

    it('registra conexión, desconexión, actualización y borrado', async () => {
      await guardarCulqi();
      await guardarCulqi();
      await post(`${RUTA}/CULQI/connect`, undefined, ctx.sessions.companyAdmin.token);
      await post(`${RUTA}/CULQI/disconnect`, undefined, ctx.sessions.companyAdmin.token);
      await del(`${RUTA}/CULQI`, ctx.sessions.companyAdmin.token);

      const acciones = await query<{ action: string }>(
        "SELECT action FROM audit_logs WHERE entity_type = 'company_integrations' ORDER BY id ASC",
      );
      assert.deepEqual(acciones.map((a) => a.action), ['CREATE', 'UPDATE', 'CONNECT', 'DISCONNECT', 'DELETE']);
    });

    it('la auditoría distingue plataforma de empresa', async () => {
      await put(`${ADMIN_RUTA}/CULQI`, { credentials: CULQI }, ctx.sessions.admin.token);

      const entrada = await queryOne<{ description: string }>(
        "SELECT description FROM audit_logs WHERE entity_type = 'company_integrations' ORDER BY id DESC LIMIT 1",
      );
      assert.match(entrada!.description, /plataforma/);
    });
  });

  // --- Seguridad general ---------------------------------------------------------------

  describe('Seguridad general', () => {
    it('resiste inyección SQL en el proveedor y en las credenciales', async () => {
      const inyeccion = await put(
        `${RUTA}/CULQI`,
        { credentials: { public_key: "x'; DROP TABLE company_integrations; --", private_key: 'sk_test_1111' } },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(inyeccion.status, 201);
      assert.ok(Array.isArray(await query('SELECT id FROM company_integrations')), 'la tabla sigue existiendo');

      assert.equal((await get(`${RUTA}/CULQI'%20OR%201=1--`, ctx.sessions.companyAdmin.token)).status, 404);
    });

    it('la respuesta no expone el sobre cifrado ni rutas del servidor', async () => {
      await guardarCulqi();
      const cuerpo = JSON.stringify((await get(`${RUTA}/CULQI`, ctx.sessions.companyAdmin.token)).body);

      assert.ok(!cuerpo.includes('credentials"'), 'no se publica la columna cruda');
      assert.ok(!cuerpo.includes('iv"'), 'ni el vector de inicialización');
      assert.doesNotMatch(cuerpo, /[A-Z]:\\\\|\/home\/|\/var\//);
    });

    it('el estado y la fecha de conexión no se aceptan del cuerpo', async () => {
      await put(
        `${RUTA}/CULQI`,
        { credentials: CULQI, status: 'CONNECTED', connected_at: '2020-01-01 00:00:00', category: 'ANALYTICS' },
        ctx.sessions.companyAdmin.token,
      );

      const fila = await queryOne<{ status: string; connected_at: string | null; category: string }>(
        'SELECT status, connected_at, category FROM company_integrations LIMIT 1',
      );
      assert.notEqual(fila?.status, 'CONNECTED');
      assert.equal(fila?.connected_at, null);
      assert.equal(fila?.category, 'PAYMENT_GATEWAY', 'la categoría sale del catálogo, no del cuerpo');
    });
  });

  // --- Flujo completo ---------------------------------------------------------------------

  describe('Flujo completo', () => {
    it('configurar → conectar → rotar llave → desconectar → eliminar', async () => {
      // 1. Configuración parcial: queda pendiente.
      const parcial = await put(`${RUTA}/NIUBIZ`, { credentials: { merchant_id: '123456' } }, ctx.sessions.companyAdmin.token);
      assert.equal(parcial.body.data.status, 'NEEDS_CONFIG');
      assert.deepEqual(parcial.body.data.missing_fields, ['access_key', 'secret_key']);

      // 2. Se completa.
      const completa = await put(
        `${RUTA}/NIUBIZ`,
        { credentials: { access_key: 'usuario-de-prueba', secret_key: 'clave-de-prueba-7890' } },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(completa.body.data.status, 'DISCONNECTED');
      assert.deepEqual(completa.body.data.missing_fields, []);

      // 3. Se conecta.
      const conectada = await post(`${RUTA}/NIUBIZ/connect`, undefined, ctx.sessions.companyAdmin.token);
      assert.equal(conectada.body.data.status, 'CONNECTED');
      assert.equal(conectada.body.data.processing_active, false, 'conectada no significa operativa');

      // 4. Se rota la clave secreta sin tocar el resto.
      const rotada = await put(`${RUTA}/NIUBIZ`, { credentials: { secret_key: 'clave-rotada-4321' } }, ctx.sessions.companyAdmin.token);
      assert.equal(rotada.body.data.status, 'CONNECTED');
      assert.equal(rotada.body.data.credentials_preview.secret_key, '•••• 4321');
      assert.equal(rotada.body.data.credentials_preview.merchant_id, '•••• 3456', 'lo demás sigue ahí');

      // 5. Se desconecta: las credenciales desaparecen.
      const desconectada = await post(`${RUTA}/NIUBIZ/disconnect`, undefined, ctx.sessions.companyAdmin.token);
      assert.deepEqual(desconectada.body.data.configured_fields, []);

      // 6. Se elimina.
      assert.equal((await del(`${RUTA}/NIUBIZ`, ctx.sessions.companyAdmin.token)).status, 200);
      assert.equal((await query('SELECT id FROM company_integrations')).length, 0);
    });
  });
});
