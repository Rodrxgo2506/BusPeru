/**
 * Proceso hijo de la suite 63 (F15-08): carga la app con `NODE_ENV=production` (entorno ficticio
 * que pone el padre), atiende UNA petición llena de credenciales y termina. No toca MySQL: solo
 * pide `/api/health`, que no consulta la base. El padre lee el registro de acceso en stderr.
 */
import type { AddressInfo } from 'node:net';
import { createApp } from '../../app';

const secretos = JSON.parse(process.env.ACCESS_LOG_SECRETS ?? '{}') as Record<string, string>;

const server = createApp().listen(0, '127.0.0.1', async () => {
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health?token=${secretos.query}&search=${secretos.email}`, {
      headers: {
        Authorization: `Bearer ${secretos.bearer}`,
        Cookie: `session=${secretos.cookie}`,
        'X-Api-Key': secretos.apiKey ?? '',
      },
    });
    await res.text();
  } finally {
    // `finish` se emite antes de que el cliente reciba el cuerpo; el registro ya está escrito.
    // Se cierra sin `process.exit`: en Windows, salir con el socket keep-alive abierto aborta el proceso.
    server.closeAllConnections();
    server.close();
  }
});
