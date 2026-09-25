import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execute, query, queryOne } from '../config/database';
import { get, post } from './helpers/api';
import { at, freeSeats } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * Ida y vuelta / multidestino (mockup 1).
 *
 * Modelo: una reserva por tramo, agrupadas por `booking_groups`. La ida simple no usa
 * grupo, así que su comportamiento debe seguir siendo idéntico.
 */
describe('Itinerarios de varios tramos', () => {
  let ctx: SuiteContext;

  /** Fecha de un viaje de las fixtures, en formato AAAA-MM-DD. */
  async function fechaDe(tripId: number): Promise<string> {
    const row = await queryOne<{ fecha: string }>(
      'SELECT DATE_FORMAT(departure_datetime, "%Y-%m-%d") AS fecha FROM trips WHERE id = ?',
      [tripId],
    );
    return row!.fecha;
  }

  /** Ciudades de origen y destino de un viaje. */
  async function ciudadesDe(tripId: number): Promise<{ origen: string; destino: string }> {
    const row = await queryOne<{ origen: string; destino: string }>(
      `SELECT ol.city AS origen, dl.city AS destino
       FROM trips t JOIN routes r ON r.id = t.route_id
       JOIN locations ol ON ol.id = r.origin_location_id
       JOIN locations dl ON dl.id = r.destination_location_id
       WHERE t.id = ?`,
      [tripId],
    );
    return row!;
  }

  /** Segundo viaje de la empresa A, para usarlo como tramo de vuelta. */
  let tripVuelta: number;

  before(async () => {
    ctx = await prepareSuite();

    // Un viaje de vuelta sobre la ruta de la empresa A, un día después.
    const bus = await queryOne<{ bus_id: number; route_id: number }>(
      'SELECT bus_id, route_id FROM trips WHERE id = ?', [ctx.fixtures.tripA],
    );
    const creado = await execute(
      `INSERT INTO trips (route_id, bus_id, departure_datetime, base_price, available_seats, status)
       SELECT ?, ?, DATE_ADD(departure_datetime, INTERVAL 2 DAY), base_price, available_seats, 'SCHEDULED'
       FROM trips WHERE id = ?`,
      [bus!.route_id, bus!.bus_id, ctx.fixtures.tripA],
    );
    tripVuelta = creado.insertId;
  });
  after(teardownSuite);

  beforeEach(async () => {
    // De dentro hacia fuera: todo lo que referencia a `bookings` antes que ellas.
    await execute('DELETE FROM financial_transactions');
    await execute('DELETE FROM coupon_usages');
    await execute('DELETE FROM booking_seats');
    await execute('DELETE FROM payments');
    await execute('DELETE FROM notifications');
    await execute('DELETE FROM bookings');
    await execute('DELETE FROM booking_groups');
    // Los tests borran reservas por SQL, que no repone la disponibilidad: se restaura a
    // la capacidad del bus para que cada test parta del mismo estado.
    await execute('UPDATE trips t JOIN buses b ON b.id = t.bus_id SET t.available_seats = b.capacity');
  });

  /** Cuerpo válido de un ida y vuelta con un asiento por tramo. */
  async function cuerpoIdaVuelta(): Promise<Record<string, unknown>> {
    const ida = await freeSeats(ctx.fixtures.tripA);
    const vuelta = await freeSeats(tripVuelta);
    return {
      trip_type: 'ROUND_TRIP',
      segments: [
        { trip_id: ctx.fixtures.tripA, seat_ids: [at(ida, 0).id] },
        { trip_id: tripVuelta, seat_ids: [at(vuelta, 0).id] },
      ],
      passenger_email: 'cliente@test.pe',
      passenger_name: 'Cliente Itinerario',
    };
  }

  describe('Regresión: la ida simple no cambia', () => {
    it('sigue creándose una reserva sin grupo', async () => {
      const seats = await freeSeats(ctx.fixtures.tripA);
      const res = await post('/bookings', {
        trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id], passenger_email: 'cliente@test.pe',
      }, ctx.sessions.customer.token);

      assert.equal(res.status, 201);
      const fila = await queryOne<{ group_id: number | null; segment_order: number }>(
        'SELECT group_id, segment_order FROM bookings WHERE id = ?', [res.body.data.id],
      );
      assert.equal(fila?.group_id, null, 'una ida simple no crea grupo');
      assert.equal(Number(fila?.segment_order), 1);
      assert.equal((await query('SELECT id FROM booking_groups')).length, 0);
    });

    it('la búsqueda de ida sigue respondiendo igual', async () => {
      const { origen, destino } = await ciudadesDe(ctx.fixtures.tripA);
      const res = await get(`/public/trips?origin=${encodeURIComponent(origen)}&destination=${encodeURIComponent(destino)}`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.pagination, 'conserva la paginación');
    });

    it('el pago de una reserva simple sigue funcionando', async () => {
      const seats = await freeSeats(ctx.fixtures.tripA);
      const reserva = await post('/bookings', {
        trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id], passenger_email: 'cliente@test.pe', payment_method: 'YAPE',
      }, ctx.sessions.customer.token);
      const pago = await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);

      assert.equal(pago.status, 200);
      assert.equal(pago.body.data.status, 'CONFIRMED');
    });
  });

  describe('Búsqueda de itinerarios', () => {
    it('devuelve resultados por tramo en un ida y vuelta', async () => {
      const { origen, destino } = await ciudadesDe(ctx.fixtures.tripA);
      const res = await post('/public/itineraries/search', {
        trip_type: 'ROUND_TRIP',
        segments: [
          { origin: origen, destination: destino, date: await fechaDe(ctx.fixtures.tripA) },
          { origin: destino, destination: origen, date: await fechaDe(tripVuelta) },
        ],
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 2);
      assert.equal(res.body.data[0].segment_order, 1);
      assert.equal(res.body.data[1].segment_order, 2);
      assert.ok(res.body.data[0].trips.length > 0, 'el tramo de ida encuentra viajes');
    });

    it('acepta un multidestino de tres tramos', async () => {
      const { origen, destino } = await ciudadesDe(ctx.fixtures.tripA);
      const fecha = await fechaDe(ctx.fixtures.tripA);
      const res = await post('/public/itineraries/search', {
        trip_type: 'MULTI_CITY',
        segments: [
          { origin: origen, destination: destino, date: fecha },
          { origin: destino, destination: 'Cusco', date: fecha },
          { origin: 'Cusco', destination: origen, date: fecha },
        ],
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 3);
    });

    it('no exige sesión: la búsqueda es pública', async () => {
      const { origen, destino } = await ciudadesDe(ctx.fixtures.tripA);
      const fecha = await fechaDe(ctx.fixtures.tripA);
      const res = await post('/public/itineraries/search', {
        trip_type: 'ROUND_TRIP',
        segments: [{ origin: origen, destination: destino, date: fecha }, { origin: destino, destination: origen, date: fecha }],
      });
      assert.equal(res.status, 200);
    });

    const invalidas: Array<[string, Record<string, unknown>]> = [
      ['vuelta anterior a la ida', {
        trip_type: 'ROUND_TRIP',
        segments: [{ origin: 'Lima', destination: 'Cusco', date: '2030-06-10' }, { origin: 'Cusco', destination: 'Lima', date: '2030-06-05' }],
      }],
      ['tramo 3 anterior al tramo 2', {
        trip_type: 'MULTI_CITY',
        segments: [
          { origin: 'Lima', destination: 'Cusco', date: '2030-06-01' },
          { origin: 'Cusco', destination: 'Puno', date: '2030-06-05' },
          { origin: 'Puno', destination: 'Lima', date: '2030-06-02' },
        ],
      }],
      ['origen igual al destino', {
        trip_type: 'ROUND_TRIP',
        segments: [{ origin: 'Lima', destination: 'Lima', date: '2030-06-01' }, { origin: 'Lima', destination: 'Cusco', date: '2030-06-05' }],
      }],
      ['fecha con formato inválido', {
        trip_type: 'ROUND_TRIP',
        segments: [{ origin: 'Lima', destination: 'Cusco', date: '10/06/2030' }, { origin: 'Cusco', destination: 'Lima', date: '2030-06-15' }],
      }],
      ['fecha inexistente', {
        trip_type: 'ROUND_TRIP',
        segments: [{ origin: 'Lima', destination: 'Cusco', date: '2030-02-31' }, { origin: 'Cusco', destination: 'Lima', date: '2030-03-05' }],
      }],
      ['ida y vuelta con un solo tramo', {
        trip_type: 'ROUND_TRIP',
        segments: [{ origin: 'Lima', destination: 'Cusco', date: '2030-06-01' }],
      }],
      ['ida y vuelta con tres tramos', {
        trip_type: 'ROUND_TRIP',
        segments: [
          { origin: 'Lima', destination: 'Cusco', date: '2030-06-01' },
          { origin: 'Cusco', destination: 'Puno', date: '2030-06-02' },
          { origin: 'Puno', destination: 'Lima', date: '2030-06-03' },
        ],
      }],
      ['más de cinco tramos', {
        trip_type: 'MULTI_CITY',
        segments: Array.from({ length: 6 }, (_, i) => ({ origin: `Ciudad${i}`, destination: `Ciudad${i + 1}`, date: `2030-06-0${i + 1}` })),
      }],
      ['tipo de viaje inexistente', {
        trip_type: 'ONE_WAY',
        segments: [{ origin: 'Lima', destination: 'Cusco', date: '2030-06-01' }, { origin: 'Cusco', destination: 'Lima', date: '2030-06-05' }],
      }],
    ];

    for (const [nombre, cuerpo] of invalidas) {
      it(`rechaza: ${nombre}`, async () => {
        assert.equal((await post('/public/itineraries/search', cuerpo)).status, 422);
      });
    }

    it('un tramo sin viajes devuelve una lista vacía, no un error', async () => {
      const res = await post('/public/itineraries/search', {
        trip_type: 'ROUND_TRIP',
        segments: [
          { origin: 'CiudadInexistente', destination: 'OtraInexistente', date: '2030-06-01' },
          { origin: 'OtraInexistente', destination: 'CiudadInexistente', date: '2030-06-05' },
        ],
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data[0].trips, []);
      assert.equal(res.body.data[0].total, 0);
    });
  });

  describe('Compra de ida y vuelta', () => {
    it('crea una reserva por tramo agrupadas en una compra', async () => {
      const res = await post('/bookings/itineraries', await cuerpoIdaVuelta(), ctx.sessions.customer.token);

      assert.equal(res.status, 201);
      assert.equal(res.body.data.trip_type, 'ROUND_TRIP');
      assert.equal(res.body.data.segments.length, 2);
      assert.match(res.body.data.group_code, /^IT-\d{6}$/);

      const reservas = await query<{ group_id: number; segment_order: number; trip_id: number }>(
        'SELECT group_id, segment_order, trip_id FROM bookings ORDER BY segment_order',
      );
      assert.equal(reservas.length, 2);
      assert.equal(Number(reservas[0]!.group_id), Number(reservas[1]!.group_id), 'ambas comparten grupo');
      assert.equal(Number(reservas[0]!.segment_order), 1);
      assert.equal(Number(reservas[1]!.segment_order), 2);
      assert.notEqual(Number(reservas[0]!.trip_id), Number(reservas[1]!.trip_id), 'cada tramo es un viaje distinto');
    });

    it('cada tramo conserva sus propios asientos', async () => {
      const res = await post('/bookings/itineraries', await cuerpoIdaVuelta(), ctx.sessions.customer.token);
      const [ida, vuelta] = res.body.data.segments;

      const asientosIda = await query('SELECT trip_id FROM booking_seats WHERE booking_id = ?', [ida.booking_id]);
      const asientosVuelta = await query('SELECT trip_id FROM booking_seats WHERE booking_id = ?', [vuelta.booking_id]);

      assert.equal(asientosIda.length, 1);
      assert.equal(asientosVuelta.length, 1);
      assert.equal(Number((asientosIda[0] as { trip_id: number }).trip_id), ctx.fixtures.tripA);
      assert.equal(Number((asientosVuelta[0] as { trip_id: number }).trip_id), tripVuelta);
    });

    it('el mismo número de asiento en tramos distintos no genera conflicto', async () => {
      const ida = await freeSeats(ctx.fixtures.tripA);
      const vuelta = await freeSeats(tripVuelta);
      // Ambos viajes usan el mismo bus en las fixtures, así que el asiento es el mismo id.
      const asiento = at(ida, 0).id;
      assert.ok(vuelta.some((seat) => seat.id === asiento), 'las fixtures comparten bus entre los dos viajes');

      const res = await post('/bookings/itineraries', {
        trip_type: 'ROUND_TRIP',
        segments: [
          { trip_id: ctx.fixtures.tripA, seat_ids: [asiento] },
          { trip_id: tripVuelta, seat_ids: [asiento] },
        ],
        passenger_email: 'cliente@test.pe',
      }, ctx.sessions.customer.token);

      assert.equal(res.status, 201, 'la disponibilidad se evalúa por trip_id + seat_id');
    });

    it('descuenta available_seats en los dos viajes', async () => {
      const antesIda = await queryOne<{ n: number }>('SELECT available_seats n FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
      const antesVuelta = await queryOne<{ n: number }>('SELECT available_seats n FROM trips WHERE id = ?', [tripVuelta]);

      await post('/bookings/itineraries', await cuerpoIdaVuelta(), ctx.sessions.customer.token);

      const despuesIda = await queryOne<{ n: number }>('SELECT available_seats n FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
      const despuesVuelta = await queryOne<{ n: number }>('SELECT available_seats n FROM trips WHERE id = ?', [tripVuelta]);
      assert.equal(Number(despuesIda?.n), Number(antesIda?.n) - 1);
      assert.equal(Number(despuesVuelta?.n), Number(antesVuelta?.n) - 1);
    });

    it('genera una notificación por tramo', async () => {
      await post('/bookings/itineraries', await cuerpoIdaVuelta(), ctx.sessions.customer.token);
      const avisos = await query(
        "SELECT id FROM notifications WHERE JSON_UNQUOTE(JSON_EXTRACT(data,'$.event')) = 'booking.created'",
      );
      assert.equal(avisos.length, 2);
    });

    it('consulta el itinerario completo', async () => {
      const creado = await post('/bookings/itineraries', await cuerpoIdaVuelta(), ctx.sessions.customer.token);
      const res = await get(`/bookings/itineraries/${creado.body.data.group_id}`, ctx.sessions.customer.token);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.segments.length, 2);
      assert.ok(res.body.data.segments[0].origin_city, 'incluye las ciudades de cada tramo');
      assert.ok(res.body.data.segments[0].seat_numbers, 'incluye los asientos de cada tramo');
      assert.ok(Number(res.body.data.total_amount) > 0);
    });

    it('paga los dos tramos y ambos quedan confirmados', async () => {
      const creado = await post(
        '/bookings/itineraries',
        { ...(await cuerpoIdaVuelta()), payment_method: 'YAPE' },
        ctx.sessions.customer.token,
      );

      const pago = await post(`/bookings/itineraries/${creado.body.data.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);
      assert.equal(pago.status, 200);
      assert.ok(pago.body.data.segments.every((s: { status: string }) => s.status === 'CONFIRMED'));

      const pagos = await query("SELECT id FROM payments WHERE status = 'PAID'");
      assert.equal(pagos.length, 2, 'un pago por tramo: cada empresa cobra el suyo');
    });

    it('el cupón se aplica una sola vez a toda la compra', async () => {
      const promo = await post('/promotions', {
        company_id: ctx.fixtures.companyA, name: 'Promo itinerario', discount_type: 'PERCENTAGE', discount_value: 10,
        start_at: '2020-01-01 00:00:00', end_at: '2035-12-31 23:59:59', status: 'ACTIVE',
      }, ctx.sessions.admin.token);
      const codigo = `IT${Date.now().toString().slice(-8)}`;
      await post('/coupons', { promotion_id: promo.body.data.id, code: codigo, usage_limit: 5, per_user_limit: 1, status: 'ACTIVE' }, ctx.sessions.admin.token);

      const res = await post('/bookings/itineraries', { ...(await cuerpoIdaVuelta()), coupon_code: codigo }, ctx.sessions.customer.token);
      assert.equal(res.status, 201);

      const usos = await queryOne<{ usage_count: number }>('SELECT usage_count FROM coupons WHERE code = ?', [codigo]);
      assert.equal(Number(usos?.usage_count), 1, 'no se consume una vez por tramo');
      assert.equal((await query('SELECT id FROM coupon_usages')).length, 1);
    });
  });

  describe('Multidestino', () => {
    it('crea tres tramos relacionados', async () => {
      const s1 = await freeSeats(ctx.fixtures.tripA);
      const s2 = await freeSeats(tripVuelta);
      const s3 = await freeSeats(ctx.fixtures.tripB);

      const res = await post('/bookings/itineraries', {
        trip_type: 'MULTI_CITY',
        segments: [
          { trip_id: ctx.fixtures.tripA, seat_ids: [at(s1, 0).id] },
          { trip_id: tripVuelta, seat_ids: [at(s2, 1).id] },
          { trip_id: ctx.fixtures.tripB, seat_ids: [at(s3, 0).id] },
        ],
        passenger_email: 'cliente@test.pe',
      }, ctx.sessions.customer.token);

      assert.equal(res.status, 201);
      assert.equal(res.body.data.segments.length, 3);
      assert.deepEqual(res.body.data.segments.map((s: { segment_order: number }) => s.segment_order), [1, 2, 3]);
    });

    it('admite tramos de empresas distintas', async () => {
      const s1 = await freeSeats(ctx.fixtures.tripA);
      const s2 = await freeSeats(ctx.fixtures.tripB);

      const res = await post('/bookings/itineraries', {
        trip_type: 'ROUND_TRIP',
        segments: [
          { trip_id: ctx.fixtures.tripA, seat_ids: [at(s1, 0).id] },
          { trip_id: ctx.fixtures.tripB, seat_ids: [at(s2, 0).id] },
        ],
        passenger_email: 'cliente@test.pe',
      }, ctx.sessions.customer.token);

      assert.equal(res.status, 201, 'la ida y la vuelta pueden ser de empresas diferentes');
      const empresas = await query<{ company_id: number }>(
        `SELECT r.company_id FROM bookings bk JOIN trips t ON t.id = bk.trip_id JOIN routes r ON r.id = t.route_id
         WHERE bk.group_id IS NOT NULL`,
      );
      assert.equal(new Set(empresas.map((e) => Number(e.company_id))).size, 2, 'cada tramo conserva su empresa');
    });

    it('no permite repetir el mismo viaje en dos tramos', async () => {
      const seats = await freeSeats(ctx.fixtures.tripA);
      const res = await post('/bookings/itineraries', {
        trip_type: 'ROUND_TRIP',
        segments: [
          { trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id] },
          { trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 1).id] },
        ],
        passenger_email: 'cliente@test.pe',
      }, ctx.sessions.customer.token);
      assert.equal(res.status, 422);
    });
  });

  describe('Transaccionalidad y concurrencia', () => {
    it('si un tramo falla no queda nada creado', async () => {
      const ida = await freeSeats(ctx.fixtures.tripA);
      const vuelta = await freeSeats(tripVuelta);

      // El asiento de la vuelta se ocupa antes con otra reserva.
      await post('/bookings', {
        trip_id: tripVuelta, seat_ids: [at(vuelta, 0).id], passenger_email: 'cliente@test.pe',
      }, ctx.sessions.customer.token);

      const antes = (await query('SELECT id FROM bookings')).length;

      const res = await post('/bookings/itineraries', {
        trip_type: 'ROUND_TRIP',
        segments: [
          { trip_id: ctx.fixtures.tripA, seat_ids: [at(ida, 0).id] },
          { trip_id: tripVuelta, seat_ids: [at(vuelta, 0).id] },
        ],
        passenger_email: 'cliente@test.pe',
      }, ctx.sessions.customer.token);

      assert.equal(res.status, 409, `el segundo tramo tiene el asiento tomado — ${JSON.stringify(res.body)}`);
      assert.equal((await query('SELECT id FROM bookings')).length, antes, 'el primer tramo se deshizo');
      assert.equal((await query('SELECT id FROM booking_groups')).length, 0, 'tampoco queda el grupo');
    });

    it('el rollback devuelve available_seats a su valor original', async () => {
      const ida = await freeSeats(ctx.fixtures.tripA);
      const vuelta = await freeSeats(tripVuelta);
      await post('/bookings', { trip_id: tripVuelta, seat_ids: [at(vuelta, 0).id], passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token);

      const antes = await queryOne<{ n: number }>('SELECT available_seats n FROM trips WHERE id = ?', [ctx.fixtures.tripA]);

      await post('/bookings/itineraries', {
        trip_type: 'ROUND_TRIP',
        segments: [
          { trip_id: ctx.fixtures.tripA, seat_ids: [at(ida, 0).id] },
          { trip_id: tripVuelta, seat_ids: [at(vuelta, 0).id] },
        ],
        passenger_email: 'cliente@test.pe',
      }, ctx.sessions.customer.token);

      const despues = await queryOne<{ n: number }>('SELECT available_seats n FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
      assert.equal(Number(despues?.n), Number(antes?.n), 'el tramo que sí se creó no dejó rastro');
    });

    it('bajo concurrencia solo una compra se queda con el asiento', async () => {
      const ida = await freeSeats(ctx.fixtures.tripA);
      const vuelta = await freeSeats(tripVuelta);
      const cuerpo = {
        trip_type: 'ROUND_TRIP',
        segments: [
          { trip_id: ctx.fixtures.tripA, seat_ids: [at(ida, 0).id] },
          { trip_id: tripVuelta, seat_ids: [at(vuelta, 0).id] },
        ],
        passenger_email: 'cliente@test.pe',
      };

      const enParalelo = await Promise.all(
        Array.from({ length: 4 }, () => post('/bookings/itineraries', cuerpo, ctx.sessions.customer.token)),
      );
      const creadas = enParalelo.filter((r) => r.status === 201);
      assert.equal(creadas.length, 1, `códigos ${enParalelo.map((r) => r.status).join(',')}`);
      assert.equal((await query('SELECT id FROM booking_groups')).length, 1);
    });

    it('un viaje que ya partió se rechaza y no deja el otro tramo', async () => {
      const ida = await freeSeats(ctx.fixtures.tripA);
      const vuelta = await freeSeats(tripVuelta);
      await execute('UPDATE trips SET departure_datetime = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id = ?', [tripVuelta]);

      try {
        const res = await post('/bookings/itineraries', {
          trip_type: 'ROUND_TRIP',
          segments: [
            { trip_id: ctx.fixtures.tripA, seat_ids: [at(ida, 0).id] },
            { trip_id: tripVuelta, seat_ids: [at(vuelta, 0).id] },
          ],
          passenger_email: 'cliente@test.pe',
        }, ctx.sessions.customer.token);

        assert.equal(res.status, 400);
        assert.equal((await query('SELECT id FROM bookings')).length, 0);
      } finally {
        await execute('UPDATE trips SET departure_datetime = DATE_ADD(NOW(), INTERVAL 5 DAY) WHERE id = ?', [tripVuelta]);
      }
    });
  });

  describe('Seguridad', () => {
    it('sin sesión no se puede comprar', async () => {
      assert.equal((await post('/bookings/itineraries', await cuerpoIdaVuelta())).status, 401);
      assert.equal((await get('/bookings/itineraries/1')).status, 401);
    });

    it('un cliente no ve el itinerario de otro usuario (IDOR)', async () => {
      const creado = await post('/bookings/itineraries', await cuerpoIdaVuelta(), ctx.sessions.customer.token);
      assert.equal(creado.status, 201, JSON.stringify(creado.body));
      const groupId = creado.body.data.group_id;

      const ajeno = await get(`/bookings/itineraries/${groupId}`, ctx.sessions.companyAdmin.token);
      assert.equal(ajeno.status, 404, '404 y no 403: no se confirma que exista');

      const propio = await get(`/bookings/itineraries/${groupId}`, ctx.sessions.customer.token);
      assert.equal(propio.status, 200);
    });

    it('un cliente no puede pagar el itinerario de otro', async () => {
      const creado = await post('/bookings/itineraries', await cuerpoIdaVuelta(), ctx.sessions.customer.token);
      const res = await post(`/bookings/itineraries/${creado.body.data.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 404);
    });

    it('ignora los campos que no son escribibles (mass assignment)', async () => {
      const cuerpo = await cuerpoIdaVuelta();
      const res = await post('/bookings/itineraries', {
        ...cuerpo,
        id: 9999,
        group_id: 9999,
        user_id: ctx.fixtures.users.admin,
        status: 'CONFIRMED',
        total_amount: 0,
      }, ctx.sessions.customer.token);

      assert.equal(res.status, 201);
      assert.notEqual(Number(res.body.data.group_id), 9999);
      const reservas = await query<{ user_id: number; status: string; total_amount: number }>(
        'SELECT user_id, status, total_amount FROM bookings',
      );
      assert.ok(reservas.every((b) => Number(b.user_id) === ctx.sessions.customer.user.id), 'la compra es del usuario en sesión');
      assert.ok(reservas.every((b) => b.status === 'PENDING'), 'no se puede nacer confirmado');
      assert.ok(reservas.every((b) => Number(b.total_amount) > 0), 'el importe lo calcula el servidor');
    });

    it('un trip_id inexistente o de un viaje cancelado se rechaza', async () => {
      const ida = await freeSeats(ctx.fixtures.tripA);
      const res = await post('/bookings/itineraries', {
        trip_type: 'ROUND_TRIP',
        segments: [
          { trip_id: ctx.fixtures.tripA, seat_ids: [at(ida, 0).id] },
          { trip_id: 999999, seat_ids: [at(ida, 1).id] },
        ],
        passenger_email: 'cliente@test.pe',
      }, ctx.sessions.customer.token);

      assert.equal(res.status, 404);
      assert.equal((await query('SELECT id FROM bookings')).length, 0);
    });

    it('un asiento de otro bus se rechaza', async () => {
      const ida = await freeSeats(ctx.fixtures.tripA);
      const ajeno = await freeSeats(ctx.fixtures.tripB);
      const res = await post('/bookings/itineraries', {
        trip_type: 'ROUND_TRIP',
        segments: [
          { trip_id: ctx.fixtures.tripA, seat_ids: [at(ida, 0).id] },
          { trip_id: tripVuelta, seat_ids: [at(ajeno, 0).id] },
        ],
        passenger_email: 'cliente@test.pe',
      }, ctx.sessions.customer.token);

      assert.equal(res.status, 400);
      assert.equal((await query('SELECT id FROM bookings')).length, 0);
    });

    it('resiste inyección SQL en la búsqueda', async () => {
      const ataques = ["Lima'; DROP TABLE trips; --", "Lima' OR '1'='1"];
      for (const origin of ataques) {
        const res = await post('/public/itineraries/search', {
          trip_type: 'ROUND_TRIP',
          segments: [{ origin, destination: 'Cusco', date: '2030-06-01' }, { origin: 'Cusco', destination: origin, date: '2030-06-05' }],
        });
        assert.ok([200, 422].includes(res.status), `${origin} -> ${res.status}`);
      }
      assert.ok((await query('SELECT id FROM trips LIMIT 1')).length > 0, 'la tabla sigue existiendo');
    });

    it('un group_id no numérico devuelve 404', async () => {
      assert.equal((await get('/bookings/itineraries/abc', ctx.sessions.customer.token)).status, 404);
      assert.equal((await get('/bookings/itineraries/999999', ctx.sessions.customer.token)).status, 404);
    });
  });

  describe('Integridad del grupo', () => {
    it('borrar el grupo no borra las reservas', async () => {
      const creado = await post('/bookings/itineraries', await cuerpoIdaVuelta(), ctx.sessions.customer.token);
      await execute('DELETE FROM booking_groups WHERE id = ?', [creado.body.data.group_id]);

      const reservas = await query<{ group_id: number | null }>('SELECT group_id FROM bookings');
      assert.equal(reservas.length, 2, 'las reservas sobreviven');
      assert.ok(reservas.every((b) => b.group_id === null), 'la referencia queda a NULL');
    });

    it('la reserva de un tramo aparece en el listado normal de reservas', async () => {
      const creado = await post('/bookings/itineraries', await cuerpoIdaVuelta(), ctx.sessions.customer.token);
      const lista = await get('/bookings?limit=50', ctx.sessions.customer.token);

      const codigos = lista.body.data.map((b: { booking_code: string }) => b.booking_code);
      for (const segmento of creado.body.data.segments) {
        assert.ok(codigos.includes(segmento.booking_code), `${segmento.booking_code} debe verse en Mis viajes`);
      }
    });
  });
});
