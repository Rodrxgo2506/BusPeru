import { TEST_DATABASE } from './testEnv';
import { startTestServer, stopTestServer } from './api';
import { truncateOperationalData } from './database';
import { loginAll, seedFixtures, type Fixtures } from './fixtures';

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

export async function teardownSuite(): Promise<void> {
  await stopTestServer();
}
