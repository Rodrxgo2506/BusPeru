import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { after, before, beforeEach, describe, it } from 'node:test';
import { get, post, testBaseUrl } from './helpers/api';
import { execute } from '../config/database';
import { errorHandler } from '../middleware/error.middleware';
import { logError } from '../utils/logger';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * BP-17 · registro de los errores 500.
 *
 * El manejador central decía `if (!env.isProduction && mapped.statusCode >= 500)`, así que
 * justo donde importa —en producción— un fallo devolvía «Error interno del servidor» y no
 * dejaba ningún rastro. Aquí se comprueba lo contrario y, con el mismo cuidado, que el
 * registro no se convierta en una fuga: ni cuerpo, ni cabeceras, ni credenciales, ni SQL.
 *
 * CÓMO SE PROVOCA UN 500 DE VERDAD. Renombrando temporalmente una tabla de `busperu_test`.
 * No es un error simulado con un doble: es la misma excepción de mysql2 que se vería en
 * producción si una migración quedara a medias, y recorre la pila entera —ruta, servicio,
 * repositorio, manejador—. El nombre se restituye siempre en el `finally`.
 */

// El registro se silencia durante la suite para no ensuciar la salida; este archivo es el
// único que necesita leerlo.
process.env.LOG_ERRORS = 'true';

interface RegistroError {
  timestamp: string;
  level: string;
  message: string;
  kind?: string;
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  userId?: number;
  role?: string;
  apiKeyId?: number;
  companyId?: number;
  error: { name: string; message: string; stack?: string; database?: Record<string, unknown> };
}

describe('BP-17 · registro seguro de errores del servidor', () => {
  let ctx: SuiteContext;
  let claveApi: string;

  /** Líneas crudas escritas en stderr durante la última captura. */
  let crudas: string[] = [];

  const original = console.error;

  before(async () => {
    ctx = await prepareSuite();
    const clave = await post(
      '/api-keys',
      { name: 'BP-17', company_id: ctx.fixtures.companyA },
      ctx.sessions.admin.token,
    );
    assert.equal(clave.status, 201, JSON.stringify(clave.body));
    claveApi = clave.body.data.plain_key as string;
  });

  after(async () => {
    console.error = original;
    await teardownSuite();
  });

  beforeEach(() => {
    crudas = [];
  });

  /** Ejecuta `accion` interceptando `stderr` y devuelve las líneas escritas. */
  async function capturar(accion: () => Promise<void>): Promise<string[]> {
    console.error = (...args: unknown[]) => {
      crudas.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    };
    try {
      await accion();
    } finally {
      console.error = original;
    }
    return crudas;
  }

  /** Solo las líneas que son un registro estructurado (descarta ruido de otras capas). */
  function registros(lineas: string[]): RegistroError[] {
    return lineas
      .map((linea) => {
        try {
          return JSON.parse(linea) as RegistroError;
        } catch {
          return null;
        }
      })
      .filter((r): r is RegistroError => r !== null && typeof r.level === 'string');
  }

  /**
   * Deja `tabla` inaccesible mientras corre `accion`. El nombre se restituye siempre, y el
   * viaje de ida y vuelta no altera la definición de las tablas que la referencian.
   */
  async function sinTabla<T>(tabla: string, accion: () => Promise<T>): Promise<T> {
    const oculta = `${tabla}_bp17_oculta`;
    await execute(`RENAME TABLE ${tabla} TO ${oculta}`);
    try {
      return await accion();
    } finally {
      await execute(`RENAME TABLE ${oculta} TO ${tabla}`);
    }
  }

  /** Provoca un 500 real y devuelve la respuesta cruda junto con lo registrado. */
  async function provocar500(
    tabla: string,
    peticion: () => Promise<Response>,
  ): Promise<{ respuesta: Response; cuerpo: any; registros: RegistroError[] }> {
    let respuesta!: Response;
    let cuerpo: any;
    const lineas = await capturar(async () => {
      await sinTabla(tabla, async () => {
        respuesta = await peticion();
        cuerpo = await respuesta.json();
      });
    });
    return { respuesta, cuerpo, registros: registros(lineas) };
  }

  const pedir = (ruta: string, init: RequestInit = {}) => fetch(testBaseUrl() + ruta, init);

  const conToken = (ruta: string, token: string, init: RequestInit = {}) =>
    pedir(ruta, {
      ...init,
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });

  /* ═════════════════════════════ el fallo queda registrado ═════════════════ */

  describe('Un 500 deja rastro en el servidor', () => {
    it('1 · un fallo real del servidor escribe exactamente una línea', async () => {
      const { respuesta, registros: regs } = await provocar500('reviews', () =>
        conToken('/reviews', ctx.sessions.admin.token),
      );

      assert.equal(respuesta.status, 500);
      assert.equal(regs.length, 1, `se esperaba una sola línea y hubo ${regs.length}: ${JSON.stringify(crudas)}`);
    });

    it('2 · la línea es un JSON de una sola línea, indexable por un recolector', async () => {
      const lineas = await capturar(async () => {
        await sinTabla('reviews', async () => {
          await conToken('/reviews', ctx.sessions.admin.token);
        });
      });

      const utiles = lineas.filter((l) => l.includes('"level"'));
      assert.equal(utiles.length, 1);
      assert.ok(!utiles[0]!.includes('\n'), 'el registro no debe ocupar varias líneas');
      assert.doesNotThrow(() => JSON.parse(utiles[0]!));
    });

    it('3 · lleva marca de tiempo, nivel y un mensaje legible', async () => {
      const { registros: regs } = await provocar500('reviews', () => conToken('/reviews', ctx.sessions.admin.token));
      const registro = regs[0]!;

      assert.equal(registro.level, 'error');
      assert.ok(registro.message.length > 0);
      assert.ok(!Number.isNaN(Date.parse(registro.timestamp)), 'la marca de tiempo debe ser una fecha ISO');
    });

    it('4 · identifica la petición: método, ruta y estado', async () => {
      const { registros: regs } = await provocar500('reviews', () =>
        conToken('/reviews?limit=5', ctx.sessions.admin.token),
      );
      const registro = regs[0]!;

      assert.equal(registro.method, 'GET');
      assert.ok(registro.path?.startsWith('/api/reviews'), `ruta inesperada: ${registro.path}`);
      assert.equal(registro.status, 500);
    });

    it('5 · conserva la traza, que es lo que permite localizar el fallo', async () => {
      const { registros: regs } = await provocar500('reviews', () => conToken('/reviews', ctx.sessions.admin.token));
      const stack = regs[0]!.error.stack ?? '';

      assert.ok(stack.length > 0, 'sin traza el registro no sirve para diagnosticar');
      assert.ok(stack.includes('at '), 'la traza debe contener marcos de pila');
    });

    it('6 · guarda el código y el mensaje de MySQL, pero no la sentencia', async () => {
      const { registros: regs } = await provocar500('reviews', () => conToken('/reviews', ctx.sessions.admin.token));
      const detalle = regs[0]!.error.database;

      assert.ok(detalle, 'un error del conector debe traer su detalle técnico');
      assert.equal(detalle.code, 'ER_NO_SUCH_TABLE');
      assert.ok(typeof detalle.errno === 'number');
      assert.ok(!('sql' in detalle), 'la sentencia lleva los parámetros ya sustituidos y no se registra');
    });

    it('7 · identifica a quien actuaba por id y rol, nunca por su token', async () => {
      const { registros: regs } = await provocar500('reviews', () =>
        conToken('/reviews', ctx.sessions.companyAdmin.token),
      );
      const registro = regs[0]!;

      assert.ok(typeof registro.userId === 'number' && registro.userId > 0);
      assert.equal(registro.role, 'COMPANY_ADMIN');
      assert.ok(!JSON.stringify(registro).includes(ctx.sessions.companyAdmin.token));
    });

    it('8 · un 500 sin sesión también queda registrado, sin inventar un usuario', async () => {
      const { registros: regs } = await provocar500('trips', () => pedir('/public/trips?limit=5'));
      const registro = regs[0]!;

      assert.equal(registro.status, 500);
      assert.equal(registro.userId, undefined);
      assert.equal(registro.role, undefined);
    });
  });

  /* ═════════════════════════════ lo que jamás se registra ══════════════════ */

  describe('El registro no filtra nada sensible', () => {
    it('9 · no registra el cuerpo de la petición', async () => {
      const secreto = 'valor-que-no-debe-aparecer-en-el-diario';
      const { registros: regs } = await provocar500('reviews', () =>
        conToken('/reviews', ctx.sessions.customer.token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ booking_id: 1, rating: 5, comment: secreto }),
        }),
      );

      const texto = JSON.stringify(regs);
      assert.ok(!texto.includes(secreto), 'el cuerpo no se vuelca al registro');
      assert.ok(!texto.includes('"body"'));
    });

    it('10 · no registra la contraseña enviada al iniciar sesión', async () => {
      const contrasena = 'ContrasenaEnClaro123';
      const { registros: regs } = await provocar500('users', () =>
        pedir('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'admin@test.pe', password: contrasena }),
        }),
      );

      assert.equal(regs.length, 1);
      const texto = JSON.stringify(regs);
      assert.ok(!texto.includes(contrasena), 'la contraseña jamás debe llegar al diario');
      assert.ok(!texto.toLowerCase().includes('password'));
    });

    it('11 · no registra las cabeceras ni la credencial de sesión', async () => {
      const token = ctx.sessions.admin.token;
      const { registros: regs } = await provocar500('reviews', () =>
        conToken('/reviews', token, { headers: { 'X-Rastro': 'cabecera-que-no-debe-registrarse' } }),
      );

      const texto = JSON.stringify(regs);
      assert.ok(!texto.includes(token), 'el JWT no se registra');
      assert.ok(!texto.includes('Bearer'));
      assert.ok(!texto.includes('cabecera-que-no-debe-registrarse'));
      assert.ok(!texto.includes('"headers"') && !texto.includes('"cookies"'));
    });

    it('12 · con API Key registra el id de la llave y la empresa, nunca la clave', async () => {
      const { registros: regs } = await provocar500('trips', () =>
        pedir('/integration/v1/trips', { headers: { Accept: 'application/json', 'X-API-Key': claveApi } }),
      );
      const registro = regs[0]!;

      assert.ok(typeof registro.apiKeyId === 'number' && registro.apiKeyId > 0);
      assert.equal(registro.companyId, ctx.fixtures.companyA);
      const texto = JSON.stringify(regs);
      assert.ok(!texto.includes(claveApi), 'la clave en claro no puede aparecer en el diario');
      assert.ok(!texto.toLowerCase().includes('x-api-key'));
    });

    it('13 · la clave queda fuera aunque el prefijo sea reconocible', async () => {
      const prefijo = claveApi.slice(0, 8);
      const { registros: regs } = await provocar500('trips', () =>
        pedir('/integration/v1/trips', { headers: { Accept: 'application/json', 'X-API-Key': claveApi } }),
      );

      assert.ok(!JSON.stringify(regs).includes(prefijo), 'ni siquiera el principio de la clave se registra');
    });
  });

  /* ═════════════════════════════ lo que ve el cliente ══════════════════════ */

  describe('La respuesta al cliente no expone el interior', () => {
    it('14 · el 500 no lleva traza, ni SQL, ni el nombre de la tabla', async () => {
      const { cuerpo } = await provocar500('reviews', () => conToken('/reviews', ctx.sessions.admin.token));

      const texto = JSON.stringify(cuerpo);
      assert.equal(cuerpo.success, false);
      assert.equal(cuerpo.message, 'Error interno del servidor');
      assert.ok(!texto.includes('stack') && !texto.includes('at '));
      assert.ok(!texto.includes('SELECT') && !texto.includes('reviews'));
      assert.ok(!texto.includes('ER_NO_SUCH_TABLE') && !texto.includes('errno'));
    });

    it('15 · el 500 devuelve una referencia que el usuario puede citar', async () => {
      const { respuesta, cuerpo, registros: regs } = await provocar500('reviews', () =>
        conToken('/reviews', ctx.sessions.admin.token),
      );

      assert.ok(typeof cuerpo.request_id === 'string' && cuerpo.request_id.length > 0);
      assert.equal(cuerpo.request_id, respuesta.headers.get('x-request-id'));
      assert.equal(cuerpo.request_id, regs[0]!.requestId, 'la referencia debe unir respuesta y registro');
    });

    it('16 · una respuesta correcta no arrastra referencia en el cuerpo', async () => {
      const res = await get('/reviews', ctx.sessions.admin.token);

      assert.equal(res.status, 200);
      assert.ok(!('request_id' in res.body));
    });
  });

  /* ═════════════════════════════ ruido y duplicados ════════════════════════ */

  describe('Ni ruido ni registros repetidos', () => {
    it('17 · un 4xx no se registra: es una respuesta legítima, no una avería', async () => {
      const lineas = await capturar(async () => {
        await pedir('/reviews');
        await conToken('/reviews/999999', ctx.sessions.admin.token);
        await conToken('/no-existe-esta-ruta', ctx.sessions.admin.token);
      });

      assert.equal(registros(lineas).length, 0, `los 4xx no deben ensuciar el diario: ${JSON.stringify(lineas)}`);
    });

    it('18 · una petición correcta no escribe nada', async () => {
      const lineas = await capturar(async () => {
        await get('/reviews', ctx.sessions.admin.token);
        await pedir('/health');
      });

      assert.equal(registros(lineas).length, 0);
    });

    it('19 · el mismo fallo no se registra dos veces por capas distintas', async () => {
      const { registros: regs } = await provocar500('reviews', () => conToken('/reviews', ctx.sessions.admin.token));

      const mensajes = regs.map((r) => r.error.message);
      assert.equal(regs.length, 1, `el error apareció ${regs.length} veces: ${JSON.stringify(mensajes)}`);
    });

    it('20 · dos fallos distintos producen dos registros con referencias distintas', async () => {
      const lineas = await capturar(async () => {
        await sinTabla('reviews', async () => {
          await conToken('/reviews', ctx.sessions.admin.token);
          await conToken('/reviews', ctx.sessions.admin.token);
        });
      });

      const regs = registros(lineas);
      assert.equal(regs.length, 2);
      assert.notEqual(regs[0]!.requestId, regs[1]!.requestId);
    });
  });

  /* ═════════════════════════════ identificador de petición ═════════════════ */

  describe('Identificador de petición', () => {
    it('21 · toda respuesta lleva X-Request-Id, no solo las que fallan', async () => {
      const res = await pedir('/health');

      assert.equal(res.status, 200);
      assert.ok((res.headers.get('x-request-id') ?? '').length > 0);
    });

    it('22 · cada petición recibe un identificador distinto', async () => {
      const [a, b] = await Promise.all([pedir('/health'), pedir('/health')]);

      assert.notEqual(a.headers.get('x-request-id'), b.headers.get('x-request-id'));
    });

    it('23 · el identificador que envía el cliente se ignora', async () => {
      const impuesto = 'identificador-elegido-por-el-cliente';
      const res = await pedir('/health', { headers: { 'X-Request-Id': impuesto } });

      assert.notEqual(res.headers.get('x-request-id'), impuesto);
    });

    it('24 · el identificador impuesto tampoco llega al registro', async () => {
      const impuesto = 'identificador-elegido-por-el-cliente';
      const { registros: regs } = await provocar500('reviews', () =>
        conToken('/reviews', ctx.sessions.admin.token, { headers: { 'X-Request-Id': impuesto } }),
      );

      assert.notEqual(regs[0]!.requestId, impuesto);
      assert.ok((regs[0]!.requestId ?? '').length > 0);
    });
  });

  /* ═════════════════════════════ excepciones no controladas ════════════════ */

  describe('Excepciones que escapan a todo manejador', () => {
    /** Corre `fatalChild.ts` en un proceso aparte y devuelve su salida de error. */
    function correrHijo(modo: 'uncaught' | 'rejection'): Promise<{ code: number | null; stderr: string }> {
      const script = path.join(__dirname, 'helpers', 'fatalChild.ts');
      return new Promise((resolve) => {
        const hijo = spawn(process.execPath, ['--import', 'tsx', script, modo], { cwd: process.cwd() });
        let stderr = '';
        hijo.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        hijo.on('close', (code) => resolve({ code, stderr }));
      });
    }

    it('25 · una excepción no controlada queda registrada como fatal', async () => {
      const { stderr } = await correrHijo('uncaught');
      const registro = registros(stderr.trim().split('\n'))[0];

      assert.ok(registro, `no se registró nada: ${stderr}`);
      assert.equal(registro.level, 'fatal');
      assert.equal(registro.kind, 'uncaughtException');
      assert.equal(registro.error.message, 'fallo sintetico no controlado');
      assert.ok((registro.error.stack ?? '').includes('at '));
    });

    it('26 · una promesa rechazada sin manejador queda registrada como fatal', async () => {
      const { stderr } = await correrHijo('rejection');
      const registro = registros(stderr.trim().split('\n'))[0];

      assert.ok(registro, `no se registró nada: ${stderr}`);
      assert.equal(registro.level, 'fatal');
      assert.equal(registro.kind, 'unhandledRejection');
      assert.equal(registro.error.message, 'promesa sintetica rechazada');
    });

    it('27 · tras registrar, el proceso termina con código distinto de cero', async () => {
      const { code, stderr } = await correrHijo('uncaught');

      // No se intenta continuar: el estado del proceso es indeterminado. El código 1 es lo
      // que el gestor de procesos (systemd, Docker, PM2) interpreta como «reinícialo».
      assert.equal(code, 1, `se esperaba salida 1 y fue ${code}: ${stderr}`);
      assert.ok(stderr.includes('"shutdown"'), 'el cierre ordenado debe dispararse tras registrar');
    });
  });

  /* ═════════════════════════════ robustez del registrador ══════════════════ */

  describe('El registrador aguanta lo que le echen', () => {
    it('28 · recorta mensajes y trazas desmesurados en vez de inundar el diario', async () => {
      const error = new Error('x'.repeat(5_000));
      error.stack = `Error: gigante\n${'    at algo (archivo.ts:1:1)\n'.repeat(500)}`;

      const lineas = await capturar(async () => {
        logError('prueba de recorte', error, { requestId: 'r-1' });
      });

      const registro = registros(lineas)[0]!;
      assert.ok(registro.error.message.length < 1_200, 'el mensaje debe venir recortado');
      assert.ok((registro.error.stack ?? '').length < 4_200, 'la traza debe venir recortada');
      assert.ok(registro.error.message.includes('recortado'));
    });

    it('29 · registra también lo que se lanza sin ser un Error', async () => {
      const lineas = await capturar(async () => {
        logError('valor extraño', 'esto no es un Error', { requestId: 'r-2' });
        logError('valor nulo', null, { requestId: 'r-3' });
      });

      const regs = registros(lineas);
      assert.equal(regs.length, 2);
      assert.equal(regs[0]!.error.message, 'esto no es un Error');
      assert.equal(regs[1]!.error.message, 'null');
      assert.ok(regs.every((r) => r.error.stack === undefined));
    });

    it('30 · el manejador central no añade al registro más campos que los previstos', async () => {
      // Sin firma de índice en `LogContext`, colar `req.body` o unas cabeceras no compila.
      // Lo que se comprueba aquí, en ejecución, es que el manejador tampoco los arrastra.
      const enviado: Record<string, unknown>[] = [];
      const lineas = await capturar(async () => {
        const req = {
          id: 'r-4',
          method: 'POST',
          originalUrl: '/api/algo',
          body: { password: 'no-debe-salir' },
          headers: { authorization: 'Bearer no-debe-salir' },
          user: { id: 7, role: 'ADMIN' },
        } as any;
        const res: any = {
          status: () => res,
          json: (payload: unknown) => enviado.push(payload as Record<string, unknown>),
        };
        errorHandler(new Error('fallo de prueba'), req, res, (() => undefined) as any);
      });

      const registro = registros(lineas)[0]!;
      assert.deepEqual(Object.keys(registro).sort(), [
        'error',
        'level',
        'message',
        'method',
        'path',
        'requestId',
        'role',
        'status',
        'timestamp',
        'userId',
      ]);
      assert.ok(!JSON.stringify(registro).includes('no-debe-salir'));
      assert.equal((enviado[0] as any).request_id, 'r-4');
    });
  });
});
