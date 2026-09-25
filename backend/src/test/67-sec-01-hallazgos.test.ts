import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { del, get, post, put } from './helpers/api';
import { execute, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * F17C-SEC-01 · Fase 1B — regresión de los hallazgos H-01, H-02 y H-03.
 *
 * H-01 · `promotions.usage_limit` no frenaba nada: `resolveCoupon` leía `promotion_limit` y
 *        `promotion_usage` y no los comprobaba, mientras el canje SÍ incrementaba el contador.
 * H-02 · `system_settings`, `notification_templates` y `company_commission_settings` dependían
 *        sólo de `settings.update`, un permiso reasignable en caliente desde `/roles/:id/permissions`.
 * H-03 · `GET /reports/:report` indexaba `REPORTS[key]` con el parámetro de ruta en crudo, así que
 *        los nombres heredados de `Object.prototype` daban 500 en lugar de 404.
 *
 * H-04 es documentación y no tiene prueba automática: se verifica leyendo el comentario.
 */
describe('F17C-SEC-01 · H-01, H-02 y H-03', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  /* ================================================================== H-01 */
  describe('H-01 · el límite de usos de la promoción frena el canje', () => {
    let promocionA = 0;
    let promocionB = 0;
    let tripA2 = 0;

    /** Promoción creada por el ADMIN para la empresa indicada. `usage_limit` se ajusta luego por SQL. */
    const crearPromocion = async (companyId: number, name: string): Promise<number> => {
      const res = await post(
        '/promotions',
        {
          company_id: companyId,
          name,
          discount_type: 'PERCENTAGE',
          discount_value: 10,
          start_at: '2020-01-01 00:00:00',
          end_at: '2035-12-31 23:59:59',
          status: 'ACTIVE',
        },
        ctx.sessions.admin.token,
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return Number(res.body.data.id);
    };

    const crearCupon = async (promotionId: number, code: string): Promise<void> => {
      const res = await post('/coupons', { promotion_id: promotionId, code, status: 'ACTIVE' }, ctx.sessions.admin.token);
      assert.equal(res.status, 201, JSON.stringify(res.body));
    };

    /** Estado de la campaña, leído de la base y no de la respuesta. */
    const contador = async (promotionId: number): Promise<{ usage_count: number; usage_limit: number | null }> => {
      const fila = await queryOne<{ usage_count: number; usage_limit: number | null }>(
        'SELECT usage_count, usage_limit FROM promotions WHERE id = ?',
        [promotionId],
      );
      assert.ok(fila, 'la promoción debería existir');
      return fila;
    };

    const ajustar = async (promotionId: number, limite: number | null, usados: number): Promise<void> => {
      await execute('UPDATE promotions SET usage_limit = ?, usage_count = ? WHERE id = ?', [limite, usados, promotionId]);
    };

    const reservar = async (tripId: number, cupon?: string) => {
      const libres = await freeSeats(tripId);
      return post(
        '/bookings',
        { trip_id: tripId, seat_ids: [at(libres, 0).id], passenger_email: 'cliente@test.pe', ...(cupon ? { coupon_code: cupon } : {}) },
        ctx.sessions.customer.token,
      );
    };

    before(async () => {
      // Segundo viaje de la MISMA empresa: la prueba de concurrencia necesita dos viajes
      // distintos para que el bloqueo compartido sea el de la promoción y no el del viaje.
      tripA2 = (
        await execute(
          `INSERT INTO trips (route_id, bus_id, bus_layout_id, departure_datetime, base_price, available_seats, status)
           SELECT route_id, bus_id, bus_layout_id, DATE_ADD(departure_datetime, INTERVAL 3 DAY), base_price, available_seats, 'SCHEDULED'
           FROM trips WHERE id = ?`,
          [ctx.fixtures.tripA],
        )
      ).insertId;

      promocionA = await crearPromocion(ctx.fixtures.companyA, 'SEC01 campaña A');
      promocionB = await crearPromocion(ctx.fixtures.companyB, 'SEC01 campaña B');
      // Dos códigos de la MISMA campaña: así el único candado en común es la fila de la promoción.
      await crearCupon(promocionA, 'SEC01UNO');
      await crearCupon(promocionA, 'SEC01DOS');
      await crearCupon(promocionB, 'SEC01EMPB');
    });

    beforeEach(async () => {
      for (const tabla of ['coupon_usages', 'booking_seats', 'payments', 'notifications', 'bookings']) {
        await execute(`DELETE FROM ${tabla}`);
      }
      await execute("UPDATE trips t JOIN buses b ON b.id = t.bus_id SET t.available_seats = b.capacity, t.status = 'SCHEDULED'");
      await execute('UPDATE coupons SET usage_count = 0');
      await execute('UPDATE promotions SET usage_count = 0, usage_limit = NULL');
    });

    it('A · usage_limit NULL: la campaña es ilimitada y el cupón sigue funcionando', async () => {
      await ajustar(promocionA, null, 99);
      const res = await reservar(ctx.fixtures.tripA, 'SEC01UNO');
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.ok(Number(res.body.data.discount_amount) > 0, 'debería haberse aplicado el descuento');
      assert.equal((await contador(promocionA)).usage_count, 100);
    });

    it('B · usage_limit 3 con 0 usados: el primer canje se permite', async () => {
      await ajustar(promocionA, 3, 0);
      const res = await reservar(ctx.fixtures.tripA, 'SEC01UNO');
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal((await contador(promocionA)).usage_count, 1);
    });

    it('C · usage_limit 3 con 2 usados: el tercer canje se permite y agota la campaña', async () => {
      await ajustar(promocionA, 3, 2);
      const res = await reservar(ctx.fixtures.tripA, 'SEC01UNO');
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal((await contador(promocionA)).usage_count, 3);
    });

    it('D · usage_limit 3 con 3 usados: el cuarto canje se rechaza', async () => {
      await ajustar(promocionA, 3, 3);
      const res = await reservar(ctx.fixtures.tripA, 'SEC01UNO');
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.match(String(res.body.message), /promoci[óo]n alcanz[óo] su l[íi]mite/i);
    });

    it('E · un canje rechazado no incrementa el contador ni deja reserva', async () => {
      await ajustar(promocionA, 3, 3);
      const res = await reservar(ctx.fixtures.tripA, 'SEC01UNO');
      assert.equal(res.status, 400, JSON.stringify(res.body));

      assert.equal((await contador(promocionA)).usage_count, 3, 'el contador de la campaña no debe moverse');
      const cupon = await queryOne<{ usage_count: number }>('SELECT usage_count FROM coupons WHERE code = ?', ['SEC01UNO']);
      assert.equal(Number(cupon?.usage_count), 0, 'el contador del cupón tampoco debe moverse');
      const reservas = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM bookings');
      assert.equal(Number(reservas?.total), 0, 'no debe quedar ninguna reserva');
    });

    it('F · el tope es de SU campaña: una agotada no contamina a otra, y el aislamiento por empresa sigue en pie', async () => {
      // La campaña de la empresa B, agotada, no impide canjear la de la empresa A.
      await ajustar(promocionB, 1, 1);
      await ajustar(promocionA, 5, 0);
      const propia = await reservar(ctx.fixtures.tripA, 'SEC01UNO');
      assert.equal(propia.status, 201, JSON.stringify(propia.body));

      // Y un cupón de la empresa B sigue sin valer en un viaje de la empresa A (H-49), con
      // holgura de usos: el rechazo es por empresa, no por el tope nuevo.
      await ajustar(promocionB, 5, 0);
      const ajena = await reservar(ctx.fixtures.tripA, 'SEC01EMPB');
      assert.equal(ajena.status, 400, JSON.stringify(ajena.body));
      assert.match(String(ajena.body.message), /no es v[áa]lido para este viaje/i);
    });

    /**
     * G · concurrencia.
     *
     * Dos canjes en paralelo de CUPONES DISTINTOS de la misma campaña, sobre VIAJES DISTINTOS,
     * con un solo uso disponible. Al no compartir ni la fila del viaje ni la del cupón, lo único
     * que los serializa es la fila de la promoción que bloquea el `SELECT ... FOR UPDATE` del
     * JOIN. Exactamente uno debe consumir el último uso.
     */
    it('G · con un solo uso libre, dos canjes simultáneos: uno pasa y el otro se rechaza', async () => {
      await ajustar(promocionA, 1, 0);

      const [uno, dos] = await Promise.all([reservar(ctx.fixtures.tripA, 'SEC01UNO'), reservar(tripA2, 'SEC01DOS')]);

      const estados = [uno.status, dos.status].sort();
      assert.deepEqual(estados, [201, 400], `esperaba un 201 y un 400, hubo ${JSON.stringify(estados)}`);

      const rechazado = uno.status === 400 ? uno : dos;
      assert.match(String(rechazado.body.message), /promoci[óo]n alcanz[óo] su l[íi]mite/i);
      assert.equal((await contador(promocionA)).usage_count, 1, 'el contador no puede superar el límite');
    });
  });

  /* ================================================================== H-02 */
  describe('H-02 · los recursos sensibles exigen ADMIN además del permiso', () => {
    let ajusteId = 0;
    let plantillaId = 0;
    let comisionId = 0;
    /** Fila que esta prueba inserta en `role_permissions` y retira al terminar. */
    let concesion: { roleId: number; permissionId: number } | null = null;

    before(async () => {
      const { admin } = ctx.sessions;

      const ajuste = await queryOne<{ id: number }>('SELECT id FROM system_settings ORDER BY id ASC LIMIT 1');
      assert.ok(ajuste, 'la base de pruebas debería tener algún ajuste sembrado');
      ajusteId = ajuste.id;

      const plantilla = await post(
        '/notification-templates',
        { name: 'SEC01 plantilla', type: 'IN_APP', body: 'Cuerpo de prueba', status: 'ACTIVE' },
        admin.token,
      );
      assert.equal(plantilla.status, 201, JSON.stringify(plantilla.body));
      plantillaId = Number(plantilla.body.data.id);

      const existente = await queryOne<{ id: number }>(
        'SELECT id FROM company_commission_settings WHERE company_id = ? ORDER BY id ASC LIMIT 1',
        [ctx.fixtures.companyA],
      );
      if (existente) {
        comisionId = existente.id;
      } else {
        const creada = await post(
          '/commissions',
          {
            company_id: ctx.fixtures.companyA,
            commission_type: 'PERCENTAGE',
            commission_value: 10,
            effective_from: '2020-01-01',
            status: 'ACTIVE',
          },
          admin.token,
        );
        assert.equal(creada.status, 201, JSON.stringify(creada.body));
        comisionId = Number(creada.body.data.id);
      }

      // Concesión TEMPORAL de `settings.update` al rol COMPANY_ADMIN. Es el escenario que el
      // hallazgo describe: el permiso se reasigna en caliente y `authenticate` relee los
      // permisos en cada petición, así que las sesiones ya abiertas lo recogen de inmediato.
      const rol = await queryOne<{ id: number }>("SELECT id FROM roles WHERE name = 'COMPANY_ADMIN'");
      const permiso = await queryOne<{ id: number }>("SELECT id FROM permissions WHERE name = 'settings.update'");
      assert.ok(rol && permiso, 'faltan el rol o el permiso en la base de pruebas');
      const yaLoTenia = await queryOne<{ total: number }>(
        'SELECT COUNT(*) AS total FROM role_permissions WHERE role_id = ? AND permission_id = ?',
        [rol.id, permiso.id],
      );
      assert.equal(Number(yaLoTenia?.total), 0, 'COMPANY_ADMIN no debería tener settings.update: la concesión es de la prueba');
      await execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [rol.id, permiso.id]);
      concesion = { roleId: rol.id, permissionId: permiso.id };
    });

    after(async () => {
      // Se retira exactamente lo que se concedió, y se borra la plantilla creada para la prueba.
      if (concesion) {
        await execute('DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?', [concesion.roleId, concesion.permissionId]);
        concesion = null;
      }
      if (plantillaId) await del(`/notification-templates/${plantillaId}`, ctx.sessions.admin.token);
    });

    it('A · ADMIN sigue pudiendo modificar system_settings', async () => {
      const res = await put(`/system-settings/${ajusteId}`, { description: 'SEC01 comprobación ADMIN' }, ctx.sessions.admin.token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    it('B · ADMIN sigue pudiendo modificar notification_templates', async () => {
      const res = await put(`/notification-templates/${plantillaId}`, { title: 'SEC01 título' }, ctx.sessions.admin.token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    it('C · ADMIN sigue pudiendo modificar company_commission_settings', async () => {
      const res = await put(`/commissions/${comisionId}`, { commission_value: 11 }, ctx.sessions.admin.token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    it('D · COMPANY_ADMIN con settings.update concedido NO puede escribir system_settings', async () => {
      const res = await put(`/system-settings/${ajusteId}`, { setting_value: 'intruso' }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 403, JSON.stringify(res.body));
      // El permiso ya lo tiene: lo que lo detiene es la segunda barrera, no `requirePermission`.
      assert.match(String(res.body.message), /administrador de la plataforma/i);
    });

    it('E · COMPANY_ADMIN con settings.update concedido NO puede escribir notification_templates', async () => {
      const res = await put(`/notification-templates/${plantillaId}`, { title: 'intruso' }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.match(String(res.body.message), /administrador de la plataforma/i);
    });

    it('F · COMPANY_ADMIN con settings.update concedido NO puede rebajar su propia comisión', async () => {
      const res = await put(`/commissions/${comisionId}`, { commission_value: 0 }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.match(String(res.body.message), /administrador de la plataforma/i);

      const fila = await queryOne<{ commission_value: string }>('SELECT commission_value FROM company_commission_settings WHERE id = ?', [comisionId]);
      assert.notEqual(Number(fila?.commission_value), 0, 'la comisión no debe haberse tocado');
    });

    it('G · OPERATOR y CUSTOMER tampoco escriben ninguno de los tres', async () => {
      const destinos = [`/system-settings/${ajusteId}`, `/notification-templates/${plantillaId}`, `/commissions/${comisionId}`];
      for (const [nombre, token] of [
        ['operator', ctx.sessions.operator.token],
        ['customer', ctx.sessions.customer.token],
      ] as const) {
        for (const destino of destinos) {
          const res = await put(destino, { description: 'intruso' }, token);
          assert.equal(res.status, 403, `${nombre} en ${destino}: ${JSON.stringify(res.body)}`);
        }
      }
    });
  });

  /* ================================================================== H-03 */
  describe('H-03 · las claves heredadas de Object.prototype no son reportes', () => {
    const HEREDADAS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf', 'propertyIsEnumerable'];

    for (const clave of HEREDADAS) {
      it(`«${clave}» responde 404 y nunca 500`, async () => {
        const res = await get(`/reports/${encodeURIComponent(clave)}`, ctx.sessions.admin.token);
        assert.equal(res.status, 404, `${clave}: ${JSON.stringify(res.body)}`);
        assert.match(String(res.body.message), /no existe/i);
      });
    }

    it('un nombre inexistente cualquiera responde 404', async () => {
      const res = await get('/reports/reporte-que-no-existe-9f2c', ctx.sessions.admin.token);
      assert.equal(res.status, 404, JSON.stringify(res.body));
    });

    it('el listado de reportes no cambió y los válidos siguen respondiendo', async () => {
      const listado = await get('/reports', ctx.sessions.admin.token);
      assert.equal(listado.status, 200, JSON.stringify(listado.body));
      const claves = listado.body.data as string[];
      assert.deepEqual(
        [...claves].sort(),
        ['cancellations', 'occupancy', 'passengers', 'payment-methods', 'sales-by-bus', 'sales-by-date', 'sales-by-route'],
      );

      for (const clave of claves) {
        const res = await get(`/reports/${clave}`, ctx.sessions.admin.token);
        assert.equal(res.status, 200, `${clave}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.data.report, clave);
        assert.ok(Array.isArray(res.body.data.rows));
      }
    });

    it('los filtros de rango siguen funcionando y siguen validándose', async () => {
      const conRango = await get('/reports/sales-by-date?from=2020-01-01&to=2035-12-31', ctx.sessions.admin.token);
      assert.equal(conRango.status, 200, JSON.stringify(conRango.body));

      const invalido = await get('/reports/sales-by-date?from=ayer', ctx.sessions.admin.token);
      assert.equal(invalido.status, 400, JSON.stringify(invalido.body));
    });

    it('una clave heredada tampoco pasa para un rol de empresa', async () => {
      const res = await get('/reports/constructor', ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 404, JSON.stringify(res.body));
    });
  });
});
