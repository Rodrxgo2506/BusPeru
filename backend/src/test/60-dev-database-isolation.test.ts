import './helpers/testEnv';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { execute, queryOne } from '../config/database';
import { assertDatabaseAllowedForEnvironment, DatabaseIsolationError } from '../config/database-guard';
import { env } from '../config/env';
import { ensureSystemTemplates } from '../services/notification.service';
import { advanceTripLifecycle } from '../services/trip.service';
import { PRODUCTION_ENV } from './helpers/productionEnv';
import { TEST_DATABASE } from './helpers/testEnv';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * FASE 11F-0 · el entorno de desarrollo no puede tocar la base real.
 *
 * El servidor local arrancaba con `DB_NAME=busperu` y, al arrancar, `ensureSystemTemplates()` y el
 * planificador escribían en producción. Aquí se prueba la guarda de configuración y que servidor,
 * planificador y plantillas trabajan sobre la base configurada (`busperu_test`).
 *
 * SEGURIDAD DE LAS PROPIAS PRUEBAS. Los procesos que se lanzan con el nombre `busperu` apuntan a
 * un puerto MySQL inexistente (127.0.0.1:1): aunque la guarda fallara, no podrían conectarse a la
 * base real. Ninguna prueba consulta `busperu`.
 */

const BACKEND = path.resolve(__dirname, '../..');
const SERVER = path.resolve(__dirname, '../server.ts');
const PROBE = path.resolve(__dirname, 'helpers/envProbe.ts');
const TSX = require.resolve('tsx/cli');
const SIN_MYSQL = { DB_HOST: '127.0.0.1', DB_PORT: '1' };

interface Resultado {
  code: number | null;
  salida: string;
}

/** Lanza el servidor y espera a que termine (arranques que deben fallar). */
function arrancarHastaSalir(extra: Record<string, string>, timeoutMs = 60_000): Resultado {
  const r = spawnSync(process.execPath, [TSX, SERVER], {
    cwd: BACKEND,
    env: { ...process.env, ...extra },
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return { code: r.status, salida: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

/** Termina el proceso y sus hijos (tsx lanza un node hijo; en Windows `kill` no los alcanza). */
function terminarArbol(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ya terminó
      }
    }
  }
}

const esperar = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('FASE 11F-0 · aislamiento de la base real respecto del desarrollo', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  describe('Guarda de configuración', () => {
    it('ISOLATION-1 · development + busperu: rechazado (función pura)', () => {
      for (const nodeEnv of ['development', 'test', 'staging', '', 'Production', 'PRODUCTION']) {
        assert.throws(() => assertDatabaseAllowedForEnvironment(nodeEnv, 'busperu'), DatabaseIsolationError, nodeEnv);
      }
      assert.throws(() => assertDatabaseAllowedForEnvironment('development', 'busperu_testing'), DatabaseIsolationError);
      assert.throws(() => assertDatabaseAllowedForEnvironment('development', 'otra'), /reservada para producción; configure busperu_test/);
    });

    it('ISOLATION-2/3/4 · development y test con *_test, y production con busperu: permitidos', () => {
      assert.doesNotThrow(() => assertDatabaseAllowedForEnvironment('development', 'busperu_test'));
      assert.doesNotThrow(() => assertDatabaseAllowedForEnvironment('test', 'busperu_test'));
      assert.doesNotThrow(() => assertDatabaseAllowedForEnvironment('production', 'busperu'));
      assert.doesNotThrow(() => assertDatabaseAllowedForEnvironment('production', 'cualquier_base_de_produccion'));
    });

    it('ISOLATION-8 · un DB_NAME vacío nunca se admite, tampoco en producción', () => {
      for (const nodeEnv of ['development', 'production']) {
        assert.throws(() => assertDatabaseAllowedForEnvironment(nodeEnv, '   '), DatabaseIsolationError);
      }
    });
  });

  describe('Arranque real del servidor', () => {
    it('ISOLATION-1 · NODE_ENV=development con DB_NAME=busperu: el proceso sale con error claro y sin conectar', () => {
      const r = arrancarHastaSalir({ ...SIN_MYSQL, NODE_ENV: 'development', DB_NAME: 'busperu' });
      assert.notEqual(r.code, 0);
      assert.match(r.salida, /La BD "busperu" está reservada para producción; configure busperu_test/);
      assert.doesNotMatch(r.salida, /Conectado a MySQL|No se pudo conectar a MySQL|escuchando/, 'falla antes de intentar conectar');
      assert.ok(!r.salida.includes(String(process.env.DB_PASSWORD || 'contraseña-que-no-existe-59')), 'sin credenciales en el mensaje');
    });

    it('ISOLATION-1b · sin NODE_ENV también se trata como no producción', () => {
      const entorno: Record<string, string> = { ...SIN_MYSQL, DB_NAME: 'busperu' };
      const r = spawnSync(process.execPath, [TSX, SERVER], {
        cwd: BACKEND,
        env: Object.fromEntries(Object.entries({ ...process.env, ...entorno }).filter(([k]) => k !== 'NODE_ENV')) as NodeJS.ProcessEnv,
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
      });
      // `.env` define NODE_ENV=development; sin él, `env.ts` asume development. En ambos casos se rechaza.
      assert.notEqual(r.status, 0);
      assert.match(`${r.stdout}${r.stderr}`, /reservada para producción/);
    });

    it('ISOLATION-4 · NODE_ENV=production con DB_NAME=busperu: la guarda no bloquea (llega a intentar conectar)', () => {
      const r = arrancarHastaSalir({ ...PRODUCTION_ENV, ...SIN_MYSQL, NODE_ENV: 'production', DB_NAME: 'busperu' });
      assert.doesNotMatch(r.salida, /reservada para producción/);
      assert.match(r.salida, /No se pudo conectar a MySQL/, 'pasó la guarda y fue al puerto inexistente, no a la base real');
    });

    it('ISOLATION-8 · sin DB_NAME en el entorno ni en .env: error explícito, nunca «busperu»', () => {
      const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'busperu-11f0-'));
      try {
        const entorno = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'DB_NAME')) as NodeJS.ProcessEnv;
        const r = spawnSync(process.execPath, [TSX, PROBE], { cwd: vacio, env: { ...entorno, NODE_ENV: 'development' }, encoding: 'utf8', timeout: 60_000, windowsHide: true });
        const salida = `${r.stdout}${r.stderr}`;
        assert.notEqual(r.status, 0);
        assert.match(salida, /Falta la variable de entorno obligatoria: DB_NAME/);
        assert.doesNotMatch(salida, /DB_NAME_RESUELTO=/);
      } finally {
        fs.rmSync(vacio, { recursive: true, force: true });
      }
    });

    it('ISOLATION-2/5/6 · development + busperu_test: arranca, plantillas y planificador sobre busperu_test', async () => {
      // Un viaje ya salido: si el planificador del hijo corre sobre ESTA base, lo pasará a IN_PROGRESS.
      const viaje = (
        await execute(
          `INSERT INTO trips (route_id, bus_id, bus_layout_id, departure_datetime, arrival_datetime, base_price, available_seats, status)
           SELECT route_id, bus_id, bus_layout_id, DATE_SUB(NOW(), INTERVAL 10 MINUTE), DATE_ADD(NOW(), INTERVAL 5 HOUR), base_price, available_seats, 'SCHEDULED' FROM trips WHERE id = ?`,
          [ctx.fixtures.tripA],
        )
      ).insertId;
      await execute("DELETE FROM notification_templates WHERE name = 'booking.payment_compensated'");

      const puerto = String(39000 + Math.floor(Math.random() * 1000));
      const hijo = spawn(process.execPath, [TSX, SERVER], {
        cwd: BACKEND,
        env: { ...process.env, NODE_ENV: 'development', DB_NAME: TEST_DATABASE, PORT: puerto, BOOKING_EXPIRY_INTERVAL_MS: '60000' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let salida = '';
      hijo.stdout.on('data', (c: Buffer) => (salida += c.toString()));
      hijo.stderr.on('data', (c: Buffer) => (salida += c.toString()));
      try {
        const limite = Date.now() + 60_000;
        while (!/escuchando/.test(salida) && hijo.exitCode === null && Date.now() < limite) await esperar(200);
        assert.match(salida, /escuchando/, salida);
        assert.match(salida, new RegExp(`Conectado a MySQL \\([^)]*/${TEST_DATABASE}\\)`), 'el log dice qué base usa');
        assert.doesNotMatch(salida, /\/busperu\)/);

        let estado = '';
        const limiteViaje = Date.now() + 20_000;
        while (Date.now() < limiteViaje) {
          estado = String((await queryOne<{ status: string }>('SELECT status FROM trips WHERE id = ?', [viaje]))?.status);
          if (estado === 'IN_PROGRESS') break;
          await esperar(250);
        }
        assert.equal(estado, 'IN_PROGRESS', 'el planificador del servidor de desarrollo corrió sobre busperu_test');
        const plantilla = await queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM notification_templates WHERE name = 'booking.payment_compensated'");
        assert.equal(Number(plantilla?.n), 1, 'ensureSystemTemplates() creó la plantilla en busperu_test');
      } finally {
        terminarArbol(hijo.pid);
      }
    });
  });

  describe('La configuración de la suite', () => {
    it('ISOLATION-3/7 · la suite corre con NODE_ENV=test sobre la base *_test, y el pool está conectado a ella', async () => {
      assert.equal(env.nodeEnv, 'test');
      assert.ok(TEST_DATABASE.endsWith('_test'));
      assert.equal(env.db.name, TEST_DATABASE);
      assert.equal((await queryOne<{ db: string }>('SELECT DATABASE() AS db'))?.db, TEST_DATABASE);
    });

    it('ISOLATION-5/6 · en proceso, ensureSystemTemplates y el ciclo de vida escriben en la base del pool', async () => {
      await execute("DELETE FROM notification_templates WHERE name = 'booking.payment_compensated'");
      await ensureSystemTemplates();
      const fila = await queryOne<{ db: string; n: number }>(
        "SELECT DATABASE() AS db, (SELECT COUNT(*) FROM notification_templates WHERE name = 'booking.payment_compensated') AS n",
      );
      assert.deepEqual([fila?.db, Number(fila?.n)], [TEST_DATABASE, 1]);

      const viaje = (
        await execute(
          `INSERT INTO trips (route_id, bus_id, bus_layout_id, departure_datetime, arrival_datetime, base_price, available_seats, status)
           SELECT route_id, bus_id, bus_layout_id, DATE_SUB(NOW(), INTERVAL 5 MINUTE), DATE_ADD(NOW(), INTERVAL 1 HOUR), base_price, available_seats, 'BOARDING' FROM trips WHERE id = ?`,
          [ctx.fixtures.tripA],
        )
      ).insertId;
      await advanceTripLifecycle();
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM trips WHERE id = ?', [viaje]))?.status, 'IN_PROGRESS');
    });
  });
});
