import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { api, get, post } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, createBusLayout } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

const patch = <T = any>(path: string, body?: unknown, token?: string) =>
  api<T>(path, { method: 'PATCH', body, token });

/**
 * H-05 · encoger un piso no puede dejar nada fuera de su rejilla.
 *
 * LO QUE FALTABA. `updateDeck` comprobaba que la rejilla nueva no dejara ASIENTOS fuera, pero
 * no miraba los elementos. Un baño colocado en la fila 9 con `row_span` 2 llega hasta la 10;
 * bajar el piso a 9 filas lo dejaba medio fuera de su propio piso, y el mapa del cliente lo
 * seguía dibujando porque amplía la rejilla con lo que encuentra. La geometría guardada y la
 * declarada dejaban de coincidir sin que nadie se enterara.
 *
 * LO QUE SE PRUEBA. Que se mira la superficie ENTERA del elemento —no su casilla de origen—,
 * que el límite exacto sí se acepta, que al rechazar no cambia absolutamente nada, y que lo
 * que ya funcionaba sigue igual.
 */
describe('H-05 · la rejilla de un piso no encoge por debajo de lo que contiene', () => {
  let ctx: SuiteContext;
  let layoutId = 0;
  let deckId = 0;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  /** Borrador limpio de 10×6 en el bus A, sin nada dentro. */
  beforeEach(async () => {
    await execute('DELETE FROM seats WHERE layout_id NOT IN (?, ?)', [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
    await execute('DELETE FROM bus_layouts WHERE id NOT IN (?, ?)', [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);

    const borrador = await createBusLayout(ctx.fixtures.busA, { version: 5, status: 'DRAFT', rows: 10, columns: 6 });
    layoutId = borrador.layoutId;
    deckId = at(borrador.deckIds, 0);
  });

  const piso = () =>
    queryOne<{ deck_number: number; name: string | null; row_count: number; column_count: number }>(
      'SELECT deck_number, name, row_count, column_count FROM bus_layout_decks WHERE id = ?',
      [deckId],
    );

  /** Coloca un elemento directamente, para poder plantear casos que el CRUD no dejaría crear. */
  async function colocarElemento(
    tipo: string,
    fila: number,
    columna: number,
    rowSpan = 1,
    colSpan = 1,
  ): Promise<number> {
    const creado = await execute(
      `INSERT INTO bus_layout_elements (deck_id, element_type, \`row_number\`, column_number, row_span, col_span, label)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [deckId, tipo, fila, columna, rowSpan, colSpan],
    );
    return creado.insertId;
  }

  async function colocarAsiento(numero: string, fila: number, columna: number): Promise<number> {
    const creado = await execute(
      `INSERT INTO seats (bus_id, layout_id, deck_id, seat_type_id, seat_number, \`row_number\`, column_number, is_window, is_aisle, status)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 0, 0, 'AVAILABLE')`,
      [ctx.fixtures.busA, layoutId, deckId, numero, fila, columna],
    );
    return creado.insertId;
  }

  const encoger = (cuerpo: Record<string, unknown>) => patch(`/decks/${deckId}`, cuerpo, ctx.sessions.companyAdmin.token);

  // =====================================================================
  describe('Elementos que quedarían fuera', () => {
    it('1 · reducir las filas dejando un elemento fuera se rechaza', async () => {
      await colocarElemento('BATHROOM', 10, 1);

      const res = await encoger({ row_count: 9 });
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /elemento/i);
      assert.equal(Number((await piso())?.row_count), 10, 'el piso no se ha tocado');
    });

    it('2 · reducir las columnas dejando un elemento fuera se rechaza', async () => {
      await colocarElemento('DOOR', 1, 6);

      const res = await encoger({ column_count: 5 });
      assert.equal(res.status, 400);
      assert.equal(Number((await piso())?.column_count), 6);
    });

    it('3 · un elemento con `row_span` que queda PARCIALMENTE fuera se rechaza', async () => {
      // Empieza en la fila 9 y llega hasta la 10: su origen cabría en una rejilla de 9 filas,
      // su extensión no. Este es exactamente el caso del hallazgo.
      await colocarElemento('STAIRS', 9, 1, 2, 1);

      const res = await encoger({ row_count: 9 });
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /fila 10/, 'el mensaje dice hasta dónde llega de verdad');
      assert.equal(Number((await piso())?.row_count), 10);
    });

    it('4 · un elemento con `col_span` que queda PARCIALMENTE fuera se rechaza', async () => {
      await colocarElemento('STAIRS', 1, 5, 1, 2);

      const res = await encoger({ column_count: 5 });
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /columna 6/);
      assert.equal(Number((await piso())?.column_count), 6);
    });

    it('5 · un 2×2 en la esquina se rechaza tanto por filas como por columnas', async () => {
      await colocarElemento('STAIRS', 9, 5, 2, 2);

      assert.equal((await encoger({ row_count: 9 })).status, 400);
      assert.equal((await encoger({ column_count: 5 })).status, 400);
      assert.equal((await encoger({ row_count: 9, column_count: 5 })).status, 400);

      const actual = await piso();
      assert.equal(Number(actual?.row_count), 10);
      assert.equal(Number(actual?.column_count), 6);
    });

    it('6 · con varios elementos basta con que UNO quede fuera', async () => {
      await colocarElemento('DRIVER', 1, 1);
      await colocarElemento('DOOR', 2, 2);
      await colocarElemento('EMPTY', 3, 3);
      await colocarElemento('BATHROOM', 10, 6);

      const res = await encoger({ row_count: 9, column_count: 6 });
      assert.equal(res.status, 400);
      assert.equal(Number((await piso())?.row_count), 10);
    });

    it('7 · los cinco tipos de elemento protegen igual', async () => {
      for (const tipo of ['BATHROOM', 'STAIRS', 'DRIVER', 'DOOR', 'EMPTY']) {
        await execute('DELETE FROM bus_layout_elements WHERE deck_id = ?', [deckId]);
        await colocarElemento(tipo, 10, 1);

        const res = await encoger({ row_count: 9 });
        assert.equal(res.status, 400, `${tipo} debería impedir el encogimiento`);
        assert.equal(Number((await piso())?.row_count), 10, `${tipo} dejó cambiar el piso`);
      }
    });
  });

  // =====================================================================
  describe('Lo que sí se permite', () => {
    it('8 · un elemento que llega justo a la última fila permitida no estorba', async () => {
      await colocarElemento('BATHROOM', 8, 1, 2, 1); // llega hasta la fila 9

      const res = await encoger({ row_count: 9 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(Number((await piso())?.row_count), 9);
    });

    it('9 · un elemento que llega justo a la última columna permitida tampoco', async () => {
      await colocarElemento('STAIRS', 1, 4, 1, 2); // llega hasta la columna 5

      const res = await encoger({ column_count: 5 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(Number((await piso())?.column_count), 5);
    });

    it('10 · encoger sin afectar a nada se permite', async () => {
      await colocarElemento('DRIVER', 1, 1);
      await colocarAsiento('01', 2, 2);

      const res = await encoger({ row_count: 4, column_count: 4 });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const actual = await piso();
      assert.equal(Number(actual?.row_count), 4);
      assert.equal(Number(actual?.column_count), 4);
    });

    it('11 · agrandar la rejilla nunca se bloquea', async () => {
      await colocarElemento('BATHROOM', 10, 6);

      const res = await encoger({ row_count: 20, column_count: 10 });
      assert.equal(res.status, 200);
      assert.equal(Number((await piso())?.row_count), 20);
    });

    it('12 · cambiar solo el nombre no dispara la comprobación', async () => {
      await colocarElemento('BATHROOM', 10, 6, 1, 1);
      await colocarAsiento('01', 10, 1);

      const res = await encoger({ name: 'Piso principal' });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const actual = await piso();
      assert.equal(actual?.name, 'Piso principal');
      assert.equal(Number(actual?.row_count), 10, 'la rejilla se queda como estaba');
      assert.equal(Number(actual?.column_count), 6);
    });

    it('13 · una rejilla sin declarar (0) sigue sin limitar', async () => {
      await execute('UPDATE bus_layout_decks SET row_count = 0, column_count = 0 WHERE id = ?', [deckId]);
      await colocarElemento('BATHROOM', 40, 9);

      const res = await encoger({ name: 'Heredado' });
      assert.equal(res.status, 200, 'un piso heredado de la migración no se puede quedar bloqueado');
    });
  });

  // =====================================================================
  describe('Los asientos se siguen comprobando igual', () => {
    it('14 · encoger por debajo de un asiento se rechaza con el mensaje de siempre', async () => {
      await colocarAsiento('01', 10, 1);

      const res = await encoger({ row_count: 9 });
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /encogerse/i);
      assert.equal(Number((await piso())?.row_count), 10);
    });

    it('15 · y por debajo de su columna también', async () => {
      await colocarAsiento('01', 1, 6);
      assert.equal((await encoger({ column_count: 5 })).status, 400);
    });
  });

  // =====================================================================
  describe('Al rechazar no cambia absolutamente nada', () => {
    it('16 · piso, elementos y asientos quedan byte a byte iguales', async () => {
      await colocarElemento('BATHROOM', 9, 1, 2, 1);
      await colocarElemento('DOOR', 1, 6);
      await colocarAsiento('01', 3, 3);
      await colocarAsiento('02', 4, 4);

      const antes = {
        piso: await queryOne('SELECT * FROM bus_layout_decks WHERE id = ?', [deckId]),
        elementos: await query('SELECT * FROM bus_layout_elements WHERE deck_id = ? ORDER BY id', [deckId]),
        asientos: await query('SELECT * FROM seats WHERE deck_id = ? ORDER BY id', [deckId]),
        version: await queryOne('SELECT * FROM bus_layouts WHERE id = ?', [layoutId]),
      };

      const res = await encoger({ deck_number: 3, name: 'Otro nombre', row_count: 9, column_count: 5 });
      assert.equal(res.status, 400);

      assert.deepEqual(await queryOne('SELECT * FROM bus_layout_decks WHERE id = ?', [deckId]), antes.piso);
      assert.deepEqual(await query('SELECT * FROM bus_layout_elements WHERE deck_id = ? ORDER BY id', [deckId]), antes.elementos);
      assert.deepEqual(await query('SELECT * FROM seats WHERE deck_id = ? ORDER BY id', [deckId]), antes.asientos);
      assert.deepEqual(await queryOne('SELECT * FROM bus_layouts WHERE id = ?', [layoutId]), antes.version);
    });

    it('17 · el rechazo no filtra nada de SQL', async () => {
      await colocarElemento('STAIRS', 9, 1, 2, 1);
      const res = await encoger({ row_count: 9 });

      const texto = JSON.stringify(res.body);
      for (const rastro of ['ER_', 'SELECT', 'UPDATE', 'sqlMessage', 'bus_layout_elements', 'Error:']) {
        assert.equal(texto.includes(rastro), false, `no debe asomar ${rastro}`);
      }
      assert.equal(res.body.success, false);
    });
  });

  // =====================================================================
  describe('Permisos y aislamiento', () => {
    it('18 · quien tiene `buses.update` edita el piso de su empresa', async () => {
      const res = await encoger({ row_count: 8 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    it('19 · el OPERATOR conserva sus permisos: lee pero no edita', async () => {
      assert.equal((await get(`/layouts/${layoutId}`, ctx.sessions.operator.token)).status, 200);
      assert.equal((await patch(`/decks/${deckId}`, { row_count: 8 }, ctx.sessions.operator.token)).status, 403);
      assert.equal(Number((await piso())?.row_count), 10);
    });

    it('20 · la empresa B no toca el piso de la empresa A', async () => {
      const res = await patch(`/decks/${deckId}`, { row_count: 8 }, ctx.sessions.companyAdminB.token);
      assert.equal(res.status, 403);
      assert.equal(Number((await piso())?.row_count), 10);
    });

    it('21 · un CUSTOMER tampoco', async () => {
      assert.equal((await patch(`/decks/${deckId}`, { row_count: 8 }, ctx.sessions.customer.token)).status, 403);
    });

    it('22 · sin sesión no se llega', async () => {
      assert.equal((await patch(`/decks/${deckId}`, { row_count: 8 })).status, 401);
    });
  });

  // =====================================================================
  describe('El resto del editor no cambia', () => {
    it('23 · una versión publicada sigue sin poder editarse', async () => {
      await execute("UPDATE bus_layouts SET status = 'ARCHIVED' WHERE bus_id = ? AND status = 'PUBLISHED'", [ctx.fixtures.busA]);
      await execute("UPDATE bus_layouts SET status = 'PUBLISHED' WHERE id = ?", [layoutId]);

      const res = await encoger({ row_count: 8 });
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /clónala|publicada/i);
      assert.equal(Number((await piso())?.row_count), 10);
    });

    it('24 · el número de piso duplicado se sigue rechazando', async () => {
      const segundo = await execute(
        "INSERT INTO bus_layout_decks (layout_id, deck_number, name, row_count, column_count) VALUES (?, 2, 'Piso 2', 4, 4)",
        [layoutId],
      );
      assert.ok(segundo.insertId > 0);

      const res = await encoger({ deck_number: 2 });
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /ya tiene un piso 2/i);
      assert.equal(Number((await piso())?.deck_number), 1);
    });

    it('25 · las filas y columnas negativas se siguen rechazando', async () => {
      assert.equal((await encoger({ row_count: -1 })).status, 400);
      assert.equal((await encoger({ column_count: -3 })).status, 400);
      assert.equal((await encoger({ deck_number: 0 })).status, 400);
      assert.equal(Number((await piso())?.row_count), 10);
    });

    it('26 · un piso inexistente responde 404', async () => {
      assert.equal((await patch('/decks/99999999', { row_count: 4 }, ctx.sessions.companyAdmin.token)).status, 404);
    });

    it('27 · colocar un elemento fuera de la rejilla se sigue rechazando con su mensaje', async () => {
      const res = await post(
        `/decks/${deckId}/elements`,
        { element_type: 'BATHROOM', row_number: 10, column_number: 1, row_span: 2 },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /se sale del piso/i);
    });

    it('28 · tras encoger, la rejilla nueva manda para colocar cosas', async () => {
      assert.equal((await encoger({ row_count: 5, column_count: 4 })).status, 200);

      const dentro = await post(
        `/decks/${deckId}/elements`,
        { element_type: 'DRIVER', row_number: 5, column_number: 4 },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(dentro.status, 201, JSON.stringify(dentro.body));

      const fuera = await post(
        `/decks/${deckId}/elements`,
        { element_type: 'DOOR', row_number: 6, column_number: 1 },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(fuera.status, 400);
    });

    it('29 · un elemento válido sigue estando ahí después de tocar otra propiedad del piso', async () => {
      const id = await colocarElemento('BATHROOM', 2, 2, 2, 2);
      assert.equal((await encoger({ name: 'Piso renombrado', deck_number: 4 })).status, 200);

      const elemento = await queryOne<{ id: number; row_number: number; row_span: number; col_span: number }>(
        'SELECT id, `row_number`, row_span, col_span FROM bus_layout_elements WHERE id = ?',
        [id],
      );
      assert.equal(Number(elemento?.id), id);
      assert.equal(Number(elemento?.row_number), 2);
      assert.equal(Number(elemento?.row_span), 2);
      assert.equal(Number(elemento?.col_span), 2);

      const arbol = await get(`/layouts/${layoutId}`, ctx.sessions.companyAdmin.token);
      assert.equal(arbol.status, 200);
      assert.equal((arbol.body.data.elements as unknown[]).length, 1);
    });
  });

  // =====================================================================
  describe('Concurrencia', () => {
    it('30 · varios cambios simultáneos sobre el mismo piso no lo dejan a medias', async () => {
      await colocarElemento('BATHROOM', 9, 1, 2, 1); // llega hasta la fila 10

      const intentos = await Promise.all([
        encoger({ row_count: 9 }),
        encoger({ row_count: 9 }),
        encoger({ row_count: 12 }),
        encoger({ row_count: 9 }),
      ]);
      assert.equal(intentos.filter((res) => res.status >= 500).length, 0, 'ninguno revienta');

      const actual = await piso();
      assert.ok(Number(actual?.row_count) >= 10, `la rejilla no puede haber bajado de 10: ${actual?.row_count}`);
    });
  });
});
