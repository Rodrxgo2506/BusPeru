import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { api, get, post } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, createBusLayout } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

const patch = <T = any>(path: string, body?: unknown, token?: string) =>
  api<T>(path, { method: 'PATCH', body, token });
const del = <T = any>(path: string, token?: string) => api<T>(path, { method: 'DELETE', token });

interface ElementoFila {
  id: number;
  deck_id: number;
  element_type: string;
  row_number: number;
  column_number: number;
  row_span: number;
  col_span: number;
}

/**
 * H-07 · colocar un elemento y cambiar la rejilla no se pisan entre sí.
 *
 * LA CARRERA. `createElement` y `updateElement` comprobaban que la casilla estuviera libre
 * por el pool y escribían después, en otra transacción. Entre una cosa y la otra cabía otra
 * petición: dos elementos podían acabar en la misma casilla, o uno podía quedar fuera de una
 * rejilla que acababa de encoger. Ninguna de las dos cosas habría pasado atendiendo las
 * peticiones una detrás de otra.
 *
 * CÓMO SE PRUEBA. Lanzando las peticiones DE VERDAD a la vez con `Promise.all` y comprobando
 * después los dos invariantes que no pueden romperse: nada fuera de la rejilla y nada
 * encimado. Se acepta cualquier desenlace serial —quién gana da igual—, pero no un estado
 * que ninguna secuencia serial habría producido.
 */
describe('H-07 · elementos y rejilla bajo el mismo cerrojo', () => {
  let ctx: SuiteContext;
  let layoutId = 0;
  let deckId = 0;
  let deck2Id = 0;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  /** Borrador limpio en el bus A: piso 1 de 10×6 y piso 2 de 6×4, ambos vacíos. */
  beforeEach(async () => {
    await execute('DELETE FROM seats WHERE layout_id NOT IN (?, ?)', [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
    await execute('DELETE FROM bus_layouts WHERE id NOT IN (?, ?)', [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);

    const borrador = await createBusLayout(ctx.fixtures.busA, { version: 5, status: 'DRAFT', decks: 2, rows: 10, columns: 6 });
    layoutId = borrador.layoutId;
    deckId = at(borrador.deckIds, 0);
    deck2Id = at(borrador.deckIds, 1);
    await execute('UPDATE bus_layout_decks SET row_count = 6, column_count = 4 WHERE id = ?', [deck2Id]);
  });

  const token = () => ctx.sessions.companyAdmin.token;

  const crear = (cuerpo: Record<string, unknown>, deck = deckId) => post(`/decks/${deck}/elements`, cuerpo, token());
  const mover = (id: number, cuerpo: Record<string, unknown>) => patch(`/elements/${id}`, cuerpo, token());
  const rejilla = (cuerpo: Record<string, unknown>, deck = deckId) => patch(`/decks/${deck}`, cuerpo, token());

  const piso = (id = deckId) =>
    queryOne<{ row_count: number; column_count: number }>(
      'SELECT row_count, column_count FROM bus_layout_decks WHERE id = ?',
      [id],
    );
  const elementos = (id = deckId) =>
    query<ElementoFila>(
      'SELECT id, deck_id, element_type, `row_number`, column_number, row_span, col_span FROM bus_layout_elements WHERE deck_id = ? ORDER BY id',
      [id],
    );

  /**
   * Los dos invariantes que ninguna combinación puede romper: nada fuera de la rejilla
   * declarada y nada compartiendo casilla, contando la extensión entera.
   */
  async function comprobarInvariantes(id = deckId): Promise<void> {
    const actual = await piso(id);
    const filas = Number(actual?.row_count ?? 0);
    const columnas = Number(actual?.column_count ?? 0);

    const ocupadas = new Map<string, number>();
    for (const elemento of await elementos(id)) {
      const ultimaFila = elemento.row_number + elemento.row_span - 1;
      const ultimaColumna = elemento.column_number + elemento.col_span - 1;
      if (filas > 0) assert.ok(ultimaFila <= filas, `el elemento ${elemento.id} llega a la fila ${ultimaFila} y el piso tiene ${filas}`);
      if (columnas > 0) {
        assert.ok(ultimaColumna <= columnas, `el elemento ${elemento.id} llega a la columna ${ultimaColumna} y el piso tiene ${columnas}`);
      }

      for (let fila = elemento.row_number; fila <= ultimaFila; fila += 1) {
        for (let columna = elemento.column_number; columna <= ultimaColumna; columna += 1) {
          const casilla = `${fila}:${columna}`;
          const anterior = ocupadas.get(casilla);
          assert.equal(anterior, undefined, `la casilla ${casilla} la ocupan los elementos ${anterior} y ${elemento.id}`);
          ocupadas.set(casilla, elemento.id);
        }
      }
    }

    // Y ningún asiento compartiendo casilla con un elemento.
    const asientos = await query<{ id: number; row_number: number; column_number: number }>(
      'SELECT id, `row_number`, column_number FROM seats WHERE deck_id = ?',
      [id],
    );
    for (const asiento of asientos) {
      assert.equal(
        ocupadas.has(`${asiento.row_number}:${asiento.column_number}`),
        false,
        `el asiento ${asiento.id} comparte casilla con un elemento`,
      );
    }
  }

  /** Ninguna respuesta puede ser un 5xx ni un interbloqueo filtrado al cliente. */
  function sinFallosDeServidor(respuestas: Array<{ status: number; body: { message?: string } }>): void {
    for (const res of respuestas) {
      assert.ok(res.status < 500, `respuesta ${res.status}: ${JSON.stringify(res.body)}`);
      assert.ok([200, 201, 400, 401, 403, 404, 409].includes(res.status), `estado inesperado ${res.status}`);
      const texto = JSON.stringify(res.body);
      for (const rastro of ['ER_LOCK', 'Deadlock', 'ER_', 'sqlMessage']) {
        assert.equal(texto.includes(rastro), false, `la respuesta filtra ${rastro}`);
      }
    }
  }

  // =====================================================================
  describe('Carreras reales', () => {
    it('1 · crear un elemento y encoger el piso a la vez', async () => {
      // El elemento iría a la fila 10; el encogimiento deja el piso en 9. Solo una de las dos
      // puede salir adelante.
      const [creacion, encogimiento] = await Promise.all([
        crear({ element_type: 'BATHROOM', row_number: 10, column_number: 1 }),
        rejilla({ row_count: 9 }),
      ]);

      sinFallosDeServidor([creacion, encogimiento]);
      await comprobarInvariantes();
      assert.ok(creacion.status === 201 || encogimiento.status === 200, 'alguna de las dos debería prosperar');
      if (creacion.status === 201) assert.equal(encogimiento.status, 400, 'si el baño entró, la rejilla no pudo encoger');
      if (encogimiento.status === 200) assert.equal(creacion.status, 400, 'si la rejilla encogió, el baño no cabía');
    });

    it('2 · mover un elemento y encoger el piso a la vez', async () => {
      const existente = await crear({ element_type: 'STAIRS', row_number: 1, column_number: 1 });
      assert.equal(existente.status, 201);
      const id = Number(existente.body.data.id);

      const [movimiento, encogimiento] = await Promise.all([
        mover(id, { row_number: 10, column_number: 6 }),
        rejilla({ row_count: 9, column_count: 5 }),
      ]);

      sinFallosDeServidor([movimiento, encogimiento]);
      await comprobarInvariantes();
    });

    it('3 · dos creaciones simultáneas sobre la MISMA casilla: solo una entra', async () => {
      const [una, otra] = await Promise.all([
        crear({ element_type: 'BATHROOM', row_number: 4, column_number: 4 }),
        crear({ element_type: 'DOOR', row_number: 4, column_number: 4 }),
      ]);

      sinFallosDeServidor([una, otra]);
      const creadas = [una, otra].filter((res) => res.status === 201).length;
      assert.equal(creadas, 1, 'exactamente una de las dos debe entrar');
      assert.equal((await elementos()).length, 1);
      await comprobarInvariantes();
    });

    it('4 · dos creaciones cuyas EXTENSIONES se solapan: solo una entra', async () => {
      // Un 2×2 en (3,3) ocupa hasta (4,4); el otro empieza justo en (4,4).
      const [una, otra] = await Promise.all([
        crear({ element_type: 'STAIRS', row_number: 3, column_number: 3, row_span: 2, col_span: 2 }),
        crear({ element_type: 'STAIRS', row_number: 4, column_number: 4, row_span: 2, col_span: 2 }),
      ]);

      sinFallosDeServidor([una, otra]);
      assert.equal([una, otra].filter((res) => res.status === 201).length, 1);
      await comprobarInvariantes();
    });

    it('5 · dos movimientos simultáneos hacia la misma casilla', async () => {
      const uno = await crear({ element_type: 'BATHROOM', row_number: 1, column_number: 1 });
      const dos = await crear({ element_type: 'DOOR', row_number: 1, column_number: 3 });
      assert.equal(uno.status, 201);
      assert.equal(dos.status, 201);

      const [a, b] = await Promise.all([
        mover(Number(uno.body.data.id), { row_number: 7, column_number: 2 }),
        mover(Number(dos.body.data.id), { row_number: 7, column_number: 2 }),
      ]);

      sinFallosDeServidor([a, b]);
      assert.equal([a, b].filter((res) => res.status === 200).length, 1, 'solo uno puede quedarse la casilla');
      assert.equal((await elementos()).length, 2, 'ninguno se pierde por el camino');
      await comprobarInvariantes();
    });

    it('6 · crear y mover hacia la misma casilla a la vez', async () => {
      const existente = await crear({ element_type: 'DRIVER', row_number: 1, column_number: 1 });
      assert.equal(existente.status, 201);

      const [creacion, movimiento] = await Promise.all([
        crear({ element_type: 'DOOR', row_number: 6, column_number: 6 }),
        mover(Number(existente.body.data.id), { row_number: 6, column_number: 6 }),
      ]);

      sinFallosDeServidor([creacion, movimiento]);
      assert.equal(
        [creacion.status === 201, movimiento.status === 200].filter(Boolean).length,
        1,
        'la casilla es de uno solo',
      );
      await comprobarInvariantes();
    });

    it('7 · el mismo bus, dos pisos distintos: las dos operaciones caben', async () => {
      const [uno, dos] = await Promise.all([
        crear({ element_type: 'BATHROOM', row_number: 2, column_number: 2 }, deckId),
        crear({ element_type: 'STAIRS', row_number: 2, column_number: 2 }, deck2Id),
      ]);

      sinFallosDeServidor([uno, dos]);
      assert.equal(uno.status, 201, JSON.stringify(uno.body));
      assert.equal(dos.status, 201, JSON.stringify(dos.body));
      await comprobarInvariantes(deckId);
      await comprobarInvariantes(deck2Id);
    });

    it('8 · seis operaciones simultáneas sobre el mismo piso', async () => {
      const base = await crear({ element_type: 'DRIVER', row_number: 1, column_number: 1 });
      assert.equal(base.status, 201);
      const baseId = Number(base.body.data.id);

      const respuestas = await Promise.all([
        crear({ element_type: 'BATHROOM', row_number: 5, column_number: 5 }),
        crear({ element_type: 'DOOR', row_number: 5, column_number: 5 }),
        crear({ element_type: 'EMPTY', row_number: 9, column_number: 1, row_span: 2 }),
        mover(baseId, { row_number: 5, column_number: 5 }),
        rejilla({ row_count: 9 }),
        rejilla({ column_count: 8 }),
      ]);

      sinFallosDeServidor(respuestas);
      await comprobarInvariantes();
    });

    it('9 · diez creaciones a la vez en casillas distintas entran todas', async () => {
      const respuestas = await Promise.all(
        Array.from({ length: 10 }, (_, indice) =>
          crear({ element_type: 'EMPTY', row_number: Math.floor(indice / 5) + 1, column_number: (indice % 5) + 1 }),
        ),
      );

      sinFallosDeServidor(respuestas);
      assert.equal(respuestas.filter((res) => res.status === 201).length, 10);
      assert.equal((await elementos()).length, 10);
      await comprobarInvariantes();
    });

    it('10 · crear y publicar la versión a la vez no deja un elemento en una versión publicada', async () => {
      const [creacion, publicacion] = await Promise.all([
        crear({ element_type: 'BATHROOM', row_number: 3, column_number: 3 }),
        post(`/layouts/${layoutId}/publish`, {}, token()),
      ]);

      sinFallosDeServidor([creacion, publicacion]);
      // Publicar exige al menos un asiento, así que aquí siempre falla; lo que importa es que
      // ninguna de las dos reviente ni deje la versión a medias.
      const version = await queryOne<{ status: string }>('SELECT status FROM bus_layouts WHERE id = ?', [layoutId]);
      assert.ok(['DRAFT', 'PUBLISHED'].includes(String(version?.status)));
      await comprobarInvariantes();
    });

    it('11 · el rollback de una creación rechazada no deja rastro', async () => {
      const previo = await crear({ element_type: 'BATHROOM', row_number: 2, column_number: 2 });
      assert.equal(previo.status, 201);

      const antes = await elementos();
      const rechazada = await crear({ element_type: 'DOOR', row_number: 2, column_number: 2 });
      assert.equal(rechazada.status, 400);

      assert.deepEqual(await elementos(), antes, 'la fila rechazada no puede haberse quedado');
      await comprobarInvariantes();
    });

    it('12 · el rollback de un movimiento rechazado deja el elemento donde estaba', async () => {
      const uno = await crear({ element_type: 'BATHROOM', row_number: 2, column_number: 2 });
      const dos = await crear({ element_type: 'DOOR', row_number: 3, column_number: 3 });
      assert.equal(uno.status, 201);
      assert.equal(dos.status, 201);

      const antes = await elementos();
      const rechazado = await mover(Number(dos.body.data.id), { row_number: 2, column_number: 2 });
      assert.equal(rechazado.status, 400);

      assert.deepEqual(await elementos(), antes);
      await comprobarInvariantes();
    });
  });

  // =====================================================================
  describe('Lo funcional sigue igual', () => {
    it('13 · se crean y se mueven los cinco tipos', async () => {
      const tipos = ['BATHROOM', 'STAIRS', 'DRIVER', 'DOOR', 'EMPTY'];
      for (const [indice, tipo] of tipos.entries()) {
        const res = await crear({ element_type: tipo, row_number: 1, column_number: indice + 1 });
        assert.equal(res.status, 201, `${tipo}: ${JSON.stringify(res.body)}`);

        const movido = await mover(Number(res.body.data.id), { row_number: 2, column_number: indice + 1 });
        assert.equal(movido.status, 200, `${tipo}: ${JSON.stringify(movido.body)}`);
        assert.equal(movido.body.data.element_type, tipo);
      }
      assert.equal((await elementos()).length, 5);
      await comprobarInvariantes();
    });

    it('14 · `row_span` y `col_span` siguen funcionando y ocupando de verdad', async () => {
      const res = await crear({ element_type: 'STAIRS', row_number: 3, column_number: 3, row_span: 2, col_span: 2 });
      assert.equal(res.status, 201);
      assert.equal(Number(res.body.data.row_span), 2);
      assert.equal(Number(res.body.data.col_span), 2);

      // Las cuatro casillas están tomadas.
      for (const [fila, columna] of [[3, 3], [3, 4], [4, 3], [4, 4]]) {
        const choque = await crear({ element_type: 'DOOR', row_number: fila, column_number: columna });
        assert.equal(choque.status, 400, `(${fila}, ${columna}) debería estar ocupada`);
      }
      // Y la de al lado no.
      assert.equal((await crear({ element_type: 'DOOR', row_number: 3, column_number: 5 })).status, 201);
    });

    it('15 · fuera de la rejilla se sigue rechazando, con el mensaje de siempre', async () => {
      const res = await crear({ element_type: 'BATHROOM', row_number: 10, column_number: 1, row_span: 2 });
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /se sale del piso/i);
    });

    it('16 · una casilla ocupada se sigue rechazando con su mensaje', async () => {
      assert.equal((await crear({ element_type: 'BATHROOM', row_number: 4, column_number: 4 })).status, 201);
      const res = await crear({ element_type: 'DOOR', row_number: 4, column_number: 4 });
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /ya la ocupa un elemento/i);
    });

    it('17 · un elemento no puede caer sobre un asiento', async () => {
      await execute(
        `INSERT INTO seats (bus_id, layout_id, deck_id, seat_type_id, seat_number, \`row_number\`, column_number, is_window, is_aisle, status)
         VALUES (?, ?, ?, NULL, '01', 5, 5, 0, 0, 'AVAILABLE')`,
        [ctx.fixtures.busA, layoutId, deckId],
      );
      const res = await crear({ element_type: 'DOOR', row_number: 5, column_number: 5 });
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /ya la ocupa un asiento/i);
    });

    it('18 · una versión publicada no admite elementos nuevos ni movimientos', async () => {
      const existente = await crear({ element_type: 'DRIVER', row_number: 1, column_number: 1 });
      assert.equal(existente.status, 201);

      await execute("UPDATE bus_layouts SET status = 'ARCHIVED' WHERE bus_id = ? AND status = 'PUBLISHED'", [ctx.fixtures.busA]);
      await execute("UPDATE bus_layouts SET status = 'PUBLISHED' WHERE id = ?", [layoutId]);

      const creacion = await crear({ element_type: 'DOOR', row_number: 2, column_number: 2 });
      assert.equal(creacion.status, 400);
      assert.match(String(creacion.body.message), /clónala|publicada/i);

      const movimiento = await mover(Number(existente.body.data.id), { row_number: 3, column_number: 3 });
      assert.equal(movimiento.status, 400);

      const sinCambios = await elementos();
      assert.equal(at(sinCambios, 0).row_number, 1);
    });

    it('19 · piso y elemento inexistentes responden 404', async () => {
      assert.equal((await post('/decks/99999999/elements', { element_type: 'DOOR', row_number: 1, column_number: 1 }, token())).status, 404);
      assert.equal((await patch('/elements/99999999', { row_number: 1 }, token())).status, 404);
    });

    it('20 · permisos y aislamiento intactos', async () => {
      const cuerpo = { element_type: 'DOOR', row_number: 8, column_number: 2 };

      assert.equal((await post(`/decks/${deckId}/elements`, cuerpo, ctx.sessions.operator.token)).status, 403);
      assert.equal((await post(`/decks/${deckId}/elements`, cuerpo, ctx.sessions.customer.token)).status, 403);
      assert.equal((await post(`/decks/${deckId}/elements`, cuerpo, ctx.sessions.companyAdminB.token)).status, 403);
      assert.equal((await post(`/decks/${deckId}/elements`, cuerpo)).status, 401);
      // El OPERATOR conserva la lectura que ya tenía.
      assert.equal((await get(`/layouts/${layoutId}`, ctx.sessions.operator.token)).status, 200);
      // Y quien tiene `buses.update` sigue pudiendo.
      assert.equal((await post(`/decks/${deckId}/elements`, cuerpo, token())).status, 201);
    });

    it('21 · borrar un elemento sigue funcionando y libera su casilla', async () => {
      const res = await crear({ element_type: 'STAIRS', row_number: 6, column_number: 2, row_span: 2, col_span: 2 });
      assert.equal(res.status, 201);

      assert.equal((await del(`/elements/${res.body.data.id}`, token())).status, 200);
      assert.equal((await elementos()).length, 0);
      assert.equal((await crear({ element_type: 'DOOR', row_number: 6, column_number: 2 })).status, 201);
    });

    it('22 · borrar y mover a la vez no deja un elemento resucitado', async () => {
      const res = await crear({ element_type: 'BATHROOM', row_number: 4, column_number: 2 });
      assert.equal(res.status, 201);
      const id = Number(res.body.data.id);

      const [borrado, movimiento] = await Promise.all([del(`/elements/${id}`, token()), mover(id, { row_number: 5, column_number: 2 })]);
      sinFallosDeServidor([borrado, movimiento]);

      const quedan = await elementos();
      assert.ok(quedan.length <= 1);
      if (quedan.length === 0) assert.equal(borrado.status, 200);
      await comprobarInvariantes();
    });

    it('23 · una rejilla sin declarar sigue sin limitar', async () => {
      await execute('UPDATE bus_layout_decks SET row_count = 0, column_count = 0 WHERE id = ?', [deckId]);
      const res = await crear({ element_type: 'BATHROOM', row_number: 40, column_number: 9 });
      assert.equal(res.status, 201, 'un piso heredado de la migración no se puede quedar bloqueado');
    });

    it('24 · encoger sigue mirando asientos y elementos (FASE 6G-4 intacta)', async () => {
      await crear({ element_type: 'BATHROOM', row_number: 9, column_number: 1, row_span: 2 });
      assert.equal((await rejilla({ row_count: 9 })).status, 400, 'el elemento llega hasta la fila 10');

      await execute('DELETE FROM bus_layout_elements WHERE deck_id = ?', [deckId]);
      await execute(
        `INSERT INTO seats (bus_id, layout_id, deck_id, seat_type_id, seat_number, \`row_number\`, column_number, is_window, is_aisle, status)
         VALUES (?, ?, ?, NULL, '02', 10, 1, 0, 0, 'AVAILABLE')`,
        [ctx.fixtures.busA, layoutId, deckId],
      );
      const res = await rejilla({ row_count: 9 });
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /encogerse/i);
      assert.equal(Number((await piso())?.row_count), 10);
    });
  });
});
