import './helpers/testEnv';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { get, post, put } from './helpers/api';
import { execute, queryOne } from '../config/database';
import { env } from '../config/env';
import { createOAuthUser } from '../repositories/user.repository';
import { issueSession, roleIdByName } from '../services/auth.service';
import { registerSchema, updateProfileSchema } from '../validators/auth.validators';
import { birthDateSchema, documentNumberError, isRealDate, todayInPeru } from '../validators/identity.validators';
import { TEST_PASSWORD } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';
import { startTestServer } from './helpers/api';

/**
 * Parte B · documento de identidad (DNI, CE, PASAPORTE) y fecha de nacimiento del cliente (migración 022).
 *
 * Datos SINTÉTICOS: 12345678, CE123456, P1234567, 1999-05-17. Nada se verifica contra RENIEC: solo formato.
 * Todo corre sobre la base de pruebas (`*_test`).
 */

const DNI = '12345678';
const CE = 'CE123456';
const PAS = 'P1234567';
const NAC = '1999-05-17';
const manana = () => { const [y, m, d] = todayInPeru().split('-').map(Number) as [number, number, number]; return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10); };
const correo = (p: string) => `${p}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}@identidad.test`;
const base = (email: string) => ({ first_name: 'Ana', last_name: 'Prueba', email, password: TEST_PASSWORD });
const fila = (email: string) => queryOne<{ document_type: string | null; document_number: string | null; birth_date: string | null }>(
  "SELECT document_type, document_number, DATE_FORMAT(birth_date, '%Y-%m-%d') AS birth_date FROM users WHERE email = ?", [email]);

describe('Parte B · documento de identidad y fecha de nacimiento', () => {
  let ctx: SuiteContext;
  before(async () => {
    ctx = await prepareSuite();
    await startTestServer();
    assert.ok(env.db.name.endsWith('_test'), `la suite corre sobre una base *_test (${env.db.name})`);
  });
  after(async () => { await teardownSuite(); });
  beforeEach(async () => {
    await execute("UPDATE users SET document_type = NULL, document_number = NULL, birth_date = NULL WHERE email = 'cliente@test.pe'");
  });

  // ===================================================================== formato
  describe('validación de formato (sin verificar identidad)', () => {
    it('DNI: exactamente 8 dígitos', () => {
      assert.equal(documentNumberError('DNI', '12345678'), null);
      assert.equal(documentNumberError('DNI', ' 12345678 '), null, 'los espacios de los extremos se quitan');
      for (const malo of ['1234567', '123456789', '1234ABCD', '1234 5678', '1234-5678', '1234.567', '', '        ']) {
        assert.notEqual(documentNumberError('DNI', malo), null, `DNI inválido aceptado: «${malo}»`);
      }
    });
    it('CE: 8 a 12 letras o números', () => {
      assert.equal(documentNumberError('CE', CE), null);
      assert.equal(documentNumberError('CE', 'ce123456'), null, 'minúsculas: se normalizan a mayúsculas');
      for (const malo of ['CE-12345', 'CE 123456', 'CE12345', 'CE1234567890X', 'ÑANDU1234', 'CE12345#', '']) {
        assert.notEqual(documentNumberError('CE', malo), null, `CE inválido aceptado: «${malo}»`);
      }
    });
    it('PASAPORTE: 6 a 12 letras o números', () => {
      assert.equal(documentNumberError('PASAPORTE', PAS), null);
      for (const malo of ['P12#4567', 'P123', 'P 1234567', 'P1234567890123', '']) {
        assert.notEqual(documentNumberError('PASAPORTE', malo), null, `pasaporte inválido aceptado: «${malo}»`);
      }
    });
    it('fecha de nacimiento: real, AAAA-MM-DD y no futura (sin edad mínima)', () => {
      assert.ok(birthDateSchema.safeParse(NAC).success);
      assert.ok(birthDateSchema.safeParse(todayInPeru()).success, 'hoy es válido');
      assert.ok(birthDateSchema.safeParse('1900-01-01').success, 'no hay edad máxima inventada');
      assert.ok(birthDateSchema.safeParse('2024-02-29').success, 'bisiesto');
      for (const mala of ['1999-02-30', '2023-02-29', '1999-13-01', '17/05/1999', '1999/05/17', 'mañana', '', manana()]) {
        assert.equal(birthDateSchema.safeParse(mala).success, false, `fecha inválida aceptada: «${mala}»`);
      }
      assert.equal(isRealDate('1999-04-31'), false);
    });
    it('tipo y número van juntos; el tipo solo puede ser DNI, CE o PASAPORTE', () => {
      assert.equal(registerSchema.safeParse({ ...base('x@x.pe'), document_type: 'DNI' }).success, false);
      assert.equal(registerSchema.safeParse({ ...base('x@x.pe'), document_number: DNI }).success, false);
      assert.equal(registerSchema.safeParse({ ...base('x@x.pe'), document_type: 'RUC', document_number: '20111111111' }).success, false);
      const ok = registerSchema.safeParse({ ...base('x@x.pe'), document_type: 'CE', document_number: ' ce123456 ', birth_date: NAC });
      assert.ok(ok.success);
      assert.equal(ok.success && ok.data.document_number, CE, 'se guarda normalizado');
    });
  });

  // ===================================================================== registro
  describe('registro de CLIENTE', () => {
    for (const [tipo, numero] of [['DNI', DNI], ['CE', CE], ['PASAPORTE', PAS]] as const) {
      it(`registra ${tipo} + fecha, los persiste y /auth/me los devuelve`, async () => {
        const email = correo(tipo.toLowerCase());
        const res = await post('/auth/register', { ...base(email), document_type: tipo, document_number: numero, birth_date: NAC });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.deepEqual(await fila(email), { document_type: tipo, document_number: numero, birth_date: NAC });
        const me = await get('/auth/me', res.body.data.token);
        assert.equal(me.body.data.document_type, tipo);
        assert.equal(me.body.data.document_number, numero);
        assert.equal(me.body.data.birth_date, NAC);
      });
    }

    it('un registro rechazado no deja nada a medias (ni usuario, ni relaciones, ni auditoría)', async () => {
      const contar = async () => queryOne<{ u: number; cu: number; a: number }>(
        'SELECT (SELECT COUNT(*) FROM users) AS u, (SELECT COUNT(*) FROM company_users) AS cu, (SELECT COUNT(*) FROM audit_logs) AS a');
      const antes = await contar();
      for (const extra of [{}, { document_type: 'DNI' }, { document_type: 'DNI', document_number: DNI }, { document_type: 'CE', document_number: 'CE-12345', birth_date: NAC }]) {
        assert.equal((await post('/auth/register', { ...base(correo('parcial')), ...extra })).status, 422, JSON.stringify(extra));
      }
      assert.deepEqual(await contar(), antes);
    });

    it('rechaza (422) documento o fecha inválidos sin crear la cuenta', async () => {
      const casos = [
        { document_type: 'DNI', document_number: '1234567' },
        { document_type: 'DNI', document_number: '1234ABCD' },
        { document_type: 'CE', document_number: 'CE-12345' },
        { document_type: 'PASAPORTE', document_number: 'P12#4567' },
        { document_type: 'DNI' },
        { birth_date: manana() },
        { birth_date: '1999-02-30' },
        { birth_date: '17/05/1999' },
      ];
      for (const extra of casos) {
        const email = correo('mal');
        const res = await post('/auth/register', { ...base(email), ...extra });
        assert.equal(res.status, 422, JSON.stringify(extra));
        assert.equal(await fila(email), null, 'no se crea la cuenta');
      }
    });

    it('tipo, número y fecha son OBLIGATORIOS: si falta cualquiera, 422 y no se crea la cuenta', async () => {
      const completo = { document_type: 'DNI', document_number: DNI, birth_date: NAC };
      const mensajes: Record<string, string> = {
        document_type: 'Elige el tipo de documento', document_number: 'Ingresa tu número de documento', birth_date: 'Ingresa tu fecha de nacimiento',
      };
      for (const falta of Object.keys(completo) as Array<keyof typeof completo>) {
        const email = correo(`sin-${falta}`);
        const { [falta]: _omitido, ...resto } = completo;
        const res = await post('/auth/register', { ...base(email), ...resto });
        assert.equal(res.status, 422, `sin ${falta}`);
        assert.equal(res.body.errors?.[falta], mensajes[falta], `mensaje de ${falta}: ${JSON.stringify(res.body)}`);
        assert.equal(await fila(email), null, `sin ${falta}: no se crea la cuenta`);
      }
      const email = correo('sin-nada');
      assert.equal((await post('/auth/register', base(email))).status, 422);
      assert.equal(await fila(email), null);
      const vacios = correo('vacios');
      assert.equal((await post('/auth/register', { ...base(vacios), document_type: 'DNI', document_number: '', birth_date: '' })).status, 422);
      assert.equal(await fila(vacios), null);
    });

    it('el mensaje de error nunca devuelve el valor enviado', async () => {
      const res = await post('/auth/register', { ...base(correo('eco')), document_type: 'DNI', document_number: '9876543X', birth_date: NAC });
      assert.equal(res.status, 422);
      assert.ok(!JSON.stringify(res.body).includes('9876543X'));
    });
  });

  // ===================================================================== usuarios existentes / OAuth
  describe('compatibilidad con cuentas existentes y OAuth', () => {
    it('un cliente existente queda sin datos (NULL) y /auth/me lo refleja', async () => {
      const me = await get('/auth/me', ctx.sessions.customer.token);
      assert.equal(me.status, 200);
      assert.equal(me.body.data.document_type, null);
      assert.equal(me.body.data.document_number, null);
      assert.equal(me.body.data.birth_date, null);
    });

    it('una cuenta creada por Google nace sin datos y puede completarlos una vez', async () => {
      const email = correo('oauth');
      const id = await createOAuthUser({
        roleId: await roleIdByName('CUSTOMER'), firstName: 'Oscar', lastName: 'Auth', email,
        provider: 'GOOGLE', oauthId: `sub-${crypto.randomBytes(6).toString('hex')}`, passwordHash: 'x'.repeat(60), emailVerified: true,
      });
      assert.deepEqual(await fila(email), { document_type: null, document_number: null, birth_date: null });
      const { token } = await issueSession(id);
      const res = await put('/auth/me', { document_type: 'PASAPORTE', document_number: PAS, birth_date: NAC }, token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(await fila(email), { document_type: 'PASAPORTE', document_number: PAS, birth_date: NAC });
    });
  });

  // ===================================================================== inmutabilidad
  describe('perfil: completar una vez, luego inmutable', () => {
    const cliente = () => ctx.sessions.customer.token;

    it('sin documento puede completarlo; con documento no puede cambiarlo', async () => {
      const r1 = await put('/auth/me', { document_type: 'DNI', document_number: DNI }, cliente());
      assert.equal(r1.status, 200);
      assert.equal(r1.body.data.document_number, DNI);
      const r2 = await put('/auth/me', { document_type: 'DNI', document_number: '87654321' }, cliente());
      assert.equal(r2.status, 409);
      const r3 = await put('/auth/me', { document_type: 'CE', document_number: CE }, cliente());
      assert.equal(r3.status, 409);
      assert.deepEqual((await fila('cliente@test.pe'))!.document_number, DNI);
      assert.equal((await put('/auth/me', { document_type: 'DNI', document_number: DNI }, cliente())).status, 200, 'reenviar lo mismo no es un cambio');
    });

    it('sin fecha puede completarla; con fecha no puede cambiarla', async () => {
      assert.equal((await put('/auth/me', { birth_date: NAC }, cliente())).status, 200);
      assert.equal((await put('/auth/me', { birth_date: '2000-01-01' }, cliente())).status, 409);
      assert.equal((await fila('cliente@test.pe'))!.birth_date, NAC);
    });

    it('concurrencia: dos peticiones simultáneas con documentos distintos → una se guarda, la otra 409', async () => {
      const [a, b] = await Promise.all([
        put('/auth/me', { document_type: 'DNI', document_number: DNI, birth_date: NAC }, cliente()),
        put('/auth/me', { document_type: 'PASAPORTE', document_number: PAS, birth_date: '2000-01-01' }, cliente()),
      ]);
      const estados = [a.status, b.status].sort();
      assert.deepEqual(estados, [200, 409], `estados ${estados}`);
      const ganadora = a.status === 200 ? { document_type: 'DNI', document_number: DNI, birth_date: NAC } : { document_type: 'PASAPORTE', document_number: PAS, birth_date: '2000-01-01' };
      assert.deepEqual(await fila('cliente@test.pe'), ganadora, 'queda lo de la petición aceptada, completo y sin mezclas');
    });

    it('si la petición intenta cambiar la identidad no se guarda nada de ella (ni el teléfono)', async () => {
      await put('/auth/me', { document_type: 'DNI', document_number: DNI }, cliente());
      const antes = await queryOne<{ phone: string | null }>("SELECT phone FROM users WHERE email = 'cliente@test.pe'");
      const res = await put('/auth/me', { phone: '+51 911 111 111', document_type: 'DNI', document_number: '87654321' }, cliente());
      assert.equal(res.status, 409);
      assert.deepEqual(await queryOne("SELECT phone FROM users WHERE email = 'cliente@test.pe'"), antes);
    });

    it('los demás datos del perfil se siguen editando con la identidad ya fijada', async () => {
      await put('/auth/me', { document_type: 'DNI', document_number: DNI, birth_date: NAC }, cliente());
      const res = await put('/auth/me', { phone: '+51 922 222 222' }, cliente());
      assert.equal(res.status, 200);
      assert.equal(res.body.data.phone, '+51 922 222 222');
      assert.equal(res.body.data.document_number, DNI);
    });

    it('el personal de empresa no registra documento por esta vía (403)', async () => {
      assert.equal((await put('/auth/me', { document_type: 'DNI', document_number: DNI }, ctx.sessions.companyAdmin.token)).status, 403);
    });
  });

  // ===================================================================== seguridad
  describe('seguridad', () => {
    it('sin mass assignment: id, user_id, rol, correo o estado en el cuerpo no cambian nada ni tocan a otro usuario', async () => {
      const otro = await queryOne<{ id: number; email: string }>("SELECT id, email FROM users WHERE email <> 'cliente@test.pe' AND id <> ? ORDER BY id LIMIT 1", [ctx.fixtures.users.customer]);
      const antesOtro = await fila(otro!.email);
      const res = await put('/auth/me', {
        id: otro!.id, user_id: otro!.id, role_id: 1, role: 'ADMIN', email: 'cambiado@identidad.test', status: 'SUSPENDED',
        document_type: 'DNI', document_number: DNI,
      }, ctx.sessions.customer.token);
      assert.equal(res.status, 200);
      const yo = await queryOne<{ email: string; status: string; role_id: number }>('SELECT email, status, role_id FROM users WHERE id = ?', [ctx.fixtures.users.customer]);
      assert.equal(yo!.email, 'cliente@test.pe');
      assert.equal(yo!.status, 'ACTIVE');
      assert.deepEqual(await fila(otro!.email), antesOtro, 'el otro usuario no cambia');
      assert.equal((await fila('cliente@test.pe'))!.document_number, DNI, 'solo cambia el propio');
    });

    it('registro sin mass assignment: id, user_id, rol o estado en el cuerpo no se aplican', async () => {
      const admin = await queryOne<{ id: number }>("SELECT id FROM roles WHERE name = 'ADMIN'");
      const email = correo('masivo');
      const res = await post('/auth/register', {
        ...base(email), document_type: 'DNI', document_number: DNI, birth_date: NAC,
        id: ctx.fixtures.users.admin, user_id: ctx.fixtures.users.admin, role_id: admin!.id, role: 'ADMIN', status: 'SUSPENDED',
        email_verified_at: '2020-01-01 00:00:00', password_hash: 'x', oauth_provider: 'GOOGLE',
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const creado = await queryOne<{ id: number; status: string; role: string; email_verified_at: string | null; oauth_provider: string | null }>(
        'SELECT u.id, u.status, r.name AS role, u.email_verified_at, u.oauth_provider FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = ?', [email]);
      assert.equal(creado!.role, 'CUSTOMER');
      assert.equal(creado!.status, 'ACTIVE');
      assert.notEqual(creado!.id, ctx.fixtures.users.admin);
      assert.equal(creado!.email_verified_at, null);
      assert.equal(creado!.oauth_provider, null);
      assert.equal(res.body.data.user.role, 'CUSTOMER');
      const adminIntacto = await queryOne<{ email: string }>('SELECT email FROM users WHERE id = ?', [ctx.fixtures.users.admin]);
      assert.equal(adminIntacto!.email, 'admin@test.pe');
    });

    it('un cliente no puede editar a otro usuario por la API de usuarios', async () => {
      const antes = await queryOne<{ first_name: string }>('SELECT first_name FROM users WHERE id = ?', [ctx.fixtures.users.admin]);
      const res = await put(`/users/${ctx.fixtures.users.admin}`, { first_name: 'Hack', document_type: 'DNI', document_number: DNI }, ctx.sessions.customer.token);
      assert.ok([403, 404].includes(res.status), `se esperaba 403/404 y llegó ${res.status}`);
      assert.deepEqual(await queryOne('SELECT first_name FROM users WHERE id = ?', [ctx.fixtures.users.admin]), antes);
      assert.equal((await fila('admin@test.pe'))?.document_number ?? null, null);
    });

    it('no aparecen en listados administrativos ni en APIs públicas', async () => {
      await put('/auth/me', { document_type: 'DNI', document_number: DNI, birth_date: NAC }, ctx.sessions.customer.token);
      const lista = await get('/users?limit=100', ctx.sessions.admin.token);
      assert.equal(lista.status, 200);
      const detalle = await get(`/users/${ctx.fixtures.users.customer}`, ctx.sessions.admin.token);
      for (const cuerpo of [lista.body, detalle.body]) {
        const texto = JSON.stringify(cuerpo);
        assert.ok(!texto.includes(DNI) && !texto.includes('document_number') && !texto.includes('birth_date'), 'ni valores ni columnas en /users');
      }
      for (const ruta of ['/public/companies', '/public/destinations', '/public/trips?date=2099-01-01']) {
        const pub = await get(ruta);
        assert.ok(!JSON.stringify(pub.body).includes(DNI), `sin datos personales en ${ruta}`);
      }
    });

    it('no aparecen en los registros (ni en errores ni en sucesos)', async () => {
      const capturado: string[] = [];
      const [err, log, warn] = [console.error, console.log, console.warn];
      const antes = process.env.LOG_ERRORS;
      process.env.LOG_ERRORS = 'true';
      console.error = (...a: unknown[]) => { capturado.push(a.map(String).join(' ')); };
      console.log = (...a: unknown[]) => { capturado.push(a.map(String).join(' ')); };
      console.warn = (...a: unknown[]) => { capturado.push(a.map(String).join(' ')); };
      try {
        const email = correo('logs');
        await post('/auth/register', { ...base(email), document_type: 'CE', document_number: CE, birth_date: NAC });
        await post('/auth/register', { ...base(correo('logs2')), document_type: 'DNI', document_number: '1234567X', birth_date: NAC });
        await put('/auth/me', { document_type: 'PASAPORTE', document_number: PAS, birth_date: NAC }, ctx.sessions.customer.token);
        await put('/auth/me', { document_type: 'DNI', document_number: DNI, birth_date: '2000-01-01' }, ctx.sessions.customer.token);
      } finally {
        [console.error, console.log, console.warn] = [err, log, warn];
        if (antes === undefined) delete process.env.LOG_ERRORS; else process.env.LOG_ERRORS = antes;
      }
      const texto = capturado.join('\n');
      for (const dato of [CE, PAS, DNI, '1234567X', NAC]) assert.ok(!texto.includes(dato), `«${dato}» apareció en los registros`);
      const auditoria = await queryOne<{ n: number }>(
        'SELECT COUNT(*) AS n FROM audit_logs WHERE description LIKE ? OR description LIKE ? OR new_values LIKE ?', [`%${PAS}%`, `%${NAC}%`, `%${PAS}%`]);
      assert.equal(Number(auditoria!.n), 0, 'la auditoría registra el hecho, no los valores');
    });

    it('la edición de perfil mantiene la lista blanca: la identidad solo entra por completeIdentity', () => {
      const r = updateProfileSchema.safeParse({ document_type: 'DNI', document_number: DNI, password_hash: 'x', role_id: 1 });
      assert.ok(r.success);
      assert.ok(r.success && !('password_hash' in r.data) && !('role_id' in r.data), 'las claves desconocidas se descartan');
    });
  });
});
