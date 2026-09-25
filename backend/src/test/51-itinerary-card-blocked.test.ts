import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { api, post } from './helpers/api';
import { env } from '../config/env';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { loadAuthenticatedUser } from '../repositories/user.repository';
import { setCulqiApi, type CulqiApi, type CulqiCharge } from '../services/culqi.service';
import { ITINERARY_CARD_NOT_SUPPORTED, payItinerary } from '../services/itinerary.service';
import { ApiError } from '../utils/ApiError';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * H-23 · la tarjeta no confirma un itinerario.
 *
 * POR QUÉ EXISTE. `POST /bookings/itineraries/:id/pay` no pasa por Culqi, y con
 * `method: 'CARD'` confirmaba todos los tramos y dejaba pagos PAID con método tarjeta sin
 * ningún cargo detrás. Ahora la tarjeta se rechaza con 400 antes de tocar nada. Lo que se
 * defiende aquí es que ese rechazo no deja rastro —ni reservas, ni pagos, ni movimientos,
 * ni asientos, ni reembolsos—, que los demás métodos siguen igual y que la compra de un solo
 * tramo con tarjeta sigue cobrando por Culqi.
 *
 * Culqi es un doble en todas las pruebas: ninguna sale a la red.
 */
describe('H-23 · tarjeta bloqueada en el pago de itinerarios', () => {
  let ctx: SuiteContext;
  let tripVuelta: number;
  const cargos: Array<Record<string, unknown>> = [];

  const culqiFalso: CulqiApi = {
    async createCharge(input) {
      cargos.push({ ...input });
      return {
        ok: true,
        data: {
          id: 'chr_test_h23',
          amount: input.amountCents,
          currency_code: input.currencyCode,
          outcome: { type: 'venta_exitosa', user_message: 'Pago exitoso' },
        } as CulqiCharge,
      };
    },
    async getCharge() {
      throw new Error('no se espera ninguna relectura en estas pruebas');
    },
    async createRefund() {
      throw new Error('no se espera ninguna devolución en estas pruebas');
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
    await execute('UPDATE trips t JOIN buses b ON b.id = t.bus_id SET t.available_seats = b.capacity');
  });
  afterEach(() => {
    setCulqiApi(null);
    env.culqi.publicKey = '';
    env.culqi.privateKey = '';
  });

  /** Ida y vuelta de un asiento por tramo, creado sin método de pago. */
  async function crearItinerario(): Promise<number> {
    const segments: Array<{ trip_id: number; seat_ids: number[] }> = [];
    for (const tripId of [ctx.fixtures.tripA, tripVuelta]) {
      segments.push({ trip_id: tripId, seat_ids: [at(await freeSeats(tripId), 0).id] });
    }
    const res = await post(
      '/bookings/itineraries',
      { trip_type: 'ROUND_TRIP', segments, passenger_email: 'cliente@test.pe' },
      ctx.sessions.customer.token,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return Number(res.body.data.group_id);
  }

  // Por defecto el pasajero. Los métodos manuales solo confirman desde el backoffice (H-22).
  const pagar = (groupId: number, body: unknown, token = ctx.sessions.customer.token) =>
    api(`/bookings/itineraries/${groupId}/pay`, { method: 'POST', body, token });

  /** Todo lo que un pago podría cambiar, para comparar antes y después. */
  async function fotografia(groupId: number) {
    const reservas = await query<{ id: number; status: string; confirmed_at: string | null; expires_at: string | null }>(
      'SELECT id, status, confirmed_at, expires_at FROM bookings WHERE group_id = ? ORDER BY segment_order',
      [groupId],
    );
    const ids = reservas.map((reserva) => reserva.id);
    const pagos = await query<Record<string, unknown>>(
      'SELECT id, booking_id, status, method, provider, provider_transaction_id, paid_at FROM payments WHERE booking_id IN (?) ORDER BY id',
      [ids],
    );
    const movimientos = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM financial_transactions WHERE booking_id IN (?)', [ids]);
    const reembolsos = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM refunds WHERE booking_id IN (?)', [ids]);
    const cupos = await query<{ id: number; available_seats: number }>(
      'SELECT id, available_seats FROM trips WHERE id IN (?, ?) ORDER BY id',
      [ctx.fixtures.tripA, tripVuelta],
    );
    const libres = [(await freeSeats(ctx.fixtures.tripA)).length, (await freeSeats(tripVuelta)).length];
    return {
      reservas,
      pagos,
      movimientos: Number(movimientos?.n),
      reembolsos: Number(reembolsos?.n),
      cupos,
      libres,
    };
  }

  // =====================================================================
  describe('CARD se rechaza sin efectos', () => {
    it('1 · CARD responde 400 con el mensaje de itinerarios', async () => {
      const groupId = await crearItinerario();
      const res = await pagar(groupId, { method: 'CARD' });

      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, ITINERARY_CARD_NOT_SUPPORTED);
      assert.equal(res.body.errors?.method, ITINERARY_CARD_NOT_SUPPORTED);
    });

    it('2 · CARD no confirma reservas, no crea pagos ni movimientos, no toca asientos ni abre reembolsos', async () => {
      const groupId = await crearItinerario();
      const antes = await fotografia(groupId);
      assert.ok(antes.reservas.length === 2 && antes.reservas.every((reserva) => reserva.status === 'PENDING'));
      assert.equal(antes.pagos.length, 0, 'se creó sin método: no hay pagos');

      assert.equal((await pagar(groupId, { method: 'CARD' })).status, 400);

      const despues = await fotografia(groupId);
      assert.deepEqual(despues, antes);
      assert.equal(despues.movimientos, 0, 'ni PAYMENT ni COMMISSION');
      assert.equal(despues.reembolsos, 0);
      assert.equal(cargos.length, 0, 'no se pidió ningún cargo a Culqi');
    });

    it('3 · un token o un identificador de cargo en el cuerpo no cambian nada', async () => {
      const groupId = await crearItinerario();
      const antes = await fotografia(groupId);

      for (const body of [
        { method: 'CARD', token: 'tkn_test_ejemplo1234' },
        { method: 'CARD', provider_transaction_id: 'chr_inventado' },
      ]) {
        assert.equal((await pagar(groupId, body)).status, 400, JSON.stringify(body));
      }

      assert.deepEqual(await fotografia(groupId), antes);
      const falso = await queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM payments WHERE provider_transaction_id = 'chr_inventado'");
      assert.equal(Number(falso?.n), 0);
      assert.equal(cargos.length, 0);
    });

    it('4 · variantes de CARD (capitalización, espacios, tipos) tampoco confirman', async () => {
      const groupId = await crearItinerario();
      const antes = await fotografia(groupId);

      for (const method of ['card', 'Card', ' CARD', 'CARD ', ['CARD'], { value: 'CARD' }, null]) {
        const res = await pagar(groupId, { method });
        assert.ok(res.status === 400 || res.status === 422, `${JSON.stringify(method)} -> ${res.status}`);
      }
      assert.equal((await pagar(groupId, {})).status, 422, 'sin método');

      assert.deepEqual(await fotografia(groupId), antes);
    });

    it('5 · el servicio también rechaza CARD si se le llama directamente', async () => {
      const groupId = await crearItinerario();
      const antes = await fotografia(groupId);
      const usuario = await loadAuthenticatedUser(ctx.fixtures.users.customer);
      assert.ok(usuario);

      await assert.rejects(
        payItinerary(groupId, usuario, 'CARD', 'chr_inventado'),
        (error: unknown) => error instanceof ApiError && error.statusCode === 400,
      );

      assert.deepEqual(await fotografia(groupId), antes);
    });

    it('6 · tras el rechazo el itinerario sigue pendiente y se paga entero con otro método', async () => {
      const groupId = await crearItinerario();
      assert.equal((await pagar(groupId, { method: 'CARD' })).status, 400);

      const res = await pagar(groupId, { method: 'CASH' }, ctx.sessions.admin.token);
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const despues = await fotografia(groupId);
      assert.deepEqual(despues.reservas.map((reserva) => reserva.status), ['CONFIRMED', 'CONFIRMED'], 'ningún tramo a medias');
      assert.deepEqual(despues.pagos.map((pago) => [pago.status, pago.method]), [['PAID', 'CASH'], ['PAID', 'CASH']]);
    });
  });

  // =====================================================================
  describe('Los demás métodos siguen igual', () => {
    for (const method of ['CASH', 'TRANSFER', 'YAPE', 'PLIN', 'OTHER'] as const) {
      it(`7 · ${method} confirma los dos tramos como antes, sin pasarela ni reembolsos`, async () => {
        const groupId = await crearItinerario();
        const res = await pagar(groupId, { method }, ctx.sessions.admin.token);
        assert.equal(res.status, 200, JSON.stringify(res.body));

        const despues = await fotografia(groupId);
        assert.deepEqual(despues.reservas.map((reserva) => reserva.status), ['CONFIRMED', 'CONFIRMED']);
        assert.equal(despues.pagos.length, 2, 'un pago por tramo');
        for (const pago of despues.pagos) {
          assert.equal(pago.status, 'PAID');
          assert.equal(pago.method, method);
          assert.equal(pago.provider, null);
          assert.equal(pago.provider_transaction_id, null, 'el itinerario no inventa identificadores de cargo');
        }
        const ventas = await queryOne<{ n: number }>(
          "SELECT COUNT(*) AS n FROM financial_transactions WHERE type = 'PAYMENT' AND company_id IS NOT NULL AND booking_id IN (?)",
          [despues.reservas.map((reserva) => reserva.id)],
        );
        assert.equal(Number(ventas?.n), 2);
        assert.equal(despues.reembolsos, 0);
        assert.equal(cargos.length, 0);
      });
    }
  });

  // =====================================================================
  describe('La compra de un tramo con tarjeta no cambia', () => {
    it('8 · POST /bookings/:id/pay con CARD sigue cobrando por Culqi', async () => {
      const reserva = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [at(await freeSeats(ctx.fixtures.tripA), 0).id], passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token,
      );
      assert.equal(reserva.status, 201, JSON.stringify(reserva.body));

      const res = await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'CARD', token: 'tkn_test_ejemplo1234' }, ctx.sessions.customer.token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, 'CONFIRMED');

      assert.equal(cargos.length, 1, 'un cargo a Culqi');
      assert.equal(cargos[0]!.amountCents, Math.round(Number(reserva.body.data.total_amount) * 100));
      const pago = await queryOne<{ status: string; method: string; provider: string; provider_transaction_id: string }>(
        'SELECT status, method, provider, provider_transaction_id FROM payments WHERE booking_id = ?',
        [reserva.body.data.id],
      );
      assert.deepEqual(pago, { status: 'PAID', method: 'CARD', provider: 'CULQI', provider_transaction_id: 'chr_test_h23' });
    });
  });
});
