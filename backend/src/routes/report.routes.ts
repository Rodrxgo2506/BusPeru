import { Router, type Request } from 'express';
import { query } from '../config/database';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
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

function dateRange(req: Request): Scope {
  const from = typeof req.query.from === 'string' ? req.query.from : null;
  const to = typeof req.query.to === 'string' ? req.query.to : null;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (from) {
    conditions.push('DATE(bk.created_at) >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('DATE(bk.created_at) <= ?');
    params.push(to);
  }
  return { sql: conditions.length > 0 ? conditions.join(' AND ') : '1 = 1', params };
}

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
    WHERE p.status = 'PAID' AND {scope} AND {range}
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

  occupancy: `SELECT CONCAT(ol.city, ' → ', dl.city) AS label,
      COUNT(DISTINCT t.id) AS trips,
      SUM(b.capacity) AS capacity,
      (SELECT COUNT(*) FROM booking_seats bs JOIN bookings bk2 ON bk2.id = bs.booking_id
        WHERE bs.trip_id = t.id AND bk2.status IN ('CONFIRMED','COMPLETED')) AS seats_sold
    FROM trips t
    JOIN routes r ON r.id = t.route_id
    JOIN buses b ON b.id = t.bus_id
    JOIN locations ol ON ol.id = r.origin_location_id
    JOIN locations dl ON dl.id = r.destination_location_id
    LEFT JOIN bookings bk ON bk.trip_id = t.id
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
    const range = dateRange(req);
    const sql = template.replace('{scope}', scope.sql).replace('{range}', range.sql);

    const rows = await query(sql, [...scope.params, ...range.params]);
    sendSuccess(res, { report: key, rows });
  }),
);

export default router;
