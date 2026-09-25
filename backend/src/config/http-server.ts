import type { Server } from 'http';

/**
 * Ajustes HTTP de la cadena CloudFront → ALB → Node (F18-11B).
 *
 * CORS: el navegador puede reutilizar un preflight durante `CORS_PREFLIGHT_MAX_AGE_SECONDS`.
 * Chromium no respeta más de 7200 s. Solo afecta a cuánto se recuerda la respuesta; qué origen,
 * métodos y cabeceras se admiten sigue igual.
 *
 * Keep-alive: el ALB reutiliza conexiones hacia Node hasta su `idle_timeout` (60 s por defecto).
 * Node las cerraba a los 5 s (su valor por defecto), así que el ALB podía enviar una petición por
 * un socket que Node acababa de cerrar (el origen clásico de 502 esporádicos) y abría conexiones
 * nuevas continuamente. Node debe esperar MÁS que el ALB: 65 s, y `headersTimeout` por encima.
 */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 7200;
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HEADERS_TIMEOUT_MS = 66_000;

export function applyKeepAlive(server: Server): Server {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}
