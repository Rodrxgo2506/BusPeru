import { Router, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { validate } from '../middleware/validate.middleware';
import { searchItinerarySchema } from '../validators/itinerary.validators';
import { query, queryOne } from '../config/database';
import { optionalAuthenticate } from '../middleware/auth.middleware';
import { searchItinerary } from '../services/itinerary.service';
import { findPublicDestination, listPublicDestinations, readBranding } from '../services/destination-content.service';
import { readPublicFile } from '../services/file-storage.service';
import { readPublicSettings } from '../services/settings.service';
import { findPublicTrip, getTripLayout, searchTrips, seatMap } from '../services/trip.service';
import { publicGallery, publicProfile, publicReviews, publicSlugs } from '../services/company-profile.service';
import { createComplaint, legalInfo, lookupComplaint } from '../services/complaint-book.service';
import { createComplaintSchema, lookupComplaintSchema } from '../validators/company-profile.validators';
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
    const companies = await query<Record<string, unknown> & { id: number }>(
      `SELECT co.id, co.name, co.logo_url, co.description,
              (SELECT ROUND(AVG(rv.rating), 1) FROM reviews rv WHERE rv.company_id = co.id AND rv.status = 'PUBLISHED') AS rating,
              (SELECT COUNT(*) FROM reviews rv WHERE rv.company_id = co.id AND rv.status = 'PUBLISHED') AS reviews_count,
              (SELECT COUNT(*) FROM routes r WHERE r.company_id = co.id AND r.status = 'ACTIVE') AS routes_count,
              -- F18-19D · fecha de la PRÓXIMA salida visible en la búsqueda pública (mismas condiciones que
              -- searchTrips): «Ver viajes» abre el buscador en esa fecha, no en un día sin salidas.
              (SELECT DATE_FORMAT(MIN(t.departure_datetime), '%Y-%m-%d')
                 FROM trips t JOIN routes r ON r.id = t.route_id JOIN buses b ON b.id = t.bus_id
                WHERE r.company_id = co.id AND r.status = 'ACTIVE'
                  AND t.status IN ('SCHEDULED', 'BOARDING', 'DELAYED') AND t.departure_datetime >= NOW()) AS next_departure_date
       FROM companies co WHERE co.status = 'ACTIVE' ORDER BY co.name ASC`,
    );
    // F18-19 · solo las empresas con perfil publicado tienen URL propia (/empresas/<slug>).
    const slugs = await publicSlugs();
    sendSuccess(
      res,
      companies.map((company) => ({ ...company, slug: slugs.get(Number(company.id))?.slug ?? null, tagline: slugs.get(Number(company.id))?.tagline ?? null })),
    );
  }),
);

/** F18-19 · perfil público de una empresa: solo contenido APROBADO y visible. Sin perfil publicado → 404. */
router.get(
  '/companies/:slug',
  asyncHandler(async (req, res) => {
    sendSuccess(res, await publicProfile(String(req.params.slug)));
  }),
);

router.get(
  '/companies/:slug/gallery',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const { rows, total, limit } = await publicGallery(String(req.params.slug), page);
    sendList(res, rows, buildPagination(total, page, limit));
  }),
);

router.get(
  '/companies/:slug/reviews',
  asyncHandler(async (req, res) => {
    const listQuery = parseListQuery(req.query as Record<string, unknown>);
    const limit = Math.min(listQuery.limit, 20);
    const { rows, total } = await publicReviews(String(req.params.slug), listQuery.page, limit);
    sendList(res, rows, buildPagination(total, listQuery.page, limit));
  }),
);

/** Datos del proveedor para el Libro de Reclamaciones y los textos legales (null = PENDIENTE). */
router.get(
  '/legal',
  asyncHandler(async (_req, res) => {
    sendSuccess(res, await legalInfo());
  }),
);

/**
 * F18-19 · Libro de Reclamaciones virtual. Público (con o sin sesión) y con su propio límite de peticiones:
 * cada hoja genera un correlativo y un correo, así que no se deja inundar.
 */
const complaintLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.rateLimit.auth,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Demasiadas solicitudes. Vuelve a intentarlo en unos minutos.' },
});

router.post(
  '/complaints',
  complaintLimiter,
  validate(createComplaintSchema),
  asyncHandler(async (req, res) => {
    sendSuccess(res, await createComplaint(req, req.body), 201);
  }),
);

router.post(
  '/complaints/lookup',
  complaintLimiter,
  validate(lookupComplaintSchema),
  asyncHandler(async (req, res) => {
    sendSuccess(res, await lookupComplaint(req.body.code, req.body.document_number));
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

/**
 * Geometría del bus del viaje: pisos, rejilla y elementos físicos. Hermano del anterior y
 * deliberadamente separado: aquel dice qué asientos hay y a qué precio, este qué forma tiene
 * el vehículo. El identificador del layout no se acepta por parámetro; sale del viaje.
 */
router.get(
  '/trips/:id/layout',
  asyncHandler(async (req, res) => {
    const tripId = parseId(req.params.id);
    const trip = await findPublicTrip(tripId);
    if (!trip) throw ApiError.notFound('Viaje no encontrado');
    sendSuccess(res, await getTripLayout(tripId));
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

/**
 * FASE 17 · «Descubre más destinos»: fichas editoriales ACTIVE, en el orden que fija el ADMIN.
 * Distinto de `/destinations`, que sigue calculando los destinos con viajes programados.
 */
router.get(
  '/featured-destinations',
  asyncHandler(async (_req, res) => {
    sendSuccess(res, await listPublicDestinations());
  }),
);

/** Ficha pública de un destino por slug, con sus atractivos y festividades ACTIVE. */
router.get(
  '/destinations/:slug',
  asyncHandler(async (req, res) => {
    sendSuccess(res, await findPublicDestination(String(req.params.slug)));
  }),
);

/** Referencias de identidad visual. Solo referencias públicas; nunca otra configuración. */
router.get(
  '/branding',
  asyncHandler(async (_req, res) => {
    sendSuccess(res, await readBranding());
  }),
);

/**
 * Entrega una imagen pública del almacén. Solo referencias con la forma exacta de `public/...`
 * (ver `readPublicFile`): cualquier otra cosa —incluidos los documentos privados— es un 404.
 *
 * `Cross-Origin-Resource-Policy: cross-origin` porque el frontend puede vivir en otro origen que
 * la API; helmet pone `same-origin` por defecto y el navegador bloquearía las imágenes.
 */
function sendPublicImage(res: Response, reference: string, cacheControl: string): void {
  const file = readPublicFile(reference);
  res.setHeader('Content-Type', file.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Cache-Control', cacheControl);
  res.end(file.buffer);
}

router.get(
  /^\/media\/(.+)$/,
  asyncHandler(async (req, res) => {
    // El nombre es aleatorio y no se reutiliza: el contenido de una URL no cambia nunca.
    sendPublicImage(res, String((req.params as Record<string, string>)[0] ?? ''), 'public, max-age=31536000, immutable');
  }),
);

/**
 * Favicon vigente en una URL estable, para `index.html`: cambiarlo desde el panel no obliga a
 * reconstruir el frontend. Caché corta, precisamente porque la URL no cambia.
 *
 * SIN FAVICON CONFIGURADO devuelve 204, no 404 (F17C-BRAND-01). Antes el 404 salía por el manejador
 * de errores, que responde JSON y no pone `Cross-Origin-Resource-Policy`, así que se aplicaba el
 * `same-origin` que Helmet fija por defecto y el navegador bloqueaba la respuesta con
 * `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` en CADA carga de página. Un 204 dice «aquí no hay icono»
 * sin ser un fallo, y la cabecera se fija SOLO en esta respuesta: nada global cambia.
 */
router.get(
  '/branding/favicon',
  asyncHandler(async (_req, res) => {
    const { favicon } = await readBranding();
    if (!favicon) {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      // Sin caducidad larga: en cuanto el ADMIN suba un favicon, la misma URL debe servirlo.
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.status(204).end();
      return;
    }
    sendPublicImage(res, favicon, 'public, max-age=300');
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
