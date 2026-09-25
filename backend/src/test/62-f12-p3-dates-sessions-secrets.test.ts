import './helpers/testEnv';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { after, before, describe, it } from 'node:test';
import { get, post, put } from './helpers/api';
import { env } from '../config/env';
import { execute, queryOne } from '../config/database';
import { assertProductionSecrets, InsecureSecretError, isValidEncryptionKey } from '../config/secrets-guard';
import { findPasswordHash } from '../repositories/user.repository';
import { purgeExpiredRevocations, revokeSession } from '../services/session-revocation.service';
import { isCalendarDate, settlementPeriodErrors } from '../validators/resource.validators';
import { login, TEST_PASSWORD } from './helpers/fixtures';
import { PRODUCTION_ENV } from './helpers/productionEnv';
import { TEST_DATABASE } from './helpers/testEnv';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';
import { sessionFingerprint } from '../utils/security';

/**
 * FASE 12B · hallazgos P3 de la auditoría final.
 *
 *   F12-04 · periodo de liquidación: fechas reales AAAA-MM-DD e inicio ≤ fin (400).
 *   F12-07 · cerrar sesión revoca ese token en el servidor (`revoked_sessions`, migración 014).
 *   F12-08 · en producción, JWT_SECRET e INTEGRATIONS_ENCRYPTION_KEY con la fortaleza y el formato
 *            que exige su uso; el proceso no arranca si no.
 *
 * Los procesos que arrancan en producción apuntan a un MySQL inexistente (127.0.0.1:1).
 */
describe('12B · fechas de liquidación, sesiones y secretos', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  // =====================================================================
  describe('F12-04 · periodo de una liquidación', () => {
    it('isCalendarDate: formato exacto y fecha real, con bisiestos', () => {
      for (const valida of ['2026-01-01', '2026-01-31', '2024-02-29', '2000-02-29', '2026-12-31']) assert.equal(isCalendarDate(valida), true, valida);
      for (const invalida of ['no-es-fecha', '2026', '2026-1-1', '2026/01/01', '2026-02-30', '2026-02-29', '1900-02-29', '2026-13-01', '2026-00-10', '2026-01-00', ' 2026-01-01', '2026-01-01T00:00:00', '', null, 20260101]) {
        assert.equal(isCalendarDate(invalida), false, String(invalida));
      }
      assert.deepEqual(settlementPeriodErrors('2026-01-01', '2026-01-01'), {});
      assert.ok(settlementPeriodErrors('2026-02-01', '2026-01-31').period_end);
    });

    it('POST /settlements: periodos inválidos → 400 con detalle y sin crear nada', async () => {
      const casos: Array<[string, string]> = [
        ['no-es-fecha', '2026-01-31'],
        ['2026', '2026-01-31'],
        ['2026-1-1', '2026-01-31'],
        ['2026/01/01', '2026-01-31'],
        ['2026-01-01', '2026-02-30'],
        ['2026-01-31', '2026-01-01'],
      ];
      for (const [period_start, period_end] of casos) {
        const res = await post('/settlements', { company_id: ctx.fixtures.companyA, period_start, period_end }, ctx.sessions.admin.token);
        assert.equal(res.status, 400, `${period_start}..${period_end} -> ${res.status}`);
        assert.ok(res.body.errors?.period_start || res.body.errors?.period_end, JSON.stringify(res.body));
      }
      assert.equal(Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM settlements'))?.n), 0);
    });

    it('POST /settlements: periodos válidos, también de un solo día', async () => {
      const mes = await post('/settlements', { company_id: ctx.fixtures.companyA, period_start: '2026-01-01', period_end: '2026-01-31' }, ctx.sessions.admin.token);
      assert.equal(mes.status, 201, JSON.stringify(mes.body));
      const dia = await post('/settlements', { company_id: ctx.fixtures.companyA, period_start: '2026-03-15', period_end: '2026-03-15' }, ctx.sessions.admin.token);
      assert.equal(dia.status, 201, JSON.stringify(dia.body));
    });
  });

  // =====================================================================
  describe('F12-07 · cerrar sesión revoca el token', () => {
    const me = (token: string) => get('/auth/me', token);
    const logout = (token: string) => post('/auth/logout', {}, token);

    it('el token lleva jti; tras el logout ese mismo token responde 401', async () => {
      const sesion = await login('cliente@test.pe');
      const claims = jwt.decode(sesion.token) as { jti?: string };
      assert.match(String(claims.jti), /^[0-9a-f]{32}$/);
      assert.equal((await me(sesion.token)).status, 200);
      assert.equal((await logout(sesion.token)).status, 200);
      const despues = await me(sesion.token);
      assert.equal(despues.status, 401);
      assert.doesNotMatch(String(despues.body.message), /jti|revoked_sessions|SQL/i);
      assert.equal((await logout(sesion.token)).status, 401, 'un token revocado no vuelve a cerrar sesión');
      const fila = await queryOne<{ user_id: number; vigente: number }>('SELECT user_id, expires_at > NOW() AS vigente FROM revoked_sessions WHERE jti = ?', [claims.jti]);
      assert.ok(fila && Number(fila.vigente) === 1, 'se guarda con la caducidad del token');
    });

    it('cerrar una sesión no expulsa las demás del mismo usuario', async () => {
      const uno = await login('empresa-a@test.pe');
      const dos = await login('empresa-a@test.pe');
      assert.notEqual(uno.token, dos.token);
      assert.equal((await logout(uno.token)).status, 200);
      assert.equal((await me(uno.token)).status, 401);
      assert.equal((await me(dos.token)).status, 200);
    });

    it('funciona para ADMIN, COMPANY_ADMIN, OPERATOR y CUSTOMER', async () => {
      for (const email of ['admin@test.pe', 'empresa-a@test.pe', 'operador-a@test.pe', 'cliente@test.pe', 'empresa-b@test.pe']) {
        const sesion = await login(email);
        assert.equal((await me(sesion.token)).status, 200, email);
        assert.equal((await logout(sesion.token)).status, 200, email);
        assert.equal((await me(sesion.token)).status, 401, email);
        assert.equal((await me((await login(email)).token)).status, 200, `${email}: puede volver a entrar`);
      }
    });

    it('cambiar la contraseña sigue invalidando todas las sesiones (BP-18) y recuperar la cuenta sigue funcionando', async () => {
      const email = `f12b-${Date.now()}@test.pe`;
      assert.equal((await post('/auth/register', { first_name: 'Rita', last_name: 'Prueba', email, password: TEST_PASSWORD })).status, 201);
      const a = (await post('/auth/login', { email, password: TEST_PASSWORD })).body.data.token as string;
      const b = (await post('/auth/login', { email, password: TEST_PASSWORD })).body.data.token as string;
      const nueva = `${TEST_PASSWORD}X9`;
      const cambio = await put('/auth/me/password', { current_password: TEST_PASSWORD, new_password: nueva }, a);
      assert.equal(cambio.status, 200, JSON.stringify(cambio.body));
      assert.equal((await me(b)).status, 401, 'la otra sesión cae por la huella');
      const c = await post('/auth/login', { email, password: nueva });
      assert.equal(c.status, 200);
      assert.equal((await me(c.body.data.token)).status, 200);
    });

    it('un token emitido antes de este cambio (sin jti) sigue valiendo hasta caducar', async () => {
      const usuario = await queryOne<{ id: number; role_id: number }>("SELECT id, role_id FROM users WHERE email = 'operador-a@test.pe'");
      const hash = await findPasswordHash(Number(usuario!.id));
      const legado = jwt.sign({ sub: Number(usuario!.id), roleId: Number(usuario!.role_id), role: 'OPERATOR', pwd: sessionFingerprint(String(hash)) }, env.jwt.secret, { expiresIn: '1h' });
      assert.equal((await me(legado)).status, 200);
      assert.equal((await logout(legado)).status, 200, 'cerrar sesión no falla aunque no pueda revocarse');
    });

    it('revocar es idempotente y el planificador purga solo lo caducado', async () => {
      const usuario = await queryOne<{ id: number }>("SELECT id FROM users WHERE email = 'cliente@test.pe'");
      const caducado = crypto.randomBytes(16).toString('hex');
      const vigente = crypto.randomBytes(16).toString('hex');
      const ahora = Math.floor(Date.now() / 1000);
      await revokeSession(caducado, Number(usuario!.id), ahora - 3 * 3600);
      await revokeSession(caducado, Number(usuario!.id), ahora - 3 * 3600);
      await revokeSession(vigente, Number(usuario!.id), ahora + 3600);
      assert.ok((await purgeExpiredRevocations()) >= 1);
      assert.equal(await queryOne('SELECT jti FROM revoked_sessions WHERE jti = ?', [caducado]), null);
      assert.ok(await queryOne('SELECT jti FROM revoked_sessions WHERE jti = ?', [vigente]));
      await execute('DELETE FROM revoked_sessions WHERE jti = ?', [vigente]);
    });
  });

  // =====================================================================
  describe('F12-08 · secretos en producción', () => {
    const FUERTE = 'Kf8#qP2vZ!mL9xR4tW7yB3nC6dH1jS5a';
    const HEX = crypto.randomBytes(32).toString('hex');
    const B64 = crypto.randomBytes(32).toString('base64');

    it('isValidEncryptionKey acepta exactamente 32 bytes en hex o base64 canónico', () => {
      assert.equal(isValidEncryptionKey(HEX), true);
      assert.equal(isValidEncryptionKey(B64), true);
      for (const mala of ['corta', HEX.slice(0, 62), `${HEX}00`, crypto.randomBytes(16).toString('base64'), crypto.randomBytes(33).toString('base64'), B64.replace('=', ''), `${B64.slice(0, 42)}*=`]) {
        assert.equal(isValidEncryptionKey(mala), false, mala);
      }
    });

    it('fuera de producción no cambia nada', () => {
      for (const nodeEnv of ['development', 'test']) {
        assert.doesNotThrow(() => assertProductionSecrets({ nodeEnv, jwtSecret: 'x', encryptionKey: 'mal-formada' }));
      }
    });

    it('en producción rechaza JWT_SECRET débiles y claves mal formadas, sin revelar su valor', () => {
      const casos = [
        { jwtSecret: 'corto', encryptionKey: '' },
        { jwtSecret: 'a'.repeat(64), encryptionKey: '' },
        { jwtSecret: 'abababababababababababababababababab', encryptionKey: '' },
        { jwtSecret: FUERTE, encryptionKey: 'no-es-una-clave-de-32-bytes' },
        { jwtSecret: FUERTE, encryptionKey: HEX.slice(0, 40) },
      ];
      for (const caso of casos) {
        assert.throws(
          () => assertProductionSecrets({ nodeEnv: 'production', ...caso }),
          (error: unknown) => error instanceof InsecureSecretError && !error.message.includes(caso.jwtSecret) && (caso.encryptionKey === '' || !error.message.includes(caso.encryptionKey)),
          JSON.stringify(caso).slice(0, 40),
        );
      }
    });

    it('en producción acepta secretos fuertes, con o sin clave de integraciones', () => {
      for (const encryptionKey of ['', HEX, B64]) {
        assert.doesNotThrow(() => assertProductionSecrets({ nodeEnv: 'production', jwtSecret: FUERTE, encryptionKey }));
      }
    });

    describe('arranque real', () => {
      const SERVER = path.resolve(__dirname, '../server.ts');
      const arrancar = (extra: Record<string, string>) => {
        // F15-04: los arranques en producción parten de un entorno de producción ficticio COMPLETO
        // (`PRODUCTION_ENV`); sin él, la guarda de configuración los pararía antes que esta.
        const r = spawnSync(process.execPath, [require.resolve('tsx/cli'), SERVER], {
          cwd: path.resolve(__dirname, '../..'),
          env: { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: '1', ...extra },
          encoding: 'utf8',
          timeout: 60_000,
          windowsHide: true,
        });
        return { code: r.status, salida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
      };

      it('producción con JWT_SECRET débil: no arranca y no imprime el valor', () => {
        const debil = 'secreto-debil-12b';
        const r = arrancar({ ...PRODUCTION_ENV, JWT_SECRET: debil, INTEGRATIONS_ENCRYPTION_KEY: '' });
        assert.notEqual(r.code, 0);
        assert.match(r.salida, /Configuración insegura para producción/);
        assert.ok(!r.salida.includes(debil));
        assert.doesNotMatch(r.salida, /Conectado a MySQL|No se pudo conectar a MySQL/, 'falla antes de conectar');
      });

      it('producción con clave de integraciones mal formada: no arranca', () => {
        const r = arrancar({ ...PRODUCTION_ENV, JWT_SECRET: FUERTE, INTEGRATIONS_ENCRYPTION_KEY: 'clave-mal-formada-12b' });
        assert.notEqual(r.code, 0);
        assert.match(r.salida, /INTEGRATIONS_ENCRYPTION_KEY no es válida/);
        assert.ok(!r.salida.includes('clave-mal-formada-12b'));
      });

      it('producción con secretos fuertes: pasa las guardas (llega a intentar conectar)', () => {
        const r = arrancar({ ...PRODUCTION_ENV, JWT_SECRET: FUERTE, INTEGRATIONS_ENCRYPTION_KEY: HEX });
        assert.doesNotMatch(r.salida, /Configuración insegura/);
        assert.match(r.salida, /No se pudo conectar a MySQL/);
      });

      it('desarrollo con un JWT_SECRET corto: compatible como hasta ahora', () => {
        const r = arrancar({ NODE_ENV: 'development', DB_NAME: TEST_DATABASE, JWT_SECRET: 'dev', INTEGRATIONS_ENCRYPTION_KEY: 'lo-que-sea' });
        assert.doesNotMatch(r.salida, /Configuración insegura/);
        assert.match(r.salida, /No se pudo conectar a MySQL/);
      });
    });
  });
});
