import { Router, type Request } from 'express';
import { query } from '../config/database';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { TRIP_SEAT_CAPACITY_SQL } from '../services/trip.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendSuccess } from '../utils/http';

const router = Router();
router.use(authenticate);
router.use(requirePermission('reports.view'));

interface Scope {
  sql: string;
  params: unknown[];
}

function companyScope(req: Request): Scope {
  const user = requireAuth(req);
  if (user.role === 'ADMIN') return { sql: '1 = 1', params: [] };
  if (user.companyIds.length === 0) return { sql: '1 = 0', params: [] };
  return { sql: `r.company_id IN (${user.companyIds.map(() => '?').join(', ')})`, params: [...user.companyIds] };
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Filtro `from`/`to` sobre la fecha DEL HECHO que mide cada reporte (auditoría 11F, H-32).
 *
 * Antes todos filtraban por `bk.created_at`: una reserva creada en enero y cancelada en marzo no
 * salía en las cancelaciones de marzo, el reporte de métodos de pago ignoraba cuándo se cobró y la
 * ocupación dejaba fuera los viajes sin reservas. Ahora cada reporte declara su columna.
 *
 * Los límites son días completos e INCLUSIVOS (`DATE(col) BETWEEN from AND to`), en la hora de
 * Perú con la que la conexión guarda y compara las fechas. Solo se aceptan fechas `AAAA-MM-DD`.
 */
function dateRange(req: Request, column: string): Scope {
  const conditions: string[] = [];
  const params: unknown[] = [];
  for (const [clave, operador] of [['from', '>='], ['to', '<=']] as const) {
    const valor = req.query[clave];
    if (valor === undefined || valor === '') continue;
    if (typeof valor !== 'string' || !FECHA.test(valor) || Number.isNaN(Date.parse(`${valor}T00:00:00Z`))) {
      throw ApiError.badRequest(`El parámetro «${clave}» debe ser una fecha AAAA-MM-DD`);
    }
    conditions.push(`DATE(${column}) ${operador} ?`);
    params.push(valor);
  }
  return { sql: conditions.length > 0 ? conditions.join(' AND ') : '1 = 1', params };
}

/**
 * Fecha del hecho que mide cada reporte.
 *   · sales-by-* y passengers: la creación de la reserva (el día de la venta, que es también la
 *     etiqueta de `sales-by-date`). Sin cambios.
 *   · payment-methods: el cobro (`payments.paid_at`).
 *   · cancellations: la cancelación (`bookings.cancelled_at`), que es su etiqueta.
 *   · occupancy: la salida del viaje (`trips.departure_datetime`): la ocupación es de viajes.
 */
const RANGE_COLUMN: Record<string, string> = {
  'sales-by-date': 'bk.created_at',
  'sales-by-route': 'bk.created_at',
  'sales-by-bus': 'bk.created_at',
  passengers: 'bk.created_at',
  'payment-methods': 'p.paid_at',
  cancellations: 'bk.cancelled_at',
  occupancy: 't.departure_datetime',
};

const REPORTS = {
  'sales-by-date': `SELECT DATE(bk.created_at) AS label, COUNT(*) AS bookings,
      COALESCE(SUM(bk.total_amount), 0) AS revenue
    FROM bookings bk
    JOIN trips t ON t.id = bk.trip_id
    JOIN routes r ON r.id = t.route_id
    WHERE bk.status IN ('CONFIRMED','COMPLETED') AND {scope} AND {range}
    GROUP BY label ORDER BY label ASC`,

  'sales-by-route': `SELECT CONCAT(ol.city, ' → ', dl.city) AS label, COUNT(*) AS bookings,
      COALESCE(SUM(bk.total_amount), 0) AS revenue
    FROM bookings bk
    JOIN trips t ON t.id = bk.trip_id
    JOIN routes r ON r.id = t.route_id
    JOIN locations ol ON ol.id = r.origin_location_id
    JOIN locations dl ON dl.id = r.destination_location_id
    WHERE bk.status IN ('CONFIRMED','COMPLETED') AND {scope} AND {range}
    GROUP BY label ORDER BY revenue DESC`,

  'sales-by-bus': `SELECT b.code AS label, b.plate_number, COUNT(*) AS bookings,
      COALESCE(SUM(bk.total_amount), 0) AS revenue
    FROM bookings bk
    JOIN trips t ON t.id = bk.trip_id
    JOIN routes r ON r.id = t.route_id
    JOIN buses b ON b.id = t.bus_id
    WHERE bk.status IN ('CONFIRMED','COMPLETED') AND {scope} AND {range}
    GROUP BY b.id, b.code, b.plate_number ORDER BY revenue DESC`,

  'payment-methods': `SELECT p.method AS label, COUNT(*) AS payments, COALESCE(SUM(p.amount), 0) AS revenue
    FROM payments p
    JOIN bookings bk ON bk.id = p.booking_id
    JOIN trips t ON t.id = bk.trip_id
    JOIN routes r ON r.id = t.route_id
    WHERE p.status IN ('PAID','REFUNDED') AND {scope} AND {range}
    GROUP BY p.method ORDER BY revenue DESC`,

  cancellations: `SELECT DATE(bk.cancelled_at) AS label, COUNT(*) AS cancellations,
      COALESCE(SUM(bk.total_amount), 0) AS amount
    FROM bookings bk
    JOIN trips t ON t.id = bk.trip_id
    JOIN routes r ON r.id = t.route_id
    WHERE bk.status = 'CANCELLED' AND {scope} AND {range}
    GROUP BY label ORDER BY label ASC`,

  passengers: `SELECT bk.passenger_name AS label, bk.passenger_document, COUNT(*) AS trips,
      COALESCE(SUM(bk.total_amount), 0) AS spent
    FROM bookings bk
    JOIN trips t ON t.id = bk.trip_id
    JOIN routes r ON r.id = t.route_id
    WHERE bk.status IN ('CONFIRMED','COMPLETED') AND {scope} AND {range}
    GROUP BY bk.passenger_name, bk.passenger_document ORDER BY trips DESC LIMIT 100`,

  /**
   * Ocupación. Agrupa por viaje (`GROUP BY label, t.id`), así que cada fila es UN viaje.
   *
   * La capacidad es la de la VERSIÓN que ese viaje congeló, no la del bus de hoy: un bus
   * puede ir por su versión 7 mientras el viaje de marzo sigue anclado a la 1, y preguntarle
   * al bus daba una ocupación histórica falsa.
   *
   * Y va con `MAX`, no con `SUM`: dentro del grupo la capacidad es una sola. (El `LEFT JOIN
   * bookings` que multiplicaba las filas solo servía al filtro por `bk.created_at`; desde H-32 el
   * rango es la salida del viaje y ese JOIN ya no existe, así que un viaje sin reservas cuenta.)
   */
  occupancy: `SELECT CONCAT(ol.city, ' → ', dl.city) AS label,
      COUNT(DISTINCT t.id) AS trips,
      MAX(${TRIP_SEAT_CAPACITY_SQL}) AS capacity,
      (SELECT COUNT(*) FROM booking_seats bs JOIN bookings bk2 ON bk2.id = bs.booking_id
        WHERE bs.trip_id = t.id AND bk2.status IN ('CONFIRMED','COMPLETED')) AS seats_sold
    FROM trips t
    JOIN routes r ON r.id = t.route_id
    JOIN buses b ON b.id = t.bus_id
    JOIN locations ol ON ol.id = r.origin_location_id
    JOIN locations dl ON dl.id = r.destination_location_id
    WHERE {scope} AND {range}
    GROUP BY label, t.id ORDER BY trips DESC LIMIT 100`,
} as const;

type ReportKey = keyof typeof REPORTS;

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    sendSuccess(res, Object.keys(REPORTS));
  }),
);

router.get(
  '/:report',
  asyncHandler(async (req, res) => {
    const key = req.params.report as ReportKey;
    const template = REPORTS[key];
    if (!template) throw ApiError.notFound('El reporte solicitado no existe');

    const scope = companyScope(req);
    const range = dateRange(req, RANGE_COLUMN[key] ?? 'bk.created_at');
    const sql = template.replace('{scope}', scope.sql).replace('{range}', range.sql);

    const rows = await query(sql, [...scope.params, ...range.params]);
    sendSuccess(res, { report: key, rows });
  }),
);

export default router;
