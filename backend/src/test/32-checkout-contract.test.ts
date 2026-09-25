import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, after } from 'node:test';
import { get, post } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * Contrato del que depende el checkout para reutilizar una reserva pendiente.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO. El pago crea la reserva ANTES de abrir la pasarela, porque es
 * la reserva la que retiene el asiento. Si el cobro no se completa, esa reserva sigue viva
 * 15 minutos; al reintentar, el navegador debe **reutilizarla** en vez de crear otra, o
 * chocará contra su propio asiento con un 409.
 *
 * Para decidirlo, el frontend lee `GET /bookings/:id` y mira cuatro cosas: `status`,
 * `expires_at`, `trip_id` y `seat_numbers`. Si alguna desapareciera de la proyección, la
 * reutilización dejaría de funcionar **en silencio** y volvería el error original. Eso es lo
 * que se fija aquí.
 *
 * El frontend no tiene infraestructura de pruebas —no hay vitest ni testing-library en el
 * proyecto—, así que su lógica no se puede probar directamente. Lo que sí se puede probar, y
 * es donde de verdad se rompería, es el contrato del backend.
 */
describe('Contrato del checkout para reintentar un pago', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  beforeEach(async () => {
    await execute('DELETE FROM financial_transactions');
    // Desde H-50 cancelar una reserva pagada abre su reembolso: va antes que los pagos que referencia.
    await execute('DELETE FROM refunds');
    await execute('DELETE FROM payments');
    await execute('DELETE FROM booking_seats');
    await execute('DELETE FROM bookings');
    await execute('UPDATE trips SET available_seats = (SELECT capacity FROM buses WHERE id = trips.bus_id)');
  });

  /** Reserva de un asiento del viaje A, como la que crea el checkout. */
  async function reservar(token = ctx.sessions.customer.token) {
    const asiento = at(await freeSeats(ctx.fixtures.tripA), 0);
    const res = await post(
      '/bookings',
      { trip_id: ctx.fixtures.tripA, seat_ids: [asiento.id], passenger_email: 'cliente@test.pe' },
      token,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { booking: res.body.data, asiento };
  }

  describe('Lo que el navegador necesita leer de una reserva', () => {
    it('1 · `GET /bookings/:id` trae estado, vigencia, viaje y asientos', async () => {
      const { booking, asiento } = await reservar();

      const res = await get(`/bookings/${booking.id}`, ctx.sessions.customer.token);

      assert.equal(res.status, 200);
      // Los cuatro campos de los que depende `reservaReutilizable()` en PaymentPage.
      assert.equal(res.body.data.status, 'PENDING');
      assert.ok(res.body.data.expires_at, 'sin `expires_at` no se puede saber si sigue vigente');
      assert.equal(Number(res.body.data.trip_id), ctx.fixtures.tripA);
      assert.equal(String(res.body.data.seat_numbers), asiento.seat_number);
    });

    it('2 · `seat_numbers` llega separado por comas y en orden', async () => {
      const libres = await freeSeats(ctx.fixtures.tripA);
      const res = await post(
        '/bookings',
        {
          trip_id: ctx.fixtures.tripA,
          seat_ids: [at(libres, 1).id, at(libres, 0).id],
          passenger_email: 'cliente@test.pe',
        },
        ctx.sessions.customer.token,
      );

      const detalle = await get(`/bookings/${res.body.data.id}`, ctx.sessions.customer.token);

      assert.equal(String(detalle.body.data.seat_numbers), `${at(libres, 0).seat_number}, ${at(libres, 1).seat_number}`);
    });

    it('3 · una reserva ajena responde 404: la propiedad la comprueba el backend', async () => {
      const { booking } = await reservar(ctx.sessions.companyAdmin.token);

      const res = await get(`/bookings/${booking.id}`, ctx.sessions.customer.token);

      assert.equal(res.status, 404, 'el frontend confía en este 404 para descartar la reserva');
    });

    it('4 · una reserva inexistente también responde 404', async () => {
      assert.equal((await get('/bookings/999999', ctx.sessions.customer.token)).status, 404);
    });
  });

  describe('Estados que impiden reutilizar', () => {
    it('5 · una reserva caducada se distingue por su `expires_at` y su estado', async () => {
      const { booking } = await reservar();
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [booking.id]);

      const res = await get(`/bookings/${booking.id}`, ctx.sessions.customer.token);

      // Todavía PENDING —el barrido no ha pasado— pero con el plazo cumplido: el navegador
      // lo detecta por la fecha y crea una reserva nueva en vez de intentar pagar esta.
      assert.equal(res.body.data.status, 'PENDING');
      assert.ok(new Date(String(res.body.data.expires_at).replace(' ', 'T')).getTime() < Date.now());
    });

    it('6 · una reserva cancelada se ve como CANCELLED', async () => {
      const { booking } = await reservar();
      await post(`/bookings/${booking.id}/cancel`, {}, ctx.sessions.customer.token);

      const res = await get(`/bookings/${booking.id}`, ctx.sessions.customer.token);
      assert.equal(res.body.data.status, 'CANCELLED');
    });

    it('7 · una reserva ya pagada se ve como CONFIRMED', async () => {
      const { booking } = await reservar();
      await post(`/bookings/${booking.id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);

      const res = await get(`/bookings/${booking.id}`, ctx.sessions.customer.token);
      assert.equal(res.body.data.status, 'CONFIRMED');
    });
  });

  describe('Lo que ocurría antes de la corrección', () => {
    it('8 · reservar dos veces el mismo asiento devuelve 409 con un mensaje legible', async () => {
      const { asiento } = await reservar();

      const segunda = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [asiento.id], passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token,
      );

      assert.equal(segunda.status, 409);
      // El navegador muestra este texto tal cual; tiene que nombrar el asiento.
      assert.match(String(segunda.body.message), /ya fueron tomados/i);
      assert.ok(String(segunda.body.message).includes(asiento.seat_number));
    });

    it('9 · reutilizar la reserva no crea una segunda: sigue habiendo una sola', async () => {
      const { booking } = await reservar();

      // Esto es lo que hace ahora el checkout al reintentar: pagar la MISMA reserva.
      const pago = await post(`/bookings/${booking.id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);

      assert.equal(pago.status, 200);
      const reservas = await query('SELECT id FROM bookings WHERE trip_id = ?', [ctx.fixtures.tripA]);
      assert.equal(reservas.length, 1, 'un reintento no puede dejar dos reservas del mismo viaje');
    });

    it('10 · un asiento nunca queda duplicado entre reservas activas', async () => {
      const { asiento } = await reservar();
      await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [asiento.id], passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token,
      );

      const duplicados = await query(
        `SELECT bs.trip_id, bs.seat_id, COUNT(*) activas
         FROM booking_seats bs JOIN bookings bk ON bk.id = bs.booking_id
         WHERE bk.status IN ('CONFIRMED','COMPLETED')
            OR (bk.status = 'PENDING' AND (bk.expires_at IS NULL OR bk.expires_at > NOW()))
         GROUP BY bs.trip_id, bs.seat_id HAVING activas > 1`,
      );
      assert.deepEqual(duplicados, []);
    });
  });

  describe('El importe que ve el pasajero', () => {
    it('11 · un asiento de S/ 45.00 con comisión de S/ 2.50 suma S/ 47.50', async () => {
      const precio = await queryOne<{ base_price: string }>('SELECT base_price FROM trips WHERE id = ?', [
        ctx.fixtures.tripA,
      ]);
      assert.equal(Number(precio?.base_price), 45);

      const { booking } = await reservar();

      assert.equal(Number(booking.subtotal), 45);
      assert.equal(Number(booking.service_fee), 2.5);
      assert.equal(Number(booking.total_amount), 47.5, 'es el importe que el navegador muestra y que se cobra');
    });

    it('12 · con dos asientos la comisión se aplica por pasajero', async () => {
      const libres = await freeSeats(ctx.fixtures.tripA);
      const res = await post(
        '/bookings',
        {
          trip_id: ctx.fixtures.tripA,
          seat_ids: [at(libres, 0).id, at(libres, 1).id],
          passenger_email: 'cliente@test.pe',
        },
        ctx.sessions.customer.token,
      );

      assert.equal(Number(res.body.data.passenger_count), 2);
      assert.equal(Number(res.body.data.total_amount), 95, '45×2 + 2.50×2');
    });
  });
});
