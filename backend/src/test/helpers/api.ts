import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../../app';
import { pool } from '../../config/database';

export interface ApiResponse<T = any> {
  status: number;
  body: { success?: boolean; data?: T; message?: string; errors?: Record<string, string>; pagination?: any };
}

let server: Server | null = null;
let baseUrl = '';

/** Levanta la app en un puerto efímero: sin servidor externo ni puertos fijos. */
export async function startTestServer(): Promise<string> {
  if (server) return baseUrl;
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, '127.0.0.1', resolve);
  });
  const address = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/api`;
  return baseUrl;
}

export async function stopTestServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = null;
  }
  await pool.end().catch(() => undefined);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string;
}

export async function api<T = any>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const response = await fetch(baseUrl + path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  let body: ApiResponse<T>['body'] = {};
  try {
    body = (await response.json()) as ApiResponse<T>['body'];
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

export const get = <T = any>(path: string, token?: string) => api<T>(path, { token });
export const post = <T = any>(path: string, body?: unknown, token?: string) => api<T>(path, { method: 'POST', body, token });
export const put = <T = any>(path: string, body?: unknown, token?: string) => api<T>(path, { method: 'PUT', body, token });
export const del = <T = any>(path: string, token?: string) => api<T>(path, { method: 'DELETE', token });

/** URL base del servidor de pruebas, para peticiones que no son JSON (multipart). */
export const testBaseUrl = (): string => baseUrl;
