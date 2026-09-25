/**
 * Entorno de PRODUCCIÓN FICTICIO y completo para las pruebas que arrancan el servidor con
 * `NODE_ENV=production` (F15-04). Ningún valor es real: dominios `.example`, llaves inventadas y
 * una base inexistente (127.0.0.1:1), de modo que el proceso pasa las guardas y falla al conectar.
 *
 * Las variables opcionales se fijan VACÍAS a propósito: `dotenv` no pisa una variable ya presente,
 * así que el `backend/.env` local (Culqi en modo test, OAuth, Resend…) no se cuela en el hijo.
 */
export const PRODUCTION_JWT_SECRET = 'Kf8#qP2vZ!mL9xR4tW7yB3nC6dH1jS5a';

export const PRODUCTION_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: 'production',
  DB_HOST: '127.0.0.1',
  DB_PORT: '1',
  DB_NAME: 'busperu',
  DB_USER: 'busperu_app',
  DB_PASSWORD: 'contrasena-ficticia-solo-pruebas-15a',
  JWT_SECRET: PRODUCTION_JWT_SECRET,
  FRONTEND_URL: 'https://app.busperu.example',
  TRUST_PROXY: '1',
  MAIL_TRANSPORT: 'resend',
  RESEND_API_KEY: 're_ficticia_solo_pruebas_15a',
  RESEND_FROM_EMAIL: 'BusPerú <no-reply@busperu.example>',
  INTEGRATIONS_ENCRYPTION_KEY: '',
  OAUTH_CALLBACK_BASE_URL: '',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  MICROSOFT_CLIENT_ID: '',
  MICROSOFT_CLIENT_SECRET: '',
  GOOGLE_ISSUER: '',
  GOOGLE_AUTH_URL: '',
  GOOGLE_TOKEN_URL: '',
  GOOGLE_JWKS_URI: '',
  MICROSOFT_ISSUER: '',
  MICROSOFT_AUTH_URL: '',
  MICROSOFT_TOKEN_URL: '',
  MICROSOFT_JWKS_URI: '',
  CULQI_PUBLIC_KEY: '',
  CULQI_PRIVATE_KEY: '',
  CULQI_WEBHOOK_SECRET: '',
  CULQI_API_URL: '',
  MAIL_HOST: '',
  MAIL_FROM: '',
  MAIL_PASSWORD: '',
  PASSWORD_RESET_RESEND_COOLDOWN_SECONDS: '',
};
