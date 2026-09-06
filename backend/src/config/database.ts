import mysql from 'mysql2/promise';
import { env } from './env';

export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  database: env.db.name,
  user: env.db.user,
  password: env.db.password,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
  timezone: 'Z',
  charset: 'utf8mb4_unicode_ci',
  decimalNumbers: true,
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
