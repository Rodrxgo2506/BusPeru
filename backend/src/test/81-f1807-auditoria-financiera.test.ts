import './helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execute, query, queryOne } from '../config/database';
import { env } from '../config/env';
import { setCulqiApi, type CulqiApi, type CulqiCharge, type CulqiResult } from '../services/culqi.service';
import { advanceTripLifecycle } from '../services/trip.service';
import { api, post } from './helpers/api';
import { at, freeSeats } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * F18-07 · rastro en `audit_logs` de los sucesos financieros y del ciclo de vida que no tenían
 * persona detrás: la conciliación por webhook de Culqi (confirmar, rechazar, marcar fallido), el
 * reembolso compensatorio y las transiciones automáticas de viajes y reservas.
 *
 * Todas usan `recordSystemAudit`: `user_id` NULL (nadie), el actor del sistema en
 * `new_values.actor` y la fila escrita DENTRO de la transacción del cambio. Aquí se comprueba que
 * cada suceso deja exactamente una fila, que repetirlo no duplica, que si la auditoría falla el
 * cambio tampoco se aplica, y que nunca se guarda nada del medio de pago.
 *
 * Nada sale a la red: Culqi es el doble en proceso de `setCulqiApi` (el de 31/70).
 */
describe('F18-07 · auditoría de sucesos financieros y del ciclo de vida', () => {
  let ctx: SuiteContext;
  const SECRETO = 'secreto-de-suite-f1807-auditoria-000000';
  let secretoOriginal = '';
  const cargos = new Map<string, { amount: number; outcome?: string; metadata?: Record<string, string> }>();

  before(async () => {
    ctx = await prepareSuite();
    secretoOriginal = env.culqi.webhookSecret;
    (env.culqi as { webhookSecret: string }).webhookSecret = SECRETO;
    const doble: CulqiApi = {
      async createCharge() { throw new Error('esta suite no cobra'); },
      async getCharge(id): Promise<CulqiResult<CulqiCharge>> {
        const g = cargos.get(id);
        if (!g) return { ok: false, kind: 'INVALID', code: 'charge_not_found', userMessage: 'No existe', merchantMessage: 'not found' };
        return {
          ok: true,
          data: { id, amount: g.amount, currency_code: 'PEN', outcome: { type: g.outcome ?? 'venta_exitosa', user_message: 'ok' }, ...(g.metadata ? { metadata: g.metadata } : {}) } as unknown as CulqiCharge,
        };
      },
      async createRefund() { return { ok: true, data: { id: 'ref_f1807' } } as CulqiResult<never> as never; },
    };
    setCulqiApi(doble);
  });

  after(async () => {
    setCulqiApi(null);
    (env.culqi as { webhookSecret: string }).webhookSecret = secretoOriginal;
    await execute('DROP TRIGGER IF EXISTS f1807_falla_auditoria').catch(() => undefined);
    await teardownSuite();
  });

  beforeEach(async () => {
    cargos.clear();
    await execute('DROP TRIGGER IF EXISTS f1807_falla_auditoria');
    for (const t of ['settlement_items', 'financial_transactions', 'refunds', 'booking_seats', 'payments', 'notifications', 'bookings', 'audit_logs']) {
      await execute(`DELETE FROM ${t}`);
    }
    await execute("UPDATE trips t JOIN buses b ON b.id = t.bus_id SET t.available_seats = b.capacity, t.status = 'SCHEDULED'");
    await execute('UPDATE trips SET departure_datetime = NOW() + INTERVAL 2 DAY, arrival_datetime = NOW() + INTERVAL 2 DAY + INTERVAL 5 HOUR WHERE id = ?', [ctx.fixtures.tripA]);
  });

  /** Reserva con un pago de tarjeta en PROCESSING y el cargo que Culqi dirá que existe. */
  async function reservaConCargo(chargeId: string, opciones: { centimos?: number; outcome?: string; bookingId?: number } = {}) {
    let bookingId = opciones.bookingId;
    let total: number;
    if (bookingId === undefined) {
      const asientos = await freeSeats(ctx.fixtures.tripA);
      const r = await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [at(asientos, 0).id], passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      bookingId = Number(r.body.data.id);
      total = Number(r.body.data.total_amount);
    } else {
      total = Number((await queryOne<{ total_amount: string }>('SELECT total_amount FROM bookings WHERE id = ?', [bookingId]))!.total_amount);
    }
    const { insertId: paymentId } = await execute(
      `INSERT INTO payments (booking_id, transaction_code, amount, currency, method, status, provider, payment_data)
       VALUES (?, ?, ?, 'PEN', 'CARD', 'PROCESSING', 'CULQI', ?)`,
      [bookingId, `TRX-F1807-${chargeId}`, total, JSON.stringify({ token: 'tkn_f1807_no_debe_auditarse' })],
    );
    cargos.set(chargeId, { amount: opciones.centimos ?? Math.round(total * 100), outcome: opciones.outcome, metadata: { payment_id: String(paymentId), booking_id: String(bookingId) } });
    return { bookingId: bookingId!, paymentId };
  }
  const webhook = (chargeId: string) => api(`/culqi/webhook/${SECRETO}`, { method: 'POST', body: { type: 'charge.succeeded', data: { id: chargeId, object: 'charge' } } });

  interface Fila { user_id: number | null; action: string; entity_type: string; entity_id: number; description: string; old_values: string | null; new_values: string | null }
  const auditoria = (accion?: string) =>
    query<Fila>(`SELECT user_id, action, entity_type, entity_id, description, old_values, new_values FROM audit_logs ${accion ? 'WHERE action = ?' : ''} ORDER BY id`, accion ? [accion] : []);
  const nv = (f: Fila) => JSON.parse(f.new_values ?? '{}') as Record<string, unknown>;
  const PROHIBIDO = /tkn_|card_number|cvv|webhook_secret|private_key|sk_(test|live)|authorization/i;

  /* ------------------------------------------------------------------ webhook */
  describe('conciliación por webhook', () => {
    it('confirmar: una fila CONFIRM, de sistema, con identificadores públicos y nada del medio de pago', async () => {
      const { bookingId, paymentId } = await reservaConCargo('chr_f1807_ok');
      assert.equal((await webhook('chr_f1807_ok')).status, 200);
      const filas = await auditoria('CONFIRM');
      assert.equal(filas.length, 1);
      const f = filas[0]!;
      assert.equal(f.user_id, null, 'no se atribuye a ninguna persona');
      assert.equal(f.entity_type, 'bookings'); assert.equal(Number(f.entity_id), bookingId);
      assert.equal(nv(f).actor, 'system:culqi-webhook');
      assert.equal(nv(f).status, 'CONFIRMED'); assert.equal(nv(f).payment_id, paymentId); assert.equal(nv(f).charge_id, 'chr_f1807_ok');
      assert.equal(JSON.parse(f.old_values!).status, 'PENDING');
      assert.doesNotMatch(JSON.stringify(filas), PROHIBIDO);
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [bookingId]))?.status, 'CONFIRMED');
    });

    it('un webhook repetido no duplica la fila (idempotente)', async () => {
      await reservaConCargo('chr_f1807_rep');
      await webhook('chr_f1807_rep');
      await webhook('chr_f1807_rep');
      await webhook('chr_f1807_rep');
      assert.equal((await auditoria('CONFIRM')).length, 1);
      assert.equal((await auditoria()).filter((f) => nv(f).actor === 'system:culqi-webhook').length, 1);
    });

    it('importe distinto: no cambia nada y deja una fila REJECT', async () => {
      const { bookingId, paymentId } = await reservaConCargo('chr_f1807_mal', { centimos: 1 });
      assert.equal((await webhook('chr_f1807_mal')).status, 200);
      const filas = await auditoria('REJECT');
      assert.equal(filas.length, 1);
      assert.equal(nv(filas[0]!).outcome, 'amount_mismatch'); assert.equal(Number(filas[0]!.entity_id), paymentId);
      assert.equal((await auditoria('CONFIRM')).length, 0);
      assert.notEqual((await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [bookingId]))?.status, 'CONFIRMED');
    });

    it('cargo no exitoso: el pago pasa a FAILED y queda una fila FAIL con su estado previo', async () => {
      const { paymentId } = await reservaConCargo('chr_f1807_ko', { outcome: 'venta_fallida' });
      await webhook('chr_f1807_ko');
      const filas = await auditoria('FAIL');
      assert.equal(filas.length, 1);
      assert.equal(JSON.parse(filas[0]!.old_values!).status, 'PROCESSING');
      assert.equal(nv(filas[0]!).status, 'FAILED');
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM payments WHERE id = ?', [paymentId]))?.status, 'FAILED');
      await webhook('chr_f1807_ko');
      assert.equal((await auditoria('FAIL')).length, 1, 'repetido no vuelve a marcar ni a auditar');
    });

    it('reembolso compensatorio: segundo cargo sobre una reserva ya pagada → COMPENSATE con su reembolso', async () => {
      const { bookingId } = await reservaConCargo('chr_f1807_uno');
      await webhook('chr_f1807_uno');
      const { paymentId: segundo } = await reservaConCargo('chr_f1807_dos', { bookingId });
      assert.equal((await webhook('chr_f1807_dos')).status, 200);
      const filas = await auditoria('COMPENSATE');
      assert.equal(filas.length, 1);
      const f = filas[0]!;
      assert.equal(Number(f.entity_id), segundo); assert.equal(f.user_id, null);
      const reembolso = await queryOne<{ id: number; status: string }>('SELECT id, status FROM refunds WHERE payment_id = ?', [segundo]);
      assert.ok(reembolso, 'hay reembolso abierto');
      assert.equal(nv(f).refund_id, reembolso!.id); assert.equal(nv(f).refund_status, 'PENDING'); assert.equal(nv(f).actor, 'system:payments');
      assert.doesNotMatch(JSON.stringify(filas), PROHIBIDO);
      await webhook('chr_f1807_dos');
      assert.equal((await auditoria('COMPENSATE')).length, 1, 'repetido no abre ni audita otro');
    });
  });

  /* ------------------------------------------------------------------ ciclo de vida */
  describe('ciclo de vida automático de viajes', () => {
    const viajeVencido = () =>
      execute('UPDATE trips SET departure_datetime = NOW() - INTERVAL 3 HOUR, arrival_datetime = NOW() - INTERVAL 1 HOUR WHERE id = ?', [ctx.fixtures.tripA]);

    it('salida y llegada vencidas: START y COMPLETE del viaje y COMPLETE de su reserva confirmada, una vez', async () => {
      const { bookingId } = await reservaConCargo('chr_f1807_vida');
      await webhook('chr_f1807_vida');
      await viajeVencido();
      await advanceTripLifecycle();
      const deViaje = (await auditoria()).filter((f) => f.entity_type === 'trips' && Number(f.entity_id) === ctx.fixtures.tripA);
      assert.deepEqual(deViaje.map((f) => f.action), ['START', 'COMPLETE']);
      assert.ok(deViaje.every((f) => f.user_id === null && nv(f).actor === 'system:trip-lifecycle'));
      assert.equal(JSON.parse(deViaje[0]!.old_values!).status, 'SCHEDULED');
      const deReserva = (await auditoria('COMPLETE')).filter((f) => f.entity_type === 'bookings');
      assert.equal(deReserva.length, 1); assert.equal(Number(deReserva[0]!.entity_id), bookingId);
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [bookingId]))?.status, 'COMPLETED');

      const antes = (await auditoria()).length;
      const segunda = await advanceTripLifecycle();
      assert.equal((await auditoria()).length, antes, 'una segunda pasada no escribe nada');
      assert.equal(segunda.bookingsCompleted, 0);
    });

    it('dos pasadas concurrentes no duplican transiciones ni registros', async () => {
      await viajeVencido();
      await Promise.all([advanceTripLifecycle(), advanceTripLifecycle()]);
      const deViaje = (await auditoria()).filter((f) => f.entity_type === 'trips' && Number(f.entity_id) === ctx.fixtures.tripA);
      assert.deepEqual(deViaje.map((f) => f.action), ['START', 'COMPLETE']);
    });

    it('atomicidad en los dos sentidos: ni transición sin rastro, ni rastro de una transición deshecha', async () => {
      await viajeVencido();
      // Falla la auditoría del SEGUNDO paso (COMPLETE). El primero (START) ya escribió su cambio y
      // su fila: si esa fila se hubiera escrito fuera de la transacción, sobreviviría al rollback.
      await execute(
        `CREATE TRIGGER f1807_falla_auditoria BEFORE INSERT ON audit_logs FOR EACH ROW
         BEGIN IF NEW.action = 'COMPLETE' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fallo simulado de auditoria'; END IF; END`,
      );
      await assert.rejects(() => advanceTripLifecycle(), /fallo simulado/);
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM trips WHERE id = ?', [ctx.fixtures.tripA]))?.status, 'SCHEDULED', 'el viaje sigue como estaba');
      assert.equal((await auditoria()).filter((f) => f.entity_type === 'trips').length, 0, 'no queda ninguna fila huérfana de START');
      await execute('DROP TRIGGER f1807_falla_auditoria');
      await advanceTripLifecycle();
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM trips WHERE id = ?', [ctx.fixtures.tripA]))?.status, 'COMPLETED', 'sin el fallo, avanza');
    });
  });
});
