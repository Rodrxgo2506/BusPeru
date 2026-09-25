import { resolveApiUrl } from '@/config/api-url';
import { isCacheablePath, ResponseCache } from '@/services/response-cache';
import type { Pagination } from '@/types';

// F15-02: el backend local solo es el fallback EN DESARROLLO. Vite sustituye `import.meta.env.DEV`
// por `false` al construir, así que el literal desaparece del bundle; la build exige VITE_API_URL.
const BASE_URL = resolveApiUrl(import.meta.env.VITE_API_URL, import.meta.env.DEV ? 'http://localhost:3000/api' : null);

/** Base de la API, para flujos que necesitan NAVEGAR (OAuth) en lugar de hacer fetch. */
export const API_BASE_URL = BASE_URL;

/**
 * URL de una imagen pública del almacén (FASE 17). La base guarda REFERENCIAS (`public/...`), no
 * URLs: así la API decide dónde viven los archivos y cambiar de almacén no toca el contenido.
 */
export function mediaUrl(reference: string | null | undefined): string | null {
  if (!reference || !/^public\/[\w/-]+\.(?:jpg|jpeg|png|webp|ico)$/.test(reference)) return null;
  return `${BASE_URL}/public/media/${reference}`;
}

const TOKEN_KEY = 'busperu.token';

export class ApiError extends Error {
  readonly status: number;
  readonly fields?: Record<string, string>;
  /** F18-11B: la petición la canceló la app (la página que la pidió ya no está). No es un error. */
  readonly aborted: boolean;

  constructor(status: number, message: string, fields?: Record<string, string>, aborted = false) {
    super(message);
    this.status = status;
    this.fields = fields;
    this.aborted = aborted;
  }

  get isNetworkError() {
    return this.status === 0 && !this.aborted;
  }
  get isUnauthorized() {
    return this.status === 401;
  }
  get isForbidden() {
    return this.status === 403;
  }
}

/* ------------------------------------------------------------------------------------------------
 * F18-11B · caché de lecturas y cancelación de peticiones abandonadas.
 *
 * Caché: ver `response-cache.ts` (memoria, clave con el token, TTL corto, invalidación total ante
 * cualquier escritura o cambio de sesión). Solo se activa mientras el panel ADMIN está montado
 * (`setResponseCacheEnabled`), así que el resto de portales se comporta exactamente como antes.
 *
 * Cancelación: `useAsync`/`useList` ejecutan su cargador dentro de `withRequestScope`; las GET
 * que ese cargador lanza de forma síncrona heredan la señal y se cancelan si la página se desmonta
 * o vuelve a cargar. Nunca se cancelan escrituras.
 *
 * F18-16 · stale-while-revalidate. Un dato es FRESCO 30 s (se usa sin preguntar a la API) y se
 * puede MOSTRAR hasta 10 min mientras la pantalla lo revalida en segundo plano. Antes la caché era
 * «fresco o nada»: pasados 30 s cada sección volvía a vaciarse, enseñaba el esqueleto y esperaba a
 * la red, que es justo lo que se percibía como lentitud. Las reglas de seguridad no cambian: clave
 * con el token, solo lecturas permitidas, y cualquier escritura, login, logout o 401 lo vacía todo.
 * ---------------------------------------------------------------------------------------------- */
const READ_CACHE_FRESH_MS = 30_000;
const READ_CACHE_MAX_AGE_MS = 10 * 60_000;
const readCache = new ResponseCache(READ_CACHE_FRESH_MS, () => Date.now(), READ_CACHE_MAX_AGE_MS);
let readCacheEnabled = false;

/**
 * Cómo usa la caché una lectura:
 *   · `default`: dato fresco si lo hay; si no, a la API (y se guarda la respuesta).
 *   · `cache-only`: dato fresco O viejo, y si no hay ninguno falla con `CacheMissError` SIN ir a la
 *     red. Lo usan los hooks para pintar al instante lo que ya se conoce.
 *   · `network`: siempre a la API (revalidación o recarga explícita), y se guarda la respuesta.
 */
export type CachePolicy = 'default' | 'cache-only' | 'network';

interface RequestScope {
  signal?: AbortSignal;
  policy?: CachePolicy;
  /** Se llama por cada lectura servida desde la caché, indicando si el dato era fresco. */
  onCacheRead?: (fresh: boolean) => void;
}

let currentScope: RequestScope | undefined;

/** Peticiones en curso compartibles (precargas): una pantalla que pide lo mismo se une a ellas. */
const inflight = new Map<string, Promise<{ data: unknown; pagination?: Pagination }>>();
/**
 * Lecturas en curso de las PANTALLAS (tienen dueño que las cancela). Solo una precarga se une a
 * ellas: una pantalla nunca espera a la petición de otra, porque si esa se cancela se quedaría sin datos.
 */
const inflightForeground = new Map<string, Promise<{ data: unknown; pagination?: Pagination }>>();
/** Momento de la última lectura lanzada por una pantalla: la precarga cede el paso mientras se navega. */
let lastForegroundAt = 0;

export function msSinceForegroundRequest(): number {
  return Date.now() - lastForegroundAt;
}

/** Lecturas de pantallas todavía en vuelo (la precarga no arranca mientras haya alguna). */
export function foregroundRequestsInFlight(): number {
  return inflightForeground.size;
}

/** Invalida TODO lo leído: la caché y las precargas en curso (su resultado ya no es de fiar). */
function invalidateReads(): void {
  readCache.clear();
  inflight.clear();
  inflightForeground.clear();
}

export class CacheMissError extends Error {
  constructor() {
    super('Sin datos en caché.');
    this.name = 'CacheMissError';
  }
}

export function isCacheMiss(error: unknown): boolean {
  return error instanceof CacheMissError;
}

export function setResponseCacheEnabled(enabled: boolean): void {
  readCacheEnabled = enabled;
  if (!enabled) invalidateReads();
}

export function isResponseCacheEnabled(): boolean {
  return readCacheEnabled;
}

export function clearResponseCache(): void {
  invalidateReads();
}

/** Ejecuta `run` de forma que las GET que lance síncronamente usen el ámbito indicado. */
export function withRequestScope<T>(scope: RequestScope, run: () => T): T {
  const previous = currentScope;
  currentScope = scope;
  try {
    return run();
  } finally {
    currentScope = previous;
  }
}

/** Ejecuta `run` de forma que las GET que lance síncronamente usen `signal`. */
export function withRequestSignal<T>(signal: AbortSignal, run: () => T): T {
  return withRequestScope({ signal }, run);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof ApiError && error.aborted;
}

const abortedError = () => new ApiError(0, 'Petición cancelada.', undefined, true);

/** Espera `promise`, pero se rinde en cuanto `signal` se cancela (la petición compartida sigue). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export const tokenStorage = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => {
    invalidateReads();
    localStorage.setItem(TOKEN_KEY, token);
  },
  clear: () => {
    invalidateReads();
    localStorage.removeItem(TOKEN_KEY);
  },
};

type SessionExpiredHandler = () => void;
let onSessionExpired: SessionExpiredHandler | null = null;

export function setSessionExpiredHandler(handler: SessionExpiredHandler): void {
  onSessionExpired = handler;
}

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

function buildUrl(path: string, params?: QueryParams): string {
  const url = new URL(`${BASE_URL}${path}`, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Un `FormData` viaja tal cual (subida de archivos); cualquier otro cuerpo se serializa como JSON. */
  body?: unknown;
  params?: QueryParams;
  signal?: AbortSignal;
}

/**
 * Single entry point for every HTTP call: attaches the token, unwraps the
 * { success, data } envelope and turns any failure into an ApiError.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<{ data: T; pagination?: Pagination }> {
  const method = options.method ?? 'GET';
  // Leído de forma síncrona, antes del primer `await`: así se hereda el ámbito de `withRequestScope`.
  const scope = method === 'GET' ? currentScope : undefined;
  const signal = options.signal ?? scope?.signal;
  if (method !== 'GET') invalidateReads();
  try {
    return await send<T>(path, options, method, signal, scope);
  } finally {
    // Una escritura (haya salido bien o mal) invalida también lo que se leyó mientras viajaba.
    if (method !== 'GET') invalidateReads();
  }
}

async function send<T>(
  path: string,
  options: RequestOptions,
  method: NonNullable<RequestOptions['method']>,
  signal: AbortSignal | undefined,
  scope: RequestScope | undefined,
): Promise<{ data: T; pagination?: Pagination }> {
  const policy = scope?.policy ?? 'default';
  const token = tokenStorage.get();
  const url = buildUrl(path, options.params);
  const cacheKey = method === 'GET' && readCacheEnabled && token && isCacheablePath(path) ? ResponseCache.key(token, url) : null;
  const generation = readCache.generation;
  if (cacheKey && policy !== 'network') {
    const hit = readCache.peek(cacheKey);
    if (hit && (hit.fresh || policy === 'cache-only')) {
      scope?.onCacheRead?.(hit.fresh);
      return hit.value as { data: T; pagination?: Pagination };
    }
    // Una precarga de esta misma lectura ya está en camino: se espera a ella en lugar de repetirla.
    // Y una precarga (sin dueño) también se une a la lectura que ya esté haciendo una pantalla.
    const shared = inflight.get(cacheKey) ?? (signal ? undefined : inflightForeground.get(cacheKey));
    if (shared && policy !== 'cache-only') {
      const result = await untilAborted(shared, signal);
      return structuredClone(result) as { data: T; pagination?: Pagination };
    }
  }
  if (policy === 'cache-only') throw new CacheMissError();
  if (cacheKey && signal) {
    lastForegroundAt = Date.now();
    const own = fetchAndStore<T>(url, options, method, signal, token, cacheKey, generation);
    inflightForeground.set(cacheKey, own as Promise<{ data: unknown; pagination?: Pagination }>);
    try {
      return await own;
    } finally {
      if (inflightForeground.get(cacheKey) === (own as Promise<unknown>)) inflightForeground.delete(cacheKey);
    }
  }
  if (cacheKey && !signal) {
    // Lectura sin dueño que la cancele (precarga): otras pantallas pueden unirse a ella.
    const own = fetchAndStore<T>(url, options, method, signal, token, cacheKey, generation);
    inflight.set(cacheKey, own as Promise<{ data: unknown; pagination?: Pagination }>);
    try {
      return await own;
    } finally {
      if (inflight.get(cacheKey) === (own as Promise<unknown>)) inflight.delete(cacheKey);
    }
  }
  return fetchAndStore<T>(url, options, method, signal, token, cacheKey, generation);
}

async function fetchAndStore<T>(
  url: string,
  options: RequestOptions,
  method: NonNullable<RequestOptions['method']>,
  signal: AbortSignal | undefined,
  token: string | null,
  cacheKey: string | null,
  generation: number,
): Promise<{ data: T; pagination?: Pagination }> {

  const isForm = options.body instanceof FormData;
  const headers: Record<string, string> = { Accept: 'application/json' };
  // Con `FormData` el navegador escribe el Content-Type con su boundary: fijarlo lo rompería.
  if (options.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : isForm ? (options.body as FormData) : JSON.stringify(options.body),
      signal,
    });
  } catch {
    if (signal?.aborted) throw abortedError();
    throw new ApiError(0, 'No pudimos conectarnos con el servidor. Revisa tu conexión e inténtalo de nuevo.');
  }

  if (response.status === 204) return { data: undefined as T };

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Cancelada a mitad del cuerpo: no es una respuesta vacía, es una petición abandonada.
    if (signal?.aborted) throw abortedError();
    payload = null;
  }

  const body = (payload ?? {}) as {
    success?: boolean;
    data?: T;
    message?: string;
    errors?: Record<string, string>;
    pagination?: Pagination;
  };

  if (!response.ok || body.success === false) {
    if (response.status === 401) {
      tokenStorage.clear();
      onSessionExpired?.();
    }
    throw new ApiError(response.status, body.message ?? 'Ocurrió un error inesperado.', body.errors);
  }

  const result = { data: body.data as T, pagination: body.pagination };
  // Solo respuestas correctas, de la misma sesión y sin escrituras ni cambios de sesión por medio.
  if (cacheKey && tokenStorage.get() === token) readCache.set(cacheKey, result, generation);
  return result;
}

export const api = {
  get: <T>(path: string, params?: QueryParams, signal?: AbortSignal) => request<T>(path, { params, signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  /** El editor de distribución envía cambios parciales; PUT exigiría reenviar todo. */
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  /** Subida de archivos. El cuerpo debe ser un `FormData`. */
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
};

/**
 * Descarga un archivo protegido por sesión. La API nunca expone URLs públicas, así que el
 * navegador no puede pedirlo directamente: hay que adjuntar el token y trabajar con el Blob.
 */
export async function apiBlob(path: string): Promise<Blob> {
  const token = tokenStorage.get();

  let response: Response;
  try {
    response = await fetch(buildUrl(path), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ApiError(0, 'No pudimos conectarnos con el servidor. Revisa tu conexión e inténtalo de nuevo.');
  }

  if (!response.ok) {
    if (response.status === 401) {
      tokenStorage.clear();
      onSessionExpired?.();
    }
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(response.status, body?.message ?? 'No pudimos obtener el archivo.');
  }

  return response.blob();
}

/** Convenience wrapper for endpoints that return a plain payload without pagination. */
export async function apiData<T>(promise: Promise<{ data: T }>): Promise<T> {
  return (await promise).data;
}
