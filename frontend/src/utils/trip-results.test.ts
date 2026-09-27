import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  arrivalDayOffset,
  availabilityLabel,
  availabilityLevel,
  durationMinutes,
  passengerCountLabel,
  passengersFromParam,
  sortTrips,
  type SortableTrip,
} from './trip-results.ts';

const trip = (id: number, salida: string, llegada: string | null, precio: number, rating: number | null): SortableTrip => ({
  id,
  departure_datetime: salida,
  arrival_datetime: llegada,
  base_price: String(precio),
  company_rating: rating,
});

// Orden del backend: por hora de salida.
const TRIPS = [
  trip(1, '2026-09-27 08:00:00', '2026-09-27 20:00:00', 90, 4.2), // 12 h
  trip(2, '2026-09-27 14:00:00', '2026-09-28 06:30:00', 60, null), // 16 h 30
  trip(3, '2026-09-27 20:00:00', '2026-09-28 06:00:00', 60, 4.8), // 10 h
  trip(4, '2026-09-27 22:00:00', null, 50, 3.9), // sin llegada
];
const ids = (rows: SortableTrip[]) => rows.map((r) => r.id);

describe('resultados · orden con datos reales', () => {
  it('recomendados respeta el orden del backend y no muta la lista', () => {
    const copia = [...TRIPS];
    assert.deepEqual(ids(sortTrips(TRIPS, 'recommended')), [1, 2, 3, 4]);
    assert.deepEqual(TRIPS, copia);
  });
  it('menor precio, con empates por hora de salida', () => {
    assert.deepEqual(ids(sortTrips(TRIPS, 'price')), [4, 2, 3, 1]);
  });
  it('más rápido: duración real; sin llegada, al final', () => {
    assert.deepEqual(ids(sortTrips(TRIPS, 'duration')), [3, 1, 2, 4]);
  });
  it('mejor calificados: sin opiniones al final', () => {
    assert.deepEqual(ids(sortTrips(TRIPS, 'rating')), [3, 1, 4, 2]);
  });
  it('hora de salida', () => {
    assert.deepEqual(ids(sortTrips([TRIPS[2]!, TRIPS[0]!], 'departure')), [1, 3]);
  });
});

describe('resultados · duración y llegada', () => {
  it('calcula minutos cruzando la medianoche', () => {
    assert.equal(durationMinutes('2026-09-27 14:00:00', '2026-09-28 06:30:00'), 990);
    assert.equal(durationMinutes('2026-09-27 14:00:00', null), null);
    assert.equal(durationMinutes('2026-09-27 14:00:00', '2026-09-27 10:00:00'), null);
  });
  it('+1 cuando se llega al día siguiente', () => {
    assert.equal(arrivalDayOffset('2026-09-27 20:00:00', '2026-09-28 06:00:00'), 1);
    assert.equal(arrivalDayOffset('2026-09-27 08:00:00', '2026-09-27 20:00:00'), 0);
  });
});

describe('resultados · pasajeros y disponibilidad', () => {
  it('lee los pasajeros de la URL con valores seguros', () => {
    assert.equal(passengersFromParam('3'), 3);
    assert.equal(passengersFromParam(null), 1);
    assert.equal(passengersFromParam('0'), 1);
    assert.equal(passengersFromParam('abc'), 1);
    assert.equal(passengerCountLabel(1), '1 pasajero');
    assert.equal(passengerCountLabel(2), '2 pasajeros');
  });
  it('avisa de los últimos asientos solo con datos reales', () => {
    assert.equal(availabilityLevel(0), 'none');
    assert.equal(availabilityLevel(3), 'few');
    assert.equal(availabilityLevel(20), 'ok');
    assert.equal(availabilityLabel(1), '¡Último asiento!');
    assert.equal(availabilityLabel(4), '¡Últimos 4 asientos!');
    assert.equal(availabilityLabel(12), '12 asientos disponibles');
  });
});
