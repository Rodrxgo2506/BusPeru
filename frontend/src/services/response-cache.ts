/**
 * Caché de lecturas de la API en MEMORIA (F18-11B).
 *
 * Por qué: cada sección del panel ADMIN volvía a pedir sus datos al montarse y cada petición
 * pagaba el viaje Lima → CloudFront → ALB (≈ 100–180 ms). Volver a una sección visitada hace
 * unos segundos repetía exactamente las mismas lecturas.
 *
 * Reglas de seguridad (no negociables):
 *   · Solo en memoria de la pestaña: nada va a localStorage/sessionStorage.
 *   · La clave incluye el TOKEN de la sesión: dos sesiones (otro usuario, otro rol, otra
 *     empresa) nunca comparten una entrada, ni siquiera entre pestañas del mismo navegador.
 *   · Solo lecturas GET de rutas explícitamente permitidas y solo respuestas correctas.
 *   · Cualquier mutación (POST/PUT/PATCH/DELETE), el inicio o cierre de sesión y un 401 vacían
 *     la caché ENTERA: la invalidación es deliberadamente gruesa para no depender de adivinar
 *     qué listados afecta cada escritura.
 *   · Se devuelven copias (`structuredClone`): una página que modifique su array no altera la
 *     copia guardada.
 *
 * Este módulo no importa nada ni usa `import.meta`, para poder probarlo con `node --test`.
 */

export interface CachedResponse {
  data: unknown;
  pagination?: unknown;
}

/** Resultado de `peek`: el dato guardado y si todavía está dentro de su ventana de frescura. */
export interface CacheLookup {
  value: CachedResponse;
  fresh: boolean;
}

export class ResponseCache {
  private readonly entries = new Map<string, { at: number; value: CachedResponse }>();
  /**
   * Cambia con cada `clear()`. Una lectura que salió ANTES de una escritura o de un cambio de
   * sesión puede traer datos previos a ese cambio: `set` la descarta si la generación ya no es la
   * misma que cuando empezó.
   */
  private currentGeneration = 0;

  get generation(): number {
    return this.currentGeneration;
  }

  private readonly ttlMs: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  /**
   * F18-16 · stale-while-revalidate. `ttlMs` es la ventana de FRESCURA: dentro de ella el dato se
   * usa sin preguntar a la API. Entre `ttlMs` y `maxAgeMs` el dato está VIEJO: se puede mostrar al
   * instante (`peek`) mientras la pantalla lo revalida en segundo plano, pero `get` ya no lo
   * devuelve. Pasado `maxAgeMs` se descarta. Por omisión `maxAgeMs = ttlMs` (sin datos viejos).
   */
  // Sin «parameter properties»: `node --test` ejecuta este archivo sin transpilar (strip-only).
  constructor(ttlMs: number, now: () => number = () => Date.now(), maxAgeMs: number = ttlMs) {
    this.ttlMs = ttlMs;
    this.maxAgeMs = Math.max(maxAgeMs, ttlMs);
    this.now = now;
  }

  static key(token: string, url: string): string {
    return `${token}\n${url}`;
  }

  /** Solo datos frescos. */
  get(key: string): CachedResponse | null {
    const hit = this.peek(key);
    return hit && hit.fresh ? hit.value : null;
  }

  /** Datos frescos o viejos (hasta `maxAgeMs`), indicando cuál de los dos es. */
  peek(key: string): CacheLookup | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    const age = this.now() - hit.at;
    if (age >= this.maxAgeMs) {
      this.entries.delete(key);
      return null;
    }
    return { value: structuredClone(hit.value), fresh: age < this.ttlMs };
  }

  /** Guarda solo si no hubo ninguna invalidación desde `startedAt` (la generación al empezar). */
  set(key: string, value: CachedResponse, startedAt: number = this.currentGeneration): boolean {
    if (startedAt !== this.currentGeneration) return false;
    this.entries.set(key, { at: this.now(), value: structuredClone(value) });
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.currentGeneration += 1;
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Rutas cuyas lecturas pueden cachearse: listados y catálogos del panel ADMIN. Quedan fuera,
 * entre otras, `/auth/*`, `/notifications/*`, `/api-keys`, `/audit-logs`, integraciones y
 * cuentas bancarias.
 */
export const CACHEABLE_PATH =
  /^\/(?:dashboard\/admin|companies|users|roles|trips|routes|buses|bus-types|seat-types|locations|bookings|payments|destinations|system-settings)(?:[/?]|$)/;

export function isCacheablePath(path: string): boolean {
  return CACHEABLE_PATH.test(path);
}
