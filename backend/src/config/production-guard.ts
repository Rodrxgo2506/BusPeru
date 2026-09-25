import net from 'net';

/**
 * Configuración de producción (auditoría pre-producción FASE 15, hallazgos F15-04, F15-05 y F15-11).
 *
 * `env.ts` tiene valores por defecto pensados para una máquina de desarrollo: `localhost`, el
 * usuario `root` sin contraseña, el transporte de correo `log`, el remitente de pruebas de Resend…
 * Fuera de producción siguen siendo cómodos y NO cambian. Con `NODE_ENV=production`, en cambio,
 * un valor ausente no puede convertirse en silencio en uno de esos defaults: aquí se exige que
 * cada variable crítica esté DEFINIDA de forma explícita y tenga una forma razonable.
 *
 * Se valida a partir del entorno crudo (`process.env`), no del objeto `env` ya resuelto, porque
 * lo que importa es precisamente si la variable venía o si se rellenó con un default.
 *
 * Igual que `secrets-guard.ts`: se acumulan todos los problemas y se lanza una sola vez, y los
 * mensajes nombran la variable y la regla, NUNCA el valor.
 */

export class ProductionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductionConfigError';
  }
}

type RawEnv = Readonly<Record<string, string | undefined>>;

/** Remitente de pruebas de Resend: solo entrega al dueño de la cuenta. Nunca en producción. */
export const RESEND_SANDBOX_DOMAIN = 'resend.dev';

export const CULQI_WEBHOOK_SECRET_MIN_LENGTH = 32;

/** Extremos OAuth sustituibles solo para apuntar la suite a un proveedor de prueba. */
export const OAUTH_ENDPOINT_OVERRIDES = [
  'GOOGLE_ISSUER',
  'GOOGLE_AUTH_URL',
  'GOOGLE_TOKEN_URL',
  'GOOGLE_JWKS_URI',
  'MICROSOFT_ISSUER',
  'MICROSOFT_AUTH_URL',
  'MICROSOFT_TOKEN_URL',
  'MICROSOFT_JWKS_URI',
] as const;

/** Variables numéricas: en producción, si se definen, enteros positivos. */
const POSITIVE_INTEGERS = [
  'PORT',
  'DB_PORT',
  'BOOKING_EXPIRY_INTERVAL_MS',
  'RATE_LIMIT_GLOBAL',
  'RATE_LIMIT_AUTH',
  'MAIL_PORT',
  'CULQI_TIMEOUT_MS',
  'PASSWORD_RESET_CODE_TTL_MINUTES',
  'PASSWORD_RESET_TICKET_TTL_MINUTES',
  'PASSWORD_RESET_MAX_ATTEMPTS',
  'OAUTH_STATE_TTL_SECONDS',
  'OAUTH_TICKET_TTL_SECONDS',
] as const;

const TRUST_PROXY_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);
const MAX_TRUST_PROXY_HOPS = 10;

/** Valor que acepta `app.set('trust proxy', …)`. */
export type TrustProxySetting = false | number | string[];

/**
 * Interpreta TRUST_PROXY (F15-05). Devuelve `null` si el valor no es válido.
 *
 *   · vacío o ausente → `false`: no se confía en `X-Forwarded-For`; la IP es la del socket.
 *   · `false` / `0`   → `false`.
 *   · `1`..`10`       → número de proxies de confianza delante de la app.
 *   · lista separada por comas de IPs, CIDR o `loopback` / `linklocal` / `uniquelocal`.
 *
 * `true` se RECHAZA a propósito: confiaría en cualquier `X-Forwarded-For`, así que cualquier
 * cliente podría fijarse la IP que quisiera y saltarse el rate limit.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxySetting | null {
  const valor = (raw ?? '').trim();
  if (valor === '' || valor.toLowerCase() === 'false' || valor === '0') return false;
  if (/^\d+$/.test(valor)) {
    const saltos = Number(valor);
    return saltos >= 1 && saltos <= MAX_TRUST_PROXY_HOPS ? saltos : null;
  }
  const partes = valor.split(',').map((parte) => parte.trim());
  const valida = (parte: string): boolean => {
    if (TRUST_PROXY_NAMES.has(parte)) return true;
    const [ip, mascara, sobra] = parte.split('/');
    if (sobra !== undefined || ip === undefined) return false;
    const version = net.isIP(ip);
    if (version === 0) return false;
    if (mascara === undefined) return true;
    if (!/^\d+$/.test(mascara)) return false;
    return Number(mascara) <= (version === 4 ? 32 : 128);
  };
  return partes.length > 0 && partes.every(valida) ? partes : null;
}

function defined(source: RawEnv, key: string): boolean {
  return (source[key] ?? '').trim() !== '';
}

function publicHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
  return url.protocol === 'https:' && !local;
}

/** Dirección del remitente, aceptando `Nombre <correo@dominio>` o `correo@dominio`. */
function senderAddress(value: string): string | null {
  const conNombre = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value.trim());
  const direccion = conNombre?.[1] ?? value.trim();
  return /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(direccion) ? direccion.toLowerCase() : null;
}

export function assertProductionConfig(source: RawEnv): void {
  if (source.NODE_ENV !== 'production') return;

  const problemas: string[] = [];
  const exigir = (key: string, regla = 'debe definirse explícitamente en producción') => {
    if (!defined(source, key)) problemas.push(`${key} ${regla}.`);
  };

  // --- Base de datos: sin localhost/root/contraseña vacía por omisión. ---------------------
  for (const key of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD']) exigir(key);
  if (defined(source, 'DB_USER') && source.DB_USER?.trim().toLowerCase() === 'root') {
    problemas.push('DB_USER no puede ser root en producción: usa un usuario dedicado con privilegios mínimos.');
  }

  // --- Frontend (CORS) y proxy. -----------------------------------------------------------
  exigir('FRONTEND_URL');
  if (defined(source, 'FRONTEND_URL') && !publicHttpsUrl(source.FRONTEND_URL ?? '')) {
    problemas.push('FRONTEND_URL debe ser una URL https pública (no localhost) en producción.');
  }
  exigir('TRUST_PROXY', 'debe definirse explícitamente en producción (false si no hay proxy, o el número de proxies / sus IPs)');
  if (defined(source, 'TRUST_PROXY') && parseTrustProxy(source.TRUST_PROXY) === null) {
    problemas.push('TRUST_PROXY no es válido: usa false, un número de proxies entre 1 y 10, o una lista de IPs/CIDR (true no se admite).');
  }

  // --- OAuth: solo si algún proveedor está configurado. -----------------------------------
  const proveedores: Array<[string, string, string]> = [
    ['Google', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    ['Microsoft', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
  ];
  let oauthHabilitado = false;
  for (const [nombre, id, secreto] of proveedores) {
    if (defined(source, id) || defined(source, secreto)) {
      oauthHabilitado = true;
      if (!defined(source, id) || !defined(source, secreto)) {
        problemas.push(`OAuth ${nombre}: ${id} y ${secreto} deben definirse juntos.`);
      }
    }
  }
  if (oauthHabilitado) {
    exigir('OAUTH_CALLBACK_BASE_URL', 'debe definirse explícitamente en producción cuando OAuth está habilitado');
    if (defined(source, 'OAUTH_CALLBACK_BASE_URL') && !publicHttpsUrl(source.OAUTH_CALLBACK_BASE_URL ?? '')) {
      problemas.push('OAUTH_CALLBACK_BASE_URL debe ser una URL https pública (no localhost) en producción.');
    }
  }
  for (const key of OAUTH_ENDPOINT_OVERRIDES) {
    if (defined(source, key)) problemas.push(`${key} no puede definirse en producción: solo existe para proveedores de prueba.`);
  }

  // --- Correo. ------------------------------------------------------------------------------
  const transporte = (source.MAIL_TRANSPORT ?? '').trim();
  if (transporte !== 'resend' && transporte !== 'smtp') {
    problemas.push('MAIL_TRANSPORT debe ser "resend" o "smtp" en producción.');
  }
  if (transporte === 'resend') {
    exigir('RESEND_API_KEY', 'es obligatoria con MAIL_TRANSPORT=resend');
    exigir('RESEND_FROM_EMAIL', 'es obligatoria con MAIL_TRANSPORT=resend');
    if (defined(source, 'RESEND_FROM_EMAIL')) {
      const direccion = senderAddress(source.RESEND_FROM_EMAIL ?? '');
      if (direccion === null) problemas.push('RESEND_FROM_EMAIL no tiene formato de remitente válido.');
      else if (direccion.endsWith(`@${RESEND_SANDBOX_DOMAIN}`)) {
        problemas.push(`RESEND_FROM_EMAIL no puede usar el dominio de pruebas ${RESEND_SANDBOX_DOMAIN} en producción: verifica un dominio propio.`);
      }
    }
  }
  if (transporte === 'smtp') {
    exigir('MAIL_HOST', 'es obligatoria con MAIL_TRANSPORT=smtp');
    exigir('MAIL_FROM', 'es obligatoria con MAIL_TRANSPORT=smtp');
    if (defined(source, 'MAIL_FROM') && senderAddress(source.MAIL_FROM ?? '') === null) {
      problemas.push('MAIL_FROM no tiene formato de remitente válido.');
    }
  }

  // --- Culqi: solo si los pagos con tarjeta están habilitados (alguna llave definida). -----
  if (defined(source, 'CULQI_PUBLIC_KEY') || defined(source, 'CULQI_PRIVATE_KEY')) {
    exigir('CULQI_PUBLIC_KEY', 'es obligatoria cuando Culqi está habilitado');
    exigir('CULQI_PRIVATE_KEY', 'es obligatoria cuando Culqi está habilitado');
    exigir('CULQI_WEBHOOK_SECRET', 'es obligatoria cuando Culqi está habilitado');
    const publica = (source.CULQI_PUBLIC_KEY ?? '').trim();
    const privada = (source.CULQI_PRIVATE_KEY ?? '').trim();
    const modoPublica = /^pk_(test|live)_/.exec(publica)?.[1];
    const modoPrivada = /^sk_(test|live)_/.exec(privada)?.[1];
    if (publica !== '' && modoPublica === undefined) problemas.push('CULQI_PUBLIC_KEY no tiene el formato de una llave pública de Culqi.');
    if (privada !== '' && modoPrivada === undefined) problemas.push('CULQI_PRIVATE_KEY no tiene el formato de una llave privada de Culqi.');
    if (modoPublica !== undefined && modoPrivada !== undefined && modoPublica !== modoPrivada) {
      problemas.push('CULQI_PUBLIC_KEY y CULQI_PRIVATE_KEY deben ser del mismo entorno (ambas test o ambas live).');
    }
    if (defined(source, 'CULQI_WEBHOOK_SECRET') && (source.CULQI_WEBHOOK_SECRET ?? '').trim().length < CULQI_WEBHOOK_SECRET_MIN_LENGTH) {
      problemas.push(`CULQI_WEBHOOK_SECRET debe tener al menos ${CULQI_WEBHOOK_SECRET_MIN_LENGTH} caracteres aleatorios.`);
    }
  }
  if (defined(source, 'CULQI_API_URL') && !publicHttpsUrl(source.CULQI_API_URL ?? '')) {
    problemas.push('CULQI_API_URL debe ser una URL https pública en producción.');
  }

  // --- Numéricas: un valor mal escrito se volvería NaN en silencio. ------------------------
  for (const key of POSITIVE_INTEGERS) {
    if (defined(source, key) && !/^[1-9]\d*$/.test((source[key] ?? '').trim())) {
      problemas.push(`${key} debe ser un entero positivo.`);
    }
  }

  if (problemas.length > 0) {
    throw new ProductionConfigError(`Configuración incompleta o insegura para producción. ${problemas.join(' ')}`);
  }
}
