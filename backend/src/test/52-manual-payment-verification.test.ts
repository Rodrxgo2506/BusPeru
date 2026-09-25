import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { api, post } from './helpers/api';
import { env } from '../config/env';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { expireDueBookings } from '../services/booking-expiry.service';
import { setCulqiApi, type CulqiApi, type CulqiCharge } from '../services/culqi.service';
import { ITINERARY_CARD_NOT_SUPPORTED } from '../services/itinerary.service';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * H-22 · el pasajero no puede dar por cobrado un pago manual.
 *
 * POR QUÉ EXISTE. Con Yape, Plin, transferencia, efectivo u otro, `POST /bookings/:id/pay`
 * confirmaba la reserva del CUSTOMER, marcaba el pago PAID y escribía venta y comisión sin que
 * nadie hubiera visto el dinero. Ahora el pago del pasajero queda PENDING y lo verifica el
 * backoffice con `POST /payments/:id/approve|reject` (ADMIN, o COMPANY_ADMIN en su empresa).
 *
 * Culqi es un doble: ninguna prueba sale a la red.
 */
describe('H-22 · verificación manual de pagos', () => {
  let ctx: SuiteContext;
  let tripVuelta: number;
  const cargos: Array<Record<string, unknown>> = [];
  const MANUALES = ['YAPE', 'PLIN', 'TRANSFER', 'CASH', 'OTHER'] as const;

  const culqiFalso: CulqiApi = {
    async createCharge(input) {
      cargos.push({ ...input });
      return {
        ok: true,
        data: {
          id: 'chr_test_h22',
          amount: input.amountCents,
          currency_code: input.currencyCode,
          outcome: { type: 'venta_exitosa', user_message: 'Pago exitoso' },
        } as CulqiCharge,
      };
    },
    async getCharge() {
      throw new Error('no se espera ninguna relectura');
    },
    async createRefund() {
      throw new Error('no se espera ninguna devolución');
    },
  };

  before(async () => {
    ctx = await prepareSuite();
    const vuelta = await execute(
      `INSERT INTO trips (route_id, bus_id, bus_layout_id, departure_datetime, base_price, available_seats, status)
       SELECT route_id, bus_id, bus_layout_id, DATE_ADD(departure_datetime, INTERVAL 2 DAY), base_price, available_seats, 'SCHEDULED'
       FROM trips WHERE id = ?`,
      [ctx.fixtures.tripA],
    );
    tripVuelta = vuelta.insertId;
  });
  after(async () => {
    setCulqiApi(null);
    await teardownSuite();
  });

  beforeEach(async () => {
    cargos.length = 0;
    setCulqiApi(culqiFalso);
    env.culqi.publicKey = 'pk_test_solo_para_pruebas';
    env.culqi.privateKey = 'sk_test_solo_para_pruebas';
    await execute('DELETE FROM settlement_items');
    await execute('DELETE FROM financial_transactions');
    await execute('DELETE FROM refunds');
    await execute('DELETE FROM coupon_usages');
    await execute('DELETE FROM booking_seats');
    await execute('DELETE FROM payments');
    await execute('DELETE FROM notifications');
    await execute('DELETE FROM bookings');
    await execute('DELETE FROM booking_groups');
    await execute("UPDATE trips t JOIN buses b ON b.id = t.bus_id SET t.available_seats = b.capacity, t.status = 'SCHEDULED'");
  });
  afterEach(() => {
    setCulqiApi(null);
    env.culqi.publicKey = '';
    env.culqi.privateKey = '';
  });

  /* ------------------------------------------------------------------ utilidades */

  async function reservar(tripId = ctx.fixtures.tripA, extra: Record<string, unknown> = {}): Promise<number> {
    const res = await post(
      '/bookings',
      { trip_id: tripId, seat_ids: [at(await freeSeats(tripId), 0).id], passenger_email: 'cliente@test.pe', ...extra },
      ctx.sessions.customer.token,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return Number(res.body.data.id);
  }

  const pagar = (bookingId: number, body: Record<string, unknown>, token = ctx.sessions.customer.token) =>
    api(`/bookings/${bookingId}/pay`, { method: 'POST', body, token });
  const aprobar = (paymentId: number, token = ctx.sessions.admin.token) =>
    api(`/payments/${paymentId}/approve`, { method: 'POST', body: {}, token });
  const rechazar = (paymentId: number, token = ctx.sessions.admin.token, reason = 'No llegó el abono') =>
    api(`/payments/${paymentId}/reject`, { method: 'POST', body: { reason }, token });

  const estadoReserva = async (bookingId: number) =>
    (await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [bookingId]))?.status;

  const pagosDe = (bookingId: number) =>
    query<{ id: number; status: string; method: string; provider: string | null; provider_transaction_id: string | null; paid_at: string | null; payment_data: string | null }>(
      'SELECT id, status, method, provider, provider_transaction_id, paid_at, payment_data FROM payments WHERE booking_id = ? ORDER BY id',
      [bookingId],
    );

  async function movimientos(bookingId: number): Promise<{ PAYMENT: number; COMMISSION: number; total: number }> {
    const filas = await query<{ type: string; n: number }>(
      'SELECT type, COUNT(*) AS n FROM financial_transactions WHERE booking_id = ? AND company_id IS NOT NULL GROUP BY type',
      [bookingId],
    );
    const cuenta = (tipo: string) => Number(filas.find((fila) => fila.type === tipo)?.n ?? 0);
    return { PAYMENT: cuenta('PAYMENT'), COMMISSION: cuenta('COMMISSION'), total: filas.reduce((s, f) => s + Number(f.n), 0) };
  }

  const avisosDePago = async (bookingId: number) =>
    Number(
      (await queryOne<{ n: number }>(
        "SELECT COUNT(*) AS n FROM notifications WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.event_key')) = ?",
        [`booking.payment_confirmed:${bookingId}`],
      ))?.n,
    );

  const marca = (pago: { payment_data: string | null }) =>
    (JSON.parse(pago.payment_data ?? '{}') as { manual_verification?: Record<string, unknown> }).manual_verification;

  /** Reserva del pasajero con su pago manual ya registrado, lista para verificar. */
  async function pendienteDeVerificar(tripId = ctx.fixtures.tripA, method: (typeof MANUALES)[number] = 'YAPE') {
    const bookingId = await reservar(tripId);
    const res = await pagar(bookingId, { method });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    const [pago] = await pagosDe(bookingId);
    assert.ok(pago);
    return { bookingId, paymentId: Number(pago.id) };
  }

  // =====================================================================
  describe('El pasajero registra, no confirma', () => {
    for (const [indice, method] of MANUALES.entries()) {
      it(`${indice + 1} · CUSTOMER + ${method}: pago PENDING, reserva PENDING y ningún movimiento`, async () => {
        const bookingId = await reservar();
        const res = await pagar(bookingId, { method });

        assert.equal(res.status, 202, JSON.stringify(res.body));
        assert.equal(res.body.success, true);
        assert.equal(res.body.data.status, 'PENDING');
        assert.equal(res.body.data.payment_status, 'PENDING');
        assert.equal(await estadoReserva(bookingId), 'PENDING');

        const pagos = await pagosDe(bookingId);
        assert.equal(pagos.length, 1);
        assert.equal(pagos[0]!.status, 'PENDING');
        assert.equal(pagos[0]!.method, method);
        assert.equal(pagos[0]!.provider_transaction_id, null);
        assert.equal(pagos[0]!.paid_at, null);
        assert.equal(marca(pagos[0]!)?.status, 'PENDING_REVIEW');
        assert.equal(Number(marca(pagos[0]!)?.requested_by), ctx.fixtures.users.customer);

        assert.deepEqual(await movimientos(bookingId), { PAYMENT: 0, COMMISSION: 0, total: 0 });
        assert.equal(await avisosDePago(bookingId), 0, 'no se anuncia un pago que nadie verificó');
      });
    }

    it('6 · `paid: true` en el cuerpo no confirma', async () => {
      const bookingId = await reservar();
      assert.equal((await pagar(bookingId, { method: 'YAPE', paid: true })).status, 202);
      assert.equal(await estadoReserva(bookingId), 'PENDING');
      assert.equal(at(await pagosDe(bookingId), 0).status, 'PENDING');
    });

    it('7 · `status: PAID` y estados de reserva o movimiento en el cuerpo no confirman', async () => {
      const bookingId = await reservar();
      const res = await pagar(bookingId, {
        method: 'TRANSFER',
        status: 'PAID',
        payment_status: 'PAID',
        booking_status: 'CONFIRMED',
        financial_status: 'COMPLETED',
      });
      assert.equal(res.status, 202);
      assert.equal(await estadoReserva(bookingId), 'PENDING');
      assert.equal(at(await pagosDe(bookingId), 0).status, 'PENDING');
      assert.equal((await movimientos(bookingId)).total, 0);
    });

    it('8 · un `provider_transaction_id` o `transaction_id` inventado no convierte el pago en PAID', async () => {
      const bookingId = await reservar();
      const res = await pagar(bookingId, { method: 'CASH', provider_transaction_id: 'chr_inventado', transaction_id: 'TRX-FALSO' });
      assert.equal(res.status, 202);

      const [pago] = await pagosDe(bookingId);
      assert.equal(pago!.status, 'PENDING');
      assert.equal(pago!.provider_transaction_id, null);
      const falso = await queryOne<{ n: number }>(
        "SELECT COUNT(*) AS n FROM payments WHERE provider_transaction_id = 'chr_inventado' OR transaction_code = 'TRX-FALSO'",
      );
      assert.equal(Number(falso?.n), 0);
    });

    it('8b · repetir el registro, o crear la reserva ya con método, deja UN solo pago PENDING', async () => {
      const bookingId = await reservar(ctx.fixtures.tripA, { payment_method: 'YAPE' });
      for (const method of ['YAPE', 'PLIN', 'PLIN']) assert.equal((await pagar(bookingId, { method })).status, 202);

      const pagos = await pagosDe(bookingId);
      assert.equal(pagos.length, 1, 'se reutiliza el mismo pago');
      assert.equal(pagos[0]!.status, 'PENDING');
      assert.equal(pagos[0]!.method, 'PLIN', 'manda el último método declarado');
      assert.equal((await movimientos(bookingId)).total, 0);
    });

    it('22 · varios registros de varios pasajeros no crean ningún movimiento financiero', async () => {
      await pendienteDeVerificar(ctx.fixtures.tripA, 'YAPE');
      await pendienteDeVerificar(ctx.fixtures.tripA, 'CASH');
      await pendienteDeVerificar(ctx.fixtures.tripB, 'TRANSFER');
      const total = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM financial_transactions');
      assert.equal(Number(total?.n), 0);
    });
  });

  // =====================================================================
  describe('Quién puede verificar', () => {
    it('9/14 · el CUSTOMER no puede aprobar ni rechazar su propio pago', async () => {
      const { bookingId, paymentId } = await pendienteDeVerificar();

      assert.equal((await aprobar(paymentId, ctx.sessions.customer.token)).status, 403);
      assert.equal((await rechazar(paymentId, ctx.sessions.customer.token)).status, 403);

      assert.equal(await estadoReserva(bookingId), 'PENDING');
      assert.equal(at(await pagosDe(bookingId), 0).status, 'PENDING');
      assert.equal((await movimientos(bookingId)).total, 0);
    });

    it('10 · el ADMIN aprueba: PAID, CONFIRMED, un PAYMENT, una COMMISSION y un aviso', async () => {
      const { bookingId, paymentId } = await pendienteDeVerificar();

      const res = await aprobar(paymentId);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.review_outcome, 'APPROVED');
      assert.equal(res.body.data.status, 'PAID');

      assert.equal(await estadoReserva(bookingId), 'CONFIRMED');
      const [pago] = await pagosDe(bookingId);
      assert.equal(pago!.status, 'PAID');
      assert.equal(pago!.method, 'YAPE');
      assert.ok(pago!.paid_at);
      assert.equal(pago!.provider_transaction_id, null);
      assert.equal(marca(pago!)?.status, 'APPROVED');
      assert.equal(Number(marca(pago!)?.reviewed_by), ctx.fixtures.users.admin);
      assert.deepEqual(await movimientos(bookingId), { PAYMENT: 1, COMMISSION: 1, total: 2 });
      assert.equal(await avisosDePago(bookingId), 1);
    });

    it('11 · el COMPANY_ADMIN aprueba un pago de su empresa', async () => {
      const { bookingId, paymentId } = await pendienteDeVerificar(ctx.fixtures.tripA);
      const res = await aprobar(paymentId, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(await estadoReserva(bookingId), 'CONFIRMED');
      assert.deepEqual(await movimientos(bookingId), { PAYMENT: 1, COMMISSION: 1, total: 2 });
    });

    it('12 · el COMPANY_ADMIN de A no ve ni verifica un pago de B (404); el de B sí', async () => {
      const { bookingId, paymentId } = await pendienteDeVerificar(ctx.fixtures.tripB);

      assert.equal((await aprobar(paymentId, ctx.sessions.companyAdmin.token)).status, 404);
      assert.equal((await rechazar(paymentId, ctx.sessions.companyAdmin.token)).status, 404);
      assert.equal(await estadoReserva(bookingId), 'PENDING');
      assert.equal(at(await pagosDe(bookingId), 0).status, 'PENDING');
      assert.equal((await movimientos(bookingId)).total, 0);

      assert.equal((await aprobar(paymentId, ctx.sessions.companyAdminB.token)).status, 200);
      assert.equal(await estadoReserva(bookingId), 'CONFIRMED');
    });

    it('13 · el OPERATOR no aprueba ni rechaza, ni gana permisos', async () => {
      const { bookingId, paymentId } = await pendienteDeVerificar();
      assert.equal(ctx.sessions.operator.user.permissions.includes('payments.create'), false);

      assert.equal((await aprobar(paymentId, ctx.sessions.operator.token)).status, 403);
      assert.equal((await rechazar(paymentId, ctx.sessions.operator.token)).status, 403);
      assert.equal(await estadoReserva(bookingId), 'PENDING');
      assert.equal((await movimientos(bookingId)).total, 0);
    });

    it('13b · un pago inexistente responde 404', async () => {
      assert.equal((await aprobar(999999)).status, 404);
    });

    it('13c · el backoffice que registra un pago manual en ventanilla sigue confirmándolo', async () => {
      const bookingId = await reservar();
      const res = await pagar(bookingId, { method: 'CASH' }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, 'CONFIRMED');
      assert.deepEqual(await movimientos(bookingId), { PAYMENT: 1, COMMISSION: 1, total: 2 });
    });
  });

  // =====================================================================
  describe('Idempotencia y concurrencia', () => {
    it('15/16 · aprobar dos veces no duplica PAYMENT, COMMISSION ni el aviso', async () => {
      const { bookingId, paymentId } = await pendienteDeVerificar();

      assert.equal((await aprobar(paymentId)).body.data.review_outcome, 'APPROVED');
      const segunda = await aprobar(paymentId, ctx.sessions.companyAdmin.token);
      assert.equal(segunda.status, 200);
      assert.equal(segunda.body.data.review_outcome, 'ALREADY_APPROVED');

      assert.deepEqual(await movimientos(bookingId), { PAYMENT: 1, COMMISSION: 1, total: 2 });
      assert.equal(await avisosDePago(bookingId), 1);
      assert.equal((await pagosDe(bookingId)).filter((pago) => pago.status === 'PAID').length, 1);
    });

    it('17 · aprobaciones simultáneas: una sola confirmación, un PAYMENT y una COMMISSION', async () => {
      const { bookingId, paymentId } = await pendienteDeVerificar();

      const respuestas = await Promise.all([
        aprobar(paymentId),
        aprobar(paymentId, ctx.sessions.companyAdmin.token),
        aprobar(paymentId),
        aprobar(paymentId, ctx.sessions.companyAdmin.token),
        aprobar(paymentId),
      ]);

      assert.deepEqual(respuestas.map((r) => r.status), [200, 200, 200, 200, 200], JSON.stringify(respuestas.map((r) => r.body)));
      const resultados = respuestas.map((r) => r.body.data.review_outcome).sort();
      assert.deepEqual(resultados, ['ALREADY_APPROVED', 'ALREADY_APPROVED', 'ALREADY_APPROVED', 'ALREADY_APPROVED', 'APPROVED']);
      assert.equal(await estadoReserva(bookingId), 'CONFIRMED');
      assert.deepEqual(await movimientos(bookingId), { PAYMENT: 1, COMMISSION: 1, total: 2 });
      assert.equal(await avisosDePago(bookingId), 1);
    });

    it('17b · aprobar y rechazar a la vez: gana una y el estado queda coherente', async () => {
      const { bookingId, paymentId } = await pendienteDeVerificar();

      const [a, r] = await Promise.all([aprobar(paymentId), rechazar(paymentId, ctx.sessions.companyAdmin.token)]);
      const exitos = [a.status, r.status].filter((status) => status === 200).length;
      assert.equal(exitos, 1, `aprobar=${a.status} rechazar=${r.status}`);
      assert.ok([a.status, r.status].includes(409));

      const [pago] = await pagosDe(bookingId);
      const mov = await movimientos(bookingId);
      if (pago!.status === 'PAID') {
        assert.equal(await estadoReserva(bookingId), 'CONFIRMED');
        assert.deepEqual(mov, { PAYMENT: 1, COMMISSION: 1, total: 2 });
      } else {
        assert.equal(pago!.status, 'FAILED');
        assert.equal(await estadoReserva(bookingId), 'PENDING');
        assert.equal(mov.total, 0);
      }
    });
  });

  // =====================================================================
  describe('Rechazo', () => {
    it('18 · rechazar: pago FAILED, reserva sin confirmar, sin movimientos ni reembolso; repetirlo no cambia nada', async () => {
      const { bookingId, paymentId } = await pendienteDeVerificar();

      const res = await rechazar(paymentId, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.review_outcome, 'REJECTED');

      const [pago] = await pagosDe(bookingId);
      assert.equal(pago!.status, 'FAILED');
      assert.equal(marca(pago!)?.status, 'REJECTED');
      assert.equal(marca(pago!)?.reason, 'No llegó el abono');
      assert.equal(await estadoReserva(bookingId), 'PENDING', 'sigue reteniendo con las reglas de siempre');
      assert.equal((await movimientos(bookingId)).total, 0);
      assert.equal(Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM refunds WHERE booking_id = ?', [bookingId]))?.n), 0);

      const otra = await rechazar(paymentId);
      assert.equal(otra.status, 200);
      assert.equal(otra.body.data.review_outcome, 'ALREADY_REJECTED');

      assert.equal((await aprobar(paymentId)).status, 409, 'un pago rechazado no se aprueba después');
      assert.equal(await estadoReserva(bookingId), 'PENDING');
      assert.equal((await movimientos(bookingId)).total, 0);
    });

    it('18b · tras un rechazo el pasajero declara otro pago y ese sí se puede aprobar', async () => {
      const { bookingId, paymentId } = await pendienteDeVerificar();
      await rechazar(paymentId);

      assert.equal((await pagar(bookingId, { method: 'TRANSFER' })).status, 202);
      const pagos = await pagosDe(bookingId);
      assert.deepEqual(pagos.map((pago) => [pago.status, pago.method]), [['FAILED', 'YAPE'], ['PENDING', 'TRANSFER']]);

      assert.equal((await aprobar(Number(pagos[1]!.id))).status, 200);
      assert.equal(await estadoReserva(bookingId), 'CONFIRMED');
      assert.deepEqual(await movimientos(bookingId), { PAYMENT: 1, COMMISSION: 1, total: 2 });
    });
  });

  // =====================================================================
  describe('Lo que no cambia', () => {
    it('19 · CARD individual sigue cobrando por Culqi y confirmando', async () => {
      const bookingId = await reservar();
      const res = await pagar(bookingId, { method: 'CARD', token: 'tkn_test_ejemplo1234' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, 'CONFIRMED');

      assert.equal(cargos.length, 1);
      const [pago] = await pagosDe(bookingId);
      assert.deepEqual(
        { status: pago!.status, method: pago!.method, provider: pago!.provider, id: pago!.provider_transaction_id },
        { status: 'PAID', method: 'CARD', provider: 'CULQI', id: 'chr_test_h22' },
      );
      assert.deepEqual(await movimientos(bookingId), { PAYMENT: 1, COMMISSION: 1, total: 2 });
    });

    it('19b · un pago con tarjeta no se aprueba ni se rechaza a mano', async () => {
      const bookingId = await reservar(ctx.fixtures.tripA, { payment_method: 'CARD' });
      const [pago] = await pagosDe(bookingId);
      assert.equal((await aprobar(Number(pago!.id))).status, 400);
      assert.equal((await rechazar(Number(pago!.id))).status, 400);
      assert.equal(await estadoReserva(bookingId), 'PENDING');
    });

    it('20 · CARD en itinerario sigue bloqueado por H-23', async () => {
      const grupo = await post(
        '/bookings/itineraries',
        {
          trip_type: 'ROUND_TRIP',
          segments: [
            { trip_id: ctx.fixtures.tripA, seat_ids: [at(await freeSeats(ctx.fixtures.tripA), 0).id] },
            { trip_id: tripVuelta, seat_ids: [at(await freeSeats(tripVuelta), 1).id] },
          ],
          passenger_email: 'cliente@test.pe',
        },
        ctx.sessions.customer.token,
      );
      assert.equal(grupo.status, 201, JSON.stringify(grupo.body));
      const res = await post(`/bookings/itineraries/${grupo.body.data.group_id}/pay`, { method: 'CARD' }, ctx.sessions.customer.token);
      assert.equal(res.status, 400);
      assert.equal(res.body.message, ITINERARY_CARD_NOT_SUPPORTED);
    });

    it('20b · en un itinerario el pasajero también solo registra, y cada tramo se aprueba aparte', async () => {
      const grupo = await post(
        '/bookings/itineraries',
        {
          trip_type: 'ROUND_TRIP',
          segments: [
            { trip_id: ctx.fixtures.tripA, seat_ids: [at(await freeSeats(ctx.fixtures.tripA), 0).id] },
            { trip_id: tripVuelta, seat_ids: [at(await freeSeats(tripVuelta), 1).id] },
          ],
          passenger_email: 'cliente@test.pe',
        },
        ctx.sessions.customer.token,
      );
      const groupId = Number(grupo.body.data.group_id);

      const res = await post(`/bookings/itineraries/${groupId}/pay`, { method: 'YAPE', status: 'PAID' }, ctx.sessions.customer.token);
      assert.equal(res.status, 202, JSON.stringify(res.body));

      const tramos = await query<{ id: number }>('SELECT id FROM bookings WHERE group_id = ? ORDER BY segment_order', [groupId]);
      for (const tramo of tramos) {
        assert.equal(await estadoReserva(tramo.id), 'PENDING');
        assert.deepEqual((await pagosDe(tramo.id)).map((pago) => pago.status), ['PENDING']);
        assert.equal((await movimientos(tramo.id)).total, 0);
      }

      for (const tramo of tramos) assert.equal((await aprobar(Number(at(await pagosDe(tramo.id), 0).id))).status, 200);
      for (const tramo of tramos) {
        assert.equal(await estadoReserva(tramo.id), 'CONFIRMED');
        assert.deepEqual(await movimientos(tramo.id), { PAYMENT: 1, COMMISSION: 1, total: 2 });
      }
    });

    it('21 · la expiración cierra un pago manual pendiente como siempre, y ya no se puede aprobar', async () => {
      const { bookingId, paymentId } = await pendienteDeVerificar();
      const libresAntes = (await freeSeats(ctx.fixtures.tripA)).length;
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [bookingId]);

      await expireDueBookings();

      assert.equal(await estadoReserva(bookingId), 'EXPIRED');
      assert.equal(at(await pagosDe(bookingId), 0).status, 'CANCELLED');
      assert.equal((await freeSeats(ctx.fixtures.tripA)).length, libresAntes + 1, 'libera su asiento');

      assert.equal((await aprobar(paymentId)).status, 409);
      assert.equal(await estadoReserva(bookingId), 'EXPIRED');
      assert.equal((await movimientos(bookingId)).total, 0);
    });

    it('21b · cancelar el viaje cierra el pago manual pendiente y ya no se aprueba', async () => {
      const { bookingId, paymentId } = await pendienteDeVerificar();
      assert.equal((await post(`/trips/${ctx.fixtures.tripA}/cancel`, {}, ctx.sessions.companyAdmin.token)).status, 200);

      assert.equal(await estadoReserva(bookingId), 'CANCELLED');
      assert.equal(at(await pagosDe(bookingId), 0).status, 'CANCELLED');
      assert.equal((await aprobar(paymentId)).status, 409);
      assert.equal((await movimientos(bookingId)).total, 0);
      const reembolsos = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM refunds WHERE booking_id = ?', [bookingId]);
      assert.equal(Number(reembolsos?.n), 0, 'sin cobro no hay nada que devolver');
    });
  });
});
