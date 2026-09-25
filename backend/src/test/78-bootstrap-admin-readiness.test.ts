import './helpers/testEnv';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execute, pool, query, queryOne } from '../config/database';
import { env } from '../config/env';
import { AdminBootstrapError, bootstrapFirstAdmin } from '../services/admin-bootstrap.service';
import { storageRoot } from '../services/file-storage.service';
import { verifyPassword } from '../utils/security';
import { api, get, post, testBaseUrl } from './helpers/api';
import { prepareSuite, teardownSuite } from './helpers/suite';
import { TEST_DATABASE } from './helpers/testEnv';

/**
 * F18-02 · alta del primer administrador y comprobación de readiness.
 *
 * ALTA DEL PRIMER ADMINISTRADOR. En producción la base nace sin usuarios y el seed se niega a correr
 * allí, así que hacía falta una forma segura de crear el primer ADMIN que no fuera un `INSERT` a mano.
 * Aquí se prueba el servicio en el propio proceso y el COMANDO real en un proceso aparte, con la
 * entrada por tubería: así se comprueba de verdad que la contraseña no sale por ninguna parte y que
 * una configuración peligrosa se rechaza antes de abrir ninguna conexión.
 *
 * READINESS. `/api/health` sigue siendo liveness; `/api/ready` comprueba base y almacenamiento y
 * responde lo mínimo. Los fallos se simulan en el propio proceso y se restauran siempre.
 *
 * Todo contra la base de PRUEBAS. Los administradores de esta suite se borran al terminar.
 */

const BACKEND = process.cwd();
const TSX = path.join(BACKEND, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const COMANDO = path.join('src', 'scripts', 'bootstrap-admin.ts');

/** Contraseña válida y distinta en cada ejecución: nunca una constante que pueda filtrarse. */
const clave = () => `Clave${crypto.randomBytes(6).toString('hex')}9A`;
const correo = (n: string) => `sec-bootstrap-${n}@test.pe`;

async function borrarAdministradores(): Promise<void> {
  await execute("DELETE FROM users WHERE role_id = (SELECT id FROM roles WHERE name = 'ADMIN')");
}
const contarAdministradores = async () =>
  Number((await queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'ADMIN'"))?.n);
const fotoUsuarios = async () =>
  queryOne<{ n: number; maximo: number | null; huella: string | null }>(
    "SELECT COUNT(*) AS n, MAX(id) AS maximo, MD5(GROUP_CONCAT(CONCAT(id, ':', role_id, ':', status, ':', password_hash) ORDER BY id)) AS huella FROM users",
  );

/** Ejecuta el comando real, con la entrada por tubería (nunca un argumento). */
function ejecutarComando(entrada: string[], opciones: { args?: string[]; env?: Record<string, string> } = {}) {
  const r = spawnSync(process.execPath, [TSX, COMANDO, ...(opciones.args ?? [])], {
    cwd: BACKEND,
    env: { ...process.env, ...(opciones.env ?? {}) },
    input: entrada.join('\n') + '\n',
    encoding: 'utf8',
    timeout: 90_000,
  });
  return { codigo: r.status, salida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('F18-02 · primer administrador y readiness', () => {
  before(async () => {
    await prepareSuite();
    fs.mkdirSync(storageRoot(), { recursive: true });
  });
  after(async () => {
    await borrarAdministradores();
    await teardownSuite();
  });

  /* ================================================================ servicio */
  describe('alta del primer administrador · servicio', () => {
    beforeEach(borrarAdministradores);

    it('sin administradores, crea uno ACTIVE con rol ADMIN y hash compatible con el login', async () => {
      const password = clave();
      const { id } = await bootstrapFirstAdmin({ email: correo('uno'), password, first_name: 'Ada', last_name: 'Primera' });

      const fila = await queryOne<{ status: string; rol: string; password_hash: string }>(
        'SELECT u.status, r.name AS rol, u.password_hash FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?', [id],
      );
      assert.equal(fila?.status, 'ACTIVE');
      assert.equal(fila?.rol, 'ADMIN');
      assert.ok(await verifyPassword(password, fila!.password_hash), 'el hash lo acepta la misma función que usa el login');
      assert.notEqual(fila!.password_hash, password);

      // Y el login real funciona con él, con los permisos del rol.
      const login = await post('/auth/login', { email: correo('uno'), password });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      assert.equal(login.body.data.user.role, 'ADMIN');
      assert.ok(login.body.data.user.permissions.length > 0, 'los permisos salen del rol');
      assert.equal((await get('/auth/me', login.body.data.token)).status, 200);
    });

    it('con un administrador ya creado, se rechaza y no modifica nada', async () => {
      await bootstrapFirstAdmin({ email: correo('uno'), password: clave(), first_name: 'Ada', last_name: 'Primera' });
      const antes = await fotoUsuarios();

      await assert.rejects(
        () => bootstrapFirstAdmin({ email: correo('dos'), password: clave(), first_name: 'Otro', last_name: 'Intento' }),
        (e: unknown) => e instanceof AdminBootstrapError && e.code === 'ADMIN_EXISTS',
      );
      assert.deepEqual(await fotoUsuarios(), antes, 'ni una fila más ni una fila cambiada');
    });

    for (const [etiqueta, datos] of [
      ['un correo inválido', { email: 'no-es-un-correo', password: 'ClaveValida9', first_name: 'Ada', last_name: 'Primera' }],
      ['una contraseña corta', { email: correo('x'), password: 'Ab9', first_name: 'Ada', last_name: 'Primera' }],
      ['una contraseña sin mayúscula', { email: correo('x'), password: 'clavevalida9', first_name: 'Ada', last_name: 'Primera' }],
      ['una contraseña sin número', { email: correo('x'), password: 'ClaveValidaSin', first_name: 'Ada', last_name: 'Primera' }],
      ['un nombre vacío', { email: correo('x'), password: 'ClaveValida9', first_name: ' ', last_name: 'Primera' }],
    ] as const) {
      it(`${etiqueta} se rechaza sin crear nada`, async () => {
        const antes = await fotoUsuarios();
        await assert.rejects(
          () => bootstrapFirstAdmin(datos),
          (e: unknown) => e instanceof AdminBootstrapError && e.code === 'INVALID_INPUT' && !e.message.includes(datos.password),
        );
        assert.deepEqual(await fotoUsuarios(), antes);
      });
    }

    for (const [etiqueta, extra] of [
      ['un rol en la entrada', { role: 'CUSTOMER' }],
      ['un role_id en la entrada', { role_id: 4 }],
      ['un estado en la entrada', { status: 'PENDING' }],
    ] as const) {
      it(`${etiqueta} se rechaza: el rol nunca viene de fuera`, async () => {
        const antes = await fotoUsuarios();
        await assert.rejects(
          () => bootstrapFirstAdmin({ email: correo('x'), password: clave(), first_name: 'Ada', last_name: 'Primera', ...extra }),
          (e: unknown) => e instanceof AdminBootstrapError && e.code === 'INVALID_INPUT',
        );
        assert.deepEqual(await fotoUsuarios(), antes);
      });
    }

    it('un correo que ya usa otra cuenta se rechaza y esa cuenta no se toca', async () => {
      const antes = await queryOne<{ role_id: number; password_hash: string }>("SELECT role_id, password_hash FROM users WHERE email = 'cliente@test.pe'");

      await assert.rejects(
        () => bootstrapFirstAdmin({ email: 'cliente@test.pe', password: clave(), first_name: 'Ada', last_name: 'Primera' }),
        (e: unknown) => e instanceof AdminBootstrapError && e.code === 'EMAIL_TAKEN',
      );
      assert.deepEqual(await queryOne("SELECT role_id, password_hash FROM users WHERE email = 'cliente@test.pe'"), antes, 'no se le cambia el rol ni la contraseña');
      assert.equal(await contarAdministradores(), 0);
    });

    it('un fallo dentro de la transacción no deja ni el usuario ni su auditoría', async () => {
      // Las pruebas anteriores dejan sus propias filas de auditoría: se compara antes y después.
      const auditoriasDelAlta = async () =>
        (await query("SELECT id FROM audit_logs WHERE JSON_UNQUOTE(JSON_EXTRACT(new_values, '$.actor')) = 'system:admin-bootstrap'")).length;
      const auditoriasAntes = await auditoriasDelAlta();

      await assert.rejects(
        () => bootstrapFirstAdmin(
          { email: correo('rollback'), password: clave(), first_name: 'Ada', last_name: 'Primera' },
          { beforeCommit: async () => { throw new Error('fallo simulado antes de confirmar'); } },
        ),
        /fallo simulado/,
      );
      assert.equal(await contarAdministradores(), 0);
      assert.equal((await query('SELECT id FROM users WHERE email = ?', [correo('rollback')])).length, 0);
      assert.equal(await auditoriasDelAlta(), auditoriasAntes, 'la auditoría del alta también se deshace');
    });

    it('dos altas simultáneas crean como mucho un administrador', async () => {
      const resultados = await Promise.allSettled([
        bootstrapFirstAdmin({ email: correo('carrera-a'), password: clave(), first_name: 'Ada', last_name: 'Carrera' }),
        bootstrapFirstAdmin({ email: correo('carrera-b'), password: clave(), first_name: 'Bea', last_name: 'Carrera' }),
      ]);

      assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1, 'exactamente una gana');
      const perdedora = resultados.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      assert.ok(perdedora.reason instanceof AdminBootstrapError && perdedora.reason.code === 'ADMIN_EXISTS', String(perdedora.reason));
      assert.equal(await contarAdministradores(), 1);
    });

    it('la auditoría registra el alta como acción del sistema, sin contraseña, hash ni correo', async () => {
      const password = clave();
      const { id } = await bootstrapFirstAdmin({ email: correo('auditoria'), password, first_name: 'Ada', last_name: 'Primera' });
      const hash = (await queryOne<{ h: string }>('SELECT password_hash AS h FROM users WHERE id = ?', [id]))!.h;

      const fila = await queryOne<{ user_id: number | null; description: string; old_values: string | null; new_values: string }>(
        "SELECT user_id, description, old_values, new_values FROM audit_logs WHERE entity_type = 'users' AND entity_id = ? AND action = 'CREATE'", [id],
      );
      assert.ok(fila);
      assert.equal(fila.user_id, null, 'nadie lo hizo desde una sesión');
      assert.equal(JSON.parse(fila.new_values).actor, 'system:admin-bootstrap');
      const volcado = JSON.stringify(fila);
      for (const prohibido of [password, hash, correo('auditoria')]) assert.ok(!volcado.includes(prohibido));
    });
  });

  /* ================================================================ comando */
  describe('alta del primer administrador · comando real', () => {
    beforeEach(borrarAdministradores);

    it('crea el administrador y la contraseña no aparece en la salida', async () => {
      const password = clave();
      const r = ejecutarComando([correo('cli'), 'Ada', 'Consola', password, password, TEST_DATABASE]);

      assert.equal(r.codigo, 0, r.salida);
      assert.match(r.salida, /Administrador creado/);
      assert.ok(!r.salida.includes(password), 'la contraseña no puede salir por consola');
      assert.equal(await contarAdministradores(), 1);
      const login = await post('/auth/login', { email: correo('cli'), password });
      assert.equal(login.status, 200, 'y se puede iniciar sesión con ella');
    });

    it('con un administrador ya creado, termina sin pedir nada ni modificar nada', async () => {
      await bootstrapFirstAdmin({ email: correo('previo'), password: clave(), first_name: 'Ada', last_name: 'Previa' });
      const antes = await fotoUsuarios();

      const r = ejecutarComando([]);

      assert.equal(r.codigo, 1, r.salida);
      assert.match(r.salida, /Ya existe un administrador/);
      assert.deepEqual(await fotoUsuarios(), antes);
    });

    it('la contraseña como argumento se rechaza, y el valor no se repite en la salida', async () => {
      const password = clave();
      const r = ejecutarComando([], { args: [`--password=${password}`] });

      assert.equal(r.codigo, 2, r.salida);
      assert.ok(!r.salida.includes(password));
      assert.equal(await contarAdministradores(), 0);
    });

    it('si el nombre de la base no coincide, no crea nada', async () => {
      const password = clave();
      const r = ejecutarComando([correo('cli'), 'Ada', 'Consola', password, password, 'otra_base']);

      assert.equal(r.codigo, 1, r.salida);
      assert.match(r.salida, /no coincide/);
      assert.equal(await contarAdministradores(), 0);
    });

    it('si las contraseñas no coinciden, no crea nada', async () => {
      const r = ejecutarComando([correo('cli'), 'Ada', 'Consola', clave(), clave(), TEST_DATABASE]);

      assert.equal(r.codigo, 1, r.salida);
      assert.match(r.salida, /no coinciden/);
      assert.equal(await contarAdministradores(), 0);
    });

    /**
     * Ninguna de estas dos llega a abrir una conexión: la guarda de la configuración se ejecuta al
     * cargar `env`, antes de que exista el pool. Por eso se puede nombrar aquí una base que no es de
     * pruebas sin riesgo alguno: el proceso termina antes de tocarla.
     */
    it('fuera de producción, una base que no es de pruebas se rechaza antes de conectar', () => {
      const r = ejecutarComando([], { env: { NODE_ENV: 'development', DB_NAME: 'busperu' } });

      assert.equal(r.codigo, 1, r.salida);
      assert.match(r.salida, /Configuración rechazada/);
      assert.ok(!/Alta del primer administrador ·/.test(r.salida), 'no llega ni a anunciar la base');
    });

    it('en producción con una configuración incompleta, también se rechaza antes de conectar', () => {
      const r = ejecutarComando([], { env: { NODE_ENV: 'production', DB_NAME: 'bd_ficticia_prod' } });

      assert.equal(r.codigo, 1, r.salida);
      assert.match(r.salida, /Configuración rechazada/);
    });
  });

  /* ================================================================ readiness */
  describe('readiness', () => {
    it('con base y almacenamiento disponibles responde 200 y solo { status: "ready" }', async () => {
      const r = await api('/ready');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body, { status: 'ready' });
    });

    it('sin base de datos responde 503 { status: "not_ready" } y /api/health sigue en 200', async () => {
      const original = pool.query.bind(pool);
      let opciones: unknown = null;
      (pool as unknown as { query: unknown }).query = async (arg: unknown) => {
        opciones = arg;
        throw new Error('ECONNREFUSED 10.0.0.9:3306 (simulado)');
      };
      try {
        const listo = await api('/ready');
        const vivo = await api('/health');
        assert.equal(listo.status, 503);
        assert.deepEqual(listo.body, { status: 'not_ready' });
        assert.equal(vivo.status, 200, 'liveness no depende de la base: son cosas distintas');
        assert.equal((opciones as { timeout?: number }).timeout, 2000, 'la consulta lleva un tiempo máximo');
      } finally {
        (pool as unknown as { query: unknown }).query = original;
      }
    });

    it('sin el directorio de almacenamiento responde 503', async () => {
      const original = env.storage.dir;
      (env.storage as { dir: string }).dir = path.join('storage-que-no-existe', crypto.randomBytes(4).toString('hex'));
      try {
        const r = await api('/ready');
        assert.equal(r.status, 503);
        assert.deepEqual(r.body, { status: 'not_ready' });
      } finally {
        (env.storage as { dir: string }).dir = original;
      }
    });

    it('si STORAGE_DIR es un archivo y no un directorio, responde 503', async () => {
      const original = env.storage.dir;
      const archivo = path.join(storageRoot(), `no-es-directorio-${crypto.randomBytes(4).toString('hex')}.txt`);
      fs.writeFileSync(archivo, 'x');
      (env.storage as { dir: string }).dir = archivo;
      try {
        assert.equal((await api('/ready')).status, 503);
      } finally {
        (env.storage as { dir: string }).dir = original;
        fs.rmSync(archivo, { force: true });
      }
    });

    it('la respuesta de fallo no filtra host, base, rutas ni trazas', async () => {
      const original = pool.query.bind(pool);
      (pool as unknown as { query: unknown }).query = async () => { throw new Error('ECONNREFUSED 10.0.0.9:3306 en /srv/secreto'); };
      try {
        const r = await fetch(`${testBaseUrl()}/ready`);
        const texto = await r.text();
        for (const prohibido of ['10.0.0.9', env.db.name, env.db.host, storageRoot(), 'ECONNREFUSED', 'at ', 'Error']) {
          assert.ok(!texto.includes(prohibido), `la respuesta no puede contener «${prohibido}»`);
        }
        assert.equal(r.headers.get('cache-control'), 'no-store', 'un proxy no debe cachear el estado');
      } finally {
        (pool as unknown as { query: unknown }).query = original;
      }
    });

    it('F18-07A · /health y /ready (sana) tampoco se cachean', async () => {
      for (const ruta of ['/health', '/ready']) {
        const r = await fetch(`${testBaseUrl()}${ruta}`);
        assert.equal(r.status, 200, ruta);
        assert.equal(r.headers.get('cache-control'), 'no-store', `${ruta} sin no-store`);
      }
    });

    it('peticiones raras no la rompen ni abren otras vías', async () => {
      assert.equal((await api('/ready?x=../../etc/passwd')).status, 200, 'la query string se ignora');
      assert.equal((await api('/ready', { method: 'POST', body: {} })).status, 404, 'solo existe GET');
      assert.equal((await api('/ready', { method: 'DELETE' })).status, 404);
    });

    it('no escribe en el almacenamiento ni en la base', async () => {
      const antes = fs.readdirSync(storageRoot()).sort();
      const usuarios = await fotoUsuarios();
      for (let i = 0; i < 5; i += 1) await api('/ready');
      assert.deepEqual(fs.readdirSync(storageRoot()).sort(), antes);
      assert.deepEqual(await fotoUsuarios(), usuarios);
    });
  });
});
