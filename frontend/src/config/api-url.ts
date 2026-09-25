/**
 * URL de la API (auditoría pre-producción, hallazgo F15-02).
 *
 * Antes `api.ts` hacía `VITE_API_URL ?? 'http://localhost:3000/api'`: una build de producción sin
 * la variable se publicaba apuntando a localhost, y el literal quedaba dentro del bundle.
 *
 *   · En DESARROLLO (`vite`), sin variable se sigue usando el backend local.
 *   · En una BUILD (`vite build`, salvo `--mode development`), `vite.config.ts` llama a
 *     `assertBuildApiUrl` y la build FALLA si falta la variable o apunta a una máquina local.
 *   · En ejecución, `resolveApiUrl` nunca inventa una URL fuera de desarrollo: el fallback local
 *     solo se le pasa bajo `import.meta.env.DEV`, que Vite sustituye por `false` en la build, así
 *     que el literal de localhost ni siquiera llega al bundle de producción.
 *
 * Este módulo no importa nada ni usa `import.meta`, para poder probarlo con `node --test`.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * Motivo por el que un valor NO sirve como VITE_API_URL de una build publicable, o `null` si sirve.
 * Se admite una URL https pública o una ruta absoluta del mismo origen (`/api`, detrás de un proxy).
 */
export function buildApiUrlProblem(value: string | undefined): string | null {
  const url = (value ?? '').trim();
  if (url === '') {
    return 'VITE_API_URL es obligatoria para construir el frontend: define la URL pública de la API (https://…/api) o una ruta del mismo origen (/api).';
  }
  if (url.startsWith('/') && !url.startsWith('//')) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'VITE_API_URL no es una URL válida: usa https://…/api o una ruta del mismo origen (/api).';
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost')) {
    return 'VITE_API_URL apunta a una máquina local: una build publicable no puede usar localhost como API.';
  }
  if (parsed.protocol !== 'https:') {
    return 'VITE_API_URL debe usar https en una build publicable.';
  }
  return null;
}

/** Lo que llama `vite.config.ts`. Solo valida `vite build`; el servidor de desarrollo no cambia. */
export function assertBuildApiUrl(command: 'build' | 'serve', mode: string, value: string | undefined): void {
  if (command !== 'build' || mode === 'development') return;
  const problem = buildApiUrlProblem(value);
  if (problem !== null) throw new Error(problem);
}

/**
 * Base de la API en ejecución. `devFallback` solo debe llegar con valor en desarrollo
 * (`import.meta.env.DEV ? '…' : null`); sin variable y sin fallback es un error de configuración.
 */
export function resolveApiUrl(value: string | undefined, devFallback: string | null): string {
  const url = (value ?? '').trim();
  if (url !== '') return url.replace(/\/+$/, '');
  if (devFallback !== null) return devFallback;
  throw new Error('VITE_API_URL no está definida en esta build.');
}
