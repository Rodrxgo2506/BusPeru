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
