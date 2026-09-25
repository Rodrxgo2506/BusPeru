/**
 * Development seed. It never drops or truncates anything and skips rows that already
 * exist, so it can be run repeatedly. Refuses to run with NODE_ENV=production.
 */
import { execute, pool, query, queryOne } from '../config/database';
import { env } from '../config/env';
import { SELLABLE_SEAT_COUNT_SQL } from '../services/bus-layout.service';
import { ensureCompanyCommission } from '../services/company-commission.service';
import { hashPassword } from '../utils/security';

const DEMO_PASSWORD = 'BusPeru2026';

async function upsert<T extends Record<string, unknown>>(
  table: string,
  uniqueWhere: string,
  uniqueParams: unknown[],
  data: T,
): Promise<number> {
  const existing = await queryOne<{ id: number }>(`SELECT id FROM ${table} WHERE ${uniqueWhere} LIMIT 1`, uniqueParams);
  if (existing) return existing.id;

  const columns = Object.keys(data);
  const result = await execute(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((column) => data[column]),
  );
  return result.insertId;
}

async function roleId(name: string): Promise<number> {
  const role = await queryOne<{ id: number }>('SELECT id FROM roles WHERE name = ?', [name]);
  if (!role) throw new Error(`El rol ${name} no existe. Importa Dump20260831.sql primero.`);
  return role.id;
}

async function seedSystemSettings(): Promise<void> {
  const settings: Array<[string, string, string, string, number]> = [
    ['site.name', 'BusPerú', 'STRING', 'Nombre público de la plataforma', 1],
    ['site.currency', 'PEN', 'STRING', 'Moneda utilizada en la plataforma', 1],
    ['site.timezone', 'America/Lima', 'STRING', 'Zona horaria', 1],
    ['site.support_email', 'soporte@busperu.com', 'STRING', 'Correo de soporte', 1],
    ['site.support_phone', '+51 987 654 321', 'STRING', 'Teléfono de soporte', 1],
    ['booking.service_fee', '2.50', 'DECIMAL', 'Cargo por servicio por pasajero', 1],
    ['booking.max_seats_per_booking', '6', 'INTEGER', 'Máximo de asientos por reserva', 1],
    ['booking.hold_minutes', '15', 'INTEGER', 'Minutos que se reservan los asientos antes de pagar', 0],
    ['booking.cancellation_hours', '24', 'INTEGER', 'Horas de anticipación para cancelar con reembolso', 1],
    ['platform.default_commission', '10.00', 'DECIMAL', 'Comisión por defecto de BusPerú (%)', 0],
  ];

  for (const [key, value, type, description, isPublic] of settings) {
    await upsert('system_settings', 'setting_key = ?', [key], {
      setting_key: key,
      setting_value: value,
      setting_type: type,
      description,
      is_public: isPublic,
    });
  }
}

/**
 * FASE 17 · destinos editoriales de DEMOSTRACIÓN. Solo para la base de desarrollo (`*_test`).
 *
 * No se inventan precios, horarios, clima ni datos turísticos: los textos dicen explícitamente
 * que son de demostración y los campos informativos quedan vacíos para que el ADMIN los complete
 * con información verificada desde «Contenido › Destinos».
 */
async function seedDemoDestinations(): Promise<number> {
  const demo: Array<[string, string]> = [
    ['Cajamarca', 'cajamarca'],
    ['Huaraz', 'huaraz'],
    ['Trujillo', 'trujillo'],
    ['La Merced', 'la-merced'],
  ];
  // FASE 17B · la ciudad sale de `locations`, no de texto: solo se asocia si esa ciudad existe.
  const cityLocation = async (city: string): Promise<number | null> => {
    const row = await queryOne<{ id: number }>("SELECT id FROM locations WHERE city = ? AND status = 'ACTIVE' ORDER BY id LIMIT 1", [city]);
    return row?.id ?? null;
  };
  const originId = await cityLocation('Lima');

  for (const [index, [name, slug]] of demo.entries()) {
    const destinationId = await upsert('destinations', 'slug = ?', [slug], {
      name,
      slug,
      subtitle: 'Contenido DEMO',
      description: `Texto de DEMOSTRACIÓN para ${name}. Reemplázalo con información verificada desde el panel de administración (Contenido › Destinos).`,
      price_from: null,
      status: 'ACTIVE',
      display_order: index + 1,
      location_id: await cityLocation(name),
      origin_location_id: originId,
    });
    await upsert('destination_attractions', 'destination_id = ? AND name = ?', [destinationId, 'Atractivo DEMO'], {
      destination_id: destinationId,
      name: 'Atractivo DEMO',
      description: 'Atractivo de demostración. Reemplázalo desde el panel.',
      display_order: 1,
      status: 'ACTIVE',
    });
    await upsert('destination_festivities', 'destination_id = ? AND name = ?', [destinationId, 'Festividad DEMO'], {
      destination_id: destinationId,
      name: 'Festividad DEMO',
      date_label: 'Por definir',
      description: 'Festividad de demostración. Reemplázala desde el panel.',
      display_order: 1,
      status: 'ACTIVE',
    });
  }
  return demo.length;
}

async function seedCatalogues(): Promise<{ busTypeIds: number[]; seatTypeIds: number[] }> {
  const busTypes = [
    ['Cama 160°', 'Asientos reclinables a 160 grados', 42],
    ['Cama 180°', 'Asientos cama full reclinables', 36],
    ['Semi Cama', 'Asientos reclinables a 140 grados', 46],
    ['Ejecutivo', 'Servicio ejecutivo con amenidades', 40],
    ['Económico', 'Servicio estándar', 50],
  ] as const;

  const busTypeIds: number[] = [];
  for (const [name, description, capacity] of busTypes) {
    busTypeIds.push(
      await upsert('bus_types', 'name = ?', [name], { name, description, default_capacity: capacity, status: 'ACTIVE' }),
    );
  }

  const seatTypes = [
    ['Cama 160°', 'Asiento reclinable 160 grados'],
    ['Cama 180°', 'Asiento cama 180 grados'],
    ['Semi Cama', 'Asiento semi cama'],
    ['Preferencial', 'Asiento preferencial para personas con movilidad reducida'],
    ['Mujer', 'Asiento reservado para pasajeras'],
  ] as const;

  const seatTypeIds: number[] = [];
  for (const [name, description] of seatTypes) {
    seatTypeIds.push(await upsert('seat_types', 'name = ?', [name], { name, description }));
  }

  return { busTypeIds, seatTypeIds };
}

async function seedLocations(): Promise<Record<string, number>> {
  const terminals: Array<[string, string, string, string, string]> = [
    ['Terminal Plaza Norte', 'Lima', 'Lima', 'Lima', 'Av. Tomás Valle 3600, Independencia'],
    ['Terminal Javier Prado', 'Lima', 'Lima', 'Lima', 'Av. Javier Prado Este 1109, La Victoria'],
    ['Terminal Atocongo', 'Lima', 'Lima', 'Lima', 'Av. Circunvalación 1803, San Juan de Miraflores'],
    ['Terminal Huánuco', 'Huánuco', 'Huánuco', 'Huánuco', 'Carretera Central Km 3.5, Pillco Marca'],
    ['Terminal Huaraz', 'Huaraz', 'Huaraz', 'Áncash', 'Jr. Mariscal Luzuriaga 650'],
    ['Terminal Tingo María', 'Tingo María', 'Leoncio Prado', 'Huánuco', 'Av. Raymondi 1234'],
    ['Terminal Pucallpa', 'Pucallpa', 'Coronel Portillo', 'Ucayali', 'Jr. Tarapacá 210'],
    ['Terminal Trujillo', 'Trujillo', 'Trujillo', 'La Libertad', 'Av. América Oeste 710'],
    ['Terminal Arequipa', 'Arequipa', 'Arequipa', 'Arequipa', 'Av. Venezuela 508, Cerro Colorado'],
    ['Terminal Cusco', 'Cusco', 'Cusco', 'Cusco', 'Av. de la Cultura 1501, Wanchaq'],
  ];

  const ids: Record<string, number> = {};
  for (const [name, city, province, department, address] of terminals) {
    ids[name] = await upsert('locations', 'name = ? AND city = ?', [name, city], {
      name,
      city,
      province,
      department,
      country_code: 'PE',
      type: 'TERMINAL',
      address,
      status: 'ACTIVE',
    });
  }
  return ids;
}

/**
 * La rejilla de un bus: cuantas columnas tiene el piso y en cuales de ellas hay asiento.
 *
 * Las que faltan son el pasillo. No se calcula partiendo las columnas por la mitad —eso era
 * lo que hacia este seed antes y solo servia para buses de 2+2—: un cama 180° lleva 1+2 y su
 * pasillo no cae en el centro. La rejilla es un DATO del piso desde la migracion 010, asi
 * que aqui se declara.
 */
interface BusLayoutPlan {
  capacity: number;
  columnCount: number;
  seatColumns: number[];
}

/** Un asiento esta junto al pasillo si la columna de al lado no lleva asiento. */
function nextToAisle(column: number, plan: BusLayoutPlan): boolean {
  const anterior = column - 1;
  const siguiente = column + 1;
  const esPasillo = (candidata: number) =>
    candidata >= 1 && candidata <= plan.columnCount && !plan.seatColumns.includes(candidata);
  return esPasillo(anterior) || esPasillo(siguiente);
}

/**
 * Version 1 PUBLICADA del bus, con su piso y sus asientos (migracion 010).
 *
 * Antes esto insertaba asientos sueltos colgados del bus, sin version ni piso. Con el modelo
 * actual eso deja una base inservible: `POST /trips` exige una version publicada, el listado
 * de buses cuenta cero asientos y el editor no puede tocar nada. Cada bus nace ahora con su
 * version, su piso y sus asientos anclados a ambos.
 *
 * Es reejecutable como el resto del seed: si el bus ya tiene alguna version, no se toca.
 */
async function seedPublishedLayout(busId: number, plan: BusLayoutPlan, seatTypeId: number): Promise<number> {
  const existente = await queryOne<{ id: number }>('SELECT id FROM bus_layouts WHERE bus_id = ? LIMIT 1', [busId]);
  if (existente) return existente.id;

  const rows = Math.ceil(plan.capacity / plan.seatColumns.length);

  const layout = await execute(
    `INSERT INTO bus_layouts (bus_id, version, status, name, seat_count, published_at)
     VALUES (?, 1, 'PUBLISHED', 'Versión 1', 0, NOW())`,
    [busId],
  );
  const deck = await execute(
    `INSERT INTO bus_layout_decks (layout_id, deck_number, name, row_count, column_count)
     VALUES (?, 1, 'Piso 1', ?, ?)`,
    [layout.insertId, rows, plan.columnCount],
  );

  let seatNumber = 1;
  for (let row = 1; row <= rows && seatNumber <= plan.capacity; row += 1) {
    for (const column of plan.seatColumns) {
      if (seatNumber > plan.capacity) break;
      await execute(
        `INSERT INTO seats (bus_id, layout_id, deck_id, seat_type_id, seat_number, \`row_number\`, column_number, is_window, is_aisle, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE')`,
        [
          busId,
          layout.insertId,
          deck.insertId,
          seatTypeId,
          String(seatNumber).padStart(2, '0'),
          row,
          column,
          column === 1 || column === plan.columnCount ? 1 : 0,
          nextToAisle(column, plan) ? 1 : 0,
        ],
      );
      seatNumber += 1;
    }
  }

  // `seat_count` y `capacity` salen de los asientos VENDIBLES que de verdad se crearon, no del
  // numero que se pidio: es la misma definicion que aplica `publishLayout`.
  await execute(`UPDATE bus_layouts SET seat_count = (${SELLABLE_SEAT_COUNT_SQL}) WHERE id = ?`, [
    layout.insertId,
    layout.insertId,
  ]);
  await execute('UPDATE buses SET capacity = (SELECT seat_count FROM bus_layouts WHERE id = ?) WHERE id = ?', [
    layout.insertId,
    busId,
  ]);

  return layout.insertId;
}

async function main(): Promise<void> {
  if (env.isProduction) {
    console.error('✖ El seed de desarrollo no puede ejecutarse con NODE_ENV=production.');
    process.exit(1);
  }

  console.log('→ Sembrando datos de desarrollo...');
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  await seedSystemSettings();
  const { busTypeIds, seatTypeIds } = await seedCatalogues();
  const locations = await seedLocations();

  const adminRoleId = await roleId('ADMIN');
  const companyAdminRoleId = await roleId('COMPANY_ADMIN');
  const operatorRoleId = await roleId('OPERATOR');
  const customerRoleId = await roleId('CUSTOMER');

  const adminId = await upsert('users', 'email = ?', ['admin@busperu.com'], {
    role_id: adminRoleId,
    first_name: 'Admin',
    last_name: 'BusPerú',
    email: 'admin@busperu.com',
    phone: '+51 987 654 321',
    password_hash: passwordHash,
    status: 'ACTIVE',
    email_verified_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
  });

  const companies = [
    { name: 'Expreso Andino S.A.C.', tax_id: '20612345678', email: 'contacto@expresoandino.pe' },
    { name: 'Transportes Cruz del Sur S.A.', tax_id: '20123456789', email: 'contacto@cruzdelsur.pe' },
  ];

  const companyIds: number[] = [];
  for (const company of companies) {
    companyIds.push(
      await upsert('companies', 'tax_id = ?', [company.tax_id], {
        name: company.name,
        legal_name: company.name,
        tax_id: company.tax_id,
        email: company.email,
        phone: '+51 1 234 5678',
        description: 'Empresa de transporte interprovincial.',
        status: 'ACTIVE',
      }),
    );
  }
  const [mainCompanyId] = companyIds;
  if (mainCompanyId === undefined) throw new Error('No se pudo crear la empresa de demostración');

  const companyAdminId = await upsert('users', 'email = ?', ['empresa@busperu.com'], {
    role_id: companyAdminRoleId,
    first_name: 'María',
    last_name: 'López',
    email: 'empresa@busperu.com',
    phone: '+51 987 111 222',
    password_hash: passwordHash,
    status: 'ACTIVE',
  });
  const operatorId = await upsert('users', 'email = ?', ['operador@busperu.com'], {
    role_id: operatorRoleId,
    first_name: 'Carlos',
    last_name: 'Ramírez',
    email: 'operador@busperu.com',
    phone: '+51 987 333 444',
    password_hash: passwordHash,
    status: 'ACTIVE',
  });
  const customerId = await upsert('users', 'email = ?', ['cliente@busperu.com'], {
    role_id: customerRoleId,
    first_name: 'Rodrigo',
    last_name: 'Pérez',
    email: 'cliente@busperu.com',
    phone: '+51 987 654 321',
    password_hash: passwordHash,
    status: 'ACTIVE',
  });

  for (const [userId, position] of [
    [companyAdminId, 'Administradora'],
    [operatorId, 'Operaciones'],
  ] as const) {
    const link = await queryOne<{ user_id: number }>('SELECT user_id FROM company_users WHERE company_id = ? AND user_id = ?', [
      mainCompanyId,
      userId,
    ]);
    if (!link) {
      await execute('INSERT INTO company_users (company_id, user_id, position) VALUES (?, ?, ?)', [mainCompanyId, userId, position]);
    }
  }

  // H-46: las empresas sembradas reciben la tasa de `platform.default_commission`, igual que una
  // empresa aprobada; una empresa que ya tenga la suya la conserva.
  for (const companyId of companyIds) {
    await ensureCompanyCommission(companyId);
  }

  /**
   * Los buses de siempre, ahora con la rejilla de su piso declarada.
   *
   * `seatColumns` dice en que columnas hay asiento; las que faltan son el pasillo. El cama
   * 180° va 1+2 con el pasillo en la columna 2, y los otros dos 2+2 con el pasillo en la 3.
   * Las capacidades no cambian: 42, 44 y 40, las mismas de antes.
   */
  const buses = [
    { code: 'EA-001', plate: 'B2X-963', brand: 'Marcopolo', model: 'Paradiso G8 1800 DD', year: 2023, capacity: 42, typeIndex: 0, columnCount: 4, seatColumns: [1, 3, 4] },
    { code: 'EA-002', plate: 'B4V-781', brand: 'Scania', model: 'K410 IB', year: 2022, capacity: 44, typeIndex: 1, columnCount: 5, seatColumns: [1, 2, 4, 5] },
    { code: 'EA-003', plate: 'B7Z-229', brand: 'Mercedes-Benz', model: 'O500 RS', year: 2021, capacity: 40, typeIndex: 2, columnCount: 5, seatColumns: [1, 2, 4, 5] },
  ];

  const busIds: number[] = [];
  /** Version publicada de cada bus, en el mismo orden que `busIds`. */
  const busLayoutIds: number[] = [];
  for (const bus of buses) {
    const busId = await upsert('buses', 'plate_number = ?', [bus.plate], {
      company_id: mainCompanyId,
      bus_type_id: busTypeIds[bus.typeIndex] ?? null,
      code: bus.code,
      plate_number: bus.plate,
      brand: bus.brand,
      model: bus.model,
      year: bus.year,
      capacity: bus.capacity,
      amenities: JSON.stringify(['WiFi', 'Aire acondicionado', 'USB', 'Baño', 'TV']),
      status: 'ACTIVE',
    });
    busIds.push(busId);
    busLayoutIds.push(await seedPublishedLayout(busId, bus, seatTypeIds[bus.typeIndex] ?? seatTypeIds[0]!));
  }

  const routeDefinitions = [
    { origin: 'Terminal Plaza Norte', destination: 'Terminal Huánuco', distance: 398, minutes: 510, price: 45 },
    { origin: 'Terminal Plaza Norte', destination: 'Terminal Huaraz', distance: 309, minutes: 450, price: 50 },
    { origin: 'Terminal Plaza Norte', destination: 'Terminal Tingo María', distance: 528, minutes: 630, price: 55 },
    { origin: 'Terminal Huánuco', destination: 'Terminal Plaza Norte', distance: 398, minutes: 510, price: 45 },
  ];

  const routeIds: number[] = [];
  for (const definition of routeDefinitions) {
    const originId = locations[definition.origin];
    const destinationId = locations[definition.destination];
    if (originId === undefined || destinationId === undefined) continue;

    const routeId = await upsert(
      'routes',
      'company_id = ? AND origin_location_id = ? AND destination_location_id = ?',
      [mainCompanyId, originId, destinationId],
      {
        company_id: mainCompanyId,
        origin_location_id: originId,
        destination_location_id: destinationId,
        name: `${definition.origin} → ${definition.destination}`,
        distance_km: definition.distance,
        estimated_duration_minutes: definition.minutes,
        status: 'ACTIVE',
      },
    );
    routeIds.push(routeId);

    for (const [order, locationId] of [originId, destinationId].entries()) {
      const stop = await queryOne<{ id: number }>('SELECT id FROM route_stops WHERE route_id = ? AND stop_order = ?', [
        routeId,
        order + 1,
      ]);
      if (!stop) {
        await execute(
          `INSERT INTO route_stops (route_id, location_id, stop_order, arrival_offset_minutes, departure_offset_minutes)
           VALUES (?, ?, ?, ?, ?)`,
          [routeId, locationId, order + 1, order === 0 ? 0 : definition.minutes, order === 0 ? 0 : null],
        );
      }
    }

    // Two departures per day for the next 7 days.
    for (let day = 1; day <= 7; day += 1) {
      for (const hour of [8, 20]) {
        const departure = new Date();
        departure.setDate(departure.getDate() + day);
        departure.setHours(hour, 30, 0, 0);
        const departureSql = departure.toISOString().slice(0, 19).replace('T', ' ');

        const arrival = new Date(departure.getTime() + definition.minutes * 60_000);
        const busIndex = (day + hour) % busIds.length;
        const busId = busIds[busIndex];
        const layoutId = busLayoutIds[busIndex];
        if (busId === undefined || layoutId === undefined) continue;

        const existingTrip = await queryOne<{ id: number }>(
          'SELECT id FROM trips WHERE route_id = ? AND bus_id = ? AND departure_datetime = ?',
          [routeId, busId, departureSql],
        );
        if (existingTrip) continue;

        /**
         * El viaje nace anclado a la version publicada de SU bus, igual que lo hace
         * `POST /trips`. Sin esto quedaba con `bus_layout_id` NULL y dependiendo de la red
         * de compatibilidad, que existe para los datos anteriores a la migracion 010 y no
         * para los que crea el seed de hoy.
         */
        const seatCount = await queryOne<{ seat_count: number }>('SELECT seat_count FROM bus_layouts WHERE id = ?', [layoutId]);
        await execute(
          `INSERT INTO trips (route_id, bus_id, bus_layout_id, departure_datetime, arrival_datetime, base_price, available_seats, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'SCHEDULED')`,
          [
            routeId,
            busId,
            layoutId,
            departureSql,
            arrival.toISOString().slice(0, 19).replace('T', ' '),
            definition.price,
            Number(seatCount?.seat_count ?? 0),
          ],
        );
      }
    }
  }

  const demoDestinations = await seedDemoDestinations();

  const tripCount = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM trips');
  console.log('✔ Seed completado.');
  console.log(`   Empresas: ${companyIds.length} · Buses: ${busIds.length} · Rutas: ${routeIds.length} · Viajes: ${tripCount?.total ?? 0}`);
  console.log(`   Destinos DEMO: ${demoDestinations} (contenido de demostración, sin precios ni datos turísticos)`);
  console.log('   Usuarios de prueba (contraseña: %s):', DEMO_PASSWORD);
  console.log(`   · admin@busperu.com     (ADMIN, id ${adminId})`);
  console.log(`   · empresa@busperu.com   (COMPANY_ADMIN, id ${companyAdminId})`);
  console.log(`   · operador@busperu.com  (OPERATOR, id ${operatorId})`);
  console.log(`   · cliente@busperu.com   (CUSTOMER, id ${customerId})`);
}

main()
  .catch((error) => {
    console.error('✖ Error al ejecutar el seed:', error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
