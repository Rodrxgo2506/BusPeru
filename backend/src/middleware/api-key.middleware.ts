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
 * DÓNDE ESTÁ MONTADO. `authenticateApiKeyRequest` protege la superficie de integración para
 * sistemas externos: `routes/index.ts` monta `integration.routes.ts` bajo `/api/integration/v1`,
 * y ese router lo aplica con `router.use(...)`, de modo que cubre TODOS sus endpoints antes que
 * ninguna otra cosa. No está montado en ningún otro sitio: en el resto de la API la credencial
 * sigue siendo el JWT, y una API Key no sirve allí.
 *
 * QUÉ GARANTIZA ESE CANAL, comprobado sobre el código de `integration.routes.ts`:
 *   · Es de SOLO LECTURA: no contiene ningún INSERT, UPDATE ni DELETE.
 *   · La empresa sale siempre de `req.apiKey.companyId`. Ese archivo no lee `company_id` del
 *     cuerpo, de la query, de los parámetros ni de otra cabecera, así que no hay nada que
 *     manipular para salirse del alcance.
 *   · Usa `trips.view` y `bookings.view`, permisos ya existentes, recortados además al techo de
 *     la empresa por `api-key.service.ts`.
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
