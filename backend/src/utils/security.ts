import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { ApiError } from './ApiError';

const SALT_ROUNDS = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface TokenPayload {
  sub: number;
  roleId: number;
  role: string;
  /**
   * Huella de la credencial con la que se emitió la sesión. Ver `sessionFingerprint`.
   * Un token sin esta marca —emitido antes de que existiera— deja de ser válido.
   */
  pwd?: string;
}

/**
 * Huella de la contraseña vigente, para poder invalidar sesiones sin guardar estado.
 *
 * El JWT es sin estado y vive 8 horas, así que cambiar la contraseña no expulsaba a nadie:
 * justo la acción que ejecuta quien sospecha que le han robado la sesión no servía para
 * nada. Guardar aquí una huella del `password_hash` y compararla en cada petición cierra
 * eso sin lista de revocación, sin Redis y sin columnas nuevas: al cambiar la contraseña
 * cambia el hash, y con él la huella, de modo que todos los tokens anteriores dejan de
 * validar. El hash de bcrypt ya es distinto en cada cambio aunque la contraseña se repita.
 *
 * No se guarda el hash en el token: solo un derivado corto, ligado además al secreto de la
 * instalación. Del contenido del token no se puede reconstruir la credencial.
 */
export function sessionFingerprint(passwordHash: string): string {
  return crypto.createHash('sha256').update(`${passwordHash}:${env.jwt.secret}`).digest('hex').slice(0, 32);
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.jwt.secret, { expiresIn: env.jwt.expiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload {
  try {
    return jwt.verify(token, env.jwt.secret) as unknown as TokenPayload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) throw ApiError.unauthorized('La sesión ha expirado');
    throw ApiError.unauthorized('Token inválido');
  }
}

export function randomCode(prefix: string, length = 6): string {
  const digits = crypto.randomInt(0, 10 ** length).toString().padStart(length, '0');
  return `${prefix}-${digits}`;
}

export function generateApiKey(): { plain: string; prefix: string; hash: string } {
  const prefix = `bp_${crypto.randomBytes(4).toString('hex')}`;
  const secret = crypto.randomBytes(24).toString('hex');
  const plain = `${prefix}.${secret}`;
  return { plain, prefix, hash: crypto.createHash('sha256').update(plain).digest('hex') };
}
