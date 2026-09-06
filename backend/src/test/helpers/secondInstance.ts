import { spawn, type ChildProcess } from 'child_process';
import path from 'path';

/**
 * Lanza una segunda instancia del backend en un proceso Node **independiente**.
 *
 * Es la única forma de comprobar sin aproximaciones que el flujo OAuth ya no depende de la
 * memoria del proceso: dos procesos distintos no comparten `Map`, así que si `/start` en
 * uno y `/callback` en el otro funcionan, el estado está de verdad en la base.
 *
 * La configuración del proveedor se pasa por variables de entorno, igual que en producción.
 * `JWT_SECRET` y `DB_NAME` se heredan del proceso padre para que ambas instancias hasheen
 * igual y hablen con la misma base de PRUEBAS.
 */
export interface SecondInstance {
  /** Base de la API de la segunda instancia, lista para usar con `fetch`. */
  baseUrl: string;
  stop(): Promise<void>;
}

const ENTRY = path.resolve(__dirname, 'oauthInstance.ts');
const READY_TIMEOUT_MS = 60_000;

export async function startSecondInstance(providerEnv: Record<string, string>): Promise<SecondInstance> {
  const child: ChildProcess = spawn(
    process.execPath,
    [require.resolve('tsx/cli'), ENTRY],
    {
      env: { ...process.env, ...providerEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('La segunda instancia no arrancó a tiempo')), READY_TIMEOUT_MS);
    let salida = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      salida += chunk.toString();
      const match = salida.match(/LISTENING (\d+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });

    // El error del hijo debe verse en la salida de la suite: si no arranca, hay que saber por qué.
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[instancia 2] ${chunk.toString()}`));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`La segunda instancia terminó antes de escuchar (código ${code})`));
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}/api`,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
}
