import type { NextFunction, Request, Response } from 'express';
import { loadAuthenticatedUser } from '../repositories/user.repository';
import { ApiError } from '../utils/ApiError';
import { verifyToken } from '../utils/security';

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) throw ApiError.unauthorized('Debes iniciar sesión para continuar');

    const payload = verifyToken(token);
    const user = await loadAuthenticatedUser(payload.sub);
    if (!user) throw ApiError.unauthorized('La cuenta ya no existe');
    if (user.status !== 'ACTIVE') throw ApiError.forbidden('Tu cuenta no está activa. Contacta con soporte.');

    req.user = user;
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
    if (user && user.status === 'ACTIVE') req.user = user;
  } catch {
    // An invalid token on a public route is simply treated as anonymous.
  }
  next();
}

export function requireAuth(req: Request): NonNullable<Request['user']> {
  if (!req.user) throw ApiError.unauthorized();
  return req.user;
}
