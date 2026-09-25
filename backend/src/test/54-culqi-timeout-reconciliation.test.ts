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

// El registrador calla durante la suite salvo que se pida; aquí no hace falta leerlo.
process.env.LOG_ERRORS = 'false';

/**
 * H-42 · H-43 · conciliación de cargos de Culqi tras un TIMEOUT.
 *
 * POR QUÉ EXISTE. La auditoría 11A encontró dos fallos de dinero que los tests de Culqi no veían
 * porque probaban el webhook partiendo de un pago PROCESSING fabricado, no del estado que deja un
 * TIMEOUT real (pago FAILED):
 *
 *   · H-42. Tras el TIMEOUT, el webhook confirmaba la reserva INSERTANDO un pago nuevo sin
 *     `provider`. Al reembolsarlo, `refundThroughCulqi` no llamaba a Culqi y el reembolso quedaba
 *     COMPLETED sin devolución real.
 *   · H-43. Si el cargo con TIMEOUT sí cobró y el pasajero reintentaba con éxito, el webhook del
 *     primer cargo veía la reserva CONFIRMED, no hacía nada y respondía «reserva confirmada»: doble
 *     cobro sin registrar ni devolver.
 *
 * Aquí todo parte del camino real: el pasajero paga con tarjeta, el doble de Culqi cobra pero
 * responde TIMEOUT, y después llega el webhook. Regla que se defiende: todo cargo aprobado acaba
 * en su propio pago PAID/CULQI con su `chr_…`, y o confirma la reserva o tiene su reembolso, que se
 * devuelve de verdad por Culqi. Culqi es un doble: nada sale a la red.
 */
describe('H-42 · H-43 · cargos de Culqi tras un TIMEOUT', () => {
  let ctx: SuiteContext;
  const SECRET = 'secreto-webhook-h42';
  const TOKEN = 'tkn_test_h42_000001';

  type Respuesta = 'ok' | 'timeout-cobrado' | 'timeout-sin-cobro' | { esperar: Promise<void> };
  let guion: Respuesta[] = [];
  let seq = 0;
  const cargosCreados = new Map<string, { amountCents: number; paymentId: number; bookingId: number }>();
  const devoluciones: Array<{ chargeId: string; amountCents: number }> = [];
  let alPedirCargo: (() => void) | null = null;

  const culqiFalso: CulqiApi = {
    async createCharge(input) {
      const paso = guion.shift() ?? 'ok';
      seq += 1;
      const id = `chr_test_h42_${seq}`;
      if (paso === 'timeout-sin-cobro') {
        return { ok: false, kind: 'TIMEOUT', code: null, userMessage: 'sin respuesta', merchantMessage: 'timeout de prueba' };
      }
      cargosCreados.set(id, {
        amountCents: input.amountCents,
        paymentId: Number(input.metadata?.payment_id),
        bookingId: Number(input.metadata?.booking_id),
      });
      if (paso === 'timeout-cobrado') {
        return { ok: false, kind: 'TIMEOUT', code: null, userMessage: 'sin respuesta', merchantMessage: 'timeout de prueba' };
      }
      if (typeof paso === 'object') {
        alPedirCargo?.();
        await paso.esperar;
      }
      return {
        ok: true,
        data: { id, amount: input.amountCents, currency_code: input.currencyCode, outcome: { type: 'venta_exitosa', user_message: 'ok' } } as CulqiCharge,
      };
    },
    async getCharge(id) {
      const cargo = cargosCreados.get(id);
      if (!cargo) return { ok: false, kind: 'PROVIDER', code: null, userMessage: 'no existe', merchantMessage: 'no existe' };
      return {
        ok: true,
        data: {
          id,
          amount: cargo.amountCents,
          currency_code: 'PEN',
          outcome: { type: 'venta_exitosa', user_message: 'ok' },
          metadata: { payment_id: String(cargo.paymentId), booking_id: String(cargo.bookingId) },
        } as unknown as CulqiCharge,
      };
    },
    async createRefund(input) {
      devoluciones.push({ chargeId: input.chargeId, amountCents: input.amountCents });
      return { ok: true, data: { id: `ref_test_h42_${devoluciones.length}`, charge_id: input.chargeId, amount: input.amountCents } as never };
    },
  };

  before(async () => {
    ctx = await prepareSuite();
  });
  after(async () => {
    setCulqiApi(null);
    await teardownSuite();
  });

  beforeEach(async () => {
    guion = [];
    cargosCreados.clear();
    devoluciones.length = 0;
    alPedirCargo = null;
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

  async function reservar(): Promise<{ bookingId: number; total: number }> {
    const res = await post(
      '/bookings',
      { trip_id: ctx.fixtures.tripA, seat_ids: [at(await freeSeats(ctx.fixtures.tripA), 0).id], passenger_email: 'cliente@test.pe' },
      ctx.sessions.customer.token,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { bookingId: Number(res.body.data.id), total: Number(res.body.data.total_amount) };
  }

  const pagarTarjeta = (bookingId: number) => post(`/bookings/${bookingId}/pay`, { method: 'CARD', token: TOKEN }, ctx.sessions.customer.token);
  const webhook = (chargeId: string) =>
    post(`/culqi/webhook/${SECRET}`, { object: 'event', type: 'charge.creation.succeeded', data: { id: chargeId } });
  const procesar = (refundId: number) => post(`/refunds/${refundId}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token);

  const pagos = (bookingId: number) =>
    query<{ id: number; status: string; method: string; provider: string | null; ptx: string | null; amount: string; payment_data: string | null }>(
      'SELECT id, status, method, provider, provider_transaction_id AS ptx, amount, payment_data FROM payments WHERE booking_id = ? ORDER BY id',
      [bookingId],
    );
  const reembolsos = (bookingId: number) =>
    query<{ id: number; payment_id: number; amount: string; status: string; provider_refund_id: string | null }>(
      'SELECT id, payment_id, amount, status, provider_refund_id FROM refunds WHERE booking_id = ? ORDER BY id',
      [bookingId],
    );
  // Libro de la EMPRESA. El cobro compensatorio vive en el de la plataforma (H-26, `company_id` NULL).
  const movimientos = (bookingId: number) =>
    query<{ type: string; payment_id: number }>(
      'SELECT type, payment_id FROM financial_transactions WHERE booking_id = ? AND company_id IS NOT NULL ORDER BY id',
      [bookingId],
    );
  const libroPlataforma = (bookingId: number) =>
    query<{ type: string; payment_id: number }>(
      'SELECT type, payment_id FROM financial_transactions WHERE booking_id = ? AND company_id IS NULL ORDER BY id',
      [bookingId],
    );
  const estadoReserva = async (bookingId: number) =>
    (await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [bookingId]))?.status;

  /** Un cargo con TIMEOUT que Culqi SÍ cobró. Devuelve el estado real que deja: pago FAILED. */
  async function timeoutCobrado() {
    const { bookingId, total } = await reservar();
    guion.push('timeout-cobrado');
    const intento = await pagarTarjeta(bookingId);
    assert.equal(intento.status, 402, JSON.stringify(intento.body));
    const [pago] = await pagos(bookingId);
    assert.equal(pago?.status, 'FAILED', 'el TIMEOUT deja el pago FAILED: es el estado real del que parte el webhook');
    const chargeId = [...cargosCreados.keys()].at(-1)!;
    return { bookingId, total, chargeId, paymentId: Number(pago!.id) };
  }

  /** Invariante global: ningún pago con un cargo de Culqi conocido queda sin proveedor. */
  async function sinPagosHuerfanosDeProveedor() {
    const huerfanos = await query("SELECT id FROM payments WHERE provider_transaction_id LIKE 'chr\\_%' AND (provider IS NULL OR provider <> 'CULQI')");
    assert.deepEqual(huerfanos, [], 'un pago con cargo de Culqi siempre tiene provider = CULQI');
    const sinDevolucion = await query(
      `SELECT rf.id FROM refunds rf JOIN payments p ON p.id = rf.payment_id
       WHERE rf.status = 'COMPLETED' AND rf.provider_refund_id IS NULL AND p.provider_transaction_id LIKE 'chr\\_%'`,
    );
    assert.deepEqual(sinDevolucion, [], 'ningún reembolso de un cargo de Culqi se cierra sin devolución real');
  }

  // =====================================================================
  describe('H-42 · TIMEOUT y webhook tardío', () => {
    it('1 · TIMEOUT sin cobro: pago FAILED, reserva PENDING, y un webhook de un cargo inexistente no toca nada', async () => {
      const { bookingId } = await reservar();
      guion.push('timeout-sin-cobro');
      assert.equal((await pagarTarjeta(bookingId)).status, 402);

      assert.deepEqual((await pagos(bookingId)).map((p) => p.status), ['FAILED']);
      assert.equal(await estadoReserva(bookingId), 'PENDING');

      const res = await webhook('chr_test_h42_inexistente');
      assert.equal(res.status, 200);
      assert.equal(res.body.data.handled, false);
      assert.deepEqual((await pagos(bookingId)).map((p) => p.status), ['FAILED']);
      assert.equal((await movimientos(bookingId)).length, 0);
    });

    it('2/3/6 · TIMEOUT con cobro + webhook con la reserva confirmable: se corrige EL MISMO pago y confirma', async () => {
      const { bookingId, chargeId, paymentId } = await timeoutCobrado();

      const res = await webhook(chargeId);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.handled, true);

      assert.equal(await estadoReserva(bookingId), 'CONFIRMED');
      const filas = await pagos(bookingId);
      assert.equal(filas.length, 1, 'no se crea un segundo pago');
      assert.equal(Number(filas[0]!.id), paymentId, 'es el pago del intento');
      assert.deepEqual(
        { status: filas[0]!.status, method: filas[0]!.method, provider: filas[0]!.provider, ptx: filas[0]!.ptx },
        { status: 'PAID', method: 'CARD', provider: 'CULQI', ptx: chargeId },
      );
      assert.equal(JSON.parse(filas[0]!.payment_data ?? '{}').charge_id, chargeId);
      assert.deepEqual((await movimientos(bookingId)).map((m) => [m.type, Number(m.payment_id)]), [['PAYMENT', paymentId], ['COMMISSION', paymentId]]);
      assert.equal((await reembolsos(bookingId)).length, 0);
      await sinPagosHuerfanosDeProveedor();
    });

    it('3b · y si luego se cancela y reembolsa, la devolución se pide de verdad a Culqi (la secuencia de H-42)', async () => {
      const { bookingId, chargeId, total } = await timeoutCobrado();
      assert.equal((await webhook(chargeId)).status, 200);

      assert.equal((await post(`/bookings/${bookingId}/cancel`, { request_refund: true }, ctx.sessions.customer.token)).status, 200);
      const [reembolso] = await reembolsos(bookingId);
      assert.equal((await procesar(reembolso!.id)).status, 200);

      assert.deepEqual(devoluciones, [{ chargeId, amountCents: Math.round(total * 100) }]);
      const [cerrado] = await reembolsos(bookingId);
      assert.equal(cerrado!.status, 'COMPLETED');
      assert.ok(cerrado!.provider_refund_id, 'guarda el identificador de la devolución de Culqi');
      await sinPagosHuerfanosDeProveedor();
    });

    it('4/5 · TIMEOUT con cobro + webhook tras la expiración: PAID/CULQI con reembolso que se devuelve por Culqi', async () => {
      const { bookingId, chargeId, paymentId, total } = await timeoutCobrado();
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [bookingId]);
      await expireDueBookings();
      assert.equal(await estadoReserva(bookingId), 'EXPIRED');

      assert.equal((await webhook(chargeId)).status, 200);

      const filas = await pagos(bookingId);
      assert.equal(filas.length, 1);
      assert.deepEqual(
        { id: Number(filas[0]!.id), status: filas[0]!.status, provider: filas[0]!.provider, ptx: filas[0]!.ptx },
        { id: paymentId, status: 'PAID', provider: 'CULQI', ptx: chargeId },
      );
      const [reembolso] = await reembolsos(bookingId);
      assert.equal(reembolso?.status, 'PENDING');
      assert.equal(Number(reembolso?.amount), total);
      assert.equal(await estadoReserva(bookingId), 'EXPIRED', 'no se revive la reserva');

      assert.equal((await procesar(reembolso!.id)).status, 200);
      assert.deepEqual(devoluciones, [{ chargeId, amountCents: Math.round(total * 100) }]);
      const [cerrado] = await reembolsos(bookingId);
      assert.equal(cerrado!.status, 'COMPLETED');
      assert.ok(cerrado!.provider_refund_id);
      await sinPagosHuerfanosDeProveedor();
    });

    it('5b · un pago con un cargo `chr_…` y sin proveedor (dato dejado por H-42) también se devuelve por Culqi', async () => {
      const { bookingId, total } = await reservar();
      await post(`/bookings/${bookingId}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);
      const [pago] = await pagos(bookingId);
      await execute("UPDATE payments SET method = 'CARD', provider = NULL, provider_transaction_id = 'chr_test_h42_legado' WHERE id = ?", [pago!.id]);
      await post(`/bookings/${bookingId}/cancel`, { request_refund: true }, ctx.sessions.customer.token);
      const [reembolso] = await reembolsos(bookingId);

      assert.equal((await procesar(reembolso!.id)).status, 200);
      assert.deepEqual(devoluciones, [{ chargeId: 'chr_test_h42_legado', amountCents: Math.round(total * 100) }]);
      assert.ok((await reembolsos(bookingId))[0]!.provider_refund_id);
    });

    it('5c · un pago manual sin cargo de Culqi se sigue reembolsando por fuera, sin pasarela', async () => {
      const { bookingId } = await reservar();
      await post(`/bookings/${bookingId}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);
      await post(`/bookings/${bookingId}/cancel`, { request_refund: true }, ctx.sessions.customer.token);
      const [reembolso] = await reembolsos(bookingId);
      assert.equal((await procesar(reembolso!.id)).status, 200);
      assert.equal(devoluciones.length, 0);
    });
  });

  // =====================================================================
  describe('H-43 · doble cobro por reintento', () => {
    async function dobleCobro() {
      const primero = await timeoutCobrado();
      guion.push('ok');
      const reintento = await pagarTarjeta(primero.bookingId);
      assert.equal(reintento.status, 200, JSON.stringify(reintento.body));
      const charge2 = [...cargosCreados.keys()].at(-1)!;
      assert.notEqual(charge2, primero.chargeId);
      return { ...primero, charge1: primero.chargeId, charge2 };
    }

    it('7–17 · el webhook del cargo 1 NO se ignora: queda registrado con su reembolso y el cargo 2 sigue confirmando', async () => {
      const { bookingId, charge1, charge2, paymentId: pago1, total } = await dobleCobro();
      assert.equal(await estadoReserva(bookingId), 'CONFIRMED');

      const res = await webhook(charge1);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.handled, true);
      assert.notEqual(res.body.data.action, 'reserva confirmada', 'no se da por conciliado sin hacer nada');

      const filas = await pagos(bookingId);
      assert.equal(filas.length, 2, 'dos cargos, dos pagos trazables');
      const [p1, p2] = filas;
      assert.deepEqual({ id: Number(p1!.id), status: p1!.status, provider: p1!.provider, ptx: p1!.ptx }, { id: pago1, status: 'PAID', provider: 'CULQI', ptx: charge1 });
      assert.deepEqual({ status: p2!.status, provider: p2!.provider, ptx: p2!.ptx }, { status: 'PAID', provider: 'CULQI', ptx: charge2 });

      assert.equal(await estadoReserva(bookingId), 'CONFIRMED', 'la reserva no se altera');
      assert.deepEqual(
        (await movimientos(bookingId)).map((m) => [m.type, Number(m.payment_id)]),
        [['PAYMENT', Number(p2!.id)], ['COMMISSION', Number(p2!.id)]],
        'una sola venta válida: la del cargo 2',
      );
      assert.deepEqual(
        (await libroPlataforma(bookingId)).filter((m) => Number(m.payment_id) === pago1).map((m) => [m.type, Number(m.payment_id)]),
        [['PAYMENT', pago1]],
        'el cargo 1 entra en el libro de la plataforma, no como venta',
      );
      const refunds = await reembolsos(bookingId);
      assert.equal(refunds.length, 1);
      assert.equal(Number(refunds[0]!.payment_id), pago1, 'el reembolso es del cargo 1');
      assert.equal(Number(refunds[0]!.amount), total);
      assert.equal(refunds[0]!.status, 'PENDING');
      await sinPagosHuerfanosDeProveedor();
    });

    it('18/19 · el cargo 1 se devuelve de verdad por Culqi, una vez, aunque el webhook se repita', async () => {
      const { bookingId, charge1, total } = await dobleCobro();
      for (let i = 0; i < 3; i += 1) assert.equal((await webhook(charge1)).status, 200);
      assert.equal((await pagos(bookingId)).length, 2, 'webhooks repetidos no crean pagos');
      assert.equal((await reembolsos(bookingId)).length, 1, 'ni reembolsos');

      const [reembolso] = await reembolsos(bookingId);
      assert.equal((await procesar(reembolso!.id)).status, 200);
      assert.equal((await procesar(reembolso!.id)).status, 400, 'no se procesa dos veces');
      for (let i = 0; i < 2; i += 1) assert.equal((await webhook(charge1)).status, 200);

      assert.deepEqual(devoluciones, [{ chargeId: charge1, amountCents: Math.round(total * 100) }], 'una sola devolución real, del cargo 1');
      const [cerrado] = await reembolsos(bookingId);
      assert.equal(cerrado!.status, 'COMPLETED');
      assert.ok(cerrado!.provider_refund_id);
      assert.equal(await estadoReserva(bookingId), 'CONFIRMED');
      const estados = (await pagos(bookingId)).map((p) => p.status);
      assert.deepEqual(estados, ['REFUNDED', 'PAID'], 'el cargo 2 sigue siendo la venta');
      await sinPagosHuerfanosDeProveedor();
    });
  });

  // =====================================================================
  describe('Concurrencia', () => {
    it('20 · webhook del cargo 1 mientras el reintento (cargo 2) está en vuelo: los dos quedan conciliados', async () => {
      const { bookingId, chargeId: charge1, total } = await timeoutCobrado();
      let soltar!: () => void;
      const enVuelo = new Promise<void>((resolve) => { soltar = resolve; });
      const cargoPedido = new Promise<void>((resolve) => { alPedirCargo = resolve; });
      guion.push({ esperar: enVuelo });

      const reintento = pagarTarjeta(bookingId);
      await cargoPedido;
      const webhook1 = await webhook(charge1);
      soltar();
      const respuesta = await reintento;

      assert.equal(webhook1.status, 200, JSON.stringify(webhook1.body));
      assert.equal(respuesta.status, 200, `reintento -> ${respuesta.status} ${JSON.stringify(respuesta.body)}`);
      assert.equal(await estadoReserva(bookingId), 'CONFIRMED');

      const filas = await pagos(bookingId);
      assert.equal(filas.length, 2);
      assert.ok(filas.every((p) => p.status === 'PAID' && p.provider === 'CULQI' && p.ptx?.startsWith('chr_')), JSON.stringify(filas));
      assert.equal((await movimientos(bookingId)).filter((m) => m.type === 'PAYMENT').length, 1);
      assert.equal((await movimientos(bookingId)).filter((m) => m.type === 'COMMISSION').length, 1);
      const refunds = await reembolsos(bookingId);
      assert.equal(refunds.length, 1, 'el cargo que no confirmó tiene su reembolso');
      assert.equal(Number(refunds[0]!.amount), total);
      const venta = (await movimientos(bookingId)).find((m) => m.type === 'PAYMENT')!;
      assert.notEqual(Number(refunds[0]!.payment_id), Number(venta.payment_id), 'no se reembolsa la venta que confirma');
      await sinPagosHuerfanosDeProveedor();
    });

    it('21 · cinco webhooks simultáneos del mismo cargo: un pago, una confirmación, una venta', async () => {
      const { bookingId, chargeId } = await timeoutCobrado();
      const respuestas = await Promise.all(Array.from({ length: 5 }, () => webhook(chargeId)));
      assert.ok(respuestas.every((r) => r.status === 200), JSON.stringify(respuestas.map((r) => r.body)));

      assert.equal((await pagos(bookingId)).length, 1);
      assert.equal(await estadoReserva(bookingId), 'CONFIRMED');
      assert.deepEqual((await movimientos(bookingId)).map((m) => m.type), ['PAYMENT', 'COMMISSION']);
      assert.equal((await reembolsos(bookingId)).length, 0);
    });

    it('21b · cinco webhooks simultáneos de un cargo tardío (H-43): un solo reembolso', async () => {
      const primero = await timeoutCobrado();
      guion.push('ok');
      await pagarTarjeta(primero.bookingId);
      const respuestas = await Promise.all(Array.from({ length: 5 }, () => webhook(primero.chargeId)));
      assert.ok(respuestas.every((r) => r.status === 200));
      assert.equal((await pagos(primero.bookingId)).length, 2);
      assert.equal((await reembolsos(primero.bookingId)).length, 1);
      assert.equal((await movimientos(primero.bookingId)).filter((m) => m.type === 'PAYMENT').length, 1);
    });

    it('22 · el reembolso compensatorio procesado a la vez pide una sola devolución', async () => {
      const { bookingId, chargeId } = await timeoutCobrado();
      guion.push('ok');
      await pagarTarjeta(bookingId);
      await webhook(chargeId);
      const [reembolso] = await reembolsos(bookingId);

      const respuestas = await Promise.all([procesar(reembolso!.id), procesar(reembolso!.id), procesar(reembolso!.id)]);
      assert.equal(respuestas.filter((r) => r.status === 200).length, 1, JSON.stringify(respuestas.map((r) => r.status)));
      assert.equal(devoluciones.length, 1);
    });

    it('23 · webhook y cancelación simultáneos: el cargo nunca queda sin conciliar', async () => {
      const { bookingId, chargeId, paymentId, total } = await timeoutCobrado();
      const [w, c] = await Promise.all([
        webhook(chargeId),
        post(`/bookings/${bookingId}/cancel`, { request_refund: true }, ctx.sessions.customer.token),
      ]);
      assert.equal(w.status, 200, JSON.stringify(w.body));
      assert.equal(c.status, 200, JSON.stringify(c.body));

      assert.equal(await estadoReserva(bookingId), 'CANCELLED');
      const [pago] = await pagos(bookingId);
      assert.deepEqual({ id: Number(pago!.id), status: pago!.status, provider: pago!.provider, ptx: pago!.ptx }, { id: paymentId, status: 'PAID', provider: 'CULQI', ptx: chargeId });
      const refunds = await reembolsos(bookingId);
      assert.equal(refunds.length, 1, 'exactamente un reembolso cubre el cargo');
      assert.equal(Number(refunds[0]!.amount), total);

      assert.equal((await procesar(refunds[0]!.id)).status, 200);
      assert.equal(devoluciones.length, 1);
      await sinPagosHuerfanosDeProveedor();
    });

    it('24 · webhook y expiración simultáneos: o confirma sin reembolso, o expira con reembolso', async () => {
      const { bookingId, chargeId } = await timeoutCobrado();
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [bookingId]);
      const [w] = await Promise.all([webhook(chargeId), expireDueBookings()]);
      assert.equal(w.status, 200, JSON.stringify(w.body));

      const estado = await estadoReserva(bookingId);
      const [pago] = await pagos(bookingId);
      assert.deepEqual({ status: pago!.status, provider: pago!.provider, ptx: pago!.ptx }, { status: 'PAID', provider: 'CULQI', ptx: chargeId });
      const ventas = (await movimientos(bookingId)).filter((m) => m.type === 'PAYMENT').length;
      const refunds = (await reembolsos(bookingId)).length;
      if (estado === 'CONFIRMED') assert.deepEqual([ventas, refunds], [1, 0]);
      else {
        assert.equal(estado, 'EXPIRED');
        assert.deepEqual([ventas, refunds], [0, 1]);
        assert.deepEqual((await libroPlataforma(bookingId)).map((m) => m.type), ['PAYMENT']);
      }
    });
  });

  // =====================================================================
  describe('Regresión', () => {
    it('25/26 · CARD individual normal: confirma y guarda el cargo real', async () => {
      const { bookingId } = await reservar();
      guion.push('ok');
      const res = await pagarTarjeta(bookingId);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const [pago] = await pagos(bookingId);
      assert.deepEqual({ status: pago!.status, provider: pago!.provider, ptx: pago!.ptx?.startsWith('chr_test_h42_') }, { status: 'PAID', provider: 'CULQI', ptx: true });
      assert.deepEqual((await movimientos(bookingId)).map((m) => m.type), ['PAYMENT', 'COMMISSION']);
    });

    it('O · un provider_transaction_id enviado por el cliente se ignora', async () => {
      const { bookingId } = await reservar();
      guion.push('ok');
      await post(`/bookings/${bookingId}/pay`, { method: 'CARD', token: TOKEN, provider_transaction_id: 'chr_inventado' }, ctx.sessions.customer.token);
      const [pago] = await pagos(bookingId);
      assert.notEqual(pago!.ptx, 'chr_inventado');
    });

    it('27 · H-22: el pasajero sigue sin poder confirmar un pago manual', async () => {
      const { bookingId } = await reservar();
      const res = await post(`/bookings/${bookingId}/pay`, { method: 'YAPE' }, ctx.sessions.customer.token);
      assert.equal(res.status, 202);
      assert.equal(await estadoReserva(bookingId), 'PENDING');
    });

    it('28 · H-23: CARD en itinerario sigue devolviendo 400', async () => {
      const vuelta = await execute(
        `INSERT INTO trips (route_id, bus_id, bus_layout_id, departure_datetime, base_price, available_seats, status)
         SELECT route_id, bus_id, bus_layout_id, DATE_ADD(departure_datetime, INTERVAL 2 DAY), base_price, available_seats, 'SCHEDULED' FROM trips WHERE id = ?`,
        [ctx.fixtures.tripA],
      );
      const grupo = await post(
        '/bookings/itineraries',
        {
          trip_type: 'ROUND_TRIP',
          segments: [
            { trip_id: ctx.fixtures.tripA, seat_ids: [at(await freeSeats(ctx.fixtures.tripA), 0).id] },
            { trip_id: vuelta.insertId, seat_ids: [at(await freeSeats(vuelta.insertId), 1).id] },
          ],
          passenger_email: 'cliente@test.pe',
        },
        ctx.sessions.customer.token,
      );
      assert.equal(grupo.status, 201, JSON.stringify(grupo.body));
      const res = await api(`/bookings/itineraries/${grupo.body.data.group_id}/pay`, { method: 'POST', body: { method: 'CARD' }, token: ctx.sessions.customer.token });
      assert.equal(res.status, 400);
    });
  });
});
