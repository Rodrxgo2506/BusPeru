import type { PoolConnection } from 'mysql2/promise';
import { pool, queryOne } from '../config/database';

/**
 * Notificaciones automáticas del sistema.
 *
 * - Usa las tablas existentes `notification_templates` y `notifications`; no crea tablas.
 * - Es idempotente: cada notificación lleva una `event_key` única en `notifications.data`
 *   y no se inserta si ya existe una con la misma clave para ese usuario.
 * - Acepta la conexión de una transacción en curso, de modo que la notificación solo
 *   existe si la operación que la origina se confirma.
 */

export const NOTIFICATION_EVENTS = {
  BOOKING_CREATED: 'booking.created',
  PAYMENT_CONFIRMED: 'booking.payment_confirmed',
  BOOKING_CANCELLED: 'booking.cancelled',
  BOOKING_EXPIRED: 'booking.expired',
  REFUND_COMPLETED: 'refund.completed',
  /** La empresa canceló el viaje y la reserva del pasajero quedó cancelada (FASE 8H). */
  TRIP_CANCELLED: 'trip.cancelled',
  /** H-29: se detectó un cobro que no se aplicó a ningún pasaje y se inició su devolución. */
  PAYMENT_COMPENSATED: 'booking.payment_compensated',
  DOCUMENT_VERIFIED: 'company.document_verified',
  DOCUMENT_REJECTED: 'company.document_rejected',
} as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[keyof typeof NOTIFICATION_EVENTS];

/**
 * Plantilla de correo (no de notificación interna) para el código de recuperación.
 * Vive en `notification_templates` con type = 'EMAIL' para que un administrador pueda
 * editar el texto sin tocar código, igual que el resto de plantillas del sistema.
 */
export const PASSWORD_RESET_EMAIL = 'auth.password_reset_code';

/**
 * Correo al pasajero cuando la empresa cancela su viaje (FASE 8H). Acompaña a la notificación
 * interna `trip.cancelled`; `{{refund_message}}` dice si hubo reembolso o no hubo cobro.
 */
export const TRIP_CANCELLED_EMAIL = 'trip.cancelled_email';

const EMAIL_TEMPLATES: Record<string, { subject: string; body: string }> = {
  [TRIP_CANCELLED_EMAIL]: {
    subject: 'Tu viaje de {{origin_city}} a {{destination_city}} fue cancelado',
    body: [
      'Hola:',
      '',
      '{{company_name}} canceló el viaje de {{origin_city}} a {{destination_city}} del {{departure_date}}.',
      'Por eso tu reserva {{booking_code}} quedó cancelada.',
      '',
      '{{refund_message}}',
      '',
      'Puedes ver el detalle en Mis viajes, dentro de tu cuenta de BusPerú.',
      '',
      'BusPerú',
    ].join('\n'),
  },
  [PASSWORD_RESET_EMAIL]: {
    subject: 'Tu código de recuperación de BusPerú',
    body: [
      'Hola {{first_name}}:',
      '',
      'Recibimos una solicitud para restablecer la contraseña de tu cuenta de BusPerú.',
      'Tu código de verificación es:',
      '',
      '    {{code}}',
      '',
      'El código caduca en {{minutes}} minutos y solo puede usarse una vez.',
      '',
      'Por tu seguridad, nunca compartas este código con nadie. El equipo de BusPerú jamás',
      'te lo pedirá por teléfono, correo ni redes sociales.',
      '',
      'Si no solicitaste este cambio, ignora este mensaje: tu contraseña seguirá siendo la misma.',
      '',
      'BusPerú',
    ].join('\n'),
  },
};

/** Texto de respaldo si la plantilla todavía no existe en la base. */
const FALLBACK_TEMPLATES: Record<NotificationEvent, { title: string; body: string }> = {
  [NOTIFICATION_EVENTS.BOOKING_CREATED]: {
    title: 'Reserva {{booking_code}} creada',
    body: 'Tu reserva {{booking_code}} de {{origin_city}} a {{destination_city}} está pendiente de pago. Tienes {{hold_minutes}} minutos para completarla.',
  },
  [NOTIFICATION_EVENTS.PAYMENT_CONFIRMED]: {
    title: '¡Pago confirmado! Reserva {{booking_code}}',
    body: 'Recibimos tu pago de {{total_amount}} por el viaje {{origin_city}} → {{destination_city}} del {{departure_date}}. Asiento(s): {{seat_numbers}}.',
  },
  [NOTIFICATION_EVENTS.BOOKING_CANCELLED]: {
    title: 'Reserva {{booking_code}} cancelada',
    body: 'Tu reserva {{booking_code}} de {{origin_city}} a {{destination_city}} fue cancelada. Si tu pago estaba aprobado, se generó una solicitud de reembolso.',
  },
  [NOTIFICATION_EVENTS.BOOKING_EXPIRED]: {
    title: 'Reserva {{booking_code}} expirada',
    body: 'No recibimos el pago de tu reserva {{booking_code}} dentro del tiempo disponible, así que los asientos volvieron a estar disponibles.',
  },
  [NOTIFICATION_EVENTS.REFUND_COMPLETED]: {
    title: 'Reembolso procesado',
    body: 'Procesamos el reembolso de {{amount}} correspondiente a tu reserva {{booking_code}}.',
  },
  [NOTIFICATION_EVENTS.DOCUMENT_VERIFIED]: {
    title: 'Documento verificado: {{document_type}}',
    body: 'Revisamos tu {{document_type}} y quedó verificado. No necesitas hacer nada más.',
  },
  [NOTIFICATION_EVENTS.TRIP_CANCELLED]: {
    title: 'Viaje cancelado: reserva {{booking_code}}',
    body: 'La empresa canceló el viaje de {{origin_city}} a {{destination_city}} del {{departure_date}}, así que tu reserva {{booking_code}} quedó cancelada. {{refund_message}}',
  },
  [NOTIFICATION_EVENTS.PAYMENT_COMPENSATED]: {
    title: 'Detectamos un cobro en tu reserva {{booking_code}}',
    body: 'Detectamos un cobro de {{amount}} asociado a tu reserva {{booking_code}} que no se aplicó a ningún pasaje. Ya iniciamos su devolución y te avisaremos cuando se procese.',
  },
  [NOTIFICATION_EVENTS.DOCUMENT_REJECTED]: {
    title: 'Documento rechazado: {{document_type}}',
    body: 'Tu {{document_type}} no pudo verificarse. Motivo: {{notes}}. Sube una versión corregida desde Verificación de empresa.',
  },
};

type Context = Record<string, string | number | null | undefined>;

/** Sustituye {{variable}} por su valor; lo no resuelto se elimina para no mostrar llaves. */
export function render(text: string, context: Context): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    const value = context[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

interface TemplateRow {
  id: number;
  type: string;
  title: string | null;
  subject: string | null;
  body: string;
}

async function loadTemplate(connection: PoolConnection, name: NotificationEvent): Promise<TemplateRow | null> {
  const [rows] = await connection.query(
    "SELECT id, type, title, subject, body FROM notification_templates WHERE name = ? AND status = 'ACTIVE' LIMIT 1",
    [name],
  );
  return (rows as TemplateRow[])[0] ?? null;
}

export interface NotifyInput {
  userId: number;
  event: NotificationEvent;
  /** Identificador único del hecho, p. ej. `booking.created:42`. Evita duplicados. */
  eventKey: string;
  context: Context;
}

/**
 * Inserta una notificación si no existe otra con la misma `event_key`.
 * Devuelve el id creado, o null si ya existía (o si falló sin poder bloquear la operación).
 */
export async function notify(connection: PoolConnection, input: NotifyInput): Promise<number | null> {
  const [existing] = await connection.query(
    "SELECT id FROM notifications WHERE user_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.event_key')) = ? LIMIT 1",
    [input.userId, input.eventKey],
  );
  if ((existing as unknown[]).length > 0) return null;

  const template = await loadTemplate(connection, input.event);
  const fallback = FALLBACK_TEMPLATES[input.event];

  const title = render(template?.title || template?.subject || fallback.title, input.context);
  const message = render(template?.body || fallback.body, input.context);
  const type = template?.type ?? 'IN_APP';

  const data = JSON.stringify({ event: input.event, event_key: input.eventKey, ...input.context });

  const [result] = await connection.query(
    `INSERT INTO notifications (user_id, template_id, type, title, message, data, status, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, 'SENT', NOW())`,
    [input.userId, template?.id ?? null, type, title, message, data],
  );
  return (result as { insertId: number }).insertId;
}

/** Variante fuera de transacción, para procesos que ya confirmaron su cambio. */
export async function notifyStandalone(input: NotifyInput): Promise<number | null> {
  const connection = await pool.getConnection();
  try {
    return await notify(connection, input);
  } finally {
    connection.release();
  }
}

/**
 * Crea las plantillas del sistema si no existen. Solo inserta filas: no altera el esquema
 * ni sobrescribe plantillas que el administrador haya editado.
 *
 * F15-10: con varias instancias arrancando a la vez, dos pueden ver «no existe» en el SELECT e
 * intentar el INSERT. `ON DUPLICATE KEY UPDATE id = id` convierte SOLO el choque con la clave
 * única (`name`) en un no-op: la fila existente no cambia y, sin `insertId`, no cuenta como creada
 * (mysql2 activa FOUND_ROWS, así que `affectedRows` no distingue ambos casos). No se usa
 * `INSERT IGNORE`, que además degradaría a aviso cualquier otro error real (datos truncados,
 * valores inválidos…).
 */
export async function ensureSystemTemplates(): Promise<number> {
  const connection = await pool.getConnection();
  let created = 0;
  try {
    for (const [event, content] of Object.entries(FALLBACK_TEMPLATES) as Array<[NotificationEvent, { title: string; body: string }]>) {
      const [rows] = await connection.query('SELECT id FROM notification_templates WHERE name = ? LIMIT 1', [event]);
      if ((rows as unknown[]).length > 0) continue;

      const variables = [...new Set([...content.title.matchAll(/\{\{\s*(\w+)\s*\}\}/g), ...content.body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))];
      const [result] = await connection.query(
        `INSERT INTO notification_templates (name, type, subject, title, body, variables, status)
         VALUES (?, 'IN_APP', ?, ?, ?, ?, 'ACTIVE')
         ON DUPLICATE KEY UPDATE id = id`,
        [event, content.title, content.title, content.body, JSON.stringify(variables)],
      );
      created += (result as { insertId: number }).insertId > 0 ? 1 : 0;
    }

    for (const [name, content] of Object.entries(EMAIL_TEMPLATES)) {
      const [rows] = await connection.query('SELECT id FROM notification_templates WHERE name = ? LIMIT 1', [name]);
      if ((rows as unknown[]).length > 0) continue;

      const variables = [...new Set([...content.subject.matchAll(/\{\{\s*(\w+)\s*\}\}/g), ...content.body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))];
      const [result] = await connection.query(
        `INSERT INTO notification_templates (name, type, subject, title, body, variables, status)
         VALUES (?, 'EMAIL', ?, ?, ?, ?, 'ACTIVE')
         ON DUPLICATE KEY UPDATE id = id`,
        [name, content.subject, content.subject, content.body, JSON.stringify(variables)],
      );
      created += (result as { insertId: number }).insertId > 0 ? 1 : 0;
    }
  } finally {
    connection.release();
  }
  return created;
}

/**
 * Devuelve asunto y cuerpo de una plantilla de correo, ya renderizados. Prioriza la fila
 * de `notification_templates` (editable) y recurre al texto de respaldo si no existe.
 */
export async function renderTemplate(name: string, context: Context): Promise<{ subject: string; body: string }> {
  const fallback = EMAIL_TEMPLATES[name];
  if (!fallback) throw new Error(`No existe la plantilla de correo ${name}`);

  const row = await queryOne<{ subject: string | null; title: string | null; body: string }>(
    "SELECT subject, title, body FROM notification_templates WHERE name = ? AND status = 'ACTIVE' LIMIT 1",
    [name],
  );

  return {
    subject: render(row?.subject || row?.title || fallback.subject, context),
    body: render(row?.body || fallback.body, context),
  };
}
