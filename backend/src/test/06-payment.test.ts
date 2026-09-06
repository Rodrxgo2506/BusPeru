import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { get, post } from './helpers/api';
import { query, queryOne } from '../config/database';
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
});
