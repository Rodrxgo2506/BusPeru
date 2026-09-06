import './testEnv';
import type { AddressInfo } from 'net';
import { createApp } from '../../app';

/**
 * Segunda instancia del backend, en un proceso Node **distinto**.
 *
 * La lanza `17-oauth.test.ts` para demostrar de verdad —y no por aproximación— que el flujo
 * OAuth ya no depende de la memoria del proceso: `/start` se atiende aquí y `/callback` en
 * la instancia principal, o al revés, y ambos funcionan porque el estado vive en
 * `oauth_flows`.
 *
 * Toda la configuración del proveedor llega por variables de entorno, igual que en
 * producción. `testEnv` garantiza que la base sea la de pruebas.
 *
 * Imprime `LISTENING <puerto>` en cuanto está lista, para que el proceso padre sepa cuándo
 * puede empezar.
 */
const server = createApp().listen(0, '127.0.0.1', () => {
  const { port } = server.address() as AddressInfo;
  console.log(`LISTENING ${port}`);
});

// Sin esto el proceso quedaría vivo si el padre muere sin matarlo.
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('disconnect', () => server.close(() => process.exit(0)));
