import { env } from '../config/env';

/**
 * Registro de errores del servidor (auditoría BP-17).
 *
 * QUÉ ESTABA MAL. El manejador central decía:
 *
 *     if (!env.isProduction && mapped.statusCode >= 500) console.error(error);
 *
 * La intención —no volcar trazas al cliente— era correcta y ya se cumplía por separado en
 * la respuesta. Pero la negación apagaba también el registro EN EL SERVIDOR, que es justo
 * donde hace falta: en producción un fallo devolvía «Error interno del servidor» al usuario
 * y **no dejaba absolutamente ningún rastro**. Ni traza, ni ruta, ni usuario. Diagnosticar
 * una incidencia era imposible sin reproducirla.
 *
 * POR QUÉ NO SE AÑADE UNA BIBLIOTECA. Un registrador completo (pino, winston) traería
 * transportes, rotación y configuración que este despliegue no necesita todavía: basta con
 * escribir una línea por suceso en `stderr`, que es lo que capturan systemd, Docker, PM2 y
 * cualquier plataforma. Se emite JSON en una sola línea para que un recolector pueda
 * indexarlo sin parsear texto libre. El día que haga falta un transporte de verdad, se
 * sustituye la implementación de `emit` y nada más.
 */

/**
 * Contexto que acompaña a un error. La lista es CERRADA a propósito: sin firma de índice no
 * se puede colar `req.body`, `req.headers` ni ninguna credencial por descuido.
 */
export interface LogContext {
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  /** Identificador de la persona autenticada, nunca su correo ni su token. */
  userId?: number;
  role?: string;
  /** Identificador de la API Key, NUNCA la clave ni su hash. */
  apiKeyId?: number;
  companyId?: number;
}

/** Detalle técnico de un error de MySQL, sin la sentencia. */
interface DatabaseErrorDetail {
  code?: string;
  errno?: number;
  sqlState?: string;
  sqlMessage?: string;
}

const MAX_MESSAGE = 1_000;
const MAX_STACK = 4_000;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}… [recortado]` : value;
}

/**
 * Extrae lo que sirve para diagnosticar de un error de base de datos.
 *
 * **`error.sql` se excluye deliberadamente.** El conector adjunta la sentencia completa con
 * sus parámetros ya sustituidos, de modo que un `INSERT INTO users` fallido llevaría dentro
 * el hash de la contraseña, y un fallo sobre `company_integrations` el sobre cifrado. El
 * código, el número y el mensaje bastan para saber qué pasó.
 */
function databaseDetail(error: unknown): DatabaseErrorDetail | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const candidate = error as DatabaseErrorDetail;
  if (candidate.code === undefined && candidate.errno === undefined) return undefined;

  return {
    ...(candidate.code !== undefined ? { code: candidate.code } : {}),
    ...(candidate.errno !== undefined ? { errno: candidate.errno } : {}),
    ...(candidate.sqlState !== undefined ? { sqlState: candidate.sqlState } : {}),
    ...(candidate.sqlMessage !== undefined ? { sqlMessage: truncate(String(candidate.sqlMessage), MAX_MESSAGE) } : {}),
  };
}

/** Una línea por suceso, en `stderr`. Aquí es donde se cambiaría el transporte. */
function emit(record: Record<string, unknown>): void {
  // Durante la suite se silencia: cada prueba que provoca un 500 escupiría su traza y
  // ensuciaría la salida. Las pruebas de BP-17 interceptan `console.error` y sí la leen.
  if (env.nodeEnv === 'test' && process.env.LOG_ERRORS !== 'true') return;
  console.error(JSON.stringify(record));
}

/**
 * Registra un error del servidor. Se llama UNA sola vez por petición, desde el manejador
 * central: las rutas se limitan a `next(error)` y no registran nada por su cuenta.
 */
export function logError(message: string, error: unknown, context: LogContext = {}): void {
  const cause = error instanceof Error ? error : undefined;

  emit({
    timestamp: new Date().toISOString(),
    level: 'error',
    message,
    ...context,
    error: {
      name: cause?.name ?? typeof error,
      message: truncate(cause?.message ?? String(error), MAX_MESSAGE),
      ...(cause?.stack ? { stack: truncate(cause.stack, MAX_STACK) } : {}),
      ...(databaseDetail(error) ? { database: databaseDetail(error) } : {}),
    },
  });
}

/**
 * Registra una excepción que escapó de todo manejador. El proceso queda en estado
 * indeterminado, así que quien llama debe cerrar ordenadamente y dejar que el gestor de
 * procesos reinicie; aquí solo se deja constancia.
 */
export function logFatal(kind: 'uncaughtException' | 'unhandledRejection', error: unknown): void {
  const cause = error instanceof Error ? error : undefined;

  emit({
    timestamp: new Date().toISOString(),
    level: 'fatal',
    message: `Excepción no controlada (${kind}). El proceso se cerrará.`,
    kind,
    error: {
      name: cause?.name ?? typeof error,
      message: truncate(cause?.message ?? String(error), MAX_MESSAGE),
      ...(cause?.stack ? { stack: truncate(cause.stack, MAX_STACK) } : {}),
    },
  });
}
