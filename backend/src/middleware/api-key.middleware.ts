import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { API_KEY_HEADER, apiKeyHasPermission, authenticateApiKey } from '../services/api-key.service';
import { ApiError } from '../utils/ApiError';

/**
 * Autenticación por API Key (auditoría BP-11).
 *
 * Es un mecanismo SEPARADO del JWT, no una variante suya: llega por su propia cabecera y
 * deja su identidad en `req.apiKey`, nunca en `req.user`. Así ningún middleware existente
 * confunde una llave con una persona, y `requirePermission`, `requireRole` o
 * `visibilityScope` siguen comportándose exactamente igual que hasta ahora.
 *
 * NO está montado en ninguna ruta todavía, y es deliberado: BusPerú no tiene hoy ninguna
 * superficie pensada para sistemas externos, y no se inventan endpoints de negocio para
 * justificar el mecanismo. Ver el informe de la fase.
 */

function extractApiKey(req: Request): string | null {
  const header = req.headers[API_KEY_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Exige una API Key válida y deja la empresa resuelta en `req.apiKey`.
 *
 * La empresa sale SIEMPRE de la llave. Nada de lo que venga en el cuerpo, la query o otra
 * cabecera influye en el alcance, porque este middleware no lo lee.
 */
export const authenticateApiKeyRequest: RequestHandler = (req: Request, _res: Response, next: NextFunction): void => {
  const presented = extractApiKey(req);
  if (!presented) {
    next(ApiError.unauthorized('Falta la clave de API'));
    return;
  }

  authenticateApiKey(presented)
    .then((identity) => {
      req.apiKey = identity;
      next();
    })
    .catch(next);
};

/**
 * Exige que la llave tenga alguno de los permisos indicados.
 *
 * Los permisos ya vienen recortados al techo de la empresa por el servicio, de modo que
 * aquí nunca puede colarse uno que la empresa no tenga.
 */
export function requireApiKeyPermission(...permissions: string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.apiKey) return next(ApiError.unauthorized('Falta la clave de API'));
    if (!apiKeyHasPermission(req.apiKey, ...permissions)) {
      return next(ApiError.forbidden(`La clave de API no tiene el permiso: ${permissions.join(' o ')}`));
    }
    next();
  };
}

/** Identidad de la llave en una ruta que ya pasó por `authenticateApiKeyRequest`. */
export function requireApiKey(req: Request): NonNullable<Request['apiKey']> {
  if (!req.apiKey) throw ApiError.unauthorized('Falta la clave de API');
  return req.apiKey;
}
