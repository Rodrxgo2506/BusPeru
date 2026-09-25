import { env } from '../config/env';
import { redactKnownSecrets, sanitizeUrl } from './log-sanitizer';

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

  /* --- Sucesos de proveedores externos (webhook de Culqi) ------------------ */
  /** Quién originó el suceso: `CULQI`. */
  provider?: string;
  /** Descriptor del suceso tal como lo envía el proveedor, recortado. */
  event?: string;
  /** Identificador PÚBLICO del cargo (`chr_…`). No es un secreto ni una credencial. */
  chargeId?: string;
  paymentId?: number;
  bookingId?: number;
  /** Qué se hizo con el suceso. Valores cerrados, ver `WebhookOutcome`. */
  outcome?: string;
  /** Aclaración corta y SIEMPRE escrita por nosotros; nunca contenido del proveedor. */
  detail?: string;
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
  // H-31: la ruta se sanea aunque quien llama ya lo haya hecho, y cualquier secreto configurado
  // que haya llegado al mensaje, a la traza o al contexto se sustituye antes de escribir.
  const saneado = typeof record.path === 'string' ? { ...record, path: sanitizeUrl(record.path) } : record;
  console.error(redactKnownSecrets(JSON.stringify(saneado)));
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
 * Registra un suceso que NO es un fallo pero que hay que poder auditar después.
 *
 * Existe por el webhook de Culqi (auditoría de observabilidad). Un webhook que llega y
 * encuentra el pago ya conciliado hace lo correcto —nada— y precisamente por eso no dejaba
 * ningún rastro: no se podía saber si Culqi lo entregó, cuántas veces ni con qué resultado.
 * Para un mecanismo cuya razón de ser es la conciliación cuando la respuesta HTTP se pierde,
 * eso era un punto ciego.
 *
 * Comparte transporte y formato con `logError`: una línea JSON, el mismo `emit`, el mismo
 * silencio durante la suite. No es un registrador paralelo.
 */
export function logEvent(message: string, context: LogContext = {}): void {
  emit({
    timestamp: new Date().toISOString(),
    level: 'info',
    message,
    ...context,
  });
}

/**
 * Una línea de registro de acceso (F15-08). Lista CERRADA: no hay forma de colar cabeceras,
 * cookies, `Authorization`, cuerpo ni query. La ruta llega ya sin query y `emit` la sanea otra vez.
 */
export interface AccessLogEntry {
  requestId?: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  /** Solo el id numérico de la persona autenticada, nunca su correo ni su token. */
  userId?: number;
}

/** Registra una petición atendida. Mismo transporte y formato que el resto: una línea JSON. */
export function logAccess(entry: AccessLogEntry): void {
  emit({
    timestamp: new Date().toISOString(),
    level: 'info',
    message: 'http_request',
    ...entry,
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
