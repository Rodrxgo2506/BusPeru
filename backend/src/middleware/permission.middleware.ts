import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError } from '../utils/ApiError';
import type { RoleName } from '../types/entities';

/**
 * Authorization is driven by the roles -> role_permissions -> permissions tables,
 * never by a hardcoded role comparison.
 */
export function requirePermission(...permissions: string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(ApiError.unauthorized());
    const granted = permissions.some((permission) => req.user!.permissions.includes(permission));
    if (!granted) {
      return next(ApiError.forbidden(`Se requiere el permiso: ${permissions.join(' o ')}`));
    }
    next();
  };
}

export function requireRole(...roles: RoleName[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(ApiError.forbidden('Tu rol no tiene acceso a esta sección'));
    }
    next();
  };
}

export function hasPermission(req: Request, permission: string): boolean {
  return req.user?.permissions.includes(permission) ?? false;
}
