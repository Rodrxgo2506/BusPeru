import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changePassengers, DEFAULT_PASSENGERS, passengerLabel, totalPassengers } from './passengers.ts';
import { filterOptions, normalizeForSearch, SLUG_PATTERN, slugify } from './text.ts';
import { badgeFitsInCircle, formatAltitude, formatPriceFrom, searchPrefill, stepIndex, visibleCards } from './destination-view.ts';

/** FASE 17 · lógica pura del buscador y del CMS de destinos. Se ejecuta con `npm test`. */
describe('FASE 17 · filtro de ciudades', () => {
  const cities = ['Lima', 'Ayacucho', 'Bagua', 'Bagua Grande', 'Huánuco', 'Cajamarca'];

  it('filtra en tiempo real sin distinguir tildes ni mayúsculas y conserva el orden', () => {
    assert.deepEqual(filterOptions(cities, 'bag'), ['Bagua', 'Bagua Grande']);
    assert.deepEqual(filterOptions(cities, 'HUANUCO'), ['Huánuco']);
    assert.deepEqual(filterOptions(cities, 'huánu'), ['Huánuco']);
    assert.deepEqual(filterOptions(cities, '   '), cities);
    assert.deepEqual(filterOptions(cities, 'zzz'), []);
    assert.equal(normalizeForSearch('  Ñaña '), 'nana');
  });
});

describe('FASE 17 · pasajeros', () => {
  it('empieza en 1 adulto, 0 niños y 0 bebés', () => {
    assert.deepEqual(DEFAULT_PASSENGERS, { adults: 1, children: 0, infants: 0 });
    assert.equal(totalPassengers(DEFAULT_PASSENGERS), 1);
    assert.equal(passengerLabel(1), '1 pasajero');
  });

  it('suma bien y nunca baja de los mínimos', () => {
    let counts = changePassengers(DEFAULT_PASSENGERS, 'adults', 1, 6);
    assert.equal(passengerLabel(totalPassengers(counts)), '2 pasajeros');
    counts = changePassengers(counts, 'children', 1, 6);
    assert.equal(passengerLabel(totalPassengers(counts)), '3 pasajeros');
    counts = changePassengers(counts, 'adults', -5, 6);
    assert.equal(counts.adults, 1, 'adultos mínimo 1');
    counts = changePassengers(counts, 'infants', -1, 6);
    assert.equal(counts.infants, 0, 'bebés nunca negativos');
    counts = changePassengers(counts, 'children', -3, 6);
    assert.equal(counts.children, 0, 'niños nunca negativos');
  });

  it('respeta el máximo total', () => {
    let counts = { adults: 5, children: 0, infants: 0 };
    counts = changePassengers(counts, 'infants', 1, 6);
    assert.equal(totalPassengers(counts), 6);
    assert.deepEqual(changePassengers(counts, 'children', 1, 6), counts);
  });
});

describe('FASE 17 · slug', () => {
  it('genera slugs seguros para URL, iguales a los del backend', () => {
    assert.equal(slugify('La Merced'), 'la-merced');
    assert.equal(slugify('Cañón del Colca'), 'canon-del-colca');
    assert.equal(slugify('  ¡Huaraz! '), 'huaraz');
    assert.equal(slugify('!!!'), '');
    for (const value of ['la-merced', 'cajamarca', 'a1-b2']) assert.ok(SLUG_PATTERN.test(value), value);
    for (const value of ['La-Merced', 'a--b', '-a', 'a b', '../x']) assert.ok(!SLUG_PATTERN.test(value), value);
  });
});

describe('FASE 17B · vistas de destinos', () => {
  it('el carrusel muestra 4, 3, 2 o 1 tarjeta según el ancho', () => {
    assert.equal(visibleCards(1440), 4);
    assert.equal(visibleCards(1280), 4);
    assert.equal(visibleCards(1024), 3);
    assert.equal(visibleCards(768), 2);
    assert.equal(visibleCards(640), 2);
    assert.equal(visibleCards(375), 1);
  });

  it('el slider de atractivos avanza y retrocede en círculo', () => {
    assert.equal(stepIndex(0, 1, 3), 1);
    assert.equal(stepIndex(2, 1, 3), 0);
    assert.equal(stepIndex(0, -1, 3), 2);
    assert.equal(stepIndex(0, 1, 1), 0);
    assert.equal(stepIndex(0, -1, 0), 0);
  });

  it('el buscador solo se precarga con ciudades que existen en el sistema', () => {
    const cities = ['Lima', 'Huaraz', 'Trujillo'];
    assert.deepEqual(searchPrefill({ city: 'Huaraz', origin_city: 'Lima' }, cities), { origin: 'Lima', destination: 'Huaraz' });
    assert.deepEqual(searchPrefill({ city: 'Cajamarca', origin_city: 'Lima' }, cities), { origin: 'Lima', destination: '' });
    assert.deepEqual(searchPrefill({ city: null, origin_city: null }, cities), { origin: '', destination: '' });
  });

  it('la altitud se formatea con separador de millares y las insignias saben si el texto cabe', () => {
    assert.equal(formatAltitude(2750), '2,750 msnm');
    assert.equal(formatAltitude(0), '0 msnm');
    assert.equal(formatAltitude(null), null);
    assert.equal(badgeFitsInCircle('18hr'), true);
    assert.equal(badgeFitsInCircle('18 horas desde Lima'), false);
    assert.equal(badgeFitsInCircle(''), false);
    assert.equal(badgeFitsInCircle(null), false);
  });

  it('el precio «desde» se muestra como en la referencia', () => {
    assert.equal(formatPriceFrom(110), 'S/110');
    assert.equal(formatPriceFrom('55.00'), 'S/55');
    assert.equal(formatPriceFrom(85.5), 'S/85.50');
    assert.equal(formatPriceFrom(null), null);
    assert.equal(formatPriceFrom(undefined), null);
  });
});
