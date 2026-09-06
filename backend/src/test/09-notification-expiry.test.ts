import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { get, post } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { freeSeats, at } from './helpers/fixtures';
import { ensureSystemTemplates } from '../services/notification.service';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/** Notificaciones de un usuario para un evento concreto. */
async function notificaciones(userId: number, evento: string) {
  return query<{ id: number; title: string; message: string; template_id: number | null }>(
    `SELECT id, title, message, template_id FROM notifications
     WHERE user_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.event')) = ?`,
    [userId, evento],
  );
}

async function notificacionesDe(userId: number, eventKey: string) {
  return query<{ id: number }>(
    `SELECT id FROM notifications WHERE user_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.event_key')) = ?`,
    [userId, eventKey],
  );
}

describe('Notificaciones automáticas y expiración de reservas', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
    await ensureSystemTemplates();
  });
  after(teardownSuite);

  it('crea las plantillas del sistema sin duplicarlas', async () => {
    const antes = await query('SELECT id FROM notification_templates');
    await ensureSystemTemplates();
    const despues = await query('SELECT id FROM notification_templates');
    assert.equal(antes.length, despues.length, 'ejecutarlo de nuevo no debe duplicar plantillas');

    const nombres = (await query<{ name: string }>('SELECT name FROM notification_templates')).map((t) => t.name);
    for (const esperado of ['booking.created', 'booking.payment_confirmed', 'booking.cancelled', 'booking.expired', 'refund.completed']) {
      assert.ok(nombres.includes(esperado), `falta la plantilla ${esperado}`);
    }
  });

  it('notifica al crear la reserva usando la plantilla real', async () => {
    const seats = await freeSeats(ctx.fixtures.tripA);
    const reserva = await post('/bookings', {
      trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id], passenger_email: 'cliente@test.pe',
    }, ctx.sessions.customer.token);

    const avisos = await notificacionesDe(ctx.sessions.customer.user.id, `booking.created:${reserva.body.data.id}`);
    assert.equal(avisos.length, 1);

    const detalle = at(await notificaciones(ctx.sessions.customer.user.id, 'booking.created'), 0);
    assert.ok(detalle.template_id, 'debe enlazar la plantilla');
    assert.ok(detalle.title.includes(reserva.body.data.booking_code), 'el título renderiza el código');
    assert.equal(/\{\{|\}\}/.test(detalle.message), false, 'no deben quedar variables sin resolver');
    assert.ok(detalle.message.includes('Lima'), 'debe incluir datos reales del viaje');
  });

  it('notifica el pago confirmado y no duplica al pagar varias veces', async () => {
    const seats = await freeSeats(ctx.fixtures.tripA);
    const reserva = await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id], passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token);
    const id = reserva.body.data.id;

    await post(`/bookings/${id}/pay`, { method: 'YAPE' }, ctx.sessions.customer.token);
    await post(`/bookings/${id}/pay`, { method: 'YAPE' }, ctx.sessions.customer.token);
    await post(`/bookings/${id}/pay`, { method: 'YAPE' }, ctx.sessions.customer.token);

    const avisos = await notificacionesDe(ctx.sessions.customer.user.id, `booking.payment_confirmed:${id}`);
    assert.equal(avisos.length, 1, 'pagar tres veces genera una sola notificación');
  });

  it('notifica la cancelación una única vez', async () => {
    const seats = await freeSeats(ctx.fixtures.tripA);
    const reserva = await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id], passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token);
    const id = reserva.body.data.id;

    await post(`/bookings/${id}/cancel`, { reason: 'prueba' }, ctx.sessions.customer.token);
    await post(`/bookings/${id}/cancel`, {}, ctx.sessions.customer.token);

    assert.equal((await notificacionesDe(ctx.sessions.customer.user.id, `booking.cancelled:${id}`)).length, 1);
  });

  it('notifica el reembolso completado una única vez', async () => {
    const seats = await freeSeats(ctx.fixtures.tripA);
    const reserva = await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id], passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token);
    await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'CARD' }, ctx.sessions.customer.token);
    await post(`/bookings/${reserva.body.data.id}/cancel`, { request_refund: true }, ctx.sessions.customer.token);

    const refund = (await get('/refunds?limit=50', ctx.sessions.admin.token)).body.data
      .find((r: { booking_id: number }) => r.booking_id === reserva.body.data.id);

    await post(`/refunds/${refund.id}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token);
    await post(`/refunds/${refund.id}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token);

    const avisos = await notificacionesDe(ctx.sessions.customer.user.id, `refund.completed:${refund.id}`);
    assert.equal(avisos.length, 1);
  });

  it('la bandeja del cliente recibe las notificaciones por la API', async () => {
    const bandeja = await get('/notifications?limit=50', ctx.sessions.customer.token);
    assert.equal(bandeja.status, 200);
    assert.ok(bandeja.body.data.length > 0);

    const contador = await get('/notifications/unread-count', ctx.sessions.customer.token);
    assert.ok(Number(contador.body.data.unread) > 0);
  });

  it('un usuario no puede marcar como leída la notificación de otro', async () => {
    const bandeja = await get('/notifications?limit=1', ctx.sessions.customer.token);
    const id = bandeja.body.data[0].id;
    assert.equal((await post(`/notifications/${id}/read`, {}, ctx.sessions.admin.token)).status, 404);
  });

  it('no existe ninguna clave de evento duplicada', async () => {
    const duplicadas = await query(
      `SELECT JSON_UNQUOTE(JSON_EXTRACT(data, '$.event_key')) AS k, COUNT(*) AS n
       FROM notifications WHERE data IS NOT NULL GROUP BY k HAVING n > 1`,
    );
    assert.deepEqual(duplicadas, []);
  });

  describe('Expiración de reservas', () => {
    it('expira la reserva vencida, libera asientos y restaura la disponibilidad', async () => {
      const seats = await freeSeats(ctx.fixtures.tripA);
      const ids = [at(seats, 0).id, at(seats, 1).id];
      const reserva = await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: ids, passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token);
      const id = reserva.body.data.id;

      const trasReservar = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);

      // Equivale a esperar los 15 minutos de retención.
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [id]);

      const res = await post('/bookings/expire', {}, ctx.sessions.admin.token);
      assert.equal(res.status, 200);
      assert.ok(res.body.data.bookingIds.includes(id));
      assert.ok(res.body.data.seatsReleased >= 2);

      const estado = await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [id]);
      assert.equal(estado?.status, 'EXPIRED');

      const mapa = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);
      for (const seatId of ids) {
        assert.equal(mapa.body.data.find((s: { id: number }) => s.id === seatId).is_taken, 0, 'el asiento debe quedar libre');
      }

      const final = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
      assert.equal(Number(final?.available_seats), Number(trasReservar?.available_seats) + 2);

      const pagos = await query<{ status: string }>('SELECT status FROM payments WHERE booking_id = ?', [id]);
      assert.ok(pagos.every((p) => p.status === 'CANCELLED'), 'los pagos pendientes se cancelan');

      assert.equal((await notificacionesDe(ctx.sessions.customer.user.id, `booking.expired:${id}`)).length, 1);
    });

    it('nunca supera la capacidad del bus al restaurar la disponibilidad', async () => {
      const fila = await queryOne<{ available_seats: number; capacity: number }>(
        'SELECT t.available_seats, b.capacity FROM trips t JOIN buses b ON b.id = t.bus_id WHERE t.id = ?',
        [ctx.fixtures.tripA],
      );
      assert.ok(Number(fila?.available_seats) <= Number(fila?.capacity));
      assert.ok(Number(fila?.available_seats) >= 0);
    });

    it('reejecutar la expiración es idempotente', async () => {
      const seats = await freeSeats(ctx.fixtures.tripA);
      const reserva = await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id], passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token);
      const id = reserva.body.data.id;
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [id]);

      await post('/bookings/expire', {}, ctx.sessions.admin.token);
      const disponibles = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);

      const segunda = await post('/bookings/expire', {}, ctx.sessions.admin.token);
      const tercera = await post('/bookings/expire', {}, ctx.sessions.admin.token);
      assert.equal(segunda.body.data.bookingIds.includes(id), false);
      assert.equal(tercera.body.data.bookingIds.includes(id), false);

      const final = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
      assert.equal(Number(final?.available_seats), Number(disponibles?.available_seats), 'la disponibilidad no debe inflarse');
      assert.equal((await notificacionesDe(ctx.sessions.customer.user.id, `booking.expired:${id}`)).length, 1);
    });

    it('bajo concurrencia solo un proceso expira cada reserva', async () => {
      const seats = await freeSeats(ctx.fixtures.tripA);
      const reserva = await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id], passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token);
      const id = reserva.body.data.id;
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [id]);

      const antes = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);

      const resultados = await Promise.all([
        post('/bookings/expire', {}, ctx.sessions.admin.token),
        post('/bookings/expire', {}, ctx.sessions.admin.token),
        post('/bookings/expire', {}, ctx.sessions.admin.token),
      ]);

      const procesaron = resultados.filter((r) => r.body.data.bookingIds.includes(id));
      assert.equal(procesaron.length, 1, `solo un proceso debe expirarla, lo hicieron ${procesaron.length}`);

      const despues = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
      assert.equal(Number(despues?.available_seats), Number(antes?.available_seats) + 1, 'la disponibilidad se restaura una sola vez');
      assert.equal((await notificacionesDe(ctx.sessions.customer.user.id, `booking.expired:${id}`)).length, 1);
    });

    it('una reserva pagada no expira aunque venza su expires_at', async () => {
      const seats = await freeSeats(ctx.fixtures.tripA);
      const reserva = await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id], passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token);
      const id = reserva.body.data.id;
      await post(`/bookings/${id}/pay`, { method: 'CASH' }, ctx.sessions.customer.token);
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [id]);

      await post('/bookings/expire', {}, ctx.sessions.admin.token);
      const estado = await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [id]);
      assert.equal(estado?.status, 'CONFIRMED');
    });

    it('la expiración exige el permiso bookings.cancel', async () => {
      assert.equal((await post('/bookings/expire', {}, ctx.sessions.customer.token)).status, 200, 'CUSTOMER tiene bookings.cancel en el dump');
      const sinSesion = await post('/bookings/expire', {});
      assert.equal(sinSesion.status, 401);
    });
  });
});
