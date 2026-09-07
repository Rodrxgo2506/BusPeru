import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { get, post } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * BP-21 · orden de cerrojos en la compra de itinerarios.
 *
 * Reservar un tramo empieza bloqueando la fila de su viaje, y los tramos se recorrían en el
 * orden que enviaba el usuario. Dos compras simultáneas de los mismos dos viajes en sentidos
 * opuestos tomaban los cerrojos al revés y se quedaban esperándose:
 *
 *     A: bloquea viaje 1 … y espera el 3
 *     B: bloquea viaje 3 … y espera el 1
 *
 * Medido antes de la corrección, con diez compras cruzadas a la vez: **nueve respuestas 500**
 * tras 50 segundos colgadas (ER_LOCK_WAIT_TIMEOUT), más el ER_LOCK_DEADLOCK que InnoDB usa
 * para romper el ciclo.
 *
 * Reproducir esto exige concurrencia de verdad. Un `await A(); await B();` no prueba nada:
 * las transacciones no llegan a solaparse y todo pasa. Aquí las peticiones salen juntas con
 * `Promise.all`, que es lo único que hace que dos transacciones coincidan en vuelo.
 */
describe('BP-21 · itinerarios concurrentes sin interbloqueo', () => {
  let ctx: SuiteContext;
  /** Cinco viajes con ids conocidos, para poder cruzar itinerarios en todas las formas. */
  let viajes: number[] = [];

  before(async () => {
    ctx = await prepareSuite();

    const existentes = await query<{ id: number }>('SELECT id FROM trips ORDER BY id ASC');
    viajes = existentes.map((row) => row.id);

    // Dos viajes más sobre el bus de la empresa A, para armar itinerarios disjuntos.
    for (const dias of [7, 9]) {
      const creado = await execute(
        `INSERT INTO trips (route_id, bus_id, departure_datetime, arrival_datetime, base_price, available_seats, status)
         VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), DATE_ADD(NOW(), INTERVAL ? DAY), 45.00, 12, 'SCHEDULED')`,
        [ctx.fixtures.routeA, ctx.fixtures.busA, dias, dias + 1],
      );
      viajes.push(creado.insertId);
    }
    assert.ok(viajes.length >= 5, `se esperaban al menos 5 viajes y hay ${viajes.length}`);
  });
  after(teardownSuite);

  beforeEach(async () => {
    await execute('DELETE FROM booking_seats');
    await execute('DELETE FROM financial_transactions');
    await execute('DELETE FROM payments');
    await execute('DELETE FROM bookings');
    await execute('DELETE FROM booking_groups');
    await execute('UPDATE trips SET available_seats = (SELECT capacity FROM buses WHERE id = trips.bus_id)');
  });

  /* ------------------------------------------------------------------ utilidades */

  /** Asiento libre número `n` del viaje. */
  async function asiento(viaje: number, n: number): Promise<number> {
    return at(await freeSeats(viaje), n).id;
  }

  /** Cuerpo de itinerario: los tramos van en el orden dado, que es el orden lógico. */
  async function itinerario(tramos: Array<{ viaje: number; n: number }>): Promise<Record<string, unknown>> {
    const segments = [];
    for (const tramo of tramos) {
      segments.push({ trip_id: tramo.viaje, seat_ids: [await asiento(tramo.viaje, tramo.n)] });
    }
    return {
      trip_type: segments.length === 2 ? 'ROUND_TRIP' : 'MULTI_CITY',
      segments,
      passenger_email: 'cliente@test.pe',
    };
  }

  const comprar = (cuerpo: Record<string, unknown>, token: string) =>
    post('/bookings/itineraries', cuerpo, token);

  /** Ninguna respuesta puede ser un fallo del servidor: un 409 es legítimo, un 500 no. */
  function sinFallosDeServidor(respuestas: Array<{ status: number; body: { message?: string } }>, contexto: string) {
    const rotas = respuestas.filter((r) => r.status >= 500);
    assert.equal(
      rotas.length,
      0,
      `${contexto}: ${rotas.length} respuestas 5xx (${rotas.map((r) => r.body.message ?? r.status).join(' | ')})`,
    );
  }

  /** Invariante de BP-19: ningún asiento con dos reservas activas. */
  async function sinAsientosDuplicados(): Promise<void> {
    const duplicados = await query(
      `SELECT bs.trip_id, bs.seat_id, COUNT(*) activas
       FROM booking_seats bs JOIN bookings bk ON bk.id = bs.booking_id
       WHERE bk.status IN ('CONFIRMED', 'COMPLETED')
          OR (bk.status = 'PENDING' AND (bk.expires_at IS NULL OR bk.expires_at > NOW()))
       GROUP BY bs.trip_id, bs.seat_id HAVING activas > 1`,
    );
    assert.deepEqual(duplicados, [], 'BP-21 no puede debilitar la protección de BP-19');
  }

  /* ══════════════════════════════ el camino normal ═══════════════════════════ */

  describe('Compras que ya funcionaban', () => {
    it('1 · una reserva simple de un solo viaje sigue funcionando', async () => {
      const res = await post(
        '/bookings',
        { trip_id: viajes[0]!, seat_ids: [await asiento(viajes[0]!, 0)], passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token,
      );

      assert.equal(res.status, 201);
      // Un itinerario de un solo tramo no existe por diseño: para eso está `POST /bookings`.
      const unTramo = await comprar(await itinerario([{ viaje: viajes[0]!, n: 1 }]), ctx.sessions.customer.token);
      assert.equal(unTramo.status, 422);
    });

    it('2 · un itinerario de dos tramos se crea completo', async () => {
      const res = await comprar(
        await itinerario([{ viaje: viajes[0]!, n: 0 }, { viaje: viajes[2]!, n: 1 }]),
        ctx.sessions.customer.token,
      );

      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.segments.length, 2);
      await sinAsientosDuplicados();
    });

    it('3 · un itinerario de tres tramos se crea completo', async () => {
      const res = await comprar(
        await itinerario([
          { viaje: viajes[0]!, n: 0 },
          { viaje: viajes[2]!, n: 1 },
          { viaje: viajes[3]!, n: 2 },
        ]),
        ctx.sessions.customer.token,
      );

      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.segments.length, 3);
    });
  });

  /* ══════════════════════════════ concurrencia real ══════════════════════════ */

  describe('Compras simultáneas de itinerarios', () => {
    it('4 · dos itinerarios idénticos a la vez: ninguno revienta', async () => {
      const a = await itinerario([{ viaje: viajes[0]!, n: 0 }, { viaje: viajes[2]!, n: 0 }]);
      const b = await itinerario([{ viaje: viajes[0]!, n: 1 }, { viaje: viajes[2]!, n: 1 }]);

      const res = await Promise.all([
        comprar(a, ctx.sessions.customer.token),
        comprar(b, ctx.sessions.companyAdmin.token),
      ]);

      sinFallosDeServidor(res, 'itinerarios idénticos');
      assert.deepEqual(res.map((r) => r.status), [201, 201]);
      await sinAsientosDuplicados();
    });

    it('5 · dos itinerarios con los tramos en orden INVERSO: ninguno revienta', async () => {
      // Este es el caso que producía el interbloqueo: A bloqueaba 1 y esperaba 3 mientras B
      // bloqueaba 3 y esperaba 1.
      const a = await itinerario([{ viaje: viajes[0]!, n: 0 }, { viaje: viajes[2]!, n: 0 }]);
      const b = await itinerario([{ viaje: viajes[2]!, n: 1 }, { viaje: viajes[0]!, n: 1 }]);

      const res = await Promise.all([
        comprar(a, ctx.sessions.customer.token),
        comprar(b, ctx.sessions.companyAdmin.token),
      ]);

      sinFallosDeServidor(res, 'itinerarios en orden inverso');
      assert.deepEqual(res.map((r) => r.status), [201, 201]);
      await sinAsientosDuplicados();
    });

    it('6 · diez itinerarios cruzados a la vez: ninguno revienta', async () => {
      const cuerpos: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 5; i += 1) {
        cuerpos.push(await itinerario([{ viaje: viajes[0]!, n: i }, { viaje: viajes[2]!, n: i }]));
        cuerpos.push(await itinerario([{ viaje: viajes[2]!, n: i + 5 }, { viaje: viajes[0]!, n: i + 5 }]));
      }

      const res = await Promise.all(
        cuerpos.map((cuerpo, i) =>
          comprar(cuerpo, i % 2 ? ctx.sessions.companyAdmin.token : ctx.sessions.customer.token),
        ),
      );

      sinFallosDeServidor(res, 'diez itinerarios cruzados');
      assert.equal(res.filter((r) => r.status === 201).length, 10);
      await sinAsientosDuplicados();
    });

    it('7 · itinerarios parcialmente superpuestos: ninguno revienta', async () => {
      // A usa 1→3, B usa 3→4: comparten solo el viaje 3.
      const a = await itinerario([{ viaje: viajes[0]!, n: 0 }, { viaje: viajes[2]!, n: 0 }]);
      const b = await itinerario([{ viaje: viajes[2]!, n: 1 }, { viaje: viajes[3]!, n: 0 }]);

      const res = await Promise.all([
        comprar(a, ctx.sessions.customer.token),
        comprar(b, ctx.sessions.companyAdmin.token),
      ]);

      sinFallosDeServidor(res, 'itinerarios superpuestos');
      assert.deepEqual(res.map((r) => r.status), [201, 201]);
    });

    it('8 · itinerarios sin ningún viaje en común funcionan a la vez', async () => {
      const a = await itinerario([{ viaje: viajes[0]!, n: 0 }, { viaje: viajes[2]!, n: 0 }]);
      const b = await itinerario([{ viaje: viajes[3]!, n: 0 }, { viaje: viajes[4]!, n: 0 }]);

      const res = await Promise.all([
        comprar(a, ctx.sessions.customer.token),
        comprar(b, ctx.sessions.companyAdmin.token),
      ]);

      sinFallosDeServidor(res, 'itinerarios disjuntos');
      assert.deepEqual(res.map((r) => r.status), [201, 201]);
    });

    it('9 · diez reservas simples a la vez: ninguna revienta', async () => {
      // Sin itinerarios de por medio. Diez es justo el tamaño del pool de conexiones, y con
      // él se destapó el segundo interbloqueo: una transacción que pedía otra conexión al
      // pool mientras sostenía la suya. Las diez esperaban una undécima que no existía.
      const libres = await freeSeats(viajes[0]!);
      const res = await Promise.all(
        libres.slice(0, 10).map((seat) =>
          post(
            '/bookings',
            { trip_id: viajes[0]!, seat_ids: [seat.id], passenger_email: 'cliente@test.pe' },
            ctx.sessions.customer.token,
          ),
        ),
      );

      sinFallosDeServidor(res, 'diez reservas simples');
      assert.equal(res.filter((r) => r.status === 201).length, 10);
    });

    it('10 · el mismo asiento pedido a la vez sigue serializándose (BP-19)', async () => {
      const compartido = await asiento(viajes[0]!, 0);
      const cuerpo = (otroAsiento: number) => ({
        trip_type: 'ROUND_TRIP',
        segments: [
          { trip_id: viajes[0]!, seat_ids: [compartido] },
          { trip_id: viajes[2]!, seat_ids: [otroAsiento] },
        ],
        passenger_email: 'cliente@test.pe',
      });

      const res = await Promise.all([
        comprar(cuerpo(await asiento(viajes[2]!, 0)), ctx.sessions.customer.token),
        comprar(cuerpo(await asiento(viajes[2]!, 1)), ctx.sessions.companyAdmin.token),
      ]);

      sinFallosDeServidor(res, 'mismo asiento simultáneo');
      assert.equal(res.filter((r) => r.status === 201).length, 1, 'solo una compra puede llevarse el asiento');
      assert.equal(res.filter((r) => r.status === 409).length, 1);
      await sinAsientosDuplicados();
    });

    it('11 · pagar dos itinerarios cruzados a la vez tampoco revienta', async () => {
      const a = await comprar(
        await itinerario([{ viaje: viajes[0]!, n: 0 }, { viaje: viajes[2]!, n: 0 }]),
        ctx.sessions.customer.token,
      );
      const b = await comprar(
        await itinerario([{ viaje: viajes[2]!, n: 1 }, { viaje: viajes[0]!, n: 1 }]),
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(a.status, 201);
      assert.equal(b.status, 201);

      const res = await Promise.all([
        post(`/bookings/itineraries/${a.body.data.group_id}/pay`, { method: 'CASH' }, ctx.sessions.customer.token),
        post(`/bookings/itineraries/${b.body.data.group_id}/pay`, { method: 'CASH' }, ctx.sessions.companyAdmin.token),
      ]);

      sinFallosDeServidor(res, 'pagos cruzados');
      assert.deepEqual(res.map((r) => r.status), [200, 200]);
      await sinAsientosDuplicados();
    });
  });

  /* ══════════════════════════════ atomicidad ═════════════════════════════════ */

  describe('Un itinerario que falla no deja nada a medias', () => {
    it('12 · si el segundo tramo choca, se deshace también el primero', async () => {
      const ocupado = await asiento(viajes[2]!, 0);
      const bloqueo = await post(
        '/bookings',
        { trip_id: viajes[2]!, seat_ids: [ocupado], passenger_email: 'cliente@test.pe' },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(bloqueo.status, 201);

      const asientoIda = await asiento(viajes[0]!, 0);
      const res = await comprar(
        {
          trip_type: 'ROUND_TRIP',
          segments: [
            { trip_id: viajes[0]!, seat_ids: [asientoIda] },
            { trip_id: viajes[2]!, seat_ids: [ocupado] },
          ],
          passenger_email: 'cliente@test.pe',
        },
        ctx.sessions.customer.token,
      );

      assert.equal(res.status, 409);

      const grupos = await query('SELECT id FROM booking_groups');
      assert.equal(grupos.length, 0, 'no puede quedar un booking_group huérfano');

      const reservas = await query("SELECT id FROM bookings WHERE trip_id = ?", [viajes[0]!]);
      assert.equal(reservas.length, 0, 'el tramo de ida no debe existir');

      const asientos = await query('SELECT id FROM booking_seats WHERE trip_id = ? AND seat_id = ?', [
        viajes[0]!,
        asientoIda,
      ]);
      assert.equal(asientos.length, 0, 'el asiento de ida debe quedar libre');
    });

    it('13 · no quedan booking_seats sin su reserva', async () => {
      await comprar(
        await itinerario([{ viaje: viajes[0]!, n: 0 }, { viaje: viajes[2]!, n: 0 }]),
        ctx.sessions.customer.token,
      );

      const huerfanos = await query(
        'SELECT bs.id FROM booking_seats bs LEFT JOIN bookings bk ON bk.id = bs.booking_id WHERE bk.id IS NULL',
      );
      assert.deepEqual(huerfanos, []);
    });

    it('14 · available_seats nunca queda por debajo de cero', async () => {
      const cuerpos: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 6; i += 1) {
        cuerpos.push(await itinerario([{ viaje: viajes[0]!, n: i }, { viaje: viajes[2]!, n: i }]));
      }
      await Promise.all(cuerpos.map((cuerpo) => comprar(cuerpo, ctx.sessions.customer.token)));

      const negativos = await query('SELECT id, available_seats FROM trips WHERE available_seats < 0');
      assert.deepEqual(negativos, [], 'la caché de cupos no puede quedar negativa');
    });
  });

  /* ══════════════════════════════ orden lógico ═══════════════════════════════ */

  describe('El orden del itinerario es el del usuario, no el de los cerrojos', () => {
    it('15 · con los viajes al revés, segment_order sigue el orden pedido', async () => {
      // El primer tramo tiene el id MAYOR: los cerrojos se toman al revés que los tramos.
      const mayor = viajes[2]!;
      const menor = viajes[0]!;
      assert.ok(mayor > menor, 'el caso exige que el primer tramo tenga el id mayor');

      const res = await comprar(
        await itinerario([{ viaje: mayor, n: 0 }, { viaje: menor, n: 0 }]),
        ctx.sessions.customer.token,
      );
      assert.equal(res.status, 201);

      const guardado = await query<{ segment_order: number; trip_id: number }>(
        'SELECT segment_order, trip_id FROM bookings WHERE group_id = ? ORDER BY segment_order ASC',
        [res.body.data.group_id],
      );
      assert.equal(Number(guardado[0]!.segment_order), 1);
      assert.equal(Number(guardado[0]!.trip_id), mayor, 'el tramo 1 es el que pidió el usuario');
      assert.equal(Number(guardado[1]!.trip_id), menor);
    });

    it('16 · la respuesta y la consulta posterior conservan ese mismo orden', async () => {
      const mayor = viajes[2]!;
      const menor = viajes[0]!;
      const res = await comprar(
        await itinerario([{ viaje: mayor, n: 0 }, { viaje: menor, n: 0 }]),
        ctx.sessions.customer.token,
      );

      assert.deepEqual(
        (res.body.data.segments as Array<{ segment_order: number; trip_id: number }>).map((s) => s.trip_id),
        [mayor, menor],
      );

      const consulta = await get(`/bookings/itineraries/${res.body.data.group_id}`, ctx.sessions.customer.token);
      assert.equal(consulta.status, 200);
      assert.deepEqual(
        (consulta.body.data.segments as Array<{ trip_id: number }>).map((s) => Number(s.trip_id)),
        [mayor, menor],
      );
    });

    it('17 · el total del grupo es la suma de sus tramos, en cualquier orden', async () => {
      const res = await comprar(
        await itinerario([{ viaje: viajes[2]!, n: 0 }, { viaje: viajes[0]!, n: 0 }]),
        ctx.sessions.customer.token,
      );

      assert.equal(res.status, 201, JSON.stringify(res.body));
      const suma = (res.body.data.segments as Array<{ total_amount: number }>).reduce(
        (acc, s) => acc + Number(s.total_amount),
        0,
      );
      const declarado = Number(res.body.data.total_amount);
      assert.equal(declarado, Number(suma.toFixed(2)));

      const guardado = await queryOne<{ total: string }>(
        'SELECT SUM(total_amount) AS total FROM bookings WHERE group_id = ?',
        [res.body.data.group_id],
      );
      assert.equal(Number(guardado?.total), declarado);
    });
  });
});
