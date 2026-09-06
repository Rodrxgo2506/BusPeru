import './helpers/testEnv';
import fs from 'fs';
import path from 'path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { TEST_DATABASE } from './helpers/testEnv';
import { setupTestDatabase } from './helpers/database';

/**
 * Corredor de la suite.
 *
 * 1. Recrea `busperu_test` desde el dump original (la base real nunca se toca).
 * 2. Ejecuta los archivos *.test.ts en serie, para que compartan la base sin pisarse.
 * 3. Devuelve un código de salida distinto de cero si algún test falla.
 */
async function main(): Promise<void> {
  console.log(`\n▶ Preparando la base de pruebas "${TEST_DATABASE}" desde el dump original...`);
  await setupTestDatabase(TEST_DATABASE);
  console.log('✔ Base de pruebas lista. La base real no se ha tocado.\n');

  const testDir = __dirname;
  // Filtro opcional para iterar sobre un archivo concreto: `npm test -- --filter=documents`.
  const filter = process.argv.find((arg) => arg.startsWith('--filter='))?.slice('--filter='.length);
  const files = fs
    .readdirSync(testDir)
    .filter((file) => file.endsWith('.test.ts'))
    .filter((file) => !filter || file.includes(filter))
    .sort()
    .map((file) => path.join(testDir, file));

  if (files.length === 0) {
    console.error('No se encontraron archivos de test.');
    process.exit(1);
  }

  const coverage = process.argv.includes('--coverage');

  let passed = 0;
  let failed = 0;

  const stream = run({
    files,
    concurrency: 1,
    timeout: 120_000,
    ...(coverage ? { coverage: true, coverageExcludeGlobs: ['src/test/**'] } : {}),
  });

  // Solo se cuentan los tests hoja: los `describe` también emiten estos eventos.
  const isSuite = (event: { details?: { type?: string } }) => event.details?.type === 'suite';

  stream.on('test:pass', (event: { skip?: boolean; todo?: boolean; details?: { type?: string } }) => {
    if (!event.skip && !event.todo && !isSuite(event)) passed += 1;
  });
  stream.on('test:fail', (event: { details?: { type?: string } }) => {
    if (!isSuite(event)) failed += 1;
  });

  stream.compose(spec).pipe(process.stdout);

  await new Promise<void>((resolve) => stream.on('end', resolve));

  console.log(`\n───────────────────────────────────────────────`);
  console.log(`  Tests ejecutados: ${passed + failed}`);
  console.log(`  Aprobados:        ${passed}`);
  console.log(`  Fallidos:         ${failed}`);
  console.log(`  Base de pruebas:  ${TEST_DATABASE}`);
  console.log(`───────────────────────────────────────────────\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Error al ejecutar la suite:', error);
  process.exit(1);
});
