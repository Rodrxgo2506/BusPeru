/**
 * Aislamiento de la base real respecto del entorno de desarrollo (FASE 11F-0).
 *
 * POR QUÉ EXISTE. El backend local arrancaba con `DB_NAME=busperu`, la base real. Al arrancar,
 * `ensureSystemTemplates()` inserta las plantillas que falten y el planificador expira reservas,
 * avanza viajes y purga códigos cada minuto: todo eso escribía en producción sin que nadie lo
 * pidiera. Así llegó a `busperu` la plantilla `booking.payment_compensated`.
 *
 * LA REGLA. Fuera de producción (`NODE_ENV` distinto de `production`, incluido no definirlo), la
 * base tiene que ser de pruebas: su nombre termina en `_test`, la misma convención que ya exige la
 * suite (`busperu_test`). Así un despiste en `.env` no puede apuntar el servidor local, el seed ni
 * un script a la base real. En producción no se impone nada: la base la configura el entorno.
 *
 * Se comprueba al cargar la configuración, ANTES de crear el pool: con una base no permitida no se
 * abre ninguna conexión. El mensaje nombra la base, nunca el host ni las credenciales.
 */

export const NON_PRODUCTION_DB_SUFFIX = '_test';

export class DatabaseIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseIsolationError';
  }
}

export function assertDatabaseAllowedForEnvironment(nodeEnv: string, dbName: string): void {
  const nombre = dbName.trim();
  if (nombre === '') {
    throw new DatabaseIsolationError('Falta DB_NAME: configura explícitamente la base de datos (en local, busperu_test).');
  }
  if (nodeEnv === 'production') return;
  if (!nombre.endsWith(NON_PRODUCTION_DB_SUFFIX)) {
    throw new DatabaseIsolationError(
      `La BD "${nombre}" está reservada para producción; configure busperu_test para el entorno local ` +
        `(NODE_ENV=${nodeEnv || 'sin definir'}: fuera de producción DB_NAME debe terminar en "${NON_PRODUCTION_DB_SUFFIX}").`,
    );
  }
}
