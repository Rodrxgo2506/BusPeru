import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { api, del, get, getWithKey, post, put } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { freeSeats, at } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

describe('Pagos, reembolsos y cupones', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  /** Crea una reserva pagada y devuelve sus datos. */
  async function reservaPagada(seatCount = 1) {
    const seats = await freeSeats(ctx.fixtures.tripA);
    const reserva = await post('/bookings', {
      trip_id: ctx.fixtures.tripA,
      seat_ids: seats.slice(0, seatCount).map((s) => s.id),
      passenger_email: 'cliente@test.pe',
      payment_method: 'YAPE',
    }, ctx.sessions.customer.token);
    assert.equal(reserva.status, 201);
    const pago = await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'YAPE' }, ctx.sessions.customer.token);
    assert.equal(pago.status, 200);
    return pago.body.data;
  }

  it('confirma la reserva y registra el pago', async () => {
    const booking = await reservaPagada();
    assert.equal(booking.status, 'CONFIRMED');
    assert.equal(booking.payment_status, 'PAID');
    assert.ok(booking.confirmed_at);
  });

  it('genera las transacciones de pago y comisión del 10%', async () => {
    const booking = await reservaPagada();
    const movimientos = await query<{ type: string; direction: string; amount: number }>(
      'SELECT type, direction, amount FROM financial_transactions WHERE booking_id = ?',
      [booking.id],
    );
    const pago = movimientos.find((m) => m.type === 'PAYMENT');
    const comision = movimientos.find((m) => m.type === 'COMMISSION');
    assert.ok(pago, 'falta la transacción PAYMENT');
    assert.equal(pago!.direction, 'CREDIT');
    assert.ok(comision, 'falta la transacción COMMISSION');
    assert.equal(comision!.direction, 'DEBIT');
    assert.ok(Math.abs(Number(comision!.amount) - Number(booking.total_amount) * 0.1) < 0.02);
  });

  it('pagar varias veces es idempotente y no duplica pagos', async () => {
    const booking = await reservaPagada();
    await post(`/bookings/${booking.id}/pay`, { method: 'YAPE' }, ctx.sessions.customer.token);
    await post(`/bookings/${booking.id}/pay`, { method: 'YAPE' }, ctx.sessions.customer.token);

    const detalle = await get(`/bookings/${booking.id}`, ctx.sessions.customer.token);
    const pagados = detalle.body.data.payments.filter((p: { status: string }) => p.status === 'PAID');
    assert.equal(pagados.length, 1);

    const comisiones = await query('SELECT id FROM financial_transactions WHERE booking_id = ? AND type = ?', [booking.id, 'COMMISSION']);
    assert.equal(comisiones.length, 1, 'tampoco debe duplicarse la comisión');
  });

  it('cancelar una reserva pagada genera la solicitud de reembolso', async () => {
    const booking = await reservaPagada();
    await post(`/bookings/${booking.id}/cancel`, { reason: 'prueba', request_refund: true }, ctx.sessions.customer.token);

    const refunds = await get('/refunds?limit=50', ctx.sessions.admin.token);
    const refund = refunds.body.data.find((r: { booking_id: number }) => r.booking_id === booking.id);
    assert.ok(refund, 'debe existir la solicitud');
    assert.equal(refund.status, 'PENDING');
    assert.equal(Number(refund.amount), Number(booking.total_amount));
  });

  it('solo un rol con payments.refund puede procesar el reembolso', async () => {
    const booking = await reservaPagada();
    await post(`/bookings/${booking.id}/cancel`, { request_refund: true }, ctx.sessions.customer.token);
    const refund = (await get('/refunds?limit=50', ctx.sessions.admin.token)).body.data
      .find((r: { booking_id: number }) => r.booking_id === booking.id);

    assert.equal((await post(`/refunds/${refund.id}/process`, { status: 'COMPLETED' }, ctx.sessions.operator.token)).status, 403);
    assert.equal((await post(`/refunds/${refund.id}/process`, { status: 'COMPLETED' }, ctx.sessions.companyAdmin.token)).status, 403);

    const procesado = await post(`/refunds/${refund.id}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token);
    assert.equal(procesado.status, 200);
    assert.equal(procesado.body.data.status, 'COMPLETED');
  });

  it('al completar el reembolso marca el pago y registra el movimiento', async () => {
    const booking = await reservaPagada();
    await post(`/bookings/${booking.id}/cancel`, { request_refund: true }, ctx.sessions.customer.token);
    const refund = (await get('/refunds?limit=50', ctx.sessions.admin.token)).body.data
      .find((r: { booking_id: number }) => r.booking_id === booking.id);
    await post(`/refunds/${refund.id}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token);

    const detalle = await get(`/bookings/${booking.id}`, ctx.sessions.admin.token);
    assert.ok(detalle.body.data.payments.some((p: { status: string }) => p.status === 'REFUNDED'));

    const movimiento = await queryOne('SELECT id FROM financial_transactions WHERE booking_id = ? AND type = ?', [booking.id, 'REFUND']);
    assert.ok(movimiento, 'debe registrarse la transacción REFUND');
  });

  it('no permite procesar dos veces el mismo reembolso', async () => {
    const booking = await reservaPagada();
    await post(`/bookings/${booking.id}/cancel`, { request_refund: true }, ctx.sessions.customer.token);
    const refund = (await get('/refunds?limit=50', ctx.sessions.admin.token)).body.data
      .find((r: { booking_id: number }) => r.booking_id === booking.id);

    assert.equal((await post(`/refunds/${refund.id}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token)).status, 200);
    assert.equal((await post(`/refunds/${refund.id}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token)).status, 400);

    const movimientos = await query('SELECT id FROM financial_transactions WHERE booking_id = ? AND type = ?', [booking.id, 'REFUND']);
    assert.equal(movimientos.length, 1, 'no debe duplicarse el movimiento de reembolso');
  });

  it('los resúmenes de pagos y reembolsos responden con totales', async () => {
    await reservaPagada();
    const pagos = await get('/payments/summary', ctx.sessions.companyAdmin.token);
    assert.equal(pagos.status, 200);
    assert.ok('total_collected' in pagos.body.data);

    const reembolsos = await get('/refunds/summary', ctx.sessions.admin.token);
    assert.equal(reembolsos.status, 200);
    assert.ok('total_requests' in reembolsos.body.data);
  });

  describe('Cupones', () => {
    let couponCode: string;

    beforeEach(async () => {
      couponCode = `TEST${Date.now().toString().slice(-8)}`;
      const promo = await post('/promotions', {
        company_id: ctx.fixtures.companyA,
        name: 'Promoción de prueba',
        discount_type: 'PERCENTAGE',
        discount_value: 20,
        minimum_amount: 10,
        maximum_discount: 50,
        start_at: '2020-01-01 00:00:00',
        end_at: '2035-12-31 23:59:59',
        status: 'ACTIVE',
      }, ctx.sessions.admin.token);
      await post('/coupons', {
        promotion_id: promo.body.data.id, code: couponCode, usage_limit: 5, per_user_limit: 1, status: 'ACTIVE',
      }, ctx.sessions.admin.token);
    });

    it('aplica el descuento y aumenta el contador de usos', async () => {
      const seats = await freeSeats(ctx.fixtures.tripA);
      const reserva = await post('/bookings', {
        trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id], coupon_code: couponCode, passenger_email: 'cliente@test.pe',
      }, ctx.sessions.customer.token);

      assert.equal(reserva.status, 201);
      assert.equal(Number(reserva.body.data.discount_amount), 9, '20% de 45');
      assert.equal(Number(reserva.body.data.total_amount), 38.5, '45 - 9 + 2.50');

      const cupon = await queryOne<{ usage_count: number }>('SELECT usage_count FROM coupons WHERE code = ?', [couponCode]);
      assert.equal(Number(cupon?.usage_count), 1);
    });

    it('respeta el límite por usuario', async () => {
      const seats = await freeSeats(ctx.fixtures.tripA);
      await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id], coupon_code: couponCode, passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token);
      const segunda = await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 1).id], coupon_code: couponCode, passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token);
      assert.equal(segunda.status, 400);
    });

    it('rechaza un cupón inexistente y revierte la reserva completa', async () => {
      const seats = await freeSeats(ctx.fixtures.tripA);
      const objetivo = at(seats, 0).id;
      const res = await post('/bookings', {
        trip_id: ctx.fixtures.tripA, seat_ids: [objetivo], coupon_code: 'NO-EXISTE', passenger_email: 'cliente@test.pe',
      }, ctx.sessions.customer.token);

      assert.equal(res.status, 400);
      const mapa = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);
      assert.equal(mapa.body.data.find((s: { id: number }) => s.id === objetivo).is_taken, 0, 'el asiento no debe quedar retenido');
    });
  });

  /**
   * BP-16 y BP-23 · regresión de la auditoría del 06/09/2026.
   *
   * `POST /refunds` insertaba `payment_id`, `booking_id` y `amount` tal como llegaban: se
   * podía ligar el pago de una reserva con la reserva de otra, reembolsar un pago no
   * cobrado, pedir más de lo pagado o reembolsar varias veces el mismo pago. Tampoco
   * comprobaba la empresa, a diferencia de `POST /settlements`.
   */
  describe('BP-16 y BP-23 · un reembolso solo se crea sobre un pago real y por lo que queda', () => {
    /**
     * Viaje nuevo sobre la ruta y el bus indicados. Cada caso necesita asientos libres y la
     * disponibilidad se evalúa por `trip_id`, así que un viaje virgen los devuelve todos sin
     * interferir con lo que hayan reservado los demás tests del archivo.
     */
    let salida = 20;
    async function nuevoViaje(routeId: number, busId: number) {
      salida += 1;
      const result = await execute(
        `INSERT INTO trips (route_id, bus_id, departure_datetime, arrival_datetime, base_price, available_seats, status)
         VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), DATE_ADD(NOW(), INTERVAL ? DAY), 45.00,
                 (SELECT capacity FROM buses WHERE id = ?), 'SCHEDULED')`,
        [routeId, busId, salida, salida + 1, busId],
      );
      return result.insertId;
    }

    /** Reserva pagada con su pago, listos para reembolsar. */
    async function pagoCobrado(tripId?: number) {
      const viaje = tripId ?? (await nuevoViaje(ctx.fixtures.routeA, ctx.fixtures.busA));
      const seats = await freeSeats(viaje);
      const reserva = await post(
        '/bookings',
        { trip_id: viaje, seat_ids: [at(seats, 0).id], passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token,
      );
      assert.equal(reserva.status, 201);
      assert.equal((await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'YAPE' }, ctx.sessions.customer.token)).status, 200);

      const pago = await queryOne<{ id: number; amount: number }>(
        "SELECT id, amount FROM payments WHERE booking_id = ? AND status = 'PAID' ORDER BY id DESC LIMIT 1",
        [reserva.body.data.id],
      );
      assert.ok(pago, 'la reserva pagada debe tener su pago');
      return { booking: reserva.body.data, payment: pago! };
    }

    async function crearReembolso(cuerpo: Record<string, unknown>, token = ctx.sessions.admin.token) {
      return post('/refunds', cuerpo, token);
    }

    it('con pago cobrado, reserva correcta e importe válido se crea', async () => {
      const { booking, payment } = await pagoCobrado();
      const res = await crearReembolso({ payment_id: payment.id, booking_id: booking.id, amount: 10, reason: 'parcial' });

      assert.equal(res.status, 201);
      assert.equal(Number(res.body.data.amount), 10);
      assert.equal(res.body.data.status, 'PENDING');
      assert.equal(Number(res.body.data.booking_id), booking.id);
    });

    it('el pago de una reserva con el booking_id de otra se rechaza', async () => {
      const primera = await pagoCobrado();
      const segunda = await pagoCobrado();

      const res = await crearReembolso({ payment_id: primera.payment.id, booking_id: segunda.booking.id, amount: 10 });
      assert.equal(res.status, 400);

      const creados = await query('SELECT id FROM refunds WHERE payment_id = ?', [primera.payment.id]);
      assert.equal(creados.length, 0, 'no debe quedar ningún reembolso cruzado');
    });

    it('un pago que no está cobrado se rechaza', async () => {
      const viaje = await nuevoViaje(ctx.fixtures.routeA, ctx.fixtures.busA);
      const seats = await freeSeats(viaje);
      const reserva = await post(
        '/bookings',
        { trip_id: viaje, seat_ids: [at(seats, 0).id], payment_method: 'YAPE' },
        ctx.sessions.customer.token,
      );
      const pendiente = await queryOne<{ id: number }>(
        "SELECT id FROM payments WHERE booking_id = ? AND status = 'PENDING' LIMIT 1",
        [reserva.body.data.id],
      );
      assert.ok(pendiente, 'la reserva con método de pago crea su pago PENDING');

      const res = await crearReembolso({ payment_id: pendiente!.id, booking_id: reserva.body.data.id, amount: 5 });
      assert.equal(res.status, 400);
    });

    it('un pago inexistente responde 404', async () => {
      const { booking } = await pagoCobrado();
      assert.equal((await crearReembolso({ payment_id: 999999, booking_id: booking.id, amount: 5 })).status, 404);
    });

    it('importe cero e importe negativo se rechazan', async () => {
      const { booking, payment } = await pagoCobrado();

      assert.equal((await crearReembolso({ payment_id: payment.id, booking_id: booking.id, amount: 0 })).status, 400);
      // El negativo ni siquiera pasa la validación de forma: `money` exige un mínimo de 0.
      assert.equal((await crearReembolso({ payment_id: payment.id, booking_id: booking.id, amount: -50 })).status, 422);

      assert.equal((await query('SELECT id FROM refunds WHERE payment_id = ?', [payment.id])).length, 0);
    });

    it('un importe mayor que el pago se rechaza', async () => {
      const { booking, payment } = await pagoCobrado();
      const res = await crearReembolso({
        payment_id: payment.id,
        booking_id: booking.id,
        amount: Number(payment.amount) + 0.01,
      });
      assert.equal(res.status, 400);
    });

    it('los reembolsos parciales se acumulan hasta el importe pagado, y ni un céntimo más', async () => {
      const { booking, payment } = await pagoCobrado();
      const total = Number(payment.amount);
      const primero = Number((total * 0.3).toFixed(2));
      const resto = Number((total - primero).toFixed(2));

      assert.equal((await crearReembolso({ payment_id: payment.id, booking_id: booking.id, amount: primero })).status, 201);

      const pasarse = await crearReembolso({ payment_id: payment.id, booking_id: booking.id, amount: resto + 0.01 });
      assert.equal(pasarse.status, 400, 'lo ya reembolsado cuenta contra el pago');

      assert.equal((await crearReembolso({ payment_id: payment.id, booking_id: booking.id, amount: resto })).status, 201);

      const suma = await queryOne<{ total: number }>(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE payment_id = ?',
        [payment.id],
      );
      assert.equal(Number(suma?.total), total, 'la suma cuadra exactamente con lo pagado');
    });

    it('un pago ya reembolsado por completo no admite otro reembolso', async () => {
      const { booking, payment } = await pagoCobrado();
      assert.equal((await crearReembolso({ payment_id: payment.id, booking_id: booking.id, amount: Number(payment.amount) })).status, 201);

      const otro = await crearReembolso({ payment_id: payment.id, booking_id: booking.id, amount: 1 });
      assert.equal(otro.status, 400);
      assert.equal((await query('SELECT id FROM refunds WHERE payment_id = ?', [payment.id])).length, 1);
    });

    it('dos solicitudes simultáneas no pueden pasarse del importe pagado', async () => {
      const { booking, payment } = await pagoCobrado();
      const total = Number(payment.amount);
      const casiTodo = Number((total * 0.8).toFixed(2));

      const [uno, dos] = await Promise.all([
        crearReembolso({ payment_id: payment.id, booking_id: booking.id, amount: casiTodo }),
        crearReembolso({ payment_id: payment.id, booking_id: booking.id, amount: casiTodo }),
      ]);

      const aceptados = [uno, dos].filter((res) => res.status === 201).length;
      assert.equal(aceptados, 1, 'el bloqueo del pago serializa las dos: solo cabe una');

      const suma = await queryOne<{ total: number }>(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE payment_id = ?',
        [payment.id],
      );
      assert.ok(Number(suma?.total) <= total, 'la suma nunca supera lo cobrado');
    });

    it('no se puede crear un reembolso ya COMPLETED saltándose el procesamiento', async () => {
      const { booking, payment } = await pagoCobrado();
      const res = await crearReembolso({ payment_id: payment.id, booking_id: booking.id, amount: 5, status: 'COMPLETED' });

      assert.equal(res.status, 400, 'cerrarlo al crearlo consumiría el pago sin escribir el movimiento REFUND');
      assert.equal((await query('SELECT id FROM refunds WHERE payment_id = ?', [payment.id])).length, 0);
    });

    it('el reembolso creado se procesa después con normalidad', async () => {
      const { booking, payment } = await pagoCobrado();
      const creado = await crearReembolso({ payment_id: payment.id, booking_id: booking.id, amount: Number(payment.amount) });
      assert.equal(creado.status, 201);

      const procesado = await post(`/refunds/${creado.body.data.id}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token);
      assert.equal(procesado.status, 200);
      assert.equal(procesado.body.data.status, 'COMPLETED');

      const movimiento = await queryOne('SELECT id FROM financial_transactions WHERE booking_id = ? AND type = ?', [booking.id, 'REFUND']);
      assert.ok(movimiento, 'el flujo completo sigue registrando el movimiento');
    });

    it('los roles sin payments.refund siguen sin poder crear ni procesar', async () => {
      const { booking, payment } = await pagoCobrado();

      for (const sesion of [ctx.sessions.companyAdmin, ctx.sessions.operator, ctx.sessions.customer]) {
        const res = await crearReembolso({ payment_id: payment.id, booking_id: booking.id, amount: 5 }, sesion.token);
        assert.equal(res.status, 403, 'el permiso sigue siendo exclusivo del ADMIN');
      }
      assert.equal((await query('SELECT id FROM refunds WHERE payment_id = ?', [payment.id])).length, 0);
    });

    it('el ADMIN puede reembolsar pagos de cualquier empresa', async () => {
      const viajeB = await nuevoViaje(ctx.fixtures.routeB, ctx.fixtures.busB);
      const { booking, payment } = await pagoCobrado(viajeB);

      const res = await crearReembolso({ payment_id: payment.id, booking_id: booking.id, amount: 5 });
      assert.equal(res.status, 201, 'el alcance global del ADMIN no cambia');
    });

    it('inyectar identificadores de otra empresa no sirve de nada sin el permiso', async () => {
      const viajeB = await nuevoViaje(ctx.fixtures.routeB, ctx.fixtures.busB);
      const { booking: reservaB, payment: pagoB } = await pagoCobrado(viajeB);

      // Un COMPANY_ADMIN de la empresa A con los identificadores de la B: la primera barrera
      // es el permiso, que hoy solo tiene el ADMIN. El alcance por empresa que se añadió es
      // la segunda, para el día que `payments.refund` se conceda (eso es BP-14, otra fase).
      const res = await crearReembolso(
        { payment_id: pagoB.id, booking_id: reservaB.id, amount: 5 },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(res.status, 403);
      assert.equal((await query('SELECT id FROM refunds WHERE payment_id = ?', [pagoB.id])).length, 0);
    });

    it('BP-14 · la empresa conserva la LECTURA de sus reembolsos', async () => {
      const { booking, payment } = await pagoCobrado();
      const creado = await crearReembolso({ payment_id: payment.id, booking_id: booking.id, amount: 7, reason: 'lectura' });
      assert.equal(creado.status, 201);

      // Retirar la ACCIÓN de la interfaz no puede llevarse por delante la información: la
      // empresa sigue viendo el listado, el estado y los totales de sus propios reembolsos.
      for (const sesion of [ctx.sessions.companyAdmin, ctx.sessions.operator]) {
        const listado = await get('/refunds?limit=100', sesion.token);
        assert.equal(listado.status, 200);
        assert.ok(
          (listado.body.data as Array<{ id: number }>).some((fila) => fila.id === creado.body.data.id),
          'el reembolso de su empresa debe seguir siendo visible',
        );

        const resumen = await get('/refunds/summary', sesion.token);
        assert.equal(resumen.status, 200);
        assert.ok('total_requests' in resumen.body.data);
      }
    });

    it('BP-14 · ningún método alternativo abre el procesamiento a un rol de empresa', async () => {
      const { booking, payment } = await pagoCobrado();
      const creado = await crearReembolso({ payment_id: payment.id, booking_id: booking.id, amount: 5 });

      // Ni por otro verbo, ni por el motor genérico de recursos: `/refunds` no es un
      // recurso CRUD y el procesamiento solo existe en su ruta, con `payments.refund`.
      for (const sesion of [ctx.sessions.companyAdmin, ctx.sessions.operator]) {
        assert.equal((await put(`/refunds/${creado.body.data.id}`, { status: 'COMPLETED' }, sesion.token)).status, 404);
        assert.equal((await del(`/refunds/${creado.body.data.id}`, sesion.token)).status, 404);
        assert.equal((await post(`/refunds/${creado.body.data.id}/process`, { status: 'COMPLETED' }, sesion.token)).status, 403);
      }

      const sinTocar = await queryOne<{ status: string }>('SELECT status FROM refunds WHERE id = ?', [creado.body.data.id]);
      assert.equal(sinTocar?.status, 'PENDING', 'el reembolso no se movió por ninguna vía');
    });

    it('BP-14 · una API Key de integración no alcanza ninguna operación financiera', async () => {
      const llave = await post(
        '/api-keys',
        { name: 'Integración BP-14', company_id: ctx.fixtures.companyA },
        ctx.sessions.admin.token,
      );
      assert.equal(llave.status, 201);
      const plain = llave.body.data.plain_key as string;

      const { booking, payment } = await pagoCobrado();
      const creado = await crearReembolso({ payment_id: payment.id, booking_id: booking.id, amount: 5 });

      // La superficie de integración es de solo lectura y no publica reembolsos ni pagos.
      for (const ruta of ['/integration/v1/refunds', '/integration/v1/payments', '/integration/v1/settlements']) {
        assert.equal((await getWithKey(ruta, plain)).status, 404, `${ruta} no debe existir`);
      }

      // Y la clave no sirve como sesión en las rutas financieras del portal.
      assert.equal((await get('/refunds', plain)).status, 401);
      assert.equal((await post(`/refunds/${creado.body.data.id}/process`, { status: 'COMPLETED' }, plain)).status, 401);
      assert.equal(
        (await api(`/refunds/${creado.body.data.id}/process`, { method: 'POST', body: { status: 'COMPLETED' }, apiKey: plain })).status,
        401,
        'presentarla por su cabecera propia tampoco autentica fuera de /integration/v1',
      );

      const sinTocar = await queryOne<{ status: string }>('SELECT status FROM refunds WHERE id = ?', [creado.body.data.id]);
      assert.equal(sinTocar?.status, 'PENDING');
    });

    it('procesar un reembolso ajeno tampoco está al alcance de un rol de empresa', async () => {
      const { booking, payment } = await pagoCobrado();
      const creado = await crearReembolso({ payment_id: payment.id, booking_id: booking.id, amount: 5 });
      assert.equal(creado.status, 201);

      for (const sesion of [ctx.sessions.companyAdminB, ctx.sessions.operator, ctx.sessions.customer]) {
        assert.equal(
          (await post(`/refunds/${creado.body.data.id}/process`, { status: 'COMPLETED' }, sesion.token)).status,
          403,
        );
      }

      const sinProcesar = await queryOne<{ status: string }>('SELECT status FROM refunds WHERE id = ?', [creado.body.data.id]);
      assert.equal(sinProcesar?.status, 'PENDING');
    });
  });
});
