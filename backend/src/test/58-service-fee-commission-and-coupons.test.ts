import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { api, get, post, put } from './helpers/api';
import { env } from '../config/env';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { setCulqiApi, type CulqiApi, type CulqiCharge } from '../services/culqi.service';
import { toCentsExact } from '../utils/money';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

process.env.LOG_ERRORS = 'false';

/**
 * FASE 11E-3 · service fee, comisión por empresa y cupones de plataforma.
 *
 *   H-45 · el service fee es de BusPerú: no entra en la base de la comisión ni en el PAYMENT de la
 *          empresa; se asienta en el libro de la plataforma y se devuelve en proporción.
 *   H-46 · `platform.default_commission` se copia a la empresa al aprobarla; cambiarlo después no
 *          toca a las empresas existentes; sin configuración vigente no se vende.
 *   Cupones · el de la empresa lo absorbe la empresa; el de plataforma, BusPerú (ADJUSTMENT).
 *
 * Escenario: asiento S/ 100, service fee S/ 5, cupones de S/ 10, comisión 10 %. Sin red: efectivo
 * registrado por el ADMIN, y Culqi es un doble.
 */
describe('11E-3 · service fee, comisión por empresa y cupones', () => {
  let ctx: SuiteContext;
  let cargosPedidos = 0;
  const culqiFalso: CulqiApi = {
    async createCharge(input) {
      cargosPedidos += 1;
      return { ok: true, data: { id: `chr_test_58_${cargosPedidos}`, amount: input.amountCents, currency_code: 'PEN', outcome: { type: 'venta_exitosa', user_message: 'ok' } } as CulqiCharge };
    },
    async getCharge() {
      return { ok: false, kind: 'PROVIDER', code: null, userMessage: 'x', merchantMessage: 'x' };
    },
    async createRefund(input) {
      return { ok: true, data: { id: `ref_test_58_${input.chargeId}`, charge_id: input.chargeId, amount: input.amountCents } as never };
    },
  };

  before(async () => {
    ctx = await prepareSuite();
    const promocion = async (company_id: number | null, name: string) => {
      const res = await post(
        '/promotions',
        { ...(company_id === null ? {} : { company_id }), name, discount_type: 'FIXED_AMOUNT', discount_value: 10, start_at: '2020-01-01 00:00:00', end_at: '2035-12-31 23:59:59', status: 'ACTIVE' },
        ctx.sessions.admin.token,
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return Number(res.body.data.id);
    };
    const cupon = async (promotion_id: number, code: string) =>
      assert.equal((await post('/coupons', { promotion_id, code, status: 'ACTIVE' }, ctx.sessions.admin.token)).status, 201);
    await cupon(await promocion(ctx.fixtures.companyA, 'Promo A 58'), 'EMPA58');
    await cupon(await promocion(ctx.fixtures.companyB, 'Promo B 58'), 'EMPB58');
    const global = await promocion(null, 'Promo plataforma 58');
    await execute('UPDATE promotions SET company_id = NULL WHERE id = ?', [global]);
    await cupon(global, 'PLAT58');
  });
  after(async () => {
    setCulqiApi(null);
    await teardownSuite();
  });
  beforeEach(async () => {
    cargosPedidos = 0;
    setCulqiApi(culqiFalso);
    for (const tabla of ['settlement_items', 'settlements', 'financial_transactions', 'refunds', 'coupon_usages', 'booking_seats', 'payments', 'notifications', 'bookings', 'booking_groups']) {
      await execute(`DELETE FROM ${tabla}`);
    }
    await execute("UPDATE trips t JOIN buses b ON b.id = t.bus_id SET t.available_seats = b.capacity, t.status = 'SCHEDULED'");
    await execute('UPDATE trips SET base_price = 100.00 WHERE id IN (?, ?)', [ctx.fixtures.tripA, ctx.fixtures.tripB]);
    await execute("UPDATE system_settings SET setting_value = '5.00' WHERE setting_key = 'booking.service_fee'");
    await execute('UPDATE coupons SET usage_count = 0');
    await execute('UPDATE promotions SET usage_count = 0');
    await execute("DELETE FROM company_commission_settings WHERE company_id IN (?, ?)", [ctx.fixtures.companyA, ctx.fixtures.companyB]);
    for (const company of [ctx.fixtures.companyA, ctx.fixtures.companyB]) {
      await execute(
        "INSERT INTO company_commission_settings (company_id, commission_type, commission_value, effective_from, status) VALUES (?, 'PERCENTAGE', 10.00, DATE_SUB(NOW(), INTERVAL 1 DAY), 'ACTIVE')",
        [company],
      );
    }
    await execute("UPDATE system_settings SET setting_value = '10.00' WHERE setting_key = 'platform.default_commission'");
  });
  afterEach(() => {
    setCulqiApi(null);
    env.culqi.publicKey = '';
    env.culqi.privateKey = '';
  });

  /* ------------------------------------------------------------------ utilidades */

  const reservar = async (tripId: number, extra: Record<string, unknown> = {}) =>
    post('/bookings', { trip_id: tripId, seat_ids: [at(await freeSeats(tripId), 0).id], passenger_email: 'cliente@test.pe', ...extra }, ctx.sessions.customer.token);

  async function venta(tripId = ctx.fixtures.tripA, coupon_code?: string) {
    const res = await reservar(tripId, coupon_code ? { coupon_code } : {});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const bookingId = Number(res.body.data.id);
    const pagado = await post(`/bookings/${bookingId}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);
    assert.equal(pagado.status, 200, JSON.stringify(pagado.body));
    const pago = await queryOne<{ id: number; amount: string }>("SELECT id, amount FROM payments WHERE booking_id = ? AND status = 'PAID'", [bookingId]);
    return { bookingId, paymentId: Number(pago!.id), amountCents: toCentsExact(pago!.amount) };
  }

  /** Movimientos de un pago como [libro, tipo, dirección, céntimos], en orden de alta. */
  const libro = async (paymentId: number) =>
    (
      await query<{ company_id: number | null; type: string; direction: string; amount: string }>(
        'SELECT company_id, type, direction, amount FROM financial_transactions WHERE payment_id = ? ORDER BY id',
        [paymentId],
      )
    ).map((m) => [m.company_id === null ? 'plataforma' : 'empresa', m.type, m.direction, toCentsExact(m.amount)] as const);

  /** Saldo firmado de un libro para un pago (CREDIT +, DEBIT −). */
  const saldo = async (paymentId: number, deEmpresa: boolean) =>
    (await libro(paymentId))
      .filter((m) => (m[0] === 'empresa') === deEmpresa)
      .reduce((total, m) => total + (m[2] === 'CREDIT' ? m[3] : -m[3]), 0);

  const suma = async (paymentId: number, dueño: 'empresa' | 'plataforma', type: string, direction: string) =>
    (await libro(paymentId)).filter((m) => m[0] === dueño && m[1] === type && m[2] === direction).reduce((t, m) => t + m[3], 0);

  async function reembolsoCompleto(paymentId: number, bookingId: number, amount: number) {
    const creado = await post('/refunds', { payment_id: paymentId, booking_id: bookingId, amount, reason: 'prueba 11E-3' }, ctx.sessions.admin.token);
    assert.equal(creado.status, 201, JSON.stringify(creado.body));
    const res = await api(`/refunds/${creado.body.data.id}/process`, { method: 'POST', body: { status: 'COMPLETED' }, token: ctx.sessions.admin.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  const estadoPago = async (paymentId: number) => (await queryOne<{ status: string }>('SELECT status FROM payments WHERE id = ?', [paymentId]))?.status;
  const hoy = async () => (await queryOne<{ d: string }>("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS d"))!.d;
  const liquidar = async (companyId: number) => {
    const d = await hoy();
    const res = await post('/settlements', { company_id: companyId, period_start: d, period_end: d }, ctx.sessions.admin.token);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data as { gross_amount: string; commission_amount: string; refund_amount: string; adjustment_amount: string; net_amount: string };
  };
  const tasaDe = async (companyId: number) =>
    query<{ commission_type: string; commission_value: string | number }>(
      "SELECT commission_type, commission_value FROM company_commission_settings WHERE company_id = ? AND status = 'ACTIVE' ORDER BY id",
      [companyId],
    );
  async function empresaPendiente(tax: string): Promise<number> {
    return (await execute("INSERT INTO companies (name, legal_name, tax_id, email, status) VALUES (?, ?, ?, ?, 'PENDING')", [`Nueva ${tax}`, `Nueva ${tax} SAC`, tax, `${tax}@test.pe`])).insertId;
  }

  // =====================================================================
  describe('H-45 · service fee', () => {
    it('H45-1 · viaje 100 + fee 5: el pasajero paga 105, la empresa 100 con comisión 10, BusPerú conserva 5', async () => {
      const { paymentId, amountCents } = await venta();
      assert.equal(amountCents, 10500, 'el pasajero paga el viaje más el service fee');
      assert.deepEqual(await libro(paymentId), [
        ['empresa', 'PAYMENT', 'CREDIT', 10000],
        ['empresa', 'COMMISSION', 'DEBIT', 1000],
        ['plataforma', 'PAYMENT', 'CREDIT', 500],
      ]);
      assert.equal(await saldo(paymentId, true), 9000);
      assert.equal(await saldo(paymentId, false), 500);

      const caja = (await get('/payments/summary', ctx.sessions.admin.token)).body.data;
      assert.equal(caja.cash_collected, '105.00');
      const empresa = (await get('/financial-transactions/summary', ctx.sessions.companyAdmin.token)).body.data;
      assert.deepEqual([empresa.sales_gross, empresa.commission_net, empresa.company_balance].map(Number), [100, 10, 90]);
      assert.equal(empresa.platform_service_fees, undefined, 'el libro de la plataforma no se expone a la empresa');
      const admin = (await get('/financial-transactions/summary', ctx.sessions.admin.token)).body.data;
      assert.deepEqual([admin.platform_service_fees, admin.platform_sales_balance, admin.compensations_collected].map(Number), [5, 5, 0]);
      const s = await liquidar(ctx.fixtures.companyA);
      assert.deepEqual([s.gross_amount, s.commission_amount, s.net_amount].map(Number), [100, 10, 90]);
    });

    it('H45-2 · reembolso total de 105: empresa y plataforma vuelven a cero, comisión revertida entera', async () => {
      const { bookingId, paymentId } = await venta();
      await reembolsoCompleto(paymentId, bookingId, 105);
      assert.equal(await estadoPago(paymentId), 'REFUNDED');
      assert.equal(await suma(paymentId, 'empresa', 'REFUND', 'DEBIT'), 10000);
      assert.equal(await suma(paymentId, 'plataforma', 'REFUND', 'DEBIT'), 500);
      assert.equal(await suma(paymentId, 'empresa', 'COMMISSION', 'CREDIT'), 1000);
      assert.deepEqual([await saldo(paymentId, true), await saldo(paymentId, false)], [0, 0]);
      const refunds = (await libro(paymentId)).filter((m) => m[1] === 'REFUND').reduce((t, m) => t + m[3], 0);
      assert.equal(refunds, 10500, 'los REFUND suman exactamente lo devuelto');
    });

    it('H45-3 · parciales 35 + 70: reparto proporcional, comisión H-27 exacta y el fee se devuelve una sola vez', async () => {
      const { bookingId, paymentId } = await venta();
      await reembolsoCompleto(paymentId, bookingId, 35);
      assert.equal(await estadoPago(paymentId), 'PAID', 'H-28: queda saldo');
      assert.equal(await suma(paymentId, 'empresa', 'REFUND', 'DEBIT'), 3333, 'round(10000 × 3500 / 10500)');
      assert.equal(await suma(paymentId, 'plataforma', 'REFUND', 'DEBIT'), 167);
      assert.equal(await suma(paymentId, 'empresa', 'COMMISSION', 'CREDIT'), 333, 'round(1000 × 3500 / 10500)');

      await reembolsoCompleto(paymentId, bookingId, 70);
      assert.equal(await estadoPago(paymentId), 'REFUNDED');
      assert.equal(await suma(paymentId, 'empresa', 'REFUND', 'DEBIT'), 10000);
      assert.equal(await suma(paymentId, 'plataforma', 'REFUND', 'DEBIT'), 500, 'el fee nunca se devuelve de más');
      assert.equal(await suma(paymentId, 'empresa', 'COMMISSION', 'CREDIT'), 1000);
      assert.deepEqual([await saldo(paymentId, true), await saldo(paymentId, false)], [0, 0]);

      const excedido = await post('/refunds', { payment_id: paymentId, booking_id: bookingId, amount: 0.01, reason: 'x' }, ctx.sessions.admin.token);
      assert.equal(excedido.status, 400, 'H-44 sigue protegiendo el límite');
    });

    it('H45-3b · tres parciales 33.33 + 33.33 + 38.34: nunca se devuelve más fee del cobrado', async () => {
      const { bookingId, paymentId } = await venta();
      for (const parte of [33.33, 33.33, 38.34]) {
        await reembolsoCompleto(paymentId, bookingId, parte);
        assert.ok((await suma(paymentId, 'plataforma', 'REFUND', 'DEBIT')) <= 500);
        assert.ok((await suma(paymentId, 'empresa', 'REFUND', 'DEBIT')) <= 10000);
      }
      assert.deepEqual([await saldo(paymentId, true), await saldo(paymentId, false)], [0, 0]);
    });

    it('H45-4 · cancelar una reserva pagada abre el reembolso de 105 (H-50) y procesarlo deja todo en cero', async () => {
      const { bookingId, paymentId } = await venta();
      const res = await api(`/bookings/${bookingId}/cancel`, { method: 'POST', body: {}, token: ctx.sessions.customer.token });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const refunds = await query<{ id: number; amount: string; status: string }>('SELECT id, amount, status FROM refunds WHERE payment_id = ?', [paymentId]);
      assert.deepEqual(refunds.map((r) => [toCentsExact(r.amount), r.status]), [[10500, 'PENDING']], 'devolución total, service fee incluido');
      assert.equal((await api(`/refunds/${refunds[0]!.id}/process`, { method: 'POST', body: { status: 'COMPLETED' }, token: ctx.sessions.admin.token })).status, 200);
      assert.deepEqual([await saldo(paymentId, true), await saldo(paymentId, false)], [0, 0]);
    });

    it('H45-5 · sin service fee el asiento de la venta es el de siempre (sin movimientos de plataforma)', async () => {
      await execute("UPDATE system_settings SET setting_value = '0.00' WHERE setting_key = 'booking.service_fee'");
      const { paymentId } = await venta();
      assert.deepEqual(await libro(paymentId), [['empresa', 'PAYMENT', 'CREDIT', 10000], ['empresa', 'COMMISSION', 'DEBIT', 1000]]);
    });

    it('H45-6 · una venta anterior a 11E-3 (PAYMENT de empresa por el total) se reembolsa como antes', async () => {
      const { bookingId, paymentId } = await venta();
      // Se reescribe el asiento con el modelo antiguo: todo el cobro en la empresa, sin fee de plataforma.
      await execute("DELETE FROM financial_transactions WHERE payment_id = ? AND company_id IS NULL", [paymentId]);
      await execute("UPDATE financial_transactions SET amount = 105.00 WHERE payment_id = ? AND type = 'PAYMENT'", [paymentId]);
      await execute("UPDATE financial_transactions SET amount = 10.50 WHERE payment_id = ? AND type = 'COMMISSION'", [paymentId]);
      await reembolsoCompleto(paymentId, bookingId, 105);
      assert.equal(await suma(paymentId, 'empresa', 'REFUND', 'DEBIT'), 10500);
      assert.equal(await suma(paymentId, 'empresa', 'COMMISSION', 'CREDIT'), 1050);
      assert.deepEqual((await libro(paymentId)).filter((m) => m[0] === 'plataforma'), []);
    });

    it('H45-7 · si los movimientos de la venta no cuadran, el reembolso se detiene antes de devolver nada', async () => {
      const { bookingId, paymentId } = await venta();
      await execute("UPDATE financial_transactions SET amount = 99.00 WHERE payment_id = ? AND type = 'PAYMENT' AND company_id IS NOT NULL", [paymentId]);
      const creado = await post('/refunds', { payment_id: paymentId, booking_id: bookingId, amount: 105, reason: 'x' }, ctx.sessions.admin.token);
      const res = await api(`/refunds/${creado.body.data.id}/process`, { method: 'POST', body: { status: 'COMPLETED' }, token: ctx.sessions.admin.token });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.doesNotMatch(String(res.body.message), /financial_transactions|SELECT/);
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM refunds WHERE id = ?', [creado.body.data.id]))?.status, 'PENDING');
      assert.equal((await libro(paymentId)).filter((m) => m[1] === 'REFUND').length, 0);
    });
  });

  // =====================================================================
  describe('H-46 · comisión por defecto y configuración por empresa', () => {
    it('H46-1 · aprobar una empresa con default 10 % le crea su configuración de 10 %', async () => {
      const id = await empresaPendiente('20333333333');
      assert.deepEqual(await tasaDe(id), []);
      const res = await put(`/companies/${id}`, { status: 'ACTIVE' }, ctx.sessions.admin.token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual((await tasaDe(id)).map((t) => [t.commission_type, Number(t.commission_value)]), [['PERCENTAGE', 10]]);
      assert.equal((await put(`/companies/${id}`, { status: 'ACTIVE' }, ctx.sessions.admin.token)).status, 200);
      assert.equal((await tasaDe(id)).length, 1, 'aprobar de nuevo no duplica la configuración');
    });

    it('H46-2 / H46-3 · cambiar el default a 12.5 %: la existente sigue en 10 %, la nueva recibe 12.5 %', async () => {
      const antigua = await empresaPendiente('20444444444');
      assert.equal((await put(`/companies/${antigua}`, { status: 'ACTIVE' }, ctx.sessions.admin.token)).status, 200);

      const ajuste = await queryOne<{ id: number }>("SELECT id FROM system_settings WHERE setting_key = 'platform.default_commission'");
      const cambio = await put(`/system-settings/${ajuste!.id}`, { setting_value: '12.50' }, ctx.sessions.admin.token);
      assert.equal(cambio.status, 200, JSON.stringify(cambio.body));

      assert.deepEqual((await tasaDe(antigua)).map((t) => Number(t.commission_value)), [10], 'no retroactivo');
      assert.deepEqual((await tasaDe(ctx.fixtures.companyA)).map((t) => Number(t.commission_value)), [10]);

      const nueva = await empresaPendiente('20555555555');
      assert.equal((await put(`/companies/${nueva}`, { status: 'ACTIVE' }, ctx.sessions.admin.token)).status, 200);
      assert.deepEqual((await tasaDe(nueva)).map((t) => Number(t.commission_value)), [12.5]);

      const creada = await post('/companies', { name: 'Alta directa', tax_id: '20666666666', status: 'ACTIVE' }, ctx.sessions.admin.token);
      assert.equal(creada.status, 201, JSON.stringify(creada.body));
      assert.deepEqual((await tasaDe(Number(creada.body.data.id))).map((t) => Number(t.commission_value)), [12.5], 'una empresa creada ya activa también la recibe');
    });

    it('H46-3b · reactivar una empresa suspendida conserva su tasa', async () => {
      await execute("UPDATE system_settings SET setting_value = '20.00' WHERE setting_key = 'platform.default_commission'");
      assert.equal((await put(`/companies/${ctx.fixtures.companyB}`, { status: 'SUSPENDED' }, ctx.sessions.admin.token)).status, 200);
      assert.equal((await put(`/companies/${ctx.fixtures.companyB}`, { status: 'ACTIVE' }, ctx.sessions.admin.token)).status, 200);
      assert.deepEqual((await tasaDe(ctx.fixtures.companyB)).map((t) => Number(t.commission_value)), [10]);
    });

    it('H46-3c · con un default inválido la aprobación se rechaza sin activar la empresa', async () => {
      const id = await empresaPendiente('20777777777');
      for (const valor of ['', 'abc', '150', '-1', '10.555']) {
        await execute("UPDATE system_settings SET setting_value = ? WHERE setting_key = 'platform.default_commission'", [valor]);
        const res = await put(`/companies/${id}`, { status: 'ACTIVE' }, ctx.sessions.admin.token);
        assert.equal(res.status, 409, `${valor} -> ${res.status}`);
      }
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM companies WHERE id = ?', [id]))?.status, 'PENDING');
      assert.deepEqual(await tasaDe(id), []);
    });

    it('H46-4 · empresa activa sin configuración: ni reserva, ni confirmación, ni cargo; nunca comisión 0', async () => {
      // Una reserva pendiente creada mientras la empresa aún tenía tasa.
      const pendiente = await reservar(ctx.fixtures.tripB);
      assert.equal(pendiente.status, 201);
      await execute('DELETE FROM company_commission_settings WHERE company_id = ?', [ctx.fixtures.companyB]);

      const nueva = await reservar(ctx.fixtures.tripB);
      assert.equal(nueva.status, 409, JSON.stringify(nueva.body));
      assert.doesNotMatch(String(nueva.body.message), /company_commission|SQL|sk_/i, 'sin detalles internos');
      assert.equal((await query('SELECT id FROM bookings')).length, 1, 'no se crea la reserva');

      const pago = await post(`/bookings/${pendiente.body.data.id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);
      assert.equal(pago.status, 409, JSON.stringify(pago.body));
      assert.deepEqual(await query('SELECT id FROM financial_transactions'), [], 'ningún movimiento, tampoco una comisión 0');
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [pendiente.body.data.id]))?.status, 'PENDING');

      env.culqi.publicKey = 'pk_test_solo_para_pruebas';
      env.culqi.privateKey = 'sk_test_solo_para_pruebas';
      const tarjeta = await post(`/bookings/${pendiente.body.data.id}/pay`, { method: 'CARD', token: 'tkn_test_58_000001' }, ctx.sessions.customer.token);
      assert.equal(tarjeta.status, 409, JSON.stringify(tarjeta.body));
      assert.equal(cargosPedidos, 0, 'no se pide ningún cargo a Culqi');

      // Una configuración INACTIVE o ya vencida tampoco vale.
      await execute(
        "INSERT INTO company_commission_settings (company_id, commission_type, commission_value, effective_from, effective_until, status) VALUES (?, 'PERCENTAGE', 10.00, '2020-01-01', '2021-01-01', 'ACTIVE')",
        [ctx.fixtures.companyB],
      );
      assert.equal((await reservar(ctx.fixtures.tripB)).status, 409);
    });

    it('H46-5 · cambiar la tasa de la empresa: las ventas nuevas usan la nueva y las anteriores conservan la suya', async () => {
      const antes = await venta();
      const fila = await queryOne<{ id: number }>("SELECT id FROM company_commission_settings WHERE company_id = ? AND status = 'ACTIVE'", [ctx.fixtures.companyA]);
      const cambio = await put(`/commissions/${fila!.id}`, { commission_value: 15 }, ctx.sessions.admin.token);
      assert.equal(cambio.status, 200, JSON.stringify(cambio.body));
      const despues = await venta();
      assert.equal(await suma(antes.paymentId, 'empresa', 'COMMISSION', 'DEBIT'), 1000);
      assert.equal(await suma(despues.paymentId, 'empresa', 'COMMISSION', 'DEBIT'), 1500);

      // La reversión de la venta anterior sigue usando SU comisión original.
      await reembolsoCompleto(antes.paymentId, antes.bookingId, 105);
      assert.equal(await suma(antes.paymentId, 'empresa', 'COMMISSION', 'CREDIT'), 1000);
    });

    it('H46-6 · el valor por defecto no se usa al vender: una empresa con tasa propia vende con la suya', async () => {
      await execute("UPDATE system_settings SET setting_value = '50.00' WHERE setting_key = 'platform.default_commission'");
      const { paymentId } = await venta();
      assert.equal(await suma(paymentId, 'empresa', 'COMMISSION', 'DEBIT'), 1000);
    });
  });

  // =====================================================================
  describe('Cupones de empresa y de plataforma', () => {
    it('C1 · cupón de la empresa A en un viaje de A: permitido', async () => {
      const res = await reservar(ctx.fixtures.tripA, { coupon_code: 'EMPA58' });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(Number(res.body.data.discount_amount), 10);
    });

    it('C2 · cupón de la empresa A en un viaje de B: rechazado (H-49)', async () => {
      const res = await reservar(ctx.fixtures.tripB, { coupon_code: 'EMPA58' });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.deepEqual(await query('SELECT id FROM bookings'), []);
    });

    it('C3 / C4 · cupón de plataforma en viajes de A y de B: permitido', async () => {
      for (const tripId of [ctx.fixtures.tripA, ctx.fixtures.tripB]) {
        const res = await reservar(tripId, { coupon_code: 'PLAT58' });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(Number(res.body.data.discount_amount), 10);
      }
    });

    it('C5 · cupón de plataforma: la empresa cobra su base entera y BusPerú absorbe el descuento', async () => {
      const { bookingId, paymentId, amountCents } = await venta(ctx.fixtures.tripA, 'PLAT58');
      assert.equal(amountCents, 9500, 'el pasajero paga 100 − 10 + 5');
      assert.deepEqual(await libro(paymentId), [
        ['empresa', 'PAYMENT', 'CREDIT', 10000],
        ['empresa', 'COMMISSION', 'DEBIT', 1000],
        ['plataforma', 'PAYMENT', 'CREDIT', 500],
        ['plataforma', 'ADJUSTMENT', 'DEBIT', 1000],
      ]);
      assert.equal(await saldo(paymentId, true), 9000, 'la empresa no absorbe el descuento');
      assert.equal(await saldo(paymentId, false), -500, 'BusPerú: fee 5 − subsidio 10');
      const s = await liquidar(ctx.fixtures.companyA);
      assert.deepEqual([s.gross_amount, s.commission_amount, s.adjustment_amount, s.net_amount].map(Number), [100, 10, 0, 90]);
      const admin = (await get('/financial-transactions/summary', ctx.sessions.admin.token)).body.data;
      assert.deepEqual([admin.platform_coupon_subsidies, admin.platform_service_fees, admin.compensations_collected].map(Number), [10, 5, 0]);

      // Reembolso total: la empresa devuelve su caja y el subsidio; la plataforma lo recupera.
      await reembolsoCompleto(paymentId, bookingId, 95);
      assert.equal(await suma(paymentId, 'empresa', 'REFUND', 'DEBIT'), 9000);
      assert.equal(await suma(paymentId, 'empresa', 'ADJUSTMENT', 'DEBIT'), 1000);
      assert.equal(await suma(paymentId, 'plataforma', 'REFUND', 'DEBIT'), 500);
      assert.equal(await suma(paymentId, 'plataforma', 'ADJUSTMENT', 'CREDIT'), 1000);
      assert.deepEqual([await saldo(paymentId, true), await saldo(paymentId, false)], [0, 0]);
      const refunds = (await libro(paymentId)).filter((m) => m[1] === 'REFUND').reduce((t, m) => t + m[3], 0);
      assert.equal(refunds, 9500, 'los REFUND suman lo devuelto al pasajero');
    });

    it('C5b · cupón de plataforma con reembolso parcial: subsidio y fee proporcionales, cuadre exacto al completar', async () => {
      const { bookingId, paymentId } = await venta(ctx.fixtures.tripA, 'PLAT58');
      await reembolsoCompleto(paymentId, bookingId, 47.5);
      assert.equal(await suma(paymentId, 'empresa', 'REFUND', 'DEBIT'), 4500);
      assert.equal(await suma(paymentId, 'plataforma', 'REFUND', 'DEBIT'), 250);
      assert.equal(await suma(paymentId, 'empresa', 'ADJUSTMENT', 'DEBIT'), 500);
      assert.equal(await suma(paymentId, 'empresa', 'COMMISSION', 'CREDIT'), 500);
      assert.equal(await estadoPago(paymentId), 'PAID');
      await reembolsoCompleto(paymentId, bookingId, 47.5);
      assert.deepEqual([await saldo(paymentId, true), await saldo(paymentId, false)], [0, 0]);
      assert.equal(await estadoPago(paymentId), 'REFUNDED');
    });

    it('C6 · cupón de empresa: el descuento reduce la base y la comisión de la empresa', async () => {
      const { paymentId, amountCents } = await venta(ctx.fixtures.tripA, 'EMPA58');
      assert.equal(amountCents, 9500);
      assert.deepEqual(await libro(paymentId), [
        ['empresa', 'PAYMENT', 'CREDIT', 9000],
        ['empresa', 'COMMISSION', 'DEBIT', 900],
        ['plataforma', 'PAYMENT', 'CREDIT', 500],
      ]);
      const s = await liquidar(ctx.fixtures.companyA);
      assert.deepEqual([s.gross_amount, s.commission_amount, s.net_amount].map(Number), [90, 9, 81]);
    });

    it('C7 · cada empresa liquida lo suyo con cupones mezclados', async () => {
      await venta(ctx.fixtures.tripA, 'PLAT58');
      await venta(ctx.fixtures.tripB, 'EMPB58');
      await venta(ctx.fixtures.tripB);
      const a = await liquidar(ctx.fixtures.companyA);
      const b = await liquidar(ctx.fixtures.companyB);
      assert.deepEqual([a.gross_amount, a.net_amount].map(Number), [100, 90]);
      assert.deepEqual([b.gross_amount, b.commission_amount, b.net_amount].map(Number), [190, 19, 171]);
    });
  });
});
