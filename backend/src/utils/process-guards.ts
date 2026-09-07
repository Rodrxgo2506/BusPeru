import { logFatal } from './logger';

/**
 * Excepciones que escapan a todo manejador (auditoría BP-17).
 *
 * Vive aparte de `server.ts` por dos motivos. El primero es que `server.ts` arranca la
 * aplicación entera —base de datos, planificador, escucha de puerto— y no se puede importar
 * desde una prueba sin levantarlo todo; aquí el comportamiento queda aislado y se puede
 * comprobar de verdad en un proceso hijo. El segundo es que así el cierre es un parámetro:
 * este módulo decide QUÉ se registra, y quien lo instala decide CÓMO se cierra.
 *
 * La política es deliberadamente estricta: se registra y **el proceso termina**. No se
 * intenta continuar. Tras una excepción no controlada el estado es indeterminado —una
 * transacción a medias, una conexión en un estado imposible, un `finally` que nunca corrió—
 * y seguir sirviendo peticiones convierte un fallo ruidoso en corrupción silenciosa.
 *
 * Aquí no se crea ningún gestor de procesos ni se reinicia nada: solo se sale con código 1,
 * que es lo que systemd, Docker, Kubernetes o PM2 ya saben interpretar como «reinícialo».
 */
export type FatalShutdown = (signal: string, code: number) => void;

export function installFatalHandlers(shutdown: FatalShutdown): void {
  process.on('uncaughtException', (error: unknown) => {
    logFatal('uncaughtException', error);
    shutdown('uncaughtException', 1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logFatal('unhandledRejection', reason);
    shutdown('unhandledRejection', 1);
  });
}
