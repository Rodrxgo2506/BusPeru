import type { PoolConnection } from 'mysql2/promise';
import { withTransaction } from '../config/database';
import type { AuthenticatedUser, PaymentMethod } from '../types/entities';
import { ApiError } from '../utils/ApiError';
import { businessTimeMs } from '../utils/businessTime';
import { readNumberSetting } from './settings.service';
import { NOTIFICATION_EVENTS, notify } from './notification.service';

/** Datos de presentación del viaje para las notificaciones (sin bloquear filas). */
async function tripContext(connection: PoolConnection, tripId: number): Promise<Record<string, string>> {
  const [rows] = await connection.query(
    `SELECT ol.city AS origin_city, dl.city AS destination_city,
            DATE_FORMAT(t.departure_datetime, '%d/%m/%Y %H:%i') AS departure_date,
            co.name AS company_name
     FROM trips t
     JOIN routes r ON r.id = t.route_id
     JOIN locations ol ON ol.id = r.origin_location_id
     JOIN locations dl ON dl.id = r.destination_location_id
     JOIN companies co ON co.id = r.company_id
     WHERE t.id = ? LIMIT 1`,
    [tripId],
  );
  const row = (rows as Array<Record<string, string>>)[0];
  return row ?? {};
}

function money(value: number | string): string {
  return `S/ ${Number(value).toFixed(2)}`;
}

export interface CreateBookingInput {
  trip_id: number;
  seat_ids: number[];
  origin_stop_id?: number | null;
  destination_stop_id?: number | null;
  passenger_name?: string | null;
  passenger_document?: string | null;
  passenger_phone?: string | null;
  passenger_email?: string | null;
  notes?: string | null;
  coupon_code?: string | null;
  passengers?: Array<{ seat_id: number; name: string; document: string }>;
}

/**
 * Minutos que se retienen los asientos antes de pagar.
 *
 * Era una constante, de modo que `booking.hold_minutes` se podía editar en el Panel Admin y
 * no cambiaba absolutamente nada: configuración que aparentaba funcionar (BP-13). Ahora se
 * lee, con 15 como valor por defecto —el mismo de la constante—, así que sin configurar
 * nada el comportamiento es idéntico al de antes.
 */
const HOLD_MINUTES_FALLBACK = 15;

async function holdMinutes(): Promise<number> {
  return readNumberSetting('booking.hold_minutes', { fallback: HOLD_MINUTES_FALLBACK, integer: true, min: 1, max: 24 * 60 });
}

function generateBookingCode(): string {
  const random = Math.floor(100000 + Math.random() * 900000);
  return `BP-${random}`;
}

interface CouponResolution {
  couponId: number;
  discount: number;
}

async function resolveCoupon(
  connection: PoolConnection,
  code: string,
  userId: number,
  subtotal: number,
): Promise<CouponResolution> {
  const [rows] = await connection.query(
    `SELECT c.id, c.usage_limit, c.usage_count, c.per_user_limit, c.status,
            p.discount_type, p.discount_value, p.minimum_amount, p.maximum_discount,
            p.start_at, p.end_at, p.status AS promotion_status, p.usage_limit AS promotion_limit,
            p.usage_count AS promotion_usage
     FROM coupons c JOIN promotions p ON p.id = c.promotion_id
     WHERE c.code = ? LIMIT 1 FOR UPDATE`,
    [code.toUpperCase()],
  );
  const coupon = (rows as Record<string, unknown>[])[0];
  if (!coupon) throw ApiError.badRequest('El cupón no existe');
  if (coupon.status !== 'ACTIVE' || coupon.promotion_status !== 'ACTIVE') {
    throw ApiError.badRequest('El cupón no está activo');
  }

  // Las fechas de la base son hora de Perú: se convierten con la semántica del negocio y
  // no con la zona del proceso (BP-12).
  const now = Date.now();
  if (businessTimeMs(String(coupon.start_at)) > now || businessTimeMs(String(coupon.end_at)) < now) {
    throw ApiError.badRequest('El cupón está fuera de su periodo de vigencia');
  }
  if (coupon.usage_limit !== null && Number(coupon.usage_count) >= Number(coupon.usage_limit)) {
    throw ApiError.badRequest('El cupón alcanzó su límite de usos');
  }
  if (coupon.minimum_amount !== null && subtotal < Number(coupon.minimum_amount)) {
    throw ApiError.badRequest(`El cupón requiere una compra mínima de S/ ${Number(coupon.minimum_amount).toFixed(2)}`);
  }

  if (coupon.per_user_limit !== null) {
    const [usageRows] = await connection.query(
      'SELECT COUNT(*) AS total FROM coupon_usages WHERE coupon_id = ? AND user_id = ?',
      [coupon.id, userId],
    );
    const used = Number((usageRows as { total: number }[])[0]?.total ?? 0);
    if (used >= Number(coupon.per_user_limit)) throw ApiError.badRequest('Ya usaste este cupón el máximo de veces permitido');
  }

  let discount =
    coupon.discount_type === 'PERCENTAGE'
      ? (subtotal * Number(coupon.discount_value)) / 100
      : Number(coupon.discount_value);

  if (coupon.maximum_discount !== null) discount = Math.min(discount, Number(coupon.maximum_discount));
  discount = Math.min(discount, subtotal);

  return { couponId: Number(coupon.id), discount: Number(discount.toFixed(2)) };
}

/** Pertenencia a una compra de varios tramos. Ausente en una compra de ida simple. */
export interface SegmentContext {
  groupId: number;
  segmentOrder: number;
}

/**
 * Cuerpo de la creación de una reserva, sobre una conexión ya en transacción.
 *
 * Se extrajo de `createBooking` para que una compra de varios tramos pueda crear todas
 * sus reservas dentro de UNA sola transacción: si el segundo tramo falla, el primero se
 * deshace con el mismo ROLLBACK. La lógica es exactamente la que había; el único añadido
 * es el `segment`, que solo se rellena en compras multitramo.
 */
export async function createBookingOnConnection(
  connection: PoolConnection,
  user: AuthenticatedUser,
  input: CreateBookingInput,
  paymentMethod: PaymentMethod | undefined,
  serviceFeePerSeat: number,
  segment?: SegmentContext,
): Promise<{ bookingId: number; bookingCode: string; total: number }> {
  {
    // La empresa y la ruta se comprueban en ESTA misma consulta, no en una aparte: así la
    // validación entra dentro del bloqueo que ya serializa las reservas del viaje y no se
    // abre una ventana entre comprobar y crear. Ocultar el viaje en la búsqueda no bastaba:
    // entrando por su id se podía comprar de una empresa que la plataforma había retirado.
    const [tripRows] = await connection.query(
      `SELECT t.id, t.base_price, t.status, t.departure_datetime, t.bus_id, t.available_seats,
              r.status AS route_status, co.status AS company_status
       FROM trips t
       JOIN routes r ON r.id = t.route_id
       JOIN companies co ON co.id = r.company_id
       WHERE t.id = ? LIMIT 1 FOR UPDATE`,
      [input.trip_id],
    );
    const trip = (tripRows as Record<string, unknown>[])[0];
    if (!trip) throw ApiError.notFound('El viaje no existe');
    if (trip.company_status !== 'ACTIVE' || trip.route_status !== 'ACTIVE') {
      throw ApiError.badRequest('El viaje ya no admite reservas');
    }
    if (!['SCHEDULED', 'BOARDING', 'DELAYED'].includes(String(trip.status))) {
      throw ApiError.badRequest('El viaje ya no admite reservas');
    }
    if (businessTimeMs(String(trip.departure_datetime)) <= Date.now()) {
      throw ApiError.badRequest('El viaje ya partió');
    }

    const placeholders = input.seat_ids.map(() => '?').join(', ');
    const [seatRows] = await connection.query(
      `SELECT id, seat_number, status FROM seats WHERE id IN (${placeholders}) AND bus_id = ? FOR UPDATE`,
      [...input.seat_ids, trip.bus_id],
    );
    const seats = seatRows as Array<{ id: number; seat_number: string; status: string }>;
    if (seats.length !== input.seat_ids.length) {
      throw ApiError.badRequest('Alguno de los asientos seleccionados no pertenece a este bus');
    }
    const inactive = seats.find((seat) => seat.status !== 'AVAILABLE');
    if (inactive) throw ApiError.badRequest(`El asiento ${inactive.seat_number} no está habilitado`);

    const [takenRows] = await connection.query(
      `SELECT bs.seat_id, s.seat_number FROM booking_seats bs
       JOIN bookings bk ON bk.id = bs.booking_id
       JOIN seats s ON s.id = bs.seat_id
       WHERE bs.trip_id = ? AND bs.seat_id IN (${placeholders})
         AND (bk.status IN ('CONFIRMED', 'COMPLETED')
              OR (bk.status = 'PENDING' AND (bk.expires_at IS NULL OR bk.expires_at > NOW())))
       FOR UPDATE`,
      [input.trip_id, ...input.seat_ids],
    );
    const taken = takenRows as Array<{ seat_number: string }>;
    if (taken.length > 0) {
      throw ApiError.conflict(`Los asientos ${taken.map((row) => row.seat_number).join(', ')} ya fueron tomados`);
    }

    const basePrice = Number(trip.base_price);
    const passengerCount = input.seat_ids.length;
    const subtotal = Number((basePrice * passengerCount).toFixed(2));
    const serviceFee = Number((serviceFeePerSeat * passengerCount).toFixed(2));

    let discount = 0;
    let couponId: number | null = null;
    if (input.coupon_code) {
      const resolved = await resolveCoupon(connection, input.coupon_code, user.id, subtotal);
      discount = resolved.discount;
      couponId = resolved.couponId;
    }

    const total = Number((subtotal - discount + serviceFee).toFixed(2));
    const holdWindow = await holdMinutes();

    let bookingCode = generateBookingCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const [existing] = await connection.query('SELECT id FROM bookings WHERE booking_code = ? LIMIT 1', [bookingCode]);
      if ((existing as unknown[]).length === 0) break;
      bookingCode = generateBookingCode();
    }

    const [bookingResult] = await connection.query(
      `INSERT INTO bookings (booking_code, user_id, group_id, segment_order, trip_id, origin_stop_id, destination_stop_id, passenger_count,
        subtotal, discount_amount, service_fee, total_amount, status, passenger_name, passenger_document,
        passenger_phone, passenger_email, notes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
      [
        bookingCode,
        user.id,
        segment?.groupId ?? null,
        segment?.segmentOrder ?? 1,
        input.trip_id,
        input.origin_stop_id ?? null,
        input.destination_stop_id ?? null,
        passengerCount,
        subtotal,
        discount,
        serviceFee,
        total,
        input.passenger_name ?? `${user.first_name} ${user.last_name}`,
        input.passenger_document ?? null,
        input.passenger_phone ?? user.phone,
        input.passenger_email ?? user.email,
        input.notes ?? null,
        holdWindow,
      ],
    );
    const bookingId = (bookingResult as { insertId: number }).insertId;

    for (const seatId of input.seat_ids) {
      const passenger = input.passengers?.find((entry) => entry.seat_id === seatId);
      await connection.query(
        `INSERT INTO booking_seats (booking_id, trip_id, seat_id, price, passenger_name, passenger_document)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          bookingId,
          input.trip_id,
          seatId,
          basePrice,
          passenger?.name ?? input.passenger_name ?? null,
          passenger?.document ?? input.passenger_document ?? null,
        ],
      );
    }

    if (couponId !== null) {
      await connection.query(
        'INSERT INTO coupon_usages (coupon_id, user_id, booking_id, discount_amount) VALUES (?, ?, ?, ?)',
        [couponId, user.id, bookingId, discount],
      );
      await connection.query('UPDATE coupons SET usage_count = usage_count + 1 WHERE id = ?', [couponId]);
      await connection.query(
        'UPDATE promotions SET usage_count = usage_count + 1 WHERE id = (SELECT promotion_id FROM coupons WHERE id = ?)',
        [couponId],
      );
    }

    if (paymentMethod) {
      await connection.query(
        `INSERT INTO payments (booking_id, transaction_code, amount, currency, method, status)
         VALUES (?, ?, ?, 'PEN', ?, 'PENDING')`,
        [bookingId, `TRX-${bookingCode}-${Date.now().toString().slice(-6)}`, total, paymentMethod],
      );
    }

    if (trip.available_seats !== null) {
      // CAST a SIGNED antes de restar: `available_seats` es UNSIGNED y la resta se evalúa
      // antes que GREATEST, así que al llegar a 0 desbordaba y MySQL lanzaba
      // ER_DATA_OUT_OF_RANGE en vez de quedarse en 0.
      await connection.query('UPDATE trips SET available_seats = GREATEST(CAST(available_seats AS SIGNED) - ?, 0) WHERE id = ?', [
        passengerCount,
        input.trip_id,
      ]);
    }

    // La notificación vive dentro de la transacción: si algo falla, tampoco se crea.
    const context = await tripContext(connection, input.trip_id);
    await notify(connection, {
      userId: user.id,
      event: NOTIFICATION_EVENTS.BOOKING_CREATED,
      eventKey: `${NOTIFICATION_EVENTS.BOOKING_CREATED}:${bookingId}`,
      context: {
        ...context,
        booking_code: bookingCode,
        booking_id: bookingId,
        total_amount: money(total),
        seat_numbers: seats.map((seat) => seat.seat_number).join(', '),
        hold_minutes: holdWindow,
      },
    });

    return { bookingId, bookingCode, total };
  }
}

/**
 * Crea una reserva de un solo tramo con su propia transacción.
 * Es el camino de IDA y no ha cambiado: abre la transacción y delega en el cuerpo común.
 */
export async function createBooking(
  user: AuthenticatedUser,
  input: CreateBookingInput,
  paymentMethod?: PaymentMethod,
): Promise<{ bookingId: number; bookingCode: string }> {
  const serviceFeePerSeat = await assertBookingInput(input);
  return withTransaction(async (connection) =>
    createBookingOnConnection(connection, user, input, paymentMethod, serviceFeePerSeat),
  );
}

/**
 * Validaciones previas comunes a un tramo, fuera de la transacción: número de asientos y
 * lectura de la configuración. Devuelve la comisión de servicio por asiento.
 */
export async function assertBookingInput(input: CreateBookingInput): Promise<number> {
  if (input.seat_ids.length === 0) throw ApiError.badRequest('Debes seleccionar al menos un asiento');
  const maxSeats = await readNumberSetting('booking.max_seats_per_booking', { fallback: 6, integer: true, min: 1, max: 10 });
  if (input.seat_ids.length > maxSeats) throw ApiError.badRequest(`Puedes seleccionar como máximo ${maxSeats} asientos`);
  return readNumberSetting('booking.service_fee', { fallback: 2.5, min: 0 });
}

/**
 * Cuerpo de la confirmación de pago, sobre una conexión ya en transacción.
 *
 * Se extrajo de `confirmBookingPayment` con el mismo criterio que
 * `createBookingOnConnection`: una compra de varios tramos necesita confirmar todas sus
 * reservas dentro de UNA sola transacción, de modo que si un tramo falla el ROLLBACK
 * deshaga también los tramos ya confirmados. La lógica no cambia.
 *
 * Idempotencia (idéntica a la que ya había):
 *   · Si la reserva ya está CONFIRMED o COMPLETED, sale sin tocar nada.
 *   · Si existe un pago PENDING/PROCESSING lo reutiliza en vez de crear otro.
 *   · `provider_transaction_id` se guarda tal cual llega; el mismo identificador puede
 *     repetirse en los N pagos de una compra cuando el cobro externo sea uno solo.
 */
export async function confirmBookingPaymentOnConnection(
  connection: PoolConnection,
  bookingId: number,
  method: PaymentMethod,
  providerTransactionId?: string | null,
): Promise<void> {
  {
    const [bookingRows] = await connection.query(
      `SELECT bk.*, r.company_id FROM bookings bk
       JOIN trips t ON t.id = bk.trip_id
       JOIN routes r ON r.id = t.route_id
       WHERE bk.id = ? LIMIT 1 FOR UPDATE`,
      [bookingId],
    );
    const booking = (bookingRows as Record<string, unknown>[])[0];
    if (!booking) throw ApiError.notFound('Reserva no encontrada');
    if (booking.status === 'CANCELLED' || booking.status === 'EXPIRED') {
      throw ApiError.badRequest('La reserva ya no está vigente');
    }
    if (booking.status === 'CONFIRMED' || booking.status === 'COMPLETED') return;

    const total = Number(booking.total_amount);
    const companyId = Number(booking.company_id);

    const [paymentRows] = await connection.query(
      "SELECT id FROM payments WHERE booking_id = ? AND status IN ('PENDING','PROCESSING') ORDER BY id DESC LIMIT 1 FOR UPDATE",
      [bookingId],
    );
    const pendingPayment = (paymentRows as Array<{ id: number }>)[0];

    let paymentId: number;
    if (pendingPayment) {
      paymentId = pendingPayment.id;
      await connection.query(
        "UPDATE payments SET status = 'PAID', method = ?, provider_transaction_id = ?, paid_at = NOW() WHERE id = ?",
        [method, providerTransactionId ?? null, paymentId],
      );
    } else {
      const [result] = await connection.query(
        `INSERT INTO payments (booking_id, transaction_code, amount, currency, method, status, provider_transaction_id, paid_at)
         VALUES (?, ?, ?, 'PEN', ?, 'PAID', ?, NOW())`,
        [bookingId, `TRX-${booking.booking_code}-${Date.now().toString().slice(-6)}`, total, method, providerTransactionId ?? null],
      );
      paymentId = (result as { insertId: number }).insertId;
    }

    await connection.query(
      "UPDATE bookings SET status = 'CONFIRMED', confirmed_at = NOW(), expires_at = NULL WHERE id = ?",
      [bookingId],
    );

    await connection.query(
      `INSERT INTO financial_transactions (company_id, user_id, booking_id, payment_id, type, direction, amount, currency, description, reference_code, status, transaction_date)
       VALUES (?, ?, ?, ?, 'PAYMENT', 'CREDIT', ?, 'PEN', ?, ?, 'COMPLETED', NOW())`,
      [companyId, booking.user_id, bookingId, paymentId, total, `Pago de reserva ${booking.booking_code}`, booking.booking_code],
    );

    const [commissionRows] = await connection.query(
      `SELECT commission_type, commission_value FROM company_commission_settings
       WHERE company_id = ? AND status = 'ACTIVE'
         AND effective_from <= NOW() AND (effective_until IS NULL OR effective_until >= NOW())
       ORDER BY effective_from DESC LIMIT 1`,
      [companyId],
    );
    const commission = (commissionRows as Array<{ commission_type: string; commission_value: number }>)[0];
    if (commission) {
      const amount =
        commission.commission_type === 'PERCENTAGE'
          ? Number(((total * Number(commission.commission_value)) / 100).toFixed(2))
          : Number(commission.commission_value);

      if (amount > 0) {
        await connection.query(
          `INSERT INTO financial_transactions (company_id, booking_id, payment_id, type, direction, amount, currency, description, reference_code, status, transaction_date)
           VALUES (?, ?, ?, 'COMMISSION', 'DEBIT', ?, 'PEN', ?, ?, 'COMPLETED', NOW())`,
          [companyId, bookingId, paymentId, amount, `Comisión BusPerú de ${booking.booking_code}`, booking.booking_code],
        );
      }
    }

    const [seatRows] = await connection.query(
      `SELECT s.seat_number FROM booking_seats bs JOIN seats s ON s.id = bs.seat_id
       WHERE bs.booking_id = ? ORDER BY s.seat_number`,
      [bookingId],
    );
    const context = await tripContext(connection, Number(booking.trip_id));
    await notify(connection, {
      userId: Number(booking.user_id),
      event: NOTIFICATION_EVENTS.PAYMENT_CONFIRMED,
      eventKey: `${NOTIFICATION_EVENTS.PAYMENT_CONFIRMED}:${bookingId}`,
      context: {
        ...context,
        booking_code: String(booking.booking_code),
        booking_id: bookingId,
        total_amount: money(total),
        seat_numbers: (seatRows as Array<{ seat_number: string }>).map((row) => row.seat_number).join(', '),
      },
    });
  }
}

/**
 * Confirma el pago de una reserva suelta con su propia transacción.
 * Es el camino de IDA y no ha cambiado: abre la transacción y delega en el cuerpo común.
 */
export async function confirmBookingPayment(
  bookingId: number,
  method: PaymentMethod,
  providerTransactionId?: string | null,
): Promise<void> {
  await withTransaction((connection) =>
    confirmBookingPaymentOnConnection(connection, bookingId, method, providerTransactionId),
  );
}

/**
 * Cancela una reserva, libera sus asientos y, si estaba pagada, abre la solicitud de
 * reembolso.
 *
 * POLÍTICA DE CANCELACIÓN (auditoría BP-08). El plazo sale de
 * `system_settings.booking.cancellation_hours`, que ya existía con valor 24 y hasta ahora no
 * lo leía nadie, de modo que la plataforma anunciaba una política en su centro de ayuda que
 * el código no aplicaba:
 *
 *   · Faltan MÁS de 24 h para la salida  → se puede cancelar, y con reembolso íntegro si se
 *                                          solicita.
 *   · Faltan 24 h o menos                → no se puede cancelar. Tampoco si la salida ya
 *                                          pasó, que es el mismo caso con el plazo negativo.
 *   · Viaje IN_PROGRESS o COMPLETED      → no se puede cancelar.
 *   · Viaje CANCELLED                    → se conserva lo que ya había: el pasajero de un
 *                                          viaje que canceló la empresa puede cancelar su
 *                                          reserva y recuperar su dinero a cualquier hora.
 *
 * El plazo se calcula en SQL con `NOW()`, el mismo reloj que usan la expiración de reservas
 * y la búsqueda pública, para no introducir una referencia horaria distinta.
 */
export async function cancelBooking(bookingId: number, reason: string | null, requestRefund: boolean): Promise<void> {
  const cancellationHours = await readNumberSetting('booking.cancellation_hours', { fallback: 24, min: 0 });

  await withTransaction(async (connection) => {
    const [rows] = await connection.query(
      `SELECT bk.*, t.status AS trip_status,
              TIMESTAMPDIFF(SECOND, NOW(), t.departure_datetime) AS seconds_to_departure
       FROM bookings bk
       JOIN trips t ON t.id = bk.trip_id
       WHERE bk.id = ? LIMIT 1 FOR UPDATE`,
      [bookingId],
    );
    const booking = (rows as Record<string, unknown>[])[0];
    if (!booking) throw ApiError.notFound('Reserva no encontrada');
    if (booking.status === 'CANCELLED') throw ApiError.badRequest('La reserva ya está cancelada');
    if (booking.status === 'COMPLETED') throw ApiError.badRequest('No se puede cancelar un viaje ya realizado');
    // Una reserva vencida ya está cerrada: la expiración devolvió sus cupos y canceló sus
    // pagos. Dejarla pasar por aquí sumaba los mismos asientos por segunda vez y separaba
    // `trips.available_seats` de la disponibilidad real.
    if (booking.status === 'EXPIRED') throw ApiError.badRequest('La reserva ya venció y sus asientos se liberaron');

    // Un viaje que la empresa canceló es la excepción: su pasajero puede cancelar y
    // recuperar el importe sin importar cuánto falte para la salida.
    if (booking.trip_status !== 'CANCELLED') {
      if (booking.trip_status === 'IN_PROGRESS') throw ApiError.badRequest('El viaje ya está en curso: no se puede cancelar');
      if (booking.trip_status === 'COMPLETED') throw ApiError.badRequest('El viaje ya se realizó: no se puede cancelar');

      // Un plazo negativo significa que la salida ya pasó, así que la misma comparación
      // cubre el viaje inminente y el que ya partió.
      if (Number(booking.seconds_to_departure) <= cancellationHours * 3600) {
        throw ApiError.badRequest(
          `Solo puedes cancelar hasta ${cancellationHours} horas antes de la salida`,
        );
      }
    }

    await connection.query(
      "UPDATE bookings SET status = 'CANCELLED', cancelled_at = NOW(), notes = COALESCE(?, notes) WHERE id = ?",
      [reason, bookingId],
    );

    await connection.query(
      'UPDATE trips SET available_seats = LEAST(COALESCE(available_seats, 0) + ?, (SELECT capacity FROM buses WHERE id = trips.bus_id)) WHERE id = ? AND available_seats IS NOT NULL',
      [Number(booking.passenger_count), booking.trip_id],
    );

    if (requestRefund) {
      const [paymentRows] = await connection.query(
        "SELECT id, amount FROM payments WHERE booking_id = ? AND status = 'PAID' ORDER BY id DESC LIMIT 1",
        [bookingId],
      );
      const payment = (paymentRows as Array<{ id: number; amount: number }>)[0];
      if (payment) {
        // Una reserva ya cancelada no vuelve a entrar aquí, así que no se duplican reembolsos.
        await connection.query(
          `INSERT INTO refunds (payment_id, booking_id, amount, reason, status) VALUES (?, ?, ?, ?, 'PENDING')`,
          [payment.id, bookingId, payment.amount, reason ?? 'Cancelación solicitada por el pasajero'],
        );
      }
    }

    const context = await tripContext(connection, Number(booking.trip_id));
    await notify(connection, {
      userId: Number(booking.user_id),
      event: NOTIFICATION_EVENTS.BOOKING_CANCELLED,
      eventKey: `${NOTIFICATION_EVENTS.BOOKING_CANCELLED}:${bookingId}`,
      context: {
        ...context,
        booking_code: String(booking.booking_code),
        booking_id: bookingId,
        total_amount: money(Number(booking.total_amount)),
        reason: reason ?? '',
      },
    });
  });
}
