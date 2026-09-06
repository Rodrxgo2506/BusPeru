import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execute, query, queryOne } from '../config/database';
import { del, get, post, put } from './helpers/api';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * Conductor y copiloto del viaje (mockup 31).
 *
 * Cubre el CRUD del personal, su aislamiento entre empresas y la asignación a viajes,
 * que se hace con el `PUT /trips/:id` existente.
 */
describe('Conductores y copilotos', () => {
  let ctx: SuiteContext;

  const RUTA = '/company/drivers';

  const CONDUCTOR = {
    first_name: 'Carlos',
    last_name: 'Mendoza',
    document_number: '44556677',
    license_number: 'Q44556677',
    license_expires_at: '2030-12-31',
    phone: '987 654 321',
  };

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  beforeEach(async () => {
    await execute('UPDATE trips SET driver_id = NULL, co_driver_id = NULL');
    await execute('DELETE FROM drivers');
    await execute("DELETE FROM audit_logs WHERE entity_type = 'drivers'");
  });

  /** Crea un conductor saltándose la API, para preparar escenarios. */
  async function sembrar(companyId: number, overrides: Record<string, unknown> = {}): Promise<number> {
    const data = { ...CONDUCTOR, status: 'ACTIVE', ...overrides };
    const result = await execute(
      `INSERT INTO drivers (company_id, first_name, last_name, document_number, license_number, license_expires_at, phone, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        companyId, data.first_name, data.last_name, data.document_number,
        data.license_number, data.license_expires_at, data.phone, data.status,
      ],
    );
    return result.insertId;
  }

  describe('CRUD del personal', () => {
    it('registra un conductor en la empresa del usuario', async () => {
      const res = await post(RUTA, CONDUCTOR, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 201);
      assert.equal(Number(res.body.data.company_id), ctx.fixtures.companyA);
      assert.equal(res.body.data.status, 'ACTIVE', 'nace activo por defecto');
      assert.equal(res.body.data.first_name, 'Carlos');
    });

    it('registra un segundo conductor que servirá de copiloto', async () => {
      await post(RUTA, CONDUCTOR, ctx.sessions.companyAdmin.token);
      const res = await post(
        RUTA,
        { ...CONDUCTOR, first_name: 'Juan', last_name: 'Quispe', document_number: '11223344', license_number: 'Q11223344' },
        ctx.sessions.companyAdmin.token,
      );

      assert.equal(res.status, 201, 'la tabla no distingue conductor de copiloto: el puesto lo define el viaje');
      assert.equal((await query('SELECT id FROM drivers')).length, 2);
    });

    it('lista el personal de su empresa', async () => {
      await sembrar(ctx.fixtures.companyA);
      const res = await get(RUTA, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].last_name, 'Mendoza');
      assert.equal(Number(res.body.data[0].trips_count), 0);
    });

    it('sin personal registrado devuelve una lista vacía', async () => {
      assert.deepEqual((await get(RUTA, ctx.sessions.companyAdmin.token)).body.data, []);
    });

    it('consulta el detalle de un conductor propio', async () => {
      const id = await sembrar(ctx.fixtures.companyA);
      const res = await get(`${RUTA}/${id}`, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 200);
      assert.equal(Number(res.body.data.id), id);
      assert.equal(res.body.data.license_number, CONDUCTOR.license_number);
    });

    it('actualiza los datos de un conductor', async () => {
      const id = await sembrar(ctx.fixtures.companyA);
      const res = await put(`${RUTA}/${id}`, { phone: '999 111 222', last_name: 'Mendoza Ríos' }, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 200);
      const fila = await queryOne<{ phone: string; last_name: string }>('SELECT phone, last_name FROM drivers WHERE id = ?', [id]);
      assert.equal(fila?.phone, '999 111 222');
      assert.equal(fila?.last_name, 'Mendoza Ríos');
    });

    it('desactiva a un conductor sin viajes por delante', async () => {
      const id = await sembrar(ctx.fixtures.companyA);
      const res = await put(`${RUTA}/${id}`, { status: 'INACTIVE' }, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'INACTIVE');
    });

    it('elimina a un conductor sin viajes por delante', async () => {
      const id = await sembrar(ctx.fixtures.companyA);
      assert.equal((await del(`${RUTA}/${id}`, ctx.sessions.companyAdmin.token)).status, 200);
      assert.equal((await query('SELECT id FROM drivers WHERE id = ?', [id])).length, 0);
    });

    it('filtra por estado y busca por nombre o documento', async () => {
      await sembrar(ctx.fixtures.companyA, { first_name: 'Ana', document_number: '10000001', license_number: 'Q10000001' });
      await sembrar(ctx.fixtures.companyA, { first_name: 'Beto', document_number: '10000002', license_number: 'Q10000002', status: 'INACTIVE' });

      assert.equal((await get(`${RUTA}?status=ACTIVE`, ctx.sessions.companyAdmin.token)).body.data.length, 1);
      assert.equal((await get(`${RUTA}?search=Beto`, ctx.sessions.companyAdmin.token)).body.data.length, 1);
      assert.equal((await get(`${RUTA}?search=10000001`, ctx.sessions.companyAdmin.token)).body.data.length, 1);
    });

    it('rechaza un documento ya registrado sin revelar de qué empresa', async () => {
      await sembrar(ctx.fixtures.companyB, { document_number: '44556677' });
      const res = await post(RUTA, CONDUCTOR, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 409);
      assert.doesNotMatch(String(res.body.message), /empresa|company/i, 'el mensaje no puede delatar dónde trabaja');
    });
  });

  describe('Aislamiento multiempresa', () => {
    it('cada empresa solo ve su propio personal', async () => {
      await sembrar(ctx.fixtures.companyA, { first_name: 'DeLaA', document_number: '20000001', license_number: 'Q20000001' });
      await sembrar(ctx.fixtures.companyB, { first_name: 'DeLaB', document_number: '20000002', license_number: 'Q20000002' });

      const a = await get(RUTA, ctx.sessions.companyAdmin.token);
      assert.equal(a.body.data.length, 1);
      assert.equal(a.body.data[0].first_name, 'DeLaA');
      assert.doesNotMatch(JSON.stringify(a.body), /DeLaB/);

      const b = await get(RUTA, ctx.sessions.companyAdminB.token);
      assert.equal(b.body.data.length, 1);
      assert.equal(b.body.data[0].first_name, 'DeLaB');
    });

    it('no puede consultar el detalle de personal ajeno', async () => {
      const ajeno = await sembrar(ctx.fixtures.companyB, { document_number: '20000003', license_number: 'Q20000003' });
      const res = await get(`${RUTA}/${ajeno}`, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 404, '404 y no 403: no confirma que exista');
    });

    it('no puede editar personal ajeno', async () => {
      const ajeno = await sembrar(ctx.fixtures.companyB, { document_number: '20000004', license_number: 'Q20000004' });
      assert.equal((await put(`${RUTA}/${ajeno}`, { first_name: 'Intruso' }, ctx.sessions.companyAdmin.token)).status, 404);

      const fila = await queryOne<{ first_name: string }>('SELECT first_name FROM drivers WHERE id = ?', [ajeno]);
      assert.notEqual(fila?.first_name, 'Intruso');
    });

    it('no puede eliminar personal ajeno', async () => {
      const ajeno = await sembrar(ctx.fixtures.companyB, { document_number: '20000005', license_number: 'Q20000005' });
      assert.equal((await del(`${RUTA}/${ajeno}`, ctx.sessions.companyAdmin.token)).status, 404);
      assert.equal((await query('SELECT id FROM drivers WHERE id = ?', [ajeno])).length, 1);
    });

    it('el company_id del cliente no cambia el tenant al crear', async () => {
      const res = await post(RUTA, { ...CONDUCTOR, company_id: ctx.fixtures.companyB }, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 201);
      assert.equal(Number(res.body.data.company_id), ctx.fixtures.companyA);
      assert.equal((await query('SELECT id FROM drivers WHERE company_id = ?', [ctx.fixtures.companyB])).length, 0);
    });

    it('el company_id del cliente no cambia el tenant al editar', async () => {
      const id = await sembrar(ctx.fixtures.companyA);
      await put(`${RUTA}/${id}`, { phone: '900 000 000', company_id: ctx.fixtures.companyB }, ctx.sessions.companyAdmin.token);

      const fila = await queryOne<{ company_id: number }>('SELECT company_id FROM drivers WHERE id = ?', [id]);
      assert.equal(Number(fila?.company_id), ctx.fixtures.companyA);
    });

    it('el company_id de la query tampoco amplía el alcance', async () => {
      await sembrar(ctx.fixtures.companyB, { first_name: 'DeLaB', document_number: '20000006', license_number: 'Q20000006' });
      const res = await get(`${RUTA}?company_id=${ctx.fixtures.companyB}`, ctx.sessions.companyAdmin.token);
      assert.deepEqual(res.body.data, []);
    });

    it('el ADMIN sí puede consultar el personal de una empresa concreta', async () => {
      await sembrar(ctx.fixtures.companyB, { first_name: 'DeLaB', document_number: '20000007', license_number: 'Q20000007' });
      const res = await get(`${RUTA}?company_id=${ctx.fixtures.companyB}`, ctx.sessions.admin.token);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].first_name, 'DeLaB');
    });
  });

  describe('Asignación al viaje', () => {
    it('asigna conductor y copiloto a un viaje propio', async () => {
      const conductor = await sembrar(ctx.fixtures.companyA, { document_number: '30000001', license_number: 'Q30000001' });
      const copiloto = await sembrar(ctx.fixtures.companyA, { first_name: 'Juan', document_number: '30000002', license_number: 'Q30000002' });

      const res = await put(
        `/trips/${ctx.fixtures.tripA}`,
        { driver_id: conductor, co_driver_id: copiloto },
        ctx.sessions.companyAdmin.token,
      );

      assert.equal(res.status, 200);
      assert.equal(Number(res.body.data.driver_id), conductor);
      assert.equal(Number(res.body.data.co_driver_id), copiloto);
      assert.equal(res.body.data.driver_name, 'Carlos Mendoza', 'el viaje devuelve el nombre de la tripulación');
      assert.equal(res.body.data.co_driver_name, 'Juan Mendoza');
    });

    it('programa un viaje nuevo ya con tripulación', async () => {
      const conductor = await sembrar(ctx.fixtures.companyA, { document_number: '30000003', license_number: 'Q30000003' });
      const salida = new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 19).replace('T', ' ');

      const res = await post(
        '/trips',
        { route_id: ctx.fixtures.routeA, bus_id: ctx.fixtures.busA, departure_datetime: salida, base_price: 50, driver_id: conductor },
        ctx.sessions.companyAdmin.token,
      );

      assert.equal(res.status, 201);
      assert.equal(Number(res.body.data.driver_id), conductor);
      assert.equal(res.body.data.co_driver_id, null, 'el copiloto es opcional');
    });

    it('rechaza tripulación de otra empresa', async () => {
      const ajeno = await sembrar(ctx.fixtures.companyB, { document_number: '30000004', license_number: 'Q30000004' });

      const res = await put(`/trips/${ctx.fixtures.tripA}`, { driver_id: ajeno }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /no es de tu empresa|no existe/i);

      const fila = await queryOne<{ driver_id: number | null }>('SELECT driver_id FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
      assert.equal(fila?.driver_id, null, 'el viaje no queda modificado');
    });

    it('el ADMIN tampoco puede mezclar personal entre empresas', async () => {
      const ajeno = await sembrar(ctx.fixtures.companyB, { document_number: '30000005', license_number: 'Q30000005' });
      const res = await put(`/trips/${ctx.fixtures.tripA}`, { driver_id: ajeno }, ctx.sessions.admin.token);
      assert.equal(res.status, 400, 'la tripulación se valida contra la empresa del viaje, no contra el rol');
    });

    it('impide que conductor y copiloto sean la misma persona', async () => {
      const conductor = await sembrar(ctx.fixtures.companyA, { document_number: '30000006', license_number: 'Q30000006' });

      const res = await put(
        `/trips/${ctx.fixtures.tripA}`,
        { driver_id: conductor, co_driver_id: conductor },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /misma persona/i);
    });

    it('detecta la colisión aunque solo se envíe uno de los dos', async () => {
      const conductor = await sembrar(ctx.fixtures.companyA, { document_number: '30000007', license_number: 'Q30000007' });
      await put(`/trips/${ctx.fixtures.tripA}`, { driver_id: conductor }, ctx.sessions.companyAdmin.token);

      // El viaje ya tiene a esa persona como conductor; asignarla ahora de copiloto debe fallar.
      const res = await put(`/trips/${ctx.fixtures.tripA}`, { co_driver_id: conductor }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /misma persona/i);
    });

    it('no admite personal inactivo', async () => {
      const inactivo = await sembrar(ctx.fixtures.companyA, { document_number: '30000008', license_number: 'Q30000008', status: 'INACTIVE' });
      const res = await put(`/trips/${ctx.fixtures.tripA}`, { driver_id: inactivo }, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /inactivo/i);
    });

    it('quita la tripulación enviando null', async () => {
      const conductor = await sembrar(ctx.fixtures.companyA, { document_number: '30000009', license_number: 'Q30000009' });
      await put(`/trips/${ctx.fixtures.tripA}`, { driver_id: conductor }, ctx.sessions.companyAdmin.token);

      const res = await put(`/trips/${ctx.fixtures.tripA}`, { driver_id: null }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.driver_id, null);
    });

    it('no puede asignar tripulación a un viaje de otra empresa', async () => {
      const propio = await sembrar(ctx.fixtures.companyA, { document_number: '30000010', license_number: 'Q30000010' });
      const res = await put(`/trips/${ctx.fixtures.tripB}`, { driver_id: propio }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 404, 'el viaje ajeno ni siquiera se ve');
    });

    it('el listado de viajes trae el nombre de la tripulación', async () => {
      const conductor = await sembrar(ctx.fixtures.companyA, { document_number: '30000011', license_number: 'Q30000011' });
      await put(`/trips/${ctx.fixtures.tripA}`, { driver_id: conductor }, ctx.sessions.companyAdmin.token);

      const lista = await get('/trips?limit=50', ctx.sessions.companyAdmin.token);
      const viaje = lista.body.data.find((t: { id: number }) => t.id === ctx.fixtures.tripA);
      assert.equal(viaje.driver_name, 'Carlos Mendoza');
      assert.equal(viaje.driver_phone, '987 654 321');
    });

    it('el contador de viajes del conductor refleja la asignación', async () => {
      const conductor = await sembrar(ctx.fixtures.companyA, { document_number: '30000012', license_number: 'Q30000012' });
      await put(`/trips/${ctx.fixtures.tripA}`, { driver_id: conductor }, ctx.sessions.companyAdmin.token);

      const detalle = await get(`${RUTA}/${conductor}`, ctx.sessions.companyAdmin.token);
      assert.equal(Number(detalle.body.data.trips_count), 1);
    });

    it('no permite desactivar ni borrar a quien tiene viajes por delante', async () => {
      const conductor = await sembrar(ctx.fixtures.companyA, { document_number: '30000013', license_number: 'Q30000013' });
      await put(`/trips/${ctx.fixtures.tripA}`, { driver_id: conductor }, ctx.sessions.companyAdmin.token);

      assert.equal((await put(`${RUTA}/${conductor}`, { status: 'INACTIVE' }, ctx.sessions.companyAdmin.token)).status, 400);
      assert.equal((await del(`${RUTA}/${conductor}`, ctx.sessions.companyAdmin.token)).status, 400);
    });

    it('borrar al conductor deja el viaje sin tripulación, no lo borra', async () => {
      const conductor = await sembrar(ctx.fixtures.companyA, { document_number: '30000014', license_number: 'Q30000014' });
      await execute('UPDATE trips SET driver_id = ? WHERE id = ?', [conductor, ctx.fixtures.tripA]);

      // Se borra directamente para probar la FK ON DELETE SET NULL de la migración.
      await execute('DELETE FROM drivers WHERE id = ?', [conductor]);

      const viaje = await queryOne<{ id: number; driver_id: number | null }>(
        'SELECT id, driver_id FROM trips WHERE id = ?', [ctx.fixtures.tripA],
      );
      assert.ok(viaje, 'el viaje sigue existiendo');
      assert.equal(viaje!.driver_id, null, 'la referencia queda a NULL');
    });
  });

  describe('Permisos por rol', () => {
    it('un OPERATOR consulta el personal pero no lo administra', async () => {
      const id = await sembrar(ctx.fixtures.companyA);

      assert.equal((await get(RUTA, ctx.sessions.operator.token)).status, 200, 'necesita verlos para operar viajes');
      assert.equal((await get(`${RUTA}/${id}`, ctx.sessions.operator.token)).status, 200);

      assert.equal((await post(RUTA, { ...CONDUCTOR, document_number: '55555555' }, ctx.sessions.operator.token)).status, 403);
      assert.equal((await put(`${RUTA}/${id}`, { phone: '900 000 000' }, ctx.sessions.operator.token)).status, 403);
      assert.equal((await del(`${RUTA}/${id}`, ctx.sessions.operator.token)).status, 403);
    });

    it('un OPERATOR sí puede asignar tripulación, porque ya tenía trips.update', async () => {
      const conductor = await sembrar(ctx.fixtures.companyA, { document_number: '40000001', license_number: 'Q40000001' });
      const res = await put(`/trips/${ctx.fixtures.tripA}`, { driver_id: conductor }, ctx.sessions.operator.token);
      assert.equal(res.status, 200, 'no se le concedió ningún permiso nuevo');
    });

    it('un CUSTOMER no administra ni consulta personal', async () => {
      const id = await sembrar(ctx.fixtures.companyA);

      assert.equal((await get(RUTA, ctx.sessions.customer.token)).status, 403, 'no pertenece a ninguna empresa');
      assert.equal((await get(`${RUTA}/${id}`, ctx.sessions.customer.token)).status, 403);
      assert.equal((await post(RUTA, CONDUCTOR, ctx.sessions.customer.token)).status, 403);
      assert.equal((await put(`${RUTA}/${id}`, { phone: '1' }, ctx.sessions.customer.token)).status, 403);
      assert.equal((await del(`${RUTA}/${id}`, ctx.sessions.customer.token)).status, 403);
    });

    it('el COMPANY_ADMIN administra su propio personal', async () => {
      const creado = await post(RUTA, CONDUCTOR, ctx.sessions.companyAdmin.token);
      assert.equal(creado.status, 201);
      assert.equal((await put(`${RUTA}/${creado.body.data.id}`, { phone: '900 111 222' }, ctx.sessions.companyAdmin.token)).status, 200);
      assert.equal((await del(`${RUTA}/${creado.body.data.id}`, ctx.sessions.companyAdmin.token)).status, 200);
    });

    it('sin token no se accede', async () => {
      assert.equal((await get(RUTA)).status, 401);
      assert.equal((await post(RUTA, CONDUCTOR)).status, 401);
      assert.equal((await put(`${RUTA}/1`, { phone: '1' })).status, 401);
      assert.equal((await del(`${RUTA}/1`)).status, 401);
    });
  });

  describe('Validaciones', () => {
    const invalidos: Array<[string, Record<string, unknown>]> = [
      ['sin nombres', { ...CONDUCTOR, first_name: '' }],
      ['nombres demasiado cortos', { ...CONDUCTOR, first_name: 'A' }],
      ['sin apellidos', { ...CONDUCTOR, last_name: '' }],
      ['documento demasiado corto', { ...CONDUCTOR, document_number: '123' }],
      ['documento con símbolos', { ...CONDUCTOR, document_number: '4455-66/77' }],
      ['licencia demasiado corta', { ...CONDUCTOR, license_number: 'Q1' }],
      ['licencia con símbolos', { ...CONDUCTOR, license_number: 'Q44*55/66' }],
      ['fecha de licencia con formato inválido', { ...CONDUCTOR, license_expires_at: '31/12/2030' }],
      ['teléfono con letras', { ...CONDUCTOR, phone: 'novecientos' }],
      ['estado inexistente', { ...CONDUCTOR, status: 'VACACIONES' }],
      ['cuerpo vacío', {}],
    ];

    for (const [nombre, cuerpo] of invalidos) {
      it(`rechaza: ${nombre}`, async () => {
        const res = await post(RUTA, cuerpo, ctx.sessions.companyAdmin.token);
        assert.equal(res.status, 422, JSON.stringify(res.body.errors ?? res.body.message));
        assert.equal((await query('SELECT id FROM drivers')).length, 0, 'no se guarda nada');
      });
    }

    it('acepta licencia sin fecha y sin teléfono', async () => {
      const res = await post(
        RUTA,
        { ...CONDUCTOR, license_expires_at: null, phone: null },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(res.status, 201);
      assert.equal(res.body.data.phone, null);
    });

    it('actualizar sin campos se rechaza', async () => {
      const id = await sembrar(ctx.fixtures.companyA);
      assert.equal((await put(`${RUTA}/${id}`, {}, ctx.sessions.companyAdmin.token)).status, 422);
    });

    it('un id inexistente o no numérico devuelve 404', async () => {
      assert.equal((await get(`${RUTA}/999999`, ctx.sessions.companyAdmin.token)).status, 404);
      assert.equal((await get(`${RUTA}/abc`, ctx.sessions.companyAdmin.token)).status, 404);
      assert.equal((await put(`${RUTA}/999999`, { phone: '900 000 000' }, ctx.sessions.companyAdmin.token)).status, 404);
      assert.equal((await del(`${RUTA}/999999`, ctx.sessions.companyAdmin.token)).status, 404);
    });

    it('un driver_id inexistente en el viaje se rechaza', async () => {
      const res = await put(`/trips/${ctx.fixtures.tripA}`, { driver_id: 999999 }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 400);
    });
  });

  describe('Seguridad', () => {
    it('ignora los campos que no son escribibles (mass assignment)', async () => {
      const res = await post(
        RUTA,
        { ...CONDUCTOR, id: 9999, company_id: ctx.fixtures.companyB, created_at: '2000-01-01 00:00:00', trips_count: 99 },
        ctx.sessions.companyAdmin.token,
      );

      assert.equal(res.status, 201);
      assert.notEqual(Number(res.body.data.id), 9999);
      assert.equal(Number(res.body.data.company_id), ctx.fixtures.companyA);
      assert.ok(!String(res.body.data.created_at).startsWith('2000'));
      assert.equal(Number(res.body.data.trips_count), 0, 'el contador se calcula, no se acepta');
    });

    it('resiste inyección SQL en los campos de texto', async () => {
      const ataques = [
        "Carlos'; DROP TABLE drivers; --",
        "Carlos' OR '1'='1",
        "'; UPDATE drivers SET company_id = 2; --",
      ];
      for (const [indice, first_name] of ataques.entries()) {
        const res = await post(
          RUTA,
          { ...CONDUCTOR, first_name, document_number: `5000000${indice}`, license_number: `Q5000000${indice}` },
          ctx.sessions.companyAdmin.token,
        );
        assert.ok([201, 409, 422].includes(res.status), `${first_name} -> ${res.status}`);
      }

      const tabla = await query<{ company_id: number }>('SELECT company_id FROM drivers');
      assert.ok(Array.isArray(tabla), 'la tabla sigue existiendo');
      assert.ok(tabla.every((fila) => Number(fila.company_id) === ctx.fixtures.companyA), 'ninguna fila cambió de empresa');
    });

    it('resiste inyección SQL en el id de la ruta y en los filtros', async () => {
      assert.equal((await get(`${RUTA}/1 OR 1=1`, ctx.sessions.companyAdmin.token)).status, 404);

      await sembrar(ctx.fixtures.companyB, { first_name: 'DeLaB', document_number: '60000001', license_number: 'Q60000001' });
      const res = await get(`${RUTA}?status=ACTIVE' OR '1'='1`, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200);
      assert.doesNotMatch(JSON.stringify(res.body), /DeLaB/, 'el filtro manipulado no amplía el alcance');
    });

    it('la respuesta no filtra hashes ni datos de usuarios', async () => {
      await sembrar(ctx.fixtures.companyA);
      const cuerpo = JSON.stringify((await get(RUTA, ctx.sessions.companyAdmin.token)).body);
      assert.doesNotMatch(cuerpo, /password/i);
      assert.doesNotMatch(cuerpo, /\$2[aby]\$/);
    });

    it('la clave foránea impide un conductor sin empresa', async () => {
      await assert.rejects(
        () => execute(
          `INSERT INTO drivers (company_id, first_name, last_name, document_number, license_number)
           VALUES (999999, 'Fantasma', 'Sin Empresa', '70000001', 'Q70000001')`,
        ),
        /foreign key|FOREIGN KEY|ER_NO_REFERENCED_ROW/i,
      );
    });

    it('al borrar la empresa se borra su personal en cascada', async () => {
      const empresa = await execute(
        "INSERT INTO companies (name, legal_name, tax_id, email, status) VALUES ('Temporal', 'Temporal SAC', '20444444444', 'tmp@test.pe', 'ACTIVE')",
      );
      await sembrar(empresa.insertId, { document_number: '80000001', license_number: 'Q80000001' });

      await execute('DELETE FROM companies WHERE id = ?', [empresa.insertId]);
      assert.equal((await query('SELECT id FROM drivers WHERE company_id = ?', [empresa.insertId])).length, 0);
    });
  });

  describe('Auditoría', () => {
    it('registra el alta sin volcar documento ni teléfono', async () => {
      await post(RUTA, CONDUCTOR, ctx.sessions.companyAdmin.token);

      const entrada = await queryOne<{ action: string; description: string; new_values: string | null; user_id: number }>(
        "SELECT action, description, new_values, user_id FROM audit_logs WHERE entity_type = 'drivers' ORDER BY id DESC LIMIT 1",
      );
      assert.ok(entrada);
      assert.equal(entrada!.action, 'CREATE');
      assert.equal(Number(entrada!.user_id), ctx.sessions.companyAdmin.user.id);
      assert.match(entrada!.description, /Carlos Mendoza/);
      assert.doesNotMatch(entrada!.description, /44556677/, 'el documento no se guarda');
      assert.doesNotMatch(String(entrada!.new_values ?? ''), /44556677|987 654 321/, 'ni el documento ni el teléfono');
    });

    it('registra la modificación y la baja', async () => {
      const id = await sembrar(ctx.fixtures.companyA);
      await put(`${RUTA}/${id}`, { phone: '900 000 000' }, ctx.sessions.companyAdmin.token);
      await del(`${RUTA}/${id}`, ctx.sessions.companyAdmin.token);

      const acciones = await query<{ action: string }>(
        "SELECT action FROM audit_logs WHERE entity_type = 'drivers' ORDER BY id ASC",
      );
      assert.deepEqual(acciones.map((a) => a.action), ['UPDATE', 'DELETE']);
    });

    it('la asignación al viaje queda registrada en la auditoría de viajes', async () => {
      const conductor = await sembrar(ctx.fixtures.companyA, { document_number: '90000001', license_number: 'Q90000001' });
      await put(`/trips/${ctx.fixtures.tripA}`, { driver_id: conductor }, ctx.sessions.companyAdmin.token);

      const entrada = await queryOne<{ action: string; new_values: string | null }>(
        "SELECT action, new_values FROM audit_logs WHERE entity_type = 'trips' ORDER BY id DESC LIMIT 1",
      );
      assert.equal(entrada?.action, 'UPDATE');
      assert.match(String(entrada?.new_values ?? ''), /driver_id/);
    });
  });
});
