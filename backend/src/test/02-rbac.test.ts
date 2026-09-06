import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { del, get, post, put } from './helpers/api';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/** Endpoint -> permiso exigido por el backend. */
const READ_MATRIX: Array<[string, string]> = [
  ['/companies', 'companies.view'],
  ['/buses', 'buses.view'],
  ['/bus-types', 'buses.view'],
  ['/seats', 'buses.view'],
  ['/seat-types', 'buses.view'],
  ['/locations', 'routes.view'],
  ['/routes', 'routes.view'],
  ['/route-stops', 'routes.view'],
  ['/trips', 'trips.view'],
  ['/bookings', 'bookings.view'],
  ['/payments', 'payments.view'],
  ['/refunds', 'payments.view'],
  ['/promotions', 'promotions.view'],
  ['/coupons', 'promotions.view'],
  ['/reviews', 'reviews.view'],
  ['/users', 'users.view'],
  ['/roles', 'roles.view'],
  ['/permissions', 'roles.view'],
  ['/audit-logs', 'audit_logs.view'],
  ['/system-settings', 'settings.view'],
  ['/api-keys', 'settings.view'],
  ['/notification-templates', 'settings.view'],
  ['/commissions', 'reports.view'],
  ['/financial-transactions', 'reports.view'],
  ['/settlements', 'reports.view'],
  ['/reports', 'reports.view'],
];

describe('RBAC dirigido por la base de datos', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  it('los permisos provienen de role_permissions, no de código', async () => {
    const { admin, companyAdmin, operator, customer } = ctx.sessions;
    assert.equal(admin.user.permissions.length, 43, 'ADMIN debe tener los 43 permisos del dump');
    assert.equal(companyAdmin.user.permissions.length, 31, 'COMPANY_ADMIN: 30 del dump + reviews.update');
    assert.equal(operator.user.permissions.length, 15);
    assert.equal(customer.user.permissions.length, 15);
  });

  for (const role of ['admin', 'companyAdmin', 'operator', 'customer'] as const) {
    it(`respeta los permisos de lectura del rol ${role}`, async () => {
      const session = ctx.sessions[role];
      const mismatches: string[] = [];
      for (const [path, permission] of READ_MATRIX) {
        const res = await get(path, session.token);
        const allowed = session.user.permissions.includes(permission);
        const ok = allowed ? res.status === 200 : res.status === 403;
        if (!ok) mismatches.push(`${path} (${permission}, tiene=${allowed}) -> ${res.status}`);
      }
      assert.deepEqual(mismatches, []);
    });
  }

  it('deniega la escritura cuando falta el permiso', async () => {
    const cases: Array<[string, string, unknown, keyof SuiteContext['sessions']]> = [
      ['/buses', 'buses.create', { code: 'X-1', plate_number: 'XXX-999', capacity: 10 }, 'operator'],
      ['/roles', 'roles.create', { name: 'NUEVO_ROL' }, 'companyAdmin'],
      ['/system-settings', 'settings.update', { setting_key: 'x.y', setting_value: '1' }, 'companyAdmin'],
      ['/refunds', 'payments.refund', { payment_id: 1, booking_id: 1, amount: 10 }, 'operator'],
      ['/notifications/send', 'settings.update', { user_ids: [1], title: 'x', message: 'y' }, 'operator'],
    ];
    for (const [path, permission, body, role] of cases) {
      const session = ctx.sessions[role];
      assert.equal(session.user.permissions.includes(permission), false, `${role} no debería tener ${permission}`);
      const res = await post(path, body, session.token);
      assert.equal(res.status, 403, `${path} como ${role} debería dar 403`);
    }
  });

  it('protege los paneles por rol', async () => {
    assert.equal((await get('/dashboard/admin', ctx.sessions.companyAdmin.token)).status, 403);
    assert.equal((await get('/dashboard/admin', ctx.sessions.customer.token)).status, 403);
    assert.equal((await get('/dashboard/company', ctx.sessions.customer.token)).status, 403);
    assert.equal((await get('/dashboard/admin', ctx.sessions.admin.token)).status, 200);
    assert.equal((await get('/dashboard/company', ctx.sessions.companyAdmin.token)).status, 200);
    assert.equal((await get('/dashboard/customer', ctx.sessions.customer.token)).status, 200);
  });

  it('un cambio de permisos surte efecto en la petición siguiente', async () => {
    const admin = ctx.sessions.admin.token;
    const operatorToken = ctx.sessions.operator.token;

    const rol = await get('/roles/3', admin);
    const originales = rol.body.data.permissions.map((p: { id: number }) => p.id);
    const permisos = (await get('/permissions', admin)).body.data.permissions;
    const tripsView = permisos.find((p: { name: string }) => p.name === 'trips.view');

    assert.equal((await get('/trips', operatorToken)).status, 200);

    await put('/roles/3/permissions', { permission_ids: originales.filter((id: number) => id !== tripsView.id) }, admin);
    assert.equal((await get('/trips', operatorToken)).status, 403, 'debe perder el acceso de inmediato');

    await put('/roles/3/permissions', { permission_ids: originales }, admin);
    assert.equal((await get('/trips', operatorToken)).status, 200, 'y recuperarlo al restaurar');
  });

  it('impide eliminar un rol con usuarios asignados', async () => {
    assert.equal((await del('/roles/4', ctx.sessions.admin.token)).status, 409);
  });

  it('no permite a un usuario eliminar su propia cuenta', async () => {
    const res = await del(`/users/${ctx.sessions.admin.user.id}`, ctx.sessions.admin.token);
    assert.equal(res.status, 400);
  });
});
