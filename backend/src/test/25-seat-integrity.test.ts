import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { get, getWithKey, post } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { expireDueBookings } from '../services/booking-expiry.service';
import { seatMap } from '../services/trip.service';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * BP-19 · un asiento, una reserva activa.
 *
 * El invariante que se defiende aquí es uno solo:
 *
 *     para un mismo (trip_id, seat_id) no puede haber más de UNA reserva que lo retenga.
 *
 * No se puede imponer con `UNIQUE (trip_id, seat_id)`. El histórico no se borra nunca —una
 * reserva cancelada o caducada conserva sus `booking_seats`—, así que el mismo par aparece
 * legítimamente varias veces; lo que no puede repetirse es la parte *activa*. La protección
 * es transaccional: los tres caminos que cambian la ocupación (vender, confirmar, caducar)
 * se serializan sobre la fila del viaje.
 *
 * EL AGUJERO QUE SE CIERRA. Al vender sí se comprobaba la ocupación; al **confirmar** no.
 * Entre la reserva y el pago la retención puede vencer, y el barrido de caducidad pasa cada
 * 60 segundos: durante esa ventana la reserva sigue PENDING con el plazo cumplido, la
 * disponibilidad la da por libre —correctamente— y otra persona compra el asiento. Si
 * entonces se pagaba la primera, quedaban DOS reservas CONFIRMED sobre el mismo asiento.
 */
describe('BP-19 · integridad de asientos en reservas', () => {
  let ctx: SuiteContext;
  /** Segundo viaje de la empresa A: MISMO bus, así que comparte los mismos `seat_id`. */
  let viajeGemelo: number;
  let claveApi: string;

  before(async () => {
    ctx = await prepareSuite();
    const gemelo = await queryOne<{ id: number }>(
      'SELECT id FROM trips WHERE bus_id = ? AND id <> ? ORDER BY id LIMIT 1',
      [ctx.fixtures.busA, ctx.fixtures.tripA],
    );
    assert.ok(gemelo, 'las fixtures deben traer un segundo viaje sobre el mismo bus');
    viajeGemelo = gemelo.id;

    const clave = await post(
      '/api-keys',
      { name: 'BP-19', company_id: ctx.fixtures.companyA },
      ctx.sessions.admin.token,
    );
    assert.equal(clave.status, 201, JSON.stringify(clave.body));
    claveApi = clave.body.data.plain_key as string;
  });
  after(teardownSuite);

  /** Deja el viaje sin reservas para que cada caso empiece con el bus entero libre. */
  beforeEach(async () => {
    await execute('DELETE FROM booking_seats');
    await execute('DELETE FROM payments');
    await execute('DELETE FROM financial_transactions');
    await execute('DELETE FROM bookings');
    await execute('UPDATE trips SET available_seats = (SELECT capacity FROM buses WHERE id = trips.bus_id)');
  });

  /* ------------------------------------------------------------------ utilidades */

  /** Pares (trip_id, seat_id) con MÁS de una reserva reteniéndolos. Debe estar vacío. */
  async function duplicadosActivos(): Promise<Array<Record<string, unknown>>> {
    return query(
      `SELECT bs.trip_id, bs.seat_id, COUNT(*) AS activas,
              GROUP_CONCAT(bk.id ORDER BY bk.id) AS reservas,
              GROUP_CONCAT(bk.status ORDER BY bk.id) AS estados
       FROM booking_seats bs
       JOIN bookings bk ON bk.id = bs.booking_id
       WHERE bk.status IN ('CONFIRMED', 'COMPLETED')
          OR (bk.status = 'PENDING' AND (bk.expires_at IS NULL OR bk.expires_at > NOW()))
       GROUP BY bs.trip_id, bs.seat_id
       HAVING activas > 1`,
    );
  }

  const sinDuplicados = async (mensaje = 'quedó un asiento con dos reservas activas') =>
    assert.deepEqual(await duplicadosActivos(), [], `${mensaje}: ${JSON.stringify(await duplicadosActivos())}`);

  /** Reserva el asiento indicado del viaje indicado. Devuelve la respuesta cruda. */
  const reservar = (viaje: number, asiento: number, token: string) =>
    post('/bookings', { trip_id: viaje, seat_ids: [asiento], passenger_email: 'cliente@test.pe' }, token);

  const pagar = (bookingId: number, token: string) => post(`/bookings/${bookingId}/pay`, { method: 'CASH' }, token);

  /** Un asiento libre del viaje, tomado del cálculo real de disponibilidad. */
  const asientoLibre = async (viaje: number) => at(await freeSeats(viaje), 0).id;

  /** Adelanta el reloj de la retención: el plazo vence, pero nadie la ha caducado aún. */
  const vencerRetencion = (bookingId: number) =>
    execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [bookingId]);

  const cuentaFilas = async (bookingId: number) =>
    Number((await queryOne<{ n: number }>('SELECT COUNT(*) n FROM booking_seats WHERE booking_id = ?', [bookingId]))?.n);

  /* ══════════════════════════════ el caso normal ══════════════════════════════ */

  describe('Asignación válida', () => {
    it('1 · un asiento queda asignado a su reserva, con viaje y asiento', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const res = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);

      assert.equal(res.status, 201);
      const filas = await query<{ trip_id: number; seat_id: number }>(
        'SELECT trip_id, seat_id FROM booking_seats WHERE booking_id = ?',
        [res.body.data.id],
      );
      assert.equal(filas.length, 1);
      assert.equal(Number(filas[0]!.trip_id), ctx.fixtures.tripA);
      assert.equal(Number(filas[0]!.seat_id), asiento);
      await sinDuplicados();
    });

    it('2 · el flujo completo de compra sigue funcionando de principio a fin', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const reserva = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);
      const pago = await pagar(reserva.body.data.id, ctx.sessions.customer.token);

      assert.equal(pago.status, 200);
      const estado = await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [reserva.body.data.id]);
      assert.equal(estado?.status, 'CONFIRMED');
      await sinDuplicados();
    });
  });

  /* ══════════════════════════════ colisiones ══════════════════════════════════ */

  describe('El mismo asiento no admite dos reservas activas', () => {
    it('3 · PENDING contra PENDING: la segunda venta se rechaza', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const primera = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);
      const segunda = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.companyAdmin.token);

      assert.equal(primera.status, 201);
      assert.equal(segunda.status, 409);
      await sinDuplicados();
    });

    it('4 · PENDING contra CONFIRMED: una reserva pagada bloquea la venta', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const primera = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);
      await pagar(primera.body.data.id, ctx.sessions.customer.token);

      const segunda = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.companyAdmin.token);
      assert.equal(segunda.status, 409);
      await sinDuplicados();
    });

    it('5 · CONFIRMED contra CONFIRMED: ningún camino produce dos pagadas', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const primera = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);
      await pagar(primera.body.data.id, ctx.sessions.customer.token);

      // No hay forma de crear la segunda: la venta ya la rechaza, y confirmar exige haber
      // reservado antes. Se comprueba el resultado, no el camino.
      const segunda = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.companyAdmin.token);
      assert.equal(segunda.status, 409);

      const confirmadas = await query(
        `SELECT bk.id FROM booking_seats bs JOIN bookings bk ON bk.id = bs.booking_id
         WHERE bs.trip_id = ? AND bs.seat_id = ? AND bk.status = 'CONFIRMED'`,
        [ctx.fixtures.tripA, asiento],
      );
      assert.equal(confirmadas.length, 1);
      await sinDuplicados();
    });

    it('6 · el mismo asiento repetido dentro de una sola reserva se rechaza', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const res = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [asiento, asiento], passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token,
      );

      assert.ok(res.status >= 400 && res.status < 500, `se esperaba un rechazo y llegó ${res.status}`);
      assert.equal(await cuentaFilas(res.body.data?.id ?? 0), 0);
      await sinDuplicados();
    });
  });

  /* ══════════════════════════════ reutilización ═══════════════════════════════ */

  describe('Un asiento liberado se vuelve a vender, sin borrar histórico', () => {
    it('7 · CANCELLED libera el asiento y conserva sus filas', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const primera = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);
      const cancelacion = await post(`/bookings/${primera.body.data.id}/cancel`, {}, ctx.sessions.customer.token);
      assert.equal(cancelacion.status, 200, JSON.stringify(cancelacion.body));

      const segunda = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.companyAdmin.token);
      assert.equal(segunda.status, 201, 'una cancelación no puede bloquear el asiento para siempre');
      assert.equal(await cuentaFilas(primera.body.data.id), 1, 'el histórico de la cancelada se conserva');
      await sinDuplicados();
    });

    it('8 · EXPIRED libera el asiento y conserva sus filas', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const primera = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);
      await vencerRetencion(primera.body.data.id);
      const barrido = await expireDueBookings();
      assert.ok(barrido.expired >= 1);

      const segunda = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.companyAdmin.token);
      assert.equal(segunda.status, 201);
      assert.equal(await cuentaFilas(primera.body.data.id), 1, 'el histórico de la caducada se conserva');
      await sinDuplicados();
    });

    it('9 · COMPLETED conserva el histórico y sigue ocupando su asiento', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const reserva = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);
      await pagar(reserva.body.data.id, ctx.sessions.customer.token);
      await execute("UPDATE bookings SET status = 'COMPLETED' WHERE id = ?", [reserva.body.data.id]);

      const otra = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.companyAdmin.token);
      assert.equal(otra.status, 409, 'un viaje ya realizado no libera el asiento de ese viaje');
      assert.equal(await cuentaFilas(reserva.body.data.id), 1);
      await sinDuplicados();
    });

    it('10 · el mismo asiento en dos viajes distintos es legítimo', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const libresGemelo = await freeSeats(viajeGemelo);
      assert.ok(libresGemelo.some((seat) => seat.id === asiento), 'ambos viajes comparten bus y asientos');

      const uno = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);
      const dos = await reservar(viajeGemelo, asiento, ctx.sessions.customer.token);

      assert.equal(uno.status, 201);
      assert.equal(dos.status, 201, 'la ocupación es por viaje, no por asiento');
      await sinDuplicados();
    });
  });

  /* ══════════════════════════════ el agujero de BP-19 ═════════════════════════ */

  describe('Confirmar un pago no puede pisar un asiento ya vendido', () => {
    it('11 · pagar una retención vencida cuyo asiento tomó otro devuelve 409', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const primera = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);

      // El plazo vence; el barrido todavía no ha pasado. La reserva sigue PENDING.
      await vencerRetencion(primera.body.data.id);
      const sigueVigente = await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [
        primera.body.data.id,
      ]);
      assert.equal(sigueVigente?.status, 'PENDING', 'el escenario exige una PENDING vencida sin barrer');

      // Otra persona compra el asiento, que la disponibilidad da por libre. Correcto.
      const segunda = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.companyAdmin.token);
      assert.equal(segunda.status, 201);
      assert.equal((await pagar(segunda.body.data.id, ctx.sessions.companyAdmin.token)).status, 200);

      // Y ahora paga la primera. Antes de BP-19 esto devolvía 200 y dejaba dos CONFIRMED.
      const pagoTardio = await pagar(primera.body.data.id, ctx.sessions.customer.token);
      assert.equal(pagoTardio.status, 409, 'el pago tardío debe rechazarse, no duplicar el asiento');
      assert.match(String(pagoTardio.body.message), /ya fueron tomados/i);

      const estado = await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [
        primera.body.data.id,
      ]);
      assert.equal(estado?.status, 'PENDING', 'la reserva rechazada no se confirma');
      await sinDuplicados();
    });

    it('12 · el rechazo no cobra: no queda pago PAID de la reserva perdedora', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const primera = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);
      await vencerRetencion(primera.body.data.id);
      const segunda = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.companyAdmin.token);
      await pagar(segunda.body.data.id, ctx.sessions.companyAdmin.token);

      await pagar(primera.body.data.id, ctx.sessions.customer.token);

      const pagados = await query(
        "SELECT id FROM payments WHERE booking_id = ? AND status = 'PAID'",
        [primera.body.data.id],
      );
      assert.equal(pagados.length, 0, 'la transacción se deshace entera: sin asiento no hay cobro');
      const movimientos = await query('SELECT id FROM financial_transactions WHERE booking_id = ?', [
        primera.body.data.id,
      ]);
      assert.equal(movimientos.length, 0);
    });

    it('13 · si el asiento sigue libre, la retención vencida se puede pagar igual', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const reserva = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);
      await vencerRetencion(reserva.body.data.id);

      // No se endurece la política de retención: lo que se impide es pisar a otro, no pagar
      // con retraso cuando nadie ha ocupado el sitio.
      const pago = await pagar(reserva.body.data.id, ctx.sessions.customer.token);
      assert.equal(pago.status, 200);
      await sinDuplicados();
    });

    it('14 · una reserva ya caducada por el barrido sigue sin poderse pagar', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const reserva = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);
      await vencerRetencion(reserva.body.data.id);
      await expireDueBookings();

      const pago = await pagar(reserva.body.data.id, ctx.sessions.customer.token);
      assert.equal(pago.status, 400);
      assert.match(String(pago.body.message), /ya no está vigente/i);
    });
  });

  /* ══════════════════════════════ concurrencia ════════════════════════════════ */

  describe('Compras simultáneas del mismo asiento', () => {
    it('15 · de dos compras a la vez, exactamente una gana', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);

      const resultados = await Promise.all([
        reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token),
        reservar(ctx.fixtures.tripA, asiento, ctx.sessions.companyAdmin.token),
      ]);

      const creadas = resultados.filter((r) => r.status === 201);
      const rechazadas = resultados.filter((r) => r.status === 409);
      assert.equal(creadas.length, 1, `ganaron ${creadas.length}: ${JSON.stringify(resultados.map((r) => r.status))}`);
      assert.equal(rechazadas.length, 1);
      await sinDuplicados();
    });

    it('16 · con seis compras a la vez sigue ganando una sola', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const tokens = [
        ctx.sessions.customer.token,
        ctx.sessions.companyAdmin.token,
        ctx.sessions.admin.token,
        ctx.sessions.operator.token,
        ctx.sessions.companyAdminB.token,
        ctx.sessions.customer.token,
      ];

      const resultados = await Promise.all(tokens.map((token) => reservar(ctx.fixtures.tripA, asiento, token)));

      const creadas = resultados.filter((r) => r.status === 201);
      assert.equal(creadas.length, 1, `estados: ${JSON.stringify(resultados.map((r) => r.status))}`);
      await sinDuplicados();
    });

    it('17 · pagar y vender a la vez tampoco duplica el asiento', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const primera = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);
      await vencerRetencion(primera.body.data.id);

      // La venta y la confirmación se serializan sobre la fila del viaje: da igual cuál
      // llegue antes, no pueden concluir las dos.
      const [venta, pagoTardio] = await Promise.all([
        reservar(ctx.fixtures.tripA, asiento, ctx.sessions.companyAdmin.token),
        pagar(primera.body.data.id, ctx.sessions.customer.token),
      ]);

      const exitos = [venta.status === 201, pagoTardio.status === 200].filter(Boolean);
      assert.ok(exitos.length >= 1, 'alguna de las dos debe prosperar');
      await sinDuplicados(`venta=${venta.status} pago=${pagoTardio.status}`);
    });
  });

  /* ══════════════════════════════ atomicidad ══════════════════════════════════ */

  describe('Si la compra falla, no queda ningún asiento retenido', () => {
    it('18 · un itinerario cuyo segundo tramo choca deshace también el primero', async () => {
      const asientoIda = await asientoLibre(ctx.fixtures.tripA);
      const asientoVuelta = await asientoLibre(viajeGemelo);

      // El asiento de vuelta ya está tomado por otra persona.
      const bloqueo = await reservar(viajeGemelo, asientoVuelta, ctx.sessions.companyAdmin.token);
      assert.equal(bloqueo.status, 201);

      const compra = await post(
        '/bookings/itineraries',
        {
          trip_type: 'ROUND_TRIP',
          segments: [
            { trip_id: ctx.fixtures.tripA, seat_ids: [asientoIda] },
            { trip_id: viajeGemelo, seat_ids: [asientoVuelta] },
          ],
          passenger_email: 'cliente@test.pe',
        },
        ctx.sessions.customer.token,
      );

      assert.equal(compra.status, 409);
      const retenidoIda = await query(
        'SELECT bs.id FROM booking_seats bs WHERE bs.trip_id = ? AND bs.seat_id = ?',
        [ctx.fixtures.tripA, asientoIda],
      );
      assert.equal(retenidoIda.length, 0, 'el tramo de ida debe deshacerse con el ROLLBACK');

      const libres = await freeSeats(ctx.fixtures.tripA);
      assert.ok(libres.some((seat) => seat.id === asientoIda), 'el asiento vuelve a estar disponible');
      await sinDuplicados();
    });
  });

  /* ══════════════════════════════ disponibilidad (BP-15) ═════════════════════ */

  describe('La disponibilidad sigue teniendo una sola fuente de verdad', () => {
    it('19 · el mapa de asientos refleja exactamente lo que dice booking_seats', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const reserva = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);
      await pagar(reserva.body.data.id, ctx.sessions.customer.token);

      const mapa = await seatMap(ctx.fixtures.tripA);
      assert.equal(mapa.find((seat) => seat.id === asiento)?.is_taken, 1);
      assert.equal(mapa.filter((seat) => seat.is_taken === 1).length, 1);

      // Y al cancelarla vuelve a mostrarse libre, sin borrar el histórico.
      await post(`/bookings/${reserva.body.data.id}/cancel`, {}, ctx.sessions.customer.token);
      const despues = await seatMap(ctx.fixtures.tripA);
      assert.equal(despues.find((seat) => seat.id === asiento)?.is_taken, 0);
      assert.equal(await cuentaFilas(reserva.body.data.id), 1);
    });

    it('20 · seats_available del buscador coincide con el mapa de asientos', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);

      const busqueda = await get('/public/trips?limit=50');
      assert.equal(busqueda.status, 200);
      const viaje = (busqueda.body.data as Array<Record<string, unknown>>).find(
        (row) => Number(row.id) === ctx.fixtures.tripA,
      );
      assert.ok(viaje, 'el viaje debe seguir apareciendo en el buscador');

      const mapa = await seatMap(ctx.fixtures.tripA);
      const libres = mapa.filter((seat) => seat.is_taken === 0).length;
      assert.equal(Number(viaje.seats_available), libres);
    });

    it('21 · una retención vencida cuenta como libre en las dos vistas', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const reserva = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);
      await vencerRetencion(reserva.body.data.id);

      const mapa = await seatMap(ctx.fixtures.tripA);
      assert.equal(mapa.find((seat) => seat.id === asiento)?.is_taken, 0);

      const busqueda = await get('/public/trips?limit=50');
      const viaje = (busqueda.body.data as Array<Record<string, unknown>>).find(
        (row) => Number(row.id) === ctx.fixtures.tripA,
      );
      assert.equal(Number(viaje?.seats_available), mapa.filter((seat) => seat.is_taken === 0).length);
    });
  });

  /* ══════════════════════════════ API de integración ═════════════════════════ */

  describe('La API de integración informa lo mismo que el resto', () => {
    it('22 · availability coincide con el mapa de asientos', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      const reserva = await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);
      await pagar(reserva.body.data.id, ctx.sessions.customer.token);

      const res = await getWithKey(`/integration/v1/trips/${ctx.fixtures.tripA}/availability`, claveApi);
      assert.equal(res.status, 200);

      const mapa = await seatMap(ctx.fixtures.tripA);
      assert.equal(res.body.data.seats_taken, mapa.filter((seat) => seat.is_taken === 1).length);
      assert.equal(
        res.body.data.seats_available,
        mapa.filter((seat) => seat.is_taken === 0 && seat.status === 'AVAILABLE').length,
      );
    });

    it('23 · seats_taken del listado coincide con availability', async () => {
      const asiento = await asientoLibre(ctx.fixtures.tripA);
      await reservar(ctx.fixtures.tripA, asiento, ctx.sessions.customer.token);

      const lista = await getWithKey('/integration/v1/trips?limit=100', claveApi);
      const viaje = (lista.body.data as Array<Record<string, unknown>>).find(
        (row) => Number(row.id) === ctx.fixtures.tripA,
      );
      const detalle = await getWithKey(`/integration/v1/trips/${ctx.fixtures.tripA}/availability`, claveApi);

      assert.equal(Number(viaje?.seats_taken), detalle.body.data.seats_taken);
    });
  });
});
