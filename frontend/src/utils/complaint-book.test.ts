import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { complaintEventLabel } from './complaint-book.ts';

describe('Libro de Reclamaciones (utilidades)', () => {
  it('historial del Libro de Reclamaciones en castellano', () => {
    assert.equal(complaintEventLabel('STATUS_CHANGED', 'CLOSED'), 'Cambio de estado → Cerrada');
    assert.equal(complaintEventLabel('COMPANY_NOTE', null), 'Descargo de la empresa');
    assert.equal(complaintEventLabel('OTRO', 'X'), 'OTRO → X');
  });
});
