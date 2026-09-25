import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { get } from './helpers/api';
import { execute, queryOne } from '../config/database';
import { at, createBusLayout } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * `seats_count` del listado de buses después del versionado (migración 010).
 *
 * QUÉ SE ROMPIÓ Y POR QUÉ. Antes de la migración un bus tenía un único juego de asientos y
 * contarlos por `s.bus_id` era exacto. Con el versionado cada versión conserva los suyos
 * —`booking_seats` apunta a asientos concretos, así que archivar una versión no puede
 * borrarlos—, de modo que aquella cuenta sumaba el histórico entero: un bus reformado dos
 * veces pasaba de 38 a 120 asientos sin que nadie hubiera tocado un tornillo.
 *
 * LO QUE SE PRUEBA AQUÍ. Que la cifra es la de la versión PUBLICADA y solo esa, que sigue el
 * ciclo de publicar/archivar, que no sale de `buses.capacity` —que es otra cosa: la caché de
 * capacidad— y que un bus anterior a la migración, sin ninguna versión, se sigue viendo como
 * siempre.
 */
describe('seats_count del listado de buses (migración 010)', () => {
  let ctx: SuiteContext;
  let busId: number;
  let busTypeId: number;

  before(async () => {
    ctx = await prepareSuite();
    const tipo = await queryOne<{ id: number }>('SELECT id FROM bus_types LIMIT 1');
    busTypeId = tipo!.id;
  });
  after(teardownSuite);

  /** Un bus propio y vacío por prueba: así ninguna toca los fixtures ni a las demás. */
  beforeEach(async () => {
    await execute('DELETE FROM seats WHERE bus_id NOT IN (?, ?)', [ctx.fixtures.busA, ctx.fixtures.busB]);
    await execute('DELETE FROM bus_layouts WHERE bus_id NOT IN (?, ?)', [ctx.fixtures.busA, ctx.fixtures.busB]);
    await execute('DELETE FROM buses WHERE id NOT IN (?, ?)', [ctx.fixtures.busA, ctx.fixtures.busB]);

    busId = (await execute(
      `INSERT INTO buses (company_id, bus_type_id, code, plate_number, brand, model, year, capacity, amenities, status)
       VALUES (?, ?, 'SC-001', 'SCX-001', 'Marca', 'Modelo', 2024, 50, '[]', 'ACTIVE')`,
      [ctx.fixtures.companyA, busTypeId],
    )).insertId;
  });

  /** Crea `cantidad` asientos colgados de una versión concreta. */
  async function crearAsientos(layoutId: number, deckId: number, cantidad: number, prefijo: string): Promise<void> {
    for (let indice = 1; indice <= cantidad; indice += 1) {
      await execute(
        `INSERT INTO seats (bus_id, layout_id, deck_id, seat_number, \`row_number\`, column_number, is_window, is_aisle, status)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'AVAILABLE')`,
        [busId, layoutId, deckId, `${prefijo}${indice}`, Math.ceil(indice / 4), ((indice - 1) % 4) + 1],
      );
    }
  }

  /** `seats_count` tal como lo devuelve el listado al que mira la pantalla de flota. */
  async function contarEnListado(): Promise<number> {
    const res = await get(`/buses?search=SC-001`, ctx.sessions.admin.token);
    assert.equal(res.status, 200);
    const fila = res.body.data.find((bus: { id: number }) => bus.id === busId);
    assert.ok(fila, 'el bus de la prueba debe aparecer en el listado');
    return Number(fila.seats_count);
  }

  describe('La cifra es la de la versión publicada', () => {
    it('1 · un bus con una sola versión cuenta los asientos de esa versión', async () => {
      const { layoutId, deckIds } = await createBusLayout(busId, { version: 1, status: 'PUBLISHED' });
      await crearAsientos(layoutId, at(deckIds, 0), 7, 'A');

      assert.equal(await contarEnListado(), 7);
    });

    it('2 · con dos versiones solo cuenta la PUBLICADA', async () => {
      const vieja = await createBusLayout(busId, { version: 1, status: 'ARCHIVED' });
      await crearAsientos(vieja.layoutId, at(vieja.deckIds, 0), 40, 'V1-');

      const vigente = await createBusLayout(busId, { version: 2, status: 'PUBLISHED' });
      await crearAsientos(vigente.layoutId, at(vigente.deckIds, 0), 38, 'V2-');

      assert.equal(await contarEnListado(), 38, 'no puede sumar los 40 archivados');
    });

    it('3 · con tres versiones tampoco se acumula el histórico', async () => {
      const v1 = await createBusLayout(busId, { version: 1, status: 'ARCHIVED' });
      await crearAsientos(v1.layoutId, at(v1.deckIds, 0), 42, 'V1-');
      const v2 = await createBusLayout(busId, { version: 2, status: 'ARCHIVED' });
      await crearAsientos(v2.layoutId, at(v2.deckIds, 0), 40, 'V2-');
      const v3 = await createBusLayout(busId, { version: 3, status: 'PUBLISHED' });
      await crearAsientos(v3.layoutId, at(v3.deckIds, 0), 38, 'V3-');

      const total = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM seats WHERE bus_id = ?', [busId]);
      assert.equal(Number(total?.total), 120, 'las tres versiones existen de verdad en la tabla');
      assert.equal(await contarEnListado(), 38, 'pero el listado enseña solo la vigente');
    });

    it('4 · archivar la vigente y publicar otra cambia la cifra', async () => {
      const antigua = await createBusLayout(busId, { version: 1, status: 'PUBLISHED' });
      await crearAsientos(antigua.layoutId, at(antigua.deckIds, 0), 10, 'V1-');
      assert.equal(await contarEnListado(), 10);

      const nueva = await createBusLayout(busId, { version: 2, status: 'DRAFT' });
      await crearAsientos(nueva.layoutId, at(nueva.deckIds, 0), 16, 'V2-');
      assert.equal(await contarEnListado(), 10, 'un borrador todavía no manda');

      // El relevo, en el orden en que lo hace `publishLayout`: primero se archiva la vigente,
      // porque `uq_layout_published_bus` no admite dos publicadas del mismo bus.
      await execute("UPDATE bus_layouts SET status = 'ARCHIVED' WHERE id = ?", [antigua.layoutId]);
      await execute("UPDATE bus_layouts SET status = 'PUBLISHED', published_at = NOW() WHERE id = ?", [nueva.layoutId]);

      assert.equal(await contarEnListado(), 16, 'ahora manda la recién publicada');
    });

    it('5 · los asientos históricos siguen existiendo, simplemente no se suman', async () => {
      const vieja = await createBusLayout(busId, { version: 1, status: 'ARCHIVED' });
      await crearAsientos(vieja.layoutId, at(vieja.deckIds, 0), 20, 'V1-');
      const vigente = await createBusLayout(busId, { version: 2, status: 'PUBLISHED' });
      await crearAsientos(vigente.layoutId, at(vigente.deckIds, 0), 5, 'V2-');

      assert.equal(await contarEnListado(), 5);

      const archivados = await queryOne<{ total: number }>(
        'SELECT COUNT(*) AS total FROM seats WHERE layout_id = ?',
        [vieja.layoutId],
      );
      assert.equal(Number(archivados?.total), 20, 'el histórico no se toca: booking_seats apunta ahí');
    });

    it('6 · la cifra no sale de buses.capacity', async () => {
      const { layoutId, deckIds } = await createBusLayout(busId, { version: 1, status: 'PUBLISHED' });
      await crearAsientos(layoutId, at(deckIds, 0), 9, 'A');

      // La caché de capacidad se deja adrede en un valor que no coincide con nada.
      await execute('UPDATE buses SET capacity = 44 WHERE id = ?', [busId]);

      const res = await get('/buses?search=SC-001', ctx.sessions.admin.token);
      const fila = res.body.data.find((bus: { id: number }) => bus.id === busId);
      assert.equal(Number(fila.seats_count), 9, 'cuenta asientos reales de la versión publicada');
      assert.equal(Number(fila.capacity), 44, 'y capacity sigue siendo lo que era, intacta');
    });
  });

  describe('Datos anteriores a la migración', () => {
    it('7 · un bus sin ninguna versión conserva la cuenta de siempre', async () => {
      // Así quedan los asientos que siembra `seed.ts`: colgados del bus y sin versión.
      for (let indice = 1; indice <= 6; indice += 1) {
        await execute(
          `INSERT INTO seats (bus_id, seat_number, \`row_number\`, column_number, is_window, is_aisle, status)
           VALUES (?, ?, ?, ?, 0, 0, 'AVAILABLE')`,
          [busId, `L${indice}`, Math.ceil(indice / 4), ((indice - 1) % 4) + 1],
        );
      }

      assert.equal(await contarEnListado(), 6, 'el dato legado se sigue viendo igual');
    });

    it('8 · un bus recién dado de alta, sin versiones y sin asientos, cuenta 0', async () => {
      assert.equal(await contarEnListado(), 0);
    });

    it('9 · un bus con versiones pero ninguna publicada no inventa una capacidad', async () => {
      const borrador = await createBusLayout(busId, { version: 1, status: 'DRAFT' });
      await crearAsientos(borrador.layoutId, at(borrador.deckIds, 0), 12, 'B');

      assert.equal(await contarEnListado(), 0, 'nada publicado, nada que mostrar');
    });
  });

  describe('El resto del contrato de GET /buses no cambia', () => {
    it('10 · el listado sigue trayendo los mismos campos y sus JOIN', async () => {
      const { layoutId, deckIds } = await createBusLayout(busId, { version: 1, status: 'PUBLISHED' });
      await crearAsientos(layoutId, at(deckIds, 0), 3, 'A');

      const res = await get('/buses?search=SC-001', ctx.sessions.admin.token);
      assert.equal(res.status, 200);
      const fila = res.body.data.find((bus: { id: number }) => bus.id === busId);

      for (const campo of ['id', 'company_id', 'bus_type_id', 'code', 'plate_number', 'brand', 'model', 'capacity', 'status', 'bus_type_name', 'company_name', 'seats_count']) {
        assert.ok(campo in fila, `el listado debe seguir trayendo ${campo}`);
      }
    });

    it('11 · la lectura de uno solo devuelve la misma cifra que el listado', async () => {
      const vieja = await createBusLayout(busId, { version: 1, status: 'ARCHIVED' });
      await crearAsientos(vieja.layoutId, at(vieja.deckIds, 0), 30, 'V1-');
      const vigente = await createBusLayout(busId, { version: 2, status: 'PUBLISHED' });
      await crearAsientos(vigente.layoutId, at(vigente.deckIds, 0), 4, 'V2-');

      const detalle = await get(`/buses/${busId}`, ctx.sessions.admin.token);
      assert.equal(detalle.status, 200);
      assert.equal(Number(detalle.body.data.seats_count), 4);
      assert.equal(Number(detalle.body.data.seats_count), await contarEnListado());
    });

    it('12 · el conteo de la paginación no se descuadra por el subconsulta', async () => {
      const { layoutId, deckIds } = await createBusLayout(busId, { version: 1, status: 'PUBLISHED' });
      await crearAsientos(layoutId, at(deckIds, 0), 5, 'A');

      const res = await get('/buses?limit=100', ctx.sessions.admin.token);
      assert.equal(res.status, 200);
      // Tres buses: los dos de los fixtures y el de esta prueba. Una fila por bus, ni una más.
      assert.equal(res.body.data.length, 3);
      assert.equal(Number(res.body.pagination.total), 3, 'el total de la paginación cuenta buses, no asientos');
    });

    it('13 · el orden y los filtros de siempre siguen funcionando', async () => {
      const { layoutId, deckIds } = await createBusLayout(busId, { version: 1, status: 'PUBLISHED' });
      await crearAsientos(layoutId, at(deckIds, 0), 5, 'A');

      const ordenado = await get('/buses?sort=b.code&order=DESC&limit=100', ctx.sessions.admin.token);
      assert.equal(ordenado.status, 200);
      const codigos = ordenado.body.data.map((bus: { code: string }) => bus.code);
      assert.deepEqual(codigos, [...codigos].sort().reverse(), 'el orden por código se mantiene');

      const filtrado = await get(`/buses?company_id=${ctx.fixtures.companyB}&limit=100`, ctx.sessions.admin.token);
      assert.equal(filtrado.status, 200);
      assert.ok(
        filtrado.body.data.every((bus: { company_id: number }) => Number(bus.company_id) === ctx.fixtures.companyB),
        'el filtro por empresa sigue restringiendo',
      );
    });

    it('14 · la empresa sigue viendo solo sus buses, con su cifra corregida', async () => {
      const { layoutId, deckIds } = await createBusLayout(busId, { version: 1, status: 'PUBLISHED' });
      await crearAsientos(layoutId, at(deckIds, 0), 5, 'A');

      const res = await get('/buses?limit=100', ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200);
      assert.ok(
        res.body.data.every((bus: { company_id: number }) => Number(bus.company_id) === ctx.fixtures.companyA),
        'el aislamiento multiempresa no cambió',
      );
      const fila = res.body.data.find((bus: { id: number }) => bus.id === busId);
      assert.equal(Number(fila.seats_count), 5);
    });
  });
});
