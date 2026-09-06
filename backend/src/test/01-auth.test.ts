import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { get, post, put } from './helpers/api';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';
import { TEST_PASSWORD } from './helpers/fixtures';

describe('Autenticación y sesión', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  it('inicia sesión con credenciales válidas y devuelve token y usuario', async () => {
    const res = await post('/auth/login', { email: 'admin@test.pe', password: TEST_PASSWORD });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.token);
    assert.equal(res.body.data.user.email, 'admin@test.pe');
  });

  it('nunca expone el hash de la contraseña', async () => {
    const res = await post('/auth/login', { email: 'admin@test.pe', password: TEST_PASSWORD });
    assert.equal('password_hash' in res.body.data.user, false);
    const me = await get('/auth/me', res.body.data.token);
    assert.equal('password_hash' in me.body.data, false);
  });

  it('rechaza contraseña incorrecta y usuario inexistente con el mismo mensaje', async () => {
    const badPassword = await post('/auth/login', { email: 'admin@test.pe', password: 'Incorrecta9' });
    const unknownUser = await post('/auth/login', { email: 'no-existe@test.pe', password: TEST_PASSWORD });
    assert.equal(badPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    // No debe permitir enumerar qué correos existen.
    assert.equal(badPassword.body.message, unknownUser.body.message);
  });

  it('valida el formato del correo y el cuerpo vacío', async () => {
    assert.equal((await post('/auth/login', { email: 'no-es-correo', password: 'x' })).status, 422);
    assert.equal((await post('/auth/login', {})).status, 422);
  });

  it('rechaza peticiones sin token, con token inválido o manipulado', async () => {
    assert.equal((await get('/auth/me')).status, 401);
    assert.equal((await get('/auth/me', 'token.falso')).status, 401);

    const valid = (await post('/auth/login', { email: 'admin@test.pe', password: TEST_PASSWORD })).body.data.token;
    assert.equal((await get('/auth/me', `${valid.slice(0, -3)}aaa`)).status, 401);
  });

  it('rechaza un JWT firmado con otra clave', async () => {
    const foreign =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjEsInJvbGVJZCI6MSwicm9sZSI6IkFETUlOIn0.' +
      'ZmlybWEtaW52YWxpZGEtcGFyYS1lc3RhLWFwaQ';
    assert.equal((await get('/auth/me', foreign)).status, 401);
  });

  it('devuelve permisos y empresas del usuario autenticado', async () => {
    const me = await get('/auth/me', ctx.sessions.companyAdmin.token);
    assert.equal(me.status, 200);
    assert.ok(Array.isArray(me.body.data.permissions));
    assert.deepEqual(me.body.data.companyIds, [ctx.fixtures.companyA]);
  });

  it('exige sesión en todos los endpoints privados', async () => {
    const paths = [
      '/users', '/roles', '/permissions', '/companies', '/buses', '/bus-types', '/seats', '/seat-types',
      '/locations', '/routes', '/route-stops', '/trips', '/bookings', '/payments', '/refunds', '/reviews',
      '/notifications', '/support/tickets', '/financial-transactions', '/settlements', '/audit-logs',
      '/api-keys', '/system-settings', '/commissions', '/promotions', '/coupons', '/notification-templates',
      '/reports', '/dashboard/admin', '/dashboard/company', '/dashboard/customer',
    ];
    const unprotected: string[] = [];
    for (const path of paths) {
      const res = await get(path);
      if (res.status !== 401) unprotected.push(`${path} -> ${res.status}`);
    }
    assert.deepEqual(unprotected, []);
  });

  it('permite los endpoints públicos sin sesión', async () => {
    const paths = ['/public/cities', '/public/terminals', '/public/companies', '/public/trips',
      '/public/destinations', '/public/promotions', '/public/reviews', '/public/settings', '/public/stats'];
    for (const path of paths) {
      assert.equal((await get(path)).status, 200, `${path} debería responder 200`);
    }
  });

  it('solo expone en /public/settings las claves marcadas is_public', async () => {
    const res = await get('/public/settings');
    const keys = Object.keys(res.body.data ?? {});
    assert.ok(keys.includes('booking.service_fee'));
    assert.equal(keys.includes('booking.hold_minutes'), false);
  });

  it('bloquea el inicio de sesión de cuentas PENDING con un mensaje claro', async () => {
    const stamp = Date.now().toString().slice(-9);
    const email = `pendiente-${stamp}@test.pe`;
    const registro = await post('/auth/register/company', {
      company: { name: 'Pendiente SAC', legal_name: 'Pendiente SAC', tax_id: `20${stamp}`, email: `emp-${stamp}@test.pe` },
      admin: { first_name: 'Pen', last_name: 'Diente', email, password: TEST_PASSWORD },
    });
    assert.equal(registro.status, 201);

    const bloqueado = await post('/auth/login', { email, password: TEST_PASSWORD });
    assert.equal(bloqueado.status, 403);
    assert.match(bloqueado.body.message ?? '', /pendiente de aprobación/i);
  });

  it('al aprobar la empresa activa a su administrador y este puede operar', async () => {
    const stamp = Date.now().toString().slice(-9);
    const email = `aprobado-${stamp}@test.pe`;
    const registro = await post('/auth/register/company', {
      company: { name: 'Aprobada SAC', legal_name: 'Aprobada SAC', tax_id: `21${stamp}`, email: `emp2-${stamp}@test.pe` },
      admin: { first_name: 'Apro', last_name: 'Bada', email, password: TEST_PASSWORD },
    });
    const companyId = registro.body.data.companyId;

    await put(`/companies/${companyId}`, { status: 'ACTIVE' }, ctx.sessions.admin.token);

    const sesion = await post('/auth/login', { email, password: TEST_PASSWORD });
    assert.equal(sesion.status, 200);
    assert.equal((await get('/auth/me', sesion.body.data.token)).status, 200);
    assert.equal((await get('/buses', sesion.body.data.token)).status, 200);
  });

  it('impide registrar un correo ya existente', async () => {
    const dup = await post('/auth/register', {
      first_name: 'Duplicado', last_name: 'Prueba', email: 'cliente@test.pe', password: TEST_PASSWORD,
    });
    assert.equal(dup.status, 409);
  });

  it('impide registrar una empresa con un RUC ya existente', async () => {
    const stamp = Date.now().toString().slice(-9);
    const dup = await post('/auth/register/company', {
      // 20111111111 es el RUC de la Empresa A de las fixtures.
      company: { name: 'Otra', legal_name: 'Otra SAC', tax_id: '20111111111', email: `otra-${stamp}@test.pe` },
      admin: { first_name: 'Otra', last_name: 'Empresa', email: `otra-admin-${stamp}@test.pe`, password: TEST_PASSWORD },
    });
    assert.equal(dup.status, 409);
  });

  it('exige contraseñas con mayúscula y número', async () => {
    const weak = await post('/auth/register', {
      first_name: 'Debil', last_name: 'Prueba', email: `debil-${Date.now()}@test.pe`, password: 'todominuscula',
    });
    assert.equal(weak.status, 422);
  });

  it('permite actualizar el perfil y cambiar la contraseña validando la actual', async () => {
    const token = ctx.sessions.customer.token;
    const update = await put('/auth/me', { phone: '+51 900 000 000' }, token);
    assert.equal(update.status, 200);
    assert.equal(update.body.data.phone, '+51 900 000 000');

    assert.equal((await put('/auth/me/password', { current_password: 'Incorrecta9', new_password: 'NuevaClave1' }, token)).status, 400);
    assert.equal((await put('/auth/me/password', { current_password: TEST_PASSWORD, new_password: 'corta' }, token)).status, 422);
  });
});
