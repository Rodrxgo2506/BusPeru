import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { get, post, put } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, createBusLayout, freeSeats, syncLayoutSeatCount } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * H-01 · un viaje con ventas ya no cambia de bus.
 *
 * LO QUE PASABA. `PUT /trips/:id` con otro `bus_id` reanclaba `bus_layout_id` sin mirar si
 * el viaje tenía reservas. Las filas de `booking_seats` seguían apuntando a asientos de la
 * distribución anterior, que ya no era la del viaje: el asiento vendido desaparecía del
 * mapa, el viaje volvía a figurar entero libre y `available_seats` conservaba el número del
 * bus viejo, de modo que un bus más pequeño se podía sobrevender. Se reprodujo en la
 * auditoría antes de tocar nada.
 *
 * LO QUE SE PRUEBA AQUÍ. Que con ventas no cambia NADA —ni el bus, ni la versión, ni las
 * ventas, ni los asientos, ni el pago—, que sin ventas el cambio sigue funcionando y además
 * recalcula la disponibilidad, y que reenviar el MISMO bus no cuenta como cambio.
 */
describe('H-01 · el bus de un viaje con ventas no se cambia', () => {
  let ctx: SuiteContext;
  /** Segundo bus de la MISMA empresa, para que el caso realista no dependa del ADMIN. */
  let busA2 = 0;
  let layoutA2 = 0;
  let asientosA2 = 0;

  before(async () => {
    ctx = await prepareSuite();

    const creado = await execute(
      `INSERT INTO buses (company_id, code, plate_number, brand, model, year, capacity, status)
       VALUES (?, 'A-H01', 'H01-001', 'Marca', 'Modelo', 2024, 0, 'ACTIVE')`,
      [ctx.fixtures.companyA],
    );
    busA2 = creado.insertId;
    const layout = await createBusLayout(busA2, { rows: 2, columns: 3 });
    layoutA2 = layout.layoutId;

    // Seis asientos en dos filas de tres: a proposito NO son doce, para que el recalculo de
    // `available_seats` se note.
    for (let indice = 1; indice <= 6; indice += 1) {
      await execute(
        `INSERT INTO seats (bus_id, layout_id, deck_id, seat_type_id, seat_number, row_number, column_number, is_window, is_aisle, status)
         VALUES (?, ?, ?, NULL, ?, ?, ?, 0, 0, 'AVAILABLE')`,
        [busA2, layoutA2, at(layout.deckIds, 0), String(indice).padStart(2, '0'), Math.ceil(indice / 3), ((indice - 1) % 3) + 1],
      );
    }
    await syncLayoutSeatCount(layoutA2);
    await execute('UPDATE buses SET capacity = 6 WHERE id = ?', [busA2]);
    asientosA2 = Number(
      (await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM seats WHERE layout_id = ?', [layoutA2]))?.n ?? 0,
    );
    assert.equal(asientosA2, 6);
  });
  after(teardownSuite);

  /** Devuelve el viaje de los fixtures a su bus y su versión originales. */
  beforeEach(async () => {
    await execute('DELETE FROM booking_seats WHERE trip_id = ?', [ctx.fixtures.tripA]);
    await execute('DELETE FROM payments WHERE booking_id IN (SELECT id FROM bookings WHERE trip_id = ?)', [ctx.fixtures.tripA]);
    await execute('DELETE FROM bookings WHERE trip_id = ?', [ctx.fixtures.tripA]);
    await execute('UPDATE trips SET bus_id = ?, bus_layout_id = ?, available_seats = 12 WHERE id = ?', [
      ctx.fixtures.busA,
      ctx.fixtures.layoutA,
      ctx.fixtures.tripA,
    ]);
  });

  const viaje = () =>
    queryOne<{ bus_id: number; bus_layout_id: number | null; available_seats: number }>(
      'SELECT bus_id, bus_layout_id, available_seats FROM trips WHERE id = ?',
      [ctx.fixtures.tripA],
    );

  /** Una compra real del cliente sobre el viaje de los fixtures, pagada. */
  async function vender(): Promise<{ bookingId: number; seatId: number }> {
    const libres = await freeSeats(ctx.fixtures.tripA);
    const asiento = at(libres, 0);
    const reserva = await post(
      '/bookings',
      { trip_id: ctx.fixtures.tripA, seat_ids: [asiento.id], passenger_email: 'cliente@test.pe' },
      ctx.sessions.customer.token,
    );
    assert.equal(reserva.status, 201, JSON.stringify(reserva.body));
    const pago = await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);
    assert.equal(pago.status, 200, JSON.stringify(pago.body));
    return { bookingId: Number(reserva.body.data.id), seatId: asiento.id };
  }

  describe('Sin ventas el cambio sigue funcionando', () => {
    it('1 · cambiar de bus está permitido', async () => {
      const res = await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(Number((await viaje())?.bus_id), busA2);
    });

    it('2 · `bus_layout_id` pasa a la versión publicada del bus nuevo', async () => {
      await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.companyAdmin.token);
      assert.equal(Number((await viaje())?.bus_layout_id), layoutA2);
    });

    it('3 · `available_seats` se recalcula con la capacidad de la versión nueva', async () => {
      const antes = await viaje();
      assert.notEqual(Number(antes?.available_seats), asientosA2, 'si ya coincidiera, la prueba no probaría nada');

      await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.companyAdmin.token);
      assert.equal(Number((await viaje())?.available_seats), asientosA2);
    });

    it('4 · el mapa del viaje pasa a ser el del bus nuevo', async () => {
      await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.companyAdmin.token);
      const mapa = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);
      assert.equal(mapa.body.data.length, asientosA2);
    });
  });

  describe('Con ventas no cambia nada', () => {
    it('5 · el cambio se rechaza con un error de negocio', async () => {
      await vender();
      const res = await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /reservas/i, 'el mensaje explica por qué');
      assert.equal(res.body.success, false);
    });

    it('6 · el mensaje es legible y no filtra nada de SQL', async () => {
      await vender();
      const res = await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.companyAdmin.token);

      const texto = JSON.stringify(res.body);
      for (const rastro of ['ER_', 'SELECT', 'UPDATE', 'sqlMessage', 'booking_seats', 'Error:']) {
        assert.equal(texto.includes(rastro), false, `no debe asomar ${rastro}`);
      }
    });

    it('7 · el bus del viaje no cambia', async () => {
      await vender();
      await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.companyAdmin.token);
      assert.equal(Number((await viaje())?.bus_id), ctx.fixtures.busA);
    });

    it('8 · la versión del viaje no cambia', async () => {
      await vender();
      await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.companyAdmin.token);
      assert.equal(Number((await viaje())?.bus_layout_id), ctx.fixtures.layoutA);
    });

    it('9 · `available_seats` tampoco se toca', async () => {
      await vender();
      const antes = Number((await viaje())?.available_seats);
      await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.companyAdmin.token);
      assert.equal(Number((await viaje())?.available_seats), antes);
    });

    it('10 · la venta, su asiento y su pago quedan intactos', async () => {
      const { bookingId, seatId } = await vender();
      const antesReserva = await queryOne<Record<string, unknown>>('SELECT * FROM bookings WHERE id = ?', [bookingId]);
      const antesPago = await queryOne<Record<string, unknown>>('SELECT * FROM payments WHERE booking_id = ?', [bookingId]);

      await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.companyAdmin.token);

      const fila = await queryOne<{ seat_id: number; trip_id: number; price: string }>(
        'SELECT seat_id, trip_id, price FROM booking_seats WHERE booking_id = ?',
        [bookingId],
      );
      assert.equal(Number(fila?.seat_id), seatId, 'la fila de venta sigue en su asiento');
      assert.deepEqual(await queryOne('SELECT * FROM bookings WHERE id = ?', [bookingId]), antesReserva);
      assert.deepEqual(await queryOne('SELECT * FROM payments WHERE booking_id = ?', [bookingId]), antesPago);

      const asiento = await queryOne<{ id: number; layout_id: number }>('SELECT id, layout_id FROM seats WHERE id = ?', [seatId]);
      assert.equal(Number(asiento?.layout_id), ctx.fixtures.layoutA, 'y el asiento sigue en la versión del viaje');
    });

    it('11 · el asiento vendido sigue apareciendo ocupado en el mapa', async () => {
      const { seatId } = await vender();
      await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.companyAdmin.token);

      const mapa = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);
      const vendido = (mapa.body.data as Array<{ id: number; is_taken: number }>).find((s) => s.id === seatId);
      assert.ok(vendido, 'el asiento no puede desaparecer del mapa');
      assert.equal(vendido.is_taken, 1);
    });

    it('12 · ninguna fila de venta queda apuntando a una versión ajena al viaje', async () => {
      await vender();
      await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.companyAdmin.token);

      const huerfanas = await queryOne<{ total: number }>(
        `SELECT COUNT(*) AS total FROM booking_seats bs
         JOIN trips t ON t.id = bs.trip_id
         JOIN seats s ON s.id = bs.seat_id
         WHERE t.id = ? AND s.layout_id <> t.bus_layout_id`,
        [ctx.fixtures.tripA],
      );
      assert.equal(Number(huerfanas?.total ?? 0), 0);
    });

    it('13 · una reserva CANCELADA también protege: su fila es histórico igual', async () => {
      const { bookingId } = await vender();
      await execute("UPDATE bookings SET status = 'CANCELLED' WHERE id = ?", [bookingId]);

      const res = await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 400, 'la fila de `booking_seats` sigue ahí y sigue apuntando a la versión de hoy');
      assert.equal(Number((await viaje())?.bus_id), ctx.fixtures.busA);
    });

    it('14 · una reserva CADUCADA protege igual', async () => {
      const { bookingId } = await vender();
      await execute("UPDATE bookings SET status = 'EXPIRED' WHERE id = ?", [bookingId]);

      assert.equal((await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.companyAdmin.token)).status, 400);
    });
  });

  describe('Reenviar el mismo bus no es cambiar de bus', () => {
    it('15 · con ventas, mandar su propio `bus_id` no se rechaza', async () => {
      await vender();
      const res = await put(
        `/trips/${ctx.fixtures.tripA}`,
        { bus_id: ctx.fixtures.busA, base_price: 61 },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(Number((await viaje())?.bus_id), ctx.fixtures.busA);
    });

    it('16 · y NO reancla la versión a la publicada de hoy', async () => {
      // La segunda puerta al mismo destrozo: el bus publica una version nueva y el viaje,
      // con ventas, saltaba a ella solo por reenviar su propio `bus_id`.
      const { seatId } = await vender();
      const nueva = await createBusLayout(ctx.fixtures.busA, { version: 7, status: 'DRAFT', rows: 2, columns: 2 });
      await execute("UPDATE bus_layouts SET status = 'ARCHIVED' WHERE id = ?", [ctx.fixtures.layoutA]);
      await execute("UPDATE bus_layouts SET status = 'PUBLISHED', published_at = NOW() WHERE id = ?", [nueva.layoutId]);

      const res = await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: ctx.fixtures.busA }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200);
      assert.equal(Number((await viaje())?.bus_layout_id), ctx.fixtures.layoutA, 'sigue en la versión que vendió');

      const mapa = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);
      const vendido = (mapa.body.data as Array<{ id: number; is_taken: number }>).find((s) => s.id === seatId);
      assert.ok(vendido && vendido.is_taken === 1, 'y el asiento vendido sigue vendido');

      // Se deja el bus como estaba para no arrastrar la version 7 a las pruebas siguientes.
      await execute('UPDATE trips SET bus_layout_id = ? WHERE bus_layout_id = ?', [ctx.fixtures.layoutA, nueva.layoutId]);
      await execute('DELETE FROM seats WHERE layout_id = ?', [nueva.layoutId]);
      await execute('DELETE FROM bus_layouts WHERE id = ?', [nueva.layoutId]);
      await execute("UPDATE bus_layouts SET status = 'PUBLISHED' WHERE id = ?", [ctx.fixtures.layoutA]);
    });
  });

  describe('El resto del contrato de PUT /trips/:id no cambia', () => {
    it('17 · con ventas, los demás campos se siguen pudiendo editar', async () => {
      await vender();
      const res = await put(
        `/trips/${ctx.fixtures.tripA}`,
        { base_price: 77.5, boarding_notes: 'Puerta 3' },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const fila = await queryOne<{ base_price: string; boarding_notes: string }>(
        'SELECT base_price, boarding_notes FROM trips WHERE id = ?',
        [ctx.fixtures.tripA],
      );
      assert.equal(Number(fila?.base_price), 77.5);
      assert.equal(fila?.boarding_notes, 'Puerta 3');
    });

    it('18 · `bus_layout_id` sigue sin ser escribible desde el cliente', async () => {
      const res = await put(
        `/trips/${ctx.fixtures.tripA}`,
        { bus_layout_id: layoutA2, base_price: 48 },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(res.status, 200);
      assert.equal(Number((await viaje())?.bus_layout_id), ctx.fixtures.layoutA, 'el campo inyectado se ignora');
    });

    it('19 · con ventas, inyectar `bus_layout_id` tampoco cuela', async () => {
      await vender();
      await put(`/trips/${ctx.fixtures.tripA}`, { bus_layout_id: layoutA2, base_price: 49 }, ctx.sessions.companyAdmin.token);
      assert.equal(Number((await viaje())?.bus_layout_id), ctx.fixtures.layoutA);
    });

    it('20 · un bus sin distribución publicada se sigue rechazando', async () => {
      const creado = await execute(
        `INSERT INTO buses (company_id, code, plate_number, brand, model, year, capacity, status)
         VALUES (?, 'A-H01B', 'H01-002', 'Marca', 'Modelo', 2024, 10, 'ACTIVE')`,
        [ctx.fixtures.companyA],
      );

      const res = await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: creado.insertId }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /distribución/i);
      assert.equal(Number((await viaje())?.bus_id), ctx.fixtures.busA, 'y el viaje no se queda a medias');

      await execute('DELETE FROM buses WHERE id = ?', [creado.insertId]);
    });

    it('21 · el viaje inexistente y el cuerpo vacío responden como siempre', async () => {
      assert.equal((await put('/trips/99999999', { base_price: 50 }, ctx.sessions.admin.token)).status, 404);
      // 422 lo pone el validador de esquema, antes de llegar a la ruta. No se ha tocado.
      assert.equal((await put(`/trips/${ctx.fixtures.tripA}`, {}, ctx.sessions.companyAdmin.token)).status, 422);
    });
  });

  describe('Permisos y aislamiento', () => {
    it('22 · la empresa A no toca el viaje de la empresa B', async () => {
      const res = await put(`/trips/${ctx.fixtures.tripB}`, { bus_id: busA2 }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 404, 'ni siquiera se confirma que exista');

      const otro = await queryOne<{ bus_id: number }>('SELECT bus_id FROM trips WHERE id = ?', [ctx.fixtures.tripB]);
      assert.equal(Number(otro?.bus_id), ctx.fixtures.busB);
    });

    it('23 · el ADMIN cambia el bus de cualquier empresa, pero tampoco con ventas', async () => {
      const sinVentas = await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.admin.token);
      assert.equal(sinVentas.status, 200);
      assert.equal(Number((await viaje())?.bus_layout_id), layoutA2);

      await execute('UPDATE trips SET bus_id = ?, bus_layout_id = ? WHERE id = ?', [
        ctx.fixtures.busA,
        ctx.fixtures.layoutA,
        ctx.fixtures.tripA,
      ]);
      await vender();
      assert.equal((await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.admin.token)).status, 400);
    });

    it('24 · el OPERATOR conserva exactamente los permisos que tenía', async () => {
      // El OPERATOR ya tenía `trips.update` antes de esta corrección —no así `buses.update`—,
      // así que sigue pudiendo editar un viaje. Lo que cambia para él es lo mismo que para
      // todos: con ventas, el bus no se mueve. No se ha tocado ningún permiso.
      assert.equal((await get(`/trips/${ctx.fixtures.tripA}`, ctx.sessions.operator.token)).status, 200);

      const sinVentas = await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.operator.token);
      assert.equal(sinVentas.status, 200, JSON.stringify(sinVentas.body));

      await execute('UPDATE trips SET bus_id = ?, bus_layout_id = ? WHERE id = ?', [
        ctx.fixtures.busA,
        ctx.fixtures.layoutA,
        ctx.fixtures.tripA,
      ]);
      await vender();
      const conVentas = await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.operator.token);
      assert.equal(conVentas.status, 400);
      assert.equal(Number((await viaje())?.bus_id), ctx.fixtures.busA);
    });

    it('25 · un CUSTOMER no edita viajes', async () => {
      assert.equal((await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.customer.token)).status, 403);
    });
  });

  describe('Concurrencia', () => {
    it('26 · cambiar el bus y comprar a la vez no deja el viaje a medias', async () => {
      // Las dos operaciones compiten por la misma fila de `trips`, que ambas bloquean la
      // primera. O gana el cambio y la compra ocurre sobre el bus nuevo, o gana la compra y
      // el cambio se rechaza. Lo que NO puede pasar es que salgan las dos.
      const libres = await freeSeats(ctx.fixtures.tripA);
      const asiento = at(libres, 0);

      const [cambio, compra] = await Promise.all([
        put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.companyAdmin.token),
        post(
          '/bookings',
          { trip_id: ctx.fixtures.tripA, seat_ids: [asiento.id], passenger_email: 'cliente@test.pe' },
          ctx.sessions.customer.token,
        ),
      ]);

      const estado = await viaje();
      const huerfanas = Number(
        (
          await queryOne<{ total: number }>(
            `SELECT COUNT(*) AS total FROM booking_seats bs
             JOIN trips t ON t.id = bs.trip_id
             JOIN seats s ON s.id = bs.seat_id
             WHERE t.id = ? AND s.layout_id <> t.bus_layout_id`,
            [ctx.fixtures.tripA],
          )
        )?.total ?? 0,
      );

      assert.equal(huerfanas, 0, 'salga como salga, ninguna venta puede quedar en otra versión');
      if (cambio.status === 200) {
        assert.equal(Number(estado?.bus_id), busA2);
        assert.equal(Number(estado?.bus_layout_id), layoutA2);
      } else {
        assert.equal(cambio.status, 400);
        assert.equal(Number(estado?.bus_id), ctx.fixtures.busA);
        assert.equal(Number(estado?.bus_layout_id), ctx.fixtures.layoutA);
      }
      assert.ok([201, 400, 409].includes(compra.status), `estado inesperado de la compra: ${compra.status}`);
    });

    it('27 · diez cambios simultáneos sobre el mismo viaje no lo descuadran', async () => {
      const intentos = await Promise.all(
        Array.from({ length: 10 }, () => put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.companyAdmin.token)),
      );
      assert.equal(intentos.filter((res) => res.status >= 500).length, 0, 'ninguno revienta');

      const estado = await viaje();
      assert.equal(Number(estado?.bus_id), busA2);
      assert.equal(Number(estado?.bus_layout_id), layoutA2);
      assert.equal(Number(estado?.available_seats), asientosA2);
    });
  });

  describe('El caso que se reprodujo en la auditoría, entero', () => {
    it('28 · bus A + versión A + asiento vendido: el cambio a B no mueve una sola fila', async () => {
      const { bookingId, seatId } = await vender();

      const antes = {
        viaje: await queryOne('SELECT * FROM trips WHERE id = ?', [ctx.fixtures.tripA]),
        reserva: await queryOne('SELECT * FROM bookings WHERE id = ?', [bookingId]),
        venta: await queryOne('SELECT * FROM booking_seats WHERE booking_id = ?', [bookingId]),
        pago: await queryOne('SELECT * FROM payments WHERE booking_id = ?', [bookingId]),
        asiento: await queryOne('SELECT * FROM seats WHERE id = ?', [seatId]),
        asientos: await query('SELECT id, layout_id, deck_id, seat_number FROM seats WHERE layout_id = ? ORDER BY id', [
          ctx.fixtures.layoutA,
        ]),
      };

      const res = await put(`/trips/${ctx.fixtures.tripA}`, { bus_id: busA2 }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 400);

      assert.deepEqual(await queryOne('SELECT * FROM trips WHERE id = ?', [ctx.fixtures.tripA]), antes.viaje);
      assert.deepEqual(await queryOne('SELECT * FROM bookings WHERE id = ?', [bookingId]), antes.reserva);
      assert.deepEqual(await queryOne('SELECT * FROM booking_seats WHERE booking_id = ?', [bookingId]), antes.venta);
      assert.deepEqual(await queryOne('SELECT * FROM payments WHERE booking_id = ?', [bookingId]), antes.pago);
      assert.deepEqual(await queryOne('SELECT * FROM seats WHERE id = ?', [seatId]), antes.asiento);
      assert.deepEqual(
        await query('SELECT id, layout_id, deck_id, seat_number FROM seats WHERE layout_id = ? ORDER BY id', [ctx.fixtures.layoutA]),
        antes.asientos,
      );
    });
  });
});
