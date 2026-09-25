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
  /**
   * F12-07 · identificador aleatorio de ESTE token, para poder revocarlo al cerrar sesión. Lo
   * pone `signToken`; los tokens anteriores no lo llevan y caducan solos.
   */
  jti?: string;
  /** Caducidad (segundos desde epoch), la añade `jsonwebtoken` al firmar. */
  exp?: number;
  /**
   * F17C-SEC-10 · momento de emisión (segundos desde epoch), que también pone `jsonwebtoken`.
   * Es lo que se compara con `users.sessions_valid_from` para saber si esta sesión nació antes
   * de una suspensión. Un token anterior a la marca no vuelve a valer aunque la cuenta se
   * reactive. Va en SEGUNDOS, de ahí que la comparación sea estricta.
   */
  iat?: number;
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
  // Solo se firman los datos de sesión: `jti` es siempre nuevo y `exp` lo calcula la librería.
  const { jti: _jti, exp: _exp, ...datos } = payload;
  return jwt.sign(datos, env.jwt.secret, {
    expiresIn: env.jwt.expiresIn,
    jwtid: crypto.randomBytes(16).toString('hex'),
  } as jwt.SignOptions);
}

/**
 * Verifica el token de sesión.
 *
 * `algorithms` se fija explícitamente (auditoría BP-25a). No era explotable —con un secreto
 * de texto, `jsonwebtoken` 9 ya restringe la verificación a HMAC y un `alg: none` o un token
 * firmado con otra clave se rechazan; se comprobó—, pero dejarlo escrito no depende de ese
 * comportamiento por defecto: si algún día el secreto pasara a ser una clave asimétrica o la
 * biblioteca cambiara, la confusión de algoritmos volvería a ser posible. Es exactamente lo
 * que ya se hace, y bien, al verificar el `id_token` de OAuth.
 *
 * `issuer` y `audience` se dejan fuera A PROPÓSITO. Aquí hay un solo emisor y una sola clave
 * simétrica, así que no distinguen nada que la firma no distinga ya; y exigirlos obligaría a
 * emitirlos también al firmar, lo que invalidaría todas las sesiones vivas en el momento del
 * despliegue. Es un cambio con coste operativo y sin ganancia de seguridad en este diseño.
 */
export function verifyToken(token: string): TokenPayload {
  try {
    return jwt.verify(token, env.jwt.secret, { algorithms: ['HS256'] }) as unknown as TokenPayload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) throw ApiError.unauthorized('La sesión ha expirado');
    throw ApiError.unauthorized('Token inválido');
  }
}

/**
 * Vida maxima de un token de sesion, en segundos, tal y como la aplica la libreria.
 *
 * No se interpreta `JWT_EXPIRES_IN` con una expresion regular: se firma un token de usar y
 * tirar y se lee `exp - iat`. Asi el valor es EXACTAMENTE el que usa `jsonwebtoken`, sea
 * cual sea el formato configurado (`8h`, `480m`, un numero de segundos...), y no hay un
 * segundo analizador que pueda discrepar del primero.
 *
 * Se calcula una vez: la configuracion no cambia mientras el proceso vive.
 */
let vidaToken: number | null = null;

export function tokenLifetimeSeconds(): number {
  if (vidaToken === null) {
    const muestra = jwt.sign({ sub: 0 }, env.jwt.secret, { expiresIn: env.jwt.expiresIn } as jwt.SignOptions);
    const { exp, iat } = jwt.decode(muestra) as { exp: number; iat: number };
    vidaToken = Math.max(0, exp - iat);
  }
  return vidaToken;
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
