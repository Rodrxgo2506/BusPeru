import crypto from 'crypto';
import { Router } from 'express';
import { query, queryOne, withTransaction } from '../config/database';
import { authenticate } from '../middleware/auth.middleware';
import { culqi, isSuccessfulCharge } from '../services/culqi.service';
import { reconcileApprovedCharge } from '../services/payment.service';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendSuccess } from '../utils/http';
import { logError, logEvent } from '../utils/logger';

/**
 * Superficie pública de Culqi: la configuración que necesita el navegador y el webhook.
 *
 * Van juntas en un archivo porque comparten algo esencial: **ninguna de las dos está
 * autenticada con JWT**. La primera porque la llave pública es, por definición, pública. El
 * segundo porque lo llama Culqi, que no tiene sesión de BusPerú.
 */

export const culqiConfigRouter = Router();

/**
 * Lo que el frontend necesita para tokenizar. Se devuelve SOLO la llave pública, que es la
 * que Culqi exige que viaje al navegador; la privada no sale del backend ni aquí ni en
 * ningún otro sitio. Requiere sesión: no hay motivo para publicarla a un anónimo.
 */
culqiConfigRouter.get(
  '/config',
  authenticate,
  asyncHandler(async (_req, res) => {
    sendSuccess(res, {
      provider: 'CULQI',
      public_key: env.culqi.publicKey,
      /** `false` significa: no ofrezcas tarjeta, no está configurada. */
      card_enabled: Boolean(env.culqi.publicKey && env.culqi.privateKey),
      currency: 'PEN',
    });
  }),
);

export const culqiWebhookRouter = Router();

/**
 * Webhook de Culqi.
 *
 * CÓMO SE ESTABLECE LA AUTENTICIDAD, Y POR QUÉ ASÍ. La documentación vigente de Culqi
 * **no publica ningún esquema de firma** —ni HMAC, ni cabecera de firma, ni secreto de
 * webhook—: el panel solo permite registrar una URL. Inventar aquí una verificación de
 * firma sería fingir una garantía que el proveedor no da. De modo que se hacen dos cosas
 * que sí son verificables:
 *
 *   1. **Un secreto en la ruta.** La URL que se registra en CulqiPanel lleva un segmento
 *      imposible de adivinar (`CULQI_WEBHOOK_SECRET`). Es un cerrojo de puerta: evita que
 *      cualquiera descubra el endpoint, y nada más. Se compara en tiempo constante.
 *   2. **La prueba de verdad: releer el cargo.** El cuerpo del webhook se trata como un
 *      RUMOR, no como un hecho. De él solo se toma un identificador de cargo, y el estado
 *      real se pide a la API de Culqi con la llave privada. Quien decide si hubo cobro es
 *      siempre Culqi respondiendo a una petición nuestra, nunca un cuerpo que llegó solo.
 *
 * Con eso, un atacante que descubriera la URL no puede confirmar nada: tendría que fabricar
 * un cargo dentro de la cuenta de Culqi de BusPerú.
 */
culqiWebhookRouter.post(
  '/:secret',
  asyncHandler(async (req, res) => {
    const evento = describirSuceso(req.body);

    if (!secretoValido(req.params.secret)) {
      // Alguien llamó al endpoint con otro secreto. Se registra el intento —es información
      // de seguridad— pero NUNCA el valor recibido ni el esperado.
      registrar({ outcome: 'unauthorized', handled: false }, evento, null);
      throw ApiError.notFound('Ruta no encontrada');
    }

    const chargeId = extraerChargeId(req.body);
    // Se responde 200 aunque no se reconozca el suceso: un 4xx haría que Culqi reintentara
    // eternamente algo que nunca vamos a poder procesar.
    if (!chargeId) {
      const resultado: Procesado = {
        outcome: 'unsupported_event',
        handled: false,
        reason: 'sin identificador de cargo',
      };
      registrar(resultado, evento, null);
      sendSuccess(res, { received: true, handled: false, reason: resultado.reason });
      return;
    }

    const resultado = await procesarCargo(chargeId);
    registrar(resultado, evento, chargeId);

    // La respuesta al proveedor NO cambia: `outcome` es información de auditoría y se queda
    // en el registro, no se publica.
    const { outcome: _outcome, paymentId: _p, bookingId: _b, ...respuesta } = resultado;
    sendSuccess(res, { received: true, ...respuesta });
  }),
);

/**
 * Qué se hizo con un suceso recibido. Lista CERRADA: son los valores que se registran y por
 * los que se filtrará una auditoría, así que no pueden ser texto libre.
 *
 *   · `reconciled`          la reserva se confirmó AQUÍ, a partir del webhook.
 *   · `already_reconciled`  llegó, pero el pago ya estaba cerrado. Es el caso normal cuando
 *                           la respuesta HTTP del cobro sí llegó; no se toca nada.
 *   · `marked_failed`       el cargo no fue exitoso y el intento quedó FAILED.
 *   · `not_correlated`      el cargo no corresponde a ningún pago de BusPerú.
 *   · `unsupported_event`   el cuerpo no traía un cargo reconocible.
 *   · `compensated`         el cargo no pudo confirmar la reserva —no era confirmable, o ya la
 *                           había confirmado OTRO cargo (H-43)— y quedó con su reembolso.
 *   · `amount_mismatch`     el importe del cargo no coincide con el del pago. No se confirma.
 *   · `charge_mismatch`     el pago ya estaba cerrado con OTRO cargo. No se toca; queda registrado.
 *   · `verification_failed` no se pudo releer el cargo en Culqi para comprobarlo.
 *   · `unauthorized`        el secreto de la ruta no era el nuestro.
 */
export type WebhookOutcome =
  | 'reconciled'
  | 'already_reconciled'
  | 'compensated'
  | 'marked_failed'
  | 'not_correlated'
  | 'unsupported_event'
  | 'amount_mismatch'
  | 'charge_mismatch'
  | 'verification_failed'
  | 'unauthorized';

/** Resultado interno de procesar un suceso. `handled`/`reason` son la respuesta HTTP. */
interface Procesado {
  outcome: WebhookOutcome;
  handled: boolean;
  reason?: string;
  action?: string;
  paymentId?: number;
  bookingId?: number;
}

/**
 * Descriptor del suceso, para poder auditarlo. Se toman SOLO campos de tipo texto y se
 * recortan: del cuerpo del proveedor no se copia nada más, y jamás el cuerpo entero.
 */
function describirSuceso(body: unknown): string {
  if (body === null || typeof body !== 'object') return 'desconocido';
  const cuerpo = body as Record<string, unknown>;
  const data = (cuerpo.data ?? {}) as Record<string, unknown>;

  const partes = [cuerpo.type, cuerpo.object, data.object]
    .filter((valor): valor is string => typeof valor === 'string' && valor.length > 0)
    .join('/');
  return (partes || 'desconocido').slice(0, 80);
}

/**
 * Deja constancia de CADA suceso recibido, pase lo que pase con él.
 *
 * Va por el registrador estructurado de BP-17: misma línea JSON, mismo transporte, mismo
 * silencio durante la suite. No es un sistema paralelo.
 *
 * QUÉ SE REGISTRA: el descriptor del suceso, el identificador público del cargo (`chr_…`),
 * el pago y la reserva con los que se pudo correlacionar, y el resultado.
 *
 * QUÉ NO: el secreto de la ruta —ni el recibido ni el esperado—, la llave privada, el
 * cuerpo del webhook, y nada del medio de pago. Del cuerpo solo se copia un descriptor de
 * texto recortado a 80 caracteres.
 */
function registrar(resultado: Procesado, evento: string, chargeId: string | null): void {
  logEvent('Webhook de Culqi recibido', {
    provider: 'CULQI',
    event: evento,
    outcome: resultado.outcome,
    ...(chargeId ? { chargeId } : {}),
    ...(resultado.paymentId !== undefined ? { paymentId: resultado.paymentId } : {}),
    ...(resultado.bookingId !== undefined ? { bookingId: resultado.bookingId } : {}),
    ...(resultado.reason ?? resultado.action ? { detail: resultado.reason ?? resultado.action } : {}),
  });
}

/** Comparación en tiempo constante: un `===` filtraría el secreto carácter a carácter. */
function secretoValido(recibido: string | undefined): boolean {
  const esperado = env.culqi.webhookSecret;
  if (!esperado || !recibido) return false;

  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Saca el identificador del cargo del cuerpo, sin creerse nada más.
 *
 * Culqi envía el objeto del suceso; según el evento el cargo aparece como el propio objeto
 * o anidado en `data`. Se aceptan las dos formas y se descarta cualquier otra cosa.
 */
function extraerChargeId(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const cuerpo = body as Record<string, unknown>;
  const data = (cuerpo.data ?? cuerpo) as Record<string, unknown>;

  const id = typeof data.id === 'string' ? data.id : null;
  return id && id.startsWith('chr_') ? id : null;
}

/**
 * Relee el cargo en Culqi y pone al día el pago correspondiente. Idempotente por diseño:
 * si el pago ya estaba cerrado no se toca, así que un webhook repetido —o uno que llega
 * tarde, después de que el navegador ya confirmó— no duplica ni cobros ni movimientos.
 */
async function procesarCargo(chargeId: string): Promise<Procesado> {
  const consulta = await culqi().getCharge(chargeId);
  if (!consulta.ok) {
    // No se propaga el fallo: si Culqi no responde ahora, su propio reintento nos traerá el
    // suceso otra vez. Devolver 5xx aquí solo añadiría ruido.
    logError('No se pudo releer un cargo de Culqi al procesar su webhook', new Error(consulta.merchantMessage), {});
    return { outcome: 'verification_failed', handled: false, reason: 'no se pudo verificar el cargo' };
  }

  const charge = consulta.data;
  const pago = await queryOne<{ id: number; booking_id: number; amount: string; status: string }>(
    `SELECT p.id, p.booking_id, p.amount, p.status
     FROM payments p
     WHERE p.provider = 'CULQI'
       AND (p.provider_transaction_id = ? OR JSON_UNQUOTE(JSON_EXTRACT(p.payment_data, '$.charge_id')) = ?)
     ORDER BY p.id DESC LIMIT 1`,
    [charge.id, charge.id],
  );

  // El cargo puede no existir aún en BusPerú si el webhook adelanta a la respuesta HTTP.
  // Se recurre a la metadata que el propio backend puso al crear el cargo.
  const paymentId = pago?.id ?? (await buscarPorMetadata(charge.id));
  if (paymentId === null) return { outcome: 'not_correlated', handled: false, reason: 'pago no encontrado' };

  if (!isSuccessfulCharge(charge)) {
    await marcarFallido(paymentId);
    return { outcome: 'marked_failed', handled: true, action: 'marcado como fallido', paymentId };
  }

  // H-42 · H-43: se concilia el cargo con SU pago, no «la reserva». Ver `reconcileApprovedCharge`.
  const resultado = await reconcileApprovedCharge(paymentId, charge, 'El cargo se cobró cuando la reserva ya no se podía confirmar');
  switch (resultado.outcome) {
    case 'confirmed':
      return { outcome: 'reconciled', handled: true, action: 'reserva confirmada', paymentId, bookingId: resultado.bookingId };
    case 'already_reconciled':
      return { outcome: 'already_reconciled', handled: true, action: 'ya estaba conciliado', paymentId, bookingId: resultado.bookingId };
    case 'compensated':
      return {
        outcome: 'compensated',
        handled: true,
        action: !resultado.opened
          ? 'ya estaba conciliado'
          : resultado.bookingConfirmed
            ? 'cobro adicional sobre una reserva ya pagada: reembolso abierto'
            : 'cobro sin reserva confirmable: reembolso abierto',
        paymentId,
        bookingId: resultado.bookingId,
      };
    case 'amount_mismatch':
      return { outcome: 'amount_mismatch', handled: false, reason: 'importe no coincide', paymentId, bookingId: resultado.bookingId };
    case 'charge_mismatch':
      return { outcome: 'charge_mismatch', handled: false, reason: 'el pago ya estaba cerrado con otro cargo', paymentId, bookingId: resultado.bookingId };
    default:
      return { outcome: 'not_correlated', handled: false, reason: 'pago no encontrado' };
  }
}

/** Busca el pago por el `payment_id` que se envió a Culqi en `metadata` al crear el cargo. */
async function buscarPorMetadata(chargeId: string): Promise<number | null> {
  const consulta = await culqi().getCharge(chargeId);
  if (!consulta.ok) return null;

  const metadata = (consulta.data as unknown as { metadata?: Record<string, string> }).metadata;
  const id = Number(metadata?.payment_id);
  if (!Number.isInteger(id) || id <= 0) return null;

  // La metadata la puso el backend al crear el cargo y se relee de Culqi con la llave privada.
  // Aun así se exige que la reserva anotada coincida con la del pago, si viene.
  const fila = await queryOne<{ id: number; booking_id: number }>('SELECT id, booking_id FROM payments WHERE id = ? LIMIT 1', [id]);
  if (!fila) return null;
  if (metadata?.booking_id !== undefined && Number(metadata.booking_id) !== Number(fila.booking_id)) return null;
  return fila.id;
}

async function marcarFallido(paymentId: number): Promise<void> {
  await withTransaction(async (connection) => {
    // Solo un intento todavía abierto: un pago ya cobrado no se degrada por un webhook.
    await connection.query(
      "UPDATE payments SET status = 'FAILED' WHERE id = ? AND status IN ('PENDING','PROCESSING')",
      [paymentId],
    );
  });
}

/** Pagos de Culqi todavía sin cerrar. Sirve para conciliar a mano si algo se quedó atrás. */
export async function pendingCulqiPayments(): Promise<unknown[]> {
  return query(
    `SELECT id, booking_id, amount, status, created_at FROM payments
     WHERE provider = 'CULQI' AND status = 'PROCESSING' ORDER BY id DESC LIMIT 100`,
  );
}
