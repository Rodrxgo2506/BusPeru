import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execute, query, queryOne } from '../config/database';
import { env } from '../config/env';
import { purgeExpired as purgeExpiredOAuthFlows } from '../repositories/oauth-flow.repository';
import { resetJwksCache } from '../services/oauth-provider.service';
import { del, get, post, testBaseUrl } from './helpers/api';
import { pkceMatches, startFakeProvider, type FakeProvider, type TokenClaims } from './helpers/oauthProvider';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';
import { startSecondInstance, type SecondInstance } from './helpers/secondInstance';

/**
 * Inicio de sesión con Google / Microsoft (PENDIENTES.md §2, mockups 8, 12 y 30).
 *
 * Los tests corren contra un proveedor local con criptografía real (ver `oauthProvider.ts`):
 * par RSA propio, JWKS publicado y tokens firmados de verdad. El backend los valida con el
 * mismo código que usaría contra Google. **No se usan credenciales ni cuentas reales de
 * ningún proveedor**, y por tanto estos tests NO demuestran que el login real funcione:
 * demuestran que la validación, las reglas de vinculación y la sesión son correctas.
 *
 * El estado efímero del flujo vive en `oauth_flows` (migración `008`), no en memoria. El
 * bloque «Persistencia del flujo» lo comprueba contra una SEGUNDA INSTANCIA del backend
 * lanzada en otro proceso.
 */
describe('Inicio de sesión con Google / Microsoft', () => {
  let ctx: SuiteContext;
  let google: FakeProvider;
  let microsoft: FakeProvider;
  let segunda: SecondInstance;

  /** Tenant que firma los tokens de Microsoft, para comprobar la resolución del emisor. */
  const TENANT = '00000000-1111-2222-3333-444444444444';

  before(async () => {
    ctx = await prepareSuite();

    google = await startFakeProvider({ clientId: 'google-client-de-pruebas', clientSecret: 'google-secreto' });
    microsoft = await startFakeProvider({ clientId: 'microsoft-client-de-pruebas', clientSecret: 'microsoft-secreto' });

    // Se apunta la configuración al proveedor local. Es exactamente para lo que existen las
    // variables de entorno de extremos documentadas en el README.
    env.oauth.google.clientId = google.clientId;
    env.oauth.google.clientSecret = google.clientSecret;
    env.oauth.google.issuer = google.issuer;
    env.oauth.google.authorizationUrl = `${google.url}/authorize`;
    env.oauth.google.tokenUrl = `${google.url}/token`;
    env.oauth.google.jwksUri = `${google.url}/jwks`;

    env.oauth.microsoft.clientId = microsoft.clientId;
    env.oauth.microsoft.clientSecret = microsoft.clientSecret;
    // Emisor CON marcador de tenant: el backend debe resolverlo con el claim `tid`.
    env.oauth.microsoft.issuer = `${microsoft.url}/{tenantid}/v2.0`;
    env.oauth.microsoft.authorizationUrl = `${microsoft.url}/authorize`;
    env.oauth.microsoft.tokenUrl = `${microsoft.url}/token`;
    env.oauth.microsoft.jwksUri = `${microsoft.url}/jwks`;

    // Segunda instancia REAL, en otro proceso, apuntando al mismo proveedor y a la misma
    // base. Es lo que permite comprobar el escenario multiinstancia sin aproximaciones.
    segunda = await startSecondInstance({
      GOOGLE_CLIENT_ID: google.clientId,
      GOOGLE_CLIENT_SECRET: google.clientSecret,
      GOOGLE_ISSUER: google.issuer,
      GOOGLE_AUTH_URL: `${google.url}/authorize`,
      GOOGLE_TOKEN_URL: `${google.url}/token`,
      GOOGLE_JWKS_URI: `${google.url}/jwks`,
    });
  });

  after(async () => {
    await teardownSuite();
    await segunda.stop();
    await google.stop();
    await microsoft.stop();
  });

  beforeEach(async () => {
    // Las fixtures se conservan: solo se les quita la vinculación. Las cuentas que crea
    // OAuth durante los tests usan siempre el dominio @oauth.test, y esas sí se borran.
    await execute('UPDATE users SET oauth_provider = NULL, oauth_id = NULL');
    await execute("DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@oauth.test')");
    await execute("DELETE FROM users WHERE email LIKE '%@oauth.test'");
    await execute("DELETE FROM audit_logs WHERE entity_type = 'users'");

    await execute('DELETE FROM oauth_flows');

    google.reset();
    microsoft.reset();
    resetJwksCache();
  });

  // --- Utilidades del flujo --------------------------------------------------

  /** Lanza `start` y devuelve lo que el backend manda al proveedor. */
  async function startLogin(scope = 'CUSTOMER', provider = 'google') {
    const response = await fetch(`${testBaseUrl()}/auth/oauth/${provider}/start?scope=${scope}`, { redirect: 'manual' });
    const location = response.headers.get('location');
    if (!location) return { status: response.status, location: null, params: null };

    const url = new URL(location);
    return { status: response.status, location, url, params: url.searchParams };
  }

  /** Cierra el flujo llamando al callback. Devuelve el ticket o el código de error. */
  async function finishCallback(state: string, options: { code?: string; provider?: string } = {}) {
    const provider = options.provider ?? 'google';
    const code = options.code ?? 'codigo-de-autorizacion';
    const response = await fetch(
      `${testBaseUrl()}/auth/oauth/${provider}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      { redirect: 'manual' },
    );

    const location = response.headers.get('location') ?? '';
    const url = location ? new URL(location) : null;
    return {
      status: response.status,
      location,
      ticket: url?.searchParams.get('ticket') ?? null,
      error: url?.searchParams.get('error') ?? null,
    };
  }

  /**
   * Flujo completo de inicio de sesión, desde `start` hasta el ticket.
   * `claims` sobrescribe lo que el proveedor pondrá en el `id_token`.
   */
  async function loginWith(claims: TokenClaims, options: { scope?: string; provider?: 'google' | 'microsoft' } = {}) {
    const provider = options.provider ?? 'google';
    const fake = provider === 'google' ? google : microsoft;

    const started = await startLogin(options.scope ?? 'CUSTOMER', provider);
    const state = started.params?.get('state');
    const nonce = started.params?.get('nonce');
    assert.ok(state && nonce, 'el arranque debe emitir state y nonce');

    fake.nextClaims = { nonce, ...claims };
    return { ...(await finishCallback(state, { provider })), state, nonce, started };
  }

  /** Canjea el ticket por la sesión, como haría el frontend. */
  async function exchange(ticket: string) {
    return post('/auth/oauth/session', { ticket });
  }

  /** Identidad de cliente válida y completa. */
  const CLIENTE: TokenClaims = {
    sub: 'google-sub-0001',
    email: 'nueva.cliente@oauth.test',
    email_verified: true,
    given_name: 'Nueva',
    family_name: 'Cliente',
  };

  // --- Disponibilidad --------------------------------------------------------

  describe('Disponibilidad de proveedores', () => {
    it('publica qué proveedores están configurados', async () => {
      const res = await get('/auth/oauth/providers');

      assert.equal(res.status, 200);
      assert.deepEqual(
        res.body.data.map((p: { provider: string; configured: boolean }) => [p.provider, p.configured]),
        [['GOOGLE', true], ['MICROSOFT', true]],
      );
    });

    it('un proveedor sin credenciales responde 503, no un login falso', async () => {
      const secreto = env.oauth.microsoft.clientSecret;
      env.oauth.microsoft.clientSecret = '';
      try {
        const res = await startLogin('CUSTOMER', 'microsoft');
        assert.equal(res.status, 503, 'no configurado ≠ no disponible temporalmente');

        const listado = await get('/auth/oauth/providers');
        assert.equal(listado.body.data.find((p: { provider: string }) => p.provider === 'MICROSOFT').configured, false);
      } finally {
        env.oauth.microsoft.clientSecret = secreto;
      }
    });

    it('un proveedor inexistente devuelve 404', async () => {
      assert.equal((await startLogin('CUSTOMER', 'facebook')).status, 404);
      assert.equal((await startLogin('CUSTOMER', 'google2')).status, 404);
    });
  });

  // --- Arranque del flujo ----------------------------------------------------

  describe('Arranque del flujo', () => {
    it('redirige al proveedor con PKCE, state y nonce', async () => {
      const { status, url, params } = await startLogin();

      assert.equal(status, 302);
      assert.equal(url!.origin + url!.pathname, `${google.url}/authorize`);
      assert.equal(params!.get('response_type'), 'code');
      assert.equal(params!.get('client_id'), google.clientId);
      assert.equal(params!.get('code_challenge_method'), 'S256', 'PKCE con S256, nunca plain');
      assert.ok((params!.get('code_challenge') ?? '').length >= 43);
      assert.ok((params!.get('state') ?? '').length >= 32, 'state largo y opaco');
      assert.ok((params!.get('nonce') ?? '').length >= 32);
      assert.match(params!.get('redirect_uri') ?? '', /\/auth\/oauth\/google\/callback$/);
    });

    it('el secreto del cliente nunca viaja al navegador', async () => {
      const { location } = await startLogin();
      assert.doesNotMatch(location ?? '', /google-secreto/, 'el client_secret no sale del servidor');
    });

    it('cada arranque genera un state y un nonce distintos', async () => {
      const uno = await startLogin();
      const dos = await startLogin();

      assert.notEqual(uno.params!.get('state'), dos.params!.get('state'));
      assert.notEqual(uno.params!.get('nonce'), dos.params!.get('nonce'));
    });

    it('un scope inválido se rechaza', async () => {
      const response = await fetch(`${testBaseUrl()}/auth/oauth/google/start?scope=SUPERADMIN`, { redirect: 'manual' });
      assert.equal(response.status, 422);
    });
  });

  // --- CASO A: alta de una cuenta nueva --------------------------------------

  describe('CASO A · correo desconocido', () => {
    it('el flujo de cliente da de alta una cuenta CUSTOMER ACTIVE', async () => {
      const resultado = await loginWith(CLIENTE);
      assert.ok(resultado.ticket, `esperaba ticket y llegó error=${resultado.error}`);

      const fila = await queryOne<any>(
        `SELECT u.email, u.first_name, u.last_name, u.status, u.oauth_provider, u.oauth_id, u.password_hash,
                u.email_verified_at, r.name AS role
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = ?`,
        [CLIENTE.email],
      );

      assert.ok(fila, 'la cuenta se creó');
      assert.equal(fila.role, 'CUSTOMER', 'el rol lo fija el servidor');
      assert.equal(fila.status, 'ACTIVE');
      assert.equal(fila.oauth_provider, 'GOOGLE');
      assert.equal(fila.oauth_id, CLIENTE.sub);
      assert.equal(fila.first_name, 'Nueva');
      assert.ok(fila.email_verified_at, 'el proveedor confirmó el correo');
      assert.ok(fila.password_hash?.startsWith('$2'), 'la columna sigue siendo NOT NULL, con un hash inutilizable');
    });

    it('la cuenta creada por OAuth no tiene contraseña utilizable', async () => {
      await loginWith(CLIENTE);

      // Ni la contraseña de las fixtures ni el propio correo sirven como contraseña.
      for (const password of ['PruebaSegura1', CLIENTE.email!, '', 'password']) {
        const res = await post('/auth/login', { email: CLIENTE.email, password });
        assert.notEqual(res.status, 200, `no debería entrar con "${password}"`);
      }
    });

    it('el Portal Empresa y el Panel Admin NO dan de alta', async () => {
      for (const scope of ['COMPANY', 'ADMIN']) {
        const resultado = await loginWith({ ...CLIENTE, sub: `sub-${scope}` }, { scope });

        assert.equal(resultado.error, 'account_not_found', `scope=${scope}`);
        assert.equal(resultado.ticket, null);
      }
      assert.equal((await query('SELECT id FROM users WHERE oauth_id IS NOT NULL')).length, 0, 'no se creó ninguna cuenta');
    });

    it('el scope solo restringe: no concede ningún privilegio', async () => {
      // Se pide el flujo de ADMIN con una identidad que acaba creando una cuenta por el
      // flujo de cliente: la cuenta sigue siendo CUSTOMER.
      await loginWith(CLIENTE, { scope: 'CUSTOMER' });
      const antes = await queryOne<{ role: string }>(
        'SELECT r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = ?',
        [CLIENTE.email],
      );
      assert.equal(antes?.role, 'CUSTOMER');

      const otra = await loginWith(CLIENTE, { scope: 'ADMIN' });
      assert.ok(otra.ticket, 'la cuenta ya existe, así que entra');

      const sesion = await exchange(otra.ticket!);
      assert.equal(sesion.body.data.user.role, 'CUSTOMER', 'pedir el portal de ADMIN no da rol de ADMIN');
      assert.deepEqual(sesion.body.data.user.permissions.filter((p: string) => p.startsWith('settings.')), []);
    });
  });

  // --- CASO B: identidad ya vinculada ----------------------------------------

  describe('CASO B · identidad ya vinculada', () => {
    it('el segundo inicio de sesión reutiliza la misma cuenta', async () => {
      const primero = await loginWith(CLIENTE);
      const idInicial = (await exchange(primero.ticket!)).body.data.user.id;

      const segundo = await loginWith({ ...CLIENTE, given_name: 'Otro', family_name: 'Nombre' });
      const sesion = await exchange(segundo.ticket!);

      assert.equal(sesion.body.data.user.id, idInicial, 'es la misma cuenta');
      assert.equal((await query('SELECT id FROM users WHERE oauth_id = ?', [CLIENTE.sub])).length, 1);

      const fila = await queryOne<{ first_name: string }>('SELECT first_name FROM users WHERE id = ?', [idInicial]);
      assert.equal(fila?.first_name, 'Nueva', 'el proveedor no sobrescribe el perfil en cada entrada');
    });

    it('la identidad manda sobre el correo: cambiar de correo en el proveedor no crea otra cuenta', async () => {
      const primero = await loginWith(CLIENTE);
      const idInicial = (await exchange(primero.ticket!)).body.data.user.id;

      const segundo = await loginWith({ ...CLIENTE, email: 'correo.nuevo@oauth.test' });
      const sesion = await exchange(segundo.ticket!);

      assert.equal(sesion.body.data.user.id, idInicial);
      assert.equal((await query('SELECT id FROM users WHERE oauth_id IS NOT NULL')).length, 1);
    });

    it('una empresa ya aprovisionada entra por el Portal Empresa', async () => {
      await execute("UPDATE users SET oauth_provider = 'GOOGLE', oauth_id = 'sub-empresa-a' WHERE id = ?", [
        ctx.sessions.companyAdmin.user.id,
      ]);

      const resultado = await loginWith({ ...CLIENTE, sub: 'sub-empresa-a', email: 'empresa-a@test.pe' }, { scope: 'COMPANY' });
      assert.ok(resultado.ticket, `esperaba ticket y llegó error=${resultado.error}`);

      const sesion = await exchange(resultado.ticket!);
      assert.equal(sesion.body.data.user.id, ctx.sessions.companyAdmin.user.id);
      assert.equal(sesion.body.data.user.role, 'COMPANY_ADMIN');
    });
  });

  // --- CASO C: el correo ya existe con contraseña ----------------------------

  describe('CASO C · el correo ya existe con contraseña', () => {
    it('se rechaza sin fusionar cuentas', async () => {
      const resultado = await loginWith({ ...CLIENTE, email: 'cliente@test.pe', email_verified: true });

      assert.equal(resultado.error, 'email_taken');
      assert.equal(resultado.ticket, null);

      const fila = await queryOne<{ oauth_provider: string | null }>(
        'SELECT oauth_provider FROM users WHERE email = ?',
        ['cliente@test.pe'],
      );
      assert.equal(fila?.oauth_provider, null, 'la cuenta existente NO quedó vinculada');
    });

    it('un correo verificado por el proveedor tampoco basta para apropiarse de la cuenta', async () => {
      const resultado = await loginWith({ ...CLIENTE, email: 'admin@test.pe', email_verified: true, sub: 'sub-atacante' });

      assert.equal(resultado.error, 'email_taken', 'ni siquiera con email_verified se fusiona');
      const fila = await queryOne<{ oauth_id: string | null }>('SELECT oauth_id FROM users WHERE email = ?', ['admin@test.pe']);
      assert.equal(fila?.oauth_id, null, 'la cuenta de ADMIN sigue intacta');
    });

    it('la cuenta existente conserva su acceso por contraseña', async () => {
      await loginWith({ ...CLIENTE, email: 'cliente@test.pe' });

      const res = await post('/auth/login', { email: 'cliente@test.pe', password: 'PruebaSegura1' });
      assert.equal(res.status, 200, 'el intento fallido de OAuth no afectó al login normal');
    });
  });

  // --- CASOS D y E: vinculación desde el perfil ------------------------------

  describe('CASOS D y E · vinculación desde el perfil', () => {
    /** Vinculación completa para la sesión indicada. */
    async function link(token: string, provider: 'google' | 'microsoft', claims: TokenClaims) {
      const inicio = await post(`/auth/oauth/${provider}/link`, undefined, token);
      if (inicio.status !== 200) return { start: inicio, error: null, ticket: null };

      const url = new URL(inicio.body.data.url);
      const state = url.searchParams.get('state')!;
      const nonce = url.searchParams.get('nonce')!;

      const fake = provider === 'google' ? google : microsoft;
      fake.nextClaims = { nonce, ...claims };

      return { start: inicio, ...(await finishCallback(state, { provider })) };
    }

    it('vincula el proveedor a la cuenta autenticada', async () => {
      const resultado = await link(ctx.sessions.customer.token, 'google', { ...CLIENTE, sub: 'sub-vinculado' });
      assert.ok(resultado.ticket, `esperaba ticket y llegó error=${resultado.error}`);

      const fila = await queryOne<{ oauth_provider: string; oauth_id: string }>(
        'SELECT oauth_provider, oauth_id FROM users WHERE id = ?',
        [ctx.sessions.customer.user.id],
      );
      assert.equal(fila?.oauth_provider, 'GOOGLE');
      assert.equal(fila?.oauth_id, 'sub-vinculado');
    });

    it('la cuenta a vincular sale de la sesión, jamás del callback', async () => {
      // El cliente arranca la vinculación; el `state` queda atado a SU id en el servidor.
      const inicio = await post('/auth/oauth/google/link', { user_id: ctx.sessions.admin.user.id }, ctx.sessions.customer.token);
      assert.equal(inicio.status, 200);

      const url = new URL(inicio.body.data.url);
      google.nextClaims = { nonce: url.searchParams.get('nonce')!, ...CLIENTE, sub: 'sub-intento' };
      await finishCallback(url.searchParams.get('state')!);

      const admin = await queryOne<{ oauth_id: string | null }>('SELECT oauth_id FROM users WHERE id = ?', [
        ctx.sessions.admin.user.id,
      ]);
      const cliente = await queryOne<{ oauth_id: string | null }>('SELECT oauth_id FROM users WHERE id = ?', [
        ctx.sessions.customer.user.id,
      ]);

      assert.equal(admin?.oauth_id, null, 'el user_id del cuerpo se ignoró por completo');
      assert.equal(cliente?.oauth_id, 'sub-intento', 'se vinculó la cuenta de la sesión');
    });

    it('sin sesión no se puede iniciar una vinculación', async () => {
      assert.equal((await post('/auth/oauth/google/link')).status, 401);
      assert.equal((await post('/auth/oauth/google/link', undefined, 'token-inventado')).status, 401);
    });

    it('CASO D · repetir la misma vinculación es idempotente', async () => {
      await link(ctx.sessions.customer.token, 'google', { ...CLIENTE, sub: 'sub-repetido' });
      const segunda = await link(ctx.sessions.customer.token, 'google', { ...CLIENTE, sub: 'sub-repetido' });

      assert.ok(segunda.ticket, 'el resultado ya era el deseado');
      assert.equal((await query('SELECT id FROM users WHERE oauth_id = ?', ['sub-repetido'])).length, 1);
    });

    it('CASO D · una cuenta no admite dos proveedores', async () => {
      await link(ctx.sessions.customer.token, 'google', { ...CLIENTE, sub: 'sub-google' });

      const segunda = await link(ctx.sessions.customer.token, 'microsoft', {
        oid: 'oid-microsoft', tid: TENANT, iss: `${microsoft.url}/${TENANT}/v2.0`, email: CLIENTE.email,
      });
      assert.equal(segunda.error, 'already_linked');

      const fila = await queryOne<{ oauth_provider: string }>('SELECT oauth_provider FROM users WHERE id = ?', [
        ctx.sessions.customer.user.id,
      ]);
      assert.equal(fila?.oauth_provider, 'GOOGLE', 'la vinculación original no se pisa');
    });

    it('CASO E · una identidad ya usada por otra cuenta se rechaza', async () => {
      await link(ctx.sessions.customer.token, 'google', { ...CLIENTE, sub: 'sub-disputado' });

      const intruso = await link(ctx.sessions.companyAdmin.token, 'google', { ...CLIENTE, sub: 'sub-disputado' });
      assert.equal(intruso.error, 'identity_taken');

      const filas = await query('SELECT id FROM users WHERE oauth_id = ?', ['sub-disputado']);
      assert.equal(filas.length, 1, 'la identidad sigue perteneciendo a una sola cuenta');
    });

    it('la clave única de la base impide la misma identidad en dos cuentas', async () => {
      await execute("UPDATE users SET oauth_provider = 'GOOGLE', oauth_id = 'sub-unico' WHERE id = ?", [
        ctx.sessions.customer.user.id,
      ]);

      await assert.rejects(
        () => execute("UPDATE users SET oauth_provider = 'GOOGLE', oauth_id = 'sub-unico' WHERE id = ?", [
          ctx.sessions.admin.user.id,
        ]),
        /Duplicate entry|ER_DUP_ENTRY/i,
      );
    });

    it('varias cuentas sin proveedor conviven bajo la clave única', async () => {
      const total = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE oauth_provider IS NULL');
      assert.ok(Number(total?.n) >= 4, 'los NULL no colisionan entre sí en el índice único');
    });

    it('consulta y elimina la vinculación', async () => {
      await link(ctx.sessions.customer.token, 'google', { ...CLIENTE, sub: 'sub-a-quitar' });

      const consulta = await get('/auth/oauth/link', ctx.sessions.customer.token);
      assert.equal(consulta.body.data.provider, 'GOOGLE');

      assert.equal((await del('/auth/oauth/link', ctx.sessions.customer.token)).status, 200);
      assert.equal((await get('/auth/oauth/link', ctx.sessions.customer.token)).body.data.provider, null);

      // Desvincular dos veces no es una operación repetible en silencio.
      assert.equal((await del('/auth/oauth/link', ctx.sessions.customer.token)).status, 400);
    });

    it('nadie puede desvincular la cuenta de otro', async () => {
      await execute("UPDATE users SET oauth_provider = 'GOOGLE', oauth_id = 'sub-ajeno' WHERE id = ?", [
        ctx.sessions.admin.user.id,
      ]);

      assert.equal((await del('/auth/oauth/link', ctx.sessions.customer.token)).status, 400, 'solo actúa sobre su propia cuenta');
      const fila = await queryOne<{ oauth_id: string | null }>('SELECT oauth_id FROM users WHERE id = ?', [
        ctx.sessions.admin.user.id,
      ]);
      assert.equal(fila?.oauth_id, 'sub-ajeno', 'la vinculación ajena sigue intacta');
    });
  });

  // --- CASO F: estado de la cuenta -------------------------------------------

  describe('CASO F · estado de la cuenta', () => {
    for (const status of ['SUSPENDED', 'INACTIVE', 'PENDING']) {
      it(`una cuenta ${status} no puede entrar por OAuth`, async () => {
        await execute("UPDATE users SET oauth_provider = 'GOOGLE', oauth_id = 'sub-estado', status = ? WHERE id = ?", [
          status,
          ctx.sessions.customer.user.id,
        ]);

        try {
          const resultado = await loginWith({ ...CLIENTE, sub: 'sub-estado' });
          assert.equal(resultado.error, 'account_blocked', `status=${status}`);
          assert.equal(resultado.ticket, null, 'no se emite ticket');
        } finally {
          await execute("UPDATE users SET status = 'ACTIVE' WHERE id = ?", [ctx.sessions.customer.user.id]);
        }
      });
    }

    it('OAuth aplica exactamente las mismas reglas de estado que el login normal', async () => {
      await execute("UPDATE users SET status = 'SUSPENDED' WHERE id = ?", [ctx.sessions.customer.user.id]);
      try {
        const conPassword = await post('/auth/login', { email: 'cliente@test.pe', password: 'PruebaSegura1' });
        assert.equal(conPassword.status, 403, 'el login normal la rechaza');

        await execute("UPDATE users SET oauth_provider = 'GOOGLE', oauth_id = 'sub-suspendido' WHERE id = ?", [
          ctx.sessions.customer.user.id,
        ]);
        const conOauth = await loginWith({ ...CLIENTE, sub: 'sub-suspendido' });
        assert.equal(conOauth.error, 'account_blocked', 'OAuth no es una puerta trasera');
      } finally {
        await execute("UPDATE users SET status = 'ACTIVE' WHERE id = ?", [ctx.sessions.customer.user.id]);
      }
    });
  });

  // --- Verificación del id_token ---------------------------------------------

  describe('Verificación del id_token', () => {
    /** Arranca un flujo y cierra el callback con un token construido a medida. */
    async function conToken(build: (nonce: string) => string) {
      const started = await startLogin();
      const state = started.params!.get('state')!;
      google.nextIdToken = build(started.params!.get('nonce')!);
      return finishCallback(state);
    }

    it('rechaza una firma que no corresponde al JWKS', async () => {
      const res = await conToken((nonce) => google.sign({ ...CLIENTE, nonce }, { wrongKey: true }));
      assert.equal(res.error, 'provider_error');
    });

    it('rechaza el algoritmo HS256 firmado con el client_id', async () => {
      const res = await conToken((nonce) => google.sign({ ...CLIENTE, nonce }, { algorithm: 'HS256' }));
      assert.equal(res.error, 'provider_error', 'la confusión de algoritmo no cuela');
    });

    it('rechaza un token sin firma (alg: none)', async () => {
      const res = await conToken((nonce) => {
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: google.keyId })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({
          ...CLIENTE, nonce, iss: google.issuer, aud: google.clientId,
          exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000),
        })).toString('base64url');
        return `${header}.${payload}.`;
      });
      assert.equal(res.error, 'provider_error');
    });

    it('rechaza un kid que no está publicado', async () => {
      const res = await conToken((nonce) => google.sign({ ...CLIENTE, nonce }, { kid: 'kid-inventado' }));
      assert.equal(res.error, 'provider_error');
    });

    it('rechaza un emisor distinto', async () => {
      const res = await conToken((nonce) => google.sign({ ...CLIENTE, nonce, iss: 'https://accounts.malicioso.com' }));
      assert.equal(res.error, 'provider_error');
    });

    it('rechaza una audiencia distinta: un token emitido para otra aplicación', async () => {
      const res = await conToken((nonce) => google.sign({ ...CLIENTE, nonce, aud: 'otra-aplicacion.apps.example.com' }));
      assert.equal(res.error, 'provider_error');
    });

    it('rechaza un token caducado', async () => {
      const ahora = Math.floor(Date.now() / 1000);
      const res = await conToken((nonce) => google.sign({ ...CLIENTE, nonce, iat: ahora - 7200, exp: ahora - 3600 }));
      assert.equal(res.error, 'provider_error');
    });

    it('rechaza un nonce que no es el de esta petición', async () => {
      const res = await conToken(() => google.sign({ ...CLIENTE, nonce: 'nonce-de-otra-sesion' }));
      assert.equal(res.error, 'provider_error', 'un id_token robado de otro flujo no se reutiliza');
    });

    it('rechaza un token sin nonce', async () => {
      const res = await conToken(() => google.sign({ ...CLIENTE }));
      assert.equal(res.error, 'provider_error');
    });

    it('rechaza un token sin sub', async () => {
      const res = await conToken((nonce) => google.sign({ email: CLIENTE.email, nonce }));
      assert.equal(res.error, 'provider_error');
    });

    it('rechaza un token sin correo', async () => {
      const res = await conToken((nonce) => google.sign({ sub: 'sub-sin-correo', nonce }));
      assert.equal(res.error, 'provider_error');
    });

    it('rechaza un token que no es un JWT', async () => {
      for (const basura of ['no-es-un-token', 'a.b.c', '', '../../etc/passwd']) {
        const res = await conToken(() => basura);
        assert.equal(res.error, 'provider_error', `token="${basura}"`);
      }
      assert.equal((await query('SELECT id FROM users WHERE oauth_id IS NOT NULL')).length, 0);
    });

    it('ningún token rechazado crea cuenta ni sesión', async () => {
      await conToken((nonce) => google.sign({ ...CLIENTE, nonce }, { wrongKey: true }));
      assert.equal((await query('SELECT id FROM users WHERE email = ?', [CLIENTE.email])).length, 0);
    });
  });

  // --- Microsoft --------------------------------------------------------------

  describe('Microsoft', () => {
    const IDENTIDAD: TokenClaims = {
      oid: 'oid-microsoft-0001',
      tid: TENANT,
      email: 'usuario@oauth.test',
      given_name: 'Usuario',
      family_name: 'Microsoft',
    };

    it('inicia sesión resolviendo el emisor con el claim tid', async () => {
      const resultado = await loginWith(
        { ...IDENTIDAD, iss: `${microsoft.url}/${TENANT}/v2.0` },
        { provider: 'microsoft' },
      );
      assert.ok(resultado.ticket, `esperaba ticket y llegó error=${resultado.error}`);

      const fila = await queryOne<{ oauth_provider: string; oauth_id: string }>(
        'SELECT oauth_provider, oauth_id FROM users WHERE email = ?',
        [IDENTIDAD.email],
      );
      assert.equal(fila?.oauth_provider, 'MICROSOFT');
      assert.equal(fila?.oauth_id, IDENTIDAD.oid, 'Microsoft identifica con oid, no con sub');
    });

    it('rechaza un token cuyo tid no corresponde al emisor', async () => {
      const started = await startLogin('CUSTOMER', 'microsoft');
      microsoft.nextIdToken = microsoft.sign({
        ...IDENTIDAD,
        nonce: started.params!.get('nonce')!,
        tid: '99999999-9999-9999-9999-999999999999',
        iss: `${microsoft.url}/${TENANT}/v2.0`,
      });

      const res = await finishCallback(started.params!.get('state')!, { provider: 'microsoft' });
      assert.equal(res.error, 'provider_error', 'el emisor debe corresponder al tenant del token');
    });

    it('rechaza un token de Microsoft sin tid', async () => {
      const started = await startLogin('CUSTOMER', 'microsoft');
      microsoft.nextIdToken = microsoft.sign({ ...IDENTIDAD, tid: undefined, nonce: started.params!.get('nonce')! });

      const res = await finishCallback(started.params!.get('state')!, { provider: 'microsoft' });
      assert.equal(res.error, 'provider_error');
    });

    it('las identidades de Google y Microsoft no se confunden entre sí', async () => {
      await loginWith({ ...CLIENTE, sub: 'identificador-compartido' });
      const conMicrosoft = await loginWith(
        { ...IDENTIDAD, oid: 'identificador-compartido', iss: `${microsoft.url}/${TENANT}/v2.0`, email: 'otro@oauth.test' },
        { provider: 'microsoft' },
      );

      assert.ok(conMicrosoft.ticket);
      const filas = await query<{ oauth_provider: string }>(
        'SELECT oauth_provider FROM users WHERE oauth_id = ? ORDER BY oauth_provider',
        ['identificador-compartido'],
      );
      assert.deepEqual(filas.map((f) => f.oauth_provider), ['GOOGLE', 'MICROSOFT'], 'la clave única es (proveedor, id)');
    });
  });

  // --- state, PKCE y CSRF ------------------------------------------------------

  describe('state, PKCE y CSRF', () => {
    it('el callback envía el code_verifier que corresponde al challenge anunciado', async () => {
      const resultado = await loginWith(CLIENTE);
      assert.ok(resultado.ticket);

      const enviado = google.lastTokenRequest!;
      assert.equal(enviado.grant_type, 'authorization_code');
      assert.equal(enviado.client_secret, google.clientSecret, 'el secreto viaja de servidor a servidor');
      assert.ok(pkceMatches(enviado.code_verifier!, resultado.started.params!.get('code_challenge')!), 'PKCE correcto');
    });

    it('un state inventado no abre sesión', async () => {
      for (const state of ['inventado', '', "' OR 1=1 --", '../../etc/passwd']) {
        const res = await finishCallback(state);
        assert.equal(res.error, 'invalid_state', `state="${state}"`);
      }
    });

    it('el state es de un solo uso', async () => {
      const started = await startLogin();
      const state = started.params!.get('state')!;
      google.nextClaims = { nonce: started.params!.get('nonce')!, ...CLIENTE };

      assert.ok((await finishCallback(state)).ticket, 'el primer canje funciona');
      assert.equal((await finishCallback(state)).error, 'invalid_state', 'reproducir el callback no vale');
    });

    it('un state de Google no sirve en el callback de Microsoft', async () => {
      const started = await startLogin();
      const res = await finishCallback(started.params!.get('state')!, { provider: 'microsoft' });

      assert.equal(res.error, 'invalid_state', 'el state pertenece al proveedor que lo emitió');
    });

    it('un callback sin código se rechaza', async () => {
      const started = await startLogin();
      const response = await fetch(
        `${testBaseUrl()}/auth/oauth/google/callback?state=${started.params!.get('state')}`,
        { redirect: 'manual' },
      );
      assert.match(response.headers.get('location') ?? '', /error=invalid_state/);
    });

    it('un state caducado se rechaza', async () => {
      const ttl = env.oauth.stateTtlSeconds;
      env.oauth.stateTtlSeconds = -1;
      try {
        const started = await startLogin();
        assert.equal((await finishCallback(started.params!.get('state')!)).error, 'invalid_state');
      } finally {
        env.oauth.stateTtlSeconds = ttl;
      }
    });

    it('si el proveedor rechaza el canje, no hay sesión', async () => {
      const started = await startLogin();
      google.failNextExchange = 400;

      const res = await finishCallback(started.params!.get('state')!);
      assert.equal(res.error, 'provider_error');
      assert.equal((await query('SELECT id FROM users WHERE oauth_id IS NOT NULL')).length, 0);
    });

    it('el error siempre vuelve al frontend, nunca deja una página en blanco', async () => {
      const res = await finishCallback('state-invalido');
      assert.equal(res.status, 302);
      assert.ok(res.location.startsWith(env.frontendUrl), 'redirige al frontend configurado');
      assert.match(res.location, /error=/);
    });
  });

  // --- Ticket y sesión ---------------------------------------------------------

  describe('Ticket y sesión', () => {
    it('el ticket entrega el mismo JWT que el login con contraseña', async () => {
      const resultado = await loginWith(CLIENTE);
      const sesion = await exchange(resultado.ticket!);

      assert.equal(sesion.status, 200);
      assert.ok(sesion.body.data.token, 'devuelve token');
      assert.ok(Array.isArray(sesion.body.data.user.permissions));
      assert.ok(Array.isArray(sesion.body.data.user.companyIds));

      // El token sirve en el resto de la API exactamente igual.
      const perfil = await get('/auth/me', sesion.body.data.token);
      assert.equal(perfil.status, 200);
      assert.equal(perfil.body.data.email, CLIENTE.email);
    });

    it('el ticket es de un solo uso', async () => {
      const resultado = await loginWith(CLIENTE);

      assert.equal((await exchange(resultado.ticket!)).status, 200);
      assert.equal((await exchange(resultado.ticket!)).status, 401, 'no se puede canjear dos veces');
    });

    it('un ticket inventado no abre sesión', async () => {
      for (const ticket of ['inventado', "' OR 1=1 --", 'a'.repeat(64)]) {
        assert.equal((await exchange(ticket)).status, 401, `ticket="${ticket}"`);
      }
      assert.equal((await post('/auth/oauth/session', {})).status, 422);
      assert.equal((await post('/auth/oauth/session', { ticket: '' })).status, 422);
    });

    it('un ticket caducado no abre sesión', async () => {
      const ttl = env.oauth.ticketTtlSeconds;
      env.oauth.ticketTtlSeconds = -1;
      try {
        const resultado = await loginWith(CLIENTE);
        assert.ok(resultado.ticket);
        assert.equal((await exchange(resultado.ticket!)).status, 401);
      } finally {
        env.oauth.ticketTtlSeconds = ttl;
      }
    });

    it('el canje ignora cualquier campo extra del cuerpo', async () => {
      const resultado = await loginWith(CLIENTE);
      const sesion = await post('/auth/oauth/session', {
        ticket: resultado.ticket,
        user_id: ctx.sessions.admin.user.id,
        role: 'ADMIN',
        role_id: 1,
        email: 'admin@test.pe',
        permissions: ['settings.update'],
        status: 'ACTIVE',
      });

      assert.equal(sesion.status, 200);
      assert.equal(sesion.body.data.user.email, CLIENTE.email, 'la sesión es la del ticket, no la del cuerpo');
      assert.equal(sesion.body.data.user.role, 'CUSTOMER');
      assert.notEqual(sesion.body.data.user.id, ctx.sessions.admin.user.id);
    });

    it('la entrada por OAuth queda auditada y actualiza last_login_at', async () => {
      const resultado = await loginWith(CLIENTE);
      const sesion = await exchange(resultado.ticket!);

      const auditoria = await queryOne<{ action: string; description: string; user_id: number }>(
        "SELECT action, description, user_id FROM audit_logs WHERE entity_type = 'users' AND action = 'LOGIN' ORDER BY id DESC LIMIT 1",
      );
      assert.equal(auditoria?.action, 'LOGIN');
      assert.match(auditoria!.description, /proveedor externo/);
      assert.equal(Number(auditoria!.user_id), sesion.body.data.user.id);

      const fila = await queryOne<{ last_login_at: string | null }>('SELECT last_login_at FROM users WHERE id = ?', [
        sesion.body.data.user.id,
      ]);
      assert.ok(fila?.last_login_at, 'se registra la última entrada');
    });
  });

  // --- Persistencia, concurrencia y multiinstancia -----------------------------

  describe('Persistencia del flujo', () => {
    /** Arranca un flujo contra la instancia indicada y devuelve state y nonce. */
    async function startEn(baseUrl: string, scope = 'CUSTOMER') {
      const response = await fetch(`${baseUrl}/auth/oauth/google/start?scope=${scope}`, { redirect: 'manual' });
      const url = new URL(response.headers.get('location')!);
      return { state: url.searchParams.get('state')!, nonce: url.searchParams.get('nonce')! };
    }

    /** Cierra el callback contra la instancia indicada. */
    async function callbackEn(baseUrl: string, state: string) {
      const response = await fetch(
        `${baseUrl}/auth/oauth/google/callback?code=codigo&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      );
      const url = new URL(response.headers.get('location')!);
      return { ticket: url.searchParams.get('ticket'), error: url.searchParams.get('error') };
    }

    it('el state se guarda hasheado, nunca en claro', async () => {
      const { state } = await startEn(testBaseUrl());

      const fila = await queryOne<any>('SELECT * FROM oauth_flows ORDER BY id DESC LIMIT 1');
      assert.ok(fila, 'el flujo se persistio');
      assert.ok(!JSON.stringify(fila).includes(state), 'el state en claro no esta en la base');
      assert.match(fila.state_hash, /^[0-9a-f]{64}$/, 'sha256 en hexadecimal');
      assert.equal(fila.provider, 'GOOGLE');
      assert.equal(fila.mode, 'LOGIN');
      assert.equal(fila.state_used_at, null, 'aun sin consumir');
    });

    it('no se guarda el nonce, el code_verifier ni ningun token del proveedor', async () => {
      const { state, nonce } = await startEn(testBaseUrl());
      google.nextClaims = { nonce, ...CLIENTE };
      await callbackEn(testBaseUrl(), state);

      const columnas = await query<Record<string, string>>(
        "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'oauth_flows'",
      );
      const nombres = columnas.map((c) => String(c.COLUMN_NAME ?? c.column_name).toLowerCase());
      for (const prohibida of ['nonce', 'code_verifier', 'access_token', 'refresh_token', 'id_token', 'client_secret', 'jwt', 'token']) {
        assert.ok(!nombres.includes(prohibida), `la tabla no debe tener la columna ${prohibida}`);
      }

      // Y tampoco por contenido: ni el nonce ni el verificador andan escondidos en otra columna.
      const fila = await queryOne<any>('SELECT * FROM oauth_flows ORDER BY id DESC LIMIT 1');
      assert.ok(!JSON.stringify(fila).includes(nonce), 'el nonce no se almacena');
    });

    it('la base es la unica fuente del state: si se borra la fila, el callback falla', async () => {
      const { state, nonce } = await startEn(testBaseUrl());
      google.nextClaims = { nonce, ...CLIENTE };

      await execute('DELETE FROM oauth_flows');

      const res = await callbackEn(testBaseUrl(), state);
      assert.equal(res.error, 'invalid_state', 'no queda ninguna copia en memoria del proceso');
    });

    it('/start en una instancia y /callback en OTRA funciona', async () => {
      const { state, nonce } = await startEn(testBaseUrl());
      google.nextClaims = { nonce, ...CLIENTE };

      const res = await callbackEn(segunda.baseUrl, state);
      assert.ok(res.ticket, `esperaba ticket y llego error=${res.error}`);
    });

    it('/start en la OTRA instancia y /callback en esta funciona', async () => {
      const { state, nonce } = await startEn(segunda.baseUrl);
      google.nextClaims = { nonce, ...CLIENTE };

      const res = await callbackEn(testBaseUrl(), state);
      assert.ok(res.ticket, `esperaba ticket y llego error=${res.error}`);
    });

    it('el ticket emitido en una instancia se canjea en la OTRA', async () => {
      const { state, nonce } = await startEn(testBaseUrl());
      google.nextClaims = { nonce, ...CLIENTE };
      const { ticket } = await callbackEn(testBaseUrl(), state);

      const response = await fetch(`${segunda.baseUrl}/auth/oauth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket }),
      });
      const body = (await response.json()) as any;

      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.data.user.email, CLIENTE.email);
    });

    it('el flujo sobrevive a un reinicio del proceso que lo inicio', async () => {
      const { state, nonce } = await startEn(segunda.baseUrl);

      // Se apaga por completo la instancia que atendio el /start.
      await segunda.stop();

      google.nextClaims = { nonce, ...CLIENTE };
      const res = await callbackEn(testBaseUrl(), state);
      assert.ok(res.ticket, 'el flujo se completa aunque su proceso ya no exista');

      // Se vuelve a levantar para el resto de la suite.
      segunda = await startSecondInstance({
        GOOGLE_CLIENT_ID: google.clientId,
        GOOGLE_CLIENT_SECRET: google.clientSecret,
        GOOGLE_ISSUER: google.issuer,
        GOOGLE_AUTH_URL: `${google.url}/authorize`,
        GOOGLE_TOKEN_URL: `${google.url}/token`,
        GOOGLE_JWKS_URI: `${google.url}/jwks`,
      });
    });

    it('la vinculacion iniciada en una instancia se completa en la otra, sobre el usuario correcto', async () => {
      const inicio = await post('/auth/oauth/google/link', undefined, ctx.sessions.customer.token);
      const url = new URL(inicio.body.data.url);
      google.nextClaims = { nonce: url.searchParams.get('nonce')!, ...CLIENTE, sub: 'sub-multi-instancia' };

      const res = await callbackEn(segunda.baseUrl, url.searchParams.get('state')!);
      assert.ok(res.ticket, `esperaba ticket y llego error=${res.error}`);

      const cliente = await queryOne<{ oauth_id: string | null }>('SELECT oauth_id FROM users WHERE id = ?', [
        ctx.sessions.customer.user.id,
      ]);
      const admin = await queryOne<{ oauth_id: string | null }>('SELECT oauth_id FROM users WHERE id = ?', [
        ctx.sessions.admin.user.id,
      ]);
      assert.equal(cliente?.oauth_id, 'sub-multi-instancia', 'se vinculo al usuario del state');
      assert.equal(admin?.oauth_id, null, 'ninguna otra cuenta se toco');
    });

    it('el modo LINK queda atado al usuario en la base, no en la peticion', async () => {
      const inicio = await post('/auth/oauth/google/link', undefined, ctx.sessions.customer.token);
      const state = new URL(inicio.body.data.url).searchParams.get('state')!;

      const fila = await queryOne<{ mode: string; user_id: number }>(
        'SELECT mode, user_id FROM oauth_flows ORDER BY id DESC LIMIT 1',
      );
      assert.equal(fila?.mode, 'LINK');
      assert.equal(Number(fila?.user_id), ctx.sessions.customer.user.id);
      assert.ok(state.length >= 32);
    });
  });

  describe('Consumo atomico', () => {
    /** Lanza un callback contra la instancia indicada y devuelve ticket o error. */
    function lanzarCallback(baseUrl: string, state: string) {
      return fetch(`${baseUrl}/auth/oauth/google/callback?code=codigo&state=${encodeURIComponent(state)}`, {
        redirect: 'manual',
      }).then((response) => {
        const url = new URL(response.headers.get('location')!);
        return { ticket: url.searchParams.get('ticket'), error: url.searchParams.get('error') };
      });
    }

    it('dos callbacks simultaneos con el mismo state: solo uno gana', async () => {
      const started = await startLogin();
      const state = started.params!.get('state')!;
      google.nextClaims = { nonce: started.params!.get('nonce')!, ...CLIENTE };

      const [uno, dos] = await Promise.all([lanzarCallback(testBaseUrl(), state), lanzarCallback(testBaseUrl(), state)]);

      assert.equal([uno.ticket, dos.ticket].filter(Boolean).length, 1, 'exactamente un ticket');
      assert.equal([uno.error, dos.error].filter(Boolean).length, 1, 'exactamente un rechazo');
      assert.equal(uno.error ?? dos.error, 'invalid_state');
      assert.equal((await query('SELECT id FROM users WHERE oauth_id IS NOT NULL')).length, 1, 'una sola cuenta');
    });

    it('dos callbacks simultaneos en instancias DISTINTAS: solo uno gana', async () => {
      const started = await startLogin();
      const state = started.params!.get('state')!;
      google.nextClaims = { nonce: started.params!.get('nonce')!, ...CLIENTE };

      const [uno, dos] = await Promise.all([lanzarCallback(testBaseUrl(), state), lanzarCallback(segunda.baseUrl, state)]);

      assert.equal([uno.ticket, dos.ticket].filter(Boolean).length, 1, 'la base arbitra entre procesos');
      assert.equal([uno.error, dos.error].filter(Boolean).length, 1);
    });

    it('dos canjes simultaneos del mismo ticket: solo uno obtiene JWT', async () => {
      const resultado = await loginWith(CLIENTE);
      const ticket = resultado.ticket!;

      const [uno, dos] = await Promise.all([exchange(ticket), exchange(ticket)]);
      const ok = [uno, dos].filter((r) => r.status === 200);
      const ko = [uno, dos].filter((r) => r.status === 401);

      assert.equal(ok.length, 1, 'exactamente una sesion');
      assert.equal(ko.length, 1, 'exactamente un rechazo');
      assert.ok(ok[0]!.body.data.token);
    });

    it('dos canjes simultaneos del mismo ticket en instancias DISTINTAS: solo uno gana', async () => {
      const resultado = await loginWith(CLIENTE);
      const ticket = resultado.ticket!;

      const canjearEn = (baseUrl: string) =>
        fetch(`${baseUrl}/auth/oauth/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket }),
        }).then((response) => response.status);

      const estados = await Promise.all([canjearEn(testBaseUrl()), canjearEn(segunda.baseUrl)]);
      assert.equal(estados.filter((estado) => estado === 200).length, 1, 'una sola sesion entre procesos');
      assert.equal(estados.filter((estado) => estado === 401).length, 1);
    });

    it('el consumo queda marcado en la fila', async () => {
      const resultado = await loginWith(CLIENTE);
      await exchange(resultado.ticket!);

      const fila = await queryOne<any>(
        'SELECT state_used_at, ticket_used_at, ticket_hash FROM oauth_flows ORDER BY id DESC LIMIT 1',
      );
      assert.ok(fila?.state_used_at, 'el state quedo marcado');
      assert.ok(fila?.ticket_used_at, 'el ticket quedo marcado');
      assert.match(fila!.ticket_hash, /^[0-9a-f]{64}$/, 'el ticket tambien se guarda hasheado');
    });
  });

  describe('Caducidad y limpieza', () => {
    it('un state caducado no se puede consumir', async () => {
      const started = await startLogin();
      google.nextClaims = { nonce: started.params!.get('nonce')!, ...CLIENTE };

      // Se envejece la fila en la base, que es donde vive la caducidad.
      await execute('UPDATE oauth_flows SET expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND)');

      const res = await finishCallback(started.params!.get('state')!);
      assert.equal(res.error, 'invalid_state');
    });

    it('un ticket caducado no abre sesion', async () => {
      const resultado = await loginWith(CLIENTE);
      await execute('UPDATE oauth_flows SET ticket_expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND)');

      assert.equal((await exchange(resultado.ticket!)).status, 401);
    });

    it('los TTL configurados se aplican tal cual', async () => {
      await startLogin();
      const fila = await queryOne<{ segundos: number }>(
        'SELECT TIMESTAMPDIFF(SECOND, NOW(), expires_at) AS segundos FROM oauth_flows ORDER BY id DESC LIMIT 1',
      );
      assert.ok(Math.abs(Number(fila?.segundos) - env.oauth.stateTtlSeconds) <= 2, `state aprox ${env.oauth.stateTtlSeconds}s`);

      const resultado = await loginWith(CLIENTE);
      assert.ok(resultado.ticket);
      const ticketFila = await queryOne<{ segundos: number }>(
        'SELECT TIMESTAMPDIFF(SECOND, NOW(), ticket_expires_at) AS segundos FROM oauth_flows WHERE ticket_hash IS NOT NULL ORDER BY id DESC LIMIT 1',
      );
      assert.ok(
        Math.abs(Number(ticketFila?.segundos) - env.oauth.ticketTtlSeconds) <= 2,
        `ticket aprox ${env.oauth.ticketTtlSeconds}s`,
      );
    });

    it('la purga elimina lo caducado y respeta lo vigente', async () => {
      await startLogin();
      await startLogin();
      // Solo una se envejece mas de la hora de gracia.
      await execute('UPDATE oauth_flows SET expires_at = DATE_SUB(NOW(), INTERVAL 2 HOUR) ORDER BY id ASC LIMIT 1');

      const borradas = await purgeExpiredOAuthFlows();
      assert.equal(borradas, 1);
      assert.equal((await query('SELECT id FROM oauth_flows')).length, 1, 'el flujo vigente sigue ahi');
    });

    it('la purga esta acotada: nunca borra mas del limite pedido', async () => {
      for (let i = 0; i < 5; i += 1) await startLogin();
      await execute('UPDATE oauth_flows SET expires_at = DATE_SUB(NOW(), INTERVAL 2 HOUR)');

      assert.equal(await purgeExpiredOAuthFlows(2), 2, 'el LIMIT manda');
      assert.equal((await query('SELECT id FROM oauth_flows')).length, 3);
    });

    it('borrar la cuenta arrastra sus flujos en cascada', async () => {
      const usuario = await execute(
        `INSERT INTO users (role_id, first_name, last_name, email, password_hash, status)
         SELECT role_id, 'Temporal', 'Cascada', 'cascada@oauth.test', password_hash, 'ACTIVE' FROM users WHERE id = ?`,
        [ctx.sessions.customer.user.id],
      );
      await execute(
        `INSERT INTO oauth_flows (state_hash, provider, scope, mode, user_id, expires_at)
         VALUES ('hash-de-prueba-cascada', 'GOOGLE', 'CUSTOMER', 'LINK', ?, DATE_ADD(NOW(), INTERVAL 600 SECOND))`,
        [usuario.insertId],
      );

      await execute('DELETE FROM users WHERE id = ?', [usuario.insertId]);
      assert.equal((await query('SELECT id FROM oauth_flows WHERE user_id = ?', [usuario.insertId])).length, 0);
    });
  });

  describe('Derivacion de nonce y code_verifier', () => {
    it('el code_verifier derivado cumple el RFC 7636', async () => {
      const resultado = await loginWith(CLIENTE);
      assert.ok(resultado.ticket);

      const verifier = google.lastTokenRequest!.code_verifier!;
      assert.ok(verifier.length >= 43 && verifier.length <= 128, `longitud ${verifier.length}, debe estar entre 43 y 128`);
      assert.match(verifier, /^[A-Za-z0-9\-._~]+$/, 'solo caracteres unreserved');
      assert.ok(pkceMatches(verifier, resultado.started.params!.get('code_challenge')!), 'el challenge es su S256');
    });

    it('cada state deriva su propio verifier, y otra instancia deriva el mismo', async () => {
      const uno = await loginWith(CLIENTE);
      const verifierUno = google.lastTokenRequest!.code_verifier!;
      // Correo distinto: reutilizarlo daria email_taken y no probaria la derivacion.
      const dos = await loginWith({ ...CLIENTE, sub: 'otro-sub', email: 'segunda.cliente@oauth.test' });
      const verifierDos = google.lastTokenRequest!.code_verifier!;

      assert.ok(uno.ticket && dos.ticket);
      assert.notEqual(verifierUno, verifierDos, 'cada state deriva el suyo');

      // Y el que calcula la OTRA instancia para un mismo state debe coincidir, cosa que
      // solo puede ocurrir si la derivacion no depende del proceso.
      const started = await startLogin();
      const state = started.params!.get('state')!;
      google.nextClaims = { nonce: started.params!.get('nonce')!, ...CLIENTE, sub: 'sub-derivacion', email: 'tercera.cliente@oauth.test' };

      const response = await fetch(
        `${segunda.baseUrl}/auth/oauth/google/callback?code=codigo&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      );
      const url = new URL(response.headers.get('location')!);
      assert.ok(url.searchParams.get('ticket'), 'la otra instancia derivo el mismo verifier y el mismo nonce');
    });

    it('un state manipulado deriva otro verifier y no encuentra flujo', async () => {
      const started = await startLogin();
      const state = started.params!.get('state')!;
      google.nextClaims = { nonce: started.params!.get('nonce')!, ...CLIENTE };

      // Un solo caracter distinto: ni el hash coincide ni la derivacion sirve.
      const alterado = `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`;
      assert.equal((await finishCallback(alterado)).error, 'invalid_state');

      // El original sigue siendo valido: el intento fallido no lo consumio.
      assert.ok((await finishCallback(state)).ticket, 'manipular no invalida el flujo legitimo');
    });
  });

  // --- RBAC, aislamiento y regresión -------------------------------------------

  describe('RBAC y aislamiento multiempresa', () => {
    it('OAuth no altera los permisos: son idénticos a los del login con contraseña', async () => {
      await execute("UPDATE users SET oauth_provider = 'GOOGLE', oauth_id = 'sub-empresa' WHERE id = ?", [
        ctx.sessions.companyAdmin.user.id,
      ]);

      const resultado = await loginWith({ ...CLIENTE, sub: 'sub-empresa', email: 'empresa-a@test.pe' }, { scope: 'COMPANY' });
      const sesion = await exchange(resultado.ticket!);

      const conPassword = await post('/auth/login', { email: 'empresa-a@test.pe', password: 'PruebaSegura1' });

      assert.deepEqual(
        [...sesion.body.data.user.permissions].sort(),
        [...conPassword.body.data.user.permissions].sort(),
        'mismos permisos por las dos vías',
      );
      assert.deepEqual(sesion.body.data.user.companyIds, conPassword.body.data.user.companyIds);
    });

    it('la sesión OAuth respeta el aislamiento entre empresas', async () => {
      await execute("UPDATE users SET oauth_provider = 'GOOGLE', oauth_id = 'sub-a' WHERE id = ?", [
        ctx.sessions.companyAdmin.user.id,
      ]);
      const resultado = await loginWith({ ...CLIENTE, sub: 'sub-a', email: 'empresa-a@test.pe' }, { scope: 'COMPANY' });
      const token = (await exchange(resultado.ticket!)).body.data.token;

      // A → A permitido
      const propios = await get('/company/bank-accounts', token);
      assert.equal(propios.status, 200);
      const propiosDocs = await get('/company/documents', token);
      assert.equal(propiosDocs.status, 200);

      // A → B rechazado: pedir la empresa B no amplía el alcance
      const ajenos = await get(`/company/documents?company_id=${ctx.fixtures.companyB}`, token);
      assert.equal(ajenos.status, 200);
      assert.deepEqual(ajenos.body.data, [], 'no ve nada de la empresa B');

      const busesAjenos = await get(`/buses?company_id=${ctx.fixtures.companyB}`, token);
      assert.equal(busesAjenos.status, 200);
      assert.deepEqual(
        busesAjenos.body.data.filter((b: { company_id: number }) => Number(b.company_id) === ctx.fixtures.companyB),
        [],
        'el company_id de la query no cruza empresas',
      );
    });

    it('una cuenta creada por OAuth no pertenece a ninguna empresa', async () => {
      const resultado = await loginWith(CLIENTE);
      const sesion = await exchange(resultado.ticket!);

      assert.deepEqual(sesion.body.data.user.companyIds, [], 'OAuth no asigna empresa');
      assert.equal(sesion.body.data.user.role, 'CUSTOMER');

      const token = sesion.body.data.token;
      assert.equal((await get('/company/documents', token)).status, 403, 'no accede al Portal Empresa');
      assert.equal((await get('/company/bank-accounts', token)).status, 403);

      // `users.view` lo concede el dump a CUSTOMER, así que el listado responde 200; lo que
      // importa es que esté acotado a su propia ficha y no exponga a nadie más.
      const usuarios = await get('/users', token);
      assert.equal(usuarios.status, 200);
      assert.deepEqual(
        usuarios.body.data.map((u: { id: number }) => u.id),
        [sesion.body.data.user.id],
        'solo se ve a sí mismo',
      );

      // Ningún dato de otra cuenta, ni siquiera pidiéndolo por id.
      assert.equal((await get(`/users/${ctx.sessions.admin.user.id}`, token)).status, 404);
    });

    it('un correo con carga SQL se guarda como dato, no se ejecuta', async () => {
      const email = "inyeccion'; DROP TABLE users; --@oauth.test";
      const resultado = await loginWith({ ...CLIENTE, sub: 'sub-inyeccion', email });

      assert.ok(resultado.ticket, 'el correo es válido para el proveedor, así que se acepta como dato');
      assert.ok(Array.isArray(await query('SELECT id FROM users LIMIT 1')), 'la tabla users sigue existiendo');

      const fila = await queryOne<{ email: string }>('SELECT email FROM users WHERE oauth_id = ?', ['sub-inyeccion']);
      assert.equal(fila?.email, email.toLowerCase(), 'se almacenó literal');
    });

    it('un oauth_id con carga SQL tampoco rompe nada', async () => {
      const res = await loginWith({ ...CLIENTE, sub: "1' OR '1'='1", email: 'sqli@oauth.test' });
      assert.ok(res.ticket);

      const filas = await query('SELECT id FROM users WHERE oauth_id = ?', ["1' OR '1'='1"]);
      assert.equal(filas.length, 1, 'la comparación es por parámetro, no por concatenación');
    });
  });

  describe('Regresión del inicio de sesión existente', () => {
    it('el login con correo y contraseña sigue funcionando igual', async () => {
      for (const email of ['admin@test.pe', 'empresa-a@test.pe', 'operador-a@test.pe', 'cliente@test.pe']) {
        const res = await post('/auth/login', { email, password: 'PruebaSegura1' });
        assert.equal(res.status, 200, email);
        assert.ok(res.body.data.token);
      }
    });

    it('las credenciales incorrectas siguen dando el mismo error', async () => {
      const res = await post('/auth/login', { email: 'cliente@test.pe', password: 'incorrecta' });
      assert.equal(res.status, 401);
      assert.match(res.body.message ?? '', /Correo o contraseña incorrectos/);
    });

    it('el registro normal sigue creando cuentas sin proveedor', async () => {
      const res = await post('/auth/register', {
        first_name: 'Registro', last_name: 'Normal', email: 'registro.normal@oauth.test', password: 'PruebaSegura1',
      });
      assert.equal(res.status, 201);

      const fila = await queryOne<{ oauth_provider: string | null }>(
        'SELECT oauth_provider FROM users WHERE email = ?', ['registro.normal@oauth.test'],
      );
      assert.equal(fila?.oauth_provider, null);
    });

    it('el login con contraseña también queda auditado', async () => {
      const res = await post('/auth/login', { email: 'cliente@test.pe', password: 'PruebaSegura1' });
      assert.equal(res.status, 200);

      const entrada = await queryOne<{ action: string; user_id: number; description: string }>(
        "SELECT action, user_id, description FROM audit_logs WHERE entity_type = 'users' AND action = 'LOGIN' ORDER BY id DESC LIMIT 1",
      );
      assert.ok(entrada, 'copiar `req` rompía esta auditoría en silencio');
      assert.equal(Number(entrada!.user_id), res.body.data.user.id);
      assert.equal(entrada!.description, 'Inicio de sesión');
    });

    it('las columnas nuevas no alteran el perfil que devuelve la API', async () => {
      const res = await get('/auth/me', ctx.sessions.customer.token);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.password_hash, undefined, 'el hash nunca sale');
      assert.equal(res.body.data.oauth_id, undefined, 'el identificador del proveedor tampoco');
    });
  });
});
