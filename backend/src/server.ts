import { createApp } from './app';
import { pool, verifyConnection } from './config/database';
import { env } from './config/env';
import { applyKeepAlive } from './config/http-server';
import { startBookingExpiryScheduler, stopBookingExpiryScheduler } from './services/booking-expiry.service';
import { ensureSystemTemplates } from './services/notification.service';
import { installFatalHandlers } from './utils/process-guards';

async function bootstrap(): Promise<void> {
  try {
    await verifyConnection();
    console.log(`✔ Conectado a MySQL (${env.db.host}:${env.db.port}/${env.db.name})`);
  } catch (error) {
    console.error('✖ No se pudo conectar a MySQL. Revisa las variables DB_* en backend/.env');
    console.error(error);
    process.exit(1);
  }

  // Inserta las plantillas del sistema si faltan (solo filas; nunca sobrescribe las editadas).
  try {
    const created = await ensureSystemTemplates();
    if (created > 0) console.log(`✔ Plantillas de notificación creadas: ${created}`);
  } catch (error) {
    console.error('No se pudieron preparar las plantillas de notificación:', error);
  }

  startBookingExpiryScheduler(env.bookingExpiryIntervalMs);
  console.log(`✔ Expiración de reservas activa cada ${env.bookingExpiryIntervalMs / 1000}s`);

  const server = createApp().listen(env.port, () => {
    console.log(`✔ API BusPerú escuchando en http://localhost:${env.port}/api`);
  });
  // F18-11B: mantener las conexiones del ALB más que su idle_timeout (ver config/http-server).
  applyKeepAlive(server);

  const shutdown = async (signal: string, code = 0) => {
    console.log(`\n${signal} recibido, cerrando servidor...`);
    stopBookingExpiryScheduler();
    server.close(async () => {
      await pool.end();
      process.exit(code);
    });
    // Si algo se queda colgado, no se espera indefinidamente.
    setTimeout(() => process.exit(code), 10_000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Excepciones que escapan a todo manejador: se registran y el proceso se cierra con
  // codigo 1 para que el gestor de procesos lo reinicie limpio. Ver process-guards.ts.
  installFatalHandlers((signal, code) => void shutdown(signal, code));
}

void bootstrap();
