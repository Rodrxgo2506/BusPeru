import { Router } from 'express';
import { validate } from '../middleware/validate.middleware';
import { searchItinerarySchema } from '../validators/itinerary.validators';
import { query, queryOne } from '../config/database';
import { optionalAuthenticate } from '../middleware/auth.middleware';
import { searchItinerary } from '../services/itinerary.service';
import { readPublicSettings } from '../services/settings.service';
import { findPublicTrip, searchTrips, seatMap } from '../services/trip.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendList, sendSuccess } from '../utils/http';
import { buildPagination, parseListQuery, parseId } from '../utils/query';

/** Endpoints reachable without a session: search, catalogues and public settings. */
const router = Router();
router.use(optionalAuthenticate);

router.get(
  '/cities',
  asyncHandler(async (_req, res) => {
    const cities = await query(
      `SELECT city, department, COUNT(*) AS terminals
       FROM locations WHERE status = 'ACTIVE' GROUP BY city, department ORDER BY city ASC`,
    );
    sendSuccess(res, cities);
  }),
);

router.get(
  '/terminals',
  asyncHandler(async (req, res) => {
    const city = typeof req.query.city === 'string' ? req.query.city : null;
    const terminals = await query(
      `SELECT id, name, city, address, type FROM locations
       WHERE status = 'ACTIVE'${city ? ' AND city = ?' : ''} ORDER BY name ASC`,
      city ? [city] : [],
    );
    sendSuccess(res, terminals);
  }),
);

router.get(
  '/companies',
  asyncHandler(async (_req, res) => {
    const companies = await query(
      `SELECT co.id, co.name, co.logo_url, co.description,
              (SELECT ROUND(AVG(rv.rating), 1) FROM reviews rv WHERE rv.company_id = co.id AND rv.status = 'PUBLISHED') AS rating,
              (SELECT COUNT(*) FROM reviews rv WHERE rv.company_id = co.id AND rv.status = 'PUBLISHED') AS reviews_count,
              (SELECT COUNT(*) FROM routes r WHERE r.company_id = co.id AND r.status = 'ACTIVE') AS routes_count
       FROM companies co WHERE co.status = 'ACTIVE' ORDER BY co.name ASC`,
    );
    sendSuccess(res, companies);
  }),
);

router.get(
  '/trips',
  asyncHandler(async (req, res) => {
    const listQuery = parseListQuery(req.query as Record<string, unknown>);
    const { rows, total } = await searchTrips({
      originCity: typeof req.query.origin === 'string' ? req.query.origin : undefined,
      destinationCity: typeof req.query.destination === 'string' ? req.query.destination : undefined,
      date: typeof req.query.date === 'string' ? req.query.date : undefined,
      companyId: req.query.company_id ? Number(req.query.company_id) : undefined,
      minPrice: req.query.min_price ? Number(req.query.min_price) : undefined,
      maxPrice: req.query.max_price ? Number(req.query.max_price) : undefined,
      page: listQuery.page,
      limit: listQuery.limit,
      offset: listQuery.offset,
    });
    sendList(res, rows, buildPagination(total, listQuery.page, listQuery.limit));
  }),
);

/**
 * Búsqueda de itinerarios de varios tramos (ida y vuelta / multidestino).
 *
 * Es POST porque el cuerpo es una lista de tramos, no un puñado de parámetros sueltos.
 * La búsqueda de IDA sigue siendo `GET /public/trips` y no ha cambiado.
 * Reutiliza la misma consulta pública, así que la visibilidad es idéntica: solo viajes
 * futuros de empresas y rutas activas.
 */
router.post(
  '/itineraries/search',
  validate(searchItinerarySchema),
  asyncHandler(async (req, res) => {
    const listQuery = parseListQuery(req.query as Record<string, unknown>);
    sendSuccess(res, await searchItinerary(req.body as never, listQuery.limit));
  }),
);

router.get(
  '/trips/:id',
  asyncHandler(async (req, res) => {
    const trip = await findPublicTrip(parseId(req.params.id));
    if (!trip) throw ApiError.notFound('Viaje no encontrado');

    const stops = await query(
      `SELECT rs.stop_order, rs.arrival_offset_minutes, rs.departure_offset_minutes, l.name, l.city
       FROM route_stops rs JOIN locations l ON l.id = rs.location_id
       WHERE rs.route_id = ? ORDER BY rs.stop_order ASC`,
      [trip.route_id],
    );
    sendSuccess(res, { ...trip, stops });
  }),
);

router.get(
  '/trips/:id/seats',
  asyncHandler(async (req, res) => {
    const tripId = parseId(req.params.id);
    const trip = await findPublicTrip(tripId);
    if (!trip) throw ApiError.notFound('Viaje no encontrado');
    sendSuccess(res, await seatMap(tripId));
  }),
);

router.get(
  '/destinations',
  asyncHandler(async (_req, res) => {
    const destinations = await query(
      `SELECT dl.city AS city, dl.department, MIN(t.base_price) AS min_price, COUNT(DISTINCT t.id) AS trips
       FROM trips t
       JOIN routes r ON r.id = t.route_id
       JOIN locations dl ON dl.id = r.destination_location_id
       JOIN companies co ON co.id = r.company_id
       WHERE t.status = 'SCHEDULED' AND t.departure_datetime >= NOW() AND co.status = 'ACTIVE'
       GROUP BY dl.city, dl.department ORDER BY trips DESC LIMIT 12`,
    );
    sendSuccess(res, destinations);
  }),
);

router.get(
  '/promotions',
  asyncHandler(async (_req, res) => {
    const promotions = await query(
      `SELECT p.id, p.name, p.description, p.discount_type, p.discount_value, p.minimum_amount, p.end_at,
              co.name AS company_name
       FROM promotions p LEFT JOIN companies co ON co.id = p.company_id
       WHERE p.status = 'ACTIVE' AND p.start_at <= NOW() AND p.end_at >= NOW()
       ORDER BY p.end_at ASC LIMIT 12`,
    );
    sendSuccess(res, promotions);
  }),
);

router.get(
  '/reviews',
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const reviews = await query(
      `SELECT rv.id, rv.rating, rv.title, rv.comment, rv.created_at,
              u.first_name, u.avatar_url, co.name AS company_name
       FROM reviews rv
       JOIN users u ON u.id = rv.user_id
       JOIN companies co ON co.id = rv.company_id
       WHERE rv.status = 'PUBLISHED'${companyId ? ' AND rv.company_id = ?' : ''}
       ORDER BY rv.created_at DESC LIMIT 12`,
      companyId ? [companyId] : [],
    );
    sendSuccess(res, reviews);
  }),
);

/** Only settings explicitly flagged is_public are exposed here. */
router.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    // Misma interpretación que usan los servicios: una sola lectura de la configuración.
    sendSuccess(res, await readPublicSettings());
  }),
);

router.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const stats = await queryOne(
      `SELECT
        (SELECT COUNT(*) FROM companies WHERE status = 'ACTIVE') AS companies,
        (SELECT COUNT(*) FROM routes WHERE status = 'ACTIVE') AS routes,
        (SELECT COUNT(*) FROM bookings WHERE status IN ('CONFIRMED','COMPLETED')) AS bookings,
        (SELECT COUNT(*) FROM locations WHERE status = 'ACTIVE' AND type = 'TERMINAL') AS terminals`,
    );
    sendSuccess(res, stats);
  }),
);

export default router;
