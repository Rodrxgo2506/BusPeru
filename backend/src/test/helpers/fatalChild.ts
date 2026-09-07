/**
 * Proceso de usar y tirar para las pruebas de BP-17.
 *
 * Instala los manejadores REALES de `process-guards.ts` y provoca a continuación una
 * excepción que nadie atrapa. No se puede comprobar esto dentro de la suite: el corredor
 * tiene sus propios manejadores y una excepción no controlada mataría todos los tests, así
 * que hace falta un proceso aparte cuyo `stderr` se pueda leer.
 */
import './testEnv';
import { installFatalHandlers } from '../../utils/process-guards';

process.env.LOG_ERRORS = 'true';

installFatalHandlers((signal, code) => {
  // Sustituye al cierre real del servidor: aquí no hay ni pool ni escucha que cerrar.
  console.error(JSON.stringify({ shutdown: signal, code }));
  setTimeout(() => process.exit(code), 50);
});

if (process.argv[2] === 'uncaught') {
  setTimeout(() => {
    throw new Error('fallo sintetico no controlado');
  }, 0);
} else {
  setTimeout(() => {
    void Promise.reject(new Error('promesa sintetica rechazada'));
  }, 0);
}

// Mantiene el proceso vivo lo justo para que el manejador llegue a actuar.
setTimeout(() => process.exit(99), 5_000);
