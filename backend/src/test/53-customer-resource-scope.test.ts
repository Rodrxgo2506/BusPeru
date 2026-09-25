import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, get, post } from './helpers/api';
import { execute, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * H-24 · alcance del CUSTOMER en los recursos genéricos.
 *
 * POR QUÉ EXISTE. El CUSTOMER tiene permisos de lectura (`companies.view`, `buses.view`,
 * `routes.view`, `promotions.view`) y el CRUD genérico no le aplicaba ningún alcance: un pasajero
 * listaba todos los cupones con su código —también los inactivos y los de otras empresas—, RUC y
 * correo de empresas, placas de buses y rutas. Ahora cada recurso genérico declara que el
 * CUSTOMER no lo usa (403) y lo público se sirve por `/public/*`, que ya filtra activos y campos.
 *
 * Lo que se defiende: que el acceso se corta en el servidor para cualquier filtro, id o
 * método; que los routers específicos siguen limitando al CUSTOMER a lo suyo; que ADMIN,
 * COMPANY_ADMIN y OPERATOR conservan exactamente su alcance, y que el catálogo público no cambia.
 */
describe('H-24 · alcance del CUSTOMER en recursos genéricos', () => {
  let ctx: SuiteContext;
  const recursos = [
    '/companies', '/bus-types', '/buses', '/seat-types', '/locations', '/routes', '/route-stops',
    '/promotions', '/coupons', '/notification-templates', '/system-settings', '/commissions',
  ];
  let promoA = 0;
  let promoB = 0;
  let cuponA = 0;
  let cuponB = 0;
  let reservaAjena = 0;
  let pagoAjeno = 0;

  before(async () => {
    ctx = await prepareSuite();
    const { admin } = ctx.sessions;
    const f = ctx.fixtures;

    const promocion = async (company_id: number, name: string, status: string, start_at: string, end_at: string) => {
      const res = await post('/promotions', { company_id, name, discount_type: 'PERCENTAGE', discount_value: 20, usage_limit: 50, start_at, end_at, status }, admin.token);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return Number(res.body.data.id);
    };
    promoA = await promocion(f.companyA, 'Vigente A', 'ACTIVE', '2020-01-01 00:00:00', '2035-12-31 23:59:59');
    promoB = await promocion(f.companyB, 'Interna B', 'INACTIVE', '2020-01-01 00:00:00', '2035-12-31 23:59:59');
    await promocion(f.companyA, 'Vencida A', 'ACTIVE', '2020-01-01 00:00:00', '2021-01-01 00:00:00');
    await promocion(f.companyA, 'Futura A', 'ACTIVE', '2034-01-01 00:00:00', '2035-01-01 00:00:00');

    const cupon = async (promotion_id: number, code: string, status: string) => {
      const res = await post('/coupons', { promotion_id, code, status }, admin.token);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return Number(res.body.data.id);
    };
    cuponA = await cupon(promoA, 'PUBLICO24', 'ACTIVE');
    cuponB = await cupon(promoB, 'SECRETO24', 'INACTIVE');

    // Reserva pagada de OTRO usuario (el ADMIN comprando): el pasajero no debe verla.
    const reserva = await post(
      '/bookings',
      { trip_id: f.tripA, seat_ids: [at(await freeSeats(f.tripA), 0).id], passenger_email: 'otro@test.pe' },
      admin.token,
    );
    assert.equal(reserva.status, 201, JSON.stringify(reserva.body));
    reservaAjena = Number(reserva.body.data.id);
    assert.equal((await post(`/bookings/${reservaAjena}/pay`, { method: 'CASH' }, admin.token)).status, 200);
    pagoAjeno = Number((await queryOne<{ id: number }>('SELECT id FROM payments WHERE booking_id = ?', [reservaAjena]))?.id);
  });
  after(teardownSuite);

  const comoCliente = (path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: unknown) =>
    api(path, { method, body, token: ctx.sessions.customer.token });

  // =====================================================================
  describe('Recursos genéricos: el CUSTOMER no entra', () => {
    it('7/8 · no lista ni lee cupones ni promociones: ni activos, ni inactivos, ni de otra empresa', async () => {
      for (const path of ['/coupons', '/promotions', `/coupons/${cuponA}`, `/coupons/${cuponB}`, `/promotions/${promoA}`, `/promotions/${promoB}`]) {
        const res = await comoCliente(path);
        assert.equal(res.status, 403, `${path} -> ${res.status}`);
        const texto = JSON.stringify(res.body);
        assert.ok(!texto.includes('SECRETO24') && !texto.includes('PUBLICO24'), `${path} filtra un código`);
      }
    });

    it('9/10/11 · ningún filtro, orden o paginación abre un recurso genérico', async () => {
      const f = ctx.fixtures;
      const consultas = [
        '', `?company_id=${f.companyB}`, '?status=INACTIVE', '?status=ACTIVE', `?promotion_id=${promoB}`,
        '?search=SECRETO', '?sort=c.code&order=ASC', '?limit=1000&page=1', `?company_id=${f.companyA}&status=ACTIVE`,
      ];
      for (const recurso of recursos) {
        for (const consulta of consultas) {
          const res = await comoCliente(`${recurso}${consulta}`);
          assert.equal(res.status, 403, `${recurso}${consulta} -> ${res.status}`);
          assert.equal(res.body.data, undefined, `${recurso}${consulta} devolvió datos`);
        }
      }
    });

    it('20 · no hay enumeración: un id existente, uno ajeno y uno inexistente responden igual', async () => {
      const f = ctx.fixtures;
      const ids: Record<string, number[]> = {
        '/companies': [f.companyA, f.companyB, 999999],
        '/buses': [f.busA, f.busB, 999999],
        '/routes': [f.routeA, f.routeB, 999999],
        '/coupons': [cuponA, cuponB, 999999],
      };
      for (const [recurso, lista] of Object.entries(ids)) {
        const respuestas = await Promise.all(lista.map((id) => comoCliente(`${recurso}/${id}`)));
        assert.deepEqual(respuestas.map((r) => r.status), [403, 403, 403], recurso);
        assert.equal(new Set(respuestas.map((r) => r.body.message)).size, 1, `${recurso}: el mensaje no delata qué existe`);
      }
    });

    it('9 · tampoco escribe, aunque mande company_id o status', async () => {
      const f = ctx.fixtures;
      const antes = await queryOne<{ promos: number; cupones: number; codigoB: string; tipoRuta: string }>(
        `SELECT (SELECT COUNT(*) FROM promotions) AS promos, (SELECT COUNT(*) FROM coupons) AS cupones,
                (SELECT code FROM coupons WHERE id = ?) AS codigoB, (SELECT status FROM routes WHERE id = ?) AS tipoRuta`,
        [cuponB, f.routeB],
      );
      const intentos: Array<[string, 'POST' | 'PUT' | 'DELETE', unknown]> = [
        ['/coupons', 'POST', { promotion_id: promoA, code: 'MIO100', status: 'ACTIVE' }],
        ['/promotions', 'POST', { company_id: f.companyB, name: 'x', discount_type: 'PERCENTAGE', discount_value: 99, start_at: '2020-01-01 00:00:00', end_at: '2035-01-01 00:00:00', status: 'ACTIVE' }],
        [`/coupons/${cuponB}`, 'PUT', { status: 'ACTIVE', code: 'ROBADO' }],
        [`/routes/${f.routeB}`, 'PUT', { status: 'INACTIVE', company_id: f.companyA }],
        [`/coupons/${cuponA}`, 'DELETE', undefined],
      ];
      for (const [path, method, body] of intentos) {
        assert.equal((await comoCliente(path, method, body)).status, 403, `${method} ${path}`);
      }
      const despues = await queryOne(
        `SELECT (SELECT COUNT(*) FROM promotions) AS promos, (SELECT COUNT(*) FROM coupons) AS cupones,
                (SELECT code FROM coupons WHERE id = ?) AS codigoB, (SELECT status FROM routes WHERE id = ?) AS tipoRuta`,
        [cuponB, f.routeB],
      );
      assert.deepEqual(despues, antes);
    });
  });

  // =====================================================================
  describe('Routers específicos: el CUSTOMER solo ve lo suyo', () => {
    it('1 · no enumera usuarios: solo se ve a sí mismo', async () => {
      const lista = await comoCliente('/users?limit=100');
      assert.equal(lista.status, 200);
      assert.deepEqual((lista.body.data as Array<{ id: number }>).map((u) => Number(u.id)), [ctx.fixtures.users.customer]);
      assert.equal((await comoCliente(`/users/${ctx.fixtures.users.admin}`)).status, 404);
    });

    it('2 · no ve pagos de otro usuario', async () => {
      assert.equal((await comoCliente(`/payments/${pagoAjeno}`)).status, 404);
      const lista = await comoCliente('/payments?limit=100');
      assert.equal(lista.status, 200);
      assert.ok(!(lista.body.data as Array<{ id: number }>).some((p) => Number(p.id) === pagoAjeno));
    });

    it('3 · no ve reservas de otro usuario, ni forzando filtros', async () => {
      assert.equal((await comoCliente(`/bookings/${reservaAjena}`)).status, 404);
      const lista = await comoCliente(`/bookings?limit=100&user_id=${ctx.fixtures.users.admin}&company_id=${ctx.fixtures.companyA}`);
      assert.equal(lista.status, 200);
      assert.ok(!(lista.body.data as Array<{ id: number }>).some((b) => Number(b.id) === reservaAjena));
    });

    it('4/5/6 · cuentas bancarias, integraciones y conductores: 403', async () => {
      for (const path of ['/company/bank-accounts', '/company/integrations', '/admin/integrations', '/company/drivers', '/company/documents']) {
        const res = await comoCliente(path);
        assert.equal(res.status, 403, `${path} -> ${res.status}`);
        assert.ok(!/credential|account_number|document_number|license/i.test(JSON.stringify(res.body)), `${path} filtra datos`);
      }
    });

    it('viajes: el CRUD administrativo no le muestra ninguno', async () => {
      const lista = await comoCliente('/trips?limit=100');
      assert.equal(lista.status, 200);
      assert.equal((lista.body.data as unknown[]).length, 0);
      assert.equal((await comoCliente(`/trips/${ctx.fixtures.tripA}`)).status, 404);
    });

    it('18 · reseñas: el pasajero sigue leyendo las suyas y el catálogo público', async () => {
      assert.equal((await comoCliente('/reviews')).status, 200);
      assert.equal((await get('/public/reviews')).status, 200);
    });

    it('notificaciones: solo las propias', async () => {
      const res = await comoCliente('/notifications?limit=100');
      assert.equal(res.status, 200);
      assert.ok((res.body.data as Array<{ user_id: number }>).every((n) => Number(n.user_id) === ctx.fixtures.users.customer));
    });
  });

  // =====================================================================
  describe('Los demás roles conservan su alcance', () => {
    it('12 · COMPANY_ADMIN ve solo cupones y promociones de su empresa; lo de B da 404', async () => {
      const token = ctx.sessions.companyAdmin.token;
      const cupones = await api('/coupons?limit=100', { token });
      assert.equal(cupones.status, 200);
      assert.ok((cupones.body.data as Array<{ company_id: number }>).every((c) => Number(c.company_id) === ctx.fixtures.companyA));
      assert.equal((await api(`/coupons/${cuponB}`, { token })).status, 404);
      assert.equal((await api(`/promotions/${promoB}`, { token })).status, 404);
      // `company_id` no es un filtro de cupones: se ignora y el alcance del servidor se mantiene.
      const forzado = (await api(`/coupons?company_id=${ctx.fixtures.companyB}&promotion_id=${promoB}`, { token })).body.data as Array<{ company_id: number }>;
      assert.ok(forzado.every((c) => Number(c.company_id) === ctx.fixtures.companyA));
    });

    it('13 · ADMIN mantiene acceso global', async () => {
      const token = ctx.sessions.admin.token;
      const codigos = ((await api('/coupons?limit=100', { token })).body.data as Array<{ code: string }>).map((c) => c.code);
      assert.ok(codigos.includes('PUBLICO24') && codigos.includes('SECRETO24'));
      for (const recurso of recursos) assert.equal((await api(recurso, { token })).status, 200, recurso);
    });

    it('14 · OPERATOR conserva exactamente sus permisos y su alcance', async () => {
      const { operator } = ctx.sessions;
      assert.equal(operator.user.permissions.length, 15);
      const cupones = await api('/coupons?limit=100', { token: operator.token });
      assert.equal(cupones.status, 200, 'tiene promotions.view');
      assert.ok((cupones.body.data as Array<{ company_id: number }>).every((c) => Number(c.company_id) === ctx.fixtures.companyA));
      assert.equal((await api('/coupons', { method: 'POST', body: { promotion_id: promoA, code: 'OPE1' }, token: operator.token })).status, 403);
    });
  });

  // =====================================================================
  describe('El canal público sigue sirviendo lo que el pasajero necesita', () => {
    it('15/19 · búsqueda, detalle, asientos, distribución e itinerarios funcionan, con y sin sesión', async () => {
      const f = ctx.fixtures;
      for (const token of [undefined, ctx.sessions.customer.token]) {
        const busqueda = await api('/public/trips', { token });
        assert.equal(busqueda.status, 200);
        assert.ok((busqueda.body.data as Array<{ id: number }>).some((t) => Number(t.id) === f.tripA));
        for (const path of [`/public/trips/${f.tripA}`, `/public/trips/${f.tripA}/seats`, `/public/trips/${f.tripA}/layout`]) {
          assert.equal((await api(path, { token })).status, 200, path);
        }
      }
      const itinerario = await api('/public/itineraries/search', {
        method: 'POST',
        body: { trip_type: 'ROUND_TRIP', segments: [{ origin: 'Lima', destination: 'Ica', date: '2030-01-01' }, { origin: 'Ica', destination: 'Lima', date: '2030-01-03' }] },
      });
      assert.ok([200, 422].includes(itinerario.status), `itinerarios -> ${itinerario.status}`);
      assert.notEqual(itinerario.status, 403);
    });

    it('16 · el pasajero accede al catálogo público: empresas, terminales, ciudades, promociones, ajustes', async () => {
      for (const path of ['/public/companies', '/public/terminals', '/public/cities', '/public/promotions', '/public/settings', '/public/destinations']) {
        assert.equal((await comoCliente(path)).status, 200, path);
      }
    });

    it('7/10 · /public/promotions solo trae promociones ACTIVE y vigentes, aunque se pida otra cosa', async () => {
      for (const consulta of ['', '?status=INACTIVE', `?company_id=${ctx.fixtures.companyB}`]) {
        const nombres = ((await comoCliente(`/public/promotions${consulta}`)).body.data as Array<{ name: string }>).map((p) => p.name);
        assert.ok(nombres.includes('Vigente A'), consulta);
        for (const oculta of ['Interna B', 'Vencida A', 'Futura A']) assert.ok(!nombres.includes(oculta), `${consulta}: ${oculta}`);
      }
    });

    it('17 · ninguna respuesta pública lleva campos internos', async () => {
      const f = ctx.fixtures;
      await execute("UPDATE companies SET status = 'SUSPENDED' WHERE id = ?", [f.companyB]);
      try {
        const empresas = (await get('/public/companies')).body.data as Array<Record<string, unknown>>;
        assert.ok(!empresas.some((e) => Number(e.id) === f.companyB), 'una empresa suspendida no es pública');
        for (const e of empresas) for (const campo of ['tax_id', 'email', 'phone', 'status', 'legal_name']) assert.ok(!(campo in e), `empresa.${campo}`);
      } finally {
        await execute("UPDATE companies SET status = 'ACTIVE' WHERE id = ?", [f.companyB]);
      }

      const promociones = (await get('/public/promotions')).body.data as Array<Record<string, unknown>>;
      for (const p of promociones) for (const campo of ['usage_limit', 'usage_count', 'status', 'company_id', 'code']) assert.ok(!(campo in p), `promoción.${campo}`);

      const viajes = [
        ...((await get('/public/trips')).body.data as Array<Record<string, unknown>>),
        (await get(`/public/trips/${f.tripA}`)).body.data as Record<string, unknown>,
      ];
      for (const v of viajes) for (const campo of ['plate_number', 'driver_id', 'co_driver_id', 'tax_id', 'email']) assert.ok(!(campo in v), `viaje.${campo}`);

      const todo = JSON.stringify(await Promise.all(['/public/companies', '/public/promotions', '/public/trips', '/public/settings'].map(async (p) => (await get(p)).body)));
      assert.ok(!/SECRETO24|PUBLICO24|password|credential|account_number/i.test(todo), 'nada interno en el canal público');
    });
  });
});
