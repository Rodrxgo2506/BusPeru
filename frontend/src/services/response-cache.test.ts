import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCacheablePath, ResponseCache } from './response-cache.ts';

describe('ResponseCache (F18-11B)', () => {
  it('devuelve lo guardado dentro del TTL y lo olvida al vencer', () => {
    let t = 1000;
    const cache = new ResponseCache(30_000, () => t);
    const key = ResponseCache.key('token-a', 'https://api.example/api/companies?page=1');
    cache.set(key, { data: [{ id: 1 }] });
    assert.deepEqual(cache.get(key), { data: [{ id: 1 }] });
    t += 29_999;
    assert.ok(cache.get(key));
    t += 1;
    assert.equal(cache.get(key), null);
    assert.equal(cache.size, 0);
  });

  it('dos sesiones distintas nunca comparten entrada, aunque la URL sea la misma', () => {
    const cache = new ResponseCache(30_000);
    const url = 'https://api.example/api/companies?page=1';
    cache.set(ResponseCache.key('token-admin', url), { data: ['empresa-a', 'empresa-b'] });
    assert.equal(cache.get(ResponseCache.key('token-company-admin', url)), null);
  });

  it('entrega copias: modificar el resultado no altera lo guardado', () => {
    const cache = new ResponseCache(30_000);
    const key = ResponseCache.key('t', 'u');
    cache.set(key, { data: [{ id: 1, name: 'A' }] });
    const first = cache.get(key) as { data: Array<{ id: number; name: string }> };
    first.data[0].name = 'MODIFICADO';
    first.data.push({ id: 2, name: 'B' });
    assert.deepEqual(cache.get(key), { data: [{ id: 1, name: 'A' }] });
  });

  it('descarta una lectura que empezó antes de una invalidación (escritura o cambio de sesión)', () => {
    const cache = new ResponseCache(30_000);
    const key = ResponseCache.key('t', 'https://api.example/api/companies');
    const startedAt = cache.generation;
    cache.clear(); // p. ej. un PUT /companies/5 terminó mientras la GET viajaba
    assert.equal(cache.set(key, { data: ['dato previo a la escritura'] }, startedAt), false);
    assert.equal(cache.get(key), null);
    assert.equal(cache.set(key, { data: ['dato fresco'] }, cache.generation), true);
    assert.deepEqual(cache.get(key), { data: ['dato fresco'] });
  });

  it('clear vacía todas las entradas', () => {
    const cache = new ResponseCache(30_000);
    cache.set(ResponseCache.key('t', 'a'), { data: 1 });
    cache.set(ResponseCache.key('t', 'b'), { data: 2 });
    cache.clear();
    assert.equal(cache.size, 0);
  });

  it('solo permite rutas de listados y catálogos del panel', () => {
    for (const ok of ['/companies', '/companies/5', '/users', '/users/stats', '/roles', '/trips', '/routes', '/buses', '/bookings', '/payments/summary', '/destinations', '/locations', '/system-settings', '/dashboard/admin', '/bus-types', '/seat-types']) {
      assert.ok(isCacheablePath(ok), ok);
    }
    for (const no of ['/auth/me', '/notifications/unread-count', '/api-keys', '/audit-logs', '/admin/integrations', '/company/bank-accounts', '/company/drivers', '/dashboard/company', '/public/branding', '/companiesx', '/users-export']) {
      assert.ok(!isCacheablePath(no), no);
    }
  });
});
