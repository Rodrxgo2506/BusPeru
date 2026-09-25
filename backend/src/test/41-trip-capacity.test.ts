import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { get, getWithKey, post } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, createBusLayout, freeSeats } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * H-03, H-04 y H-14 · la capacidad de un viaje es la de SU versión, no la del bus de hoy.
 *
 * EL PROBLEMA COMÚN. Desde la migración 010 un bus puede ir por su versión 7 mientras un
 * viaje de marzo sigue anclado a la 1. Varias consultas seguían preguntándole al bus cuántas
 * plazas tenía aquel viaje, y respondían con la cifra de hoy: disponibilidad equivocada en el
 * buscador, ocupación histórica falseada en el informe y denominadores erróneos en el panel,
 * el listado de viajes y la API de integración.
 *
 * CÓMO SE PRUEBA. Se deja `buses.capacity` en un número que NO es el de ninguna versión. Si
 * alguna consulta lo sigue leyendo, salta a la vista.
 */
describe('Capacidad efectiva del viaje (H-03, H-04, H-14)', () => {
  let ctx: SuiteContext;
  /** Cifra imposible: si aparece en una respuesta, es que se leyó `buses.capacity`. */
  const CAPACIDAD_FALSA = 99;
  let asientosA = 0;

  before(async () => {
    ctx = await prepareSuite();
    asientosA = Number(
      (await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM seats WHERE layout_id = ?', [ctx.fixtures.layoutA]))?.n ?? 0,
    );
    assert.ok(asientosA > 0);
    assert.notEqual(asientosA, CAPACIDAD_FALSA);
  });
  after(teardownSuite);

  beforeEach(async () => {
    await execute('DELETE FROM booking_seats WHERE trip_id = ?', [ctx.fixtures.tripA]);
    // Desde H-50 cancelar una reserva pagada abre su reembolso: va antes que los pagos que referencia.
    await execute('DELETE FROM refunds WHERE booking_id IN (SELECT id FROM bookings WHERE trip_id = ?)', [ctx.fixtures.tripA]);
    await execute('DELETE FROM payments WHERE booking_id IN (SELECT id FROM bookings WHERE trip_id = ?)', [ctx.fixtures.tripA]);
    await execute('DELETE FROM bookings WHERE trip_id = ?', [ctx.fixtures.tripA]);
    await execute('DELETE FROM seats WHERE layout_id NOT IN (?, ?)', [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
    await execute('UPDATE trips SET bus_layout_id = ? WHERE bus_id = ?', [ctx.fixtures.layoutA, ctx.fixtures.busA]);
    await execute('DELETE FROM bus_layouts WHERE id NOT IN (?, ?)', [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
    await execute("UPDATE bus_layouts SET status = 'PUBLISHED' WHERE id IN (?, ?)", [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
    await execute('UPDATE bus_layouts SET seat_count = (SELECT COUNT(*) FROM seats WHERE layout_id = ?) WHERE id = ?', [
      ctx.fixtures.layoutA,
      ctx.fixtures.layoutA,
    ]);
    // El bus miente a propósito: su caché de capacidad no es la de ninguna versión.
    await execute('UPDATE buses SET capacity = ? WHERE id = ?', [CAPACIDAD_FALSA, ctx.fixtures.busA]);
  });

  /** Una venta pagada sobre el viaje de los fixtures. */
  async function vender(cuantos = 1): Promise<number[]> {
    const libres = await freeSeats(ctx.fixtures.tripA);
    const ids = libres.slice(0, cuantos).map((asiento) => asiento.id);
    const reserva = await post(
      '/bookings',
      { trip_id: ctx.fixtures.tripA, seat_ids: ids, passenger_email: 'cliente@test.pe' },
      ctx.sessions.customer.token,
    );
    assert.equal(reserva.status, 201, JSON.stringify(reserva.body));
    await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);
    return ids;
  }

  /** Publica una versión nueva del bus A con otro número de asientos. El viaje no se mueve. */
  async function publicarOtraVersion(asientos: number): Promise<number> {
    const nueva = await createBusLayout(ctx.fixtures.busA, { version: 9, status: 'DRAFT', rows: 9, columns: 4 });
    for (let indice = 1; indice <= asientos; indice += 1) {
      await execute(
        `INSERT INTO seats (bus_id, layout_id, deck_id, seat_type_id, seat_number, row_number, column_number, is_window, is_aisle, status)
         VALUES (?, ?, ?, NULL, ?, ?, ?, 0, 0, 'AVAILABLE')`,
        [ctx.fixtures.busA, nueva.layoutId, at(nueva.deckIds, 0), `N${indice}`, Math.ceil(indice / 4), ((indice - 1) % 4) + 1],
      );
    }
    await execute('UPDATE bus_layouts SET seat_count = (SELECT COUNT(*) FROM seats WHERE layout_id = ?) WHERE id = ?', [
      nueva.layoutId,
      nueva.layoutId,
    ]);
    await execute("UPDATE bus_layouts SET status = 'ARCHIVED' WHERE id = ?", [ctx.fixtures.layoutA]);
    await execute("UPDATE bus_layouts SET status = 'PUBLISHED', published_at = NOW() WHERE id = ?", [nueva.layoutId]);
    // La publicación real sincroniza la caché del bus; aquí se imita para que la cifra del
    // bus sea la de la versión NUEVA y se note si alguien la lee para el viaje viejo.
    await execute('UPDATE buses SET capacity = ? WHERE id = ?', [asientos, ctx.fixtures.busA]);
    return nueva.layoutId;
  }

  const buscar = () => get('/public/trips?limit=100');
  const viajeEnBusqueda = async () =>
    ((await buscar()).body.data as Array<{ id: number; capacity: number; seats_available: number }>).find(
      (viaje) => viaje.id === ctx.fixtures.tripA,
    );

  // =====================================================================
  describe('H-03 · disponibilidad del buscador público', () => {
    it('1 · `seats_available` sale de la versión del viaje, no de `buses.capacity`', async () => {
      const viaje = await viajeEnBusqueda();
      assert.ok(viaje, 'el viaje debe aparecer en la búsqueda');
      assert.equal(Number(viaje.seats_available), asientosA);
      assert.notEqual(Number(viaje.seats_available), CAPACIDAD_FALSA);
    });

    it('2 · la ficha pública del viaje tampoco usa la caché del bus', async () => {
      const res = await get(`/public/trips/${ctx.fixtures.tripA}`);
      assert.equal(res.status, 200);
      assert.equal(Number(res.body.data.capacity), asientosA);
      assert.equal(Number(res.body.data.seats_available), asientosA);
    });

    it('3 · con asientos vendidos, la resta se hace sobre la capacidad correcta', async () => {
      await vender(2);
      const viaje = await viajeEnBusqueda();
      assert.equal(Number(viaje?.seats_available), asientosA - 2);
    });

    it('4 · un viaje anclado a una versión antigua conserva SU capacidad', async () => {
      await publicarOtraVersion(5);

      const viaje = await viajeEnBusqueda();
      assert.equal(Number(viaje?.capacity), asientosA, 'sigue siendo la de la v1, no la de la v9');
      assert.equal(Number(viaje?.seats_available), asientosA);
    });

    it('5 · y los viajes nuevos del mismo bus usan la versión nueva', async () => {
      const nuevoLayout = await publicarOtraVersion(5);
      await execute(
        `INSERT INTO trips (route_id, bus_id, bus_layout_id, departure_datetime, arrival_datetime, base_price, available_seats, status)
         SELECT route_id, bus_id, ?, DATE_ADD(departure_datetime, INTERVAL 3 DAY), DATE_ADD(arrival_datetime, INTERVAL 3 DAY),
                base_price, 5, 'SCHEDULED'
         FROM trips WHERE id = ?`,
        [nuevoLayout, ctx.fixtures.tripA],
      );
      const nuevoId = Number((await queryOne<{ id: number }>('SELECT MAX(id) AS id FROM trips'))?.id);

      const filas = (await buscar()).body.data as Array<{ id: number; capacity: number; seats_available: number }>;
      assert.equal(Number(filas.find((v) => v.id === nuevoId)?.seats_available), 5);
      assert.equal(Number(filas.find((v) => v.id === ctx.fixtures.tripA)?.seats_available), asientosA);
    });

    it('6 · un viaje sin versión propia conserva el respaldo de `buses.capacity`', async () => {
      await execute('UPDATE trips SET bus_layout_id = NULL WHERE id = ?', [ctx.fixtures.tripA]);

      const viaje = await viajeEnBusqueda();
      assert.equal(Number(viaje?.capacity), CAPACIDAD_FALSA, 'es el único caso en que manda el bus');
      assert.equal(Number(viaje?.seats_available), CAPACIDAD_FALSA);
    });

    it('7 · la búsqueda sigue devolviendo los mismos viajes y campos que antes', async () => {
      const res = await buscar();
      assert.equal(res.status, 200);
      const viaje = (res.body.data as Array<Record<string, unknown>>).find((v) => v.id === ctx.fixtures.tripA)!;
      for (const campo of [
        'id', 'departure_datetime', 'arrival_datetime', 'base_price', 'status', 'route_id',
        'origin_city', 'origin_terminal', 'destination_city', 'destination_terminal',
        'company_id', 'company_name', 'bus_id', 'capacity', 'amenities', 'bus_type_name',
        'company_rating', 'company_reviews', 'seats_available',
      ]) {
        assert.ok(campo in viaje, `falta ${campo} en la respuesta`);
      }
      assert.ok(res.body.pagination, 'la paginación sigue ahí');
    });
  });

  // =====================================================================
  describe('H-04 · informe de ocupación', () => {
    const ocupacion = async () => {
      const res = await get('/reports/occupancy', ctx.sessions.admin.token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body.data.rows as Array<{ label: string; trips: number; capacity: number; seats_sold: number }>;
    };

    it('8 · la capacidad del informe sale de la versión del viaje', async () => {
      const filas = await ocupacion();
      assert.ok(filas.length > 0, 'el informe debe devolver filas');
      for (const fila of filas) {
        assert.notEqual(Number(fila.capacity), CAPACIDAD_FALSA, 'ninguna fila puede traer la caché del bus');
      }
    });

    it('9 · con VARIAS reservas, la capacidad de la fila no se multiplica por cada una', async () => {
      // El informe lleva un `LEFT JOIN bookings` y agrupa por viaje: con dos reservas hay dos
      // filas por viaje, y una suma ingenua devolveria la capacidad dos veces. Por eso se
      // venden dos reservas SEPARADAS y no dos asientos en una sola.
      await vender(1);
      await vender(1);
      const reservas = Number(
        (await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM bookings WHERE trip_id = ?', [ctx.fixtures.tripA]))?.n ?? 0,
      );
      assert.equal(reservas, 2, 'la prueba necesita dos reservas distintas');

      const filas = await ocupacion();

      // Todas las filas del bus A deben valer exactamente la capacidad de su versión: ni la
      // del bus, ni esa cifra repetida una vez por reserva.
      const conVentas = filas.filter((fila) => Number(fila.seats_sold) > 0);
      assert.ok(conVentas.length > 0, 'debería haber al menos una fila con ventas');
      for (const fila of conVentas) {
        assert.equal(Number(fila.capacity), asientosA, `la fila «${fila.label}» descuadra`);
      }
    });

    it('10 · el porcentaje de ocupación resultante es el correcto', async () => {
      await vender(3);
      const fila = (await ocupacion()).find((f) => Number(f.seats_sold) > 0)!;
      const porcentaje = Math.round((Number(fila.seats_sold) / Number(fila.capacity)) * 100);
      assert.equal(Number(fila.seats_sold), 3);
      assert.equal(Number(fila.capacity), asientosA);
      assert.equal(porcentaje, Math.round((3 / asientosA) * 100));
    });

    it('11 · dos viajes del mismo bus con versiones distintas se tratan por separado', async () => {
      const nuevoLayout = await publicarOtraVersion(5);
      await execute(
        `INSERT INTO trips (route_id, bus_id, bus_layout_id, departure_datetime, arrival_datetime, base_price, available_seats, status)
         SELECT route_id, bus_id, ?, DATE_ADD(departure_datetime, INTERVAL 4 DAY), DATE_ADD(arrival_datetime, INTERVAL 4 DAY),
                base_price, 5, 'SCHEDULED'
         FROM trips WHERE id = ?`,
        [nuevoLayout, ctx.fixtures.tripA],
      );

      const capacidades = new Set((await ocupacion()).map((fila) => Number(fila.capacity)));
      assert.ok(capacidades.has(asientosA), 'la del viaje viejo');
      assert.ok(capacidades.has(5), 'la del viaje nuevo');
      assert.equal(capacidades.has(CAPACIDAD_FALSA), false);
    });

    it('12 · un viaje histórico conserva su capacidad aunque el bus publique otra versión', async () => {
      await vender(1);
      const antes = (await ocupacion()).find((f) => Number(f.seats_sold) > 0)!;
      await publicarOtraVersion(5);
      const despues = (await ocupacion()).find((f) => Number(f.seats_sold) > 0)!;

      assert.equal(Number(despues.capacity), Number(antes.capacity));
      assert.equal(Number(despues.capacity), asientosA);
    });

    it('13 · el resto del informe no cambia: mismas columnas, filtros y alcance', async () => {
      // El rango de fechas del informe filtra por `bk.created_at`, de modo que sin ninguna
      // reserva no devuelve filas. Es su comportamiento de siempre y no se ha tocado.
      await vender(1);
      const res = await get('/reports/occupancy?from=2000-01-01&to=2100-01-01', ctx.sessions.admin.token);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.report, 'occupancy');
      const fila = res.body.data.rows[0];
      assert.deepEqual(Object.keys(fila).sort(), ['capacity', 'label', 'seats_sold', 'trips'].sort());

      // La empresa sigue viendo solo lo suyo.
      const empresa = await get('/reports/occupancy', ctx.sessions.companyAdmin.token);
      assert.equal(empresa.status, 200);
      const etiquetas = (empresa.body.data.rows as Array<{ label: string }>).map((f) => f.label);
      assert.equal(etiquetas.some((e) => e.includes('Arequipa')), false, 'no asoma la ruta de la otra empresa');

      // Los demás informes siguen respondiendo.
      for (const informe of ['sales-by-route', 'sales-by-bus', 'payment-methods']) {
        assert.equal((await get(`/reports/${informe}`, ctx.sessions.admin.token)).status, 200, informe);
      }
    });
  });

  // =====================================================================
  describe('H-14 · panel, listado de viajes e integración', () => {
    it('14 · el listado de viajes del portal usa la capacidad de la versión', async () => {
      const res = await get(`/trips?limit=100`, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200);
      const viaje = (res.body.data as Array<{ id: number; capacity: number }>).find((v) => v.id === ctx.fixtures.tripA);
      assert.equal(Number(viaje?.capacity), asientosA);
      assert.notEqual(Number(viaje?.capacity), CAPACIDAD_FALSA);
    });

    it('15 · la ficha de un viaje concreto también', async () => {
      const res = await get(`/trips/${ctx.fixtures.tripA}`, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200);
      assert.equal(Number(res.body.data.capacity), asientosA);
    });

    it('16 · el panel de la empresa muestra vendidos sobre la capacidad del viaje', async () => {
      await vender(2);
      const res = await get('/dashboard/company', ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200);

      const proximos = res.body.data.upcoming_trips ?? res.body.data.upcomingTrips;
      assert.ok(Array.isArray(proximos), `no se encontró la lista de próximos viajes: ${Object.keys(res.body.data)}`);
      const viaje = (proximos as Array<{ id: number; capacity: number; seats_sold: number }>).find(
        (v) => v.id === ctx.fixtures.tripA,
      );
      assert.ok(viaje, 'el viaje debe estar entre los próximos');
      assert.equal(Number(viaje.capacity), asientosA);
      assert.equal(Number(viaje.seats_sold), 2);
    });

    it('17 · la API de integración publica la capacidad del viaje en su listado', async () => {
      const clave = await post(
        '/api-keys',
        { name: 'Integración capacidad', company_id: ctx.fixtures.companyA },
        ctx.sessions.admin.token,
      );
      assert.equal(clave.status, 201);

      const res = await getWithKey('/integration/v1/trips?limit=100', clave.body.data.plain_key);
      assert.equal(res.status, 200);
      const viaje = (res.body.data as Array<{ id: number; capacity: number }>).find((v) => v.id === ctx.fixtures.tripA);
      assert.equal(Number(viaje?.capacity), asientosA);
      assert.notEqual(Number(viaje?.capacity), CAPACIDAD_FALSA);
    });

    it('18 · `availability` de integración sigue contando asientos, sin tocarse', async () => {
      const clave = await post(
        '/api-keys',
        { name: 'Integración availability', company_id: ctx.fixtures.companyA },
        ctx.sessions.admin.token,
      );
      const res = await getWithKey(`/integration/v1/trips/${ctx.fixtures.tripA}/availability`, clave.body.data.plain_key);
      assert.equal(res.status, 200);
      assert.equal(Number(res.body.data.capacity), asientosA, 'sigue siendo el número de asientos del mapa');
      assert.equal(res.body.data.seats.length, asientosA);
    });

    it('19 · publicar otra versión no altera lo que el panel y el listado dicen del viaje viejo', async () => {
      await publicarOtraVersion(5);

      const listado = await get('/trips?limit=100', ctx.sessions.companyAdmin.token);
      const viaje = (listado.body.data as Array<{ id: number; capacity: number }>).find((v) => v.id === ctx.fixtures.tripA);
      assert.equal(Number(viaje?.capacity), asientosA);

      const ficha = await get(`/trips/${ctx.fixtures.tripA}`, ctx.sessions.companyAdmin.token);
      assert.equal(Number(ficha.body.data.capacity), asientosA);
    });

    it('20 · la capacidad ACTUAL del bus se sigue leyendo de `buses.capacity`', async () => {
      // Este es el otro lado de la regla: el listado de flota describe el bus de hoy, no un
      // viaje, así que ahí la caché del bus es la fuente correcta y NO se ha tocado.
      const res = await get('/buses?limit=50', ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200);
      const bus = (res.body.data as Array<{ id: number; capacity: number; seats_count: number }>).find(
        (b) => b.id === ctx.fixtures.busA,
      );
      assert.equal(Number(bus?.capacity), CAPACIDAD_FALSA, 'la ficha del bus sigue mostrando su propia capacidad');
      assert.equal(Number(bus?.seats_count), asientosA, 'y `seats_count` sigue contando la versión publicada');
    });

    it('21 · el mapa de asientos y la geometría siguen intactos', async () => {
      const mapa = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);
      assert.equal(mapa.status, 200);
      assert.equal(mapa.body.data.length, asientosA);

      const geometria = await get(`/public/trips/${ctx.fixtures.tripA}/layout`);
      assert.equal(geometria.status, 200);
      assert.equal(geometria.body.data.layout_id, ctx.fixtures.layoutA);
    });
  });

  // =====================================================================
  describe('Una sola definición de capacidad', () => {
    it('22 · el ciclo de reservas sigue usando el mismo tope, sin sobrepasarlo', async () => {
      const ids = await vender(2);
      const reserva = await queryOne<{ id: number }>('SELECT id FROM bookings WHERE trip_id = ? ORDER BY id DESC LIMIT 1', [
        ctx.fixtures.tripA,
      ]);

      await post(`/bookings/${reserva?.id}/cancel`, {}, ctx.sessions.customer.token);

      const viaje = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [
        ctx.fixtures.tripA,
      ]);
      assert.ok(
        Number(viaje?.available_seats) <= asientosA,
        `la devolución no puede pasar del tope de la versión: ${viaje?.available_seats} > ${asientosA}`,
      );
      assert.equal(ids.length, 2);
    });

    it('23 · la búsqueda y el mapa coinciden en cuántos asientos quedan libres', async () => {
      await vender(3);
      const viaje = await viajeEnBusqueda();
      const mapa = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);
      const libres = (mapa.body.data as Array<{ is_taken: number; status: string }>).filter(
        (asiento) => asiento.is_taken === 0 && asiento.status === 'AVAILABLE',
      ).length;

      assert.equal(Number(viaje?.seats_available), libres);
    });

    it('24 · ninguna respuesta de viaje trae ya la capacidad del bus cuando hay versión', async () => {
      const respuestas = await Promise.all([
        buscar(),
        get(`/public/trips/${ctx.fixtures.tripA}`),
        get('/trips?limit=100', ctx.sessions.companyAdmin.token),
        get(`/trips/${ctx.fixtures.tripA}`, ctx.sessions.companyAdmin.token),
        get('/reports/occupancy', ctx.sessions.admin.token),
      ]);

      for (const [indice, res] of respuestas.entries()) {
        assert.equal(res.status, 200, `respuesta ${indice}`);
        const texto = JSON.stringify(res.body.data);
        assert.equal(
          texto.includes(`"capacity":${CAPACIDAD_FALSA}`) || texto.includes(`"capacity":"${CAPACIDAD_FALSA}"`),
          false,
          `la respuesta ${indice} todavía trae la capacidad del bus`,
        );
      }
    });
  });
});
