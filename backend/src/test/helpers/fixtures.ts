import { execute, query, queryOne } from '../../config/database';
import { hashPassword } from '../../utils/security';
import { post } from './api';

/**
 * Datos deterministas para la suite: dos empresas con flota y viajes propios, y un usuario
 * por cada rol. Se reconstruyen antes de cada archivo de test, de modo que ningún test
 * dependa del resultado de otro.
 */

export const TEST_PASSWORD = 'PruebaSegura1';

export interface Fixtures {
  companyA: number;
  companyB: number;
  users: { admin: number; companyAdmin: number; operator: number; customer: number; companyAdminB: number };
  busA: number;
  busB: number;
  routeA: number;
  routeB: number;
  tripA: number;
  tripB: number;
  seatsA: number[];
  seatsB: number[];
  locations: number[];
}

async function roleId(name: string): Promise<number> {
  const row = await queryOne<{ id: number }>('SELECT id FROM roles WHERE name = ?', [name]);
  if (!row) throw new Error(`Falta el rol ${name} en la base de pruebas`);
  return row.id;
}

async function createUser(role: string, email: string, firstName: string, hash: string): Promise<number> {
  const result = await execute(
    `INSERT INTO users (role_id, first_name, last_name, email, phone, password_hash, status, email_verified_at)
     VALUES (?, ?, 'Prueba', ?, '999999999', ?, 'ACTIVE', NOW())`,
    [await roleId(role), firstName, email, hash],
  );
  return result.insertId;
}

async function createSeats(busId: number, count: number, seatTypeId: number | null): Promise<number[]> {
  const ids: number[] = [];
  for (let index = 1; index <= count; index += 1) {
    const result = await execute(
      `INSERT INTO seats (bus_id, seat_type_id, seat_number, row_number, column_number, is_window, is_aisle, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'AVAILABLE')`,
      [
        busId,
        seatTypeId,
        String(index).padStart(2, '0'),
        Math.ceil(index / 4),
        ((index - 1) % 4) + 1,
        (index - 1) % 4 === 0 || index % 4 === 0 ? 1 : 0,
        (index - 1) % 4 === 1 || (index - 1) % 4 === 2 ? 1 : 0,
      ],
    );
    ids.push(result.insertId);
  }
  return ids;
}

function futureDate(daysAhead: number, hour: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export async function seedFixtures(): Promise<Fixtures> {
  const hash = await hashPassword(TEST_PASSWORD);

  const settings: Array<[string, string, string, number]> = [
    ['booking.service_fee', '2.50', 'DECIMAL', 1],
    ['booking.max_seats_per_booking', '6', 'INTEGER', 1],
    ['booking.hold_minutes', '15', 'INTEGER', 0],
    ['site.name', 'BusPerú', 'STRING', 1],
  ];
  for (const [key, value, type, isPublic] of settings) {
    await execute(
      'INSERT INTO system_settings (setting_key, setting_value, setting_type, is_public) VALUES (?, ?, ?, ?)',
      [key, value, type, isPublic],
    );
  }

  const busType = await execute("INSERT INTO bus_types (name, description, default_capacity, status) VALUES ('Cama 160°', 'Prueba', 40, 'ACTIVE')", []);
  const seatType = await execute("INSERT INTO seat_types (name, description) VALUES ('Cama 160°', 'Prueba')", []);
  const womanSeatType = await execute("INSERT INTO seat_types (name, description) VALUES ('Mujer', 'Prueba')", []);

  const locations: number[] = [];
  for (const [name, city] of [
    ['Terminal Plaza Norte', 'Lima'],
    ['Terminal Huánuco', 'Huánuco'],
    ['Terminal Huaraz', 'Huaraz'],
  ] as const) {
    const result = await execute(
      "INSERT INTO locations (name, city, department, country_code, type, status) VALUES (?, ?, ?, 'PE', 'TERMINAL', 'ACTIVE')",
      [name, city, city],
    );
    locations.push(result.insertId);
  }

  const companyA = (await execute(
    "INSERT INTO companies (name, legal_name, tax_id, email, status) VALUES ('Empresa A', 'Empresa A SAC', '20111111111', 'a@test.pe', 'ACTIVE')",
  )).insertId;
  const companyB = (await execute(
    "INSERT INTO companies (name, legal_name, tax_id, email, status) VALUES ('Empresa B', 'Empresa B SAC', '20222222222', 'b@test.pe', 'ACTIVE')",
  )).insertId;

  for (const company of [companyA, companyB]) {
    await execute(
      "INSERT INTO company_commission_settings (company_id, commission_type, commission_value, effective_from, status) VALUES (?, 'PERCENTAGE', 10.00, NOW(), 'ACTIVE')",
      [company],
    );
  }

  const users = {
    admin: await createUser('ADMIN', 'admin@test.pe', 'Admin', hash),
    companyAdmin: await createUser('COMPANY_ADMIN', 'empresa-a@test.pe', 'Ana', hash),
    operator: await createUser('OPERATOR', 'operador-a@test.pe', 'Otto', hash),
    customer: await createUser('CUSTOMER', 'cliente@test.pe', 'Clara', hash),
    companyAdminB: await createUser('COMPANY_ADMIN', 'empresa-b@test.pe', 'Beto', hash),
  };

  await execute('INSERT INTO company_users (company_id, user_id, position) VALUES (?, ?, ?)', [companyA, users.companyAdmin, 'Admin']);
  await execute('INSERT INTO company_users (company_id, user_id, position) VALUES (?, ?, ?)', [companyA, users.operator, 'Operaciones']);
  await execute('INSERT INTO company_users (company_id, user_id, position) VALUES (?, ?, ?)', [companyB, users.companyAdminB, 'Admin']);

  const busA = (await execute(
    "INSERT INTO buses (company_id, bus_type_id, code, plate_number, brand, model, year, capacity, amenities, status) VALUES (?, ?, 'A-001', 'AAA-111', 'Marca', 'Modelo', 2023, 12, ?, 'ACTIVE')",
    [companyA, busType.insertId, JSON.stringify(['WiFi', 'USB'])],
  )).insertId;
  const busB = (await execute(
    "INSERT INTO buses (company_id, bus_type_id, code, plate_number, brand, model, year, capacity, amenities, status) VALUES (?, ?, 'B-001', 'BBB-222', 'Marca', 'Modelo', 2022, 8, ?, 'ACTIVE')",
    [companyB, busType.insertId, JSON.stringify(['WiFi'])],
  )).insertId;

  const seatsA = await createSeats(busA, 12, seatType.insertId);
  const seatsB = await createSeats(busB, 8, seatType.insertId);
  // Un asiento con categoría distinta para comprobar el mapa de asientos.
  await execute('UPDATE seats SET seat_type_id = ? WHERE id = ?', [womanSeatType.insertId, seatsA[11]]);

  const routeA = (await execute(
    "INSERT INTO routes (company_id, origin_location_id, destination_location_id, name, distance_km, estimated_duration_minutes, status) VALUES (?, ?, ?, 'Lima - Huánuco', 398, 510, 'ACTIVE')",
    [companyA, locations[0], locations[1]],
  )).insertId;
  const routeB = (await execute(
    "INSERT INTO routes (company_id, origin_location_id, destination_location_id, name, distance_km, estimated_duration_minutes, status) VALUES (?, ?, ?, 'Lima - Huaraz', 309, 450, 'ACTIVE')",
    [companyB, locations[0], locations[2]],
  )).insertId;

  const tripA = (await execute(
    "INSERT INTO trips (route_id, bus_id, departure_datetime, arrival_datetime, base_price, available_seats, status) VALUES (?, ?, ?, ?, 45.00, 12, 'SCHEDULED')",
    [routeA, busA, futureDate(3, 20), futureDate(4, 6)],
  )).insertId;
  const tripB = (await execute(
    "INSERT INTO trips (route_id, bus_id, departure_datetime, arrival_datetime, base_price, available_seats, status) VALUES (?, ?, ?, ?, 50.00, 8, 'SCHEDULED')",
    [routeB, busB, futureDate(4, 8), futureDate(4, 16)],
  )).insertId;

  // Un segundo viaje de la empresa A para pruebas de listados y reportes.
  await execute(
    "INSERT INTO trips (route_id, bus_id, departure_datetime, arrival_datetime, base_price, available_seats, status) VALUES (?, ?, ?, ?, 45.00, 12, 'SCHEDULED')",
    [routeA, busA, futureDate(5, 20), futureDate(6, 6)],
  );

  return { companyA, companyB, users, busA, busB, routeA, routeB, tripA, tripB, seatsA, seatsB, locations };
}

export interface Session {
  token: string;
  user: { id: number; role: string; permissions: string[]; companyIds: number[] };
}

export async function login(email: string): Promise<Session> {
  const response = await post('/auth/login', { email, password: TEST_PASSWORD });
  if (response.status !== 200) {
    throw new Error(`No se pudo iniciar sesión con ${email}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.data as Session;
}

export async function loginAll() {
  return {
    admin: await login('admin@test.pe'),
    companyAdmin: await login('empresa-a@test.pe'),
    operator: await login('operador-a@test.pe'),
    customer: await login('cliente@test.pe'),
    companyAdminB: await login('empresa-b@test.pe'),
  };
}

/** Asientos libres de un viaje, en orden estable. */
export async function freeSeats(tripId: number): Promise<Array<{ id: number; seat_number: string }>> {
  return query<{ id: number; seat_number: string }>(
    `SELECT s.id, s.seat_number
     FROM trips t JOIN buses b ON b.id = t.bus_id JOIN seats s ON s.bus_id = b.id
     WHERE t.id = ? AND s.status = 'AVAILABLE'
       AND NOT EXISTS (
         SELECT 1 FROM booking_seats bs JOIN bookings bk ON bk.id = bs.booking_id
         WHERE bs.trip_id = t.id AND bs.seat_id = s.id
           AND (bk.status IN ('CONFIRMED','COMPLETED') OR (bk.status = 'PENDING' AND (bk.expires_at IS NULL OR bk.expires_at > NOW())))
       )
     ORDER BY s.id ASC`,
    [tripId],
  );
}

/** Acceso a un elemento obligatorio de un array; falla claro si el dato no existe. */
export function at<T>(items: T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`Se esperaba un elemento en la posición ${index} y no existe`);
  return value;
}
