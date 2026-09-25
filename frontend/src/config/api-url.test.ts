import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertBuildApiUrl, buildApiUrlProblem, resolveApiUrl } from './api-url.ts';

/** F15-02 · la URL de la API nunca cae en localhost fuera de desarrollo. Se ejecuta con `npm test`. */
describe('F15-02 · VITE_API_URL', () => {
  it('una build publicable exige una URL https pública o una ruta del mismo origen', () => {
    for (const valida of ['https://api.busperu.example/api', 'https://api.busperu.example', '/api', '  https://api.busperu.example/api  ']) {
      assert.equal(buildApiUrlProblem(valida), null, valida);
    }
    for (const [valor, motivo] of [
      [undefined, /obligatoria/],
      ['', /obligatoria/],
      ['   ', /obligatoria/],
      ['http://localhost:3000/api', /máquina local/],
      ['https://localhost/api', /máquina local/],
      ['http://127.0.0.1:3000/api', /máquina local/],
      ['http://[::1]:3000/api', /máquina local/],
      ['https://api.localhost/api', /máquina local/],
      ['http://api.busperu.example/api', /https/],
      ['api.busperu.example/api', /no es una URL válida/],
      ['//api.busperu.example/api', /no es una URL válida/],
    ] as const) {
      assert.match(buildApiUrlProblem(valor) ?? '', motivo, String(valor));
    }
  });

  it('assertBuildApiUrl: solo bloquea `vite build`; `vite` y --mode development no cambian', () => {
    assert.doesNotThrow(() => assertBuildApiUrl('serve', 'development', undefined));
    assert.doesNotThrow(() => assertBuildApiUrl('serve', 'production', 'http://localhost:3000/api'));
    assert.doesNotThrow(() => assertBuildApiUrl('build', 'development', undefined));
    assert.throws(() => assertBuildApiUrl('build', 'production', undefined), /VITE_API_URL es obligatoria/);
    assert.throws(() => assertBuildApiUrl('build', 'production', 'http://localhost:3000/api'), /máquina local/);
    assert.throws(() => assertBuildApiUrl('build', 'staging', ''), /obligatoria/);
    assert.doesNotThrow(() => assertBuildApiUrl('build', 'production', 'https://api.busperu.example/api'));
  });

  it('resolveApiUrl: usa la variable, cae al fallback solo si se le da (desarrollo) y si no, falla', () => {
    assert.equal(resolveApiUrl('https://api.busperu.example/api/', null), 'https://api.busperu.example/api');
    assert.equal(resolveApiUrl('/api', null), '/api');
    assert.equal(resolveApiUrl(undefined, 'http://localhost:3000/api'), 'http://localhost:3000/api');
    assert.equal(resolveApiUrl('', 'http://localhost:3000/api'), 'http://localhost:3000/api');
    assert.throws(() => resolveApiUrl(undefined, null), /VITE_API_URL no está definida/);
    assert.throws(() => resolveApiUrl('  ', null), /VITE_API_URL no está definida/);
  });
});
