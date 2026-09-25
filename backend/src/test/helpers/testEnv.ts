/**
 * Debe importarse SIEMPRE como primer import de cada archivo de test.
 *
 * Fija las variables de entorno antes de que `config/env.ts` las lea, de modo que la
 * aplicación quede apuntando a la base de pruebas y nunca a `busperu`.
 */
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Sin DB_NAME se usa directamente la base de pruebas; nunca se parte de `busperu` (FASE 11F-0).
const configured = process.env.DB_NAME ?? 'busperu_test';

/**
 * Los procesos hijo del corredor heredan DB_NAME ya apuntando a la base de pruebas, así que
 * el sufijo solo se añade una vez (si no, quedaría `busperu_test_test`).
 */
export const TEST_DATABASE =
  process.env.TEST_DB_NAME ?? (configured.endsWith('_test') ? configured : `${configured}_test`);

if (!TEST_DATABASE.endsWith('_test')) {
  throw new Error(`ABORTADO: la base de pruebas debe terminar en "_test" y se obtuvo "${TEST_DATABASE}".`);
}

process.env.NODE_ENV = 'test';
process.env.DB_NAME = TEST_DATABASE;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'clave-solo-para-tests-no-usar-en-produccion';
// Los límites por defecto cortarían la suite; el rate limiting se prueba aparte.
process.env.RATE_LIMIT_GLOBAL = process.env.RATE_LIMIT_GLOBAL ?? '100000';
process.env.RATE_LIMIT_AUTH = process.env.RATE_LIMIT_AUTH ?? '100000';
// El correo nunca sale de la suite: el transporte en memoria retiene los mensajes para
// poder comprobarlos sin depender de un servidor SMTP.
process.env.MAIL_TRANSPORT = 'memory';
// Sin cooldown de reenvío los tests no tendrían que esperar 45 segundos reales.
process.env.PASSWORD_RESET_RESEND_COOLDOWN_SECONDS = process.env.PASSWORD_RESET_RESEND_COOLDOWN_SECONDS ?? '0';
