import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { api, get, post, put } from './helpers/api';
import { env } from '../config/env';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { errorHandler } from '../middleware/error.middleware';
import { CARD_RESULT_UNCONFIRMED_MESSAGE, reconcileApprovedCharge } from '../services/payment.service';
import { TRIP_CANCELLED_CHARGE_UNCERTAIN_MESSAGE } from '../services/booking.service';
import { setCulqiApi, type CulqiApi, type CulqiCharge } from '../services/culqi.service';
import { advanceTripLifecycle } from '../services/trip.service';
import { ApiError } from '../utils/ApiError';
import { REDACTED, redactKnownSecrets, sanitizeUrl } from '../utils/log-sanitizer';
import { logError } from '../utils/logger';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

process.env.LOG_ERRORS = 'false';

/**
 * FASE 11F · H-29 (aviso en la carrera tarjeta/cancelación), H-30 (ciclo de vida de viajes),
 * H-31 (secretos en los registros), H-32 (rangos de fechas en reportes) y H-36 (empresa no activa).
 * Todo sobre `busperu_test`; Culqi es un doble y ningún correo sale a la red.
 */
describe('11F · H-29 · H-30 · H-31 · H-32 · H-36', () => {
  let ctx: SuiteContext;
  let modoCargo: 'ok' | 'timeout' | 'declined' = 'ok';
  let cargos = 0;

  const culqiFalso: CulqiApi = {
    async createCharge(input) {
      cargos += 1;
      if (modoCargo === 'timeout') return { ok: false, kind: 'TIMEOUT', code: null, userMessage: 'No pudimos completar el pago. Vuelve a intentarlo en unos minutos.', merchantMessage: 'Culqi no respondió dentro del tiempo límite' };
      if (modoCargo === 'declined') return { ok: false, kind: 'DECLINED', code: 'card_declined', userMessage: 'Tu tarjeta fue rechazada.', merchantMessage: 'rechazo' };
      return { ok: true, data: { id: `chr_test_59_${cargos}`, amount: input.amountCents, currency_code: 'PEN', outcome: { type: 'venta_exitosa', user_message: 'ok' } } as CulqiCharge };
    },
    async getCharge() {
      return { ok: false, kind: 'PROVIDER', code: null, userMessage: 'x', merchantMessage: 'x' };
    },
    async createRefund(input) {
      return { ok: true, data: { id: `ref_test_59_${input.chargeId}`, charge_id: input.chargeId, amount: input.amountCents } as never };
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
    modoCargo = 'ok';
    cargos = 0;
    setCulqiApi(culqiFalso);
    env.culqi.publicKey = 'pk_test_solo_para_pruebas';
    env.culqi.privateKey = 'sk_test_solo_para_pruebas';
    for (const tabla of ['settlement_items', 'settlements', 'financial_transactions', 'refunds', 'coupon_usages', 'booking_seats', 'payments', 'notifications', 'bookings', 'booking_groups']) {
      await execute(`DELETE FROM ${tabla}`);
    }
    await execute('DELETE FROM trips WHERE id NOT IN (?, ?)', [ctx.fixtures.tripA, ctx.fixtures.tripB]);
    await execute(
      "UPDATE trips t JOIN buses b ON b.id = t.bus_id SET t.available_seats = b.capacity, t.status = 'SCHEDULED', t.departure_datetime = DATE_ADD(NOW(), INTERVAL 3 DAY), t.arrival_datetime = DATE_ADD(NOW(), INTERVAL 80 HOUR)",
    );
    await execute("UPDATE companies SET status = 'ACTIVE' WHERE id IN (?, ?)", [ctx.fixtures.companyA, ctx.fixtures.companyB]);
  });
  afterEach(() => {
    setCulqiApi(null);
    env.culqi.publicKey = '';
    env.culqi.privateKey = '';
  });

  /* ------------------------------------------------------------------ utilidades */

  const reservar = async (tripId: number, token = ctx.sessions.customer.token) => {
    const res = await post('/bookings', { trip_id: tripId, seat_ids: [at(await freeSeats(tripId), 0).id], passenger_email: 'cliente@test.pe' }, token);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return Number(res.body.data.id);
  };
  const pagarTarjeta = (bookingId: number) => post(`/bookings/${bookingId}/pay`, { method: 'CARD', token: 'tkn_test_59_00000001' }, ctx.sessions.customer.token);
  const avisos = (bookingId: number) =>
    query<{ title: string; message: string; event: string }>(
      "SELECT title, message, JSON_UNQUOTE(JSON_EXTRACT(data, '$.event')) AS event FROM notifications WHERE JSON_EXTRACT(data, '$.booking_id') = ? ORDER BY id",
      [bookingId],
    );
  /** Copia de un viaje de las fixtures con estado y horas relativas al reloj de la base. */
  async function viaje(base: number, status: string, salidaHoras: number, llegadaHoras: number | null): Promise<number> {
    return (
      await execute(
        `INSERT INTO trips (route_id, bus_id, bus_layout_id, departure_datetime, arrival_datetime, base_price, available_seats, status)
         SELECT route_id, bus_id, bus_layout_id, DATE_ADD(NOW(), INTERVAL ? MINUTE), ${llegadaHoras === null ? 'NULL' : 'DATE_ADD(NOW(), INTERVAL ? MINUTE)'}, base_price, available_seats, ? FROM trips WHERE id = ?`,
        llegadaHoras === null ? [Math.round(salidaHoras * 60), status, base] : [Math.round(salidaHoras * 60), Math.round(llegadaHoras * 60), status, base],
      )
    ).insertId;
  }
  const estadoViaje = async (id: number) => (await queryOne<{ status: string }>('SELECT status FROM trips WHERE id = ?', [id]))?.status;

  // =====================================================================
  describe('H-29 · el aviso no afirma lo que el backend no sabe', () => {
    it('H29-1 · TIMEOUT de Culqi: el pasajero lee que el resultado es incierto, no que falló ni que no hubo cobro', async () => {
      const bookingId = await reservar(ctx.fixtures.tripA);
      modoCargo = 'timeout';
      const res = await pagarTarjeta(bookingId);
      assert.equal(res.status, 402);
      assert.equal(res.body.message, CARD_RESULT_UNCONFIRMED_MESSAGE);
      assert.doesNotMatch(String(res.body.message), /no se realizó|rechaz|Culqi|chr_|tiempo límite/i);
      const pago = await queryOne<{ status: string; payment_data: string }>('SELECT status, payment_data FROM payments WHERE booking_id = ?', [bookingId]);
      assert.equal(pago?.status, 'FAILED');
      assert.match(String(pago?.payment_data), /TIMEOUT/);
    });

    it('H29-2 · un rechazo del banco sigue diciéndose como rechazo (caso A distinto del B)', async () => {
      const bookingId = await reservar(ctx.fixtures.tripA);
      modoCargo = 'declined';
      const res = await pagarTarjeta(bookingId);
      assert.equal(res.status, 402);
      assert.equal(res.body.message, 'Tu tarjeta fue rechazada.');
    });

    it('H29-3 · cancelar el viaje de una reserva sin intentos de cobro: «no se realizó ningún cobro» (caso A)', async () => {
      const bookingId = await reservar(ctx.fixtures.tripA);
      assert.equal((await post(`/trips/${ctx.fixtures.tripA}/cancel`, {}, ctx.sessions.companyAdmin.token)).status, 200);
      const [aviso] = (await avisos(bookingId)).filter((a) => a.event === 'trip.cancelled');
      assert.match(aviso!.message, /no se realizó ningún cobro/);
    });

    it('H29-4 · cancelar tras un TIMEOUT: el aviso dice que aún no se puede confirmar (caso B)', async () => {
      const bookingId = await reservar(ctx.fixtures.tripA);
      modoCargo = 'timeout';
      await pagarTarjeta(bookingId);
      assert.equal((await post(`/trips/${ctx.fixtures.tripA}/cancel`, {}, ctx.sessions.companyAdmin.token)).status, 200);
      const [aviso] = (await avisos(bookingId)).filter((a) => a.event === 'trip.cancelled');
      assert.doesNotMatch(aviso!.message, /no se realizó ningún cobro/);
      assert.ok(aviso!.message.includes(TRIP_CANCELLED_CHARGE_UNCERTAIN_MESSAGE));
    });

    it('H29-5 · cancelar con un cobro en vuelo (PROCESSING): caso B, y el pago en vuelo no se toca', async () => {
      const bookingId = await reservar(ctx.fixtures.tripA);
      // Un intento de tarjeta en vuelo, tal como lo deja la fase A de `payBookingWithCard`.
      await execute("DELETE FROM payments WHERE booking_id = ?", [bookingId]);
      await execute(
        "INSERT INTO payments (booking_id, transaction_code, amount, currency, method, status, provider) SELECT id, CONCAT('TRX-59-', id), total_amount, 'PEN', 'CARD', 'PROCESSING', 'CULQI' FROM bookings WHERE id = ?",
        [bookingId],
      );
      assert.equal((await post(`/trips/${ctx.fixtures.tripA}/cancel`, {}, ctx.sessions.companyAdmin.token)).status, 200);
      const [aviso] = (await avisos(bookingId)).filter((a) => a.event === 'trip.cancelled');
      assert.ok(aviso!.message.includes(TRIP_CANCELLED_CHARGE_UNCERTAIN_MESSAGE));
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM payments WHERE booking_id = ?', [bookingId]))?.status, 'PROCESSING');
    });

    it('H29-6 · el cargo aparece después (webhook/conciliación): compensatorio y aviso «detectamos un cobro» una sola vez (caso C)', async () => {
      const bookingId = await reservar(ctx.fixtures.tripA);
      modoCargo = 'timeout';
      await pagarTarjeta(bookingId);
      assert.equal((await post(`/trips/${ctx.fixtures.tripA}/cancel`, {}, ctx.sessions.companyAdmin.token)).status, 200);

      const pago = await queryOne<{ id: number; amount: string }>('SELECT id, amount FROM payments WHERE booking_id = ?', [bookingId]);
      const cargo = { id: 'chr_test_59_tardio', amount: Math.round(Number(pago!.amount) * 100), currency_code: 'PEN', outcome: { type: 'venta_exitosa' } } as CulqiCharge;
      for (let i = 0; i < 3; i += 1) {
        const r = await reconcileApprovedCharge(Number(pago!.id), cargo, 'El viaje fue cancelado');
        assert.ok(['compensated', 'already_reconciled'].includes(r.outcome), r.outcome);
      }
      assert.equal((await query("SELECT id FROM refunds WHERE booking_id = ? AND status = 'PENDING'", [bookingId])).length, 1);
      const compensados = (await avisos(bookingId)).filter((a) => a.event === 'booking.payment_compensated');
      assert.equal(compensados.length, 1, 'un solo aviso aunque el webhook se repita');
      assert.match(compensados[0]!.message, /Detectamos un cobro de S\/ \d+\.\d{2}.*iniciamos su devolución/);
      assert.doesNotMatch(compensados[0]!.message, /chr_|Culqi/);
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [bookingId]))?.status, 'CANCELLED', 'H-42 intacto: no se confirma');
    });

    it('H29-7 · una conciliación normal (reserva confirmable) no envía el aviso de cobro compensado', async () => {
      const bookingId = await reservar(ctx.fixtures.tripA);
      modoCargo = 'timeout';
      await pagarTarjeta(bookingId);
      const pago = await queryOne<{ id: number; amount: string }>('SELECT id, amount FROM payments WHERE booking_id = ?', [bookingId]);
      const r = await reconcileApprovedCharge(Number(pago!.id), { id: 'chr_test_59_ok', amount: Math.round(Number(pago!.amount) * 100), currency_code: 'PEN', outcome: { type: 'venta_exitosa' } } as CulqiCharge, 'x');
      assert.equal(r.outcome, 'confirmed');
      assert.equal((await avisos(bookingId)).filter((a) => a.event === 'booking.payment_compensated').length, 0);
    });
  });

  // =====================================================================
  describe('H-30 · ciclo de vida de los viajes', () => {
    it('H30-1 · el reloj es el de la base, en hora de Perú', async () => {
      const zona = await queryOne<{ tz: string }>('SELECT @@session.time_zone AS tz');
      assert.equal(zona?.tz, '-05:00');
    });

    it('H30-2 · transiciones del scheduler por estado y hora', async () => {
      const b = ctx.fixtures.tripA;
      const casos = {
        programadoFuturo: await viaje(b, 'SCHEDULED', 2, 10),
        programadoSalido: await viaje(b, 'SCHEDULED', -1, 5),
        embarqueSalido: await viaje(b, 'BOARDING', -0.1, 5),
        embarqueFuturo: await viaje(b, 'BOARDING', 0.5, 6),
        retrasadoSalido: await viaje(b, 'DELAYED', -2, 3),
        retrasadoLlegadaPasada: await viaje(b, 'DELAYED', -10, -1),
        enCursoLlegado: await viaje(b, 'IN_PROGRESS', -6, -0.05),
        enCursoEnRuta: await viaje(b, 'IN_PROGRESS', -1, 4),
        enCursoSinLlegada: await viaje(b, 'IN_PROGRESS', -8, null),
        cancelado: await viaje(b, 'CANCELLED', -6, -1),
        completado: await viaje(b, 'COMPLETED', -6, -1),
        salidoYLlegadoSinScheduler: await viaje(b, 'SCHEDULED', -10, -2),
      };
      await advanceTripLifecycle();
      const estados = Object.fromEntries(await Promise.all(Object.entries(casos).map(async ([k, id]) => [k, await estadoViaje(id)])));
      assert.deepEqual(estados, {
        programadoFuturo: 'SCHEDULED',
        programadoSalido: 'IN_PROGRESS',
        embarqueSalido: 'IN_PROGRESS',
        embarqueFuturo: 'BOARDING',
        retrasadoSalido: 'DELAYED',
        retrasadoLlegadaPasada: 'DELAYED',
        enCursoLlegado: 'COMPLETED',
        enCursoEnRuta: 'IN_PROGRESS',
        enCursoSinLlegada: 'IN_PROGRESS',
        cancelado: 'CANCELLED',
        completado: 'COMPLETED',
        salidoYLlegadoSinScheduler: 'COMPLETED',
      });
    });

    it('H30-3 · idempotente: la segunda y la tercera pasada no cambian nada', async () => {
      await viaje(ctx.fixtures.tripA, 'BOARDING', -1, 1);
      await viaje(ctx.fixtures.tripA, 'IN_PROGRESS', -5, -1);
      const primera = await advanceTripLifecycle();
      assert.ok(primera.started >= 1 && primera.completed >= 1);
      for (let i = 0; i < 2; i += 1) {
        const otra = await advanceTripLifecycle();
        assert.deepEqual(otra, { started: 0, completed: 0, bookingsCompleted: 0 });
      }
      const simultaneas = await Promise.all([advanceTripLifecycle(), advanceTripLifecycle()]);
      assert.deepEqual(simultaneas.map((r) => r.started + r.completed), [0, 0]);
    });

    it('H30-4 · un viaje en embarque con reserva confirmada: sale, llega y la reserva queda COMPLETED', async () => {
      const tripId = await viaje(ctx.fixtures.tripA, 'SCHEDULED', 48, 56);
      const bookingId = await reservar(tripId);
      assert.equal((await post(`/bookings/${bookingId}/pay`, { method: 'CASH' }, ctx.sessions.admin.token)).status, 200);
      await execute("UPDATE trips SET status = 'BOARDING', departure_datetime = DATE_SUB(NOW(), INTERVAL 3 HOUR), arrival_datetime = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?", [tripId]);
      await advanceTripLifecycle();
      assert.equal(await estadoViaje(tripId), 'COMPLETED');
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [bookingId]))?.status, 'COMPLETED');
    });

    it('H30-5 · transiciones manuales: no se reabre un viaje realizado ni se completa uno que no salió', async () => {
      const t = async (status: string, siguiente: string) => {
        const id = await viaje(ctx.fixtures.tripA, status, 5, 10);
        return (await put(`/trips/${id}`, { status: siguiente }, ctx.sessions.companyAdmin.token)).status;
      };
      assert.equal(await t('COMPLETED', 'SCHEDULED'), 400);
      assert.equal(await t('COMPLETED', 'IN_PROGRESS'), 400);
      assert.equal(await t('SCHEDULED', 'COMPLETED'), 400);
      assert.equal(await t('BOARDING', 'COMPLETED'), 400);
      assert.equal(await t('DELAYED', 'COMPLETED'), 400);
      assert.equal(await t('IN_PROGRESS', 'SCHEDULED'), 400);
      assert.equal(await t('IN_PROGRESS', 'COMPLETED'), 200);
      assert.equal(await t('DELAYED', 'BOARDING'), 200);
      assert.equal(await t('DELAYED', 'IN_PROGRESS'), 200);
      assert.equal(await t('BOARDING', 'DELAYED'), 200);
      assert.equal(await t('SCHEDULED', 'SCHEDULED'), 200, 'el mismo estado siempre vale');
      assert.equal(await t('CANCELLED', 'SCHEDULED'), 400);
    });

    it('H30-6 · un viaje nuevo no puede nacer en curso, realizado ni cancelado', async () => {
      const base = await queryOne<{ route_id: number; bus_id: number }>('SELECT route_id, bus_id FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
      const cuerpo = (status: string) => ({ route_id: base!.route_id, bus_id: base!.bus_id, departure_datetime: '2031-01-10 08:00:00', arrival_datetime: '2031-01-10 16:00:00', base_price: 50, status });
      for (const status of ['IN_PROGRESS', 'COMPLETED', 'CANCELLED']) {
        assert.equal((await post('/trips', cuerpo(status), ctx.sessions.companyAdmin.token)).status, 400, status);
      }
      assert.equal((await post('/trips', cuerpo('SCHEDULED'), ctx.sessions.companyAdmin.token)).status, 201);
    });
  });

  // =====================================================================
  describe('H-31 · ningún secreto en los registros', () => {
    const capturar = async (accion: () => Promise<void> | void): Promise<string> => {
      const original = console.error;
      const lineas: string[] = [];
      const previo = process.env.LOG_ERRORS;
      process.env.LOG_ERRORS = 'true';
      console.error = (...args: unknown[]) => {
        lineas.push(args.map(String).join(' '));
      };
      try {
        await accion();
      } finally {
        console.error = original;
        process.env.LOG_ERRORS = previo;
      }
      return lineas.join('\n');
    };
    const peticion = (originalUrl: string) =>
      ({ id: 'req-59', method: 'POST', originalUrl, url: originalUrl, user: undefined, apiKey: undefined, headers: {} }) as unknown as Request;
    const respuesta = () => {
      const res = { statusCode: 0, body: null as unknown, status(code: number) { this.statusCode = code; return this; }, json(b: unknown) { this.body = b; return this; } };
      return res as unknown as Response & { statusCode: number; body: unknown };
    };

    it('H31-1 · sanitizeUrl oculta el secreto del webhook, code/state/ticket/token y valores con forma de token', () => {
      assert.equal(sanitizeUrl('/api/culqi/webhook/whsec_super_secreto?x=1'), `/api/culqi/webhook/${REDACTED}?x=1`);
      const oauth = sanitizeUrl('/api/auth/oauth/google/callback?code=4/0AbCdEf-codigo&state=estado-opaco-123&scope=email');
      assert.ok(!oauth.includes('4/0AbCdEf') && !oauth.includes('estado-opaco'), oauth);
      assert.match(oauth, /scope=email/, 'lo inocuo se conserva');
      for (const [url, secreto] of [
        ['/api/auth/oauth/exchange?ticket=tkt-123456', 'tkt-123456'],
        ['/api/x?access_token=abc.def.ghi&refresh_token=zzz999', 'abc.def.ghi'],
        ['/api/x?password=Clave123!&reset_code=482913', 'Clave123!'],
        ['/api/x?api_key=bp_live_1234567890', 'bp_live_1234567890'],
        ['/api/x?card_number=4111111111111111&cvv=123', '4111111111111111'],
        ['/api/x?source_id=tkn_live_ABCDEFGHIJKLMNOPQRSTUV', 'tkn_live_ABCDEFGHIJKLMNOPQRSTUV'],
        ['/api/reset/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.firma', 'eyJhbGciOiJIUzI1NiJ9'],
      ] as const) {
        assert.ok(!sanitizeUrl(url).includes(secreto), `${url} -> ${sanitizeUrl(url)}`);
      }
      assert.equal(sanitizeUrl('/api/trips/42?page=2&status=SCHEDULED&from=2026-01-01'), '/api/trips/42?page=2&status=SCHEDULED&from=2026-01-01');
    });

    it('H31-2 · un 500 en el webhook de Culqi no escribe el secreto de la ruta', async () => {
      const secreto = 'whsec-real-de-prueba-59';
      const texto = await capturar(() => {
        errorHandler(new Error('fallo de prueba'), peticion(`/api/culqi/webhook/${secreto}`), respuesta(), (() => undefined) as NextFunction);
      });
      assert.match(texto, /Error no controlado/);
      assert.ok(!texto.includes(secreto), texto);
      assert.ok(texto.includes('/api/culqi/webhook/'), 'se conserva la ruta útil');
    });

    it('H31-3 · un 500 en el callback OAuth no escribe code ni state', async () => {
      const texto = await capturar(() => {
        errorHandler(new Error('x'), peticion('/api/auth/oauth/google/callback?code=codigo-oauth-59&state=estado-oauth-59'), respuesta(), (() => undefined) as NextFunction);
      });
      assert.ok(texto.length > 0);
      assert.ok(!texto.includes('codigo-oauth-59') && !texto.includes('estado-oauth-59'), texto);
    });

    it('H31-4 · un secreto configurado que llegue al mensaje o a la traza se sustituye', async () => {
      const previos = { webhook: env.culqi.webhookSecret, privada: env.culqi.privateKey };
      env.culqi.webhookSecret = 'secreto-webhook-59-xyz';
      env.culqi.privateKey = 'sk_live_privada_59_xyz';
      try {
        const texto = await capturar(() => {
          logError('fallo con secretos', new Error(`url https://api/culqi/webhook/secreto-webhook-59-xyz con Bearer sk_live_privada_59_xyz`), { path: '/api/x?token=tok-59-abcdef' });
        });
        assert.ok(!texto.includes('secreto-webhook-59-xyz') && !texto.includes('sk_live_privada_59_xyz') && !texto.includes('tok-59-abcdef'), texto);
        assert.ok(texto.includes(REDACTED));
        assert.equal(redactKnownSecrets('sin secretos'), 'sin secretos');
      } finally {
        env.culqi.webhookSecret = previos.webhook;
        env.culqi.privateKey = previos.privada;
      }
    });

    it('H31-5 · un 4xx no se registra; un webhook con secreto erróneo responde 404 sin registrar el valor', async () => {
      const texto = await capturar(async () => {
        errorHandler(ApiError.badRequest('x'), peticion('/api/x?password=nope-59'), respuesta(), (() => undefined) as NextFunction);
        await post('/culqi/webhook/secreto-equivocado-59', { object: 'event' });
      });
      assert.ok(!texto.includes('nope-59') && !texto.includes('secreto-equivocado-59'), texto);
    });
  });

  // =====================================================================
  describe('H-32 · cada reporte filtra por la fecha de su hecho', () => {
    const reporte = (clave: string, from: string, to: string) => api(`/reports/${clave}?from=${from}&to=${to}`, { token: ctx.sessions.admin.token });

    it('H32-1 · cancelaciones: cuenta la fecha de cancelación, no la de creación', async () => {
      const creadaAntes = await reservar(ctx.fixtures.tripA);
      const creadaDentro = await reservar(ctx.fixtures.tripA);
      await execute("UPDATE bookings SET status = 'CANCELLED', created_at = '2030-01-05 10:00:00', cancelled_at = '2030-03-10 23:30:00' WHERE id = ?", [creadaAntes]);
      await execute("UPDATE bookings SET status = 'CANCELLED', created_at = '2030-03-10 00:00:00', cancelled_at = '2030-04-02 09:00:00' WHERE id = ?", [creadaDentro]);
      const res = await reporte('cancellations', '2030-03-10', '2030-03-10');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.data.rows.map((r: { label: string; cancellations: number }) => [String(r.label).slice(0, 10), Number(r.cancellations)]), [['2030-03-10', 1]], 'la de 23:30 cuenta en su día, sin desfase de zona');
      const abril = await reporte('cancellations', '2030-04-01', '2030-04-30');
      assert.equal(abril.body.data.rows.length, 1);
    });

    it('H32-2 · ocupación: viajes por fecha de salida, con o sin reservas', async () => {
      const dentroSinReservas = await viaje(ctx.fixtures.tripA, 'SCHEDULED', 48, 56);
      const fueraConReserva = await viaje(ctx.fixtures.tripA, 'SCHEDULED', 24 * 20, 24 * 20 + 8);
      await execute("UPDATE trips SET departure_datetime = '2030-05-15 00:00:00' WHERE id = ?", [dentroSinReservas]);
      const bookingId = await reservar(fueraConReserva);
      await execute("UPDATE trips SET departure_datetime = '2030-06-01 08:00:00' WHERE id = ?", [fueraConReserva]);
      await execute("UPDATE bookings SET created_at = '2030-05-15 12:00:00' WHERE id = ?", [bookingId]);
      await execute("UPDATE trips SET departure_datetime = '2031-01-01 08:00:00' WHERE id IN (?, ?)", [ctx.fixtures.tripA, ctx.fixtures.tripB]);
      const res = await reporte('occupancy', '2030-05-15', '2030-05-15');
      assert.equal(res.status, 200);
      assert.equal(res.body.data.rows.length, 1, 'solo el viaje que sale ese día, aunque no tenga reservas');
      assert.equal(Number(res.body.data.rows[0].seats_sold), 0);
    });

    it('H32-3 · métodos de pago: la fecha del cobro; ventas: la de la reserva (sin cambios)', async () => {
      const bookingId = await reservar(ctx.fixtures.tripA);
      assert.equal((await post(`/bookings/${bookingId}/pay`, { method: 'CASH' }, ctx.sessions.admin.token)).status, 200);
      await execute("UPDATE bookings SET created_at = '2030-07-01 10:00:00' WHERE id = ?", [bookingId]);
      await execute("UPDATE payments SET paid_at = '2030-07-20 18:00:00' WHERE booking_id = ?", [bookingId]);
      assert.equal((await reporte('payment-methods', '2030-07-01', '2030-07-01')).body.data.rows.length, 0, 'creada ese día pero cobrada otro');
      assert.equal((await reporte('payment-methods', '2030-07-20', '2030-07-20')).body.data.rows.length, 1);
      assert.equal((await reporte('sales-by-date', '2030-07-01', '2030-07-01')).body.data.rows.length, 1, 'la venta sigue en su día de reserva');
    });

    it('H32-4 · límites inclusivos de día completo y fechas mal formadas', async () => {
      const a = await reservar(ctx.fixtures.tripA);
      const b = await reservar(ctx.fixtures.tripA);
      await execute("UPDATE bookings SET status = 'CANCELLED', cancelled_at = '2030-08-01 00:00:00' WHERE id = ?", [a]);
      await execute("UPDATE bookings SET status = 'CANCELLED', cancelled_at = '2030-08-31 23:59:59' WHERE id = ?", [b]);
      const res = await reporte('cancellations', '2030-08-01', '2030-08-31');
      assert.equal(res.body.data.rows.reduce((t: number, r: { cancellations: number }) => t + Number(r.cancellations), 0), 2);
      assert.equal((await reporte('cancellations', '2030-08-02', '2030-08-31')).body.data.rows.length, 1);
      for (const malo of ['2030-08-01%2010:00:00', '01-08-2030', 'ayer', '2030-13-45x']) {
        assert.equal((await reporte('cancellations', malo, '2030-08-31')).status, 400, malo);
      }
    });

    it('H32-5 · itinerario: cada tramo cancelado cuenta como una cancelación en su día', async () => {
      const [primero, segundo] = [await reservar(ctx.fixtures.tripA), await reservar(ctx.fixtures.tripB)];
      await execute("UPDATE bookings SET status = 'CANCELLED', segment_order = 1, cancelled_at = '2030-09-09 10:00:00' WHERE id = ?", [primero]);
      await execute("UPDATE bookings SET status = 'CANCELLED', segment_order = 2, cancelled_at = '2030-09-09 10:00:01' WHERE id = ?", [segundo]);
      const res = await reporte('cancellations', '2030-09-09', '2030-09-09');
      assert.equal(Number(res.body.data.rows[0].cancellations), 2);
    });
  });

  // =====================================================================
  describe('H-36 · empresa no activa', () => {
    const suspender = (companyId: number) => put(`/companies/${companyId}`, { status: 'SUSPENDED' }, ctx.sessions.admin.token);

    it('H36-1 · ACTIVE: la empresa vende y opera con normalidad (control)', async () => {
      const bookingId = await reservar(ctx.fixtures.tripB);
      assert.equal((await post(`/bookings/${bookingId}/pay`, { method: 'CASH' }, ctx.sessions.admin.token)).status, 200);
      assert.equal((await put(`/trips/${ctx.fixtures.tripB}`, { boarding_notes: 'ok' }, ctx.sessions.companyAdminB.token)).status, 200);
      assert.equal((await put(`/trips/${ctx.fixtures.tripA}`, { boarding_notes: 'ok' }, ctx.sessions.operator.token)).status, 200, 'el OPERATOR de una empresa activa no se bloquea');
    });

    it('H36-2 · SUSPENDED: ni búsqueda pública, ni reserva nueva, ni cobro de reservas anteriores', async () => {
      const pendiente = await reservar(ctx.fixtures.tripB);
      const manual = await reservar(ctx.fixtures.tripB);
      assert.equal((await post(`/bookings/${manual}/pay`, { method: 'YAPE' }, ctx.sessions.customer.token)).status, 202);
      assert.equal((await suspender(ctx.fixtures.companyB)).status, 200);

      assert.equal((await get(`/public/trips/${ctx.fixtures.tripB}`)).status, 404);
      const empresas = (await get('/public/companies')).body.data as Array<{ id: number }>;
      assert.ok(!empresas.some((c) => Number(c.id) === ctx.fixtures.companyB));
      const nueva = await post('/bookings', { trip_id: ctx.fixtures.tripB, seat_ids: [at(await freeSeats(ctx.fixtures.tripB), 0).id] }, ctx.sessions.customer.token);
      assert.equal(nueva.status, 400);

      assert.equal((await post(`/bookings/${pendiente}/pay`, { method: 'CASH' }, ctx.sessions.admin.token)).status, 409, 'ni el ADMIN confirma una venta');
      assert.equal((await pagarTarjeta(pendiente)).status, 409);
      assert.equal(cargos, 0, 'no se pide ningún cargo a Culqi');
      assert.equal((await post(`/bookings/${pendiente}/pay`, { method: 'TRANSFER' }, ctx.sessions.customer.token)).status, 409);
      const pagoManual = await queryOne<{ id: number }>("SELECT id FROM payments WHERE booking_id = ? AND status = 'PENDING'", [manual]);
      assert.equal((await post(`/payments/${pagoManual!.id}/approve`, {}, ctx.sessions.admin.token)).status, 409);
      assert.deepEqual(await query('SELECT id FROM financial_transactions'), []);
    });

    it('H36-3 · SUSPENDED · COMPANY_ADMIN: consulta y cancela, pero no crea ni modifica viajes, integraciones ni llaves', async () => {
      assert.equal((await suspender(ctx.fixtures.companyB)).status, 200);
      const token = ctx.sessions.companyAdminB.token;
      assert.equal((await get('/trips', token)).status, 200);
      assert.equal((await get('/dashboard/company', token)).status, 200);
      assert.equal((await get('/company/integrations', token)).status, 200);
      const base = await queryOne<{ route_id: number; bus_id: number }>('SELECT route_id, bus_id FROM trips WHERE id = ?', [ctx.fixtures.tripB]);
      const nuevo = await post('/trips', { route_id: base!.route_id, bus_id: base!.bus_id, departure_datetime: '2031-02-01 08:00:00', base_price: 40 }, token);
      assert.equal(nuevo.status, 403);
      assert.doesNotMatch(String(nuevo.body.message), /SUSPENDED|SQL|company_id/);
      assert.equal((await put(`/trips/${ctx.fixtures.tripB}`, { base_price: 1 }, token)).status, 403);
      assert.equal((await put('/company/integrations/CULQI', { credentials: {} }, token)).status, 403);
      assert.equal((await post('/company/integrations/CULQI/connect', {}, token)).status, 403);
      assert.equal((await post('/api-keys', { name: 'no' }, token)).status, 403, 'COMPANY_ADMIN no tiene settings.update; el bloqueo por estado se prueba con el ADMIN en H36-5');
      assert.equal((await post(`/trips/${ctx.fixtures.tripB}/cancel`, {}, token)).status, 200, 'cancelar protege al pasajero y sigue permitido');
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM companies WHERE id = ?', [ctx.fixtures.companyB]))?.status, 'SUSPENDED', 'nada cambia el estado de la empresa');
    });

    it('H36-4 · SUSPENDED · OPERATOR de esa empresa: bloqueado igual que su administrador; el de otra empresa no', async () => {
      assert.equal((await suspender(ctx.fixtures.companyA)).status, 200);
      assert.equal((await get('/trips', ctx.sessions.operator.token)).status, 200);
      assert.equal((await put(`/trips/${ctx.fixtures.tripA}`, { boarding_notes: 'x' }, ctx.sessions.operator.token)).status, 403);
      assert.equal((await put(`/trips/${ctx.fixtures.tripB}`, { boarding_notes: 'x' }, ctx.sessions.companyAdminB.token)).status, 200);
    });

    it('H36-5 · SUSPENDED · ADMIN: revisa y corrige la empresa, pero no le emite credenciales de venta; reactivar la devuelve a la normalidad', async () => {
      assert.equal((await suspender(ctx.fixtures.companyB)).status, 200);
      assert.equal((await put(`/trips/${ctx.fixtures.tripB}`, { boarding_notes: 'revisado por BusPerú' }, ctx.sessions.admin.token)).status, 200);
      assert.equal((await get(`/companies/${ctx.fixtures.companyB}`, ctx.sessions.admin.token)).status, 200);
      assert.equal((await post('/api-keys', { name: 'no', company_id: ctx.fixtures.companyB }, ctx.sessions.admin.token)).status, 409);

      assert.equal((await put(`/companies/${ctx.fixtures.companyB}`, { status: 'ACTIVE' }, ctx.sessions.admin.token)).status, 200);
      const bookingId = await reservar(ctx.fixtures.tripB);
      assert.equal((await post(`/bookings/${bookingId}/pay`, { method: 'CASH' }, ctx.sessions.admin.token)).status, 200);
      assert.equal((await put(`/trips/${ctx.fixtures.tripB}`, { boarding_notes: 'ok' }, ctx.sessions.companyAdminB.token)).status, 200);
    });

    it('H36-6 · SUSPENDED · CUSTOMER: conserva su historial y puede cancelar su reserva pagada', async () => {
      const bookingId = await reservar(ctx.fixtures.tripB);
      assert.equal((await post(`/bookings/${bookingId}/pay`, { method: 'CASH' }, ctx.sessions.admin.token)).status, 200);
      assert.equal((await suspender(ctx.fixtures.companyB)).status, 200);
      assert.equal((await get(`/bookings/${bookingId}`, ctx.sessions.customer.token)).status, 200);
      assert.equal((await api(`/bookings/${bookingId}/cancel`, { method: 'POST', body: {}, token: ctx.sessions.customer.token })).status, 200);
      assert.equal((await query("SELECT id FROM refunds WHERE booking_id = ? AND status = 'PENDING'", [bookingId])).length, 1, 'H-50 intacto');
    });
  });
});
