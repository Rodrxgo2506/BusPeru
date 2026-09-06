import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { get, post } from './helpers/api';
import { queryOne } from '../config/database';
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
});
