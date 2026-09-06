import crypto from 'crypto';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';

/**
 * Cifrado de credenciales en reposo (PENDIENTES.md §5).
 *
 * §5 exige que las credenciales de integraciones «se cifren en reposo, nunca se guarden en
 * texto plano». Esta es la única pieza que lo implementa.
 *
 * **AES-256-GCM**, del módulo `crypto` de Node, sin dependencias nuevas. Se eligió GCM
 * frente a CBC porque es cifrado *autenticado*: si alguien manipula una fila de la base, el
 * descifrado falla con error de etiqueta en vez de devolver basura en silencio. Para
 * credenciales que algún día autorizarán cobros, detectar la manipulación importa tanto
 * como la confidencialidad.
 *
 * El sobre es **JSON válido** porque la columna `credentials` lleva `CHECK (json_valid(...))`,
 * tal y como §5 prescribe:
 *
 *   {"v":1,"alg":"AES-256-GCM","iv":"…","tag":"…","data":"…"}
 *
 * El campo `v` deja preparada una futura rotación de clave o de algoritmo sin romper lo ya
 * escrito. La rotación en sí queda fuera de alcance.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const VERSION = 1;

export interface EncryptedEnvelope {
  v: number;
  alg: string;
  iv: string;
  tag: string;
  data: string;
}

/**
 * Clave de 32 bytes desde `INTEGRATIONS_ENCRYPTION_KEY`. Acepta hex o base64 y **exige la
 * longitud exacta**: una clave corta se rechaza, nunca se rellena ni se deriva en silencio.
 *
 * Si falta, el módulo responde 503 igual que hace OAuth con un proveedor sin configurar. No
 * se guarda nada en claro «provisionalmente» y ninguna otra funcionalidad se ve afectada.
 */
function encryptionKey(): Buffer {
  const configured = env.integrations.encryptionKey.trim();
  if (!configured) {
    throw ApiError.serviceUnavailable(
      'El cifrado de credenciales no está configurado en este servidor (falta INTEGRATIONS_ENCRYPTION_KEY)',
    );
  }

  const key = /^[0-9a-fA-F]+$/.test(configured) && configured.length === KEY_BYTES * 2
    ? Buffer.from(configured, 'hex')
    : Buffer.from(configured, 'base64');

  if (key.length !== KEY_BYTES) {
    throw ApiError.serviceUnavailable(
      `INTEGRATIONS_ENCRYPTION_KEY debe tener exactamente ${KEY_BYTES} bytes (64 caracteres hex o 44 en base64)`,
    );
  }
  return key;
}

/** `true` si el servidor puede cifrar. Lo consulta la API para no ofrecer lo que no puede cumplir. */
export function isEncryptionConfigured(): boolean {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

/** Cifra un objeto y devuelve el sobre listo para guardar como JSON. */
export function encryptJson(value: Record<string, unknown>): string {
  const key = encryptionKey();
  // IV nuevo en cada escritura: reutilizarlo en GCM rompe la garantía del cifrado.
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  const envelope: EncryptedEnvelope = {
    v: VERSION,
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
  return JSON.stringify(envelope);
}

/**
 * Descifra un sobre. Devuelve `null` si el contenido no es un sobre reconocible o si la
 * etiqueta no valida — es decir, si la fila fue manipulada. Nunca lanza hacia el cliente con
 * detalles del fallo criptográfico.
 */
export function decryptJson(stored: string | null): Record<string, unknown> | null {
  if (!stored) return null;

  let envelope: EncryptedEnvelope;
  try {
    envelope = JSON.parse(stored) as EncryptedEnvelope;
  } catch {
    return null;
  }
  if (envelope?.alg !== 'AES-256-GCM' || !envelope.iv || !envelope.tag || typeof envelope.data !== 'string') {
    return null;
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));

    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString('utf8')) as unknown;

    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Etiqueta inválida (fila manipulada) o clave equivocada. En ambos casos, sin contenido.
    return null;
  }
}
