import multer from 'multer';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError } from '../utils/ApiError';

/**
 * Recepción de UN archivo en el campo `file` (extraído de `company-document.routes.ts` en la
 * FASE 17 para que documentos e imágenes públicas compartan la misma barrera).
 *
 * El archivo se recibe en memoria y solo llega a disco si pasa las validaciones de
 * `file-storage.service`. El límite de multer es la primera barrera; el servicio vuelve
 * a comprobar tamaño, extensión, MIME y bytes mágicos.
 */
export function receiveSingleFile(maxBytes: number): RequestHandler {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
  });

  /** Convierte el error de límite de multer en un 400 legible en vez de un 500. */
  return (req: Request, res: Response, next: NextFunction): void => {
    upload.single('file')(req, res, (error: unknown) => {
      if (error && (error as { code?: string }).code === 'LIMIT_FILE_SIZE') {
        return next(ApiError.badRequest(`El archivo supera el máximo de ${Math.round(maxBytes / 1024 / 1024)} MB`));
      }
      if (error) return next(ApiError.badRequest('No se pudo procesar el archivo enviado'));
      next();
    });
  };
}
