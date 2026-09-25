import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { del, get, put } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * La bandeja de notificaciones es de cada usuario y de nadie más.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO (auditoría 6F, hallazgo H-12). La cobertura dejó a
 * `notification.routes.ts` en el 66 % de líneas, el peor del backend, y al mirar qué faltaba
 * resultó no ser relleno: las tres operaciones que ESCRIBEN sobre la bandeja —marcar una
 * como leída, marcarlas todas y borrar una— no tenían ni una sola prueba. Lo único que separa
 * la bandeja de un usuario de la de otro en esas tres rutas es un `AND user_id = ?`; si
 * alguien lo quitara en un refactor, nada habría fallado y cualquiera podría leer o BORRAR
 * las notificaciones de otra persona.
 *
 * QUÉ NO SE REPITE AQUÍ. El listado y el contador ya se prueban en `09-notification-expiry`,
 * y el permiso de `POST /notifications/send` en `02-rbac`. Esto cubre solo lo que faltaba.
 */
describe('Bandeja de notificaciones: cada una es de su dueño', () => {
  let ctx: SuiteContext;
  let mia = 0;
  let ajena = 0;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  /** Una notificación sin leer para el cliente y otra para el administrador de empresa. */
  beforeEach(async () => {
    await execute('DELETE FROM notifications');
    mia = (
      await execute(
        `INSERT INTO notifications (user_id, type, title, message, is_read, status)
         VALUES (?, 'IN_APP', 'Para el cliente', 'Mensaje del cliente', 0, 'SENT')`,
        [ctx.fixtures.users.customer],
      )
    ).insertId;
    ajena = (
      await execute(
        `INSERT INTO notifications (user_id, type, title, message, is_read, status)
         VALUES (?, 'IN_APP', 'Para la empresa', 'Mensaje de la empresa', 0, 'SENT')`,
        [ctx.fixtures.users.companyAdmin],
      )
    ).insertId;
  });

  const fila = (id: number) =>
    queryOne<{ id: number; user_id: number; is_read: 0 | 1; read_at: string | null; status: string }>(
      'SELECT id, user_id, is_read, read_at, status FROM notifications WHERE id = ?',
      [id],
    );

  const cliente = () => ctx.sessions.customer.token;

  // =====================================================================
  describe('Marcar una como leída', () => {
    it('1 · el dueño marca la suya y queda leída', async () => {
      const res = await put(`/notifications/${mia}/read`, {}, cliente());
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const actual = await fila(mia);
      assert.equal(Number(actual?.is_read), 1);
      assert.equal(actual?.status, 'READ');
      assert.ok(actual?.read_at, 'se sella la fecha de lectura');
    });

    it('2 · nadie marca la notificación de otro, y la ajena no se toca', async () => {
      const antes = await fila(ajena);

      const res = await put(`/notifications/${ajena}/read`, {}, cliente());
      assert.equal(res.status, 404, 'ni siquiera se confirma que exista');

      assert.deepEqual(await fila(ajena), antes, 'la notificación ajena queda intacta');
    });

    it('3 · una notificación inexistente responde 404 y sin sesión responde 401', async () => {
      assert.equal((await put('/notifications/99999999/read', {}, cliente())).status, 404);
      assert.equal((await put(`/notifications/${mia}/read`, {})).status, 401);
      assert.equal(Number((await fila(mia))?.is_read), 0, 'la petición sin sesión no marcó nada');
    });

    it('4 · marcarla dos veces no rompe nada', async () => {
      assert.equal((await put(`/notifications/${mia}/read`, {}, cliente())).status, 200);
      assert.equal((await put(`/notifications/${mia}/read`, {}, cliente())).status, 200);
      assert.equal(Number((await fila(mia))?.is_read), 1);
    });
  });

  // =====================================================================
  describe('Marcarlas todas como leídas', () => {
    it('5 · marca solo las del usuario y deja las ajenas sin leer', async () => {
      const otraMia = (
        await execute(
          `INSERT INTO notifications (user_id, type, title, message, is_read, status)
           VALUES (?, 'IN_APP', 'Segunda', 'Otra del cliente', 0, 'SENT')`,
          [ctx.fixtures.users.customer],
        )
      ).insertId;

      const res = await put('/notifications/read-all', {}, cliente());
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(Number(res.body.data.updated), 2, 'solo las dos suyas');

      assert.equal(Number((await fila(mia))?.is_read), 1);
      assert.equal(Number((await fila(otraMia))?.is_read), 1);
      assert.equal(Number((await fila(ajena))?.is_read), 0, 'la de la otra persona sigue sin leer');
    });

    it('6 · el contador de no leídas cuenta solo las propias', async () => {
      const antes = await get('/notifications/unread-count', cliente());
      assert.equal(Number(antes.body.data.unread), 1, 'la del otro usuario no cuenta');

      await put('/notifications/read-all', {}, cliente());

      const despues = await get('/notifications/unread-count', cliente());
      assert.equal(Number(despues.body.data.unread), 0);

      // Y la otra persona sigue teniendo la suya pendiente.
      const otro = await get('/notifications/unread-count', ctx.sessions.companyAdmin.token);
      assert.equal(Number(otro.body.data.unread), 1);
    });

    it('7 · sin sesión no marca nada', async () => {
      assert.equal((await put('/notifications/read-all', {})).status, 401);
      assert.equal(Number((await fila(mia))?.is_read), 0);
    });
  });

  // =====================================================================
  describe('Borrar una notificación', () => {
    it('8 · el dueño borra la suya', async () => {
      const res = await del(`/notifications/${mia}`, cliente());
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(await fila(mia), null);
    });

    it('9 · nadie borra la notificación de otro', async () => {
      const res = await del(`/notifications/${ajena}`, cliente());
      assert.equal(res.status, 404);

      assert.ok(await fila(ajena), 'la notificación ajena sigue ahí');
      assert.equal(Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM notifications'))?.n), 2);
    });

    it('10 · ni el ADMIN borra la bandeja de otro por esta vía', async () => {
      // El endpoint es personal: no hay un borrado administrativo por aquí.
      const res = await del(`/notifications/${mia}`, ctx.sessions.admin.token);
      assert.equal(res.status, 404);
      assert.ok(await fila(mia));
    });

    it('11 · una notificación inexistente responde 404 y sin sesión responde 401', async () => {
      assert.equal((await del('/notifications/99999999', cliente())).status, 404);
      assert.equal((await del(`/notifications/${mia}`)).status, 401);
      assert.ok(await fila(mia), 'la petición sin sesión no borró nada');
    });
  });

  // =====================================================================
  describe('El listado tampoco enseña lo ajeno', () => {
    it('12 · cada usuario ve solo sus notificaciones', async () => {
      const delCliente = await get('/notifications?limit=50', cliente());
      assert.equal(delCliente.status, 200);
      const idsCliente = (delCliente.body.data as Array<{ id: number; user_id: number }>).map((n) => n.id);
      assert.ok(idsCliente.includes(mia));
      assert.equal(idsCliente.includes(ajena), false);

      const deLaEmpresa = await get('/notifications?limit=50', ctx.sessions.companyAdmin.token);
      const idsEmpresa = (deLaEmpresa.body.data as Array<{ id: number }>).map((n) => n.id);
      assert.ok(idsEmpresa.includes(ajena));
      assert.equal(idsEmpresa.includes(mia), false);
    });

    it('13 · un `user_id` inyectado en la consulta no amplía lo que se ve', async () => {
      const res = await get(`/notifications?limit=50&user_id=${ctx.fixtures.users.companyAdmin}`, cliente());
      assert.equal(res.status, 200);
      const ids = (res.body.data as Array<{ id: number }>).map((n) => n.id);
      assert.equal(ids.includes(ajena), false, 'el filtro del cliente no puede saltarse');
    });
  });
});
