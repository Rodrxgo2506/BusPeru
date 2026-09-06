import { z } from 'zod';

/**
 * Validación de las integraciones por empresa (PENDIENTES.md §5).
 *
 * Obsérvese lo que NO aparece: `company_id`, `status`, `connected_at`, `category`, `id`,
 * `created_at` ni `updated_at`. El ámbito lo resuelve el servidor desde la sesión, la
 * categoría sale del catálogo y el estado se deriva de si faltan campos obligatorios.
 *
 * El cuerpo admitido es **solo el diccionario de credenciales**, y de él el servicio
 * conserva únicamente las claves que el proveedor declara: cualquier otra se descarta.
 */

/** Una credencial: texto corto, sin saltos de línea. Vacío significa «no la cambies». */
const credentialValue = z
  .string()
  .trim()
  .max(500, 'El valor es demasiado largo')
  .regex(/^[^\r\n]*$/, 'El valor no puede contener saltos de línea');

export const saveIntegrationSchema = z.object({
  credentials: z.record(credentialValue).default({}),
});

export type SaveIntegrationInput = z.infer<typeof saveIntegrationSchema>;
