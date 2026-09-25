import './helpers/testEnv';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { execute, query } from '../config/database';
import { env } from '../config/env';
import { assertProductionConfig, parseTrustProxy, ProductionConfigError } from '../config/production-guard';
import { createApp } from '../app';
import { accessLog } from '../middleware/access-log.middleware';
import { attachRequestId } from '../middleware/request-id.middleware';
import { ensureSystemTemplates, TRIP_CANCELLED_EMAIL } from '../services/notification.service';
import { PRODUCTION_ENV } from './helpers/productionEnv';
import { TEST_DATABASE } from './helpers/testEnv';
import { prepareSuite, teardownSuite } from './helpers/suite';

/**
 * FASE 15A · hallazgos de la auditoría pre-producción.
 *
 *   F15-04 · en producción no se aceptan defaults locales o inseguros (BD, FRONTEND_URL, OAuth,
 *            correo, Culqi, numéricas); fuera de producción nada cambia.
 *   F15-05 · TRUST_PROXY configurable, `false` por defecto y `true` rechazado.
 *   F15-08 · registro de acceso en producción sin credenciales, query ni cuerpo.
 *   F15-10 · plantillas del sistema a prueba de arranques concurrentes.
 *   F15-11 · producción exige RESEND_FROM_EMAIL propio (nunca resend.dev) o MAIL_FROM con SMTP.
 *
 * Todo sobre `busperu_test`. Los procesos en producción usan un entorno ficticio y un MySQL
 * inexistente (127.0.0.1:1): nunca llegan a una base real.
 */

const BACKEND = path.resolve(__dirname, '../..');
const TSX = require.resolve('tsx/cli');
const SERVER = path.resolve(__dirname, '../server.ts');

const produccion = (cambios: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({ ...PRODUCTION_ENV, ...cambios });

/** Ejecuta la guarda y devuelve el mensaje de error, o `null` si la configuración pasa. */
function problemas(source: Record<string, string | undefined>): string | null {
  try {
    assertProductionConfig(source);
    return null;
  } catch (error) {
    assert.ok(error instanceof ProductionConfigError, 'solo lanza ProductionConfigError');
    return error.message;
  }
}

function arrancar(extra: Record<string, string>) {
  const r = spawnSync(process.execPath, [TSX, SERVER], {
    cwd: BACKEND,
    env: { ...process.env, ...extra },
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  return { code: r.status, salida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('15A · configuración de producción, proxy, registro de acceso y plantillas', () => {
  // =====================================================================
  describe('F15-04 · guarda de configuración de producción', () => {
    it('fuera de producción no exige nada: los defaults locales siguen valiendo', () => {
      for (const NODE_ENV of ['development', 'test', undefined]) {
        assert.equal(problemas({ NODE_ENV }), null);
        assert.equal(problemas({ NODE_ENV, MAIL_TRANSPORT: 'log', DB_USER: 'root', FRONTEND_URL: 'http://localhost:5173', GOOGLE_ISSUER: 'http://localhost:9999' }), null);
      }
    });

    it('un entorno de producción completo y coherente pasa', () => {
      assert.equal(problemas(produccion()), null);
    });

    it('sin DB_HOST, DB_PORT, DB_USER, DB_PASSWORD o FRONTEND_URL explícitos: no arranca', () => {
      for (const key of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'FRONTEND_URL', 'TRUST_PROXY']) {
        for (const vacio of [undefined, '', '   ']) {
          const mensaje = problemas(produccion({ [key]: vacio }));
          assert.ok(mensaje?.includes(`${key} debe definirse explícitamente en producción`), `${key}=${String(vacio)} -> ${mensaje}`);
        }
      }
    });

    it('DB_USER root y FRONTEND_URL local o sin https: rechazados', () => {
      for (const root of ['root', 'ROOT', ' root ']) assert.match(problemas(produccion({ DB_USER: root })) ?? '', /DB_USER no puede ser root/);
      for (const url of ['http://localhost:5173', 'https://localhost', 'https://127.0.0.1:5173', 'http://app.busperu.example', 'no-es-una-url', 'https://[::1]:5173']) {
        assert.match(problemas(produccion({ FRONTEND_URL: url })) ?? '', /FRONTEND_URL debe ser una URL https pública/, url);
      }
    });

    it('OAuth habilitado exige callback https explícito y la pareja id/secret', () => {
      const conGoogle = { GOOGLE_CLIENT_ID: 'id-ficticio.apps.example', GOOGLE_CLIENT_SECRET: 'secreto-ficticio-oauth-15a' };
      assert.match(problemas(produccion(conGoogle)) ?? '', /OAUTH_CALLBACK_BASE_URL debe definirse explícitamente/);
      assert.match(problemas(produccion({ ...conGoogle, OAUTH_CALLBACK_BASE_URL: 'http://localhost:3000/api' })) ?? '', /OAUTH_CALLBACK_BASE_URL debe ser una URL https pública/);
      assert.equal(problemas(produccion({ ...conGoogle, OAUTH_CALLBACK_BASE_URL: 'https://api.busperu.example/api' })), null);
      assert.match(problemas(produccion({ MICROSOFT_CLIENT_ID: 'solo-el-id', OAUTH_CALLBACK_BASE_URL: 'https://api.busperu.example/api' })) ?? '', /MICROSOFT_CLIENT_ID y MICROSOFT_CLIENT_SECRET deben definirse juntos/);
      assert.equal(problemas(produccion({ OAUTH_CALLBACK_BASE_URL: '' })), null, 'sin proveedores OAuth el callback no se exige');
    });

    it('los extremos OAuth de prueba (issuer, JWKS, auth, token) no pueden definirse en producción', () => {
      for (const key of ['GOOGLE_ISSUER', 'GOOGLE_AUTH_URL', 'GOOGLE_TOKEN_URL', 'GOOGLE_JWKS_URI', 'MICROSOFT_ISSUER', 'MICROSOFT_AUTH_URL', 'MICROSOFT_TOKEN_URL', 'MICROSOFT_JWKS_URI']) {
        assert.match(problemas(produccion({ [key]: 'https://proveedor-falso.example' })) ?? '', new RegExp(`${key} no puede definirse en producción`));
      }
    });

    it('MAIL_TRANSPORT debe ser resend o smtp: log, memory o ausente se rechazan al arrancar', () => {
      for (const transporte of ['log', 'memory', '', undefined, 'sendgrid']) {
        assert.match(problemas(produccion({ MAIL_TRANSPORT: transporte })) ?? '', /MAIL_TRANSPORT debe ser "resend" o "smtp"/, String(transporte));
      }
    });

    it('Culqi habilitado exige las tres piezas, formato de llave, mismo entorno y secreto largo', () => {
      const culqi = { CULQI_PUBLIC_KEY: 'pk_test_ficticia15a', CULQI_PRIVATE_KEY: 'sk_test_ficticia15a', CULQI_WEBHOOK_SECRET: 'w'.repeat(10) + 'ebhook-ficticio-de-32-caracteres' };
      assert.equal(problemas(produccion(culqi)), null);
      assert.equal(problemas(produccion({ ...culqi, CULQI_PUBLIC_KEY: 'pk_live_ficticia15a', CULQI_PRIVATE_KEY: 'sk_live_ficticia15a' })), null);
      assert.match(problemas(produccion({ ...culqi, CULQI_PRIVATE_KEY: '' })) ?? '', /CULQI_PRIVATE_KEY es obligatoria cuando Culqi está habilitado/);
      assert.match(problemas(produccion({ ...culqi, CULQI_WEBHOOK_SECRET: '' })) ?? '', /CULQI_WEBHOOK_SECRET es obligatoria/);
      assert.match(problemas(produccion({ ...culqi, CULQI_WEBHOOK_SECRET: 'corto' })) ?? '', /CULQI_WEBHOOK_SECRET debe tener al menos 32/);
      assert.match(problemas(produccion({ ...culqi, CULQI_PRIVATE_KEY: 'sk_live_ficticia15a' })) ?? '', /mismo entorno/);
      assert.match(problemas(produccion({ ...culqi, CULQI_PUBLIC_KEY: 'sk_test_al_reves' })) ?? '', /CULQI_PUBLIC_KEY no tiene el formato/);
      assert.match(problemas(produccion({ CULQI_API_URL: 'http://127.0.0.1:9999/v2' })) ?? '', /CULQI_API_URL debe ser una URL https pública/);
      assert.equal(problemas(produccion({ CULQI_PUBLIC_KEY: '', CULQI_PRIVATE_KEY: '', CULQI_WEBHOOK_SECRET: '' })), null, 'sin llaves, la tarjeta queda deshabilitada y no se exige nada');
    });

    it('numéricas mal escritas se rechazan en lugar de volverse NaN', () => {
      for (const [key, valor] of [['DB_PORT', 'tres mil'], ['PORT', '-1'], ['RATE_LIMIT_GLOBAL', '0'], ['CULQI_TIMEOUT_MS', '1.5'], ['OAUTH_TICKET_TTL_SECONDS', '60s']] as const) {
        assert.match(problemas(produccion({ [key]: valor })) ?? '', new RegExp(`${key} debe ser un entero positivo`), `${key}=${valor}`);
      }
    });

    it('los mensajes nombran variables y reglas, nunca los valores', () => {
      const sensibles = {
        DB_USER: 'root',
        DB_PASSWORD: '',
        MAIL_TRANSPORT: 'resend',
        RESEND_API_KEY: 're_valor_que_no_debe_salir_15a',
        RESEND_FROM_EMAIL: 'onboarding@resend.dev',
        GOOGLE_CLIENT_ID: 'id-que-no-debe-salir-15a',
        GOOGLE_CLIENT_SECRET: 'secreto-que-no-debe-salir-15a',
        CULQI_PRIVATE_KEY: 'sk_live_llave-que-no-debe-salir-15a',
        CULQI_WEBHOOK_SECRET: 'webhook-que-no-debe-salir',
      };
      const mensaje = problemas(produccion(sensibles)) ?? '';
      assert.ok(mensaje.length > 0);
      for (const [key, valor] of Object.entries(sensibles)) {
        if (valor.length > 6 && key !== 'MAIL_TRANSPORT') assert.ok(!mensaje.includes(valor), `${key} aparece en el mensaje`);
      }
    });

    describe('arranque real', () => {
      it('producción completa: pasa todas las guardas y solo falla al conectar al MySQL inexistente', () => {
        const r = arrancar({ ...PRODUCTION_ENV });
        assert.doesNotMatch(r.salida, /Configuración incompleta o insegura|Configuración insegura/);
        assert.match(r.salida, /No se pudo conectar a MySQL/);
      });

      it('producción con MAIL_TRANSPORT=log y FRONTEND_URL local: no arranca, antes de conectar y sin valores', () => {
        const r = arrancar({ ...PRODUCTION_ENV, MAIL_TRANSPORT: 'log', FRONTEND_URL: 'http://localhost:5173' });
        assert.notEqual(r.code, 0);
        assert.match(r.salida, /MAIL_TRANSPORT debe ser "resend" o "smtp"/);
        assert.match(r.salida, /FRONTEND_URL debe ser una URL https pública/);
        assert.doesNotMatch(r.salida, /Conectado a MySQL|No se pudo conectar a MySQL/, 'falla antes de conectar');
        for (const valor of [PRODUCTION_ENV.DB_PASSWORD, PRODUCTION_ENV.JWT_SECRET, PRODUCTION_ENV.RESEND_API_KEY]) assert.ok(!r.salida.includes(valor ?? '#'));
      });

      it('desarrollo sin configuración de producción: compatible como hasta ahora', () => {
        const r = arrancar({ NODE_ENV: 'development', DB_NAME: TEST_DATABASE, DB_HOST: '127.0.0.1', DB_PORT: '1', MAIL_TRANSPORT: 'log', FRONTEND_URL: '' });
        assert.doesNotMatch(r.salida, /Configuración incompleta/);
        assert.match(r.salida, /No se pudo conectar a MySQL/);
      });
    });
  });

  // =====================================================================
  describe('F15-11 · remitente de correo en producción', () => {
    it('resend exige RESEND_FROM_EMAIL explícito y rechaza el dominio de pruebas resend.dev', () => {
      assert.match(problemas(produccion({ RESEND_FROM_EMAIL: undefined })) ?? '', /RESEND_FROM_EMAIL es obligatoria con MAIL_TRANSPORT=resend/);
      for (const sandbox of ['onboarding@resend.dev', 'BusPerú <onboarding@resend.dev>', 'Otro <ONBOARDING@RESEND.DEV>']) {
        assert.match(problemas(produccion({ RESEND_FROM_EMAIL: sandbox })) ?? '', /dominio de pruebas resend\.dev/, sandbox);
      }
      assert.match(problemas(produccion({ RESEND_FROM_EMAIL: 'sin-arroba' })) ?? '', /RESEND_FROM_EMAIL no tiene formato/);
      assert.match(problemas(produccion({ RESEND_API_KEY: '' })) ?? '', /RESEND_API_KEY es obligatoria/);
      for (const valido of ['no-reply@busperu.example', 'BusPerú <no-reply@busperu.example>']) assert.equal(problemas(produccion({ RESEND_FROM_EMAIL: valido })), null, valido);
    });

    it('smtp exige MAIL_HOST y MAIL_FROM válidos (y no pide nada de Resend)', () => {
      const smtp = { MAIL_TRANSPORT: 'smtp', RESEND_API_KEY: '', RESEND_FROM_EMAIL: '' };
      assert.match(problemas(produccion(smtp)) ?? '', /MAIL_HOST es obligatoria con MAIL_TRANSPORT=smtp/);
      assert.match(problemas(produccion({ ...smtp, MAIL_HOST: 'smtp.busperu.example' })) ?? '', /MAIL_FROM es obligatoria con MAIL_TRANSPORT=smtp/);
      assert.match(problemas(produccion({ ...smtp, MAIL_HOST: 'smtp.busperu.example', MAIL_FROM: 'BusPerú <sin-dominio>' })) ?? '', /MAIL_FROM no tiene formato/);
      assert.equal(problemas(produccion({ ...smtp, MAIL_HOST: 'smtp.busperu.example', MAIL_FROM: 'BusPerú <no-reply@busperu.example>' })), null);
    });

    it('fuera de producción el remitente de pruebas sigue siendo el default de Resend', () => {
      assert.equal(env.isProduction, false);
      assert.ok(env.resend.from.length > 0);
    });
  });

  // =====================================================================
  describe('F15-05 · trust proxy', () => {
    it('parseTrustProxy: false por defecto, saltos 1..10, IPs/CIDR y nombres; true y basura rechazados', () => {
      for (const falso of [undefined, '', '  ', 'false', 'FALSE', '0']) assert.equal(parseTrustProxy(falso), false, String(falso));
      assert.equal(parseTrustProxy('1'), 1);
      assert.equal(parseTrustProxy('10'), 10);
      assert.deepEqual(parseTrustProxy('10.0.0.1'), ['10.0.0.1']);
      assert.deepEqual(parseTrustProxy('loopback, 10.0.0.0/8 ,2001:db8::/32'), ['loopback', '10.0.0.0/8', '2001:db8::/32']);
      for (const malo of ['true', 'TRUE', '11', '-1', '1.5', 'proxy', '10.0.0.0/33', '::1/129', '10.0.0.1/8/1', '999.0.0.1', '10.0.0.1,', 'loopback,true']) {
        assert.equal(parseTrustProxy(malo), null, malo);
      }
    });

    it('la app de la suite (sin TRUST_PROXY) no confía en X-Forwarded-For', async () => {
      assert.equal(env.trustProxy, false);
      const app = createApp();
      assert.equal(app.get('trust proxy'), false);

      const espejo = express();
      espejo.set('trust proxy', env.trustProxy);
      espejo.get('/ip', (req, res) => {
        res.json({ ip: req.ip });
      });
      const server = espejo.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      try {
        const { port } = server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${port}/ip`, { headers: { 'X-Forwarded-For': '203.0.113.77' } });
        const body = (await res.json()) as { ip: string };
        assert.notEqual(body.ip, '203.0.113.77', 'una cabecera del cliente no fija la IP');
      } finally {
        server.close();
      }
    });

    it('un TRUST_PROXY inválido impide arrancar también fuera de producción', () => {
      const r = arrancar({ NODE_ENV: 'development', DB_NAME: TEST_DATABASE, DB_HOST: '127.0.0.1', DB_PORT: '1', TRUST_PROXY: 'true' });
      assert.notEqual(r.code, 0);
      assert.match(r.salida, /TRUST_PROXY no es válido/);
      assert.doesNotMatch(r.salida, /No se pudo conectar a MySQL/);
    });
  });

  // =====================================================================
  describe('F15-08 · registro de acceso sin secretos', () => {
    const SECRETOS = {
      bearer: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxNWEifQ.firma-ficticia-del-token-15a',
      cookie: 'cookie-de-sesion-ficticia-15a',
      apiKey: 'bp_live_api_key_ficticia_15a',
      password: 'Contrasena-Ficticia-15a!',
      card: '4111111111111111',
      query: 'token-en-la-query-ficticio-15a',
      email: 'persona.ficticia.15a@correo.example',
      webhook: 'segmento-secreto-del-webhook-ficticio-15a',
    };

    async function capturar(accion: () => Promise<void>): Promise<string[]> {
      const original = console.error;
      const previo = process.env.LOG_ERRORS;
      const lineas: string[] = [];
      process.env.LOG_ERRORS = 'true';
      console.error = (...args: unknown[]) => {
        lineas.push(args.map(String).join(' '));
      };
      try {
        await accion();
      } finally {
        console.error = original;
        process.env.LOG_ERRORS = previo;
      }
      return lineas;
    }

    function sinSecretos(texto: string) {
      for (const [nombre, valor] of Object.entries(SECRETOS)) assert.ok(!texto.includes(valor), `el registro contiene ${nombre}`);
      assert.doesNotMatch(texto, /Bearer|authorization|cookie|x-api-key|password|card_number/i);
    }

    it('registra método, ruta, estado, duración, request_id y userId; nada de cabeceras, query ni cuerpo', async () => {
      const app = express();
      app.use(attachRequestId);
      app.use(express.json());
      app.use((req, _res, next) => {
        // Simula a la persona autenticada: solo su id debe aparecer.
        req.user = { id: 4242, email: SECRETOS.email } as unknown as NonNullable<typeof req.user>;
        next();
      });
      app.use(accessLog);
      app.post('/api/culqi/webhook/:secret', (_req, res) => {
        res.status(201).json({ ok: true });
      });

      const server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      let requestId = '';
      const lineas = await capturar(async () => {
        const { port } = server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${port}/api/culqi/webhook/${SECRETOS.webhook}?token=${SECRETOS.query}&search=${SECRETOS.email}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRETOS.bearer}`, Cookie: `session=${SECRETOS.cookie}`, 'X-Api-Key': SECRETOS.apiKey },
          body: JSON.stringify({ password: SECRETOS.password, card_number: SECRETOS.card }),
        });
        requestId = res.headers.get('x-request-id') ?? '';
        await res.text();
        await new Promise((resolve) => setImmediate(resolve));
      });
      server.close();

      const registros = lineas.map((linea) => JSON.parse(linea) as Record<string, unknown>).filter((r) => r.message === 'http_request');
      assert.equal(registros.length, 1, lineas.join('\n'));
      const registro = registros[0]!;
      assert.equal(registro.level, 'info');
      assert.equal(registro.method, 'POST');
      assert.equal(registro.status, 201);
      assert.equal(registro.userId, 4242);
      assert.equal(registro.requestId, requestId);
      assert.ok(requestId.length > 0);
      assert.equal(typeof registro.durationMs, 'number');
      assert.equal(registro.path, '/api/culqi/webhook/[REDACTED]');
      assert.deepEqual(Object.keys(registro).sort(), ['durationMs', 'level', 'message', 'method', 'path', 'requestId', 'status', 'timestamp', 'userId']);
      sinSecretos(lineas.join('\n'));
    });

    it('en la suite (NODE_ENV=test) la app no emite registro de acceso', async () => {
      const lineas = await capturar(async () => {
        const server = createApp().listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        const { port } = server.address() as AddressInfo;
        await (await fetch(`http://127.0.0.1:${port}/api/health`)).text();
        await new Promise((resolve) => setImmediate(resolve));
        server.close();
      });
      assert.equal(lineas.filter((linea) => linea.includes('http_request')).length, 0);
    });

    it('con NODE_ENV=production la app real registra el acceso saneado', () => {
      const r = spawnSync(process.execPath, [TSX, path.resolve(__dirname, 'helpers/productionAccessLogChild.ts')], {
        cwd: BACKEND,
        env: { ...process.env, ...PRODUCTION_ENV, ACCESS_LOG_SECRETS: JSON.stringify(SECRETOS) },
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
      });
      const salida = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      assert.equal(r.status, 0, salida);
      const registros = salida
        .split(/\r?\n/)
        .filter((linea) => linea.startsWith('{'))
        .map((linea) => JSON.parse(linea) as Record<string, unknown>)
        .filter((registro) => registro.message === 'http_request');
      assert.equal(registros.length, 1, salida);
      assert.equal(registros[0]!.path, '/api/health');
      assert.equal(registros[0]!.status, 200);
      assert.equal(typeof registros[0]!.requestId, 'string');
      sinSecretos(salida.replace(/ACCESS_LOG_SECRETS/g, ''));
      for (const valor of [PRODUCTION_ENV.DB_PASSWORD, PRODUCTION_ENV.JWT_SECRET, PRODUCTION_ENV.RESEND_API_KEY]) assert.ok(!salida.includes(valor ?? '#'));
    });
  });

  // =====================================================================
  describe('F15-10 · plantillas del sistema con arranques concurrentes', () => {
    before(async () => {
      await prepareSuite();
    });
    after(teardownSuite);

    it('varias ejecuciones simultáneas crean la plantilla que falta una sola vez y ninguna falla', async () => {
      await ensureSystemTemplates();
      const total = async () => Number((await query<{ n: number }>('SELECT COUNT(*) AS n FROM notification_templates'))[0]?.n);
      const antes = await total();

      // La FK de notifications es ON DELETE SET NULL: borrar la plantilla en busperu_test es seguro.
      await execute('DELETE FROM notification_templates WHERE name = ?', [TRIP_CANCELLED_EMAIL]);
      assert.equal(await total(), antes - 1);

      const creadas = await Promise.all(Array.from({ length: 8 }, () => ensureSystemTemplates()));
      assert.equal(await total(), antes, 'no se duplica ninguna plantilla');
      const filas = await query('SELECT id FROM notification_templates WHERE name = ?', [TRIP_CANCELLED_EMAIL]);
      assert.equal(filas.length, 1);
      assert.equal(creadas.reduce((suma, n) => suma + n, 0), 1, `solo una ejecución cuenta la plantilla como creada: ${creadas.join(',')}`);

      assert.equal(await ensureSystemTemplates(), 0, 'con todo creado, no crea nada');
    });
  });
});
