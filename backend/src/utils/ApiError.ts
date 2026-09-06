export class ApiError extends Error {
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, ApiError);
  }

  static badRequest(message = 'Solicitud inválida', details?: unknown) {
    return new ApiError(400, message, details);
  }

  static unauthorized(message = 'No autenticado') {
    return new ApiError(401, message);
  }

  static forbidden(message = 'No tienes permisos para realizar esta acción') {
    return new ApiError(403, message);
  }

  static notFound(message = 'Recurso no encontrado') {
    return new ApiError(404, message);
  }

  static conflict(message = 'El recurso ya existe o está en uso') {
    return new ApiError(409, message);
  }

  static unprocessable(message = 'No se pudo procesar la solicitud', details?: unknown) {
    return new ApiError(422, message, details);
  }

  static tooManyRequests(message = 'Demasiados intentos. Inténtalo de nuevo más tarde') {
    return new ApiError(429, message);
  }

  static internal(message = 'Error interno del servidor') {
    return new ApiError(500, message);
  }

  /** Dependencia externa ausente o caída: el proveedor de identidad, por ejemplo. */
  static serviceUnavailable(message = 'El servicio no está disponible en este momento') {
    return new ApiError(503, message);
  }
}
