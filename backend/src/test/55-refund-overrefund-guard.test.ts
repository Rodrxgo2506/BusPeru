import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { api, post } from './helpers/api';
import { env } from '../config/env';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { expireDueBookings } from '../services/booking-expiry.service';
import { setCulqiApi, type CulqiApi, type CulqiCharge } from '../services/culqi.service';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

process.env.LOG_ERRORS = 'false';

/**
 * H-44 · un reembolso no puede devolver más de lo cobrado.
 *
 * POR QUÉ EXISTE. La auditoría 11C comprobó que `POST /refunds/:id/process` solo impedía
 * reprocesar un reembolso COMPLETED. Un reembolso CANCELLED o FAILED liberaba su importe para
 * crear otro y después también podía completarse: un pago de S/ 100 acababa con S/ 200
 * reembolsados, dos devoluciones a Culqi y dos movimientos REFUND. Además la devolución se
 * pedía a Culqi ANTES de comprobar el estado, y el cerrojo era por reembolso, no por pago.
 *
 * Invariantes que se defienden: CANCELLED y FAILED son terminales; nunca Σ reembolsos
 * COMPLETED > importe del pago, tampoco con procesamientos simultáneos; nunca se pide a Culqi una
 * devolución que exceda lo cobrado ni se repite la misma; todo COMPLETED de un cargo de Culqi
 * lleva su `provider_refund_id`. Culqi es un doble: nada sale a la red.
 */
describe('H-44 · guarda contra sobre-reembolsos', () => {
  let ctx: SuiteContext;
  const TOKEN = 'tkn_test_h44_000001';
  const SECRET = 'secreto-webhook-h44';
  let seq = 0;
  const cargos = new Map<string, { amountCents: number; paymentId: number; bookingId: number }>();
  const devoluciones: Array<{ chargeId: string; amountCents: number }> = [];
  let modoCargo: 'ok' | 'timeout' = 'ok';
  let modoDevolucion: 'ok' | 'falla' = 'ok';
  const demoraDevolucionMs = 60;

  const culqiFalso: CulqiApi = {
    async createCharge(input) {
      seq += 1;
      const id = `chr_test_h44_${seq}`;
      cargos.set(id, { amountCents: input.amountCents, paymentId: Number(input.metadata?.payment_id), bookingId: Number(input.metadata?.booking_id) });
      if (modoCargo === 'timeout') return { ok: false, kind: 'TIMEOUT', code: null, userMessage: 'x', merchantMessage: 'x' };
      return { ok: true, data: { id, amount: input.amountCents, currency_code: 'PEN', outcome: { type: 'venta_exitosa', user_message: 'ok' } } as CulqiCharge };
    },
    async getCharge(id) {
      const c = cargos.get(id);
      if (!c) return { ok: false, kind: 'PROVIDER', code: null, userMessage: 'x', merchantMessage: 'x' };
      return {
        ok: true,
        data: { id, amount: c.amountCents, currency_code: 'PEN', outcome: { type: 'venta_exitosa', user_message: 'ok' }, metadata: { payment_id: String(c.paymentId), booking_id: String(c.bookingId) } } as unknown as CulqiCharge,
      };
    },
    async createRefund(input) {
      // Una demora corta ensancha la ventana en la que dos procesamientos se solaparían.
      await new Promise((resolve) => setTimeout(resolve, demoraDevolucionMs));
      if (modoDevolucion === 'falla') return { ok: false, kind: 'PROVIDER', code: null, userMessage: 'Culqi no pudo devolver', merchantMessage: 'fallo de prueba' };
      devoluciones.push({ chargeId: input.chargeId, amountCents: input.amountCents });
      return { ok: true, data: { id: `ref_test_h44_${devoluciones.length}`, charge_id: input.chargeId, amount: input.amountCents } as never };
    },
  };

  before(async () => {
    ctx = await prepareSuite();
    // Los casos de la auditoría hablan de un pago de S/ 100: asiento 97,50 + tarifa de servicio 2,50.
    await execute('UPDATE trips SET base_price = 97.50 WHERE id = ?', [ctx.fixtures.tripA]);
  });
  after(async () => {
    setCulqiApi(null);
    await teardownSuite();
  });
  beforeEach(async () => {
    cargos.clear();
    devoluciones.length = 0;
    modoCargo = 'ok';
    modoDevolucion = 'ok';
    setCulqiApi(culqiFalso);
    env.culqi.publicKey = 'pk_test_solo_para_pruebas';
    env.culqi.privateKey = 'sk_test_solo_para_pruebas';
    env.culqi.webhookSecret = SECRET;
    for (const tabla of ['settlement_items', 'financial_transactions', 'refunds', 'coupon_usages', 'booking_seats', 'payments', 'notifications', 'bookings', 'booking_groups']) {
      await execute(`DELETE FROM ${tabla}`);
    }
    await execute("UPDATE trips t JOIN buses b ON b.id = t.bus_id SET t.available_seats = b.capacity, t.status = 'SCHEDULED'");
  });
  afterEach(() => {
    setCulqiApi(null);
    env.culqi.publicKey = '';
    env.culqi.privateKey = '';
    env.culqi.webhookSecret = '';
  });

  /* ------------------------------------------------------------------ utilidades */

  async function reservar(): Promise<number> {
    const res = await post(
      '/bookings',
      { trip_id: ctx.fixtures.tripA, seat_ids: [at(await freeSeats(ctx.fixtures.tripA), 0).id], passenger_email: 'cliente@test.pe' },
      ctx.sessions.customer.token,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return Number(res.body.data.id);
  }

  /** Venta con tarjeta cobrada por Culqi. */
  async function ventaTarjeta() {
    const bookingId = await reservar();
    assert.equal((await post(`/bookings/${bookingId}/pay`, { method: 'CARD', token: TOKEN }, ctx.sessions.customer.token)).status, 200);
    const pago = await queryOne<{ id: number; amount: string }>("SELECT id, amount FROM payments WHERE booking_id = ? AND status = 'PAID'", [bookingId]);
    assert.equal(Number(pago!.amount), 100, 'el escenario es un pago de S/ 100');
    return { bookingId, paymentId: Number(pago!.id), amount: Number(pago!.amount) };
  }

  /** Venta en efectivo registrada por el backoffice: sin pasarela. */
  async function ventaManual() {
    const bookingId = await reservar();
    assert.equal((await post(`/bookings/${bookingId}/pay`, { method: 'CASH' }, ctx.sessions.admin.token)).status, 200);
    const pago = await queryOne<{ id: number; amount: string }>("SELECT id, amount FROM payments WHERE booking_id = ? AND status = 'PAID'", [bookingId]);
    return { bookingId, paymentId: Number(pago!.id), amount: Number(pago!.amount) };
  }

  const crear = (paymentId: number, bookingId: number, amount: number) =>
    post('/refunds', { payment_id: paymentId, booking_id: bookingId, amount, reason: 'prueba H-44' }, ctx.sessions.admin.token);
  const procesar = (refundId: number, status: string = 'COMPLETED') =>
    api(`/refunds/${refundId}/process`, { method: 'POST', body: { status }, token: ctx.sessions.admin.token });

  /**
   * Un segundo reembolso VIVO sobre el mismo pago que la API ya no dejaría crear. Representa lo
   * que dejaron datos anteriores a esta fase o una carrera en el alta: el procesamiento tiene que
   * defender el límite por sí solo.
   */
  async function reembolsoDirecto(paymentId: number, bookingId: number, amount: number): Promise<number> {
    const r = await execute(
      "INSERT INTO refunds (payment_id, booking_id, amount, reason, status) VALUES (?, ?, ?, 'insertado para la prueba', 'PENDING')",
      [paymentId, bookingId, amount],
    );
    return r.insertId;
  }

  const refund = (id: number) =>
    queryOne<{ status: string; amount: string; provider_refund_id: string | null; processed_at: string | null }>(
      'SELECT status, amount, provider_refund_id, processed_at FROM refunds WHERE id = ?',
      [id],
    );
  const totalCompletado = async (paymentId: number) =>
    Number((await queryOne<{ t: string }>("SELECT COALESCE(SUM(amount), 0) AS t FROM refunds WHERE payment_id = ? AND status = 'COMPLETED'", [paymentId]))?.t);
  const movimientosRefund = async (paymentId: number) =>
    Number((await queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM financial_transactions WHERE payment_id = ? AND type = 'REFUND' AND company_id IS NOT NULL", [paymentId]))?.n);
  const devueltoCulqiCents = () => devoluciones.reduce((s, d) => s + d.amountCents, 0);

  /** Invariantes globales de H-44 sobre toda la base de pruebas. */
  async function invariantes() {
    const excedidos = await query(
      `SELECT p.id FROM payments p
       WHERE (SELECT COALESCE(SUM(rf.amount), 0) FROM refunds rf WHERE rf.payment_id = p.id AND rf.status = 'COMPLETED') > p.amount`,
    );
    assert.deepEqual(excedidos, [], 'nunca Σ reembolsos COMPLETED > importe del pago');
    const sinId = await query(
      `SELECT rf.id FROM refunds rf JOIN payments p ON p.id = rf.payment_id
       WHERE rf.status = 'COMPLETED' AND rf.provider_refund_id IS NULL AND (p.provider = 'CULQI' OR p.provider_transaction_id LIKE 'chr\\_%')`,
    );
    assert.deepEqual(sinId, [], 'todo reembolso COMPLETED de un cargo de Culqi tiene provider_refund_id');
    const movimientosDeMas = await query(
      `SELECT p.id FROM payments p
       WHERE (SELECT COALESCE(SUM(f.amount), 0) FROM financial_transactions f WHERE f.payment_id = p.id AND f.type = 'REFUND') > p.amount`,
    );
    assert.deepEqual(movimientosDeMas, [], 'nunca Σ movimientos REFUND > importe del pago');
  }

  // =====================================================================
  describe('Estados terminales', () => {
    it('1 · un reembolso CANCELLED no se puede procesar después: ni Culqi, ni movimiento', async () => {
      const { bookingId, paymentId, amount } = await ventaTarjeta();
      const r = await crear(paymentId, bookingId, amount);
      const id = Number(r.body.data.id);
      assert.equal((await procesar(id, 'CANCELLED')).status, 200);

      for (const status of ['COMPLETED', 'FAILED', 'CANCELLED']) {
        const res = await procesar(id, status);
        assert.ok([400, 409].includes(res.status), `${status} -> ${res.status}`);
      }
      assert.equal((await refund(id))?.status, 'CANCELLED');
      assert.equal(devoluciones.length, 0, 'no se pidió ninguna devolución a Culqi');
      assert.equal(await movimientosRefund(paymentId), 0);
      await invariantes();
    });

    it('2 · un reembolso FAILED no se puede procesar después como el mismo intento', async () => {
      const { bookingId, paymentId, amount } = await ventaTarjeta();
      const id = Number((await crear(paymentId, bookingId, amount)).body.data.id);
      assert.equal((await procesar(id, 'FAILED')).status, 200);

      for (const status of ['COMPLETED', 'CANCELLED', 'FAILED']) {
        const res = await procesar(id, status);
        assert.ok([400, 409].includes(res.status), `${status} -> ${res.status}`);
      }
      assert.equal((await refund(id))?.status, 'FAILED');
      assert.equal(devoluciones.length, 0);
      assert.equal(await movimientosRefund(paymentId), 0);
    });

    it('3 · un reembolso COMPLETED no se reprocesa: 400, sin segunda devolución', async () => {
      const { bookingId, paymentId, amount } = await ventaTarjeta();
      const id = Number((await crear(paymentId, bookingId, amount)).body.data.id);
      assert.equal((await procesar(id)).status, 200);
      for (const status of ['COMPLETED', 'CANCELLED', 'FAILED']) assert.equal((await procesar(id, status)).status, 400, status);
      assert.equal(devoluciones.length, 1);
      assert.equal(await movimientosRefund(paymentId), 1);
      assert.equal((await refund(id))?.status, 'COMPLETED');
    });

    it('3b · `process` solo admite estados de cierre: PENDING o PROCESSING responden 422', async () => {
      const { bookingId, paymentId, amount } = await ventaTarjeta();
      const id = Number((await crear(paymentId, bookingId, amount)).body.data.id);
      for (const status of ['PENDING', 'PROCESSING']) assert.equal((await procesar(id, status)).status, 422, status);
      const fila = await refund(id);
      assert.equal(fila?.status, 'PENDING');
      assert.equal(fila?.processed_at, null);
    });
  });

  // =====================================================================
  describe('Límite del importe cobrado', () => {
    it('4/5/11 · reembolso de S/ total: completa con provider_refund_id; uno de S/ 1 más se rechaza', async () => {
      const { bookingId, paymentId, amount } = await ventaTarjeta();
      const id = Number((await crear(paymentId, bookingId, amount)).body.data.id);
      assert.equal((await procesar(id)).status, 200);
      const fila = await refund(id);
      assert.equal(fila?.status, 'COMPLETED');
      assert.ok(fila?.provider_refund_id, 'lleva el identificador de la devolución de Culqi');
      assert.equal(devueltoCulqiCents(), Math.round(amount * 100));

      assert.equal((await crear(paymentId, bookingId, 1)).status, 400);
      await invariantes();
    });

    it('9 · CANCELLED por el total + nuevo por el total: solo uno devuelve el dinero', async () => {
      const { bookingId, paymentId, amount } = await ventaTarjeta();
      const a = Number((await crear(paymentId, bookingId, amount)).body.data.id);
      assert.equal((await procesar(a, 'CANCELLED')).status, 200);
      const b = Number((await crear(paymentId, bookingId, amount)).body.data.id);
      assert.equal((await procesar(b)).status, 200);

      const intento = await procesar(a);
      assert.ok([400, 409].includes(intento.status), `A -> ${intento.status}`);
      assert.equal(await totalCompletado(paymentId), amount);
      assert.equal(devueltoCulqiCents(), Math.round(amount * 100), 'una sola devolución real');
      assert.equal(await movimientosRefund(paymentId), 1);
      await invariantes();
    });

    it('10 · FAILED por el total + nuevo por el total: solo uno devuelve el dinero', async () => {
      const { bookingId, paymentId, amount } = await ventaTarjeta();
      const a = Number((await crear(paymentId, bookingId, amount)).body.data.id);
      assert.equal((await procesar(a, 'FAILED')).status, 200);
      const b = Number((await crear(paymentId, bookingId, amount)).body.data.id);
      assert.equal((await procesar(b)).status, 200);

      assert.ok([400, 409].includes((await procesar(a)).status));
      assert.equal(await totalCompletado(paymentId), amount);
      assert.equal(devoluciones.length, 1);
      await invariantes();
    });

    it('7b · un reembolso vivo que excedería lo cobrado se rechaza al procesar, antes de llamar a Culqi', async () => {
      const { bookingId, paymentId, amount } = await ventaTarjeta();
      const a = Number((await crear(paymentId, bookingId, 60)).body.data.id);
      const b = await reembolsoDirecto(paymentId, bookingId, amount - 60 + 10);
      assert.equal((await procesar(a)).status, 200);

      const res = await procesar(b);
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal((await refund(b))?.status, 'PENDING', 'queda como estaba: se puede rechazar');
      assert.equal(devoluciones.length, 1, 'Culqi solo recibió la devolución de A');
      assert.equal(await totalCompletado(paymentId), 60);
      assert.equal((await procesar(b, 'CANCELLED')).status, 200, 'rechazarlo sigue siendo posible');
      await invariantes();
    });

    it('18 · pago manual: el mismo límite, sin pasarela', async () => {
      const { bookingId, paymentId, amount } = await ventaManual();
      const a = Number((await crear(paymentId, bookingId, 60)).body.data.id);
      const b = await reembolsoDirecto(paymentId, bookingId, amount);
      assert.equal((await procesar(a)).status, 200);
      assert.equal((await procesar(b)).status, 409);
      assert.equal(await totalCompletado(paymentId), 60);
      assert.equal(devoluciones.length, 0);

      const c = await reembolsoDirecto(paymentId, bookingId, 60);
      assert.equal((await procesar(c)).status, 409, 'CANCELLED/FAILED/COMPLETED o no, el total manda');
      await invariantes();
    });
  });

  // =====================================================================
  describe('Concurrencia', () => {
    it('6 · S/ 60 + S/ resto procesados a la vez: nunca más del total y, reintentando, cuadran exacto', async () => {
      const { bookingId, paymentId, amount } = await ventaTarjeta();
      const a = Number((await crear(paymentId, bookingId, 60)).body.data.id);
      const b = Number((await crear(paymentId, bookingId, amount - 60)).body.data.id);

      const respuestas = await Promise.all([procesar(a), procesar(b)]);
      assert.ok(respuestas.every((r) => [200, 409].includes(r.status)), JSON.stringify(respuestas.map((r) => r.status)));
      assert.ok(respuestas.some((r) => r.status === 200));
      await invariantes();

      for (const [indice, id] of [a, b].entries()) {
        if (respuestas[indice]!.status !== 200) assert.equal((await procesar(id)).status, 200);
      }
      assert.equal(await totalCompletado(paymentId), amount);
      assert.equal(devueltoCulqiCents(), Math.round(amount * 100));
      assert.equal(await movimientosRefund(paymentId), 2);
      await invariantes();
    });

    it('7 · S/ 60 + S/ resto+10 (vivos) a la vez: nunca más del total, ni en Culqi', async () => {
      const { bookingId, paymentId, amount } = await ventaTarjeta();
      const a = Number((await crear(paymentId, bookingId, 60)).body.data.id);
      const b = await reembolsoDirecto(paymentId, bookingId, amount - 60 + 10);

      await Promise.all([procesar(a), procesar(b)]);
      await Promise.all([procesar(a), procesar(b)]);
      assert.ok((await totalCompletado(paymentId)) <= amount);
      assert.ok(devueltoCulqiCents() <= Math.round(amount * 100), `Culqi devolvió ${devueltoCulqiCents()}`);
      await invariantes();
    });

    it('8 · S/ total + S/ total (vivos) a la vez, varias rondas: un solo COMPLETED y una sola devolución', async () => {
      const { bookingId, paymentId, amount } = await ventaTarjeta();
      const a = Number((await crear(paymentId, bookingId, amount)).body.data.id);
      const b = await reembolsoDirecto(paymentId, bookingId, amount);

      for (let ronda = 0; ronda < 3; ronda += 1) await Promise.all([procesar(a), procesar(b), procesar(a), procesar(b)]);

      const completados = await query("SELECT id FROM refunds WHERE payment_id = ? AND status = 'COMPLETED'", [paymentId]);
      assert.equal(completados.length, 1);
      assert.equal(devoluciones.length, 1);
      assert.equal(await movimientosRefund(paymentId), 1);
      await invariantes();
    });

    it('14 · el mismo reembolso procesado cinco veces a la vez y cinco seguidas: una devolución', async () => {
      const { bookingId, paymentId, amount } = await ventaTarjeta();
      const id = Number((await crear(paymentId, bookingId, amount)).body.data.id);
      const simultaneas = await Promise.all(Array.from({ length: 5 }, () => procesar(id)));
      assert.equal(simultaneas.filter((r) => r.status === 200).length, 1);
      for (let i = 0; i < 5; i += 1) assert.notEqual((await procesar(id)).status, 200);
      assert.equal(devoluciones.length, 1);
      assert.equal(await movimientosRefund(paymentId), 1);
    });

    it('15 · procesar y cancelar la reserva a la vez: un solo reembolso vivo y nunca más del total', async () => {
      const { bookingId, paymentId, amount } = await ventaTarjeta();
      const id = Number((await crear(paymentId, bookingId, amount)).body.data.id);
      const [p, c] = await Promise.all([
        procesar(id),
        post(`/bookings/${bookingId}/cancel`, { request_refund: true }, ctx.sessions.customer.token),
      ]);
      assert.equal(p.status, 200, JSON.stringify(p.body));
      assert.equal(c.status, 200, JSON.stringify(c.body));
      const vivos = await query("SELECT id FROM refunds WHERE payment_id = ? AND status NOT IN ('FAILED','CANCELLED')", [paymentId]);
      assert.equal(vivos.length, 1);
      assert.equal(devoluciones.length, 1);
      await invariantes();
    });

    it('16 · procesar mientras corre la expiración: sin efectos cruzados', async () => {
      const { bookingId, paymentId, amount } = await ventaTarjeta();
      const pendiente = await reservar();
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [pendiente]);
      const id = Number((await crear(paymentId, bookingId, amount)).body.data.id);

      const [p] = await Promise.all([procesar(id), expireDueBookings()]);
      assert.equal(p.status, 200, JSON.stringify(p.body));
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [pendiente]))?.status, 'EXPIRED');
      assert.equal(await totalCompletado(paymentId), amount);
      assert.equal(devoluciones.length, 1);
      await invariantes();
    });
  });

  // =====================================================================
  describe('Culqi', () => {
    it('12 · si Culqi falla, el reembolso no se marca COMPLETED ni escribe movimiento; el reintento lo cierra', async () => {
      const { bookingId, paymentId, amount } = await ventaTarjeta();
      const id = Number((await crear(paymentId, bookingId, amount)).body.data.id);
      modoDevolucion = 'falla';
      assert.equal((await procesar(id)).status, 400);
      const fila = await refund(id);
      assert.equal(fila?.status, 'PENDING');
      assert.equal(fila?.provider_refund_id, null);
      assert.equal(await movimientosRefund(paymentId), 0);

      modoDevolucion = 'ok';
      assert.equal((await procesar(id)).status, 200);
      assert.ok((await refund(id))?.provider_refund_id);
      await invariantes();
    });

    it('13 · Culqi devolvió pero el cierre local no llegó: reprocesar no pide otra devolución, y ya no se puede rechazar', async () => {
      const { bookingId, paymentId, amount } = await ventaTarjeta();
      const id = Number((await crear(paymentId, bookingId, amount)).body.data.id);
      // Estado exacto que deja `refundThroughCulqi` si la transacción posterior falla: el
      // identificador de Culqi ya guardado y el reembolso aún PENDING.
      await execute("UPDATE refunds SET provider_refund_id = 'ref_test_h44_previo' WHERE id = ?", [id]);

      for (const status of ['CANCELLED', 'FAILED']) {
        const res = await procesar(id, status);
        assert.equal(res.status, 409, `${status}: el dinero ya salió en Culqi -> ${res.status}`);
      }
      assert.equal((await procesar(id)).status, 200);
      const fila = await refund(id);
      assert.deepEqual({ status: fila?.status, ref: fila?.provider_refund_id }, { status: 'COMPLETED', ref: 'ref_test_h44_previo' });
      assert.equal(devoluciones.length, 0, 'no se pidió una segunda devolución');
      assert.equal(await movimientosRefund(paymentId), 1);
      await invariantes();
    });

    it('17 · compensatorio de H-43 (doble cobro): se devuelve una vez, con provider_refund_id, sin regresión', async () => {
      const bookingId = await reservar();
      modoCargo = 'timeout';
      await post(`/bookings/${bookingId}/pay`, { method: 'CARD', token: TOKEN }, ctx.sessions.customer.token);
      const cargo1 = [...cargos.keys()].at(-1)!;
      modoCargo = 'ok';
      assert.equal((await post(`/bookings/${bookingId}/pay`, { method: 'CARD', token: TOKEN }, ctx.sessions.customer.token)).status, 200);
      assert.equal((await post(`/culqi/webhook/${SECRET}`, { data: { id: cargo1 } })).status, 200);

      const [compensatorio] = await query<{ id: number; payment_id: number }>("SELECT id, payment_id FROM refunds WHERE booking_id = ? AND status = 'PENDING'", [bookingId]);
      assert.ok(compensatorio);
      const respuestas = await Promise.all([procesar(compensatorio.id), procesar(compensatorio.id)]);
      assert.equal(respuestas.filter((r) => r.status === 200).length, 1);
      assert.equal((await post(`/culqi/webhook/${SECRET}`, { data: { id: cargo1 } })).status, 200);

      assert.deepEqual(devoluciones.map((d) => d.chargeId), [cargo1]);
      assert.ok((await refund(compensatorio.id))?.provider_refund_id);
      assert.equal((await query('SELECT id FROM refunds WHERE booking_id = ?', [bookingId])).length, 1);
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [bookingId]))?.status, 'CONFIRMED');
      await invariantes();
    });
  });
});
