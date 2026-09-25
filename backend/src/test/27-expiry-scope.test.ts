import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { post, testBaseUrl } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import {
  expireDueBookings,
  startBookingExpiryScheduler,
  stopBookingExpiryScheduler,
} from '../services/booking-expiry.service';
import { seatMap } from '../services/trip.service';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * BP-22 · alcance y contexto de la expiración de reservas.
 *
 * Son dos preguntas distintas y con respuestas distintas:
 *
 *   · **El planificador** debe ser global y no representar a nadie. Ya lo era: un
 *     `setInterval` del propio proceso, sin petición, sin JWT y sin empresa, cuya consulta
 *     no filtra por `company_id`. Aquí se fija con pruebas para que siga siéndolo.
 *   · **La llamada manual** `POST /bookings/expire` sí tiene a alguien detrás, y lanzaba el
 *     barrido global. Como `bookings.cancel` lo tienen los cuatro roles, la empresa A
 *     caducaba reservas de la B y recibía sus identificadores, y un CUSTOMER podía barrer la
 *     plataforma entera. Eso es lo que se corrige.
 *
 * Las reglas de negocio no cambian: sigue caducando `PENDING` con `expires_at` vencido.
 */
describe('BP-22 · expiración global sin contexto de empresa', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(async () => {
    stopBookingExpiryScheduler();
    await teardownSuite();
  });

  beforeEach(async () => {
    stopBookingExpiryScheduler();
    await execute('DELETE FROM booking_seats');
    await execute('DELETE FROM financial_transactions');
    // Desde H-50 cancelar una reserva pagada abre su reembolso: va antes que los pagos que referencia.
    await execute('DELETE FROM refunds');
    await execute('DELETE FROM payments');
    await execute('DELETE FROM bookings');
    await execute('UPDATE trips SET available_seats = (SELECT capacity FROM buses WHERE id = trips.bus_id)');
  });

  /* ------------------------------------------------------------------ utilidades */

  /** Reserva del cliente sobre el viaje indicado. Devuelve el id. */
  async function reservar(viaje: number): Promise<number> {
    const res = await post(
      '/bookings',
      { trip_id: viaje, seat_ids: [at(await freeSeats(viaje), 0).id], passenger_email: 'cliente@test.pe' },
      ctx.sessions.customer.token,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data.id as number;
  }

  /** Vence la retención sin tocar el estado: es lo que ve el planificador. */
  const vencer = (bookingId: number) =>
    execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [bookingId]);

  const estado = async (bookingId: number) =>
    (await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [bookingId]))?.status;

  const cupos = async (viaje: number) =>
    Number((await queryOne<{ n: number }>('SELECT available_seats n FROM trips WHERE id = ?', [viaje]))?.n);

  const esperar = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /* ══════════════════════════ el proceso no representa a nadie ═══════════════ */

  describe('Contexto de ejecución', () => {
    it('1 · la expiración corre sin usuario, sin JWT y sin empresa', async () => {
      const reserva = await reservar(ctx.fixtures.tripA);
      await vencer(reserva);

      // Se invoca el servicio directamente: no hay `req`, ni token, ni sesión.
      const resultado = await expireDueBookings();

      assert.equal(resultado.expired, 1);
      assert.equal(await estado(reserva), 'EXPIRED');
    });

    it('2 · el endpoint HTTP sí exige sesión; el servicio no', async () => {
      // Sin credencial la puerta HTTP responde 401: la autenticación protege el endpoint,
      // no el barrido. El planificador no pasa por ahí.
      const sinSesion = await fetch(`${testBaseUrl()}/bookings/expire`, { method: 'POST' });
      assert.equal(sinSesion.status, 401);

      const reserva = await reservar(ctx.fixtures.tripA);
      await vencer(reserva);
      assert.equal((await expireDueBookings()).expired, 1, 'el servicio funciona sin ninguna sesión');
    });

    it('3 · el planificador caduca por sí solo, sin ninguna petición', async () => {
      const reserva = await reservar(ctx.fixtures.tripA);
      await vencer(reserva);

      startBookingExpiryScheduler(50);
      for (let intento = 0; intento < 40 && (await estado(reserva)) !== 'EXPIRED'; intento += 1) {
        await esperar(25);
      }
      stopBookingExpiryScheduler();

      assert.equal(await estado(reserva), 'EXPIRED');
    });

    it('4 · arrancarlo dos veces no deja dos planificadores', async () => {
      startBookingExpiryScheduler(50);
      startBookingExpiryScheduler(50);
      // Si la segunda llamada hubiera creado otro temporizador, este `stop` solo pararía uno
      // y el superviviente seguiría caducando reservas.
      stopBookingExpiryScheduler();

      const reserva = await reservar(ctx.fixtures.tripA);
      await vencer(reserva);
      await esperar(250);

      assert.equal(await estado(reserva), 'PENDING', 'no puede quedar un planificador huérfano');
    });
  });

  /* ══════════════════════════ alcance global del barrido ═════════════════════ */

  describe('El barrido del sistema alcanza a todas las empresas', () => {
    it('5 · caduca una reserva vencida de la empresa A', async () => {
      const reserva = await reservar(ctx.fixtures.tripA);
      await vencer(reserva);

      assert.equal((await expireDueBookings()).expired, 1);
      assert.equal(await estado(reserva), 'EXPIRED');
    });

    it('6 · caduca una reserva vencida de la empresa B', async () => {
      const reserva = await reservar(ctx.fixtures.tripB);
      await vencer(reserva);

      assert.equal((await expireDueBookings()).expired, 1);
      assert.equal(await estado(reserva), 'EXPIRED');
    });

    it('7 · caduca las de ambas empresas en la misma pasada', async () => {
      const a = await reservar(ctx.fixtures.tripA);
      const b = await reservar(ctx.fixtures.tripB);
      await vencer(a);
      await vencer(b);

      const resultado = await expireDueBookings();

      assert.equal(resultado.expired, 2);
      assert.deepEqual([await estado(a), await estado(b)], ['EXPIRED', 'EXPIRED']);
      // Y el resultado no depende de qué empresa creó cada una.
      assert.deepEqual([...resultado.bookingIds].sort((x, y) => x - y), [a, b].sort((x, y) => x - y));
    });
  });

  /* ══════════════════════════ lo que NO debe tocar ═══════════════════════════ */

  describe('Solo caduca lo que corresponde', () => {
    it('8 · no toca una reserva todavía vigente', async () => {
      const vigente = await reservar(ctx.fixtures.tripA);

      assert.equal((await expireDueBookings()).expired, 0);
      assert.equal(await estado(vigente), 'PENDING');
    });

    it('9 · no toca una CONFIRMED, ni de A ni de B, aunque su plazo pasara', async () => {
      const a = await reservar(ctx.fixtures.tripA);
      const b = await reservar(ctx.fixtures.tripB);
      await post(`/bookings/${a}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);
      await post(`/bookings/${b}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE)');

      assert.equal((await expireDueBookings()).expired, 0);
      assert.deepEqual([await estado(a), await estado(b)], ['CONFIRMED', 'CONFIRMED']);
    });

    it('10 · no toca una CANCELLED', async () => {
      const reserva = await reservar(ctx.fixtures.tripA);
      await post(`/bookings/${reserva}/cancel`, {}, ctx.sessions.customer.token);
      await vencer(reserva);

      assert.equal((await expireDueBookings()).expired, 0);
      assert.equal(await estado(reserva), 'CANCELLED');
    });

    it('11 · no toca una COMPLETED', async () => {
      const reserva = await reservar(ctx.fixtures.tripA);
      await execute("UPDATE bookings SET status = 'COMPLETED' WHERE id = ?", [reserva]);
      await vencer(reserva);

      assert.equal((await expireDueBookings()).expired, 0);
      assert.equal(await estado(reserva), 'COMPLETED');
    });

    it('12 · una reserva sin `expires_at` no caduca nunca', async () => {
      const reserva = await reservar(ctx.fixtures.tripA);
      await execute('UPDATE bookings SET expires_at = NULL WHERE id = ?', [reserva]);

      assert.equal((await expireDueBookings()).expired, 0);
      assert.equal(await estado(reserva), 'PENDING');
    });
  });

  /* ══════════════════════════ concurrencia ═══════════════════════════════════ */

  describe('Dos barridos a la vez', () => {
    it('13 · una sola transición y una sola devolución de cupos', async () => {
      const reserva = await reservar(ctx.fixtures.tripA);
      await vencer(reserva);
      const antes = await cupos(ctx.fixtures.tripA);

      const [uno, dos] = await Promise.all([expireDueBookings(), expireDueBookings()]);

      assert.equal(uno.expired + dos.expired, 1, 'la reserva solo puede caducar una vez');
      assert.equal(await estado(reserva), 'EXPIRED');
      assert.equal(await cupos(ctx.fixtures.tripA), antes + 1, 'el cupo se devuelve una sola vez');
    });

    it('14 · con varias reservas de varios viajes tampoco se duplica nada', async () => {
      const reservas = [
        await reservar(ctx.fixtures.tripA),
        await reservar(ctx.fixtures.tripB),
        await reservar(ctx.fixtures.tripA),
      ];
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE)');
      const antesA = await cupos(ctx.fixtures.tripA);
      const antesB = await cupos(ctx.fixtures.tripB);

      const salidas = await Promise.all([expireDueBookings(), expireDueBookings(), expireDueBookings()]);

      const total = salidas.reduce((suma, s) => suma + s.expired, 0);
      assert.equal(total, reservas.length, `se esperaban ${reservas.length} transiciones y hubo ${total}`);
      assert.equal(await cupos(ctx.fixtures.tripA), antesA + 2);
      assert.equal(await cupos(ctx.fixtures.tripB), antesB + 1);

      // Ninguna respuesta repite un identificador: cada reserva la procesó un solo barrido.
      const todos = salidas.flatMap((s) => s.bookingIds);
      assert.equal(new Set(todos).size, todos.length, 'un id no puede aparecer en dos barridos');
    });

    it('15 · ningún movimiento financiero se crea al caducar', async () => {
      const reserva = await reservar(ctx.fixtures.tripA);
      await vencer(reserva);

      await Promise.all([expireDueBookings(), expireDueBookings()]);

      const movimientos = await query('SELECT id FROM financial_transactions WHERE booking_id = ?', [reserva]);
      assert.deepEqual(movimientos, [], 'caducar no cobra ni devuelve dinero');
      const pagos = await query<{ status: string }>('SELECT status FROM payments WHERE booking_id = ?', [reserva]);
      assert.ok(pagos.every((p) => p.status === 'CANCELLED'), 'los pagos pendientes quedan cancelados una vez');
    });
  });

  /* ══════════════════════════ la llamada manual ══════════════════════════════ */

  describe('POST /bookings/expire respeta el alcance de quien llama', () => {
    it('16 · una empresa no caduca reservas de otra empresa', async () => {
      const a = await reservar(ctx.fixtures.tripA);
      const b = await reservar(ctx.fixtures.tripB);
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE)');

      const res = await post('/bookings/expire', {}, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 200);
      assert.equal(await estado(a), 'EXPIRED');
      assert.equal(await estado(b), 'PENDING', 'la reserva de la empresa B no le corresponde a la empresa A');
    });

    it('17 · y no recibe los identificadores de la otra empresa', async () => {
      const a = await reservar(ctx.fixtures.tripA);
      const b = await reservar(ctx.fixtures.tripB);
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE)');

      const res = await post('/bookings/expire', {}, ctx.sessions.companyAdmin.token);

      assert.deepEqual(res.body.data.bookingIds, [a]);
      assert.ok(!JSON.stringify(res.body.data).includes(`:${b}`), 'no puede filtrarse un id ajeno');
      assert.equal(res.body.data.expired, 1);
    });

    it('18 · un CUSTOMER solo caduca lo suyo', async () => {
      const propia = await reservar(ctx.fixtures.tripA);
      const ajena = await post(
        '/bookings',
        {
          trip_id: ctx.fixtures.tripA,
          seat_ids: [at(await freeSeats(ctx.fixtures.tripA), 0).id],
          passenger_email: 'empresa-a@test.pe',
        },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(ajena.status, 201);
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE)');

      const res = await post('/bookings/expire', {}, ctx.sessions.customer.token);

      assert.deepEqual(res.body.data.bookingIds, [propia]);
      assert.equal(await estado(ajena.body.data.id), 'PENDING');
    });

    it('19 · un ADMIN de plataforma sí barre todo', async () => {
      const a = await reservar(ctx.fixtures.tripA);
      const b = await reservar(ctx.fixtures.tripB);
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE)');

      const res = await post('/bookings/expire', {}, ctx.sessions.admin.token);

      assert.equal(res.body.data.expired, 2);
      assert.deepEqual([await estado(a), await estado(b)], ['EXPIRED', 'EXPIRED']);
    });

    it('20 · lo que el manual no alcanza, lo caduca igualmente el planificador', async () => {
      const b = await reservar(ctx.fixtures.tripB);
      await vencer(b);

      // La empresa A no la toca...
      await post('/bookings/expire', {}, ctx.sessions.companyAdmin.token);
      assert.equal(await estado(b), 'PENDING');

      // ...pero el proceso del sistema sí. La política de expiración no cambia.
      await expireDueBookings();
      assert.equal(await estado(b), 'EXPIRED');
    });

    it('21 · sin empresas asignadas no se caduca nada', async () => {
      const reserva = await reservar(ctx.fixtures.tripA);
      await vencer(reserva);
      await execute('DELETE FROM company_users WHERE user_id = ?', [ctx.fixtures.users.operator]);

      const sesion = await post('/auth/login', { email: 'operador-a@test.pe', password: 'PruebaSegura1' });
      const res = await post('/bookings/expire', {}, sesion.body.data.token);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.expired, 0);
      assert.equal(await estado(reserva), 'PENDING');

      await execute('INSERT INTO company_users (company_id, user_id, position) VALUES (?, ?, ?)', [
        ctx.fixtures.companyA,
        ctx.fixtures.users.operator,
        'Operaciones',
      ]);
    });
  });

  /* ══════════════════════════ compatibilidad ═════════════════════════════════ */

  describe('No se rompe lo corregido antes', () => {
    it('22 · BP-19: el asiento caducado vuelve a estar libre y sin duplicados', async () => {
      const reserva = await reservar(ctx.fixtures.tripA);
      const asientoTomado = await queryOne<{ seat_id: number }>(
        'SELECT seat_id FROM booking_seats WHERE booking_id = ?',
        [reserva],
      );
      await vencer(reserva);
      await expireDueBookings();

      const mapa = await seatMap(ctx.fixtures.tripA);
      assert.equal(mapa.find((s) => s.id === Number(asientoTomado?.seat_id))?.is_taken, 0);

      // Y se puede volver a vender, sin que el histórico desaparezca.
      const nueva = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [Number(asientoTomado?.seat_id)], passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token,
      );
      assert.equal(nueva.status, 201);

      const duplicados = await query(
        `SELECT bs.trip_id, bs.seat_id, COUNT(*) activas
         FROM booking_seats bs JOIN bookings bk ON bk.id = bs.booking_id
         WHERE bk.status IN ('CONFIRMED', 'COMPLETED')
            OR (bk.status = 'PENDING' AND (bk.expires_at IS NULL OR bk.expires_at > NOW()))
         GROUP BY bs.trip_id, bs.seat_id HAVING activas > 1`,
      );
      assert.deepEqual(duplicados, []);
      const historico = await query('SELECT id FROM booking_seats WHERE booking_id = ?', [reserva]);
      assert.equal(historico.length, 1, 'la reserva caducada conserva sus filas');
    });

    it('23 · BP-21: barridos y ventas simultáneos no se interbloquean', async () => {
      // Cada reserva se procesa en su propia transacción y bloquea UN solo viaje, así que no
      // hay ciclo posible por muchos barridos que coincidan con ventas en curso.
      const vencidas = [await reservar(ctx.fixtures.tripA), await reservar(ctx.fixtures.tripB)];
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE)');
      const libresA = await freeSeats(ctx.fixtures.tripA);
      const libresB = await freeSeats(ctx.fixtures.tripB);

      const salidas = await Promise.all([
        expireDueBookings(),
        expireDueBookings(),
        post(
          '/bookings',
          { trip_id: ctx.fixtures.tripA, seat_ids: [at(libresA, 1).id], passenger_email: 'cliente@test.pe' },
          ctx.sessions.customer.token,
        ),
        post(
          '/bookings',
          { trip_id: ctx.fixtures.tripB, seat_ids: [at(libresB, 1).id], passenger_email: 'cliente@test.pe' },
          ctx.sessions.customer.token,
        ),
      ]);

      const ventas = salidas.slice(2) as Array<{ status: number; body: { message?: string } }>;
      assert.deepEqual(
        ventas.map((v) => v.status),
        [201, 201],
        `las ventas no deben fallar: ${ventas.map((v) => v.body.message).join(' | ')}`,
      );
      assert.deepEqual([await estado(vencidas[0]!), await estado(vencidas[1]!)], ['EXPIRED', 'EXPIRED']);
    });
  });
});
