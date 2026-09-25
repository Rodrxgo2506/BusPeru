import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { api, post } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * H-49 · un cupón de empresa solo vale en viajes de esa empresa.
 * H-50 · cancelar una reserva pagada siempre abre su reembolso.
 *
 * POR QUÉ EXISTE. La auditoría 11E-0 encontró que `resolveCoupon` no miraba de qué empresa era la
 * promoción: el cupón de la empresa A descontaba en viajes de la empresa B y reducía el cobro de B.
 * Y que `POST /bookings/:id/cancel` solo abría el reembolso si llegaba `request_refund`: sin él, una
 * reserva pagada quedaba CANCELLED, liberaba sus asientos y el dinero se quedaba retenido. Las
 * pantallas siempre lo enviaban; el backend no lo exigía.
 */
describe('H-49 · H-50 · cupones por empresa y cancelación de reservas pagadas', () => {
  let ctx: SuiteContext;
  let tripB2 = 0;
  let tripA2 = 0;

  before(async () => {
    ctx = await prepareSuite();
    const copia = async (tripId: number) =>
      (await execute(
        `INSERT INTO trips (route_id, bus_id, bus_layout_id, departure_datetime, base_price, available_seats, status)
         SELECT route_id, bus_id, bus_layout_id, DATE_ADD(departure_datetime, INTERVAL 2 DAY), base_price, available_seats, 'SCHEDULED' FROM trips WHERE id = ?`,
        [tripId],
      )).insertId;
    tripA2 = await copia(ctx.fixtures.tripA);
    tripB2 = await copia(ctx.fixtures.tripB);

    const { admin } = ctx.sessions;
    const promocion = async (company_id: number | null, name: string) => {
      const res = await post(
        '/promotions',
        { ...(company_id === null ? {} : { company_id }), name, discount_type: 'PERCENTAGE', discount_value: 10, start_at: '2020-01-01 00:00:00', end_at: '2035-12-31 23:59:59', status: 'ACTIVE' },
        admin.token,
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return Number(res.body.data.id);
    };
    const cupon = async (promotion_id: number, code: string) => {
      const res = await post('/coupons', { promotion_id, code, status: 'ACTIVE' }, admin.token);
      assert.equal(res.status, 201, JSON.stringify(res.body));
    };
    await cupon(await promocion(ctx.fixtures.companyA, 'Promo A'), 'EMPRESAA49');
    await cupon(await promocion(ctx.fixtures.companyB, 'Promo B'), 'EMPRESAB49');
    const global = await promocion(null, 'Promo plataforma');
    // El alta por la API asigna la empresa del ADMIN si no se indica; la de plataforma se deja explícita.
    await execute('UPDATE promotions SET company_id = NULL WHERE id = ?', [global]);
    await cupon(global, 'GLOBAL49');
  });
  after(teardownSuite);

  beforeEach(async () => {
    for (const tabla of ['settlement_items', 'financial_transactions', 'refunds', 'coupon_usages', 'booking_seats', 'payments', 'notifications', 'bookings', 'booking_groups']) {
      await execute(`DELETE FROM ${tabla}`);
    }
    await execute("UPDATE trips t JOIN buses b ON b.id = t.bus_id SET t.available_seats = b.capacity, t.status = 'SCHEDULED'");
    await execute('UPDATE coupons SET usage_count = 0');
    await execute('UPDATE promotions SET usage_count = 0');
  });

  const reservar = async (tripId: number, extra: Record<string, unknown> = {}) =>
    post('/bookings', { trip_id: tripId, seat_ids: [at(await freeSeats(tripId), 0).id], passenger_email: 'cliente@test.pe', ...extra }, ctx.sessions.customer.token);

  // =====================================================================
  describe('H-49 · aislamiento de cupones', () => {
    it('H49-1 · cupón de la empresa A en un viaje de la empresa A: se aplica', async () => {
      const res = await reservar(ctx.fixtures.tripA, { coupon_code: 'EMPRESAA49' });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.ok(Number(res.body.data.discount_amount) > 0);
    });

    it('H49-2 · cupón de la empresa A en un viaje de la empresa B: rechazado, sin reserva ni uso del cupón', async () => {
      const res = await reservar(ctx.fixtures.tripB, { coupon_code: 'EMPRESAA49' });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.match(String(res.body.message), /no es válido para este viaje/);
      assert.equal((await query('SELECT id FROM bookings')).length, 0, 'no se crea la reserva');
      assert.equal(Number((await queryOne<{ n: number }>('SELECT usage_count AS n FROM coupons WHERE code = ?', ['EMPRESAA49']))?.n), 0);
      assert.equal((await query('SELECT id FROM coupon_usages')).length, 0);
    });

    it('H49-3 · cupón de la empresa B en un viaje de la empresa A: rechazado', async () => {
      const res = await reservar(ctx.fixtures.tripA, { coupon_code: 'empresab49' });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal((await query('SELECT id FROM bookings')).length, 0);
    });

    it('H49-4 · cupón de plataforma (company_id NULL): sigue valiendo en cualquier empresa', async () => {
      const a = await reservar(ctx.fixtures.tripA, { coupon_code: 'GLOBAL49' });
      const b = await reservar(ctx.fixtures.tripB, { coupon_code: 'GLOBAL49' });
      assert.equal(a.status, 201, JSON.stringify(a.body));
      assert.equal(b.status, 201, JSON.stringify(b.body));
      assert.ok(Number(a.body.data.discount_amount) > 0 && Number(b.body.data.discount_amount) > 0);
    });

    it('H49-5 · un company_id manipulado en el cuerpo no salta la validación', async () => {
      for (const extra of [
        { company_id: ctx.fixtures.companyA },
        { company_id: ctx.fixtures.companyA, promotion_company_id: ctx.fixtures.companyA, trip_company_id: ctx.fixtures.companyA },
      ]) {
        const res = await reservar(ctx.fixtures.tripB, { coupon_code: 'EMPRESAA49', ...extra });
        assert.equal(res.status, 400, JSON.stringify(res.body));
      }
      assert.equal((await query('SELECT id FROM bookings')).length, 0);
    });

    it('H49-6 · itinerario: el cupón se valida contra la empresa de su tramo', async () => {
      const itinerario = async (primero: number, segundo: number, coupon_code: string) =>
        post(
          '/bookings/itineraries',
          {
            trip_type: 'ROUND_TRIP',
            segments: [
              { trip_id: primero, seat_ids: [at(await freeSeats(primero), 0).id] },
              { trip_id: segundo, seat_ids: [at(await freeSeats(segundo), 1).id] },
            ],
            passenger_email: 'cliente@test.pe',
            coupon_code,
          },
          ctx.sessions.customer.token,
        );

      const ajeno = await itinerario(ctx.fixtures.tripB, tripB2, 'EMPRESAA49');
      assert.equal(ajeno.status, 400, JSON.stringify(ajeno.body));
      assert.equal((await query('SELECT id FROM booking_groups')).length, 0, 'el itinerario no se crea a medias');

      const propio = await itinerario(ctx.fixtures.tripB, tripB2, 'EMPRESAB49');
      assert.equal(propio.status, 201, JSON.stringify(propio.body));
      const conDescuento = await query<{ n: number }>('SELECT id FROM bookings WHERE discount_amount > 0');
      assert.equal(conDescuento.length, 1, 'el descuento cae en su tramo');

      const global = await itinerario(ctx.fixtures.tripA, tripA2, 'GLOBAL49');
      assert.equal(global.status, 201, JSON.stringify(global.body));
    });
  });

  // =====================================================================
  describe('H-50 · cancelar una reserva pagada abre siempre su reembolso', () => {
    async function reservaPagada() {
      const res = await reservar(ctx.fixtures.tripA);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const id = Number(res.body.data.id);
      assert.equal((await post(`/bookings/${id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token)).status, 200);
      const pago = await queryOne<{ id: number; amount: string }>("SELECT id, amount FROM payments WHERE booking_id = ? AND status = 'PAID'", [id]);
      return { id, paymentId: Number(pago!.id), amount: Number(pago!.amount) };
    }
    const reembolsos = (bookingId: number) =>
      query<{ id: number; amount: string; status: string; payment_id: number }>('SELECT id, amount, status, payment_id FROM refunds WHERE booking_id = ?', [bookingId]);
    const cancelar = (bookingId: number, body: Record<string, unknown>, token = ctx.sessions.customer.token) =>
      api(`/bookings/${bookingId}/cancel`, { method: 'POST', body, token });

    for (const [etiqueta, body] of [
      ['sin request_refund', {}],
      ['con request_refund = false', { request_refund: false }],
      ['con request_refund = "false"', { request_refund: 'false' }],
      ['con request_refund = 0', { request_refund: 0 }],
    ] as const) {
      it(`H50-1 · CONFIRMED pagada, cancelada ${etiqueta}: reembolso PENDING por el total`, async () => {
        const { id, paymentId, amount } = await reservaPagada();
        const res = await cancelar(id, body);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal((await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [id]))?.status, 'CANCELLED');
        const refunds = await reembolsos(id);
        assert.equal(refunds.length, 1, 'no queda dinero retenido sin reembolso');
        assert.deepEqual([Number(refunds[0]!.payment_id), Number(refunds[0]!.amount), refunds[0]!.status], [paymentId, amount, 'PENDING']);
      });
    }

    it('H50-1b · lo mismo cuando cancela la empresa o el ADMIN', async () => {
      for (const token of [ctx.sessions.companyAdmin.token, ctx.sessions.admin.token]) {
        const { id, amount } = await reservaPagada();
        assert.equal((await cancelar(id, {}, token)).status, 200);
        const refunds = await reembolsos(id);
        assert.equal(refunds.length, 1);
        assert.equal(Number(refunds[0]!.amount), amount);
      }
    });

    it('H50-2 · request_refund = true mantiene el flujo de siempre', async () => {
      const { id, amount } = await reservaPagada();
      assert.equal((await cancelar(id, { request_refund: true, reason: 'Motivo del pasajero' })).status, 200);
      const [refund] = await reembolsos(id);
      assert.equal(Number(refund?.amount), amount);
      assert.equal(refund?.status, 'PENDING');
    });

    it('H50-3 · reserva PENDING sin pagar: se cancela y no abre reembolso', async () => {
      const res = await reservar(ctx.fixtures.tripA, { payment_method: 'YAPE' });
      const id = Number(res.body.data.id);
      assert.equal((await cancelar(id, {})).status, 200);
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [id]))?.status, 'CANCELLED');
      assert.equal((await reembolsos(id)).length, 0);
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM payments WHERE booking_id = ?', [id]))?.status, 'PENDING');
    });

    it('H50-4 · cancelar dos veces o a la vez no duplica el reembolso', async () => {
      const uno = await reservaPagada();
      assert.equal((await cancelar(uno.id, {})).status, 200);
      assert.equal((await cancelar(uno.id, { request_refund: true })).status, 400);
      assert.equal((await reembolsos(uno.id)).length, 1);

      const dos = await reservaPagada();
      const respuestas = await Promise.all([cancelar(dos.id, {}), cancelar(dos.id, { request_refund: true }), cancelar(dos.id, {})]);
      assert.equal(respuestas.filter((r) => r.status === 200).length, 1, JSON.stringify(respuestas.map((r) => r.status)));
      assert.equal((await reembolsos(dos.id)).length, 1);
    });

    it('H50-5 · H-44 sigue: el reembolso de la cancelación, rechazado, no se completa después', async () => {
      const { id } = await reservaPagada();
      await cancelar(id, {});
      const [refund] = await reembolsos(id);
      const procesar = (status: string) => api(`/refunds/${refund!.id}/process`, { method: 'POST', body: { status }, token: ctx.sessions.admin.token });
      assert.equal((await procesar('CANCELLED')).status, 200);
      assert.ok([400, 409].includes((await procesar('COMPLETED')).status));
      assert.equal((await query("SELECT id FROM financial_transactions WHERE booking_id = ? AND type = 'REFUND'", [id])).length, 0);
    });

    it('H50-6 · la cancelación del viaje (8H) no cambia: pagadas con un reembolso, pendientes sin él', async () => {
      const pagada = await reservaPagada();
      const pendiente = Number((await reservar(ctx.fixtures.tripA)).body.data.id);
      const res = await api(`/trips/${ctx.fixtures.tripA}/cancel`, { method: 'POST', token: ctx.sessions.companyAdmin.token });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      assert.equal((await reembolsos(pagada.id)).length, 1);
      assert.equal((await reembolsos(pendiente)).length, 0);
      const estados = await query<{ id: number; status: string }>('SELECT id, status FROM bookings WHERE id IN (?, ?) ORDER BY id', [pagada.id, pendiente]);
      assert.ok(estados.every((b) => b.status === 'CANCELLED'));
      assert.equal((await api(`/trips/${ctx.fixtures.tripA}/cancel`, { method: 'POST', token: ctx.sessions.companyAdmin.token })).status, 200, 'repetirlo no hace nada');
      assert.equal((await reembolsos(pagada.id)).length, 1);
    });
  });
});
