import { env } from '../config/env';

/**
 * Saneado de lo que se escribe en los registros (auditoría 11F, hallazgo H-31).
 *
 * EL PROBLEMA. El manejador central de errores registraba `req.originalUrl` en cada 5xx. Por la
 * URL viajan valores que nunca deben quedar en un log:
 *   · el secreto del webhook de Culqi, que es un SEGMENTO de la ruta (`/culqi/webhook/<secreto>`);
 *   · el `code` y el `state` del callback OAuth, el `ticket` que se canjea por la sesión, códigos
 *     de recuperación y, en general, cualquier token que un cliente ponga en la query.
 *
 * TRES CAPAS, DE MÁS CONCRETA A MÁS GENERAL:
 *   1. `sanitizeUrl`: la ruta del webhook pierde su secreto, los parámetros de nombre sensible
 *      pierden su valor y cualquier valor con forma de token (largo y sin espacios) también.
 *   2. `redactKnownSecrets`: cualquier aparición literal de un secreto CONFIGURADO (llaves de
 *      Culqi, secreto del webhook, JWT, contraseñas de BD y correo, secretos OAuth, clave de
 *      cifrado) se sustituye, esté donde esté: mensaje, traza o contexto.
 *   3. El contexto de `logError` sigue siendo una lista cerrada (sin cuerpo ni cabeceras).
 *
 * Se conserva lo útil para diagnosticar: método, ruta con sus ids, parámetros inocuos (`page`,
 * `status`, fechas), estado, usuario e identificador de la petición.
 */

export const REDACTED = '[REDACTED]';

/** Nombres de parámetro cuyo valor nunca se registra. Se compara sin mayúsculas y por inclusión. */
const SENSITIVE_PARAM = /(code|state|ticket|token|secret|password|passwd|pwd|key|signature|cvv|cvc|card|otp|nonce|verifier|session|jwt|credential|assertion)/i;

/** Un valor con forma de token: 24+ caracteres de alfabeto de token, sin espacios. */
const TOKEN_LIKE = /^[A-Za-z0-9._~+/=-]{24,}$/;

/** Rutas con un secreto en un segmento: se conserva el prefijo y se oculta lo que sigue. */
const SECRET_PATH_PREFIXES = ['/culqi/webhook/'];

function sanitizePath(path: string): string {
  let resultado = path;
  for (const prefijo of SECRET_PATH_PREFIXES) {
    const i = resultado.indexOf(prefijo);
    if (i >= 0) {
      const resto = resultado.slice(i + prefijo.length);
      const fin = resto.indexOf('/');
      resultado = `${resultado.slice(0, i + prefijo.length)}${REDACTED}${fin >= 0 ? resto.slice(fin) : ''}`;
    }
  }
  // Un segmento con forma de token también se oculta (los ids de BusPerú son numéricos o códigos cortos).
  return resultado
    .split('/')
    .map((segmento) => {
      let decodificado = segmento;
      try {
        decodificado = decodeURIComponent(segmento);
      } catch {
        // Un segmento mal codificado se evalúa tal cual.
      }
      return TOKEN_LIKE.test(decodificado) ? REDACTED : segmento;
    })
    .join('/');
}

/** URL apta para un registro: ruta sin secretos y query con los valores sensibles ocultos. */
export function sanitizeUrl(url: string | undefined | null): string {
  if (!url) return '';
  const hash = url.indexOf('#');
  const sinHash = hash >= 0 ? url.slice(0, hash) : url;
  const q = sinHash.indexOf('?');
  const path = sanitizePath(q >= 0 ? sinHash.slice(0, q) : sinHash);
  if (q < 0) return path;

  const partes = sinHash
    .slice(q + 1)
    .split('&')
    .filter((parte) => parte.length > 0)
    .map((parte) => {
      const igual = parte.indexOf('=');
      const nombreCrudo = igual >= 0 ? parte.slice(0, igual) : parte;
      const valorCrudo = igual >= 0 ? parte.slice(igual + 1) : '';
      let nombre = nombreCrudo;
      let valor = valorCrudo;
      try {
        nombre = decodeURIComponent(nombreCrudo.replace(/\+/g, ' '));
        valor = decodeURIComponent(valorCrudo.replace(/\+/g, ' '));
      } catch {
        // Si no se puede decodificar, se evalúa el texto crudo.
      }
      if (igual < 0) return nombreCrudo;
      if (SENSITIVE_PARAM.test(nombre) || TOKEN_LIKE.test(valor)) return `${nombreCrudo}=${REDACTED}`;
      return parte;
    });
  return partes.length > 0 ? `${path}?${partes.join('&')}` : path;
}

/** Secretos configurados en este proceso. Los vacíos y los demasiado cortos no se consideran. */
function knownSecrets(): string[] {
  const valores = [
    env.culqi.privateKey,
    env.culqi.webhookSecret,
    env.jwt.secret,
    env.db.password,
    env.mail.password,
    env.oauth.google.clientSecret,
    env.oauth.microsoft.clientSecret,
    env.integrations.encryptionKey,
    env.integrations.previousEncryptionKey,
    env.resend.apiKey,
  ];
  // Un secreto de menos de 6 caracteres sustituiría trozos de texto normal; no se busca.
  return [...new Set(valores.filter((valor): valor is string => typeof valor === 'string' && valor.length >= 6))].sort((a, b) => b.length - a.length);
}

/** Sustituye cualquier aparición literal de un secreto configurado. */
export function redactKnownSecrets(texto: string): string {
  let resultado = texto;
  for (const secreto of knownSecrets()) {
    if (resultado.includes(secreto)) resultado = resultado.split(secreto).join(REDACTED);
  }
  return resultado;
}
