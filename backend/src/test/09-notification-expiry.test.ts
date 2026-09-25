import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { get, post } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { freeSeats, at } from './helpers/fixtures';
import { ensureSystemTemplates } from '../services/notification.service';
import { advanceTripLifecycle } from '../services/trip.service';
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

    await post(`/bookings/${id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);
    await post(`/bookings/${id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);
    await post(`/bookings/${id}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);

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
    // CASH: lo que se prueba es la notificacion del reembolso, no el medio de pago. CARD
    // exige ahora el token de Culqi porque cobra de verdad.
    await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);
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
      await post(`/bookings/${id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);
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

  /**
   * BP-08 · regresión de la auditoría del 06/09/2026.
   *
   * Los estados IN_PROGRESS y COMPLETED existían en el ENUM y decenas de consultas
   * filtraban por ellos, pero ninguna sentencia los escribía: un viaje que ya había salido
   * seguía SCHEDULED para siempre y sus reservas seguían CONFIRMED.
   */
  describe('BP-08 · ciclo de vida del viaje', () => {
    /** Viaje propio del caso, con salida y llegada colocadas donde interesa. */
    async function viaje(horasHastaSalida: number, horasHastaLlegada: number, arrivalNula = false) {
      const result = await execute(
        `INSERT INTO trips (route_id, bus_id, departure_datetime, arrival_datetime, base_price, available_seats, status)
         VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), ${arrivalNula ? 'NULL' : 'DATE_ADD(NOW(), INTERVAL ? MINUTE)'},
                 45.00, (SELECT capacity FROM buses WHERE id = ?), 'SCHEDULED')`,
        arrivalNula
          ? [ctx.fixtures.routeA, ctx.fixtures.busA, Math.round(horasHastaSalida * 60), ctx.fixtures.busA]
          : [
              ctx.fixtures.routeA,
              ctx.fixtures.busA,
              Math.round(horasHastaSalida * 60),
              Math.round(horasHastaLlegada * 60),
              ctx.fixtures.busA,
            ],
      );
      return result.insertId;
    }

    async function estadoViaje(tripId: number): Promise<string> {
      const fila = await queryOne<{ status: string }>('SELECT status FROM trips WHERE id = ?', [tripId]);
      return String(fila?.status);
    }

    /** Reserva confirmada y pagada sobre el viaje indicado. */
    async function reservaConfirmada(tripId: number) {
      const seats = await freeSeats(tripId);
      const reserva = await post(
        '/bookings',
        { trip_id: tripId, seat_ids: [at(seats, 0).id] },
        ctx.sessions.customer.token,
      );
      assert.equal(reserva.status, 201);
      assert.equal((await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token)).status, 200);
      return reserva.body.data as { id: number; booking_code: string };
    }

    async function estadoReserva(bookingId: number): Promise<string> {
      const fila = await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [bookingId]);
      return String(fila?.status);
    }

    /**
     * Viaje ya terminado con una reserva confirmada dentro. La reserva se crea con el viaje
     * todavía en el futuro —crearla sobre un viaje que ya partió se rechaza, y así debe
     * seguir siendo— y solo después se llevan salida y llegada al pasado.
     */
    async function viajeTerminadoConReserva() {
      const tripId = await viaje(48, 56);
      const reserva = await reservaConfirmada(tripId);
      await execute(
        'UPDATE trips SET departure_datetime = DATE_SUB(NOW(), INTERVAL 5 HOUR), arrival_datetime = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id = ?',
        [tripId],
      );
      return { tripId, reserva };
    }

    it('un viaje cuya salida llegó pasa a IN_PROGRESS', async () => {
      const partido = await viaje(-1, 5);
      const futuro = await viaje(48, 56);

      const resultado = await advanceTripLifecycle();
      assert.ok(resultado.started >= 1);

      assert.equal(await estadoViaje(partido), 'IN_PROGRESS');
      assert.equal(await estadoViaje(futuro), 'SCHEDULED', 'el que aún no sale no se toca');
    });

    it('un viaje cuya llegada pasó termina en COMPLETED', async () => {
      const terminado = await viaje(-5, -1);
      const enRuta = await viaje(-1, 5);

      await advanceTripLifecycle();

      assert.equal(await estadoViaje(terminado), 'COMPLETED');
      assert.equal(await estadoViaje(enRuta), 'IN_PROGRESS', 'sin llegar todavía, sigue en curso');
    });

    it('no se completa por haber salido: hace falta la hora de llegada', async () => {
      const sinLlegada = await viaje(-5, 0, true);

      await advanceTripLifecycle();
      assert.equal(await estadoViaje(sinLlegada), 'IN_PROGRESS', 'sin arrival_datetime no se puede dar por terminado');

      await advanceTripLifecycle();
      assert.equal(await estadoViaje(sinLlegada), 'IN_PROGRESS', 'y sigue igual por muchas vueltas que dé');
    });

    it('las reservas CONFIRMED del viaje cerrado pasan a COMPLETED', async () => {
      const tripId = await viaje(48, 56);
      const reserva = await reservaConfirmada(tripId);
      assert.equal(await estadoReserva(reserva.id), 'CONFIRMED');

      await execute(
        'UPDATE trips SET departure_datetime = DATE_SUB(NOW(), INTERVAL 5 HOUR), arrival_datetime = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id = ?',
        [tripId],
      );
      const resultado = await advanceTripLifecycle();

      assert.equal(await estadoViaje(tripId), 'COMPLETED');
      assert.equal(await estadoReserva(reserva.id), 'COMPLETED');
      assert.ok(resultado.bookingsCompleted >= 1);
    });

    it('las CANCELLED y EXPIRED no se reviven', async () => {
      const tripId = await viaje(48, 56);
      const cancelada = await reservaConfirmada(tripId);
      const pendiente = await post(
        '/bookings',
        { trip_id: tripId, seat_ids: [at(await freeSeats(tripId), 0).id] },
        ctx.sessions.customer.token,
      );

      assert.equal((await post(`/bookings/${cancelada.id}/cancel`, {}, ctx.sessions.customer.token)).status, 200);
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [pendiente.body.data.id]);
      await post('/bookings/expire', {}, ctx.sessions.admin.token);

      await execute(
        'UPDATE trips SET departure_datetime = DATE_SUB(NOW(), INTERVAL 5 HOUR), arrival_datetime = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id = ?',
        [tripId],
      );
      await advanceTripLifecycle();

      assert.equal(await estadoReserva(cancelada.id), 'CANCELLED');
      assert.equal(await estadoReserva(pendiente.body.data.id), 'EXPIRED');
    });

    it('un viaje CANCELLED no entra en el ciclo', async () => {
      const tripId = await viaje(-5, -1);
      await execute("UPDATE trips SET status = 'CANCELLED' WHERE id = ?", [tripId]);

      await advanceTripLifecycle();
      assert.equal(await estadoViaje(tripId), 'CANCELLED');
    });

    it('ejecutarlo repetidamente no cambia nada ni mueve dinero', async () => {
      const { tripId, reserva } = await viajeTerminadoConReserva();

      await advanceTripLifecycle();
      const movimientos = await query('SELECT id FROM financial_transactions WHERE booking_id = ?', [reserva.id]);
      const asientos = await query('SELECT id FROM booking_seats WHERE booking_id = ?', [reserva.id]);
      const disponibles = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [tripId]);

      for (let vuelta = 0; vuelta < 3; vuelta += 1) {
        const repetido = await advanceTripLifecycle();
        assert.equal(repetido.started, 0);
        assert.equal(repetido.completed, 0);
        assert.equal(repetido.bookingsCompleted, 0, 'nada que volver a cerrar');
      }

      assert.equal(await estadoViaje(tripId), 'COMPLETED');
      assert.equal(await estadoReserva(reserva.id), 'COMPLETED');
      assert.equal((await query('SELECT id FROM financial_transactions WHERE booking_id = ?', [reserva.id])).length, movimientos.length);
      assert.equal((await query('SELECT id FROM booking_seats WHERE booking_id = ?', [reserva.id])).length, asientos.length);
      assert.equal(
        Number((await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [tripId]))?.available_seats),
        Number(disponibles?.available_seats),
        'completar no toca la disponibilidad',
      );
      assert.equal((await query('SELECT id FROM refunds WHERE booking_id = ?', [reserva.id])).length, 0);
    });

    it('dos ejecuciones simultáneas dejan el mismo resultado', async () => {
      const { tripId, reserva } = await viajeTerminadoConReserva();

      const [uno, dos] = await Promise.all([advanceTripLifecycle(), advanceTripLifecycle()]);
      assert.equal(uno.started + dos.started >= 1, true);
      assert.equal(await estadoViaje(tripId), 'COMPLETED');
      assert.equal(await estadoReserva(reserva.id), 'COMPLETED');
    });

    it('se repara solo si las reservas quedaron a medias', async () => {
      const { tripId, reserva } = await viajeTerminadoConReserva();

      // Simula la caída entre cerrar el viaje y cerrar sus reservas.
      await execute("UPDATE trips SET status = 'COMPLETED' WHERE id = ?", [tripId]);
      assert.equal(await estadoReserva(reserva.id), 'CONFIRMED');

      await advanceTripLifecycle();
      assert.equal(await estadoReserva(reserva.id), 'COMPLETED', 'la siguiente vuelta las encuentra igualmente');
    });
  });

  /**
   * BP-08 · política de cancelación. `booking.cancellation_hours` valía 24 en la base y no
   * lo leía nadie: se podía cancelar y pedir reembolso de un viaje que ya había salido.
   */
  describe('BP-08 · política de cancelación de 24 horas', () => {
    /** Reserva pagada sobre un viaje que sale dentro de los minutos indicados. */
    async function reservaConSalidaEn(minutos: number) {
      const trip = await execute(
        `INSERT INTO trips (route_id, bus_id, departure_datetime, arrival_datetime, base_price, available_seats, status)
         VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY), DATE_ADD(NOW(), INTERVAL 31 DAY), 45.00,
                 (SELECT capacity FROM buses WHERE id = ?), 'SCHEDULED')`,
        [ctx.fixtures.routeA, ctx.fixtures.busA, ctx.fixtures.busA],
      );
      const tripId = trip.insertId;

      // La reserva se crea con el viaje lejos —crearla exige que no haya partido— y solo
      // después se acerca la salida a donde el caso la necesita.
      const reserva = await post(
        '/bookings',
        { trip_id: tripId, seat_ids: [at(await freeSeats(tripId), 0).id] },
        ctx.sessions.customer.token,
      );
      assert.equal(reserva.status, 201);
      await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);

      await execute('UPDATE trips SET departure_datetime = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?', [
        Math.round(minutos * 60),
        tripId,
      ]);
      return { tripId, bookingId: reserva.body.data.id as number };
    }

    async function cancelar(bookingId: number, refund = true) {
      return post(`/bookings/${bookingId}/cancel`, { reason: 'prueba', request_refund: refund }, ctx.sessions.customer.token);
    }

    async function reembolsos(bookingId: number) {
      return query('SELECT id FROM refunds WHERE booking_id = ?', [bookingId]);
    }

    it('25 horas antes se puede cancelar y se genera el reembolso', async () => {
      const { bookingId } = await reservaConSalidaEn(25 * 60);
      const res = await cancelar(bookingId);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'CANCELLED');
      assert.equal((await reembolsos(bookingId)).length, 1, 'reembolso íntegro cuando se solicita');
    });

    it('exactamente 24 horas antes se rechaza', async () => {
      const { bookingId } = await reservaConSalidaEn(24 * 60);
      const res = await cancelar(bookingId);

      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /24 horas/);
      assert.equal((await reembolsos(bookingId)).length, 0);
    });

    it('a 23 h 59 min también se rechaza', async () => {
      const { bookingId } = await reservaConSalidaEn(24 * 60 - 1);
      assert.equal((await cancelar(bookingId)).status, 400);
      assert.equal((await reembolsos(bookingId)).length, 0);
    });

    it('a una hora de la salida se rechaza', async () => {
      const { bookingId } = await reservaConSalidaEn(60);
      assert.equal((await cancelar(bookingId)).status, 400);
    });

    it('justo a la hora de salida se rechaza', async () => {
      const { bookingId } = await reservaConSalidaEn(0);
      assert.equal((await cancelar(bookingId)).status, 400);
    });

    it('un minuto después de la salida se rechaza', async () => {
      const { bookingId } = await reservaConSalidaEn(-1);
      assert.equal((await cancelar(bookingId)).status, 400);
    });

    it('con el viaje IN_PROGRESS se rechaza', async () => {
      const { tripId, bookingId } = await reservaConSalidaEn(-30);
      await advanceTripLifecycle();
      assert.equal(await queryOne<{ status: string }>('SELECT status FROM trips WHERE id = ?', [tripId]).then((r) => r?.status), 'IN_PROGRESS');

      const res = await cancelar(bookingId);
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /en curso/);
    });

    it('con el viaje COMPLETED se rechaza', async () => {
      const { tripId, bookingId } = await reservaConSalidaEn(-30);
      await execute('UPDATE trips SET arrival_datetime = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [tripId]);
      await advanceTripLifecycle();

      const res = await cancelar(bookingId);
      assert.equal(res.status, 400);
      assert.equal((await reembolsos(bookingId)).length, 0);
    });

    it('una cancelación rechazada no toca reserva, asientos ni disponibilidad', async () => {
      const { tripId, bookingId } = await reservaConSalidaEn(60);
      const antes = await queryOne<{ status: string; available_seats: number; asientos: number }>(
        `SELECT (SELECT status FROM bookings WHERE id = ?) AS status,
                (SELECT available_seats FROM trips WHERE id = ?) AS available_seats,
                (SELECT COUNT(*) FROM booking_seats WHERE booking_id = ?) AS asientos`,
        [bookingId, tripId, bookingId],
      );

      assert.equal((await cancelar(bookingId)).status, 400);

      const despues = await queryOne<{ status: string; available_seats: number; asientos: number }>(
        `SELECT (SELECT status FROM bookings WHERE id = ?) AS status,
                (SELECT available_seats FROM trips WHERE id = ?) AS available_seats,
                (SELECT COUNT(*) FROM booking_seats WHERE booking_id = ?) AS asientos`,
        [bookingId, tripId, bookingId],
      );
      assert.deepEqual(despues, antes);
      assert.equal(despues?.status, 'CONFIRMED', 'sigue confirmada');
    });

    it('si la empresa canceló el viaje, el pasajero puede cancelar a cualquier hora', async () => {
      const { tripId, bookingId } = await reservaConSalidaEn(60);
      await execute("UPDATE trips SET status = 'CANCELLED' WHERE id = ?", [tripId]);

      const res = await cancelar(bookingId);
      assert.equal(res.status, 200, 'se conserva el comportamiento que ya existía');
      assert.equal((await reembolsos(bookingId)).length, 1);
    });

    it('el portal de empresa está sujeto a la misma regla', async () => {
      const { bookingId } = await reservaConSalidaEn(60);
      const res = await post(
        `/bookings/${bookingId}/cancel`,
        { reason: 'Cancelada desde el portal', request_refund: true },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(res.status, 400, 'la política vive en el servicio, no en cada rol');
    });

    it('las reglas de BP-09 sobre reservas ya cerradas siguen intactas', async () => {
      const { bookingId } = await reservaConSalidaEn(25 * 60);
      assert.equal((await cancelar(bookingId)).status, 200);
      assert.equal((await cancelar(bookingId)).status, 400, 'CANCELLED no se cancela dos veces');
    });
  });
});
