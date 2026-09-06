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
function splitStatements(sql: string): string[] {
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
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const statement of splitStatements(sql)) {
      await connection.query(statement);
    }
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');

    // Migraciones aplicadas sobre el dump. La base de pruebas debe tener el mismo esquema
    // que la real, incluida la tabla de recuperación de contraseña (migración 002).
    const migrationsDir = path.resolve(__dirname, '../../../../database/migrations');
    for (const file of ['002-password-reset-tokens.sql', '003-company-bank-accounts.sql', '004-drivers.sql', '005-booking-groups.sql', '006-company-documents.sql', '007-users-oauth.sql', '008-oauth-flows.sql', '009-company-integrations.sql']) {
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
    'settlement_items', 'settlements', 'financial_transactions', 'refunds', 'payments',
    'booking_groups',
    'coupon_usages', 'booking_seats', 'bookings', 'review_responses', 'reviews',
    'support_messages', 'support_tickets', 'notifications', 'coupons', 'promotions',
    'audit_logs', 'api_keys', 'seats', 'trips', 'route_stops', 'routes', 'buses',
    'oauth_flows', 'company_integrations', 'password_reset_tokens', 'company_bank_accounts', 'company_documents', 'drivers', 'company_users', 'companies', 'locations', 'users', 'bus_types', 'seat_types',
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

export async function dropTestDatabase(databaseName: string): Promise<void> {
  assertIsTestDatabase(databaseName);
  const admin = await mysql.createConnection(credentials());
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
  } finally {
    await admin.end();
  }
}
