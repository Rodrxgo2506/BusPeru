import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { del, get, post } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, createLayoutElement, freeSeats } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';
import * as layouts from '../services/bus-layout.service';
import { seatMap } from '../services/trip.service';

/**
 * Migración 010 · versionado, copy-on-write y publicación.
 *
 * LA REGLA QUE SE PRUEBA. Una versión publicada es inmutable. Cambiar la distribución de un
 * bus significa clonar la vigente a un borrador, editar el borrador y publicarlo; al
 * publicarlo, la anterior queda archivada y sigue viva para siempre, porque los viajes que
 * la usan la necesitan tal cual estaba el día que se vendieron.
 *
 * LO QUE MÁS IMPORTA AQUÍ. Que clonar no toque ni una fila del original —ni un identificador
 * de asiento, que es a lo que apunta `booking_seats`— y que dos publicaciones simultáneas del
 * mismo bus no puedan dejar dos versiones vigentes ni al bus sin ninguna.
 */
describe('Versionado de la distribución del bus (migración 010)', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  /** Borra las versiones que una prueba haya creado, dejando la v1 de los fixtures. */
  beforeEach(async () => {
    await execute('DELETE FROM financial_transactions');
    await execute('DELETE FROM payments');
    await execute('DELETE FROM booking_seats');
    await execute('DELETE FROM bookings');

    // ORDEN IMPORTANTE. Los viajes se devuelven a la version de los fixtures ANTES de borrar
    // las versiones que las pruebas hayan creado: `fk_trips_bus_layout` es RESTRICT, asi que
    // borrar una version a la que un viaje todavia apunta falla —y esa es exactamente la
    // proteccion del historico que esta fase implementa—.
    await execute('UPDATE trips SET bus_layout_id = ? WHERE bus_id = ?', [ctx.fixtures.layoutA, ctx.fixtures.busA]);
    await execute('UPDATE trips SET bus_layout_id = ? WHERE bus_id = ?', [ctx.fixtures.layoutB, ctx.fixtures.busB]);

    await execute('DELETE FROM bus_layout_elements');
    await execute('DELETE FROM seats WHERE layout_id NOT IN (?, ?)', [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
    // Se borran las versiones sobrantes antes de reactivar las de los fixtures: si una prueba
    // publico un clon, poner la v1 como PUBLISHED con el clon todavia vigente chocaria contra
    // `uq_layout_published_bus`.
    await execute('DELETE FROM bus_layouts WHERE id NOT IN (?, ?)', [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
    await execute("UPDATE bus_layouts SET status = 'PUBLISHED' WHERE id IN (?, ?)", [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
    await execute('UPDATE trips SET available_seats = 12 WHERE bus_id = ?', [ctx.fixtures.busA]);
    await execute('UPDATE buses SET capacity = 12 WHERE id = ?', [ctx.fixtures.busA]);
  });

  describe('Creación de borradores', () => {
    it('1 · un borrador nace en DRAFT, sin fecha de publicación y sin asientos', async () => {
      const borrador = await layouts.createDraft(ctx.fixtures.busA, { name: 'Prueba' });

      assert.equal(borrador.status, 'DRAFT');
      assert.equal(borrador.published_at, null);
      assert.equal(borrador.seat_count, 0);
      assert.equal(borrador.bus_id, ctx.fixtures.busA);
    });

    it('2 · crear un borrador no altera la versión publicada', async () => {
      await layouts.createDraft(ctx.fixtures.busA);

      const publicada = await layouts.getPublishedLayout(ctx.fixtures.busA);
      assert.equal(publicada?.id, ctx.fixtures.layoutA, 'la vigente sigue siendo la misma');
    });

    it('3 · la versión se numera sola y de forma creciente', async () => {
      const primero = await layouts.createDraft(ctx.fixtures.busA);
      const segundo = await layouts.createDraft(ctx.fixtures.busA);

      assert.equal(primero.version, 2, 'los fixtures dejan la v1 publicada');
      assert.equal(segundo.version, 3);
    });

    it('4 · el borrador trae su piso inicial', async () => {
      const borrador = await layouts.createDraft(ctx.fixtures.busA, {
        decks: [{ deck_number: 1, name: 'Bajo' }, { deck_number: 2, name: 'Alto' }],
      });

      const arbol = await layouts.getLayoutTree(borrador.id);
      assert.equal(arbol?.decks.length, 2);
      assert.deepEqual(arbol?.decks.map((piso) => piso.name), ['Bajo', 'Alto']);
    });
  });

  describe('Copy-on-write: clonar sin tocar el original', () => {
    it('5 · el clon es una versión nueva en borrador', async () => {
      const clon = await layouts.cloneForEdit(ctx.fixtures.layoutA);

      assert.notEqual(clon.id, ctx.fixtures.layoutA);
      assert.equal(clon.status, 'DRAFT');
      assert.equal(clon.published_at, null);
      assert.equal(clon.bus_id, ctx.fixtures.busA);
      assert.equal(clon.version, 2);
    });

    it('6 · copia pisos, elementos y asientos con identificadores nuevos', async () => {
      await createLayoutElement(ctx.fixtures.deckA, 'BATHROOM', 9, 4, 'Baño');
      await createLayoutElement(ctx.fixtures.deckA, 'STAIRS', 9, 1, 'Escalera');

      const original = await layouts.getLayoutTree(ctx.fixtures.layoutA);
      const clon = await layouts.cloneForEdit(ctx.fixtures.layoutA);
      const copia = await layouts.getLayoutTree(clon.id);

      assert.ok(original && copia);
      assert.equal(copia.decks.length, original.decks.length);
      assert.equal(copia.elements.length, original.elements.length);
      assert.equal(copia.seats.length, original.seats.length);

      // Ni un solo identificador compartido, en ninguna de las tres tablas.
      const idsOriginales = new Set(original.seats.map((asiento) => asiento.id));
      assert.ok(copia.seats.every((asiento) => !idsOriginales.has(asiento.id)), 'los asientos deben ser filas nuevas');
      const pisosOriginales = new Set(original.decks.map((piso) => piso.id));
      assert.ok(copia.decks.every((piso) => !pisosOriginales.has(piso.id)));
      const elementosOriginales = new Set(original.elements.map((elemento) => elemento.id));
      assert.ok(copia.elements.every((elemento) => !elementosOriginales.has(elemento.id)));
    });

    it('7 · el clon conserva número, tipo, fila, columna y estado de cada asiento', async () => {
      const original = await layouts.getLayoutTree(ctx.fixtures.layoutA);
      const clon = await layouts.cloneForEdit(ctx.fixtures.layoutA);
      const copia = await layouts.getLayoutTree(clon.id);

      const retrato = (arbol: layouts.LayoutTree) =>
        arbol.seats
          .map((asiento) => [asiento.seat_number, asiento.seat_type_id, asiento.row_number, asiento.column_number, asiento.is_window, asiento.is_aisle, asiento.status].join('|'))
          .sort();

      assert.deepEqual(retrato(copia!), retrato(original!));
    });

    it('8 · cada asiento del clon cuelga de un piso DEL CLON, no del original', async () => {
      const clon = await layouts.cloneForEdit(ctx.fixtures.layoutA);
      const copia = await layouts.getLayoutTree(clon.id);

      const pisosDelClon = new Set(copia!.decks.map((piso) => piso.id));
      assert.ok(copia!.seats.every((asiento) => asiento.deck_id !== null && pisosDelClon.has(asiento.deck_id)));

      const desviados = await queryOne<{ total: number }>(
        `SELECT COUNT(*) AS total FROM seats s
         JOIN bus_layout_decks d ON d.id = s.deck_id
         WHERE s.layout_id = ? AND d.layout_id <> s.layout_id`,
        [clon.id],
      );
      assert.equal(Number(desviados?.total), 0);
    });

    it('9 · `seat_count` del clon coincide con sus asientos reales', async () => {
      const clon = await layouts.cloneForEdit(ctx.fixtures.layoutA);
      const reales = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM seats WHERE layout_id = ?', [clon.id]);

      assert.equal(clon.seat_count, Number(reales?.total));
      assert.equal(clon.seat_count, ctx.fixtures.seatsA.length);
    });

    it('10 · clonar una versión con ventas no toca ni una fila del histórico', async () => {
      const libres = await freeSeats(ctx.fixtures.tripA);
      const reserva = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [at(libres, 0).id], passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token,
      );
      assert.equal(reserva.status, 201);

      const antes = await query('SELECT id, booking_id, trip_id, seat_id, price FROM booking_seats ORDER BY id');
      const asientosAntes = await query('SELECT id, seat_number, `row_number`, column_number, deck_id FROM seats WHERE layout_id = ? ORDER BY id', [ctx.fixtures.layoutA]);

      await layouts.cloneForEdit(ctx.fixtures.layoutA);

      const despues = await query('SELECT id, booking_id, trip_id, seat_id, price FROM booking_seats ORDER BY id');
      const asientosDespues = await query('SELECT id, seat_number, `row_number`, column_number, deck_id FROM seats WHERE layout_id = ? ORDER BY id', [ctx.fixtures.layoutA]);

      assert.deepEqual(despues, antes, 'las ventas no pueden moverse');
      assert.deepEqual(asientosDespues, asientosAntes, 'los asientos del original no pueden moverse');
    });

    it('11 · clonar una versión inexistente responde 404', async () => {
      await assert.rejects(() => layouts.cloneForEdit(999999), (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 404);
        return true;
      });
    });
  });

  describe('Publicación', () => {
    /** Clona la v1 y devuelve el borrador listo para publicar. */
    async function borradorListo() {
      return layouts.cloneForEdit(ctx.fixtures.layoutA);
    }

    it('12 · publicar un borrador lo deja vigente y archiva la anterior', async () => {
      const borrador = await borradorListo();

      const publicado = await layouts.publishLayout(borrador.id);

      assert.equal(publicado.status, 'PUBLISHED');
      assert.ok(publicado.published_at, 'debe quedar fechada');
      const anterior = await layouts.getLayout(ctx.fixtures.layoutA);
      assert.equal(anterior?.status, 'ARCHIVED');
    });

    it('13 · nunca quedan dos versiones vigentes del mismo bus', async () => {
      const borrador = await borradorListo();
      await layouts.publishLayout(borrador.id);

      const vigentes = await query<{ id: number }>(
        "SELECT id FROM bus_layouts WHERE bus_id = ? AND status = 'PUBLISHED'",
        [ctx.fixtures.busA],
      );
      assert.equal(vigentes.length, 1);
      assert.equal(vigentes[0]!.id, borrador.id);
    });

    it('14 · una versión ya publicada no se puede volver a publicar', async () => {
      await assert.rejects(() => layouts.publishLayout(ctx.fixtures.layoutA), (error: unknown) => {
        const fallo = error as { statusCode?: number; message?: string };
        assert.equal(fallo.statusCode, 400);
        assert.match(String(fallo.message), /borrador/i);
        return true;
      });
    });

    it('15 · un borrador sin asientos no se publica', async () => {
      const vacio = await layouts.createDraft(ctx.fixtures.busA);

      await assert.rejects(() => layouts.publishLayout(vacio.id), (error: unknown) => {
        assert.match(String((error as { message?: string }).message), /asiento/i);
        return true;
      });
      assert.equal((await layouts.getLayout(vacio.id))?.status, 'DRAFT', 'debe seguir siendo borrador');
    });

    it('16 · un borrador sin pisos no se publica', async () => {
      const borrador = await layouts.createDraft(ctx.fixtures.busA, { decks: [] });

      await assert.rejects(() => layouts.publishLayout(borrador.id), (error: unknown) => {
        assert.match(String((error as { message?: string }).message), /piso/i);
        return true;
      });
    });

    it('17 · un asiento y un elemento en la misma casilla impiden publicar', async () => {
      const borrador = await borradorListo();
      const arbol = await layouts.getLayoutTree(borrador.id);
      const asiento = at(arbol!.seats, 0);
      await createLayoutElement(asiento.deck_id!, 'BATHROOM', asiento.row_number!, asiento.column_number!, 'Choque');

      await assert.rejects(() => layouts.publishLayout(borrador.id), (error: unknown) => {
        assert.match(String((error as { message?: string }).message), /misma posición/i);
        return true;
      });
      assert.equal((await layouts.getLayout(borrador.id))?.status, 'DRAFT');
    });

    it('18 · publicar sincroniza `buses.capacity` con la versión vigente', async () => {
      const borrador = await borradorListo();
      // Se le quita un asiento al borrador: la nueva capacidad debe ser una menos.
      const arbol = await layouts.getLayoutTree(borrador.id);
      await execute('DELETE FROM seats WHERE id = ?', [at(arbol!.seats, 0).id]);

      const publicado = await layouts.publishLayout(borrador.id);

      const bus = await queryOne<{ capacity: number }>('SELECT capacity FROM buses WHERE id = ?', [ctx.fixtures.busA]);
      assert.equal(publicado.seat_count, ctx.fixtures.seatsA.length - 1);
      assert.equal(Number(bus?.capacity), publicado.seat_count);
    });
  });

  describe('El histórico no se mueve al publicar', () => {
    it('19 · un viaje anterior sigue resolviendo su versión, no la nueva', async () => {
      const antes = await seatMap(ctx.fixtures.tripA);
      const borrador = await layouts.cloneForEdit(ctx.fixtures.layoutA);
      await execute('DELETE FROM seats WHERE id = ?', [at((await layouts.getLayoutTree(borrador.id))!.seats, 0).id]);
      await layouts.publishLayout(borrador.id);

      const viaje = await queryOne<{ bus_layout_id: number }>('SELECT bus_layout_id FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
      assert.equal(Number(viaje?.bus_layout_id), ctx.fixtures.layoutA, 'el viaje no puede saltar de versión solo');

      const despues = await seatMap(ctx.fixtures.tripA);
      assert.equal(despues.length, antes.length, 'su mapa tampoco puede encoger');
    });

    it('20 · un viaje nuevo sí nace con la versión recién publicada', async () => {
      const borrador = await layouts.cloneForEdit(ctx.fixtures.layoutA);
      const publicado = await layouts.publishLayout(borrador.id);

      const res = await post(
        '/trips',
        {
          route_id: ctx.fixtures.routeA,
          bus_id: ctx.fixtures.busA,
          departure_datetime: '2027-06-10 08:00:00',
          base_price: 55,
        },
        ctx.sessions.companyAdmin.token,
      );

      assert.equal(res.status, 201, JSON.stringify(res.body));
      const creado = await queryOne<{ bus_layout_id: number }>('SELECT bus_layout_id FROM trips WHERE id = ?', [res.body.data.id]);
      assert.equal(Number(creado?.bus_layout_id), publicado.id);
    });

    it('21 · las ventas anteriores siguen apuntando a los asientos de su versión', async () => {
      const libres = await freeSeats(ctx.fixtures.tripA);
      const reserva = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [at(libres, 0).id], passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token,
      );
      assert.equal(reserva.status, 201);

      const borrador = await layouts.cloneForEdit(ctx.fixtures.layoutA);
      await layouts.publishLayout(borrador.id);

      const vendido = await queryOne<{ layout_id: number }>(
        'SELECT s.layout_id FROM booking_seats bs JOIN seats s ON s.id = bs.seat_id WHERE bs.booking_id = ? LIMIT 1',
        [reserva.body.data.id],
      );
      assert.equal(Number(vendido?.layout_id), ctx.fixtures.layoutA);
    });
  });

  describe('Publicaciones simultáneas', () => {
    it('22 · dos borradores publicados a la vez: solo uno queda vigente', async () => {
      const uno = await layouts.cloneForEdit(ctx.fixtures.layoutA);
      const dos = await layouts.cloneForEdit(ctx.fixtures.layoutA);

      const resultados = await Promise.allSettled([layouts.publishLayout(uno.id), layouts.publishLayout(dos.id)]);

      const vigentes = await query<{ id: number }>(
        "SELECT id FROM bus_layouts WHERE bus_id = ? AND status = 'PUBLISHED'",
        [ctx.fixtures.busA],
      );
      assert.equal(vigentes.length, 1, 'jamás pueden quedar dos vigentes');
      assert.ok(vigentes[0], 'ni el bus puede quedarse sin ninguna');

      const cumplidas = resultados.filter((entrada) => entrada.status === 'fulfilled');
      assert.ok(cumplidas.length >= 1, 'al menos una debe haber terminado');
      assert.ok([uno.id, dos.id].includes(Number(vigentes[0].id)), 'la vigente debe ser uno de los dos borradores');
    });

    it('23 · el que pierde falla con un error de negocio, no con un choque de clave', async () => {
      const uno = await layouts.cloneForEdit(ctx.fixtures.layoutA);
      await layouts.publishLayout(uno.id);

      // Publicar ahora el original ya archivado es el mismo caso que pierde la carrera.
      await assert.rejects(() => layouts.publishLayout(ctx.fixtures.layoutA), (error: unknown) => {
        const fallo = error as { statusCode?: number; code?: string; message?: string };
        assert.equal(fallo.statusCode, 400, 'debe ser 400 y no un ER_DUP_ENTRY sin traducir');
        assert.equal(fallo.code, undefined, 'no debe filtrarse el código de MySQL');
        assert.match(String(fallo.message), /borrador/i);
        return true;
      });
    });
  });

  describe('Protección de lo publicado y lo archivado', () => {
    it('24 · una versión publicada no se declara editable', async () => {
      await assert.rejects(() => layouts.assertEditable(ctx.fixtures.layoutA), (error: unknown) => {
        const fallo = error as { statusCode?: number; message?: string };
        assert.equal(fallo.statusCode, 400);
        assert.match(String(fallo.message), /cl[óo]nala/i);
        return true;
      });
    });

    it('25 · una archivada tampoco', async () => {
      const borrador = await layouts.cloneForEdit(ctx.fixtures.layoutA);
      await layouts.publishLayout(borrador.id);

      await assert.rejects(() => layouts.assertEditable(ctx.fixtures.layoutA), (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 400);
        return true;
      });
    });

    it('26 · un borrador sí es editable', async () => {
      const borrador = await layouts.createDraft(ctx.fixtures.busA);
      const comprobado = await layouts.assertEditable(borrador.id);
      assert.equal(comprobado.status, 'DRAFT');
    });

    it('27 · una versión con viajes no se puede eliminar', async () => {
      await assert.rejects(() => layouts.deleteDraft(ctx.fixtures.layoutA), (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 400);
        return true;
      });
      assert.ok(await layouts.getLayout(ctx.fixtures.layoutA), 'debe seguir existiendo');
    });

    it('28 · un borrador sin viajes sí se elimina', async () => {
      const borrador = await layouts.createDraft(ctx.fixtures.busA);

      await layouts.deleteDraft(borrador.id);

      assert.equal(await layouts.getLayout(borrador.id), null);
    });
  });

  describe('Rutas, permisos y aislamiento entre empresas', () => {
    it('29 · COMPANY_ADMIN puede crear, clonar y publicar en su bus', async () => {
      const creado = await post(`/buses/${ctx.fixtures.busA}/layouts`, { name: 'Nueva' }, ctx.sessions.companyAdmin.token);
      assert.equal(creado.status, 201, JSON.stringify(creado.body));
      assert.equal(creado.body.data.status, 'DRAFT');

      const clonado = await post(`/layouts/${ctx.fixtures.layoutA}/clone`, {}, ctx.sessions.companyAdmin.token);
      assert.equal(clonado.status, 201);

      const publicado = await post(`/layouts/${clonado.body.data.id}/publish`, {}, ctx.sessions.companyAdmin.token);
      assert.equal(publicado.status, 200, JSON.stringify(publicado.body));
      assert.equal(publicado.body.data.status, 'PUBLISHED');
    });

    it('30 · OPERATOR puede leer pero no escribir: conserva exactamente sus permisos', async () => {
      const lectura = await get(`/buses/${ctx.fixtures.busA}/layouts`, ctx.sessions.operator.token);
      assert.equal(lectura.status, 200, 'OPERATOR ya tenía `buses.view`');

      const creacion = await post(`/buses/${ctx.fixtures.busA}/layouts`, {}, ctx.sessions.operator.token);
      assert.equal(creacion.status, 403);
      const clonacion = await post(`/layouts/${ctx.fixtures.layoutA}/clone`, {}, ctx.sessions.operator.token);
      assert.equal(clonacion.status, 403);
      const publicacion = await post(`/layouts/${ctx.fixtures.layoutA}/publish`, {}, ctx.sessions.operator.token);
      assert.equal(publicacion.status, 403);
    });

    it('31 · el bus de otra empresa queda fuera de alcance', async () => {
      const lectura = await get(`/buses/${ctx.fixtures.busB}/layouts`, ctx.sessions.companyAdmin.token);
      assert.equal(lectura.status, 403);

      const clonacion = await post(`/layouts/${ctx.fixtures.layoutB}/clone`, {}, ctx.sessions.companyAdmin.token);
      assert.equal(clonacion.status, 403);

      const sigueIgual = await layouts.listLayouts(ctx.fixtures.busB);
      assert.equal(sigueIgual.length, 1, 'no se le pudo crear nada a la otra empresa');
    });

    it('32 · el cliente no puede imponer estado ni versión al crear un borrador', async () => {
      const res = await post(
        `/buses/${ctx.fixtures.busA}/layouts`,
        { status: 'PUBLISHED', version: 99, bus_id: ctx.fixtures.busB, seat_count: 500 },
        ctx.sessions.companyAdmin.token,
      );

      assert.equal(res.status, 201);
      assert.equal(res.body.data.status, 'DRAFT', 'el estado lo fija el servidor');
      assert.equal(res.body.data.version, 2, 'la versión también');
      assert.equal(res.body.data.bus_id, ctx.fixtures.busA, 'y el bus sale de la URL, no del cuerpo');
      assert.equal(res.body.data.seat_count, 0);
    });

    it('33 · borrar un borrador ajeno no es posible', async () => {
      const borrador = await layouts.createDraft(ctx.fixtures.busB);
      const res = await del(`/layouts/${borrador.id}`, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 403);
      assert.ok(await layouts.getLayout(borrador.id), 'debe seguir existiendo');
    });
  });

  describe('Atomicidad', () => {
    it('34 · si la publicación falla, no deja nada a medias', async () => {
      const borrador = await layouts.cloneForEdit(ctx.fixtures.layoutA);
      const arbol = await layouts.getLayoutTree(borrador.id);
      const asiento = at(arbol!.seats, 0);
      await createLayoutElement(asiento.deck_id!, 'DOOR', asiento.row_number!, asiento.column_number!, 'Choque');

      await assert.rejects(() => layouts.publishLayout(borrador.id));

      // Ni la anterior se archivó, ni el borrador cambió, ni la capacidad se movió.
      assert.equal((await layouts.getLayout(ctx.fixtures.layoutA))?.status, 'PUBLISHED');
      assert.equal((await layouts.getLayout(borrador.id))?.status, 'DRAFT');
      const bus = await queryOne<{ capacity: number }>('SELECT capacity FROM buses WHERE id = ?', [ctx.fixtures.busA]);
      assert.equal(Number(bus?.capacity), 12);
    });

    it('35 · si la clonación falla, no deja una versión huérfana', async () => {
      const antes = await layouts.listLayouts(ctx.fixtures.busA);

      // Un bus inexistente hace fallar el bloqueo inicial, antes de escribir nada.
      await assert.rejects(() => layouts.cloneForEdit(999999));

      const despues = await layouts.listLayouts(ctx.fixtures.busA);
      assert.equal(despues.length, antes.length);
      const sueltas = await queryOne<{ total: number }>(
        'SELECT COUNT(*) AS total FROM bus_layouts bl LEFT JOIN buses b ON b.id = bl.bus_id WHERE b.id IS NULL',
      );
      assert.equal(Number(sueltas?.total), 0);
    });
  });
});
