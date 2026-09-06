import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { del, get, post, put } from './helpers/api';
import { freeSeats, at } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

describe('Aislamiento multiempresa', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  it('cada empresa solo ve sus propios buses y rutas', async () => {
    const a = await get('/buses?limit=100', ctx.sessions.companyAdmin.token);
    const b = await get('/buses?limit=100', ctx.sessions.companyAdminB.token);
    assert.ok(a.body.data.every((bus: { company_id: number }) => bus.company_id === ctx.fixtures.companyA));
    assert.ok(b.body.data.every((bus: { company_id: number }) => bus.company_id === ctx.fixtures.companyB));
    assert.equal(a.body.data.some((bus: { id: number }) => bus.id === ctx.fixtures.busB), false);
  });

  it('el ADMIN ve los datos de todas las empresas', async () => {
    const res = await get('/buses?limit=100', ctx.sessions.admin.token);
    const companies = new Set(res.body.data.map((bus: { company_id: number }) => bus.company_id));
    assert.ok(companies.has(ctx.fixtures.companyA) && companies.has(ctx.fixtures.companyB));
  });

  it('forzar ?company_id de otra empresa no devuelve nada', async () => {
    const res = await get(`/buses?company_id=${ctx.fixtures.companyB}&limit=100`, ctx.sessions.companyAdmin.token);
    assert.deepEqual(res.body.data, []);
  });

  it('no se puede leer ni modificar un recurso de otra empresa por id', async () => {
    const token = ctx.sessions.companyAdmin.token;
    assert.equal((await get(`/buses/${ctx.fixtures.busB}`, token)).status, 404);
    assert.equal((await put(`/buses/${ctx.fixtures.busB}`, { code: 'SECUESTRADO' }, token)).status, 404);
    assert.equal((await del(`/buses/${ctx.fixtures.busB}`, token)).status, 404);
    assert.equal((await get(`/routes/${ctx.fixtures.routeB}`, token)).status, 404);
    assert.equal((await put(`/routes/${ctx.fixtures.routeB}`, { name: 'SECUESTRADA' }, token)).status, 404);

    // El recurso ajeno queda intacto.
    const intacto = await get(`/buses/${ctx.fixtures.busB}`, ctx.sessions.admin.token);
    assert.equal(intacto.body.data.code, 'B-001');
  });

  it('no se puede crear un recurso a nombre de otra empresa', async () => {
    const token = ctx.sessions.companyAdmin.token;
    const bus = await post('/buses', { company_id: ctx.fixtures.companyB, code: 'FUGA', plate_number: 'FUG-000', capacity: 10 }, token);
    assert.equal(bus.status, 403);

    const route = await post(
      '/routes',
      { company_id: ctx.fixtures.companyB, origin_location_id: at(ctx.fixtures.locations, 0), destination_location_id: at(ctx.fixtures.locations, 1) },
      token,
    );
    assert.equal(route.status, 403);
  });

  it('al crear sin company_id se asigna la empresa del usuario', async () => {
    const res = await post('/buses', { code: 'AUTO-1', plate_number: 'AUT-001', capacity: 10 }, ctx.sessions.companyAdmin.token);
    assert.equal(res.status, 201);
    assert.equal(res.body.data.company_id, ctx.fixtures.companyA);
    await del(`/buses/${res.body.data.id}`, ctx.sessions.admin.token);
  });

  it('un viaje no puede apuntar a la ruta o al bus de otra empresa', async () => {
    const token = ctx.sessions.companyAdmin.token;
    const res = await post(
      '/trips',
      { route_id: ctx.fixtures.routeB, bus_id: ctx.fixtures.busA, departure_datetime: '2030-01-01 10:00:00', base_price: 30 },
      token,
    );
    assert.equal(res.status, 403);
  });

  it('el cliente solo ve sus propias reservas y no las de otros', async () => {
    const seats = await freeSeats(ctx.fixtures.tripA);
    const propia = await post(
      '/bookings',
      { trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id], passenger_email: 'cliente@test.pe' },
      ctx.sessions.customer.token,
    );
    assert.equal(propia.status, 201);

    const ajena = await post(
      '/bookings',
      { trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 1).id], passenger_email: 'admin@test.pe' },
      ctx.sessions.admin.token,
    );
    assert.equal(ajena.status, 201);

    const lista = await get('/bookings?limit=100', ctx.sessions.customer.token);
    assert.ok(lista.body.data.every((b: { user_id: number }) => b.user_id === ctx.sessions.customer.user.id));
    assert.equal((await get(`/bookings/${ajena.body.data.id}`, ctx.sessions.customer.token)).status, 404);

    // Tampoco sirve forzar el filtro por usuario.
    const forzado = await get(`/bookings?user_id=${ctx.sessions.admin.user.id}&limit=100`, ctx.sessions.customer.token);
    assert.ok(forzado.body.data.every((b: { user_id: number }) => b.user_id === ctx.sessions.customer.user.id));
  });

  it('la empresa solo ve las reservas de sus propios viajes', async () => {
    const seats = await freeSeats(ctx.fixtures.tripB);
    await post(
      '/bookings',
      { trip_id: ctx.fixtures.tripB, seat_ids: [at(seats, 0).id], passenger_email: 'cliente@test.pe' },
      ctx.sessions.customer.token,
    );

    const a = await get('/bookings?limit=100', ctx.sessions.companyAdmin.token);
    assert.ok(a.body.data.every((b: { company_id: number }) => b.company_id === ctx.fixtures.companyA));

    const b = await get('/bookings?limit=100', ctx.sessions.companyAdminB.token);
    assert.ok(b.body.data.every((x: { company_id: number }) => x.company_id === ctx.fixtures.companyB));
    assert.ok(b.body.data.length > 0);
  });

  it('el cliente no accede al manifiesto de pasajeros', async () => {
    assert.equal((await get(`/trips/${ctx.fixtures.tripA}/passengers`, ctx.sessions.customer.token)).status, 404);
    assert.equal((await get(`/trips/${ctx.fixtures.tripA}/passengers`, ctx.sessions.companyAdmin.token)).status, 200);
  });

  it('la empresa no accede al manifiesto de un viaje ajeno', async () => {
    // 404 y no 403: un 403 revelaría que el viaje existe.
    assert.equal((await get(`/trips/${ctx.fixtures.tripB}/passengers`, ctx.sessions.companyAdmin.token)).status, 404);
    assert.equal((await get(`/trips/${ctx.fixtures.tripB}`, ctx.sessions.companyAdmin.token)).status, 404);
  });

  it('el cliente en /users solo se ve a sí mismo', async () => {
    const res = await get('/users?limit=100', ctx.sessions.customer.token);
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].id, ctx.sessions.customer.user.id);
  });

  it('la empresa solo gestiona usuarios de su propia empresa', async () => {
    const res = await get('/users?limit=100', ctx.sessions.companyAdmin.token);
    assert.ok(res.body.data.every((u: { company_id: number | null }) => u.company_id === ctx.fixtures.companyA));

    const ajeno = await get(`/users/${ctx.fixtures.users.companyAdminB}`, ctx.sessions.companyAdmin.token);
    assert.equal(ajeno.status, 404);
  });
});
