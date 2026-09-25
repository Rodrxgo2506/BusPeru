import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestServer, stopTestServer, testBaseUrl } from './helpers/api';

/**
 * F17C-SEC-03B · SEC03B-01 — un cuerpo ilegible es culpa del cliente, no del servidor.
 *
 * QUÉ PASABA. `express.json()` lanza su propio error cuando no puede leer el cuerpo —JSON mal
 * formado, un escalar donde se espera un objeto, más de 1 MB— y ese error ya trae su estado
 * (400, 413, 415). `mapError` no lo reconocía, caía en el `default` y salía un **500**: la API
 * se culpaba a sí misma de lo que había enviado mal el cliente, y `errorHandler` lo registraba
 * como fallo no controlado con su traza. Cualquiera podía llenar el diario de errores con un
 * `curl` SIN AUTENTICARSE, y una alerta de 5xx se disparaba por peticiones mal formadas.
 *
 * Las peticiones van con `fetch` en crudo, no con el ayudante `api()`: hace falta mandar un
 * cuerpo que NO es JSON válido, y el ayudante siempre serializa.
 */
describe('SEC03B-01 · cuerpos ilegibles', () => {
  let base = '';

  before(async () => {
    base = await startTestServer();
  });
  after(stopTestServer);

  const enviar = (ruta: string, cuerpo: string, cabeceras: Record<string, string> = {}) =>
    fetch(`${base}${ruta}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cabeceras },
      body: cuerpo,
    });

  /**
   * Se prueban rutas ANÓNIMAS a propósito: el fallo estaba antes de cualquier autenticación,
   * así que lo podía provocar un desconocido.
   */
  const RUTAS_ANONIMAS = ['/auth/login', '/public/itineraries/search', '/culqi/webhook/cualquiera'];

  describe('JSON sintácticamente inválido', () => {
    for (const ruta of RUTAS_ANONIMAS) {
      it(`${ruta} responde 400 y no 500`, async () => {
        const res = await enviar(ruta, '{"email":');
        assert.equal(res.status, 400, `${ruta} debería responder 400`);
        const cuerpo = (await res.json()) as { success: boolean; message: string; request_id?: string };
        assert.equal(cuerpo.success, false);
        assert.match(cuerpo.message, /JSON v[áa]lido/i);
        // `request_id` solo acompaña a los 5xx: si aparece, es que volvió a tratarse como fallo del servidor.
        assert.equal(cuerpo.request_id, undefined, 'un 400 no debe llevar identificador de incidencia');
      });
    }
  });

  describe('JSON válido pero que no es un objeto', () => {
    for (const [etiqueta, cuerpo] of [
      ['una cadena', '"soy una cadena"'],
      ['un número', '42'],
      ['un booleano', 'true'],
      ['null', 'null'],
    ] as const) {
      it(`${etiqueta} responde 400`, async () => {
        const res = await enviar('/auth/login', cuerpo);
        assert.equal(res.status, 400, `${etiqueta}: ${res.status}`);
        assert.match(((await res.json()) as { message: string }).message, /JSON v[áa]lido/i);
      });
    }
  });

  it('un cuerpo por encima del límite responde 413 y no 500', async () => {
    // El límite configurado en `createApp` es 1 MB.
    const enorme = JSON.stringify({ relleno: 'A'.repeat(1_200_000) });
    const res = await enviar('/auth/login', enorme);
    assert.equal(res.status, 413, `esperaba 413 y llegó ${res.status}`);
    assert.match(((await res.json()) as { message: string }).message, /demasiado grande/i);
  });

  it('una codificación no admitida responde 415 y no 500', async () => {
    const res = await enviar('/auth/login', '{"a":1}', { 'Content-Encoding': 'inventada' });
    assert.equal(res.status, 415, `esperaba 415 y llegó ${res.status}`);
  });

  it('el mensaje no refleja nada del cuerpo recibido', async () => {
    const secreto = 'SEC03B-VALOR-QUE-NO-DEBE-SALIR';
    const res = await enviar('/auth/login', `{"password": "${secreto}"`);
    const texto = await res.text();
    assert.equal(res.status, 400);
    assert.ok(!texto.includes(secreto), 'la respuesta no puede devolver lo que se envió');
  });

  it('un cuerpo bien formado sigue llegando a su ruta', async () => {
    // No se comprueba el resultado del login, solo que el analizador ya no se interpone:
    // cualquier respuesta distinta de 400 «JSON inválido» demuestra que el cuerpo se leyó.
    const res = await enviar('/auth/login', JSON.stringify({ email: 'no-existe@test.pe', password: 'ClaveCualquiera1' }));
    assert.equal(res.status, 401, 'un cuerpo válido debe llegar al manejador y ser rechazado por credenciales');
  });
});
