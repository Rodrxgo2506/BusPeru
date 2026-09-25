import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { get, post } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, createBusLayout } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * H-06 · publicar repasa la geometría entera, no solo la casilla de origen.
 *
 * LO QUE FALTABA. El editor valida cada pieza según se coloca, pero la publicación —el
 * momento en que una versión deja de ser un borrador y pasa a ser el mapa que verá un
 * pasajero y que quedará congelado en los viajes— solo comparaba la casilla de ORIGEN de cada
 * elemento contra los asientos. Con eso, un baño de 2×2 en (2,2) y un asiento en (3,3) se
 * publicaban tan tranquilos aunque estuvieran uno encima del otro; nada miraba si dos
 * elementos se solapaban, ni si alguno se salía de la rejilla por culpa de su extensión.
 *
 * CÓMO SE PRUEBA. Insertando estados geométricamente inválidos DIRECTAMENTE en la base —que
 * es como llegarían de una clonación, de una carga manual o de una versión anterior del
 * código— y comprobando que la publicación los rechaza. Eso es justamente lo que H-06 pide:
 * una validación defensiva que no dé por hecho que todo entró por la puerta principal.
 */
describe('H-06 · la publicación valida la geometría completa', () => {
  let ctx: SuiteContext;
  let layoutId = 0;
  let deckId = 0;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  /** Borrador de 6×6 con un asiento en (1,1), el mínimo para poder publicar. */
  beforeEach(async () => {
    await execute('DELETE FROM seats WHERE layout_id NOT IN (?, ?)', [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
    await execute('DELETE FROM bus_layouts WHERE id NOT IN (?, ?)', [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
    await execute("UPDATE bus_layouts SET status = 'PUBLISHED' WHERE id IN (?, ?)", [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
    await execute('UPDATE buses SET capacity = 12 WHERE id = ?', [ctx.fixtures.busA]);

    const borrador = await createBusLayout(ctx.fixtures.busA, { version: 5, status: 'DRAFT', rows: 6, columns: 6 });
    layoutId = borrador.layoutId;
    deckId = at(borrador.deckIds, 0);
    await ponerAsiento('01', 1, 1);
  });

  /** Inserta un asiento directamente: hace falta para plantear estados que el CRUD prohíbe. */
  async function ponerAsiento(numero: string, fila: number, columna: number, deck = deckId): Promise<number> {
    const creado = await execute(
      `INSERT INTO seats (bus_id, layout_id, deck_id, seat_type_id, seat_number, \`row_number\`, column_number, is_window, is_aisle, status)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 0, 0, 'AVAILABLE')`,
      [ctx.fixtures.busA, layoutId, deck, numero, fila, columna],
    );
    await execute('UPDATE bus_layouts SET seat_count = (SELECT COUNT(*) FROM seats WHERE layout_id = ?) WHERE id = ?', [
      layoutId,
      layoutId,
    ]);
    return creado.insertId;
  }

  /** Inserta un elemento directamente, saltándose el CRUD a propósito. */
  async function ponerElemento(
    tipo: string,
    fila: number,
    columna: number,
    rowSpan = 1,
    colSpan = 1,
    deck = deckId,
  ): Promise<number> {
    const creado = await execute(
      `INSERT INTO bus_layout_elements (deck_id, element_type, \`row_number\`, column_number, row_span, col_span, label)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [deck, tipo, fila, columna, rowSpan, colSpan],
    );
    return creado.insertId;
  }

  const publicar = (id = layoutId, token = ctx.sessions.companyAdmin.token) => post(`/layouts/${id}/publish`, {}, token);

  const version = (id = layoutId) =>
    queryOne<{ status: string; seat_count: number; published_at: string | null }>(
      'SELECT status, seat_count, published_at FROM bus_layouts WHERE id = ?',
      [id],
    );

  /** Ninguna respuesta de rechazo puede filtrar nada del interior. */
  function sinFugas(body: unknown): void {
    const texto = JSON.stringify(body);
    for (const rastro of ['ER_', 'sqlMessage', 'SELECT', 'bus_layout_elements', 'bus_layout_decks', 'at Object', 'stack']) {
      assert.equal(texto.includes(rastro), false, `no debe asomar ${rastro}`);
    }
  }

  // ===================================================================== A
  describe('A · publicaciones válidas', () => {
    it('1 · un elemento 1×1 dentro de la rejilla se publica', async () => {
      await ponerElemento('BATHROOM', 3, 3);
      const res = await publicar();
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((await version())?.status, 'PUBLISHED');
    });

    it('2 · un elemento con extensión válida se publica', async () => {
      await ponerElemento('STAIRS', 2, 2, 2, 2);
      assert.equal((await publicar()).status, 200);
      assert.equal((await version())?.status, 'PUBLISHED');
    });

    it('3 · varios elementos sin choques se publican', async () => {
      await ponerElemento('BATHROOM', 2, 1, 2, 1);
      await ponerElemento('STAIRS', 2, 2, 2, 2);
      await ponerElemento('DOOR', 2, 4);
      await ponerElemento('DRIVER', 4, 4);
      await ponerElemento('EMPTY', 5, 5, 2, 2);

      assert.equal((await publicar()).status, 200);
      assert.equal((await query('SELECT id FROM bus_layout_elements WHERE deck_id = ?', [deckId])).length, 5);
    });

    it('4 · una versión de dos pisos se publica y conserva los elementos de ambos', async () => {
      const segundo = await execute(
        "INSERT INTO bus_layout_decks (layout_id, deck_number, name, row_count, column_count) VALUES (?, 2, 'Piso 2', 4, 4)",
        [layoutId],
      );
      await ponerElemento('BATHROOM', 2, 2, 2, 2, deckId);
      await ponerElemento('STAIRS', 3, 3, 2, 2, segundo.insertId);
      await ponerAsiento('S1', 1, 1, segundo.insertId);

      assert.equal((await publicar()).status, 200, 'ambos pisos son válidos');

      const arbol = await get(`/layouts/${layoutId}`, ctx.sessions.companyAdmin.token);
      assert.equal(arbol.status, 200);
      assert.equal((arbol.body.data.elements as unknown[]).length, 2, 'no se pierde ningún elemento');
      assert.equal((arbol.body.data.decks as unknown[]).length, 2);
    });

    it('5 · una versión sin elementos se publica igual que siempre', async () => {
      assert.equal((await publicar()).status, 200);
      assert.equal((await version())?.status, 'PUBLISHED');
    });
  });

  // ===================================================================== B
  describe('B · extensiones que se salen de la rejilla', () => {
    it('6 · `row_span` que pasa de `row_count` se rechaza', async () => {
      await ponerElemento('BATHROOM', 6, 1, 2, 1); // llega hasta la fila 7 de un piso de 6

      const res = await publicar();
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /se sale del piso/i);
      assert.match(String(res.body.message), /fila 7/);
      sinFugas(res.body);
    });

    it('7 · `col_span` que pasa de `column_count` se rechaza', async () => {
      await ponerElemento('STAIRS', 1, 6, 1, 2);

      const res = await publicar();
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /columna 7/);
    });

    it('8 · pasarse por las dos también se rechaza', async () => {
      await ponerElemento('STAIRS', 6, 6, 2, 2);
      assert.equal((await publicar()).status, 400);
      assert.equal((await version())?.status, 'DRAFT');
    });

    it('9 · en la última casilla con extensión 1 sí cabe; con extensión 2 no', async () => {
      const id = await ponerElemento('DOOR', 6, 6, 1, 1);
      assert.equal((await publicar()).status, 200, 'justo en el borde sí cabe');

      // Se devuelve a borrador para probar el mismo elemento con extensión.
      await execute("UPDATE bus_layouts SET status = 'DRAFT' WHERE id = ?", [layoutId]);
      await execute('UPDATE bus_layout_elements SET row_span = 2 WHERE id = ?', [id]);
      assert.equal((await publicar()).status, 400, 'con extensión ya no');
    });

    it('10 · una rejilla sin declarar (0) conserva el comportamiento legacy: no limita', async () => {
      await execute('UPDATE bus_layout_decks SET row_count = 0, column_count = 0 WHERE id = ?', [deckId]);
      await ponerElemento('BATHROOM', 40, 9, 3, 3);

      assert.equal((await publicar()).status, 200, 'un piso heredado de la migración no se puede quedar bloqueado');
    });

    it('11 · una posición o una extensión inválidas se rechazan', async () => {
      const id = await ponerElemento('DOOR', 2, 2);
      await execute('UPDATE bus_layout_elements SET row_span = 0 WHERE id = ?', [id]);

      const res = await publicar();
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /altura|anchura/i);
    });
  });

  // ===================================================================== C
  describe('C · choques entre elementos', () => {
    it('12 · dos elementos en la misma casilla se rechazan', async () => {
      await ponerElemento('BATHROOM', 3, 3);
      await ponerElemento('DOOR', 3, 3);

      const res = await publicar();
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /dos elementos/i);
      assert.match(String(res.body.message), /\(3, 3\)/);
    });

    it('13 · dos extensiones parcialmente solapadas se rechazan', async () => {
      await ponerElemento('STAIRS', 2, 2, 2, 2); // (2,2)(2,3)(3,2)(3,3)
      await ponerElemento('STAIRS', 3, 3, 2, 2); // empieza justo en (3,3)

      assert.equal((await publicar()).status, 400);
      assert.equal((await version())?.status, 'DRAFT');
    });

    it('14 · un elemento pequeño DENTRO de la extensión de otro se rechaza', async () => {
      await ponerElemento('STAIRS', 2, 2, 3, 3); // de (2,2) a (4,4)
      await ponerElemento('DOOR', 3, 3); // justo en el centro

      const res = await publicar();
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /dos elementos/i);
    });

    it('15 · el choque en la esquina de dos extensiones se detecta', async () => {
      await ponerElemento('STAIRS', 2, 2, 2, 2); // hasta (3,3)
      await ponerElemento('BATHROOM', 3, 3, 2, 2); // desde (3,3)

      assert.equal((await publicar()).status, 400);
    });

    it('16 · el choque SOLO en la última casilla cubierta también se detecta', async () => {
      await ponerElemento('STAIRS', 2, 2, 1, 3); // (2,2)(2,3)(2,4)
      await ponerElemento('DOOR', 2, 4); // solo la última

      const res = await publicar();
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /\(2, 4\)/);
    });
  });

  // ===================================================================== D
  describe('D · choques entre elemento y asiento', () => {
    it('17 · un asiento en la primera casilla del elemento se rechaza', async () => {
      await ponerAsiento('02', 3, 3);
      await ponerElemento('BATHROOM', 3, 3, 2, 2);

      const res = await publicar();
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /misma posición/i, 'se conserva el mensaje de siempre');
      assert.match(String(res.body.message), /\(3, 3\)/);
    });

    it('18 · un asiento en una casilla INTERNA de la extensión se rechaza', async () => {
      // Este es el caso que antes se colaba: el origen del elemento es (2,2) y el asiento
      // está en (3,3), así que la comparación por casilla de origen no lo veía.
      await ponerAsiento('02', 3, 3);
      await ponerElemento('STAIRS', 2, 2, 2, 2);

      const res = await publicar();
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /misma posición/i);
      assert.equal((await version())?.status, 'DRAFT');
    });

    it('19 · un asiento en la ÚLTIMA casilla de la extensión se rechaza', async () => {
      await ponerAsiento('02', 4, 4);
      await ponerElemento('STAIRS', 2, 2, 3, 3); // hasta (4,4)

      assert.equal((await publicar()).status, 400);
    });

    it('20 · varios asientos dentro de la extensión: basta con uno para rechazar', async () => {
      await ponerAsiento('02', 2, 3);
      await ponerAsiento('03', 3, 2);
      await ponerAsiento('04', 3, 3);
      await ponerElemento('STAIRS', 2, 2, 2, 2);

      const res = await publicar();
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /misma posición/i);
    });

    it('21 · un asiento JUSTO fuera de la extensión no estorba', async () => {
      await ponerAsiento('02', 4, 4); // el elemento llega hasta (3,3)
      await ponerElemento('STAIRS', 2, 2, 2, 2);

      assert.equal((await publicar()).status, 200);
    });
  });

  // ===================================================================== E
  describe('E · atomicidad del rechazo', () => {
    it('22 · un rechazo no mueve una sola fila', async () => {
      await ponerAsiento('02', 3, 3);
      await ponerElemento('STAIRS', 2, 2, 2, 2);

      const antes = {
        borrador: await queryOne('SELECT * FROM bus_layouts WHERE id = ?', [layoutId]),
        publicada: await queryOne('SELECT * FROM bus_layouts WHERE id = ?', [ctx.fixtures.layoutA]),
        bus: await queryOne('SELECT * FROM buses WHERE id = ?', [ctx.fixtures.busA]),
        pisos: await query('SELECT * FROM bus_layout_decks WHERE layout_id = ? ORDER BY id', [layoutId]),
        elementos: await query('SELECT * FROM bus_layout_elements WHERE deck_id = ? ORDER BY id', [deckId]),
        asientos: await query('SELECT * FROM seats WHERE layout_id = ? ORDER BY id', [layoutId]),
      };

      assert.equal((await publicar()).status, 400);

      assert.deepEqual(await queryOne('SELECT * FROM bus_layouts WHERE id = ?', [layoutId]), antes.borrador);
      assert.deepEqual(await queryOne('SELECT * FROM bus_layouts WHERE id = ?', [ctx.fixtures.layoutA]), antes.publicada);
      assert.deepEqual(await queryOne('SELECT * FROM buses WHERE id = ?', [ctx.fixtures.busA]), antes.bus);
      assert.deepEqual(await query('SELECT * FROM bus_layout_decks WHERE layout_id = ? ORDER BY id', [layoutId]), antes.pisos);
      assert.deepEqual(await query('SELECT * FROM bus_layout_elements WHERE deck_id = ? ORDER BY id', [deckId]), antes.elementos);
      assert.deepEqual(await query('SELECT * FROM seats WHERE layout_id = ? ORDER BY id', [layoutId]), antes.asientos);
    });

    it('23 · el borrador sigue siendo borrador y la publicada sigue publicada', async () => {
      await ponerElemento('BATHROOM', 6, 6, 2, 2);
      assert.equal((await publicar()).status, 400);

      assert.equal((await version())?.status, 'DRAFT');
      assert.equal((await version(ctx.fixtures.layoutA))?.status, 'PUBLISHED');
      assert.equal((await version())?.published_at, null, 'ni se le pone fecha de publicación');
    });

    it('24 · `buses.capacity` y `seat_count` no se tocan', async () => {
      await ponerAsiento('02', 3, 3);
      await ponerElemento('STAIRS', 2, 2, 2, 2);

      const capacidadAntes = Number(
        (await queryOne<{ capacity: number }>('SELECT capacity FROM buses WHERE id = ?', [ctx.fixtures.busA]))?.capacity,
      );
      const recuentoAntes = Number((await version())?.seat_count);

      assert.equal((await publicar()).status, 400);

      assert.equal(
        Number((await queryOne<{ capacity: number }>('SELECT capacity FROM buses WHERE id = ?', [ctx.fixtures.busA]))?.capacity),
        capacidadAntes,
      );
      assert.equal(Number((await version())?.seat_count), recuentoAntes);
    });

    it('25 · el mapa del viaje que usa la versión publicada no cambia', async () => {
      const antes = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);
      await ponerAsiento('02', 3, 3);
      await ponerElemento('STAIRS', 2, 2, 2, 2);

      assert.equal((await publicar()).status, 400);

      const despues = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);
      assert.deepEqual(despues.body.data, antes.body.data);
    });
  });

  // ===================================================================== F
  describe('F · regresión', () => {
    it('26 · corregir el estado inválido permite publicar', async () => {
      const id = await ponerElemento('STAIRS', 2, 2, 2, 2);
      await ponerAsiento('02', 3, 3);
      assert.equal((await publicar()).status, 400);

      // Se retira el elemento y ya no hay choque.
      await execute('DELETE FROM bus_layout_elements WHERE id = ?', [id]);

      const res = await publicar();
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((await version())?.status, 'PUBLISHED');
      assert.ok((await version())?.published_at, 'ahora sí se le pone fecha');
    });

    it('27 · la publicación válida hace lo de siempre: archiva la anterior y sincroniza capacidad', async () => {
      await ponerAsiento('02', 2, 2);
      await ponerElemento('DOOR', 4, 4);

      assert.equal((await publicar()).status, 200);

      assert.equal((await version())?.status, 'PUBLISHED');
      assert.equal((await version(ctx.fixtures.layoutA))?.status, 'ARCHIVED');

      const asientos = Number(
        (await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM seats WHERE layout_id = ?', [layoutId]))?.n,
      );
      assert.equal(Number((await version())?.seat_count), asientos);
      assert.equal(
        Number((await queryOne<{ capacity: number }>('SELECT capacity FROM buses WHERE id = ?', [ctx.fixtures.busA]))?.capacity),
        asientos,
      );
    });

    it('28 · las reglas de publicación anteriores siguen en pie', async () => {
      // Sin asientos no se publica.
      await execute('DELETE FROM seats WHERE layout_id = ?', [layoutId]);
      const sinAsientos = await publicar();
      assert.equal(sinAsientos.status, 400);
      assert.match(String(sinAsientos.body.message), /ningún asiento/i);

      // Una versión ya publicada tampoco se vuelve a publicar.
      assert.match(String((await publicar(ctx.fixtures.layoutA)).body.message), /borrador/i);
    });

    it('29 · permisos y aislamiento intactos', async () => {
      assert.equal((await publicar(layoutId, ctx.sessions.operator.token)).status, 403);
      assert.equal((await publicar(layoutId, ctx.sessions.customer.token)).status, 403);
      assert.equal((await publicar(layoutId, ctx.sessions.companyAdminB.token)).status, 403);
      assert.equal((await post(`/layouts/${layoutId}/publish`, {})).status, 401);
      assert.equal((await version())?.status, 'DRAFT', 'ningún rechazo la publicó');

      // El ADMIN de la plataforma sí puede.
      assert.equal((await publicar(layoutId, ctx.sessions.admin.token)).status, 200);
    });

    it('30 · las reservas históricas no se ven afectadas por un rechazo', async () => {
      const antesVentas = await query('SELECT * FROM booking_seats ORDER BY id');
      const antesReservas = await query('SELECT * FROM bookings ORDER BY id');

      await ponerAsiento('02', 3, 3);
      await ponerElemento('STAIRS', 2, 2, 2, 2);
      assert.equal((await publicar()).status, 400);

      assert.deepEqual(await query('SELECT * FROM booking_seats ORDER BY id'), antesVentas);
      assert.deepEqual(await query('SELECT * FROM bookings ORDER BY id'), antesReservas);
    });

    it('31 · el rechazo nunca filtra SQL ni nombres de tablas', async () => {
      const casos: Array<() => Promise<unknown>> = [
        () => ponerElemento('BATHROOM', 6, 6, 2, 2),
        () => ponerElemento('DOOR', 3, 3),
        () => ponerAsiento('09', 1, 1),
      ];
      for (const preparar of casos) {
        await execute('DELETE FROM bus_layout_elements WHERE deck_id = ?', [deckId]);
        await ponerElemento('STAIRS', 2, 2, 2, 2);
        await preparar();

        const res = await publicar();
        // F12-06: primero se exige el rechazo; antes, un 200 pasaba sin comprobar nada.
        assert.equal(res.status, 400, JSON.stringify(res.body));
        sinFugas(res.body);
        await execute("UPDATE bus_layouts SET status = 'DRAFT', published_at = NULL WHERE id = ?", [layoutId]);
      }
    });
  });
});
