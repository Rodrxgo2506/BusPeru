import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { del, get, post, put } from './helpers/api';
import { at } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

describe('CRUD, validaciones y consultas', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  it('completa el ciclo crear-leer-actualizar-eliminar con persistencia real', async () => {
    const token = ctx.sessions.companyAdmin.token;

    const creado = await post('/buses', {
      code: 'CRUD-1', plate_number: 'CRU-001', brand: 'Marca', model: 'Modelo', year: 2024, capacity: 20, status: 'ACTIVE',
    }, token);
    assert.equal(creado.status, 201);
    const id = creado.body.data.id;

    const leido = await get(`/buses/${id}`, token);
    assert.equal(leido.status, 200);
    assert.equal(leido.body.data.code, 'CRUD-1');
    assert.ok(leido.body.data.company_name, 'la lectura debe traer los JOIN');

    const buscado = await get('/buses?search=CRUD-1', token);
    assert.ok(buscado.body.data.some((b: { id: number }) => b.id === id));

    const actualizado = await put(`/buses/${id}`, { capacity: 30, status: 'MAINTENANCE' }, token);
    assert.equal(actualizado.status, 200);
    assert.equal(Number(actualizado.body.data.capacity), 30);

    const releido = await get(`/buses/${id}`, token);
    assert.equal(Number(releido.body.data.capacity), 30, 'el cambio debe persistir en la base');

    assert.equal((await del(`/buses/${id}`, token)).status, 200);
    assert.equal((await get(`/buses/${id}`, token)).status, 404);
  });

  it('rechaza los datos inválidos con 422 y detalle por campo', async () => {
    const token = ctx.sessions.companyAdmin.token;
    const casos: Array<[string, unknown]> = [
      ['/buses', { brand: 'Sin obligatorios' }],
      ['/buses', { code: 'A', plate_number: 'AAA-000', capacity: 0 }],
      ['/buses', { code: 'A', plate_number: 'AAA-000', capacity: 999 }],
      ['/buses', { code: 'A', plate_number: 'AAA-000', capacity: 10, status: 'VOLANDO' }],
      ['/routes', { origin_location_id: at(ctx.fixtures.locations, 0), destination_location_id: at(ctx.fixtures.locations, 0) }],
      ['/trips', { route_id: ctx.fixtures.routeA, bus_id: ctx.fixtures.busA, departure_datetime: '2030-01-01 10:00:00', base_price: -5 }],
    ];
    for (const [path, body] of casos) {
      const res = await post(path, body, token);
      assert.equal(res.status, 422, `${path} con ${JSON.stringify(body)}`);
    }

    const detalle = await post('/buses', { brand: 'X' }, token);
    assert.ok(detalle.body.errors && Object.keys(detalle.body.errors).length > 0);
  });

  it('traduce las restricciones de la base a errores legibles', async () => {
    const admin = ctx.sessions.admin.token;

    const duplicado = await post('/buses', { company_id: ctx.fixtures.companyA, code: 'DUP', plate_number: 'AAA-111', capacity: 10 }, admin);
    assert.equal(duplicado.status, 409, 'placa duplicada');

    const fkInvalida = await post('/trips', { route_id: 999999, bus_id: 999999, departure_datetime: '2030-01-01 10:00:00', base_price: 10 }, admin);
    assert.ok([400, 404].includes(fkInvalida.status), `esperado 400/404, obtenido ${fkInvalida.status}`);

    const enUso = await del(`/buses/${ctx.fixtures.busA}`, admin);
    assert.equal(enUso.status, 409, 'un bus con viajes no debe poder eliminarse');
  });

  it('pagina de forma estable y sin repetir filas entre páginas', async () => {
    const admin = ctx.sessions.admin.token;
    // Varios viajes con la misma fecha de salida: el caso que rompía la paginación.
    for (let i = 0; i < 12; i += 1) {
      await post('/trips', {
        route_id: ctx.fixtures.routeA, bus_id: ctx.fixtures.busA,
        departure_datetime: '2030-06-01 08:00:00', base_price: 45,
      }, admin);
    }

    const p1 = await get('/trips?page=1&limit=5', admin);
    const p2 = await get('/trips?page=2&limit=5', admin);
    const p3 = await get('/trips?page=3&limit=5', admin);

    assert.equal(p1.body.data.length, 5);
    assert.ok(['page', 'limit', 'total', 'totalPages'].every((k) => k in p1.body.pagination));
    assert.equal(p1.body.pagination.totalPages, Math.ceil(p1.body.pagination.total / 5));

    const ids = [...p1.body.data, ...p2.body.data, ...p3.body.data].map((t: { id: number }) => t.id);
    assert.equal(new Set(ids).size, ids.length, 'ninguna fila debe repetirse entre páginas');
  });

  it('normaliza los parámetros de paginación fuera de rango', async () => {
    const admin = ctx.sessions.admin.token;
    assert.ok((await get('/trips?limit=5000', admin)).body.data.length <= 100, 'limit acotado a 100');
    assert.equal((await get('/trips?page=-3', admin)).body.pagination.page, 1);
    const lejos = await get('/trips?page=9999&limit=5', admin);
    assert.equal(lejos.status, 200);
    assert.deepEqual(lejos.body.data, []);
  });

  it('ordena por columnas permitidas y neutraliza la inyección por ?sort', async () => {
    const admin = ctx.sessions.admin.token;
    const asc = await get('/trips?sort=t.base_price&order=ASC&limit=20', admin);
    const precios = asc.body.data.map((t: { base_price: number }) => Number(t.base_price));
    assert.deepEqual(precios, [...precios].sort((a, b) => a - b));

    const payloads = [
      't.base_price; DROP TABLE users--',
      '(SELECT 1)',
      't.id UNION SELECT password_hash FROM users',
      '1=1',
    ];
    for (const payload of payloads) {
      const res = await get(`/trips?sort=${encodeURIComponent(payload)}&limit=3`, admin);
      assert.equal(res.status, 200, `la lista blanca debe ignorar: ${payload}`);
    }
    assert.equal((await get('/users?limit=1', admin)).status, 200, 'la tabla users sigue intacta');
  });

  it('neutraliza la inyección por ?search usando consultas preparadas', async () => {
    const res = await get(`/buses?search=${encodeURIComponent("' OR 1=1--")}`, ctx.sessions.admin.token);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, []);
  });

  it('devuelve 404 controlado ante ids inexistentes o no numéricos', async () => {
    const admin = ctx.sessions.admin.token;
    assert.equal((await get('/buses/99999999', admin)).status, 404);
    assert.equal((await get('/buses/no-es-un-numero', admin)).status, 404);
    assert.equal((await get('/ruta-que-no-existe', admin)).status, 404);
  });

  it('rechaza actualizaciones sin cambios', async () => {
    const res = await put(`/buses/${ctx.fixtures.busA}`, {}, ctx.sessions.admin.token);
    assert.ok([400, 422].includes(res.status));
  });

  it('no filtra trazas de error en las respuestas', async () => {
    const res = await get('/buses/99999999', ctx.sessions.admin.token);
    const cuerpo = JSON.stringify(res.body);
    assert.equal(cuerpo.includes('.ts:'), false);
    assert.equal(cuerpo.includes('    at '), false);
  });

  it('registra en auditoría las operaciones de escritura', async () => {
    const admin = ctx.sessions.admin.token;
    const creado = await post('/locations', { name: 'Terminal Auditada', city: 'Ica' }, admin);
    assert.equal(creado.status, 201);

    const auditoria = await get('/audit-logs?limit=50', admin);
    assert.ok(
      auditoria.body.data.some((log: { entity_type: string; action: string }) => log.entity_type === 'locations' && log.action === 'CREATE'),
      'la creación debe quedar auditada',
    );
    assert.equal(JSON.stringify(auditoria.body.data).includes('password_hash'), false);
  });
});
