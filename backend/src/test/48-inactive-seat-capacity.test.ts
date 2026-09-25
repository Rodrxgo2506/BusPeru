import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, get, getWithKey, post, put } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, createBusLayout } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';
import * as layouts from '../services/bus-layout.service';

/**
 * H-15 · `seat_count` cuenta solo los asientos VENDIBLES.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO (auditoría FASE 7). `seat_count` se calculaba con un
 * `COUNT(*)` de todas las filas de `seats` de la versión, INACTIVE incluidos. Un asiento
 * INACTIVE no se vende —la reserva lo rechaza—, pero seguía sumando en la capacidad del bus,
 * en la del viaje y en `seats_available`: el viaje anunciaba plazas que nadie podía comprar y
 * jamás llegaba a verse lleno. La API de integración sí los descontaba, así que dos partes de
 * la plataforma daban disponibilidades distintas para el mismo viaje.
 *
 * La regla ahora es una sola: AVAILABLE cuenta, INACTIVE no. De `seat_count` beben
 * `buses.capacity`, la capacidad del viaje y los cupos iniciales, y cada caso de aquí mira
 * uno de esos caminos por su propia vía —servicio, HTTP o base—, nunca solo el valor guardado.
 */
describe('H-15 · la capacidad es de asientos vendibles', () => {
  let ctx: SuiteContext;
  let claveIntegracion = '';
  let secuencia = 0;

  before(async () => {
    ctx = await prepareSuite();
    const clave = await post(
      '/api-keys',
      { name: 'H-15', company_id: ctx.fixtures.companyA },
      ctx.sessions.admin.token,
    );
    assert.equal(clave.status, 201, JSON.stringify(clave.body));
    claveIntegracion = clave.body.data.plain_key as string;
  });
  after(teardownSuite);

  // ------------------------------------------------------------------ utilidades

  const fecha = (dias: number, hora: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + dias);
    d.setHours(hora, 0, 0, 0);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  };

  const seatCount = async (layoutId: number) =>
    Number((await queryOne<{ n: number }>('SELECT seat_count AS n FROM bus_layouts WHERE id = ?', [layoutId]))?.n);

  const capacidadBus = async (busId: number) =>
    Number((await queryOne<{ n: number }>('SELECT capacity AS n FROM buses WHERE id = ?', [busId]))?.n);

  /**
   * Bus nuevo de la empresa A con una versión en BORRADOR de `disponibles` asientos AVAILABLE
   * seguidos de `inactivos` INACTIVE, en una rejilla de 11×4 que admite hasta 44.
   */
  async function busEnBorrador(disponibles: number, inactivos: number) {
    secuencia += 1;
    const busId = (
      await execute(
        `INSERT INTO buses (company_id, code, plate_number, brand, model, year, capacity, status)
         VALUES (?, ?, ?, 'Marca', 'Modelo', 2024, 1, 'ACTIVE')`,
        [ctx.fixtures.companyA, `H15-${secuencia}`, `H15-${String(secuencia).padStart(3, '0')}`],
      )
    ).insertId;
    const { layoutId, deckIds } = await createBusLayout(busId, { status: 'DRAFT', rows: 11, columns: 4 });
    const deckId = at(deckIds, 0);

    const seatIds: number[] = [];
    const total = disponibles + inactivos;
    for (let i = 1; i <= total; i += 1) {
      const res = await execute(
        `INSERT INTO seats (bus_id, layout_id, deck_id, seat_number, row_number, column_number, is_window, is_aisle, status)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
        [busId, layoutId, deckId, String(i).padStart(2, '0'), Math.ceil(i / 4), ((i - 1) % 4) + 1, i <= disponibles ? 'AVAILABLE' : 'INACTIVE'],
      );
      seatIds.push(res.insertId);
    }
    return { busId, layoutId, deckId, seatIds, inactivos: seatIds.slice(disponibles) };
  }

  /** Igual, pero ya publicada por el camino real de la aplicación. */
  async function busPublicado(disponibles: number, inactivos: number) {
    const bus = await busEnBorrador(disponibles, inactivos);
    await layouts.publishLayout(bus.layoutId);
    return bus;
  }

  /** Viaje nuevo, creado por la API, sobre el bus indicado. */
  async function crearViaje(busId: number, dias = 10) {
    const res = await post(
      '/trips',
      { route_id: ctx.fixtures.routeA, bus_id: busId, departure_datetime: fecha(dias, 21), arrival_datetime: fecha(dias + 1, 7), base_price: 60 },
      ctx.sessions.companyAdmin.token,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return Number(res.body.data.id);
  }

  const enBusqueda = async (tripId: number) => {
    const res = await get('/public/trips?limit=100');
    assert.equal(res.status, 200);
    const fila = (res.body.data as Array<{ id: number; capacity: number; seats_available: number }>).find((t) => Number(t.id) === tripId);
    assert.ok(fila, `el viaje ${tripId} debe salir en la búsqueda pública`);
    return { capacity: Number(fila.capacity), seatsAvailable: Number(fila.seats_available) };
  };

  const availableSeats = async (tripId: number) =>
    Number((await queryOne<{ n: number }>('SELECT available_seats AS n FROM trips WHERE id = ?', [tripId]))?.n);

  async function comprar(tripId: number, seatIds: number[]) {
    const reserva = await post(
      '/bookings',
      { trip_id: tripId, seat_ids: seatIds, passenger_email: 'cliente@test.pe' },
      ctx.sessions.customer.token,
    );
    assert.equal(reserva.status, 201, JSON.stringify(reserva.body));
    const pago = await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);
    assert.equal(pago.status, 200, JSON.stringify(pago.body));
    return Number(reserva.body.data.id);
  }

  // =====================================================================
  describe('Publicación', () => {
    it('1 · 42 AVAILABLE → seat_count 42 y capacidad del bus 42', async () => {
      const bus = await busPublicado(42, 0);
      assert.equal(await seatCount(bus.layoutId), 42);
      assert.equal(await capacidadBus(bus.busId), 42);
    });

    it('2 · 40 AVAILABLE + 2 INACTIVE → seat_count 40 y capacidad del bus 40', async () => {
      const bus = await busPublicado(40, 2);
      assert.equal(await seatCount(bus.layoutId), 40);
      assert.equal(await capacidadBus(bus.busId), 40);
      // Los INACTIVE no desaparecen: siguen siendo filas de la versión y se dibujan en el mapa.
      const filas = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM seats WHERE layout_id = ?', [bus.layoutId]);
      assert.equal(Number(filas?.n), 42);
    });

    it('3 · 0 AVAILABLE + 42 INACTIVE → seat_count 0 y capacidad del bus 0', async () => {
      const bus = await busPublicado(0, 42);
      assert.equal(await seatCount(bus.layoutId), 0);
      assert.equal(await capacidadBus(bus.busId), 0);
    });

    it('11 · publicar recalcula desde los asientos, no confía en la cifra guardada', async () => {
      const bus = await busEnBorrador(38, 4);
      await execute('UPDATE bus_layouts SET seat_count = 999 WHERE id = ?', [bus.layoutId]);

      const publicado = await layouts.publishLayout(bus.layoutId);
      assert.equal(publicado.seat_count, 38, 'lo que devuelve la publicación');
      assert.equal(await seatCount(bus.layoutId), 38, 'lo que queda guardado');
      assert.equal(await capacidadBus(bus.busId), 38, '`buses.capacity` sigue a `seat_count`');
    });

    it('11b · una versión sin ninguna fila de asiento sigue sin poder publicarse', async () => {
      const bus = await busEnBorrador(0, 0);
      await assert.rejects(layouts.publishLayout(bus.layoutId), /ningún asiento/);
    });
  });

  // =====================================================================
  describe('Editor del borrador', () => {
    it('10 · desactivar y reactivar un asiento recalcula seat_count en el acto', async () => {
      const bus = await busEnBorrador(6, 0);
      const [primero, segundo] = [at(bus.seatIds, 0), at(bus.seatIds, 1)];

      // El borrador nace con seat_count 0 en la fixture: el primer cambio lo pone al día.
      await layouts.updateSeat(primero, { status: 'INACTIVE' });
      assert.equal(await seatCount(bus.layoutId), 5);

      await layouts.updateSeat(segundo, { status: 'INACTIVE' });
      assert.equal(await seatCount(bus.layoutId), 4);

      await layouts.updateSeat(primero, { status: 'AVAILABLE' });
      assert.equal(await seatCount(bus.layoutId), 5);
    });

    it('10b · por HTTP, el PATCH del asiento deja la versión con la cifra correcta', async () => {
      const bus = await busEnBorrador(4, 0);
      const res = await api(`/layout-seats/${at(bus.seatIds, 3)}`, {
        method: 'PATCH',
        body: { status: 'INACTIVE' },
        token: ctx.sessions.companyAdmin.token,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const arbol = await get(`/layouts/${bus.layoutId}`, ctx.sessions.companyAdmin.token);
      assert.equal(Number(arbol.body.data.layout.seat_count), 3);
      assert.equal(await seatCount(bus.layoutId), 3);
    });

    it('10c · crear un asiento INACTIVE no suma; borrar uno INACTIVE no resta', async () => {
      const bus = await busEnBorrador(2, 0);
      await layouts.updateSeat(at(bus.seatIds, 0), { status: 'AVAILABLE' }); // pone el recuento al día
      assert.equal(await seatCount(bus.layoutId), 2);

      const nuevo = await layouts.createSeat(bus.deckId, { seat_number: '90', row_number: 5, column_number: 1, status: 'INACTIVE' });
      assert.equal(await seatCount(bus.layoutId), 2, 'un INACTIVE nuevo no es una plaza');

      await layouts.createSeat(bus.deckId, { seat_number: '91', row_number: 5, column_number: 2 });
      assert.equal(await seatCount(bus.layoutId), 3, 'un AVAILABLE nuevo sí');

      await layouts.deleteSeat(nuevo.id);
      assert.equal(await seatCount(bus.layoutId), 3, 'borrar el INACTIVE no cambia la capacidad');
    });
  });

  // =====================================================================
  describe('Clonación', () => {
    it('9 · el clon hereda la capacidad vendible y conserva los INACTIVE', async () => {
      const bus = await busPublicado(40, 2);
      const clon = await layouts.cloneForEdit(bus.layoutId);

      assert.equal(clon.seat_count, 40);
      const estados = await query<{ status: string; n: number }>(
        'SELECT status, COUNT(*) AS n FROM seats WHERE layout_id = ? GROUP BY status ORDER BY status',
        [clon.id],
      );
      assert.deepEqual(
        estados.map((e) => [e.status, Number(e.n)]),
        [['AVAILABLE', 40], ['INACTIVE', 2]],
        'el clon copia los asientos con su estado',
      );
    });

    it('9b · el clon recuenta sus asientos en vez de copiar la cifra del origen', async () => {
      const bus = await busPublicado(30, 3);
      // Una cifra guardada vieja —p. ej. calculada con la regla anterior— no se hereda.
      await execute('UPDATE bus_layouts SET seat_count = 33 WHERE id = ?', [bus.layoutId]);

      const clon = await layouts.cloneForEdit(bus.layoutId);
      assert.equal(clon.seat_count, 30);
      assert.equal(await seatCount(clon.id), 30);
    });
  });

  // =====================================================================
  describe('Viajes: creación, cambio de bus, búsqueda, integración y reserva', () => {
    it('12 · crear un viaje y cambiarle el bus toman la capacidad vendible de la versión publicada', async () => {
      const conInactivos = await busPublicado(40, 2);
      const completo = await busPublicado(42, 0);

      const tripId = await crearViaje(conInactivos.busId);
      assert.equal(await availableSeats(tripId), 40, 'al crear');
      const anclado = await queryOne<{ bus_layout_id: number }>('SELECT bus_layout_id FROM trips WHERE id = ?', [tripId]);
      assert.equal(Number(anclado?.bus_layout_id), conInactivos.layoutId);

      const cambio = await put(`/trips/${tripId}`, { bus_id: completo.busId }, ctx.sessions.companyAdmin.token);
      assert.equal(cambio.status, 200, JSON.stringify(cambio.body));
      assert.equal(await availableSeats(tripId), 42, 'al cambiar a un bus sin INACTIVE');

      const vuelta = await put(`/trips/${tripId}`, { bus_id: conInactivos.busId }, ctx.sessions.companyAdmin.token);
      assert.equal(vuelta.status, 200, JSON.stringify(vuelta.body));
      assert.equal(await availableSeats(tripId), 40, 'al volver al bus con 2 INACTIVE');
    });

    it('4 · 5 · 6 · búsqueda pública, integración y available_seats dan la misma disponibilidad', async () => {
      const bus = await busPublicado(40, 2);
      const tripId = await crearViaje(bus.busId, 12);

      const comprobar = async (esperado: number) => {
        const publico = await enBusqueda(tripId);
        assert.equal(publico.capacity, 40, 'búsqueda pública: capacidad vendible');
        assert.equal(publico.seatsAvailable, esperado, 'búsqueda pública: disponibles');

        const detalle = await getWithKey(`/integration/v1/trips/${tripId}`, claveIntegracion);
        assert.equal(detalle.status, 200, JSON.stringify(detalle.body));
        assert.equal(Number(detalle.body.data.capacity), 40, 'integración (ficha del viaje): capacidad vendible');

        const disponibilidad = await getWithKey(`/integration/v1/trips/${tripId}/availability`, claveIntegracion);
        assert.equal(disponibilidad.status, 200, JSON.stringify(disponibilidad.body));
        const d = disponibilidad.body.data as { capacity: number; seats_taken: number; seats_inactive: number; seats_available: number };
        assert.equal(Number(d.seats_available), esperado, 'integración: disponibles coincide con la búsqueda pública');
        assert.equal(Number(d.seats_inactive), 2);
        assert.equal(Number(d.capacity), Number(d.seats_taken) + Number(d.seats_inactive) + Number(d.seats_available), 'la integración cuadra consigo misma');

        assert.equal(await availableSeats(tripId), esperado, '`trips.available_seats`');
      };

      await comprobar(40);
      const disponibles = bus.seatIds.slice(0, 40);
      await comprar(tripId, [at(disponibles, 0), at(disponibles, 1)]);
      await comprobar(38);
    });

    it('6b · con todas las vendibles compradas el viaje se ve lleno aunque queden INACTIVE', async () => {
      const bus = await busEnBorrador(3, 2);
      await layouts.publishLayout(bus.layoutId);
      const tripId = await crearViaje(bus.busId, 14);

      await comprar(tripId, bus.seatIds.slice(0, 3));

      assert.equal((await enBusqueda(tripId)).seatsAvailable, 0, 'antes del arreglo quedaba en 2');
      assert.equal(await availableSeats(tripId), 0);
      const d = (await getWithKey(`/integration/v1/trips/${tripId}/availability`, claveIntegracion)).body.data;
      assert.equal(Number(d.seats_available), 0);
    });

    it('7 · la reserva sigue rechazando un asiento INACTIVE', async () => {
      const bus = await busPublicado(10, 2);
      const tripId = await crearViaje(bus.busId, 16);
      const antes = await availableSeats(tripId);

      const res = await post(
        '/bookings',
        { trip_id: tripId, seat_ids: [at(bus.inactivos, 0)], passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token,
      );
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.match(String(res.body.message), /no está habilitado/);
      assert.equal(await availableSeats(tripId), antes, 'el rechazo no toca los cupos');
    });

    it('8 · un viaje ya vendido conserva su capacidad, su reserva y su precio al republicar el bus', async () => {
      const { tripA, busA, layoutA } = ctx.fixtures;
      const vendidos = (await query<{ id: number }>('SELECT id FROM seats WHERE layout_id = ? ORDER BY id LIMIT 1', [layoutA])).map((s) => s.id);
      const bookingId = await comprar(tripA, vendidos);

      const reservaAntes = await queryOne<{ total_amount: string; status: string }>('SELECT total_amount, status FROM bookings WHERE id = ?', [bookingId]);
      const asientosAntes = await query('SELECT seat_id, price FROM booking_seats WHERE booking_id = ? ORDER BY seat_id', [bookingId]);
      const busquedaAntes = await enBusqueda(tripA);

      // Nueva versión del bus con dos plazas desactivadas.
      const clon = await layouts.cloneForEdit(layoutA);
      const delClon = await query<{ id: number }>('SELECT id FROM seats WHERE layout_id = ? ORDER BY id LIMIT 2', [clon.id]);
      for (const asiento of delClon) await layouts.updateSeat(asiento.id, { status: 'INACTIVE' });
      await layouts.publishLayout(clon.id);

      assert.equal(await seatCount(clon.id), 10, 'la versión nueva tiene 10 vendibles');
      assert.equal(await capacidadBus(busA), 10, 'el bus, desde hoy, 10');

      assert.equal(await seatCount(layoutA), 12, 'la versión archivada conserva su cifra');
      const viaje = await queryOne<{ bus_layout_id: number }>('SELECT bus_layout_id FROM trips WHERE id = ?', [tripA]);
      assert.equal(Number(viaje?.bus_layout_id), layoutA, 'el viaje sigue anclado a su versión');
      assert.deepEqual(await enBusqueda(tripA), busquedaAntes, 'capacidad y disponibles del viaje, idénticos');

      assert.deepEqual(
        await queryOne('SELECT total_amount, status FROM bookings WHERE id = ?', [bookingId]),
        reservaAntes,
        'la reserva no cambia',
      );
      assert.deepEqual(
        await query('SELECT seat_id, price FROM booking_seats WHERE booking_id = ? ORDER BY seat_id', [bookingId]),
        asientosAntes,
        'ni sus asientos ni sus precios',
      );
    });
  });
});
