import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { api, post, put } from './helpers/api';
import { env } from '../config/env';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { expireDueBookings } from '../services/booking-expiry.service';
import { setCulqiApi, type CulqiApi, type CulqiCharge, type CulqiResult } from '../services/culqi.service';
import { ensureSystemTemplates } from '../services/notification.service';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * F17C-SEC-06 · expiración de reservas: aislamiento de fallos, pagos tardíos y manipulación.
 *
 * QUÉ CUBRE Y QUÉ NO. Las suites `09-notification-expiry` y `27-expiry-scope` ya defienden lo
 * básico —expirar, liberar asientos, idempotencia, concurrencia, alcance por empresa, no tocar
 * CONFIRMED ni CANCELLED—. Aquí van solo los huecos que encontró la auditoría SEC-06:
 *
 *   · El BUCLE no aislaba los fallos. Una reserva que lanzara abortaba el barrido entero, y
 *     como las candidatas se ordenan por `expires_at ASC` la que falla es siempre la primera:
 *     bloqueaba la expiración de todas las demás indefinidamente. Comprobado y corregido.
 *   · Qué pasa con un cobro que llega DESPUÉS de expirar, por webhook y por el endpoint.
 *   · Que el cliente no pueda provocar ni evitar la expiración desde el cuerpo de una petición.
 *
 * Ningún caso usa tarjeta real: Culqi se sustituye en proceso con `setCulqiApi`.
 */
describe('SEC-06 · expiración de reservas', () => {
  let ctx: SuiteContext;
  const SECRETO = 'secreto-suite-sec06-000000000000';
  let secretoOriginal = '';
  const cargos = new Map<string, { amount: number; metadata: Record<string, string> }>();

  before(async () => {
    ctx = await prepareSuite();
    await ensureSystemTemplates();
    secretoOriginal = env.culqi.webhookSecret;
    (env.culqi as { webhookSecret: string }).webhookSecret = SECRETO;
    setCulqiApi({
      async createCharge() {
        throw new Error('esta suite no cobra con tarjeta');
      },
      async getCharge(id): Promise<CulqiResult<CulqiCharge>> {
        const guion = cargos.get(id);
        if (!guion) return { ok: false, kind: 'INVALID', code: 'x', userMessage: 'no existe', merchantMessage: 'x' };
        return {
          ok: true,
          data: { id, amount: guion.amount, currency_code: 'PEN', outcome: { type: 'venta_exitosa' }, metadata: guion.metadata } as unknown as CulqiCharge,
        };
      },
      async createRefund() {
        return { ok: true, data: { id: 'ref_sec06' } } as never;
      },
    } as CulqiApi);
  });

  after(async () => {
    setCulqiApi(null);
    (env.culqi as { webhookSecret: string }).webhookSecret = secretoOriginal;
    await teardownSuite();
  });

  beforeEach(async () => {
    cargos.clear();
    for (const tabla of ['settlement_items', 'financial_transactions', 'refunds', 'payments', 'booking_seats', 'notifications', 'bookings']) {
      await execute(`DELETE FROM ${tabla}`);
    }
    await execute("UPDATE trips t JOIN buses b ON b.id = t.bus_id SET t.available_seats = b.capacity, t.status = 'SCHEDULED'");
  });

  const reservar = async (tripId = ctx.fixtures.tripA): Promise<number> => {
    const libres = await freeSeats(tripId);
    const r = await post(
      '/bookings',
      { trip_id: tripId, seat_ids: [at(libres, 0).id], passenger_email: 'cliente@test.pe' },
      ctx.sessions.customer.token,
    );
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return Number(r.body.data.id);
  };

  const vencer = (id: number) => execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [id]);
  const estado = (id: number) =>
    queryOne<{ status: string; expires_at: string | null; subtotal: string; discount_amount: string; service_fee: string; total_amount: string }>(
      'SELECT status, expires_at, subtotal, discount_amount, service_fee, total_amount FROM bookings WHERE id = ?', [id],
    );
  const cupos = async (tripId: number) => Number((await queryOne<{ n: number }>('SELECT available_seats AS n FROM trips WHERE id = ?', [tripId]))?.n ?? 0);

  /* ================================================== aislamiento de fallos */
  describe('un fallo aislado no frena el barrido', () => {
    /**
     * EL CASO DE LA AUDITORÍA. Se rompe la PRIMERA candidata —la más antigua, la que el
     * `ORDER BY expires_at ASC` pone al frente— y se comprueba que las otras dos, sanas,
     * se expiran igualmente. Antes del arreglo el barrido terminaba con CERO expiradas.
     */
    it('la reserva rota se salta y las sanas se expiran igual', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 3; i += 1) ids.push(await reservar());
      await execute(`UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id IN (${ids.join(',')})`);

      // Se deja la primera apuntando a un usuario que no existe: la notificación de su
      // transacción falla. Hay que desactivar la comprobación de claves para poder crear
      // ese estado inconsistente, que es justo lo que el barrido debe saber encajar.
      await execute('SET FOREIGN_KEY_CHECKS = 0');
      await execute('UPDATE bookings SET user_id = 999999 WHERE id = ?', [ids[0]]);
      await execute('SET FOREIGN_KEY_CHECKS = 1');

      const resultado = await expireDueBookings();

      const estados = await query<{ id: number; status: string }>(
        `SELECT id, status FROM bookings WHERE id IN (${ids.join(',')}) ORDER BY id`,
      );
      assert.equal(resultado.failed, 1, 'debe contar una reserva fallida');
      assert.equal(resultado.expired, 2, 'las otras dos deben expirar');
      assert.equal(estados[0]?.status, 'PENDING', 'la rota se queda como estaba');
      assert.equal(estados[1]?.status, 'EXPIRED');
      assert.equal(estados[2]?.status, 'EXPIRED');

      await execute('SET FOREIGN_KEY_CHECKS = 0');
      await execute('UPDATE bookings SET user_id = ? WHERE id = ?', [ctx.fixtures.users.customer, ids[0]]);
      await execute('SET FOREIGN_KEY_CHECKS = 1');
    });

    it('un barrido sin incidencias informa de cero fallidas', async () => {
      const id = await reservar();
      await vencer(id);
      const resultado = await expireDueBookings();
      assert.equal(resultado.expired, 1);
      assert.equal(resultado.failed, 0);
    });
  });

  /* ================================================== COMPLETED intacta */
  it('una reserva COMPLETED con el plazo vencido no se toca', async () => {
    const id = await reservar();
    await execute("UPDATE bookings SET status = 'COMPLETED', expires_at = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id = ?", [id]);
    const cuposAntes = await cupos(ctx.fixtures.tripA);

    const resultado = await expireDueBookings();

    assert.equal(resultado.expired, 0);
    assert.equal((await estado(id))?.status, 'COMPLETED');
    assert.equal(await cupos(ctx.fixtures.tripA), cuposAntes, 'no puede liberar cupos de una reserva completada');
  });

  /* ================================================== precio congelado y finanzas */
  it('expirar no recalcula importes ni genera movimientos financieros', async () => {
    const id = await reservar();
    const antes = await estado(id);
    await vencer(id);
    await expireDueBookings();
    const despues = await estado(id);

    assert.equal(despues?.status, 'EXPIRED');
    assert.equal(despues?.subtotal, antes?.subtotal);
    assert.equal(despues?.discount_amount, antes?.discount_amount);
    assert.equal(despues?.service_fee, antes?.service_fee);
    assert.equal(despues?.total_amount, antes?.total_amount);

    for (const tabla of ['financial_transactions', 'refunds', 'settlement_items']) {
      const fila = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tabla} WHERE booking_id = ?`, [id]);
      assert.equal(Number(fila?.n), 0, `una reserva que nunca se pagó no puede dejar filas en ${tabla}`);
    }
  });

  /* ================================================== pagos tardíos */
  describe('un cobro que llega después de expirar', () => {
    it('por el endpoint de pago: se rechaza y no cambia nada', async () => {
      const id = await reservar();
      await vencer(id);
      await expireDueBookings();
      const cuposAntes = await cupos(ctx.fixtures.tripA);

      const pago = await post(`/bookings/${id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);

      assert.ok(pago.status >= 400, `esperaba un rechazo y llegó ${pago.status}`);
      assert.match(String(pago.body.message), /ya no est[áa] vigente/i);
      assert.equal((await estado(id))?.status, 'EXPIRED');
      assert.equal(await cupos(ctx.fixtures.tripA), cuposAntes, 'no puede volver a tomar el asiento');
      const mov = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM financial_transactions WHERE booking_id = ?', [id]);
      assert.equal(Number(mov?.n), 0);
    });

    /**
     * POR WEBHOOK, la política del proyecto es distinta y deliberada: el dinero YA se cobró en
     * Culqi, así que no se puede fingir que no existe. El cargo se registra y se abre un
     * reembolso compensatorio; la reserva NO se reconfirma y el asiento no se vuelve a tomar.
     */
    it('por webhook: no reconfirma, registra el cobro y abre un reembolso compensatorio', async () => {
      const id = await reservar();
      const total = Number((await estado(id))!.total_amount);
      const { insertId: pagoId } = await execute(
        `INSERT INTO payments (booking_id, transaction_code, amount, currency, method, status, provider, payment_data)
         VALUES (?, ?, ?, 'PEN', 'CARD', 'PROCESSING', 'CULQI', ?)`,
        [id, `TRX-SEC06-${id}`, total, JSON.stringify({ token: 'tkn_sec06' })],
      );
      cargos.set('chr_tardio', { amount: Math.round(total * 100), metadata: { payment_id: String(pagoId), booking_id: String(id) } });

      await vencer(id);
      await expireDueBookings();
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM payments WHERE id = ?', [pagoId]))?.status, 'CANCELLED',
        'al expirar, el intento en vuelo se cancela');
      const cuposTrasExpirar = await cupos(ctx.fixtures.tripA);

      const wh = await api(`/culqi/webhook/${SECRETO}`, {
        method: 'POST', body: { type: 'charge.succeeded', data: { id: 'chr_tardio', object: 'charge' } },
      });

      assert.equal(wh.status, 200, 'el webhook responde de forma controlada');
      assert.equal((await estado(id))?.status, 'EXPIRED', 'la reserva NO se reconfirma');
      assert.equal(await cupos(ctx.fixtures.tripA), cuposTrasExpirar, 'el asiento no se vuelve a tomar');

      const reembolsos = await query<{ amount: string; status: string }>('SELECT amount, status FROM refunds WHERE payment_id = ?', [pagoId]);
      assert.equal(reembolsos.length, 1, 'debe abrirse exactamente un reembolso compensatorio');
      assert.equal(Number(reembolsos[0]?.amount), total, 'por el importe completo del cargo');
      assert.equal(reembolsos[0]?.status, 'PENDING');

      // El cobro queda registrado contra la plataforma, no abonado a la empresa.
      const mov = await query<{ type: string; company_id: number | null }>(
        'SELECT type, company_id FROM financial_transactions WHERE payment_id = ?', [pagoId],
      );
      assert.ok(!mov.some((m) => m.type === 'COMMISSION'), 'no puede generarse comisión por una venta que no se completó');
    });
  });

  /* ================================================== concurrencia */
  describe('concurrencia', () => {
    it('pagar y expirar a la vez deja un único desenlace coherente', async () => {
      const id = await reservar();
      await vencer(id);

      await Promise.all([
        post(`/bookings/${id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token),
        expireDueBookings(),
      ]);

      const tras = await estado(id);
      const mov = Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM financial_transactions WHERE booking_id = ?', [id]))?.n ?? 0);

      // Cualquiera de los dos puede ganar; lo que no vale es un estado a medias.
      if (tras?.status === 'CONFIRMED') {
        assert.equal(mov, 3, 'una venta confirmada escribe sus tres movimientos');
      } else {
        assert.equal(tras?.status, 'EXPIRED');
        assert.equal(mov, 0, 'una reserva expirada no puede dejar movimientos');
      }
    });

    it('cancelar y expirar a la vez no libera el asiento dos veces', async () => {
      const id = await reservar();
      await vencer(id);
      const cuposAntes = await cupos(ctx.fixtures.tripA);

      await Promise.all([
        post(`/bookings/${id}/cancel`, { reason: 'sec06' }, ctx.sessions.admin.token),
        expireDueBookings(),
      ]);

      const tras = await estado(id);
      assert.ok(['CANCELLED', 'EXPIRED'].includes(String(tras?.status)), `estado final inesperado: ${tras?.status}`);
      assert.equal(await cupos(ctx.fixtures.tripA), cuposAntes + 1, 'el cupo se devuelve UNA sola vez');
    });

    it('dos barridos simultáneos expiran cada reserva una sola vez', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 3; i += 1) ids.push(await reservar());
      await execute(`UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id IN (${ids.join(',')})`);
      const cuposAntes = await cupos(ctx.fixtures.tripA);

      const [a, b] = await Promise.all([expireDueBookings(), expireDueBookings()]);

      assert.equal(a.expired + b.expired, 3, `entre los dos deben expirar 3 (${a.expired}+${b.expired})`);
      assert.equal(await cupos(ctx.fixtures.tripA), cuposAntes + 3, 'ni un cupo de más');
      const avisos = await queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM notifications WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.event_key')) IN (${ids.map((i) => `'booking.expired:${i}'`).join(',')})`,
      );
      assert.equal(Number(avisos?.n), 3, 'un aviso por reserva, sin duplicar');
    });
  });

  /* ================================================== manipulación desde el cliente */
  describe('el cliente no controla la expiración', () => {
    for (const [etiqueta, cuerpo] of [
      ['marcarla EXPIRED', { status: 'EXPIRED' }],
      ['adelantar expires_at', { expires_at: '2020-01-01 00:00:00' }],
      ['confirmarla y poner el total a cero', { status: 'CONFIRMED', total_amount: 0 }],
      ['moverla de viaje y de empresa', { trip_id: 2, company_id: 2 }],
    ] as const) {
      it(`un CUSTOMER no puede ${etiqueta}`, async () => {
        const id = await reservar();
        const antes = await estado(id);

        const r = await put(`/bookings/${id}`, cuerpo, ctx.sessions.customer.token);

        const despues = await estado(id);
        assert.ok(r.status >= 400, `esperaba rechazo y llegó ${r.status}`);
        assert.equal(despues?.status, antes?.status);
        assert.equal(despues?.expires_at, antes?.expires_at, 'el plazo no puede cambiarlo el cliente');
        assert.equal(despues?.total_amount, antes?.total_amount);
      });
    }

    it('el barrido manual de una empresa no alcanza reservas de otra', async () => {
      const ajena = await reservar(ctx.fixtures.tripB);
      await vencer(ajena);

      const r = await post('/bookings/expire', {}, ctx.sessions.companyAdmin.token);

      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await estado(ajena))?.status, 'PENDING', 'la reserva de la empresa B sigue intacta');
    });
  });

  /* ================================================== el plazo sale de la base */
  it('la expiración se decide por expires_at, no por la memoria del proceso', async () => {
    const id = await reservar();
    const fila = await estado(id);
    assert.ok(fila?.expires_at, 'la reserva debe nacer con su plazo persistido');

    // Se simula un reinicio: nadie programó un temporizador para esta reserva, y aun así
    // el primer barrido posterior la caduca porque el plazo vive en la base.
    await vencer(id);
    const resultado = await expireDueBookings();

    assert.equal(resultado.expired, 1);
    assert.equal((await estado(id))?.status, 'EXPIRED');
  });
});
