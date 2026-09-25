import { TEST_DATABASE } from './testEnv';
import { startTestServer, stopTestServer } from './api';
import { closeOrphanTransactions, truncateOperationalData, type TransaccionHuerfana } from './database';
import { loginAll, seedFixtures, type Fixtures } from './fixtures';
import type { PoolConnection as CallbackPoolConnection } from 'mysql2';
import { pool } from '../../config/database';

/**
 * F18-02 · con `TEST_SQL_MODE`, cada conexión del pool de la aplicación arranca en ese modo SQL.
 * Sirve para ejecutar la batería completa con el modo estricto de producción sobre la base de
 * pruebas, sin tocar la configuración global del servidor. Se registra al cargar este módulo, antes
 * de que ninguna prueba abra una conexión. Sin la variable no hace nada.
 */
const modoSqlDePrueba = process.env.TEST_SQL_MODE;
if (modoSqlDePrueba) {
  pool.on('connection', (connection) => {
    (connection as unknown as CallbackPoolConnection).query('SET SESSION sql_mode = ?', [modoSqlDePrueba], (error: unknown) => {
      if (error) console.error('No se pudo fijar el modo SQL de prueba:', error);
    });
  });
}

export interface SuiteContext {
  fixtures: Fixtures;
  sessions: Awaited<ReturnType<typeof loginAll>>;
}

/**
 * Deja el entorno en un estado conocido: vacía los datos operativos de la base de PRUEBAS,
 * vuelve a sembrar las fixtures y arranca la app. Cada archivo de test empieza limpio.
 */
export async function prepareSuite(): Promise<SuiteContext> {
  await startTestServer();
  await truncateOperationalData(TEST_DATABASE);
  const fixtures = await seedFixtures();
  const sessions = await loginAll();
  return { fixtures, sessions };
}

/**
 * Cierra la app y el pool del archivo.
 *
 * F17C-SEC-11 · antes de cerrar, comprueba que el archivo no deje ninguna transacción abierta.
 * Se hace ANTES de cerrar el pool a propósito: cerrarlo destruye la conexión filtrada y con ella
 * la prueba de la fuga, y el problema volvería a pasar desapercibido.
 *
 * Si encuentra alguna, la cierra —para que sus cerrojos no hundan a los archivos siguientes— y
 * hace FALLAR este archivo con la descripción de lo que quedó abierto. No es una red de
 * seguridad que tape el fallo: es lo contrario, un fallo con nombre y apellido en el archivo que
 * lo causó, en lugar de una cascada muda en archivos que no tienen nada que ver.
 */
export async function teardownSuite(): Promise<void> {
  let huerfanas: TransaccionHuerfana[] = [];
  try {
    huerfanas = await closeOrphanTransactions(TEST_DATABASE);
  } catch (error) {
    // Si ni siquiera se puede consultar, el archivo ya habrá fallado por su cuenta.
    console.error(`[aislamiento] no se pudo comprobar si quedaron transacciones abiertas: ${(error as Error).message}`);
  }
  await stopTestServer();

  if (huerfanas.length > 0) {
    const detalle = huerfanas
      .map((h) => `sesión ${h.sesion}: abierta desde ${h.desde}, ${h.filasBloqueadas} filas en ${h.tablasBloqueadas} tablas`)
      .join('; ');
    throw new Error(
      `Este archivo dejó ${huerfanas.length} transacción(es) abierta(s) en una conexión devuelta al pool `
      + `o nunca liberada. Se cerraron para no bloquear a los archivos siguientes. ${detalle}`,
    );
  }
}
