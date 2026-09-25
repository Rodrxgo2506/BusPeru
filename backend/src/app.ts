import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import { sanitizeUrl } from './utils/log-sanitizer';
import { env } from './config/env';
import { CORS_PREFLIGHT_MAX_AGE_SECONDS } from './config/http-server';
import { accessLog } from './middleware/access-log.middleware';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { attachRequestId } from './middleware/request-id.middleware';
import { checkReadiness } from './services/readiness.service';
import routes from './routes';

export function createApp() {
  const app = express();

  // F15-05: configurable y `false` por defecto. Con `true` cualquier cliente fijaría su IP con
  // X-Forwarded-For y se saltaría el rate limit; `parseTrustProxy` no lo admite.
  app.set('trust proxy', env.trustProxy);
  // Lo primero de todo: cualquier cosa que falle después ya tiene identificador.
  app.use(attachRequestId);
  app.use(helmet());
  // Un ÚNICO origen explícito, nunca `*` y nunca el `Origin` que llegue en la petición: `cors`
  // con un origen de tipo cadena emite siempre el mismo `Access-Control-Allow-Origin`, así que
  // una página atacante recibe el del frontend legítimo y su navegador descarta la respuesta.
  // `env.corsOrigin` está normalizado a `esquema://host[:puerto]` (SEC07-01): una barra final en
  // FRONTEND_URL produciría una cabecera que ningún navegador puede aceptar.
  app.use(
    cors({
      origin: env.corsOrigin,
      credentials: true,
      // F18-11B: el navegador guarda el preflight 2 h (máximo que respeta Chromium) en lugar de
      // repetirlo en cada petición autenticada. No cambia qué origen, métodos ni cabeceras se admiten.
      maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // En pruebas el log de peticiones solo añade ruido a la salida del runner.
  // H-31: con la URL saneada, para que ni en desarrollo se imprima el secreto del webhook ni el
  // `code`/`state` de OAuth.
  // F15-08: en producción, registro de acceso propio en JSON (sin query, cabeceras ni cuerpo).
  if (env.isProduction) app.use(accessLog);
  if (!env.isProduction && env.nodeEnv !== 'test') {
    morgan.token('safe-url', (req) => sanitizeUrl((req as { originalUrl?: string }).originalUrl ?? req.url));
    app.use(morgan(':method :safe-url :status :response-time ms - :res[content-length]'));
  }

  // F15-05: el almacén es la MEMORIA del proceso. Con varias réplicas cada una lleva su propia
  // cuenta y el límite efectivo se multiplica; en ese despliegue hace falta un store compartido
  // (p. ej. Redis). Ver README, sección de producción.
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: env.rateLimit.global,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, message: 'Demasiadas solicitudes. Intenta nuevamente en un momento.' },
    }),
  );

  // LIVENESS: el proceso responde. No toca la base ni el disco, a propósito: sirve para saber si
  // hay que reiniciar el proceso, no si puede atender tráfico.
  app.get('/api/health', (_req, res) => {
    // F18-07A · igual que /ready: un proxy o el navegador no deben servir un estado viejo.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } });
  });

  // READINESS (F18-02): ¿puede esta instancia atender tráfico? Comprueba la base y el almacenamiento
  // (ver `readiness.service.ts`). Respuesta mínima a propósito: el detalle solo va al registro.
  app.get('/api/ready', async (_req, res) => {
    let ready = false;
    try {
      ready = (await checkReadiness()).ready;
    } catch {
      ready = false;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });

  app.use('/api', routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
