import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { get, getWithKey, post } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, createBusLayout, createLayoutElement } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';
import { seatMap } from '../services/trip.service';

/**
 * `GET /public/trips/:id/layout` · la forma del bus que le toca a un viaje.
 *
 * POR QUÉ EXISTE APARTE. El mapa público de asientos —y con él la `capacity` que lee la API
 * de integración— es la lista de lo que se puede vender. Un baño no se vende. Meterlo en esa
 * lista le habría sumado un pasajero inexistente a todos los integradores, así que la
 * geometría se publica por su propia puerta y `seatMap` sigue siendo solo asientos.
 *
 * LO QUE MÁS IMPORTA AQUÍ. Que la versión que devuelve sea la del VIAJE y no la vigente del
 * bus: alguien que compró sobre la v1 tiene que seguir viendo la v1 cuando la empresa ya va
 * por la v2. Y que, siendo público, no filtre nada de la empresa ni acepte que le digan qué
 * distribución enseñar.
 */
describe('Geometría pública de la distribución del viaje', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  /** Deja bus y viaje de los fixtures en su v1, borrando lo que cada prueba haya creado. */
  beforeEach(async () => {
    await execute('UPDATE trips SET bus_layout_id = ? WHERE bus_id = ?', [ctx.fixtures.layoutA, ctx.fixtures.busA]);
    await execute('DELETE FROM bus_layout_elements');
    await execute('DELETE FROM seats WHERE layout_id NOT IN (?, ?)', [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
    await execute('DELETE FROM bus_layouts WHERE id NOT IN (?, ?)', [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
    await execute("UPDATE bus_layouts SET status = 'PUBLISHED' WHERE id IN (?, ?)", [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
    await execute('UPDATE bus_layout_decks SET row_count = 3, column_count = 4 WHERE layout_id = ?', [ctx.fixtures.layoutA]);
  });

  const pedirLayout = () => get(`/public/trips/${ctx.fixtures.tripA}/layout`);

  describe('El endpoint responde y trae la geometría', () => {
    it('1 · responde 200 sin ninguna credencial', async () => {
      const res = await pedirLayout();
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
    });

    it('2 · devuelve la versión a la que está anclado el viaje', async () => {
      const res = await pedirLayout();
      assert.equal(res.body.data.layout_id, ctx.fixtures.layoutA);
      assert.equal(res.body.data.version, 1);
      assert.equal(res.body.data.status, 'PUBLISHED');
    });

    it('3 · la versión sale de trips.bus_layout_id, no de la publicada del bus', async () => {
      // El viaje se ancla a una versión ARCHIVADA mientras el bus conserva otra publicada.
      const otra = await createBusLayout(ctx.fixtures.busA, { version: 9, status: 'ARCHIVED', rows: 7, columns: 2 });
      await execute('UPDATE trips SET bus_layout_id = ? WHERE id = ?', [otra.layoutId, ctx.fixtures.tripA]);

      const res = await pedirLayout();
      assert.equal(res.body.data.layout_id, otra.layoutId, 'manda la del viaje');
      assert.equal(res.body.data.version, 9);
      assert.equal(res.body.data.status, 'ARCHIVED', 'una versión archivada se sigue pudiendo dibujar');
    });

    it('4 · publicar una versión nueva NO cambia el mapa de un viaje ya vendido', async () => {
      // v1 publicada con el viaje encima; llega la v2 y releva a la v1.
      const v2 = await createBusLayout(ctx.fixtures.busA, { version: 2, status: 'DRAFT', rows: 12, columns: 4 });
      await execute("UPDATE bus_layouts SET status = 'ARCHIVED' WHERE id = ?", [ctx.fixtures.layoutA]);
      await execute("UPDATE bus_layouts SET status = 'PUBLISHED', published_at = NOW() WHERE id = ?", [v2.layoutId]);

      const res = await pedirLayout();
      assert.equal(res.body.data.layout_id, ctx.fixtures.layoutA, 'sigue siendo la v1, la que compró el pasajero');
      assert.notEqual(res.body.data.layout_id, v2.layoutId);
      assert.equal(at<{ row_count: number }>(res.body.data.decks, 0).row_count, 3, 'y con la rejilla de la v1, no la de la v2');
    });

    it('5 · un viaje sin versión propia cae a la publicada del bus', async () => {
      await execute('UPDATE trips SET bus_layout_id = NULL WHERE id = ?', [ctx.fixtures.tripA]);

      const res = await pedirLayout();
      assert.equal(res.status, 200);
      assert.equal(res.body.data.layout_id, ctx.fixtures.layoutA, 'la publicada del bus, la red de transición');
    });

    it('6 · sin versión propia y sin publicada, el error es de negocio y no una excepción SQL', async () => {
      await execute('UPDATE trips SET bus_layout_id = NULL WHERE id = ?', [ctx.fixtures.tripA]);
      await execute("UPDATE bus_layouts SET status = 'ARCHIVED' WHERE id = ?", [ctx.fixtures.layoutA]);

      const res = await pedirLayout();
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /distribución/i);
      assert.equal(JSON.stringify(res.body).toLowerCase().includes('select'), false, 'nada de SQL en la respuesta');
    });

    it('7 · un viaje inexistente responde 404', async () => {
      assert.equal((await get('/public/trips/99999999/layout')).status, 404);
      assert.equal((await get('/public/trips/no-es-un-numero/layout')).status, 404);
    });
  });

  describe('Pisos', () => {
    it('8 · devuelve los pisos con su identificador, número y nombre', async () => {
      const res = await pedirLayout();
      const pisos = res.body.data.decks;
      assert.equal(pisos.length, 1);
      assert.equal(at<{ deck_number: number }>(pisos, 0).deck_number, 1);
      assert.equal(at<{ id: number }>(pisos, 0).id, ctx.fixtures.deckA);
      assert.ok('name' in at<Record<string, unknown>>(pisos, 0));
    });

    it('9 · devuelve row_count tal como lo declaró la empresa', async () => {
      await execute('UPDATE bus_layout_decks SET row_count = 10 WHERE id = ?', [ctx.fixtures.deckA]);
      assert.equal(at<{ row_count: number }>((await pedirLayout()).body.data.decks, 0).row_count, 10);
    });

    it('10 · devuelve column_count tal como lo declaró la empresa', async () => {
      await execute('UPDATE bus_layout_decks SET column_count = 5 WHERE id = ?', [ctx.fixtures.deckA]);
      assert.equal(at<{ column_count: number }>((await pedirLayout()).body.data.decks, 0).column_count, 5);
    });

    it('11 · la rejilla NO se deduce de los asientos: conserva las filas vacías a propósito', async () => {
      // Los asientos de los fixtures llegan a la fila 3; el piso declara 10.
      await execute('UPDATE bus_layout_decks SET row_count = 10, column_count = 6 WHERE id = ?', [ctx.fixtures.deckA]);
      const maximos = await queryOne<{ f: number; c: number }>(
        'SELECT MAX(`row_number`) AS f, MAX(column_number) AS c FROM seats WHERE layout_id = ?',
        [ctx.fixtures.layoutA],
      );
      assert.ok(Number(maximos?.f) < 10 && Number(maximos?.c) < 6, 'los asientos no llegan al borde');

      const piso = at<{ row_count: number; column_count: number }>((await pedirLayout()).body.data.decks, 0);
      assert.equal(piso.row_count, 10);
      assert.equal(piso.column_count, 6);
    });

    it('12 · un bus de dos pisos devuelve los dos, ordenados', async () => {
      const dos = await createBusLayout(ctx.fixtures.busA, { version: 5, status: 'ARCHIVED', decks: 2, rows: 4, columns: 4 });
      await execute('UPDATE trips SET bus_layout_id = ? WHERE id = ?', [dos.layoutId, ctx.fixtures.tripA]);

      const pisos = (await pedirLayout()).body.data.decks;
      assert.equal(pisos.length, 2);
      assert.deepEqual(pisos.map((piso: { deck_number: number }) => piso.deck_number), [1, 2]);
    });
  });

  describe('Elementos físicos', () => {
    /** Coloca los cinco tipos en el piso de los fixtures. */
    async function colocarLosCinco(): Promise<void> {
      await createLayoutElement(ctx.fixtures.deckA, 'BATHROOM', 8, 1, 'Baño');
      await createLayoutElement(ctx.fixtures.deckA, 'STAIRS', 8, 2);
      await createLayoutElement(ctx.fixtures.deckA, 'DRIVER', 9, 1);
      await createLayoutElement(ctx.fixtures.deckA, 'DOOR', 9, 2);
      await createLayoutElement(ctx.fixtures.deckA, 'EMPTY', 9, 3);
    }

    it('13 · devuelve los cinco tipos, sin filtrar ninguno', async () => {
      await colocarLosCinco();
      const elementos = at<{ elements: Array<{ element_type: string }> }>((await pedirLayout()).body.data.decks, 0).elements;
      const tipos = elementos.map((elemento) => elemento.element_type).sort();
      assert.deepEqual(tipos, ['BATHROOM', 'DOOR', 'DRIVER', 'EMPTY', 'STAIRS']);
    });

    it('14 · cada elemento trae su posición, su extensión y su etiqueta', async () => {
      await execute(
        `INSERT INTO bus_layout_elements (deck_id, element_type, \`row_number\`, column_number, row_span, col_span, label)
         VALUES (?, 'BATHROOM', 2, 4, 2, 1, 'Baño')`,
        [ctx.fixtures.deckA],
      );

      const elemento = at<{ elements: Array<Record<string, unknown>> }>((await pedirLayout()).body.data.decks, 0).elements[0]!;
      assert.equal(elemento.element_type, 'BATHROOM');
      assert.equal(elemento.row_number, 2);
      assert.equal(elemento.column_number, 4);
      assert.equal(elemento.row_span, 2, 'la extensión vertical llega al cliente');
      assert.equal(elemento.col_span, 1);
      assert.equal(elemento.label, 'Baño');
      assert.ok('id' in elemento);
    });

    it('15 · un elemento 2×2 conserva sus dos extensiones', async () => {
      await execute(
        `INSERT INTO bus_layout_elements (deck_id, element_type, \`row_number\`, column_number, row_span, col_span)
         VALUES (?, 'STAIRS', 5, 2, 2, 2)`,
        [ctx.fixtures.deckA],
      );

      const elemento = at<{ elements: Array<{ row_span: number; col_span: number }> }>((await pedirLayout()).body.data.decks, 0).elements[0]!;
      assert.equal(elemento.row_span, 2);
      assert.equal(elemento.col_span, 2);
    });

    it('16 · los elementos van en su propio piso y no se mezclan', async () => {
      const dos = await createBusLayout(ctx.fixtures.busA, { version: 6, status: 'ARCHIVED', decks: 2, rows: 4, columns: 4 });
      await execute('UPDATE trips SET bus_layout_id = ? WHERE id = ?', [dos.layoutId, ctx.fixtures.tripA]);
      await createLayoutElement(at(dos.deckIds, 0), 'BATHROOM', 1, 1);
      await createLayoutElement(at(dos.deckIds, 1), 'STAIRS', 2, 2);

      const pisos = (await pedirLayout()).body.data.decks as Array<{ elements: Array<{ element_type: string }> }>;
      assert.deepEqual(at(pisos, 0).elements.map((elemento) => elemento.element_type), ['BATHROOM']);
      assert.deepEqual(at(pisos, 1).elements.map((elemento) => elemento.element_type), ['STAIRS']);
    });

    it('17 · un piso sin elementos devuelve una lista vacía, no null', async () => {
      const elementos = at<{ elements: unknown }>((await pedirLayout()).body.data.decks, 0).elements;
      assert.deepEqual(elementos, []);
    });
  });

  describe('Lo que este endpoint NO hace', () => {
    it('18 · no devuelve asientos', async () => {
      const cuerpo = (await pedirLayout()).body.data;
      assert.equal('seats' in cuerpo, false);
      assert.equal(JSON.stringify(cuerpo).includes('seat_number'), false);
      const piso = at<Record<string, unknown>>(cuerpo.decks, 0);
      assert.equal('seats' in piso, false);
    });

    it('19 · no devuelve precios', async () => {
      const texto = JSON.stringify((await pedirLayout()).body.data);
      for (const campo of ['price', 'base_price', 'subtotal', 'total']) {
        assert.equal(texto.includes(campo), false, `no debe asomar ${campo}`);
      }
    });

    it('20 · no expone datos de la empresa ni internos del bus', async () => {
      const texto = JSON.stringify((await pedirLayout()).body).toLowerCase();
      for (const campo of ['company_id', 'company_name', 'bus_id', 'plate_number', 'user', 'password', 'ruc']) {
        assert.equal(texto.includes(campo), false, `no debe asomar ${campo}`);
      }
    });

    it('21 · no acepta que le digan qué distribución enseñar', async () => {
      const ajena = await createBusLayout(ctx.fixtures.busB, { version: 4, status: 'ARCHIVED', rows: 9, columns: 9 });

      for (const sufijo of [`?layout_id=${ajena.layoutId}`, `?layout=${ajena.layoutId}`, `?bus_layout_id=${ajena.layoutId}`]) {
        const res = await get(`/public/trips/${ctx.fixtures.tripA}/layout${sufijo}`);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.layout_id, ctx.fixtures.layoutA, `el parámetro ${sufijo} no debe mandar`);
      }
    });

    it('22 · un viaje de otra empresa devuelve SU layout, no el del primero', async () => {
      const res = await get(`/public/trips/${ctx.fixtures.tripB}/layout`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.layout_id, ctx.fixtures.layoutB);
    });
  });

  describe('Regresión: lo de antes sigue exactamente igual', () => {
    it('23 · el mapa público de asientos no devuelve elementos', async () => {
      await createLayoutElement(ctx.fixtures.deckA, 'BATHROOM', 8, 1);
      await createLayoutElement(ctx.fixtures.deckA, 'STAIRS', 8, 2);

      const res = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);
      assert.equal(res.status, 200);
      assert.equal(JSON.stringify(res.body.data).includes('element_type'), false);
      assert.equal(res.body.data.length, 12, 'los doce asientos de los fixtures, ni uno más');
    });

    it('24 · `seatMap` sigue contando solo asientos aunque el piso tenga elementos', async () => {
      const antes = (await seatMap(ctx.fixtures.tripA)).length;
      await createLayoutElement(ctx.fixtures.deckA, 'BATHROOM', 8, 1);
      await createLayoutElement(ctx.fixtures.deckA, 'DRIVER', 8, 2);

      assert.equal((await seatMap(ctx.fixtures.tripA)).length, antes, 'la longitud es la capacidad: no puede crecer');
    });

    it('25 · la API de integración mantiene capacity = número de asientos', async () => {
      await createLayoutElement(ctx.fixtures.deckA, 'BATHROOM', 8, 1);
      await createLayoutElement(ctx.fixtures.deckA, 'STAIRS', 8, 2);
      await createLayoutElement(ctx.fixtures.deckA, 'DOOR', 8, 3);

      const clave = await post(
        '/api-keys',
        { name: 'Integración geometría', company_id: ctx.fixtures.companyA },
        ctx.sessions.admin.token,
      );
      assert.equal(clave.status, 201);

      const res = await getWithKey(`/integration/v1/trips/${ctx.fixtures.tripA}/availability`, clave.body.data.plain_key);
      assert.equal(res.status, 200);
      const asientos = await query<{ total: number }>('SELECT COUNT(*) AS total FROM seats WHERE layout_id = ?', [ctx.fixtures.layoutA]);
      assert.equal(Number(res.body.data.capacity), Number(at(asientos, 0).total), 'tres elementos no suman tres pasajeros');
      assert.equal(JSON.stringify(res.body.data).includes('element_type'), false);
    });

    it('26 · la geometría no exige sesión y el resto de lo público tampoco cambió', async () => {
      assert.equal((await get(`/public/trips/${ctx.fixtures.tripA}`)).status, 200);
      assert.equal((await get(`/public/trips/${ctx.fixtures.tripA}/seats`)).status, 200);
      assert.equal((await pedirLayout()).status, 200);
    });
  });
});
