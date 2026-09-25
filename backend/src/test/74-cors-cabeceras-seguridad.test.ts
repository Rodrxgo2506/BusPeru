import './helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestServer } from './helpers/api';
import { env } from '../config/env';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * F17C-SEC-07 · CORS y cabeceras de seguridad HTTP.
 *
 * DOS IDEAS SOSTIENEN TODA ESTA SUITE.
 *
 * La primera: el backend anuncia UN origen fijo y no refleja jamás el `Origin` que recibe. Es lo
 * que impide el fallo clásico de CORS —devolver `Access-Control-Allow-Origin: <lo que pidió el
 * atacante>`— y por eso casi todas las pruebas de abajo comprueban lo mismo desde ángulos
 * distintos: da igual qué `Origin` se envíe, la cabecera no cambia.
 *
 * La segunda, y es la que de verdad importa: **CORS no es control de acceso**. Es una política que
 * aplica el NAVEGADOR sobre la respuesta; `curl`, un script o un servidor la ignoran por completo.
 * Así que aquí también se comprueba que un origen no permitido con un token válido SÍ recibe su
 * respuesta —eso es correcto— y que quien de verdad decide sigue siendo la autenticación, el rol y
 * la clave de API. Si alguna vez alguien intenta usar CORS para proteger un endpoint, estas
 * pruebas le recordarán que no protege nada.
 *
 * Todo contra `busperu_test`. No se toca ninguna configuración global ni `.env`.
 */

/** Cabeceras que nos interesan de una respuesta, en minúsculas. */
async function pedir(
  url: string,
  opciones: { method?: string; origin?: string; token?: string; apiKey?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; head: (nombre: string) => string | null; body: any }> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(opciones.headers ?? {}) };
  if (opciones.origin !== undefined) headers.Origin = opciones.origin;
  if (opciones.token) headers.Authorization = `Bearer ${opciones.token}`;
  if (opciones.apiKey) headers['X-API-Key'] = opciones.apiKey;

  const respuesta = await fetch(url, { method: opciones.method ?? 'GET', headers });
  let body: any = {};
  try {
    body = await respuesta.json();
  } catch {
    body = {};
  }
  return { status: respuesta.status, head: (nombre) => respuesta.headers.get(nombre), body };
}

describe('SEC-07 · CORS y cabeceras de seguridad', () => {
  let ctx: SuiteContext;
  let base = '';
  /** El origen que el backend considera legítimo, ya normalizado. */
  const LEGITIMO = env.corsOrigin;

  before(async () => {
    ctx = await prepareSuite();
    base = await startTestServer();
  });
  after(teardownSuite);

  /* ============================================ el origen anunciado es fijo, nunca un reflejo */
  describe('el origen permitido no depende de lo que pida el cliente', () => {
    it('el frontend legítimo recibe su origen, con credenciales y Vary', async () => {
      const r = await pedir(`${base}/public/settings`, { origin: LEGITIMO });

      assert.equal(r.status, 200);
      assert.equal(r.head('access-control-allow-origin'), LEGITIMO);
      assert.equal(r.head('access-control-allow-credentials'), 'true');
      assert.match(String(r.head('vary')), /Origin/, 'sin Vary: Origin una caché podría servir la respuesta a otro origen');
    });

    /**
     * El corazón del asunto. Ninguno de estos `Origin` debe aparecer NUNCA en la respuesta. Se
     * incluyen a propósito los que engañan a una comparación perezosa: el que TERMINA en el
     * dominio legítimo, el que EMPIEZA por él, el subdominio y el cambio de esquema o de puerto.
     */
    for (const [etiqueta, origin] of [
      ['un dominio cualquiera', 'https://attacker.example'],
      ['uno que acaba en el legítimo', 'https://evil.com/?x=http://localhost:5173'],
      ['sufijo: el legítimo como prefijo del suyo', 'http://localhost:5173.attacker.example'],
      ['prefijo: el legítimo dentro del suyo', 'https://localhost-5173.evil.com'],
      ['un subdominio', 'http://evil.localhost:5173'],
      ['el literal null (iframe sandbox, redirecciones)', 'null'],
      ['otro puerto', 'http://localhost:5174'],
      ['otro esquema', 'https://localhost:5173'],
      ['el legítimo con barra final', `${LEGITIMO}/`],
      ['el legítimo en mayúsculas', LEGITIMO.toUpperCase()],
      ['dos orígenes en una cabecera', `${LEGITIMO}, https://attacker.example`],
      ['un intento de comodín', '*'],
    ] as const) {
      it(`no refleja ${etiqueta}`, async () => {
        const r = await pedir(`${base}/public/settings`, { origin });

        const anunciado = r.head('access-control-allow-origin');
        assert.equal(anunciado, LEGITIMO, 'la cabecera debe ser siempre la misma, pase lo que pase');
        assert.notEqual(anunciado, origin, 'reflejar el Origin recibido sería el fallo clásico de CORS');
        assert.notEqual(anunciado, '*');
      });
    }

    it('sin cabecera Origin la petición se atiende igual', async () => {
      // Un servidor, un script o `curl` no envían Origin. No hay nada que negociar.
      const r = await pedir(`${base}/public/settings`);
      assert.equal(r.status, 200);
    });

    it('nunca se combina comodín con credenciales', async () => {
      // `*` junto a `credentials: true` es una configuración que los navegadores rechazan y que
      // delata un CORS abierto. Se comprueba en varias rutas por si alguna tuviera su propio CORS.
      for (const ruta of ['/public/settings', '/auth/login', '/bookings', '/health']) {
        const r = await pedir(base.replace(/\/api$/, '/api') + ruta, { origin: 'https://attacker.example' });
        assert.notEqual(r.head('access-control-allow-origin'), '*', `${ruta} no puede anunciar comodín`);
      }
    });
  });

  /* ============================================ SEC07-01 · el origen anunciado es utilizable */
  describe('SEC07-01 · el origen anunciado tiene forma de origen', () => {
    /**
     * REGRESIÓN DEL HALLAZGO. `Origin` que manda un navegador es siempre `esquema://host[:puerto]`:
     * ni barra final ni ruta. Si `FRONTEND_URL` se escribe como `https://dominio.pe/` —algo
     * perfectamente natural, y que la guarda de producción acepta con razón porque esa misma
     * variable es la base del redirect de OAuth— el `ACAO` resultante no coincide con ningún
     * `Origin` y el navegador rechaza TODAS las respuestas: la aplicación entera cae en producción.
     */
    it('el ACAO no lleva barra final ni ruta', async () => {
      const anunciado = String((await pedir(`${base}/public/settings`, { origin: LEGITIMO })).head('access-control-allow-origin'));

      assert.equal(new URL(anunciado).origin, anunciado, `«${anunciado}» no es un origen puro: ningún navegador podría aceptarlo`);
      assert.ok(!anunciado.endsWith('/'), 'una barra final basta para romper CORS por completo');
    });

    it('el origen de CORS se deriva de FRONTEND_URL normalizándola', async () => {
      assert.equal(env.corsOrigin, new URL(env.frontendUrl).origin);
    });
  });

  /* ============================================ preflight */
  describe('preflight', () => {
    const preflight = (ruta: string, origin: string, metodo = 'POST') =>
      pedir(`${base}${ruta}`, {
        method: 'OPTIONS',
        origin,
        headers: { 'Access-Control-Request-Method': metodo, 'Access-Control-Request-Headers': 'authorization,content-type' },
      });

    for (const ruta of ['/auth/login', '/public/settings', '/bookings', '/payments', '/companies', '/users']) {
      it(`${ruta} responde al preflight del frontend legítimo`, async () => {
        const r = await preflight(ruta, LEGITIMO);

        assert.ok(r.status === 204 || r.status === 200, `el preflight no debe fallar (${r.status})`);
        assert.equal(r.head('access-control-allow-origin'), LEGITIMO);
        assert.match(String(r.head('access-control-allow-methods')), /POST/);
        assert.match(String(r.head('access-control-allow-headers')).toLowerCase(), /authorization/);
      });

      it(`${ruta} no concede permisos a un origen no permitido`, async () => {
        const r = await preflight(ruta, 'https://attacker.example');
        assert.notEqual(r.head('access-control-allow-origin'), 'https://attacker.example');
        assert.equal(r.head('access-control-allow-origin'), LEGITIMO, 'el navegador del atacante comparará y descartará');
      });
    }

    it('solo se anuncian métodos que la API usa de verdad', async () => {
      const metodos = String((await preflight('/bookings', LEGITIMO)).head('access-control-allow-methods'))
        .split(',')
        .map((m) => m.trim().toUpperCase())
        .filter(Boolean);

      const usados = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
      for (const metodo of metodos) {
        assert.ok(usados.has(metodo), `se anuncia un método que la API no usa: ${metodo}`);
      }
      for (const peligroso of ['TRACE', 'CONNECT', 'TRACK']) {
        assert.ok(!metodos.includes(peligroso), `${peligroso} no debe anunciarse nunca`);
      }
    });

    it('no se exponen cabeceras de respuesta al JavaScript del frontend', async () => {
      // El cliente lee la paginación del cuerpo JSON, no de cabeceras, así que no hay nada que
      // exponer. Si algún día hiciera falta, que sea una decisión explícita y no un comodín.
      const expuestas = (await pedir(`${base}/public/settings`, { origin: LEGITIMO })).head('access-control-expose-headers');
      assert.ok(expuestas === null || !expuestas.includes('*'), 'exponer con comodín sería excesivo');
    });
  });

  /* ============================================ cabeceras de Helmet */
  describe('cabeceras de seguridad', () => {
    it('la respuesta trae el conjunto esperado', async () => {
      const r = await pedir(`${base}/health`, { origin: LEGITIMO });

      assert.equal(r.head('x-content-type-options'), 'nosniff', 'sin nosniff el navegador adivina el tipo');
      assert.match(String(r.head('x-frame-options')), /DENY|SAMEORIGIN/, 'protección contra clickjacking');
      assert.ok(r.head('referrer-policy'), 'debe fijarse una política de referente');
      assert.equal(r.head('cross-origin-opener-policy'), 'same-origin');
      assert.ok(r.head('content-security-policy'), 'la API declara su propia CSP');
      assert.ok(r.head('strict-transport-security'), 'HSTS presente');
    });

    it('la CSP cierra las vías clásicas de inyección', async () => {
      const csp = String((await pedir(`${base}/health`)).head('content-security-policy'));

      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /object-src 'none'/, 'sin object-src none quedarían embeds y applets');
      assert.match(csp, /base-uri 'self'/, 'base-uri abierto permite secuestrar rutas relativas');
      assert.match(csp, /frame-ancestors/, 'frame-ancestors es la defensa moderna contra el clickjacking');
      assert.ok(!/script-src[^;]*'unsafe-eval'/.test(csp), 'unsafe-eval no debe aparecer');
    });

    it('no se anuncia la tecnología del servidor', async () => {
      const r = await pedir(`${base}/health`);
      assert.equal(r.head('x-powered-by'), null, 'X-Powered-By: Express regala información del stack');
      assert.equal(r.head('server'), null);
    });
  });

  /* ============================================ recursos públicos cross-origin */
  describe('recursos públicos servidos a otro origen', () => {
    /**
     * Helmet pone `Cross-Origin-Resource-Policy: same-origin` por defecto, y el frontend vive en
     * otro origen que la API: sin excepción explícita el navegador bloquea cada imagen con
     * `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`. F17C-CLEAN-01 lo corrigió; aquí se vigila que un
     * endurecimiento posterior no lo reintroduzca.
     */
    it('el favicon sin configurar responde 204 con CORP cross-origin', async () => {
      const r = await fetch(`${base}/public/branding/favicon`, { headers: { Origin: LEGITIMO } });

      assert.equal(r.status, 204, 'un 404 saldría por el manejador de errores, que no pone CORP');
      assert.equal(r.headers.get('cross-origin-resource-policy'), 'cross-origin');
    });

    it('el logotipo de una empresa se sirve con CORP cross-origin y sin adivinar el tipo', async () => {
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'logo.png');
      const subida = await fetch(`${base}/company/logo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.sessions.companyAdmin.token}` },
        body: form,
      });
      assert.equal(subida.status, 200, 'la subida debe funcionar para poder comprobar cómo se sirve');
      const referencia = ((await subida.json()) as { data: { logo_url: string } }).data.logo_url;

      const servido = await fetch(`${base}/public/media/${referencia}`, { headers: { Origin: LEGITIMO } });

      assert.equal(servido.status, 200);
      assert.equal(servido.headers.get('cross-origin-resource-policy'), 'cross-origin');
      assert.equal(servido.headers.get('x-content-type-options'), 'nosniff');
      assert.match(String(servido.headers.get('content-security-policy')), /sandbox/, 'una imagen subida se sirve aislada');
    });
  });

  /* ============================================ clientes que no son navegadores */
  describe('CORS no es control de acceso', () => {
    it('el webhook de Culqi no depende de ningún Origin', async () => {
      // Culqi llama de servidor a servidor: no hay Origin. La respuesta debe ser idéntica con y sin
      // él, porque quien autentica es el secreto de la ruta, no la cabecera del navegador.
      const cuerpo = JSON.stringify({ type: 'charge.succeeded', data: { id: 'chr_x', object: 'charge' } });
      const llamar = (headers: Record<string, string>) =>
        fetch(`${base}/culqi/webhook/secreto-que-no-es-el-bueno-0000`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: cuerpo });

      const sinOrigin = await llamar({});
      const conOrigin = await llamar({ Origin: 'https://attacker.example' });

      assert.equal(sinOrigin.status, conOrigin.status, 'el Origin no puede cambiar el resultado de un webhook');
      assert.ok(sinOrigin.status === 404 || sinOrigin.status === 401 || sinOrigin.status === 403,
        `un secreto incorrecto debe rechazarse (${sinOrigin.status})`);
    });

    it('un origen permitido no sustituye a la autenticación', async () => {
      const r = await pedir(`${base}/bookings`, { origin: LEGITIMO });
      assert.equal(r.status, 401, 'venir del frontend legítimo no es estar autenticado');
    });

    it('un origen permitido no sustituye a la autorización', async () => {
      // Desde el origen bueno y con un token real, el rol sigue mandando en las dos direcciones:
      // un CUSTOMER puede LEER `/users` —tiene `users.view`— pero el alcance lo reduce a su propia
      // ficha, y CREAR usuarios le está vedado.
      const lectura = await pedir(`${base}/users`, { origin: LEGITIMO, token: ctx.sessions.customer.token });
      assert.equal(lectura.status, 200);
      const filas = lectura.body.data as Array<{ id: number }>;
      assert.equal(filas.length, 1, 'un cliente solo puede verse a sí mismo');
      assert.equal(filas[0]?.id, ctx.sessions.customer.user.id);

      const creacion = await pedir(`${base}/users`, {
        method: 'POST',
        origin: LEGITIMO,
        token: ctx.sessions.customer.token,
        headers: { 'Content-Type': 'application/json' },
      });
      assert.ok(creacion.status === 403 || creacion.status === 401,
        `crear usuarios exige permiso, venga del origen que venga (${creacion.status})`);
    });

    it('un origen NO permitido con un token válido recibe su respuesta, y eso es correcto', async () => {
      // No es un fallo: CORS lo aplica el navegador sobre la respuesta, no el servidor sobre la
      // petición. Un cliente que no sea navegador ignora CORS por completo. Se deja escrito para
      // que nadie llegue a creer que un Origin no permitido protege un endpoint.
      const r = await pedir(`${base}/bookings`, { origin: 'https://attacker.example', token: ctx.sessions.customer.token });

      assert.equal(r.status, 200);
      assert.equal(r.head('access-control-allow-origin'), LEGITIMO, 'pero el navegador del atacante descartará la respuesta');
    });

    it('la API de integración sigue exigiendo su clave, venga el Origin que venga', async () => {
      for (const origin of [LEGITIMO, 'https://attacker.example']) {
        const r = await pedir(`${base}/integration/v1/trips`, { origin });
        assert.ok(r.status === 401 || r.status === 403, `sin clave de API debe rechazarse (${origin} → ${r.status})`);
      }
      const conTokenDeSesion = await pedir(`${base}/integration/v1/trips`, { origin: LEGITIMO, token: ctx.sessions.admin.token });
      assert.ok(conTokenDeSesion.status === 401 || conTokenDeSesion.status === 403,
        'un JWT de sesión no puede reemplazar a la clave de API');
    });

    it('el límite de peticiones no se negocia por Origin', async () => {
      const r = await pedir(`${base}/public/settings`, { origin: 'https://attacker.example' });
      assert.ok(r.head('ratelimit') !== null || r.head('ratelimit-limit') !== null,
        'el contador se aplica igual a un cliente que no es navegador');
    });
  });

  /* ============================================ respuestas de error */
  describe('las respuestas de error no cuentan de más', () => {
    for (const [etiqueta, ruta, opciones] of [
      ['404', '/no-existe-esta-ruta', {}],
      ['401', '/bookings', {}],
      ['403/404 por rol', '/users', { token: '' }],
    ] as const) {
      it(`${etiqueta} no filtra rastro, rutas ni secretos`, async () => {
        const r = await pedir(`${base}${ruta}`, { origin: LEGITIMO, ...(opciones as object) });
        const texto = JSON.stringify(r.body);

        assert.ok(!/at \w+ \(/.test(texto), 'no debe aparecer una traza de pila');
        assert.ok(!/[A-Za-z]:\\\\|\/home\/|node_modules/.test(texto), 'no deben aparecer rutas del sistema de archivos');
        assert.ok(!/password|secret|JWT_SECRET|DB_PASSWORD/i.test(texto), 'no debe aparecer ninguna credencial');
        assert.equal(r.head('x-content-type-options'), 'nosniff', 'también los errores llevan las cabeceras');
      });
    }
  });
});
