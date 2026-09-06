import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { get, post } from './helpers/api';
import { execute, queryOne } from '../config/database';
import { freeSeats, at } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

describe('Reservas y bloqueo de asientos', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  it('la búsqueda pública solo devuelve viajes futuros con disponibilidad calculada', async () => {
    const res = await get('/public/trips?origin=Lima&limit=50');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.length > 0);
    for (const trip of res.body.data) {
      assert.ok(new Date(trip.departure_datetime.replace(' ', 'T')) > new Date());
      assert.equal(typeof trip.seats_available, 'number');
    }
  });

  it('calcula los importes en el servidor a partir de system_settings', async () => {
    const seats = await freeSeats(ctx.fixtures.tripA);
    const res = await post('/bookings', {
      trip_id: ctx.fixtures.tripA,
      seat_ids: [at(seats, 0).id, at(seats, 1).id],
      passenger_name: 'Clara Prueba',
      passenger_email: 'cliente@test.pe',
    }, ctx.sessions.customer.token);

    assert.equal(res.status, 201);
    const booking = res.body.data;
    assert.equal(Number(booking.subtotal), 90, '45 x 2 asientos');
    assert.equal(Number(booking.service_fee), 5, '2.50 x 2 pasajeros');
    assert.equal(Number(booking.total_amount), 95);
    assert.equal(booking.status, 'PENDING');
    assert.ok(booking.expires_at, 'debe fijar la retención temporal');
    assert.match(booking.booking_code, /^BP-\d{6}$/);
    assert.equal(booking.seat_numbers.split(',').length, 2);
  });

  it('retiene los asientos aunque la reserva no esté pagada', async () => {
    const seats = await freeSeats(ctx.fixtures.tripA);
    const objetivo = at(seats, 0).id;
    await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [objetivo], passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token);

    const mapa = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);
    const asiento = mapa.body.data.find((s: { id: number }) => s.id === objetivo);
    assert.equal(asiento.is_taken, 1);
  });

  it('rechaza un asiento ya retenido', async () => {
    const seats = await freeSeats(ctx.fixtures.tripA);
    const objetivo = at(seats, 0).id;
    await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [objetivo], passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token);

    const duplicada = await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [objetivo], passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token);
    assert.equal(duplicada.status, 409);
  });

  it('bajo concurrencia solo una reserva simultánea gana el asiento', async () => {
    const seats = await freeSeats(ctx.fixtures.tripA);
    const objetivo = at(seats, 0).id;

    const intentos = await Promise.all(
      Array.from({ length: 5 }).map(() =>
        post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [objetivo], passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token),
      ),
    );

    const creadas = intentos.filter((r) => r.status === 201);
    const rechazadas = intentos.filter((r) => r.status === 409);
    assert.equal(creadas.length, 1, `esperada 1 reserva creada, hubo ${creadas.length}`);
    assert.equal(rechazadas.length, 4, `esperados 4 conflictos, hubo ${rechazadas.length}`);

    const fila = await queryOne<{ total: number }>(
      "SELECT COUNT(*) AS total FROM booking_seats bs JOIN bookings bk ON bk.id = bs.booking_id WHERE bs.seat_id = ? AND bk.status <> 'CANCELLED'",
      [objetivo],
    );
    assert.equal(Number(fila?.total), 1, 'en la base debe existir una única retención del asiento');
  });

  it('valida el viaje, los asientos y el máximo por reserva', async () => {
    const token = ctx.sessions.customer.token;
    const seats = await freeSeats(ctx.fixtures.tripA);

    assert.equal((await post('/bookings', { trip_id: 999999, seat_ids: [at(seats, 0).id] }, token)).status, 404);
    assert.equal((await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [999999] }, token)).status, 400);
    // Un asiento del bus de la otra empresa no pertenece a este viaje.
    assert.equal((await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [at(ctx.fixtures.seatsB, 0)] }, token)).status, 400);
    assert.equal((await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [] }, token)).status, 422);

    const demasiados = seats.slice(0, 7).map((s) => s.id);
    if (demasiados.length === 7) {
      assert.ok([400, 422].includes((await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: demasiados }, token)).status));
    }
  });

  it('libera los asientos al cancelar y restaura la disponibilidad', async () => {
    const seats = await freeSeats(ctx.fixtures.tripA);
    const ids = [at(seats, 0).id, at(seats, 1).id];
    const antes = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);

    const reserva = await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: ids, passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token);
    const tras = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
    assert.equal(Number(tras?.available_seats), Number(antes?.available_seats) - 2);

    const cancelada = await post(`/bookings/${reserva.body.data.id}/cancel`, { reason: 'prueba' }, ctx.sessions.customer.token);
    assert.equal(cancelada.status, 200);
    assert.equal(cancelada.body.data.status, 'CANCELLED');

    const mapa = await get(`/public/trips/${ctx.fixtures.tripA}/seats`);
    for (const id of ids) {
      assert.equal(mapa.body.data.find((s: { id: number }) => s.id === id).is_taken, 0);
    }
    const final = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
    assert.equal(Number(final?.available_seats), Number(antes?.available_seats));
  });

  it('no permite cancelar dos veces la misma reserva', async () => {
    const seats = await freeSeats(ctx.fixtures.tripA);
    const reserva = await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id], passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token);
    await post(`/bookings/${reserva.body.data.id}/cancel`, {}, ctx.sessions.customer.token);
    const segunda = await post(`/bookings/${reserva.body.data.id}/cancel`, {}, ctx.sessions.customer.token);
    assert.equal(segunda.status, 400);
  });

  it('el manifiesto de pasajeros refleja las reservas vigentes', async () => {
    const seats = await freeSeats(ctx.fixtures.tripA);
    const reserva = await post('/bookings', {
      trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id],
      passenger_name: 'Pasajero Manifiesto', passenger_document: 'DNI 12345678', passenger_email: 'cliente@test.pe',
    }, ctx.sessions.customer.token);
    await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'CASH' }, ctx.sessions.customer.token);

    const manifiesto = await get(`/trips/${ctx.fixtures.tripA}/passengers`, ctx.sessions.companyAdmin.token);
    assert.equal(manifiesto.status, 200);
    const fila = manifiesto.body.data.find((p: { booking_code: string }) => p.booking_code === reserva.body.data.booking_code);
    assert.ok(fila, 'el pasajero debe aparecer en el manifiesto');
    assert.equal(fila.passenger_name, 'Pasajero Manifiesto');
    assert.ok(fila.seat_number);
  });

  /**
   * BP-07 · regresión de la auditoría del 06/09/2026.
   *
   * Suspender una empresa o desactivar una ruta la retiraba de la búsqueda, pero el viaje
   * seguía siendo accesible por su id y se podía comprar: la ocultación en el buscador era
   * la única protección. Se comprueba en los dos puntos —consulta pública y creación de la
   * reserva— y con los tres estados que retiran a una empresa o una ruta de la venta.
   */
  describe('BP-07 · no se vende un viaje de empresa o ruta dada de baja', () => {
    /** Deja el escenario como estaba, pase lo que pase en el test. */
    async function conEstado(
      cambio: { empresa?: string; ruta?: string },
      comprobacion: () => Promise<void>,
    ): Promise<void> {
      if (cambio.empresa) await execute('UPDATE companies SET status = ? WHERE id = ?', [cambio.empresa, ctx.fixtures.companyB]);
      if (cambio.ruta) await execute('UPDATE routes SET status = ? WHERE id = ?', [cambio.ruta, ctx.fixtures.routeB]);
      try {
        await comprobacion();
      } finally {
        await execute("UPDATE companies SET status = 'ACTIVE' WHERE id = ?", [ctx.fixtures.companyB]);
        await execute("UPDATE routes SET status = 'ACTIVE' WHERE id = ?", [ctx.fixtures.routeB]);
      }
    }

    async function intentaReservar() {
      const seats = await freeSeats(ctx.fixtures.tripB);
      return post(
        '/bookings',
        { trip_id: ctx.fixtures.tripB, seat_ids: [at(seats, 0).id] },
        ctx.sessions.customer.token,
      );
    }

    it('con empresa y ruta ACTIVE el viaje se consulta y se reserva con normalidad', async () => {
      assert.equal((await get(`/public/trips/${ctx.fixtures.tripB}`)).status, 200);
      assert.equal((await get(`/public/trips/${ctx.fixtures.tripB}/seats`)).status, 200);

      const reserva = await intentaReservar();
      assert.equal(reserva.status, 201, 'el caso legítimo no debe verse afectado');
    });

    it('empresa SUSPENDED: ni ficha pública, ni mapa de asientos, ni reserva', async () => {
      await conEstado({ empresa: 'SUSPENDED' }, async () => {
        assert.equal((await get(`/public/trips/${ctx.fixtures.tripB}`)).status, 404);
        assert.equal((await get(`/public/trips/${ctx.fixtures.tripB}/seats`)).status, 404);
        assert.equal((await intentaReservar()).status, 400);
      });
    });

    it('empresa INACTIVE: mismo cierre', async () => {
      await conEstado({ empresa: 'INACTIVE' }, async () => {
        assert.equal((await get(`/public/trips/${ctx.fixtures.tripB}`)).status, 404);
        assert.equal((await intentaReservar()).status, 400);
      });
    });

    it('ruta INACTIVE: mismo cierre aunque la empresa siga activa', async () => {
      await conEstado({ ruta: 'INACTIVE' }, async () => {
        assert.equal((await get(`/public/trips/${ctx.fixtures.tripB}`)).status, 404);
        assert.equal((await intentaReservar()).status, 400);
      });
    });

    it('entrar por el id del viaje tampoco sirve: ocultarlo en la búsqueda no era la única defensa', async () => {
      await conEstado({ empresa: 'SUSPENDED' }, async () => {
        const busqueda = await get('/public/trips?origin=Lima&destination=Huaraz');
        assert.equal(busqueda.body.data.length, 0, 'la búsqueda ya lo ocultaba antes de la corrección');

        const directa = await intentaReservar();
        assert.equal(directa.status, 400, 'y ahora la compra directa por id también se rechaza');
      });
    });

    it('el rechazo ocurre antes de crear reserva, asientos y pago', async () => {
      const antes = await queryOne<{ reservas: number; asientos: number; pagos: number }>(
        `SELECT (SELECT COUNT(*) FROM bookings WHERE trip_id = ?) AS reservas,
                (SELECT COUNT(*) FROM booking_seats WHERE trip_id = ?) AS asientos,
                (SELECT COUNT(*) FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE b.trip_id = ?) AS pagos`,
        [ctx.fixtures.tripB, ctx.fixtures.tripB, ctx.fixtures.tripB],
      );

      await conEstado({ empresa: 'SUSPENDED' }, async () => {
        const seats = await freeSeats(ctx.fixtures.tripB);
        const res = await post(
          '/bookings',
          { trip_id: ctx.fixtures.tripB, seat_ids: [at(seats, 0).id], payment_method: 'CARD' },
          ctx.sessions.customer.token,
        );
        assert.equal(res.status, 400);
      });

      const despues = await queryOne<{ reservas: number; asientos: number; pagos: number }>(
        `SELECT (SELECT COUNT(*) FROM bookings WHERE trip_id = ?) AS reservas,
                (SELECT COUNT(*) FROM booking_seats WHERE trip_id = ?) AS asientos,
                (SELECT COUNT(*) FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE b.trip_id = ?) AS pagos`,
        [ctx.fixtures.tripB, ctx.fixtures.tripB, ctx.fixtures.tripB],
      );

      assert.deepEqual(despues, antes, 'no debe quedar ninguna fila a medias');
    });

    it('la disponibilidad del viaje no se toca en un intento rechazado', async () => {
      const antes = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripB]);

      await conEstado({ ruta: 'INACTIVE' }, async () => {
        assert.equal((await intentaReservar()).status, 400);
      });

      const despues = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripB]);
      assert.equal(despues?.available_seats, antes?.available_seats);
    });

    it('restablecer la empresa devuelve el viaje a la venta', async () => {
      const publica = await get(`/public/trips/${ctx.fixtures.tripB}`);
      assert.equal(publica.status, 200, 'la corrección no deja el viaje inaccesible de forma permanente');
      assert.equal((await intentaReservar()).status, 201);
    });
  });

  /**
   * BP-09 · regresión de la auditoría del 06/09/2026.
   *
   * `cancelBooking` rechazaba CANCELLED y COMPLETED pero no EXPIRED. La expiración ya había
   * devuelto los cupos, así que cancelar después la misma reserva los sumaba por segunda vez
   * y `trips.available_seats` se separaba de la disponibilidad real (10 → 11 → 12, cuando lo
   * correcto era 11). El tope por capacidad ocultaba el problema solo en viajes llenos.
   */
  describe('BP-09 · una reserva vencida ya no vuelve a liberar asientos', () => {
    /** Reserva pendiente del cliente, vencida y pasada por la expiración real. */
    async function reservaVencida() {
      const seats = await freeSeats(ctx.fixtures.tripA);
      const reserva = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id], payment_method: 'CARD' },
        ctx.sessions.customer.token,
      );
      assert.equal(reserva.status, 201);

      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [reserva.body.data.id]);
      const expiracion = await post('/bookings/expire', {}, ctx.sessions.admin.token);
      assert.equal(expiracion.status, 200);

      return reserva.body.data;
    }

    /** Disponibilidad real derivada de los asientos que siguen reteniendo cupo. */
    async function disponibilidadReal(tripId: number): Promise<number> {
      const fila = await queryOne<{ libres: number }>(
        `SELECT b.capacity - (
           SELECT COUNT(*) FROM booking_seats bs JOIN bookings bk ON bk.id = bs.booking_id
           WHERE bs.trip_id = t.id
             AND (bk.status IN ('CONFIRMED','COMPLETED')
                  OR (bk.status = 'PENDING' AND (bk.expires_at IS NULL OR bk.expires_at > NOW())))
         ) AS libres
         FROM trips t JOIN buses b ON b.id = t.bus_id WHERE t.id = ?`,
        [tripId],
      );
      return Number(fila?.libres);
    }

    it('la expiración libera los asientos una sola vez', async () => {
      const reserva = await reservaVencida();

      const fila = await queryOne<{ status: string; available_seats: number }>(
        'SELECT bk.status, t.available_seats FROM bookings bk JOIN trips t ON t.id = bk.trip_id WHERE bk.id = ?',
        [reserva.id],
      );
      assert.equal(fila?.status, 'EXPIRED');
      assert.equal(Number(fila?.available_seats), await disponibilidadReal(ctx.fixtures.tripA), 'la expiración deja la cuenta cuadrada');
    });

    it('cancelar una reserva EXPIRED se rechaza y no toca nada', async () => {
      const reserva = await reservaVencida();

      const antes = await queryOne<{ available_seats: number; asientos: number; refunds: number; movimientos: number }>(
        `SELECT (SELECT available_seats FROM trips WHERE id = ?) AS available_seats,
                (SELECT COUNT(*) FROM booking_seats WHERE booking_id = ?) AS asientos,
                (SELECT COUNT(*) FROM refunds WHERE booking_id = ?) AS refunds,
                (SELECT COUNT(*) FROM financial_transactions WHERE booking_id = ?) AS movimientos`,
        [ctx.fixtures.tripA, reserva.id, reserva.id, reserva.id],
      );

      const cancelacion = await post(
        `/bookings/${reserva.id}/cancel`,
        { reason: 'intento tardío', request_refund: true },
        ctx.sessions.customer.token,
      );
      assert.equal(cancelacion.status, 400);

      const despues = await queryOne<{ available_seats: number; asientos: number; refunds: number; movimientos: number }>(
        `SELECT (SELECT available_seats FROM trips WHERE id = ?) AS available_seats,
                (SELECT COUNT(*) FROM booking_seats WHERE booking_id = ?) AS asientos,
                (SELECT COUNT(*) FROM refunds WHERE booking_id = ?) AS refunds,
                (SELECT COUNT(*) FROM financial_transactions WHERE booking_id = ?) AS movimientos`,
        [ctx.fixtures.tripA, reserva.id, reserva.id, reserva.id],
      );

      assert.deepEqual(despues, antes, 'ni asientos, ni reembolso, ni movimiento financiero');
      assert.equal(
        Number(despues?.available_seats),
        await disponibilidadReal(ctx.fixtures.tripA),
        'la disponibilidad sigue coincidiendo con la real: no hay doble abono',
      );
    });

    it('la reserva sigue EXPIRED, no pasa a CANCELLED', async () => {
      const reserva = await reservaVencida();
      await post(`/bookings/${reserva.id}/cancel`, {}, ctx.sessions.customer.token);

      const fila = await queryOne<{ status: string; cancelled_at: string | null }>(
        'SELECT status, cancelled_at FROM bookings WHERE id = ?',
        [reserva.id],
      );
      assert.equal(fila?.status, 'EXPIRED');
      assert.equal(fila?.cancelled_at, null);
    });

    it('insistir varias veces tampoco desplaza la disponibilidad', async () => {
      const reserva = await reservaVencida();
      const antes = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);

      for (let intento = 0; intento < 3; intento += 1) {
        assert.equal((await post(`/bookings/${reserva.id}/cancel`, {}, ctx.sessions.customer.token)).status, 400);
      }

      const despues = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
      assert.equal(Number(despues?.available_seats), Number(antes?.available_seats));
    });

    it('cancelar dos veces una reserva vigente se sigue rechazando igual', async () => {
      const seats = await freeSeats(ctx.fixtures.tripA);
      const reserva = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id] },
        ctx.sessions.customer.token,
      );

      assert.equal((await post(`/bookings/${reserva.body.data.id}/cancel`, {}, ctx.sessions.customer.token)).status, 200);
      assert.equal((await post(`/bookings/${reserva.body.data.id}/cancel`, {}, ctx.sessions.customer.token)).status, 400);
    });

    it('y cancelar una reserva vigente sigue liberando sus asientos con normalidad', async () => {
      const seats = await freeSeats(ctx.fixtures.tripA);
      const reserva = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id] },
        ctx.sessions.customer.token,
      );
      const retenida = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);

      assert.equal((await post(`/bookings/${reserva.body.data.id}/cancel`, {}, ctx.sessions.customer.token)).status, 200);

      const liberada = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
      assert.equal(Number(liberada?.available_seats), Number(retenida?.available_seats) + 1);
      assert.equal(Number(liberada?.available_seats), await disponibilidadReal(ctx.fixtures.tripA));
    });

    it('expirar después de cancelar tampoco suma: la expiración solo mira reservas PENDING', async () => {
      const seats = await freeSeats(ctx.fixtures.tripA);
      const reserva = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [at(seats, 0).id] },
        ctx.sessions.customer.token,
      );
      await post(`/bookings/${reserva.body.data.id}/cancel`, {}, ctx.sessions.customer.token);

      const antes = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [reserva.body.data.id]);
      await post('/bookings/expire', {}, ctx.sessions.admin.token);

      const despues = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [ctx.fixtures.tripA]);
      assert.equal(Number(despues?.available_seats), Number(antes?.available_seats), 'el otro orden de los hechos tampoco duplica');
    });
  });
});
