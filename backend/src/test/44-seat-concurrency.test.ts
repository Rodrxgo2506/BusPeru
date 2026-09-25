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

interface Celda {
  id: number;
  row_number: number | null;
  column_number: number | null;
}

/**
 * H-07 (cierre) · los ASIENTOS se serializan igual que los elementos.
 *
 * LO QUE QUEDABA. La fase anterior metió `createElement` y `updateElement` bajo el cerrojo del
 * bus, pero `createSeat` y `updateSeat` seguían comprobando la casilla por el pool y
 * escribiendo después. Quedaba abierto que dos asientos se quedaran la misma casilla, que un
 * asiento cayera sobre un elemento colocado a la vez, o que acabara fuera de una rejilla
 * recién encogida.
 *
 * CÓMO SE PRUEBA. Igual que en la fase anterior: peticiones HTTP de verdad lanzadas a la vez
 * y, después, los invariantes que ninguna secuencia serial podría romper. Quién gana da igual.
 */
describe('H-07 · asientos y geometría bajo el mismo cerrojo', () => {
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
    // La reserva artificial de la prueba del borrado impediría limpiar los asientos:
    // `fk_booking_seats_seat` es RESTRICT, que es justo lo que protege el histórico.
    await execute(
      "DELETE bs FROM booking_seats bs JOIN bookings bk ON bk.id = bs.booking_id WHERE bk.booking_code LIKE 'CNC-%'",
    );
    await execute("DELETE FROM bookings WHERE booking_code LIKE 'CNC-%'");
    await execute('DELETE FROM seats WHERE layout_id NOT IN (?, ?)', [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
    await execute('DELETE FROM bus_layouts WHERE id NOT IN (?, ?)', [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);

    const borrador = await createBusLayout(ctx.fixtures.busA, { version: 5, status: 'DRAFT', decks: 2, rows: 10, columns: 6 });
    layoutId = borrador.layoutId;
    deckId = at(borrador.deckIds, 0);
    deck2Id = at(borrador.deckIds, 1);
    await execute('UPDATE bus_layout_decks SET row_count = 6, column_count = 4 WHERE id = ?', [deck2Id]);
  });

  const token = () => ctx.sessions.companyAdmin.token;

  const crearAsiento = (cuerpo: Record<string, unknown>, deck = deckId) => post(`/decks/${deck}/seats`, cuerpo, token());
  const moverAsiento = (id: number, cuerpo: Record<string, unknown>) => patch(`/layout-seats/${id}`, cuerpo, token());
  const crearElemento = (cuerpo: Record<string, unknown>, deck = deckId) => post(`/decks/${deck}/elements`, cuerpo, token());
  const moverElemento = (id: number, cuerpo: Record<string, unknown>) => patch(`/elements/${id}`, cuerpo, token());
  const rejilla = (cuerpo: Record<string, unknown>, deck = deckId) => patch(`/decks/${deck}`, cuerpo, token());

  const piso = (id = deckId) =>
    queryOne<{ row_count: number; column_count: number }>('SELECT row_count, column_count FROM bus_layout_decks WHERE id = ?', [id]);
  const asientos = (id = deckId) =>
    query<Celda & { seat_number: string; layout_id: number | null }>(
      'SELECT id, `row_number`, column_number, seat_number, layout_id FROM seats WHERE deck_id = ? ORDER BY id',
      [id],
    );

  /**
   * Los invariantes: nada fuera de la rejilla declarada y ninguna casilla compartida, ni
   * entre asientos, ni entre elementos, ni de unos con otros.
   */
  async function comprobarInvariantes(id = deckId): Promise<void> {
    const actual = await piso(id);
    const filas = Number(actual?.row_count ?? 0);
    const columnas = Number(actual?.column_count ?? 0);
    const ocupadas = new Map<string, string>();

    const elementos = await query<Celda & { row_span: number; col_span: number }>(
      'SELECT id, `row_number`, column_number, row_span, col_span FROM bus_layout_elements WHERE deck_id = ?',
      [id],
    );
    for (const elemento of elementos) {
      const hastaFila = Number(elemento.row_number) + elemento.row_span - 1;
      const hastaColumna = Number(elemento.column_number) + elemento.col_span - 1;
      if (filas > 0) assert.ok(hastaFila <= filas, `el elemento ${elemento.id} llega a la fila ${hastaFila} y el piso tiene ${filas}`);
      if (columnas > 0) {
        assert.ok(hastaColumna <= columnas, `el elemento ${elemento.id} llega a la columna ${hastaColumna} y el piso tiene ${columnas}`);
      }
      for (let fila = Number(elemento.row_number); fila <= hastaFila; fila += 1) {
        for (let columna = Number(elemento.column_number); columna <= hastaColumna; columna += 1) {
          const casilla = `${fila}:${columna}`;
          assert.equal(ocupadas.get(casilla), undefined, `la casilla ${casilla} la comparten ${ocupadas.get(casilla)} y el elemento ${elemento.id}`);
          ocupadas.set(casilla, `elemento ${elemento.id}`);
        }
      }
    }

    for (const asiento of await asientos(id)) {
      if (asiento.row_number === null || asiento.column_number === null) continue;
      if (filas > 0) assert.ok(asiento.row_number <= filas, `el asiento ${asiento.id} está en la fila ${asiento.row_number} y el piso tiene ${filas}`);
      if (columnas > 0) {
        assert.ok(asiento.column_number <= columnas, `el asiento ${asiento.id} está en la columna ${asiento.column_number} y el piso tiene ${columnas}`);
      }
      const casilla = `${asiento.row_number}:${asiento.column_number}`;
      assert.equal(ocupadas.get(casilla), undefined, `la casilla ${casilla} la comparten ${ocupadas.get(casilla)} y el asiento ${asiento.id}`);
      ocupadas.set(casilla, `asiento ${asiento.id}`);
    }
  }

  /** `seat_count` de la versión tiene que seguir cuadrando con los asientos reales. */
  async function comprobarRecuento(): Promise<void> {
    const fila = await queryOne<{ seat_count: number; reales: number }>(
      'SELECT seat_count, (SELECT COUNT(*) FROM seats s WHERE s.layout_id = bl.id) AS reales FROM bus_layouts bl WHERE bl.id = ?',
      [layoutId],
    );
    assert.equal(Number(fila?.seat_count), Number(fila?.reales), 'el recuento de la versión no cuadra con sus asientos');
  }

  function sinFallosDeServidor(respuestas: Array<{ status: number; body: { message?: string } }>): void {
    for (const res of respuestas) {
      assert.ok(res.status < 500, `respuesta ${res.status}: ${JSON.stringify(res.body)}`);
      assert.ok([200, 201, 400, 401, 403, 404, 409].includes(res.status), `estado inesperado ${res.status}`);
      const texto = JSON.stringify(res.body);
      for (const rastro of ['ER_LOCK', 'Deadlock', 'ER_DUP', 'sqlMessage']) {
        assert.equal(texto.includes(rastro), false, `la respuesta filtra ${rastro}`);
      }
    }
  }

  // =====================================================================
  describe('Carreras reales', () => {
    it('1 · crear un asiento y encoger el piso a la vez', async () => {
      const [creacion, encogimiento] = await Promise.all([
        crearAsiento({ seat_number: '99', row_number: 10, column_number: 1 }),
        rejilla({ row_count: 9 }),
      ]);

      sinFallosDeServidor([creacion, encogimiento]);
      await comprobarInvariantes();
      await comprobarRecuento();
      // F12-06: como en su gemela de elementos, alguna de las dos tiene que prosperar; si no, el test
      // pasaba aunque ambas fallaran.
      assert.ok(creacion.status === 201 || encogimiento.status === 200, `alguna de las dos debería prosperar: ${creacion.status}/${encogimiento.status}`);
      if (creacion.status === 201) assert.equal(encogimiento.status, 400, 'si el asiento entró, la rejilla no pudo encoger');
      if (encogimiento.status === 200) assert.equal(creacion.status, 400, 'si la rejilla encogió, el asiento no cabía');
    });

    it('2 · mover un asiento y encoger el piso a la vez', async () => {
      const existente = await crearAsiento({ seat_number: '01', row_number: 1, column_number: 1 });
      assert.equal(existente.status, 201, JSON.stringify(existente.body));

      const [movimiento, encogimiento] = await Promise.all([
        moverAsiento(Number(existente.body.data.id), { row_number: 10, column_number: 6 }),
        rejilla({ row_count: 9, column_count: 5 }),
      ]);

      sinFallosDeServidor([movimiento, encogimiento]);
      await comprobarInvariantes();
      await comprobarRecuento();
    });

    it('3 · dos creaciones sobre la MISMA casilla: entra exactamente una', async () => {
      const [una, otra] = await Promise.all([
        crearAsiento({ seat_number: 'A1', row_number: 4, column_number: 4 }),
        crearAsiento({ seat_number: 'A2', row_number: 4, column_number: 4 }),
      ]);

      sinFallosDeServidor([una, otra]);
      assert.equal([una, otra].filter((res) => res.status === 201).length, 1, 'la casilla es de uno solo');
      assert.equal((await asientos()).length, 1);
      await comprobarInvariantes();
      await comprobarRecuento();
    });

    it('4 · dos creaciones en casillas distintas: entran las dos', async () => {
      const [una, otra] = await Promise.all([
        crearAsiento({ seat_number: 'B1', row_number: 2, column_number: 1 }),
        crearAsiento({ seat_number: 'B2', row_number: 2, column_number: 2 }),
      ]);

      sinFallosDeServidor([una, otra]);
      assert.equal(una.status, 201, JSON.stringify(una.body));
      assert.equal(otra.status, 201, JSON.stringify(otra.body));
      await comprobarInvariantes();
      await comprobarRecuento();
    });

    it('5 · dos movimientos hacia la misma casilla no acaban encimados', async () => {
      const uno = await crearAsiento({ seat_number: 'C1', row_number: 1, column_number: 1 });
      const dos = await crearAsiento({ seat_number: 'C2', row_number: 1, column_number: 3 });
      assert.equal(uno.status, 201);
      assert.equal(dos.status, 201);

      const [a, b] = await Promise.all([
        moverAsiento(Number(uno.body.data.id), { row_number: 7, column_number: 2 }),
        moverAsiento(Number(dos.body.data.id), { row_number: 7, column_number: 2 }),
      ]);

      sinFallosDeServidor([a, b]);
      assert.equal([a, b].filter((res) => res.status === 200).length, 1);
      assert.equal((await asientos()).length, 2, 'ninguno se pierde');
      await comprobarInvariantes();
    });

    it('6 · crear un asiento y mover un elemento a la misma casilla', async () => {
      const elemento = await crearElemento({ element_type: 'BATHROOM', row_number: 1, column_number: 1 });
      assert.equal(elemento.status, 201);

      const [asiento, movimiento] = await Promise.all([
        crearAsiento({ seat_number: 'D1', row_number: 6, column_number: 3 }),
        moverElemento(Number(elemento.body.data.id), { row_number: 6, column_number: 3 }),
      ]);

      sinFallosDeServidor([asiento, movimiento]);
      assert.equal(
        [asiento.status === 201, movimiento.status === 200].filter(Boolean).length,
        1,
        'la casilla no puede ser de los dos',
      );
      await comprobarInvariantes();
    });

    it('7 · crear asiento, crear elemento y encoger el piso, todo a la vez', async () => {
      const respuestas = await Promise.all([
        crearAsiento({ seat_number: 'E1', row_number: 9, column_number: 2 }),
        crearElemento({ element_type: 'STAIRS', row_number: 9, column_number: 2 }),
        rejilla({ row_count: 8 }),
      ]);

      sinFallosDeServidor(respuestas);
      await comprobarInvariantes();
      await comprobarRecuento();
    });

    it('8 · doce asientos creados a la vez en el mismo piso', async () => {
      const respuestas = await Promise.all(
        Array.from({ length: 12 }, (_, indice) =>
          crearAsiento({
            seat_number: `F${indice + 1}`,
            row_number: Math.floor(indice / 4) + 1,
            column_number: (indice % 4) + 1,
          }),
        ),
      );

      sinFallosDeServidor(respuestas);
      assert.equal(respuestas.filter((res) => res.status === 201).length, 12);
      assert.equal((await asientos()).length, 12);
      await comprobarInvariantes();
      await comprobarRecuento();
    });

    it('9 · el mismo bus, dos pisos distintos: las dos operaciones caben', async () => {
      const [uno, dos] = await Promise.all([
        crearAsiento({ seat_number: 'G1', row_number: 2, column_number: 2 }, deckId),
        crearAsiento({ seat_number: 'G2', row_number: 2, column_number: 2 }, deck2Id),
      ]);

      sinFallosDeServidor([uno, dos]);
      assert.equal(uno.status, 201, JSON.stringify(uno.body));
      assert.equal(dos.status, 201, JSON.stringify(dos.body));
      await comprobarInvariantes(deckId);
      await comprobarInvariantes(deck2Id);
      await comprobarRecuento();
    });

    it('10 · dos creaciones con el MISMO número: una sola, y con mensaje de negocio', async () => {
      const [una, otra] = await Promise.all([
        crearAsiento({ seat_number: 'H1', row_number: 3, column_number: 1 }),
        crearAsiento({ seat_number: 'H1', row_number: 3, column_number: 2 }),
      ]);

      sinFallosDeServidor([una, otra]);
      assert.equal([una, otra].filter((res) => res.status === 201).length, 1);
      const rechazada = [una, otra].find((res) => res.status !== 201)!;
      assert.equal(rechazada.status, 400);
      assert.match(String(rechazada.body.message), /ya tiene un asiento/i);
      await comprobarRecuento();
    });

    it('11 · el rollback de una creación rechazada no deja rastro ni descuadra el recuento', async () => {
      assert.equal((await crearAsiento({ seat_number: 'I1', row_number: 2, column_number: 2 })).status, 201);
      const antes = await asientos();

      const rechazada = await crearAsiento({ seat_number: 'I2', row_number: 2, column_number: 2 });
      assert.equal(rechazada.status, 400);

      assert.deepEqual(await asientos(), antes);
      await comprobarRecuento();
    });

    it('12 · el rollback de un movimiento rechazado deja el asiento donde estaba', async () => {
      const uno = await crearAsiento({ seat_number: 'J1', row_number: 2, column_number: 2 });
      const dos = await crearAsiento({ seat_number: 'J2', row_number: 3, column_number: 3 });
      assert.equal(uno.status, 201);
      assert.equal(dos.status, 201);
      const antes = await asientos();

      const rechazado = await moverAsiento(Number(dos.body.data.id), { row_number: 2, column_number: 2 });
      assert.equal(rechazado.status, 400);

      assert.deepEqual(await asientos(), antes);
      await comprobarInvariantes();
    });

    it('13 · crear asientos y publicar la versión a la vez no deja la versión a medias', async () => {
      assert.equal((await crearAsiento({ seat_number: 'K0', row_number: 1, column_number: 1 })).status, 201);

      const respuestas = await Promise.all([
        crearAsiento({ seat_number: 'K1', row_number: 1, column_number: 2 }),
        crearAsiento({ seat_number: 'K2', row_number: 1, column_number: 3 }),
        post(`/layouts/${layoutId}/publish`, {}, token()),
      ]);

      sinFallosDeServidor(respuestas);
      const version = await queryOne<{ status: string; seat_count: number }>(
        'SELECT status, seat_count FROM bus_layouts WHERE id = ?',
        [layoutId],
      );
      assert.ok(['DRAFT', 'PUBLISHED'].includes(String(version?.status)));
      await comprobarRecuento();
      await comprobarInvariantes();
    });
  });

  // =====================================================================
  describe('Lo funcional sigue igual', () => {
    it('14 · crear, editar parcialmente y borrar un asiento', async () => {
      const creado = await crearAsiento({ seat_number: '01', row_number: 1, column_number: 1, is_window: true });
      assert.equal(creado.status, 201, JSON.stringify(creado.body));
      const id = Number(creado.body.data.id);
      assert.equal(Number(creado.body.data.is_window), 1);

      // Solo el número: lo demás se conserva.
      const renumerado = await moverAsiento(id, { seat_number: '01-A' });
      assert.equal(renumerado.status, 200, JSON.stringify(renumerado.body));
      assert.equal(renumerado.body.data.seat_number, '01-A');
      assert.equal(Number(renumerado.body.data.row_number), 1);
      assert.equal(Number(renumerado.body.data.column_number), 1);
      assert.equal(Number(renumerado.body.data.is_window), 1);

      assert.equal((await moverAsiento(id, { status: 'INACTIVE' })).body.data.status, 'INACTIVE');
      assert.equal((await del(`/layout-seats/${id}`, token())).status, 200);
      assert.equal((await asientos()).length, 0);
      await comprobarRecuento();
    });

    it('15 · fuera de la rejilla se sigue rechazando con su mensaje', async () => {
      const res = await crearAsiento({ seat_number: '01', row_number: 11, column_number: 1 });
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /se sale del piso/i);
    });

    it('16 · una casilla ocupada por otro asiento se sigue rechazando', async () => {
      assert.equal((await crearAsiento({ seat_number: '01', row_number: 4, column_number: 4 })).status, 201);
      const res = await crearAsiento({ seat_number: '02', row_number: 4, column_number: 4 });
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /ya la ocupa un asiento/i);
    });

    it('17 · una casilla ocupada por un elemento también', async () => {
      assert.equal((await crearElemento({ element_type: 'BATHROOM', row_number: 5, column_number: 5 })).status, 201);
      const res = await crearAsiento({ seat_number: '01', row_number: 5, column_number: 5 });
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /ya la ocupa un elemento/i);
    });

    it('18 · el número repetido y el tipo inexistente se siguen rechazando', async () => {
      assert.equal((await crearAsiento({ seat_number: '01', row_number: 1, column_number: 1 })).status, 201);

      const repetido = await crearAsiento({ seat_number: '01', row_number: 1, column_number: 2 });
      assert.equal(repetido.status, 400);
      assert.match(String(repetido.body.message), /ya tiene un asiento/i);

      const tipoMalo = await crearAsiento({ seat_number: '02', row_number: 1, column_number: 2, seat_type_id: 999999 });
      assert.equal(tipoMalo.status, 400);
      assert.match(String(tipoMalo.body.message), /tipo de asiento/i);
    });

    it('19 · un asiento no salta a un piso de otra versión', async () => {
      const creado = await crearAsiento({ seat_number: '01', row_number: 1, column_number: 1 });
      assert.equal(creado.status, 201);

      const otra = await createBusLayout(ctx.fixtures.busA, { version: 8, status: 'DRAFT', rows: 4, columns: 4 });
      const res = await moverAsiento(Number(creado.body.data.id), { deck_id: at(otra.deckIds, 0) });
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /otra versión/i);
    });

    it('20 · mover un asiento al otro piso de la MISMA versión sí funciona', async () => {
      const creado = await crearAsiento({ seat_number: '01', row_number: 1, column_number: 1 });
      assert.equal(creado.status, 201);

      const res = await moverAsiento(Number(creado.body.data.id), { deck_id: deck2Id, row_number: 2, column_number: 2 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(Number(res.body.data.deck_id), deck2Id);
      await comprobarRecuento();
    });

    it('21 · una versión publicada no admite asientos nuevos ni movimientos', async () => {
      const creado = await crearAsiento({ seat_number: '01', row_number: 1, column_number: 1 });
      assert.equal(creado.status, 201);

      await execute("UPDATE bus_layouts SET status = 'ARCHIVED' WHERE bus_id = ? AND status = 'PUBLISHED'", [ctx.fixtures.busA]);
      await execute("UPDATE bus_layouts SET status = 'PUBLISHED' WHERE id = ?", [layoutId]);

      const nuevo = await crearAsiento({ seat_number: '02', row_number: 2, column_number: 2 });
      assert.equal(nuevo.status, 400);
      assert.match(String(nuevo.body.message), /clónala|publicada/i);

      const movido = await moverAsiento(Number(creado.body.data.id), { row_number: 3, column_number: 3 });
      assert.equal(movido.status, 400);
      assert.equal(at(await asientos(), 0).row_number, 1);
    });

    it('22 · piso y asiento inexistentes responden 404', async () => {
      assert.equal((await post('/decks/99999999/seats', { seat_number: '01', row_number: 1, column_number: 1 }, token())).status, 404);
      assert.equal((await patch('/layout-seats/99999999', { row_number: 1 }, token())).status, 404);
    });

    it('23 · permisos y aislamiento intactos', async () => {
      const cuerpo = { seat_number: 'P1', row_number: 8, column_number: 2 };

      assert.equal((await post(`/decks/${deckId}/seats`, cuerpo, ctx.sessions.operator.token)).status, 403);
      assert.equal((await post(`/decks/${deckId}/seats`, cuerpo, ctx.sessions.customer.token)).status, 403);
      assert.equal((await post(`/decks/${deckId}/seats`, cuerpo, ctx.sessions.companyAdminB.token)).status, 403);
      assert.equal((await post(`/decks/${deckId}/seats`, cuerpo)).status, 401);
      assert.equal((await get(`/layouts/${layoutId}`, ctx.sessions.operator.token)).status, 200);
      assert.equal((await post(`/decks/${deckId}/seats`, cuerpo, token())).status, 201);
    });

    it('24 · un asiento vendido no se puede borrar', async () => {
      // El asiento va en el BORRADOR: sobre una versión publicada saltaría antes la regla de
      // «clónala para editarla», que es la de siempre y no es lo que se quiere probar aquí.
      const creado = await crearAsiento({ seat_number: 'V1', row_number: 3, column_number: 1 });
      assert.equal(creado.status, 201, JSON.stringify(creado.body));
      const vendido = Number(creado.body.data.id);
      const usuario = await queryOne<{ id: number }>("SELECT id FROM users WHERE email = 'cliente@test.pe' LIMIT 1");
      const reserva = await execute(
        `INSERT INTO bookings (booking_code, trip_id, user_id, subtotal, discount_amount, service_fee, total_amount, status, passenger_name, passenger_document)
         VALUES (?, ?, ?, 50, 0, 2.5, 52.5, 'CONFIRMED', 'Prueba', '00000000')`,
        [`CNC-${Date.now()}`, ctx.fixtures.tripA, usuario?.id],
      );
      await execute('INSERT INTO booking_seats (booking_id, trip_id, seat_id, price) VALUES (?,?,?,50)', [
        reserva.insertId,
        ctx.fixtures.tripA,
        vendido,
      ]);

      const res = await del(`/layout-seats/${vendido}`, token());
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /reservas/i);
      assert.ok(await queryOne('SELECT id FROM seats WHERE id = ?', [vendido]), 'el asiento sigue ahí');
    });

    it('25 · borrar y mover a la vez no resucita el asiento', async () => {
      const creado = await crearAsiento({ seat_number: 'Q1', row_number: 4, column_number: 2 });
      assert.equal(creado.status, 201);
      const id = Number(creado.body.data.id);

      const [borrado, movimiento] = await Promise.all([
        del(`/layout-seats/${id}`, token()),
        moverAsiento(id, { row_number: 5, column_number: 2 }),
      ]);
      sinFallosDeServidor([borrado, movimiento]);

      assert.ok((await asientos()).length <= 1);
      await comprobarInvariantes();
      await comprobarRecuento();
    });

    it('26 · una rejilla sin declarar sigue sin limitar', async () => {
      await execute('UPDATE bus_layout_decks SET row_count = 0, column_count = 0 WHERE id = ?', [deckId]);
      assert.equal((await crearAsiento({ seat_number: 'R1', row_number: 40, column_number: 9 })).status, 201);
    });

    it('27 · el mapa del pasajero y las reservas siguen funcionando', async () => {
      // Sobre la versión publicada de los fixtures, que esta prueba no toca.
      const mapa = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);
      assert.equal(mapa.status, 200);
      assert.ok(mapa.body.data.length > 0);

      const libre = (mapa.body.data as Array<{ id: number; is_taken: number; status: string }>).find(
        (asiento) => asiento.is_taken === 0 && asiento.status === 'AVAILABLE',
      );
      assert.ok(libre, 'debería quedar algún asiento libre');

      const reserva = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [libre.id], passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token,
      );
      assert.equal(reserva.status, 201, JSON.stringify(reserva.body));
    });

    it('28 · la fase anterior sigue en pie: elementos y encogimiento', async () => {
      assert.equal((await crearElemento({ element_type: 'BATHROOM', row_number: 9, column_number: 1, row_span: 2 })).status, 201);
      assert.equal((await rejilla({ row_count: 9 })).status, 400, 'el elemento llega a la fila 10');

      assert.equal((await crearAsiento({ seat_number: 'S1', row_number: 10, column_number: 3 })).status, 201);
      const res = await rejilla({ row_count: 9, column_count: 6 });
      assert.equal(res.status, 400);
      assert.equal(Number((await piso())?.row_count), 10);
    });
  });
});
