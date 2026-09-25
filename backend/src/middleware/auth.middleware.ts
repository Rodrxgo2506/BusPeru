import type { NextFunction, Request, Response } from 'express';
import { findPasswordHash, loadAuthenticatedUser } from '../repositories/user.repository';
import { ApiError } from '../utils/ApiError';
import { isSessionRevoked } from '../services/session-revocation.service';
import { sessionFingerprint, verifyToken, type TokenPayload } from '../utils/security';

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

/**
 * Comprueba que la sesión siga atada a la credencial con la que se emitió.
 *
 * El JWT es sin estado y dura 8 horas, de modo que hasta ahora cambiar la contraseña no
 * expulsaba a nadie: quien tuviera un token robado seguía dentro aunque su víctima
 * reaccionara. Comparar la huella del `password_hash` vigente cierra eso sin lista de
 * revocación ni almacenamiento adicional.
 *
 * Un token emitido antes de que existiera la huella no la lleva y deja de valer: obliga a
 * iniciar sesión otra vez una sola vez, al desplegar.
 */
async function assertSessionIsCurrent(payload: TokenPayload): Promise<void> {
  const passwordHash = await findPasswordHash(payload.sub);
  if (!passwordHash || payload.pwd !== sessionFingerprint(passwordHash)) {
    throw ApiError.unauthorized('Tu sesión ya no es válida. Vuelve a iniciar sesión.');
  }
  // F12-07: un token cerrado con `POST /auth/logout` no vuelve a entrar.
  if (typeof payload.jti === 'string' && (await isSessionRevoked(payload.jti))) {
    throw ApiError.unauthorized('Tu sesión se cerró. Vuelve a iniciar sesión.');
  }
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) throw ApiError.unauthorized('Debes iniciar sesión para continuar');

    const payload = verifyToken(token);
    const user = await loadAuthenticatedUser(payload.sub);
    // Una cuenta borrada o desactivada corta el acceso en la petición siguiente: el rol, el
    // estado y los permisos se releen de la base en cada llamada, nunca del token.
    if (!user) throw ApiError.unauthorized('La cuenta ya no existe');
    if (user.status !== 'ACTIVE') throw ApiError.forbidden('Tu cuenta no está activa. Contacta con soporte.');
    await assertSessionIsCurrent(payload);

    req.user = user;
    req.session = { jti: typeof payload.jti === 'string' ? payload.jti : null, exp: typeof payload.exp === 'number' ? payload.exp : null };
    next();
  } catch (error) {
    next(error);
  }
}

/** Attaches the user when a valid token is present, but never rejects the request. */
export async function optionalAuthenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  if (!token) return next();

  try {
    const payload = verifyToken(token);
    const user = await loadAuthenticatedUser(payload.sub);
    if (user && user.status === 'ACTIVE') {
      // La misma comprobación que en la ruta protegida: una sesión invalidada no debe
      // colarse como usuario identificado en un endpoint público.
      await assertSessionIsCurrent(payload);
      req.user = user;
    }
  } catch {
    // An invalid token on a public route is simply treated as anonymous.
  }
  next();
}

export function requireAuth(req: Request): NonNullable<Request['user']> {
  if (!req.user) throw ApiError.unauthorized();
  return req.user;
}
