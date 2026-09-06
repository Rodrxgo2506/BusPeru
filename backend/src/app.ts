import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import routes from './routes';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
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
  if (!env.isProduction && env.nodeEnv !== 'test') app.use(morgan('dev'));

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









