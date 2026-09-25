import dotenv from 'dotenv';
import path from 'path';
import { assertDatabaseAllowedForEnvironment } from './database-guard';
import { assertProductionConfig, parseTrustProxy, type TrustProxySetting } from './production-guard';
import { assertProductionSecrets } from './secrets-guard';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// F15-04: en producción, antes de resolver ningún default, cada variable crítica tiene que venir
// definida. Fuera de producción no hace nada y los defaults locales siguen funcionando.
assertProductionConfig(process.env);

/** TRUST_PROXY ya validado; fuera de producción un valor inválido también se rechaza (F15-05). */
function trustProxy(): TrustProxySetting {
  const parsed = parseTrustProxy(process.env.TRUST_PROXY);
  if (parsed === null) {
    throw new Error('TRUST_PROXY no es válido: usa false, un número de proxies entre 1 y 10, o una lista de IPs/CIDR (true no se admite).');
  }
  return parsed;
}

/**
 * ORIGEN del frontend, en la forma EXACTA que exige CORS (F17C-SEC-07, hallazgo SEC07-01).
 *
 * `Access-Control-Allow-Origin` se compara carácter a carácter contra el `Origin` que envía el
 * navegador, y ese `Origin` es siempre `esquema://host[:puerto]`: sin barra final y sin ruta.
 * `FRONTEND_URL`, en cambio, es una URL que también sirve de base para el redirect de OAuth, así
 * que escribirla como `https://dominio.pe/` es natural —y la guarda de producción la acepta, con
 * razón—. Pero pasada tal cual a `cors()` produce `ACAO: https://dominio.pe/`, que NO coincide con
 * `Origin: https://dominio.pe` y el navegador rechaza TODAS las respuestas: la aplicación entera
 * deja de funcionar en producción por una barra.
 *
 * Aquí se normaliza una sola vez. No afecta a la seguridad —el origen sigue siendo uno explícito,
 * nunca `*` ni un reflejo del `Origin` recibido—, solo evita que un detalle de escritura de la
 * variable tumbe el sitio. Si el valor no es una URL interpretable se devuelve tal cual: en
 * producción `assertProductionConfig` ya lo habría rechazado, y en desarrollo vale más arrancar
 * con un origen raro que no arrancar.
 */
function corsOrigin(frontendUrl: string): string {
  try {
    return new URL(frontendUrl).origin;
  } catch {
    return frontendUrl;
  }
}

function required(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Falta la variable de entorno obligatoria: ${key}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  db: {
    host: required('DB_HOST', 'localhost'),
    port: Number(process.env.DB_PORT ?? 3306),
    // Sin valor por defecto (FASE 11F-0): antes, un DB_NAME ausente se convertía en `busperu`,
    // la base real. Ahora falta y se dice.
    name: required('DB_NAME'),
    user: required('DB_USER', 'root'),
    password: process.env.DB_PASSWORD ?? '',
  },
  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  },
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  /** Mismo sitio que `frontendUrl`, pero como ORIGEN puro: es lo único que CORS puede comparar. */
  corsOrigin: corsOrigin(process.env.FRONTEND_URL ?? 'http://localhost:5173'),
  /**
   * `trust proxy` de Express (F15-05). Por defecto `false`: no se confía en `X-Forwarded-For`,
   * así que ningún cliente puede fijarse la IP con la que se aplica el rate limit. Detrás de un
   * proxy inverso hay que declararlo (número de saltos o IPs del proxy); en producción es obligatorio.
   */
  trustProxy: trustProxy(),
  /** Cada cuánto se revisan las reservas PENDING vencidas. */
  bookingExpiryIntervalMs: Number(process.env.BOOKING_EXPIRY_INTERVAL_MS ?? 60_000),
  rateLimit: {
    /** Peticiones por minuto sobre toda la API. */
    global: Number(process.env.RATE_LIMIT_GLOBAL ?? 300),
    /** Intentos por ventana de 15 minutos sobre /auth. */
    auth: Number(process.env.RATE_LIMIT_AUTH ?? 20),
  },
  mail: {
    /**
     * `log` imprime en consola (solo desarrollo); `smtp` y `resend` envían de verdad;
     * `memory` retiene los mensajes y solo lo usa la suite.
     */
    transport: (process.env.MAIL_TRANSPORT ?? 'log') as 'log' | 'smtp' | 'resend' | 'memory',
    host: process.env.MAIL_HOST ?? '',
    port: Number(process.env.MAIL_PORT ?? 587),
    secure: process.env.MAIL_SECURE === 'true',
    user: process.env.MAIL_USER ?? '',
    password: process.env.MAIL_PASSWORD ?? '',
    from: process.env.MAIL_FROM ?? 'BusPeru <no-reply@busperu.com>',
  },
  /**
   * Resend, el proveedor de correo transaccional.
   *
   * La clave se lee EXCLUSIVAMENTE del entorno y no tiene valor por defecto: sin ella el
   * transporte `resend` no arranca y lo dice, en vez de fingir que envía. No es `required()`
   * a propósito —eso rompe el arranque de la suite y de cualquier despliegue que todavía no
   * use Resend—; el transporte comprueba su presencia solo cuando se le pide enviar.
   *
   * `from` apunta por defecto al remitente de pruebas que Resend permite sin dominio
   * verificado, SOLO fuera de producción: en producción `production-guard.ts` exige
   * RESEND_FROM_EMAIL explícito y rechaza el dominio de pruebas (F15-11).
   */
  /**
   * Culqi, la pasarela de pago (modelo AGREGADOR: cobra BusPerú con UNA cuenta de
   * plataforma y después liquida a cada empresa con las comisiones y liquidaciones que ya
   * existen). El módulo `company_integrations` sigue guardando credenciales CULQI por
   * empresa para el panel, pero NO se usa para cobrar: son dos cosas distintas a propósito.
   *
   * `privateKey` no sale JAMAS del backend. `publicKey` sí se publica: la necesita el
   * navegador para tokenizar la tarjeta contra Culqi sin que los datos pasen por BusPerú.
   * Ninguna de las dos tiene valor por defecto y ninguna es `required()`: sin ellas el
   * proceso arranca igual y solo falla el cobro con tarjeta, diciendo lo que falta.
   */
  culqi: {
    publicKey: process.env.CULQI_PUBLIC_KEY ?? '',
    privateKey: process.env.CULQI_PRIVATE_KEY ?? '',
    /** Base de la API v2. Variable solo para poder apuntarla a un doble en pruebas. */
    apiUrl: process.env.CULQI_API_URL ?? 'https://api.culqi.com/v2',
    /**
     * Secreto compartido del webhook. Culqi NO publica un esquema de firma HMAC, así que
     * este valor lo eliges tú y lo pones en la URL que registras en CulqiPanel. Es un
     * cerrojo de puerta, no la prueba del pago: esa se obtiene releyendo el cargo contra
     * la API de Culqi. Ver `culqi-webhook.routes.ts`.
     */
    webhookSecret: process.env.CULQI_WEBHOOK_SECRET ?? '',
    /** Milisegundos antes de cortar una llamada a Culqi. Un cobro no puede colgarse. */
    timeoutMs: Number(process.env.CULQI_TIMEOUT_MS ?? 20_000),
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY ?? '',
    from: process.env.RESEND_FROM_EMAIL ?? 'BusPerú <onboarding@resend.dev>',
  },
  storage: {
    /**
     * Directorio PRIVADO donde se guardan los documentos subidos. Debe quedar fuera del
     * frontend y fuera de cualquier ruta servida estáticamente: los archivos solo se
     * entregan por endpoints que validan sesión y empresa.
     */
    dir: process.env.STORAGE_DIR ?? 'storage',
  },
  passwordReset: {
    /** Minutos de validez del código de 6 dígitos (mockup 10: 15 minutos). */
    codeTtlMinutes: Number(process.env.PASSWORD_RESET_CODE_TTL_MINUTES ?? 15),
    /** Minutos de validez del ticket que emite la verificación. */
    ticketTtlMinutes: Number(process.env.PASSWORD_RESET_TICKET_TTL_MINUTES ?? 10),
    /** Intentos fallidos antes de invalidar el código. */
    maxAttempts: Number(process.env.PASSWORD_RESET_MAX_ATTEMPTS ?? 5),
    /** Segundos de espera antes de poder reenviar (mockup 10: 45 s). */
    resendCooldownSeconds: Number(process.env.PASSWORD_RESET_RESEND_COOLDOWN_SECONDS ?? 45),
  },
  /**
   * OAuth (PENDIENTES.md §2). Flujo Authorization Code + PKCE.
   *
   * Un proveedor solo se considera CONFIGURADO si tiene `clientId` y `clientSecret`. Sin
   * ellos el backend responde 503 y el frontend no ofrece el botón: nunca se simula un
   * inicio de sesión. Ningún secreto llega al navegador.
   *
   * Los `*_ISSUER`, `*_AUTH_URL`, `*_TOKEN_URL` y `*_JWKS_URI` existen únicamente para
   * poder apuntar la suite a un proveedor de prueba local. **En producción no deben
   * definirse**: sin ellos se usan los extremos reales de Google y Microsoft.
   */
  oauth: {
    /** Segundos de validez del `state` (y su verificador PKCE) entre `start` y `callback`. */
    stateTtlSeconds: Number(process.env.OAUTH_STATE_TTL_SECONDS ?? 600),
    /** Segundos de validez del ticket de un solo uso que el callback entrega al frontend. */
    ticketTtlSeconds: Number(process.env.OAUTH_TICKET_TTL_SECONDS ?? 60),
    /** Base pública del backend, para construir el redirect_uri registrado en el proveedor. */
    callbackBaseUrl: process.env.OAUTH_CALLBACK_BASE_URL ?? `http://localhost:${Number(process.env.PORT ?? 3000)}/api`,
    /** Ruta del frontend que recibe el ticket y lo canjea por la sesión. */
    frontendCallbackPath: process.env.OAUTH_FRONTEND_CALLBACK_PATH ?? '/auth/oauth/callback',
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      issuer: process.env.GOOGLE_ISSUER ?? 'https://accounts.google.com',
      authorizationUrl: process.env.GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: process.env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
      jwksUri: process.env.GOOGLE_JWKS_URI ?? 'https://www.googleapis.com/oauth2/v3/certs',
    },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID ?? '',
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? '',
      /** `common` acepta cualquier tenant; un GUID restringe a esa organización. */
      tenant: process.env.MICROSOFT_TENANT ?? 'common',
      issuer: process.env.MICROSOFT_ISSUER ?? '',
      authorizationUrl: process.env.MICROSOFT_AUTH_URL ?? '',
      tokenUrl: process.env.MICROSOFT_TOKEN_URL ?? '',
      jwksUri: process.env.MICROSOFT_JWKS_URI ?? '',
    },
  },
  /**
   * Integraciones por empresa (PENDIENTES.md §5). La clave cifra las credenciales en
   * reposo con AES-256-GCM. Sin ella el módulo responde 503 y no guarda nada en claro.
   * Es independiente de `JWT_SECRET`: rotar el JWT no debe inutilizar las credenciales.
   */
  integrations: {
    encryptionKey: process.env.INTEGRATIONS_ENCRYPTION_KEY ?? '',
    /**
     * Clave ANTERIOR, opcional y solo para descifrar (F17C-SEC-08). Existe únicamente durante una
     * rotación: mientras esté puesta, lo cifrado con la clave vieja se sigue leyendo, y todo lo
     * que se escriba usa ya la nueva. Se retira cuando no queda nada pendiente de re-cifrar.
     * Vacía por defecto, y entonces el comportamiento es el de una sola clave.
     */
    previousEncryptionKey: process.env.INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS ?? '',
  },
  get isProduction() {
    return this.nodeEnv === 'production';
  },
};

// FASE 11F-0: fuera de producción solo se admite una base `*_test`. Falla aquí, al cargar la
// configuración y antes de que exista el pool, para que no llegue a abrirse ninguna conexión.
assertDatabaseAllowedForEnvironment(env.nodeEnv, env.db.name);

// F12-08: en producción, secretos con la fortaleza y el formato que exige su uso. No imprime valores.
assertProductionSecrets({
  nodeEnv: env.nodeEnv,
  jwtSecret: env.jwt.secret,
  encryptionKey: env.integrations.encryptionKey,
  previousEncryptionKey: env.integrations.previousEncryptionKey,
});
