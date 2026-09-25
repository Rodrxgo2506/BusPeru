import fs from 'fs';
import mysql from 'mysql2/promise';
import path from 'path';

/**
 * Prepara la base de datos de pruebas.
 *
 * SEGURIDAD: solo opera sobre bases cuyo nombre termina en `_test`. Si por cualquier
 * motivo la configuración apuntara a la base real (`busperu`), aborta antes de tocar nada.
 * La suite nunca lee ni escribe en la base de desarrollo.
 */

export const TEST_DB_SUFFIX = '_test';

function assertIsTestDatabase(name: string): void {
  if (!name.endsWith(TEST_DB_SUFFIX)) {
    throw new Error(
      `ABORTADO: la base de pruebas debe terminar en "${TEST_DB_SUFFIX}" y se recibió "${name}". ` +
        'Nunca se ejecutan pruebas contra la base real.',
    );
  }
}

interface Connection {
  host: string;
  port: number;
  user: string;
  password: string;
}

function credentials(): Connection {
  return {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
  };
}

/**
 * Divide el dump en sentencias respetando cadenas y comentarios.
 * Se ignoran los comentarios ejecutables de MySQL para no depender de la versión.
 */
export function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.startsWith('--') && !line.startsWith('/*!') && line.trim() !== '')
    .join('\n');

  const statements: string[] = [];
  let current = '';
  let inString: string | null = null;
  let escaped = false;

  for (const char of withoutComments) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === inString) inString = null;
      current += char;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      inString = char;
      current += char;
      continue;
    }
    if (char === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      continue;
    }
    current += char;
  }

  const last = current.trim();
  if (last) statements.push(last);
  return statements;
}

/** Recrea la base de pruebas desde el dump original, sin modificarlo. */
export async function setupTestDatabase(databaseName: string): Promise<void> {
  assertIsTestDatabase(databaseName);

  const dumpPath = path.resolve(__dirname, '../../../../database/schema/Dump20260831.sql');
  if (!fs.existsSync(dumpPath)) {
    throw new Error(`No se encontró el dump del esquema en ${dumpPath}`);
  }

  const raw = fs.readFileSync(dumpPath, 'utf8');
  // Se descartan CREATE DATABASE / USE del dump: la base destino la fija la suite.
  const sql = raw
    .split('\n')
    .filter((line) => !/^\s*(CREATE DATABASE|USE)\b/i.test(line))
    .join('\n');

  const admin = await mysql.createConnection({ ...credentials(), multipleStatements: true });
  try {
    assertIsTestDatabase(databaseName);
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.query(`CREATE DATABASE \`${databaseName}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await admin.end();
  }

  const connection = await mysql.createConnection({ ...credentials(), database: databaseName });
  try {
    // F18-02 · modo SQL opcional (`TEST_SQL_MODE`) para validar dump y migraciones con el modo
    // estricto que tendrá la base de producción. Solo esta sesión: la configuración global del
    // servidor no se toca. Sin la variable, todo sigue exactamente igual.
    if (process.env.TEST_SQL_MODE) await connection.query('SET SESSION sql_mode = ?', [process.env.TEST_SQL_MODE]);
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const statement of splitStatements(sql)) {
      await connection.query(statement);
    }
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');

    // Migraciones aplicadas sobre el dump. La base de pruebas debe tener el mismo esquema
    // que la real, incluida la tabla de recuperación de contraseña (migración 002).
    const migrationsDir = path.resolve(__dirname, '../../../../database/migrations');
    for (const file of ['002-password-reset-tokens.sql', '003-company-bank-accounts.sql', '004-drivers.sql', '005-booking-groups.sql', '006-company-documents.sql', '007-users-oauth.sql', '008-oauth-flows.sql', '009-company-integrations.sql', '010-bus-layout-versioning.sql', '011-trip-seat-type-prices-restrict.sql', '012-drop-redundant-code-indexes.sql', '013-settlement-item-unique-transaction.sql', '014-revoked-sessions.sql', '015-destinations-content-branding.sql', '016-destination-enhancements.sql', '017-users-sessions-valid-from.sql', '018-fk-on-update-restrict-mariadb-1011.sql', '019-bank-accounts-encryption.sql']) {
      const migration = path.join(migrationsDir, file);
      if (!fs.existsSync(migration)) throw new Error(`Falta la migración ${file}`);
      for (const statement of splitStatements(fs.readFileSync(migration, 'utf8'))) {
        if (/^SELECT/i.test(statement)) continue; // las comprobaciones del script no aplican aquí
        await connection.query(statement);
      }
    }

    // Cambio de datos ya aplicado en desarrollo: COMPANY_ADMIN modera reseñas de su empresa.
    await connection.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r JOIN permissions p ON p.name = 'reviews.update'
       WHERE r.name = 'COMPANY_ADMIN'
         AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`,
    );
  } finally {
    await connection.end();
  }
}

/** Vacía las tablas transaccionales dejando intactos roles, permisos y catálogos. */
export async function truncateOperationalData(databaseName: string): Promise<void> {
  assertIsTestDatabase(databaseName);

  const tables = [
    // Migración 015: los hijos antes que el destino (TRUNCATE no arrastra en cascada).
    'destination_festivities', 'destination_attractions', 'destinations',
    'settlement_items', 'settlements', 'financial_transactions', 'refunds', 'payments',
    'booking_groups',
    'coupon_usages', 'booking_seats', 'bookings', 'review_responses', 'reviews',
    'support_messages', 'support_tickets', 'notifications', 'coupons', 'promotions',
    'audit_logs', 'api_keys',
    // Migración 010: las versiones de distribución se vacían antes que sus asientos y
    // que el bus. `TRUNCATE` corre con las claves ajenas desactivadas y por tanto NO
    // arrastra en cascada: si no se nombran aquí, la versión 1 sobrevive de un archivo de
    // pruebas al siguiente y el segundo sembrado choca contra `uq_layout_bus_version`.
    'trip_seat_type_prices', 'bus_layout_elements', 'bus_layout_decks', 'bus_layouts',
    'seats', 'trips', 'route_stops', 'routes', 'buses',
    'revoked_sessions', 'oauth_flows', 'company_integrations', 'password_reset_tokens', 'company_bank_accounts', 'company_documents', 'drivers', 'company_users', 'companies', 'locations', 'users', 'bus_types', 'seat_types',
    'company_commission_settings', 'system_settings', 'notification_templates',
  ];

  const connection = await mysql.createConnection({ ...credentials(), database: databaseName });
  try {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of tables) {
      await connection.query(`TRUNCATE TABLE \`${table}\``);
    }
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    await connection.end();
  }
}

/** Una transacción que quedó abierta en una sesión ociosa. Nunca lleva datos de negocio. */
export interface TransaccionHuerfana {
  sesion: number;
  desde: string;
  filasBloqueadas: number;
  tablasBloqueadas: number;
}

/**
 * Cierra y devuelve las transacciones que quedaron ABIERTAS en sesiones OCIOSAS de la base de
 * pruebas (F17C-SEC-11).
 *
 * POR QUÉ. En una batería completa se capturó en vivo una sesión en reposo con una transacción
 * abierta desde hacía minutos: 24 filas bloqueadas en 7 tablas, entre ellas un cerrojo exclusivo
 * sobre `routes`. Cada `INSERT INTO trips` posterior esperaba los 50 s de
 * `innodb_lock_wait_timeout` y fallaba, así que el resto del archivo se hundió en cascada. El
 * error original nunca llegó a verse y no hubo forma de saber quién la abrió.
 *
 * QUÉ SE CONSIDERA HUÉRFANA. Al terminar un archivo ya no queda ninguna petición suya en curso y
 * el corredor ejecuta los archivos de uno en uno, así que una sesión de la base de pruebas que
 * está en `Sleep` y aun así tiene una transacción abierta no puede ser trabajo legítimo: es una
 * transacción que alguien empezó y nunca cerró.
 *
 * Se CIERRA para que sus cerrojos no alcancen al archivo siguiente, y se DEVUELVE para que quien
 * llama lo convierta en un fallo visible. No borra datos: `KILL` deshace lo no confirmado de una
 * sesión que, por definición, nadie iba a confirmar ya.
 */
export async function closeOrphanTransactions(databaseName: string): Promise<TransaccionHuerfana[]> {
  assertIsTestDatabase(databaseName);
  const connection = await mysql.createConnection(credentials());
  try {
    const [rows] = await connection.query(
      `SELECT t.trx_mysql_thread_id AS sesion, t.trx_started AS desde,
              t.trx_rows_locked AS filasBloqueadas, t.trx_tables_locked AS tablasBloqueadas
       FROM information_schema.innodb_trx t
       JOIN information_schema.processlist p ON p.id = t.trx_mysql_thread_id
       WHERE p.db = ? AND p.command = 'Sleep' AND p.id <> CONNECTION_ID()`,
      [databaseName],
    );
    const huerfanas = (rows as Array<Record<string, unknown>>).map((fila) => ({
      sesion: Number(fila.sesion),
      desde: String(fila.desde),
      filasBloqueadas: Number(fila.filasBloqueadas),
      tablasBloqueadas: Number(fila.tablasBloqueadas),
    }));
    for (const huerfana of huerfanas) {
      await connection.query('KILL ?', [huerfana.sesion]);
    }
    return huerfanas;
  } finally {
    await connection.end();
  }
}

export async function dropTestDatabase(databaseName: string): Promise<void> {
  assertIsTestDatabase(databaseName);
  const admin = await mysql.createConnection(credentials());
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
  } finally {
    await admin.end();
  }
}
