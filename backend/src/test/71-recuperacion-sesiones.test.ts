import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { api, get, post } from './helpers/api';
import { env } from '../config/env';
import { execute, query, queryOne } from '../config/database';
import { emailTransport, type MemoryTransport } from '../services/email.service';
import { TEST_PASSWORD } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * F17C-SEC-04 · recuperación de contraseña: sesiones, concurrencia y atributos.
 *
 * QUÉ CUBRE Y POR QUÉ. La suite `11-password-reset` ya defiende el flujo en sí —código,
 * hashes, intentos, expiración, un solo uso, enumeración—. La auditoría F17C-SEC-04 encontró
 * que NO estaban cubiertas tres propiedades que el flujo sí cumple, y que son justo las que
 * más caro sale perder en una refactorización:
 *
 *   · Que restablecer la contraseña EXPULSE las sesiones abiertas. No hay ninguna llamada
 *     explícita que lo haga: funciona porque `authenticate` compara la huella del
 *     `password_hash` vigente, y el reset cambia ese hash. Es una garantía indirecta, y por
 *     eso conviene tener un test que la fije: si alguien desacopla la huella, esto lo caza.
 *   · Que dos restablecimientos simultáneos con el mismo ticket dejen UNA sola contraseña.
 *   · Que el reset no toque el rol, la empresa ni el estado de la cuenta.
 *
 * El correo va al transporte en memoria que impone `helpers/testEnv`: no sale ningún mensaje.
 */
describe('SEC-04 · sesiones, concurrencia y atributos tras el restablecimiento', () => {
  let ctx: SuiteContext;
  const buzon = emailTransport() as MemoryTransport;
  const NUEVA = 'NuevaClaveSec04';

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  beforeEach(async () => {
    buzon.clear();
    await execute('DELETE FROM password_reset_tokens');
  });

  const usuario = async (email: string) =>
    queryOne<{ id: number; role_id: number; status: string; password_hash: string }>(
      'SELECT id, role_id, status, password_hash FROM users WHERE email = ? LIMIT 1',
      [email],
    );

  /** Recorre las tres fases y devuelve el ticket de un solo uso. */
  async function obtenerTicket(email: string): Promise<string> {
    buzon.clear();
    const solicitud = await post('/auth/forgot-password', { email });
    assert.equal(solicitud.status, 200, JSON.stringify(solicitud.body));
    const mensaje = buzon.sent.at(-1);
    assert.ok(mensaje, 'no se entregó ningún correo');
    const codigo = /\b(\d{6})\b/.exec(mensaje!.text);
    assert.ok(codigo, 'el correo no trae un código de 6 dígitos');
    const verificado = await post('/auth/verify-reset-code', { email, code: codigo![1] });
    assert.equal(verificado.status, 200, JSON.stringify(verificado.body));
    return String(verificado.body.data.ticket);
  }

  /** Deja la cuenta con la contraseña de las fixtures. */
  async function restaurar(email: string): Promise<void> {
    await execute('DELETE FROM password_reset_tokens');
    const ticket = await obtenerTicket(email);
    const r = await post('/auth/reset-password', { email, ticket, new_password: TEST_PASSWORD });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }

  /* ===================================================== 12 · invalidación de sesiones */
  describe('12 · el restablecimiento expulsa las sesiones abiertas', () => {
    it('un JWT emitido ANTES del reset deja de valer después', async () => {
      const email = 'cliente@test.pe';

      // 1 y 2 · iniciar sesión y guardar el token.
      const login = await post('/auth/login', { email, password: TEST_PASSWORD });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      const tokenViejo = String(login.body.data.token);

      // El token funciona antes del reset.
      assert.equal((await get('/auth/me', tokenViejo)).status, 200);

      // 3 y 4 · pedir el reset y cambiar la contraseña.
      const ticket = await obtenerTicket(email);
      const reset = await post('/auth/reset-password', { email, ticket, new_password: NUEVA });
      assert.equal(reset.status, 200, JSON.stringify(reset.body));

      // 5 y 6 · el token anterior ya no entra.
      const despues = await get('/auth/me', tokenViejo);
      assert.equal(despues.status, 401, 'el JWT anterior al reset debe quedar invalidado');
      assert.match(String(despues.body.message), /sesi[óo]n/i);

      await restaurar(email);
    });

    it('el token anterior tampoco sirve en otras rutas protegidas', async () => {
      const email = 'cliente@test.pe';
      const login = await post('/auth/login', { email, password: TEST_PASSWORD });
      const tokenViejo = String(login.body.data.token);

      const ticket = await obtenerTicket(email);
      await post('/auth/reset-password', { email, ticket, new_password: NUEVA });

      for (const ruta of ['/bookings', '/notifications', '/auth/me']) {
        assert.equal((await get(ruta, tokenViejo)).status, 401, `${ruta} debería rechazar el token anterior`);
      }

      await restaurar(email);
    });

    it('la huella de la sesión cambia porque cambia el hash de la contraseña', async () => {
      const email = 'cliente@test.pe';
      const antes = await usuario(email);
      const ticket = await obtenerTicket(email);
      await post('/auth/reset-password', { email, ticket, new_password: NUEVA });
      const despues = await usuario(email);

      // No se comprueba el hash en sí, sino que cambió: de ahí sale la invalidación.
      assert.notEqual(despues?.password_hash, antes?.password_hash);
      await restaurar(email);
    });
  });

  /* ===================================================== 13 · atributos de la cuenta */
  describe('13 · el restablecimiento no altera quién es el usuario', () => {
    for (const [etiqueta, email] of [
      ['CUSTOMER', 'cliente@test.pe'],
      ['COMPANY_ADMIN', 'empresa-a@test.pe'],
      ['OPERATOR', 'operador-a@test.pe'],
      ['ADMIN', 'admin@test.pe'],
    ] as const) {
      it(`${etiqueta} conserva rol, estado y empresa`, async () => {
        const antes = await usuario(email);
        const vinculosAntes = await query<{ company_id: number }>('SELECT company_id FROM company_users WHERE user_id = ?', [antes!.id]);

        const ticket = await obtenerTicket(email);
        const reset = await post('/auth/reset-password', { email, ticket, new_password: NUEVA });
        assert.equal(reset.status, 200, JSON.stringify(reset.body));

        const despues = await usuario(email);
        const vinculosDespues = await query<{ company_id: number }>('SELECT company_id FROM company_users WHERE user_id = ?', [antes!.id]);

        assert.equal(despues?.role_id, antes?.role_id, 'el rol no puede cambiar');
        assert.equal(despues?.status, antes?.status, 'el estado no puede cambiar');
        assert.deepEqual(vinculosDespues, vinculosAntes, 'los vínculos con empresas no pueden cambiar');

        // La contraseña antigua deja de servir y la nueva entra.
        assert.equal((await post('/auth/login', { email, password: TEST_PASSWORD })).status, 401);
        assert.equal((await post('/auth/login', { email, password: NUEVA })).status, 200);

        await restaurar(email);
      });
    }
  });

  /* ===================================================== 18 · replay y concurrencia */
  describe('18 · dos restablecimientos a la vez con el mismo ticket', () => {
    it('exactamente uno cambia la contraseña y queda UNA sola válida', async () => {
      const email = 'cliente@test.pe';
      const ticket = await obtenerTicket(email);
      const OTRA = 'OtraClaveSec04X';

      const [a, b] = await Promise.all([
        post('/auth/reset-password', { email, ticket, new_password: NUEVA }),
        post('/auth/reset-password', { email, ticket, new_password: OTRA }),
      ]);

      const exitos = [a, b].filter((r) => r.status === 200).length;
      assert.equal(exitos, 1, `esperaba un solo éxito y hubo ${exitos}: ${a.status}/${b.status}`);

      const conNueva = await post('/auth/login', { email, password: NUEVA });
      const conOtra = await post('/auth/login', { email, password: OTRA });
      const validas = [conNueva, conOtra].filter((r) => r.status === 200).length;
      assert.equal(validas, 1, 'solo puede quedar una contraseña válida');
      assert.equal((await post('/auth/login', { email, password: TEST_PASSWORD })).status, 401);

      await restaurar(email);
    });

    it('el ticket ya consumido no vuelve a servir', async () => {
      const email = 'cliente@test.pe';
      const ticket = await obtenerTicket(email);
      assert.equal((await post('/auth/reset-password', { email, ticket, new_password: NUEVA })).status, 200);

      const replay = await post('/auth/reset-password', { email, ticket, new_password: 'TerceraClave9' });
      assert.equal(replay.status, 400, JSON.stringify(replay.body));
      // La contraseña del replay no puede haber entrado.
      assert.equal((await post('/auth/login', { email, password: 'TerceraClave9' })).status, 401);

      await restaurar(email);
    });
  });

  /* ===================================================== 21 · estado de la cuenta */
  describe('21 · el restablecimiento no reactiva ni crea cuentas', () => {
    it('una cuenta SUSPENDED no recibe código y sigue suspendida', async () => {
      const email = 'cliente@test.pe';
      const antes = await usuario(email);
      await execute("UPDATE users SET status = 'SUSPENDED' WHERE id = ?", [antes!.id]);
      buzon.clear();

      const r = await post('/auth/forgot-password', { email });
      const solicitudes = await query<{ n: number }>('SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ?', [antes!.id]);
      const despues = await usuario(email);
      await execute("UPDATE users SET status = 'ACTIVE' WHERE id = ?", [antes!.id]);

      assert.equal(r.status, 200, 'la respuesta es genérica, no delata el estado');
      assert.equal(buzon.sent.length, 0, 'no se envía ningún correo');
      assert.equal(Number(solicitudes[0]?.n), 0, 'no se genera ninguna solicitud');
      assert.equal(despues?.status, 'SUSPENDED', 'la cuenta sigue suspendida');
    });

    it('un correo desconocido no crea ningún usuario', async () => {
      const antes = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM users');
      const r = await post('/auth/forgot-password', { email: 'jamas-existio-sec04@test.pe' });
      const despues = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM users');

      assert.equal(r.status, 200);
      assert.equal(Number(despues?.n), Number(antes?.n));
      assert.equal(buzon.sent.length, 0);
    });
  });

  /* ===================================================== 19 · auditoría sin secretos */
  it('19 · la auditoría del restablecimiento no guarda código, ticket ni contraseña', async () => {
    const email = 'cliente@test.pe';
    buzon.clear();
    await post('/auth/forgot-password', { email });
    const codigo = /\b(\d{6})\b/.exec(buzon.sent.at(-1)!.text)![1]!;
    const verificado = await post('/auth/verify-reset-code', { email, code: codigo });
    const ticket = String(verificado.body.data.ticket);
    const reset = await post('/auth/reset-password', { email, ticket, new_password: NUEVA });
    assert.equal(reset.status, 200);

    const id = (await usuario(email))!.id;
    const entradas = await query<Record<string, unknown>>(
      "SELECT action, description, old_values, new_values FROM audit_logs WHERE entity_type = 'users' AND entity_id = ? ORDER BY id DESC LIMIT 5",
      [id],
    );
    const texto = JSON.stringify(entradas);

    assert.ok(entradas.length > 0, 'el restablecimiento debe dejar rastro');
    assert.ok(!texto.includes(codigo), 'el código no puede aparecer en la auditoría');
    assert.ok(!texto.includes(ticket), 'el ticket no puede aparecer en la auditoría');
    assert.ok(!texto.includes(NUEVA), 'la contraseña no puede aparecer en la auditoría');
    assert.ok(!/password_hash/i.test(texto), 'el hash no puede aparecer en la auditoría');

    await restaurar(email);
  });

  /* ===================================================== 15 · abuso de envío de correo */
  describe('15 · el cooldown por cuenta limita el envío de correos', () => {
    let cooldownOriginal = 0;

    before(() => {
      // `testEnv` lo pone a 0 para que la batería no espere 45 s reales; con ese valor la
      // defensa está apagada y medirla no demostraría nada. Se restaura sólo aquí.
      cooldownOriginal = env.passwordReset.resendCooldownSeconds;
      (env.passwordReset as { resendCooldownSeconds: number }).resendCooldownSeconds = 45;
    });
    after(() => {
      (env.passwordReset as { resendCooldownSeconds: number }).resendCooldownSeconds = cooldownOriginal;
    });

    it('cuatro solicitudes seguidas envían un solo correo, aunque cambie el uso de mayúsculas', async () => {
      const email = 'cliente@test.pe';
      buzon.clear();

      for (let i = 0; i < 4; i += 1) {
        const r = await post('/auth/forgot-password', { email: i % 2 === 0 ? email : email.toUpperCase() });
        assert.equal(r.status, 200, 'la respuesta es siempre genérica');
      }

      assert.equal(buzon.sent.length, 1, 'el cooldown debe cortar los tres envíos siguientes');
      const solicitudes = await query<{ n: number }>('SELECT COUNT(*) AS n FROM password_reset_tokens');
      assert.equal(Number(solicitudes[0]?.n), 1, 'tampoco puede acumular solicitudes');
    });

    it('el reenvío explícito dentro del cooldown responde 429', async () => {
      const email = 'cliente@test.pe';
      await post('/auth/forgot-password', { email });
      const reenvio = await post('/auth/resend-reset-code', { email });

      assert.equal(reenvio.status, 429, JSON.stringify(reenvio.body));
      assert.match(String(reenvio.body.message), /espera/i);
    });

    it('pasado el cooldown, el reenvío vuelve a funcionar', async () => {
      const email = 'cliente@test.pe';
      await post('/auth/forgot-password', { email });
      // Se adelanta la fila en el tiempo en lugar de esperar de verdad.
      await execute('UPDATE password_reset_tokens SET created_at = DATE_SUB(NOW(), INTERVAL 2 MINUTE)');
      buzon.clear();

      const reenvio = await post('/auth/resend-reset-code', { email });
      assert.equal(reenvio.status, 200, JSON.stringify(reenvio.body));
      assert.equal(buzon.sent.length, 1);
    });

    it('el reenvío de una cuenta desconocida responde igual y no envía nada', async () => {
      buzon.clear();
      const r = await post('/auth/resend-reset-code', { email: 'no-existe-sec04@test.pe' });
      assert.equal(r.status, 200, 'no puede delatar que la cuenta no existe');
      assert.equal(buzon.sent.length, 0);
    });
  });
});
