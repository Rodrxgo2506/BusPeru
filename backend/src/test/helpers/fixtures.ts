import { execute, query, queryOne } from '../../config/database';
import { hashPassword } from '../../utils/security';
import { SELLABLE_SEAT_COUNT_SQL } from '../../services/bus-layout.service';
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
  /** Version publicada de cada bus (migracion 010). Los viajes quedan anclados a ella. */
  layoutA: number;
  layoutB: number;
  deckA: number;
  deckB: number;
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

/**
 * Version publicada de un bus, con un piso. Es lo minimo que el modelo 010 exige para que
 * un bus sea utilizable: los asientos cuelgan del piso, y el viaje se ancla a la version.
 *
 * `uq_layout_published_bus` solo admite UNA version PUBLISHED por bus, asi que un segundo
 * `createBusLayout` sobre el mismo bus debe pedirse en DRAFT.
 */
export async function createBusLayout(
  busId: number,
  options: { version?: number; status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'; decks?: number; rows?: number; columns?: number } = {},
): Promise<{ layoutId: number; deckIds: number[] }> {
  const { version = 1, status = 'PUBLISHED', decks = 1, rows = 0, columns = 4 } = options;
  const layout = await execute(
    `INSERT INTO bus_layouts (bus_id, version, status, name, seat_count, published_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
    [busId, version, status, `Version ${version}`, status === 'PUBLISHED' ? new Date() : null],
  );
  const deckIds: number[] = [];
  for (let numero = 1; numero <= decks; numero += 1) {
    const deck = await execute(
      'INSERT INTO bus_layout_decks (layout_id, deck_number, name, row_count, column_count) VALUES (?, ?, ?, ?, ?)',
      [layout.insertId, numero, `Piso ${numero}`, rows, columns],
    );
    deckIds.push(deck.insertId);
  }
  return { layoutId: layout.insertId, deckIds };
}

/**
 * Elemento fisico que NO es un asiento: bano, escalera, conductor, puerta o hueco.
 *
 * Vive en el piso y jamas en `seats`, de modo que no cuenta como pasajero, no entra en la
 * capacidad y no puede aparecer en el mapa de asientos.
 */
export async function createLayoutElement(
  deckId: number,
  elementType: 'BATHROOM' | 'STAIRS' | 'DRIVER' | 'DOOR' | 'EMPTY',
  row: number,
  column: number,
  label: string | null = null,
): Promise<number> {
  const result = await execute(
    'INSERT INTO bus_layout_elements (deck_id, element_type, `row_number`, column_number, label) VALUES (?, ?, ?, ?, ?)',
    [deckId, elementType, row, column, label],
  );
  return result.insertId;
}

/** Precio de un tipo de asiento para un viaje concreto. Sin fila, rige `trips.base_price`. */
export async function setSeatTypePrice(tripId: number, seatTypeId: number, price: number): Promise<number> {
  const result = await execute(
    'INSERT INTO trip_seat_type_prices (trip_id, seat_type_id, price) VALUES (?, ?, ?)',
    [tripId, seatTypeId, price],
  );
  return result.insertId;
}

/**
 * Deja `bus_layouts.seat_count` de acuerdo con los asientos VENDIBLES de la version, con la
 * misma definicion que usa la aplicacion (`SELLABLE_SEAT_COUNT_SQL`, hallazgo H-15).
 */
export async function syncLayoutSeatCount(layoutId: number): Promise<void> {
  await execute(`UPDATE bus_layouts SET seat_count = (${SELLABLE_SEAT_COUNT_SQL}) WHERE id = ?`, [layoutId, layoutId]);
}

async function createSeats(
  busId: number,
  count: number,
  seatTypeId: number | null,
  layoutId: number,
  deckId: number,
): Promise<number[]> {
  const ids: number[] = [];
  for (let index = 1; index <= count; index += 1) {
    const result = await execute(
      `INSERT INTO seats (bus_id, layout_id, deck_id, seat_type_id, seat_number, \`row_number\`, column_number, is_window, is_aisle, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE')`,
      [
        busId,
        layoutId,
        deckId,
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
    ['platform.default_commission', '10.00', 'DECIMAL', 0],
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

  // Version publicada de cada bus (modelo 010). Sin ella los asientos no tendrian donde
  // colgar y el viaje no tendria version que congelar.
  const { layoutId: layoutA, deckIds: decksA } = await createBusLayout(busA, { rows: 3, columns: 4 });
  const { layoutId: layoutB, deckIds: decksB } = await createBusLayout(busB, { rows: 2, columns: 4 });
  const deckA = at(decksA, 0);
  const deckB = at(decksB, 0);

  const seatsA = await createSeats(busA, 12, seatType.insertId, layoutA, deckA);
  const seatsB = await createSeats(busB, 8, seatType.insertId, layoutB, deckB);
  await syncLayoutSeatCount(layoutA);
  await syncLayoutSeatCount(layoutB);
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
    "INSERT INTO trips (route_id, bus_id, bus_layout_id, departure_datetime, arrival_datetime, base_price, available_seats, status) VALUES (?, ?, ?, ?, ?, 45.00, 12, 'SCHEDULED')",
    [routeA, busA, layoutA, futureDate(3, 20), futureDate(4, 6)],
  )).insertId;
  const tripB = (await execute(
    "INSERT INTO trips (route_id, bus_id, bus_layout_id, departure_datetime, arrival_datetime, base_price, available_seats, status) VALUES (?, ?, ?, ?, ?, 50.00, 8, 'SCHEDULED')",
    [routeB, busB, layoutB, futureDate(4, 8), futureDate(4, 16)],
  )).insertId;

  // Un segundo viaje de la empresa A para pruebas de listados y reportes.
  await execute(
    "INSERT INTO trips (route_id, bus_id, bus_layout_id, departure_datetime, arrival_datetime, base_price, available_seats, status) VALUES (?, ?, ?, ?, ?, 45.00, 12, 'SCHEDULED')",
    [routeA, busA, layoutA, futureDate(5, 20), futureDate(6, 6)],
  );

  return { companyA, companyB, users, busA, busB, routeA, routeB, tripA, tripB, seatsA, seatsB, locations, layoutA, layoutB, deckA, deckB };
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
     FROM trips t
     JOIN bus_layouts bl ON bl.id = COALESCE(t.bus_layout_id, (SELECT bl2.id FROM bus_layouts bl2 WHERE bl2.bus_id = t.bus_id AND bl2.status = 'PUBLISHED' LIMIT 1))
     JOIN seats s ON s.layout_id = bl.id
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
