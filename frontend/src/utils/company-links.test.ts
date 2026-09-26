import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { companyTripsHref } from './company-links.ts';

describe('«Ver viajes» de la tarjeta de empresa', () => {
  const hoy = '2026-09-26';

  it('lleva al buscador filtrado por la empresa', () => {
    assert.equal(companyTripsHref({ id: 16 }, hoy), '/buscar?company_id=16&date=2026-09-26');
  });

  it('usa la fecha de la próxima salida si el backend la conoce; si no, la indicada', () => {
    assert.equal(companyTripsHref({ id: 16, next_departure_date: '2026-09-27' }, hoy), '/buscar?company_id=16&date=2026-09-27');
    assert.equal(companyTripsHref({ id: 16, next_departure_date: null }, hoy), '/buscar?company_id=16&date=2026-09-26');
    assert.equal(companyTripsHref({ id: 16, next_departure_date: 'mañana' }, hoy), '/buscar?company_id=16&date=2026-09-26');
  });

  it('nunca construye un enlace al perfil público (retirado)', () => {
    assert.equal(companyTripsHref({ id: 7 }, hoy).startsWith('/empresas'), false);
  });
});
