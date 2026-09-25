import './helpers/testEnv';
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import { applyKeepAlive, CORS_PREFLIGHT_MAX_AGE_SECONDS, HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS } from '../config/http-server';

/**
 * F18-11B · ajustes HTTP de la cadena CloudFront → ALB → Node.
 * El ALB de staging mantiene conexiones 60 s: Node debe esperar más (si no, 502 esporádicos al
 * reutilizar un socket que Node ya cerró) y `headersTimeout` debe superar a `keepAliveTimeout`.
 */
describe('F18-11B · keep-alive y caché del preflight', () => {
  it('Node mantiene las conexiones más que el idle timeout del ALB (60 s)', () => {
    const server = applyKeepAlive(http.createServer());
    assert.equal(server.keepAliveTimeout, KEEP_ALIVE_TIMEOUT_MS);
    assert.ok(server.keepAliveTimeout > 60_000);
    assert.ok(server.headersTimeout > server.keepAliveTimeout);
    assert.equal(server.headersTimeout, HEADERS_TIMEOUT_MS);
  });

  it('el preflight se recuerda como mucho 2 h (el tope de Chromium)', () => {
    assert.equal(CORS_PREFLIGHT_MAX_AGE_SECONDS, 7200);
  });
});
