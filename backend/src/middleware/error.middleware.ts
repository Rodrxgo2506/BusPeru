import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';

interface MysqlError extends Error {
  code?: string;
  errno?: number;
  sqlMessage?: string;
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`Ruta no encontrada: ${req.method} ${req.originalUrl}`));
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const mapped = mapError(error);

  if (!env.isProduction && mapped.statusCode >= 500) {
    console.error(error);
  }

  res.status(mapped.statusCode).json({
    success: false,
    message: mapped.message,
    ...(mapped.details ? { errors: mapped.details } : {}),
  });
}

function mapError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

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
