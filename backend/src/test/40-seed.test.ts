import { TEST_DATABASE } from '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { get, post } from './helpers/api';
import { query, queryOne } from '../config/database';
import { truncateOperationalData } from './helpers/database';
import { prepareSuite, teardownSuite } from './helpers/suite';

const ejecutar = promisify(execFile);

/**
 * H-02 · el seed deja una base utilizable bajo el modelo de versiones.
 *
 * LO QUE PASABA. `npm run seed` seguía escribiendo el modelo anterior: asientos colgados del
 * bus, sin versión ni piso, y viajes sin `bus_layout_id`. Una base recién sembrada nacía
 * inservible —`POST /trips` exige una versión publicada, el listado de buses contaba cero
 * asientos y el editor no tenía nada que editar—, y los asientos quedaban justo en el estado
 * que el resto del sistema prohíbe.
 *
 * CÓMO SE PRUEBA. Se vacía la base de pruebas, se ejecuta el seed DE VERDAD como proceso
 * aparte —el mismo comando que usa una persona— y después se comprueba lo que quedó, tanto
 * en la base como a través de la API.
 */
describe('H-02 · el seed siembra versiones de distribución completas', () => {
  before(async () => {
    await prepareSuite();
    // Fuera las fixtures: lo que se audita aquí es lo que deja el seed sobre una base limpia.
    await truncateOperationalData(TEST_DATABASE);

    const raiz = process.cwd();
    await ejecutar(process.execPath, [path.join(raiz, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/database/seed.ts'], {
      cwd: raiz,
      env: { ...process.env, DB_NAME: TEST_DATABASE, NODE_ENV: 'development' },
      maxBuffer: 10 * 1024 * 1024,
    });
  });
  after(teardownSuite);

  describe('Buses y versiones', () => {
    it('1 · el seed crea los tres buses de siempre', async () => {
      const buses = await query<{ code: string; capacity: number }>('SELECT code, capacity FROM buses ORDER BY code');
      assert.deepEqual(
        buses.map((bus) => bus.code),
        ['EA-001', 'EA-002', 'EA-003'],
      );
    });

    it('2 · cada bus tiene exactamente una versión, y publicada', async () => {
      const filas = await query<{ bus_id: number; total: number; publicadas: number }>(
        `SELECT b.id AS bus_id,
                (SELECT COUNT(*) FROM bus_layouts bl WHERE bl.bus_id = b.id) AS total,
                (SELECT COUNT(*) FROM bus_layouts bl WHERE bl.bus_id = b.id AND bl.status = 'PUBLISHED') AS publicadas
         FROM buses b`,
      );
      assert.equal(filas.length, 3);
      for (const fila of filas) {
        assert.equal(Number(fila.total), 1, `el bus ${fila.bus_id} debería tener una sola versión`);
        assert.equal(Number(fila.publicadas), 1, `el bus ${fila.bus_id} debería tenerla publicada`);
      }
    });

    it('3 · cada versión pertenece a su bus y es la número 1', async () => {
      const layouts = await query<{ id: number; bus_id: number; version: number }>('SELECT id, bus_id, version FROM bus_layouts');
      const buses = new Set((await query<{ id: number }>('SELECT id FROM buses')).map((bus) => bus.id));
      for (const layout of layouts) {
        assert.ok(buses.has(layout.bus_id), 'la versión cuelga de un bus que existe');
        assert.equal(Number(layout.version), 1);
      }
      assert.equal(new Set(layouts.map((l) => l.bus_id)).size, layouts.length, 'ningún bus repite versión');
    });

    it('4 · cada versión tiene su piso, con la rejilla declarada', async () => {
      const pisos = await query<{ layout_id: number; deck_number: number; row_count: number; column_count: number }>(
        'SELECT layout_id, deck_number, row_count, column_count FROM bus_layout_decks',
      );
      assert.equal(pisos.length, 3, 'un piso por versión');
      for (const piso of pisos) {
        assert.equal(Number(piso.deck_number), 1);
        assert.ok(Number(piso.row_count) > 0, 'las filas no pueden quedar sin declarar');
        assert.ok(Number(piso.column_count) > 0, 'las columnas tampoco');
      }
    });

    it('5 · la rejilla NO es la de 4 columnas para todos: hay pasillo real y varía por bus', async () => {
      const anchos = await query<{ column_count: number }>('SELECT DISTINCT column_count FROM bus_layout_decks ORDER BY column_count');
      assert.ok(anchos.length > 1, 'los tres buses no pueden tener la misma rejilla');

      // En cada piso debe quedar al menos una columna sin asientos: el pasillo.
      const pisos = await query<{ id: number; column_count: number }>('SELECT id, column_count FROM bus_layout_decks');
      for (const piso of pisos) {
        const ocupadas = new Set(
          (await query<{ column_number: number }>('SELECT DISTINCT column_number FROM seats WHERE deck_id = ?', [piso.id])).map((f) =>
            Number(f.column_number),
          ),
        );
        const pasillos = Array.from({ length: Number(piso.column_count) }, (_, i) => i + 1).filter((c) => !ocupadas.has(c));
        assert.ok(pasillos.length >= 1, `el piso ${piso.id} no tiene ninguna columna de pasillo`);
      }
    });
  });

  describe('Asientos', () => {
    it('6 · ningún asiento queda sin versión', async () => {
      const huerfanos = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM seats WHERE layout_id IS NULL');
      assert.equal(Number(huerfanos?.total ?? -1), 0);
    });

    it('7 · ningún asiento queda sin piso', async () => {
      const huerfanos = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM seats WHERE deck_id IS NULL');
      assert.equal(Number(huerfanos?.total ?? -1), 0);
    });

    it('8 · el piso de cada asiento pertenece a su misma versión, y el bus también', async () => {
      const descuadrados = await queryOne<{ total: number }>(
        `SELECT COUNT(*) AS total FROM seats s
         JOIN bus_layout_decks d ON d.id = s.deck_id
         JOIN bus_layouts bl ON bl.id = s.layout_id
         WHERE d.layout_id <> s.layout_id OR bl.bus_id <> s.bus_id`,
      );
      assert.equal(Number(descuadrados?.total ?? -1), 0);
    });

    it('9 · `seat_count` de la versión coincide con los asientos que tiene de verdad', async () => {
      const filas = await query<{ id: number; seat_count: number; reales: number }>(
        `SELECT bl.id, bl.seat_count, (SELECT COUNT(*) FROM seats s WHERE s.layout_id = bl.id) AS reales FROM bus_layouts bl`,
      );
      for (const fila of filas) {
        assert.equal(Number(fila.seat_count), Number(fila.reales), `la versión ${fila.id} miente sobre su recuento`);
      }
    });

    it('10 · `buses.capacity` coincide con la capacidad de la versión publicada', async () => {
      const filas = await query<{ code: string; capacity: number; seat_count: number }>(
        `SELECT b.code, b.capacity, bl.seat_count
         FROM buses b JOIN bus_layouts bl ON bl.bus_id = b.id AND bl.status = 'PUBLISHED'`,
      );
      assert.equal(filas.length, 3);
      for (const fila of filas) {
        assert.equal(Number(fila.capacity), Number(fila.seat_count), `${fila.code} descuadra capacidad y versión`);
      }
    });

    it('11 · las capacidades demo siguen siendo 42, 44 y 40', async () => {
      const filas = await query<{ code: string; capacity: number }>('SELECT code, capacity FROM buses ORDER BY code');
      assert.deepEqual(
        filas.map((f) => [f.code, Number(f.capacity)]),
        [
          ['EA-001', 42],
          ['EA-002', 44],
          ['EA-003', 40],
        ],
      );
    });

    it('12 · los números de asiento no se repiten dentro de una versión', async () => {
      const repetidos = await query<{ layout_id: number; seat_number: string }>(
        'SELECT layout_id, seat_number FROM seats GROUP BY layout_id, seat_number HAVING COUNT(*) > 1',
      );
      assert.deepEqual(repetidos, []);
    });

    it('13 · dos asientos no comparten casilla en el mismo piso', async () => {
      const choques = await query<{ deck_id: number; row_number: number; column_number: number }>(
        'SELECT deck_id, `row_number`, column_number FROM seats GROUP BY deck_id, `row_number`, column_number HAVING COUNT(*) > 1',
      );
      assert.deepEqual(choques, []);
    });

    it('14 · ningún asiento se sale de la rejilla que declara su piso', async () => {
      const fuera = await queryOne<{ total: number }>(
        `SELECT COUNT(*) AS total FROM seats s JOIN bus_layout_decks d ON d.id = s.deck_id
         WHERE s.row_number > d.row_count OR s.column_number > d.column_count OR s.row_number < 1 OR s.column_number < 1`,
      );
      assert.equal(Number(fuera?.total ?? -1), 0);
    });
  });

  describe('Viajes', () => {
    it('15 · todos los viajes nacen anclados a una versión', async () => {
      const total = Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM trips'))?.n ?? 0);
      assert.ok(total > 0, 'el seed debe crear viajes');

      const sinVersion = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM trips WHERE bus_layout_id IS NULL');
      assert.equal(Number(sinVersion?.n ?? -1), 0);
    });

    it('16 · la versión del viaje pertenece al mismo bus que el viaje', async () => {
      const descuadrados = await queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM trips t JOIN bus_layouts bl ON bl.id = t.bus_layout_id WHERE bl.bus_id <> t.bus_id`,
      );
      assert.equal(Number(descuadrados?.n ?? -1), 0);
    });

    it('17 · `available_seats` parte de la capacidad de esa versión', async () => {
      const descuadrados = await queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM trips t JOIN bus_layouts bl ON bl.id = t.bus_layout_id WHERE t.available_seats <> bl.seat_count`,
      );
      assert.equal(Number(descuadrados?.n ?? -1), 0);
    });
  });

  describe('La base sembrada se puede usar de verdad', () => {
    it('18 · el mapa público de un viaje sembrado devuelve sus asientos', async () => {
      const viaje = await queryOne<{ id: number; bus_layout_id: number }>(
        "SELECT id, bus_layout_id FROM trips WHERE status = 'SCHEDULED' AND departure_datetime >= NOW() ORDER BY id LIMIT 1",
      );
      assert.ok(viaje, 'el seed debe dejar algún viaje futuro');

      const res = await get(`/public/trips/${viaje.id}/seats`);
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const esperados = Number(
        (await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM seats WHERE layout_id = ?', [viaje.bus_layout_id]))?.n ?? 0,
      );
      assert.equal(res.body.data.length, esperados);
      assert.ok(res.body.data.every((asiento: { deck_id: number | null }) => asiento.deck_id !== null), 'todos con piso');
    });

    it('19 · la geometría pública también responde', async () => {
      const viaje = await queryOne<{ id: number }>(
        "SELECT id FROM trips WHERE status = 'SCHEDULED' AND departure_datetime >= NOW() ORDER BY id LIMIT 1",
      );
      const res = await get(`/public/trips/${viaje?.id}/layout`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'PUBLISHED');
      assert.equal(res.body.data.decks.length, 1);
      assert.ok(res.body.data.decks[0].row_count > 0 && res.body.data.decks[0].column_count > 0);
    });

    it('20 · se puede reservar y pagar sobre un viaje sembrado', async () => {
      const sesion = await post('/auth/login', { email: 'cliente@busperu.com', password: 'BusPeru2026' });
      assert.equal(sesion.status, 200, JSON.stringify(sesion.body));
      const token = sesion.body.data.token as string;

      const viaje = await queryOne<{ id: number; bus_layout_id: number }>(
        "SELECT id, bus_layout_id FROM trips WHERE status = 'SCHEDULED' AND departure_datetime >= NOW() ORDER BY id LIMIT 1",
      );
      const asiento = await queryOne<{ id: number }>('SELECT id FROM seats WHERE layout_id = ? ORDER BY id LIMIT 1', [
        viaje?.bus_layout_id,
      ]);

      const reserva = await post(
        '/bookings',
        { trip_id: viaje?.id, seat_ids: [asiento?.id], passenger_email: 'cliente@busperu.com' },
        token,
      );
      assert.equal(reserva.status, 201, JSON.stringify(reserva.body));

      // H-22: el efectivo lo da por cobrado el backoffice, no el pasajero.
      const admin = await post('/auth/login', { email: 'admin@busperu.com', password: 'BusPeru2026' });
      assert.equal(admin.status, 200, JSON.stringify(admin.body));
      const pago = await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'CASH' }, admin.body.data.token as string);
      assert.equal(pago.status, 200, JSON.stringify(pago.body));

      const mapa = await get(`/public/trips/${viaje?.id}/seats`);
      const vendido = (mapa.body.data as Array<{ id: number; is_taken: number }>).find((s) => s.id === asiento?.id);
      assert.ok(vendido && vendido.is_taken === 1, 'el asiento comprado figura ocupado');
    });

    it('21 · se puede programar un viaje nuevo: el bus ya tiene distribución publicada', async () => {
      const sesion = await post('/auth/login', { email: 'admin@busperu.com', password: 'BusPeru2026' });
      assert.equal(sesion.status, 200, JSON.stringify(sesion.body));

      const ruta = await queryOne<{ id: number }>('SELECT id FROM routes ORDER BY id LIMIT 1');
      const bus = await queryOne<{ id: number }>('SELECT id FROM buses ORDER BY id LIMIT 1');
      const salida = new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

      const res = await post(
        '/trips',
        { route_id: ruta?.id, bus_id: bus?.id, departure_datetime: salida, base_price: 55 },
        sesion.body.data.token,
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.ok(res.body.data.bus_layout_id, 'el viaje nuevo queda anclado a la versión publicada');
    });

    it('22 · el listado de buses cuenta los asientos de la versión publicada, no cero', async () => {
      const sesion = await post('/auth/login', { email: 'admin@busperu.com', password: 'BusPeru2026' });
      const res = await get('/buses?limit=50', sesion.body.data.token);
      assert.equal(res.status, 200);

      const filas = res.body.data as Array<{ code: string; seats_count: number; capacity: number }>;
      assert.equal(filas.length, 3);
      for (const fila of filas) {
        assert.equal(Number(fila.seats_count), Number(fila.capacity), `${fila.code} debería contar sus asientos`);
        assert.ok(Number(fila.seats_count) > 0);
      }
    });
  });

  describe('Integridad', () => {
    it('23 · no quedan filas huérfanas en ninguna de las tablas nuevas', async () => {
      const comprobaciones: Array<[string, string]> = [
        ['versiones sin bus', 'SELECT COUNT(*) AS n FROM bus_layouts bl LEFT JOIN buses b ON b.id = bl.bus_id WHERE b.id IS NULL'],
        [
          'pisos sin versión',
          'SELECT COUNT(*) AS n FROM bus_layout_decks d LEFT JOIN bus_layouts bl ON bl.id = d.layout_id WHERE bl.id IS NULL',
        ],
        [
          'elementos sin piso',
          'SELECT COUNT(*) AS n FROM bus_layout_elements e LEFT JOIN bus_layout_decks d ON d.id = e.deck_id WHERE d.id IS NULL',
        ],
        ['asientos sin bus', 'SELECT COUNT(*) AS n FROM seats s LEFT JOIN buses b ON b.id = s.bus_id WHERE b.id IS NULL'],
        [
          'viajes con una versión que no existe',
          'SELECT COUNT(*) AS n FROM trips t LEFT JOIN bus_layouts bl ON bl.id = t.bus_layout_id WHERE t.bus_layout_id IS NOT NULL AND bl.id IS NULL',
        ],
      ];
      for (const [nombre, sql] of comprobaciones) {
        assert.equal(Number((await queryOne<{ n: number }>(sql))?.n ?? -1), 0, nombre);
      }
    });

    it('24 · ninguna versión queda a medias: todas tienen piso y asientos', async () => {
      const incompletas = await queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM bus_layouts bl
         WHERE NOT EXISTS (SELECT 1 FROM bus_layout_decks d WHERE d.layout_id = bl.id)
            OR NOT EXISTS (SELECT 1 FROM seats s WHERE s.layout_id = bl.id)`,
      );
      assert.equal(Number(incompletas?.n ?? -1), 0);
    });

    it('25 · volver a ejecutar el seed no duplica nada ni crea una segunda versión', async () => {
      const antes = {
        buses: Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM buses'))?.n),
        layouts: Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM bus_layouts'))?.n),
        decks: Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM bus_layout_decks'))?.n),
        seats: Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM seats'))?.n),
      };

      const raiz = process.cwd();
      await ejecutar(process.execPath, [path.join(raiz, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/database/seed.ts'], {
        cwd: raiz,
        env: { ...process.env, DB_NAME: TEST_DATABASE, NODE_ENV: 'development' },
        maxBuffer: 10 * 1024 * 1024,
      });

      assert.equal(Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM buses'))?.n), antes.buses);
      assert.equal(Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM bus_layouts'))?.n), antes.layouts);
      assert.equal(Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM bus_layout_decks'))?.n), antes.decks);
      assert.equal(Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM seats'))?.n), antes.seats);
    });
  });
});
