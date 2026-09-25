import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { del, get, post, put } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';
import * as layouts from '../services/bus-layout.service';

/**
 * Migración 010 · editor de la versión: pisos, elementos y asientos.
 *
 * LA REGLA QUE GOBIERNA TODO. Solo se edita un BORRADOR. Una versión publicada o archivada es
 * el historial de los viajes que la usan y no se toca por ninguna vía; para cambiarla hay que
 * clonarla. Cada operación de este archivo comprueba esa regla por separado, porque basta con
 * que una sola se la salte para que un viaje ya vendido cambie de mapa.
 *
 * LO SEGUNDO EN IMPORTANCIA. Que el servidor decida siempre `layout_id`, `deck_id` y `bus_id`.
 * Si el cliente pudiera fijarlos, un asiento podría acabar en la versión —o en el bus— de otra
 * empresa, y el aislamiento multiempresa se caería por ahí.
 */
describe('Editor de la distribución del bus (migración 010)', () => {
  let ctx: SuiteContext;
  let borrador: layouts.BusLayout;
  let piso: layouts.BusLayoutDeck;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  beforeEach(async () => {
    await execute('DELETE FROM financial_transactions');
    await execute('DELETE FROM payments');
    await execute('DELETE FROM booking_seats');
    await execute('DELETE FROM bookings');

    // Los viajes vuelven a la versión de los fixtures antes de borrar nada: la clave ajena
    // del histórico es RESTRICT y no dejaría borrar una versión todavía en uso.
    await execute('UPDATE trips SET bus_layout_id = ? WHERE bus_id = ?', [ctx.fixtures.layoutA, ctx.fixtures.busA]);
    await execute('UPDATE trips SET bus_layout_id = ? WHERE bus_id = ?', [ctx.fixtures.layoutB, ctx.fixtures.busB]);
    await execute('DELETE FROM bus_layout_elements');
    await execute('DELETE FROM seats WHERE layout_id NOT IN (?, ?)', [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
    await execute('DELETE FROM bus_layouts WHERE id NOT IN (?, ?)', [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
    await execute("UPDATE bus_layouts SET status = 'PUBLISHED' WHERE id IN (?, ?)", [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);

    // Un borrador limpio con un piso de 10×4 para cada prueba.
    borrador = await layouts.createDraft(ctx.fixtures.busA, { decks: [{ deck_number: 1, name: 'Piso 1', row_count: 10, column_count: 4 }] });
    piso = at(await layouts.listDecks(borrador.id), 0);
  });

  /** Asiento de conveniencia dentro del borrador. */
  async function nuevoAsiento(numero: string, fila: number, columna: number) {
    return layouts.createSeat(piso.id, { seat_number: numero, row_number: fila, column_number: columna });
  }

  // =========================================================================
  describe('Pisos', () => {
    it('1 · se crea un piso en un borrador', async () => {
      const segundo = await layouts.createDeck(borrador.id, { deck_number: 2, name: 'Alto', row_count: 8, column_count: 4 });

      assert.equal(segundo.layout_id, borrador.id);
      assert.equal(segundo.deck_number, 2);
      assert.equal(segundo.row_count, 8);
    });

    it('2 · se listan los pisos de la versión', async () => {
      await layouts.createDeck(borrador.id, { deck_number: 2 });
      const pisos = await layouts.listDecks(borrador.id);

      assert.equal(pisos.length, 2);
      assert.deepEqual(pisos.map((entrada) => entrada.deck_number), [1, 2]);
    });

    it('3 · se edita un piso', async () => {
      const editado = await layouts.updateDeck(piso.id, { name: 'Renombrado', row_count: 12 });

      assert.equal(editado.name, 'Renombrado');
      assert.equal(editado.row_count, 12);
      assert.equal(editado.column_count, 4, 'lo que no se envía no cambia');
    });

    it('4 · se elimina un piso vacío', async () => {
      const segundo = await layouts.createDeck(borrador.id, { deck_number: 2 });

      await layouts.deleteDeck(segundo.id);

      assert.equal((await layouts.listDecks(borrador.id)).length, 1);
    });

    it('5 · repetir el número de piso dentro de la versión falla', async () => {
      await assert.rejects(() => layouts.createDeck(borrador.id, { deck_number: 1 }), (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 400);
        assert.match(String((error as { message?: string }).message), /ya tiene un piso/i);
        return true;
      });
    });

    it('6 · un número de piso inválido falla', async () => {
      await assert.rejects(() => layouts.createDeck(borrador.id, { deck_number: 0 }));
      await assert.rejects(() => layouts.createDeck(borrador.id, { deck_number: -3 }));
    });

    it('7 · la rejilla no puede encoger por debajo de los asientos que ya tiene', async () => {
      await nuevoAsiento('01', 9, 3);

      await assert.rejects(() => layouts.updateDeck(piso.id, { row_count: 5 }), (error: unknown) => {
        assert.match(String((error as { message?: string }).message), /encogerse/i);
        return true;
      });
    });

    it('8 · un piso con asientos no se elimina', async () => {
      await nuevoAsiento('01', 1, 1);

      await assert.rejects(() => layouts.deleteDeck(piso.id), (error: unknown) => {
        assert.match(String((error as { message?: string }).message), /asientos/i);
        return true;
      });
      assert.equal((await layouts.listDecks(borrador.id)).length, 1, 'el piso sigue ahí');
    });

    it('9 · un piso con elementos tampoco', async () => {
      await layouts.createElement(piso.id, { element_type: 'BATHROOM', row_number: 1, column_number: 1 });

      await assert.rejects(() => layouts.deleteDeck(piso.id), (error: unknown) => {
        assert.match(String((error as { message?: string }).message), /elementos/i);
        return true;
      });
    });

    it('10 · no se puede añadir un piso a una versión PUBLICADA', async () => {
      await assert.rejects(() => layouts.createDeck(ctx.fixtures.layoutA, { deck_number: 2 }), (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 400);
        assert.match(String((error as { message?: string }).message), /cl[óo]nala/i);
        return true;
      });
    });

    it('11 · ni editar ni borrar un piso de una versión ARCHIVADA', async () => {
      await execute("UPDATE bus_layouts SET status = 'ARCHIVED' WHERE id = ?", [borrador.id]);

      await assert.rejects(() => layouts.updateDeck(piso.id, { name: 'X' }));
      await assert.rejects(() => layouts.deleteDeck(piso.id));
    });
  });

  // =========================================================================
  describe('Elementos', () => {
    for (const tipo of ['BATHROOM', 'STAIRS', 'DRIVER', 'DOOR', 'EMPTY'] as const) {
      it(`12 · se crea un elemento ${tipo}`, async () => {
        const elemento = await layouts.createElement(piso.id, { element_type: tipo, row_number: 2, column_number: 2, label: tipo });

        assert.equal(elemento.element_type, tipo);
        assert.equal(elemento.deck_id, piso.id);
        assert.equal(elemento.row_span, 1);
        assert.equal(elemento.col_span, 1);
      });
    }

    it('13 · se lista, se edita y se elimina un elemento', async () => {
      const creado = await layouts.createElement(piso.id, { element_type: 'BATHROOM', row_number: 3, column_number: 3 });
      assert.equal((await layouts.listElements(piso.id)).length, 1);

      const editado = await layouts.updateElement(creado.id, { row_number: 4, label: 'Servicio' });
      assert.equal(editado.row_number, 4);
      assert.equal(editado.label, 'Servicio');
      assert.equal(editado.element_type, 'BATHROOM', 'lo que no se envía no cambia');

      await layouts.deleteElement(creado.id);
      assert.equal((await layouts.listElements(piso.id)).length, 0);
    });

    it('14 · un tipo no admitido se rechaza', async () => {
      await assert.rejects(
        () => layouts.createElement(piso.id, { element_type: 'COCINA', row_number: 1, column_number: 1 }),
        (error: unknown) => {
          assert.match(String((error as { message?: string }).message), /no admitido/i);
          return true;
        },
      );
    });

    it('15 · un elemento fuera de la rejilla se rechaza', async () => {
      await assert.rejects(() => layouts.createElement(piso.id, { element_type: 'DOOR', row_number: 99, column_number: 1 }), (error: unknown) => {
        assert.match(String((error as { message?: string }).message), /se sale del piso/i);
        return true;
      });
      await assert.rejects(() => layouts.createElement(piso.id, { element_type: 'DOOR', row_number: 1, column_number: 9 }));
      await assert.rejects(() => layouts.createElement(piso.id, { element_type: 'DOOR', row_number: 0, column_number: 1 }));
    });

    it('16 · un elemento no puede caer sobre un asiento', async () => {
      await nuevoAsiento('05', 5, 2);

      await assert.rejects(
        () => layouts.createElement(piso.id, { element_type: 'BATHROOM', row_number: 5, column_number: 2 }),
        (error: unknown) => {
          assert.match(String((error as { message?: string }).message), /ya la ocupa un asiento/i);
          return true;
        },
      );
    });

    it('17 · dos elementos no pueden solaparse, ni siquiera por su extensión', async () => {
      // Ocupa (2,2) y (3,2).
      await layouts.createElement(piso.id, { element_type: 'STAIRS', row_number: 2, column_number: 2, row_span: 2 });

      await assert.rejects(
        () => layouts.createElement(piso.id, { element_type: 'DOOR', row_number: 3, column_number: 2 }),
        (error: unknown) => {
          assert.match(String((error as { message?: string }).message), /ya la ocupa un elemento/i);
          return true;
        },
      );
      // Justo debajo del tramo ocupado sí cabe.
      const abajo = await layouts.createElement(piso.id, { element_type: 'DOOR', row_number: 4, column_number: 2 });
      assert.equal(abajo.row_number, 4);
    });

    it('18 · un asiento tampoco puede caer sobre las celdas que ocupa un elemento', async () => {
      await layouts.createElement(piso.id, { element_type: 'STAIRS', row_number: 6, column_number: 1, row_span: 2, col_span: 2 });

      await assert.rejects(() => nuevoAsiento('99', 7, 2), (error: unknown) => {
        assert.match(String((error as { message?: string }).message), /ya la ocupa un elemento/i);
        return true;
      });
    });

    it('19 · no se crean ni editan elementos en una versión PUBLICADA', async () => {
      const pisoPublicado = at(await layouts.listDecks(ctx.fixtures.layoutA), 0);

      await assert.rejects(() => layouts.createElement(pisoPublicado.id, { element_type: 'DOOR', row_number: 1, column_number: 1 }), (error: unknown) => {
        assert.match(String((error as { message?: string }).message), /cl[óo]nala/i);
        return true;
      });
    });

    it('20 · ni en una ARCHIVADA', async () => {
      const creado = await layouts.createElement(piso.id, { element_type: 'DOOR', row_number: 1, column_number: 1 });
      await execute("UPDATE bus_layouts SET status = 'ARCHIVED' WHERE id = ?", [borrador.id]);

      await assert.rejects(() => layouts.updateElement(creado.id, { label: 'X' }));
      await assert.rejects(() => layouts.deleteElement(creado.id));
    });
  });

  // =========================================================================
  describe('Asientos', () => {
    it('21 · se crea un asiento y el servidor le pone versión, piso y bus', async () => {
      const asiento = await nuevoAsiento('01', 1, 1);

      const fila = await queryOne<{ layout_id: number; deck_id: number; bus_id: number }>(
        'SELECT layout_id, deck_id, bus_id FROM seats WHERE id = ?',
        [asiento.id],
      );
      assert.equal(Number(fila?.layout_id), borrador.id);
      assert.equal(Number(fila?.deck_id), piso.id);
      assert.equal(Number(fila?.bus_id), ctx.fixtures.busA, 'el bus sale de la versión, no del cliente');
    });

    it('22 · se edita un asiento', async () => {
      const asiento = await nuevoAsiento('01', 1, 1);
      const tipoMujer = await queryOne<{ id: number }>("SELECT id FROM seat_types WHERE name = 'Mujer' LIMIT 1");

      const editado = await layouts.updateSeat(asiento.id, {
        seat_number: '01A',
        seat_type_id: tipoMujer!.id,
        is_window: true,
        status: 'INACTIVE',
      });

      assert.equal(editado.seat_number, '01A');
      assert.equal(Number(editado.seat_type_id), tipoMujer!.id);
      assert.equal(editado.is_window, 1);
      assert.equal(editado.status, 'INACTIVE');
      assert.equal(editado.row_number, 1, 'lo que no se envía no cambia');
    });

    it('23 · se mueve un asiento a otro piso de la misma versión', async () => {
      const asiento = await nuevoAsiento('01', 1, 1);
      const segundo = await layouts.createDeck(borrador.id, { deck_number: 2, row_count: 6, column_count: 4 });

      const movido = await layouts.updateSeat(asiento.id, { deck_id: segundo.id, row_number: 2, column_number: 2 });

      assert.equal(movido.deck_id, segundo.id);
      assert.equal(movido.row_number, 2);
    });

    it('24 · se elimina un asiento sin histórico', async () => {
      const asiento = await nuevoAsiento('01', 1, 1);

      await layouts.deleteSeat(asiento.id);

      assert.equal((await layouts.listSeats(piso.id)).length, 0);
    });

    it('25 · repetir el número dentro de la versión falla', async () => {
      await nuevoAsiento('07', 1, 1);

      await assert.rejects(() => nuevoAsiento('07', 2, 2), (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 400);
        assert.match(String((error as { message?: string }).message), /ya tiene un asiento/i);
        return true;
      });
    });

    it('26 · dos asientos no pueden compartir casilla', async () => {
      await nuevoAsiento('01', 3, 3);

      await assert.rejects(() => nuevoAsiento('02', 3, 3), (error: unknown) => {
        assert.match(String((error as { message?: string }).message), /ya la ocupa un asiento/i);
        return true;
      });
    });

    it('27 · un asiento fuera de la rejilla se rechaza', async () => {
      await assert.rejects(() => nuevoAsiento('01', 11, 1));
      await assert.rejects(() => nuevoAsiento('02', 1, 5));
    });

    it('28 · un tipo de asiento inexistente se rechaza', async () => {
      await assert.rejects(
        () => layouts.createSeat(piso.id, { seat_number: '01', row_number: 1, column_number: 1, seat_type_id: 999999 }),
        (error: unknown) => {
          assert.match(String((error as { message?: string }).message), /tipo de asiento no existe/i);
          return true;
        },
      );
    });

    it('29 · un estado inválido se rechaza', async () => {
      await assert.rejects(
        () => layouts.createSeat(piso.id, { seat_number: '01', row_number: 1, column_number: 1, status: 'VENDIDO' }),
        (error: unknown) => {
          assert.match(String((error as { message?: string }).message), /estado de asiento no admitido/i);
          return true;
        },
      );
    });

    it('30 · no se crean asientos en una versión PUBLICADA ni ARCHIVADA', async () => {
      const pisoPublicado = at(await layouts.listDecks(ctx.fixtures.layoutA), 0);
      await assert.rejects(() => layouts.createSeat(pisoPublicado.id, { seat_number: 'ZZ', row_number: 1, column_number: 1 }));

      const asiento = await nuevoAsiento('01', 1, 1);
      await execute("UPDATE bus_layouts SET status = 'ARCHIVED' WHERE id = ?", [borrador.id]);
      await assert.rejects(() => layouts.updateSeat(asiento.id, { seat_number: 'X' }));
      await assert.rejects(() => layouts.deleteSeat(asiento.id));
    });

    it('31 · un asiento no puede saltar a un piso de otra versión', async () => {
      const asiento = await nuevoAsiento('01', 1, 1);
      const pisoAjeno = at(await layouts.listDecks(ctx.fixtures.layoutA), 0);

      await assert.rejects(() => layouts.updateSeat(asiento.id, { deck_id: pisoAjeno.id }), (error: unknown) => {
        assert.match(String((error as { message?: string }).message), /otra versión/i);
        return true;
      });
    });

    it('32 · un asiento no puede cambiar de bus ni de versión aunque se envíen', async () => {
      const asiento = await nuevoAsiento('01', 1, 1);

      await layouts.updateSeat(asiento.id, {
        seat_number: '02',
        // Campos que el servicio no lee: no forman parte de `SeatInput`.
        ...({ bus_id: ctx.fixtures.busB, layout_id: ctx.fixtures.layoutB } as Record<string, unknown>),
      });

      const fila = await queryOne<{ bus_id: number; layout_id: number }>('SELECT bus_id, layout_id FROM seats WHERE id = ?', [asiento.id]);
      assert.equal(Number(fila?.bus_id), ctx.fixtures.busA);
      assert.equal(Number(fila?.layout_id), borrador.id);
    });

    it('33 · un asiento con reservas no se elimina', async () => {
      // Se reserva sobre la versión publicada y se intenta borrar ese asiento poniendo su
      // versión en borrador: aunque el estado lo permita, el histórico manda.
      const libres = await freeSeats(ctx.fixtures.tripA);
      const vendido = at(libres, 0).id;
      const reserva = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [vendido], passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token,
      );
      assert.equal(reserva.status, 201);

      await execute('UPDATE trips SET bus_layout_id = NULL WHERE bus_id = ?', [ctx.fixtures.busA]);
      await execute("UPDATE bus_layouts SET status = 'DRAFT' WHERE id = ?", [ctx.fixtures.layoutA]);
      try {
        await assert.rejects(() => layouts.deleteSeat(vendido), (error: unknown) => {
          assert.match(String((error as { message?: string }).message), /reservas asociadas/i);
          return true;
        });
        assert.ok(await queryOne('SELECT id FROM seats WHERE id = ?', [vendido]), 'el asiento sigue existiendo');
      } finally {
        await execute("UPDATE bus_layouts SET status = 'PUBLISHED' WHERE id = ?", [ctx.fixtures.layoutA]);
        await execute('UPDATE trips SET bus_layout_id = ? WHERE bus_id = ?', [ctx.fixtures.layoutA, ctx.fixtures.busA]);
      }
    });
  });

  // =========================================================================
  describe('Recuento de asientos de la versión', () => {
    it('34 · crear un asiento sube `seat_count`', async () => {
      assert.equal((await layouts.getLayout(borrador.id))?.seat_count, 0);

      await nuevoAsiento('01', 1, 1);
      assert.equal((await layouts.getLayout(borrador.id))?.seat_count, 1);

      await nuevoAsiento('02', 1, 2);
      assert.equal((await layouts.getLayout(borrador.id))?.seat_count, 2);
    });

    it('35 · eliminar un asiento lo baja', async () => {
      const uno = await nuevoAsiento('01', 1, 1);
      await nuevoAsiento('02', 1, 2);

      await layouts.deleteSeat(uno.id);

      assert.equal((await layouts.getLayout(borrador.id))?.seat_count, 1);
    });

    it('36 · un alta fallida deja el recuento como estaba', async () => {
      await nuevoAsiento('01', 1, 1);
      const antes = (await layouts.getLayout(borrador.id))?.seat_count;

      await assert.rejects(() => nuevoAsiento('01', 2, 2), 'el número repetido debe fallar');

      assert.equal((await layouts.getLayout(borrador.id))?.seat_count, antes);
      const reales = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM seats WHERE layout_id = ?', [borrador.id]);
      assert.equal(Number(reales?.total), antes, 'el recuento y la realidad siguen coincidiendo');
    });

    it('37 · el recuento coincide con la realidad tras una tanda de cambios', async () => {
      const creados = [];
      for (let numero = 1; numero <= 4; numero += 1) {
        creados.push(await nuevoAsiento(String(numero).padStart(2, '0'), 1, numero));
      }
      await layouts.deleteSeat(at(creados, 0).id);
      await layouts.deleteSeat(at(creados, 1).id);

      const layout = await layouts.getLayout(borrador.id);
      const reales = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM seats WHERE layout_id = ?', [borrador.id]);
      assert.equal(layout?.seat_count, 2);
      assert.equal(Number(reales?.total), 2);
    });
  });

  // =========================================================================
  /**
   * H-16 (auditoría FASE 7). El CRUD genérico `/seats` se retiró entero: ninguna pantalla lo
   * usaba, sus escrituras ya estaban cerradas y su lectura no sabía de versiones ni de pisos.
   * Ahora la ruta no existe (404), y los asientos solo se leen y administran por los
   * endpoints de la versión: `/decks/:id/seats` y `/layout-seats/:id`.
   */
  describe('El recurso genérico `/seats` ya no existe', () => {
    it('38 · POST /seats responde 404 y no crea nada', async () => {
      const antes = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM seats');

      const res = await post(
        '/seats',
        { bus_id: ctx.fixtures.busA, seat_number: 'X1', row_number: 1, column_number: 1 },
        ctx.sessions.companyAdmin.token,
      );

      assert.equal(res.status, 404);
      const despues = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM seats');
      assert.equal(Number(despues?.total), Number(antes?.total), 'no puede haberse creado ningún asiento');
    });

    it('39 · PUT /seats/:id responde 404 y no modifica', async () => {
      const asiento = at(ctx.fixtures.seatsA, 0);
      const antes = await queryOne('SELECT * FROM seats WHERE id = ?', [asiento]);

      const res = await put(`/seats/${asiento}`, { seat_number: 'MOD' }, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 404);
      assert.deepEqual(await queryOne('SELECT * FROM seats WHERE id = ?', [asiento]), antes, 'el asiento queda idéntico');
    });

    it('40 · DELETE /seats/:id responde 404 y no elimina', async () => {
      const asiento = at(ctx.fixtures.seatsA, 0);
      const res = await del(`/seats/${asiento}`, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 404);
      assert.ok(await queryOne('SELECT id FROM seats WHERE id = ?', [asiento]), 'el asiento sigue existiendo');
    });

    it('41 · GET /seats responde 404', async () => {
      const res = await get(`/seats?bus_id=${ctx.fixtures.busA}`, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 404);
      assert.equal(res.body.data, undefined, 'no devuelve ningún asiento');
    });

    it('41b · GET /seats/:id responde 404', async () => {
      const res = await get(`/seats/${at(ctx.fixtures.seatsA, 0)}`, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 404);
      assert.equal(res.body.data, undefined, 'no devuelve el asiento');
    });

    it('41c · un CUSTOMER ya no puede listar asientos de ninguna empresa', async () => {
      // Antes de H-16 esta lectura respondía 200 al cliente con los asientos de TODAS las
      // empresas y de todas las versiones —borradores incluidos—, porque el alcance genérico
      // no se aplica a un CUSTOMER. Retirar la ruta cierra esa exposición entre empresas.
      const { customer } = ctx.sessions;
      assert.ok(customer.user.permissions.includes('buses.view'), 'el cliente conserva buses.view: el cierre no depende del permiso');

      for (const ruta of ['/seats', `/seats?bus_id=${ctx.fixtures.busA}`, `/seats?bus_id=${ctx.fixtures.busB}`, `/seats/${at(ctx.fixtures.seatsB, 0)}`]) {
        const res = await get(ruta, customer.token);
        assert.equal(res.status, 404, `${ruta} no debe existir`);
        assert.equal(res.body.data, undefined, `${ruta} no expone asientos`);
      }

      // Y por las rutas de la versión tampoco: el cliente no pertenece a ninguna empresa.
      const porElEditor = await get(`/decks/${ctx.fixtures.deckB}/seats`, customer.token);
      assert.equal(porElEditor.status, 403);
    });

    it('42 · ningún asiento quedó sin versión ni sin piso', async () => {
      const huerfanos = await queryOne<{ total: number }>(
        'SELECT COUNT(*) AS total FROM seats WHERE layout_id IS NULL OR deck_id IS NULL',
      );
      assert.equal(Number(huerfanos?.total), 0, 'era justo lo que el cierre del CRUD genérico venía a impedir');
    });
  });

  // =========================================================================
  describe('Permisos y aislamiento entre empresas', () => {
    it('43 · OPERATOR lee pero no escribe nada del editor', async () => {
      const lectura = await get(`/layouts/${borrador.id}/decks`, ctx.sessions.operator.token);
      assert.equal(lectura.status, 200);

      const crearPiso = await post(`/layouts/${borrador.id}/decks`, { deck_number: 3 }, ctx.sessions.operator.token);
      assert.equal(crearPiso.status, 403);

      const crearElemento = await post(`/decks/${piso.id}/elements`, { element_type: 'DOOR', row_number: 1, column_number: 1 }, ctx.sessions.operator.token);
      assert.equal(crearElemento.status, 403);

      const crearAsiento = await post(`/decks/${piso.id}/seats`, { seat_number: 'OP', row_number: 1, column_number: 1 }, ctx.sessions.operator.token);
      assert.equal(crearAsiento.status, 403);

      const asiento = await nuevoAsiento('01', 2, 2);
      const editar = await post(`/layout-seats/${asiento.id}`, {}, ctx.sessions.operator.token);
      assert.ok([403, 404].includes(editar.status), 'ni por POST ni por ninguna vía de escritura');
      const borrar = await del(`/layout-seats/${asiento.id}`, ctx.sessions.operator.token);
      assert.equal(borrar.status, 403);
      const borrarPiso = await del(`/decks/${piso.id}`, ctx.sessions.operator.token);
      assert.equal(borrarPiso.status, 403);
    });

    it('44 · COMPANY_ADMIN sí puede editar el borrador de su bus', async () => {
      const creado = await post(
        `/decks/${piso.id}/seats`,
        { seat_number: 'CA', row_number: 4, column_number: 4 },
        ctx.sessions.companyAdmin.token,
      );

      assert.equal(creado.status, 201, JSON.stringify(creado.body));
      assert.equal(creado.body.data.seat_number, 'CA');
    });

    it('45 · la empresa A no toca nada de la empresa B', async () => {
      const ajeno = await layouts.createDraft(ctx.fixtures.busB, { decks: [{ deck_number: 1, row_count: 5, column_count: 4 }] });
      const pisoAjeno = at(await layouts.listDecks(ajeno.id), 0);

      const ver = await get(`/layouts/${ajeno.id}/decks`, ctx.sessions.companyAdmin.token);
      assert.equal(ver.status, 403);

      const crearPiso = await post(`/layouts/${ajeno.id}/decks`, { deck_number: 2 }, ctx.sessions.companyAdmin.token);
      assert.equal(crearPiso.status, 403);

      const crearAsiento = await post(`/decks/${pisoAjeno.id}/seats`, { seat_number: 'X', row_number: 1, column_number: 1 }, ctx.sessions.companyAdmin.token);
      assert.equal(crearAsiento.status, 403);

      const borrarPiso = await del(`/decks/${pisoAjeno.id}`, ctx.sessions.companyAdmin.token);
      assert.equal(borrarPiso.status, 403);

      assert.equal((await layouts.listDecks(ajeno.id)).length, 1, 'la versión ajena quedó intacta');
    });

    it('46 · el `company_id` del cuerpo se ignora por completo', async () => {
      const res = await post(
        `/decks/${piso.id}/seats`,
        { seat_number: 'CI', row_number: 5, column_number: 4, company_id: ctx.fixtures.companyB, bus_id: ctx.fixtures.busB },
        ctx.sessions.companyAdmin.token,
      );

      assert.equal(res.status, 201);
      const fila = await queryOne<{ bus_id: number }>('SELECT bus_id FROM seats WHERE id = ?', [res.body.data.id]);
      assert.equal(Number(fila?.bus_id), ctx.fixtures.busA, 'el bus sale de la versión');
    });
  });

  // =========================================================================
  describe('Editar el borrador no toca el histórico', () => {
    it('47 · editar un borrador no altera la versión publicada', async () => {
      const antes = await layouts.getLayoutTree(ctx.fixtures.layoutA);

      await nuevoAsiento('01', 1, 1);
      await layouts.createElement(piso.id, { element_type: 'BATHROOM', row_number: 8, column_number: 4 });
      await layouts.createDeck(borrador.id, { deck_number: 2 });

      const despues = await layouts.getLayoutTree(ctx.fixtures.layoutA);
      assert.deepEqual(despues, antes, 'la versión publicada no puede haberse movido');
    });

    it('48 · editar un clon no toca las ventas del original', async () => {
      const libres = await freeSeats(ctx.fixtures.tripA);
      const reserva = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [at(libres, 0).id], passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token,
      );
      assert.equal(reserva.status, 201);
      const ventasAntes = await query('SELECT id, booking_id, trip_id, seat_id, price FROM booking_seats ORDER BY id');

      const clon = await layouts.cloneForEdit(ctx.fixtures.layoutA);
      const pisoClon = at(await layouts.listDecks(clon.id), 0);
      const asientos = await layouts.listSeats(pisoClon.id);
      await layouts.deleteSeat(at(asientos, 0).id);
      await layouts.updateSeat(at(asientos, 1).id, { seat_number: 'REORDENADO' });

      const ventasDespues = await query('SELECT id, booking_id, trip_id, seat_id, price FROM booking_seats ORDER BY id');
      assert.deepEqual(ventasDespues, ventasAntes);
    });

    it('49 · publicar después de editar conserva el mapa del viaje anterior', async () => {
      const mapaAntes = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);
      assert.equal(mapaAntes.status, 200);

      const clon = await layouts.cloneForEdit(ctx.fixtures.layoutA);
      const pisoClon = at(await layouts.listDecks(clon.id), 0);
      const asientos = await layouts.listSeats(pisoClon.id);
      await layouts.deleteSeat(at(asientos, 0).id);
      await layouts.publishLayout(clon.id);

      const mapaDespues = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);
      assert.equal(mapaDespues.body.data.length, mapaAntes.body.data.length, 'el viaje sigue con su versión');
    });
  });
});
