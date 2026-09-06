import { Router } from 'express';
import { query, queryOne } from '../config/database';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendSuccess } from '../utils/http';

const router = Router();
router.use(authenticate);

/** All dashboard numbers come from the database; nothing here is hardcoded. */
router.get(
  '/admin',
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    if (user.role !== 'ADMIN') throw ApiError.forbidden('Solo el administrador de la plataforma puede ver este panel');

    const [totals, salesSeries, topCompanies, topRoutes, paymentMethods, recentActivity, alerts] = await Promise.all([
      queryOne(
        `SELECT
          (SELECT COUNT(*) FROM companies) AS companies_total,
          (SELECT COUNT(*) FROM companies WHERE status = 'PENDING') AS companies_pending,
          (SELECT COUNT(*) FROM users) AS users_total,
          (SELECT COUNT(*) FROM trips WHERE status IN ('SCHEDULED','BOARDING','IN_PROGRESS')) AS trips_active,
          (SELECT COUNT(*) FROM trips WHERE DATE(departure_datetime) = CURDATE()) AS trips_today,
          (SELECT COUNT(*) FROM bookings WHERE status IN ('CONFIRMED','COMPLETED')) AS bookings_confirmed,
          (SELECT COUNT(*) FROM booking_seats bs JOIN bookings bk ON bk.id = bs.booking_id
            WHERE bk.status IN ('CONFIRMED','COMPLETED')) AS tickets_sold,
          (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'PAID') AS revenue_total,
          (SELECT COUNT(*) FROM refunds WHERE status = 'COMPLETED') AS refunds_processed,
          (SELECT COALESCE(SUM(amount), 0) FROM financial_transactions WHERE type = 'COMMISSION' AND status = 'COMPLETED') AS commissions_total,
          (SELECT COALESCE(SUM(net_amount), 0) FROM settlements WHERE status = 'PAID') AS settlements_paid`,
      ),
      query(
        `SELECT DATE(p.paid_at) AS day, COALESCE(SUM(p.amount), 0) AS amount, COUNT(*) AS payments
         FROM payments p
         WHERE p.status = 'PAID' AND p.paid_at >= CURDATE() - INTERVAL 29 DAY
         GROUP BY DATE(p.paid_at) ORDER BY day ASC`,
      ),
      query(
        `SELECT co.id, co.name, co.logo_url, COALESCE(SUM(p.amount), 0) AS revenue, COUNT(DISTINCT bk.id) AS bookings
         FROM companies co
         JOIN routes r ON r.company_id = co.id
         JOIN trips t ON t.route_id = r.id
         JOIN bookings bk ON bk.trip_id = t.id
         JOIN payments p ON p.booking_id = bk.id AND p.status = 'PAID'
         GROUP BY co.id, co.name, co.logo_url ORDER BY revenue DESC LIMIT 5`,
      ),
      query(
        `SELECT CONCAT(ol.city, ' → ', dl.city) AS route, COUNT(bk.id) AS bookings, COALESCE(SUM(bk.total_amount), 0) AS revenue
         FROM bookings bk
         JOIN trips t ON t.id = bk.trip_id
         JOIN routes r ON r.id = t.route_id
         JOIN locations ol ON ol.id = r.origin_location_id
         JOIN locations dl ON dl.id = r.destination_location_id
         WHERE bk.status IN ('CONFIRMED','COMPLETED')
         GROUP BY route ORDER BY bookings DESC LIMIT 5`,
      ),
      query(
        `SELECT p.method, COUNT(*) AS payments, COALESCE(SUM(p.amount), 0) AS amount
         FROM payments p WHERE p.status = 'PAID' GROUP BY p.method ORDER BY amount DESC`,
      ),
      query(
        `SELECT al.action, al.entity_type, al.description, al.created_at, u.first_name, u.last_name
         FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id
         ORDER BY al.created_at DESC LIMIT 8`,
      ),
      queryOne(
        `SELECT
          (SELECT COUNT(*) FROM companies WHERE status = 'PENDING') AS companies_pending,
          (SELECT COUNT(*) FROM refunds WHERE status = 'PENDING') AS refunds_pending,
          (SELECT COUNT(*) FROM support_tickets WHERE status IN ('OPEN','IN_PROGRESS')) AS tickets_open,
          (SELECT COUNT(*) FROM settlements WHERE status = 'PENDING') AS settlements_pending,
          (SELECT COUNT(*) FROM reviews WHERE status = 'PENDING') AS reviews_pending`,
      ),
    ]);

    sendSuccess(res, { totals, salesSeries, topCompanies, topRoutes, paymentMethods, recentActivity, alerts });
  }),
);

router.get(
  '/company',
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    if (user.companyIds.length === 0) throw ApiError.forbidden('Tu usuario no está asociado a ninguna empresa');

    const placeholders = user.companyIds.map(() => '?').join(', ');
    const ids = user.companyIds;

    const [totals, salesSeries, upcomingTrips, paymentMethods, topRoutes, alerts] = await Promise.all([
      queryOne(
        `SELECT
          (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
            JOIN bookings bk ON bk.id = p.booking_id JOIN trips t ON t.id = bk.trip_id JOIN routes r ON r.id = t.route_id
            WHERE p.status = 'PAID' AND DATE(p.paid_at) = CURDATE() AND r.company_id IN (${placeholders})) AS sales_today,
          (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
            JOIN bookings bk ON bk.id = p.booking_id JOIN trips t ON t.id = bk.trip_id JOIN routes r ON r.id = t.route_id
            WHERE p.status = 'PAID' AND DATE(p.paid_at) = CURDATE() - INTERVAL 1 DAY AND r.company_id IN (${placeholders})) AS sales_yesterday,
          (SELECT COUNT(*) FROM booking_seats bs JOIN bookings bk ON bk.id = bs.booking_id
            JOIN trips t ON t.id = bk.trip_id JOIN routes r ON r.id = t.route_id
            WHERE bk.status IN ('CONFIRMED','COMPLETED') AND r.company_id IN (${placeholders})) AS tickets_sold,
          (SELECT COUNT(*) FROM trips t JOIN routes r ON r.id = t.route_id
            WHERE DATE(t.departure_datetime) = CURDATE() AND r.company_id IN (${placeholders})) AS trips_today,
          (SELECT COUNT(*) FROM buses b WHERE b.company_id IN (${placeholders})) AS buses_total,
          (SELECT COUNT(*) FROM buses b WHERE b.status = 'ACTIVE' AND b.company_id IN (${placeholders})) AS buses_active,
          (SELECT COUNT(*) FROM routes r WHERE r.company_id IN (${placeholders})) AS routes_total,
          (SELECT COUNT(*) FROM bookings bk JOIN trips t ON t.id = bk.trip_id JOIN routes r ON r.id = t.route_id
            WHERE bk.status = 'PENDING' AND r.company_id IN (${placeholders})) AS bookings_pending`,
        [...ids, ...ids, ...ids, ...ids, ...ids, ...ids, ...ids, ...ids],
      ),
      query(
        `SELECT DATE(p.paid_at) AS day, COALESCE(SUM(p.amount), 0) AS amount
         FROM payments p
         JOIN bookings bk ON bk.id = p.booking_id JOIN trips t ON t.id = bk.trip_id JOIN routes r ON r.id = t.route_id
         WHERE p.status = 'PAID' AND p.paid_at >= CURDATE() - INTERVAL 6 DAY AND r.company_id IN (${placeholders})
         GROUP BY DATE(p.paid_at) ORDER BY day ASC`,
        ids,
      ),
      query(
        `SELECT t.id, t.departure_datetime, t.status, b.code AS bus_code, b.capacity,
                ol.city AS origin_city, dl.city AS destination_city,
                (SELECT COUNT(*) FROM booking_seats bs JOIN bookings bk ON bk.id = bs.booking_id
                  WHERE bs.trip_id = t.id AND bk.status IN ('CONFIRMED','COMPLETED')) AS seats_sold
         FROM trips t
         JOIN routes r ON r.id = t.route_id
         JOIN locations ol ON ol.id = r.origin_location_id
         JOIN locations dl ON dl.id = r.destination_location_id
         JOIN buses b ON b.id = t.bus_id
         WHERE r.company_id IN (${placeholders}) AND t.departure_datetime >= NOW()
         ORDER BY t.departure_datetime ASC LIMIT 5`,
        ids,
      ),
      query(
        `SELECT p.method, COALESCE(SUM(p.amount), 0) AS amount, COUNT(*) AS payments
         FROM payments p
         JOIN bookings bk ON bk.id = p.booking_id JOIN trips t ON t.id = bk.trip_id JOIN routes r ON r.id = t.route_id
         WHERE p.status = 'PAID' AND r.company_id IN (${placeholders})
         GROUP BY p.method ORDER BY amount DESC`,
        ids,
      ),
      query(
        `SELECT CONCAT(ol.city, ' → ', dl.city) AS route, COALESCE(SUM(bk.total_amount), 0) AS revenue, COUNT(bk.id) AS bookings
         FROM bookings bk
         JOIN trips t ON t.id = bk.trip_id
         JOIN routes r ON r.id = t.route_id
         JOIN locations ol ON ol.id = r.origin_location_id
         JOIN locations dl ON dl.id = r.destination_location_id
         WHERE bk.status IN ('CONFIRMED','COMPLETED') AND r.company_id IN (${placeholders})
         GROUP BY route ORDER BY revenue DESC LIMIT 5`,
        ids,
      ),
      queryOne(
        `SELECT
          (SELECT COUNT(*) FROM buses b WHERE b.status = 'MAINTENANCE' AND b.company_id IN (${placeholders})) AS buses_maintenance,
          (SELECT COUNT(*) FROM support_tickets st WHERE st.status IN ('OPEN','IN_PROGRESS') AND st.company_id IN (${placeholders})) AS tickets_open,
          (SELECT COUNT(*) FROM settlements s WHERE s.status = 'PENDING' AND s.company_id IN (${placeholders})) AS settlements_pending,
          (SELECT COUNT(*) FROM reviews rv WHERE rv.status = 'PENDING' AND rv.company_id IN (${placeholders})) AS reviews_pending`,
        [...ids, ...ids, ...ids, ...ids],
      ),
    ]);

    sendSuccess(res, { totals, salesSeries, upcomingTrips, paymentMethods, topRoutes, alerts });
  }),
);

router.get(
  '/customer',
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);

    const [totals, upcomingTrips, recentBookings] = await Promise.all([
      queryOne(
        `SELECT
          (SELECT COUNT(*) FROM bookings WHERE user_id = ? AND status IN ('CONFIRMED','COMPLETED')) AS trips_taken,
          (SELECT COALESCE(SUM(total_amount), 0) FROM bookings WHERE user_id = ? AND status IN ('CONFIRMED','COMPLETED')) AS total_spent,
          (SELECT COUNT(*) FROM bookings bk JOIN trips t ON t.id = bk.trip_id
            WHERE bk.user_id = ? AND bk.status = 'CONFIRMED' AND t.departure_datetime >= NOW()) AS upcoming,
          (SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = 0) AS unread_notifications`,
        [user.id, user.id, user.id, user.id],
      ),
      query(
        `SELECT bk.id, bk.booking_code, bk.status, bk.total_amount, t.departure_datetime, t.arrival_datetime,
                ol.city AS origin_city, ol.name AS origin_terminal, dl.city AS destination_city, dl.name AS destination_terminal,
                co.name AS company_name, bt.name AS bus_type_name,
                (SELECT GROUP_CONCAT(s.seat_number ORDER BY s.seat_number SEPARATOR ', ')
                  FROM booking_seats bs JOIN seats s ON s.id = bs.seat_id WHERE bs.booking_id = bk.id) AS seat_numbers
         FROM bookings bk
         JOIN trips t ON t.id = bk.trip_id
         JOIN routes r ON r.id = t.route_id
         JOIN locations ol ON ol.id = r.origin_location_id
         JOIN locations dl ON dl.id = r.destination_location_id
         JOIN companies co ON co.id = r.company_id
         JOIN buses b ON b.id = t.bus_id
         LEFT JOIN bus_types bt ON bt.id = b.bus_type_id
         WHERE bk.user_id = ? AND bk.status IN ('PENDING','CONFIRMED') AND t.departure_datetime >= NOW()
         ORDER BY t.departure_datetime ASC LIMIT 5`,
        [user.id],
      ),
      query(
        `SELECT bk.id, bk.booking_code, bk.status, bk.total_amount, bk.created_at
         FROM bookings bk WHERE bk.user_id = ? ORDER BY bk.created_at DESC LIMIT 5`,
        [user.id],
      ),
    ]);

    sendSuccess(res, { totals, upcomingTrips, recentBookings });
  }),
);

export default router;
