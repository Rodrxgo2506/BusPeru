import type { PoolConnection } from 'mysql2/promise';
import { env } from '../config/env';
import { execute, pool, query, queryOne, withTransaction } from '../config/database';
import type { AuthenticatedUser, PaymentMethod } from '../types/entities';
import { ApiError } from '../utils/ApiError';
import { logError } from '../utils/logger';
import { recordSystemAudit } from './audit.service';
import { centsToDecimal, proportionalCents, toCentsExact } from '../utils/money';
import { loadCompanyCommission } from './company-commission.service';
import { assertCompanyCanSell } from './company-status.service';
import { NOTIFICATION_EVENTS, notify } from './notification.service';
import {
  confirmBookingPaymentOnConnection,
  isManualPaymentMethod,
  mergePaymentData,
  withDeadlockRetry,
} from './booking.service';
import {
  culqi,
  fromCents,
  isSuccessfulCharge,
  toCents,
  type CulqiCharge,
  type CulqiResult,
} from './culqi.service';

/**
 * Cobro con tarjeta a través de Culqi, en el modelo AGREGADOR: cobra BusPerú con una sola
 * cuenta de plataforma y liquida después a cada empresa con las comisiones y liquidaciones
 * que ya existían. `company_integrations` sigue guardando credenciales CULQI por empresa
 * para el panel, y NO interviene aquí.
 *
 * TRES FASES, y el motivo importa:
 *
 *   A. **Reservar la intención** (transacción). Se valida todo contra la base y se deja el
 *      pago en PROCESSING con el token anotado. Commit.
 *   B. **Cobrar** (SIN transacción). Se llama a Culqi.
 *   C. **Asentar el resultado** (transacción). Éxito → se confirma la reserva por el camino
 *      de siempre; fallo → el pago queda FAILED y la reserva intacta.
 *
 * Partirlo así no es un capricho. Confirmar una reserva bloquea la fila del viaje (BP-19 y
 * BP-21), y sostener ese cerrojo durante una llamada HTTP a un tercero dejaría en cola todas
 * las compras de ese viaje durante segundos. La red no puede ocurrir dentro de la
 * transacción.
 */

/** Lo que hace falta para cobrar, ya resuelto por el backend. Nada viene del cliente. */
interface PaymentIntent {
  paymentId: number;
  amount: number;
  amountCents: number;
  currency: string;
  email: string;
  bookingCode: string;
  companyId: number;
}

export interface CardPaymentOutcome {
  /**
   * `UNCONFIRMED` (H-29): Culqi no respondió a tiempo. No se sabe si hubo cobro, así que el mensaje
   * no afirma ni que se cobró ni que no; el webhook resolverá el resultado.
   */
  status: 'PAID' | 'DECLINED' | 'UNAVAILABLE' | 'UNCONFIRMED';
  message: string;
  /** Solo cuando el cobro salió bien; es el `chr_…` de Culqi. */
  chargeId?: string;
}

/** H-29: texto para un cobro con tarjeta de resultado desconocido. Sin detalles de Culqi. */
export const CARD_RESULT_UNCONFIRMED_MESSAGE =
  'Todavía no podemos confirmar si tu pago se realizó. Revisa Mis viajes en unos minutos antes de volver a intentarlo: si el cobro llegó a hacerse, confirmaremos tu reserva o te devolveremos el importe automáticamente.';

/** El único formato de token que Culqi entrega hoy para una tarjeta tokenizada. */
const TOKEN_VALIDO = /^(tkn|crd|ype)_[A-Za-z0-9_-]{8,}$/;

/**
 * Cobra una reserva con tarjeta.
 *
 * El importe, la moneda, el correo y la empresa salen SIEMPRE de la base de datos. Del
 * cliente se acepta exactamente un dato —el token de Culqi— y ni siquiera se confía en él
 * como prueba de pago: sirve para pedir el cargo, y quien dice si hubo cobro es Culqi.
 */
export async function payBookingWithCard(
  user: AuthenticatedUser,
  bookingId: number,
  token: string,
): Promise<CardPaymentOutcome> {
  if (!TOKEN_VALIDO.test(token)) throw ApiError.badRequest('El identificador de pago no es válido');

  // ── Fase A ────────────────────────────────────────────────────────────────────
  const intent = await reserveIntent(user, bookingId, token);
  if (intent === 'ALREADY_PAID') {
    return { status: 'PAID', message: 'Esta reserva ya estaba pagada.' };
  }

  // ── Fase B ────────────────────────────────────────────────────────────────────
  const resultado = await culqi().createCharge({
    amountCents: intent.amountCents,
    currencyCode: intent.currency,
    email: intent.email,
    sourceId: token,
    description: `Reserva ${intent.bookingCode} · BusPerú`,
    // Sirve para reconciliar en el panel de Culqi y para que el webhook encuentre la fila.
    metadata: {
      booking_id: String(bookingId),
      booking_code: intent.bookingCode,
      payment_id: String(intent.paymentId),
    },
  });

  // ── Fase C ────────────────────────────────────────────────────────────────────
  return settle(bookingId, intent, resultado);
}

/**
 * Fase A. Valida y deja la intención anotada, todo bajo el cerrojo de la fila del pago.
 *
 * Comprueba, en este orden: que la reserva existe y es de quien pregunta, que sigue en un
 * estado que admite cobro, que su retención no ha vencido, que conserva asientos, y cuál es
 * el importe real. Nada de eso se toma de la petición.
 */
async function reserveIntent(
  user: AuthenticatedUser,
  bookingId: number,
  token: string,
): Promise<PaymentIntent | 'ALREADY_PAID'> {
  return withTransaction(async (connection) => {
    const [filas] = await connection.query(
      `SELECT bk.id, bk.user_id, bk.status, bk.total_amount, bk.booking_code, bk.passenger_email,
              bk.expires_at, r.company_id, t.status AS trip_status,
              u.email AS account_email,
              (SELECT COUNT(*) FROM booking_seats bs WHERE bs.booking_id = bk.id) AS seats,
              (bk.expires_at IS NOT NULL AND bk.expires_at <= NOW()) AS vencida
       FROM bookings bk
       JOIN users u ON u.id = bk.user_id
       JOIN trips t ON t.id = bk.trip_id
       JOIN routes r ON r.id = t.route_id
       WHERE bk.id = ? LIMIT 1 FOR UPDATE`,
      [bookingId],
    );
    const booking = (filas as Record<string, unknown>[])[0];
    // 404 y no 403: no se confirma que exista una reserva ajena.
    if (!booking) throw ApiError.notFound('Reserva no encontrada');
    if (user.role !== 'ADMIN' && Number(booking.user_id) !== user.id) {
      throw ApiError.notFound('Reserva no encontrada');
    }

    if (booking.status === 'CONFIRMED' || booking.status === 'COMPLETED') return 'ALREADY_PAID';
    if (booking.status === 'CANCELLED' || booking.status === 'EXPIRED') {
      throw ApiError.badRequest('La reserva ya no está vigente');
    }
    if (Number(booking.vencida) === 1) {
      throw ApiError.badRequest('La reserva ya no está vigente');
    }
    // Antes de pedir nada a Culqi (FASE 8H): un viaje cancelado no se cobra. La confirmación
    // lo vuelve a comprobar bajo el cerrojo del viaje; esto evita el cargo en el caso normal.
    if (booking.trip_status === 'CANCELLED') {
      throw ApiError.badRequest('El viaje fue cancelado: esta reserva ya no se puede pagar');
    }
    if (Number(booking.seats) === 0) {
      throw ApiError.conflict('La reserva no tiene asientos asociados');
    }
    // H-46: antes de pedir el cargo. Una empresa sin comisión vigente no cobra; la confirmación lo
    // vuelve a comprobar, y si un cargo llegara igual quedaría cubierto por su compensatorio.
    await assertCompanyCanSell(Number(booking.company_id), connection);
    await loadCompanyCommission(connection, Number(booking.company_id));

    const amount = Number(booking.total_amount);
    if (!(amount > 0)) throw ApiError.badRequest('El importe de la reserva no es válido');

    // Idempotencia (1/2): si ya hay un cobro cerrado, no se vuelve a cobrar jamás.
    const [pagados] = await connection.query(
      "SELECT id FROM payments WHERE booking_id = ? AND status IN ('PAID','REFUNDED') LIMIT 1 FOR UPDATE",
      [bookingId],
    );
    if ((pagados as unknown[]).length > 0) return 'ALREADY_PAID';

    // Idempotencia (2/2): un intento ya en vuelo. Un doble clic, un F5 o un reintento del
    // navegador caen aquí y reciben un 409 en vez de un segundo cargo. La ventana la cierra
    // el propio cerrojo: la segunda petición espera a que la primera confirme su PROCESSING.
    const [enCurso] = await connection.query(
      "SELECT id FROM payments WHERE booking_id = ? AND status = 'PROCESSING' LIMIT 1 FOR UPDATE",
      [bookingId],
    );
    if ((enCurso as unknown[]).length > 0) {
      throw ApiError.conflict('Ya hay un pago en curso para esta reserva. Espera unos segundos.');
    }

    // Se reutiliza el pago PENDING que crea la reserva, si existe; si no, se crea uno.
    const [pendientes] = await connection.query(
      "SELECT id, currency FROM payments WHERE booking_id = ? AND status = 'PENDING' ORDER BY id DESC LIMIT 1 FOR UPDATE",
      [bookingId],
    );
    const pendiente = (pendientes as Array<{ id: number; currency: string }>)[0];

    let paymentId: number;
    let currency: string;
    if (pendiente) {
      paymentId = pendiente.id;
      currency = pendiente.currency || 'PEN';
      await connection.query(
        `UPDATE payments SET status = 'PROCESSING', method = 'CARD', provider = 'CULQI',
                             amount = ?, payment_data = ?
         WHERE id = ?`,
        [amount, JSON.stringify({ token, intent_at: new Date().toISOString() }), paymentId],
      );
    } else {
      currency = 'PEN';
      const [creado] = await connection.query(
        `INSERT INTO payments (booking_id, transaction_code, amount, currency, method, status, provider, payment_data)
         VALUES (?, ?, ?, ?, 'CARD', 'PROCESSING', 'CULQI', ?)`,
        [
          bookingId,
          `TRX-${String(booking.booking_code)}-${Date.now().toString().slice(-6)}`,
          amount,
          currency,
          JSON.stringify({ token, intent_at: new Date().toISOString() }),
        ],
      );
      paymentId = (creado as { insertId: number }).insertId;
    }

    return {
      paymentId,
      amount,
      amountCents: toCents(amount),
      currency,
      email: String(booking.passenger_email || booking.account_email),
      bookingCode: String(booking.booking_code),
      companyId: Number(booking.company_id),
    };
  });
}

/**
 * ¿El cargo que devuelve Culqi es el que BusPerú pidió?
 *
 * Una sola definición de la regla para las DOS vías que cierran un cobro con tarjeta: el
 * cobro síncrono (`settle`) y la reconciliación del webhook (`reconcileApprovedCharge`).
 * Antes cada una compraba lo suyo y no coincidían: la síncrona miraba importe Y moneda, la
 * del webhook solo el importe, de modo que un cargo declarado en otra divisa con el mismo
 * número de céntimos confirmaba la reserva (observación de F17C-SEC-03B).
 *
 * NO se convierte nada: una moneda distinta es un desacuerdo, no un tipo de cambio. Que el
 * importe cuadre no compensa que la divisa no lo haga. La comparación es exacta, igual que
 * la que ya hacía el cobro síncrono.
 *
 * Devuelve QUÉ no cuadra para que cada vía pueda decirlo con su propio vocabulario; `null`
 * significa que el cargo es el esperado.
 */
export type DesacuerdoCargo = 'amount' | 'currency' | null;

export function compararCargo(charge: CulqiCharge, amountCents: number, currency: string): DesacuerdoCargo {
  if (charge.amount !== amountCents) return 'amount';
  if (charge.currency_code !== currency) return 'currency';
  return null;
}

/** Fase C. Asienta lo que respondió Culqi. */
async function settle(
  bookingId: number,
  intent: PaymentIntent,
  resultado: CulqiResult<CulqiCharge>,
): Promise<CardPaymentOutcome> {
  if (!resultado.ok) {
    await markFailed(intent.paymentId, resultado.kind, resultado.merchantMessage);

    if (resultado.kind === 'UNCONFIGURED') {
      return { status: 'UNAVAILABLE', message: resultado.userMessage };
    }
    // Un TIMEOUT es el caso incómodo: el cobro pudo ocurrir igual. El pago queda FAILED y
    // el webhook, si el cargo existía, lo corregirá al llegar. Por eso no se reintenta solo, y
    // al pasajero no se le dice que el pago falló (H-29): se le dice que aún no se sabe.
    if (resultado.kind === 'TIMEOUT') {
      return { status: 'UNCONFIRMED', message: CARD_RESULT_UNCONFIRMED_MESSAGE };
    }
    return { status: 'DECLINED', message: resultado.userMessage };
  }

  const charge = resultado.data;

  // El importe y la moneda que devuelve Culqi tienen que ser los que BusPerú pidió. Si no
  // coinciden, no se confirma nada: es preferible un pago sin confirmar que una reserva
  // confirmada por un importe que no es el suyo. La regla vive en `compararCargo`, compartida
  // con la reconciliación del webhook; aquí el trato es el mismo para las dos discrepancias.
  if (compararCargo(charge, intent.amountCents, intent.currency) !== null) {
    await markFailed(
      intent.paymentId,
      'INVALID',
      `Culqi devolvió ${charge.amount} ${charge.currency_code} y se esperaba ${intent.amountCents} ${intent.currency}`,
    );
    throw ApiError.conflict('El cobro no coincide con el importe de la reserva. No se confirmó nada.');
  }

  if (!isSuccessfulCharge(charge)) {
    await markFailed(intent.paymentId, 'DECLINED', charge.outcome?.merchant_message ?? 'Cargo no aprobado');
    return { status: 'DECLINED', message: charge.outcome?.user_message ?? 'El pago fue rechazado.' };
  }

  return applySuccessfulCharge(bookingId, intent, charge);
}

/**
 * Cobro aceptado: se confirma la reserva por el MISMO camino de siempre.
 *
 * `confirmBookingPaymentOnConnection` ya bloquea viaje y reserva en el orden correcto,
 * revalida que los asientos sigan libres, cierra el pago, escribe el movimiento financiero
 * con su comisión y notifica. No se duplica nada de eso aquí.
 */
async function applySuccessfulCharge(
  bookingId: number,
  intent: PaymentIntent,
  charge: CulqiCharge,
): Promise<CardPaymentOutcome> {
  let conciliacion: ChargeReconciliation;
  try {
    conciliacion = await reconcileApprovedCharge(intent.paymentId, charge, 'El asiento dejó de estar disponible durante el cobro');
  } catch (error) {
    // Fallo de infraestructura con el dinero YA cobrado: se intenta dejar el cobro y su
    // reembolso registrados igualmente, en vez de perder el rastro. Si tampoco se puede, el pago
    // queda PROCESSING y el webhook de Culqi lo conciliará cuando llegue.
    await openCompensatingRefund(bookingId, intent.paymentId, charge, error);
    throw ApiError.conflict('El cobro se realizó pero la reserva ya no estaba disponible. Se registró un reembolso.');
  }

  switch (conciliacion.outcome) {
    case 'confirmed':
    case 'already_reconciled':
      return { status: 'PAID', message: 'Pago confirmado.', chargeId: charge.id };
    case 'compensated':
      // H-43: otro cargo ya había confirmado la reserva. Está pagada; este cobro se devuelve.
      if (conciliacion.bookingConfirmed) {
        return { status: 'PAID', message: 'Tu reserva ya estaba pagada. Este cobro adicional se devolverá.', chargeId: charge.id };
      }
      throw ApiError.conflict('El cobro se realizó pero la reserva ya no estaba disponible. Se registró un reembolso.');
    default:
      throw ApiError.conflict('El cobro no coincide con el intento de pago. No se confirmó nada.');
  }
}

/** Deja constancia del cargo en el pago: proveedor, identificador y datos no sensibles. */
async function recordChargeData(connection: PoolConnection, paymentId: number, charge: CulqiCharge): Promise<void> {
  await connection.query(
    `UPDATE payments SET provider = 'CULQI', payment_data = ? WHERE id = ?`,
    [
      // Del medio de pago solo se guarda lo que Culqi ya publica y no identifica una
      // tarjeta: marca y los últimos dígitos enmascarados que él mismo devuelve.
      JSON.stringify({
        charge_id: charge.id,
        outcome_type: charge.outcome?.type ?? null,
        card_brand: charge.source?.iin?.card_brand ?? null,
        card_number: charge.source?.card_number ?? null,
        reference_code: charge.reference_code ?? null,
      }),
      paymentId,
    ],
  );
}

/** Marca el intento como fallido. El motivo técnico se guarda, la credencial nunca. */
async function markFailed(paymentId: number, kind: string, detail: string): Promise<void> {
  await withTransaction(async (connection) => {
    await connection.query(
      `UPDATE payments SET status = 'FAILED', payment_data = ? WHERE id = ? AND status = 'PROCESSING'`,
      [JSON.stringify({ failure: kind, detail: detail.slice(0, 400) }), paymentId],
    );
  });
}

/**
 * Cobro sin reserva: se guarda el pago y se abre el reembolso por el camino existente.
 *
 * Lo usan las dos vías por las que BusPerú se entera de un cargo aprobado que ya no puede
 * confirmar: la respuesta HTTP del cobro y el webhook de Culqi (8H-CIERRE). Por eso es
 * IDEMPOTENTE: se bloquea el pago y, si ya está PAID o REFUNDED, otra vía ya lo resolvió y no
 * se hace nada; y el reembolso solo se inserta si el pago no tiene ya uno vivo. Devuelve si
 * abrió el reembolso en esta llamada.
 */
export async function openCompensatingRefund(
  bookingId: number,
  paymentId: number,
  charge: CulqiCharge,
  cause: unknown,
  reason = 'El asiento dejó de estar disponible durante el cobro',
): Promise<boolean> {
  logError('Cobro aceptado por Culqi sin poder confirmar la reserva', cause, {
    userId: undefined,
  });

  return withTransaction((connection) => openCompensatingRefundOnConnection(connection, bookingId, paymentId, charge, reason));
}

/**
 * Cuerpo del compensatorio sobre una transacción ya abierta. Deja el pago de ESE cargo en
 * PAID/CULQI con su `chr_…` y abre su reembolso.
 *
 * CONTABILIDAD (H-26). El cargo no es una venta de la empresa: la reserva no se confirmó con él.
 * Por eso no hay PAYMENT ni COMMISSION de empresa, y el dinero se registra en el LIBRO DE LA
 * PLATAFORMA (`company_id` NULL): aquí su entrada, `PAYMENT/CREDIT`, y al completarse la
 * devolución su salida, `REFUND/DEBIT`. La plataforma queda en 0 y la empresa no se entera. El
 * pago lleva además la marca explícita `compensation` en `payment_data`, para trazarlo.
 */
async function openCompensatingRefundOnConnection(
  connection: PoolConnection,
  bookingId: number,
  paymentId: number,
  charge: CulqiCharge,
  reason: string,
): Promise<boolean> {
  const [filas] = await connection.query('SELECT status FROM payments WHERE id = ? LIMIT 1 FOR UPDATE', [paymentId]);
  const estado = (filas as Array<{ status: string }>)[0]?.status;
  if (estado === undefined || estado === 'PAID' || estado === 'REFUNDED') return false;

  await connection.query(
    `UPDATE payments SET status = 'PAID', method = 'CARD', provider = 'CULQI', provider_transaction_id = ?, paid_at = NOW()
     WHERE id = ?`,
    [charge.id, paymentId],
  );
  await recordChargeData(connection, paymentId, charge);
  const [dataRows] = await connection.query('SELECT payment_data FROM payments WHERE id = ? LIMIT 1', [paymentId]);
  await connection.query('UPDATE payments SET payment_data = ? WHERE id = ?', [
    mergePaymentData((dataRows as Array<{ payment_data: string | null }>)[0]?.payment_data ?? null, {
      compensation: { reason, at: new Date().toISOString() },
    }),
    paymentId,
  ]);
  await recordPlatformCompensationCharge(connection, bookingId, paymentId, fromCents(charge.amount));
  await connection.query(
    `INSERT INTO refunds (payment_id, booking_id, amount, reason, status)
     SELECT ?, ?, ?, ?, 'PENDING' FROM DUAL
     WHERE NOT EXISTS (
       SELECT 1 FROM refunds WHERE payment_id = ? AND status NOT IN ('FAILED', 'CANCELLED')
     )`,
    [paymentId, bookingId, fromCents(charge.amount), reason, paymentId],
  );

  // F18-07 · rastro en `audit_logs` DENTRO de la misma transacción: o queda el pago cobrado, su
  // movimiento compensatorio, el reembolso abierto y su registro, o no queda nada. Actor de
  // sistema (`user_id` NULL); ningún dato del medio de pago, solo identificadores públicos.
  const [reembolsos] = await connection.query(
    "SELECT id FROM refunds WHERE payment_id = ? AND status NOT IN ('FAILED', 'CANCELLED') ORDER BY id DESC LIMIT 1",
    [paymentId],
  );
  await recordSystemAudit(
    {
      action: 'COMPENSATE',
      entityType: 'payments',
      entityId: paymentId,
      actor: 'system:payments',
      description: `Cobro sin reserva confirmable: pago cobrado y reembolso compensatorio abierto (reserva #${bookingId}, cargo ${charge.id})`,
      oldValues: { status: estado },
      newValues: {
        status: 'PAID',
        booking_id: bookingId,
        charge_id: charge.id,
        amount: fromCents(charge.amount),
        refund_id: (reembolsos as Array<{ id: number }>)[0]?.id ?? null,
        refund_status: 'PENDING',
        reason,
      },
    },
    connection,
  );

  // H-29 · caso C: el pasajero pudo haber leído antes que no hubo cobro o que el resultado era
  // incierto. Ahora se sabe que sí lo hubo, así que se le avisa de que se devolverá. Una vez por pago.
  const [bookingRows] = await connection.query('SELECT user_id, booking_code FROM bookings WHERE id = ? LIMIT 1', [bookingId]);
  const reserva = (bookingRows as Array<{ user_id: number; booking_code: string }>)[0];
  if (reserva) {
    await notify(connection, {
      userId: Number(reserva.user_id),
      event: NOTIFICATION_EVENTS.PAYMENT_COMPENSATED,
      eventKey: `${NOTIFICATION_EVENTS.PAYMENT_COMPENSATED}:${paymentId}`,
      context: { booking_code: reserva.booking_code, booking_id: bookingId, amount: `S/ ${fromCents(charge.amount).toFixed(2)}` },
    });
  }
  return true;
}

/**
 * Entrada del cargo compensatorio en el libro de la plataforma (`company_id` NULL). Idempotente:
 * un pago tiene como mucho una. Se usa al abrir el compensatorio y, por si el pago venía de antes de
 * este cambio, también al completar su devolución.
 */
async function recordPlatformCompensationCharge(connection: PoolConnection, bookingId: number, paymentId: number, amount: string | number): Promise<void> {
  await connection.query(
    `INSERT INTO financial_transactions (company_id, booking_id, payment_id, type, direction, amount, currency, description, status, transaction_date)
     SELECT NULL, ?, ?, 'PAYMENT', 'CREDIT', ?, 'PEN', ?, 'COMPLETED', NOW() FROM DUAL
     WHERE NOT EXISTS (
       SELECT 1 FROM financial_transactions WHERE payment_id = ? AND type = 'PAYMENT' AND company_id IS NULL
     )`,
    [bookingId, paymentId, centsToDecimal(toCentsExact(String(amount))), `Cobro compensatorio de la reserva #${bookingId} (plataforma)`, paymentId],
  );
}

/**
 * Asiento de un reembolso que acaba de completarse (H-26 · H-27 · H-28). Se llama dentro de la
 * transacción de cierre, con el reembolso ya COMPLETED y bajo el cerrojo del pago de H-44.
 *
 *   · COMPENSATORIO —el pago no tiene PAYMENT de empresa, es decir, no fue una venta—: la devolución
 *     sale del libro de la plataforma (`REFUND/DEBIT`, `company_id` NULL). Ni la empresa ni su
 *     comisión se tocan.
 *   · VENTA: `REFUND/DEBIT` de la empresa y reversión PROPORCIONAL de su comisión como
 *     `COMMISSION/CREDIT`, en céntimos y con el método acumulado:
 *         reversión_total = round(C × R / P)   ·   reversión = reversión_total − revertido antes
 *     con C = comisión original, P = importe del pago y R = Σ reembolsos COMPLETED (incluido este).
 *     La suma de las reversiones no deriva por redondeo y llega exactamente a C al devolverse todo.
 *   · ESTADO DEL PAGO: sigue PAID mientras quede saldo y pasa a REFUNDED solo cuando
 *     Σ reembolsos COMPLETED = importe del pago. Los PENDING, PROCESSING, FAILED o CANCELLED no cuentan.
 */
/** Cómo se repartió el cobro de una venta entre la empresa y la plataforma (H-45 · cupones). */
export interface RefundAllocationBasis {
  paymentCents: number;
  /** PAYMENT/CREDIT de la empresa: su base, incluido el subsidio de un cupón de plataforma. */
  companyBaseCents: number;
  /** ADJUSTMENT/DEBIT de la plataforma: descuento de cupón de plataforma asumido por BusPerú. */
  platformDiscountCents: number;
  /** PAYMENT/CREDIT de la plataforma: service fee. */
  serviceFeeCents: number;
  /** Parte del cobro que pagó el pasajero a la empresa: base − subsidio. */
  companyCashCents: number;
}

/**
 * Base de reparto de los reembolsos de un pago, DERIVADA DE SUS PROPIOS MOVIMIENTOS de venta; no
 * se guarda nada nuevo. Devuelve `null` si el pago no fue una venta (compensatorio, H-26).
 *
 * Una venta anterior a 11E-3 tiene un único PAYMENT de empresa por el total y ningún movimiento de
 * plataforma: su base de empresa es el cobro entero y el reparto reproduce exactamente el de antes.
 * Si los movimientos no cuadran con el cobro, se detiene el cierre ANTES de pedir nada a Culqi.
 */
export async function saleRefundBasis(consultar: ConsultaFilas, paymentId: number): Promise<RefundAllocationBasis | null> {
  const [fila] = await consultar<{ ventas: number; company_base: string; service_fee: string; platform_discount: string; amount: string }>(
    `SELECT
       (SELECT COUNT(*) FROM financial_transactions WHERE payment_id = p.id AND type = 'PAYMENT' AND company_id IS NOT NULL) AS ventas,
       (SELECT COALESCE(SUM(amount), 0) FROM financial_transactions WHERE payment_id = p.id AND type = 'PAYMENT' AND direction = 'CREDIT' AND company_id IS NOT NULL) AS company_base,
       (SELECT COALESCE(SUM(amount), 0) FROM financial_transactions WHERE payment_id = p.id AND type = 'PAYMENT' AND direction = 'CREDIT' AND company_id IS NULL) AS service_fee,
       (SELECT COALESCE(SUM(amount), 0) FROM financial_transactions WHERE payment_id = p.id AND type = 'ADJUSTMENT' AND direction = 'DEBIT' AND company_id IS NULL) AS platform_discount,
       p.amount
     FROM payments p WHERE p.id = ? LIMIT 1`,
    [paymentId],
  );
  if (!fila || Number(fila.ventas) === 0) return null;
  const paymentCents = toCentsExact(String(fila.amount));
  const companyBaseCents = toCentsExact(String(fila.company_base));
  const serviceFeeCents = toCentsExact(String(fila.service_fee));
  const platformDiscountCents = toCentsExact(String(fila.platform_discount));
  const companyCashCents = companyBaseCents - platformDiscountCents;
  if (paymentCents <= 0 || companyCashCents < 0 || companyCashCents + serviceFeeCents !== paymentCents) {
    logError('Reembolso detenido: los movimientos de la venta no cuadran con el cobro', new Error(`pago ${paymentId}`), {});
    throw ApiError.conflict('No se puede completar este reembolso porque la contabilidad del pago no cuadra. Contacta con soporte.');
  }
  return { paymentCents, companyBaseCents, platformDiscountCents, serviceFeeCents, companyCashCents };
}

export async function recordCompletedRefund(
  connection: PoolConnection,
  refund: { id: number; payment_id: number; booking_id: number; amount: string | number; company_id: number },
): Promise<{ compensatory: boolean; commissionReversed: number; paymentStatus: 'PAID' | 'REFUNDED' }> {
  const consultar = async <T>(sql: string, params: unknown[]) => (await connection.query(sql, params))[0] as T[];
  const paymentId = Number(refund.payment_id);
  const bookingId = Number(refund.booking_id);

  const [pago] = await consultar<{ amount: string }>('SELECT amount FROM payments WHERE id = ? LIMIT 1', [paymentId]);
  const importeCents = toCentsExact(String(pago!.amount));
  const base = await saleRefundBasis(consultar, paymentId);
  const compensatory = base === null;
  const reembolsoCents = toCentsExact(String(refund.amount));

  let commissionReversed = 0;
  if (compensatory) {
    await recordPlatformCompensationCharge(connection, bookingId, paymentId, pago!.amount);
    await connection.query(
      `INSERT INTO financial_transactions (company_id, booking_id, payment_id, type, direction, amount, currency, description, status, transaction_date)
       VALUES (NULL, ?, ?, 'REFUND', 'DEBIT', ?, 'PEN', ?, 'COMPLETED', NOW())`,
      [bookingId, paymentId, centsToDecimal(reembolsoCents), `Devolución compensatoria de la reserva #${bookingId} (plataforma)`],
    );
  } else {
    /**
     * H-45 · REPARTO DE LA DEVOLUCIÓN, acumulado y en céntimos (R = Σ reembolsos COMPLETED):
     *   empresa   REFUND/DEBIT      round(caja_empresa × R / P)      caja_empresa = base − subsidio
     *   plataforma REFUND/DEBIT     R − lo anterior                   (service fee, nunca > fee)
     *   empresa   ADJUSTMENT/DEBIT  round(subsidio × R / P)          devuelve el subsidio de un
     *   plataforma ADJUSTMENT/CREDIT el mismo importe                  cupón de plataforma
     * Cada paso asienta la diferencia con lo ya asentado. Los REFUND suman exactamente lo devuelto
     * y, al devolverse todo, empresa y plataforma vuelven a cero. Sin fee ni cupón de plataforma
     * (y en ventas anteriores a 11E-3) todo va a la empresa, igual que antes.
     */
    const b = base!;
    const [devueltoTotal] = await consultar<{ total: string }>(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE payment_id = ? AND status = 'COMPLETED'",
      [paymentId],
    );
    const acumuladoCents = Math.min(toCentsExact(String(devueltoTotal?.total ?? '0')), b.paymentCents);
    const [previos] = await consultar<{ empresa: string; plataforma: string; subsidio: string }>(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'REFUND' AND company_id IS NOT NULL THEN amount END), 0) AS empresa,
         COALESCE(SUM(CASE WHEN type = 'REFUND' AND company_id IS NULL THEN amount END), 0) AS plataforma,
         COALESCE(SUM(CASE WHEN type = 'ADJUSTMENT' AND direction = 'DEBIT' AND company_id IS NOT NULL THEN amount END), 0) AS subsidio
       FROM financial_transactions WHERE payment_id = ? AND direction = 'DEBIT'`,
      [paymentId],
    );
    const empresaObjetivo = proportionalCents(b.companyCashCents, acumuladoCents, b.paymentCents);
    const plataformaObjetivo = acumuladoCents - empresaObjetivo;
    const subsidioObjetivo = proportionalCents(b.platformDiscountCents, acumuladoCents, b.paymentCents);
    const empresaCents = Math.max(0, empresaObjetivo - toCentsExact(String(previos?.empresa ?? '0')));
    const plataformaCents = Math.max(0, plataformaObjetivo - toCentsExact(String(previos?.plataforma ?? '0')));
    const subsidioCents = Math.max(0, subsidioObjetivo - toCentsExact(String(previos?.subsidio ?? '0')));

    const asentar = (companyId: number | null, type: string, direction: string, cents: number, description: string) =>
      connection.query(
        `INSERT INTO financial_transactions (company_id, booking_id, payment_id, type, direction, amount, currency, description, status, transaction_date)
         VALUES (?, ?, ?, ?, ?, ?, 'PEN', ?, 'COMPLETED', NOW())`,
        [companyId, bookingId, paymentId, type, direction, centsToDecimal(cents), description],
      );
    if (empresaCents > 0) await asentar(refund.company_id, 'REFUND', 'DEBIT', empresaCents, `Reembolso de la reserva #${bookingId}`);
    if (plataformaCents > 0) await asentar(null, 'REFUND', 'DEBIT', plataformaCents, `Devolución del cargo por servicio de la reserva #${bookingId} (plataforma)`);
    if (subsidioCents > 0) {
      await asentar(refund.company_id, 'ADJUSTMENT', 'DEBIT', subsidioCents, `Devolución del subsidio de cupón de plataforma de la reserva #${bookingId}`);
      await asentar(null, 'ADJUSTMENT', 'CREDIT', subsidioCents, `Recupero del subsidio de cupón de plataforma de la reserva #${bookingId} (plataforma)`);
    }

    const [comision] = await consultar<{ original: string; revertida: string }>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount END), 0) AS original,
              COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount END), 0) AS revertida
       FROM financial_transactions WHERE payment_id = ? AND type = 'COMMISSION' AND company_id IS NOT NULL`,
      [paymentId],
    );
    const [devuelto] = await consultar<{ total: string }>(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE payment_id = ? AND status = 'COMPLETED'",
      [paymentId],
    );
    const originalCents = toCentsExact(String(comision?.original ?? '0'));
    const yaRevertidaCents = toCentsExact(String(comision?.revertida ?? '0'));
    const objetivoCents = proportionalCents(originalCents, toCentsExact(String(devuelto?.total ?? '0')), importeCents);
    const reversionCents = objetivoCents - yaRevertidaCents;
    if (reversionCents > 0) {
      await connection.query(
        `INSERT INTO financial_transactions (company_id, booking_id, payment_id, type, direction, amount, currency, description, status, transaction_date)
         VALUES (?, ?, ?, 'COMMISSION', 'CREDIT', ?, 'PEN', ?, 'COMPLETED', NOW())`,
        [refund.company_id, bookingId, paymentId, centsToDecimal(reversionCents), `Reversión proporcional de comisión por el reembolso #${refund.id}`],
      );
      commissionReversed = reversionCents;
    }
  }

  const [completado] = await consultar<{ total: string }>(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE payment_id = ? AND status = 'COMPLETED'",
    [paymentId],
  );
  const paymentStatus = toCentsExact(String(completado?.total ?? '0')) >= importeCents ? 'REFUNDED' : 'PAID';
  await connection.query('UPDATE payments SET status = ? WHERE id = ?', [paymentStatus, paymentId]);
  return { compensatory, commissionReversed, paymentStatus };
}

export type ChargeReconciliation =
  | { outcome: 'confirmed' | 'already_reconciled'; paymentId: number; bookingId: number }
  | { outcome: 'compensated'; paymentId: number; bookingId: number; bookingConfirmed: boolean; opened: boolean }
  | { outcome: 'amount_mismatch' | 'currency_mismatch' | 'charge_mismatch'; paymentId: number; bookingId: number }
  | { outcome: 'not_found'; paymentId: number };

/**
 * Concilia UN cargo aprobado de Culqi con SU pago (H-42 · H-43).
 *
 * LA CORRELACIÓN ES EL PAGO DEL INTENTO, NO LA RESERVA. Cada intento con tarjeta tiene su fila en
 * `payments` y su id viaja a Culqi en `metadata.payment_id`: la respuesta HTTP lo trae en el
 * intento y el webhook lo relee del cargo con la llave privada. Antes se confirmaba «la reserva»
 * reutilizando su último pago PENDING/PROCESSING, y eso fallaba justo tras un TIMEOUT:
 *
 *   · H-42: el pago del intento ya estaba FAILED, así que se INSERTABA otro pago sin `provider` y
 *     su reembolso se cerraba sin pedir la devolución a Culqi.
 *   · H-43: si otro cargo ya había confirmado la reserva, la confirmación salía sin hacer nada y el
 *     primer cobro quedaba sin registrar ni devolver.
 *
 * REGLA. Todo cargo aprobado acaba en su propio pago PAID, `provider = CULQI` y `chr_…`, y o
 * confirma la reserva (venta y comisión, como siempre) o deja su reembolso PENDING:
 *
 *   · pago ya PAID/REFUNDED con este cargo → `already_reconciled` (webhook repetido o tardío);
 *   · la reserva ya está CONFIRMED por OTRO pago → no se toca; compensatorio de este cargo;
 *   · la reserva es confirmable → se confirma ESTE pago;
 *   · no es confirmable (viaje o reserva cancelados, vencida, asiento tomado) → se deshace la
 *     transacción y se abre el compensatorio, igual que antes.
 *
 * Bloquea viaje → reserva → pago, el orden de la venta, la cancelación y la expiración, con
 * `withDeadlockRetry`: dos webhooks, un webhook y un reintento, o un webhook y una cancelación, se
 * serializan y el segundo ve el estado ya conciliado. Los rechazos de negocio se convierten en
 * compensatorio; un fallo de infraestructura se propaga.
 */
export async function reconcileApprovedCharge(
  paymentId: number,
  charge: CulqiCharge,
  compensationReason: string,
  /**
   * F18-07 · quién concilia, para `audit_logs` (p. ej. `system:culqi-webhook`). El cobro síncrono
   * no lo pasa: esa vía ya audita la acción de la persona en la ruta y no debe duplicarse.
   */
  origen?: string,
): Promise<ChargeReconciliation> {
  const ref = await queryOne<{ booking_id: number }>('SELECT booking_id FROM payments WHERE id = ? LIMIT 1', [paymentId]);
  if (!ref) return { outcome: 'not_found', paymentId };
  const bookingId = Number(ref.booking_id);

  try {
    return await withDeadlockRetry(() =>
      withTransaction(async (connection): Promise<ChargeReconciliation> => {
        const [tripRows] = await connection.query('SELECT trip_id FROM bookings WHERE id = ? LIMIT 1', [bookingId]);
        const tripId = (tripRows as Array<{ trip_id: number }>)[0]?.trip_id;
        await connection.query('SELECT id FROM trips WHERE id = ? LIMIT 1 FOR UPDATE', [tripId]);
        const [bookingRows] = await connection.query('SELECT status FROM bookings WHERE id = ? LIMIT 1 FOR UPDATE', [bookingId]);
        const bookingStatus = (bookingRows as Array<{ status: string }>)[0]?.status;
        const [paymentRows] = await connection.query(
          'SELECT status, amount, currency, provider_transaction_id FROM payments WHERE id = ? LIMIT 1 FOR UPDATE',
          [paymentId],
        );
        const payment = (paymentRows as Array<{ status: string; amount: string; currency: string; provider_transaction_id: string | null }>)[0]!;

        if (payment.status === 'PAID' || payment.status === 'REFUNDED') {
          if (payment.provider_transaction_id === charge.id) return { outcome: 'already_reconciled', paymentId, bookingId };
          logError('Un cargo aprobado de Culqi apunta a un pago ya cerrado con otro cargo', new Error(`cargo ${charge.id}`), {});
          await auditarRechazo(connection, origen, paymentId, bookingId, charge.id, 'charge_mismatch', 'el pago ya estaba cerrado con otro cargo');
          return { outcome: 'charge_mismatch', paymentId, bookingId };
        }

        /**
         * El orden importa y es deliberado: PRIMERO se resuelve si el pago ya estaba cerrado
         * —eso es la idempotencia del replay y va antes que nada— y solo después se comprueba
         * que el cargo sea el esperado, importe y moneda, con la misma regla que el cobro
         * síncrono. Ninguna de las dos discrepancias escribe nada.
         */
        const desacuerdo = compararCargo(charge, toCents(payment.amount), payment.currency || 'PEN');
        if (desacuerdo === 'amount') {
          logError('Un cargo de Culqi trajo un importe distinto al del pago', new Error(`cargo ${charge.amount} vs pago ${payment.amount}`), {});
          await auditarRechazo(connection, origen, paymentId, bookingId, charge.id, 'amount_mismatch', 'importe distinto al del pago');
          return { outcome: 'amount_mismatch', paymentId, bookingId };
        }
        if (desacuerdo === 'currency') {
          logError(
            'Un cargo de Culqi trajo una moneda distinta a la del pago',
            new Error(`cargo ${String(charge.currency_code)} vs pago ${payment.currency}`),
            {},
          );
          await auditarRechazo(connection, origen, paymentId, bookingId, charge.id, 'currency_mismatch', 'moneda distinta a la del pago');
          return { outcome: 'currency_mismatch', paymentId, bookingId };
        }

        if (bookingStatus === 'CONFIRMED' || bookingStatus === 'COMPLETED') {
          const opened = await openCompensatingRefundOnConnection(
            connection,
            bookingId,
            paymentId,
            charge,
            'Cobro adicional sobre una reserva ya pagada con otro cargo',
          );
          return { outcome: 'compensated', paymentId, bookingId, bookingConfirmed: true, opened };
        }

        // El pago de ESTE cargo, con su proveedor y su identificador reales, pasa a confirmarse.
        await connection.query(
          "UPDATE payments SET status = 'PROCESSING', method = 'CARD', provider = 'CULQI', provider_transaction_id = ? WHERE id = ?",
          [charge.id, paymentId],
        );
        await confirmBookingPaymentOnConnection(connection, bookingId, 'CARD', charge.id, paymentId);
        await recordChargeData(connection, paymentId, charge);
        if (origen) {
          // F18-07 · la confirmación por webhook no tiene persona detrás: se audita aquí, en la
          // misma transacción que confirma la reserva y escribe sus movimientos.
          await recordSystemAudit(
            {
              action: 'CONFIRM',
              entityType: 'bookings',
              entityId: bookingId,
              actor: origen,
              description: `Confirmó la reserva #${bookingId} al conciliar el cargo ${charge.id} (pago #${paymentId})`,
              oldValues: { status: bookingStatus, payment_status: payment.status },
              newValues: { status: 'CONFIRMED', payment_id: paymentId, payment_status: 'PAID', charge_id: charge.id },
            },
            connection,
          );
        }
        return { outcome: 'confirmed', paymentId, bookingId };
      }),
    );
  } catch (error) {
    if (!(error instanceof ApiError) || error.statusCode >= 500) throw error;
    // La reserva no se puede confirmar: la transacción se deshizo entera. El cargo queda
    // registrado en su pago y cubierto por un reembolso. Idempotente si otra vía se adelantó.
    const opened = await openCompensatingRefund(bookingId, paymentId, charge, error, compensationReason);
    return { outcome: 'compensated', paymentId, bookingId, bookingConfirmed: false, opened };
  }
}

/**
 * Devuelve el dinero por Culqi antes de cerrar un reembolso de BusPerú.
 *
 * Se llama FUERA de la transacción que cierra el reembolso, por el mismo motivo que el
 * cobro: esa transacción bloquea filas y una llamada de red no puede sostenerlas.
 *
 * No inventa un sistema nuevo de reembolsos. El de BusPerú —importe disponible, prohibición
 * de reembolsar dos veces, separación entre crear y procesar— sigue mandando; esto solo
 * añade el paso que faltaba: mover el dinero de verdad.
 *
 * Devuelve el `ref_…` de Culqi, o `null` cuando el pago no se cobró por la pasarela (efectivo,
 * transferencia o datos anteriores a esta integración), en cuyo caso el reembolso se cierra
 * como siempre porque el dinero se devuelve por fuera.
 */
/**
 * F18-07 · un cargo que NO se concilia (importe, moneda u otro cargo) no cambia nada, pero es un
 * suceso de seguridad: queda en `audit_logs` cuando hay un origen de sistema que lo atribuya.
 */
async function auditarRechazo(
  connection: PoolConnection,
  origen: string | undefined,
  paymentId: number,
  bookingId: number,
  chargeId: string,
  outcome: 'amount_mismatch' | 'currency_mismatch' | 'charge_mismatch',
  motivo: string,
): Promise<void> {
  if (!origen) return;
  await recordSystemAudit(
    {
      action: 'REJECT',
      entityType: 'payments',
      entityId: paymentId,
      actor: origen,
      description: `No concilió el cargo ${chargeId}: ${motivo}`,
      newValues: { outcome, booking_id: bookingId, charge_id: chargeId },
    },
    connection,
  );
}

export async function refundThroughCulqi(refundId: number): Promise<string | null> {
  const fila = await queryOne<{
    amount: string;
    provider: string | null;
    provider_refund_id: string | null;
    charge_id: string | null;
    refund_status: string;
  }>(
    `SELECT rf.amount, rf.provider_refund_id, rf.status AS refund_status,
            p.provider, p.provider_transaction_id AS charge_id
     FROM refunds rf JOIN payments p ON p.id = rf.payment_id
     WHERE rf.id = ? LIMIT 1`,
    [refundId],
  );
  if (!fila) throw ApiError.notFound('Reembolso no encontrado');

  // Idempotencia: si ya se devolvió por Culqi, no se vuelve a pedir.
  if (fila.provider_refund_id) return fila.provider_refund_id;
  // Se decide por el CARGO, no solo por la etiqueta del proveedor (H-42): un pago con un
  // `chr_…` de Culqi se devuelve por Culqi aunque su `provider` hubiera quedado vacío. Sin cargo
  // (efectivo, transferencia, datos antiguos) el dinero se devuelve por fuera, como siempre.
  const chargeId = fila.charge_id;
  if (!chargeId || (fila.provider !== 'CULQI' && !chargeId.startsWith('chr_'))) return null;

  const resultado = await culqi().createRefund({
    chargeId,
    amountCents: toCents(fila.amount),
    reason: 'solicitud del pasajero',
  });

  if (!resultado.ok) {
    // El reembolso se queda como estaba: se puede reintentar sin haber movido nada.
    throw ApiError.badRequest(`No se pudo devolver el importe: ${resultado.userMessage}`);
  }

  // Se anota YA, antes de cerrar el reembolso. Si lo que viene después fallara —la base, un
  // reinicio—, el siguiente intento encuentra el identificador y no pide a Culqi una segunda
  // devolución del mismo dinero.
  await execute('UPDATE refunds SET provider_refund_id = ? WHERE id = ? AND provider_refund_id IS NULL', [
    resultado.data.id,
    refundId,
  ]);
  return resultado.data.id;
}

/**
 * Ejecuta el procesamiento de un reembolso en exclusiva con TODOS los reembolsos de su pago
 * (FASE 8H; ampliado en H-44).
 *
 * POR QUÉ UN CERROJO CON NOMBRE Y NO UNA FILA BLOQUEADA. El proceso tiene que llamar a Culqi,
 * y esa llamada de red no puede ir dentro de una transacción que sostenga cerrojos de fila.
 * `GET_LOCK` de MariaDB da exclusión entre peticiones —y entre instancias del backend— sin
 * abrir transacción, y se libera solo si el proceso muere, porque pertenece a la conexión.
 * No añade estados nuevos a `refunds` ni cambia el significado de PROCESSING.
 *
 * POR PAGO Y NO POR REEMBOLSO (H-44). Con un cerrojo por reembolso, dos reembolsos del MISMO
 * pago se procesaban a la vez: cada uno comprobaba lo ya devuelto sin ver al otro y ambos
 * pedían su devolución a Culqi, superando lo cobrado. El límite del importe solo se puede
 * garantizar si todos los cierres de un pago —comprobación, Culqi y cierre local— van en fila.
 * `payment_id` de un reembolso no cambia nunca, así que se puede leer antes de bloquear.
 *
 * Con espera 0: una segunda petición simultánea sobre un reembolso del mismo pago no espera,
 * recibe 409 y no llega a Culqi; puede reintentarse. El nombre lleva la base para no chocar
 * con otra instalación que comparta servidor.
 */
export async function withRefundLock<T>(refundId: number, handler: () => Promise<T>): Promise<T> {
  const refund = await queryOne<{ payment_id: number }>('SELECT payment_id FROM refunds WHERE id = ? LIMIT 1', [refundId]);
  if (!refund) throw ApiError.notFound('Reembolso no encontrado');
  const name = `${env.db.name}:refund-payment:${refund.payment_id}`;
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.query('SELECT GET_LOCK(?, 0) AS adquirido', [name]);
    if (Number((rows as Array<{ adquirido: number | null }>)[0]?.adquirido) !== 1) {
      throw ApiError.conflict('Este reembolso ya se está procesando. Inténtalo de nuevo en unos segundos.');
    }
    try {
      return await handler();
    } finally {
      await connection.query('SELECT RELEASE_LOCK(?)', [name]);
    }
  } finally {
    connection.release();
  }
}

/** Estados en los que `POST /refunds/:id/process` puede cerrar un reembolso (H-44). */
export const REFUND_CLOSING_STATUSES = ['COMPLETED', 'CANCELLED', 'FAILED'] as const;
export type RefundClosingStatus = (typeof REFUND_CLOSING_STATUSES)[number];

type ConsultaFilas = <T>(sql: string, params: unknown[]) => Promise<T[]>;

/**
 * Reglas para cerrar un reembolso (auditoría 11C, hallazgo H-44). Se evalúan DOS veces, siempre
 * bajo el cerrojo del pago (`withRefundLock`): antes de pedir nada a Culqi y otra vez dentro de la
 * transacción que cierra el reembolso, sobre su fila ya bloqueada.
 *
 *   · COMPLETED, CANCELLED y FAILED son TERMINALES. Antes solo lo era COMPLETED: un reembolso
 *     rechazado o fallido liberaba su importe para crear otro y después también podía
 *     completarse, devolviendo dos veces el mismo dinero. Reintentar un FAILED es crear un
 *     reembolso NUEVO, que vuelve a pasar por el límite del importe.
 *   · Un reembolso con `provider_refund_id` ya tiene el dinero devuelto por Culqi —su cierre local
 *     no llegó a completarse—: solo puede completarse, nunca rechazarse ni marcarse fallido.
 *   · Completar nunca puede dejar Σ reembolsos COMPLETED por encima del importe del pago. Se
 *     comprueba al cerrar, no solo al crear: protege de reembolsos vivos que la API ya no dejaría
 *     crear (datos antiguos o una carrera en el alta).
 */
export async function assertRefundCanClose(consultar: ConsultaFilas, refundId: number, status: RefundClosingStatus): Promise<void> {
  const [refund] = await consultar<{ status: string; amount: string; payment_id: number; provider_refund_id: string | null }>(
    'SELECT status, amount, payment_id, provider_refund_id FROM refunds WHERE id = ? LIMIT 1',
    [refundId],
  );
  if (!refund) throw ApiError.notFound('Reembolso no encontrado');
  if (refund.status === 'COMPLETED') throw ApiError.badRequest('El reembolso ya fue procesado');
  if (refund.status === 'CANCELLED' || refund.status === 'FAILED') {
    throw ApiError.badRequest(
      `El reembolso ya está cerrado (${refund.status === 'CANCELLED' ? 'rechazado' : 'fallido'}) y no se puede volver a procesar. Si hace falta devolver ese importe, crea un reembolso nuevo.`,
    );
  }
  if (refund.provider_refund_id && status !== 'COMPLETED') {
    throw ApiError.conflict('Culqi ya devolvió este importe: el reembolso solo puede completarse');
  }
  if (status !== 'COMPLETED') return;

  const [pago] = await consultar<{ amount: string }>('SELECT amount FROM payments WHERE id = ? LIMIT 1', [refund.payment_id]);
  const [yaDevuelto] = await consultar<{ total: string }>(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE payment_id = ? AND status = 'COMPLETED' AND id <> ?",
    [refund.payment_id, refundId],
  );
  const disponible = toCents(pago?.amount ?? 0) - toCents(yaDevuelto?.total ?? 0);
  if (toCents(refund.amount) > disponible) {
    throw ApiError.conflict(
      `Completar este reembolso superaría lo cobrado: quedan S/ ${fromCents(Math.max(disponible, 0)).toFixed(2)} por devolver de este pago`,
    );
  }
  // H-45: el reparto entre empresa y plataforma tiene que poder hacerse; si no, se detiene aquí,
  // antes de pedir la devolución a Culqi.
  await saleRefundBasis(consultar, refund.payment_id);
}

/** `assertRefundCanClose` con consultas fuera de transacción. */
export const consultarFilas: ConsultaFilas = <T>(sql: string, params: unknown[]) => query<T>(sql, params);

// --- Verificación manual de pagos (auditoría FASE 9, hallazgo H-22) ---------------------

export type ManualPaymentDecision = 'APPROVE' | 'REJECT';
export type ManualPaymentOutcome = 'APPROVED' | 'ALREADY_APPROVED' | 'REJECTED' | 'ALREADY_REJECTED';

/**
 * Aprueba o rechaza un pago manual (Yape, Plin, transferencia, efectivo u otro) desde el
 * backoffice. El alcance por empresa lo comprueba la ruta ANTES de llamar aquí.
 *
 * APROBAR delega en `confirmBookingPaymentOnConnection`, el mismo cuerpo que ya confirmaba
 * pagos: pago PAID, reserva CONFIRMED, un `PAYMENT`, su `COMMISSION` y el aviso. Se le pasa
 * el id del pago para que confirme ESE pago y no otro.
 *
 * RECHAZAR deja el pago FAILED. La reserva no se confirma y sigue PENDING con su retención:
 * el pasajero puede pagar de otro modo antes de que venza, y si vence la expiración libera
 * los asientos como siempre. No hay movimientos ni reembolso: no entró dinero.
 *
 * IDEMPOTENCIA Y CONCURRENCIA. Todo ocurre en una transacción que bloquea viaje → reserva →
 * pago, el mismo orden que la venta, la confirmación, la expiración y la cancelación. Dos
 * aprobaciones simultáneas se serializan en el cerrojo del viaje, y la segunda relee el pago
 * con `FOR UPDATE` —la última versión confirmada, no su instantánea— y lo encuentra PAID:
 * responde `ALREADY_APPROVED` sin escribir nada. Igual al repetir un rechazo.
 */
export async function reviewManualPayment(
  paymentId: number,
  decision: ManualPaymentDecision,
  reviewerId: number,
  reason: string | null = null,
): Promise<{ outcome: ManualPaymentOutcome; bookingId: number }> {
  return withDeadlockRetry(() =>
    withTransaction(async (connection) => {
      const [refRows] = await connection.query(
        'SELECT p.booking_id, bk.trip_id FROM payments p JOIN bookings bk ON bk.id = p.booking_id WHERE p.id = ? LIMIT 1',
        [paymentId],
      );
      const ref = (refRows as Array<{ booking_id: number; trip_id: number }>)[0];
      if (!ref) throw ApiError.notFound('Pago no encontrado');

      await connection.query('SELECT id FROM trips WHERE id = ? LIMIT 1 FOR UPDATE', [ref.trip_id]);
      const [bookingRows] = await connection.query('SELECT id, status FROM bookings WHERE id = ? LIMIT 1 FOR UPDATE', [ref.booking_id]);
      const booking = (bookingRows as Array<{ id: number; status: string }>)[0]!;
      const [paymentRows] = await connection.query(
        'SELECT id, booking_id, method, status, payment_data FROM payments WHERE id = ? LIMIT 1 FOR UPDATE',
        [paymentId],
      );
      const payment = (paymentRows as Array<{ id: number; booking_id: number; method: PaymentMethod; status: string; payment_data: string | null }>)[0]!;

      if (!isManualPaymentMethod(payment.method)) {
        throw ApiError.badRequest('Los pagos con tarjeta los confirma Culqi: no se aprueban ni rechazan a mano');
      }

      if (decision === 'APPROVE') {
        if (payment.status === 'PAID') return { outcome: 'ALREADY_APPROVED' as const, bookingId: booking.id };
        if (payment.status !== 'PENDING') throw ApiError.conflict('El pago ya no está pendiente de verificación');
        if (booking.status === 'CONFIRMED' || booking.status === 'COMPLETED') {
          throw ApiError.conflict('La reserva ya está confirmada con otro pago');
        }
        // Valida reserva, viaje y asientos, y escribe pago, reserva, venta, comisión y aviso.
        await confirmBookingPaymentOnConnection(connection, booking.id, payment.method, null, payment.id);
        await connection.query('UPDATE payments SET payment_data = ? WHERE id = ?', [
          mergePaymentData(payment.payment_data, {
            manual_verification: { status: 'APPROVED', reviewed_by: reviewerId, reviewed_at: new Date().toISOString() },
          }),
          payment.id,
        ]);
        return { outcome: 'APPROVED' as const, bookingId: booking.id };
      }

      if (payment.status === 'FAILED') return { outcome: 'ALREADY_REJECTED' as const, bookingId: booking.id };
      if (payment.status !== 'PENDING') throw ApiError.conflict('El pago ya no está pendiente de verificación');
      await connection.query("UPDATE payments SET status = 'FAILED', payment_data = ? WHERE id = ? AND status = 'PENDING'", [
        mergePaymentData(payment.payment_data, {
          manual_verification: { status: 'REJECTED', reviewed_by: reviewerId, reviewed_at: new Date().toISOString(), reason },
        }),
        payment.id,
      ]);
      return { outcome: 'REJECTED' as const, bookingId: booking.id };
    }),
  );
}
