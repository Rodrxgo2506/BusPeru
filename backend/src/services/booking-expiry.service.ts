import { query, withTransaction } from '../config/database';
import { NOTIFICATION_EVENTS, notify } from './notification.service';
import { purgeExpiredResetTokens } from './password-reset.service';
import { advanceTripLifecycle } from './trip.service';
import { TRIP_SEAT_CAPACITY_SQL, cancelOpenPayments, withDeadlockRetry } from './booking.service';
import { purgeExpired as purgeExpiredOAuthFlows } from '../repositories/oauth-flow.repository';
import { purgeExpiredRevocations } from './session-revocation.service';
import { logError } from '../utils/logger';
import { recordSystemAudit } from './audit.service';

/**
 * Expiración de reservas PENDING cuyo `expires_at` ya venció.
 *
 * Por cada reserva, dentro de su propia transacción:
 *   1. Bloquea la fila con FOR UPDATE y vuelve a comprobar el estado (idempotencia real
 *      frente a ejecuciones concurrentes del planificador y llamadas manuales).
 *   2. Marca la reserva como EXPIRED.
 *   3. Cancela los pagos que siguieran PENDING/PROCESSING.
 *   4. Restaura `trips.available_seats` sin superar la capacidad del bus.
 *   5. Notifica al pasajero.
 *
 * Los `booking_seats` NO se borran: la disponibilidad se deriva del estado de la reserva
 * (una EXPIRED deja de retener el asiento), y conservar las filas mantiene el rastro de
 * qué se había reservado. El asiento queda efectivamente libre para volver a venderse.
 */

export interface ExpiryResult {
  expired: number;
  bookingIds: number[];
  seatsReleased: number;
  /**
   * Reservas que no se pudieron procesar en esta pasada (F17C-SEC-06). Se cuentan para que
   * quien llama sepa que el barrido no fue completo; el detalle va al registro de errores.
   */
  failed: number;
}

interface DueBooking {
  id: number;
  user_id: number;
  trip_id: number;
  booking_code: string;
  passenger_count: number;
  total_amount: number;
}

/**
 * A quién alcanza un barrido (auditoría BP-22).
 *
 * `all` es el barrido del sistema: el planificador no actúa en nombre de nadie y no tiene
 * —ni debe tener— sesión, rol ni empresa. Los otros dos casos existen solo para la llamada
 * manual por HTTP, donde SÍ hay alguien detrás y su alcance debe ser el de siempre.
 */
export type ExpiryScope =
  | { kind: 'all' }
  | { kind: 'user'; userId: number }
  | { kind: 'companies'; companyIds: number[] };

export interface ExpiryOptions {
  scope?: ExpiryScope;
  limit?: number;
}

/** Traduce el alcance a una condición SQL sobre los alias `bk` (reserva) y `r` (ruta). */
function scopeCondition(scope: ExpiryScope): { sql: string; params: unknown[] } {
  if (scope.kind === 'all') return { sql: '1 = 1', params: [] };
  if (scope.kind === 'user') return { sql: 'bk.user_id = ?', params: [scope.userId] };
  // Sin empresas asignadas no se ve nada: la misma regla que el resto de listados.
  if (scope.companyIds.length === 0) return { sql: '1 = 0', params: [] };
  return {
    sql: `r.company_id IN (${scope.companyIds.map(() => '?').join(', ')})`,
    params: [...scope.companyIds],
  };
}

/**
 * Barre las reservas vencidas.
 *
 * ALCANCE (auditoría BP-22). Por omisión el barrido es GLOBAL, que es lo que necesita el
 * planificador: una retención que venció debe caducar sea de la empresa que sea, y el
 * proceso que lo hace no representa a ningún usuario. Eso ya funcionaba así.
 *
 * Lo que no funcionaba era la llamada manual. `POST /bookings/expire` ejecutaba **este mismo
 * barrido global** con el permiso `bookings.cancel`, que tienen los cuatro roles: un
 * administrador de la empresa A caducaba reservas de la empresa B y recibía de vuelta sus
 * identificadores, y un CUSTOMER cualquiera podía disparar el barrido de toda la plataforma
 * y leer la lista. Comprobado: `{"expired":2,"bookingIds":[1,2]}` devuelto a la empresa A,
 * con la reserva 2 perteneciendo a la empresa B.
 *
 * Las REGLAS NO CAMBIAN: sigue caducando exactamente `PENDING` con `expires_at` vencido, ni
 * antes ni después. Lo único que se acota es a qué reservas llega **quien llama por HTTP**,
 * con el mismo criterio de visibilidad que el resto de la API. Una reserva ajena que haya
 * vencido caduca igual: la caduca el planificador, dentro del minuto siguiente.
 *
 * El JOIN con `trips` y `routes` no altera qué filas entran —ambas claves foráneas son NOT
 * NULL— y evita tener dos consultas distintas que puedan divergir.
 */
export async function expireDueBookings(options: ExpiryOptions = {}): Promise<ExpiryResult> {
  const limit = options.limit ?? 200;
  const scope = scopeCondition(options.scope ?? { kind: 'all' });

  const due = await query<DueBooking>(
    `SELECT bk.id, bk.user_id, bk.trip_id, bk.booking_code, bk.passenger_count, bk.total_amount
     FROM bookings bk
     JOIN trips t ON t.id = bk.trip_id
     JOIN routes r ON r.id = t.route_id
     WHERE bk.status = 'PENDING' AND bk.expires_at IS NOT NULL AND bk.expires_at <= NOW()
       AND ${scope.sql}
     ORDER BY bk.expires_at ASC
     LIMIT ?`,
    [...scope.params, limit],
  );

  const result: ExpiryResult = { expired: 0, bookingIds: [], seatsReleased: 0, failed: 0 };

  for (const candidate of due) {
    /**
     * F17C-SEC-06 · CADA RESERVA VA EN SU PROPIO `try`.
     *
     * Ya tenía una transacción por reserva, pero si esa transacción lanzaba, el error subía y
     * abortaba el bucle: la auditoría lo comprobó rompiendo la PRIMERA candidata, y el barrido
     * terminó con cero expiradas dejando en PENDING a las otras dos, que estaban sanas. Y como
     * las candidatas se ordenan por `expires_at ASC`, la que falla es siempre la primera de la
     * lista: una sola reserva atascada bloqueaba la expiración de TODAS las demás, para siempre.
     * Los asientos no se liberaban y las reservas se acumulaban.
     *
     * Ahora el fallo se registra y el barrido sigue con la siguiente. El siguiente ciclo del
     * planificador volverá a intentar la que falló, que es el comportamiento deseado: reintento
     * sin bloqueo. `withDeadlockRetry` se conserva tal cual para el caso del interbloqueo.
     */
    let processed: { id: number; seats: number } | null = null;
    try {
      processed = await withDeadlockRetry(() => withTransaction(async (connection) => {
        // El viaje primero, igual que en la venta y en la confirmación (auditoría BP-19).
        // Las tres rutas que cambian la ocupación de un asiento toman ahora los cerrojos en
        // el mismo orden —viaje, luego reserva—, de modo que no pueden quedarse esperándose
        // mutuamente. Esta transacción además actualiza `trips`, así que el cerrojo lo iba a
        // necesitar de todos modos; solo se adelanta.
        await connection.query('SELECT id FROM trips WHERE id = ? LIMIT 1 FOR UPDATE', [candidate.trip_id]);

        const [rows] = await connection.query(
          `SELECT id, user_id, trip_id, booking_code, passenger_count, total_amount, status, expires_at
           FROM bookings
           WHERE id = ? AND status = 'PENDING' AND expires_at IS NOT NULL AND expires_at <= NOW()
           LIMIT 1 FOR UPDATE`,
          [candidate.id],
        );
        const booking = (rows as Array<DueBooking & { status: string; expires_at: string | null }>)[0];
        // Otro proceso pudo pagarla o expirarla entre el listado y el bloqueo.
        if (!booking) return null;

        await connection.query("UPDATE bookings SET status = 'EXPIRED' WHERE id = ?", [booking.id]);

        // Mismo efecto que antes, sin bloquear pagos de otras reservas: ver `cancelOpenPayments`.
        await cancelOpenPayments(connection, booking.id, ['PENDING', 'PROCESSING']);

        // Devuelve los cupos sin pasarse de la capacidad de LA VERSION que usa este viaje.
        // Se sustituye el JOIN contra `buses` por subconsultas correlacionadas: un recurso
        // menos que bloquear dentro de la transaccion de expiracion.
        await connection.query(
          `UPDATE trips t
           SET t.available_seats = LEAST(COALESCE(t.available_seats, 0) + ?, ${TRIP_SEAT_CAPACITY_SQL})
           WHERE t.id = ? AND t.available_seats IS NOT NULL`,
          [booking.passenger_count, booking.trip_id],
        );

        const [seatRows] = await connection.query(
          `SELECT s.seat_number FROM booking_seats bs JOIN seats s ON s.id = bs.seat_id
           WHERE bs.booking_id = ? ORDER BY s.seat_number`,
          [booking.id],
        );
        const seatNumbers = (seatRows as Array<{ seat_number: string }>).map((row) => row.seat_number);

        const [tripRows] = await connection.query(
          `SELECT ol.city AS origin_city, dl.city AS destination_city
           FROM trips t
           JOIN routes r ON r.id = t.route_id
           JOIN locations ol ON ol.id = r.origin_location_id
           JOIN locations dl ON dl.id = r.destination_location_id
           WHERE t.id = ? LIMIT 1`,
          [booking.trip_id],
        );
        const tripInfo = (tripRows as Array<Record<string, string>>)[0] ?? {};

        await notify(connection, {
          userId: booking.user_id,
          event: NOTIFICATION_EVENTS.BOOKING_EXPIRED,
          eventKey: `${NOTIFICATION_EVENTS.BOOKING_EXPIRED}:${booking.id}`,
          context: {
            ...tripInfo,
            booking_code: booking.booking_code,
            booking_id: booking.id,
            seat_numbers: seatNumbers.join(', '),
            total_amount: `S/ ${Number(booking.total_amount).toFixed(2)}`,
          },
        });

        /**
         * RASTRO DE AUDITORÍA (F17C-SEC-10).
         *
         * Una reserva pasaba de PENDING a EXPIRED y liberaba asientos sin dejar nada en
         * `audit_logs`: para `bookings` solo constaba CREATE. Al usuario se le avisaba, sí, pero
         * una notificación no es una auditoría —se borra, es del usuario y no dice qué cambió—.
         * Una expiración masiva anómala era indistinguible de la operación normal.
         *
         * Va DENTRO de la transacción y a propósito: o quedan el cambio de estado y su registro,
         * o no queda ninguno de los dos. Si esta escritura fallara, la transacción entera se
         * deshace, la reserva sigue PENDING y el barrido la cuenta como fallida (SEC-06) para
         * reintentarla en el ciclo siguiente. Prefiero eso a una reserva expirada sin rastro.
         *
         * `user_id` queda en NULL porque no hay nadie detrás; quién fue se lee en `actor`.
         */
        await recordSystemAudit({
          action: 'EXPIRE',
          entityType: 'bookings',
          entityId: booking.id,
          actor: 'system:booking-expiry',
          description: `Expiró automáticamente la reserva ${booking.booking_code} por falta de pago`,
          oldValues: { status: 'PENDING', expires_at: booking.expires_at },
          newValues: {
            status: 'EXPIRED',
            trip_id: booking.trip_id,
            seats_released: seatNumbers.length,
            reason: 'hold_expired',
          },
        }, connection);

        return { id: booking.id, seats: seatNumbers.length };
      }));
    } catch (error) {
      // El identificador de la reserva basta para investigar; no se registra nada del pasajero.
      result.failed += 1;
      logError('No se pudo expirar una reserva vencida', error, { bookingId: candidate.id });
      continue;
    }

    if (processed) {
      result.expired += 1;
      result.bookingIds.push(processed.id);
      result.seatsReleased += processed.seats;
    }
  }

  return result;
}

let timer: NodeJS.Timeout | null = null;

/** Planificador en proceso: no requiere dependencias ni servicios externos. */
export function startBookingExpiryScheduler(intervalMs: number): void {
  if (timer) return;

  const run = async () => {
    try {
      const result = await expireDueBookings();
      if (result.expired > 0) {
        console.log(`↺ Reservas expiradas: ${result.expired} (${result.bookingIds.join(', ')}), asientos liberados: ${result.seatsReleased}`);
      }
      // Una pasada incompleta se avisa: si el número no baja, hay una reserva atascada.
      if (result.failed > 0) {
        logError('Algunas reservas vencidas no se pudieron expirar', new Error(`${result.failed} con fallo`), {});
      }
    } catch (error) {
      logError('Error al expirar reservas vencidas', error);
    }

    // El mismo ciclo avanza el ciclo de vida de los viajes: no hace falta un segundo
    // planificador, y el minuto de resolución es de sobra para una salida y una llegada.
    try {
      const trips = await advanceTripLifecycle();
      if (trips.started > 0 || trips.completed > 0) {
        console.log(
          `↺ Viajes iniciados: ${trips.started}, completados: ${trips.completed}, reservas cerradas: ${trips.bookingsCompleted}`,
        );
      }
    } catch (error) {
      logError('Error al avanzar el estado de los viajes', error);
    }

    // Aprovecha el mismo ciclo para purgar los códigos de recuperación caducados, en vez
    // de añadir otro planificador permanente al proceso.
    try {
      const purged = await purgeExpiredResetTokens();
      if (purged > 0) console.log(`↺ Códigos de recuperación purgados: ${purged}`);
    } catch (error) {
      logError('Error al purgar códigos de recuperación', error);
    }

    // Y los flujos OAuth caducados, por el mismo motivo. El borrado va por índice y con
    // LIMIT: nunca se recorre la tabla entera, y jamás durante una petición.
    try {
      const purged = await purgeExpiredOAuthFlows();
      if (purged > 0) console.log(`↺ Flujos OAuth purgados: ${purged}`);
    } catch (error) {
      logError('Error al purgar flujos OAuth', error);
    }

    // F12-07: las revocaciones de tokens ya caducados no pueden coincidir con ninguno vivo.
    try {
      const purged = await purgeExpiredRevocations();
      if (purged > 0) console.log(`↺ Sesiones revocadas purgadas: ${purged}`);
    } catch (error) {
      logError('Error al purgar sesiones revocadas', error);
    }
  };

  void run();
  timer = setInterval(() => void run(), intervalMs);
  timer.unref();
}

export function stopBookingExpiryScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
