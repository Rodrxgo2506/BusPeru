import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import { api, get, post } from './helpers/api';
import { env } from '../config/env';
import { execute, query, queryOne } from '../config/database';
import { TEST_PASSWORD } from './helpers/fixtures';
import { purgeExpiredRevocations, revokeSession } from '../services/session-revocation.service';
import { sessionFingerprint, tokenLifetimeSeconds } from '../utils/security';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * F17C-SEC-05 · revocación de sesiones: crecimiento, expiración y purga.
 *
 * EL DISEÑO. Cada token lleva un `jti` aleatorio. `POST /auth/logout` lo anota en
 * `revoked_sessions` con `expires_at = exp del token`, y el middleware rechaza cualquier token
 * cuyo `jti` esté ahí. El planificador general purga las filas que ya no pueden corresponder a
 * ningún token vivo, de modo que la tabla no crece sin límite.
 *
 * LO QUE DEFIENDE ESTA SUITE. La seguridad de la purga se apoya en una invariante: que
 * `expires_at` sea el `exp` del token. La auditoría comprobó que hoy se cumple al segundo, pero
 * también que NADA la verificaba: una fila con un `expires_at` más corto que su token se
 * borraba con el token todavía vivo, y ese token volvía a entrar. Por eso la purga exige ahora
 * DOS condiciones, y la segunda —la antigüedad de `revoked_at`— no depende de esa invariante.
 * Los casos de abajo fijan ambas.
 */
describe('SEC-05 · revocación de sesiones', () => {
  let ctx: SuiteContext;
  const VIDA = tokenLifetimeSeconds();

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  beforeEach(async () => {
    await execute('DELETE FROM revoked_sessions');
  });

  const entrar = async (email: string): Promise<string> => {
    const r = await post('/auth/login', { email, password: TEST_PASSWORD });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return String(r.body.data.token);
  };

  // `sub` es numerico en este proyecto, pero `JwtPayload` lo declara como cadena: se pasa por
  // `unknown` para no forzar una conversion que TypeScript considera incompatible.
  const leer = (token: string) => jwt.decode(token) as unknown as { jti: string; exp: number; iat: number; sub: number };

  /** Envejece una fila lo justo para que la purga pueda borrarla. */
  const envejecer = (jti: string) =>
    execute(
      `UPDATE revoked_sessions
         SET expires_at = DATE_SUB(NOW(), INTERVAL 2 HOUR),
             revoked_at = DATE_SUB(NOW(), INTERVAL ? SECOND)
       WHERE jti = ?`,
      [VIDA + 7200, jti],
    );

  /* ==================================================== 1 · el token y su expiración */
  describe('el token de sesión', () => {
    it('lleva jti de 32 hex, exp posterior a iat, y el middleware lo acepta', async () => {
      const token = await entrar('cliente@test.pe');
      const p = leer(token);
      const cabecera = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as { alg: string };

      assert.equal(cabecera.alg, 'HS256');
      assert.match(p.jti, /^[0-9a-f]{32}$/);
      assert.ok(p.exp > p.iat, 'exp debe ser posterior a iat');
      assert.equal(p.exp - p.iat, VIDA, 'la vida del token debe ser la configurada');
      assert.equal((await get('/auth/me', token)).status, 200);
    });

    it('un token caducado se rechaza aunque su firma y su huella sean correctas', async () => {
      const usuario = await queryOne<{ id: number; password_hash: string }>(
        "SELECT id, password_hash FROM users WHERE email = 'cliente@test.pe'",
      );
      const caducado = jwt.sign(
        { sub: usuario!.id, roleId: 0, role: 'CUSTOMER', pwd: sessionFingerprint(usuario!.password_hash) },
        env.jwt.secret,
        { expiresIn: '-1s', jwtid: 'a'.repeat(32) },
      );
      const r = await get('/auth/me', caducado);
      assert.equal(r.status, 401);
      assert.match(String(r.body.message), /expirad/i);
    });
  });

  /* ==================================================== 2 · revocación */
  describe('logout revoca el token', () => {
    it('anota el jti y el mismo token deja de valer', async () => {
      const token = await entrar('cliente@test.pe');
      const { jti, exp } = leer(token);

      assert.equal((await post('/auth/logout', {}, token)).status, 200);
      const fila = await queryOne<{ expires_at: string; user_id: number }>(
        'SELECT expires_at, user_id FROM revoked_sessions WHERE jti = ?', [jti],
      );
      assert.ok(fila, 'debe quedar la revocación');

      const reuso = await get('/auth/me', token);
      assert.equal(reuso.status, 401);
      assert.match(String(reuso.body.message), /sesi[óo]n se cerr/i, 'lo rechaza la revocación, no la expiración');

      // §11 · la revocación nunca puede caducar antes que el token.
      const guardado = Math.floor(new Date(String(fila!.expires_at)).getTime() / 1000);
      assert.ok(guardado >= exp, `expires_at (${guardado}) debe ser >= exp del token (${exp})`);
    });

    it('cerrar sesión dos veces no falla ni duplica filas', async () => {
      const token = await entrar('cliente@test.pe');
      const { jti } = leer(token);

      assert.equal((await post('/auth/logout', {}, token)).status, 200);
      assert.equal((await post('/auth/logout', {}, token)).status, 401, 'el segundo ya no autentica');

      const filas = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM revoked_sessions WHERE jti = ?', [jti]);
      assert.equal(Number(filas?.n), 1, 'la clave primaria impide duplicados');
    });

    it('revocar el mismo jti tres veces a la vez deja una sola fila', async () => {
      const token = await entrar('cliente@test.pe');
      const { jti, exp, sub } = leer(token);
      await Promise.all([revokeSession(jti, sub, exp), revokeSession(jti, sub, exp), revokeSession(jti, sub, exp)]);
      const filas = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM revoked_sessions WHERE jti = ?', [jti]);
      assert.equal(Number(filas?.n), 1);
    });
  });

  /* ==================================================== 3 · la purga */
  describe('la purga', () => {
    it('NO borra una revocación vigente y el token sigue rechazado', async () => {
      const token = await entrar('cliente@test.pe');
      const { jti } = leer(token);
      await post('/auth/logout', {}, token);

      assert.equal(await purgeExpiredRevocations(), 0, 'no hay nada purgable');
      assert.ok(await queryOne('SELECT jti FROM revoked_sessions WHERE jti = ?', [jti]), 'la fila sobrevive');
      assert.equal((await get('/auth/me', token)).status, 401);
    });

    /**
     * LA PRUEBA CRÍTICA. Antes del endurecimiento bastaba con que `expires_at` estuviera en el
     * pasado para borrar la fila: adelantando esa columna —sin tocar el token— la revocación
     * desaparecía y el JWT, todavía vivo, volvía a entrar con un 200.
     */
    it('no borra la fila si el token pudiera seguir vivo, aunque expires_at diga lo contrario', async () => {
      const token = await entrar('cliente@test.pe');
      const { jti } = leer(token);
      await post('/auth/logout', {}, token);
      assert.equal((await get('/auth/me', token)).status, 401);

      // Se falsea SOLO la caducidad de la revocación: el token sigue siendo válido.
      await execute('UPDATE revoked_sessions SET expires_at = DATE_SUB(NOW(), INTERVAL 2 HOUR) WHERE jti = ?', [jti]);

      const borradas = await purgeExpiredRevocations();
      assert.equal(borradas, 0, 'una revocación recién creada no puede purgarse');
      assert.ok(await queryOne('SELECT jti FROM revoked_sessions WHERE jti = ?', [jti]), 'la fila debe seguir ahí');

      const despues = await get('/auth/me', token);
      assert.equal(despues.status, 401, 'purgar NUNCA puede reactivar un token');
    });

    it('sí borra la fila cuando ya no puede corresponder a ningún token vivo', async () => {
      const token = await entrar('cliente@test.pe');
      const { jti } = leer(token);
      await post('/auth/logout', {}, token);
      await envejecer(jti);

      assert.equal(await purgeExpiredRevocations(), 1);
      assert.equal(await queryOne('SELECT jti FROM revoked_sessions WHERE jti = ?', [jti]), null);
    });

    it('el límite: solo lo caducado y revocado hace más de la vida de un token', async () => {
      const id = (await queryOne<{ id: number }>("SELECT id FROM users WHERE email = 'cliente@test.pe'"))!.id;
      const casos: Array<[string, string, number]> = [
        ['futuro', 'DATE_ADD(NOW(), INTERVAL 1 HOUR)', VIDA + 7200],
        ['justo ahora', 'NOW()', VIDA + 7200],
        ['pasado 1 segundo', 'DATE_SUB(NOW(), INTERVAL 1 SECOND)', VIDA + 7200],
        ['pasado 59 minutos', 'DATE_SUB(NOW(), INTERVAL 59 MINUTE)', VIDA + 7200],
        ['pasado 61 minutos', 'DATE_SUB(NOW(), INTERVAL 61 MINUTE)', VIDA + 7200],
        ['caducado pero revocado ahora', 'DATE_SUB(NOW(), INTERVAL 5 HOUR)', 0],
      ];
      for (const [etiqueta, expira, antiguedad] of casos) {
        await execute(
          `INSERT INTO revoked_sessions (jti, user_id, expires_at, revoked_at)
           VALUES (?, ?, ${expira}, DATE_SUB(NOW(), INTERVAL ? SECOND))`,
          [etiqueta.replace(/\W/g, '_').padEnd(32, '0').slice(0, 32), id, antiguedad],
        );
      }

      const borradas = await purgeExpiredRevocations();
      const quedan = await query<{ jti: string }>('SELECT jti FROM revoked_sessions');

      // Solo «pasado 61 minutos» cumple las dos condiciones a la vez.
      assert.equal(borradas, 1, `esperaba borrar 1 y borró ${borradas}`);
      assert.equal(quedan.length, 5);
      assert.ok(!quedan.some((q) => q.jti.startsWith('pasado_61')), 'la única purgable era la de 61 minutos');
    });

    it('dos purgas simultáneas no fallan ni borran de más', async () => {
      const token = await entrar('cliente@test.pe');
      const { jti } = leer(token);
      await post('/auth/logout', {}, token);
      await envejecer(jti);

      const [a, b] = await Promise.all([purgeExpiredRevocations(), purgeExpiredRevocations()]);
      assert.equal(a + b, 1, `entre las dos deben borrar exactamente una fila (${a}+${b})`);
      assert.equal(Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM revoked_sessions'))?.n), 0);
    });
  });

  /* ==================================================== 4 · concurrencia */
  describe('concurrencia', () => {
    it('autenticar y revocar a la vez: una vez confirmada la revocación no hay ventana', async () => {
      const token = await entrar('cliente@test.pe');
      await Promise.all([get('/auth/me', token), post('/auth/logout', {}, token)]);
      assert.equal((await get('/auth/me', token)).status, 401, 'tras confirmarse el logout el token no vuelve');
    });

    it('purgar mientras se revoca: la revocación nueva sobrevive', async () => {
      const token = await entrar('cliente@test.pe');
      const { jti } = leer(token);
      await Promise.all([post('/auth/logout', {}, token), purgeExpiredRevocations()]);

      assert.ok(await queryOne('SELECT jti FROM revoked_sessions WHERE jti = ?', [jti]));
      assert.equal((await get('/auth/me', token)).status, 401);
    });

    it('autenticar mientras se purga con una revocación vigente', async () => {
      const token = await entrar('cliente@test.pe');
      const { jti } = leer(token);
      await post('/auth/logout', {}, token);

      const [auth, purgadas] = await Promise.all([get('/auth/me', token), purgeExpiredRevocations()]);
      assert.equal(auth.status, 401);
      assert.equal(purgadas, 0);
      assert.ok(await queryOne('SELECT jti FROM revoked_sessions WHERE jti = ?', [jti]));
    });
  });

  /* ==================================================== 5 · aislamiento */
  describe('aislamiento entre cuentas y empresas', () => {
    it('revocar una sesión no toca las de otras cuentas ni las de otra empresa', async () => {
      const cuentas = ['cliente@test.pe', 'operador-a@test.pe', 'empresa-a@test.pe', 'empresa-b@test.pe', 'admin@test.pe'];
      const tokens = await Promise.all(cuentas.map((c) => entrar(c)));
      await post('/auth/logout', {}, tokens[0]!);

      assert.equal((await get('/auth/me', tokens[0]!)).status, 401, 'la revocada cae');
      for (let i = 1; i < tokens.length; i += 1) {
        assert.equal((await get('/auth/me', tokens[i]!)).status, 200, `${cuentas[i]} no debe verse afectada`);
      }
    });

    it('la purga solo retira la fila elegible, no las de las demás cuentas', async () => {
      const cuentas = ['cliente@test.pe', 'operador-a@test.pe', 'empresa-b@test.pe'];
      const tokens = await Promise.all(cuentas.map((c) => entrar(c)));
      for (const t of tokens) await post('/auth/logout', {}, t);
      await envejecer(leer(tokens[0]!).jti);

      assert.equal(await purgeExpiredRevocations(), 1);
      assert.equal(Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM revoked_sessions'))?.n), 2);
      for (let i = 1; i < tokens.length; i += 1) {
        assert.equal((await get('/auth/me', tokens[i]!)).status, 401, 'las otras siguen revocadas');
      }
    });

    it('el jti de una cuenta no invalida el token de otra', async () => {
      const ajeno = await entrar('empresa-b@test.pe');
      const propio = await entrar('cliente@test.pe');
      await revokeSession(leer(propio).jti, leer(propio).sub, leer(propio).exp);

      assert.equal((await get('/auth/me', propio)).status, 401);
      assert.equal((await get('/auth/me', ajeno)).status, 200);
    });
  });

  /* ==================================================== 6 · otros caminos de invalidación */
  describe('cambio de contraseña, restablecimiento y suspensión', () => {
    it('cambiar la contraseña expulsa por huella, sin necesitar una revocación', async () => {
      const token = await entrar('cliente@test.pe');
      const { jti } = leer(token);

      const cambio = await api('/auth/me/password', {
        method: 'PUT', token,
        body: { current_password: TEST_PASSWORD, new_password: 'ClaveSec05Nueva' },
      });
      assert.equal(cambio.status, 200, JSON.stringify(cambio.body));

      const reuso = await get('/auth/me', token);
      assert.equal(reuso.status, 401);
      assert.match(String(reuso.body.message), /ya no es v[áa]lida/i, 'lo corta la huella, no la revocación');
      assert.equal(await queryOne('SELECT jti FROM revoked_sessions WHERE jti = ?', [jti]), null, 'no inserta fila');

      // La purga no puede reabrir lo que cerró la huella.
      await purgeExpiredRevocations();
      assert.equal((await get('/auth/me', token)).status, 401);

      const nueva = await post('/auth/login', { email: 'cliente@test.pe', password: 'ClaveSec05Nueva' });
      assert.equal(nueva.status, 200, 'la contraseña nueva entra');
      assert.equal((await get('/auth/me', String(nueva.body.data.token))).status, 200, 'la sesión nueva funciona');

      await api('/auth/me/password', {
        method: 'PUT', token: String(nueva.body.data.token),
        body: { current_password: 'ClaveSec05Nueva', new_password: TEST_PASSWORD },
      });
    });

    it('una cuenta suspendida no pasa, y al reactivarla el token antiguo vuelve a servir', async () => {
      const id = (await queryOne<{ id: number }>("SELECT id FROM users WHERE email = 'cliente@test.pe'"))!.id;
      const token = await entrar('cliente@test.pe');
      assert.equal((await get('/auth/me', token)).status, 200);

      await execute("UPDATE users SET status = 'SUSPENDED' WHERE id = ?", [id]);
      const suspendido = await get('/auth/me', token);
      assert.equal(suspendido.status, 403, 'lo corta el estado, que se relee en cada petición');

      await execute("UPDATE users SET status = 'ACTIVE' WHERE id = ?", [id]);

      /**
       * COMPORTAMIENTO REAL, documentado a propósito: suspender NO revoca los tokens vivos ni
       * cambia la huella, así que al reactivar la cuenta el token anterior vuelve a valer. La
       * suspensión se comporta como una congelación temporal, no como un cierre de sesiones.
       * Si se quisiera lo contrario haría falta poder invalidar todas las sesiones de un
       * usuario, y eso exige una columna nueva: queda documentado como propuesta, no aplicado.
       */
      assert.equal((await get('/auth/me', token)).status, 200, 'comportamiento actual: el token antiguo revive');
    });
  });

  /* ==================================================== 7 · manipulación */
  describe('manipulación del token', () => {
    let huella = '';
    let userId = 0;

    before(async () => {
      const u = await queryOne<{ id: number; password_hash: string }>(
        "SELECT id, password_hash FROM users WHERE email = 'cliente@test.pe'",
      );
      userId = u!.id;
      huella = sessionFingerprint(u!.password_hash);
    });

    const firmar = (opciones: jwt.SignOptions) =>
      jwt.sign({ sub: userId, roleId: 0, role: 'CUSTOMER', pwd: huella }, env.jwt.secret, { expiresIn: '1h', ...opciones });

    it('alterar el jti dentro del token rompe la firma', async () => {
      const token = await entrar('cliente@test.pe');
      const [h, , f] = token.split('.');
      const cuerpo = Buffer.from(JSON.stringify({ ...leer(token), jti: 'c'.repeat(32) })).toString('base64url');
      assert.equal((await get('/auth/me', `${h}.${cuerpo}.${f}`)).status, 401);
    });

    it('firmar con otra clave no sirve ni para escalar a ADMIN', async () => {
      const falso = jwt.sign({ sub: userId, roleId: 1, role: 'ADMIN', pwd: huella }, 'clave-que-no-es-la-nuestra', {
        expiresIn: '1h', jwtid: 'd'.repeat(32),
      });
      assert.equal((await get('/auth/me', falso)).status, 401);
    });

    it('revocar un token no afecta a otro del mismo usuario con distinto jti', async () => {
      const token = await entrar('cliente@test.pe');
      await post('/auth/logout', {}, token);
      // Otro token del mismo usuario, con su propio jti: la revocación era de aquel, no de este.
      assert.equal((await get('/auth/me', firmar({ jwtid: 'e'.repeat(32) }))).status, 200);
    });

    it('un jti con comillas, comodines o muy largo no rompe la consulta', async () => {
      for (const raro of ["'", '"', '\\', '%', '_', "' OR '1'='1", 'x'.repeat(500)]) {
        const r = await get('/auth/me', firmar({ jwtid: raro }));
        assert.ok(r.status < 500, `jti «${raro.slice(0, 12)}» provocó ${r.status}`);
      }
    });
  });

  /* ==================================================== 8 · crecimiento */
  it('con mil revocaciones la búsqueda sigue yendo por clave primaria y la purga solo retira lo elegible', async () => {
    const id = (await queryOne<{ id: number }>("SELECT id FROM users WHERE email = 'cliente@test.pe'"))!.id;
    const vivas = 500;
    const purgables = 500;
    const valores: string[] = [];
    for (let i = 0; i < vivas; i += 1) valores.push(`('${`viva${i}`.padEnd(32, 'x')}', ${id}, DATE_ADD(NOW(), INTERVAL 8 HOUR), NOW())`);
    for (let i = 0; i < purgables; i += 1) {
      valores.push(`('${`old${i}`.padEnd(32, 'y')}', ${id}, DATE_SUB(NOW(), INTERVAL 20 HOUR), DATE_SUB(NOW(), INTERVAL ${VIDA + 7200} SECOND))`);
    }
    await execute(`INSERT INTO revoked_sessions (jti, user_id, expires_at, revoked_at) VALUES ${valores.join(',')}`);
    assert.equal(Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM revoked_sessions'))?.n), vivas + purgables);

    // La búsqueda de cada petición va por la clave primaria, no por barrido.
    const plan = await query<{ type: string; key: string | null; rows: number }>(
      'EXPLAIN SELECT jti FROM revoked_sessions WHERE jti = ?', ['viva0'.padEnd(32, 'x')],
    );
    assert.equal(plan[0]?.key, 'PRIMARY', 'la consulta por jti debe usar la clave primaria');

    const token = await entrar('cliente@test.pe');
    assert.equal((await get('/auth/me', token)).status, 200, 'autenticar sigue funcionando con la tabla llena');

    const borradas = await purgeExpiredRevocations();
    assert.equal(borradas, purgables, `debía purgar ${purgables} y purgó ${borradas}`);
    assert.equal(Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM revoked_sessions'))?.n), vivas, 'las vigentes se conservan');
  });

  /* ==================================================== 9 · rastro */
  it('la auditoría del cierre de sesión no guarda el token ni el jti', async () => {
    const token = await entrar('cliente@test.pe');
    const { jti, sub } = leer(token);
    await post('/auth/logout', {}, token);

    const entradas = await query<Record<string, unknown>>(
      "SELECT action, description, old_values, new_values FROM audit_logs WHERE entity_type = 'users' AND entity_id = ? ORDER BY id DESC LIMIT 3",
      [sub],
    );
    const texto = JSON.stringify(entradas);

    assert.ok(entradas.some((e) => e.action === 'LOGOUT'), 'el cierre de sesión debe dejar rastro');
    assert.ok(!texto.includes(jti), 'el jti no puede aparecer en la auditoría');
    assert.ok(!texto.includes(token.slice(0, 24)), 'el token no puede aparecer en la auditoría');
  });
});
