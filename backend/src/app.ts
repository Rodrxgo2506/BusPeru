import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import { sanitizeUrl } from './utils/log-sanitizer';
import { env } from './config/env';
import { accessLog } from './middleware/access-log.middleware';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { attachRequestId } from './middleware/request-id.middleware';
import routes from './routes';

export function createApp() {
  const app = express();

  // F15-05: configurable y `false` por defecto. Con `true` cualquier cliente fijaría su IP con
  // X-Forwarded-For y se saltaría el rate limit; `parseTrustProxy` no lo admite.
  app.set('trust proxy', env.trustProxy);
  // Lo primero de todo: cualquier cosa que falle después ya tiene identificador.
  app.use(attachRequestId);
  app.use(helmet());
  app.use(
    cors({
      origin: env.frontendUrl,
      credentials: true,
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

  app.get('/api/health', (_req, res) => {
    res.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } });
  });

  app.use('/api', routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
