/**
 * Proceso de sondeo para FASE 11F-0: carga SOLO la configuración y dice qué base resolvió. No
 * importa el pool ni abre conexiones. Se lanza con otro directorio de trabajo y otro entorno para
 * comprobar que una configuración ausente no se convierte en `busperu`.
 */
import { env } from '../../config/env';

console.log(`DB_NAME_RESUELTO=${env.db.name}`);
