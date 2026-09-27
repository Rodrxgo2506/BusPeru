import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addDays,
  addMonths,
  clampIso,
  compareMonths,
  formatDayMonthYearEs,
  formatLongEs,
  formatShortEs,
  isIsoDate,
  isSelectable,
  keyboardTarget,
  monthGrid,
  monthTitle,
  shiftMonths,
  weekdayIndex,
} from './calendar.ts';

describe('calendario · fechas ISO sin zona horaria', () => {
  it('valida fechas reales', () => {
    assert.equal(isIsoDate('2026-09-27'), true);
    assert.equal(isIsoDate('2026-02-30'), false);
    assert.equal(isIsoDate('27-09-2026'), false);
    assert.equal(isIsoDate(''), false);
  });

  it('suma días y meses cruzando meses y años', () => {
    assert.equal(addDays('2026-09-30', 1), '2026-10-01');
    assert.equal(addDays('2026-01-01', -1), '2025-12-31');
    assert.deepEqual(addMonths({ year: 2026, month: 11 }, 1), { year: 2027, month: 0 });
    assert.deepEqual(addMonths({ year: 2026, month: 0 }, -1), { year: 2025, month: 11 });
    assert.equal(compareMonths({ year: 2026, month: 8 }, { year: 2026, month: 9 }) < 0, true);
  });

  it('cambiar de mes conserva el día o usa el último del mes', () => {
    assert.equal(shiftMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(shiftMonths('2026-03-15', -1), '2026-02-15');
  });
});

describe('calendario · rejilla del mes (lunes primero)', () => {
  it('septiembre de 2026 empieza en martes: un hueco antes del día 1', () => {
    const grid = monthGrid({ year: 2026, month: 8 });
    assert.equal(grid[0], null);
    assert.equal(grid[1], '2026-09-01');
    assert.equal(grid.length % 7, 0);
    assert.equal(grid.filter(Boolean).length, 30);
  });

  it('el 27 de septiembre de 2026 es domingo (última columna)', () => {
    assert.equal(weekdayIndex('2026-09-27'), 6);
    const grid = monthGrid({ year: 2026, month: 8 });
    assert.equal(grid.indexOf('2026-09-27') % 7, 6);
  });

  it('un mes que empieza en lunes no tiene huecos iniciales', () => {
    assert.equal(monthGrid({ year: 2026, month: 5 })[0], '2026-06-01');
  });
});

describe('calendario · fechas permitidas', () => {
  it('bloquea fechas pasadas y respeta el máximo', () => {
    assert.equal(isSelectable('2026-09-25', '2026-09-26'), false);
    assert.equal(isSelectable('2026-09-26', '2026-09-26'), true);
    assert.equal(isSelectable('2026-12-31', '2026-09-26', '2026-12-30'), false);
    assert.equal(clampIso('2026-09-01', '2026-09-26'), '2026-09-26');
  });
});

describe('calendario · teclado', () => {
  it('flechas, inicio/fin de semana y cambio de mes/año', () => {
    assert.equal(keyboardTarget('2026-09-27', 'ArrowRight'), '2026-09-28');
    assert.equal(keyboardTarget('2026-09-27', 'ArrowUp'), '2026-09-20');
    assert.equal(keyboardTarget('2026-09-27', 'Home'), '2026-09-21');
    assert.equal(keyboardTarget('2026-09-23', 'End'), '2026-09-27');
    assert.equal(keyboardTarget('2026-09-27', 'PageDown'), '2026-10-27');
    assert.equal(keyboardTarget('2026-09-27', 'PageDown', true), '2027-09-27');
    assert.equal(keyboardTarget('2026-09-27', 'Enter'), null);
  });
});

describe('calendario · textos en español', () => {
  it('formatos de cabecera, campo y resumen', () => {
    assert.equal(monthTitle({ year: 2026, month: 8 }), 'SEP 2026');
    assert.equal(formatLongEs('2026-09-27'), 'domingo, 27 de septiembre de 2026');
    assert.equal(formatShortEs('2026-09-27'), 'dom 27 sep 2026');
    assert.equal(formatDayMonthYearEs('2026-09-27'), '27 de septiembre de 2026');
  });
});
