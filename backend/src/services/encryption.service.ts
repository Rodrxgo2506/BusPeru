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
 * escrito.
 *
 * ROTACIÓN DE CLAVE (F17C-SEC-08). Antes la rotación era, en la práctica, imposible: al cambiar
 * `INTEGRATIONS_ENCRYPTION_KEY` todo lo ya escrito quedaba ilegible para siempre, porque el
 * servicio solo conocía una clave. Ahora admite además una clave ANTERIOR opcional
 * (`INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS`), que **solo se usa para descifrar**. Eso permite el
 * procedimiento habitual y sin pérdida:
 *
 *   1. la clave vigente pasa a `…_PREVIOUS` y se pone una nueva en `INTEGRATIONS_ENCRYPTION_KEY`;
 *   2. lo antiguo se sigue leyendo con la anterior, y todo lo que se escriba usa ya la nueva;
 *   3. cada guardado reescribe ese registro con la clave nueva;
 *   4. cuando no quede nada cifrado con la anterior, se retira `…_PREVIOUS`.
 *
 * Sin esa variable el comportamiento es exactamente el de antes: una sola clave.
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
function parseKey(configured: string, variable: string): Buffer {
  const key = /^[0-9a-fA-F]+$/.test(configured) && configured.length === KEY_BYTES * 2
    ? Buffer.from(configured, 'hex')
    : Buffer.from(configured, 'base64');

  if (key.length !== KEY_BYTES) {
    throw ApiError.serviceUnavailable(
      `${variable} debe tener exactamente ${KEY_BYTES} bytes (64 caracteres hex o 44 en base64)`,
    );
  }
  return key;
}

function encryptionKey(): Buffer {
  const configured = env.integrations.encryptionKey.trim();
  if (!configured) {
    throw ApiError.serviceUnavailable(
      'El cifrado de credenciales no está configurado en este servidor (falta INTEGRATIONS_ENCRYPTION_KEY)',
    );
  }
  return parseKey(configured, 'INTEGRATIONS_ENCRYPTION_KEY');
}

/**
 * Claves con las que se INTENTA descifrar, en orden: primero la vigente y después la anterior,
 * si está configurada. Escribir usa siempre y solo la vigente, de modo que cada reescritura
 * arrastra el dato hacia la clave nueva por sí sola.
 *
 * Una clave anterior mal formada no puede tumbar la lectura de lo que sí es legible con la
 * vigente: se descarta y se sigue.
 */
function decryptionKeys(): Buffer[] {
  const keys = [encryptionKey()];
  const previous = env.integrations.previousEncryptionKey.trim();
  if (previous) {
    try {
      keys.push(parseKey(previous, 'INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS'));
    } catch {
      // Se ignora en silencio a propósito: el detalle no puede viajar al cliente y la
      // alternativa —fallar— dejaría ilegible también lo cifrado con la clave vigente.
    }
  }
  return keys;
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
 * ¿Ese texto tiene pinta de ser uno de nuestros sobres?
 *
 * Sirve para distinguir «aquí no había credenciales» de «aquí hay credenciales que ahora mismo
 * no se pueden leer», que es una diferencia con consecuencias: ver `hasUnreadableCredentials`.
 * No toca criptografía; solo mira la forma.
 */
function parseEnvelope(stored: string): EncryptedEnvelope | null {
  let envelope: EncryptedEnvelope;
  try {
    envelope = JSON.parse(stored) as EncryptedEnvelope;
  } catch {
    return null;
  }
  if (envelope?.alg !== 'AES-256-GCM' || !envelope.iv || !envelope.tag || typeof envelope.data !== 'string') {
    return null;
  }
  // La versión sí se comprueba (SEC-08): el campo existía pero nadie lo miraba, así que un sobre
  // que dijera `v:2` se habría intentado abrir con las reglas de la v1. Un sobre sin `v` se toma
  // como v1, que es lo único que este servicio ha escrito nunca.
  if (envelope.v !== undefined && envelope.v !== VERSION) return null;
  return envelope;
}

/**
 * Descifra un sobre. Devuelve `null` si el contenido no es un sobre reconocible, si la versión
 * no es conocida o si la etiqueta no valida — es decir, si la fila fue manipulada o si ninguna
 * de las claves disponibles es la suya. Nunca lanza hacia el cliente con detalles del fallo
 * criptográfico.
 */
export function decryptJson(stored: string | null): Record<string, unknown> | null {
  if (!stored) return null;

  const envelope = parseEnvelope(stored);
  if (!envelope) return null;

  for (const key of keysOrEmpty()) {
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));

      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
      const parsed = JSON.parse(plaintext.toString('utf8')) as unknown;

      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      // Etiqueta inválida con ESTA clave. Puede que la otra sí sea la suya; si no, se acaba
      // devolviendo null igual que antes.
    }
  }
  return null;
}

/**
 * F18-07A · ¿El sobre abre con la clave VIGENTE, sin recurrir a la anterior? Lo usa la rotación de
 * los datos bancarios para saber qué filas dependen todavía de `INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS`
 * (paso 4 del procedimiento: la anterior solo se retira cuando esto es cierto para todas).
 */
export function isEncryptedWithCurrentKey(stored: string | null): boolean {
  if (!stored) return false;
  const envelope = parseEnvelope(stored);
  if (!envelope) return false;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    return true;
  } catch {
    return false;
  }
}

/** Las claves de descifrado, o ninguna si el servidor no tiene cifrado configurado. */
function keysOrEmpty(): Buffer[] {
  try {
    return decryptionKeys();
  } catch {
    return [];
  }
}

/**
 * Hay un sobre guardado y NINGUNA clave disponible lo abre (F17C-SEC-08, hallazgo SEC08-01).
 *
 * Es la señal de «no lo pises». Quien guarda credenciales conserva los campos que el usuario
 * deja en blanco releyendo los anteriores; si el sobre no se puede leer, esa relectura devuelve
 * lo mismo que un registro vacío —nada— y el guardado escribía encima un sobre nuevo con solo el
 * campo tecleado. Las demás credenciales desaparecían para siempre, sin aviso y sin que
 * recuperar la clave correcta sirviera de nada, porque el ciphertext original ya no estaba.
 *
 * Pasa al cambiar de clave sin re-cifrar, con una clave mal configurada o con una fila alterada.
 */
export function hasUnreadableCredentials(stored: string | null): boolean {
  if (!stored) return false;
  if (!parseEnvelope(stored)) return true;
  return decryptJson(stored) === null;
}
