import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { get, post, put } from './helpers/api';
import { query } from '../config/database';
import { freeSeats } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

describe('Liquidaciones y reportes', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();

    // Ventas reales sobre las que liquidar.
    const seats = await freeSeats(ctx.fixtures.tripA);
    for (const seat of seats.slice(0, 3)) {
      const reserva = await post('/bookings', {
        trip_id: ctx.fixtures.tripA, seat_ids: [seat.id], passenger_email: 'cliente@test.pe',
      }, ctx.sessions.customer.token);
      await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'CARD' }, ctx.sessions.customer.token);
    }
  });
  after(teardownSuite);

  it('genera una liquidación agrupando los movimientos del periodo', async () => {
    const res = await post('/settlements', {
      company_id: ctx.fixtures.companyA, period_start: '2020-01-01', period_end: '2035-12-31',
    }, ctx.sessions.admin.token);

    assert.equal(res.status, 201);
    assert.ok(Number(res.body.data.items_count) > 0, 'debe incluir movimientos');
    assert.ok(Number(res.body.data.gross_amount) > 0);
    assert.ok(Number(res.body.data.commission_amount) > 0);
  });

  it('calcula el neto como bruto menos comisión y reembolsos', async () => {
    const lista = await get('/settlements?limit=10', ctx.sessions.admin.token);
    const s = lista.body.data[0];
    const esperado = Number(s.gross_amount) - Number(s.commission_amount) - Number(s.refund_amount);
    assert.ok(Math.abs(Number(s.net_amount) - esperado) < 0.02);
  });

  it('no vuelve a agrupar movimientos ya liquidados', async () => {
    const segunda = await post('/settlements', {
      company_id: ctx.fixtures.companyA, period_start: '2020-01-01', period_end: '2035-12-31',
    }, ctx.sessions.admin.token);
    assert.equal(segunda.status, 201);
    assert.equal(Number(segunda.body.data.items_count), 0, 'los movimientos ya liquidados no se repiten');
  });

  it('el detalle incluye los items de la liquidación', async () => {
    const lista = await get('/settlements?limit=10', ctx.sessions.admin.token);
    const conItems = lista.body.data.find((s: { items_count: number }) => Number(s.items_count) > 0);
    const detalle = await get(`/settlements/${conItems.id}`, ctx.sessions.admin.token);
    assert.equal(detalle.status, 200);
    assert.ok(detalle.body.data.items.length > 0);
    assert.ok(detalle.body.data.items.every((i: { type: string }) => ['SALE', 'COMMISSION', 'REFUND', 'ADJUSTMENT'].includes(i.type)));
  });

  it('marcarla como pagada registra la transacción PAYOUT', async () => {
    const lista = await get('/settlements?limit=10', ctx.sessions.admin.token);
    const objetivo = lista.body.data.find((s: { status: string }) => s.status === 'PENDING');

    const res = await put(`/settlements/${objetivo.id}`, { status: 'PAID', payment_reference: 'REF-1' }, ctx.sessions.admin.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'PAID');

    const payouts = await query("SELECT id FROM financial_transactions WHERE type = 'PAYOUT'");
    assert.ok(payouts.length > 0);
  });

  it('la empresa solo ve sus liquidaciones y no puede generarlas', async () => {
    const propias = await get('/settlements?limit=50', ctx.sessions.companyAdmin.token);
    assert.equal(propias.status, 200);
    assert.ok(propias.body.data.every((s: { company_id: number }) => s.company_id === ctx.fixtures.companyA));

    const ajenas = await get('/settlements?limit=50', ctx.sessions.companyAdminB.token);
    assert.deepEqual(ajenas.body.data, [], 'la empresa B aún no tiene liquidaciones');

    // Generar exige settings.update, que solo tiene ADMIN.
    const intento = await post('/settlements', {
      company_id: ctx.fixtures.companyA, period_start: '2020-01-01', period_end: '2035-12-31',
    }, ctx.sessions.companyAdmin.token);
    assert.equal(intento.status, 403);
  });

  it('el resumen financiero responde con los totales de la empresa', async () => {
    const res = await get('/financial-transactions/summary', ctx.sessions.companyAdmin.token);
    assert.equal(res.status, 200);
    assert.ok(Number(res.body.data.gross_income) > 0);
    assert.ok(Number(res.body.data.commissions) > 0);
  });

  it('todos los reportes del catálogo se ejecutan sin error', async () => {
    const catalogo = await get('/reports', ctx.sessions.companyAdmin.token);
    assert.equal(catalogo.status, 200);
    assert.ok(catalogo.body.data.length >= 7);

    for (const nombre of catalogo.body.data) {
      const res = await get(`/reports/${nombre}`, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200, `el reporte ${nombre} falló`);
      assert.ok(Array.isArray(res.body.data.rows), `el reporte ${nombre} no devolvió filas`);
    }
  });

  it('un reporte inexistente devuelve 404', async () => {
    assert.equal((await get('/reports/no-existe', ctx.sessions.companyAdmin.token)).status, 404);
  });

  it('los paneles devuelven cifras numéricas reales', async () => {
    const admin = await get('/dashboard/admin', ctx.sessions.admin.token);
    assert.equal(admin.status, 200);
    assert.ok(Array.isArray(admin.body.data.salesSeries));
    for (const [clave, valor] of Object.entries(admin.body.data.totals)) {
      assert.ok(valor !== null && !Number.isNaN(Number(valor)), `el total ${clave} no es numérico`);
    }

    const empresa = await get('/dashboard/company', ctx.sessions.companyAdmin.token);
    assert.ok(Number(empresa.body.data.totals.tickets_sold) > 0);
  });

  /**
   * BP-10 · regresión de la auditoría del 06/09/2026.
   *
   * `PUT /settlements/:id` insertaba un PAYOUT cada vez que llegaba `status: PAID`, sin
   * mirar si la liquidación ya estaba pagada. Un doble clic, un reintento de red o una
   * recarga duplicaban el pago a la empresa en `financial_transactions`, que es la fuente
   * de los informes financieros.
   *
   * BP-23 · el mismo endpoint tampoco comprobaba la empresa, a diferencia de `POST`.
   */
  describe('BP-10 y BP-23 · pagar una liquidación es idempotente y acotado', () => {
    /** Liquidación nueva sobre la empresa indicada, con los movimientos que queden sin liquidar. */
    async function nuevaLiquidacion(companyId: number) {
      const res = await post(
        '/settlements',
        { company_id: companyId, period_start: '2020-01-01', period_end: '2035-12-31' },
        ctx.sessions.admin.token,
      );
      assert.equal(res.status, 201);
      return res.body.data as { id: number; net_amount: number; settlement_code: string; status: string };
    }

    async function payouts(code: string) {
      return query<{ id: number; amount: number }>(
        "SELECT id, amount FROM financial_transactions WHERE type = 'PAYOUT' AND reference_code = ?",
        [code],
      );
    }

    it('marcarla PAID crea exactamente un PAYOUT por el neto', async () => {
      const liquidacion = await nuevaLiquidacion(ctx.fixtures.companyA);

      const res = await put(`/settlements/${liquidacion.id}`, { status: 'PAID' }, ctx.sessions.admin.token);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'PAID');

      const movimientos = await payouts(liquidacion.settlement_code);
      assert.equal(movimientos.length, 1);
      assert.equal(Number(movimientos[0]!.amount), Number(liquidacion.net_amount), 'el importe es el neto de la liquidación');
    });

    it('repetir la misma petición no crea un segundo PAYOUT', async () => {
      const liquidacion = await nuevaLiquidacion(ctx.fixtures.companyA);
      await put(`/settlements/${liquidacion.id}`, { status: 'PAID' }, ctx.sessions.admin.token);

      const repetida = await put(`/settlements/${liquidacion.id}`, { status: 'PAID' }, ctx.sessions.admin.token);
      assert.equal(repetida.status, 200, 'reintentar sigue siendo una respuesta correcta');
      assert.equal(repetida.body.data.status, 'PAID');

      const movimientos = await payouts(liquidacion.settlement_code);
      assert.equal(movimientos.length, 1, 'el ataque de la auditoría dejaba dos');
    });

    it('ni cinco reintentos seguidos alteran el importe acumulado', async () => {
      const liquidacion = await nuevaLiquidacion(ctx.fixtures.companyA);
      for (let intento = 0; intento < 5; intento += 1) {
        assert.equal((await put(`/settlements/${liquidacion.id}`, { status: 'PAID' }, ctx.sessions.admin.token)).status, 200);
      }

      const movimientos = await payouts(liquidacion.settlement_code);
      assert.equal(movimientos.length, 1);
      assert.equal(Number(movimientos[0]!.amount), Number(liquidacion.net_amount));
    });

    it('dos peticiones simultáneas dejan un único PAYOUT', async () => {
      const liquidacion = await nuevaLiquidacion(ctx.fixtures.companyA);

      const [uno, dos] = await Promise.all([
        put(`/settlements/${liquidacion.id}`, { status: 'PAID' }, ctx.sessions.admin.token),
        put(`/settlements/${liquidacion.id}`, { status: 'PAID' }, ctx.sessions.admin.token),
      ]);
      assert.equal(uno.status, 200);
      assert.equal(dos.status, 200);

      const movimientos = await payouts(liquidacion.settlement_code);
      assert.equal(movimientos.length, 1, 'el bloqueo de fila serializa las dos transiciones');
    });

    it('la fecha de pago no se reescribe al reintentar', async () => {
      const liquidacion = await nuevaLiquidacion(ctx.fixtures.companyA);
      await put(`/settlements/${liquidacion.id}`, { status: 'PAID' }, ctx.sessions.admin.token);
      const primera = await query<{ paid_at: string }>('SELECT paid_at FROM settlements WHERE id = ?', [liquidacion.id]);

      await put(`/settlements/${liquidacion.id}`, { status: 'PAID' }, ctx.sessions.admin.token);
      const segunda = await query<{ paid_at: string }>('SELECT paid_at FROM settlements WHERE id = ?', [liquidacion.id]);

      assert.equal(segunda[0]!.paid_at, primera[0]!.paid_at);
    });

    it('las demás transiciones legítimas siguen funcionando', async () => {
      const liquidacion = await nuevaLiquidacion(ctx.fixtures.companyA);

      const enProceso = await put(`/settlements/${liquidacion.id}`, { status: 'PROCESSING' }, ctx.sessions.admin.token);
      assert.equal(enProceso.body.data.status, 'PROCESSING');
      assert.equal((await payouts(liquidacion.settlement_code)).length, 0, 'solo PAID emite el pago');

      const referencia = await put(
        `/settlements/${liquidacion.id}`,
        { payment_reference: 'TRANSFERENCIA-001' },
        ctx.sessions.admin.token,
      );
      assert.equal(referencia.body.data.payment_reference, 'TRANSFERENCIA-001');

      const pagada = await put(`/settlements/${liquidacion.id}`, { status: 'PAID' }, ctx.sessions.admin.token);
      assert.equal(pagada.body.data.status, 'PAID');
      assert.equal((await payouts(liquidacion.settlement_code)).length, 1, 'PROCESSING → PAID sí emite, una vez');

      const cancelada = await put(`/settlements/${liquidacion.id}`, { status: 'CANCELLED' }, ctx.sessions.admin.token);
      assert.equal(cancelada.body.data.status, 'CANCELLED');
      assert.equal((await payouts(liquidacion.settlement_code)).length, 1, 'salir de PAID no borra ni añade movimientos');
    });

    it('un rol de empresa no puede tocar la liquidación de otra empresa', async () => {
      const deB = await nuevaLiquidacion(ctx.fixtures.companyB);

      // Hoy `settings.update` es exclusivo del ADMIN, así que la primera barrera es el permiso.
      for (const sesion of [ctx.sessions.companyAdmin, ctx.sessions.operator, ctx.sessions.customer]) {
        assert.equal((await put(`/settlements/${deB.id}`, { status: 'PAID' }, sesion.token)).status, 403);
      }
      assert.equal((await payouts(deB.settlement_code)).length, 0);
    });

    it('el ADMIN conserva el acceso global a las liquidaciones de cualquier empresa', async () => {
      const deB = await nuevaLiquidacion(ctx.fixtures.companyB);
      const res = await put(`/settlements/${deB.id}`, { status: 'PAID' }, ctx.sessions.admin.token);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'PAID');
      assert.equal((await payouts(deB.settlement_code)).length, 1);
    });

    it('una liquidación inexistente responde 404 y no revela nada', async () => {
      const res = await put('/settlements/999999', { status: 'PAID' }, ctx.sessions.admin.token);
      assert.equal(res.status, 404);
    });
  });
});
