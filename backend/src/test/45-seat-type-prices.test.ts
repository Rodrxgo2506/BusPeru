import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { del, get, post } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats, setSeatTypePrice } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * H-08 · borrar un tipo de asiento ya no borra los precios de los viajes.
 *
 * LO QUE PASABA. La clave ajena de `trip_seat_type_prices` hacia `seat_types` nació con
 * ON DELETE CASCADE. El catálogo lo administra el ADMIN de la plataforma, así que borrar un
 * tipo arrastraba en silencio todas sus filas de precios. Y el daño no era un error visible
 * sino un cambio de precio mudo: el precio efectivo sale de
 * `COALESCE(trip_seat_type_prices.price, trips.base_price)`, de modo que al desaparecer la
 * fila el viaje pasaba a cobrar el precio base sin que nadie lo hubiera tocado.
 *
 * CÓMO SE CORRIGE. La clave pasa a RESTRICT (migración 011). La base es la que impide el
 * borrado, así que no hay ventana entre comprobar y borrar; la API no cambió porque el
 * manejador de errores del proyecto ya traduce `ER_ROW_IS_REFERENCED_2` a un 409 de negocio.
 */
describe('H-08 · los precios por tipo de asiento sobreviven al catálogo', () => {
  let ctx: SuiteContext;
  let tipoConPrecio = 0;
  let tipoSuelto = 0;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  beforeEach(async () => {
    await execute('DELETE FROM trip_seat_type_prices');
    await execute("DELETE FROM seat_types WHERE name LIKE 'H08%'");

    tipoConPrecio = (await execute("INSERT INTO seat_types (name, description) VALUES ('H08 Cama 180', 'Con precio')")).insertId;
    tipoSuelto = (await execute("INSERT INTO seat_types (name, description) VALUES ('H08 Suelto', 'Sin referencias')")).insertId;
  });

  const borrarTipo = (id: number, token = ctx.sessions.admin.token) => del(`/seat-types/${id}`, token);

  const precios = () =>
    query<{ trip_id: number; seat_type_id: number; price: string }>(
      'SELECT trip_id, seat_type_id, price FROM trip_seat_type_prices ORDER BY trip_id, seat_type_id',
    );

  /** Pone el tipo a los asientos del viaje A y le fija un precio específico. */
  async function configurarPrecio(precio: number, tipo = tipoConPrecio, tripId = ctx.fixtures.tripA): Promise<void> {
    await execute('UPDATE seats SET seat_type_id = ? WHERE layout_id = ?', [tipo, ctx.fixtures.layoutA]);
    await setSeatTypePrice(tripId, tipo, precio);
  }

  // =====================================================================
  describe('Un tipo sin referencias se sigue borrando', () => {
    it('1 · el ADMIN borra un tipo que no usa nadie', async () => {
      const res = await borrarTipo(tipoSuelto);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(await queryOne('SELECT id FROM seat_types WHERE id = ?', [tipoSuelto]), null);
    });

    it('2 · un tipo usado solo por asientos se sigue borrando, y el asiento queda sin tipo', async () => {
      // `fk_seats_type` es SET NULL desde antes de esta corrección y no se ha tocado.
      const asiento = at(await query<{ id: number }>('SELECT id FROM seats WHERE layout_id = ? LIMIT 1', [ctx.fixtures.layoutA]), 0);
      await execute('UPDATE seats SET seat_type_id = ? WHERE id = ?', [tipoSuelto, asiento.id]);

      assert.equal((await borrarTipo(tipoSuelto)).status, 200);
      const despues = await queryOne<{ seat_type_id: number | null }>('SELECT seat_type_id FROM seats WHERE id = ?', [asiento.id]);
      assert.equal(despues?.seat_type_id, null);
    });
  });

  // =====================================================================
  describe('Un tipo con precios configurados ya no se borra', () => {
    it('3 · el borrado se rechaza con un error de negocio', async () => {
      await configurarPrecio(70);

      const res = await borrarTipo(tipoConPrecio);
      assert.equal(res.status, 409);
      assert.equal(res.body.success, false);
      assert.match(String(res.body.message), /no se puede eliminar/i);
    });

    it('4 · el rechazo no filtra ningún error de SQL', async () => {
      await configurarPrecio(70);
      const res = await borrarTipo(tipoConPrecio);

      const texto = JSON.stringify(res.body);
      for (const rastro of ['ER_ROW_IS_REFERENCED', 'ER_', 'sqlMessage', 'errno', 'FOREIGN KEY', 'trip_seat_type_prices', 'at Object']) {
        assert.equal(texto.includes(rastro), false, `no debe asomar ${rastro}`);
      }
    });

    it('5 · el precio configurado sigue ahí', async () => {
      await configurarPrecio(70);
      const antes = await precios();

      await borrarTipo(tipoConPrecio);

      assert.deepEqual(await precios(), antes);
      assert.equal(Number(at(await precios(), 0).price), 70);
    });

    it('6 · el tipo de asiento sigue existiendo', async () => {
      await configurarPrecio(70);
      await borrarTipo(tipoConPrecio);

      const tipo = await queryOne<{ id: number; name: string }>('SELECT id, name FROM seat_types WHERE id = ?', [tipoConPrecio]);
      assert.equal(Number(tipo?.id), tipoConPrecio);
      assert.equal(tipo?.name, 'H08 Cama 180');
    });

    it('7 · el viaje no cambia en nada', async () => {
      await configurarPrecio(70);
      const antes = await queryOne('SELECT * FROM trips WHERE id = ?', [ctx.fixtures.tripA]);

      await borrarTipo(tipoConPrecio);

      assert.deepEqual(await queryOne('SELECT * FROM trips WHERE id = ?', [ctx.fixtures.tripA]), antes);
    });

    it('8 · el precio efectivo del viaje sigue siendo el específico, no el base', async () => {
      await configurarPrecio(70);
      const base = Number((await queryOne<{ base_price: string }>('SELECT base_price FROM trips WHERE id = ?', [ctx.fixtures.tripA]))?.base_price);
      assert.notEqual(base, 70, 'si coincidieran, la prueba no probaría nada');

      await borrarTipo(tipoConPrecio);

      const mapa = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);
      assert.equal(mapa.status, 200);
      for (const asiento of mapa.body.data as Array<{ price: string }>) {
        assert.equal(Number(asiento.price), 70, 'el mapa sigue mostrando el precio configurado');
      }
    });

    it('9 · y el cobro real también', async () => {
      await configurarPrecio(70);
      await borrarTipo(tipoConPrecio);

      const libres = await freeSeats(ctx.fixtures.tripA);
      const reserva = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [at(libres, 0).id], passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token,
      );
      assert.equal(reserva.status, 201, JSON.stringify(reserva.body));
      assert.equal(Number(reserva.body.data.subtotal), 70, 'se cobra el precio del tipo, no el base');
    });

    it('10 · con precios en VARIOS viajes también se rechaza, y no se pierde ninguno', async () => {
      await configurarPrecio(70, tipoConPrecio, ctx.fixtures.tripA);
      await execute('UPDATE seats SET seat_type_id = ? WHERE layout_id = ?', [tipoConPrecio, ctx.fixtures.layoutB]);
      await setSeatTypePrice(ctx.fixtures.tripB, tipoConPrecio, 99);

      const antes = await precios();
      assert.ok(antes.length >= 2, 'la prueba necesita precios en más de un viaje');

      assert.equal((await borrarTipo(tipoConPrecio)).status, 409);
      assert.deepEqual(await precios(), antes);
    });

    it('11 · basta con UNA fila de precio para bloquear el borrado', async () => {
      await setSeatTypePrice(ctx.fixtures.tripA, tipoSuelto, 55);

      assert.equal((await borrarTipo(tipoSuelto)).status, 409);
      assert.equal((await precios()).length, 1);
    });
  });

  // =====================================================================
  describe('El histórico de ventas no se toca', () => {
    it('12 · `booking_seats.price` sigue congelado tras el intento de borrado', async () => {
      await configurarPrecio(70);

      const libres = await freeSeats(ctx.fixtures.tripA);
      const reserva = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [at(libres, 0).id], passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token,
      );
      assert.equal(reserva.status, 201);
      await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'CASH' }, ctx.sessions.customer.token);

      const antesVenta = await query('SELECT * FROM booking_seats WHERE booking_id = ?', [reserva.body.data.id]);
      const antesReserva = await queryOne('SELECT * FROM bookings WHERE id = ?', [reserva.body.data.id]);
      assert.equal(Number(at(antesVenta as Array<{ price: string }>, 0).price), 70);

      assert.equal((await borrarTipo(tipoConPrecio)).status, 409);

      assert.deepEqual(await query('SELECT * FROM booking_seats WHERE booking_id = ?', [reserva.body.data.id]), antesVenta);
      assert.deepEqual(await queryOne('SELECT * FROM bookings WHERE id = ?', [reserva.body.data.id]), antesReserva);
    });

    it('13 · aunque el precio del catálogo cambie después, la venta conserva el suyo', async () => {
      await configurarPrecio(70);
      const libres = await freeSeats(ctx.fixtures.tripA);
      const reserva = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [at(libres, 0).id], passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token,
      );
      assert.equal(reserva.status, 201);

      // El precio configurado del viaje sube DESPUÉS de la venta.
      await execute('UPDATE trip_seat_type_prices SET price = 999 WHERE trip_id = ? AND seat_type_id = ?', [
        ctx.fixtures.tripA,
        tipoConPrecio,
      ]);

      const venta = await queryOne<{ price: string }>('SELECT price FROM booking_seats WHERE booking_id = ?', [
        reserva.body.data.id,
      ]);
      assert.equal(Number(venta?.price), 70, 'el precio histórico no se recalcula');
    });
  });

  // =====================================================================
  describe('Permisos, aislamiento y vías alternativas', () => {
    it('14 · el catálogo sigue siendo solo del ADMIN', async () => {
      assert.equal((await borrarTipo(tipoSuelto, ctx.sessions.companyAdmin.token)).status, 403);
      assert.equal((await borrarTipo(tipoSuelto, ctx.sessions.operator.token)).status, 403);
      assert.equal((await borrarTipo(tipoSuelto, ctx.sessions.customer.token)).status, 403);
      assert.equal((await del(`/seat-types/${tipoSuelto}`)).status, 401);

      // Y sigue existiendo: ninguno de los rechazos lo borró.
      assert.ok(await queryOne('SELECT id FROM seat_types WHERE id = ?', [tipoSuelto]));
    });

    it('15 · el ADMIN conserva la administración del catálogo', async () => {
      const creado = await post('/seat-types', { name: 'H08 Nuevo', description: 'Alta' }, ctx.sessions.admin.token);
      assert.equal(creado.status, 201, JSON.stringify(creado.body));

      const listado = await get('/seat-types?limit=100', ctx.sessions.admin.token);
      assert.equal(listado.status, 200);
      assert.ok((listado.body.data as Array<{ id: number }>).some((tipo) => tipo.id === creado.body.data.id));

      assert.equal((await del(`/seat-types/${creado.body.data.id}`, ctx.sessions.admin.token)).status, 200);
    });

    it('16 · no hay una vía alternativa que sí borre el tipo con precios', async () => {
      await configurarPrecio(70);

      // El recurso genérico es el único camino; se prueban sus verbos y un id manipulado.
      assert.equal((await borrarTipo(tipoConPrecio)).status, 409);
      assert.equal((await del(`/seat-types/${tipoConPrecio}?force=true`, ctx.sessions.admin.token)).status, 409);
      assert.equal((await del(`/seat-types/${tipoConPrecio}/`, ctx.sessions.admin.token)).status, 409);

      assert.ok(await queryOne('SELECT id FROM seat_types WHERE id = ?', [tipoConPrecio]));
      assert.equal((await precios()).length, 1);
    });

    it('17 · un tipo inexistente sigue respondiendo 404', async () => {
      assert.equal((await del('/seat-types/99999999', ctx.sessions.admin.token)).status, 404);
    });
  });

  // =====================================================================
  describe('La base es la última línea de defensa', () => {
    it('18 · la clave ajena hacia `seat_types` es RESTRICT y conserva su ON UPDATE', async () => {
      const clave = await queryOne<{ al_borrar: string; al_actualizar: string }>(
        `SELECT delete_rule AS al_borrar, update_rule AS al_actualizar
         FROM information_schema.referential_constraints
         WHERE constraint_schema = DATABASE() AND table_name = 'trip_seat_type_prices'
           AND constraint_name = 'fk_trip_seat_type_prices_type'`,
      );
      assert.equal(clave?.al_borrar, 'RESTRICT');
      assert.equal(clave?.al_actualizar, 'CASCADE');
    });

    it('19 · la clave hacia `trips` sigue en CASCADE: sin viaje, el precio no significa nada', async () => {
      const clave = await queryOne<{ al_borrar: string }>(
        `SELECT delete_rule AS al_borrar FROM information_schema.referential_constraints
         WHERE constraint_schema = DATABASE() AND table_name = 'trip_seat_type_prices'
           AND constraint_name = 'fk_trip_seat_type_prices_trip'`,
      );
      assert.equal(clave?.al_borrar, 'CASCADE');
    });

    it('20 · un DELETE directo en la base tampoco se lleva los precios por delante', async () => {
      await configurarPrecio(70);

      await assert.rejects(
        () => execute('DELETE FROM seat_types WHERE id = ?', [tipoConPrecio]),
        (error: { code?: string }) => error.code === 'ER_ROW_IS_REFERENCED_2',
        'la base debe rechazarlo aunque nadie pase por la API',
      );
      assert.equal((await precios()).length, 1);
    });

    it('21 · columnas e índices de la tabla siguen intactos', async () => {
      const columnas = (await query<{ Field: string }>('SHOW COLUMNS FROM trip_seat_type_prices')).map((fila) => fila.Field);
      assert.deepEqual(columnas, ['id', 'trip_id', 'seat_type_id', 'price', 'created_at', 'updated_at']);

      const indices = new Set((await query<{ Key_name: string }>('SHOW INDEX FROM trip_seat_type_prices')).map((fila) => fila.Key_name));
      for (const indice of ['PRIMARY', 'uq_trip_seat_type_price', 'idx_trip_seat_type_prices_trip', 'idx_trip_seat_type_prices_type']) {
        assert.ok(indices.has(indice), `falta el índice ${indice}`);
      }
    });

    it('22 · borrar un viaje sí se lleva sus precios, como siempre', async () => {
      const viaje = await execute(
        `INSERT INTO trips (route_id, bus_id, bus_layout_id, departure_datetime, arrival_datetime, base_price, available_seats, status)
         SELECT route_id, bus_id, bus_layout_id, DATE_ADD(departure_datetime, INTERVAL 30 DAY),
                DATE_ADD(arrival_datetime, INTERVAL 30 DAY), base_price, available_seats, 'SCHEDULED'
         FROM trips WHERE id = ?`,
        [ctx.fixtures.tripA],
      );
      await setSeatTypePrice(viaje.insertId, tipoConPrecio, 61);
      assert.equal((await precios()).length, 1);

      await execute('DELETE FROM trips WHERE id = ?', [viaje.insertId]);
      assert.equal((await precios()).length, 0, 'sin viaje, el precio no tiene sentido');
    });
  });
});
