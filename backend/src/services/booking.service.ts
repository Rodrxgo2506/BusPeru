import type { PoolConnection } from 'mysql2/promise';
import { withTransaction } from '../config/database';
import type { AuthenticatedUser, PaymentMethod } from '../types/entities';
import { ApiError } from '../utils/ApiError';
import { businessTimeMs } from '../utils/businessTime';
import { logError } from '../utils/logger';
import { centsToDecimal, percentOfCents, toCentsExact } from '../utils/money';
import { loadCompanyCommission } from './company-commission.service';
import { assertCompanyCanSell } from './company-status.service';
import { readNumberSetting } from './settings.service';
import { sendEmail } from './email.service';
import { NOTIFICATION_EVENTS, TRIP_CANCELLED_EMAIL, notify, renderTemplate } from './notification.service';
import { SEAT_HELD_SQL, TRIP_SEAT_CAPACITY_SQL } from './trip.service';

/**
 * Se reexporta desde aqui porque este era su sitio original y `booking-expiry.service` la
 * importa por esta via. La definicion vive ahora en `trip.service`, junto a `SEAT_HELD_SQL`:
 * las dos describen el mismo viaje y tenerlas separadas obligaba a que `trip.service`
 * importara de `booking.service`, que ya importa de `trip.service`.
 */
export { TRIP_SEAT_CAPACITY_SQL };

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
  tripCompanyId: number,
): Promise<CouponResolution> {
  const [rows] = await connection.query(
    `SELECT c.id, c.usage_limit, c.usage_count, c.per_user_limit, c.status,
            p.company_id AS promotion_company_id,
            p.discount_type, p.discount_value, p.minimum_amount, p.maximum_discount,
            p.start_at, p.end_at, p.status AS promotion_status, p.usage_limit AS promotion_limit,
            p.usage_count AS promotion_usage
     FROM coupons c JOIN promotions p ON p.id = c.promotion_id
     WHERE c.code = ? LIMIT 1 FOR UPDATE`,
    [code.toUpperCase()],
  );
  const coupon = (rows as Record<string, unknown>[])[0];
  if (!coupon) throw ApiError.badRequest('El cupón no existe');
  // H-49: el cupón de una empresa solo vale en SUS viajes; antes descontaba en cualquier viaje y
  // reducía el cobro de otra empresa. Las dos empresas salen de la base —la del viaje, de su ruta;
  // la del cupón, de su promoción—, nunca del cuerpo de la petición. Los cupones de plataforma
  // (`company_id` NULL) siguen valiendo en cualquier empresa. En un itinerario se evalúa por tramo.
  if (coupon.promotion_company_id !== null && Number(coupon.promotion_company_id) !== tripCompanyId) {
    throw ApiError.badRequest('El cupón no es válido para este viaje');
  }
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
  settings: BookingSettings,
  segment?: SegmentContext,
): Promise<{ bookingId: number; bookingCode: string; total: number }> {
  {
    // La empresa y la ruta se comprueban en ESTA misma consulta, no en una aparte: así la
    // validación entra dentro del bloqueo que ya serializa las reservas del viaje y no se
    // abre una ventana entre comprobar y crear. Ocultar el viaje en la búsqueda no bastaba:
    // entrando por su id se podía comprar de una empresa que la plataforma había retirado.
    const [tripRows] = await connection.query(
      `SELECT t.id, t.base_price, t.status, t.departure_datetime, t.bus_id, t.bus_layout_id, t.available_seats,
              r.company_id, r.status AS route_status, co.status AS company_status
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
    // H-46: una empresa sin comisión vigente no vende; se corta antes de retener asientos.
    await loadCompanyCommission(connection, Number(trip.company_id));
    if (!['SCHEDULED', 'BOARDING', 'DELAYED'].includes(String(trip.status))) {
      throw ApiError.badRequest('El viaje ya no admite reservas');
    }
    if (businessTimeMs(String(trip.departure_datetime)) <= Date.now()) {
      throw ApiError.badRequest('El viaje ya partió');
    }

    // Los asientos se bloquean de menor a mayor id, no en el orden en que llegaron
    // (auditoría BP-21). Dos viajes distintos pueden compartir bus y por tanto asientos, así
    // que dos compras que pidieran [5, 2] y [2, 5] podían quedarse esperándose. Ordenar la
    // lista es todo lo que hace falta para que eso no pueda ocurrir; el orden de la petición
    // se conserva para insertar y para asociar cada pasajero a su asiento.
    const lockOrder = [...new Set(input.seat_ids)].sort((a, b) => a - b);
    const placeholders = lockOrder.map(() => '?').join(', ');

    /**
     * Version de distribucion de la que salen los asientos vendibles (migracion 010).
     *
     * Se resuelve SOBRE ESTA MISMA CONEXION, nunca con el ayudante global: pedir una segunda
     * conexion del pool desde dentro de una transaccion que ya tiene una es exactamente lo
     * que provocaba el interbloqueo de BP-21.
     */
    let layoutId = trip.bus_layout_id === null || trip.bus_layout_id === undefined ? null : Number(trip.bus_layout_id);
    if (layoutId === null) {
      const [publicadas] = await connection.query(
        "SELECT id FROM bus_layouts WHERE bus_id = ? AND status = 'PUBLISHED' LIMIT 1",
        [trip.bus_id],
      );
      const publicada = (publicadas as Array<{ id: number }>)[0];
      if (!publicada) throw ApiError.badRequest('El bus de este viaje no tiene una distribución de asientos publicada');
      layoutId = publicada.id;
    }

    // El bloqueo no cambia de forma: misma tabla, mismo `ORDER BY id ASC` y mismo FOR UPDATE
    // que exige BP-21. Lo unico que cambia es el ambito —la version en vez del bus— y una
    // columna mas en la proyeccion, que hace falta para el precio y no añade ningun JOIN.
    const [seatRows] = await connection.query(
      `SELECT id, seat_number, status, seat_type_id FROM seats WHERE id IN (${placeholders}) AND layout_id = ? ORDER BY id ASC FOR UPDATE`,
      [...lockOrder, layoutId],
    );
    const seats = seatRows as Array<{ id: number; seat_number: string; status: string; seat_type_id: number | null }>;
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
         AND ${SEAT_HELD_SQL}
       ORDER BY bs.seat_id ASC
       FOR UPDATE`,
      [input.trip_id, ...lockOrder],
    );
    const taken = takenRows as Array<{ seat_number: string }>;
    if (taken.length > 0) {
      throw ApiError.conflict(`Los asientos ${taken.map((row) => row.seat_number).join(', ')} ya fueron tomados`);
    }

    /**
     * Precio efectivo de cada asiento.
     *
     * Se lee DESPUES de tener los asientos bloqueados y sin `FOR UPDATE`: `trip_seat_type_prices`
     * es una tabla de configuracion diminuta y bloquearla no aporta nada, mientras que meterla
     * en el camino de cerrojos añadiria un recurso mas al orden de bloqueo, que es justo lo
     * que BP-21 pide no tocar.
     *
     * Donde no hay fila para el tipo del asiento rige `trips.base_price`, de modo que un viaje
     * sin precios configurados cobra exactamente lo mismo que antes de esta fase.
     */
    const [priceRows] = await connection.query('SELECT seat_type_id, price FROM trip_seat_type_prices WHERE trip_id = ?', [
      input.trip_id,
    ]);
    const overrides = new Map(
      (priceRows as Array<{ seat_type_id: number; price: string }>).map((row) => [Number(row.seat_type_id), Number(row.price)]),
    );
    const basePrice = Number(trip.base_price);
    const seatPrices = new Map<number, number>(
      input.seat_ids.map((seatId) => {
        const seat = seats.find((entry) => entry.id === seatId);
        const tipo = seat?.seat_type_id;
        const precio = tipo !== null && tipo !== undefined && overrides.has(Number(tipo)) ? overrides.get(Number(tipo))! : basePrice;
        return [seatId, precio];
      }),
    );

    const passengerCount = input.seat_ids.length;
    const subtotal = Number([...seatPrices.values()].reduce((total, precio) => total + precio, 0).toFixed(2));
    const serviceFee = Number((settings.serviceFeePerSeat * passengerCount).toFixed(2));

    let discount = 0;
    let couponId: number | null = null;
    if (input.coupon_code) {
      const resolved = await resolveCoupon(connection, input.coupon_code, user.id, subtotal, Number(trip.company_id));
      discount = resolved.discount;
      couponId = resolved.couponId;
    }

    const total = Number((subtotal - discount + serviceFee).toFixed(2));
    const holdWindow = settings.holdMinutes;

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
          // El precio historico: lo que se cobro por ESTE asiento en ESTE momento. Cambiar
          // luego `trips.base_price` o los precios por tipo no puede reescribir esta fila.
          seatPrices.get(seatId) ?? basePrice,
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
  const settings = await assertBookingInput(input);
  return withTransaction(async (connection) =>
    createBookingOnConnection(connection, user, input, paymentMethod, settings),
  );
}

export interface BookingSettings {
  /** Comisión de servicio por asiento. */
  serviceFeePerSeat: number;
  /** Minutos que se retiene el asiento antes de vencer. */
  holdMinutes: number;
}

/**
 * Validaciones previas comunes a un tramo y TODA la configuración que necesita la reserva.
 *
 * Se lee aquí, **antes** de abrir la transacción, y no dentro (auditoría BP-21). El lector de
 * configuración pide su propia conexión al pool, así que llamarlo con una transacción abierta
 * significaba sostener una conexión mientras se pedía otra. Con diez reservas simultáneas
 * —el límite del pool— las diez sostenían una conexión y las diez esperaban una undécima que
 * nunca iba a llegar, cada una con el cerrojo del viaje ya tomado: el pool se bloqueaba
 * entero y las peticiones morían a los 50 segundos con ER_LOCK_WAIT_TIMEOUT.
 *
 * `cancelBooking` ya leía su configuración fuera de la transacción; esto solo aplica el
 * mismo patrón al camino de creación.
 */
export async function assertBookingInput(input: CreateBookingInput): Promise<BookingSettings> {
  if (input.seat_ids.length === 0) throw ApiError.badRequest('Debes seleccionar al menos un asiento');
  const maxSeats = await readNumberSetting('booking.max_seats_per_booking', { fallback: 6, integer: true, min: 1, max: 10 });
  if (input.seat_ids.length > maxSeats) throw ApiError.badRequest(`Puedes seleccionar como máximo ${maxSeats} asientos`);
  return {
    serviceFeePerSeat: await readNumberSetting('booking.service_fee', { fallback: 2.5, min: 0 }),
    holdMinutes: await readNumberSetting('booking.hold_minutes', {
      fallback: HOLD_MINUTES_FALLBACK,
      integer: true,
      min: 1,
      max: 24 * 60,
    }),
  };
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
/** Desglose en céntimos de lo que se cobra en una reserva (H-45 · cupones). */
export interface SaleBreakdown {
  totalCents: number;
  /** Lo que pertenece a la empresa y sobre lo que se calcula su comisión. */
  companyBaseCents: number;
  serviceFeeCents: number;
  /** Descuento de un cupón de plataforma: lo asume BusPerú. */
  platformDiscountCents: number;
  /** Descuento de un cupón de la empresa: lo asume la empresa. */
  companyDiscountCents: number;
}

/**
 * Reparte el cobro de una reserva con los importes CONGELADOS en `bookings` (subtotal, descuento,
 * service fee y total) y el dueño del cupón usado (`coupon_usages → coupons → promotions`). No se
 * recalcula ningún precio. Si los importes guardados no cuadran al céntimo, no se asienta nada:
 * repartir unos datos incoherentes produciría balances incorrectos.
 */
export async function saleBreakdown(connection: PoolConnection, booking: Record<string, unknown>): Promise<SaleBreakdown> {
  const subtotalCents = toCentsExact(String(booking.subtotal));
  const discountCents = toCentsExact(String(booking.discount_amount ?? '0'));
  const serviceFeeCents = toCentsExact(String(booking.service_fee ?? '0'));
  const totalCents = toCentsExact(String(booking.total_amount));
  if (subtotalCents - discountCents + serviceFeeCents !== totalCents || discountCents > subtotalCents || serviceFeeCents < 0 || discountCents < 0) {
    logError('Importes de la reserva incoherentes: no se asienta la venta', new Error(`reserva ${String(booking.id)}`), {});
    throw ApiError.conflict('No se pudo confirmar el pago de esta reserva. Contacta con soporte.');
  }

  let platformDiscountCents = 0;
  if (discountCents > 0) {
    const [usageRows] = await connection.query(
      `SELECT p.company_id FROM coupon_usages cu
       JOIN coupons c ON c.id = cu.coupon_id
       JOIN promotions p ON p.id = c.promotion_id
       WHERE cu.booking_id = ? ORDER BY cu.id ASC LIMIT 1`,
      [booking.id],
    );
    const usage = (usageRows as Array<{ company_id: number | null }>)[0];
    // Solo un cupón de plataforma probado traslada el descuento a BusPerú. Sin cupón registrado el
    // descuento se queda en la empresa, como hasta ahora: no se inventa un subsidio.
    if (usage && usage.company_id === null) platformDiscountCents = discountCents;
  }
  const companyDiscountCents = discountCents - platformDiscountCents;
  return {
    totalCents,
    companyBaseCents: subtotalCents - companyDiscountCents,
    serviceFeeCents,
    platformDiscountCents,
    companyDiscountCents,
  };
}

export async function confirmBookingPaymentOnConnection(
  connection: PoolConnection,
  bookingId: number,
  method: PaymentMethod,
  providerTransactionId?: string | null,
  /**
   * Pago concreto que se confirma: el PENDING de una aprobación manual (H-22) o el del cargo de
   * Culqi que se concilia (H-42). Sin él se reutiliza el último PENDING/PROCESSING de la reserva.
   */
  paymentIdToConfirm?: number,
): Promise<void> {
  {
    // El viaje se bloquea ANTES que la reserva, y es exactamente el mismo cerrojo que toma
    // `createBookingOnConnection`. Dos razones, ambas necesarias:
    //
    //   · **Exclusión mutua con la venta.** Sin él, confirmar y vender miran el mismo
    //     asiento a la vez sin verse: uno comprueba que está libre mientras el otro lo
    //     confirma. Con él, ambos caminos se serializan sobre la fila del viaje.
    //   · **Orden de bloqueo.** La venta toma viaje → reservas. Si la confirmación tomara
    //     reserva → viaje, dos operaciones simultáneas podrían quedarse cada una esperando
    //     el cerrojo de la otra. Leer el `trip_id` sin bloquear —nunca cambia— permite
    //     tomarlos en el mismo orden que la venta.
    const [tripRows] = await connection.query('SELECT trip_id FROM bookings WHERE id = ? LIMIT 1', [bookingId]);
    const tripId = (tripRows as Array<{ trip_id: number }>)[0]?.trip_id;
    if (tripId === undefined) throw ApiError.notFound('Reserva no encontrada');
    const [lockedTrip] = await connection.query('SELECT id, status FROM trips WHERE id = ? LIMIT 1 FOR UPDATE', [tripId]);
    const tripStatus = (lockedTrip as Array<{ status: string }>)[0]?.status;

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

    // Un viaje cancelado no se cobra (FASE 8H). Se mira el estado del VIAJE, releído bajo su
    // cerrojo, y no solo el de la reserva: cancelar el viaje también cancela sus reservas,
    // pero una reserva de un viaje cancelado por otra vía no debe poder pagarse nunca. Por
    // aquí pasan el efectivo, la transferencia, los itinerarios, la tarjeta y el webhook.
    if (tripStatus === 'CANCELLED') {
      throw ApiError.badRequest('El viaje fue cancelado: esta reserva ya no se puede pagar');
    }

    // Los asientos se vuelven a comprobar aquí, no solo al reservar (auditoría BP-19).
    //
    // Entre la reserva y el pago la retención pudo vencer. El planificador la marcaría
    // EXPIRED, pero pasa cada 60 segundos: durante esa ventana la reserva sigue en PENDING
    // con el plazo ya cumplido, así que la disponibilidad la da por libre —correctamente— y
    // otra persona puede comprar el asiento. Si entonces se pagaba la primera, quedaban DOS
    // reservas CONFIRMED sobre el mismo asiento del mismo viaje. Confirmar era el único
    // camino que cambiaba a un estado que ocupa asiento sin comprobar si seguía libre.
    //
    // No se toca la política de retención: una PENDING vencida se sigue pudiendo pagar
    // mientras nadie haya ocupado su sitio. Lo que deja de ser posible es pisar a quien ya
    // lo ocupó.
    //
    // La consulta es BLOQUEANTE (`FOR UPDATE`), igual que la de la venta, y no por el
    // cerrojo sino por la lectura: InnoDB trabaja en REPEATABLE READ, así que una consulta
    // normal devuelve la instantánea tomada al principio de la transacción y no vería una
    // venta que acabara de confirmarse. Una lectura bloqueante sí lee la última versión
    // confirmada. Sin `FOR UPDATE` esta comprobación pasaba de largo justo en el caso
    // simultáneo que pretende cubrir.
    const [conflictRows] = await connection.query(
      `SELECT s.seat_number
       FROM booking_seats propios
       JOIN booking_seats ajenos
         ON ajenos.trip_id = propios.trip_id
        AND ajenos.seat_id = propios.seat_id
        AND ajenos.booking_id <> propios.booking_id
       JOIN bookings bk ON bk.id = ajenos.booking_id
       JOIN seats s ON s.id = propios.seat_id
       WHERE propios.booking_id = ? AND ${SEAT_HELD_SQL}
       FOR UPDATE`,
      [bookingId],
    );
    const ocupados = [...new Set((conflictRows as Array<{ seat_number: string }>).map((row) => row.seat_number))].sort();
    if (ocupados.length > 0) {
      throw ApiError.conflict(
        `La retención de esta reserva venció y los asientos ${ocupados.join(', ')} ya fueron tomados por otra reserva.`,
      );
    }

    const total = Number(booking.total_amount);
    const companyId = Number(booking.company_id);

    // H-36: una empresa no activa no vende. H-46: sin comisión vigente no se confirma. Ambas
    // se comprueban ANTES de escribir nada; un cargo de Culqi que llegue aquí queda cubierto por
    // el reembolso compensatorio de H-42.
    await assertCompanyCanSell(companyId, connection);
    const commission = await loadCompanyCommission(connection, companyId);
    const desglose = await saleBreakdown(connection, booking);

    const [paymentRows] =
      paymentIdToConfirm === undefined
        ? await connection.query(
            "SELECT id FROM payments WHERE booking_id = ? AND status IN ('PENDING','PROCESSING') ORDER BY id DESC LIMIT 1 FOR UPDATE",
            [bookingId],
          )
        : // PENDING (aprobación manual, H-22) o PROCESSING (cargo de Culqi verificado, H-42).
          await connection.query("SELECT id FROM payments WHERE id = ? AND booking_id = ? AND status IN ('PENDING','PROCESSING') LIMIT 1 FOR UPDATE", [
            paymentIdToConfirm,
            bookingId,
          ]);
    const pendingPayment = (paymentRows as Array<{ id: number }>)[0];
    if (paymentIdToConfirm !== undefined && !pendingPayment) {
      throw ApiError.conflict('El pago ya no está pendiente de verificación');
    }

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

    /**
     * ASIENTOS DE LA VENTA (H-45 · cupones). El cobro al pasajero (`payments.amount`) no cambia:
     * subtotal − descuento + service fee. Lo que cambia es a quién pertenece cada parte:
     *
     *   empresa     PAYMENT/CREDIT     base = subtotal − descuento de un cupón DE LA EMPRESA
     *   empresa     COMMISSION/DEBIT   % de la base (nunca del service fee)
     *   plataforma  PAYMENT/CREDIT     service fee                  (company_id NULL)
     *   plataforma  ADJUSTMENT/DEBIT   descuento de un cupón DE PLATAFORMA: lo absorbe BusPerú
     *
     * base + service fee − subsidio = cobro, al céntimo. Un cupón de plataforma no reduce la base de
     * la empresa; un cupón de la empresa sí. No hay tipos de movimiento nuevos.
     */
    const bookingCode = String(booking.booking_code);
    await connection.query(
      `INSERT INTO financial_transactions (company_id, user_id, booking_id, payment_id, type, direction, amount, currency, description, reference_code, status, transaction_date)
       VALUES (?, ?, ?, ?, 'PAYMENT', 'CREDIT', ?, 'PEN', ?, ?, 'COMPLETED', NOW())`,
      [companyId, booking.user_id, bookingId, paymentId, centsToDecimal(desglose.companyBaseCents), `Pago de reserva ${bookingCode}`, bookingCode],
    );

    // H-51: en céntimos enteros y con redondeo explícito (mitad hacia arriba). H-45: sobre la base
    // de la empresa, no sobre el cobro total. La tasa es la configurada para la empresa (H-46).
    const amountCents =
      commission.commission_type === 'PERCENTAGE'
        ? percentOfCents(desglose.companyBaseCents, commission.commission_value)
        : toCentsExact(commission.commission_value);
    if (amountCents > 0) {
      await connection.query(
        `INSERT INTO financial_transactions (company_id, booking_id, payment_id, type, direction, amount, currency, description, reference_code, status, transaction_date)
         VALUES (?, ?, ?, 'COMMISSION', 'DEBIT', ?, 'PEN', ?, ?, 'COMPLETED', NOW())`,
        [companyId, bookingId, paymentId, centsToDecimal(amountCents), `Comisión BusPerú de ${bookingCode}`, bookingCode],
      );
    }
    if (desglose.serviceFeeCents > 0) {
      await connection.query(
        `INSERT INTO financial_transactions (company_id, user_id, booking_id, payment_id, type, direction, amount, currency, description, reference_code, status, transaction_date)
         VALUES (NULL, ?, ?, ?, 'PAYMENT', 'CREDIT', ?, 'PEN', ?, ?, 'COMPLETED', NOW())`,
        [booking.user_id, bookingId, paymentId, centsToDecimal(desglose.serviceFeeCents), `Cargo por servicio de ${bookingCode} (plataforma)`, bookingCode],
      );
    }
    if (desglose.platformDiscountCents > 0) {
      await connection.query(
        `INSERT INTO financial_transactions (company_id, user_id, booking_id, payment_id, type, direction, amount, currency, description, reference_code, status, transaction_date)
         VALUES (NULL, ?, ?, ?, 'ADJUSTMENT', 'DEBIT', ?, 'PEN', ?, ?, 'COMPLETED', NOW())`,
        [booking.user_id, bookingId, paymentId, centsToDecimal(desglose.platformDiscountCents), `Cupón de plataforma en ${bookingCode}: descuento asumido por BusPerú`, bookingCode],
      );
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

// --- Pagos manuales pendientes de verificación (auditoría FASE 9, hallazgo H-22) ----------

/** Métodos sin pasarela: nadie comprueba el cobro salvo una persona de la empresa o BusPerú. */
export const MANUAL_PAYMENT_METHODS: readonly PaymentMethod[] = ['YAPE', 'PLIN', 'TRANSFER', 'CASH', 'OTHER'];

export const isManualPaymentMethod = (method: string): boolean => (MANUAL_PAYMENT_METHODS as readonly string[]).includes(method);

/**
 * ¿Puede este usuario dar por cobrado un pago manual? Solo el backoffice que responde del
 * dinero: ADMIN y COMPANY_ADMIN (este, además, solo dentro de su empresa, que comprueba quien
 * llama). OPERATOR y CUSTOMER no.
 */
export const canVerifyManualPayments = (user: Pick<AuthenticatedUser, 'role'>): boolean =>
  user.role === 'ADMIN' || user.role === 'COMPANY_ADMIN';

/** Añade claves a `payments.payment_data` sin perder las que ya tuviera. */
export function mergePaymentData(raw: unknown, patch: Record<string, unknown>): string {
  let base: Record<string, unknown> = {};
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  return JSON.stringify({ ...base, ...patch });
}

export type ManualPaymentRegistration = 'REGISTERED' | 'ALREADY_CONFIRMED';

/**
 * Registra el pago manual de una reserva SIN confirmarla (H-22).
 *
 * POR QUÉ. Con Yape, Plin, transferencia, efectivo u otro, el pasajero declaraba que había
 * pagado y el backend lo daba por hecho: reserva CONFIRMED, pago PAID, venta y comisión. Nadie
 * había visto el dinero. Ahora el pago queda PENDING con la marca `manual_verification` y la
 * reserva sigue PENDING, reteniendo sus asientos con las reglas de siempre (incluida la
 * expiración). Lo confirma o lo rechaza el backoffice con `POST /payments/:id/approve|reject`.
 *
 * No escribe movimientos financieros ni notificaciones: todavía no ha entrado dinero.
 *
 * Bloquea viaje → reserva → pagos, el mismo orden que la venta, la confirmación y la
 * expiración. Es idempotente: repetirlo reutiliza el mismo pago PENDING.
 */
export async function registerManualPaymentOnConnection(
  connection: PoolConnection,
  bookingId: number,
  method: PaymentMethod,
  requestedBy: number,
): Promise<ManualPaymentRegistration> {
  if (!isManualPaymentMethod(method)) throw ApiError.badRequest('El método indicado no es un pago manual');

  const [tripRows] = await connection.query('SELECT trip_id FROM bookings WHERE id = ? LIMIT 1', [bookingId]);
  const tripId = (tripRows as Array<{ trip_id: number }>)[0]?.trip_id;
  if (tripId === undefined) throw ApiError.notFound('Reserva no encontrada');
  const [lockedTrip] = await connection.query('SELECT id, status FROM trips WHERE id = ? LIMIT 1 FOR UPDATE', [tripId]);
  const tripStatus = (lockedTrip as Array<{ status: string }>)[0]?.status;

  const [bookingRows] = await connection.query(
    'SELECT id, status, booking_code, total_amount FROM bookings WHERE id = ? LIMIT 1 FOR UPDATE',
    [bookingId],
  );
  const booking = (bookingRows as Array<{ id: number; status: string; booking_code: string; total_amount: string }>)[0];
  if (!booking) throw ApiError.notFound('Reserva no encontrada');
  if (booking.status === 'CANCELLED' || booking.status === 'EXPIRED') throw ApiError.badRequest('La reserva ya no está vigente');
  if (booking.status === 'CONFIRMED' || booking.status === 'COMPLETED') return 'ALREADY_CONFIRMED';
  if (tripStatus === 'CANCELLED') throw ApiError.badRequest('El viaje fue cancelado: esta reserva ya no se puede pagar');
  // H-36: registrar un pago es avanzar una venta; una empresa no activa no la admite.
  const [companyRows] = await connection.query('SELECT r.company_id FROM trips t JOIN routes r ON r.id = t.route_id WHERE t.id = ? LIMIT 1', [tripId]);
  const saleCompanyId = (companyRows as Array<{ company_id: number }>)[0]?.company_id;
  if (saleCompanyId !== undefined) await assertCompanyCanSell(Number(saleCompanyId), connection);

  // Por clave primaria, como `cancelOpenPayments`: nada de `index_merge` sobre otras reservas.
  const [paymentRows] = await connection.query(
    'SELECT id, status, payment_data FROM payments WHERE booking_id = ? ORDER BY id DESC FOR UPDATE',
    [bookingId],
  );
  const pagos = paymentRows as Array<{ id: number; status: string; payment_data: string | null }>;
  if (pagos.some((pago) => pago.status === 'PROCESSING')) {
    throw ApiError.conflict('Hay un cobro con tarjeta en curso para esta reserva. Espera a que termine.');
  }

  const marca = {
    manual_verification: { status: 'PENDING_REVIEW', requested_by: requestedBy, requested_at: new Date().toISOString() },
  };
  const pendiente = pagos.find((pago) => pago.status === 'PENDING');
  if (pendiente) {
    await connection.query(
      'UPDATE payments SET method = ?, provider = NULL, provider_transaction_id = NULL, paid_at = NULL, payment_data = ? WHERE id = ?',
      [method, mergePaymentData(pendiente.payment_data, marca), pendiente.id],
    );
  } else {
    await connection.query(
      `INSERT INTO payments (booking_id, transaction_code, amount, currency, method, status, payment_data)
       VALUES (?, ?, ?, 'PEN', ?, 'PENDING', ?)`,
      [bookingId, `TRX-${booking.booking_code}-${Date.now().toString().slice(-6)}`, booking.total_amount, method, JSON.stringify(marca)],
    );
  }
  return 'REGISTERED';
}

/** Registro de un pago manual de una reserva suelta, en su propia transacción. */
export async function registerManualPayment(bookingId: number, method: PaymentMethod, requestedBy: number): Promise<ManualPaymentRegistration> {
  return withDeadlockRetry(() =>
    withTransaction((connection) => registerManualPaymentOnConnection(connection, bookingId, method, requestedBy)),
  );
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
export async function cancelBooking(bookingId: number, reason: string | null): Promise<void> {
  const cancellationHours = await readNumberSetting('booking.cancellation_hours', { fallback: 24, min: 0 });

  // Bloquea viaje → reserva → pago; un alta manual simultánea puede cruzarse: se repite entera.
  await withDeadlockRetry(() => withTransaction(async (connection) => {
    const cancelled = await cancelBookingOnConnection(connection, bookingId, reason, cancellationHours);

    const context = await tripContext(connection, cancelled.tripId);
    await notify(connection, {
      userId: cancelled.userId,
      event: NOTIFICATION_EVENTS.BOOKING_CANCELLED,
      eventKey: `${NOTIFICATION_EVENTS.BOOKING_CANCELLED}:${bookingId}`,
      context: {
        ...context,
        booking_code: cancelled.bookingCode,
        booking_id: bookingId,
        total_amount: money(cancelled.totalAmount),
        reason: reason ?? '',
      },
    });
  }));
}

export interface CancelledBooking {
  bookingId: number;
  bookingCode: string;
  userId: number;
  tripId: number;
  previousStatus: 'PENDING' | 'CONFIRMED';
  totalAmount: number;
  passengerEmail: string | null;
  /** Reembolso abierto en ESTA cancelación; null si no había pago cobrado o ya existía uno. */
  refundId: number | null;
  refundAmount: number | null;
}

/**
 * Cuerpo de la cancelación de una reserva, sobre una conexión ya en transacción.
 *
 * Se extrajo de `cancelBooking` con el mismo criterio que `createBookingOnConnection`: la
 * cancelación de un viaje (FASE 8H) cancela N reservas dentro de UNA transacción, y cada una
 * debe seguir exactamente las mismas reglas que cuando la cancela el pasajero. La lógica no
 * cambia; la notificación la decide quien llama.
 *
 * EL REEMBOLSO ES IDEMPOTENTE. Se inserta solo si el pago no tiene ya otro reembolso vivo
 * (todo lo que no sea FAILED ni CANCELLED). La reserva bloqueada y su paso a CANCELLED ya
 * impedían repetirlo; esta condición es la red por si el mismo pago llega por dos caminos.
 */
export async function cancelBookingOnConnection(
  connection: PoolConnection,
  bookingId: number,
  reason: string | null,
  cancellationHours: number,
): Promise<CancelledBooking> {
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

  // El tope sale de la version que el viaje congelo, no del bus. Ver `TRIP_SEAT_CAPACITY_SQL`.
  await connection.query(
    `UPDATE trips t
     SET t.available_seats = LEAST(COALESCE(t.available_seats, 0) + ?, ${TRIP_SEAT_CAPACITY_SQL})
     WHERE t.id = ? AND t.available_seats IS NOT NULL`,
    [Number(booking.passenger_count), booking.trip_id],
  );

  // H-50: si la reserva tiene un pago cobrado, cancelarla SIEMPRE abre su reembolso. Antes solo lo
  // hacía si llegaba `request_refund`: sin él la reserva quedaba CANCELLED, liberaba sus asientos y
  // el dinero se quedaba retenido. La política no puede depender de que el cliente mande un flag.
  // El alta sigue siendo la idempotente de siempre (un reembolso vivo por pago).
  //
  // H-28: el reembolso es por lo que QUEDA por devolver, no por el total. Tras un reembolso parcial
  // el pago sigue PAID, y cancelar la reserva devuelve el resto; si ya hay reembolsos vivos que
  // cubren el total, no se abre ninguno (idempotente). El pago se bloquea —después del viaje y la
  // reserva, el mismo orden que la venta— para que el alta manual no calcule a la vez sobre el mismo
  // saldo.
  let refundId: number | null = null;
  let refundAmount: number | null = null;
  {
    const [paymentRows] = await connection.query(
      "SELECT id, amount FROM payments WHERE booking_id = ? AND status = 'PAID' ORDER BY id DESC LIMIT 1 FOR UPDATE",
      [bookingId],
    );
    const payment = (paymentRows as Array<{ id: number; amount: string }>)[0];
    if (payment) {
      const [vivosRows] = await connection.query(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE payment_id = ? AND status NOT IN ('FAILED', 'CANCELLED')",
        [payment.id],
      );
      const restanteCents = toCentsExact(String(payment.amount)) - toCentsExact(String((vivosRows as Array<{ total: string }>)[0]?.total ?? '0'));
      if (restanteCents > 0) {
        const [inserted] = await connection.query(
          "INSERT INTO refunds (payment_id, booking_id, amount, reason, status) VALUES (?, ?, ?, ?, 'PENDING')",
          [payment.id, bookingId, centsToDecimal(restanteCents), reason ?? 'Cancelación solicitada por el pasajero'],
        );
        refundId = (inserted as { insertId: number }).insertId;
        refundAmount = restanteCents / 100;
      }
    }
  }

  return {
    bookingId,
    bookingCode: String(booking.booking_code),
    userId: Number(booking.user_id),
    tripId: Number(booking.trip_id),
    previousStatus: booking.status as 'PENDING' | 'CONFIRMED',
    totalAmount: Number(booking.total_amount),
    passengerEmail: (booking.passenger_email as string | null) ?? null,
    refundId,
    refundAmount,
  };
}

/**
 * Reintenta una transacción completa si InnoDB la eligió como víctima de un interbloqueo.
 *
 * POR QUÉ EXISTE (8H-CIERRE). Cancelar muchos viajes a la vez —o cancelar mientras corre la
 * expiración— abre reembolsos en paralelo, y el alta idempotente del reembolso
 * (`INSERT … SELECT … WHERE NOT EXISTS`) toma un cerrojo de HUECO en `idx_refunds_payment`:
 * dos transacciones con pagos distintos que caen en el mismo hueco del índice se esperan
 * mutuamente al insertar. Esa lectura bloqueante es justo lo que garantiza que no haya dos
 * reembolsos del mismo pago, así que no se debilita; se hace lo que la documentación de MySQL
 * indica para `ER_LOCK_DEADLOCK`: repetir la transacción.
 *
 * Es seguro porque InnoDB ya deshizo la transacción entera —no queda nada a medias— y porque
 * lo que se reintenta es idempotente. Pocas veces y con una espera breve y aleatoria para que
 * los competidores no vuelvan a chocar al mismo ritmo. Cualquier otro error se propaga tal cual.
 */
export async function withDeadlockRetry<T>(operation: () => Promise<T>, attempts = 5): Promise<T> {
  for (let intento = 1; ; intento += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code !== 'ER_LOCK_DEADLOCK' || intento >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * intento + Math.floor(Math.random() * 40)));
    }
  }
}

/**
 * Cierra (CANCELLED) los pagos de UNA reserva que estén en alguno de los estados indicados.
 *
 * POR QUÉ NO ES UN SOLO `UPDATE … WHERE booking_id = ? AND status IN (…)` (8H-CIERRE). Con esas
 * dos condiciones MariaDB resuelve la sentencia con `index_merge` sobre `idx_payments_booking`
 * e `idx_payments_status`, y bloquea el rango del ÍNDICE DE ESTADO: todos los pagos PENDING de
 * la plataforma, no solo los de esta reserva. Dos cancelaciones de viajes distintos —o una
 * cancelación y una expiración— se bloqueaban entonces pagos ajenos y acababan en
 * `ER_LOCK_DEADLOCK`, reproducido en `49-trip-cancellation` (X1).
 *
 * Aquí se bloquean primero los pagos de la reserva por su propio índice (una sola condición:
 * `ref` sobre `idx_payments_booking`) y se actualizan después por clave primaria. El efecto es
 * idéntico; el conjunto bloqueado queda limitado a la reserva.
 */
export async function cancelOpenPayments(
  connection: PoolConnection,
  bookingId: number,
  statuses: readonly string[],
): Promise<number> {
  const [rows] = await connection.query('SELECT id, status FROM payments WHERE booking_id = ? FOR UPDATE', [bookingId]);
  const ids = (rows as Array<{ id: number; status: string }>)
    .filter((payment) => statuses.includes(payment.status))
    .map((payment) => payment.id);
  if (ids.length === 0) return 0;
  await connection.query(`UPDATE payments SET status = 'CANCELLED' WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
  return ids.length;
}

// --- Cancelación de un viaje completo (FASE 8H) ---------------------------------------

/**
 * H-29 · ¿Puede haber un cobro con tarjeta que BusPerú todavía no conoce? Sí si queda un pago en
 * PROCESSING (cargo en vuelo) o uno que falló por TIMEOUT (Culqi no respondió y pudo cobrar). En
 * esos casos no se afirma que «no se realizó ningún cobro»: lo resolverá el webhook (H-42).
 */
export async function chargeOutcomeIsUncertain(connection: PoolConnection, bookingId: number): Promise<boolean> {
  const [rows] = await connection.query(
    `SELECT id FROM payments
     WHERE booking_id = ? AND method = 'CARD'
       AND (status = 'PROCESSING' OR (status = 'FAILED' AND JSON_VALID(payment_data) AND JSON_UNQUOTE(JSON_EXTRACT(payment_data, '$.failure')) = 'TIMEOUT'))
     LIMIT 1`,
    [bookingId],
  );
  return (rows as unknown[]).length > 0;
}

export const TRIP_CANCELLED_CHARGE_UNCERTAIN_MESSAGE =
  'Tu reserva no llegó a confirmarse. Si tenías un pago con tarjeta en proceso, todavía no podemos confirmar su resultado: si el cobro llegó a hacerse, lo devolveremos automáticamente y te avisaremos.';

/** Estados desde los que un viaje se puede cancelar. Fuera de aquí, el viaje ya salió o ya se canceló. */
export const TRIP_CANCELLABLE_STATUSES = ['SCHEDULED', 'BOARDING', 'DELAYED'] as const;

export interface TripCancellationResult {
  tripId: number;
  /** true si el viaje ya estaba cancelado: la llamada no hizo nada. */
  alreadyCancelled: boolean;
  bookings: CancelledBooking[];
  emailsSent: number;
}

/**
 * Cancela un viaje y todo lo que depende de él, en UNA transacción.
 *
 * QUÉ HACE, EN ESTE ORDEN:
 *   1. Bloquea el viaje. Es el primer cerrojo del ciclo de reserva (viaje → reserva → sus
 *      asientos), así que se serializa con la venta, el pago y otra cancelación del mismo viaje
 *      sin introducir un orden nuevo.
 *   2. Si ya estaba CANCELLED, sale sin tocar nada: repetir la llamada es seguro.
 *   3. Solo cancela desde SCHEDULED, BOARDING o DELAYED.
 *   4. Pasa el viaje a CANCELLED.
 *   5. Cancela cada reserva PENDING o CONFIRMED con `cancelBookingOnConnection` —las mismas
 *      reglas que cuando cancela el pasajero—: libera sus cupos, conserva `booking_seats` y,
 *      si había un pago PAID, abre UN reembolso PENDING. El dinero no se da por devuelto:
 *      eso ocurre al procesar el reembolso.
 *   6. Cierra los pagos PENDING de esas reservas, para que no queden cobrables. Los PROCESSING
 *      no se tocan: son un cobro de tarjeta en vuelo, y su cierre lo decide el propio flujo de
 *      Culqi, que ante una reserva ya no confirmable registra el cobro y abre su reembolso.
 *   7. Notifica a cada pasajero dentro de la transacción: si algo falla, no queda ni el aviso.
 *
 * El correo sale DESPUÉS de confirmar la transacción, porque es una llamada de red. Si falla,
 * se registra y la cancelación sigue en pie: la notificación interna ya existe.
 */
export async function cancelTrip(tripId: number): Promise<TripCancellationResult> {
  const cancellationHours = await readNumberSetting('booking.cancellation_hours', { fallback: 24, min: 0 });
  const reason = 'Viaje cancelado por la empresa';

  const result = await withDeadlockRetry(() => withTransaction(async (connection) => {
    const [tripRows] = await connection.query('SELECT id, status FROM trips WHERE id = ? LIMIT 1 FOR UPDATE', [tripId]);
    const trip = (tripRows as Array<{ id: number; status: string }>)[0];
    if (!trip) throw ApiError.notFound('Viaje no encontrado');
    if (trip.status === 'CANCELLED') {
      return { tripId, alreadyCancelled: true, bookings: [] as CancelledBooking[], outbox: [] as Array<{ to: string; context: Record<string, string> }> };
    }
    if (!(TRIP_CANCELLABLE_STATUSES as readonly string[]).includes(trip.status)) {
      throw ApiError.badRequest('Solo se puede cancelar un viaje programado, en embarque o retrasado');
    }

    await connection.query(
      "UPDATE trips SET status = 'CANCELLED' WHERE id = ? AND status IN ('SCHEDULED', 'BOARDING', 'DELAYED')",
      [tripId],
    );

    const [bookingRows] = await connection.query(
      "SELECT id FROM bookings WHERE trip_id = ? AND status IN ('PENDING', 'CONFIRMED') ORDER BY id ASC FOR UPDATE",
      [tripId],
    );

    const context = await tripContext(connection, tripId);
    const bookings: CancelledBooking[] = [];
    const outbox: Array<{ to: string; context: Record<string, string> }> = [];
    for (const { id } of bookingRows as Array<{ id: number }>) {
      const cancelled = await cancelBookingOnConnection(connection, id, reason, cancellationHours);
      await cancelOpenPayments(connection, id, ['PENDING']);

      const refundMessage =
        cancelled.refundId !== null
          ? `Generamos una solicitud de reembolso de ${money(cancelled.refundAmount ?? 0)}; te avisaremos cuando se procese.`
          : cancelled.previousStatus === 'PENDING'
            ? (await chargeOutcomeIsUncertain(connection, id))
              ? TRIP_CANCELLED_CHARGE_UNCERTAIN_MESSAGE
              : 'Tu reserva aún no estaba pagada, así que no se realizó ningún cobro.'
            : 'No encontramos un pago cobrado asociado a esta reserva.';

      await notify(connection, {
        userId: cancelled.userId,
        event: NOTIFICATION_EVENTS.TRIP_CANCELLED,
        eventKey: `${NOTIFICATION_EVENTS.TRIP_CANCELLED}:${tripId}:${id}`,
        context: {
          ...context,
          booking_code: cancelled.bookingCode,
          booking_id: id,
          trip_id: tripId,
          refund_id: cancelled.refundId,
          refund_message: refundMessage,
        },
      });
      bookings.push(cancelled);

      const [accountRows] = await connection.query('SELECT email FROM users WHERE id = ? LIMIT 1', [cancelled.userId]);
      const to = cancelled.passengerEmail || (accountRows as Array<{ email: string }>)[0]?.email || null;
      if (to) outbox.push({ to, context: { ...context, booking_code: cancelled.bookingCode, refund_message: refundMessage } });
    }

    return { tripId, alreadyCancelled: false, bookings, outbox };
  }));

  let emailsSent = 0;
  for (const message of result.outbox) {
    const { subject, body } = await renderTemplate(TRIP_CANCELLED_EMAIL, message.context);
    if (await sendEmail({ to: message.to, subject, text: body })) emailsSent += 1;
  }

  return { tripId: result.tripId, alreadyCancelled: result.alreadyCancelled, bookings: result.bookings, emailsSent };
}
