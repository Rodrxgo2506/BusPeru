import type { PoolConnection } from 'mysql2/promise';
import { z } from 'zod';
import { queryOne, withTransaction } from '../config/database';
import { hashPassword } from '../utils/security';
import { strongPasswordSchema } from '../validators/auth.validators';
import { recordSystemAudit } from './audit.service';

/**
 * Alta del PRIMER administrador de la plataforma (F18-02).
 *
 * POR QUÉ EXISTE. El dump de producción solo trae el catálogo de roles y permisos: ningún usuario.
 * El seed de desarrollo se niega —con razón— a ejecutarse en producción, y crear un ADMIN desde la
 * API exige ya ser ADMIN. Sin esto, la única salida era un `INSERT` a mano con un hash de bcrypt
 * calculado aparte: fácil de equivocar y sin ninguna de las garantías de abajo.
 *
 * GARANTÍAS
 *   · Solo funciona si NO existe ningún ADMIN. Si ya hay uno, no toca nada.
 *   · El rol no viene de la entrada: siempre es ADMIN y los permisos salen del rol. Un campo de
 *     más (`role`, `role_id`, `status`…) hace fallar la validación en vez de colarse.
 *   · Misma validación que la aplicación: el correo con la regla del registro (sin normalizarlo:
 *     la aplicación tampoco lo hace; la unicidad sin distinguir mayúsculas la da la collation) y la
 *     contraseña con la regla de siempre. El hash, con `hashPassword`, el mismo que usa el login.
 *   · Una sola transacción. Dos ejecuciones a la vez no pueden crear dos administradores: la primera
 *     bloquea la fila del rol ADMIN y la segunda, al conseguirla, vuelve a mirar con una lectura
 *     bloqueante —que siempre ve lo último confirmado— y encuentra el que acaba de crearse.
 *   · La contraseña no se registra en ningún sitio: ni en la auditoría, ni en los mensajes de error.
 *
 * La elección de la BASE la protegen las guardas que ya existen al cargar la configuración: fuera
 * de producción solo se admiten bases `*_test`, y en producción la configuración tiene que estar
 * completa. El comando de consola añade además una confirmación explícita del nombre de la base.
 */

export const bootstrapAdminSchema = z
  .object({
    email: z.string().email('Correo electrónico inválido').max(150),
    password: strongPasswordSchema,
    first_name: z.string().trim().min(2, 'Ingresa los nombres').max(100),
    last_name: z.string().trim().min(2, 'Ingresa los apellidos').max(100),
  })
  // Cualquier otra clave —en particular `role`, `role_id` o `status`— se rechaza, no se ignora.
  .strict();

export type BootstrapAdminInput = z.infer<typeof bootstrapAdminSchema>;

export type AdminBootstrapErrorCode = 'INVALID_INPUT' | 'ADMIN_EXISTS' | 'EMAIL_TAKEN' | 'ADMIN_ROLE_MISSING';

/** Errores esperables. Sus mensajes nunca incluyen la contraseña ni su hash. */
export class AdminBootstrapError extends Error {
  constructor(public readonly code: AdminBootstrapErrorCode, message: string) {
    super(message);
    this.name = 'AdminBootstrapError';
  }
}

export interface BootstrapOptions {
  /**
   * Solo para las pruebas: se ejecuta dentro de la transacción, después de crear el usuario y
   * antes de confirmar, para poder demostrar que un fallo en ese punto no deja nada. El comando de
   * consola nunca lo usa.
   */
  beforeCommit?: (connection: PoolConnection) => Promise<void>;
}

/** Mensajes de validación legibles. Zod no incluye valores en ellos, solo el campo y la regla. */
function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'entrada'}: ${issue.message}`).join('; ');
}

/** ¿Hay ya algún administrador? Lectura sin bloqueo, para que el comando aborte antes de pedir datos. */
export async function adminExists(): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'ADMIN'`,
  );
  return Number(row?.n ?? 0) > 0;
}

export async function bootstrapFirstAdmin(raw: unknown, options: BootstrapOptions = {}): Promise<{ id: number }> {
  const parsed = bootstrapAdminSchema.safeParse(raw);
  if (!parsed.success) throw new AdminBootstrapError('INVALID_INPUT', describeIssues(parsed.error));
  const input = parsed.data;

  // bcrypt es lento a propósito: se calcula fuera de la transacción para no sostener bloqueos.
  const passwordHash = await hashPassword(input.password);

  return withTransaction(async (connection) => {
    // 1 · Serializa: quien llega segundo espera aquí a que el primero confirme o deshaga.
    const [roleRows] = await connection.query(
      "SELECT id FROM roles WHERE name = 'ADMIN' AND status = 'ACTIVE' LIMIT 1 FOR UPDATE",
    );
    const role = (roleRows as Array<{ id: number }>)[0];
    if (!role) {
      throw new AdminBootstrapError('ADMIN_ROLE_MISSING', 'El rol ADMIN no existe en esta base: importa primero el dump y las migraciones.');
    }

    // 2 · Lectura BLOQUEANTE: ve lo último confirmado aunque la transacción empezara antes.
    const [adminRows] = await connection.query(
      'SELECT COUNT(*) AS n FROM users WHERE role_id = ? FOR UPDATE',
      [role.id],
    );
    if (Number((adminRows as Array<{ n: number }>)[0]?.n ?? 0) > 0) {
      throw new AdminBootstrapError('ADMIN_EXISTS', 'Ya existe un administrador. El alta inicial solo se hace una vez y no se ha modificado nada.');
    }

    const [emailRows] = await connection.query('SELECT id FROM users WHERE email = ? LIMIT 1 FOR UPDATE', [input.email]);
    if ((emailRows as unknown[]).length > 0) {
      throw new AdminBootstrapError('EMAIL_TAKEN', 'Ya existe una cuenta con ese correo. No se ha modificado nada.');
    }

    const [result] = await connection.query(
      `INSERT INTO users (role_id, first_name, last_name, email, password_hash, status)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
      [role.id, input.first_name, input.last_name, input.email, passwordHash],
    );
    const id = (result as { insertId: number }).insertId;

    // Rastro del alta, dentro de la misma transacción. Sin contraseña, sin hash y sin correo.
    await recordSystemAudit({
      action: 'CREATE',
      entityType: 'users',
      entityId: id,
      actor: 'system:admin-bootstrap',
      description: 'Alta del primer administrador de la plataforma',
      newValues: { role: 'ADMIN', status: 'ACTIVE' },
    }, connection);

    if (options.beforeCommit) await options.beforeCommit(connection);
    return { id };
  });
}
