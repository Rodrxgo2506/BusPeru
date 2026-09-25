import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execute, query, queryOne } from '../config/database';
import { get, post } from './helpers/api';
import { at, freeSeats } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * Atomicidad del pago de un itinerario.
 *
 * Modelo acordado: **un pago por tramo**, agrupados conceptualmente por `booking_groups`.
 * No existe un pago a nivel de grupo; lo que sí es atómico es la CONFIRMACIÓN: los N
 * tramos se confirman dentro de una única transacción y un fallo revierte todos.
 */
describe('Pago del itinerario: atomicidad', () => {
  let ctx: SuiteContext;
  let tripVuelta: number;
  let tripTercero: number;

  before(async () => {
    ctx = await prepareSuite();

    const base = await queryOne<{ bus_id: number; route_id: number }>(
      'SELECT bus_id, route_id FROM trips WHERE id = ?', [ctx.fixtures.tripA],
    );
    const vuelta = await execute(
      `INSERT INTO trips (route_id, bus_id, departure_datetime, base_price, available_seats, status)
       SELECT ?, ?, DATE_ADD(departure_datetime, INTERVAL 2 DAY), base_price, available_seats, 'SCHEDULED'
       FROM trips WHERE id = ?`,
      [base!.route_id, base!.bus_id, ctx.fixtures.tripA],
    );
    tripVuelta = vuelta.insertId;

    const tercero = await execute(
      `INSERT INTO trips (route_id, bus_id, departure_datetime, base_price, available_seats, status)
       SELECT ?, ?, DATE_ADD(departure_datetime, INTERVAL 4 DAY), base_price, available_seats, 'SCHEDULED'
       FROM trips WHERE id = ?`,
      [base!.route_id, base!.bus_id, ctx.fixtures.tripA],
    );
    tripTercero = tercero.insertId;
  });
  after(teardownSuite);

  beforeEach(async () => {
    // De dentro hacia fuera: lo que referencia a `payments` y a `bookings` va primero.
    await execute('DELETE FROM settlement_items');
    await execute('DELETE FROM financial_transactions');
    await execute('DELETE FROM refunds');
    await execute('DELETE FROM coupon_usages');
    await execute('DELETE FROM booking_seats');
    await execute('DELETE FROM payments');
    await execute('DELETE FROM notifications');
    await execute('DELETE FROM bookings');
    await execute('DELETE FROM booking_groups');
    await execute('UPDATE trips t JOIN buses b ON b.id = t.bus_id SET t.available_seats = b.capacity');
  });

  /** Crea un itinerario con los viajes indicados, un asiento por tramo. */
  async function crearItinerario(trips: number[]): Promise<Record<string, any>> {
    const segments: Array<{ trip_id: number; seat_ids: number[] }> = [];
    for (const [index, tripId] of trips.entries()) {
      const seats = await freeSeats(tripId);
      segments.push({ trip_id: tripId, seat_ids: [at(seats, index).id] });
    }

    const res = await post('/bookings/itineraries', {
      trip_type: trips.length === 2 ? 'ROUND_TRIP' : 'MULTI_CITY',
      segments,
      passenger_email: 'cliente@test.pe',
      payment_method: 'YAPE',
    }, ctx.sessions.customer.token);

    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  }

  /** Estado actual de todas las reservas del grupo, en orden. */
  async function estados(groupId: number) {
    return query<{ id: number; status: string; confirmed_at: string | null }>(
      'SELECT id, status, confirmed_at FROM bookings WHERE group_id = ? ORDER BY segment_order', [groupId],
    );
  }

  describe('Confirmación completa', () => {
    it('un itinerario de 2 tramos confirma ambos', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta]);
      const res = await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);

      assert.equal(res.status, 200);
      assert.ok(res.body.data.segments.every((s: { status: string }) => s.status === 'CONFIRMED'));
      assert.ok((await estados(grupo.group_id)).every((b) => b.status === 'CONFIRMED'));
    });

    it('un itinerario de 3 tramos confirma los tres', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta, tripTercero]);
      const res = await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);

      assert.equal(res.status, 200);
      const reservas = await estados(grupo.group_id);
      assert.equal(reservas.length, 3);
      assert.ok(reservas.every((b) => b.status === 'CONFIRMED' && b.confirmed_at !== null));
    });

    it('crea exactamente un pago por tramo, no uno por grupo', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta, tripTercero]);
      await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);

      const pagos = await query<{ booking_id: number; amount: number; status: string }>(
        'SELECT booking_id, amount, status FROM payments ORDER BY id',
      );
      assert.equal(pagos.length, 3, 'un pago por tramo');
      assert.ok(pagos.every((p) => p.status === 'PAID'));

      const reservas = await estados(grupo.group_id);
      assert.deepEqual(
        pagos.map((p) => Number(p.booking_id)).sort(),
        reservas.map((b) => Number(b.id)).sort(),
        'cada pago apunta a la reserva de su tramo',
      );
    });

    it('registra los movimientos financieros de cada tramo', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta]);
      await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);

      const movimientos = await query<{ type: string; booking_id: number; company_id: number }>(
        'SELECT type, booking_id, company_id FROM financial_transactions WHERE company_id IS NOT NULL ORDER BY id',
      );
      const pagos = movimientos.filter((m) => m.type === 'PAYMENT');
      assert.equal(pagos.length, 2, 'un movimiento PAYMENT por tramo');
      assert.ok(movimientos.some((m) => m.type === 'COMMISSION'));
    });
  });

  describe('Rollback ante un tramo que falla', () => {
    /** Cancela una reserva por SQL: al confirmar, ese tramo lanzará y hará fallar el pago. */
    async function sabotear(groupId: number, segmentOrder: number): Promise<void> {
      await execute(
        "UPDATE bookings SET status = 'CANCELLED' WHERE group_id = ? AND segment_order = ?",
        [groupId, segmentOrder],
      );
    }

    it('si falla el segundo tramo, el primero no queda pagado', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta]);
      await sabotear(grupo.group_id, 2);

      const res = await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);
      assert.equal(res.status, 400, JSON.stringify(res.body));

      const reservas = await estados(grupo.group_id);
      assert.equal(reservas[0]!.status, 'PENDING', 'el primer tramo vuelve a su estado anterior');
      assert.equal(reservas[0]!.confirmed_at, null);
      assert.equal(reservas[1]!.status, 'CANCELLED', 'el saboteado se queda como estaba');
    });

    it('si falla el tercer tramo, los dos primeros se revierten', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta, tripTercero]);
      await sabotear(grupo.group_id, 3);

      const res = await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);
      assert.equal(res.status, 400);

      const reservas = await estados(grupo.group_id);
      assert.equal(reservas[0]!.status, 'PENDING');
      assert.equal(reservas[1]!.status, 'PENDING');
      assert.ok(reservas.slice(0, 2).every((b) => b.confirmed_at === null));
    });

    it('no queda ningún pago confirmado a medias', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta, tripTercero]);
      await sabotear(grupo.group_id, 3);
      await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);

      const pagados = await query("SELECT id FROM payments WHERE status = 'PAID'");
      assert.equal(pagados.length, 0, 'ningún pago quedó en PAID');

      const pendientes = await query("SELECT id FROM payments WHERE status = 'PENDING'");
      assert.equal(pendientes.length, 3, 'los pagos siguen pendientes, como antes de intentar');
    });

    it('no queda ningún movimiento financiero a medias', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta, tripTercero]);
      await sabotear(grupo.group_id, 3);
      await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);

      assert.equal((await query('SELECT id FROM financial_transactions')).length, 0);
    });

    it('no se emite ninguna notificación de pago del tramo revertido', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta]);
      await sabotear(grupo.group_id, 2);
      await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);

      const avisos = await query(
        "SELECT id FROM notifications WHERE JSON_UNQUOTE(JSON_EXTRACT(data,'$.event')) = 'booking.payment_confirmed'",
      );
      assert.equal(avisos.length, 0);
    });

    it('el grupo y sus reservas siguen existiendo tras el rollback', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta]);
      await sabotear(grupo.group_id, 2);
      await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);

      assert.equal((await query('SELECT id FROM booking_groups WHERE id = ?', [grupo.group_id])).length, 1);
      assert.equal((await estados(grupo.group_id)).length, 2, 'no se pierde ninguna reserva');
    });

    it('tras corregir el problema, el pago vuelve a funcionar', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta]);
      await sabotear(grupo.group_id, 2);
      assert.equal((await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token)).status, 400);

      // Se restaura el tramo saboteado y se reintenta.
      await execute("UPDATE bookings SET status = 'PENDING' WHERE group_id = ? AND segment_order = 2", [grupo.group_id]);
      const segundo = await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);

      assert.equal(segundo.status, 200);
      assert.ok((await estados(grupo.group_id)).every((b) => b.status === 'CONFIRMED'));
      assert.equal((await query("SELECT id FROM payments WHERE status = 'PAID'")).length, 2);
    });
  });

  describe('Idempotencia', () => {
    it('pagar dos veces el mismo itinerario no duplica pagos', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta]);
      await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);
      const segundo = await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);

      assert.equal(segundo.status, 200, 'reintentar no es un error');
      assert.equal((await query('SELECT id FROM payments')).length, 2, 'siguen siendo dos pagos');
      assert.equal((await query("SELECT id FROM payments WHERE status = 'PAID'")).length, 2);
    });

    it('pagar dos veces no duplica movimientos financieros', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta]);
      await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);
      const antes = (await query('SELECT id FROM financial_transactions')).length;

      await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);
      assert.equal((await query('SELECT id FROM financial_transactions')).length, antes);
    });

    it('pagar dos veces no duplica la notificación de pago', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta]);
      await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);
      await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);

      const avisos = await query(
        "SELECT id FROM notifications WHERE JSON_UNQUOTE(JSON_EXTRACT(data,'$.event')) = 'booking.payment_confirmed'",
      );
      assert.equal(avisos.length, 2, 'uno por tramo, sin duplicados');
    });

    it('reutiliza el pago PENDING en vez de crear otro', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta]);
      const pendientesAntes = await query<{ id: number }>("SELECT id FROM payments WHERE status = 'PENDING' ORDER BY id");
      assert.equal(pendientesAntes.length, 2);

      await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);

      const pagados = await query<{ id: number }>("SELECT id FROM payments WHERE status = 'PAID' ORDER BY id");
      assert.deepEqual(
        pagados.map((p) => Number(p.id)),
        pendientesAntes.map((p) => Number(p.id)),
        'son las mismas filas, no filas nuevas',
      );
    });

    /**
     * CAMBIO DE CONTRATO, no una prueba debilitada.
     *
     * Antes este caso daba por buena una regla insegura: el cliente enviaba
     * `provider_transaction_id` y el backend lo guardaba como prueba de cobro, de modo que
     * cualquiera podia confirmar tres tramos inventandose un identificador. Con la
     * integracion de Culqi ese campo dejo de aceptarse del cliente; el identificador lo
     * devuelve la pasarela al backend. Lo que se comprueba ahora es justo lo contrario.
     *
     * Va con YAPE y no con CARD: desde H-23 la tarjeta se rechaza en itinerarios (test 51).
     */
    it('ya no acepta un provider_transaction_id enviado por el cliente', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta, tripTercero]);
      const res = await post(
        `/bookings/itineraries/${grupo.group_id}/pay`,
        { method: 'YAPE', provider_transaction_id: 'chg_inventado_por_el_cliente' },
        ctx.sessions.admin.token,
      );

      assert.equal(res.status, 200);
      const pagos = await query<{ provider_transaction_id: string | null }>(
        'SELECT provider_transaction_id FROM payments',
      );
      assert.equal(pagos.length, 3);
      assert.ok(
        pagos.every((p) => p.provider_transaction_id === null),
        'un identificador que llega del navegador no puede quedar registrado como cobro',
      );
    });
  });

  describe('Compatibilidad con lo existente', () => {
    it('un itinerario de un solo tramo no existe: el mínimo son dos', async () => {
      const seats = await freeSeats(ctx.fixtures.tripA);
      const res = await post('/bookings/itineraries', {
        trip_type: 'ROUND_TRIP',
        segments: [{ trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id] }],
        passenger_email: 'cliente@test.pe',
      }, ctx.sessions.customer.token);
      assert.equal(res.status, 422);
    });

    it('el pago de una reserva de IDA sigue funcionando igual', async () => {
      const seats = await freeSeats(ctx.fixtures.tripA);
      const reserva = await post('/bookings', {
        trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id], passenger_email: 'cliente@test.pe', payment_method: 'YAPE',
      }, ctx.sessions.customer.token);

      const pago = await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);
      assert.equal(pago.status, 200);
      assert.equal(pago.body.data.status, 'CONFIRMED');

      const pagos = await query("SELECT id FROM payments WHERE status = 'PAID'");
      assert.equal(pagos.length, 1);
      assert.equal((await query('SELECT id FROM booking_groups')).length, 0, 'la ida no crea grupo');
    });

    it('el reembolso de un tramo funciona contra su propio pago', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta]);
      await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);

      const reservas = await estados(grupo.group_id);
      const vuelta = reservas[1]!;
      await post(`/bookings/${vuelta.id}/cancel`, { reason: 'prueba', request_refund: true }, ctx.sessions.customer.token);

      const reembolsos = await query<{ booking_id: number; payment_id: number; amount: number }>(
        'SELECT booking_id, payment_id, amount FROM refunds',
      );
      assert.equal(reembolsos.length, 1, 'solo se reembolsa el tramo cancelado');
      assert.equal(Number(reembolsos[0]!.booking_id), Number(vuelta.id));

      const pagoDelTramo = await queryOne<{ id: number }>('SELECT id FROM payments WHERE booking_id = ?', [vuelta.id]);
      assert.equal(Number(reembolsos[0]!.payment_id), Number(pagoDelTramo?.id), 'contra el pago de ese tramo');

      const otro = await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [reservas[0]!.id]);
      assert.equal(otro?.status, 'CONFIRMED', 'el otro tramo sigue vigente');
    });

    it('cada pago se atribuye a la empresa de su propio tramo', async () => {
      // Tramos de empresas distintas: A y B.
      const seatsA = await freeSeats(ctx.fixtures.tripA);
      const seatsB = await freeSeats(ctx.fixtures.tripB);
      const creado = await post('/bookings/itineraries', {
        trip_type: 'ROUND_TRIP',
        segments: [
          { trip_id: ctx.fixtures.tripA, seat_ids: [at(seatsA, 0).id] },
          { trip_id: ctx.fixtures.tripB, seat_ids: [at(seatsB, 0).id] },
        ],
        passenger_email: 'cliente@test.pe',
        payment_method: 'YAPE',
      }, ctx.sessions.customer.token);
      assert.equal(creado.status, 201);

      const res = await post(`/bookings/itineraries/${creado.body.data.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);
      assert.equal(res.status, 200);

      const movimientos = await query<{ company_id: number; type: string }>(
        "SELECT company_id, type FROM financial_transactions WHERE type = 'PAYMENT' AND company_id IS NOT NULL",
      );
      const empresas = new Set(movimientos.map((m) => Number(m.company_id)));
      assert.equal(empresas.size, 2, 'cada empresa recibe su propio movimiento');
      assert.ok(empresas.has(ctx.fixtures.companyA) && empresas.has(ctx.fixtures.companyB));

      // Cada empresa solo ve su pago en su portal.
      const pagosA = await get('/payments?limit=50', ctx.sessions.companyAdmin.token);
      const pagosB = await get('/payments?limit=50', ctx.sessions.companyAdminB.token);
      assert.equal(pagosA.body.data.length, 1, 'la empresa A ve un solo pago');
      assert.equal(pagosB.body.data.length, 1, 'la empresa B ve el suyo');
      assert.notEqual(Number(pagosA.body.data[0].id), Number(pagosB.body.data[0].id));
    });
  });

  describe('Seguridad', () => {
    it('no se puede pagar el itinerario de otro usuario', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta]);
      const res = await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' }, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 404, '404 y no 403: no se confirma que exista');
      assert.ok((await estados(grupo.group_id)).every((b) => b.status === 'PENDING'), 'nada cambió');
    });

    it('sin sesión no se puede pagar', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta]);
      assert.equal((await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'YAPE' })).status, 401);
    });

    it('un group_id inexistente o no numérico devuelve 404', async () => {
      assert.equal((await post('/bookings/itineraries/999999/pay', { method: 'YAPE' }, ctx.sessions.customer.token)).status, 404);
      assert.equal((await post('/bookings/itineraries/abc/pay', { method: 'YAPE' }, ctx.sessions.customer.token)).status, 404);
    });

    it('un método de pago inválido se rechaza antes de tocar nada', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta]);
      const res = await post(`/bookings/itineraries/${grupo.group_id}/pay`, { method: 'BITCOIN' }, ctx.sessions.customer.token);

      assert.equal(res.status, 422);
      assert.ok((await estados(grupo.group_id)).every((b) => b.status === 'PENDING'));
    });

    it('un provider_transaction_id malicioso del cliente se descarta sin efecto', async () => {
      const grupo = await crearItinerario([ctx.fixtures.tripA, tripVuelta]);
      const res = await post(
        `/bookings/itineraries/${grupo.group_id}/pay`,
        // YAPE: desde H-23 CARD se rechaza antes de llegar a leer el cuerpo (test 51).
        { method: 'YAPE', provider_transaction_id: "x'; DROP TABLE payments; --" },
        ctx.sessions.admin.token,
      );

      assert.ok([200, 422].includes(res.status), `HTTP ${res.status}`);
      assert.ok(Array.isArray(await query('SELECT id FROM payments')), 'la tabla sigue existiendo');
    });
  });
});
