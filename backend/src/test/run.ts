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
  /** Fallos que no son de un test concreto: un hook `before`/`after` o el archivo entero. */
  let failedOutsideTests = 0;
  /** Veredicto global del propio `node:test`, independiente de nuestro recuento. */
  let runnerSuccess: boolean | null = null;

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
  /**
   * F17C-SEC-11 · el error de cada fallo se imprime EN EL MOMENTO, no solo al final.
   *
   * El reportero `spec` guarda los detalles para el resumen final. Una batería que se cuelga —se
   * capturó una en la que cada test esperaba 50 s por un cerrojo— nunca llega a ese resumen, y
   * todo lo que queda son líneas `✖` sin un solo mensaje: el fallo es imposible de diagnosticar.
   * Una línea breve por fallo, a stderr, basta para saber qué pasó aunque haya que cortar la
   * ejecución. El resumen final no cambia.
   */
  stream.on('test:fail', (event: { name?: string; file?: string; details?: { type?: string; error?: unknown } }) => {
    if (isSuite(event)) {
      /**
       * F17C-SEC-11 · UN `describe` QUE FALLA POR SÍ MISMO TAMBIÉN ES UN FALLO.
       *
       * Antes solo se contaban los tests hoja, así que un fallo en un hook `before`/`after` de
       * un `describe` —que `node:test` atribuye a la suite, no a un test— no sumaba nada: la
       * batería imprimía «Fallidos: 0» y salía con código 0 aunque el reportero mostrara el
       * error en rojo. Se comprobó con un archivo cuyo `after` fallaba: «Aprobados: 1,
       * Fallidos: 0», código de salida 0.
       *
       * Un `describe` que falla porque falló uno de sus tests (`subtestsFailed`) ya está contado
       * en ese test; cualquier otro motivo es un fallo propio y se cuenta aparte.
       */
      const error = event.details?.error as { failureType?: string; cause?: { message?: string } } | undefined;
      if (error?.failureType === 'subtestsFailed') return;
      failedOutsideTests += 1;
      const detalle = String(error?.cause?.message ?? '').split('\n')[0]?.slice(0, 300) ?? '';
      process.stderr.write(
        `\n[fallo fuera de un test: ${error?.failureType ?? 'desconocido'}] ${path.basename(event.file ?? '')} › ${event.name ?? ''}\n        ${detalle}\n`,
      );
      return;
    }
    failed += 1;
    const envoltura = event.details?.error as
      | { cause?: unknown; message?: string; failureType?: string; exitCode?: number | null; signal?: string | null }
      | undefined;
    const causa = (envoltura?.cause ?? envoltura) as { code?: string; message?: string } | undefined;
    const mensaje = String(causa?.message ?? envoltura?.message ?? '').split('\n')[0]?.slice(0, 300) ?? '';
    // Cuando es el PROCESO del archivo el que muere —sin llegar a reportar ningún test—,
    // `node:test` solo dice «test failed». El código de salida y la señal son la única pista de
    // por qué: un fallo nativo, una señal externa o un `process.exit` inesperado se distinguen ahí.
    const proceso = envoltura && ('exitCode' in envoltura || 'signal' in envoltura)
      ? ` [proceso: ${envoltura.failureType ?? '?'} · código ${String(envoltura.exitCode)} · señal ${String(envoltura.signal)}]`
      : '';
    process.stderr.write(`\n[fallo] ${path.basename(event.file ?? '')} › ${event.name ?? ''}${proceso}\n        ${causa?.code ? `${causa.code} ` : ''}${mensaje}\n`);
  });

  // El resumen global —el único sin `file`— trae el veredicto del propio `node:test`.
  stream.on('test:summary', (summary: { success?: boolean; file?: string }) => {
    if (summary.file === undefined && typeof summary.success === 'boolean') runnerSuccess = summary.success;
  });

  stream.compose(spec).pipe(process.stdout);

  await new Promise<void>((resolve) => stream.on('end', resolve));

  console.log(`\n───────────────────────────────────────────────`);
  console.log(`  Tests ejecutados: ${passed + failed}`);
  console.log(`  Aprobados:        ${passed}`);
  console.log(`  Fallidos:         ${failed}`);
  console.log(`  Fallos fuera de un test (hooks o archivo): ${failedOutsideTests}`);
  console.log(`  Veredicto de node:test: ${runnerSuccess === null ? 'no recibido' : runnerSuccess ? 'correcto' : 'FALLIDO'}`);
  console.log(`  Base de pruebas:  ${TEST_DATABASE}`);
  console.log(`───────────────────────────────────────────────\n`);

  // Dos señales independientes: nuestro recuento y el veredicto del corredor. Basta con que una
  // diga que algo falló. Si el veredicto no llegara, no se presume éxito: decide el recuento.
  const huboFallos = failed > 0 || failedOutsideTests > 0 || runnerSuccess === false;
  process.exit(huboFallos ? 1 : 0);
}

main().catch((error) => {
  console.error('Error al ejecutar la suite:', error);
  process.exit(1);
});
