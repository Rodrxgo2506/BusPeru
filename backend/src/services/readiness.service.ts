import fs from 'fs';
import { pool } from '../config/database';
import { logError } from '../utils/logger';
import { storageRoot } from './file-storage.service';

/**
 * ¿Puede esta instancia atender tráfico ahora mismo? (F18-02)
 *
 * Es la comprobación de *readiness*, distinta de `GET /api/health`, que es solo *liveness*: dice que
 * el proceso responde y nada más. Aquí se mira lo que la aplicación necesita para funcionar:
 *
 *   · la base de datos: un `SELECT 1` por el pool normal, con un tiempo máximo corto. Si el pool no
 *     consigue conexión o la base no contesta, la instancia no está lista;
 *   · el almacenamiento: que `STORAGE_DIR` exista, sea un directorio y el proceso pueda leer, escribir
 *     y recorrerlo. Solo se comprueban permisos: no se escribe ningún archivo.
 *
 * Es barata a propósito, porque la llaman el balanceador y la monitorización cada pocos segundos: no
 * abre conexiones propias (usa el pool y devuelve la conexión al terminar) ni hace trabajo pesado.
 *
 * El detalle de lo que falló va SOLO al registro saneado. A quien pregunta se le devuelve un sí o un
 * no: ni el host de la base, ni su nombre, ni rutas del servidor, ni trazas.
 */

/** Tiempo máximo del `SELECT 1`. Un balanceador no puede quedarse esperando a una base colgada. */
export const READINESS_DB_TIMEOUT_MS = 2_000;

export type ReadinessCheck = 'database' | 'storage';

export interface ReadinessResult {
  ready: boolean;
  /** Qué comprobaciones fallaron. Para el registro y las pruebas; no se envía al cliente. */
  failed: ReadinessCheck[];
}

async function databaseReady(): Promise<boolean> {
  try {
    await pool.query({ sql: 'SELECT 1', timeout: READINESS_DB_TIMEOUT_MS });
    return true;
  } catch (error) {
    logError('Readiness: la base de datos no responde', error);
    return false;
  }
}

async function storageReady(): Promise<boolean> {
  try {
    const root = storageRoot();
    const info = await fs.promises.stat(root);
    if (!info.isDirectory()) throw new Error('STORAGE_DIR no es un directorio');
    // Solo permisos: el proceso tiene que poder leer, escribir y entrar. No se crea nada.
    await fs.promises.access(root, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch (error) {
    logError('Readiness: el almacenamiento de archivos no está disponible', error);
    return false;
  }
}

export async function checkReadiness(): Promise<ReadinessResult> {
  const [database, storage] = await Promise.all([databaseReady(), storageReady()]);
  const failed: ReadinessCheck[] = [];
  if (!database) failed.push('database');
  if (!storage) failed.push('storage');
  return { ready: failed.length === 0, failed };
}
