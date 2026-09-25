import type { PoolConnection } from 'mysql2/promise';
import { query, queryOne, withTransaction } from '../config/database';
import { ApiError } from '../utils/ApiError';

/**
 * Lectura de la configuración física de un bus (migración 010).
 *
 * EL MODELO. Un bus no tiene asientos: tiene VERSIONES de distribución, y cada versión
 * tiene pisos, y cada piso tiene asientos y elementos. Un viaje se ancla a una versión
 * concreta al crearse (`trips.bus_layout_id`), y a partir de ahí su mapa ya no depende de
 * lo que la empresa haga con el bus. Eso es lo que protege el histórico de las ventas.
 *
 *   buses → bus_layouts → bus_layout_decks → bus_layout_elements
 *                      └→ seats
 *
 * COPY-ON-WRITE. Una versión PUBLISHED es INMUTABLE, tenga viajes o no. Para cambiar la
 * distribución de un bus se clona la versión vigente a un DRAFT, se edita el DRAFT y se
 * publica; al publicarlo, la anterior pasa a ARCHIVED. No existe ninguna operación que
 * modifique una versión publicada o archivada: la protección no depende de que nadie se
 * equivoque, sino de que la operación no está escrita.
 *
 * TODA ESCRITURA VA EN UNA SOLA TRANSACCIÓN. Un clon a medias —la versión creada pero sin
 * sus asientos— sería peor que no haberlo intentado: el bus quedaría con una distribución
 * fantasma. Por eso `cloneForEdit` y `publishLayout` son atómicas de principio a fin.
 *
 * LOS ELEMENTOS NO SON ASIENTOS. Un baño o una escalera ocupan una casilla del piso pero no
 * se venden, no cuentan como pasajero y no entran en la capacidad. Por eso viven en su
 * propia tabla y `getLayoutTree` los devuelve aparte de los asientos: el mapa de asientos no
 * puede contaminarse con ellos ni siquiera por descuido.
 */

export interface BusLayout {
  id: number;
  bus_id: number;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  name: string | null;
  seat_count: number;
  published_at: string | null;
}

export interface BusLayoutDeck {
  id: number;
  layout_id: number;
  deck_number: number;
  name: string | null;
  row_count: number;
  column_count: number;
}

export interface BusLayoutElement {
  id: number;
  deck_id: number;
  element_type: 'BATHROOM' | 'STAIRS' | 'DRIVER' | 'DOOR' | 'EMPTY';
  row_number: number;
  column_number: number;
  row_span: number;
  col_span: number;
  label: string | null;
}

export interface LayoutSeat {
  id: number;
  deck_id: number | null;
  seat_type_id: number | null;
  seat_type_name: string | null;
  seat_number: string;
  row_number: number | null;
  column_number: number | null;
  is_window: 0 | 1;
  is_aisle: 0 | 1;
  status: 'AVAILABLE' | 'INACTIVE';
}

export interface LayoutTree {
  layout: BusLayout;
  decks: BusLayoutDeck[];
  elements: BusLayoutElement[];
  seats: LayoutSeat[];
}

const LAYOUT_SELECT = 'SELECT id, bus_id, version, status, name, seat_count, published_at FROM bus_layouts';

/**
 * Asientos VENDIBLES de una versión. Espera un único parámetro: el id de la versión.
 *
 * ES LA ÚNICA DEFINICIÓN DE `seat_count` (auditoría FASE 7, hallazgo H-15). `seat_count` no
 * es el número de filas de `seats` de la versión: es cuántas plazas puede vender. Un asiento
 * INACTIVE ocupa su casilla y se dibuja en el mapa, pero la reserva lo rechaza, así que
 * contarlo inflaba `capacity` y `seats_available` con plazas que nadie podía comprar y el
 * viaje nunca llegaba a verse lleno.
 *
 * De `seat_count` beben la capacidad de cada viaje (`TRIP_SEAT_CAPACITY_SQL`), los cupos
 * iniciales de un viaje nuevo y `buses.capacity`. Por eso el recuento vive aquí una sola vez
 * y lo usan el editor, el clon, la publicación y el seed: si la regla cambia, cambia en un
 * único sitio.
 */
export const SELLABLE_SEAT_COUNT_SQL = "SELECT COUNT(*) FROM seats WHERE layout_id = ? AND status = 'AVAILABLE'";

/** La versión vigente de un bus: la única que puede estar `PUBLISHED` a la vez. */
export async function getPublishedLayout(busId: number): Promise<BusLayout | null> {
  return queryOne<BusLayout>(`${LAYOUT_SELECT} WHERE bus_id = ? AND status = 'PUBLISHED' LIMIT 1`, [busId]);
}

/** Todas las versiones de un bus, de la más nueva a la más antigua. */
export async function listLayouts(busId: number): Promise<BusLayout[]> {
  return query<BusLayout>(`${LAYOUT_SELECT} WHERE bus_id = ? ORDER BY version DESC`, [busId]);
}

export async function getLayout(layoutId: number): Promise<BusLayout | null> {
  return queryOne<BusLayout>(`${LAYOUT_SELECT} WHERE id = ? LIMIT 1`, [layoutId]);
}

/**
 * La versión entera: pisos, elementos y asientos.
 *
 * Sirve al editor de la empresa y a cualquier vista que necesite dibujar el bus completo.
 * El mapa de asientos de un viaje NO usa esto: usa `seatMap`, que además sabe qué asientos
 * están tomados en ese viaje concreto.
 */
export async function getLayoutTree(layoutId: number): Promise<LayoutTree | null> {
  const layout = await getLayout(layoutId);
  if (!layout) return null;

  const decks = await query<BusLayoutDeck>(
    'SELECT id, layout_id, deck_number, name, row_count, column_count FROM bus_layout_decks WHERE layout_id = ? ORDER BY deck_number ASC',
    [layoutId],
  );

  const elements = decks.length
    ? await query<BusLayoutElement>(
        `SELECT e.id, e.deck_id, e.element_type, e.row_number, e.column_number, e.row_span, e.col_span, e.label
         FROM bus_layout_elements e
         JOIN bus_layout_decks d ON d.id = e.deck_id
         WHERE d.layout_id = ?
         ORDER BY d.deck_number ASC, e.row_number ASC, e.column_number ASC`,
        [layoutId],
      )
    : [];

  const seats = await query<LayoutSeat>(
    `SELECT s.id, s.deck_id, s.seat_type_id, st.name AS seat_type_name, s.seat_number,
            s.row_number, s.column_number, s.is_window, s.is_aisle, s.status
     FROM seats s
     LEFT JOIN seat_types st ON st.id = s.seat_type_id
     WHERE s.layout_id = ?
     ORDER BY s.row_number ASC, s.column_number ASC, s.seat_number ASC`,
    [layoutId],
  );

  return { layout, decks, elements, seats };
}

/**
 * ¿Hay algún viaje anclado a esta versión?
 *
 * Es la pregunta que decide si una versión se puede seguir editando en el sitio o si hay
 * que clonarla. En cuanto un viaje la usa, la versión es historia y no se toca.
 */
export async function hasTrips(layoutId: number): Promise<boolean> {
  const row = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM trips WHERE bus_layout_id = ? LIMIT 1', [layoutId]);
  return Number(row?.total ?? 0) > 0;
}

/**
 * Qué versión le toca a un viaje.
 *
 * Primero la suya, congelada al crearse. Si no la tiene —viajes anteriores a la migración,
 * o creados por una vía que todavía no la fija— se cae a la versión publicada del bus.
 *
 * ESA CAÍDA ES UNA RED DE TRANSICIÓN, NO UN COMPORTAMIENTO. Un viaje sin versión propia
 * queda expuesto a que la empresa le cambie el mapa, que es justo lo que la migración 010
 * vino a impedir; en cuanto todas las vías de creación fijen `bus_layout_id`, esta rama
 * dejará de ejecutarse. Y si no hay ni una cosa ni la otra, el error es explícito: un viaje
 * cuyo bus no tiene distribución publicada no se puede vender, y decirlo así es mucho más
 * útil que dejar que la consulta devuelva cero asientos sin explicar por qué.
 */
export async function resolveTripLayoutId(tripId: number): Promise<number> {
  const trip = await queryOne<{ id: number; bus_id: number; bus_layout_id: number | null }>(
    'SELECT id, bus_id, bus_layout_id FROM trips WHERE id = ? LIMIT 1',
    [tripId],
  );
  if (!trip) throw ApiError.notFound('Viaje no encontrado');
  if (trip.bus_layout_id !== null) return trip.bus_layout_id;

  const publicado = await getPublishedLayout(trip.bus_id);
  if (!publicado) {
    throw ApiError.badRequest('El bus de este viaje no tiene una distribución de asientos publicada');
  }
  return publicado.id;
}

// ===========================================================================
// Escritura: borrador, copia y publicación
// ===========================================================================

/** Filas de una consulta hecha sobre una conexión de transacción. */
async function rows<T>(connection: PoolConnection, sql: string, params: unknown[] = []): Promise<T[]> {
  const [result] = await connection.query(sql, params);
  return result as T[];
}

async function first<T>(connection: PoolConnection, sql: string, params: unknown[] = []): Promise<T | null> {
  const found = await rows<T>(connection, sql, params);
  return found[0] ?? null;
}

/**
 * Siguiente número de versión libre del bus.
 *
 * Se calcula dentro de la transacción y con la fila del bus ya bloqueada, de modo que dos
 * clonaciones simultáneas no puedan elegir el mismo número. Si aun así coincidieran,
 * `uq_layout_bus_version` lo impediría en la base.
 */
async function nextVersion(connection: PoolConnection, busId: number): Promise<number> {
  const fila = await first<{ maxima: number | null }>(
    connection,
    'SELECT MAX(version) AS maxima FROM bus_layouts WHERE bus_id = ?',
    [busId],
  );
  return Number(fila?.maxima ?? 0) + 1;
}

/**
 * Bloquea el bus para serializar cualquier cambio sobre sus versiones.
 *
 * Es el ÚNICO cerrojo que toma este servicio, y siempre el primero. Tomar siempre el mismo
 * recurso y en el mismo orden es lo que evita que dos publicaciones se queden esperándose
 * (la lección de BP-21). El ciclo de reservas bloquea el viaje y los asientos, nunca el bus,
 * así que estas dos familias de operaciones no comparten recursos y no pueden trabarse.
 */
async function lockBus(connection: PoolConnection, busId: number): Promise<void> {
  const bus = await first<{ id: number }>(connection, 'SELECT id FROM buses WHERE id = ? FOR UPDATE', [busId]);
  if (!bus) throw ApiError.notFound('Bus no encontrado');
}

export interface DraftInput {
  name?: string | null;
  decks?: Array<{ deck_number: number; name?: string | null; row_count?: number; column_count?: number }>;
}

/**
 * Borrador vacío para un bus.
 *
 * Nace siempre en DRAFT y con `published_at` en NULL: publicar es un acto explícito y
 * aparte. Ni la versión ni el estado los decide quien llama —el número se calcula aquí y el
 * estado es fijo—, de modo que no hay forma de colar una versión ya publicada.
 */
export async function createDraft(busId: number, input: DraftInput = {}): Promise<BusLayout> {
  return withTransaction(async (connection) => {
    await lockBus(connection, busId);
    const version = await nextVersion(connection, busId);

    const [creado] = await connection.query(
      `INSERT INTO bus_layouts (bus_id, version, status, name, seat_count, published_at)
       VALUES (?, ?, 'DRAFT', ?, 0, NULL)`,
      [busId, version, input.name ?? `Versión ${version}`],
    );
    const layoutId = (creado as { insertId: number }).insertId;

    for (const deck of input.decks ?? [{ deck_number: 1, name: 'Piso 1' }]) {
      await connection.query(
        'INSERT INTO bus_layout_decks (layout_id, deck_number, name, row_count, column_count) VALUES (?, ?, ?, ?, ?)',
        [layoutId, deck.deck_number, deck.name ?? `Piso ${deck.deck_number}`, deck.row_count ?? 0, deck.column_count ?? 0],
      );
    }

    const layout = await first<BusLayout>(connection, `${LAYOUT_SELECT} WHERE id = ?`, [layoutId]);
    if (!layout) throw ApiError.badRequest('No se pudo crear la versión');
    return layout;
  });
}

/**
 * Copia una versión a un borrador nuevo: el copy-on-write.
 *
 * Nada del origen se toca. Se crean filas nuevas para la versión, sus pisos, sus elementos y
 * sus asientos, con identificadores nuevos, y se reconstruyen las referencias con un mapa de
 * piso viejo → piso nuevo. Reutilizar un identificador de asiento sería catastrófico: las
 * ventas de `booking_seats` apuntan a esos identificadores y quedarían colgadas de la
 * distribución equivocada.
 *
 * Todo ocurre en una transacción: si algo falla a mitad, no queda ni rastro del clon.
 */
export async function cloneForEdit(layoutId: number): Promise<BusLayout> {
  return withTransaction(async (connection) => {
    const origen = await first<BusLayout>(connection, `${LAYOUT_SELECT} WHERE id = ?`, [layoutId]);
    if (!origen) throw ApiError.notFound('Versión no encontrada');

    await lockBus(connection, origen.bus_id);
    const version = await nextVersion(connection, origen.bus_id);

    const [creado] = await connection.query(
      `INSERT INTO bus_layouts (bus_id, version, status, name, seat_count, published_at)
       VALUES (?, ?, 'DRAFT', ?, 0, NULL)`,
      [origen.bus_id, version, `Versión ${version}`],
    );
    const nuevoId = (creado as { insertId: number }).insertId;

    const pisos = await rows<BusLayoutDeck>(
      connection,
      'SELECT id, layout_id, deck_number, name, row_count, column_count FROM bus_layout_decks WHERE layout_id = ? ORDER BY deck_number ASC',
      [layoutId],
    );

    // Sin este mapa, los asientos del clon apuntarían a los pisos del original.
    const equivalencia = new Map<number, number>();
    for (const piso of pisos) {
      const [insertado] = await connection.query(
        'INSERT INTO bus_layout_decks (layout_id, deck_number, name, row_count, column_count) VALUES (?, ?, ?, ?, ?)',
        [nuevoId, piso.deck_number, piso.name, piso.row_count, piso.column_count],
      );
      equivalencia.set(piso.id, (insertado as { insertId: number }).insertId);
    }

    for (const piso of pisos) {
      const destino = equivalencia.get(piso.id);
      if (destino === undefined) continue;
      await connection.query(
        `INSERT INTO bus_layout_elements (deck_id, element_type, row_number, column_number, row_span, col_span, label)
         SELECT ?, element_type, row_number, column_number, row_span, col_span, label
         FROM bus_layout_elements WHERE deck_id = ?`,
        [destino, piso.id],
      );
      await connection.query(
        `INSERT INTO seats (bus_id, layout_id, deck_id, seat_type_id, seat_number, row_number, column_number, is_window, is_aisle, status)
         SELECT bus_id, ?, ?, seat_type_id, seat_number, row_number, column_number, is_window, is_aisle, status
         FROM seats WHERE layout_id = ? AND deck_id = ?`,
        [nuevoId, destino, layoutId, piso.id],
      );
    }

    // Los asientos sin piso —solo pueden venir de datos anteriores a la migración— se copian
    // igualmente para no perderlos por el camino.
    await connection.query(
      `INSERT INTO seats (bus_id, layout_id, deck_id, seat_type_id, seat_number, row_number, column_number, is_window, is_aisle, status)
       SELECT bus_id, ?, NULL, seat_type_id, seat_number, row_number, column_number, is_window, is_aisle, status
       FROM seats WHERE layout_id = ? AND deck_id IS NULL`,
      [nuevoId, layoutId],
    );

    // No se copia el `seat_count` del origen: se recuenta sobre los asientos que de verdad
    // se acaban de copiar. Así el clon hereda la capacidad vendible sin depender de que la
    // cifra guardada en el origen estuviera bien.
    await syncSeatCount(connection, nuevoId);

    const clon = await first<BusLayout>(connection, `${LAYOUT_SELECT} WHERE id = ?`, [nuevoId]);
    if (!clon) throw ApiError.badRequest('No se pudo clonar la versión');
    return clon;
  });
}

/**
 * Publica un borrador y archiva la versión que estuviera vigente.
 *
 * El bus se bloquea al principio, así que dos publicaciones simultáneas del mismo bus se
 * serializan: la segunda encuentra su borrador ya cambiado de estado y falla con un error de
 * negocio, nunca con un choque de clave. La restricción `uq_layout_published_bus` queda como
 * última red, no como mecanismo.
 *
 * `buses.capacity` se sincroniza aquí porque describe la capacidad ACTUAL del bus. Los
 * viajes ya creados no se tocan: cada uno conserva su `bus_layout_id` y, con él, su propia
 * capacidad histórica.
 */
export async function publishLayout(layoutId: number): Promise<BusLayout> {
  return withTransaction(async (connection) => {
    const borrador = await first<BusLayout>(connection, `${LAYOUT_SELECT} WHERE id = ?`, [layoutId]);
    if (!borrador) throw ApiError.notFound('Versión no encontrada');

    await lockBus(connection, borrador.bus_id);

    // Se relee tras el cerrojo: entre la primera lectura y el bloqueo otra publicación pudo
    // haber cambiado este mismo borrador.
    const actual = await first<BusLayout>(connection, `${LAYOUT_SELECT} WHERE id = ?`, [layoutId]);
    if (!actual) throw ApiError.notFound('Versión no encontrada');
    if (actual.status !== 'DRAFT') {
      throw ApiError.badRequest('Solo se puede publicar una versión en borrador');
    }

    const pisos = await rows<BusLayoutDeck>(
      connection,
      'SELECT id, layout_id, deck_number, name, row_count, column_count FROM bus_layout_decks WHERE layout_id = ? ORDER BY deck_number ASC',
      [layoutId],
    );
    if (pisos.length === 0) throw ApiError.badRequest('La versión no tiene ningún piso');

    // Esta guarda es FÍSICA a propósito: una versión sin ninguna fila en `seats` no es un bus.
    // No es la capacidad —esa la fija `syncSeatCount` más abajo y sí descuenta los INACTIVE—.
    const conteo = await first<{ total: number }>(connection, 'SELECT COUNT(*) AS total FROM seats WHERE layout_id = ?', [layoutId]);
    if (Number(conteo?.total ?? 0) === 0) throw ApiError.badRequest('La versión no tiene ningún asiento');

    const sueltos = await first<{ total: number }>(
      connection,
      `SELECT COUNT(*) AS total FROM seats s
       WHERE s.layout_id = ?
         AND (s.deck_id IS NULL OR NOT EXISTS (SELECT 1 FROM bus_layout_decks d WHERE d.id = s.deck_id AND d.layout_id = s.layout_id))`,
      [layoutId],
    );
    if (Number(sueltos?.total ?? 0) > 0) {
      throw ApiError.badRequest('Hay asientos que no pertenecen a ningún piso de esta versión');
    }

    /**
     * Repaso geometrico piso a piso.
     *
     * Antes esto era una sola consulta que comparaba la casilla de ORIGEN de cada elemento
     * contra los asientos. Con eso, un bano de 2x2 en (2,2) y un asiento en (3,3) se
     * publicaban tan tranquilos aunque estuvieran uno encima del otro, y nada miraba si dos
     * elementos se solapaban ni si alguno se salia de la rejilla por culpa de su extension.
     * Ahora se expande la superficie completa de cada elemento y se comprueba celda a celda.
     */
    for (const piso of pisos) {
      const elementos = await rows<BusLayoutElement>(
        connection,
        `SELECT id, deck_id, element_type, row_number, column_number, row_span, col_span, label
         FROM bus_layout_elements WHERE deck_id = ? ORDER BY row_number ASC, column_number ASC`,
        [piso.id],
      );
      const asientosDelPiso = await rows<{ row_number: number | null; column_number: number | null; seat_number: string }>(
        connection,
        'SELECT row_number, column_number, seat_number FROM seats WHERE deck_id = ? ORDER BY row_number ASC, column_number ASC',
        [piso.id],
      );
      assertDeckGeometry(piso, elementos, asientosDelPiso);
    }

    await connection.query(
      "UPDATE bus_layouts SET status = 'ARCHIVED' WHERE bus_id = ? AND status = 'PUBLISHED' AND id <> ?",
      [borrador.bus_id, layoutId],
    );
    await syncSeatCount(connection, layoutId);
    await connection.query("UPDATE bus_layouts SET status = 'PUBLISHED', published_at = NOW() WHERE id = ?", [layoutId]);
    // Capacidad ACTUAL del bus, copiada de la versión recién publicada y no recalculada por
    // separado: `buses.capacity` es una caché de `seat_count`, no una segunda definición.
    // Los viajes históricos conservan la suya en su versión.
    await connection.query(
      'UPDATE buses SET capacity = (SELECT seat_count FROM bus_layouts WHERE id = ?) WHERE id = ?',
      [layoutId, borrador.bus_id],
    );

    const publicado = await first<BusLayout>(connection, `${LAYOUT_SELECT} WHERE id = ?`, [layoutId]);
    if (!publicado) throw ApiError.badRequest('No se pudo publicar la versión');
    return publicado;
  });
}

/**
 * Una versión solo se puede tocar mientras es un borrador.
 *
 * Lo usará el editor de la fase siguiente antes de cualquier alta, cambio o baja de piso,
 * elemento o asiento. Vive aquí, junto al modelo, y no en la ruta, para que ninguna vía de
 * escritura futura pueda saltárselo por descuido.
 */
export async function assertEditable(layoutId: number): Promise<BusLayout> {
  const layout = await getLayout(layoutId);
  if (!layout) throw ApiError.notFound('Versión no encontrada');
  if (layout.status !== 'DRAFT') {
    throw ApiError.badRequest('Una versión publicada o archivada no se modifica: clónala para editarla');
  }
  return layout;
}

/**
 * Borra una versión en borrador.
 *
 * Una publicada o archivada no se borra nunca: la archivada es el historial de los viajes que
 * la usan, y `fk_trips_bus_layout` es RESTRICT precisamente para que la base tampoco lo
 * permita. Se comprueba antes para dar un mensaje entendible en vez de un error de clave.
 */
export async function deleteDraft(layoutId: number): Promise<void> {
  const layout = await getLayout(layoutId);
  if (!layout) throw ApiError.notFound('Versión no encontrada');
  if (layout.status !== 'DRAFT') {
    throw ApiError.badRequest('Solo se puede eliminar una versión en borrador');
  }
  if (await hasTrips(layoutId)) {
    throw ApiError.badRequest('La versión tiene viajes asociados y no se puede eliminar');
  }
  await withTransaction(async (connection) => {
    await connection.query('DELETE FROM seats WHERE layout_id = ?', [layoutId]);
    await connection.query('DELETE FROM bus_layouts WHERE id = ?', [layoutId]);
  });
}

// ===========================================================================
// Editor: pisos, elementos y asientos de un BORRADOR
// ===========================================================================
//
// TODO LO DE AQUÍ EXIGE UN BORRADOR. `assertEditable` corre al principio de cada operación,
// de modo que una versión publicada o archivada no se puede tocar por ninguna vía: es el
// historial de los viajes que la usan. Para cambiarla hay que clonarla.
//
// Y TODO VA EN UNA TRANSACCIÓN, incluido el recuento de asientos de la versión. No puede
// existir un momento en el que el asiento esté creado y `seat_count` diga otra cosa.

/** El piso, comprobando de paso que su versión se puede editar. */
async function deckInDraft(deckId: number): Promise<{ deck: BusLayoutDeck; layout: BusLayout }> {
  const deck = await queryOne<BusLayoutDeck>(
    'SELECT id, layout_id, deck_number, name, row_count, column_count FROM bus_layout_decks WHERE id = ? LIMIT 1',
    [deckId],
  );
  if (!deck) throw ApiError.notFound('Piso no encontrado');
  const layout = await assertEditable(deck.layout_id);
  return { deck, layout };
}

/**
 * Deja `seat_count` de acuerdo con los asientos VENDIBLES de la versión. Siempre dentro de la
 * transacción. Ver `SELLABLE_SEAT_COUNT_SQL`.
 */
async function syncSeatCount(connection: PoolConnection, layoutId: number): Promise<void> {
  await connection.query(`UPDATE bus_layouts SET seat_count = (${SELLABLE_SEAT_COUNT_SQL}) WHERE id = ?`, [
    layoutId,
    layoutId,
  ]);
}

/**
 * Última fila y última columna que ocupa algo colocado en la rejilla.
 *
 * Es LA definición de hasta dónde llega un elemento, y la usan tanto la colocación —al crear
 * o mover algo— como la comprobación de que la rejilla no encoja por debajo de lo que ya hay
 * dentro. Tenerla escrita dos veces era exactamente el modo en que una comprobación acabaría
 * aceptando lo que la otra rechaza.
 */
function lastCell(row: number, column: number, rowSpan = 1, colSpan = 1): { row: number; column: number } {
  return { row: row + Math.max(1, rowSpan) - 1, column: column + Math.max(1, colSpan) - 1 };
}

/**
 * ¿Cabe entero en una rejilla de `rows` × `columns`?
 *
 * Un 0 significa «rejilla sin declarar» y no limita, igual que en `assertFreeCells`: los
 * pisos que vienen de la migración pueden tenerlo así y rechazarlos dejaría inservible un
 * bus heredado.
 */
function fitsInGrid(rows: number, columns: number, row: number, column: number, rowSpan = 1, colSpan = 1): boolean {
  const fin = lastCell(row, column, rowSpan, colSpan);
  if (rows > 0 && fin.row > rows) return false;
  if (columns > 0 && fin.column > columns) return false;
  return true;
}

/** Las casillas que ocupa algo con su extensión: (fila, columna) en forma de texto. */
function cells(row: number, column: number, rowSpan = 1, colSpan = 1): string[] {
  const ocupadas: string[] = [];
  for (let fila = row; fila < row + Math.max(1, rowSpan); fila += 1) {
    for (let columna = column; columna < column + Math.max(1, colSpan); columna += 1) {
      ocupadas.push(`${fila}:${columna}`);
    }
  }
  return ocupadas;
}

/**
 * Lee por la conexión de la transacción si se da una, y por el pool si no.
 *
 * Existe para que `assertFreeCells` —la única definición de «esta casilla está libre»— pueda
 * correr DENTRO de la transacción que después escribe. Validar por el pool y escribir por
 * otra conexión es justo lo que dejaba pasar una edición ajena por el medio.
 */
async function readRows<T>(connection: PoolConnection | null, sql: string, params: unknown[]): Promise<T[]> {
  return connection ? rows<T>(connection, sql, params) : query<T>(sql, params);
}

/**
 * La versión de un piso, releída por la conexión dada, y solo si se puede editar.
 *
 * Se relee DENTRO de la transacción y detrás del cerrojo a propósito: entre la comprobación
 * inicial y la escritura, otra petición pudo publicar la versión, y entonces ya no se toca.
 */
async function assertDraftOnConnection(connection: PoolConnection, layoutId: number): Promise<BusLayout> {
  const layout = await first<BusLayout>(connection, `${LAYOUT_SELECT} WHERE id = ?`, [layoutId]);
  if (!layout) throw ApiError.notFound('Versión no encontrada');
  if (layout.status !== 'DRAFT') {
    throw ApiError.badRequest('Una versión publicada o archivada no se modifica: clónala para editarla');
  }
  return layout;
}

/**
 * Comprueba que la posición cabe en la rejilla y que no pisa nada.
 *
 * Un `row_count` o `column_count` en 0 significa «rejilla sin declarar» y no limita: los
 * pisos que vienen de la migración pueden tenerlo así, y rechazarlos dejaría buses
 * heredados inservibles.
 *
 * El choque se detecta ANTES de escribir y se explica con palabras. El índice único de la
 * base sigue estando, pero como última red: un 500 con `ER_DUP_ENTRY` no le dice nada a
 * quien está colocando un baño en una rejilla.
 */
async function assertFreeCells(
  deck: BusLayoutDeck,
  row: number,
  column: number,
  rowSpan: number,
  colSpan: number,
  excluir: { seatId?: number; elementId?: number } = {},
  connection: PoolConnection | null = null,
): Promise<void> {
  if (row < 1 || column < 1) throw ApiError.badRequest('La fila y la columna empiezan en 1');
  const fin = lastCell(row, column, rowSpan, colSpan);
  if (deck.row_count > 0 && fin.row > deck.row_count) {
    throw ApiError.badRequest(`La fila ${row} se sale del piso, que tiene ${deck.row_count} filas`);
  }
  if (deck.column_count > 0 && fin.column > deck.column_count) {
    throw ApiError.badRequest(`La columna ${column} se sale del piso, que tiene ${deck.column_count} columnas`);
  }

  const pedidas = new Set(cells(row, column, rowSpan, colSpan));

  const asientos = await readRows<{ id: number; row_number: number | null; column_number: number | null }>(
    connection,
    'SELECT id, row_number, column_number FROM seats WHERE deck_id = ?',
    [deck.id],
  );
  for (const asiento of asientos) {
    if (asiento.id === excluir.seatId) continue;
    if (asiento.row_number === null || asiento.column_number === null) continue;
    if (pedidas.has(`${asiento.row_number}:${asiento.column_number}`)) {
      throw ApiError.badRequest(`La posición (${asiento.row_number}, ${asiento.column_number}) ya la ocupa un asiento`);
    }
  }

  const elementos = await readRows<BusLayoutElement>(
    connection,
    'SELECT id, deck_id, element_type, row_number, column_number, row_span, col_span, label FROM bus_layout_elements WHERE deck_id = ?',
    [deck.id],
  );
  for (const elemento of elementos) {
    if (elemento.id === excluir.elementId) continue;
    const suyas = cells(elemento.row_number, elemento.column_number, elemento.row_span, elemento.col_span);
    const choque = suyas.find((casilla) => pedidas.has(casilla));
    if (choque) {
      throw ApiError.badRequest(`La posición (${choque.replace(':', ', ')}) ya la ocupa un elemento`);
    }
  }
}

/**
 * Repasa la geometria de un piso ENTERO antes de publicar (auditoria 6F, hallazgo H-06).
 *
 * POR QUE EXISTE SI EL EDITOR YA VALIDA. `assertFreeCells` comprueba cada pieza segun se
 * coloca, pero solo ve la peticion que tiene delante. La publicacion es el momento en que una
 * version deja de ser un borrador y pasa a ser el mapa que vera un pasajero y que quedara
 * congelado en los viajes: ahi conviene mirar el piso completo, sin dar por hecho que todo lo
 * que hay dentro entro por la puerta principal. Un dato que venga de una clonacion, de una
 * carga manual o de una version anterior del codigo no tiene por que cumplir nada.
 *
 * LO QUE MIRA. La superficie COMPLETA de cada elemento, no su casilla de origen: un 2x2 en
 * (2,2) ocupa (2,2) (2,3) (3,2) y (3,3), y cualquiera de las cuatro puede salirse de la
 * rejilla o chocar con algo. Antes la comprobacion de publicacion comparaba solo la casilla
 * de origen contra los asientos, de modo que un asiento en (3,3) pasaba sin enterarse.
 *
 * Usa exactamente la misma geometria que el editor: `fitsInGrid`, `lastCell` y `cells`. No
 * hay una segunda definicion de que ocupa cada cosa.
 */
function assertDeckGeometry(
  deck: BusLayoutDeck,
  elementos: BusLayoutElement[],
  asientos: Array<{ row_number: number | null; column_number: number | null; seat_number: string }>,
): void {
  /** Que hay en cada casilla: sirve para explicar el choque, no solo para detectarlo. */
  const ocupadas = new Map<string, string>();
  const comoTexto = (casilla: string) => `(${casilla.replace(':', ', ')})`;

  for (const elemento of elementos) {
    if (elemento.row_number < 1 || elemento.column_number < 1) {
      throw ApiError.badRequest('Hay un elemento con una posición inválida: la fila y la columna empiezan en 1');
    }
    if (elemento.row_span < 1 || elemento.col_span < 1) {
      throw ApiError.badRequest('Hay un elemento con una altura o una anchura inválida: deben ser 1 o mayores');
    }
    if (
      !fitsInGrid(deck.row_count, deck.column_count, elemento.row_number, elemento.column_number, elemento.row_span, elemento.col_span)
    ) {
      const fin = lastCell(elemento.row_number, elemento.column_number, elemento.row_span, elemento.col_span);
      throw ApiError.badRequest(
        `Hay un elemento que se sale del piso: llega hasta la fila ${fin.row} y la columna ${fin.column}`,
      );
    }

    for (const casilla of cells(elemento.row_number, elemento.column_number, elemento.row_span, elemento.col_span)) {
      if (ocupadas.has(casilla)) {
        throw ApiError.badRequest(`Hay dos elementos ocupando la misma posición ${comoTexto(casilla)}`);
      }
      ocupadas.set(casilla, 'elemento');
    }
  }

  for (const asiento of asientos) {
    if (asiento.row_number === null || asiento.column_number === null) continue;
    const casilla = `${asiento.row_number}:${asiento.column_number}`;
    if (ocupadas.has(casilla)) {
      throw ApiError.badRequest(
        `Hay asientos y elementos ocupando la misma posición ${comoTexto(casilla)}: el asiento ${asiento.seat_number}`,
      );
    }
    ocupadas.set(casilla, 'asiento');
  }
}

// ------------------------------------------------------------------ pisos

export interface DeckInput {
  deck_number?: number;
  name?: string | null;
  row_count?: number;
  column_count?: number;
}

export async function listDecks(layoutId: number): Promise<BusLayoutDeck[]> {
  return query<BusLayoutDeck>(
    'SELECT id, layout_id, deck_number, name, row_count, column_count FROM bus_layout_decks WHERE layout_id = ? ORDER BY deck_number ASC',
    [layoutId],
  );
}

export async function createDeck(layoutId: number, input: DeckInput): Promise<BusLayoutDeck> {
  await assertEditable(layoutId);
  const numero = Number(input.deck_number ?? 1);
  if (!Number.isInteger(numero) || numero < 1) throw ApiError.badRequest('El número de piso debe ser 1 o mayor');
  const filas = Number(input.row_count ?? 0);
  const columnas = Number(input.column_count ?? 0);
  if (filas < 0 || columnas < 0) throw ApiError.badRequest('Las filas y columnas no pueden ser negativas');

  const repetido = await queryOne<{ id: number }>(
    'SELECT id FROM bus_layout_decks WHERE layout_id = ? AND deck_number = ? LIMIT 1',
    [layoutId, numero],
  );
  if (repetido) throw ApiError.badRequest(`Esta versión ya tiene un piso ${numero}`);

  return withTransaction(async (connection) => {
    const [creado] = await connection.query(
      'INSERT INTO bus_layout_decks (layout_id, deck_number, name, row_count, column_count) VALUES (?, ?, ?, ?, ?)',
      [layoutId, numero, input.name ?? `Piso ${numero}`, filas, columnas],
    );
    const deckId = (creado as { insertId: number }).insertId;
    const deck = await first<BusLayoutDeck>(
      connection,
      'SELECT id, layout_id, deck_number, name, row_count, column_count FROM bus_layout_decks WHERE id = ?',
      [deckId],
    );
    if (!deck) throw ApiError.badRequest('No se pudo crear el piso');
    return deck;
  });
}

/**
 * Cambia un piso: su número, su nombre y su rejilla.
 *
 * ENCOGER NO PUEDE DEJAR NADA FUERA. Ni asientos —eso ya se comprobaba— ni ELEMENTOS, que es
 * lo que faltaba (auditoría 6F, hallazgo H-05): un baño en la fila 9 con `row_span` 2 llega
 * hasta la 10, y bajar el piso a 9 filas lo dejaba medio fuera de su propia rejilla. Se mira
 * la superficie ENTERA de cada elemento, no su casilla de origen, con la misma regla que usa
 * `assertFreeCells` para colocarlo: `fitsInGrid`.
 *
 * TODO VA DENTRO DE LA TRANSACCIÓN, y detrás del cerrojo del bus. Antes se comprobaba fuera
 * y se escribía después, así que entre una cosa y otra cabía un cambio ajeno. El cerrojo es
 * el del BUS porque es el único que toma este servicio y siempre el primero: mantener ese
 * orden es lo que evita que publicar y editar se traben (BP-21).
 */
export async function updateDeck(deckId: number, input: DeckInput): Promise<BusLayoutDeck> {
  const { layout } = await deckInDraft(deckId);

  if (input.deck_number !== undefined) {
    const pedido = Number(input.deck_number);
    if (!Number.isInteger(pedido) || pedido < 1) throw ApiError.badRequest('El número de piso debe ser 1 o mayor');
  }
  if (input.row_count !== undefined && Number(input.row_count) < 0) {
    throw ApiError.badRequest('Las filas y columnas no pueden ser negativas');
  }
  if (input.column_count !== undefined && Number(input.column_count) < 0) {
    throw ApiError.badRequest('Las filas y columnas no pueden ser negativas');
  }

  return withTransaction(async (connection) => {
    await lockBus(connection, layout.bus_id);

    // Se relee todo tras el cerrojo: entre la primera lectura y el bloqueo, otra edición
    // pudo cambiar el piso, o publicar la versión y dejarla intocable.
    const deck = await first<BusLayoutDeck>(
      connection,
      'SELECT id, layout_id, deck_number, name, row_count, column_count FROM bus_layout_decks WHERE id = ?',
      [deckId],
    );
    if (!deck) throw ApiError.notFound('Piso no encontrado');
    await assertDraftOnConnection(connection, deck.layout_id);

    const numero = input.deck_number === undefined ? deck.deck_number : Number(input.deck_number);
    const filas = input.row_count === undefined ? deck.row_count : Number(input.row_count);
    const columnas = input.column_count === undefined ? deck.column_count : Number(input.column_count);

    if (numero !== deck.deck_number) {
      const repetido = await first<{ id: number }>(
        connection,
        'SELECT id FROM bus_layout_decks WHERE layout_id = ? AND deck_number = ? AND id <> ? LIMIT 1',
        [deck.layout_id, numero, deckId],
      );
      if (repetido) throw ApiError.badRequest(`Esta versión ya tiene un piso ${numero}`);
    }

    // Encoger la rejilla por debajo de lo que ya hay dentro dejaría asientos fuera del piso.
    const asientos = await rows<{ row_number: number | null; column_number: number | null }>(
      connection,
      'SELECT row_number, column_number FROM seats WHERE deck_id = ?',
      [deckId],
    );
    const asientoFuera = asientos.some(
      (asiento) =>
        asiento.row_number !== null &&
        asiento.column_number !== null &&
        !fitsInGrid(filas, columnas, asiento.row_number, asiento.column_number),
    );
    if (asientoFuera) {
      throw ApiError.badRequest('La rejilla no puede encogerse por debajo de los asientos que ya tiene');
    }

    // Y tampoco por debajo de los elementos, contando su extensión entera.
    const elementos = await rows<BusLayoutElement>(
      connection,
      'SELECT id, deck_id, element_type, row_number, column_number, row_span, col_span, label FROM bus_layout_elements WHERE deck_id = ?',
      [deckId],
    );
    const elementoFuera = elementos.find(
      (elemento) =>
        !fitsInGrid(filas, columnas, elemento.row_number, elemento.column_number, elemento.row_span, elemento.col_span),
    );
    if (elementoFuera) {
      const fin = lastCell(
        elementoFuera.row_number,
        elementoFuera.column_number,
        elementoFuera.row_span,
        elementoFuera.col_span,
      );
      throw ApiError.badRequest(
        `La rejilla no puede encogerse: hay un elemento que llega hasta la fila ${fin.row} y la columna ${fin.column}`,
      );
    }

    await connection.query(
      'UPDATE bus_layout_decks SET deck_number = ?, name = ?, row_count = ?, column_count = ? WHERE id = ?',
      [numero, input.name === undefined ? deck.name : input.name, filas, columnas, deckId],
    );
    const actualizado = await first<BusLayoutDeck>(
      connection,
      'SELECT id, layout_id, deck_number, name, row_count, column_count FROM bus_layout_decks WHERE id = ?',
      [deckId],
    );
    if (!actualizado) throw ApiError.notFound('Piso no encontrado');
    return actualizado;
  });
}

/**
 * Borra un piso vacío.
 *
 * Nunca en cascada: si el piso tiene asientos o elementos, se dice y se deja que quien edita
 * decida qué hacer con ellos. Un borrado silencioso de doce asientos por pulsar «eliminar
 * piso» es justo el tipo de accidente que no debe poder ocurrir desde una API.
 */
export async function deleteDeck(deckId: number): Promise<void> {
  const { deck } = await deckInDraft(deckId);

  const asientos = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM seats WHERE deck_id = ?', [deckId]);
  if (Number(asientos?.total ?? 0) > 0) {
    throw ApiError.badRequest('El piso todavía tiene asientos: muévelos o elimínalos primero');
  }
  const elementos = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM bus_layout_elements WHERE deck_id = ?', [deckId]);
  if (Number(elementos?.total ?? 0) > 0) {
    throw ApiError.badRequest('El piso todavía tiene elementos: elimínalos primero');
  }

  await withTransaction(async (connection) => {
    await connection.query('DELETE FROM bus_layout_decks WHERE id = ?', [deckId]);
    await syncSeatCount(connection, deck.layout_id);
  });
}

// -------------------------------------------------------------- elementos

const ELEMENT_TYPES = ['BATHROOM', 'STAIRS', 'DRIVER', 'DOOR', 'EMPTY'] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

export interface ElementInput {
  element_type?: string;
  row_number?: number;
  column_number?: number;
  row_span?: number;
  col_span?: number;
  label?: string | null;
}

export async function listElements(deckId: number): Promise<BusLayoutElement[]> {
  return query<BusLayoutElement>(
    `SELECT id, deck_id, element_type, row_number, column_number, row_span, col_span, label
     FROM bus_layout_elements WHERE deck_id = ? ORDER BY row_number ASC, column_number ASC`,
    [deckId],
  );
}

function assertElementType(value: unknown): ElementType {
  if (!ELEMENT_TYPES.includes(value as ElementType)) {
    throw ApiError.badRequest(`Tipo de elemento no admitido. Válidos: ${ELEMENT_TYPES.join(', ')}`);
  }
  return value as ElementType;
}

function assertSpan(value: number, nombre: string): number {
  if (!Number.isInteger(value) || value < 1) throw ApiError.badRequest(`${nombre} debe ser 1 o mayor`);
  return value;
}

/**
 * Coloca un elemento en un piso.
 *
 * LA COMPROBACION Y LA ESCRITURA VAN JUNTAS (auditoria 6F, hallazgo H-07). Antes se miraba
 * si la casilla estaba libre por el pool y se insertaba despues en otra transaccion: entre
 * una cosa y otra cabia otro elemento en la misma casilla, o un encogimiento del piso que
 * dejaba este fuera de la rejilla. Ninguna de las dos combinaciones habria pasado si las
 * peticiones se hubieran atendido una detras de otra, que es lo que ahora ocurre.
 *
 * El cerrojo es el del BUS: el mismo que toman `createDraft`, `cloneForEdit`, `publishLayout`
 * y `updateDeck`, y siempre el primero. Tomar siempre el mismo recurso y en el mismo orden es
 * lo que impide que dos ediciones se queden esperandose (BP-21).
 */
export async function createElement(deckId: number, input: ElementInput): Promise<BusLayoutElement> {
  const { layout } = await deckInDraft(deckId);
  const tipo = assertElementType(input.element_type);
  const fila = Number(input.row_number);
  const columna = Number(input.column_number);
  if (!Number.isInteger(fila) || !Number.isInteger(columna)) {
    throw ApiError.badRequest('Hay que indicar fila y columna');
  }
  const rowSpan = assertSpan(Number(input.row_span ?? 1), 'La altura');
  const colSpan = assertSpan(Number(input.col_span ?? 1), 'La anchura');

  return withTransaction(async (connection) => {
    await lockBus(connection, layout.bus_id);

    // El piso se relee tras el cerrojo: su rejilla pudo cambiar mientras se esperaba.
    const deck = await first<BusLayoutDeck>(
      connection,
      'SELECT id, layout_id, deck_number, name, row_count, column_count FROM bus_layout_decks WHERE id = ?',
      [deckId],
    );
    if (!deck) throw ApiError.notFound('Piso no encontrado');
    await assertDraftOnConnection(connection, deck.layout_id);

    await assertFreeCells(deck, fila, columna, rowSpan, colSpan, {}, connection);

    const [creado] = await connection.query(
      'INSERT INTO bus_layout_elements (deck_id, element_type, row_number, column_number, row_span, col_span, label) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [deckId, tipo, fila, columna, rowSpan, colSpan, input.label ?? null],
    );
    const elemento = await first<BusLayoutElement>(
      connection,
      'SELECT id, deck_id, element_type, row_number, column_number, row_span, col_span, label FROM bus_layout_elements WHERE id = ?',
      [(creado as { insertId: number }).insertId],
    );
    if (!elemento) throw ApiError.badRequest('No se pudo crear el elemento');
    return elemento;
  });
}

/**
 * Mueve, redimensiona o renombra un elemento. Mismo trato que `createElement`: la
 * comprobacion de la casilla y la escritura ocurren bajo el cerrojo del bus y en la misma
 * transaccion, de modo que no se valide contra un piso que ya cambio.
 *
 * Los valores que no llegan en la peticion se toman del elemento RELEIDO dentro de la
 * transaccion, no de la primera lectura: si otro cambio lo movio entretanto, se parte de
 * donde esta de verdad.
 */
export async function updateElement(elementId: number, input: ElementInput): Promise<BusLayoutElement> {
  const previo = await queryOne<{ deck_id: number }>('SELECT deck_id FROM bus_layout_elements WHERE id = ? LIMIT 1', [elementId]);
  if (!previo) throw ApiError.notFound('Elemento no encontrado');
  const { layout } = await deckInDraft(previo.deck_id);

  // Lo que no depende del estado de la base se valida antes de pedir el cerrojo.
  const tipoPedido = input.element_type === undefined ? null : assertElementType(input.element_type);
  const rowSpanPedido = input.row_span === undefined ? null : assertSpan(Number(input.row_span), 'La altura');
  const colSpanPedido = input.col_span === undefined ? null : assertSpan(Number(input.col_span), 'La anchura');

  return withTransaction(async (connection) => {
    await lockBus(connection, layout.bus_id);

    const actual = await first<BusLayoutElement>(
      connection,
      'SELECT id, deck_id, element_type, row_number, column_number, row_span, col_span, label FROM bus_layout_elements WHERE id = ?',
      [elementId],
    );
    if (!actual) throw ApiError.notFound('Elemento no encontrado');

    const deck = await first<BusLayoutDeck>(
      connection,
      'SELECT id, layout_id, deck_number, name, row_count, column_count FROM bus_layout_decks WHERE id = ?',
      [actual.deck_id],
    );
    if (!deck) throw ApiError.notFound('Piso no encontrado');
    await assertDraftOnConnection(connection, deck.layout_id);

    const tipo = tipoPedido ?? actual.element_type;
    const fila = input.row_number === undefined ? actual.row_number : Number(input.row_number);
    const columna = input.column_number === undefined ? actual.column_number : Number(input.column_number);
    const rowSpan = rowSpanPedido ?? actual.row_span;
    const colSpan = colSpanPedido ?? actual.col_span;

    await assertFreeCells(deck, fila, columna, rowSpan, colSpan, { elementId }, connection);

    await connection.query(
      'UPDATE bus_layout_elements SET element_type = ?, row_number = ?, column_number = ?, row_span = ?, col_span = ?, label = ? WHERE id = ?',
      [tipo, fila, columna, rowSpan, colSpan, input.label === undefined ? actual.label : input.label, elementId],
    );
    const elemento = await first<BusLayoutElement>(
      connection,
      'SELECT id, deck_id, element_type, row_number, column_number, row_span, col_span, label FROM bus_layout_elements WHERE id = ?',
      [elementId],
    );
    if (!elemento) throw ApiError.notFound('Elemento no encontrado');
    return elemento;
  });
}

export async function deleteElement(elementId: number): Promise<void> {
  const actual = await queryOne<{ id: number; deck_id: number }>('SELECT id, deck_id FROM bus_layout_elements WHERE id = ? LIMIT 1', [
    elementId,
  ]);
  if (!actual) throw ApiError.notFound('Elemento no encontrado');
  await deckInDraft(actual.deck_id);

  await withTransaction(async (connection) => {
    await connection.query('DELETE FROM bus_layout_elements WHERE id = ?', [elementId]);
  });
}

// --------------------------------------------------------------- asientos

export interface SeatInput {
  seat_type_id?: number | null;
  seat_number?: string;
  row_number?: number | null;
  column_number?: number | null;
  is_window?: boolean | number;
  is_aisle?: boolean | number;
  status?: string;
  /** Solo al editar: mover el asiento a otro piso DE LA MISMA versión. */
  deck_id?: number;
}

export async function listSeats(deckId: number): Promise<LayoutSeat[]> {
  return query<LayoutSeat>(
    `SELECT s.id, s.deck_id, s.seat_type_id, st.name AS seat_type_name, s.seat_number,
            s.row_number, s.column_number, s.is_window, s.is_aisle, s.status
     FROM seats s LEFT JOIN seat_types st ON st.id = s.seat_type_id
     WHERE s.deck_id = ? ORDER BY s.row_number ASC, s.column_number ASC, s.seat_number ASC`,
    [deckId],
  );
}

const SEAT_STATUSES = ['AVAILABLE', 'INACTIVE'] as const;

function assertSeatStatus(value: unknown): 'AVAILABLE' | 'INACTIVE' {
  if (!SEAT_STATUSES.includes(value as 'AVAILABLE')) {
    throw ApiError.badRequest(`Estado de asiento no admitido. Válidos: ${SEAT_STATUSES.join(', ')}`);
  }
  return value as 'AVAILABLE' | 'INACTIVE';
}

async function assertSeatType(seatTypeId: number | null | undefined): Promise<number | null> {
  if (seatTypeId === null || seatTypeId === undefined) return null;
  const tipo = await queryOne<{ id: number }>('SELECT id FROM seat_types WHERE id = ? LIMIT 1', [seatTypeId]);
  if (!tipo) throw ApiError.badRequest('El tipo de asiento no existe');
  return tipo.id;
}

/** El número no puede repetirse dentro de la versión; es lo que `uq_layout_seat_number` exige. */
async function assertSeatNumberFree(
  layoutId: number,
  seatNumber: string,
  excluirId?: number,
  connection: PoolConnection | null = null,
): Promise<void> {
  const repetidos = await readRows<{ id: number }>(
    connection,
    'SELECT id FROM seats WHERE layout_id = ? AND seat_number = ? AND (? IS NULL OR id <> ?) LIMIT 1',
    [layoutId, seatNumber, excluirId ?? null, excluirId ?? 0],
  );
  if (repetidos.length > 0) throw ApiError.badRequest(`Esta versión ya tiene un asiento ${seatNumber}`);
}

/**
 * Crea un asiento en un piso.
 *
 * MISMO TRATO QUE LOS ELEMENTOS (auditoria 6F, hallazgo H-07). La casilla se comprobaba por
 * el pool y el asiento se insertaba despues en otra transaccion: entre las dos cosas cabia
 * otro asiento en la misma casilla, un elemento encima, o un encogimiento del piso que dejaba
 * este fuera de la rejilla. Ahora la comprobacion y la escritura van juntas, detras del
 * cerrojo del BUS, que es el unico que toma este servicio y siempre el primero.
 */
export async function createSeat(deckId: number, input: SeatInput): Promise<LayoutSeat> {
  const { layout } = await deckInDraft(deckId);

  // Lo que no depende del estado de la base se valida antes de pedir el cerrojo.
  const numero = String(input.seat_number ?? '').trim();
  if (!numero) throw ApiError.badRequest('El asiento necesita un número');
  if (numero.length > 10) throw ApiError.badRequest('El número de asiento no puede pasar de 10 caracteres');
  const estado = input.status === undefined ? 'AVAILABLE' : assertSeatStatus(input.status);
  const fila = Number(input.row_number);
  const columna = Number(input.column_number);
  if (!Number.isInteger(fila) || !Number.isInteger(columna)) {
    throw ApiError.badRequest('Hay que indicar fila y columna');
  }
  const tipo = await assertSeatType(input.seat_type_id);

  return withTransaction(async (connection) => {
    await lockBus(connection, layout.bus_id);

    // El piso se relee tras el cerrojo: su rejilla pudo cambiar mientras se esperaba.
    const deck = await first<BusLayoutDeck>(
      connection,
      'SELECT id, layout_id, deck_number, name, row_count, column_count FROM bus_layout_decks WHERE id = ?',
      [deckId],
    );
    if (!deck) throw ApiError.notFound('Piso no encontrado');
    const vigente = await assertDraftOnConnection(connection, deck.layout_id);

    await assertSeatNumberFree(vigente.id, numero, undefined, connection);
    await assertFreeCells(deck, fila, columna, 1, 1, {}, connection);

    // `bus_id` y `layout_id` los pone el servidor a partir de la versión: no llegan del
    // cliente, de modo que un asiento no puede acabar en el bus ni en la versión de otro.
    const [creado] = await connection.query(
      `INSERT INTO seats (bus_id, layout_id, deck_id, seat_type_id, seat_number, row_number, column_number, is_window, is_aisle, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        layout.bus_id,
        layout.id,
        deckId,
        tipo,
        numero,
        fila,
        columna,
        input.is_window ? 1 : 0,
        input.is_aisle ? 1 : 0,
        estado,
      ],
    );
    await syncSeatCount(connection, layout.id);

    const asiento = await first<LayoutSeat>(
      connection,
      `SELECT s.id, s.deck_id, s.seat_type_id, NULL AS seat_type_name, s.seat_number,
              s.row_number, s.column_number, s.is_window, s.is_aisle, s.status
       FROM seats s WHERE s.id = ?`,
      [(creado as { insertId: number }).insertId],
    );
    if (!asiento) throw ApiError.badRequest('No se pudo crear el asiento');
    return asiento;
  });
}

interface SeatRow {
  id: number;
  bus_id: number;
  layout_id: number | null;
  deck_id: number | null;
  seat_type_id: number | null;
  seat_number: string;
  row_number: number | null;
  column_number: number | null;
  is_window: 0 | 1;
  is_aisle: 0 | 1;
  status: 'AVAILABLE' | 'INACTIVE';
}

const SEAT_ROW_SELECT = `SELECT id, bus_id, layout_id, deck_id, seat_type_id, seat_number, row_number, column_number,
            is_window, is_aisle, status
     FROM seats`;

/**
 * Mueve, renumera o cambia un asiento. Mismo trato que `createSeat`.
 *
 * El estado final se construye sobre el asiento RELEIDO dentro de la transaccion, no sobre la
 * primera lectura: los campos que la peticion no trae salen de donde el asiento esta de
 * verdad, no de donde estaba antes de esperar el cerrojo.
 */
export async function updateSeat(seatId: number, input: SeatInput): Promise<LayoutSeat> {
  const previo = await queryOne<SeatRow>(`${SEAT_ROW_SELECT} WHERE id = ? LIMIT 1`, [seatId]);
  if (!previo) throw ApiError.notFound('Asiento no encontrado');
  if (previo.layout_id === null) throw ApiError.badRequest('Este asiento no pertenece a ninguna versión de distribución');
  const layoutPrevio = await assertEditable(previo.layout_id);

  // Lo que no depende del estado de la base se valida antes de pedir el cerrojo.
  const estadoPedido = input.status === undefined ? null : assertSeatStatus(input.status);
  const tipoPedido = input.seat_type_id === undefined ? null : await assertSeatType(input.seat_type_id);

  return withTransaction(async (connection) => {
    await lockBus(connection, layoutPrevio.bus_id);

    const actual = await first<SeatRow>(connection, `${SEAT_ROW_SELECT} WHERE id = ?`, [seatId]);
    if (!actual) throw ApiError.notFound('Asiento no encontrado');
    if (actual.layout_id === null) throw ApiError.badRequest('Este asiento no pertenece a ninguna versión de distribución');
    const layout = await assertDraftOnConnection(connection, actual.layout_id);

    // Mover de piso sí, de versión o de bus nunca: `layout_id` y `bus_id` ni se leen del
    // cuerpo. Un piso de otra versión se rechaza explícitamente.
    const deckId = input.deck_id === undefined ? actual.deck_id : Number(input.deck_id);
    if (deckId === null) throw ApiError.badRequest('El asiento debe pertenecer a un piso');
    const deck = await first<BusLayoutDeck>(
      connection,
      'SELECT id, layout_id, deck_number, name, row_count, column_count FROM bus_layout_decks WHERE id = ?',
      [deckId],
    );
    if (!deck) throw ApiError.notFound('Piso no encontrado');
    if (deck.layout_id !== layout.id) throw ApiError.badRequest('El piso pertenece a otra versión');

    const numero = input.seat_number === undefined ? actual.seat_number : String(input.seat_number).trim();
    if (!numero) throw ApiError.badRequest('El asiento necesita un número');
    if (numero !== actual.seat_number) await assertSeatNumberFree(layout.id, numero, seatId, connection);

    const tipo = input.seat_type_id === undefined ? actual.seat_type_id : tipoPedido;
    const estado = estadoPedido ?? actual.status;
    const fila = input.row_number === undefined ? actual.row_number : Number(input.row_number);
    const columna = input.column_number === undefined ? actual.column_number : Number(input.column_number);
    if (fila === null || columna === null || !Number.isInteger(fila) || !Number.isInteger(columna)) {
      throw ApiError.badRequest('Hay que indicar fila y columna');
    }
    await assertFreeCells(deck, fila, columna, 1, 1, { seatId }, connection);

    await connection.query(
      `UPDATE seats SET deck_id = ?, seat_type_id = ?, seat_number = ?, row_number = ?, column_number = ?,
              is_window = ?, is_aisle = ?, status = ?
       WHERE id = ?`,
      [
        deckId,
        tipo,
        numero,
        fila,
        columna,
        input.is_window === undefined ? actual.is_window : input.is_window ? 1 : 0,
        input.is_aisle === undefined ? actual.is_aisle : input.is_aisle ? 1 : 0,
        estado,
        seatId,
      ],
    );
    // Activar o desactivar un asiento cambia cuántas plazas se pueden vender. Antes no hacía
    // falta recontar aquí porque el total físico no se movía; con `seat_count` vendible, sí.
    await syncSeatCount(connection, layout.id);
    const asiento = await first<LayoutSeat>(
      connection,
      `SELECT s.id, s.deck_id, s.seat_type_id, NULL AS seat_type_name, s.seat_number,
              s.row_number, s.column_number, s.is_window, s.is_aisle, s.status
       FROM seats s WHERE s.id = ?`,
      [seatId],
    );
    if (!asiento) throw ApiError.notFound('Asiento no encontrado');
    return asiento;
  });
}

/**
 * Borra un asiento de un borrador.
 *
 * Se comprueba antes que no tenga ventas. En teoría un borrador no debería tener ninguna
 * —sus asientos son filas nuevas que ningún viaje ha usado todavía—, pero la comprobación no
 * sobra: un asiento vendido no se borra jamás, y decirlo con palabras es mejor que dejar que
 * salte la clave ajena de `booking_seats` con un error de motor.
 */
export async function deleteSeat(seatId: number): Promise<void> {
  const actual = await queryOne<{ id: number; layout_id: number | null }>('SELECT id, layout_id FROM seats WHERE id = ? LIMIT 1', [
    seatId,
  ]);
  if (!actual) throw ApiError.notFound('Asiento no encontrado');
  if (actual.layout_id === null) throw ApiError.badRequest('Este asiento no pertenece a ninguna versión de distribución');
  const layout = await assertEditable(actual.layout_id);

  const vendido = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM booking_seats WHERE seat_id = ?', [seatId]);
  if (Number(vendido?.total ?? 0) > 0) {
    throw ApiError.badRequest('El asiento tiene reservas asociadas y no se puede eliminar');
  }

  await withTransaction(async (connection) => {
    await connection.query('DELETE FROM seats WHERE id = ?', [seatId]);
    await syncSeatCount(connection, layout.id);
  });
}
