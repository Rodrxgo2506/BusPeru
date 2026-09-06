import { query, queryOne } from '../config/database';
import type { AuthenticatedUser } from '../types/entities';
import { ApiError } from '../utils/ApiError';

export interface SeatAvailability {
  id: number;
  seat_number: string;
  row_number: number | null;
  column_number: number | null;
  is_window: 0 | 1;
  is_aisle: 0 | 1;
  status: 'AVAILABLE' | 'INACTIVE';
  seat_type_name: string | null;
  is_taken: 0 | 1;
}

/** Company id that owns a trip, resolved through routes. */
export async function tripCompanyId(tripId: number): Promise<number | null> {
  const row = await queryOne<{ company_id: number }>(
    'SELECT r.company_id FROM trips t JOIN routes r ON r.id = t.route_id WHERE t.id = ? LIMIT 1',
    [tripId],
  );
  return row?.company_id ?? null;
}

export async function assertTripBelongsToUser(tripId: number, user: AuthenticatedUser): Promise<void> {
  if (user.role === 'ADMIN') return;
  const companyId = await tripCompanyId(tripId);
  // Se responde 404, no 403: un 403 confirmaría que el viaje existe y permitiría
  // enumerar la operación de otras empresas. El resto de recursos ya responde 404.
  if (companyId === null || !user.companyIds.includes(companyId)) throw ApiError.notFound('Viaje no encontrado');
}

/**
 * Seat map for a trip. A seat counts as taken when it belongs to a booking that is
 * still holding it (PENDING within its expiry window, CONFIRMED or COMPLETED).
 */
export async function seatMap(tripId: number): Promise<SeatAvailability[]> {
  return query<SeatAvailability>(
    `SELECT s.id, s.seat_number, s.row_number, s.column_number, s.is_window, s.is_aisle, s.status,
            st.name AS seat_type_name,
            EXISTS (
              SELECT 1 FROM booking_seats bs
              JOIN bookings bk ON bk.id = bs.booking_id
              WHERE bs.trip_id = ? AND bs.seat_id = s.id
                AND (bk.status IN ('CONFIRMED', 'COMPLETED')
                     OR (bk.status = 'PENDING' AND (bk.expires_at IS NULL OR bk.expires_at > NOW())))
            ) AS is_taken
     FROM trips t
     JOIN buses b ON b.id = t.bus_id
     JOIN seats s ON s.bus_id = b.id
     LEFT JOIN seat_types st ON st.id = s.seat_type_id
     WHERE t.id = ?
     ORDER BY s.row_number ASC, s.column_number ASC, s.seat_number ASC`,
    [tripId, tripId],
  );
}

export interface TripSearchParams {
  originCity?: string;
  destinationCity?: string;
  date?: string;
  companyId?: number;
  minPrice?: number;
  maxPrice?: number;
  page: number;
  limit: number;
  offset: number;
}

const SEARCH_SELECT = `SELECT t.id, t.departure_datetime, t.arrival_datetime, t.base_price, t.status,
    t.available_seats, t.boarding_notes,
    r.id AS route_id, r.distance_km, r.estimated_duration_minutes,
    ol.city AS origin_city, ol.name AS origin_terminal,
    dl.city AS destination_city, dl.name AS destination_terminal,
    co.id AS company_id, co.name AS company_name, co.logo_url AS company_logo,
    b.id AS bus_id, b.capacity, b.amenities, bt.name AS bus_type_name,
    (SELECT ROUND(AVG(rv.rating), 1) FROM reviews rv WHERE rv.company_id = co.id AND rv.status = 'PUBLISHED') AS company_rating,
    (SELECT COUNT(*) FROM reviews rv WHERE rv.company_id = co.id AND rv.status = 'PUBLISHED') AS company_reviews,
    (b.capacity - (
      SELECT COUNT(*) FROM booking_seats bs
      JOIN bookings bk ON bk.id = bs.booking_id
      WHERE bs.trip_id = t.id AND (bk.status IN ('CONFIRMED', 'COMPLETED')
        OR (bk.status = 'PENDING' AND (bk.expires_at IS NULL OR bk.expires_at > NOW())))
    )) AS seats_available
  FROM trips t
  JOIN routes r ON r.id = t.route_id
  JOIN locations ol ON ol.id = r.origin_location_id
  JOIN locations dl ON dl.id = r.destination_location_id
  JOIN companies co ON co.id = r.company_id
  JOIN buses b ON b.id = t.bus_id
  LEFT JOIN bus_types bt ON bt.id = b.bus_type_id`;

/** Public trip search: only scheduled future trips of ACTIVE companies are visible. */
export async function searchTrips(params: TripSearchParams): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const conditions = [
    "t.status IN ('SCHEDULED', 'BOARDING', 'DELAYED')",
    "co.status = 'ACTIVE'",
    "r.status = 'ACTIVE'",
    't.departure_datetime >= NOW()',
  ];
  const values: unknown[] = [];

  if (params.originCity) {
    conditions.push('ol.city = ?');
    values.push(params.originCity);
  }
  if (params.destinationCity) {
    conditions.push('dl.city = ?');
    values.push(params.destinationCity);
  }
  if (params.date) {
    conditions.push('DATE(t.departure_datetime) = ?');
    values.push(params.date);
  }
  if (params.companyId) {
    conditions.push('co.id = ?');
    values.push(params.companyId);
  }
  if (params.minPrice !== undefined) {
    conditions.push('t.base_price >= ?');
    values.push(params.minPrice);
  }
  if (params.maxPrice !== undefined) {
    conditions.push('t.base_price <= ?');
    values.push(params.maxPrice);
  }

  const where = ` WHERE ${conditions.join(' AND ')}`;
  const countRow = await queryOne<{ total: number }>(
    `SELECT COUNT(*) AS total FROM trips t
     JOIN routes r ON r.id = t.route_id
     JOIN locations ol ON ol.id = r.origin_location_id
     JOIN locations dl ON dl.id = r.destination_location_id
     JOIN companies co ON co.id = r.company_id${where}`,
    values,
  );

  const rows = await query<Record<string, unknown>>(
    `${SEARCH_SELECT}${where} ORDER BY t.departure_datetime ASC LIMIT ? OFFSET ?`,
    [...values, params.limit, params.offset],
  );

  return { rows, total: Number(countRow?.total ?? 0) };
}

export async function findPublicTrip(tripId: number): Promise<Record<string, unknown> | null> {
  return queryOne<Record<string, unknown>>(`${SEARCH_SELECT} WHERE t.id = ? LIMIT 1`, [tripId]);
}
