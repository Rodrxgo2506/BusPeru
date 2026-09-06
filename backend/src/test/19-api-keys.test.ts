import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Request } from 'express';
import { get, post } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { authenticateApiKeyRequest, requireApiKeyPermission } from '../middleware/api-key.middleware';
import { assertApiKeyOwns, authenticateApiKey } from '../services/api-key.service';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * BP-11 · autenticación por API Key.
 *
 * El módulo generaba llaves y guardaba su hash, pero nadie las leía nunca: `key_hash` solo
 * se escribía y el middleware únicamente aceptaba `Bearer <JWT>`. Aquí se prueba la pieza
 * que faltaba.
 *
 * NO hay ninguna ruta de negocio protegida con API Key —BusPerú no tiene hoy superficie
 * para sistemas externos y no se han inventado endpoints—, así que el autenticador y su
 * middleware se ejercitan directamente. Es código real contra la base real de pruebas: lo
 * único que falta es el consumidor.
 */
describe('BP-11 · autenticación por API Key', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  /** Crea una llave por la API de gestión y devuelve la clave en claro y su fila. */
  async function crearLlave(
    cuerpo: Record<string, unknown> = {},
    token = ctx.sessions.admin.token,
  ): Promise<{ plain: string; id: number }> {
    const res = await post('/api-keys', { name: 'Integración de prueba', company_id: ctx.fixtures.companyA, ...cuerpo }, token);
    assert.equal(res.status, 201, `no se pudo crear la llave: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.data.plain_key, 'la creación debe devolver la clave completa');
    return { plain: res.body.data.plain_key as string, id: res.body.data.id as number };
  }

  /** Ejecuta el middleware con una cabecera concreta y devuelve lo que le llegó a `next`. */
  async function pasarPorMiddleware(headers: Record<string, unknown>) {
    const req = { headers } as unknown as Request;
    const resultado = await new Promise<unknown>((resolve) => {
      authenticateApiKeyRequest(req, {} as never, ((error?: unknown) => resolve(error)) as never);
    });
    return { req, error: resultado as { statusCode?: number; message?: string } | undefined };
  }

  describe('Credencial válida', () => {
    it('una clave activa autentica y resuelve su empresa', async () => {
      const { plain, id } = await crearLlave();
      const identidad = await authenticateApiKey(plain);

      assert.equal(identidad.id, id);
      assert.equal(identidad.companyId, ctx.fixtures.companyA);
      assert.equal(identidad.environment, 'TEST');
      assert.ok(identidad.permissions.length > 0, 'debe heredar el techo de la empresa');
    });

    it('el middleware la acepta y deja la identidad en req.apiKey', async () => {
      const { plain } = await crearLlave();
      const { req, error } = await pasarPorMiddleware({ 'x-api-key': plain });

      assert.equal(error, undefined, 'no debe haber error');
      assert.equal(req.apiKey?.companyId, ctx.fixtures.companyA);
      assert.equal(req.user, undefined, 'una llave no es una persona: no toca req.user');
    });
  });

  describe('Credencial ausente, inválida o caducada', () => {
    it('sin cabecera responde 401', async () => {
      const { req, error } = await pasarPorMiddleware({});
      assert.equal(error?.statusCode, 401);
      assert.equal(req.apiKey, undefined);
    });

    it('una cabecera vacía o con espacios también', async () => {
      assert.equal((await pasarPorMiddleware({ 'x-api-key': '' })).error?.statusCode, 401);
      assert.equal((await pasarPorMiddleware({ 'x-api-key': '   ' })).error?.statusCode, 401);
    });

    it('una clave con formato inválido se rechaza sin tocar la base', async () => {
      for (const invalida of ['no-es-una-clave', 'bp_xxxx.yyyy', 'bp_1234abcd', `bp_1234abcd.${'z'.repeat(48)}`]) {
        await assert.rejects(() => authenticateApiKey(invalida), (error: { statusCode: number }) => error.statusCode === 401);
      }
    });

    it('una clave bien formada pero inexistente se rechaza', async () => {
      await assert.rejects(
        () => authenticateApiKey(`bp_00000000.${'a'.repeat(48)}`),
        (error: { statusCode: number }) => error.statusCode === 401,
      );
    });

    it('cambiar un carácter del secreto invalida la clave', async () => {
      const { plain } = await crearLlave();
      const [prefijo, secreto] = plain.split('.');
      const alterado = `${prefijo}.${secreto!.slice(0, -1)}${secreto!.endsWith('a') ? 'b' : 'a'}`;

      await assert.rejects(() => authenticateApiKey(alterado), (error: { statusCode: number }) => error.statusCode === 401);
    });

    it('una clave revocada deja de autenticar de inmediato', async () => {
      const { plain, id } = await crearLlave();
      assert.ok(await authenticateApiKey(plain), 'funciona antes de revocarla');

      const revocada = await post(`/api-keys/${id}/revoke`, {}, ctx.sessions.admin.token);
      assert.equal(revocada.status, 200);
      assert.equal(revocada.body.data.status, 'REVOKED');

      await assert.rejects(() => authenticateApiKey(plain), (error: { statusCode: number }) => error.statusCode === 401);
    });

    it('una clave caducada no autentica', async () => {
      const { plain, id } = await crearLlave();
      await execute('UPDATE api_keys SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [id]);

      await assert.rejects(() => authenticateApiKey(plain), (error: { statusCode: number }) => error.statusCode === 401);
    });

    it('una clave con caducidad futura sí autentica', async () => {
      const { plain, id } = await crearLlave();
      await execute('UPDATE api_keys SET expires_at = DATE_ADD(NOW(), INTERVAL 1 DAY) WHERE id = ?', [id]);

      assert.equal((await authenticateApiKey(plain)).id, id);
    });

    it('todos los rechazos comparten mensaje: no se puede distinguir el motivo', async () => {
      const { plain, id } = await crearLlave();
      await post(`/api-keys/${id}/revoke`, {}, ctx.sessions.admin.token);

      const mensajes = new Set<string>();
      for (const clave of [plain, `bp_00000000.${'a'.repeat(48)}`]) {
        await authenticateApiKey(clave).catch((error: { message: string }) => mensajes.add(error.message));
      }
      assert.equal(mensajes.size, 1, 'revocada e inexistente responden igual');
    });
  });

  describe('Entorno', () => {
    it('una clave de PRODUCTION no autentica en un proceso que no es de producción', async () => {
      const { plain } = await crearLlave({ environment: 'PRODUCTION' });

      await assert.rejects(() => authenticateApiKey(plain), (error: { statusCode: number }) => error.statusCode === 401);
    });

    it('una clave TEST sí autentica aquí', async () => {
      const { plain } = await crearLlave({ environment: 'TEST' });
      assert.equal((await authenticateApiKey(plain)).environment, 'TEST');
    });
  });

  describe('Aislamiento multiempresa', () => {
    it('la empresa sale de la llave, nunca del cliente', async () => {
      const { plain } = await crearLlave({ company_id: ctx.fixtures.companyA });
      const identidad = await authenticateApiKey(plain);

      // Ni el cuerpo, ni la query, ni otra cabecera cambian el alcance: no se leen.
      const { req } = await pasarPorMiddleware({ 'x-api-key': plain, 'x-company-id': String(ctx.fixtures.companyB) });
      assert.equal(req.apiKey?.companyId, ctx.fixtures.companyA);
      assert.equal(identidad.companyId, ctx.fixtures.companyA);
    });

    it('una llave de la empresa A no alcanza recursos de la B', async () => {
      const { plain } = await crearLlave({ company_id: ctx.fixtures.companyA });
      const identidad = await authenticateApiKey(plain);

      assert.doesNotThrow(() => assertApiKeyOwns(identidad, ctx.fixtures.companyA));
      assert.throws(
        () => assertApiKeyOwns(identidad, ctx.fixtures.companyB),
        (error: { statusCode: number }) => error.statusCode === 404,
        'un recurso ajeno responde 404, no 403',
      );
      assert.throws(() => assertApiKeyOwns(identidad, null), (error: { statusCode: number }) => error.statusCode === 404);
    });

    it('una llave de la empresa B resuelve la empresa B', async () => {
      const { plain } = await crearLlave({ company_id: ctx.fixtures.companyB });
      assert.equal((await authenticateApiKey(plain)).companyId, ctx.fixtures.companyB);
    });

    it('una llave sin empresa no autentica: su identidad ES la empresa', async () => {
      const { plain, id } = await crearLlave();
      await execute('UPDATE api_keys SET company_id = NULL WHERE id = ?', [id]);

      await assert.rejects(() => authenticateApiKey(plain), (error: { statusCode: number }) => error.statusCode === 401);
    });

    it('si la empresa no está activa, la llave se bloquea con 403', async () => {
      const { plain } = await crearLlave({ company_id: ctx.fixtures.companyB });
      await execute("UPDATE companies SET status = 'SUSPENDED' WHERE id = ?", [ctx.fixtures.companyB]);

      try {
        await assert.rejects(() => authenticateApiKey(plain), (error: { statusCode: number }) => error.statusCode === 403);
      } finally {
        await execute("UPDATE companies SET status = 'ACTIVE' WHERE id = ?", [ctx.fixtures.companyB]);
      }

      assert.ok(await authenticateApiKey(plain), 'al reactivarla vuelve a valer');
    });
  });

  describe('Permisos efectivos', () => {
    async function permisosDeEmpresa(): Promise<string[]> {
      const filas = await query<{ name: string }>(
        `SELECT p.name FROM roles r
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE r.name = 'COMPANY_ADMIN' ORDER BY p.name`,
      );
      return filas.map((f) => f.name);
    }

    it('sin permisos declarados hereda el techo de la empresa', async () => {
      const { plain } = await crearLlave();
      const identidad = await authenticateApiKey(plain);

      assert.deepEqual(identidad.permissions.slice().sort(), (await permisosDeEmpresa()).slice().sort());
    });

    it('los permisos declarados recortan, nunca amplían', async () => {
      const { plain } = await crearLlave({ permissions: ['trips.view', 'bookings.view'] });
      const identidad = await authenticateApiKey(plain);

      assert.deepEqual(identidad.permissions.slice().sort(), ['bookings.view', 'trips.view']);
    });

    it('un permiso que la empresa no tiene se descarta aunque la llave lo pida', async () => {
      const { plain } = await crearLlave({
        permissions: ['trips.view', 'settings.update', 'roles.delete', 'audit_logs.view', 'payments.refund', 'users.delete'],
      });
      const identidad = await authenticateApiKey(plain);

      assert.deepEqual(identidad.permissions, ['trips.view'], 'solo sobrevive lo que la empresa sí tiene');
      const techo = await permisosDeEmpresa();
      for (const prohibido of ['settings.update', 'roles.delete', 'audit_logs.view', 'payments.refund', 'users.delete']) {
        assert.equal(techo.includes(prohibido), false, `${prohibido} no está en el techo de empresa`);
        assert.equal(identidad.permissions.includes(prohibido), false, `${prohibido} no debe concederse`);
      }
    });

    it('una lista vacía deja la llave sin permisos', async () => {
      const { plain } = await crearLlave({ permissions: [] });
      assert.deepEqual((await authenticateApiKey(plain)).permissions, []);
    });

    it('un JSON que no es una lista no se interpreta como «todo»', async () => {
      const { plain, id } = await crearLlave();
      await execute('UPDATE api_keys SET permissions = ? WHERE id = ?', ['{"admin":true}', id]);

      assert.deepEqual((await authenticateApiKey(plain)).permissions, []);
    });

    it('el middleware de permiso deja pasar lo concedido y corta lo demás', async () => {
      const { plain } = await crearLlave({ permissions: ['trips.view'] });
      const { req } = await pasarPorMiddleware({ 'x-api-key': plain });

      const evaluar = (permiso: string) =>
        new Promise<{ statusCode?: number } | undefined>((resolve) => {
          requireApiKeyPermission(permiso)(req, {} as never, ((error?: unknown) => resolve(error as never)) as never);
        });

      assert.equal(await evaluar('trips.view'), undefined, 'permiso concedido: pasa');
      assert.equal((await evaluar('trips.delete'))?.statusCode, 403, 'permiso ausente: 403');
      assert.equal((await evaluar('settings.update'))?.statusCode, 403);
    });

    it('sin identidad, el middleware de permiso responde 401', async () => {
      const req = { headers: {} } as unknown as Request;
      const error = await new Promise<{ statusCode?: number }>((resolve) => {
        requireApiKeyPermission('trips.view')(req, {} as never, ((e?: unknown) => resolve(e as never)) as never);
      });
      assert.equal(error?.statusCode, 401);
    });
  });

  describe('Uso y secreto', () => {
    it('last_used_at se marca cuando la clave autentica', async () => {
      const { plain, id } = await crearLlave();
      assert.equal((await queryOne<{ last_used_at: string | null }>('SELECT last_used_at FROM api_keys WHERE id = ?', [id]))?.last_used_at, null);

      await authenticateApiKey(plain);

      const despues = await queryOne<{ last_used_at: string | null }>('SELECT last_used_at FROM api_keys WHERE id = ?', [id]);
      assert.ok(despues?.last_used_at, 'debe quedar registrado el uso');
    });

    it('no se marca con una clave revocada, caducada ni inexistente', async () => {
      const revocada = await crearLlave();
      await post(`/api-keys/${revocada.id}/revoke`, {}, ctx.sessions.admin.token);

      const caducada = await crearLlave();
      await execute('UPDATE api_keys SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [caducada.id]);

      await authenticateApiKey(revocada.plain).catch(() => undefined);
      await authenticateApiKey(caducada.plain).catch(() => undefined);
      await authenticateApiKey(`bp_00000000.${'a'.repeat(48)}`).catch(() => undefined);

      for (const { id } of [revocada, caducada]) {
        const fila = await queryOne<{ last_used_at: string | null }>('SELECT last_used_at FROM api_keys WHERE id = ?', [id]);
        assert.equal(fila?.last_used_at, null, 'una credencial rechazada no deja rastro de uso');
      }
    });

    it('la marca de uso se limita a una escritura por minuto', async () => {
      const { plain, id } = await crearLlave();
      await authenticateApiKey(plain);
      const primera = await queryOne<{ last_used_at: string }>('SELECT last_used_at FROM api_keys WHERE id = ?', [id]);

      await authenticateApiKey(plain);
      const segunda = await queryOne<{ last_used_at: string }>('SELECT last_used_at FROM api_keys WHERE id = ?', [id]);
      assert.equal(segunda?.last_used_at, primera?.last_used_at, 'no reescribe en la misma ventana');

      // Se atrasa la marca para salir de la ventana. Se compara contra ESE valor y no
      // contra el anterior: `NOW()` tiene resolución de segundo y todo el test corre dentro
      // del mismo, así que comparar con el primero mediría el reloj, no el comportamiento.
      await execute('UPDATE api_keys SET last_used_at = DATE_SUB(NOW(), INTERVAL 5 MINUTE) WHERE id = ?', [id]);
      const atrasada = await queryOne<{ last_used_at: string }>('SELECT last_used_at FROM api_keys WHERE id = ?', [id]);

      await authenticateApiKey(plain);
      const tercera = await queryOne<{ last_used_at: string }>('SELECT last_used_at FROM api_keys WHERE id = ?', [id]);
      assert.notEqual(tercera?.last_used_at, atrasada?.last_used_at, 'pasada la ventana sí se refresca');
    });

    it('la clave completa solo se ve al crearla', async () => {
      const { plain, id } = await crearLlave();

      const listado = await get('/api-keys', ctx.sessions.admin.token);
      assert.equal(listado.status, 200);
      const serializado = JSON.stringify(listado.body);

      assert.equal(serializado.includes(plain), false, 'la clave no puede volver a aparecer');
      assert.equal(serializado.includes('key_hash'), false, 'el hash tampoco se publica');
      assert.equal(serializado.includes('plain_key'), false);

      const fila = listado.body.data.find((k: { id: number }) => k.id === id);
      assert.ok(fila, 'la llave sí aparece en el listado');
      assert.ok(fila.key_prefix, 'solo con su prefijo, que no es secreto');
    });

    it('en la base solo vive el hash, nunca la clave', async () => {
      const { plain, id } = await crearLlave();
      const fila = await queryOne<{ key_hash: string }>('SELECT key_hash FROM api_keys WHERE id = ?', [id]);

      assert.ok(fila?.key_hash);
      assert.equal(fila!.key_hash.includes(plain), false);
      assert.equal(fila!.key_hash.length, 64, 'sha256 en hexadecimal');
    });
  });

  describe('Regresión: los mecanismos existentes no cambian', () => {
    it('el JWT sigue funcionando y no necesita cabecera de API Key', async () => {
      assert.equal((await get('/auth/me', ctx.sessions.admin.token)).status, 200);
      assert.equal((await get('/buses', ctx.sessions.companyAdmin.token)).status, 200);
      assert.equal((await get('/bookings?limit=1', ctx.sessions.customer.token)).status, 200);
    });

    it('una API Key no sirve como JWT en las rutas actuales', async () => {
      const { plain } = await crearLlave();
      assert.equal((await get('/auth/me', plain)).status, 401, 'los dos mecanismos no se mezclan');
      assert.equal((await get('/buses', plain)).status, 401);
    });

    it('los endpoints públicos siguen abiertos sin ninguna credencial', async () => {
      for (const ruta of ['/public/cities', '/public/trips', '/public/companies', '/public/settings']) {
        assert.equal((await get(ruta)).status, 200, `${ruta} debe seguir siendo público`);
      }
    });

    it('la gestión de llaves sigue exigiendo sesión y permiso', async () => {
      assert.equal((await get('/api-keys')).status, 401);
      assert.equal((await post('/api-keys', { name: 'Sin permiso' }, ctx.sessions.customer.token)).status, 403);
      assert.equal((await post('/api-keys', { name: 'Sin permiso' }, ctx.sessions.companyAdmin.token)).status, 403);
    });
  });
});
