import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execute, query, queryOne } from '../config/database';
import { emailTransport, type MemoryTransport } from '../services/email.service';
import { verifyPassword } from '../utils/security';
import { post } from './helpers/api';
import { TEST_PASSWORD } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * Recuperación de contraseña con código de verificación (mockup 10).
 *
 * El transporte de correo de la suite es el de memoria, así que el código se obtiene
 * leyendo el mensaje entregado, nunca de la respuesta HTTP ni de la base.
 */
describe('Recuperación de contraseña', () => {
  let ctx: SuiteContext;
  let buzon: MemoryTransport;

  const CLIENTE = 'cliente@test.pe';

  before(async () => {
    ctx = await prepareSuite();
    buzon = emailTransport() as MemoryTransport;
  });
  after(teardownSuite);

  beforeEach(async () => {
    buzon.clear();
    await execute('DELETE FROM password_reset_tokens');
  });

  /** Extrae el código de 6 dígitos del último correo entregado. */
  function codigoDelCorreo(indice = 0): string {
    const mensaje = buzon.sent[indice];
    assert.ok(mensaje, 'no se entregó ningún correo');
    const encontrado = /\b(\d{6})\b/.exec(mensaje!.text);
    assert.ok(encontrado, `el correo no contiene un código de 6 dígitos:\n${mensaje!.text}`);
    return encontrado![1]!;
  }

  /** Recorre el flujo hasta obtener el ticket de un solo uso. */
  async function obtenerTicket(email = CLIENTE): Promise<{ code: string; ticket: string }> {
    buzon.clear();
    await post('/auth/forgot-password', { email });
    const code = codigoDelCorreo();
    const verificado = await post('/auth/verify-reset-code', { email, code });
    assert.equal(verificado.status, 200);
    return { code, ticket: verificado.body.data.ticket };
  }

  describe('Solicitud del código', () => {
    it('acepta un correo registrado y entrega el código por correo', async () => {
      const res = await post('/auth/forgot-password', { email: CLIENTE });

      assert.equal(res.status, 200);
      assert.equal(buzon.sent.length, 1, 'debe enviarse exactamente un correo');
      assert.equal(buzon.sent[0]!.to, CLIENTE);
      assert.match(buzon.sent[0]!.text, /\b\d{6}\b/, 'el correo debe incluir el código');
      assert.match(buzon.sent[0]!.text, /15 minutos/, 'debe indicar la caducidad');
      assert.match(buzon.sent[0]!.text, /ignora este mensaje/i, 'debe incluir el aviso de seguridad');
    });

    it('responde igual con un correo inexistente y no envía nada', async () => {
      const registrado = await post('/auth/forgot-password', { email: CLIENTE });
      buzon.clear();
      const desconocido = await post('/auth/forgot-password', { email: 'nadie-por-aqui@test.pe' });

      assert.equal(desconocido.status, registrado.status, 'mismo código de estado');
      assert.equal(desconocido.body.data.message, registrado.body.data.message, 'mismo mensaje: no revela si existe');
      assert.equal(buzon.sent.length, 0, 'no debe enviarse correo a una cuenta inexistente');
      assert.equal((await query('SELECT id FROM password_reset_tokens')).length, 1, 'no debe crearse una solicitud');
    });

    it('el mensaje genérico no nombra al usuario ni confirma la cuenta', async () => {
      const res = await post('/auth/forgot-password', { email: CLIENTE });
      const mensaje = String(res.body.data.message);
      assert.match(mensaje, /si el correo está registrado/i);
      assert.doesNotMatch(mensaje, /no existe|no encontrado|no registrado/i);
    });

    it('nunca devuelve el código en la respuesta HTTP', async () => {
      const res = await post('/auth/forgot-password', { email: CLIENTE });
      const codigo = codigoDelCorreo();
      assert.doesNotMatch(JSON.stringify(res.body), new RegExp(codigo), 'el código no puede viajar en la respuesta');
    });

    it('rechaza un correo con formato inválido', async () => {
      assert.equal((await post('/auth/forgot-password', { email: 'no-es-un-correo' })).status, 422);
      assert.equal((await post('/auth/forgot-password', {})).status, 422);
    });

    it('una cuenta no activa no recibe código', async () => {
      await execute("UPDATE users SET status = 'SUSPENDED' WHERE email = ?", [CLIENTE]);
      try {
        const res = await post('/auth/forgot-password', { email: CLIENTE });
        assert.equal(res.status, 200, 'la respuesta sigue siendo genérica');
        assert.equal(buzon.sent.length, 0, 'pero no se envía nada');
      } finally {
        await execute("UPDATE users SET status = 'ACTIVE' WHERE email = ?", [CLIENTE]);
      }
    });

    it('una solicitud nueva invalida la anterior', async () => {
      await post('/auth/forgot-password', { email: CLIENTE });
      const primerCodigo = codigoDelCorreo();

      buzon.clear();
      await post('/auth/forgot-password', { email: CLIENTE });
      const segundoCodigo = codigoDelCorreo();

      const conElViejo = await post('/auth/verify-reset-code', { email: CLIENTE, code: primerCodigo });
      assert.equal(conElViejo.status, 400, 'el código anterior deja de servir');

      const conElNuevo = await post('/auth/verify-reset-code', { email: CLIENTE, code: segundoCodigo });
      assert.equal(conElNuevo.status, 200);
    });
  });

  describe('Almacenamiento del código', () => {
    it('en la base solo hay hashes, nunca el código en claro', async () => {
      await post('/auth/forgot-password', { email: CLIENTE });
      const codigo = codigoDelCorreo();

      const filas = await query<{ token_hash: string; ticket_hash: string | null }>(
        'SELECT token_hash, ticket_hash FROM password_reset_tokens',
      );
      assert.equal(filas.length, 1);
      assert.notEqual(filas[0]!.token_hash, codigo, 'el hash no puede ser el código');
      assert.doesNotMatch(filas[0]!.token_hash, new RegExp(codigo), 'el código no puede aparecer dentro del hash');
      assert.match(filas[0]!.token_hash, /^[a-f0-9]{64}$/, 'debe ser un sha256 en hexadecimal');
    });

    it('el código de un usuario no sirve para otro', async () => {
      await post('/auth/forgot-password', { email: CLIENTE });
      const codigoDelCliente = codigoDelCorreo();

      buzon.clear();
      await post('/auth/forgot-password', { email: 'empresa-a@test.pe' });

      const cruzado = await post('/auth/verify-reset-code', { email: 'empresa-a@test.pe', code: codigoDelCliente });
      assert.equal(cruzado.status, 400, 'el código de otra cuenta no puede verificarse');
    });

    it('el hash de dos usuarios difiere aunque el código fuera el mismo', async () => {
      await post('/auth/forgot-password', { email: CLIENTE });
      await post('/auth/forgot-password', { email: 'empresa-a@test.pe' });

      const hashes = await query<{ token_hash: string }>('SELECT token_hash FROM password_reset_tokens');
      assert.equal(hashes.length, 2);
      assert.notEqual(hashes[0]!.token_hash, hashes[1]!.token_hash);
    });
  });

  describe('Verificación del código', () => {
    it('un código correcto devuelve un ticket y no un JWT', async () => {
      await post('/auth/forgot-password', { email: CLIENTE });
      const res = await post('/auth/verify-reset-code', { email: CLIENTE, code: codigoDelCorreo() });

      assert.equal(res.status, 200);
      assert.match(res.body.data.ticket, /^[a-f0-9]{64}$/);
      assert.equal(res.body.data.token, undefined, 'no debe iniciarse sesión');
      assert.equal(res.body.data.user, undefined, 'no debe devolverse el usuario');
    });

    it('un código incorrecto se rechaza y suma un intento', async () => {
      await post('/auth/forgot-password', { email: CLIENTE });

      const res = await post('/auth/verify-reset-code', { email: CLIENTE, code: '000000' });
      assert.equal(res.status, 400);

      const fila = await queryOne<{ attempts: number }>('SELECT attempts FROM password_reset_tokens ORDER BY id DESC LIMIT 1');
      assert.equal(Number(fila?.attempts), 1);
    });

    it('un código expirado se rechaza', async () => {
      await post('/auth/forgot-password', { email: CLIENTE });
      const codigo = codigoDelCorreo();
      await execute('UPDATE password_reset_tokens SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE)');

      const res = await post('/auth/verify-reset-code', { email: CLIENTE, code: codigo });
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /expirado/i);

      const fila = await queryOne<{ used_at: string | null }>('SELECT used_at FROM password_reset_tokens ORDER BY id DESC LIMIT 1');
      assert.ok(fila?.used_at, 'la solicitud vencida queda consumida');
    });

    it('bloquea tras cinco intentos fallidos', async () => {
      await post('/auth/forgot-password', { email: CLIENTE });
      const codigo = codigoDelCorreo();

      for (let intento = 1; intento <= 4; intento += 1) {
        assert.equal((await post('/auth/verify-reset-code', { email: CLIENTE, code: '000000' })).status, 400, `intento ${intento}`);
      }

      const quinto = await post('/auth/verify-reset-code', { email: CLIENTE, code: '000000' });
      assert.equal(quinto.status, 429, 'el quinto fallo agota los intentos');

      const conElBueno = await post('/auth/verify-reset-code', { email: CLIENTE, code: codigo });
      assert.notEqual(conElBueno.status, 200, 'ni siquiera el código correcto sirve ya');
    });

    it('rechaza códigos que no sean de seis dígitos', async () => {
      await post('/auth/forgot-password', { email: CLIENTE });
      for (const code of ['12345', '1234567', 'abcdef', '', '12 34 56']) {
        assert.equal((await post('/auth/verify-reset-code', { email: CLIENTE, code })).status, 422, `code="${code}"`);
      }
    });

    it('no permite verificar sin haber solicitado nada', async () => {
      assert.equal((await post('/auth/verify-reset-code', { email: CLIENTE, code: '123456' })).status, 400);
    });
  });

  describe('Cambio de contraseña', () => {
    const NUEVA = 'NuevaClave2026';

    /** Devuelve la cuenta a su contraseña original para no arrastrar estado entre tests. */
    async function restaurarPassword() {
      const { ticket } = await obtenerTicket();
      await post('/auth/reset-password', { email: CLIENTE, ticket, new_password: TEST_PASSWORD });
    }

    it('cambia la contraseña con un ticket válido', async () => {
      const { ticket } = await obtenerTicket();

      const res = await post('/auth/reset-password', { email: CLIENTE, ticket, new_password: NUEVA });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.token, undefined, 'no debe iniciar sesión automáticamente');

      const conLaNueva = await post('/auth/login', { email: CLIENTE, password: NUEVA });
      assert.equal(conLaNueva.status, 200, 'la contraseña nueva funciona');

      const conLaVieja = await post('/auth/login', { email: CLIENTE, password: TEST_PASSWORD });
      assert.equal(conLaVieja.status, 401, 'la contraseña anterior deja de funcionar');

      await restaurarPassword();
    });

    it('guarda la contraseña con bcrypt, nunca en claro', async () => {
      const { ticket } = await obtenerTicket();
      await post('/auth/reset-password', { email: CLIENTE, ticket, new_password: NUEVA });

      const fila = await queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = ?', [CLIENTE]);
      assert.ok(fila);
      assert.notEqual(fila!.password_hash, NUEVA);
      assert.match(fila!.password_hash, /^\$2[aby]\$/, 'debe ser un hash bcrypt');
      assert.ok(await verifyPassword(NUEVA, fila!.password_hash), 'el hash corresponde a la nueva contraseña');

      await restaurarPassword();
    });

    it('el ticket es de un solo uso', async () => {
      const { ticket } = await obtenerTicket();

      assert.equal((await post('/auth/reset-password', { email: CLIENTE, ticket, new_password: NUEVA })).status, 200);
      const repetido = await post('/auth/reset-password', { email: CLIENTE, ticket, new_password: 'OtraClave2026' });
      assert.equal(repetido.status, 400, 'el mismo ticket no puede reutilizarse');

      assert.equal((await post('/auth/login', { email: CLIENTE, password: 'OtraClave2026' })).status, 401);

      await restaurarPassword();
    });

    it('el código ya no sirve para cambiar la contraseña', async () => {
      const { code, ticket } = await obtenerTicket();

      // El endpoint exige el ticket: enviar el código en su lugar debe fallar la validación.
      const conCodigo = await post('/auth/reset-password', { email: CLIENTE, ticket: code, new_password: NUEVA });
      assert.equal(conCodigo.status, 422, 'el código no tiene el formato de un ticket');

      assert.equal((await post('/auth/reset-password', { email: CLIENTE, ticket, new_password: TEST_PASSWORD })).status, 200);
    });

    it('el ticket de un usuario no sirve para otro', async () => {
      const { ticket } = await obtenerTicket();

      const cruzado = await post('/auth/reset-password', { email: 'empresa-a@test.pe', ticket, new_password: NUEVA });
      assert.equal(cruzado.status, 400, 'el ticket está ligado a su usuario');

      const empresa = await queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = ?', ['empresa-a@test.pe']);
      assert.ok(await verifyPassword(TEST_PASSWORD, empresa!.password_hash), 'la otra cuenta no se toca');
    });

    it('un ticket expirado se rechaza', async () => {
      const { ticket } = await obtenerTicket();
      await execute('UPDATE password_reset_tokens SET ticket_expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE)');

      const res = await post('/auth/reset-password', { email: CLIENTE, ticket, new_password: NUEVA });
      assert.equal(res.status, 400);
      assert.match(String(res.body.message), /expirad/i);
    });

    it('rechaza una contraseña que no cumple las reglas', async () => {
      const { ticket } = await obtenerTicket();
      for (const new_password of ['corta', 'sinmayusculas1', 'SINNUMEROS', '']) {
        const res = await post('/auth/reset-password', { email: CLIENTE, ticket, new_password });
        assert.equal(res.status, 422, `contraseña "${new_password}"`);
      }
      assert.ok(await verifyPassword(TEST_PASSWORD, (await queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = ?', [CLIENTE]))!.password_hash));
    });

    it('rechaza cuando la confirmación no coincide', async () => {
      const { ticket } = await obtenerTicket();
      const res = await post('/auth/reset-password', {
        email: CLIENTE, ticket, new_password: NUEVA, confirm_password: 'OtraDistinta2026',
      });
      assert.equal(res.status, 422);
      assert.equal(res.body.errors?.confirm_password, 'Las contraseñas no coinciden');
    });

    it('tras el cambio se consumen todas las solicitudes del usuario', async () => {
      const { ticket } = await obtenerTicket();
      await post('/auth/reset-password', { email: CLIENTE, ticket, new_password: NUEVA });

      const vivas = await query('SELECT id FROM password_reset_tokens WHERE user_id = (SELECT id FROM users WHERE email = ?) AND used_at IS NULL', [CLIENTE]);
      assert.equal(vivas.length, 0);

      await restaurarPassword();
    });

    it('envía el correo de confirmación del cambio', async () => {
      const { ticket } = await obtenerTicket();
      buzon.clear();
      await post('/auth/reset-password', { email: CLIENTE, ticket, new_password: NUEVA });

      assert.equal(buzon.sent.length, 1);
      assert.equal(buzon.sent[0]!.to, CLIENTE);
      assert.match(buzon.sent[0]!.subject, /actualizada/i);

      await restaurarPassword();
    });
  });

  describe('Reenvío del código', () => {
    it('genera un código nuevo e invalida el anterior', async () => {
      await post('/auth/forgot-password', { email: CLIENTE });
      const primero = codigoDelCorreo();

      buzon.clear();
      const res = await post('/auth/resend-reset-code', { email: CLIENTE });
      assert.equal(res.status, 200);
      assert.equal(buzon.sent.length, 1, 'se entrega un correo nuevo');
      const segundo = codigoDelCorreo();

      assert.equal((await post('/auth/verify-reset-code', { email: CLIENTE, code: primero })).status, 400, 'el anterior queda invalidado');
      assert.equal((await post('/auth/verify-reset-code', { email: CLIENTE, code: segundo })).status, 200);
    });

    it('respeta el cooldown entre reenvíos', async () => {
      const original = process.env.PASSWORD_RESET_RESEND_COOLDOWN_SECONDS;
      process.env.PASSWORD_RESET_RESEND_COOLDOWN_SECONDS = '45';
      const { env } = await import('../config/env');
      env.passwordReset.resendCooldownSeconds = 45;

      try {
        await post('/auth/forgot-password', { email: CLIENTE });
        const res = await post('/auth/resend-reset-code', { email: CLIENTE });
        assert.equal(res.status, 429, 'reenviar de inmediato se rechaza');
        assert.match(String(res.body.message), /segundos/i);
      } finally {
        env.passwordReset.resendCooldownSeconds = 0;
        process.env.PASSWORD_RESET_RESEND_COOLDOWN_SECONDS = original;
      }
    });

    it('con un correo desconocido responde igual y sin enviar nada', async () => {
      const res = await post('/auth/resend-reset-code', { email: 'nadie-por-aqui@test.pe' });
      assert.equal(res.status, 200);
      assert.equal(buzon.sent.length, 0);
    });
  });

  describe('Seguridad de los endpoints', () => {
    it('ningún endpoint devuelve password_hash', async () => {
      await post('/auth/forgot-password', { email: CLIENTE });
      const verificado = await post('/auth/verify-reset-code', { email: CLIENTE, code: codigoDelCorreo() });
      const cambiado = await post('/auth/reset-password', {
        email: CLIENTE, ticket: verificado.body.data.ticket, new_password: TEST_PASSWORD,
      });

      for (const res of [verificado, cambiado]) {
        const cuerpo = JSON.stringify(res.body);
        assert.doesNotMatch(cuerpo, /password_hash/i);
        assert.doesNotMatch(cuerpo, /\$2[aby]\$/);
      }
    });

    it('resiste inyección SQL en el correo y en el código', async () => {
      const ataques = [
        "cliente@test.pe' OR '1'='1",
        "'; DROP TABLE password_reset_tokens; --",
        "cliente@test.pe'; UPDATE users SET password_hash='x' WHERE '1'='1",
      ];
      for (const email of ataques) {
        const res = await post('/auth/forgot-password', { email });
        assert.ok([200, 422].includes(res.status), `${email} -> ${res.status}`);
      }
      await post('/auth/verify-reset-code', { email: CLIENTE, code: "1' OR '1'='1" });

      const tabla = await query('SELECT id FROM password_reset_tokens');
      assert.ok(Array.isArray(tabla), 'la tabla sigue existiendo');
      const usuario = await queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = ?', [CLIENTE]);
      assert.ok(await verifyPassword(TEST_PASSWORD, usuario!.password_hash), 'ninguna contraseña fue alterada');
    });

    it('ignora campos ajenos al esquema (mass assignment)', async () => {
      const { ticket } = await obtenerTicket();
      const antes = await queryOne<{ id: number; role_id: number; status: string }>(
        'SELECT id, role_id, status FROM users WHERE email = ?', [CLIENTE],
      );

      const res = await post('/auth/reset-password', {
        email: CLIENTE,
        ticket,
        new_password: TEST_PASSWORD,
        user_id: 1,
        role_id: 1,
        status: 'SUSPENDED',
        email_verified_at: '2020-01-01 00:00:00',
      });
      assert.equal(res.status, 200);

      const despues = await queryOne<{ id: number; role_id: number; status: string }>(
        'SELECT id, role_id, status FROM users WHERE email = ?', [CLIENTE],
      );
      assert.equal(Number(despues?.role_id), Number(antes?.role_id), 'el rol no cambia');
      assert.equal(despues?.status, antes?.status, 'el estado no cambia');

      const admin = await queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = 1');
      assert.ok(await verifyPassword(TEST_PASSWORD, admin!.password_hash), 'no se tocó el usuario id 1');
    });

    it('no permite reutilizar una solicitud ya consumida', async () => {
      const { code, ticket } = await obtenerTicket();
      await post('/auth/reset-password', { email: CLIENTE, ticket, new_password: TEST_PASSWORD });

      assert.equal((await post('/auth/verify-reset-code', { email: CLIENTE, code })).status, 400);
      assert.equal((await post('/auth/reset-password', { email: CLIENTE, ticket, new_password: TEST_PASSWORD })).status, 400);
    });

    it('los cuatro endpoints son públicos y no exigen sesión', async () => {
      for (const ruta of ['/auth/forgot-password', '/auth/resend-reset-code']) {
        assert.notEqual((await post(ruta, { email: CLIENTE })).status, 401, ruta);
      }
      assert.notEqual((await post('/auth/verify-reset-code', { email: CLIENTE, code: '123456' })).status, 401);
      assert.notEqual((await post('/auth/reset-password', { email: CLIENTE, ticket: 'a'.repeat(64), new_password: TEST_PASSWORD })).status, 401);
    });
  });
});
