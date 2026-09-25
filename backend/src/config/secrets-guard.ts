/**
 * Fortaleza de los secretos en producción (auditoría final FASE 12, hallazgo F12-08).
 *
 * `env.ts` solo exigía que `JWT_SECRET` existiera: una cadena de un carácter servía para firmar
 * sesiones en producción. Aquí se valida, SOLO con `NODE_ENV=production`, antes de abrir nada:
 *
 *   · JWT_SECRET: al menos 32 caracteres y 10 distintos (descarta «aaaa…» y marcadores obvios).
 *   · INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS: opcional, solo durante una rotación. Mismas reglas de
 *     formato, y no puede coincidir con la vigente.
 *   · INTEGRATIONS_ENCRYPTION_KEY: opcional —sin ella el módulo de integraciones responde 503 y
 *     no guarda nada—, pero si está definida tiene que ser EXACTAMENTE lo que usa AES-256-GCM en
 *     `encryption.service.ts`: 32 bytes, como 64 caracteres hex o base64 canónico (44 caracteres).
 *     Una clave mal formada haría fallar cada cifrado en caliente; mejor no arrancar.
 *
 * Desarrollo y test no cambian. Los mensajes nombran la variable y la regla, nunca el valor.
 */

export class InsecureSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsecureSecretError';
  }
}

export const JWT_SECRET_MIN_LENGTH = 32;
export const JWT_SECRET_MIN_DISTINCT_CHARS = 10;
const ENCRYPTION_KEY_BYTES = 32;

/** ¿Es una clave de 32 bytes en hex (64 caracteres) o en base64 canónico? Estricto: sin relleno inventado. */
export function isValidEncryptionKey(value: string): boolean {
  const clave = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(clave)) return true;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(clave)) return false;
  const bytes = Buffer.from(clave, 'base64');
  return bytes.length === ENCRYPTION_KEY_BYTES && bytes.toString('base64') === clave;
}

export function assertProductionSecrets(input: {
  nodeEnv: string;
  jwtSecret: string;
  encryptionKey: string;
  /** Clave anterior durante una rotacion (F17C-SEC-08). Opcional, pero si esta debe ser valida. */
  previousEncryptionKey?: string;
}): void {
  if (input.nodeEnv !== 'production') return;

  const problemas: string[] = [];
  const jwt = input.jwtSecret;
  if (jwt.trim().length < JWT_SECRET_MIN_LENGTH || new Set(jwt).size < JWT_SECRET_MIN_DISTINCT_CHARS) {
    problemas.push(
      `JWT_SECRET es demasiado débil para producción: usa al menos ${JWT_SECRET_MIN_LENGTH} caracteres aleatorios (${JWT_SECRET_MIN_DISTINCT_CHARS} distintos como mínimo).`,
    );
  }
  if (input.encryptionKey.trim() !== '' && !isValidEncryptionKey(input.encryptionKey)) {
    problemas.push('INTEGRATIONS_ENCRYPTION_KEY no es válida: debe ser una clave de 32 bytes en hex (64 caracteres) o base64 (44 caracteres).');
  }
  // La clave anterior se valida igual: puesta a medias, una rotación dejaría de leer lo viejo
  // sin que nadie se entere hasta que alguien abra una integración.
  const anterior = (input.previousEncryptionKey ?? '').trim();
  if (anterior !== '' && !isValidEncryptionKey(anterior)) {
    problemas.push('INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS no es válida: debe ser una clave de 32 bytes en hex (64 caracteres) o base64 (44 caracteres).');
  }
  if (anterior !== '' && anterior === input.encryptionKey.trim()) {
    problemas.push('INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS no puede ser igual a INTEGRATIONS_ENCRYPTION_KEY: entonces no hay rotación que completar.');
  }
  if (problemas.length > 0) throw new InsecureSecretError(`Configuración insegura para producción. ${problemas.join(' ')}`);
}
