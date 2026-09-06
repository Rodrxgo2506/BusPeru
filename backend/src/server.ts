import { createApp } from './app';
import { pool, verifyConnection } from './config/database';
import { env } from './config/env';
import { startBookingExpiryScheduler, stopBookingExpiryScheduler } from './services/booking-expiry.service';
import { ensureSystemTemplates } from './services/notification.service';

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

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} recibido, cerrando servidor...`);
    stopBookingExpiryScheduler();
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void bootstrap();
