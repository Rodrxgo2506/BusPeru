import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { post } from './helpers/api';
import { env } from '../config/env';
import {
  ResendTransport,
  htmlEnvelope,
  sendEmail,
  setEmailTransport,
  type EmailMessage,
  type ResendClient,
} from '../services/email.service';
import { execute, queryOne } from '../config/database';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

// H-31: el fallo de envío se registra por el registrador saneado, que en la suite solo escribe con esta marca.
process.env.LOG_ERRORS = 'true';

/**
 * Integración de Resend como transporte de correo.
 *
 * NINGUNA de estas pruebas sale a la red: el transporte acepta un cliente inyectado y aquí
 * se le pasa un doble que apunta lo que se le pidió enviar. La clave real no interviene, no
 * hace falta para probar nada de esto, y no aparece en ningún punto del archivo.
 *
 * Lo que se fija aquí es que añadir un proveedor NO cambió la semántica que ya tenía el
 * servicio: `sendEmail` sigue devolviendo `false` en vez de lanzar, porque un fallo de correo
 * no puede tumbar una operación de negocio que sí se completó.
 */
describe('Correo transaccional con Resend', () => {
  let ctx: SuiteContext;

  /** Doble del SDK: apunta cada envío y puede simular un rechazo del proveedor. */
  function clienteFalso(fallo?: { message: string; name?: string }) {
    const enviados: Array<Record<string, unknown>> = [];
    const cliente: ResendClient = {
      emails: {
        async send(payload) {
          enviados.push({ ...payload });
          if (fallo) return { data: null, error: fallo };
          return { data: { id: 'correo-de-prueba' }, error: null };
        },
      },
    };
    return { cliente, enviados };
  }

  const original = console.error;
  let registrado: string[] = [];

  before(async () => {
    ctx = await prepareSuite();
  });
  after(async () => {
    console.error = original;
    setEmailTransport(null);
    await teardownSuite();
  });

  beforeEach(() => {
    registrado = [];
    console.error = (...args: unknown[]) => {
      registrado.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack}` : String(a))).join(' '));
    };
  });

  afterEach(() => {
    console.error = original;
    setEmailTransport(null);
  });

  const mensaje: EmailMessage = {
    to: 'destinatario@test.pe',
    subject: 'Asunto de prueba',
    text: 'Primera línea.\n\nSegunda línea.',
  };

  /* ══════════════════════════════ configuración ══════════════════════════════ */

  describe('Configuración y credenciales', () => {
    it('1 · sin RESEND_API_KEY el transporte dice qué falta y no inventa un envío', async () => {
      const previa = env.resend.apiKey;
      env.resend.apiKey = '';
      try {
        await assert.rejects(() => new ResendTransport().send(mensaje), /Falta RESEND_API_KEY/);
      } finally {
        env.resend.apiKey = previa;
      }
    });

    it('2 · con la clave puesta, el cliente se construye sin salir a la red', async () => {
      const previa = env.resend.apiKey;
      // Valor local de usar y tirar: no es una credencial y no sale de esta prueba.
      env.resend.apiKey = 'clave-local-de-prueba';
      try {
        const transporte = new ResendTransport();
        // Construir el cliente no hace ninguna petición; el fallo llega al intentar enviar
        // contra la API con una clave que no existe, y eso ya no se prueba aquí.
        await assert.doesNotReject(async () => {
          const { Resend } = await import('resend');
          assert.ok(new Resend(env.resend.apiKey));
        });
        assert.equal(transporte.name, 'resend');
      } finally {
        env.resend.apiKey = previa;
      }
    });

    it('3 · el remitente sale de RESEND_FROM_EMAIL, no del código', async () => {
      const { cliente, enviados } = clienteFalso();
      await new ResendTransport(cliente).send(mensaje);

      assert.equal(enviados[0]!.from, env.resend.from);
      assert.match(String(env.resend.from), /@/);
    });

    it('4 · el remitente por defecto es el de desarrollo de Resend, sin dominio inventado', async () => {
      assert.match(String(env.resend.from), /onboarding@resend\.dev/);
    });
  });

  /* ══════════════════════════════ envío ═════════════════════════════════════ */

  describe('Lo que se envía', () => {
    it('5 · llega al destinatario y con el asunto indicados', async () => {
      const { cliente, enviados } = clienteFalso();

      await new ResendTransport(cliente).send(mensaje);

      assert.equal(enviados.length, 1);
      assert.equal(enviados[0]!.to, 'destinatario@test.pe');
      assert.equal(enviados[0]!.subject, 'Asunto de prueba');
      assert.equal(enviados[0]!.text, mensaje.text);
    });

    it('6 · el correo lleva HTML aunque la plantilla sea de texto', async () => {
      const { cliente, enviados } = clienteFalso();

      await new ResendTransport(cliente).send(mensaje);

      const html = String(enviados[0]!.html);
      assert.ok(html.includes('Asunto de prueba'));
      assert.ok(html.includes('Primera línea.'));
      assert.ok(html.includes('Segunda línea.'));
      // Documento completo con la identidad de BusPerú, no un fragmento suelto.
      assert.ok(html.startsWith('<!DOCTYPE html>'));
      assert.ok(html.includes('<meta name="viewport"'), 'debe verse bien en el móvil');
      assert.ok(html.includes('BusPerú'), 'cabecera de marca');
      assert.ok(html.includes('No respondas a esta dirección'), 'pie corporativo');
    });

    it('7 · el HTML escapa el contenido: no se puede inyectar marcado', async () => {
      const html = htmlEnvelope({
        to: 'x@test.pe',
        subject: '<img src=x onerror=alert(1)>',
        text: 'Hola <script>alert(1)</script> & "comillas"',
      });

      // Lo que importa no es que las palabras desaparezcan, sino que ningún `<` del
      // contenido sobreviva sin escapar: así nada de lo escrito puede abrir una etiqueta.
      assert.ok(!html.includes('<script'), 'no puede quedar una etiqueta script real');
      assert.ok(!html.includes('<img'), 'ni una etiqueta img con manejador');
      assert.ok(html.includes('&lt;script&gt;'));
      assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'el asunto queda como texto inerte');
      assert.ok(html.includes('&amp;') && html.includes('&quot;'));
    });

    it('8 · si el mensaje ya trae su propio HTML, se respeta tal cual', async () => {
      const { cliente, enviados } = clienteFalso();

      await new ResendTransport(cliente).send({ ...mensaje, html: '<p>plantilla propia</p>' });

      assert.equal(enviados[0]!.html, '<p>plantilla propia</p>');
    });
  });

  /* ══════════════════════════════ errores ═══════════════════════════════════ */

  describe('Cuando Resend rechaza el envío', () => {
    it('9 · el fallo se registra y `sendEmail` devuelve false sin lanzar', async () => {
      const { cliente } = clienteFalso({ message: 'domain is not verified', name: 'validation_error' });
      setEmailTransport(new ResendTransport(cliente));

      const entregado = await sendEmail(mensaje);

      assert.equal(entregado, false, 'un fallo de correo no puede propagarse como excepción');
      assert.equal(registrado.length, 1);
      assert.match(registrado[0]!, /domain is not verified/);
    });

    it('10 · el registro del fallo no contiene ninguna credencial', async () => {
      const previa = env.resend.apiKey;
      env.resend.apiKey = 'clave-local-de-prueba';
      const { cliente } = clienteFalso({ message: 'rate limit exceeded' });
      setEmailTransport(new ResendTransport(cliente));

      try {
        await sendEmail(mensaje);
      } finally {
        env.resend.apiKey = previa;
      }

      const texto = registrado.join('\n');
      assert.ok(!texto.includes('clave-local-de-prueba'), 'la clave jamás puede llegar al diario');
      assert.ok(!texto.toLowerCase().includes('authorization'));
      assert.ok(!texto.toLowerCase().includes('api_key') && !texto.toLowerCase().includes('apikey'));
    });

    it('11 · la clave tampoco viaja en la carga que se manda al proveedor', async () => {
      const previa = env.resend.apiKey;
      env.resend.apiKey = 'clave-local-de-prueba';
      const { cliente, enviados } = clienteFalso();

      try {
        await new ResendTransport(cliente).send(mensaje);
      } finally {
        env.resend.apiKey = previa;
      }

      assert.ok(!JSON.stringify(enviados).includes('clave-local-de-prueba'));
      assert.deepEqual(Object.keys(enviados[0]!).sort(), ['from', 'html', 'subject', 'text', 'to']);
    });

    it('12 · un envío correcto no registra nada', async () => {
      const { cliente } = clienteFalso();
      setEmailTransport(new ResendTransport(cliente));

      assert.equal(await sendEmail(mensaje), true);
      assert.deepEqual(registrado, []);
    });
  });

  /* ══════════════════════════════ flujo real ════════════════════════════════ */

  describe('Recuperación de contraseña a través de Resend', () => {
    it('13 · el código de recuperación se entrega por el transporte configurado', async () => {
      const { cliente, enviados } = clienteFalso();
      setEmailTransport(new ResendTransport(cliente));

      const res = await post('/auth/forgot-password', { email: 'cliente@test.pe' });

      assert.equal(res.status, 200);
      assert.equal(enviados.length, 1, 'la recuperación debe salir por el proveedor configurado');
      assert.equal(enviados[0]!.to, 'cliente@test.pe');
      assert.match(String(enviados[0]!.subject), /recuperación/i);
    });

    it('14 · el correo trae el código, su vigencia y el aviso de «ignora este mensaje»', async () => {
      const { cliente, enviados } = clienteFalso();
      setEmailTransport(new ResendTransport(cliente));

      await post('/auth/forgot-password', { email: 'cliente@test.pe' });

      const texto = String(enviados[0]!.text);
      assert.match(texto, /BusPer[úu]/);
      assert.match(texto, /\b\d{6}\b/, 'el código de seis dígitos debe estar en el cuerpo');
      assert.match(texto, new RegExp(`${env.passwordReset.codeTtlMinutes}\\s*minutos`));
      assert.match(texto, /no solicitaste/i);
      // Y lo mismo en la versión HTML, que es la que verá la mayoría.
      const codigo = texto.match(/\b\d{6}\b/)![0];
      const html = String(enviados[0]!.html);
      assert.ok(html.includes(codigo));
      assert.ok(html.includes('letter-spacing'), 'el código va destacado, no perdido en un párrafo');
    });

    it('15 · un fallo del proveedor no rompe el flujo ni revela si la cuenta existe', async () => {
      const { cliente } = clienteFalso({ message: 'sandbox: recipient not allowed' });
      setEmailTransport(new ResendTransport(cliente));

      const conocido = await post('/auth/forgot-password', { email: 'cliente@test.pe' });
      const desconocido = await post('/auth/forgot-password', { email: 'nadie@test.pe' });

      assert.equal(conocido.status, 200, 'la operación se completa aunque el correo falle');
      assert.equal(desconocido.status, 200);
      assert.equal(conocido.body.message, desconocido.body.message, 'respuesta idéntica: no se enumeran cuentas');
    });

    it('16 · la confirmación de cambio de contraseña también sale por el transporte', async () => {
      const original = await queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = ?', [
        'empresa-b@test.pe',
      ]);
      const hashOriginal = original!.password_hash;
      const { cliente, enviados } = clienteFalso();
      setEmailTransport(new ResendTransport(cliente));

      await post('/auth/forgot-password', { email: 'empresa-b@test.pe' });
      assert.equal(enviados.length, 1);
      const codigo = String(enviados[0]!.text).match(/\b\d{6}\b/)![0];

      const verificado = await post('/auth/verify-reset-code', { email: 'empresa-b@test.pe', code: codigo });
      assert.equal(verificado.status, 200, JSON.stringify(verificado.body));

      const cambiado = await post('/auth/reset-password', {
        email: 'empresa-b@test.pe',
        ticket: verificado.body.data.ticket,
        new_password: 'NuevaClaveSegura9',
      });

      assert.equal(cambiado.status, 200, JSON.stringify(cambiado.body));
      assert.equal(enviados.length, 2, 'el aviso de contraseña actualizada usa el mismo transporte');
      assert.match(String(enviados[1]!.subject), /contraseña/i);
      assert.ok(!String(enviados[1]!.text).includes(codigo), 'el aviso no repite el código');

      // Se restituye el hash original: cambiar la contraseña invalida las sesiones vivas
      // (BP-18) y los demás archivos de la suite cuentan con la contraseña de las fixtures.
      await execute('UPDATE users SET password_hash = ? WHERE email = ?', [hashOriginal, 'empresa-b@test.pe']);
    });

    it('17 · ninguna prueba de este archivo envió un correo real', () => {
      // El transporte siempre recibió un cliente inyectado; el SDK real nunca se instanció
      // con una credencial verdadera ni se llamó a su endpoint.
      assert.equal(env.mail.transport, 'memory', 'la suite corre con el transporte en memoria');
    });
  });
});
