import './helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { get, post, put } from './helpers/api';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * Listado público de empresas (/empresas) tras retirar los perfiles públicos de F18-19: cada empresa se muestra con
 * sus datos básicos y la acción «Ver viajes» (buscador de la empresa en la fecha de hoy, como antes de F18-19). No hay
 * perfil público, ni panel de edición, ni moderación de perfiles.
 * Las tablas de la migración 020 siguen en la base de datos (no se borra nada), pero ningún endpoint las usa.
 */
describe('Listado público de empresas (sin perfiles públicos)', () => {
  let ctx: SuiteContext;
  const token = (role: keyof SuiteContext['sessions']) => ctx.sessions[role].token;
  type Company = { id: number; name: string; description: string | null; logo_url: string | null; routes_count: number };
  const empresas = async () => (await get('/public/companies')).body.data as Company[];

  before(async () => {
    ctx = await prepareSuite();
  });
  after(async () => {
    await teardownSuite();
  });

  it('lista las empresas activas con sus datos básicos y rutas', async () => {
    const res = await get('/public/companies');
    assert.equal(res.status, 200);
    const lista = res.body.data as Company[];
    for (const id of [ctx.fixtures.companyA, ctx.fixtures.companyB]) {
      const empresa = lista.find((c) => c.id === id);
      assert.ok(empresa, `empresa ${id} en el listado`);
      assert.equal(typeof empresa.name, 'string');
      assert.ok(Number(empresa.routes_count) >= 1);
    }
  });

  it('el listado ya no expone datos del perfil público (slug ni lema)', async () => {
    for (const empresa of await empresas()) {
      assert.equal('slug' in empresa, false);
      assert.equal('tagline' in empresa, false);
    }
  });

  it('el listado vuelve a ser el de antes de F18-19: sin fecha de próxima salida («Ver viajes» usa la fecha de hoy)', async () => {
    const lista = await empresas();
    assert.ok(lista.length > 0);
    for (const empresa of lista) assert.equal('next_departure_date' in empresa, false);
  });

  it('no existe el perfil público de una empresa ni sus subrecursos', async () => {
    for (const ruta of ['/public/companies/empresa-a', '/public/companies/empresa-a/gallery', '/public/companies/empresa-a/reviews']) {
      assert.equal((await get(ruta)).status, 404, ruta);
    }
  });

  it('no existen el panel de edición del perfil ni la moderación de perfiles', async () => {
    assert.equal((await get('/company/profile', token('companyAdmin'))).status, 404);
    assert.equal((await put('/company/profile', { tagline: 'x' }, token('companyAdmin'))).status, 404);
    assert.equal((await get('/company/profile/preview', token('companyAdmin'))).status, 404);
    assert.equal((await get('/admin/company-profiles', token('admin'))).status, 404);
    assert.equal((await post(`/admin/company-profiles/${ctx.fixtures.companyA}/moderation`, { entity: 'profile', action: 'approve' }, token('admin'))).status, 404);
  });

  it('el Libro de Reclamaciones y los datos legales siguen disponibles', async () => {
    assert.equal((await get('/public/legal')).status, 200);
    assert.equal((await get('/admin/complaints', token('admin'))).status, 200);
    assert.equal((await get('/company/complaints', token('companyAdmin'))).status, 200);
  });
});
