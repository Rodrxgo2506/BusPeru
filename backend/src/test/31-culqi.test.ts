import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { get, post } from './helpers/api';
import { env } from '../config/env';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { setCulqiApi, type CulqiApi, type CulqiCharge, type CulqiResult } from '../services/culqi.service';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

// El registrador de BP-17 calla durante la suite salvo con esto; aquí hace falta leerlo.
process.env.LOG_ERRORS = 'true';

/**
 * Cobro con tarjeta por Culqi, modelo agregador.
 *
 * NINGUNA prueba sale a la red ni usa credenciales reales: `setCulqiApi` inyecta un doble
 * con la misma superficie que el cliente HTTP. Las llaves que aparecen aquí son literales
 * de usar y tirar que no valen en ningún entorno.
 *
 * Lo que se defiende es que **el backend es la autoridad**: el importe, la moneda, el dueño
 * de la reserva y el resultado del cobro salen de la base de datos y de Culqi, nunca de lo
 * que envíe el navegador.
 */
describe('Pagos con Culqi', () => {
  let ctx: SuiteContext;
  const TOKEN = 'tkn_test_ejemplo1234';
  const LLAVE_PUBLICA = 'pk_test_solo_para_pruebas';
  const LLAVE_PRIVADA = 'sk_test_solo_para_pruebas';

  /** Doble del cliente de Culqi. Anota lo que se le pide y devuelve lo que se le indique. */
  function culqiFalso(opciones: {
    charge?: Partial<CulqiCharge>;
    fallo?: { kind: 'DECLINED' | 'INVALID' | 'TIMEOUT' | 'PROVIDER'; userMessage?: string };
    refundId?: string;
  } = {}) {
    const cargos: Array<Record<string, unknown>> = [];
    const devoluciones: Array<Record<string, unknown>> = [];

    const respuesta = (base: Partial<CulqiCharge>): CulqiResult<CulqiCharge> => {
      if (opciones.fallo) {
        return {
          ok: false,
          kind: opciones.fallo.kind,
          code: 'card_declined',
          userMessage: opciones.fallo.userMessage ?? 'Tarjeta rechazada.',
          merchantMessage: 'detalle tecnico',
        };
      }
      return {
        ok: true,
        data: {
          id: 'chr_test_0001',
          amount: base.amount ?? 0,
          currency_code: base.currency_code ?? 'PEN',
          outcome: { type: 'venta_exitosa', user_message: 'Pago exitoso' },
          ...opciones.charge,
        } as CulqiCharge,
      };
    };

    const api: CulqiApi = {
      async createCharge(input) {
        cargos.push({ ...input });
        return respuesta({ amount: input.amountCents, currency_code: input.currencyCode });
      },
      async getCharge(id) {
        return respuesta({ amount: ultimoImporte(), currency_code: 'PEN', id } as Partial<CulqiCharge>);
      },
      async createRefund(input) {
        devoluciones.push({ ...input });
        return { ok: true, data: { id: opciones.refundId ?? 'ref_test_0001', charge_id: input.chargeId, amount: input.amountCents } };
      },
    };

    const ultimoImporte = () => Number(cargos[cargos.length - 1]?.amountCents ?? 0);
    return { api, cargos, devoluciones };
  }

  before(async () => {
    ctx = await prepareSuite();
  });
  after(async () => {
    setCulqiApi(null);
    await teardownSuite();
  });

  beforeEach(async () => {
    env.culqi.publicKey = LLAVE_PUBLICA;
    env.culqi.privateKey = LLAVE_PRIVADA;
    env.culqi.webhookSecret = 'secreto-de-webhook-para-pruebas';
    await execute('DELETE FROM refunds');
    await execute('DELETE FROM financial_transactions');
    await execute('DELETE FROM payments');
    await execute('DELETE FROM booking_seats');
    await execute('DELETE FROM bookings');
    await execute('UPDATE trips SET available_seats = (SELECT capacity FROM buses WHERE id = trips.bus_id)');
  });

  afterEach(() => {
    setCulqiApi(null);
    env.culqi.publicKey = '';
    env.culqi.privateKey = '';
  });

  /* ------------------------------------------------------------------ utilidades */

  async function reservar(token = ctx.sessions.customer.token): Promise<{ id: number; total: number; code: string }> {
    const res = await post(
      '/bookings',
      {
        trip_id: ctx.fixtures.tripA,
        seat_ids: [at(await freeSeats(ctx.fixtures.tripA), 0).id],
        passenger_email: 'cliente@test.pe',
      },
      token,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { id: res.body.data.id, total: Number(res.body.data.total_amount), code: res.body.data.booking_code };
  }

  const pagar = (bookingId: number, cuerpo: Record<string, unknown> = {}, token = ctx.sessions.customer.token) =>
    post(`/bookings/${bookingId}/pay`, { method: 'CARD', token: TOKEN, ...cuerpo }, token);

  const pago = (bookingId: number) =>
    queryOne<{ id: number; status: string; provider: string; provider_transaction_id: string; amount: string }>(
      'SELECT id, status, provider, provider_transaction_id, amount FROM payments WHERE booking_id = ? ORDER BY id DESC LIMIT 1',
      [bookingId],
    );

  const estadoReserva = async (bookingId: number) =>
    (await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [bookingId]))?.status;

  const webhook = (chargeId: string, secreto = env.culqi.webhookSecret) =>
    post(`/culqi/webhook/${secreto}`, { object: 'event', data: { id: chargeId, object: 'charge' } });

  /* ══════════════════════════════ configuración ═════════════════════════════ */

  describe('Configuración y credenciales', () => {
    it('1 · sin credenciales, la tarjeta se anuncia como no disponible', async () => {
      env.culqi.publicKey = '';
      env.culqi.privateKey = '';

      const res = await get('/culqi/config', ctx.sessions.customer.token);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.card_enabled, false);
      assert.equal(res.body.data.public_key, '');
    });

    it('2 · con credenciales, se publica la llave pública y se habilita la tarjeta', async () => {
      const res = await get('/culqi/config', ctx.sessions.customer.token);

      assert.equal(res.body.data.card_enabled, true);
      assert.equal(res.body.data.public_key, LLAVE_PUBLICA);
      assert.equal(res.body.data.currency, 'PEN');
    });

    it('3 · la llave privada no sale nunca en la respuesta', async () => {
      const res = await get('/culqi/config', ctx.sessions.customer.token);

      const texto = JSON.stringify(res.body);
      assert.ok(!texto.includes(LLAVE_PRIVADA), 'la llave privada jamás puede viajar al cliente');
      assert.ok(!texto.includes('private'));
      assert.ok(!texto.toLowerCase().includes('sk_'));
    });

    it('4 · sin llave privada el cobro no ocurre y se responde sin exponer el motivo interno', async () => {
      const reserva = await reservar();
      env.culqi.privateKey = '';
      // Sin doble inyectado: se usa el cliente real, que corta al no haber llave.
      setCulqiApi(null);

      const res = await pagar(reserva.id);

      assert.equal(res.status, 402);
      assert.ok(!JSON.stringify(res.body).toLowerCase().includes('culqi_private_key'));
      assert.equal(await estadoReserva(reserva.id), 'PENDING');
    });
  });

  /* ══════════════════════════════ cobro ═════════════════════════════════════ */

  describe('Cobro con tarjeta', () => {
    it('5 · un cobro aceptado confirma la reserva y guarda el cargo de Culqi', async () => {
      const { api, cargos } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();

      const res = await pagar(reserva.id);

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(await estadoReserva(reserva.id), 'CONFIRMED');
      const fila = await pago(reserva.id);
      assert.equal(fila?.status, 'PAID');
      assert.equal(fila?.provider, 'CULQI');
      assert.equal(fila?.provider_transaction_id, 'chr_test_0001');
      assert.equal(cargos.length, 1);
    });

    it('6 · el importe cobrado sale de la base, en céntimos, y no del cliente', async () => {
      const { api, cargos } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();

      // El cliente intenta imponer otro importe y otra moneda.
      await pagar(reserva.id, { amount: 1, amount_cents: 1, currency: 'USD', total_amount: 1 });

      assert.equal(cargos[0]!.amountCents, Math.round(reserva.total * 100));
      assert.equal(cargos[0]!.currencyCode, 'PEN');
    });

    it('7 · `provider_transaction_id` del cliente se ignora por completo', async () => {
      const { api } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();

      await pagar(reserva.id, { provider_transaction_id: 'chr_inventado_por_el_cliente' });

      const fila = await pago(reserva.id);
      assert.equal(fila?.provider_transaction_id, 'chr_test_0001', 'solo vale el identificador que devuelve Culqi');
    });

    it('8 · un cobro rechazado deja la reserva sin confirmar y el pago en FAILED', async () => {
      const { api } = culqiFalso({ fallo: { kind: 'DECLINED', userMessage: 'Tarjeta sin fondos.' } });
      setCulqiApi(api);
      const reserva = await reservar();

      const res = await pagar(reserva.id);

      assert.equal(res.status, 402);
      assert.match(String(res.body.message), /sin fondos/i);
      assert.equal(await estadoReserva(reserva.id), 'PENDING');
      assert.equal((await pago(reserva.id))?.status, 'FAILED');
    });

    it('9 · un cargo que Culqi no marca como exitoso no confirma nada', async () => {
      const { api } = culqiFalso({ charge: { outcome: { type: 'pendiente', user_message: 'En revisión' } } });
      setCulqiApi(api);
      const reserva = await reservar();

      const res = await pagar(reserva.id);

      assert.equal(res.status, 402);
      assert.equal(await estadoReserva(reserva.id), 'PENDING');
    });

    it('10 · un error del proveedor no confirma la reserva', async () => {
      const { api } = culqiFalso({ fallo: { kind: 'PROVIDER' } });
      setCulqiApi(api);
      const reserva = await reservar();

      assert.equal((await pagar(reserva.id)).status, 402);
      assert.equal(await estadoReserva(reserva.id), 'PENDING');
    });

    it('11 · un timeout deja el pago FAILED, nunca la reserva confirmada', async () => {
      const { api } = culqiFalso({ fallo: { kind: 'TIMEOUT', userMessage: 'Vuelve a intentarlo.' } });
      setCulqiApi(api);
      const reserva = await reservar();

      assert.equal((await pagar(reserva.id)).status, 402);
      assert.equal(await estadoReserva(reserva.id), 'PENDING');
      assert.equal((await pago(reserva.id))?.status, 'FAILED');
    });

    it('12 · si Culqi devuelve otro importe, no se confirma la reserva', async () => {
      const { api } = culqiFalso({ charge: { amount: 1 } });
      setCulqiApi(api);
      const reserva = await reservar();

      const res = await pagar(reserva.id);

      assert.equal(res.status, 409);
      assert.equal(await estadoReserva(reserva.id), 'PENDING');
    });

    it('13 · un token con formato inválido se rechaza antes de llamar a Culqi', async () => {
      const { api, cargos } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();

      const res = await pagar(reserva.id, { token: 'no-es-un-token' });

      assert.equal(res.status, 400);
      assert.equal(cargos.length, 0, 'no se molesta a la pasarela con basura');
    });

    it('14 · con tarjeta y sin token la petición ni siquiera se valida', async () => {
      const reserva = await reservar();
      const res = await post(`/bookings/${reserva.id}/pay`, { method: 'CARD' }, ctx.sessions.customer.token);

      assert.equal(res.status, 422);
    });
  });

  /* ══════════════════════════════ autorización ══════════════════════════════ */

  describe('De quién es la reserva', () => {
    it('15 · una reserva inexistente responde 404', async () => {
      const { api } = culqiFalso();
      setCulqiApi(api);

      assert.equal((await pagar(999999)).status, 404);
    });

    it('16 · no se puede pagar la reserva de otra persona', async () => {
      const { api, cargos } = culqiFalso();
      setCulqiApi(api);
      const ajena = await reservar(ctx.sessions.companyAdmin.token);

      const res = await pagar(ajena.id, {}, ctx.sessions.customer.token);

      assert.equal(res.status, 404, 'un recurso ajeno responde 404, no 403');
      assert.equal(cargos.length, 0);
      assert.equal(await estadoReserva(ajena.id), 'PENDING');
    });

    it('17 · una reserva vencida no se puede pagar', async () => {
      const { api, cargos } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [reserva.id]);

      const res = await pagar(reserva.id);

      assert.equal(res.status, 400);
      assert.equal(cargos.length, 0, 'no se cobra algo que ya no se puede entregar');
    });

    it('18 · una reserva cancelada tampoco', async () => {
      const { api, cargos } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();
      await post(`/bookings/${reserva.id}/cancel`, {}, ctx.sessions.customer.token);

      assert.equal((await pagar(reserva.id)).status, 400);
      assert.equal(cargos.length, 0);
    });
  });

  /* ══════════════════════════════ idempotencia ══════════════════════════════ */

  describe('Una intención, un solo cobro', () => {
    it('19 · pagar dos veces seguidas no genera un segundo cargo', async () => {
      const { api, cargos } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();

      const primera = await pagar(reserva.id);
      const segunda = await pagar(reserva.id);

      assert.equal(primera.status, 200);
      assert.equal(segunda.status, 200, 'la repetición es inofensiva, no un error');
      assert.equal(cargos.length, 1, 'Culqi solo debe ver un cargo');
      const pagados = await query('SELECT id FROM payments WHERE booking_id = ? AND status = ?', [reserva.id, 'PAID']);
      assert.equal(pagados.length, 1);
    });

    it('20 · dos peticiones simultáneas tampoco duplican el cargo', async () => {
      const { api, cargos } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();

      const [a, b] = await Promise.all([pagar(reserva.id), pagar(reserva.id)]);

      assert.equal(cargos.length, 1, `se pidieron ${cargos.length} cargos: ${JSON.stringify(cargos)}`);
      const exitos = [a, b].filter((r) => r.status === 200);
      assert.ok(exitos.length >= 1);
      const pagados = await query('SELECT id FROM payments WHERE booking_id = ? AND status = ?', [reserva.id, 'PAID']);
      assert.equal(pagados.length, 1);
    });

    it('21 · una reserva ya confirmada no se vuelve a cobrar', async () => {
      const { api, cargos } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();
      await pagar(reserva.id);

      const otra = await pagar(reserva.id);

      assert.equal(otra.status, 200);
      assert.equal(cargos.length, 1);
    });

    it('22 · no se crea un segundo movimiento financiero al repetir', async () => {
      const { api } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();

      await pagar(reserva.id);
      await pagar(reserva.id);

      const movimientos = await query(
        "SELECT id FROM financial_transactions WHERE booking_id = ? AND type = 'PAYMENT' AND company_id IS NOT NULL",
        [reserva.id],
      );
      assert.equal(movimientos.length, 1);
    });
  });

  /* ══════════════════════════════ webhook ═══════════════════════════════════ */

  describe('Webhook de Culqi', () => {
    it('23 · con el secreto correcto y un cargo verificado, confirma la reserva', async () => {
      const { api } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();
      // Un pago en PROCESSING, como si la respuesta HTTP del cobro se hubiera perdido y solo
      // nos llegara la noticia por el webhook.
      await execute(
        `INSERT INTO payments (booking_id, transaction_code, amount, currency, method, status, provider, payment_data)
         VALUES (?, ?, ?, 'PEN', 'CARD', 'PROCESSING', 'CULQI', ?)`,
        [reserva.id, `TRX-WH-${reserva.id}`, reserva.total, JSON.stringify({ charge_id: 'chr_test_0001' })],
      );
      setCulqiApi(culqiFalso({ charge: { amount: Math.round(reserva.total * 100) } }).api);

      const res = await webhook('chr_test_0001');

      assert.equal(res.status, 200);
      assert.equal(await estadoReserva(reserva.id), 'CONFIRMED');
    });

    it('24 · con un secreto equivocado responde 404 y no toca nada', async () => {
      const { api } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();

      const res = await webhook('chr_test_0001', 'secreto-que-no-es');

      assert.equal(res.status, 404);
      assert.equal(await estadoReserva(reserva.id), 'PENDING');
    });

    it('25 · sin secreto configurado, el webhook no acepta nada', async () => {
      env.culqi.webhookSecret = '';
      const res = await post('/culqi/webhook/cualquier-cosa', { data: { id: 'chr_test_0001' } });

      assert.equal(res.status, 404);
    });

    it('26 · un webhook repetido no duplica movimientos ni cobros', async () => {
      const { api } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();
      await pagar(reserva.id);
      setCulqiApi(culqiFalso({ charge: { amount: Math.round(reserva.total * 100) } }).api);

      await webhook('chr_test_0001');
      await webhook('chr_test_0001');

      const pagados = await query('SELECT id FROM payments WHERE booking_id = ? AND status = ?', [reserva.id, 'PAID']);
      assert.equal(pagados.length, 1);
      const movimientos = await query(
        "SELECT id FROM financial_transactions WHERE booking_id = ? AND type = 'PAYMENT' AND company_id IS NOT NULL",
        [reserva.id],
      );
      assert.equal(movimientos.length, 1);
      assert.equal(await estadoReserva(reserva.id), 'CONFIRMED');
    });

    it('27 · un webhook de un cargo desconocido se acepta sin hacer nada', async () => {
      const { api } = culqiFalso();
      setCulqiApi(api);

      const res = await webhook('chr_que_no_existe_aqui');

      assert.equal(res.status, 200, 'un 4xx haría que Culqi reintentara para siempre');
      assert.equal(res.body.data.handled, false);
    });

    it('28 · un cuerpo sin identificador de cargo se acepta y se ignora', async () => {
      const res = await post(`/culqi/webhook/${env.culqi.webhookSecret}`, { object: 'event', data: {} });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.handled, false);
    });

    it('29 · el webhook no confirma si el importe del cargo no es el del pago', async () => {
      const { api } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();
      await execute(
        `INSERT INTO payments (booking_id, transaction_code, amount, currency, method, status, provider, payment_data)
         VALUES (?, ?, ?, 'PEN', 'CARD', 'PROCESSING', 'CULQI', ?)`,
        [reserva.id, `TRX-WH2-${reserva.id}`, reserva.total, JSON.stringify({ charge_id: 'chr_test_0001' })],
      );
      // Culqi dice un importe distinto al de la reserva.
      setCulqiApi(culqiFalso({ charge: { amount: 1 } }).api);

      const res = await webhook('chr_test_0001');

      assert.equal(res.status, 200);
      assert.equal(await estadoReserva(reserva.id), 'PENDING');
    });

    it('30 · el webhook no requiere sesión: Culqi no tiene una', async () => {
      const res = await post(`/culqi/webhook/${env.culqi.webhookSecret}`, { data: {} });
      assert.notEqual(res.status, 401);
    });
  });

  /* ══════════════════════════════ trazabilidad ═════════════════════════════ */

  describe('Cada webhook deja rastro', () => {
    const originalError = console.error;
    let lineas: string[] = [];

    /** Ejecuta `accion` capturando lo que escriba el registrador estructurado. */
    async function registros(accion: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
      lineas = [];
      console.error = (...args: unknown[]) => {
        lineas.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
      };
      try {
        await accion();
      } finally {
        console.error = originalError;
      }
      return lineas
        .map((linea) => {
          try {
            return JSON.parse(linea) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((r): r is Record<string, unknown> => r !== null && r.provider === 'CULQI');
    }

    afterEach(() => {
      console.error = originalError;
    });

    /** Reserva pagada por la ruta síncrona, como en la compra real. */
    async function reservaPagadaPorHttp() {
      const { api } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();
      assert.equal((await pagar(reserva.id)).status, 200);
      return reserva;
    }

    /** Pago en PROCESSING con su cargo anotado, como si la respuesta HTTP se hubiera perdido. */
    async function pagoEnVuelo(bookingId: number, total: number, etiqueta: string) {
      await execute(
        `INSERT INTO payments (booking_id, transaction_code, amount, currency, method, status, provider, payment_data)
         VALUES (?, ?, ?, 'PEN', 'CARD', 'PROCESSING', 'CULQI', ?)`,
        [bookingId, `TRX-${etiqueta}-${bookingId}`, total, JSON.stringify({ charge_id: 'chr_test_0001' })],
      );
    }

    it('39 · un webhook que concilia queda registrado con su resultado', async () => {
      const { api } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();
      await pagoEnVuelo(reserva.id, reserva.total, 'TR');
      setCulqiApi(culqiFalso({ charge: { amount: Math.round(reserva.total * 100) } }).api);

      const anotados = await registros(async () => {
        await webhook('chr_test_0001');
      });

      assert.equal(anotados.length, 1, 'exactamente un registro por recepción');
      assert.equal(anotados[0]!.level, 'info');
      assert.equal(anotados[0]!.outcome, 'reconciled');
      assert.equal(anotados[0]!.chargeId, 'chr_test_0001');
      assert.equal(anotados[0]!.bookingId, reserva.id);
      assert.ok(typeof anotados[0]!.paymentId === 'number');
      assert.ok(!Number.isNaN(Date.parse(String(anotados[0]!.timestamp))), 'lleva marca de tiempo');
      assert.equal(await estadoReserva(reserva.id), 'CONFIRMED');
    });

    it('40 · sobre un pago ya conciliado se registra `already_reconciled`', async () => {
      const reserva = await reservaPagadaPorHttp();
      setCulqiApi(culqiFalso({ charge: { amount: Math.round(reserva.total * 100) } }).api);

      const anotados = await registros(async () => {
        await webhook('chr_test_0001');
      });

      assert.equal(anotados.length, 1);
      assert.equal(anotados[0]!.outcome, 'already_reconciled');
      assert.equal(anotados[0]!.bookingId, reserva.id);
      assert.equal(anotados[0]!.detail, 'ya estaba conciliado');
    });

    it('41 · repetirlo deja DOS registros y ningún duplicado en la base', async () => {
      const reserva = await reservaPagadaPorHttp();
      setCulqiApi(culqiFalso({ charge: { amount: Math.round(reserva.total * 100) } }).api);

      const anotados = await registros(async () => {
        await webhook('chr_test_0001');
        await webhook('chr_test_0001');
      });

      // Dos recepciones, dos registros: justo lo que antes no se podía saber.
      assert.equal(anotados.length, 2);
      assert.deepEqual(anotados.map((r) => r.outcome), ['already_reconciled', 'already_reconciled']);

      const pagados = await query('SELECT id FROM payments WHERE booking_id = ? AND status = ?', [reserva.id, 'PAID']);
      assert.equal(pagados.length, 1, 'ni un pago de más');
      const movimientos = await query('SELECT id FROM financial_transactions WHERE booking_id = ?', [reserva.id]);
      assert.equal(movimientos.length, 3, 'solo PAYMENT y COMMISSION de la empresa y el service fee de la plataforma');
      assert.equal(await estadoReserva(reserva.id), 'CONFIRMED');
    });

    it('42 · un cargo que no corresponde a nadie se registra como `not_correlated`', async () => {
      const { api } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();

      const anotados = await registros(async () => {
        await webhook('chr_test_desconocido');
      });

      assert.equal(anotados[0]!.outcome, 'not_correlated');
      assert.equal(anotados[0]!.chargeId, 'chr_test_desconocido');
      assert.equal(await estadoReserva(reserva.id), 'PENDING', 'la reserva no se toca');
    });

    it('43 · un cuerpo sin cargo se registra como `unsupported_event`', async () => {
      const anotados = await registros(async () => {
        await post(`/culqi/webhook/${env.culqi.webhookSecret}`, { object: 'event', data: {} });
      });

      assert.equal(anotados[0]!.outcome, 'unsupported_event');
      assert.equal(anotados[0]!.event, 'event');
    });

    it('44 · un secreto equivocado se registra como `unauthorized`, sin el valor', async () => {
      const anotados = await registros(async () => {
        const res = await webhook('chr_test_0001', 'secreto-que-no-es-el-nuestro');
        assert.equal(res.status, 404);
      });

      assert.equal(anotados.length, 1, 'un intento no autorizado también deja rastro');
      assert.equal(anotados[0]!.outcome, 'unauthorized');
      const texto = JSON.stringify(anotados);
      assert.ok(!texto.includes('secreto-que-no-es-el-nuestro'), 'el secreto recibido no se registra');
      assert.ok(!texto.includes(env.culqi.webhookSecret), 'el esperado tampoco');
    });

    it('45 · un importe discordante se registra como `amount_mismatch`', async () => {
      const { api } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();
      await pagoEnVuelo(reserva.id, reserva.total, 'AM');
      setCulqiApi(culqiFalso({ charge: { amount: 1 } }).api);

      const anotados = await registros(async () => {
        await webhook('chr_test_0001');
      });

      assert.equal(anotados[0]!.outcome, 'amount_mismatch');
      assert.equal(await estadoReserva(reserva.id), 'PENDING');
    });

    it('46 · el registro no contiene credenciales ni datos de tarjeta', async () => {
      const reserva = await reservaPagadaPorHttp();
      setCulqiApi(culqiFalso({ charge: { amount: Math.round(reserva.total * 100) } }).api);

      const anotados = await registros(async () => {
        await webhook('chr_test_0001');
      });

      const texto = JSON.stringify(anotados);
      assert.ok(!texto.includes(LLAVE_PRIVADA), 'ni la llave privada');
      assert.ok(!texto.includes(LLAVE_PUBLICA), 'ni la pública');
      assert.ok(!texto.includes(env.culqi.webhookSecret), 'ni el secreto del webhook');
      assert.ok(!texto.includes(TOKEN), 'ni el token de la tarjeta');
      assert.ok(!texto.toLowerCase().includes('authorization'));
      assert.ok(!texto.includes('card_number') && !texto.includes('4111'));
      // La lista de campos es cerrada y previsible.
      assert.deepEqual(Object.keys(anotados[0]!).sort(), [
        'bookingId',
        'chargeId',
        'detail',
        'event',
        'level',
        'message',
        'outcome',
        'paymentId',
        'provider',
        'timestamp',
      ]);
    });

    it('47 · la respuesta HTTP no cambia: el código de auditoría no se publica', async () => {
      const reserva = await reservaPagadaPorHttp();
      setCulqiApi(culqiFalso({ charge: { amount: Math.round(reserva.total * 100) } }).api);

      const res = await webhook('chr_test_0001');

      assert.equal(res.status, 200);
      assert.equal(res.body.data.received, true);
      assert.equal(res.body.data.handled, true);
      assert.equal(res.body.data.action, 'ya estaba conciliado');
      assert.equal(res.body.data.outcome, undefined);
    });
  });

  /* ══════════════════════════════ reembolsos ════════════════════════════════ */

  describe('Reembolsos contra Culqi', () => {
    /** Deja una reserva pagada y devuelve el id del pago. */
    async function reservaPagada(): Promise<{ bookingId: number; paymentId: number; total: number }> {
      const { api } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();
      assert.equal((await pagar(reserva.id)).status, 200);
      const fila = await pago(reserva.id);
      return { bookingId: reserva.id, paymentId: fila!.id, total: reserva.total };
    }

    const crearRefund = (bookingId: number, paymentId: number, amount: number) =>
      post('/refunds', { booking_id: bookingId, payment_id: paymentId, amount }, ctx.sessions.admin.token);

    it('31 · procesar un reembolso llama a Culqi y guarda su identificador', async () => {
      const { bookingId, paymentId, total } = await reservaPagada();
      const doble = culqiFalso({ refundId: 'ref_test_abcdef' });
      setCulqiApi(doble.api);

      const creado = await crearRefund(bookingId, paymentId, total);
      assert.equal(creado.status, 201, JSON.stringify(creado.body));

      const res = await post(`/refunds/${creado.body.data.id}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token);

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(doble.devoluciones.length, 1);
      assert.equal(doble.devoluciones[0]!.chargeId, 'chr_test_0001');
      assert.equal(doble.devoluciones[0]!.amountCents, Math.round(total * 100));
      const fila = await queryOne<{ provider_refund_id: string; status: string }>(
        'SELECT provider_refund_id, status FROM refunds WHERE id = ?',
        [creado.body.data.id],
      );
      assert.equal(fila?.provider_refund_id, 'ref_test_abcdef');
      assert.equal(fila?.status, 'COMPLETED');
    });

    it('32 · procesar dos veces no devuelve el dinero dos veces', async () => {
      const { bookingId, paymentId, total } = await reservaPagada();
      const doble = culqiFalso({ refundId: 'ref_test_abcdef' });
      setCulqiApi(doble.api);
      const creado = await crearRefund(bookingId, paymentId, total);

      await post(`/refunds/${creado.body.data.id}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token);
      const segunda = await post(`/refunds/${creado.body.data.id}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token);

      assert.equal(segunda.status, 400, 'la regla existente ya impide reprocesar');
      assert.equal(doble.devoluciones.length, 1, 'Culqi solo debe ver una devolución');
    });

    it('33 · no se puede reembolsar más de lo cobrado', async () => {
      const { bookingId, paymentId, total } = await reservaPagada();
      const doble = culqiFalso();
      setCulqiApi(doble.api);

      const res = await crearRefund(bookingId, paymentId, total + 100);

      assert.equal(res.status, 400);
      assert.equal(doble.devoluciones.length, 0);
    });

    it('34 · si Culqi rechaza la devolución, el reembolso no se cierra', async () => {
      const { bookingId, paymentId, total } = await reservaPagada();
      const creado = await crearRefund(bookingId, paymentId, total);

      setCulqiApi({
        async createCharge() {
          throw new Error('no se usa');
        },
        async getCharge() {
          throw new Error('no se usa');
        },
        async createRefund() {
          return { ok: false, kind: 'PROVIDER', code: null, userMessage: 'Culqi no disponible', merchantMessage: 'x' };
        },
      });

      const res = await post(`/refunds/${creado.body.data.id}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token);

      assert.equal(res.status, 400);
      const fila = await queryOne<{ status: string }>('SELECT status FROM refunds WHERE id = ?', [creado.body.data.id]);
      assert.equal(fila?.status, 'PENDING', 'reintentable: no se movió nada');
    });

    it('35 · un pago que no pasó por la pasarela se reembolsa como siempre', async () => {
      const reserva = await reservar();
      await post(`/bookings/${reserva.id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);
      const fila = await pago(reserva.id);
      const doble = culqiFalso();
      setCulqiApi(doble.api);

      const creado = await crearRefund(reserva.id, fila!.id, reserva.total);
      const res = await post(`/refunds/${creado.body.data.id}/process`, { status: 'COMPLETED' }, ctx.sessions.admin.token);

      assert.equal(res.status, 200);
      assert.equal(doble.devoluciones.length, 0, 'el efectivo se devuelve por fuera de Culqi');
    });
  });

  /* ══════════════════════════════ el resto no cambia ════════════════════════ */

  describe('Lo que ya funcionaba sigue funcionando', () => {
    it('36 · el pago en efectivo no toca la pasarela', async () => {
      const doble = culqiFalso();
      setCulqiApi(doble.api);
      const reserva = await reservar();

      const res = await post(`/bookings/${reserva.id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);

      assert.equal(res.status, 200);
      assert.equal(await estadoReserva(reserva.id), 'CONFIRMED');
      assert.equal(doble.cargos.length, 0);
    });

    it('37 · un cobro rechazado deja el asiento disponible para otra persona', async () => {
      const { api } = culqiFalso({ fallo: { kind: 'DECLINED' } });
      setCulqiApi(api);
      const reserva = await reservar();
      await pagar(reserva.id);

      // La reserva sigue viva con su retención: el asiento no se libera por un pago fallido,
      // y eso es lo correcto. Se libera cuando la retención vence, por el camino de siempre.
      assert.equal(await estadoReserva(reserva.id), 'PENDING');
      const asientos = await query('SELECT id FROM booking_seats WHERE booking_id = ?', [reserva.id]);
      assert.equal(asientos.length, 1);
    });

    it('38 · tras un cobro aceptado no hay asientos duplicados', async () => {
      const { api } = culqiFalso();
      setCulqiApi(api);
      const reserva = await reservar();
      await pagar(reserva.id);

      const duplicados = await query(
        `SELECT bs.trip_id, bs.seat_id, COUNT(*) activas
         FROM booking_seats bs JOIN bookings bk ON bk.id = bs.booking_id
         WHERE bk.status IN ('CONFIRMED','COMPLETED')
            OR (bk.status = 'PENDING' AND (bk.expires_at IS NULL OR bk.expires_at > NOW()))
         GROUP BY bs.trip_id, bs.seat_id HAVING activas > 1`,
      );
      assert.deepEqual(duplicados, []);
    });
  });
});
