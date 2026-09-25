import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { api, get, post } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { setCulqiApi, type CulqiApi } from '../services/culqi.service';
import { centsToDecimal, percentOfCents, proportionalCents, toCentsExact } from '../utils/money';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

process.env.LOG_ERRORS = 'false';

/**
 * FASE 11E-2 · contabilidad de reembolsos, caja y liquidación.
 *
 *   H-26 · el reembolso compensatorio (cobro que no confirmó ninguna venta) vive en el libro de la
 *          plataforma (`company_id` NULL): la empresa no ve venta, comisión ni devolución.
 *   H-27 · la comisión se revierte en proporción a lo devuelto, en céntimos y por acumulado.
 *   H-28 · varios reembolsos parciales: el pago sigue PAID hasta devolver el total.
 *   H-47 · caja (pagos y reembolsos) separada de la contabilidad (movimientos firmados).
 *   H-48 · la liquidación suma movimientos firmados; ADJUSTMENT entra, PAYOUT no.
 *   H-51 · la comisión se calcula en céntimos, sin coma flotante.
 *
 * Todo corre sobre `busperu_test`. Las ventas son en efectivo registradas por el ADMIN: sin pasarela.
 */
describe('11E-2 · reembolsos parciales, comisión, caja y liquidación', () => {
  let ctx: SuiteContext;
  const devoluciones: Array<{ chargeId: string; amountCents: number }> = [];
  /** Doble de Culqi: el compensatorio lleva un `chr_…` y su devolución pasa por la pasarela. */
  const culqiFalso: CulqiApi = {
    async createCharge() {
      return { ok: false, kind: 'PROVIDER', code: null, userMessage: 'sin cobros en esta suite', merchantMessage: 'x' };
    },
    async getCharge() {
      return { ok: false, kind: 'PROVIDER', code: null, userMessage: 'sin cobros en esta suite', merchantMessage: 'x' };
    },
    async createRefund(input) {
      devoluciones.push({ chargeId: input.chargeId, amountCents: input.amountCents });
      return { ok: true, data: { id: `ref_test_57_${devoluciones.length}`, charge_id: input.chargeId, amount: input.amountCents } as never };
    },
  };

  before(async () => {
    ctx = await prepareSuite();
  });
  after(async () => {
    await execute("UPDATE system_settings SET setting_value = '2.50' WHERE setting_key = 'booking.service_fee'");
    await teardownSuite();
  });
  beforeEach(async () => {
    devoluciones.length = 0;
    setCulqiApi(culqiFalso);
    for (const tabla of ['settlement_items', 'settlements', 'financial_transactions', 'refunds', 'coupon_usages', 'booking_seats', 'payments', 'notifications', 'bookings', 'booking_groups']) {
      await execute(`DELETE FROM ${tabla}`);
    }
    await execute("UPDATE trips t JOIN buses b ON b.id = t.bus_id SET t.available_seats = b.capacity, t.status = 'SCHEDULED'");
    // Pago de S/ 100 sin service fee y la tasa de las fixtures: 10 %. Esta suite mide H-27/H-47/H-48
    // sobre la base de la empresa; el service fee (H-45) se prueba en la suite 58.
    await execute('UPDATE trips SET base_price = 100.00 WHERE id IN (?, ?)', [ctx.fixtures.tripA, ctx.fixtures.tripB]);
    await execute("UPDATE system_settings SET setting_value = '0.00' WHERE setting_key = 'booking.service_fee'");
    await execute("UPDATE company_commission_settings SET commission_type = 'PERCENTAGE', commission_value = 10.00");
  });
  afterEach(() => setCulqiApi(null));

  /* ------------------------------------------------------------------ utilidades */

  async function venta(tripId = ctx.fixtures.tripA) {
    const res = await post(
      '/bookings',
      { trip_id: tripId, seat_ids: [at(await freeSeats(tripId), 0).id], passenger_email: 'cliente@test.pe' },
      ctx.sessions.customer.token,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const bookingId = Number(res.body.data.id);
    const pagado = await post(`/bookings/${bookingId}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);
    assert.equal(pagado.status, 200, JSON.stringify(pagado.body));
    const pago = await queryOne<{ id: number; amount: string }>("SELECT id, amount FROM payments WHERE booking_id = ? AND status = 'PAID'", [bookingId]);
    return { bookingId, paymentId: Number(pago!.id), amountCents: toCentsExact(pago!.amount) };
  }

  async function reembolsar(paymentId: number, bookingId: number, amount: number): Promise<number> {
    const creado = await post('/refunds', { payment_id: paymentId, booking_id: bookingId, amount, reason: 'prueba 11E-2' }, ctx.sessions.admin.token);
    assert.equal(creado.status, 201, JSON.stringify(creado.body));
    return Number(creado.body.data.id);
  }
  const procesar = (refundId: number, status = 'COMPLETED') =>
    api(`/refunds/${refundId}/process`, { method: 'POST', body: { status }, token: ctx.sessions.admin.token });
  async function reembolsoCompleto(paymentId: number, bookingId: number, amount: number): Promise<number> {
    const id = await reembolsar(paymentId, bookingId, amount);
    const res = await procesar(id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return id;
  }

  const estadoPago = async (paymentId: number) => (await queryOne<{ status: string }>('SELECT status FROM payments WHERE id = ?', [paymentId]))?.status;
  const comisiones = (paymentId: number) =>
    query<{ direction: string; amount: string; company_id: number | null }>(
      "SELECT direction, amount, company_id FROM financial_transactions WHERE payment_id = ? AND type = 'COMMISSION' ORDER BY id",
      [paymentId],
    );
  const centsDe = (filas: Array<{ direction: string; amount: string }>, direction: string) =>
    filas.filter((f) => f.direction === direction).map((f) => toCentsExact(f.amount));
  const hoy = async () => (await queryOne<{ d: string }>("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS d"))!.d;

  /** Deja S/ 100 cobrados y un compensatorio: pago PAID sin venta de empresa, con su reembolso. */
  async function compensatorio(tripId = ctx.fixtures.tripA) {
    const res = await post(
      '/bookings',
      { trip_id: tripId, seat_ids: [at(await freeSeats(tripId), 0).id], passenger_email: 'cliente@test.pe' },
      ctx.sessions.customer.token,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const bookingId = Number(res.body.data.id);
    const pago = await execute(
      `INSERT INTO payments (booking_id, method, provider, provider_transaction_id, amount, currency, status, paid_at, payment_data)
       VALUES (?, 'CARD', 'CULQI', ?, 100.00, 'PEN', 'PAID', NOW(), ?)`,
      [bookingId, `chr_test_57_${bookingId}`, JSON.stringify({ compensation: { reason: 'prueba', at: new Date().toISOString() } })],
    );
    const refund = await execute("INSERT INTO refunds (payment_id, booking_id, amount, reason, status) VALUES (?, ?, 100.00, 'compensatorio', 'PENDING')", [
      pago.insertId,
      bookingId,
    ]);
    return { bookingId, paymentId: pago.insertId, refundId: refund.insertId };
  }

  // =====================================================================
  describe('H-51 · comisión en céntimos', () => {
    it('H51-1 · 1.005 → 1.01: 10 % de S/ 10,05 (la coma flotante daba 1.00)', () => {
      assert.equal((1.005).toFixed(2), '1.00', 'el defecto que se corrige');
      assert.equal(percentOfCents(1005, '10.00'), 101);
      assert.equal(centsToDecimal(percentOfCents(1005, '10.00')), '1.01');
      assert.equal(toCentsExact('1.005'), 101);
    });

    it('H51-2 · 10.005 → 10.01 y 99.995 → 100.00', () => {
      assert.equal(toCentsExact('10.005'), 1001);
      assert.equal(percentOfCents(10005, '10'), 1001);
      assert.equal(toCentsExact('99.995'), 10000);
      assert.equal(percentOfCents(99995, '10'), 10000);
      assert.equal(centsToDecimal(percentOfCents(99995, '10')), '100.00');
    });

    it('H51-3 · porcentajes con decimales y bordes', () => {
      assert.equal(percentOfCents(4750, '12.50'), 594, '593,75 → 594');
      assert.equal(percentOfCents(10000, '0.01'), 1);
      assert.equal(percentOfCents(10000, 0), 0);
      assert.equal(percentOfCents(333, '33.33'), 111, '110,9889 → 111');
      assert.equal(percentOfCents(10000, 7.5), 750, 'un número también se lee sin coma flotante');
      assert.equal(centsToDecimal(5), '0.05');
      assert.equal(centsToDecimal(-1234), '-12.34');
      assert.throws(() => toCentsExact('abc'));
      assert.throws(() => toCentsExact(Number.NaN));
    });

    it('H51-4 · proporcional por acumulado: 3 tercios suman exactamente la comisión', () => {
      const tramos = [proportionalCents(1000, 3333, 10000), proportionalCents(1000, 6666, 10000), proportionalCents(1000, 10000, 10000)];
      assert.deepEqual(tramos, [333, 667, 1000]);
      assert.equal(proportionalCents(1000, 20000, 10000), 1000, 'acotado al total');
      assert.equal(proportionalCents(1000, 5000, 0), 0);
    });

    it('H51-5 · la venta real persiste 1.01 de comisión sobre un total de S/ 10,05', async () => {
      await execute('UPDATE trips SET base_price = 10.05 WHERE id = ?', [ctx.fixtures.tripA]);
      const { paymentId, amountCents } = await venta();
      assert.equal(amountCents, 1005);
      assert.deepEqual(centsDe(await comisiones(paymentId), 'DEBIT'), [101]);
    });

    it('H51-6 · tasa con decimales (12,50 %) sobre S/ 100 → 12.50', async () => {
      await execute("UPDATE company_commission_settings SET commission_value = 12.50 WHERE company_id = ?", [ctx.fixtures.companyA]);
      const { paymentId } = await venta();
      assert.deepEqual(centsDe(await comisiones(paymentId), 'DEBIT'), [1250]);
    });
  });

  // =====================================================================
  describe('H-27 · reversión proporcional de la comisión', () => {
    it('H27-1 · reembolso total: se revierte la comisión entera', async () => {
      const { bookingId, paymentId } = await venta();
      await reembolsoCompleto(paymentId, bookingId, 100);
      const filas = await comisiones(paymentId);
      assert.deepEqual(centsDe(filas, 'DEBIT'), [1000]);
      assert.deepEqual(centsDe(filas, 'CREDIT'), [1000]);
    });

    it('H27-2 · reembolso de 30 sobre 100 con 10 %: revierte 3.00', async () => {
      const { bookingId, paymentId } = await venta();
      await reembolsoCompleto(paymentId, bookingId, 30);
      assert.deepEqual(centsDe(await comisiones(paymentId), 'CREDIT'), [300]);
    });

    it('H27-3 · 33.33 + 33.33 + 33.34: 3.33 + 3.34 + 3.33 = 10.00 exactos', async () => {
      const { bookingId, paymentId } = await venta();
      const acumulado: number[] = [];
      for (const parte of [33.33, 33.33, 33.34]) {
        await reembolsoCompleto(paymentId, bookingId, parte);
        acumulado.push(centsDe(await comisiones(paymentId), 'CREDIT').reduce((s, c) => s + c, 0));
      }
      assert.deepEqual(centsDe(await comisiones(paymentId), 'CREDIT'), [333, 334, 333]);
      assert.deepEqual(acumulado, [333, 667, 1000]);
    });

    it('H27-4 · comisión 0: ni cargo ni reversión', async () => {
      await execute('UPDATE company_commission_settings SET commission_value = 0 WHERE company_id = ?', [ctx.fixtures.companyA]);
      const { bookingId, paymentId } = await venta();
      await reembolsoCompleto(paymentId, bookingId, 50);
      await reembolsoCompleto(paymentId, bookingId, 50);
      assert.deepEqual(await comisiones(paymentId), []);
      assert.equal(await estadoPago(paymentId), 'REFUNDED');
    });

    it('H27-5 · tasa decimal 12,50 %: 50 de 100 revierte 6.25', async () => {
      await execute('UPDATE company_commission_settings SET commission_value = 12.50 WHERE company_id = ?', [ctx.fixtures.companyA]);
      const { bookingId, paymentId } = await venta();
      await reembolsoCompleto(paymentId, bookingId, 50);
      assert.deepEqual(centsDe(await comisiones(paymentId), 'CREDIT'), [625]);
    });

    it('H27-6 · la reversión usa la comisión ORIGINAL aunque la tasa cambie después', async () => {
      const { bookingId, paymentId } = await venta();
      await execute('UPDATE company_commission_settings SET commission_value = 20 WHERE company_id = ?', [ctx.fixtures.companyA]);
      await reembolsoCompleto(paymentId, bookingId, 50);
      assert.deepEqual(centsDe(await comisiones(paymentId), 'CREDIT'), [500]);
    });

    it('H27-7 · FAILED y CANCELLED no revierten comisión', async () => {
      const { bookingId, paymentId } = await venta();
      assert.equal((await procesar(await reembolsar(paymentId, bookingId, 40), 'FAILED')).status, 200);
      assert.equal((await procesar(await reembolsar(paymentId, bookingId, 40), 'CANCELLED')).status, 200);
      assert.deepEqual(centsDe(await comisiones(paymentId), 'CREDIT'), []);
      const refunds = await query("SELECT id FROM financial_transactions WHERE payment_id = ? AND type = 'REFUND'", [paymentId]);
      assert.deepEqual(refunds, [], 'un reembolso FAILED o CANCELLED no genera movimientos');
      assert.equal(await estadoPago(paymentId), 'PAID');
    });
  });

  // =====================================================================
  describe('H-28 · reembolsos parciales múltiples', () => {
    it('H28-1 · 40 + 60: PAID tras el primero, REFUNDED tras el segundo', async () => {
      const { bookingId, paymentId } = await venta();
      await reembolsoCompleto(paymentId, bookingId, 40);
      assert.equal(await estadoPago(paymentId), 'PAID', 'queda saldo por devolver');
      await reembolsoCompleto(paymentId, bookingId, 60);
      assert.equal(await estadoPago(paymentId), 'REFUNDED');
    });

    it('H28-2 · un PENDING o PROCESSING no cuenta como devuelto', async () => {
      const { bookingId, paymentId } = await venta();
      await reembolsoCompleto(paymentId, bookingId, 40);
      const pendiente = await reembolsar(paymentId, bookingId, 60);
      assert.equal(await estadoPago(paymentId), 'PAID');
      await execute("UPDATE refunds SET status = 'PROCESSING' WHERE id = ?", [pendiente]);
      assert.equal(await estadoPago(paymentId), 'PAID');
      assert.equal((await procesar(pendiente)).status, 200);
      assert.equal(await estadoPago(paymentId), 'REFUNDED');
    });

    it('H28-3 · FAILED y CANCELLED liberan saldo y no cuentan', async () => {
      const { bookingId, paymentId } = await venta();
      assert.equal((await procesar(await reembolsar(paymentId, bookingId, 100), 'FAILED')).status, 200);
      assert.equal((await procesar(await reembolsar(paymentId, bookingId, 100), 'CANCELLED')).status, 200);
      assert.equal(await estadoPago(paymentId), 'PAID');
      await reembolsoCompleto(paymentId, bookingId, 70);
      assert.equal(await estadoPago(paymentId), 'PAID');
      await reembolsoCompleto(paymentId, bookingId, 30);
      assert.equal(await estadoPago(paymentId), 'REFUNDED');
    });

    it('H28-4 · H-44 sigue vigente: no se puede pedir más de lo que queda', async () => {
      const { bookingId, paymentId } = await venta();
      await reembolsoCompleto(paymentId, bookingId, 60);
      const excedido = await post('/refunds', { payment_id: paymentId, booking_id: bookingId, amount: 40.01, reason: 'x' }, ctx.sessions.admin.token);
      assert.equal(excedido.status, 400, JSON.stringify(excedido.body));
      await reembolsoCompleto(paymentId, bookingId, 40);
      const otro = await post('/refunds', { payment_id: paymentId, booking_id: bookingId, amount: 0.01, reason: 'x' }, ctx.sessions.admin.token);
      assert.equal(otro.status, 400, 'un pago REFUNDED ya no admite reembolsos');
      const total = await queryOne<{ t: string }>("SELECT COALESCE(SUM(amount), 0) AS t FROM refunds WHERE payment_id = ? AND status = 'COMPLETED'", [paymentId]);
      assert.equal(toCentsExact(total!.t), 10000);
    });

    it('H28-5 · un reembolso vivo que excede lo que queda no se completa (defensa del cierre)', async () => {
      const { bookingId, paymentId } = await venta();
      const primero = await reembolsar(paymentId, bookingId, 60);
      const directo = await execute("INSERT INTO refunds (payment_id, booking_id, amount, reason, status) VALUES (?, ?, 60.00, 'directo', 'PENDING')", [paymentId, bookingId]);
      assert.equal((await procesar(primero)).status, 200);
      assert.equal((await procesar(directo.insertId)).status, 409);
      assert.equal(await estadoPago(paymentId), 'PAID');
    });

    /** Procesa a la vez; el cerrojo por pago de H-44 rechaza sin esperar (409) y esos se reintentan en serie. */
    async function procesarAlaVez(ids: number[]): Promise<number[]> {
      const primeros = await Promise.all(ids.map((id) => procesar(id)));
      assert.ok(primeros.every((r) => [200, 409].includes(r.status)), JSON.stringify(primeros.map((r) => r.body)));
      const finales: number[] = [];
      for (const [i, r] of primeros.entries()) finales.push(r.status === 200 ? 200 : (await procesar(ids[i]!)).status);
      return finales;
    }

    it('H28-C1 · dos parciales procesados a la vez: los dos completan, la reversión suma 10.00 y el pago queda REFUNDED', async () => {
      const { bookingId, paymentId } = await venta();
      const [r1, r2] = [await reembolsar(paymentId, bookingId, 33.33), await reembolsar(paymentId, bookingId, 66.67)];
      assert.deepEqual(await procesarAlaVez([r1, r2]), [200, 200]);
      const creditos = centsDe(await comisiones(paymentId), 'CREDIT');
      assert.equal(creditos.length, 2);
      assert.equal(creditos.reduce((t, c) => t + c, 0), 1000);
      assert.equal(await estadoPago(paymentId), 'REFUNDED');
    });

    it('H28-C2 · tres reembolsos vivos de 40 procesados a la vez: nunca se devuelve más de 100', async () => {
      const { bookingId, paymentId } = await venta();
      const ids = [await reembolsar(paymentId, bookingId, 40), await reembolsar(paymentId, bookingId, 40)];
      ids.push((await execute("INSERT INTO refunds (payment_id, booking_id, amount, reason, status) VALUES (?, ?, 40.00, 'directo', 'PENDING')", [paymentId, bookingId])).insertId);
      const estados = await procesarAlaVez(ids);
      assert.deepEqual([...estados].sort(), [200, 200, 409], 'el tercero superaría lo cobrado');
      const devuelto = await queryOne<{ t: string }>("SELECT COALESCE(SUM(amount), 0) AS t FROM refunds WHERE payment_id = ? AND status = 'COMPLETED'", [paymentId]);
      assert.equal(toCentsExact(devuelto!.t), 8000);
      const movs = await query<{ amount: string }>("SELECT amount FROM financial_transactions WHERE payment_id = ? AND type = 'REFUND'", [paymentId]);
      assert.equal(movs.reduce((t, m) => t + toCentsExact(m.amount), 0), 8000);
      assert.equal(centsDe(await comisiones(paymentId), 'CREDIT').reduce((t, c) => t + c, 0), 800);
      assert.equal(await estadoPago(paymentId), 'PAID');
    });

    it('H28-6 · cancelar tras un reembolso parcial abre el reembolso del RESTO', async () => {
      const { bookingId, paymentId } = await venta();
      await reembolsoCompleto(paymentId, bookingId, 40);
      const res = await api(`/bookings/${bookingId}/cancel`, { method: 'POST', body: {}, token: ctx.sessions.customer.token });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const vivos = await query<{ amount: string; status: string }>("SELECT amount, status FROM refunds WHERE payment_id = ? AND status = 'PENDING'", [paymentId]);
      assert.deepEqual(vivos.map((r) => [toCentsExact(r.amount), r.status]), [[6000, 'PENDING']]);
    });

    it('H28-7 · cancelar cuando los reembolsos vivos ya cubren el total no abre otro', async () => {
      const { bookingId, paymentId } = await venta();
      await reembolsoCompleto(paymentId, bookingId, 40);
      await reembolsar(paymentId, bookingId, 60);
      assert.equal((await api(`/bookings/${bookingId}/cancel`, { method: 'POST', body: {}, token: ctx.sessions.customer.token })).status, 200);
      const filas = await query('SELECT id FROM refunds WHERE payment_id = ?', [paymentId]);
      assert.equal(filas.length, 2);
    });

    it('H28-8 · el pago REFUNDED por parciales tiene exactamente un REFUND por reembolso', async () => {
      const { bookingId, paymentId } = await venta();
      for (const parte of [25, 25, 50]) await reembolsoCompleto(paymentId, bookingId, parte);
      const refunds = await query<{ amount: string }>("SELECT amount FROM financial_transactions WHERE payment_id = ? AND type = 'REFUND' ORDER BY id", [paymentId]);
      assert.deepEqual(refunds.map((r) => toCentsExact(r.amount)), [2500, 2500, 5000]);
    });
  });

  // =====================================================================
  describe('H-26 · reembolso compensatorio fuera de la contabilidad de la empresa', () => {
    it('H26-1 · completar el compensatorio asienta la plataforma y deja a la empresa intacta', async () => {
      const { paymentId, refundId } = await compensatorio();
      const res = await procesar(refundId);
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const empresa = await query('SELECT id FROM financial_transactions WHERE payment_id = ? AND company_id IS NOT NULL', [paymentId]);
      assert.deepEqual(empresa, [], 'ni PAYMENT, ni COMMISSION, ni REFUND de empresa');
      const plataforma = await query<{ type: string; direction: string; amount: string }>(
        'SELECT type, direction, amount FROM financial_transactions WHERE payment_id = ? AND company_id IS NULL ORDER BY id',
        [paymentId],
      );
      assert.deepEqual(plataforma.map((m) => [m.type, m.direction, toCentsExact(m.amount)]), [['PAYMENT', 'CREDIT', 10000], ['REFUND', 'DEBIT', 10000]]);
      assert.equal(await estadoPago(paymentId), 'REFUNDED');
      assert.deepEqual(devoluciones, [{ chargeId: `chr_test_57_${(await queryOne<{ booking_id: number }>('SELECT booking_id FROM payments WHERE id = ?', [paymentId]))!.booking_id}`, amountCents: 10000 }]);
    });

    it('H26-2 · la empresa no ve el compensatorio en su resumen contable ni en su liquidación', async () => {
      const { refundId } = await compensatorio();
      assert.equal((await procesar(refundId)).status, 200);
      const resumen = await get('/financial-transactions/summary', ctx.sessions.companyAdmin.token);
      assert.equal(resumen.status, 200);
      assert.deepEqual([resumen.body.data.sales_gross, resumen.body.data.sales_refunded, resumen.body.data.company_balance].map(Number), [0, 0, 0]);
      assert.equal(resumen.body.data.compensations_collected, undefined, 'el libro de la plataforma no se expone a la empresa');

      const d = await hoy();
      const liq = await post('/settlements', { company_id: ctx.fixtures.companyA, period_start: d, period_end: d }, ctx.sessions.admin.token);
      assert.equal(liq.status, 201, JSON.stringify(liq.body));
      assert.deepEqual([liq.body.data.net_amount, liq.body.data.items_count].map(Number), [0, 0]);
    });

    it('H26-3 · el ADMIN ve las compensaciones aparte y en cero', async () => {
      const { refundId } = await compensatorio();
      assert.equal((await procesar(refundId)).status, 200);
      const resumen = await get('/financial-transactions/summary', ctx.sessions.admin.token);
      assert.deepEqual(
        [resumen.body.data.compensations_collected, resumen.body.data.compensations_refunded, resumen.body.data.platform_compensation_balance, resumen.body.data.sales_gross].map(Number),
        [100, 100, 0, 0],
      );
    });

    it('H26-4 · la entrada de la plataforma es idempotente aunque ya existiera', async () => {
      const { bookingId, paymentId, refundId } = await compensatorio();
      await execute(
        "INSERT INTO financial_transactions (company_id, booking_id, payment_id, type, direction, amount, currency, status, transaction_date) VALUES (NULL, ?, ?, 'PAYMENT', 'CREDIT', 100.00, 'PEN', 'COMPLETED', NOW())",
        [bookingId, paymentId],
      );
      assert.equal((await procesar(refundId)).status, 200);
      const n = await queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM financial_transactions WHERE payment_id = ? AND type = 'PAYMENT'", [paymentId]);
      assert.equal(Number(n!.n), 1);
    });
  });

  // =====================================================================
  describe('H-47 · caja frente a contabilidad', () => {
    it('H47-1 · venta 100, reembolso 30: caja 100/30/70 y contabilidad 100/30/7/63', async () => {
      const { bookingId, paymentId } = await venta();
      await reembolsoCompleto(paymentId, bookingId, 30);

      const caja = await get('/payments/summary', ctx.sessions.companyAdmin.token);
      assert.equal(caja.status, 200);
      assert.deepEqual([caja.body.data.cash_collected, caja.body.data.cash_refunded, caja.body.data.cash_net], ['100.00', '30.00', '70.00']);
      assert.deepEqual([caja.body.data.total_collected, caja.body.data.refunded], ['100.00', '30.00'], 'claves antiguas con valores de caja');

      const conta = await get('/financial-transactions/summary', ctx.sessions.companyAdmin.token);
      const d = conta.body.data;
      assert.deepEqual([d.sales_gross, d.sales_refunded, d.commission_net, d.adjustments, d.company_balance].map(Number), [100, 30, 7, 0, 63]);
      assert.deepEqual([d.gross_income, d.commissions, d.refunds].map(Number), [100, 7, 30]);
    });

    it('H47-2 · reembolso total: caja cobrada sigue en 100 (el pago REFUNDED cuenta), neto 0', async () => {
      const { bookingId, paymentId } = await venta();
      await reembolsoCompleto(paymentId, bookingId, 100);
      const caja = (await get('/payments/summary', ctx.sessions.admin.token)).body.data;
      assert.deepEqual([caja.cash_collected, caja.cash_refunded, caja.cash_net], ['100.00', '100.00', '0.00']);
      const conta = (await get('/financial-transactions/summary', ctx.sessions.admin.token)).body.data;
      assert.deepEqual([conta.sales_gross, conta.sales_refunded, conta.commission_net, conta.company_balance].map(Number), [100, 100, 0, 0]);
    });

    it('H47-3 · un reembolso PENDING no resta de la caja', async () => {
      const { bookingId, paymentId } = await venta();
      await reembolsar(paymentId, bookingId, 50);
      const caja = (await get('/payments/summary', ctx.sessions.admin.token)).body.data;
      assert.deepEqual([caja.cash_collected, caja.cash_refunded], ['100.00', '0.00']);
    });

    it('H47-4 · cada empresa ve solo lo suyo', async () => {
      const a = await venta(ctx.fixtures.tripA);
      await venta(ctx.fixtures.tripB);
      await reembolsoCompleto(a.paymentId, a.bookingId, 30);
      const b = (await get('/financial-transactions/summary', ctx.sessions.companyAdminB.token)).body.data;
      assert.deepEqual([b.sales_gross, b.sales_refunded, b.commission_net, b.company_balance].map(Number), [100, 0, 10, 90]);
      const cajaB = (await get('/payments/summary', ctx.sessions.companyAdminB.token)).body.data;
      assert.deepEqual([cajaB.cash_collected, cajaB.cash_refunded], ['100.00', '0.00']);
    });

    it('H47-5 · dashboards: ventas netas y comisión neta desde contabilidad; métodos de pago desde caja', async () => {
      const { bookingId, paymentId } = await venta();
      await reembolsoCompleto(paymentId, bookingId, 100);
      const { refundId } = await compensatorio();
      assert.equal((await procesar(refundId)).status, 200);

      const admin = (await get('/dashboard/admin', ctx.sessions.admin.token)).body.data;
      assert.deepEqual([admin.totals.revenue_total, admin.totals.commissions_total].map(Number), [0, 0]);
      const metodos = new Map<string, number>(admin.paymentMethods.map((m: { method: string; amount: string }) => [m.method, Number(m.amount)]));
      assert.equal(metodos.get('CASH'), 100, 'un pago REFUNDED sigue siendo dinero que entró');

      const empresa = (await get('/dashboard/company', ctx.sessions.companyAdmin.token)).body.data;
      assert.equal(Number(empresa.totals.sales_today), 100, 'la venta (luego reembolsada) sí; el compensatorio no');
      assert.deepEqual(empresa.paymentMethods.map((m: { method: string }) => m.method), ['CASH']);

      const reporte = (await get('/reports/payment-methods', ctx.sessions.companyAdmin.token)).body.data;
      assert.ok(reporte.rows.some((r: { label: string }) => r.label === 'CASH'), 'el reporte incluye pagos REFUNDED');
    });
  });

  // =====================================================================
  describe('H-48 · liquidación firmada', () => {
    async function liquidar(companyId = ctx.fixtures.companyA) {
      const d = await hoy();
      const res = await post('/settlements', { company_id: companyId, period_start: d, period_end: d }, ctx.sessions.admin.token);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const detalle = await get(`/settlements/${res.body.data.id}`, ctx.sessions.admin.token);
      return { s: res.body.data, items: detalle.body.data.items as Array<{ type: string; amount: string }> };
    }

    it('H48-1 · 100 − 10 − 30 + 3 = 63, y los ítems firmados suman el neto', async () => {
      const { bookingId, paymentId } = await venta();
      await reembolsoCompleto(paymentId, bookingId, 30);
      const { s, items } = await liquidar();
      assert.deepEqual([s.gross_amount, s.commission_amount, s.refund_amount, s.adjustment_amount, s.net_amount].map(Number), [100, 7, 30, 0, 63]);
      assert.deepEqual(items.map((i) => [i.type, Number(i.amount)]), [['SALE', 100], ['COMMISSION', -10], ['REFUND', -30], ['COMMISSION', 3]]);
      assert.equal(items.reduce((t, i) => t + toCentsExact(String(i.amount)), 0), 6300);
    });

    it('H48-2 · ADJUSTMENT entra con su signo; PAYOUT queda fuera', async () => {
      const { bookingId, paymentId } = await venta();
      await reembolsoCompleto(paymentId, bookingId, 30);
      const insertar = (type: string, direction: string, amount: string) =>
        execute(
          "INSERT INTO financial_transactions (company_id, booking_id, type, direction, amount, currency, status, transaction_date) VALUES (?, ?, ?, ?, ?, 'PEN', 'COMPLETED', NOW())",
          [ctx.fixtures.companyA, bookingId, type, direction, amount],
        );
      await insertar('ADJUSTMENT', 'CREDIT', '5.00');
      await insertar('ADJUSTMENT', 'DEBIT', '1.50');
      await insertar('PAYOUT', 'DEBIT', '40.00');
      const { s, items } = await liquidar();
      assert.deepEqual([s.adjustment_amount, s.net_amount].map(Number), [3.5, 66.5]);
      assert.ok(!items.some((i) => i.type === 'PAYOUT'));
      assert.deepEqual(items.filter((i) => i.type === 'ADJUSTMENT').map((i) => Number(i.amount)), [5, -1.5]);
    });

    it('H48-3 · empresas aisladas: la liquidación de A no incluye movimientos de B ni de la plataforma', async () => {
      await venta(ctx.fixtures.tripA);
      const b = await venta(ctx.fixtures.tripB);
      await reembolsoCompleto(b.paymentId, b.bookingId, 50);
      const { refundId } = await compensatorio();
      assert.equal((await procesar(refundId)).status, 200);

      const a = await liquidar(ctx.fixtures.companyA);
      assert.deepEqual([a.s.gross_amount, a.s.commission_amount, a.s.refund_amount, a.s.net_amount].map(Number), [100, 10, 0, 90]);
      const lb = await liquidar(ctx.fixtures.companyB);
      assert.deepEqual([lb.s.gross_amount, lb.s.commission_amount, lb.s.refund_amount, lb.s.net_amount].map(Number), [100, 5, 50, 45]);
    });

    it('H48-4 · un movimiento ya liquidado no entra en una segunda liquidación', async () => {
      await venta();
      const primera = await liquidar();
      const d = await hoy();
      // Otro periodo que incluye el mismo día (el mismo periodo devuelve la existente, F12-02).
      const res = await post('/settlements', { company_id: ctx.fixtures.companyA, period_start: '2020-01-01', period_end: d }, ctx.sessions.admin.token);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.notEqual(Number(res.body.data.id), Number(primera.s.id));
      assert.deepEqual([res.body.data.gross_amount, res.body.data.net_amount, res.body.data.items_count].map(Number), [0, 0, 0]);
    });
  });
});
