import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { api, post } from './helpers/api';
import { env } from '../config/env';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { setCulqiApi, type CulqiApi, type CulqiCharge, type CulqiResult } from '../services/culqi.service';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * F17C-SEC-03C · la reconciliación del webhook compara también la MONEDA.
 *
 * QUÉ PASABA. `settle` —el cobro síncrono— comparaba importe y moneda antes de confirmar. Pero
 * `reconcileApprovedCharge`, que es la vía por la que el webhook cierra un cobro, solo miraba el
 * importe: un cargo declarado en USD o EUR con el mismo número de céntimos confirmaba la reserva
 * y escribía sus movimientos. Lo demostró la auditoría activa F17C-SEC-03B.
 *
 * NINGUNA PRUEBA SALE A LA RED. Se usa el mismo mecanismo que `31-culqi.test.ts`: `setCulqiApi`
 * inyecta un doble EN PROCESO con la superficie de `CulqiApi`, así que el cliente HTTP real nunca
 * se instancia. No se levanta ningún servidor, no se abre ningún puerto y no se toca `.env`: el
 * secreto del webhook se sustituye en memoria sólo mientras dura la suite.
 */
describe('SEC-03C · moneda en la reconciliación del webhook', () => {
  let ctx: SuiteContext;
  const SECRETO = 'secreto-de-suite-sec03c-0000000000';
  let secretoOriginal = '';

  /** Lo que el doble dirá que existe en Culqi, por identificador de cargo. */
  const cargos = new Map<string, { amount: number; currency?: string; outcome?: string; metadata?: Record<string, string> }>();

  before(async () => {
    ctx = await prepareSuite();
    secretoOriginal = env.culqi.webhookSecret;
    (env.culqi as { webhookSecret: string }).webhookSecret = SECRETO;

    const respuesta = (id: string): CulqiResult<CulqiCharge> => {
      const guion = cargos.get(id);
      if (!guion) {
        return { ok: false, kind: 'INVALID', code: 'charge_not_found', userMessage: 'No existe', merchantMessage: 'not found' };
      }
      return {
        ok: true,
        data: {
          id,
          amount: guion.amount,
          // `currency_code` se omite a propósito cuando el guion no lo trae: así se puede
          // representar el caso «el proveedor no declara moneda».
          ...(guion.currency === undefined ? {} : { currency_code: guion.currency }),
          outcome: { type: guion.outcome ?? 'venta_exitosa', user_message: 'ok' },
          ...(guion.metadata ? { metadata: guion.metadata } : {}),
        } as unknown as CulqiCharge,
      };
    };

    const doble: CulqiApi = {
      async createCharge() {
        throw new Error('esta suite no cobra: el webhook es quien concilia');
      },
      async getCharge(id) {
        return respuesta(id);
      },
      async createRefund() {
        return { ok: true, data: { id: 'ref_sec03c' } } as CulqiResult<never> as never;
      },
    };
    setCulqiApi(doble);
  });

  after(async () => {
    setCulqiApi(null);
    (env.culqi as { webhookSecret: string }).webhookSecret = secretoOriginal;
    await teardownSuite();
  });

  beforeEach(async () => {
    cargos.clear();
    for (const tabla of ['settlement_items', 'financial_transactions', 'refunds', 'booking_seats', 'payments', 'notifications', 'bookings']) {
      await execute(`DELETE FROM ${tabla}`);
    }
    await execute("UPDATE trips t JOIN buses b ON b.id = t.bus_id SET t.available_seats = b.capacity, t.status = 'SCHEDULED'");
  });

  afterEach(async () => {
    cargos.clear();
  });

  /** Reserva con un pago de tarjeta en PROCESSING: el escenario que el webhook viene a cerrar. */
  async function reservaConCargo(chargeId: string, opciones: { currency?: string; centimos?: number } = {}) {
    const asientos = await freeSeats(ctx.fixtures.tripA);
    const creada = await post(
      '/bookings',
      { trip_id: ctx.fixtures.tripA, seat_ids: [at(asientos, 0).id], passenger_email: 'cliente@test.pe' },
      ctx.sessions.customer.token,
    );
    assert.equal(creada.status, 201, JSON.stringify(creada.body));
    const bookingId = Number(creada.body.data.id);
    const total = Number(creada.body.data.total_amount);

    const { insertId: paymentId } = await execute(
      `INSERT INTO payments (booking_id, transaction_code, amount, currency, method, status, provider, payment_data)
       VALUES (?, ?, ?, 'PEN', 'CARD', 'PROCESSING', 'CULQI', ?)`,
      [bookingId, `TRX-SEC03C-${bookingId}-${Date.now().toString().slice(-6)}`, total, JSON.stringify({ token: 'tkn_sec03c' })],
    );

    cargos.set(chargeId, {
      amount: opciones.centimos ?? Math.round(total * 100),
      currency: 'currency' in opciones ? opciones.currency : 'PEN',
      metadata: { payment_id: String(paymentId), booking_id: String(bookingId) },
    });
    return { bookingId, paymentId, total };
  }

  const webhook = (chargeId: string, extra: Record<string, unknown> = {}) =>
    api(`/culqi/webhook/${SECRETO}`, { method: 'POST', body: { type: 'charge.succeeded', data: { id: chargeId, object: 'charge', ...extra } } });

  const estado = async (paymentId: number, bookingId: number) => ({
    pago: await queryOne<{ status: string; currency: string }>('SELECT status, currency FROM payments WHERE id = ?', [paymentId]),
    reserva: await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [bookingId]),
    movimientos: await query<{ type: string }>('SELECT type FROM financial_transactions WHERE payment_id = ?', [paymentId]),
  });

  /* ==================================================== A · moneda correcta */
  it('A · moneda correcta: el webhook confirma como siempre', async () => {
    const { bookingId, paymentId } = await reservaConCargo('chr_sec03c_pen');
    const r = await webhook('chr_sec03c_pen');
    const { pago, reserva, movimientos } = await estado(paymentId, bookingId);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(pago?.status, 'PAID');
    assert.equal(reserva?.status, 'CONFIRMED');
    assert.equal(movimientos.length, 3, 'tarifa a la empresa, comisión y cargo por servicio');
  });

  /* ==================================================== B y C · otra divisa */
  for (const divisa of ['USD', 'EUR']) {
    it(`${divisa === 'USD' ? 'B' : 'C'} · ${divisa} con el importe correcto: no confirma nada`, async () => {
      const { bookingId, paymentId } = await reservaConCargo(`chr_sec03c_${divisa}`, { currency: divisa });
      const r = await webhook(`chr_sec03c_${divisa}`);
      const { pago, reserva, movimientos } = await estado(paymentId, bookingId);

      // El webhook sigue respondiendo de forma controlada: un 4xx haría reintentar a Culqi.
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.notEqual(pago?.status, 'PAID', `el pago no puede quedar PAID con un cargo en ${divisa}`);
      assert.notEqual(reserva?.status, 'CONFIRMED', 'la reserva no puede confirmarse por esa reconciliación');
      assert.equal(movimientos.length, 0, 'no puede escribirse ningún movimiento financiero');
      assert.equal(pago?.currency, 'PEN', 'la moneda del pago no se reescribe');
    });
  }

  /* ==================================================== D · moneda ausente */
  it('D · el proveedor no declara moneda: no confirma nada', async () => {
    const { bookingId, paymentId } = await reservaConCargo('chr_sec03c_sin_moneda', { currency: undefined });
    const r = await webhook('chr_sec03c_sin_moneda');
    const { pago, reserva, movimientos } = await estado(paymentId, bookingId);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.notEqual(pago?.status, 'PAID');
    assert.notEqual(reserva?.status, 'CONFIRMED');
    assert.equal(movimientos.length, 0);
  });

  /* ==================================================== E · importe correcto no compensa */
  it('E · el importe exacto NO compensa una moneda incorrecta', async () => {
    const { bookingId, paymentId, total } = await reservaConCargo('chr_sec03c_exacto', { currency: 'USD' });
    // Se fuerza el importe al céntimo exacto del pago: lo único que falla es la divisa.
    cargos.set('chr_sec03c_exacto', { ...cargos.get('chr_sec03c_exacto')!, amount: Math.round(total * 100), currency: 'USD' });

    const r = await webhook('chr_sec03c_exacto');
    const { pago, movimientos } = await estado(paymentId, bookingId);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.notEqual(pago?.status, 'PAID');
    assert.equal(movimientos.length, 0);
  });

  /* ==================================================== F · el cuerpo no manda */
  it('F · la moneda del CUERPO del webhook no es fuente de verdad', async () => {
    const { bookingId, paymentId } = await reservaConCargo('chr_sec03c_cuerpo', { currency: 'USD' });
    // El cuerpo afirma PEN; el proveedor dice USD. Manda el proveedor.
    const r = await webhook('chr_sec03c_cuerpo', { currency_code: 'PEN', amount: 4750, outcome: { type: 'venta_exitosa' } });
    const { pago, reserva, movimientos } = await estado(paymentId, bookingId);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.notEqual(pago?.status, 'PAID', 'el cuerpo del webhook no puede imponer la moneda');
    assert.notEqual(reserva?.status, 'CONFIRMED');
    assert.equal(movimientos.length, 0);
  });

  /* ==================================================== G · el replay sigue intacto */
  it('G · la idempotencia del replay no se rompe', async () => {
    const { bookingId, paymentId } = await reservaConCargo('chr_sec03c_replay');
    const primero = await webhook('chr_sec03c_replay');
    const foto = JSON.stringify(await estado(paymentId, bookingId));
    const segundo = await webhook('chr_sec03c_replay');
    const despues = JSON.stringify(await estado(paymentId, bookingId));

    assert.equal(primero.status, 200);
    assert.equal(segundo.status, 200);
    assert.equal(foto, despues, 'el segundo evento no puede cambiar nada');

    // Y un replay que AHORA llega con otra divisa tampoco puede tocar un pago ya cerrado:
    // la rama de «pago ya cerrado» se evalúa antes que la comparación del cargo.
    cargos.set('chr_sec03c_replay', { ...cargos.get('chr_sec03c_replay')!, currency: 'USD' });
    const tercero = await webhook('chr_sec03c_replay');
    assert.equal(tercero.status, 200);
    assert.equal(JSON.stringify(await estado(paymentId, bookingId)), foto, 'un cargo ya conciliado no se reabre');
  });

  /* ==================================================== H · concurrencia */
  it('H · dos reconciliaciones simultáneas: el cerrojo sigue funcionando', async () => {
    const { bookingId, paymentId } = await reservaConCargo('chr_sec03c_concurrente');
    const [a, b] = await Promise.all([webhook('chr_sec03c_concurrente'), webhook('chr_sec03c_concurrente')]);
    const { pago, reserva, movimientos } = await estado(paymentId, bookingId);

    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(pago?.status, 'PAID');
    assert.equal(reserva?.status, 'CONFIRMED');
    assert.equal(movimientos.length, 3, 'una sola reconciliación efectiva pese a las dos peticiones');
  });

  it('H2 · dos reconciliaciones simultáneas con moneda incorrecta: ninguna escribe', async () => {
    const { bookingId, paymentId } = await reservaConCargo('chr_sec03c_conc_usd', { currency: 'USD' });
    const [a, b] = await Promise.all([webhook('chr_sec03c_conc_usd'), webhook('chr_sec03c_conc_usd')]);
    const { pago, movimientos } = await estado(paymentId, bookingId);

    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.notEqual(pago?.status, 'PAID');
    assert.equal(movimientos.length, 0);
  });

  /* ==================================================== coherencia con el cobro síncrono */
  it('la regla es la MISMA que usa el cobro síncrono', async () => {
    const { compararCargo } = await import('../services/payment.service');
    const cargo = (amount: number, currency?: string) => ({ amount, ...(currency === undefined ? {} : { currency_code: currency }) }) as CulqiCharge;

    assert.equal(compararCargo(cargo(4750, 'PEN'), 4750, 'PEN'), null, 'importe y moneda correctos');
    assert.equal(compararCargo(cargo(4700, 'PEN'), 4750, 'PEN'), 'amount', 'el importe se comprueba primero');
    assert.equal(compararCargo(cargo(4750, 'USD'), 4750, 'PEN'), 'currency');
    assert.equal(compararCargo(cargo(4750, undefined), 4750, 'PEN'), 'currency', 'sin moneda declarada tampoco cuadra');
    assert.equal(compararCargo(cargo(4750, 'pen'), 4750, 'PEN'), 'currency', 'la comparación es exacta, sin normalizar');
  });
});
