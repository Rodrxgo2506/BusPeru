import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, get, getWithKey, post } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * BP-11 · superficie de integración `/integration/v1`.
 *
 * Cierra el hallazgo: las API Keys ya tenían autenticación real pero no había nada que
 * consumirlas. Aquí se prueba la superficie de solo lectura de extremo a extremo, con
 * peticiones HTTP reales y credenciales creadas por la API de gestión.
 */
describe('BP-11 · API de integración con API Key', () => {
  let ctx: SuiteContext;
  let claveA: string;
  let claveB: string;
  let reservaA: { id: number; booking_code: string };
  let reservaB: { id: number; booking_code: string };

  /** Crea una llave por la API de gestión y devuelve la clave en claro. */
  async function crearClave(cuerpo: Record<string, unknown> = {}): Promise<{ plain: string; id: number }> {
    const res = await post(
      '/api-keys',
      { name: 'Integración', company_id: ctx.fixtures.companyA, ...cuerpo },
      ctx.sessions.admin.token,
    );
    assert.equal(res.status, 201, `no se pudo crear la llave: ${JSON.stringify(res.body)}`);
    return { plain: res.body.data.plain_key as string, id: res.body.data.id as number };
  }

  /** Reserva pagada sobre el viaje indicado. */
  async function reservar(tripId: number) {
    const reserva = await post(
      '/bookings',
      { trip_id: tripId, seat_ids: [at(await freeSeats(tripId), 0).id], passenger_email: 'cliente@test.pe' },
      ctx.sessions.customer.token,
    );
    assert.equal(reserva.status, 201);
    await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'CASH' }, ctx.sessions.customer.token);
    return reserva.body.data as { id: number; booking_code: string };
  }

  before(async () => {
    ctx = await prepareSuite();
    claveA = (await crearClave({ company_id: ctx.fixtures.companyA })).plain;
    claveB = (await crearClave({ company_id: ctx.fixtures.companyB })).plain;
    reservaA = await reservar(ctx.fixtures.tripA);
    reservaB = await reservar(ctx.fixtures.tripB);
  });
  after(teardownSuite);

  /* ------------------------------------------------------------------- viajes */

  describe('Viajes', () => {
    it('lista solo los viajes de la empresa de la clave', async () => {
      const res = await getWithKey('/integration/v1/trips?limit=100', claveA);
      assert.equal(res.status, 200);
      assert.ok(res.body.data.length > 0);

      const propios = await query<{ id: number }>(
        'SELECT t.id FROM trips t JOIN routes r ON r.id = t.route_id WHERE r.company_id = ?',
        [ctx.fixtures.companyA],
      );
      const permitidos = new Set(propios.map((t) => t.id));
      for (const viaje of res.body.data as Array<{ id: number }>) {
        assert.ok(permitidos.has(viaje.id), `el viaje ${viaje.id} no es de la empresa A`);
      }
      assert.equal(res.body.data.some((t: { id: number }) => t.id === ctx.fixtures.tripB), false);
    });

    it('la clave de la empresa B ve otro conjunto distinto', async () => {
      const res = await getWithKey('/integration/v1/trips?limit=100', claveB);
      assert.equal(res.status, 200);
      assert.ok(res.body.data.some((t: { id: number }) => t.id === ctx.fixtures.tripB));
      assert.equal(res.body.data.some((t: { id: number }) => t.id === ctx.fixtures.tripA), false);
    });

    it('devuelve un viaje propio por su id', async () => {
      const res = await getWithKey(`/integration/v1/trips/${ctx.fixtures.tripA}`, claveA);
      assert.equal(res.status, 200);
      assert.equal(Number(res.body.data.id), ctx.fixtures.tripA);
      assert.ok(res.body.data.origin_city);
      assert.ok(res.body.data.bus_code);
    });

    it('un viaje de otra empresa responde 404, igual que uno inexistente', async () => {
      const ajeno = await getWithKey(`/integration/v1/trips/${ctx.fixtures.tripB}`, claveA);
      const inexistente = await getWithKey('/integration/v1/trips/999999', claveA);

      assert.equal(ajeno.status, 404);
      assert.equal(inexistente.status, 404);
      assert.equal(ajeno.body.message, inexistente.body.message, 'no se puede distinguir uno de otro');
    });

    it('un id no numérico también responde 404', async () => {
      assert.equal((await getWithKey('/integration/v1/trips/abc', claveA)).status, 404);
    });

    it('los filtros y la paginación existentes funcionan', async () => {
      const porEstado = await getWithKey('/integration/v1/trips?status=SCHEDULED&limit=100', claveA);
      assert.equal(porEstado.status, 200);
      for (const viaje of porEstado.body.data as Array<{ status: string }>) {
        assert.equal(viaje.status, 'SCHEDULED');
      }

      const porRuta = await getWithKey(`/integration/v1/trips?route_id=${ctx.fixtures.routeA}&limit=100`, claveA);
      assert.ok(porRuta.body.data.length > 0);

      const pagina = await getWithKey('/integration/v1/trips?limit=1&page=1', claveA);
      assert.equal(pagina.body.data.length, 1);
      assert.equal(pagina.body.pagination.limit, 1);
      assert.equal(pagina.body.pagination.page, 1);
      assert.ok(pagina.body.pagination.total >= 1);

      // El tope de la paginación existente sigue vigente: no se aceptan límites absurdos.
      const excesiva = await getWithKey('/integration/v1/trips?limit=100000', claveA);
      assert.equal(excesiva.body.pagination.limit, 100);
    });

    it('no publica datos de la tripulación ni recaudación', async () => {
      const res = await getWithKey(`/integration/v1/trips/${ctx.fixtures.tripA}`, claveA);
      for (const campo of ['driver_name', 'driver_phone', 'co_driver_name', 'co_driver_phone', 'revenue']) {
        assert.equal(campo in res.body.data, false, `${campo} no debe salir de la plataforma`);
      }
    });
  });

  /* ------------------------------------------------------------ disponibilidad */

  describe('Disponibilidad', () => {
    it('devuelve la disponibilidad de un viaje propio', async () => {
      const res = await getWithKey(`/integration/v1/trips/${ctx.fixtures.tripA}/availability`, claveA);
      assert.equal(res.status, 200);
      assert.equal(Number(res.body.data.trip_id), ctx.fixtures.tripA);
      assert.ok(res.body.data.capacity > 0);
      assert.ok(Array.isArray(res.body.data.seats));
      assert.equal(
        res.body.data.capacity,
        res.body.data.seats_taken + res.body.data.seats_available + res.body.data.seats_inactive,
        'las cuentas deben cuadrar',
      );
      assert.ok(res.body.data.seats_taken >= 1, 'la reserva pagada ocupa su asiento');
    });

    it('coincide con el mapa de asientos que ve el resto de la plataforma', async () => {
      const integracion = await getWithKey(`/integration/v1/trips/${ctx.fixtures.tripA}/availability`, claveA);
      const publico = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);

      assert.equal(integracion.body.data.seats.length, publico.body.data.length);
      const ocupadosPublico = (publico.body.data as Array<{ is_taken: number }>).filter((s) => s.is_taken === 1).length;
      assert.equal(integracion.body.data.seats_taken, ocupadosPublico);
    });

    it('la disponibilidad de un viaje ajeno responde 404', async () => {
      assert.equal((await getWithKey(`/integration/v1/trips/${ctx.fixtures.tripB}/availability`, claveA)).status, 404);
      assert.equal((await getWithKey(`/integration/v1/trips/${ctx.fixtures.tripA}/availability`, claveB)).status, 404);
    });

    it('la de un viaje inexistente también', async () => {
      assert.equal((await getWithKey('/integration/v1/trips/999999/availability', claveA)).status, 404);
    });
  });

  /* ----------------------------------------------------------------- reservas */

  describe('Reservas', () => {
    it('lista solo las reservas de los viajes de su empresa', async () => {
      const res = await getWithKey('/integration/v1/bookings?limit=100', claveA);
      assert.equal(res.status, 200);

      const codigos = (res.body.data as Array<{ booking_code: string }>).map((b) => b.booking_code);
      assert.ok(codigos.includes(reservaA.booking_code), 'debe ver la suya');
      assert.equal(codigos.includes(reservaB.booking_code), false, 'no la de la empresa B');
    });

    it('la clave de la empresa B ve la suya y no la de A', async () => {
      const res = await getWithKey('/integration/v1/bookings?limit=100', claveB);
      const codigos = (res.body.data as Array<{ booking_code: string }>).map((b) => b.booking_code);

      assert.ok(codigos.includes(reservaB.booking_code));
      assert.equal(codigos.includes(reservaA.booking_code), false);
    });

    it('los filtros y la paginación funcionan', async () => {
      const porViaje = await getWithKey(`/integration/v1/bookings?trip_id=${ctx.fixtures.tripA}&limit=100`, claveA);
      assert.equal(porViaje.status, 200);
      for (const reserva of porViaje.body.data as Array<{ trip_id: number }>) {
        assert.equal(Number(reserva.trip_id), ctx.fixtures.tripA);
      }

      const porEstado = await getWithKey('/integration/v1/bookings?status=CONFIRMED&limit=100', claveA);
      for (const reserva of porEstado.body.data as Array<{ status: string }>) {
        assert.equal(reserva.status, 'CONFIRMED');
      }

      const pagina = await getWithKey('/integration/v1/bookings?limit=1', claveA);
      assert.equal(pagina.body.data.length, 1);
      assert.equal(pagina.body.pagination.limit, 1);
      assert.ok(pagina.body.pagination.total >= 1);
    });

    it('minimiza los datos del pasajero', async () => {
      const res = await getWithKey('/integration/v1/bookings?limit=100', claveA);
      const reserva = (res.body.data as Array<Record<string, unknown>>)[0]!;

      // Lo que sí necesita un sistema externo para operar.
      for (const campo of ['booking_code', 'status', 'passenger_name', 'seat_numbers', 'total_amount', 'departure_datetime']) {
        assert.ok(campo in reserva, `falta ${campo}, que la operación necesita`);
      }

      // Lo que no sale de la plataforma.
      for (const campo of ['passenger_document', 'passenger_phone', 'passenger_email', 'notes', 'user_id', 'user_email', 'first_name', 'last_name']) {
        assert.equal(campo in reserva, false, `${campo} no debe publicarse`);
      }
    });
  });

  /* ------------------------------------------------------------ autenticación */

  describe('Autenticación', () => {
    it('sin clave responde 401 en los cuatro endpoints', async () => {
      for (const ruta of [
        '/integration/v1/trips',
        `/integration/v1/trips/${ctx.fixtures.tripA}`,
        `/integration/v1/trips/${ctx.fixtures.tripA}/availability`,
        '/integration/v1/bookings',
      ]) {
        assert.equal((await getWithKey(ruta)).status, 401, `${ruta} debe exigir clave`);
      }
    });

    it('una clave inválida responde 401', async () => {
      assert.equal((await getWithKey('/integration/v1/trips', 'no-es-una-clave')).status, 401);
      assert.equal((await getWithKey('/integration/v1/trips', `bp_00000000.${'a'.repeat(48)}`)).status, 401);
    });

    it('una clave revocada deja de funcionar de inmediato', async () => {
      const { plain, id } = await crearClave();
      assert.equal((await getWithKey('/integration/v1/trips', plain)).status, 200);

      await post(`/api-keys/${id}/revoke`, {}, ctx.sessions.admin.token);
      assert.equal((await getWithKey('/integration/v1/trips', plain)).status, 401);
    });

    it('una clave caducada responde 401', async () => {
      const { plain, id } = await crearClave();
      await execute('UPDATE api_keys SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [id]);

      assert.equal((await getWithKey('/integration/v1/trips', plain)).status, 401);
    });

    it('si la empresa no está activa responde 403', async () => {
      await execute("UPDATE companies SET status = 'SUSPENDED' WHERE id = ?", [ctx.fixtures.companyB]);
      try {
        assert.equal((await getWithKey('/integration/v1/trips', claveB)).status, 403);
      } finally {
        await execute("UPDATE companies SET status = 'ACTIVE' WHERE id = ?", [ctx.fixtures.companyB]);
      }
      assert.equal((await getWithKey('/integration/v1/trips', claveB)).status, 200);
    });

    it('marca el uso de la clave al autenticar', async () => {
      const { plain, id } = await crearClave();
      assert.equal((await queryOne<{ last_used_at: string | null }>('SELECT last_used_at FROM api_keys WHERE id = ?', [id]))?.last_used_at, null);

      await getWithKey('/integration/v1/trips', plain);

      const fila = await queryOne<{ last_used_at: string | null }>('SELECT last_used_at FROM api_keys WHERE id = ?', [id]);
      assert.ok(fila?.last_used_at, 'una petición autenticada deja rastro de uso');
    });
  });

  /* -------------------------------------------------------------- aislamiento */

  describe('Aislamiento: el cliente no puede cambiar de empresa', () => {
    it('company_id en la query no cambia el alcance', async () => {
      const res = await getWithKey(`/integration/v1/trips?company_id=${ctx.fixtures.companyB}&limit=100`, claveA);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.some((t: { id: number }) => t.id === ctx.fixtures.tripB), false);
      assert.ok(res.body.data.length > 0, 'sigue viendo los suyos');
    });

    it('el cuerpo no puede cambiar el alcance porque ningún endpoint lo lee', async () => {
      // Los cuatro endpoints son GET y ninguno lee `req.body`. Enviar un cuerpo con otra
      // empresa por un método que no existe se queda en «esa ruta no está», ya autenticado.
      const res = await api('/integration/v1/trips', {
        method: 'POST',
        body: { company_id: ctx.fixtures.companyB },
        apiKey: claveA,
      });
      assert.equal(res.status, 404, 'no hay ninguna ruta que reciba un cuerpo');
    });

    it('una cabecera inventada tampoco', async () => {
      const res = await getWithKey('/integration/v1/trips?limit=100', claveA, {
        'X-Company-Id': String(ctx.fixtures.companyB),
      });
      assert.equal(res.body.data.some((t: { id: number }) => t.id === ctx.fixtures.tripB), false);
    });

    it('company_id en la query tampoco afecta a las reservas', async () => {
      const res = await getWithKey(`/integration/v1/bookings?company_id=${ctx.fixtures.companyB}&limit=100`, claveA);
      const codigos = (res.body.data as Array<{ booking_code: string }>).map((b) => b.booking_code);
      assert.equal(codigos.includes(reservaB.booking_code), false);
    });

    it('la superficie es de solo lectura: con clave válida, ninguna escritura existe', async () => {
      const rutas = ['/integration/v1/bookings', '/integration/v1/trips', '/integration/v1/payments', '/integration/v1/refunds'];

      for (const ruta of rutas) {
        for (const method of ['POST', 'PUT', 'DELETE'] as const) {
          const res = await api(ruta, { method, body: {}, apiKey: claveA });
          assert.equal(res.status, 404, `${method} ${ruta} no debe existir`);
        }
      }

      // Y sin credencial la autenticación corta antes, que es el orden correcto.
      assert.equal((await api('/integration/v1/bookings', { method: 'POST', body: {} })).status, 401);
    });
  });

  /* ----------------------------------------------------------------- permisos */

  describe('Permisos', () => {
    it('una clave sin trips.view no puede consultar viajes', async () => {
      const { plain } = await crearClave({ permissions: ['bookings.view'] });

      assert.equal((await getWithKey('/integration/v1/trips', plain)).status, 403);
      assert.equal((await getWithKey(`/integration/v1/trips/${ctx.fixtures.tripA}`, plain)).status, 403);
      assert.equal((await getWithKey(`/integration/v1/trips/${ctx.fixtures.tripA}/availability`, plain)).status, 403);
      assert.equal((await getWithKey('/integration/v1/bookings', plain)).status, 200, 'lo que sí tiene, funciona');
    });

    it('una clave sin bookings.view no puede consultar reservas', async () => {
      const { plain } = await crearClave({ permissions: ['trips.view'] });

      assert.equal((await getWithKey('/integration/v1/bookings', plain)).status, 403);
      assert.equal((await getWithKey('/integration/v1/trips', plain)).status, 200);
    });

    it('una clave sin permisos no accede a nada', async () => {
      const { plain } = await crearClave({ permissions: [] });

      assert.equal((await getWithKey('/integration/v1/trips', plain)).status, 403);
      assert.equal((await getWithKey('/integration/v1/bookings', plain)).status, 403);
    });

    it('los permisos que el cliente se inventa no le dan nada', async () => {
      const { plain } = await crearClave({
        permissions: ['settings.update', 'roles.delete', 'audit_logs.view', 'payments.refund', 'users.delete'],
      });

      // Ninguno de esos está en el techo de empresa, así que la llave se queda sin permisos.
      assert.equal((await getWithKey('/integration/v1/trips', plain)).status, 403);
      assert.equal((await getWithKey('/integration/v1/bookings', plain)).status, 403);
    });

    it('sin permisos declarados hereda el techo de la empresa y accede a todo lo de lectura', async () => {
      const { plain } = await crearClave();
      assert.equal((await getWithKey('/integration/v1/trips', plain)).status, 200);
      assert.equal((await getWithKey('/integration/v1/bookings', plain)).status, 200);
    });
  });

  /* ------------------------------------------------------------------ secretos */

  describe('Secretos', () => {
    it('ninguna respuesta contiene la clave ni su hash', async () => {
      const respuestas = await Promise.all([
        getWithKey('/integration/v1/trips?limit=100', claveA),
        getWithKey(`/integration/v1/trips/${ctx.fixtures.tripA}`, claveA),
        getWithKey(`/integration/v1/trips/${ctx.fixtures.tripA}/availability`, claveA),
        getWithKey('/integration/v1/bookings?limit=100', claveA),
      ]);

      for (const res of respuestas) {
        const cuerpo = JSON.stringify(res.body);
        assert.equal(cuerpo.includes(claveA), false, 'la clave no puede volver en la respuesta');
        assert.equal(cuerpo.includes('key_hash'), false);
        assert.equal(cuerpo.includes('password_hash'), false);
        assert.equal(cuerpo.includes('plain_key'), false);
        assert.equal(/"token"/.test(cuerpo), false, 'ningún token de sesión');
      }
    });

    it('el error de una clave inválida no revela nada', async () => {
      const res = await getWithKey('/integration/v1/trips', `bp_00000000.${'a'.repeat(48)}`);
      const cuerpo = JSON.stringify(res.body);

      assert.equal(cuerpo.includes('key_hash'), false);
      assert.equal(cuerpo.includes('company_id'), false);
    });
  });

  /* ----------------------------------------------------------------- regresión */

  describe('Regresión: nada de lo anterior cambia', () => {
    it('una API Key no sirve como JWT', async () => {
      assert.equal((await get('/auth/me', claveA)).status, 401);
      assert.equal((await get('/trips', claveA)).status, 401);
      assert.equal((await get('/bookings', claveA)).status, 401);
    });

    it('un JWT no sirve en la API de integración', async () => {
      for (const sesion of [ctx.sessions.admin, ctx.sessions.companyAdmin, ctx.sessions.customer]) {
        assert.equal((await get('/integration/v1/trips', sesion.token)).status, 401, 'aquí solo vale X-API-Key');
      }
    });

    it('el JWT sigue funcionando en su propia superficie', async () => {
      assert.equal((await get('/auth/me', ctx.sessions.admin.token)).status, 200);
      assert.equal((await get('/trips?limit=1', ctx.sessions.companyAdmin.token)).status, 200);
      assert.equal((await get('/bookings?limit=1', ctx.sessions.customer.token)).status, 200);
      assert.equal((await get('/dashboard/company', ctx.sessions.companyAdmin.token)).status, 200);
    });

    it('el flujo OAuth sigue en pie', async () => {
      const proveedores = await get('/auth/oauth/providers');
      assert.equal(proveedores.status, 200);
      assert.ok(Array.isArray(proveedores.body.data));
      assert.equal((await post('/auth/oauth/session', { ticket: 'inventado' })).status, 401);
    });

    it('las rutas públicas siguen abiertas sin credencial', async () => {
      for (const ruta of ['/public/cities', '/public/trips', '/public/companies', '/public/settings']) {
        assert.equal((await get(ruta)).status, 200);
      }
    });

    it('la gestión de API Keys no cambió', async () => {
      assert.equal((await get('/api-keys')).status, 401);
      assert.equal((await get('/api-keys', ctx.sessions.admin.token)).status, 200);
      assert.equal((await post('/api-keys', { name: 'x' }, ctx.sessions.customer.token)).status, 403);
    });
  });
});
