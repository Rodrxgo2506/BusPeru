import type { Pagination } from '@/types';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

/** Base de la API, para flujos que necesitan NAVEGAR (OAuth) en lugar de hacer fetch. */
export const API_BASE_URL = BASE_URL;
const TOKEN_KEY = 'busperu.token';

export class ApiError extends Error {
  readonly status: number;
  readonly fields?: Record<string, string>;

  constructor(status: number, message: string, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.fields = fields;
  }

  get isNetworkError() {
    return this.status === 0;
  }
  get isUnauthorized() {
    return this.status === 401;
  }
  get isForbidden() {
    return this.status === 403;
  }
}

export const tokenStorage = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
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
  const token = tokenStorage.get();
  const isForm = options.body instanceof FormData;
  const headers: Record<string, string> = { Accept: 'application/json' };
  // Con `FormData` el navegador escribe el Content-Type con su boundary: fijarlo lo rompería.
  if (options.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.params), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : isForm ? (options.body as FormData) : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch {
    throw new ApiError(0, 'No pudimos conectarnos con el servidor. Revisa tu conexión e inténtalo de nuevo.');
  }

  if (response.status === 204) return { data: undefined as T };

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
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

  return { data: body.data as T, pagination: body.pagination };
}

export const api = {
  get: <T>(path: string, params?: QueryParams, signal?: AbortSignal) => request<T>(path, { params, signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
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
