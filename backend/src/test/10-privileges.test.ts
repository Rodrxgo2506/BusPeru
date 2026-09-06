import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { del, get, post, put } from './helpers/api';
import { execute, queryOne } from '../config/database';
import { at, freeSeats, login, TEST_PASSWORD } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * Límites de privilegio detectados en la auditoría del Portal Empresa y el Panel Admin:
 * escalada de rol al crear/editar usuarios y escritura sobre catálogos globales
 * (terminales, tipos de bus y de asiento) que no tienen `company_id`.
 */
describe('Límites de privilegio de los roles de empresa', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  /**
   * Vuelve a iniciar sesión y sustituye el token guardado.
   *
   * Desde BP-18 un cambio de contraseña invalida los tokens emitidos antes, así que el
   * test que cambia una contraseña tiene que renovar la sesión que siga usando después.
   * Es exactamente lo que hará un usuario real.
   */
  async function refrescarSesion(clave: 'customer' | 'operator', email: string): Promise<void> {
    ctx.sessions[clave] = await login(email);
  }

  async function roleId(name: string): Promise<number> {
    const row = await queryOne<{ id: number }>('SELECT id FROM roles WHERE name = ?', [name]);
    assert.ok(row, `falta el rol ${name}`);
    return row!.id;
  }

  describe('Asignación de roles', () => {
    it('un COMPANY_ADMIN no puede crear un usuario con rol ADMIN', async () => {
      const res = await post(
        '/users',
        {
          first_name: 'Intento',
          last_name: 'Escalada',
          email: `escalada-${Date.now()}@test.pe`,
          password: 'PruebaSegura1',
          role_id: await roleId('ADMIN'),
          status: 'ACTIVE',
        },
        ctx.sessions.companyAdmin.token,
      );

      assert.equal(res.status, 403);
      const creado = await queryOne('SELECT id FROM users WHERE email = ?', [res.body?.data?.email ?? '']);
      assert.equal(creado, null, 'no debe quedar ningún usuario creado');
    });

    it('un COMPANY_ADMIN sí puede crear un OPERATOR de su propia empresa', async () => {
      const res = await post(
        '/users',
        {
          first_name: 'Operador',
          last_name: 'Legítimo',
          email: `operador-${Date.now()}@test.pe`,
          password: 'PruebaSegura1',
          role_id: await roleId('OPERATOR'),
          status: 'ACTIVE',
        },
        ctx.sessions.companyAdmin.token,
      );

      assert.equal(res.status, 201);
      assert.equal(Number(res.body.data.company_id), ctx.fixtures.companyA);
    });

    it('un COMPANY_ADMIN no puede promover a ADMIN a un usuario de su empresa', async () => {
      const res = await put(
        `/users/${ctx.fixtures.users.operator}`,
        { role_id: await roleId('ADMIN') },
        ctx.sessions.companyAdmin.token,
      );

      assert.equal(res.status, 403);
      const operador = await queryOne<{ role_id: number }>('SELECT role_id FROM users WHERE id = ?', [
        ctx.fixtures.users.operator,
      ]);
      assert.equal(Number(operador?.role_id), await roleId('OPERATOR'), 'el rol no debe cambiar');
    });

    it('el ADMIN de la plataforma sí puede asignar cualquier rol', async () => {
      const res = await post(
        '/users',
        {
          first_name: 'Nuevo',
          last_name: 'Administrador',
          email: `admin-${Date.now()}@test.pe`,
          password: 'PruebaSegura1',
          role_id: await roleId('ADMIN'),
          status: 'ACTIVE',
        },
        ctx.sessions.admin.token,
      );
      assert.equal(res.status, 201);
    });
  });

  describe('Catálogos globales sin company_id', () => {
    const catalogos: Array<[string, Record<string, unknown>]> = [
      ['/locations', { name: 'Terminal intrusa', city: 'Lima', type: 'TERMINAL', status: 'ACTIVE' }],
      ['/bus-types', { name: 'Tipo intruso', default_capacity: 40, status: 'ACTIVE' }],
      ['/seat-types', { name: 'Asiento intruso' }],
    ];

    for (const [ruta, cuerpo] of catalogos) {
      it(`un COMPANY_ADMIN puede leer pero no crear en ${ruta}`, async () => {
        assert.equal((await get(`${ruta}?limit=1`, ctx.sessions.companyAdmin.token)).status, 200, 'la lectura sigue permitida');
        assert.equal((await post(ruta, cuerpo, ctx.sessions.companyAdmin.token)).status, 403);
      });
    }

    it('un COMPANY_ADMIN no puede editar ni borrar una terminal compartida', async () => {
      const terminal = at(ctx.fixtures.locations, 0);
      assert.equal((await put(`/locations/${terminal}`, { name: 'Renombrada' }, ctx.sessions.companyAdmin.token)).status, 403);
      assert.equal((await del(`/locations/${terminal}`, ctx.sessions.companyAdmin.token)).status, 403);

      const fila = await queryOne<{ id: number }>('SELECT id FROM locations WHERE id = ?', [terminal]);
      assert.ok(fila, 'la terminal debe seguir existiendo');
    });

    it('el ADMIN de la plataforma mantiene la gestión de los catálogos', async () => {
      const creada = await post(
        '/locations',
        { name: 'Terminal del admin', city: 'Cusco', type: 'TERMINAL', status: 'ACTIVE' },
        ctx.sessions.admin.token,
      );
      assert.equal(creada.status, 201);
      assert.equal((await put(`/locations/${creada.body.data.id}`, { name: 'Terminal renombrada' }, ctx.sessions.admin.token)).status, 200);
      assert.equal((await del(`/locations/${creada.body.data.id}`, ctx.sessions.admin.token)).status, 200);
    });
  });

  describe('Alta de empresas', () => {
    it('un COMPANY_ADMIN no puede dar de alta una empresa nueva', async () => {
      const antes = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM companies');
      const res = await post(
        '/companies',
        {
          name: 'Empresa fantasma',
          legal_name: 'Empresa Fantasma S.A.C.',
          tax_id: '20999999999',
          email: 'fantasma@test.pe',
          status: 'ACTIVE',
        },
        ctx.sessions.companyAdmin.token,
      );

      assert.equal(res.status, 403);
      const despues = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM companies');
      assert.equal(Number(despues?.total), Number(antes?.total), 'no debe quedar ninguna fila huérfana');
    });

    it('un COMPANY_ADMIN no puede eliminar empresas', async () => {
      assert.equal((await del(`/companies/${ctx.fixtures.companyA}`, ctx.sessions.companyAdmin.token)).status, 403);
    });

    it('un COMPANY_ADMIN sí puede editar la ficha de su propia empresa', async () => {
      const res = await put(`/companies/${ctx.fixtures.companyA}`, { phone: '+51 900 000 000' }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.phone, '+51 900 000 000');
    });

    it('pero no la de otra empresa', async () => {
      assert.equal((await put(`/companies/${ctx.fixtures.companyB}`, { phone: '+51 911 111 111' }, ctx.sessions.companyAdmin.token)).status, 404);
    });
  });

  describe('Paradas de ruta', () => {
    it('una empresa gestiona las paradas de su ruta pero no las de otra', async () => {
      const propia = await post(
        '/route-stops',
        { route_id: ctx.fixtures.routeA, location_id: at(ctx.fixtures.locations, 2), stop_order: 1, arrival_offset_minutes: 90 },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(propia.status, 201);

      const ajena = await post(
        '/route-stops',
        { route_id: ctx.fixtures.routeB, location_id: at(ctx.fixtures.locations, 2), stop_order: 1 },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(ajena.status, 403, 'no puede añadir paradas a la ruta de otra empresa');

      const listado = await get(`/route-stops?route_id=${ctx.fixtures.routeB}`, ctx.sessions.companyAdmin.token);
      assert.deepEqual(listado.body.data, [], 'ni verlas');
    });
  });
  describe('Superficie de información y perfil propio', () => {
    it('un viaje ajeno responde 404 y no 403, para no confirmar que existe', async () => {
      for (const ruta of [`/trips/${ctx.fixtures.tripB}`, `/trips/${ctx.fixtures.tripB}/seats`, `/trips/${ctx.fixtures.tripB}/passengers`]) {
        const res = await get(ruta, ctx.sessions.companyAdmin.token);
        assert.equal(res.status, 404, `${ruta} debería responder 404`);
      }
      assert.equal((await get(`/trips/${ctx.fixtures.tripA}`, ctx.sessions.companyAdmin.token)).status, 200, 'el viaje propio sigue accesible');
    });

    it('PUT /auth/me solo escribe los campos del perfil', async () => {
      const antes = (await get('/auth/me', ctx.sessions.customer.token)).body.data;

      const res = await put(
        '/auth/me',
        { first_name: 'Nombre', role_id: 1, status: 'SUSPENDED', password_hash: 'inyectado', email: 'otro@test.pe' },
        ctx.sessions.customer.token,
      );
      assert.equal(res.status, 200);

      const despues = (await get('/auth/me', ctx.sessions.customer.token)).body.data;
      assert.equal(despues.first_name, 'Nombre', 'el nombre sí debe cambiar');
      assert.equal(Number(despues.role_id), Number(antes.role_id), 'el rol no puede cambiarse desde el perfil');
      assert.equal(despues.status, antes.status, 'el estado no puede cambiarse desde el perfil');
      assert.equal(despues.email, antes.email, 'el correo no puede cambiarse desde el perfil');

      const fila = await queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [antes.id]);
      assert.notEqual(fila?.password_hash, 'inyectado', 'el hash no puede escribirse desde el perfil');
    });

    it('la sesión sigue siendo valida tras editar el perfil', async () => {
      assert.equal((await get('/bookings?limit=1', ctx.sessions.customer.token)).status, 200);
    });
  });

  /**
   * Regresión de la auditoría del 06/09/2026.
   *
   * BP-01 · un CUSTOMER se promovía a COMPANY_ADMIN con `PUT /users/:id {"role_id": …}`:
   *         tiene `users.update`, su alcance es su propia fila y `assertAssignableRole`
   *         solo cerraba el paso al rol ADMIN.
   * BP-03 · el mismo endpoint aceptaba `password` sin pedir la actual, anulando la
   *         comprobación de `PUT /auth/me/password`.
   *
   * Los dos ataques se reproducen tal como los ejecutó la auditoría, y a continuación se
   * comprueba que las operaciones administrativas legítimas siguen funcionando.
   */
  describe('BP-01 · nadie cambia su propio rol', () => {
    async function intentaAutoPromoverse(rol: string) {
      const customer = ctx.sessions.customer;
      const res = await put(`/users/${customer.user.id}`, { role_id: await roleId(rol) }, customer.token);
      const fila = await queryOne<{ role_id: number }>('SELECT role_id FROM users WHERE id = ?', [customer.user.id]);
      return { res, roleIdEnBase: Number(fila?.role_id) };
    }

    it('un CUSTOMER no puede promoverse a COMPANY_ADMIN', async () => {
      const { res, roleIdEnBase } = await intentaAutoPromoverse('COMPANY_ADMIN');
      assert.equal(res.status, 403);
      assert.equal(roleIdEnBase, await roleId('CUSTOMER'), 'el rol debe seguir siendo CUSTOMER');
    });

    it('tampoco a OPERATOR', async () => {
      const { res, roleIdEnBase } = await intentaAutoPromoverse('OPERATOR');
      assert.equal(res.status, 403);
      assert.equal(roleIdEnBase, await roleId('CUSTOMER'));
    });

    it('tampoco a ADMIN', async () => {
      const { res, roleIdEnBase } = await intentaAutoPromoverse('ADMIN');
      assert.equal(res.status, 403);
      assert.equal(roleIdEnBase, await roleId('CUSTOMER'));
    });

    it('un COMPANY_ADMIN tampoco puede cambiarse el rol a sí mismo', async () => {
      const actor = ctx.sessions.companyAdmin;
      const res = await put(`/users/${actor.user.id}`, { role_id: await roleId('OPERATOR') }, actor.token);
      assert.equal(res.status, 403);

      const fila = await queryOne<{ role_id: number }>('SELECT role_id FROM users WHERE id = ?', [actor.user.id]);
      assert.equal(Number(fila?.role_id), await roleId('COMPANY_ADMIN'));
    });

    it('ni un ADMIN, que también necesita que sea otro quien le cambie el rol', async () => {
      const actor = ctx.sessions.admin;
      const res = await put(`/users/${actor.user.id}`, { role_id: await roleId('CUSTOMER') }, actor.token);
      assert.equal(res.status, 403);

      const fila = await queryOne<{ role_id: number }>('SELECT role_id FROM users WHERE id = ?', [actor.user.id]);
      assert.equal(Number(fila?.role_id), await roleId('ADMIN'), 'el ADMIN no puede degradarse por accidente');
    });

    it('el rechazo no escribe ningún otro campo de la misma petición', async () => {
      const customer = ctx.sessions.customer;
      const antes = (await get('/auth/me', customer.token)).body.data;

      const res = await put(
        `/users/${customer.user.id}`,
        { role_id: await roleId('COMPANY_ADMIN'), first_name: 'Colada', phone: '+51 999 000 111' },
        customer.token,
      );
      assert.equal(res.status, 403);

      const despues = (await get('/auth/me', customer.token)).body.data;
      assert.equal(despues.first_name, antes.first_name, 'la petición se rechaza entera, no a medias');
      assert.equal(despues.phone, antes.phone);
    });

    it('reenviar el propio rol sin cambiarlo no es una escalada y se admite', async () => {
      const customer = ctx.sessions.customer;
      const res = await put(
        `/users/${customer.user.id}`,
        { role_id: await roleId('CUSTOMER'), first_name: 'Clara' },
        customer.token,
      );
      assert.equal(res.status, 200, 'el formulario del panel reenvía la fila completa al editar');

      const fila = await queryOne<{ role_id: number; first_name: string }>(
        'SELECT role_id, first_name FROM users WHERE id = ?',
        [customer.user.id],
      );
      assert.equal(Number(fila?.role_id), await roleId('CUSTOMER'));
      assert.equal(fila?.first_name, 'Clara');
    });

    it('el endpoint no ofrece ninguna otra vía para ganar privilegios', async () => {
      const customer = ctx.sessions.customer;

      // `company_id` no está en el esquema de actualización: enviarlo no vincula la cuenta
      // a ninguna empresa, que es lo que convertiría un rol de empresa en acceso real.
      const conEmpresa = await put(
        `/users/${customer.user.id}`,
        { company_id: ctx.fixtures.companyA, position: 'Gerente' },
        customer.token,
      );
      assert.equal(conEmpresa.status, 400, 'sin campos escribibles, no hay nada que actualizar');

      const vinculo = await queryOne<{ total: number }>(
        'SELECT COUNT(*) AS total FROM company_users WHERE user_id = ?',
        [customer.user.id],
      );
      assert.equal(Number(vinculo?.total), 0, 'la cuenta no puede autoasociarse a una empresa');

      // Y su alcance sigue siendo su propia fila: sobre otro usuario responde 404.
      const ajeno = await put(
        `/users/${ctx.sessions.operator.user.id}`,
        { role_id: await roleId('ADMIN') },
        customer.token,
      );
      assert.equal(ajeno.status, 404, 'un usuario ajeno ni siquiera se confirma que exista');
    });

    it('un ADMIN sí puede cambiar el rol de OTRO usuario', async () => {
      const objetivo = ctx.sessions.operator.user.id;
      const original = await roleId('OPERATOR');

      const promocion = await put(`/users/${objetivo}`, { role_id: await roleId('COMPANY_ADMIN') }, ctx.sessions.admin.token);
      assert.equal(promocion.status, 200);
      assert.equal(Number(promocion.body.data.role_id), await roleId('COMPANY_ADMIN'));

      const vuelta = await put(`/users/${objetivo}`, { role_id: original }, ctx.sessions.admin.token);
      assert.equal(vuelta.status, 200);
      assert.equal(Number(vuelta.body.data.role_id), original);
    });

    it('y puede editar su propia ficha mientras el formulario reenvía su rol', async () => {
      const admin = ctx.sessions.admin;
      const res = await put(
        `/users/${admin.user.id}`,
        { role_id: await roleId('ADMIN'), phone: '+51 900 111 222' },
        admin.token,
      );
      assert.equal(res.status, 200, 'la gestión de usuarios del panel no debe romperse');
      assert.equal(res.body.data.phone, '+51 900 111 222');
    });
  });

  describe('BP-03 · la contraseña propia no se cambia desde la gestión de usuarios', () => {
    const CLAVE_INTRUSA = 'OtraClaveNueva9';

    it('un CUSTOMER no puede fijarse una contraseña nueva por PUT /users/:id', async () => {
      const customer = ctx.sessions.customer;
      const hashAntes = await queryOne<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = ?',
        [customer.user.id],
      );

      const res = await put(`/users/${customer.user.id}`, { password: CLAVE_INTRUSA }, customer.token);
      assert.equal(res.status, 403);

      const hashDespues = await queryOne<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = ?',
        [customer.user.id],
      );
      assert.equal(hashDespues?.password_hash, hashAntes?.password_hash, 'el hash no puede haberse tocado');

      const conIntrusa = await post('/auth/login', { email: 'cliente@test.pe', password: CLAVE_INTRUSA });
      assert.equal(conIntrusa.status, 401, 'la contraseña del atacante no debe servir');

      const conOriginal = await post('/auth/login', { email: 'cliente@test.pe', password: TEST_PASSWORD });
      assert.equal(conOriginal.status, 200, 'la contraseña original sigue siendo la buena');
    });

    it('ni acompañada de otros campos legítimos', async () => {
      const customer = ctx.sessions.customer;
      const res = await put(
        `/users/${customer.user.id}`,
        { first_name: 'Clara', password: CLAVE_INTRUSA },
        customer.token,
      );
      assert.equal(res.status, 403);
      assert.equal(
        (await post('/auth/login', { email: 'cliente@test.pe', password: CLAVE_INTRUSA })).status,
        401,
      );
    });

    it('el camino correcto sigue funcionando con la contraseña actual', async () => {
      const nueva = 'ClavePropia2026';
      const cambio = await put(
        '/auth/me/password',
        { current_password: TEST_PASSWORD, new_password: nueva },
        ctx.sessions.customer.token,
      );
      assert.equal(cambio.status, 200);

      // El token con el que se hizo el cambio queda invalidado (BP-18); hay que volver a
      // entrar con la contraseña nueva para seguir operando.
      assert.equal(
        (await put('/auth/me/password', { current_password: nueva, new_password: 'OtraMas1' }, ctx.sessions.customer.token)).status,
        401,
        'la sesión anterior al cambio ya no vale',
      );

      const conNueva = await post('/auth/login', { email: 'cliente@test.pe', password: nueva });
      assert.equal(conNueva.status, 200);

      const vuelta = await put(
        '/auth/me/password',
        { current_password: nueva, new_password: TEST_PASSWORD },
        conNueva.body.data.token,
      );
      assert.equal(vuelta.status, 200);
      assert.equal((await post('/auth/login', { email: 'cliente@test.pe', password: TEST_PASSWORD })).status, 200);
      await refrescarSesion('customer', 'cliente@test.pe');
    });

    it('y sigue rechazando una contraseña actual incorrecta', async () => {
      const res = await put(
        '/auth/me/password',
        { current_password: 'NoEsLaMia1', new_password: 'LaQueQuiera1' },
        ctx.sessions.customer.token,
      );
      assert.equal(res.status, 400);
      assert.equal((await post('/auth/login', { email: 'cliente@test.pe', password: TEST_PASSWORD })).status, 200);
    });

    it('un ADMIN conserva el restablecimiento de la contraseña de OTRO usuario', async () => {
      const objetivo = ctx.sessions.operator.user.id;
      const asignada = 'RestablecidaAdmin1';

      const res = await put(`/users/${objetivo}`, { password: asignada }, ctx.sessions.admin.token);
      assert.equal(res.status, 200, 'la operación administrativa legítima no se ha roto');
      assert.equal((await post('/auth/login', { email: 'operador-a@test.pe', password: asignada })).status, 200);

      const vuelta = await put(`/users/${objetivo}`, { password: TEST_PASSWORD }, ctx.sessions.admin.token);
      assert.equal(vuelta.status, 200);
      assert.equal((await post('/auth/login', { email: 'operador-a@test.pe', password: TEST_PASSWORD })).status, 200);

      // El restablecimiento administrativo también invalida las sesiones del afectado.
      await refrescarSesion('operator', 'operador-a@test.pe');
    });

    it('un CUSTOMER no puede restablecer la contraseña de otro usuario', async () => {
      const res = await put(
        `/users/${ctx.sessions.operator.user.id}`,
        { password: CLAVE_INTRUSA },
        ctx.sessions.customer.token,
      );
      assert.equal(res.status, 404, 'fuera de su alcance: ni se confirma que el usuario exista');
      assert.equal(
        (await post('/auth/login', { email: 'operador-a@test.pe', password: CLAVE_INTRUSA })).status,
        401,
      );
    });
  });

  /**
   * BP-02 · regresión de la auditoría del 06/09/2026.
   *
   * `status` y `tax_id` estaban entre las columnas escribibles de `companies`, y
   * `adminOnlyActions` solo cubría el alta y la baja. Como suspender una empresa no le
   * quita la sesión a su administrador, este deshacía la sanción con una petición.
   */
  describe('BP-02 · el estado y el RUC de la empresa son de la plataforma', () => {
    /** Suspende la empresa A, ejecuta la comprobación y la deja como estaba. */
    async function conEmpresaSuspendida(comprobacion: () => Promise<void>): Promise<void> {
      await execute("UPDATE companies SET status = 'SUSPENDED' WHERE id = ?", [ctx.fixtures.companyA]);
      try {
        await comprobacion();
      } finally {
        await execute("UPDATE companies SET status = 'ACTIVE' WHERE id = ?", [ctx.fixtures.companyA]);
      }
    }

    async function estadoEmpresaA() {
      return queryOne<{ status: string; tax_id: string | null; name: string; phone: string | null }>(
        'SELECT status, tax_id, name, phone FROM companies WHERE id = ?',
        [ctx.fixtures.companyA],
      );
    }

    it('un COMPANY_ADMIN no puede reactivar su propia empresa suspendida', async () => {
      await conEmpresaSuspendida(async () => {
        const res = await put(`/companies/${ctx.fixtures.companyA}`, { status: 'ACTIVE' }, ctx.sessions.companyAdmin.token);
        assert.equal(res.status, 403);
        assert.equal((await estadoEmpresaA())?.status, 'SUSPENDED', 'la sanción debe seguir en pie');
      });
    });

    it('tampoco puede darse de baja a sí misma', async () => {
      const res = await put(`/companies/${ctx.fixtures.companyA}`, { status: 'INACTIVE' }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 403);
      assert.equal((await estadoEmpresaA())?.status, 'ACTIVE');
    });

    it('ni cambiar el RUC verificado', async () => {
      const res = await put(`/companies/${ctx.fixtures.companyA}`, { tax_id: '20999999999' }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 403);
      assert.equal((await estadoEmpresaA())?.tax_id, '20111111111');
    });

    it('mezclarlo con campos legítimos no abre ningún bypass', async () => {
      const antes = await estadoEmpresaA();

      const res = await put(
        `/companies/${ctx.fixtures.companyA}`,
        { name: 'Nombre colado', phone: '+51 900 123 456', status: 'ACTIVE', tax_id: '20999999999' },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(res.status, 403);

      const despues = await estadoEmpresaA();
      assert.equal(despues?.name, antes?.name, 'la petición se rechaza entera');
      assert.equal(despues?.phone, antes?.phone);
      assert.equal(despues?.tax_id, antes?.tax_id);
    });

    it('pero sigue editando la ficha de su empresa con normalidad', async () => {
      const res = await put(
        `/companies/${ctx.fixtures.companyA}`,
        { name: 'Empresa A', email: 'contacto-a@test.pe', phone: '+51 955 000 111', description: 'Transporte interprovincial' },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.data.phone, '+51 955 000 111');
      assert.equal(res.body.data.email, 'contacto-a@test.pe');
    });

    it('y puede guardar el formulario completo, que reenvía el RUC sin cambiarlo', async () => {
      const actual = await estadoEmpresaA();
      const res = await put(
        `/companies/${ctx.fixtures.companyA}`,
        { name: actual?.name, tax_id: actual?.tax_id, phone: '+51 955 222 333' },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(res.status, 200, 'el Portal Empresa reenvía la ficha entera al guardar');
      assert.equal(res.body.data.phone, '+51 955 222 333');
    });

    it('un OPERATOR no gana ninguna capacidad: sigue sin poder escribir', async () => {
      assert.equal((await put(`/companies/${ctx.fixtures.companyA}`, { phone: '+51 999 999 999' }, ctx.sessions.operator.token)).status, 403);
      assert.equal((await put(`/companies/${ctx.fixtures.companyA}`, { status: 'INACTIVE' }, ctx.sessions.operator.token)).status, 403);
    });

    it('un CUSTOMER tampoco', async () => {
      assert.equal((await put(`/companies/${ctx.fixtures.companyA}`, { status: 'INACTIVE' }, ctx.sessions.customer.token)).status, 403);
    });

    it('el ADMIN conserva el estado y el RUC como capacidad administrativa', async () => {
      await conEmpresaSuspendida(async () => {
        const reactivada = await put(`/companies/${ctx.fixtures.companyA}`, { status: 'ACTIVE' }, ctx.sessions.admin.token);
        assert.equal(reactivada.status, 200);
        assert.equal(reactivada.body.data.status, 'ACTIVE');
      });

      const ruc = await put(`/companies/${ctx.fixtures.companyA}`, { tax_id: '20555555555' }, ctx.sessions.admin.token);
      assert.equal(ruc.status, 200);
      assert.equal(ruc.body.data.tax_id, '20555555555');

      const vuelta = await put(`/companies/${ctx.fixtures.companyA}`, { tax_id: '20111111111' }, ctx.sessions.admin.token);
      assert.equal(vuelta.status, 200);
    });
  });

  /**
   * BP-04 · regresión de la auditoría del 06/09/2026.
   *
   * `GET /users/stats` era el único endpoint del archivo sin alcance, y `users.view` lo
   * tienen también CUSTOMER y OPERATOR: cualquier cliente registrado obtenía el tamaño de
   * la plataforma y cuántos administradores hay.
   */
  describe('BP-04 · las cifras de usuarios son solo del ADMIN', () => {
    it('un CUSTOMER ya no recibe las cifras globales', async () => {
      const res = await get('/users/stats', ctx.sessions.customer.token);
      assert.equal(res.status, 403);
      assert.equal(res.body.data, undefined, 'ni siquiera parcialmente');
    });

    it('un OPERATOR tampoco', async () => {
      const res = await get('/users/stats', ctx.sessions.operator.token);
      assert.equal(res.status, 403);
      assert.equal(res.body.data, undefined);
    });

    it('un COMPANY_ADMIN tampoco: el Portal Empresa nunca pide estas cifras', async () => {
      assert.equal((await get('/users/stats', ctx.sessions.companyAdmin.token)).status, 403);
    });

    it('sin sesión responde 401 como el resto de la API', async () => {
      assert.equal((await get('/users/stats')).status, 401);
    });

    it('el ADMIN las sigue recibiendo completas: el panel no se rompe', async () => {
      const res = await get('/users/stats', ctx.sessions.admin.token);
      assert.equal(res.status, 200);
      for (const clave of ['total', 'active', 'suspended', 'pending', 'customers', 'admins', 'company_users']) {
        assert.ok(res.body.data[clave] !== undefined, `falta la métrica ${clave} que usa el panel`);
      }
      assert.ok(Number(res.body.data.total) > 0);
    });

    it('no hay otra vía en el listado de usuarios para deducir las mismas cifras', async () => {
      // El listado sí sigue disponible, pero acotado: un cliente solo se ve a sí mismo.
      const listado = await get('/users?limit=100', ctx.sessions.customer.token);
      assert.equal(listado.status, 200);
      assert.equal(listado.body.pagination.total, 1, 'el alcance del listado sigue siendo su propia fila');

      // Y filtrar por rol no amplía nada.
      const admins = await get('/users?role=ADMIN&limit=100', ctx.sessions.customer.token);
      assert.equal(admins.body.pagination.total, 0, 'no puede contar administradores');
    });
  });

  /**
   * BP-05 · regresión de la auditoría del 06/09/2026.
   *
   * `POST /support/tickets` insertaba `company_id` y `booking_id` tal como llegaban: se
   * podía abrir un ticket apuntando a la reserva de otro —y la respuesta devolvía su
   * `booking_code`— y contra una empresa sin ninguna relación con el autor.
   */
  describe('BP-05 · la reserva y la empresa del ticket las decide el servidor', () => {
    let reservaPropia: { id: number; booking_code: string };
    let reservaAjena: { id: number; booking_code: string };

    before(async () => {
      const propia = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [at(await freeSeats(ctx.fixtures.tripA), 0).id] },
        ctx.sessions.customer.token,
      );
      reservaPropia = propia.body.data;

      // Una reserva del ADMIN sobre un viaje de la empresa B: ajena al cliente por partida doble.
      const ajena = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripB, seat_ids: [at(await freeSeats(ctx.fixtures.tripB), 0).id] },
        ctx.sessions.admin.token,
      );
      reservaAjena = ajena.body.data;
    });

    it('un ticket sin reserva sigue funcionando', async () => {
      const res = await post(
        '/support/tickets',
        { subject: 'Consulta general', message: 'No consigo actualizar mis datos.' },
        ctx.sessions.customer.token,
      );
      assert.equal(res.status, 201);
      assert.equal(res.body.data.booking_id, null);
      assert.equal(res.body.data.company_id, null, 'sin reserva y sin empresa propia, el ticket es de plataforma');
    });

    it('un ticket con la reserva propia deriva la empresa real del viaje', async () => {
      const res = await post(
        '/support/tickets',
        { subject: 'Duda sobre mi viaje', message: 'Quiero cambiar de asiento.', booking_id: reservaPropia.id },
        ctx.sessions.customer.token,
      );
      assert.equal(res.status, 201);
      assert.equal(Number(res.body.data.booking_id), reservaPropia.id);
      assert.equal(Number(res.body.data.company_id), ctx.fixtures.companyA, 'la empresa sale de booking → trip → route');
      assert.equal(res.body.data.booking_code, reservaPropia.booking_code, 'su propia reserva sí se muestra');
    });

    it('el company_id que envíe el cliente se descarta', async () => {
      const res = await post(
        '/support/tickets',
        {
          subject: 'Intento de desvío',
          message: 'sonda',
          booking_id: reservaPropia.id,
          company_id: ctx.fixtures.companyB,
        },
        ctx.sessions.customer.token,
      );
      assert.equal(res.status, 201);
      assert.equal(
        Number(res.body.data.company_id),
        ctx.fixtures.companyA,
        'debe quedar la empresa de la reserva, no la que pidió el cliente',
      );
    });

    it('una reserva ajena se rechaza y no filtra su booking_code', async () => {
      const res = await post(
        '/support/tickets',
        { subject: 'Fuga', message: 'sonda', booking_id: reservaAjena.id },
        ctx.sessions.customer.token,
      );
      assert.equal(res.status, 404, '404 y no 403: no se confirma que la reserva exista');
      assert.equal(JSON.stringify(res.body).includes(reservaAjena.booking_code), false, 'el código no puede aparecer');
    });

    it('ni acompañada de la empresa propia para disimular', async () => {
      const res = await post(
        '/support/tickets',
        { subject: 'Fuga 2', message: 'sonda', booking_id: reservaAjena.id, company_id: ctx.fixtures.companyA },
        ctx.sessions.customer.token,
      );
      assert.equal(res.status, 404);
      assert.equal(JSON.stringify(res.body).includes(reservaAjena.booking_code), false);
    });

    it('ningún ticket del cliente quedó apuntando a la empresa B ni a la reserva ajena', async () => {
      const mios = await get('/support/tickets?limit=100', ctx.sessions.customer.token);
      const filas = mios.body.data as Array<Record<string, unknown>>;

      assert.ok(filas.length > 0);
      for (const fila of filas) {
        assert.notEqual(Number(fila.company_id), ctx.fixtures.companyB, 'no se puede colar en la bandeja de otra empresa');
        assert.notEqual(Number(fila.booking_id), reservaAjena.id);
        assert.notEqual(fila.booking_code, reservaAjena.booking_code);
      }
    });

    it('la empresa B no ve ningún ticket colado por el cliente', async () => {
      const deB = await get('/support/tickets?limit=100', ctx.sessions.companyAdminB.token);
      const ajenos = (deB.body.data as Array<Record<string, unknown>>).filter(
        (fila) => Number(fila.user_id) === ctx.sessions.customer.user.id,
      );
      assert.equal(ajenos.length, 0);
    });

    it('la empresa A sigue viendo los tickets legítimos de sus reservas', async () => {
      const deA = await get('/support/tickets?limit=100', ctx.sessions.companyAdmin.token);
      const suyos = (deA.body.data as Array<Record<string, unknown>>).filter(
        (fila) => Number(fila.company_id) === ctx.fixtures.companyA,
      );
      assert.ok(suyos.length > 0, 'las reglas de visibilidad de la empresa no cambian');
      assert.ok(suyos.some((fila) => fila.booking_code === reservaPropia.booking_code));
    });

    it('un usuario de empresa puede abrir un ticket sobre una reserva de su empresa', async () => {
      const res = await post(
        '/support/tickets',
        { subject: 'Incidencia de operación', message: 'El pasajero no se presentó.', booking_id: reservaPropia.id },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(res.status, 201);
      assert.equal(Number(res.body.data.company_id), ctx.fixtures.companyA);
    });

    it('pero no sobre una reserva de otra empresa', async () => {
      const res = await post(
        '/support/tickets',
        { subject: 'Ajena', message: 'sonda', booking_id: reservaAjena.id },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(res.status, 404);
    });
  });
});
