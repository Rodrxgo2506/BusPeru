import crypto from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Identificador de petición (auditoría BP-17).
 *
 * Sirve para unir lo que quedó registrado en el servidor con lo que vio el usuario: cuando
 * algo falla, la respuesta lleva el mismo `request_id` que la línea del registro, así que
 * basta con que alguien lo copie para encontrar su traza.
 *
 * Se genera SIEMPRE en el servidor y no se acepta del cliente aunque lo envíe. Confiar en
 * una cabecera entrante permitiría que dos peticiones distintas compartieran identificador
 * —a propósito o por error— y ensuciaría el registro con un valor que el usuario controla.
 */
export const REQUEST_ID_HEADER = 'X-Request-Id';

export const attachRequestId: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  req.id = crypto.randomUUID();
  // Se devuelve en TODAS las respuestas, no solo en los errores: también sirve para seguir
  // una petición correcta a través de los registros de un proxy.
  res.setHeader(REQUEST_ID_HEADER, req.id);
  next();
};
