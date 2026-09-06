import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

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
    name: required('DB_NAME', 'busperu'),
    user: required('DB_USER', 'root'),
    password: process.env.DB_PASSWORD ?? '',
  },
  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  },
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  /** Cada cuánto se revisan las reservas PENDING vencidas. */
  bookingExpiryIntervalMs: Number(process.env.BOOKING_EXPIRY_INTERVAL_MS ?? 60_000),
  rateLimit: {
    /** Peticiones por minuto sobre toda la API. */
    global: Number(process.env.RATE_LIMIT_GLOBAL ?? 300),
    /** Intentos por ventana de 15 minutos sobre /auth. */
    auth: Number(process.env.RATE_LIMIT_AUTH ?? 20),
  },
  mail: {
    /** `log` imprime en consola (solo desarrollo), `smtp` envía de verdad. */
    transport: (process.env.MAIL_TRANSPORT ?? 'log') as 'log' | 'smtp' | 'memory',
    host: process.env.MAIL_HOST ?? '',
    port: Number(process.env.MAIL_PORT ?? 587),
    secure: process.env.MAIL_SECURE === 'true',
    user: process.env.MAIL_USER ?? '',
    password: process.env.MAIL_PASSWORD ?? '',
    from: process.env.MAIL_FROM ?? 'BusPeru <no-reply@busperu.com>',
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
  },
  get isProduction() {
    return this.nodeEnv === 'production';
  },
};
