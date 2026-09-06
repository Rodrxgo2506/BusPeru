import type { PoolConnection as CallbackPoolConnection } from 'mysql2';
import mysql from 'mysql2/promise';
import { peruUtcOffset } from '../utils/businessTime';
import { env } from './env';

/**
 * Desfase de la zona operativa, resuelto desde `America/Lima` (auditoría BP-12).
 *
 * El conector no admite identificadores IANA, solo `Z`, `local` o un desfase, así que se
 * calcula una vez al arrancar a partir de la zona real. Perú no aplica horario de verano,
 * de modo que un único valor vale para todo el proceso.
 */
const PERU_OFFSET = peruUtcOffset();

export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  database: env.db.name,
  user: env.db.user,
  password: env.db.password,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  /** Las fechas llegan como texto: sin conversión al leer, el valor es el de la columna. */
  dateStrings: true,
  /**
   * Y al ESCRIBIR un objeto `Date` se serializa en hora de Perú, no en UTC.
   *
   * Antes decía `'Z'`, que es lo contrario de lo que hace el resto del sistema: un `Date`
   * pasado como parámetro se guardaba cinco horas por delante de todo lo que escribe
   * `NOW()`. Se podía comprobar insertando ambos en la misma fila: `20:19:55` frente a
   * `15:19:55`. Le ocurría a `users.email_verified_at` en el alta por OAuth.
   */
  timezone: PERU_OFFSET,
  charset: 'utf8mb4_unicode_ci',
  decimalNumbers: true,
});

/**
 * Fija la zona de cada sesión de MySQL en lugar de heredar la del sistema operativo.
 *
 * `@@time_zone` valía `SYSTEM`, así que `NOW()` dependía de cómo estuviera configurada la
 * máquina —aquí resultó ser `America/Bogota`, que coincide con Perú por casualidad, y en un
 * contenedor sería UTC—. Fijándola, `NOW()`, `DATE_ADD` y `TIMESTAMPDIFF` producen siempre
 * hora de Perú, que es lo que el negocio espera y lo que ya hay guardado.
 *
 * Se hace por CONEXIÓN, nunca tocando la configuración global del servidor, que es dato de
 * la instalación y puede estar compartida con otras bases.
 *
 * NOTA DE DESPLIEGUE: las columnas `TIMESTAMP` se convierten con esta zona al leer y al
 * escribir. Como la base ya venía operando en UTC-5, fijar el mismo desfase no mueve ningún
 * valor. Si algún día se restaura este esquema en un servidor que estuviera en UTC y con
 * datos escritos en UTC, habría que revisar esa conversión antes de arrancar.
 */
pool.on('connection', (connection) => {
  // El evento entrega la conexión de la API de callbacks, no la envoltura de promesas.
  const raw = connection as unknown as CallbackPoolConnection;
  raw.query(`SET time_zone = '${PERU_OFFSET}'`, (error: unknown) => {
    if (error) console.error('No se pudo fijar la zona horaria de la conexión:', error);
  });
});

export async function verifyConnection(): Promise<void> {
  const connection = await pool.getConnection();
  try {
    await connection.ping();
  } finally {
    connection.release();
  }
}

export type SqlParams = ReadonlyArray<unknown>;

export async function query<T = Record<string, unknown>>(sql: string, params: SqlParams = []): Promise<T[]> {
  const [rows] = await pool.query(sql, params as unknown[]);
  return rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(sql: string, params: SqlParams = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function execute(sql: string, params: SqlParams = []): Promise<mysql.ResultSetHeader> {
  const [result] = await pool.query(sql, params as unknown[]);
  return result as mysql.ResultSetHeader;
}

/** Runs `handler` inside a MySQL transaction, rolling back on any thrown error. */
export async function withTransaction<T>(handler: (connection: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    const result = await handler(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
