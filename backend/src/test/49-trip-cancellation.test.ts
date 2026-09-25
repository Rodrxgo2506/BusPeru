import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { get, post, put } from './helpers/api';
import { execute, pool, query, queryOne } from '../config/database';
import { env } from '../config/env';
import { expireDueBookings } from '../services/booking-expiry.service';
import { emailTransport, type MemoryTransport } from '../services/email.service';
import { setCulqiApi, type CulqiApi } from '../services/culqi.service';
import { at, freeSeats } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * FASE 8H · cancelar un viaje cancela sus reservas, libera sus asientos, abre los reembolsos
 * de lo cobrado y avisa a cada pasajero, en una sola transacción.
 *
 * POR QUÉ EXISTE (auditoría 8G). `POST /trips/:id/cancel` solo cambiaba `trips.status`. Las
 * reservas pagadas quedaban CONFIRMED para siempre, sin reembolso ni aviso; una reserva
 * PENDING podía pagarse después; y `PUT /trips/:id` permitía reactivar un viaje cancelado.
 *
 * NINGUNA prueba sale a la red: Culqi se sustituye con `setCulqiApi` y el correo va al
 * transporte en memoria que ya usa la suite.
 */
describe('FASE 8H · cancelación de viajes, reservas y reembolsos', () => {
  let ctx: SuiteContext;
  let buzon: MemoryTransport;
  const TOKEN = 'tkn_test_ejemplo1234';
  let secuencia = 0;

  before(async () => {
    ctx = await prepareSuite();
    buzon = emailTransport() as MemoryTransport;
  });
  after(async () => {
    setCulqiApi(null);
    await teardownSuite();
  });
  beforeEach(() => {
    env.culqi.publicKey = 'pk_test_solo_para_pruebas';
    env.culqi.privateKey = 'sk_test_solo_para_pruebas';
    env.culqi.webhookSecret = 'secreto-de-webhook-para-pruebas';
    buzon.clear();
  });
  afterEach(() => {
    setCulqiApi(null);
    env.culqi.publicKey = '';
    env.culqi.privateKey = '';
  });

  // ------------------------------------------------------------------ utilidades

  /** Doble de Culqi. `retrasoDevolucion` alarga la devolución para forzar solapamientos. */
  function culqiFalso(
    opciones: {
      falloDevolucion?: boolean;
      retrasoDevolucion?: number;
      /** El cobro responde TIMEOUT aunque Culqi lo haya cobrado: el caso que resuelve el webhook. */
      cargoSinRespuesta?: boolean;
      /** Lo que devuelve `getCharge` al releer un cargo desde el webhook. */
      cargoReleido?: { id: string; amountCents: number; paymentId: number };
    } = {},
  ) {
    const cargos: Array<{ amountCents: number }> = [];
    const devoluciones: Array<{ chargeId: string; amountCents: number }> = [];
    const api: CulqiApi = {
      async createCharge(input) {
        cargos.push({ amountCents: input.amountCents });
        if (opciones.cargoSinRespuesta) {
          return { ok: false, kind: 'TIMEOUT', code: null, userMessage: 'Culqi no respondió a tiempo', merchantMessage: 'timeout de prueba' };
        }
        return {
          ok: true,
          data: {
            id: `chr_test_${cargos.length}_${Date.now()}`,
            amount: input.amountCents,
            currency_code: input.currencyCode,
            outcome: { type: 'venta_exitosa', user_message: 'Pago exitoso' },
          } as never,
        };
      },
      async getCharge(id) {
        const releido = opciones.cargoReleido;
        if (!releido || releido.id !== id) {
          return { ok: false, kind: 'PROVIDER', code: null, userMessage: 'no disponible', merchantMessage: 'no disponible' };
        }
        return {
          ok: true,
          data: {
            id: releido.id,
            amount: releido.amountCents,
            currency_code: 'PEN',
            outcome: { type: 'venta_exitosa', user_message: 'Pago exitoso' },
            metadata: { payment_id: String(releido.paymentId) },
          } as never,
        };
      },
      async createRefund(input) {
        if (opciones.retrasoDevolucion) await new Promise((resolve) => setTimeout(resolve, opciones.retrasoDevolucion));
        if (opciones.falloDevolucion) {
          return { ok: false, kind: 'PROVIDER', code: 'provider_error', userMessage: 'Culqi no respondió', merchantMessage: 'error de prueba' };
        }
        devoluciones.push({ chargeId: input.chargeId, amountCents: input.amountCents });
        return { ok: true, data: { id: `ref_test_${devoluciones.length}`, charge_id: input.chargeId, amount: input.amountCents } };
      },
    };
    return { api, cargos, devoluciones };
  }

  const fecha = (dias: number, hora: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + dias);
    d.setHours(hora, 0, 0, 0);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  };

  /** Viaje nuevo, con su versión de distribución, en el estado pedido. */
  async function nuevoViaje(status = 'SCHEDULED', empresa: 'A' | 'B' = 'A'): Promise<number> {
    secuencia += 1;
    const { routeA, busA, layoutA, routeB, busB, layoutB } = ctx.fixtures;
    const [route, bus, layout, cupos] = empresa === 'A' ? [routeA, busA, layoutA, 12] : [routeB, busB, layoutB, 8];
    const res = await execute(
      `INSERT INTO trips (route_id, bus_id, bus_layout_id, departure_datetime, arrival_datetime, base_price, available_seats, status)
       VALUES (?, ?, ?, ?, ?, 40.00, ?, ?)`,
      [route, bus, layout, fecha(10 + secuencia, 20), fecha(11 + secuencia, 6), cupos, status],
    );
    return res.insertId;
  }

  const viaje = (tripId: number) =>
    queryOne<{ status: string; available_seats: number }>('SELECT status, available_seats FROM trips WHERE id = ?', [tripId]);

  const reserva = (bookingId: number) =>
    queryOne<{ status: string; notes: string | null }>('SELECT status, notes FROM bookings WHERE id = ?', [bookingId]);

  const pagoDe = (bookingId: number) =>
    queryOne<{ id: number; status: string; amount: string; provider: string | null }>(
      'SELECT id, status, amount, provider FROM payments WHERE booking_id = ? ORDER BY id DESC LIMIT 1',
      [bookingId],
    );

  const reembolsosDe = (bookingId: number) =>
    query<{ id: number; status: string; amount: string; provider_refund_id: string | null }>(
      'SELECT id, status, amount, provider_refund_id FROM refunds WHERE booking_id = ? ORDER BY id',
      [bookingId],
    );

  // Libro de la EMPRESA. Desde 11E-2 (H-26) los compensatorios se asientan aparte, en el libro de la
  // plataforma (`company_id` NULL), que se consulta con `libroPlataformaDe`.
  const movimientosDe = (bookingId: number) =>
    query<{ type: string; direction: string; amount: string }>(
      'SELECT type, direction, amount FROM financial_transactions WHERE booking_id = ? AND company_id IS NOT NULL ORDER BY id',
      [bookingId],
    );
  const libroPlataformaDe = (bookingId: number) =>
    query<{ type: string; direction: string; amount: string }>(
      'SELECT type, direction, amount FROM financial_transactions WHERE booking_id = ? AND company_id IS NULL ORDER BY id',
      [bookingId],
    );

  const avisosDe = (bookingId: number) =>
    query<{ title: string; message: string }>(
      "SELECT title, message FROM notifications WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.event')) = 'trip.cancelled' AND JSON_EXTRACT(data, '$.booking_id') = ?",
      [bookingId],
    );

  /** Reserva de un asiento libre. `pagar` la deja CONFIRMED y con su pago PAID. */
  async function reservar(tripId: number, pagar: false | 'CASH' | 'TRANSFER' | 'CARD' = false) {
    const asiento = at(await freeSeats(tripId), 0);
    const creada = await post(
      '/bookings',
      { trip_id: tripId, seat_ids: [asiento.id], passenger_email: 'cliente@test.pe', payment_method: pagar || 'CASH' },
      ctx.sessions.customer.token,
    );
    assert.equal(creada.status, 201, JSON.stringify(creada.body));
    const bookingId = Number(creada.body.data.id);
    if (pagar) {
      const cuerpo = pagar === 'CARD' ? { method: 'CARD', token: TOKEN } : { method: pagar };
      // H-22: la tarjeta la cobra el pasajero por Culqi; un pago manual lo registra el backoffice.
      const pago = await post(`/bookings/${bookingId}/pay`, cuerpo, pagar === 'CARD' ? ctx.sessions.customer.token : ctx.sessions.admin.token);
      assert.equal(pago.status, 200, JSON.stringify(pago.body));
    }
    return { bookingId, seatId: asiento.id };
  }

  const cancelar = (tripId: number, token = ctx.sessions.companyAdmin.token) => post(`/trips/${tripId}/cancel`, {}, token);

  const asientoTomado = async (tripId: number, seatId: number) => {
    const mapa = await get(`/public/trips/${tripId}/seats`);
    if (mapa.status !== 200) {
      // El viaje cancelado ya no es público: se mira el mapa interno de la empresa.
      const interno = await get(`/trips/${tripId}/seats`, ctx.sessions.companyAdmin.token);
      return (interno.body.data as Array<{ id: number; is_taken: number }>).find((s) => s.id === seatId)?.is_taken === 1;
    }
    return (mapa.body.data as Array<{ id: number; is_taken: number }>).find((s) => s.id === seatId)?.is_taken === 1;
  };

  // =====================================================================
  describe('Transiciones de estado', () => {
    for (const [letra, estado] of [['A', 'SCHEDULED'], ['B', 'BOARDING'], ['C', 'DELAYED']] as const) {
      it(`${letra} · ${estado} → CANCELLED se permite`, async () => {
        const tripId = await nuevoViaje(estado);
        const res = await cancelar(tripId);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal((await viaje(tripId))?.status, 'CANCELLED');
        assert.equal(res.body.data.cancellation.already_cancelled, false);
      });
    }

    for (const [letra, estado] of [['D', 'IN_PROGRESS'], ['E', 'COMPLETED']] as const) {
      it(`${letra} · ${estado} → CANCELLED se rechaza y no toca nada`, async () => {
        const tripId = await nuevoViaje(estado);
        const res = await cancelar(tripId);
        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.equal((await viaje(tripId))?.status, estado);
      });
    }

    it('F · un viaje CANCELLED no vuelve a ningún estado por PUT', async () => {
      const tripId = await nuevoViaje();
      assert.equal((await cancelar(tripId)).status, 200);
      for (const estado of ['SCHEDULED', 'BOARDING', 'DELAYED', 'IN_PROGRESS', 'COMPLETED']) {
        const res = await put(`/trips/${tripId}`, { status: estado }, ctx.sessions.admin.token);
        assert.equal(res.status, 400, `${estado}: ${JSON.stringify(res.body)}`);
      }
      assert.equal((await viaje(tripId))?.status, 'CANCELLED');
    });

    it('F2 · PUT no puede cancelar un viaje saltándose sus efectos', async () => {
      const tripId = await nuevoViaje('IN_PROGRESS');
      const programado = await nuevoViaje();
      const { bookingId } = await reservar(programado, 'CASH');

      assert.equal((await put(`/trips/${tripId}`, { status: 'CANCELLED' }, ctx.sessions.admin.token)).status, 400);
      assert.equal((await put(`/trips/${programado}`, { status: 'CANCELLED' }, ctx.sessions.companyAdmin.token)).status, 400);
      assert.equal((await viaje(programado))?.status, 'SCHEDULED');
      assert.equal((await reserva(bookingId))?.status, 'CONFIRMED', 'la reserva no quedó a medias');
    });

    it('F3 · PUT sigue editando lo demás de un viaje no cancelado', async () => {
      const tripId = await nuevoViaje();
      const res = await put(`/trips/${tripId}`, { status: 'DELAYED', boarding_notes: 'Salida retrasada' }, ctx.sessions.operator.token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((await viaje(tripId))?.status, 'DELAYED');
    });
  });

  // =====================================================================
  describe('Quién puede cancelar', () => {
    it('G · OPERATOR no puede cancelar un viaje de su empresa', async () => {
      const tripId = await nuevoViaje();
      const { bookingId } = await reservar(tripId, 'CASH');

      const res = await cancelar(tripId, ctx.sessions.operator.token);
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal((await viaje(tripId))?.status, 'SCHEDULED');
      assert.equal((await reserva(bookingId))?.status, 'CONFIRMED');
      assert.equal((await reembolsosDe(bookingId)).length, 0);
    });

    it('H · COMPANY_ADMIN solo cancela viajes de su empresa', async () => {
      const ajeno = await nuevoViaje('SCHEDULED', 'B');
      const res = await cancelar(ajeno, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 404, 'no confirma que el viaje exista');
      assert.equal((await viaje(ajeno))?.status, 'SCHEDULED');

      const propio = await nuevoViaje();
      assert.equal((await cancelar(propio, ctx.sessions.companyAdmin.token)).status, 200);
    });

    it('I · ADMIN cancela viajes de cualquier empresa', async () => {
      const tripA = await nuevoViaje('SCHEDULED', 'A');
      const tripB = await nuevoViaje('SCHEDULED', 'B');
      assert.equal((await cancelar(tripA, ctx.sessions.admin.token)).status, 200);
      assert.equal((await cancelar(tripB, ctx.sessions.admin.token)).status, 200);
    });

    it('W · aislamiento: la empresa B no cancela ni afecta reservas de la A', async () => {
      const tripId = await nuevoViaje('SCHEDULED', 'A');
      const { bookingId } = await reservar(tripId, 'CASH');

      const res = await cancelar(tripId, ctx.sessions.companyAdminB.token);
      assert.equal(res.status, 404);
      assert.equal((await viaje(tripId))?.status, 'SCHEDULED');
      assert.equal((await reserva(bookingId))?.status, 'CONFIRMED');
      assert.equal((await reembolsosDe(bookingId)).length, 0);
      assert.equal((await avisosDe(bookingId)).length, 0);
    });
  });

  // =====================================================================
  describe('Reservas afectadas', () => {
    it('J · booking PENDING: queda CANCELLED, libera su asiento, cierra su pago y no abre reembolso', async () => {
      const tripId = await nuevoViaje();
      const antes = Number((await viaje(tripId))?.available_seats);
      const { bookingId, seatId } = await reservar(tripId);
      assert.equal(Number((await viaje(tripId))?.available_seats), antes - 1);
      assert.equal(await asientoTomado(tripId, seatId), true);

      const res = await cancelar(tripId);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.cancellation.bookings_cancelled, 1);
      assert.equal(res.body.data.cancellation.refunds_created, 0);

      assert.equal((await reserva(bookingId))?.status, 'CANCELLED');
      assert.equal(Number((await viaje(tripId))?.available_seats), antes, 'V · cupos restaurados');
      assert.equal(await asientoTomado(tripId, seatId), false, 'el asiento ya no está retenido');
      assert.equal((await reembolsosDe(bookingId)).length, 0);
      assert.equal((await pagoDe(bookingId))?.status, 'CANCELLED', 'el pago pendiente no queda cobrable');
    });

    it('K · booking CONFIRMED + PAID: queda CANCELLED, libera su asiento y abre UN reembolso PENDING', async () => {
      const tripId = await nuevoViaje();
      const antes = Number((await viaje(tripId))?.available_seats);
      const { bookingId, seatId } = await reservar(tripId, 'CASH');
      const pago = await pagoDe(bookingId);
      assert.equal(pago?.status, 'PAID');

      const res = await cancelar(tripId);
      assert.equal(res.body.data.cancellation.refunds_created, 1);

      assert.equal((await reserva(bookingId))?.status, 'CANCELLED');
      assert.equal(await asientoTomado(tripId, seatId), false);
      assert.equal(Number((await viaje(tripId))?.available_seats), antes);

      const reembolsos = await reembolsosDe(bookingId);
      assert.equal(reembolsos.length, 1);
      assert.equal(reembolsos[0]!.status, 'PENDING', 'el dinero no se da por devuelto');
      assert.equal(Number(reembolsos[0]!.amount), Number(pago?.amount));
      assert.equal((await pagoDe(bookingId))?.status, 'PAID', 'el pago sigue PAID hasta procesar el reembolso');
    });

    it('U · booking_seats se conserva tras cancelar', async () => {
      const tripId = await nuevoViaje();
      const pendiente = await reservar(tripId);
      const pagada = await reservar(tripId, 'CASH');
      const filas = async () =>
        Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM booking_seats WHERE trip_id = ?', [tripId]))?.n);
      const antes = await filas();

      await cancelar(tripId);
      assert.equal(await filas(), antes);
      assert.ok(await queryOne('SELECT id FROM booking_seats WHERE booking_id = ?', [pendiente.bookingId]));
      assert.ok(await queryOne('SELECT id FROM booking_seats WHERE booking_id = ?', [pagada.bookingId]));
    });

    it('V · available_seats vuelve a la capacidad aunque haya varias reservas de distinto estado', async () => {
      const tripId = await nuevoViaje();
      const capacidad = Number((await viaje(tripId))?.available_seats);
      await reservar(tripId);
      await reservar(tripId, 'CASH');
      await reservar(tripId, 'TRANSFER');
      assert.equal(Number((await viaje(tripId))?.available_seats), capacidad - 3);

      await cancelar(tripId);
      assert.equal(Number((await viaje(tripId))?.available_seats), capacidad);
    });

    it('las reservas ya CANCELLED o EXPIRED no se tocan ni suman cupos', async () => {
      const tripId = await nuevoViaje();
      const capacidad = Number((await viaje(tripId))?.available_seats);
      const { bookingId } = await reservar(tripId);
      await execute("UPDATE bookings SET status = 'EXPIRED' WHERE id = ?", [bookingId]);
      await execute('UPDATE trips SET available_seats = ? WHERE id = ?', [capacidad, tripId]);

      const res = await cancelar(tripId);
      assert.equal(res.body.data.cancellation.bookings_cancelled, 0);
      assert.equal((await reserva(bookingId))?.status, 'EXPIRED');
      assert.equal(Number((await viaje(tripId))?.available_seats), capacidad);
    });
  });

  // =====================================================================
  describe('Idempotencia y concurrencia', () => {
    it('L · cancelar dos veces no duplica reembolsos, cupos, movimientos ni avisos', async () => {
      const tripId = await nuevoViaje();
      const { bookingId } = await reservar(tripId, 'CASH');

      assert.equal((await cancelar(tripId)).status, 200);
      const estado = {
        seats: (await viaje(tripId))?.available_seats,
        refunds: (await reembolsosDe(bookingId)).length,
        movimientos: (await movimientosDe(bookingId)).length,
        avisos: (await avisosDe(bookingId)).length,
      };

      const segunda = await cancelar(tripId);
      assert.equal(segunda.status, 200);
      assert.equal(segunda.body.data.cancellation.already_cancelled, true);
      assert.deepEqual(
        {
          seats: (await viaje(tripId))?.available_seats,
          refunds: (await reembolsosDe(bookingId)).length,
          movimientos: (await movimientosDe(bookingId)).length,
          avisos: (await avisosDe(bookingId)).length,
        },
        estado,
      );
      assert.equal(estado.refunds, 1);
      assert.equal(estado.avisos, 1);
    });

    it('R · dos cancelaciones simultáneas del mismo viaje abren un solo reembolso', async () => {
      const tripId = await nuevoViaje();
      const { bookingId } = await reservar(tripId, 'CASH');
      const capacidad = 12;

      const [uno, dos] = await Promise.all([cancelar(tripId), cancelar(tripId, ctx.sessions.admin.token)]);
      assert.equal(uno.status, 200, JSON.stringify(uno.body));
      assert.equal(dos.status, 200, JSON.stringify(dos.body));
      assert.equal(
        [uno, dos].filter((res) => res.body.data.cancellation.already_cancelled === false).length,
        1,
        'solo una de las dos hizo el trabajo',
      );
      assert.equal((await reembolsosDe(bookingId)).length, 1);
      assert.equal(Number((await viaje(tripId))?.available_seats), capacidad);
    });

    it('R2 · dos procesamientos simultáneos del mismo reembolso piden a Culqi una sola devolución', async () => {
      const doble = culqiFalso({ retrasoDevolucion: 150 });
      setCulqiApi(doble.api);
      const tripId = await nuevoViaje();
      const { bookingId } = await reservar(tripId, 'CARD');
      await cancelar(tripId);
      const refundId = at(await reembolsosDe(bookingId), 0).id;

      const procesar = () => post(`/refunds/${refundId}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token);
      const resultados = await Promise.all([procesar(), procesar()]);

      assert.deepEqual(resultados.map((res) => res.status).sort(), [200, 409], JSON.stringify(resultados.map((r) => r.body)));
      assert.equal(doble.devoluciones.length, 1, 'Culqi solo ve una devolución');
      const movimientos = (await movimientosDe(bookingId)).filter((m) => m.type === 'REFUND');
      assert.equal(movimientos.length, 1, 'un solo movimiento de reembolso');
      assert.equal((await pagoDe(bookingId))?.status, 'REFUNDED');
    });
  });

  // =====================================================================
  describe('Pagos después de cancelar', () => {
    for (const [letra, metodo] of [['M', 'CARD'], ['N', 'CASH'], ['O', 'TRANSFER']] as const) {
      it(`${letra} · ${metodo} se rechaza sobre la reserva de un viaje cancelado`, async () => {
        const doble = culqiFalso();
        setCulqiApi(doble.api);
        const tripId = await nuevoViaje();
        const { bookingId } = await reservar(tripId);
        await cancelar(tripId);

        const cuerpo = metodo === 'CARD' ? { method: 'CARD', token: TOKEN } : { method: metodo };
        const res = await post(`/bookings/${bookingId}/pay`, cuerpo, ctx.sessions.customer.token);
        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.equal((await reserva(bookingId))?.status, 'CANCELLED');
        assert.notEqual((await pagoDe(bookingId))?.status, 'PAID');
        assert.equal(doble.cargos.length, 0, 'no se pidió ningún cargo a Culqi');
      });

      it(`${letra}2 · ${metodo} se rechaza aunque la reserva siguiera PENDING (el estado del viaje manda)`, async () => {
        const doble = culqiFalso();
        setCulqiApi(doble.api);
        const tripId = await nuevoViaje();
        const { bookingId } = await reservar(tripId);
        // Viaje cancelado por una vía que no tocó sus reservas (datos anteriores a 8H).
        await execute("UPDATE trips SET status = 'CANCELLED' WHERE id = ?", [tripId]);

        const cuerpo = metodo === 'CARD' ? { method: 'CARD', token: TOKEN } : { method: metodo };
        const res = await post(`/bookings/${bookingId}/pay`, cuerpo, ctx.sessions.customer.token);
        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.match(String(res.body.message), /viaje fue cancelado/);
        assert.equal((await reserva(bookingId))?.status, 'PENDING');
        assert.notEqual((await pagoDe(bookingId))?.status, 'PAID');
        assert.equal(doble.cargos.length, 0, 'no se pidió ningún cargo a Culqi');
      });
    }
  });

  // =====================================================================
  describe('Reembolso con Culqi', () => {
    it('Q · si Culqi falla, el reembolso queda PENDING y nada se marca como devuelto; el reintento lo cierra', async () => {
      setCulqiApi(culqiFalso().api);
      const tripId = await nuevoViaje();
      const { bookingId } = await reservar(tripId, 'CARD');
      await cancelar(tripId);
      const refundId = at(await reembolsosDe(bookingId), 0).id;

      setCulqiApi(culqiFalso({ falloDevolucion: true }).api);
      const fallido = await post(`/refunds/${refundId}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token);
      assert.equal(fallido.status, 400, JSON.stringify(fallido.body));

      const tras = at(await reembolsosDe(bookingId), 0);
      assert.equal(tras.status, 'PENDING');
      assert.equal(tras.provider_refund_id, null);
      assert.equal((await pagoDe(bookingId))?.status, 'PAID', 'no se marca REFUNDED sin confirmación de Culqi');
      assert.equal((await movimientosDe(bookingId)).filter((m) => m.type === 'REFUND').length, 0);

      const bueno = culqiFalso();
      setCulqiApi(bueno.api);
      const reintento = await post(`/refunds/${refundId}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token);
      assert.equal(reintento.status, 200, JSON.stringify(reintento.body));
      assert.equal(bueno.devoluciones.length, 1);
      assert.equal(at(await reembolsosDe(bookingId), 0).status, 'COMPLETED');
      assert.equal((await pagoDe(bookingId))?.status, 'REFUNDED');
    });
  });

  // =====================================================================
  describe('Itinerarios', () => {
    it('P · cancelar el viaje de un tramo solo cancela y reembolsa ese tramo', async () => {
      const tripA = await nuevoViaje('SCHEDULED', 'A');
      const tripB = await nuevoViaje('SCHEDULED', 'B');
      const creado = await post(
        '/bookings/itineraries',
        {
          trip_type: 'ROUND_TRIP',
          segments: [
            { trip_id: tripA, seat_ids: [at(await freeSeats(tripA), 0).id] },
            { trip_id: tripB, seat_ids: [at(await freeSeats(tripB), 0).id] },
          ],
          passenger_email: 'cliente@test.pe',
          payment_method: 'YAPE',
        },
        ctx.sessions.customer.token,
      );
      assert.equal(creado.status, 201, JSON.stringify(creado.body));
      const groupId = Number(creado.body.data.group_id);
      const pago = await post(`/bookings/itineraries/${groupId}/pay`, { method: 'YAPE' }, ctx.sessions.admin.token);
      assert.equal(pago.status, 200, JSON.stringify(pago.body));

      const tramos = await query<{ id: number; trip_id: number }>('SELECT id, trip_id FROM bookings WHERE group_id = ? ORDER BY segment_order', [groupId]);
      const ida = at(tramos, 0);
      const vuelta = at(tramos, 1);
      const pagoVueltaAntes = await pagoDe(vuelta.id);

      assert.equal((await cancelar(tripA)).status, 200);

      assert.equal((await reserva(ida.id))?.status, 'CANCELLED');
      assert.equal((await reembolsosDe(ida.id)).length, 1);
      assert.equal((await reserva(vuelta.id))?.status, 'CONFIRMED', 'la vuelta sigue en pie');
      assert.equal((await reembolsosDe(vuelta.id)).length, 0);
      assert.deepEqual(await pagoDe(vuelta.id), pagoVueltaAntes, 'el pago de la vuelta no se toca');
      assert.equal((await viaje(tripB))?.status, 'SCHEDULED');
      const grupo = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM bookings WHERE group_id = ?', [groupId]);
      assert.equal(Number(grupo?.n), 2, 'el itinerario conserva sus dos tramos');
    });
  });

  // =====================================================================
  describe('Avisos y finanzas', () => {
    it('S · cada pasajero afectado recibe su notificación y su correo, con el mensaje que le corresponde', async () => {
      const tripId = await nuevoViaje();
      const pendiente = await reservar(tripId);
      const pagada = await reservar(tripId, 'CASH');

      await cancelar(tripId);

      const avisoPendiente = await avisosDe(pendiente.bookingId);
      const avisoPagada = await avisosDe(pagada.bookingId);
      assert.equal(avisoPendiente.length, 1);
      assert.equal(avisoPagada.length, 1);
      assert.match(avisoPendiente[0]!.message, /cancel/);
      assert.match(avisoPendiente[0]!.message, /no se realizó ningún cobro/);
      assert.match(avisoPagada[0]!.message, /reembolso/);

      const correos = buzon.sent.filter((m) => /fue cancelado/.test(m.subject));
      assert.equal(correos.length, 2);
      assert.ok(correos.every((m) => m.to === 'cliente@test.pe'));
      assert.ok(correos.some((m) => /reembolso/.test(m.text)));
      assert.ok(correos.every((m) => !/\{\{/.test(m.text) && !/\{\{/.test(m.subject)), 'sin variables sin resolver');
    });

    it('T · cancelar no crea movimientos financieros; procesar el reembolso crea un REFUND y la reversión de la comisión', async () => {
      const tripId = await nuevoViaje();
      const { bookingId } = await reservar(tripId, 'CASH');
      const antes = await movimientosDe(bookingId);

      await cancelar(tripId);
      await cancelar(tripId);
      assert.deepEqual(await movimientosDe(bookingId), antes, 'la cancelación no mueve dinero');

      const refundId = at(await reembolsosDe(bookingId), 0).id;
      assert.equal((await post(`/refunds/${refundId}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token)).status, 200);
      assert.equal((await post(`/refunds/${refundId}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token)).status, 400);

      // H-27: reembolso total → la comisión se revierte entera (COMMISSION/CREDIT).
      const despues = await movimientosDe(bookingId);
      assert.equal(despues.length, antes.length + 2);
      assert.equal(despues.filter((m) => m.type === 'REFUND' && m.direction === 'DEBIT').length, 1);
      const comision = despues.filter((m) => m.type === 'COMMISSION');
      assert.deepEqual(comision.map((m) => [m.direction, Number(m.amount)]), [['DEBIT', Number(comision[0]!.amount)], ['CREDIT', Number(comision[0]!.amount)]]);
      // H-45: de una venta, la plataforma solo asienta su service fee y, al devolverse todo, su devolución.
      assert.deepEqual(
        (await libroPlataformaDe(bookingId)).map((m) => [m.type, m.direction, Math.round(Number(m.amount) * 100)]),
        [['PAYMENT', 'CREDIT', 250], ['REFUND', 'DEBIT', 250]],
      );
    });
  });

  // =====================================================================
  describe('Extremo a extremo', () => {
    it('E2E · reserva pagada con tarjeta → cancelar viaje → reembolso por Culqi → no se puede volver a pagar', async () => {
      const doble = culqiFalso();
      setCulqiApi(doble.api);
      const tripId = await nuevoViaje();
      const capacidad = Number((await viaje(tripId))?.available_seats);

      // Reserva y pago.
      const { bookingId, seatId } = await reservar(tripId, 'CARD');
      assert.equal((await reserva(bookingId))?.status, 'CONFIRMED');
      assert.equal((await pagoDe(bookingId))?.provider, 'CULQI');
      assert.equal(await asientoTomado(tripId, seatId), true);
      const movimientosPago = await movimientosDe(bookingId);
      assert.ok(movimientosPago.some((m) => m.type === 'PAYMENT'), 'el cobro dejó su movimiento');

      // Cancelación del viaje.
      const res = await cancelar(tripId);
      assert.equal(res.status, 200);
      assert.equal((await viaje(tripId))?.status, 'CANCELLED');
      assert.equal((await reserva(bookingId))?.status, 'CANCELLED');
      assert.match(String((await reserva(bookingId))?.notes), /Viaje cancelado/);
      assert.equal(await asientoTomado(tripId, seatId), false);
      assert.equal(Number((await viaje(tripId))?.available_seats), capacidad);
      assert.equal((await avisosDe(bookingId)).length, 1);
      assert.deepEqual(await movimientosDe(bookingId), movimientosPago);

      // El pasajero lo ve en su cuenta.
      const propias = await get('/bookings?limit=100', ctx.sessions.customer.token);
      assert.equal((propias.body.data as Array<{ id: number; status: string }>).find((b) => b.id === bookingId)?.status, 'CANCELLED');

      // Reembolso.
      const reembolso = at(await reembolsosDe(bookingId), 0);
      assert.equal(reembolso.status, 'PENDING');
      const procesado = await post(`/refunds/${reembolso.id}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token);
      assert.equal(procesado.status, 200, JSON.stringify(procesado.body));
      assert.equal(doble.devoluciones.length, 1);
      const cerrado = at(await reembolsosDe(bookingId), 0);
      assert.equal(cerrado.status, 'COMPLETED');
      assert.ok(cerrado.provider_refund_id, 'queda el identificador de Culqi');
      assert.equal((await pagoDe(bookingId))?.status, 'REFUNDED');
      assert.equal((await movimientosDe(bookingId)).filter((m) => m.type === 'REFUND').length, 1);

      // Volver a pagar.
      const otraVez = await post(`/bookings/${bookingId}/pay`, { method: 'CARD', token: TOKEN }, ctx.sessions.customer.token);
      assert.equal(otraVez.status, 400);
      assert.equal(doble.cargos.length, 1, 'un único cargo en todo el recorrido');
    });

    it('E2E · reserva PENDING → cancelar viaje → sin cobro ni reembolso → no se puede pagar', async () => {
      const doble = culqiFalso();
      setCulqiApi(doble.api);
      const tripId = await nuevoViaje();
      const capacidad = Number((await viaje(tripId))?.available_seats);

      const { bookingId, seatId } = await reservar(tripId);
      assert.equal((await reserva(bookingId))?.status, 'PENDING');

      assert.equal((await cancelar(tripId)).status, 200);
      assert.equal((await reserva(bookingId))?.status, 'CANCELLED');
      assert.equal(await asientoTomado(tripId, seatId), false);
      assert.equal(Number((await viaje(tripId))?.available_seats), capacidad);
      assert.equal((await reembolsosDe(bookingId)).length, 0);
      assert.equal((await movimientosDe(bookingId)).length, 0);
      assert.match(at(await avisosDe(bookingId), 0).message, /no se realizó ningún cobro/);

      for (const cuerpo of [{ method: 'CASH' }, { method: 'TRANSFER' }, { method: 'CARD', token: TOKEN }]) {
        const res = await post(`/bookings/${bookingId}/pay`, cuerpo, ctx.sessions.customer.token);
        assert.equal(res.status, 400, JSON.stringify(res.body));
      }
      assert.equal(doble.cargos.length, 0);
      assert.equal((await reserva(bookingId))?.status, 'CANCELLED');
    });
  });

  // =====================================================================
  describe('Webhook de Culqi sobre un viaje cancelado (8H-CIERRE)', () => {
    const webhook = (chargeId: string) =>
      post(`/culqi/webhook/${env.culqi.webhookSecret}`, { object: 'event', data: { id: chargeId, object: 'charge' } });

    /**
     * Deja un cobro de tarjeta «en el aire»: Culqi responde TIMEOUT, el pago queda FAILED y la
     * reserva PENDING, pero el cargo existe. Es exactamente el caso en que el webhook es la única
     * vía por la que BusPerú se entera de que el dinero entró.
     */
    async function cobroSinRespuesta(tripId: number) {
      setCulqiApi(culqiFalso({ cargoSinRespuesta: true }).api);
      const { bookingId } = await reservar(tripId);
      const intento = await post(`/bookings/${bookingId}/pay`, { method: 'CARD', token: TOKEN }, ctx.sessions.customer.token);
      assert.equal(intento.status, 402, JSON.stringify(intento.body));
      const pago = await pagoDe(bookingId);
      assert.equal(pago?.status, 'FAILED');
      const total = await queryOne<{ total_amount: string }>('SELECT total_amount FROM bookings WHERE id = ?', [bookingId]);
      return { bookingId, paymentId: Number(pago?.id), amountCents: Math.round(Number(total?.total_amount) * 100) };
    }

    const pagoCompleto = (bookingId: number) =>
      queryOne<{ status: string; provider_transaction_id: string | null }>(
        'SELECT status, provider_transaction_id FROM payments WHERE booking_id = ? ORDER BY id DESC LIMIT 1',
        [bookingId],
      );

    it('WH1 · cargo exitoso tras cancelar el viaje: no confirma, abre el reembolso compensatorio y es idempotente', async () => {
      const tripId = await nuevoViaje();
      const { bookingId, paymentId, amountCents } = await cobroSinRespuesta(tripId);

      assert.equal((await cancelar(tripId)).status, 200);
      assert.equal((await reserva(bookingId))?.status, 'CANCELLED');
      assert.equal((await reembolsosDe(bookingId)).length, 0, 'al cancelar no había pago cobrado');
      const movimientosAntes = await movimientosDe(bookingId);

      const chargeId = 'chr_test_webhook_cancelado';
      setCulqiApi(culqiFalso({ cargoReleido: { id: chargeId, amountCents, paymentId } }).api);

      const primero = await webhook(chargeId);
      assert.equal(primero.status, 200, JSON.stringify(primero.body));
      assert.equal(primero.body.data.handled, true);

      assert.notEqual((await reserva(bookingId))?.status, 'CONFIRMED', 'nunca se confirma una reserva de un viaje cancelado');
      const pago = await pagoCompleto(bookingId);
      assert.equal(pago?.status, 'PAID', 'el cobro queda registrado');
      assert.equal(pago?.provider_transaction_id, chargeId);
      const reembolsos = await reembolsosDe(bookingId);
      assert.equal(reembolsos.length, 1, 'el dinero queda cubierto por un reembolso');
      assert.equal(reembolsos[0]!.status, 'PENDING');
      assert.equal(Math.round(Number(reembolsos[0]!.amount) * 100), amountCents);
      assert.deepEqual(await movimientosDe(bookingId), movimientosAntes, 'la compensación no crea movimientos de la empresa');
      const entradaPlataforma = [{ type: 'PAYMENT', direction: 'CREDIT', amount: amountCents / 100 }];
      assert.deepEqual(
        (await libroPlataformaDe(bookingId)).map((m) => ({ ...m, amount: Number(m.amount) })),
        entradaPlataforma,
        'H-26: el cobro compensatorio entra en el libro de la plataforma',
      );

      const segundo = await webhook(chargeId);
      assert.equal(segundo.status, 200, JSON.stringify(segundo.body));
      assert.equal((await reembolsosDe(bookingId)).length, 1, 'un webhook repetido no duplica el reembolso');
      assert.deepEqual(await movimientosDe(bookingId), movimientosAntes, 'ni los movimientos');
      assert.equal((await libroPlataformaDe(bookingId)).length, 1, 'ni la entrada de la plataforma');
      assert.notEqual((await reserva(bookingId))?.status, 'CONFIRMED');

      // Y el reembolso se devuelve por el cargo correcto.
      const doble = culqiFalso();
      setCulqiApi(doble.api);
      const procesado = await post(`/refunds/${reembolsos[0]!.id}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token);
      assert.equal(procesado.status, 200, JSON.stringify(procesado.body));
      assert.equal(doble.devoluciones.length, 1);
      assert.equal(doble.devoluciones[0]!.chargeId, chargeId);
      assert.ok(at(await reembolsosDe(bookingId), 0).provider_refund_id);
      assert.deepEqual(await movimientosDe(bookingId), movimientosAntes, 'la devolución compensatoria no toca a la empresa');
      assert.deepEqual(
        (await libroPlataformaDe(bookingId)).map((m) => [m.type, m.direction, Math.round(Number(m.amount) * 100)]),
        [['PAYMENT', 'CREDIT', amountCents], ['REFUND', 'DEBIT', amountCents]],
        'la plataforma queda en cero',
      );
    });

    it('WH2 · con la reserva aún PENDING y el viaje ya cancelado, el estado del viaje manda', async () => {
      const tripId = await nuevoViaje();
      const { bookingId, paymentId, amountCents } = await cobroSinRespuesta(tripId);
      // Viaje cancelado por una vía que no tocó la reserva (datos anteriores a 8H).
      await execute("UPDATE trips SET status = 'CANCELLED' WHERE id = ?", [tripId]);

      const chargeId = 'chr_test_webhook_pendiente';
      setCulqiApi(culqiFalso({ cargoReleido: { id: chargeId, amountCents, paymentId } }).api);

      assert.equal((await webhook(chargeId)).status, 200);
      assert.equal((await reserva(bookingId))?.status, 'PENDING', 'no se confirma');
      assert.equal((await pagoCompleto(bookingId))?.status, 'PAID');
      assert.equal((await reembolsosDe(bookingId)).length, 1);

      assert.equal((await webhook(chargeId)).status, 200);
      assert.equal((await reembolsosDe(bookingId)).length, 1);
      assert.equal((await movimientosDe(bookingId)).length, 0);
      assert.deepEqual((await libroPlataformaDe(bookingId)).map((m) => m.type), ['PAYMENT']);
    });

    it('WH3 · el camino normal no cambia: un webhook de un pago ya confirmado sigue sin tocar nada', async () => {
      setCulqiApi(culqiFalso().api);
      const tripId = await nuevoViaje();
      const { bookingId } = await reservar(tripId, 'CARD');
      const pago = await pagoCompleto(bookingId);
      const movimientos = await movimientosDe(bookingId);
      const total = await queryOne<{ total_amount: string }>('SELECT total_amount FROM bookings WHERE id = ?', [bookingId]);
      const pagoId = Number((await pagoDe(bookingId))?.id);

      setCulqiApi(
        culqiFalso({
          cargoReleido: { id: String(pago?.provider_transaction_id), amountCents: Math.round(Number(total?.total_amount) * 100), paymentId: pagoId },
        }).api,
      );
      const res = await webhook(String(pago?.provider_transaction_id));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.action, 'ya estaba conciliado');
      assert.equal((await reserva(bookingId))?.status, 'CONFIRMED');
      assert.equal((await reembolsosDe(bookingId)).length, 0);
      assert.deepEqual(await movimientosDe(bookingId), movimientos);
    });
  });

  // =====================================================================
  describe('Cancelación ↔ expiración concurrentes (8H-CIERRE)', () => {
    /** Viaje con una reserva PENDING ya vencida: la cancelación y la expiración la quieren a la vez. */
    async function viajeConReservaVencida() {
      const tripId = await nuevoViaje();
      const capacidad = Number((await viaje(tripId))?.available_seats);
      const { bookingId } = await reservar(tripId);
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [bookingId]);
      return { tripId, bookingId, capacidad };
    }

    /** Estado final coherente, venga de la cancelación o de la expiración. */
    async function assertCoherente(tripId: number, bookingId: number, capacidad: number) {
      const estado = (await reserva(bookingId))?.status;
      assert.ok(estado === 'CANCELLED' || estado === 'EXPIRED', `estado final: ${estado}`);
      assert.equal((await viaje(tripId))?.status, 'CANCELLED');
      assert.equal(Number((await viaje(tripId))?.available_seats), capacidad, 'el asiento se liberó una sola vez');
      assert.equal((await reembolsosDe(bookingId)).length, 0, 'sin cobro, sin reembolso');
      assert.equal((await pagoDe(bookingId))?.status, 'CANCELLED', 'el pago pendiente quedó cerrado');
      assert.equal((await movimientosDe(bookingId)).length, 0);
      const avisos = await query<{ event: string }>(
        "SELECT JSON_UNQUOTE(JSON_EXTRACT(data, '$.event')) AS event FROM notifications WHERE JSON_EXTRACT(data, '$.booking_id') = ? AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.event')) IN ('trip.cancelled', 'booking.expired')",
        [bookingId],
      );
      assert.equal(avisos.length, 1, `un solo aviso de cierre: ${JSON.stringify(avisos)}`);
    }

    it('X1 · ejecutadas a la vez sobre muchas reservas: sin interbloqueos ni estados parciales', async () => {
      const casos = [];
      for (let i = 0; i < 12; i += 1) casos.push(await viajeConReservaVencida());

      const errores: unknown[] = [];
      await Promise.all(
        casos.flatMap(({ tripId }) => [
          cancelar(tripId).then((res) => {
            if (res.status !== 200) errores.push(res.body);
          }),
          expireDueBookings({ limit: 500 }).catch((error: unknown) => errores.push(error)),
        ]),
      );
      assert.deepEqual(errores, [], 'ninguna operación falló, tampoco por interbloqueo');

      for (const { tripId, bookingId, capacidad } of casos) await assertCoherente(tripId, bookingId, capacidad);

      // Repetir las dos operaciones sobre lo ya cerrado no cambia nada.
      await Promise.all([...casos.map(({ tripId }) => cancelar(tripId)), expireDueBookings({ limit: 500 })]);
      for (const { tripId, bookingId, capacidad } of casos) await assertCoherente(tripId, bookingId, capacidad);
    });

    it('X3 · muchas reservas PAGADAS en viajes distintos cancelados a la vez: un reembolso por pago y sin interbloqueos', async () => {
      const casos: Array<{ tripId: number; bookingId: number; capacidad: number }> = [];
      for (let i = 0; i < 12; i += 1) {
        const tripId = await nuevoViaje();
        const capacidad = Number((await viaje(tripId))?.available_seats);
        const { bookingId } = await reservar(tripId, i % 2 === 0 ? 'CASH' : 'TRANSFER');
        casos.push({ tripId, bookingId, capacidad });
      }

      const respuestas = await Promise.all([
        ...casos.map(({ tripId }) => cancelar(tripId)),
        expireDueBookings({ limit: 500 }).then(() => null),
      ]);
      const fallidas = respuestas.filter((res) => res !== null && res.status !== 200).map((res) => res!.body);
      assert.deepEqual(fallidas, [], 'ninguna cancelación falló, tampoco por interbloqueo');

      for (const { tripId, bookingId, capacidad } of casos) {
        assert.equal((await reserva(bookingId))?.status, 'CANCELLED');
        assert.equal(Number((await viaje(tripId))?.available_seats), capacidad);
        const reembolsos = await reembolsosDe(bookingId);
        assert.equal(reembolsos.length, 1, `reserva ${bookingId}: un solo reembolso`);
        assert.equal(reembolsos[0]!.status, 'PENDING');
        assert.equal((await pagoDe(bookingId))?.status, 'PAID');
      }
    });

    it('X2 · intercalado forzado: la expiración espera al cerrojo del viaje y cede ante la cancelación', async () => {
      const { tripId, bookingId, capacidad } = await viajeConReservaVencida();

      // Una tercera transacción retiene el viaje, como lo haría una cancelación en curso.
      const bloqueo = await pool.getConnection();
      await bloqueo.beginTransaction();

      /**
       * F17C-SEC-11 · EL CERROJO SE SUELTA PASE LO QUE PASE.
       *
       * Antes el `commit()` y el `release()` iban detrás de una aserción. Si esa aserción
       * fallaba, la conexión se quedaba fuera del pool con la transacción abierta y el `FOR
       * UPDATE` puesto, y la expiración y la cancelación —lanzadas sin esperar— seguían vivas
       * aguardando ese cerrojo 50 segundos después de que el caso hubiera terminado. Es el mismo
       * artefacto (sesión ociosa con transacción abierta) que se capturó en la batería completa.
       */
      let suelto = false;
      const soltar = async () => {
        if (suelto) return;
        suelto = true;
        try {
          await bloqueo.commit();
        } finally {
          bloqueo.release();
        }
      };
      let expiracion: ReturnType<typeof expireDueBookings> | undefined;
      let cancelacion: ReturnType<typeof cancelar> | undefined;
      try {
        await bloqueo.query('SELECT id FROM trips WHERE id = ? FOR UPDATE', [tripId]);

        expiracion = expireDueBookings({ limit: 500 });
        cancelacion = cancelar(tripId);
        await new Promise((resolve) => setTimeout(resolve, 300));
        // Mientras el viaje está retenido, ninguna de las dos pudo tocar la reserva.
        assert.equal((await reserva(bookingId))?.status, 'PENDING');

        await soltar();

        const [resultadoExpiracion, resultadoCancelacion] = await Promise.all([expiracion, cancelacion]);
        assert.equal(resultadoCancelacion.status, 200, JSON.stringify(resultadoCancelacion.body));
        assert.ok(resultadoExpiracion.expired <= 1);
        await assertCoherente(tripId, bookingId, capacidad);
      } finally {
        await soltar();
        // Nada queda flotando después del caso: ni la expiración ni la cancelación.
        await Promise.allSettled([expiracion, cancelacion].filter((p) => p !== undefined));
      }
    });
  });
});
