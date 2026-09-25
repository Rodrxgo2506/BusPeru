import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { get, getWithKey, post } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { createBusLayout, createLayoutElement, setSeatTypePrice, syncLayoutSeatCount } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';
import { getLayoutTree, getPublishedLayout, hasTrips, resolveTripLayoutId } from '../services/bus-layout.service';
import { seatMap } from '../services/trip.service';

/**
 * Migración 010 · lectura de la distribución versionada del bus.
 *
 * QUÉ SE PRUEBA AQUÍ. Que el mapa de asientos de un viaje sale de la VERSIÓN que ese viaje
 * tiene congelada y no del bus, y que esa lista contiene asientos y nada más que asientos.
 *
 * POR QUÉ IMPORTA LO SEGUNDO. `seatMap` alimenta también
 * `GET /integration/v1/trips/:id/availability`, que publica `capacity: seats.length` a
 * sistemas de terceros. Un baño colado en esa lista le sumaría un pasajero inexistente a la
 * capacidad de todos los integradores, de forma silenciosa. Por eso hay una prueba por cada
 * tipo de elemento en vez de una sola genérica: si mañana alguien añade un `JOIN` de más,
 * la prueba dice exactamente cuál se coló.
 *
 * Lo que NO se prueba todavía, porque no está implementado: el subtotal por precio efectivo,
 * el tope de devolución por versión y el copy-on-write.
 */
describe('Distribución versionada del bus (migración 010)', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  beforeEach(async () => {
    // Se limpia lo que cada prueba añade; los fixtures base se reconstruyen entre archivos.
    await execute('DELETE FROM trip_seat_type_prices');
    await execute('DELETE FROM bus_layout_elements');
  });

  describe('Los fixtures representan el modelo 010', () => {
    it('1 · cada bus de prueba tiene una versión PUBLISHED con su piso', async () => {
      for (const busId of [ctx.fixtures.busA, ctx.fixtures.busB]) {
        const publicada = await getPublishedLayout(busId);
        assert.ok(publicada, `el bus ${busId} no tiene versión publicada`);
        assert.equal(publicada.status, 'PUBLISHED');
        assert.equal(publicada.version, 1);

        const pisos = await query('SELECT id FROM bus_layout_decks WHERE layout_id = ?', [publicada.id]);
        assert.equal(pisos.length, 1, 'se esperaba un piso inicial');
      }
    });

    it('2 · ningún asiento de prueba quedó sin versión ni sin piso', async () => {
      const huerfanos = await queryOne<{ total: number }>(
        'SELECT COUNT(*) AS total FROM seats WHERE layout_id IS NULL OR deck_id IS NULL',
      );
      assert.equal(Number(huerfanos?.total), 0);
    });

    it('3 · los viajes de los fixtures están anclados a la versión de su bus', async () => {
      const sinVersion = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM trips WHERE bus_layout_id IS NULL');
      assert.equal(Number(sinVersion?.total), 0);

      const desviados = await queryOne<{ total: number }>(
        `SELECT COUNT(*) AS total FROM trips t
         JOIN bus_layouts bl ON bl.id = t.bus_layout_id
         WHERE bl.bus_id <> t.bus_id`,
      );
      assert.equal(Number(desviados?.total), 0, 'un viaje apunta a la versión de otro bus');
    });

    it('4 · `seat_count` de la versión coincide con sus asientos reales', async () => {
      const publicada = await getPublishedLayout(ctx.fixtures.busA);
      const reales = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM seats WHERE layout_id = ?', [publicada!.id]);
      assert.equal(publicada!.seat_count, Number(reales?.total));
    });
  });

  describe('Qué versión le toca a un viaje', () => {
    it('5 · un viaje con versión propia usa exactamente esa', async () => {
      const resuelta = await resolveTripLayoutId(ctx.fixtures.tripA);
      assert.equal(resuelta, ctx.fixtures.layoutA);
    });

    it('6 · sin versión propia cae a la publicada del bus', async () => {
      await execute('UPDATE trips SET bus_layout_id = NULL WHERE id = ?', [ctx.fixtures.tripA]);
      try {
        const resuelta = await resolveTripLayoutId(ctx.fixtures.tripA);
        assert.equal(resuelta, ctx.fixtures.layoutA, 'la red de transición debe dar la versión publicada');
      } finally {
        await execute('UPDATE trips SET bus_layout_id = ? WHERE id = ?', [ctx.fixtures.layoutA, ctx.fixtures.tripA]);
      }
    });

    it('7 · sin versión propia NI publicada devuelve un error controlado, no un fallo SQL', async () => {
      // Se archiva la publicada para dejar al bus sin ninguna vigente.
      await execute('UPDATE trips SET bus_layout_id = NULL WHERE id = ?', [ctx.fixtures.tripA]);
      await execute("UPDATE bus_layouts SET status = 'ARCHIVED' WHERE id = ?", [ctx.fixtures.layoutA]);
      try {
        await assert.rejects(
          () => resolveTripLayoutId(ctx.fixtures.tripA),
          (error: unknown) => {
            const fallo = error as { statusCode?: number; message?: string };
            assert.equal(fallo.statusCode, 400, 'debe ser un error de negocio, no una excepción cruda');
            assert.match(String(fallo.message), /distribución/i);
            return true;
          },
        );
      } finally {
        await execute("UPDATE bus_layouts SET status = 'PUBLISHED' WHERE id = ?", [ctx.fixtures.layoutA]);
        await execute('UPDATE trips SET bus_layout_id = ? WHERE id = ?', [ctx.fixtures.layoutA, ctx.fixtures.tripA]);
      }
    });

    it('8 · un viaje inexistente responde 404', async () => {
      await assert.rejects(() => resolveTripLayoutId(999999), (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 404);
        return true;
      });
    });

    it('9 · `hasTrips` distingue una versión en uso de una libre', async () => {
      assert.equal(await hasTrips(ctx.fixtures.layoutA), true, 'la v1 de A la usan viajes de los fixtures');

      const libre = await createBusLayout(ctx.fixtures.busA, { version: 2, status: 'DRAFT' });
      try {
        assert.equal(await hasTrips(libre.layoutId), false);
      } finally {
        await execute('DELETE FROM bus_layouts WHERE id = ?', [libre.layoutId]);
      }
    });
  });

  describe('El mapa de asientos solo contiene asientos', () => {
    /** Coloca un elemento de cada tipo en el piso del viaje A. */
    async function poblarElementos() {
      const tipos = ['BATHROOM', 'STAIRS', 'DRIVER', 'DOOR', 'EMPTY'] as const;
      let fila = 20;
      for (const tipo of tipos) {
        await createLayoutElement(ctx.fixtures.deckA, tipo, fila, 1, tipo);
        fila += 1;
      }
    }

    it('10 · el número de asientos no cambia al añadir elementos al piso', async () => {
      const antes = await seatMap(ctx.fixtures.tripA);
      await poblarElementos();
      const despues = await seatMap(ctx.fixtures.tripA);

      assert.equal(despues.length, antes.length, 'un baño o una escalera no son plazas');
      assert.equal(despues.length, ctx.fixtures.seatsA.length);
    });

    for (const tipo of ['BATHROOM', 'STAIRS', 'DRIVER', 'DOOR', 'EMPTY'] as const) {
      it(`11 · el mapa no devuelve ningún ${tipo}`, async () => {
        await createLayoutElement(ctx.fixtures.deckA, tipo, 30, 1, tipo);
        const mapa = await seatMap(ctx.fixtures.tripA);

        // Ni por su etiqueta ni por su identificador: un elemento no tiene número de asiento.
        assert.ok(!mapa.some((asiento) => asiento.seat_number === tipo));
        const idsDeAsientos = new Set(ctx.fixtures.seatsA);
        assert.ok(mapa.every((asiento) => idsDeAsientos.has(asiento.id)), 'se coló una fila que no es un asiento');
      });
    }

    it('12 · cada asiento trae el piso al que pertenece', async () => {
      const mapa = await seatMap(ctx.fixtures.tripA);

      assert.ok(mapa.length > 0);
      assert.ok(mapa.every((asiento) => asiento.deck_id === ctx.fixtures.deckA));
      assert.ok(mapa.every((asiento) => Number(asiento.deck_number) === 1));
    });

    it('13 · el mapa sale de la versión del viaje, no del bus', async () => {
      // Una segunda versión con un solo asiento. El viaje sigue anclado a la primera, así
      // que su mapa no puede cambiar: eso es lo que protege el histórico.
      const otra = await createBusLayout(ctx.fixtures.busA, { version: 3, status: 'DRAFT', rows: 1, columns: 1 });
      const deckOtra = otra.deckIds[0]!;
      await execute(
        `INSERT INTO seats (bus_id, layout_id, deck_id, seat_type_id, seat_number, \`row_number\`, column_number, is_window, is_aisle, status)
         VALUES (?, ?, ?, NULL, 'X1', 1, 1, 0, 0, 'AVAILABLE')`,
        [ctx.fixtures.busA, otra.layoutId, deckOtra],
      );
      try {
        const mapa = await seatMap(ctx.fixtures.tripA);
        assert.equal(mapa.length, ctx.fixtures.seatsA.length, 'la versión nueva no debe afectar al viaje ya creado');
        assert.ok(!mapa.some((asiento) => asiento.seat_number === 'X1'));

        // Y si el viaje se moviera a la otra versión, vería la otra distribución.
        await execute('UPDATE trips SET bus_layout_id = ? WHERE id = ?', [otra.layoutId, ctx.fixtures.tripA]);
        const otroMapa = await seatMap(ctx.fixtures.tripA);
        assert.equal(otroMapa.length, 1);
        assert.equal(otroMapa[0]!.seat_number, 'X1');
      } finally {
        await execute('UPDATE trips SET bus_layout_id = ? WHERE id = ?', [ctx.fixtures.layoutA, ctx.fixtures.tripA]);
        await execute('DELETE FROM seats WHERE layout_id = ?', [otra.layoutId]);
        await execute('DELETE FROM bus_layouts WHERE id = ?', [otra.layoutId]);
      }
    });
  });

  describe('Precio efectivo de cada asiento', () => {
    it('14 · sin precio específico, todos los asientos valen `trips.base_price`', async () => {
      const viaje = await queryOne<{ base_price: string }>('SELECT base_price FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
      const mapa = await seatMap(ctx.fixtures.tripA);

      assert.ok(mapa.every((asiento) => Number(asiento.price) === Number(viaje?.base_price)));
      assert.equal(Number(mapa[0]!.price), 45);
    });

    it('15 · un precio por tipo de asiento solo afecta a los asientos de ese tipo', async () => {
      // El fixture deja un asiento con la categoría «Mujer» y el resto con la del bus.
      const mujer = await queryOne<{ id: number }>("SELECT id FROM seat_types WHERE name = 'Mujer' LIMIT 1");
      assert.ok(mujer, 'falta el tipo de asiento de los fixtures');
      await setSeatTypePrice(ctx.fixtures.tripA, mujer.id, 60);

      const mapa = await seatMap(ctx.fixtures.tripA);
      const conRecargo = mapa.filter((asiento) => asiento.seat_type_name === 'Mujer');
      const resto = mapa.filter((asiento) => asiento.seat_type_name !== 'Mujer');

      assert.ok(conRecargo.length > 0, 'se esperaba al menos un asiento de esa categoría');
      assert.ok(conRecargo.every((asiento) => Number(asiento.price) === 60));
      assert.ok(resto.every((asiento) => Number(asiento.price) === 45), 'el resto no debe cambiar de precio');
    });

    it('16 · el precio es por viaje: el mismo bus puede costar otra cosa en otro viaje', async () => {
      const mujer = await queryOne<{ id: number }>("SELECT id FROM seat_types WHERE name = 'Mujer' LIMIT 1");
      await setSeatTypePrice(ctx.fixtures.tripA, mujer!.id, 60);

      const otroViaje = await queryOne<{ id: number }>(
        'SELECT id FROM trips WHERE bus_id = ? AND id <> ? LIMIT 1',
        [ctx.fixtures.busA, ctx.fixtures.tripA],
      );
      assert.ok(otroViaje, 'los fixtures traen un segundo viaje de la empresa A');

      const mapaOtro = await seatMap(otroViaje.id);
      assert.ok(mapaOtro.every((asiento) => Number(asiento.price) === 45), 'el recargo no debe filtrarse a otro viaje');
    });
  });

  describe('El contrato con los sistemas externos no cambia', () => {
    it('17 · `capacity` de la API de integración sigue siendo el número de asientos', async () => {
      await createLayoutElement(ctx.fixtures.deckA, 'BATHROOM', 40, 1, 'Baño');
      await createLayoutElement(ctx.fixtures.deckA, 'STAIRS', 41, 1, 'Escalera');

      const llave = await post(
        '/api-keys',
        { name: 'Integración layout', company_id: ctx.fixtures.companyA },
        ctx.sessions.admin.token,
      );
      assert.equal(llave.status, 201, JSON.stringify(llave.body));

      const res = await getWithKey(`/integration/v1/trips/${ctx.fixtures.tripA}/availability`, llave.body.data.plain_key);

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.capacity, ctx.fixtures.seatsA.length, 'los elementos no pueden inflar la capacidad');
    });

    it('18 · el mapa público sigue respondiendo y solo trae asientos', async () => {
      await createLayoutElement(ctx.fixtures.deckA, 'DRIVER', 42, 1, 'Conductor');

      const res = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, ctx.fixtures.seatsA.length);
      assert.ok(res.body.data.every((asiento: { seat_number: string }) => asiento.seat_number !== 'Conductor'));
    });
  });

  describe('El árbol de la versión sí incluye los elementos', () => {
    it('19 · `getLayoutTree` devuelve pisos, elementos y asientos por separado', async () => {
      await createLayoutElement(ctx.fixtures.deckA, 'BATHROOM', 50, 4, 'Baño');

      const arbol = await getLayoutTree(ctx.fixtures.layoutA);

      assert.ok(arbol);
      assert.equal(arbol.layout.id, ctx.fixtures.layoutA);
      assert.equal(arbol.decks.length, 1);
      assert.equal(arbol.elements.length, 1);
      assert.equal(arbol.elements[0]!.element_type, 'BATHROOM');
      assert.equal(arbol.seats.length, ctx.fixtures.seatsA.length);
      // La separación es el punto: los elementos jamás viajan dentro de `seats`.
      assert.ok(arbol.seats.every((asiento) => asiento.seat_number !== 'Baño'));
    });

    it('20 · una versión inexistente devuelve null, no una excepción', async () => {
      assert.equal(await getLayoutTree(999999), null);
    });
  });

  describe('Un bus de dos pisos', () => {
    it('21 · los asientos salen ordenados por piso y el mapa distingue cada uno', async () => {
      const dos = await createBusLayout(ctx.fixtures.busA, { version: 4, status: 'DRAFT', decks: 2, rows: 2, columns: 2 });
      const [piso1, piso2] = dos.deckIds;
      assert.ok(piso1 && piso2, 'se pidieron dos pisos y deben existir');
      for (const [deckId, prefijo] of [[piso1!, 'P1'], [piso2!, 'P2']] as const) {
        for (let numero = 1; numero <= 2; numero += 1) {
          await execute(
            `INSERT INTO seats (bus_id, layout_id, deck_id, seat_type_id, seat_number, \`row_number\`, column_number, is_window, is_aisle, status)
             VALUES (?, ?, ?, NULL, ?, 1, ?, 0, 0, 'AVAILABLE')`,
            [ctx.fixtures.busA, dos.layoutId, deckId, `${prefijo}-${numero}`, numero],
          );
        }
      }
      await syncLayoutSeatCount(dos.layoutId);
      await execute('UPDATE trips SET bus_layout_id = ? WHERE id = ?', [dos.layoutId, ctx.fixtures.tripA]);

      try {
        const mapa = await seatMap(ctx.fixtures.tripA);

        assert.equal(mapa.length, 4);
        assert.deepEqual(mapa.map((asiento) => Number(asiento.deck_number)), [1, 1, 2, 2], 'el orden debe agrupar por piso');
        assert.equal(new Set(mapa.map((asiento) => asiento.deck_id)).size, 2);
      } finally {
        await execute('UPDATE trips SET bus_layout_id = ? WHERE id = ?', [ctx.fixtures.layoutA, ctx.fixtures.tripA]);
        await execute('DELETE FROM seats WHERE layout_id = ?', [dos.layoutId]);
        await execute('DELETE FROM bus_layouts WHERE id = ?', [dos.layoutId]);
      }
    });
  });
});
