import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { get, getWithKey, post, put } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { seatMap } from '../services/trip.service';
import { businessNow } from '../utils/businessTime';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * BP-15 · consistencia de la disponibilidad de asientos.
 *
 * La respuesta pública de un viaje traía DOS números para lo mismo: `available_seats`, la
 * columna denormalizada de `trips`, y `seats_available`, calculado a partir de
 * `booking_seats`. Podían no coincidir, y cada pantalla usaba uno distinto: el buscador de
 * ida el calculado, el de itinerarios la columna.
 *
 * La fuente de verdad es el CÁLCULO. Quien decide si un asiento está libre es
 * `createBookingOnConnection`, y lo hace consultando `booking_seats`; la columna no gobierna
 * ninguna venta.
 */
describe('BP-15 · disponibilidad de asientos', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  /** Viaje propio del caso, con todos sus asientos libres. */
  async function nuevoViaje(busId = ctx.fixtures.busA, routeId = ctx.fixtures.routeA): Promise<number> {
    const result = await execute(
      `INSERT INTO trips (route_id, bus_id, departure_datetime, arrival_datetime, base_price, available_seats, status)
       VALUES (?, ?, ?, ?, 45.00, (SELECT capacity FROM buses WHERE id = ?), 'SCHEDULED')`,
      [
        routeId,
        busId,
        businessNow(new Date(Date.now() + 20 * 86_400_000)),
        businessNow(new Date(Date.now() + 21 * 86_400_000)),
        busId,
      ],
    );
    return result.insertId;
  }

  /** Disponibilidad REAL: capacidad menos los asientos que retiene alguna reserva viva. */
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

  async function reservar(tripId: number, cantidad = 1) {
    const seats = await freeSeats(tripId);
    const res = await post(
      '/bookings',
      { trip_id: tripId, seat_ids: seats.slice(0, cantidad).map((s) => s.id) },
      ctx.sessions.customer.token,
    );
    assert.equal(res.status, 201, `no se pudo reservar: ${JSON.stringify(res.body)}`);
    return res.body.data as { id: number };
  }

  describe('Contrato: un solo campo de disponibilidad', () => {
    it('el esquema tiene `available_seats` y no tiene `seats_available`', async () => {
      const columnas = await query<{ COLUMN_NAME: string }>(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trips'`,
      );
      const nombres = columnas.map((c) => c.COLUMN_NAME);

      assert.ok(nombres.includes('available_seats'), 'la columna denormalizada existe');
      assert.equal(nombres.includes('seats_available'), false, '`seats_available` nunca fue una columna');
    });

    it('la búsqueda pública publica `seats_available` y ya no `available_seats`', async () => {
      const res = await get('/public/trips?limit=5');
      assert.equal(res.status, 200);
      assert.ok(res.body.data.length > 0);

      for (const viaje of res.body.data as Array<Record<string, unknown>>) {
        assert.ok('seats_available' in viaje, 'debe venir la disponibilidad calculada');
        assert.equal('available_seats' in viaje, false, 'la columna no debe viajar en la respuesta pública');
        assert.equal(typeof viaje.seats_available, 'number');
      }
    });

    it('el detalle público tampoco expone las dos', async () => {
      const tripId = await nuevoViaje();
      const res = await get(`/public/trips/${tripId}`);

      assert.equal(res.status, 200);
      assert.ok('seats_available' in res.body.data);
      assert.equal('available_seats' in res.body.data, false);
    });

    it('la búsqueda de itinerarios usa exactamente el mismo contrato', async () => {
      const res = await post('/public/itineraries/search', {
        trip_type: 'ROUND_TRIP',
        segments: [
          { origin: 'Lima', destination: 'Huánuco', date: businessNow(new Date(Date.now() + 3 * 86_400_000)).slice(0, 10) },
          { origin: 'Huánuco', destination: 'Lima', date: businessNow(new Date(Date.now() + 5 * 86_400_000)).slice(0, 10) },
        ],
      });
      assert.equal(res.status, 200);

      for (const tramo of res.body.data as Array<{ trips: Array<Record<string, unknown>> }>) {
        for (const viaje of tramo.trips) {
          assert.ok('seats_available' in viaje, 'el mismo campo que el buscador de ida');
          assert.equal('available_seats' in viaje, false);
        }
      }
    });
  });

  describe('El cálculo es la fuente de verdad', () => {
    it('la disponibilidad publicada coincide con los asientos realmente libres', async () => {
      const tripId = await nuevoViaje();
      await reservar(tripId, 3);

      const publico = await get(`/public/trips/${tripId}`);
      assert.equal(Number(publico.body.data.seats_available), await disponibilidadReal(tripId));
    });

    it('`seatMap()` y la disponibilidad publicada dicen lo mismo', async () => {
      const tripId = await nuevoViaje();
      await reservar(tripId, 2);

      const mapa = await seatMap(tripId);
      const libresSegunMapa = mapa.filter((asiento) => asiento.is_taken === 0 && asiento.status === 'AVAILABLE').length;
      const ocupadosSegunMapa = mapa.filter((asiento) => asiento.is_taken === 1).length;

      const publico = await get(`/public/trips/${tripId}`);
      assert.equal(Number(publico.body.data.seats_available), mapa.length - ocupadosSegunMapa);
      assert.equal(libresSegunMapa, mapa.length - ocupadosSegunMapa, 'sin asientos inactivos, ambas cuentas coinciden');

      const mapaPublico = await get(`/public/trips/${tripId}/seats`);
      assert.equal(mapaPublico.body.data.filter((s: { is_taken: number }) => s.is_taken === 1).length, ocupadosSegunMapa);
    });

    it('aunque la columna esté desfasada, lo publicado sigue siendo correcto', async () => {
      const tripId = await nuevoViaje();
      await reservar(tripId, 2);
      const real = await disponibilidadReal(tripId);

      // Se ensucia la caché a propósito: es lo que la corrección deja de exponer.
      await execute('UPDATE trips SET available_seats = 999 WHERE id = ?', [tripId]);
      const conBasura = await get(`/public/trips/${tripId}`);
      assert.equal(Number(conBasura.body.data.seats_available), real, 'el cálculo ignora la columna');

      // Y a NULL, que es un estado que el esquema permite.
      await execute('UPDATE trips SET available_seats = NULL WHERE id = ?', [tripId]);
      const conNulo = await get(`/public/trips/${tripId}`);
      assert.equal(Number(conNulo.body.data.seats_available), real, 'tampoco depende de que la columna exista');
    });

    it('la columna ya no se puede escribir a mano desde la edición del viaje', async () => {
      const tripId = await nuevoViaje();
      const antes = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [tripId]);

      // Un valor que SÍ pasa la validación de forma (el esquema admite 0..120), para que la
      // prueba mida la lista blanca de columnas y no el validador.
      const res = await put(`/trips/${tripId}`, { available_seats: 99, boarding_notes: 'nota' }, ctx.sessions.admin.token);
      assert.equal(res.status, 200, 'los demás campos siguen editándose');
      assert.equal(res.body.data.boarding_notes, 'nota');

      const despues = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [tripId]);
      assert.equal(Number(despues?.available_seats), Number(antes?.available_seats), 'la caché no se toca a mano');
    });
  });

  describe('La disponibilidad sigue el ciclo de la reserva', () => {
    it('crear una reserva descuenta lo reservado', async () => {
      const tripId = await nuevoViaje();
      const antes = await disponibilidadReal(tripId);

      await reservar(tripId, 2);

      const despues = await disponibilidadReal(tripId);
      assert.equal(despues, antes - 2);
      assert.equal(Number((await get(`/public/trips/${tripId}`)).body.data.seats_available), despues);
    });

    it('confirmar el pago no cambia la disponibilidad: el asiento ya estaba retenido', async () => {
      const tripId = await nuevoViaje();
      const reserva = await reservar(tripId, 1);
      const trasReservar = await disponibilidadReal(tripId);

      await post(`/bookings/${reserva.id}/pay`, { method: 'CASH' }, ctx.sessions.customer.token);

      assert.equal(await disponibilidadReal(tripId), trasReservar);
    });

    it('expirar la reserva libera los asientos una sola vez', async () => {
      const tripId = await nuevoViaje();
      const antes = await disponibilidadReal(tripId);
      const reserva = await reservar(tripId, 2);
      assert.equal(await disponibilidadReal(tripId), antes - 2);

      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [reserva.id]);
      await post('/bookings/expire', {}, ctx.sessions.admin.token);

      assert.equal(await disponibilidadReal(tripId), antes, 'vuelven los dos asientos');
      const columna = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [tripId]);
      assert.equal(Number(columna?.available_seats), antes, 'y la caché queda cuadrada');
    });

    it('cancelar la reserva libera los asientos', async () => {
      const tripId = await nuevoViaje();
      const antes = await disponibilidadReal(tripId);
      const reserva = await reservar(tripId, 1);

      assert.equal((await post(`/bookings/${reserva.id}/cancel`, {}, ctx.sessions.customer.token)).status, 200);

      assert.equal(await disponibilidadReal(tripId), antes);
      assert.equal(Number((await get(`/public/trips/${tripId}`)).body.data.seats_available), antes);
    });

    it('la caché y el cálculo terminan de acuerdo tras el ciclo completo', async () => {
      const tripId = await nuevoViaje();

      const cancelada = await reservar(tripId, 1);
      await post(`/bookings/${cancelada.id}/cancel`, {}, ctx.sessions.customer.token);

      const vencida = await reservar(tripId, 1);
      await execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [vencida.id]);
      await post('/bookings/expire', {}, ctx.sessions.admin.token);

      const viva = await reservar(tripId, 2);
      await post(`/bookings/${viva.id}/pay`, { method: 'CASH' }, ctx.sessions.customer.token);

      const columna = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [tripId]);
      assert.equal(Number(columna?.available_seats), await disponibilidadReal(tripId), 'sin deriva tras cancelar, expirar y pagar');
    });
  });

  describe('Límites y concurrencia', () => {
    it('dos reservas simultáneas no venden el mismo asiento', async () => {
      const tripId = await nuevoViaje();
      const objetivo = at(await freeSeats(tripId), 0).id;

      const [una, otra] = await Promise.all([
        post('/bookings', { trip_id: tripId, seat_ids: [objetivo] }, ctx.sessions.customer.token),
        post('/bookings', { trip_id: tripId, seat_ids: [objetivo] }, ctx.sessions.admin.token),
      ]);

      const aceptadas = [una, otra].filter((res) => res.status === 201).length;
      assert.equal(aceptadas, 1, 'el bloqueo del viaje serializa las dos compras');

      const vendidas = await queryOne<{ n: number }>(
        `SELECT COUNT(*) n FROM booking_seats bs JOIN bookings bk ON bk.id = bs.booking_id
         WHERE bs.trip_id = ? AND bs.seat_id = ?
           AND (bk.status IN ('CONFIRMED','COMPLETED')
                OR (bk.status = 'PENDING' AND (bk.expires_at IS NULL OR bk.expires_at > NOW())))`,
        [tripId, objetivo],
      );
      assert.equal(Number(vendidas?.n), 1, 'un asiento, una reserva viva');
    });

    it('no se puede reservar por encima de la capacidad', async () => {
      const tripId = await nuevoViaje(ctx.fixtures.busB, ctx.fixtures.routeB);
      const capacidad = Number(
        (await queryOne<{ capacity: number }>('SELECT capacity FROM buses WHERE id = ?', [ctx.fixtures.busB]))?.capacity,
      );

      // Se agota el bus en tandas, respetando el máximo por reserva.
      let vendidos = 0;
      while (vendidos < capacidad) {
        const libres = await freeSeats(tripId);
        if (libres.length === 0) break;
        const lote = libres.slice(0, Math.min(6, libres.length));
        const res = await post(
          '/bookings',
          { trip_id: tripId, seat_ids: lote.map((s) => s.id) },
          ctx.sessions.customer.token,
        );
        assert.equal(res.status, 201);
        vendidos += lote.length;
      }

      assert.equal(await disponibilidadReal(tripId), 0, 'el viaje queda agotado');
      assert.equal(Number((await get(`/public/trips/${tripId}`)).body.data.seats_available), 0);
      assert.equal((await freeSeats(tripId)).length, 0, 'no queda ningún asiento libre que ofrecer');
    });

    it('la disponibilidad nunca baja de cero ni supera la capacidad', async () => {
      const tripId = await nuevoViaje();
      const capacidad = Number(
        (await queryOne<{ capacity: number }>('SELECT capacity FROM buses WHERE id = ?', [ctx.fixtures.busA]))?.capacity,
      );

      const reserva = await reservar(tripId, 4);
      await post(`/bookings/${reserva.id}/cancel`, {}, ctx.sessions.customer.token);

      const fila = await queryOne<{ available_seats: number }>('SELECT available_seats FROM trips WHERE id = ?', [tripId]);
      assert.ok(Number(fila?.available_seats) >= 0, 'nunca negativa');
      assert.ok(Number(fila?.available_seats) <= capacidad, 'nunca por encima de la capacidad');

      const calculada = await disponibilidadReal(tripId);
      assert.ok(calculada >= 0 && calculada <= capacidad);
    });
  });

  describe('La API de integración comparte la misma fuente', () => {
    it('su disponibilidad coincide con la del buscador público', async () => {
      const llave = await post(
        '/api-keys',
        { name: 'Disponibilidad', company_id: ctx.fixtures.companyA },
        ctx.sessions.admin.token,
      );
      const plain = llave.body.data.plain_key as string;

      const tripId = await nuevoViaje();
      await reservar(tripId, 3);

      const integracion = await getWithKey(`/integration/v1/trips/${tripId}/availability`, plain);
      const publico = await get(`/public/trips/${tripId}`);

      assert.equal(integracion.status, 200);
      assert.equal(Number(integracion.body.data.seats_available), Number(publico.body.data.seats_available));
      assert.equal(Number(integracion.body.data.seats_available), await disponibilidadReal(tripId));
      assert.equal(
        integracion.body.data.capacity,
        integracion.body.data.seats_taken + integracion.body.data.seats_available + integracion.body.data.seats_inactive,
      );
    });

    it('el listado de integración también deriva sus asientos ocupados', async () => {
      const llave = await post(
        '/api-keys',
        { name: 'Listado', company_id: ctx.fixtures.companyA },
        ctx.sessions.admin.token,
      );
      const tripId = await nuevoViaje();
      await reservar(tripId, 2);

      const res = await getWithKey('/integration/v1/trips?limit=100', llave.body.data.plain_key);
      const viaje = (res.body.data as Array<Record<string, unknown>>).find((t) => Number(t.id) === tripId);

      assert.ok(viaje, 'el viaje debe aparecer');
      assert.equal(Number(viaje!.seats_taken), 2, 'ocupados derivados de booking_seats');
      assert.equal('available_seats' in viaje!, false, 'tampoco aquí se publica la columna');
    });
  });
});
