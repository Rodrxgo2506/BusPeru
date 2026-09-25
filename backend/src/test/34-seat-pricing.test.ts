import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { get, post, put } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, createBusLayout, freeSeats, setSeatTypePrice, syncLayoutSeatCount } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';
import { expireDueBookings } from '../services/booking-expiry.service';

/**
 * Migración 010 · precio por tipo de asiento y capacidad por versión.
 *
 * TRES INVARIANTES SE PRUEBAN AQUÍ.
 *
 *   1. El precio de una reserva es la SUMA de lo que vale cada asiento, no el precio del
 *      viaje multiplicado por cuántos son. Un bus con Cama 180° y Semi Cama cobra distinto
 *      por cada uno dentro del mismo viaje.
 *   2. Lo cobrado queda congelado en `booking_seats.price`. Que la empresa suba la tarifa
 *      mañana no puede reescribir lo que alguien pagó ayer.
 *   3. Los cupos que se devuelven al expirar o cancelar se topan con la capacidad de LA
 *      VERSIÓN que el viaje congeló, no con la del bus. Si el bus adelgazó de 42 a 40
 *      plazas, un viaje anclado a la versión de 42 conserva sus 42.
 *
 * El precio nunca llega del cliente: se prueba explícitamente que enviarlo no cambia nada.
 */
describe('Precio por tipo de asiento y capacidad por versión (migración 010)', () => {
  let ctx: SuiteContext;
  let tipoCama: number;
  let tipoMujer: number;

  before(async () => {
    ctx = await prepareSuite();
    const cama = await queryOne<{ id: number }>('SELECT seat_type_id AS id FROM seats WHERE id = ? LIMIT 1', [at(ctx.fixtures.seatsA, 0)]);
    const mujer = await queryOne<{ id: number }>("SELECT id FROM seat_types WHERE name = 'Mujer' LIMIT 1");
    tipoCama = Number(cama?.id);
    tipoMujer = Number(mujer?.id);
  });
  after(teardownSuite);

  beforeEach(async () => {
    await execute('DELETE FROM financial_transactions');
    // Desde H-50 cancelar una reserva pagada abre su reembolso: va antes que los pagos que referencia.
    await execute('DELETE FROM refunds');
    await execute('DELETE FROM payments');
    await execute('DELETE FROM booking_seats');
    await execute('DELETE FROM bookings');
    await execute('DELETE FROM trip_seat_type_prices');
    await execute('UPDATE trips SET available_seats = 12, base_price = 45.00 WHERE id = ?', [ctx.fixtures.tripA]);
  });

  /** Reserva del viaje A con los asientos indicados. */
  async function reservar(seatIds: number[], extra: Record<string, unknown> = {}) {
    return post(
      '/bookings',
      { trip_id: ctx.fixtures.tripA, seat_ids: seatIds, passenger_email: 'cliente@test.pe', ...extra },
      ctx.sessions.customer.token,
    );
  }

  /** Los asientos del viaje A separados por categoría. */
  async function asientosPorTipo() {
    const filas = await query<{ id: number; seat_type_id: number }>(
      'SELECT id, seat_type_id FROM seats WHERE layout_id = ? ORDER BY id ASC',
      [ctx.fixtures.layoutA],
    );
    return {
      cama: filas.filter((fila) => Number(fila.seat_type_id) === tipoCama).map((fila) => fila.id),
      mujer: filas.filter((fila) => Number(fila.seat_type_id) === tipoMujer).map((fila) => fila.id),
    };
  }

  describe('Creación de viajes anclada a la versión', () => {
    it('1 · un viaje nuevo recibe automáticamente la versión publicada del bus', async () => {
      const res = await post(
        '/trips',
        {
          route_id: ctx.fixtures.routeA,
          bus_id: ctx.fixtures.busA,
          departure_datetime: '2027-01-15 08:00:00',
          arrival_datetime: '2027-01-15 18:00:00',
          base_price: 60,
        },
        ctx.sessions.companyAdmin.token,
      );

      assert.equal(res.status, 201, JSON.stringify(res.body));
      const creado = await queryOne<{ bus_layout_id: number; available_seats: number }>(
        'SELECT bus_layout_id, available_seats FROM trips WHERE id = ?',
        [res.body.data.id],
      );
      assert.equal(Number(creado?.bus_layout_id), ctx.fixtures.layoutA);
      assert.equal(Number(creado?.available_seats), ctx.fixtures.seatsA.length, 'los cupos iniciales son los de la versión');
    });

    it('2 · un bus sin versión publicada no permite crear el viaje', async () => {
      await execute("UPDATE bus_layouts SET status = 'ARCHIVED' WHERE id = ?", [ctx.fixtures.layoutA]);
      try {
        const res = await post(
          '/trips',
          {
            route_id: ctx.fixtures.routeA,
            bus_id: ctx.fixtures.busA,
            departure_datetime: '2027-02-15 08:00:00',
            base_price: 60,
          },
          ctx.sessions.companyAdmin.token,
        );

        assert.equal(res.status, 400);
        assert.match(String(res.body.message), /distribución/i);
        const creados = await queryOne<{ total: number }>(
          "SELECT COUNT(*) AS total FROM trips WHERE departure_datetime = '2027-02-15 08:00:00'",
        );
        assert.equal(Number(creados?.total), 0, 'no debe quedar ningún viaje a medio crear');
      } finally {
        await execute("UPDATE bus_layouts SET status = 'PUBLISHED' WHERE id = ?", [ctx.fixtures.layoutA]);
      }
    });

    it('3 · el cliente no puede imponer la versión de otro bus', async () => {
      const res = await post(
        '/trips',
        {
          route_id: ctx.fixtures.routeA,
          bus_id: ctx.fixtures.busA,
          bus_layout_id: ctx.fixtures.layoutB,
          departure_datetime: '2027-03-15 08:00:00',
          base_price: 60,
        },
        ctx.sessions.companyAdmin.token,
      );

      assert.equal(res.status, 201);
      const creado = await queryOne<{ bus_layout_id: number }>('SELECT bus_layout_id FROM trips WHERE id = ?', [res.body.data.id]);
      assert.equal(Number(creado?.bus_layout_id), ctx.fixtures.layoutA, 'manda el bus, no lo que envíe el cliente');
    });

    it('4 · cambiar el bus de un viaje mueve también su versión', async () => {
      const creado = await post(
        '/trips',
        { route_id: ctx.fixtures.routeA, bus_id: ctx.fixtures.busA, departure_datetime: '2027-04-15 08:00:00', base_price: 60 },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(creado.status, 201);

      // El bus B es de otra empresa: se usa el admin, que sí puede cruzar empresas.
      const res = await put(`/trips/${creado.body.data.id}`, { bus_id: ctx.fixtures.busB }, ctx.sessions.admin.token);

      assert.equal(res.status, 200, JSON.stringify(res.body));
      const actualizado = await queryOne<{ bus_id: number; bus_layout_id: number }>(
        'SELECT bus_id, bus_layout_id FROM trips WHERE id = ?',
        [creado.body.data.id],
      );
      assert.equal(Number(actualizado?.bus_id), ctx.fixtures.busB);
      assert.equal(Number(actualizado?.bus_layout_id), ctx.fixtures.layoutB, 'la versión debe seguir al bus');
    });
  });

  describe('El precio de cada asiento', () => {
    it('5 · sin precios configurados, todo cuesta `base_price` y el total no cambia', async () => {
      const libres = await freeSeats(ctx.fixtures.tripA);
      const res = await reservar([at(libres, 0).id, at(libres, 1).id]);

      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(Number(res.body.data.subtotal), 90, '45 × 2, exactamente como antes de esta fase');
      assert.equal(Number(res.body.data.total_amount), 95, 'más 2.50 de servicio por pasajero');
    });

    it('6 · el subtotal suma el precio de cada asiento, no multiplica el del viaje', async () => {
      await setSeatTypePrice(ctx.fixtures.tripA, tipoCama, 70);
      await setSeatTypePrice(ctx.fixtures.tripA, tipoMujer, 55);
      const tipos = await asientosPorTipo();

      const res = await reservar([at(tipos.cama, 0), at(tipos.mujer, 0)]);

      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(Number(res.body.data.subtotal), 125, '70 + 55');
      assert.equal(Number(res.body.data.total_amount), 130, '125 + 2.50 × 2');
    });

    it('7 · `booking_seats.price` guarda el precio de cada asiento por separado', async () => {
      await setSeatTypePrice(ctx.fixtures.tripA, tipoCama, 70);
      await setSeatTypePrice(ctx.fixtures.tripA, tipoMujer, 55);
      const tipos = await asientosPorTipo();
      const asientoCama = at(tipos.cama, 0);
      const asientoMujer = at(tipos.mujer, 0);

      const res = await reservar([asientoCama, asientoMujer]);
      assert.equal(res.status, 201);

      const filas = await query<{ seat_id: number; price: string }>(
        'SELECT seat_id, price FROM booking_seats WHERE booking_id = ?',
        [res.body.data.id],
      );
      const porAsiento = new Map(filas.map((fila) => [Number(fila.seat_id), Number(fila.price)]));
      assert.equal(porAsiento.get(asientoCama), 70);
      assert.equal(porAsiento.get(asientoMujer), 55);
    });

    it('8 · un tipo sin precio propio cae a `base_price` aunque otro tipo sí lo tenga', async () => {
      await setSeatTypePrice(ctx.fixtures.tripA, tipoMujer, 80);
      const tipos = await asientosPorTipo();

      const res = await reservar([at(tipos.cama, 0), at(tipos.mujer, 0)]);

      assert.equal(Number(res.body.data.subtotal), 125, '45 del que no tiene precio + 80 del que sí');
    });

    it('9 · el precio que envía el cliente se ignora por completo', async () => {
      const libres = await freeSeats(ctx.fixtures.tripA);
      const res = await reservar([at(libres, 0).id], { price: 1, subtotal: 1, total_amount: 1 });

      assert.equal(res.status, 201);
      assert.equal(Number(res.body.data.subtotal), 45, 'manda el servidor');
      assert.equal(Number(res.body.data.total_amount), 47.5);
      const fila = await queryOne<{ price: string }>('SELECT price FROM booking_seats WHERE booking_id = ?', [res.body.data.id]);
      assert.equal(Number(fila?.price), 45);
    });

    it('10 · un asiento de otra versión no se puede reservar en este viaje', async () => {
      const otra = await createBusLayout(ctx.fixtures.busA, { version: 5, status: 'DRAFT', rows: 1, columns: 1 });
      const ajeno = await execute(
        `INSERT INTO seats (bus_id, layout_id, deck_id, seat_type_id, seat_number, row_number, column_number, is_window, is_aisle, status)
         VALUES (?, ?, ?, NULL, 'Z9', 1, 1, 0, 0, 'AVAILABLE')`,
        [ctx.fixtures.busA, otra.layoutId, at(otra.deckIds, 0)],
      );
      try {
        const res = await reservar([ajeno.insertId]);

        assert.equal(res.status, 400);
        assert.match(String(res.body.message), /no pertenece/i);
      } finally {
        await execute('DELETE FROM seats WHERE layout_id = ?', [otra.layoutId]);
        await execute('DELETE FROM bus_layouts WHERE id = ?', [otra.layoutId]);
      }
    });
  });

  describe('El precio cobrado es historia y no se reescribe', () => {
    it('11 · cambiar el precio del tipo después de reservar no toca lo ya cobrado', async () => {
      await setSeatTypePrice(ctx.fixtures.tripA, tipoCama, 70);
      const tipos = await asientosPorTipo();
      const res = await reservar([at(tipos.cama, 0)]);
      assert.equal(res.status, 201);

      await execute('UPDATE trip_seat_type_prices SET price = 999 WHERE trip_id = ? AND seat_type_id = ?', [
        ctx.fixtures.tripA,
        tipoCama,
      ]);

      const fila = await queryOne<{ price: string }>('SELECT price FROM booking_seats WHERE booking_id = ?', [res.body.data.id]);
      assert.equal(Number(fila?.price), 70, 'lo pagado no cambia porque cambie la tarifa');
      const reserva = await queryOne<{ subtotal: string }>('SELECT subtotal FROM bookings WHERE id = ?', [res.body.data.id]);
      assert.equal(Number(reserva?.subtotal), 70);
    });

    it('12 · cambiar `trips.base_price` después de reservar tampoco', async () => {
      const libres = await freeSeats(ctx.fixtures.tripA);
      const res = await reservar([at(libres, 0).id]);
      assert.equal(res.status, 201);

      await execute('UPDATE trips SET base_price = 500 WHERE id = ?', [ctx.fixtures.tripA]);

      const fila = await queryOne<{ price: string }>('SELECT price FROM booking_seats WHERE booking_id = ?', [res.body.data.id]);
      assert.equal(Number(fila?.price), 45);
    });

    it('13 · el precio es por viaje: otro viaje del mismo bus no hereda el recargo', async () => {
      await setSeatTypePrice(ctx.fixtures.tripA, tipoCama, 70);
      const otro = await queryOne<{ id: number }>('SELECT id FROM trips WHERE bus_id = ? AND id <> ? LIMIT 1', [
        ctx.fixtures.busA,
        ctx.fixtures.tripA,
      ]);

      const libres = await freeSeats(otro!.id);
      const res = await post(
        '/bookings',
        { trip_id: otro!.id, seat_ids: [at(libres, 0).id], passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token,
      );

      assert.equal(res.status, 201);
      assert.equal(Number(res.body.data.subtotal), 45);
    });
  });

  describe('Capacidad: el tope es el de la versión del viaje', () => {
    /** Deja el viaje A anclado a una versión con `seat_count` distinto del bus. */
    async function anclarAVersionMasGrande(seatCount: number) {
      const otra = await createBusLayout(ctx.fixtures.busA, { version: 6, status: 'DRAFT', rows: 3, columns: 4 });
      await execute('UPDATE bus_layouts SET seat_count = ? WHERE id = ?', [seatCount, otra.layoutId]);
      // Los asientos del viaje siguen siendo los de la v1: solo se mueve el tope.
      await execute('UPDATE trips SET bus_layout_id = ? WHERE id = ?', [otra.layoutId, ctx.fixtures.tripA]);
      return otra.layoutId;
    }

    it('14 · al cancelar, los cupos no superan el `seat_count` de la versión', async () => {
      const libres = await freeSeats(ctx.fixtures.tripA);
      const res = await reservar([at(libres, 0).id]);
      assert.equal(res.status, 201);

      await execute('UPDATE trips SET available_seats = 11 WHERE id = ?', [ctx.fixtures.tripA]);
      await execute('UPDATE bus_layouts SET seat_count = 11 WHERE id = ?', [ctx.fixtures.layoutA]);
      try {
        const cancelada = await post(`/bookings/${res.body.data.id}/cancel`, {}, ctx.sessions.customer.token);
        assert.equal(cancelada.status, 200, JSON.stringify(cancelada.body));

        const viaje = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
        assert.equal(Number(viaje?.available_seats), 11, 'el tope es el de la versión, no puede desbordar');
      } finally {
        await syncLayoutSeatCount(ctx.fixtures.layoutA);
      }
    });

    it('15 · al expirar, los cupos tampoco superan ese tope', async () => {
      const libres = await freeSeats(ctx.fixtures.tripA);
      const res = await reservar([at(libres, 0).id]);
      assert.equal(res.status, 201);
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [res.body.data.id]);

      await execute('UPDATE trips SET available_seats = 11 WHERE id = ?', [ctx.fixtures.tripA]);
      await execute('UPDATE bus_layouts SET seat_count = 11 WHERE id = ?', [ctx.fixtures.layoutA]);
      try {
        await expireDueBookings();

        const viaje = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
        assert.equal(Number(viaje?.available_seats), 11);
        const reserva = await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [res.body.data.id]);
        assert.equal(reserva?.status, 'EXPIRED');
      } finally {
        await syncLayoutSeatCount(ctx.fixtures.layoutA);
      }
    });

    it('16 · un viaje anclado a una versión de 42 conserva su tope aunque el bus tenga 12', async () => {
      // Este es el caso que motivó el cambio: `buses.capacity` vale 12 en los fixtures.
      // La reserva se hace ANTES de mover la version: `freeSeats` resuelve por version, y la
      // version grande solo lleva el tope, no asientos propios.
      const libres = await freeSeats(ctx.fixtures.tripA);
      const res = await reservar([at(libres, 0).id]);
      assert.equal(res.status, 201);

      const layoutGrande = await anclarAVersionMasGrande(42);
      try {
        await execute('UPDATE trips SET available_seats = 41 WHERE id = ?', [ctx.fixtures.tripA]);
        const cancelada = await post(`/bookings/${res.body.data.id}/cancel`, {}, ctx.sessions.customer.token);
        assert.equal(cancelada.status, 200);

        const viaje = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
        assert.equal(Number(viaje?.available_seats), 42, 'con el tope viejo se habría quedado en 12');
      } finally {
        await execute('UPDATE trips SET bus_layout_id = ? WHERE id = ?', [ctx.fixtures.layoutA, ctx.fixtures.tripA]);
        await execute('DELETE FROM bus_layouts WHERE id = ?', [layoutGrande]);
      }
    });

    it('17 · un viaje sin versión propia sigue topando con la capacidad del bus', async () => {
      // Compatibilidad con los datos anteriores a la migración 010.
      const libres = await freeSeats(ctx.fixtures.tripA);
      const res = await reservar([at(libres, 0).id]);
      assert.equal(res.status, 201);

      await execute('UPDATE trips SET bus_layout_id = NULL, available_seats = 99 WHERE id = ?', [ctx.fixtures.tripA]);
      try {
        await post(`/bookings/${res.body.data.id}/cancel`, {}, ctx.sessions.customer.token);

        const viaje = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
        assert.equal(Number(viaje?.available_seats), 12, 'el respaldo es `buses.capacity`');
      } finally {
        await execute('UPDATE trips SET bus_layout_id = ? WHERE id = ?', [ctx.fixtures.layoutA, ctx.fixtures.tripA]);
      }
    });
  });

  describe('La concurrencia no se resintió', () => {
    it('18 · dos compras simultáneas del mismo asiento: solo una se lleva la plaza', async () => {
      await setSeatTypePrice(ctx.fixtures.tripA, tipoCama, 70);
      const asiento = at(await freeSeats(ctx.fixtures.tripA), 0).id;

      const [uno, dos] = await Promise.all([reservar([asiento]), reservar([asiento])]);

      const estados = [uno.status, dos.status].sort();
      assert.deepEqual(estados, [201, 409], `se esperaba una creada y una en conflicto: ${JSON.stringify(estados)}`);

      const activas = await queryOne<{ total: number }>(
        `SELECT COUNT(*) AS total FROM booking_seats bs JOIN bookings bk ON bk.id = bs.booking_id
         WHERE bs.seat_id = ? AND bk.status IN ('PENDING','CONFIRMED','COMPLETED')`,
        [asiento],
      );
      assert.equal(Number(activas?.total), 1);
    });

    it('19 · diez compras simultáneas con precios configurados no producen interbloqueos', async () => {
      await setSeatTypePrice(ctx.fixtures.tripA, tipoCama, 70);
      await setSeatTypePrice(ctx.fixtures.tripA, tipoMujer, 55);
      const libres = await freeSeats(ctx.fixtures.tripA);
      assert.ok(libres.length >= 10, 'el bus de pruebas debe tener asientos suficientes');

      const resultados = await Promise.all(
        Array.from({ length: 10 }, (_, indice) => reservar([at(libres, indice).id])),
      );

      const fallos = resultados.filter((res) => res.status !== 201);
      assert.equal(fallos.length, 0, `ninguna debería fallar: ${JSON.stringify(fallos.map((r) => r.body))}`);

      const duplicados = await query(
        `SELECT bs.seat_id FROM booking_seats bs JOIN bookings bk ON bk.id = bs.booking_id
         WHERE bk.status IN ('PENDING','CONFIRMED','COMPLETED')
         GROUP BY bs.trip_id, bs.seat_id HAVING COUNT(*) > 1`,
      );
      assert.deepEqual(duplicados, [], 'ningún asiento puede quedar vendido dos veces');
    });

    it('20 · el mapa público muestra el mismo precio que después se cobra', async () => {
      await setSeatTypePrice(ctx.fixtures.tripA, tipoMujer, 80);
      const tipos = await asientosPorTipo();
      const asiento = at(tipos.mujer, 0);

      const mapa = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);
      const enElMapa = mapa.body.data.find((entrada: { id: number }) => entrada.id === asiento);
      assert.ok(enElMapa, 'el asiento debe estar en el mapa');

      const res = await reservar([asiento]);
      const cobrado = await queryOne<{ price: string }>('SELECT price FROM booking_seats WHERE booking_id = ?', [res.body.data.id]);

      assert.equal(Number(enElMapa.price), 80);
      assert.equal(Number(cobrado?.price), Number(enElMapa.price), 'lo mostrado y lo cobrado deben coincidir');
    });
  });
});
