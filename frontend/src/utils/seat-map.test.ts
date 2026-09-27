import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deckLabel,
  freeSeatsByDeck,
  isSeatSelectable,
  seatCategories,
  seatState,
  selectionSummary,
  toggleSeatSelection,
  type SeatLike,
} from './seat-map.ts';

const seat = (id: number, deck: number | null, extra: Partial<SeatLike> = {}): SeatLike => ({
  id,
  seat_number: String(id).padStart(2, '0'),
  is_taken: 0,
  status: 'AVAILABLE',
  price: '60.00',
  deck_id: deck,
  seat_type_name: 'Semicama',
  ...extra,
});

describe('asientos · estados y disponibilidad real', () => {
  it('solo se eligen asientos libres y activos', () => {
    assert.equal(isSeatSelectable(seat(1, 1)), true);
    assert.equal(isSeatSelectable(seat(2, 1, { is_taken: 1 })), false);
    assert.equal(isSeatSelectable(seat(3, 1, { status: 'INACTIVE' })), false);
  });
  it('estado de cada asiento', () => {
    assert.equal(seatState(seat(1, 1), []), 'available');
    assert.equal(seatState(seat(1, 1), [1]), 'selected');
    assert.equal(seatState(seat(2, 1, { is_taken: 1 }), [2]), 'taken');
    assert.equal(seatState(seat(3, 1, { status: 'INACTIVE' }), []), 'inactive');
  });
});

describe('asientos · selección con la regla actual (máximo por reserva)', () => {
  it('añade y quita sin duplicar', () => {
    let sel = toggleSeatSelection([], seat(1, 1), 6);
    sel = toggleSeatSelection(sel, seat(2, 1), 6);
    assert.deepEqual(sel.map((s) => s.id), [1, 2]);
    sel = toggleSeatSelection(sel, seat(1, 1), 6);
    assert.deepEqual(sel.map((s) => s.id), [2]);
  });
  it('respeta el tope y no admite ocupados', () => {
    const sel = toggleSeatSelection([seat(1, 1)], seat(2, 1), 1);
    assert.deepEqual(sel.map((s) => s.id), [1]);
    assert.deepEqual(toggleSeatSelection([], seat(3, 1, { is_taken: 1 }), 6), []);
  });
  it('conserva la selección al cambiar de piso (la lista no depende del piso visible)', () => {
    let sel = toggleSeatSelection([], seat(1, 10), 6); // piso 1
    sel = toggleSeatSelection(sel, seat(40, 11), 6); // piso 2
    assert.deepEqual(sel.map((s) => s.deck_id), [10, 11]);
  });
});

describe('asientos · pisos', () => {
  it('cuenta los libres de cada piso (1 o 2 pisos según el layout)', () => {
    const seats = [seat(1, 10), seat(2, 10, { is_taken: 1 }), seat(3, 11), seat(4, 11), seat(5, 11, { status: 'INACTIVE' })];
    const map = freeSeatsByDeck(seats);
    assert.equal(map.get(10), 1);
    assert.equal(map.get(11), 2);
    assert.equal(freeSeatsByDeck([seat(1, 10)]).size, 1);
  });
  it('nombre del piso: el del layout o «Piso N»', () => {
    assert.equal(deckLabel({ deck_number: 2, name: null }), 'Piso 2');
    assert.equal(deckLabel({ deck_number: 1, name: 'Primer piso' }), 'Primer piso');
  });
});

describe('asientos · resumen y total', () => {
  it('mismo precio: «S/ 60 × 2»', () => {
    const r = selectionSummary([seat(12, 1), seat(13, 1)]);
    assert.equal(r.count, 2);
    assert.deepEqual(r.numbers, ['12', '13']);
    assert.equal(r.subtotal, 120);
    assert.equal(r.unitPrice, 60);
  });
  it('precios distintos por categoría: suma real, sin precio unitario', () => {
    const r = selectionSummary([seat(1, 1, { price: '60.00' }), seat(2, 1, { price: '85.50', seat_type_name: 'Cama' })]);
    assert.equal(r.subtotal, 145.5);
    assert.equal(r.unitPrice, null);
  });
  it('sin selección', () => {
    assert.deepEqual(selectionSummary([]), { count: 0, numbers: [], subtotal: 0, unitPrice: null });
  });
  it('categorías presentes con su precio', () => {
    assert.deepEqual(seatCategories([seat(1, 1), seat(2, 1, { seat_type_name: 'Cama', price: '90.00' }), seat(3, 1)]), [
      { name: 'Cama', price: 90 },
      { name: 'Semicama', price: 60 },
    ]);
  });
});
