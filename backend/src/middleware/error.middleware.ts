import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';
import { sanitizeUrl } from '../utils/log-sanitizer';
import { logError } from '../utils/logger';

interface MysqlError extends Error {
  code?: string;
  errno?: number;
  sqlMessage?: string;
}

/**
 * Ruta inexistente.
 *
 * El mensaje ya NO incluye `req.originalUrl` (auditoría BP-25b). La respuesta es JSON y no
 * había XSS, pero devolver al cliente lo que el cliente acaba de escribir no aporta nada
 * —él sabe qué pidió— y es la clase de reflejo que deja de ser inocuo en cuanto alguien
 * copia el mensaje a un correo, a un panel o a una página HTML.
 */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound('Ruta no encontrada'));
}

/**
 * Manejador central de errores. Es el ÚNICO sitio que registra un fallo del servidor.
 *
 * Las rutas se limitan a `next(error)` y los servicios a lanzar, de modo que un mismo error
 * no aparece repetido por varias capas. Los pocos `console.error` que quedan fuera de aquí
 * son sucesos que NO terminan en una respuesta —el marcado de uso de una API Key, la zona
 * horaria de una conexión, una configuración mal escrita— y por tanto no se duplican.
 *
 * Reparto de responsabilidades:
 *
 *   · **Al cliente**, lo mínimo: el mensaje ya traducido y, en un 5xx, el identificador de
 *     la petición para que pueda citarlo. Nunca traza, ni SQL, ni rutas del sistema.
 *   · **Al registro**, lo necesario para diagnosticar: método, ruta, estado, identificador,
 *     quién actuaba y el error técnico con su traza. Jamás el cuerpo, las cabeceras ni
 *     ninguna credencial.
 */
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  const mapped = mapError(error);

  // Se registra SIEMPRE que sea un fallo del servidor, también —y sobre todo— en
  // producción. Un 4xx es una respuesta legítima a una petición mal formada y no se
  // registra: llenaría el diario de ruido que no requiere ninguna acción.
  if (mapped.statusCode >= 500) {
    logError('Error no controlado al atender una petición', error, {
      requestId: req.id,
      method: req.method,
      // H-31: sin el secreto del webhook ni códigos, tickets o tokens de la query.
      path: sanitizeUrl(req.originalUrl),
      status: mapped.statusCode,
      ...(req.user ? { userId: req.user.id, role: req.user.role } : {}),
      ...(req.apiKey ? { apiKeyId: req.apiKey.id, companyId: req.apiKey.companyId } : {}),
    });
  }

  res.status(mapped.statusCode).json({
    success: false,
    message: mapped.message,
    ...(mapped.details ? { errors: mapped.details } : {}),
    // La referencia solo acompaña a los fallos del servidor, que son los que alguien puede
    // necesitar reportar. En la cabecera `X-Request-Id` va en todas las respuestas.
    ...(mapped.statusCode >= 500 && req.id ? { request_id: req.id } : {}),
  });
}

/**
 * F17C-SEC-03B (SEC03B-01) · errores del analizador del cuerpo.
 *
 * `express.json()` lanza su propio error cuando el cuerpo no se puede leer: JSON mal formado,
 * un escalar donde se espera un objeto, más de 1 MB, una codificación que no admite… Ese error
 * YA trae su estado (400, 413, 415) y un `type` cerrado que fija la propia librería.
 *
 * Como `mapError` no lo reconocía, caía en el `default` y salía un **500**: la API culpaba al
 * servidor de un cuerpo que había enviado mal el cliente, y `errorHandler` lo registraba como
 * fallo no controlado con su traza. Cualquiera podía llenar el diario de errores con un `curl`
 * sin autenticarse, y una alerta de 5xx se disparaba por peticiones mal formadas.
 *
 * El mensaje que se devuelve es fijo y NO incluye nada del cuerpo recibido: se dice qué pasa,
 * no se refleja lo que llegó.
 */
const CUERPO_ILEGIBLE: Record<string, { status: number; message: string }> = {
  'entity.parse.failed': { status: 400, message: 'El cuerpo de la petición no es un JSON válido.' },
  'entity.verify.failed': { status: 400, message: 'El cuerpo de la petición no se pudo verificar.' },
  'entity.too.large': { status: 413, message: 'El cuerpo de la petición es demasiado grande.' },
  'request.aborted': { status: 400, message: 'La petición se interrumpió antes de terminar de enviarse.' },
  'request.size.invalid': { status: 400, message: 'El tamaño declarado del cuerpo no coincide con lo enviado.' },
  'parameters.too.many': { status: 400, message: 'El cuerpo de la petición tiene demasiados campos.' },
  'encoding.unsupported': { status: 415, message: 'La codificación del cuerpo no está admitida.' },
  'charset.unsupported': { status: 415, message: 'El juego de caracteres del cuerpo no está admitido.' },
  'stream.encoding.set': { status: 400, message: 'El cuerpo de la petición no se pudo leer.' },
};

/** `hasOwnProperty` y no un acceso directo: la clave no puede resolverse por el prototipo (H-03). */
function mapBodyParserError(error: unknown): ApiError | null {
  const tipo = (error as { type?: unknown } | null)?.type;
  if (typeof tipo !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(CUERPO_ILEGIBLE, tipo)) return null;
  const mapeado = CUERPO_ILEGIBLE[tipo]!;
  return new ApiError(mapeado.status, mapeado.message);
}

function mapError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  const cuerpo = mapBodyParserError(error);
  if (cuerpo) return cuerpo;

  const mysqlError = error as MysqlError;
  switch (mysqlError?.code) {
    case 'ER_DUP_ENTRY':
      return ApiError.conflict('Ya existe un registro con esos datos únicos.');
    case 'ER_ROW_IS_REFERENCED_2':
      return ApiError.conflict('No se puede eliminar: el registro está siendo utilizado por otros datos.');
    case 'ER_NO_REFERENCED_ROW_2':
      return ApiError.badRequest('Uno de los datos relacionados no existe.');
    case 'ECONNREFUSED':
    case 'PROTOCOL_CONNECTION_LOST':
      return new ApiError(503, 'No hay conexión con la base de datos.');
    default:
      return ApiError.internal();
  }
}
