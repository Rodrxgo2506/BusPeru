import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { after, before, beforeEach, describe, it } from 'node:test';
import { get, put, testBaseUrl } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { env } from '../config/env';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * BP-25 · detalles menores de robustez.
 *
 * La auditoría agrupó cinco asperezas bajo un mismo hallazgo de severidad baja. Aquí se
 * fijan las tres que se corrigieron y se deja constancia del comportamiento de las dos que
 * se dejaron como estaban, para que un cambio futuro sea una decisión y no un descuido:
 *
 *   a) `jwt.verify` no fijaba `algorithms`.
 *   b) el 404 devolvía al cliente la URL que el cliente acababa de enviar.
 *   c) las integraciones se atan a `companyIds[0]` — **sin corregir**, ver más abajo.
 *   d) el Portal Empresa dejaba entrar a un ADMIN sin empresa — corregido en el frontend.
 *   e) un ADMIN podía dejar la plataforma sin nadie capaz de administrar permisos.
 */
describe('BP-25 · robustez y bordes', () => {
  let ctx: SuiteContext;
  let rolAdmin: number;
  let permisoRolesUpdate: number;

  before(async () => {
    ctx = await prepareSuite();
    rolAdmin = (await queryOne<{ id: number }>("SELECT id FROM roles WHERE name = 'ADMIN'"))!.id;
    permisoRolesUpdate = (await queryOne<{ id: number }>("SELECT id FROM permissions WHERE name = 'roles.update'"))!.id;
  });
  after(teardownSuite);

  /** Los permisos de un rol, para poder restituirlos tras cada caso. */
  async function permisosDe(roleId: number): Promise<number[]> {
    const filas = await query<{ permission_id: number }>(
      'SELECT permission_id FROM role_permissions WHERE role_id = ? ORDER BY permission_id',
      [roleId],
    );
    return filas.map((fila) => Number(fila.permission_id));
  }

  let permisosOriginales: number[] = [];
  beforeEach(async () => {
    permisosOriginales = await permisosDe(rolAdmin);
  });

  /** Devuelve el rol ADMIN a su estado original sin pasar por la API. */
  async function restaurarAdmin(): Promise<void> {
    await execute('DELETE FROM role_permissions WHERE role_id = ?', [rolAdmin]);
    for (const permiso of permisosOriginales) {
      await execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [rolAdmin, permiso]);
    }
  }

  /* ══════════════════════════ (a) verificación del token ═════════════════════ */

  describe('a · el algoritmo del token está fijado', () => {
    /** Vuelve a firmar las claims de un token real con otras opciones. */
    function refirmar(token: string, secret: string, options: jwt.SignOptions = {}): string {
      const claims = jwt.decode(token) as Record<string, unknown>;
      delete claims.iat;
      delete claims.exp;
      return jwt.sign(claims, secret, { expiresIn: '8h', ...options });
    }

    it('1 · el token legítimo sigue funcionando', async () => {
      const res = await get('/auth/me', ctx.sessions.admin.token);
      assert.equal(res.status, 200);
    });

    it('2 · un token sin firma (`alg: none`) se rechaza', async () => {
      const claims = jwt.decode(ctx.sessions.admin.token) as Record<string, unknown>;
      delete claims.iat;
      delete claims.exp;
      const sinFirma = jwt.sign(claims, '', { algorithm: 'none' } as never);

      const res = await get('/auth/me', sinFirma);

      assert.equal(res.status, 401);
    });

    it('3 · un token firmado con otro secreto se rechaza', async () => {
      const res = await get('/auth/me', refirmar(ctx.sessions.admin.token, 'otro-secreto-cualquiera'));

      assert.equal(res.status, 401);
    });

    it('4 · las claims del token real se mantienen: no se rompió el contrato', async () => {
      const claims = jwt.decode(ctx.sessions.admin.token) as Record<string, unknown>;

      // `pwd` es la huella de sesión de BP-18; `sub`/`role` sostienen la autorización; `jti`
      // identifica el token para revocarlo al cerrar sesión (F12-07).
      assert.deepEqual(Object.keys(claims).sort(), ['exp', 'iat', 'jti', 'pwd', 'role', 'roleId', 'sub']);
      assert.match(String(claims.jti), /^[0-9a-f]{32}$/);
      const rehecho = refirmar(ctx.sessions.admin.token, env.jwt.secret);
      assert.equal((await get('/auth/me', rehecho)).status, 200);
    });
  });

  /* ══════════════════════════ (b) el 404 no refleja la URL ══════════════════ */

  describe('b · una ruta inexistente no devuelve lo que envió el cliente', () => {
    it('5 · el mensaje ya no lleva la URL', async () => {
      const res = await fetch(`${testBaseUrl()}/ruta-que-no-existe`);
      const body = (await res.json()) as { message: string };

      assert.equal(res.status, 404);
      assert.equal(body.message, 'Ruta no encontrada');
      assert.ok(!body.message.includes('ruta-que-no-existe'));
    });

    it('6 · tampoco refleja caracteres peligrosos', async () => {
      const res = await fetch(`${testBaseUrl()}/%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
      const texto = await res.text();

      assert.equal(res.status, 404);
      assert.ok(!texto.includes('script'), `la respuesta refleja la entrada: ${texto}`);
      assert.ok(!texto.includes('alert'));
    });

    it('7 · una ruta que sí existe sigue respondiendo lo suyo', async () => {
      const res = await get('/roles', ctx.sessions.admin.token);
      assert.equal(res.status, 200);
    });
  });

  /* ══════════════════════════ (e) la plataforma no se tapia ════════════════ */

  describe('e · no se puede dejar la plataforma sin quien administre permisos', () => {
    it('8 · vaciar los permisos del rol ADMIN se rechaza', async () => {
      const res = await put(`/roles/${rolAdmin}/permissions`, { permission_ids: [] }, ctx.sessions.admin.token);

      assert.equal(res.status, 409);
      assert.match(String(res.body.message), /sin ningún usuario activo capaz de administrar permisos/i);
    });

    it('9 · el rechazo revierte la transacción entera: no se pierde ni un permiso', async () => {
      const antes = await permisosDe(rolAdmin);
      assert.ok(antes.length > 0);

      await put(`/roles/${rolAdmin}/permissions`, { permission_ids: [] }, ctx.sessions.admin.token);

      assert.deepEqual(await permisosDe(rolAdmin), antes, 'el DELETE debe deshacerse con el ROLLBACK');
    });

    it('10 · quitar `roles.update` al ADMIN sin dárselo a nadie también se rechaza', async () => {
      const sinRolesUpdate = permisosOriginales.filter((permiso) => permiso !== permisoRolesUpdate);

      const res = await put(
        `/roles/${rolAdmin}/permissions`,
        { permission_ids: sinRolesUpdate },
        ctx.sessions.admin.token,
      );

      assert.equal(res.status, 409);
      assert.ok((await permisosDe(rolAdmin)).includes(permisoRolesUpdate));
    });

    it('11 · un cambio que conserva el permiso sí se aplica', async () => {
      // Se recorta el rol a dos permisos, uno de ellos `roles.update`: sigue habiendo quien
      // administre, así que la guarda no estorba.
      const permisoRolesView = (await queryOne<{ id: number }>("SELECT id FROM permissions WHERE name = 'roles.view'"))!.id;

      const res = await put(
        `/roles/${rolAdmin}/permissions`,
        { permission_ids: [permisoRolesUpdate, permisoRolesView] },
        ctx.sessions.admin.token,
      );

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual((await permisosDe(rolAdmin)).sort((a, b) => a - b), [permisoRolesUpdate, permisoRolesView].sort((a, b) => a - b));
      await restaurarAdmin();
    });

    it('12 · la guarda no impide reorganizar: se puede mover el permiso a otro rol', async () => {
      const rolEmpresa = (await queryOne<{ id: number }>("SELECT id FROM roles WHERE name = 'COMPANY_ADMIN'"))!.id;
      // Primero se le da `roles.update` al rol de empresa, que tiene un usuario activo...
      await execute('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [
        rolEmpresa,
        permisoRolesUpdate,
      ]);

      // ...y ahora quitárselo al ADMIN es legítimo: la plataforma sigue administrable.
      const res = await put(
        `/roles/${rolAdmin}/permissions`,
        { permission_ids: permisosOriginales.filter((permiso) => permiso !== permisoRolesUpdate) },
        ctx.sessions.admin.token,
      );

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(!(await permisosDe(rolAdmin)).includes(permisoRolesUpdate));

      await execute('DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?', [
        rolEmpresa,
        permisoRolesUpdate,
      ]);
      await restaurarAdmin();
    });

    it('13 · los permisos de un rol cualquiera se siguen editando sin trabas', async () => {
      const rolOperador = (await queryOne<{ id: number }>("SELECT id FROM roles WHERE name = 'OPERATOR'"))!.id;
      const originales = await permisosDe(rolOperador);

      const res = await put(`/roles/${rolOperador}/permissions`, { permission_ids: [] }, ctx.sessions.admin.token);

      assert.equal(res.status, 200, 'vaciar un rol que no administra permisos es legítimo');
      assert.deepEqual(await permisosDe(rolOperador), []);

      await put(`/roles/${rolOperador}/permissions`, { permission_ids: originales }, ctx.sessions.admin.token);
      assert.deepEqual(await permisosDe(rolOperador), originales);
    });

    it('14 · tras un intento fallido la plataforma sigue administrable', async () => {
      await put(`/roles/${rolAdmin}/permissions`, { permission_ids: [] }, ctx.sessions.admin.token);

      assert.equal((await get('/roles', ctx.sessions.admin.token)).status, 200);
      assert.equal(
        (await put(`/roles/${rolAdmin}/permissions`, { permission_ids: permisosOriginales }, ctx.sessions.admin.token))
          .status,
        200,
      );
    });
  });

  /* ══════════════════════════ (c) y (d): comportamiento documentado ═════════ */

  describe('c y d · bordes que se dejan como están, con su comportamiento fijado', () => {
    it('15 · (d) el backend sigue siendo la autoridad: un ADMIN sin empresa recibe 403', async () => {
      // El guard del frontend ahora comprueba lo mismo antes de pintar el Portal Empresa,
      // pero la protección de verdad está aquí y no ha cambiado.
      const empresas = await query('SELECT company_id FROM company_users WHERE user_id = ?', [ctx.fixtures.users.admin]);
      assert.deepEqual(empresas, [], 'el ADMIN de las fixtures no está asociado a ninguna empresa');

      assert.equal((await get('/company/integrations', ctx.sessions.admin.token)).status, 403);
      assert.equal((await get('/dashboard/company', ctx.sessions.admin.token)).status, 403);
    });

    it('16 · (c) las integraciones se resuelven por la PRIMERA empresa del usuario', async () => {
      // No es una corrección: es dejar por escrito el comportamiento actual. Permitir elegir
      // empresa exigiría un parámetro nuevo y una forma de escogerla en la interfaz, es
      // decir, funcionalidad que nadie ha pedido. Hoy no afecta a nadie: ni `busperu` ni
      // `busperu_test` tienen un solo usuario asociado a dos empresas.
      const multiEmpresa = await query(
        'SELECT user_id FROM company_users GROUP BY user_id HAVING COUNT(*) > 1',
      );
      assert.deepEqual(multiEmpresa, [], 'si esto deja de estar vacío, (c) pasa a afectar a alguien real');

      const res = await get('/company/integrations', ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200);
    });
  });
});
