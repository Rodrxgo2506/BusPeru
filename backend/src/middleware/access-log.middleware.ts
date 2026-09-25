import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logAccess } from '../utils/logger';

/**
 * Registro de acceso (auditoría pre-producción F15-08).
 *
 * En producción morgan está desactivado, así que no quedaba rastro de las peticiones correctas.
 * Este middleware escribe, al terminar cada respuesta, una línea JSON con el mismo `emit` que los
 * errores: método, ruta, estado, duración, `request_id` y el id numérico del usuario si lo hay.
 *
 * QUÉ NO SE REGISTRA, A PROPÓSITO:
 *   · la query string entera: por ella viajan `code`/`state` de OAuth, tickets, búsquedas con
 *     correos o documentos; se descarta en lugar de intentar sanearla;
 *   · ninguna cabecera (`Authorization`, cookies, API Keys) ni el cuerpo;
 *   · la ruta pasa además por `sanitizeUrl` dentro de `emit`, que oculta el secreto del webhook
 *     de Culqi y cualquier segmento con forma de token.
 */
export const accessLog: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  const inicio = process.hrtime.bigint();
  res.on('finish', () => {
    const url = req.originalUrl ?? req.url;
    const q = url.indexOf('?');
    logAccess({
      ...(req.id ? { requestId: req.id } : {}),
      method: req.method,
      path: q >= 0 ? url.slice(0, q) : url,
      status: res.statusCode,
      durationMs: Math.round(Number(process.hrtime.bigint() - inicio) / 1e4) / 100,
      ...(typeof req.user?.id === 'number' ? { userId: req.user.id } : {}),
    });
  });
  next();
};
