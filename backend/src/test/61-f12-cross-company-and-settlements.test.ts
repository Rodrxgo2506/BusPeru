import './helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { get, post, put } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { SETTLEMENT_TRANSITIONS } from '../routes/finance.routes';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * FASE 12A · cierre de los tres P1 de la auditoría final.
 *
 *   F12-01 · `PUT /coupons/:id` y `PUT /route-stops/:id` movían el registro al padre de otra
 *            empresa: respondían 404 pero el UPDATE ya se había ejecutado.
 *   F12-02 · dos `POST /settlements` simultáneos creaban dos liquidaciones con los mismos
 *            movimientos (5/5 en la sonda).
 *   F12-03 · sin máquina de estados: PAID → PENDING → PAID … generaba varios PAYOUT, y el alta
 *            aceptaba `status: PAID`.
 * Todo sobre `busperu_test`.
 */
describe('12A · aislamiento por padre y liquidaciones', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  const hoy = async () => (await queryOne<{ d: string }>("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS d"))!.d;

  // =====================================================================
  describe('F12-01 · un hijo no cambia de empresa por su padre', () => {
    let promoA = 0;
    let promoA2 = 0;
    let promoB = 0;
    let promoPlataforma = 0;

    before(async () => {
      const promo = async (company_id: number, name: string) => {
        const res = await post('/promotions', { company_id, name, discount_type: 'PERCENTAGE', discount_value: 10, start_at: '2020-01-01 00:00:00', end_at: '2035-01-01 00:00:00', status: 'ACTIVE' }, ctx.sessions.admin.token);
        assert.equal(res.status, 201, JSON.stringify(res.body));
        return Number(res.body.data.id);
      };
      promoA = await promo(ctx.fixtures.companyA, 'A1');
      promoA2 = await promo(ctx.fixtures.companyA, 'A2');
      promoB = await promo(ctx.fixtures.companyB, 'B1');
      promoPlataforma = await promo(ctx.fixtures.companyA, 'Plataforma');
      await execute('UPDATE promotions SET company_id = NULL WHERE id = ?', [promoPlataforma]);
    });

    const cuponDeA = async (code: string) => {
      const res = await post('/coupons', { promotion_id: promoA, code, status: 'ACTIVE' }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return Number(res.body.data.id);
    };
    let orden = 0;
    const paradaDeA = async () => {
      orden += 10;
      const res = await post('/route-stops', { route_id: ctx.fixtures.routeA, location_id: at(ctx.fixtures.locations, 2), stop_order: orden }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return Number(res.body.data.id);
    };
    const filaCupon = (id: number) => queryOne<{ promotion_id: number; code: string; usage_limit: number | null }>('SELECT promotion_id, code, usage_limit FROM coupons WHERE id = ?', [id]);

    it('A · cupón de A hacia una promoción de B: 404 y el cupón sigue en su promoción', async () => {
      const id = await cuponDeA('F12A-A');
      const res = await put(`/coupons/${id}`, { promotion_id: promoB, usage_limit: 99 }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 404, JSON.stringify(res.body));
      const fila = await filaCupon(id);
      assert.deepEqual([Number(fila?.promotion_id), fila?.usage_limit], [promoA, null], 'ni el padre ni los demás campos cambian');
      assert.equal((await query('SELECT id FROM coupons WHERE promotion_id = ?', [promoB])).length, 0, 'la promoción de B no recibe el cupón');
      assert.equal((await get(`/coupons?promotion_id=${promoB}`, ctx.sessions.companyAdminB.token)).body.data.length, 0);
    });

    it('A2 · tampoco hacia una promoción de plataforma (otra «empresa»)', async () => {
      const id = await cuponDeA('F12A-A2');
      assert.equal((await put(`/coupons/${id}`, { promotion_id: promoPlataforma }, ctx.sessions.companyAdmin.token)).status, 404);
      assert.equal(Number((await filaCupon(id))?.promotion_id), promoA);
    });

    it('B · parada de la ruta de A hacia la ruta de B: 404 y conserva su ruta', async () => {
      const id = await paradaDeA();
      const res = await put(`/route-stops/${id}`, { route_id: ctx.fixtures.routeB, stop_order: 7 }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 404, JSON.stringify(res.body));
      const fila = await queryOne<{ route_id: number; stop_order: number }>('SELECT route_id, stop_order FROM route_stops WHERE id = ?', [id]);
      assert.deepEqual([Number(fila?.route_id), Number(fila?.stop_order)], [ctx.fixtures.routeA, orden]);
      assert.equal((await get(`/route-stops?route_id=${ctx.fixtures.routeB}`, ctx.sessions.companyAdminB.token)).body.data.length, 0);
    });

    it('C · padre inexistente: 404 sin modificación parcial', async () => {
      const cupon = await cuponDeA('F12A-C');
      assert.equal((await put(`/coupons/${cupon}`, { promotion_id: 999999, code: 'CAMBIADO' }, ctx.sessions.companyAdmin.token)).status, 404);
      assert.deepEqual([Number((await filaCupon(cupon))?.promotion_id), (await filaCupon(cupon))?.code], [promoA, 'F12A-C']);
      const parada = await paradaDeA();
      assert.equal((await put(`/route-stops/${parada}`, { route_id: 999999, stop_order: 5 }, ctx.sessions.companyAdmin.token)).status, 404);
      assert.equal(Number((await queryOne<{ stop_order: number }>('SELECT stop_order FROM route_stops WHERE id = ?', [parada]))?.stop_order), orden);
    });

    it('D · cambio de padre dentro de la misma empresa: 200 y aplicado', async () => {
      const cupon = await cuponDeA('F12A-D');
      const res = await put(`/coupons/${cupon}`, { promotion_id: promoA2, usage_limit: 5 }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual([Number((await filaCupon(cupon))?.promotion_id), Number((await filaCupon(cupon))?.usage_limit)], [promoA2, 5]);

      const routeA2 = (await execute("INSERT INTO routes (company_id, origin_location_id, destination_location_id, status) SELECT company_id, destination_location_id, origin_location_id, 'ACTIVE' FROM routes WHERE id = ?", [ctx.fixtures.routeA])).insertId;
      const parada = await paradaDeA();
      assert.equal((await put(`/route-stops/${parada}`, { route_id: routeA2 }, ctx.sessions.companyAdmin.token)).status, 200);
      assert.equal(Number((await queryOne<{ route_id: number }>('SELECT route_id FROM route_stops WHERE id = ?', [parada]))?.route_id), routeA2);
      // Reenviar el mismo padre (formulario completo) no es un cambio.
      assert.equal((await put(`/route-stops/${parada}`, { route_id: routeA2, stop_order: 2 }, ctx.sessions.companyAdmin.token)).status, 200);
    });

    it('D2 · el ADMIN tampoco mueve un hijo a otra empresa por esta vía', async () => {
      const cupon = await cuponDeA('F12A-D2');
      assert.equal((await put(`/coupons/${cupon}`, { promotion_id: promoB }, ctx.sessions.admin.token)).status, 404);
      assert.equal(Number((await filaCupon(cupon))?.promotion_id), promoA);
    });
  });

  // =====================================================================
  describe('F12-02 · generación de liquidaciones atómica e idempotente', () => {
    beforeEach(async () => {
      for (const tabla of ['settlement_items', 'settlements', 'financial_transactions', 'refunds', 'coupon_usages', 'booking_seats', 'payments', 'notifications', 'bookings', 'booking_groups']) {
        await execute(`DELETE FROM ${tabla}`);
      }
      await execute("UPDATE trips t JOIN buses b ON b.id = t.bus_id SET t.available_seats = b.capacity, t.status = 'SCHEDULED'");
    });

    async function ventas(tripId: number, n: number) {
      for (let i = 0; i < n; i += 1) {
        const res = await post('/bookings', { trip_id: tripId, seat_ids: [at(await freeSeats(tripId), 0).id], passenger_email: 'c@test.pe' }, ctx.sessions.customer.token);
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal((await post(`/bookings/${res.body.data.id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token)).status, 200);
      }
    }
    const repetidos = () =>
      query('SELECT financial_transaction_id FROM settlement_items WHERE financial_transaction_id IS NOT NULL GROUP BY financial_transaction_id HAVING COUNT(*) > 1');

    it('A · dos POST simultáneos (5 rondas): una sola liquidación, un solo conjunto de ítems', async () => {
      await ventas(ctx.fixtures.tripA, 3);
      const d = await hoy();
      const cuerpo = { company_id: ctx.fixtures.companyA, period_start: d, period_end: d };
      for (let ronda = 0; ronda < 5; ronda += 1) {
        await execute('DELETE FROM settlement_items');
        await execute('DELETE FROM settlements');
        const r = await Promise.all([post('/settlements', cuerpo, ctx.sessions.admin.token), post('/settlements', cuerpo, ctx.sessions.admin.token)]);
        assert.deepEqual(r.map((x) => x.status).sort(), [200, 201], `ronda ${ronda}: una crea y la otra recibe la misma`);
        assert.equal(Number(r[0]!.body.data.id), Number(r[1]!.body.data.id), 'las dos respuestas son la misma liquidación');
        const liquidaciones = await query<{ id: number; n: number }>('SELECT s.id, (SELECT COUNT(*) FROM settlement_items si WHERE si.settlement_id = s.id) AS n FROM settlements s');
        assert.equal(liquidaciones.length, 1, `ronda ${ronda}`);
        assert.equal(Number(liquidaciones[0]!.n), 6, 'venta + comisión de las tres ventas');
        assert.deepEqual(await repetidos(), []);
      }
    });

    it('B · reintento posterior: devuelve la misma liquidación y no duplica movimientos', async () => {
      await ventas(ctx.fixtures.tripA, 2);
      const d = await hoy();
      const cuerpo = { company_id: ctx.fixtures.companyA, period_start: d, period_end: d };
      const primera = await post('/settlements', cuerpo, ctx.sessions.admin.token);
      assert.equal(primera.status, 201);
      for (let i = 0; i < 3; i += 1) {
        const otra = await post('/settlements', cuerpo, ctx.sessions.admin.token);
        assert.equal(otra.status, 200);
        assert.equal(Number(otra.body.data.id), Number(primera.body.data.id));
      }
      assert.equal((await query('SELECT id FROM settlements')).length, 1);
      assert.deepEqual(await repetidos(), []);
      // Un periodo distinto que se solapa no toma lo ya liquidado.
      const solapado = await post('/settlements', { company_id: ctx.fixtures.companyA, period_start: '2020-01-01', period_end: d }, ctx.sessions.admin.token);
      assert.equal(solapado.status, 201);
      assert.equal(Number(solapado.body.data.items_count), 0);
      assert.deepEqual(await repetidos(), []);
    });

    it('A2 · periodos DISTINTOS solapados de la misma empresa a la vez (5 rondas): ambos 201, sin movimientos repetidos', async () => {
      await ventas(ctx.fixtures.tripA, 3);
      const d = await hoy();
      for (let ronda = 0; ronda < 5; ronda += 1) {
        await execute('DELETE FROM settlement_items');
        await execute('DELETE FROM settlements');
        const r = await Promise.all([
          post('/settlements', { company_id: ctx.fixtures.companyA, period_start: d, period_end: d }, ctx.sessions.admin.token),
          post('/settlements', { company_id: ctx.fixtures.companyA, period_start: '2020-01-01', period_end: d }, ctx.sessions.admin.token),
        ]);
        assert.deepEqual(r.map((x) => x.status), [201, 201], `ronda ${ronda}: ${JSON.stringify(r.map((x) => x.body))}`);
        assert.deepEqual(r.map((x) => Number(x.body.data.items_count)).sort(), [0, 6], 'una se lleva los movimientos y la otra queda vacía');
        assert.deepEqual(await repetidos(), []);
      }
    });

    it('C · dos empresas distintas liquidan a la vez, cada una lo suyo', async () => {
      await ventas(ctx.fixtures.tripA, 2);
      await ventas(ctx.fixtures.tripB, 2);
      const d = await hoy();
      const inicio = Date.now();
      const [a, b] = await Promise.all([
        post('/settlements', { company_id: ctx.fixtures.companyA, period_start: d, period_end: d }, ctx.sessions.admin.token),
        post('/settlements', { company_id: ctx.fixtures.companyB, period_start: d, period_end: d }, ctx.sessions.admin.token),
      ]);
      assert.deepEqual([a.status, b.status], [201, 201]);
      assert.ok(Date.now() - inicio < 10_000, 'no se bloquean esperando al otro');
      assert.deepEqual([Number(a.body.data.items_count), Number(b.body.data.items_count)], [4, 4]);
      const cruzados = await query(
        `SELECT si.id FROM settlement_items si JOIN settlements s ON s.id = si.settlement_id
         JOIN financial_transactions ft ON ft.id = si.financial_transaction_id WHERE ft.company_id <> s.company_id`,
      );
      assert.deepEqual(cruzados, []);
    });

    it('D · UNIQUE(financial_transaction_id): la base rechaza el mismo movimiento en dos liquidaciones', async () => {
      await ventas(ctx.fixtures.tripA, 1);
      const d = await hoy();
      const s = await post('/settlements', { company_id: ctx.fixtures.companyA, period_start: d, period_end: d }, ctx.sessions.admin.token);
      const item = await queryOne<{ financial_transaction_id: number }>('SELECT financial_transaction_id FROM settlement_items WHERE settlement_id = ? LIMIT 1', [s.body.data.id]);
      const otra = (await execute("INSERT INTO settlements (company_id, settlement_code, period_start, period_end, status) VALUES (?, 'L-F12A-D', ?, ?, 'PENDING')", [ctx.fixtures.companyA, d, d])).insertId;
      await assert.rejects(
        execute("INSERT INTO settlement_items (settlement_id, financial_transaction_id, type, amount) VALUES (?, ?, 'SALE', 1.00)", [otra, item!.financial_transaction_id]),
        (error: { code?: string }) => error.code === 'ER_DUP_ENTRY',
      );
      const indices = await query<{ index_name: string; non_unique: number }>(
        "SELECT index_name, non_unique FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'settlement_items' AND column_name = 'financial_transaction_id'",
      );
      assert.deepEqual(indices.map((i) => [i.index_name, Number(i.non_unique)]), [['uq_settlement_items_transaction', 0]], 'un único índice y es UNIQUE (migración 013)');
    });

    it('D2 · la empresa inexistente responde 404 y el alta no acepta un estado inicial', async () => {
      const d = await hoy();
      assert.equal((await post('/settlements', { company_id: 999999, period_start: d, period_end: d }, ctx.sessions.admin.token)).status, 404);
      for (const status of ['PAID', 'PROCESSING', 'CANCELLED', 'FAILED']) {
        const res = await post('/settlements', { company_id: ctx.fixtures.companyA, period_start: d, period_end: d, status }, ctx.sessions.admin.token);
        assert.equal(res.status, 400, status);
      }
      assert.deepEqual(await query('SELECT id FROM settlements'), []);
      const pendiente = await post('/settlements', { company_id: ctx.fixtures.companyA, period_start: d, period_end: d, status: 'PENDING' }, ctx.sessions.admin.token);
      assert.equal(pendiente.status, 201);
      assert.equal(pendiente.body.data.status, 'PENDING');
    });
  });

  // =====================================================================
  describe('F12-03 · máquina de estados y PAYOUT único', () => {
    let seq = 0;
    beforeEach(async () => {
      for (const tabla of ['settlement_items', 'settlements', 'financial_transactions', 'refunds', 'coupon_usages', 'booking_seats', 'payments', 'notifications', 'bookings', 'booking_groups']) {
        await execute(`DELETE FROM ${tabla}`);
      }
      await execute("UPDATE trips t JOIN buses b ON b.id = t.bus_id SET t.available_seats = b.capacity, t.status = 'SCHEDULED'");
      const res = await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [at(await freeSeats(ctx.fixtures.tripA), 0).id], passenger_email: 'c@test.pe' }, ctx.sessions.customer.token);
      assert.equal((await post(`/bookings/${res.body.data.id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token)).status, 200);
    });

    async function liquidacion() {
      seq += 1;
      const d = await hoy();
      // Un inicio distinto y REAL por liquidación (F12-04 rechaza fechas imposibles como 2020-02-30).
      const inicio = new Date(Date.UTC(2020, 0, 1) + seq * 86_400_000).toISOString().slice(0, 10);
      const res = await post('/settlements', { company_id: ctx.fixtures.companyA, period_start: inicio, period_end: d }, ctx.sessions.admin.token);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body.data as { id: number; settlement_code: string; net_amount: number };
    }
    const cambiar = (id: number, status: string) => put(`/settlements/${id}`, { status }, ctx.sessions.admin.token);
    const estado = async (id: number) => queryOne<{ status: string; paid_at: string | null }>('SELECT status, paid_at FROM settlements WHERE id = ?', [id]);
    const payouts = (code: string) => query<{ amount: number }>("SELECT amount FROM financial_transactions WHERE type = 'PAYOUT' AND reference_code = ?", [code]);

    it('la tabla de transiciones es exactamente la definida', () => {
      assert.deepEqual(SETTLEMENT_TRANSITIONS, {
        PENDING: ['PROCESSING', 'PAID', 'CANCELLED'],
        PROCESSING: ['PAID', 'FAILED', 'CANCELLED'],
        FAILED: ['PROCESSING', 'CANCELLED'],
        PAID: [],
        CANCELLED: [],
      });
    });

    it('sonda original: PAID → PENDING → PAID → CANCELLED → PAID; solo la primera pasa y hay un único PAYOUT', async () => {
      const s = await liquidacion();
      const respuestas: number[] = [];
      for (const status of ['PAID', 'PENDING', 'PAID', 'CANCELLED', 'PAID']) respuestas.push((await cambiar(s.id, status)).status);
      assert.deepEqual(respuestas, [200, 409, 409, 409, 409]);
      assert.equal((await payouts(s.settlement_code)).length, 1);
      const fila = await estado(s.id);
      assert.equal(fila?.status, 'PAID');
      assert.ok(fila?.paid_at, 'paid_at obligatorio en PAID');
    });

    it('todas las transiciones: las permitidas pasan y las demás responden 409 sin cambiar nada', async () => {
      const estados = ['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED'];
      const caminos: Record<string, string[]> = { PENDING: [], PROCESSING: ['PROCESSING'], FAILED: ['PROCESSING', 'FAILED'], PAID: ['PAID'], CANCELLED: ['CANCELLED'] };
      for (const origen of estados) {
        for (const destino of estados) {
          const s = await liquidacion();
          for (const paso of caminos[origen]!) assert.equal((await cambiar(s.id, paso)).status, 200, `${origen}: preparar ${paso}`);
          const res = await cambiar(s.id, destino);
          const permitida = SETTLEMENT_TRANSITIONS[origen]!.includes(destino);
          assert.equal(res.status, permitida ? 200 : 409, `${origen} → ${destino}`);
          assert.equal((await estado(s.id))?.status, permitida ? destino : origen);
          const esperadosPayout = origen === 'PAID' || (permitida && destino === 'PAID') ? 1 : 0;
          assert.equal((await payouts(s.settlement_code)).length, esperadosPayout, `${origen} → ${destino}: PAYOUT`);
        }
      }
    });

    it('FAILED → PROCESSING → PAID: se reintenta y paga una sola vez', async () => {
      const s = await liquidacion();
      for (const status of ['PROCESSING', 'FAILED', 'PROCESSING', 'PAID']) assert.equal((await cambiar(s.id, status)).status, 200, status);
      assert.equal((await payouts(s.settlement_code)).length, 1);
      assert.equal(Number((await payouts(s.settlement_code))[0]!.amount), Number(s.net_amount));
    });

    it('pagos simultáneos: uno paga, el resto 409, un PAYOUT', async () => {
      const s = await liquidacion();
      const r = await Promise.all(Array.from({ length: 5 }, () => cambiar(s.id, 'PAID')));
      assert.deepEqual(r.map((x) => x.status).sort(), [200, 409, 409, 409, 409]);
      assert.equal((await payouts(s.settlement_code)).length, 1);
    });

    it('un PAYOUT previo para la liquidación impide pagarla otra vez (defensa)', async () => {
      const s = await liquidacion();
      await execute(
        "INSERT INTO financial_transactions (company_id, type, direction, amount, currency, reference_code, status, transaction_date) VALUES (?, 'PAYOUT', 'DEBIT', 1.00, 'PEN', ?, 'COMPLETED', NOW())",
        [ctx.fixtures.companyA, s.settlement_code],
      );
      assert.equal((await cambiar(s.id, 'PAID')).status, 409);
      assert.equal((await estado(s.id))?.status, 'PENDING');
      assert.equal((await payouts(s.settlement_code)).length, 1);
    });

    it('la referencia de pago se puede actualizar sin cambiar el estado, también en PAID', async () => {
      const s = await liquidacion();
      assert.equal((await cambiar(s.id, 'PAID')).status, 200);
      const res = await put(`/settlements/${s.id}`, { payment_reference: 'TRX-12A' }, ctx.sessions.admin.token);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.payment_reference, 'TRX-12A');
      assert.equal((await payouts(s.settlement_code)).length, 1);
    });

    it('CANCELLED libera sus movimientos: vuelven a ser liquidables, sin duplicarse y con traza', async () => {
      const s = await liquidacion();
      const antes = await query<{ financial_transaction_id: number }>('SELECT financial_transaction_id FROM settlement_items WHERE settlement_id = ?', [s.id]);
      assert.equal(antes.length, 2);
      assert.equal((await cambiar(s.id, 'CANCELLED')).status, 200);

      const trazas = await query<{ financial_transaction_id: number | null; amount: number }>('SELECT financial_transaction_id, amount FROM settlement_items WHERE settlement_id = ?', [s.id]);
      assert.equal(trazas.length, 2, 'los ítems se conservan');
      assert.ok(trazas.every((t) => t.financial_transaction_id === null), 'y dejan de retener sus movimientos');
      const auditoria = await queryOne<{ new_values: string }>("SELECT new_values FROM audit_logs WHERE entity_type = 'settlements' AND entity_id = ? ORDER BY id DESC LIMIT 1", [s.id]);
      assert.match(String(auditoria?.new_values), /released_financial_transaction_ids/);

      const d = await hoy();
      const nueva = await post('/settlements', { company_id: ctx.fixtures.companyA, period_start: d, period_end: d }, ctx.sessions.admin.token);
      assert.equal(nueva.status, 201);
      const ahora = await query<{ financial_transaction_id: number }>('SELECT financial_transaction_id FROM settlement_items WHERE settlement_id = ?', [nueva.body.data.id]);
      assert.deepEqual(ahora.map((i) => Number(i.financial_transaction_id)).sort(), antes.map((i) => Number(i.financial_transaction_id)).sort());
      assert.equal((await cambiar(s.id, 'PAID')).status, 409, 'la anulada no se paga');
      assert.equal((await payouts(s.settlement_code)).length, 0);
    });

    it('FAILED no libera los movimientos (sigue siendo el mismo pago pendiente)', async () => {
      const s = await liquidacion();
      await cambiar(s.id, 'PROCESSING');
      await cambiar(s.id, 'FAILED');
      const items = await query<{ financial_transaction_id: number | null }>('SELECT financial_transaction_id FROM settlement_items WHERE settlement_id = ?', [s.id]);
      assert.ok(items.length > 0 && items.every((i) => i.financial_transaction_id !== null));
    });

    it('la misma liquidación anulada no bloquea regenerar el mismo periodo', async () => {
      const d = await hoy();
      const primera = await post('/settlements', { company_id: ctx.fixtures.companyA, period_start: d, period_end: d }, ctx.sessions.admin.token);
      assert.equal((await cambiar(primera.body.data.id, 'CANCELLED')).status, 200);
      const otra = await post('/settlements', { company_id: ctx.fixtures.companyA, period_start: d, period_end: d }, ctx.sessions.admin.token);
      assert.equal(otra.status, 201, 'una anulada no cuenta como existente');
      assert.notEqual(Number(otra.body.data.id), Number(primera.body.data.id));
      assert.equal(Number(otra.body.data.items_count), 2);
    });
  });
});
