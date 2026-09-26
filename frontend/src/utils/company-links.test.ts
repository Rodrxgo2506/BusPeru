import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { companyCardActions } from './company-links.ts';

describe('F18-19D · acciones de la tarjeta de empresa', () => {
  const hoy = '2026-09-26';

  it('con perfil aprobado ofrece «Ver perfil» hacia /empresas/<slug del backend>', () => {
    const a = companyCardActions({ id: 16, name: 'BusPerú Demo', slug: 'busperu-demo' }, hoy);
    assert.equal(a.profile?.label, 'Ver perfil');
    assert.equal(a.profile?.href, '/empresas/busperu-demo');
  });

  it('«Ver viajes» conserva su destino (buscador filtrado por la empresa y la fecha)', () => {
    const conPerfil = companyCardActions({ id: 16, name: 'BusPerú Demo', slug: 'busperu-demo' }, hoy);
    const sinPerfil = companyCardActions({ id: 16, name: 'BusPerú Demo', slug: null }, hoy);
    for (const a of [conPerfil, sinPerfil]) {
      assert.equal(a.trips.label, 'Ver viajes');
      assert.equal(a.trips.href, '/buscar?company_id=16&date=2026-09-26');
    }
  });

  it('sin perfil (slug null, ausente o vacío) no hay «Ver perfil» ni URL construida', () => {
    for (const slug of [null, undefined, '', '   ']) {
      const a = companyCardActions({ id: 7, name: 'Empresa Sin Perfil', slug }, hoy);
      assert.equal(a.profile, null, `slug ${JSON.stringify(slug)}`);
    }
  });

  it('nunca deriva el slug del nombre: solo usa el que entrega el backend', () => {
    const a = companyCardActions({ id: 7, name: 'Empresa Con Nombre Largo', slug: 'slug-real-del-backend' }, hoy);
    assert.equal(a.profile?.href, '/empresas/slug-real-del-backend');
    assert.equal(companyCardActions({ id: 7, name: 'Empresa Con Nombre Largo' }, hoy).profile, null);
  });

  it('«Ver viajes» abre la fecha de la próxima salida si el backend la conoce; si no, la fecha indicada', () => {
    assert.equal(companyCardActions({ id: 16, name: 'D', slug: null, next_departure_date: '2026-09-27' }, hoy).trips.href, '/buscar?company_id=16&date=2026-09-27');
    assert.equal(companyCardActions({ id: 16, name: 'D', slug: null, next_departure_date: null }, hoy).trips.href, '/buscar?company_id=16&date=2026-09-26');
    assert.equal(companyCardActions({ id: 16, name: 'D', slug: null, next_departure_date: 'mañana' }, hoy).trips.href, '/buscar?company_id=16&date=2026-09-26');
  });

  it('los enlaces tienen nombre accesible con la empresa', () => {
    const a = companyCardActions({ id: 16, name: 'BusPerú Demo', slug: 'busperu-demo' }, hoy);
    assert.equal(a.profile?.ariaLabel, 'Ver el perfil de BusPerú Demo');
    assert.equal(a.trips.ariaLabel, 'Ver los viajes de BusPerú Demo');
  });

  it('codifica el slug al construir la ruta (defensa en profundidad)', () => {
    assert.equal(companyCardActions({ id: 1, name: 'X', slug: 'a b' }, hoy).profile?.href, '/empresas/a%20b');
  });
});
