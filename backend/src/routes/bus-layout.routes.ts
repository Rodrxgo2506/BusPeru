import { Router } from 'express';
import { queryOne } from '../config/database';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { recordAudit } from '../services/audit.service';
import * as layouts from '../services/bus-layout.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendSuccess } from '../utils/http';
import { parseId } from '../utils/query';

/**
 * Versiones de distribución física de un bus (migración 010).
 *
 * PERMISOS REUTILIZADOS, NINGUNO NUEVO. La distribución es dato maestro de la flota, igual
 * que los asientos y los conductores, así que sigue el mismo mapeo que ya usaban:
 *   · Leer     → `buses.view`   (ADMIN, COMPANY_ADMIN, OPERATOR)
 *   · Escribir → `buses.update` (ADMIN, COMPANY_ADMIN)
 *
 * OPERATOR conserva exactamente lo que tenía: consulta las versiones para operar, y no puede
 * crearlas, clonarlas ni publicarlas.
 *
 * LA EMPRESA LA DECIDE EL SERVIDOR. `company_id` no se acepta del cliente en ninguna de estas
 * rutas: se deduce del bus, y se comprueba contra las empresas de quien pide. Un bus ajeno
 * responde 403 y nunca deja ver ni tocar nada.
 *
 * ALCANCE. Solo lo imprescindible para el versionado: crear un borrador, clonar y publicar.
 * El CRUD de pisos, elementos y asientos del editor llega en la fase siguiente; las reglas
 * que lo gobernarán (`assertEditable`) ya están en el servicio.
 */
/**
 * DOS ROUTERS, NINGUNO EN LA RAIZ. Montar un router con `authenticate` en `/` haria que
 * TODA peticion pasara por el, y una ruta inexistente devolveria 401 en vez de 404 —y la
 * superficie de integracion con API Key dejaria de responder—. Cada uno se monta bajo su
 * propio prefijo y deja pasar lo que no le toca.
 */
const busesRouter = Router();
busesRouter.use(authenticate);

const layoutsRouter = Router();
layoutsRouter.use(authenticate);

/** Comprueba que el bus existe y es de una empresa de quien pide. ADMIN pasa siempre. */
async function assertBusOwnership(req: Parameters<typeof requireAuth>[0], busId: number): Promise<void> {
  const user = requireAuth(req);
  const bus = await queryOne<{ company_id: number }>('SELECT company_id FROM buses WHERE id = ?', [busId]);
  if (!bus) throw ApiError.notFound('Bus no encontrado');
  if (user.role === 'ADMIN') return;
  // 404 y no 403 cuando el bus es de otra empresa sería lo habitual en este proyecto para
  // recursos ajenos; aquí el bus lo elige la propia empresa en su panel, así que un 403
  // explica mejor lo que pasa sin revelar nada que no supiera ya.
  if (!user.companyIds.includes(bus.company_id)) throw ApiError.forbidden('El bus pertenece a otra empresa');
}

/** Igual, pero partiendo de la versión. */
async function assertLayoutOwnership(req: Parameters<typeof requireAuth>[0], layoutId: number): Promise<layouts.BusLayout> {
  const layout = await layouts.getLayout(layoutId);
  if (!layout) throw ApiError.notFound('Versión no encontrada');
  await assertBusOwnership(req, layout.bus_id);
  return layout;
}

busesRouter.get(
  '/:id/layouts',
  requirePermission('buses.view'),
  asyncHandler(async (req, res) => {
    const busId = parseId(req.params.id);
    await assertBusOwnership(req, busId);
    sendSuccess(res, await layouts.listLayouts(busId));
  }),
);

layoutsRouter.get(
  '/:id',
  requirePermission('buses.view'),
  asyncHandler(async (req, res) => {
    const layoutId = parseId(req.params.id);
    await assertLayoutOwnership(req, layoutId);
    sendSuccess(res, await layouts.getLayoutTree(layoutId));
  }),
);

busesRouter.post(
  '/:id/layouts',
  requirePermission('buses.update'),
  asyncHandler(async (req, res) => {
    const busId = parseId(req.params.id);
    await assertBusOwnership(req, busId);

    // Del cuerpo solo se lee el nombre y los pisos iniciales. Ni `status`, ni `version`, ni
    // `bus_id`, ni `published_scope`: esos los fija el servicio.
    const body = req.body as { name?: string; decks?: layouts.DraftInput['decks'] };
    const layout = await layouts.createDraft(busId, { name: body.name ?? null, decks: body.decks });

    await recordAudit(req, {
      action: 'CREATE',
      entityType: 'bus_layouts',
      entityId: layout.id,
      description: `Creó la versión ${layout.version} del bus ${busId}`,
    });
    sendSuccess(res, layout, 201);
  }),
);

layoutsRouter.post(
  '/:id/clone',
  requirePermission('buses.update'),
  asyncHandler(async (req, res) => {
    const layoutId = parseId(req.params.id);
    const origen = await assertLayoutOwnership(req, layoutId);

    const clon = await layouts.cloneForEdit(layoutId);

    await recordAudit(req, {
      action: 'CREATE',
      entityType: 'bus_layouts',
      entityId: clon.id,
      description: `Clonó la versión ${origen.version} en la ${clon.version}`,
    });
    sendSuccess(res, clon, 201);
  }),
);

layoutsRouter.post(
  '/:id/publish',
  requirePermission('buses.update'),
  asyncHandler(async (req, res) => {
    const layoutId = parseId(req.params.id);
    await assertLayoutOwnership(req, layoutId);

    const publicado = await layouts.publishLayout(layoutId);

    await recordAudit(req, {
      action: 'UPDATE',
      entityType: 'bus_layouts',
      entityId: publicado.id,
      description: `Publicó la versión ${publicado.version} del bus ${publicado.bus_id}`,
    });
    sendSuccess(res, publicado);
  }),
);

layoutsRouter.delete(
  '/:id',
  requirePermission('buses.delete'),
  asyncHandler(async (req, res) => {
    const layoutId = parseId(req.params.id);
    const layout = await assertLayoutOwnership(req, layoutId);

    await layouts.deleteDraft(layoutId);

    await recordAudit(req, {
      action: 'DELETE',
      entityType: 'bus_layouts',
      entityId: layoutId,
      description: `Eliminó el borrador de versión ${layout.version}`,
    });
    sendSuccess(res, { deleted: true });
  }),
);

// ===========================================================================
// Editor de la versión: pisos, elementos y asientos
// ===========================================================================
//
// LOS ASIENTOS VIVEN EN `/layout-seats/:id`. El prefijo nació para no chocar con el recurso
// genérico `/seats`, que ya no existe: se retiró porque ninguna pantalla lo usaba y dejaba
// leer asientos de cualquier empresa (auditoría FASE 7, hallazgo H-16). Un asiento se lee y
// se administra siempre a través de su versión de distribución.
//
// La versión a la que pertenece cada cosa se resuelve hacia arriba —asiento → piso → versión
// → bus → empresa— y se contrasta con las empresas de quien pide. El cliente no envía nunca
// `company_id`, ni `layout_id`, ni `bus_id`.

const decksRouter = Router();
decksRouter.use(authenticate);

const elementsRouter = Router();
elementsRouter.use(authenticate);

const seatsRouter = Router();
seatsRouter.use(authenticate);

/** Comprueba la propiedad del piso subiendo hasta la empresa del bus. */
async function assertDeckOwnership(req: Parameters<typeof requireAuth>[0], deckId: number): Promise<layouts.BusLayoutDeck> {
  const deck = await queryOne<layouts.BusLayoutDeck>(
    'SELECT id, layout_id, deck_number, name, row_count, column_count FROM bus_layout_decks WHERE id = ? LIMIT 1',
    [deckId],
  );
  if (!deck) throw ApiError.notFound('Piso no encontrado');
  await assertLayoutOwnership(req, deck.layout_id);
  return deck;
}

async function assertElementOwnership(req: Parameters<typeof requireAuth>[0], elementId: number): Promise<void> {
  const elemento = await queryOne<{ deck_id: number }>('SELECT deck_id FROM bus_layout_elements WHERE id = ? LIMIT 1', [elementId]);
  if (!elemento) throw ApiError.notFound('Elemento no encontrado');
  await assertDeckOwnership(req, elemento.deck_id);
}

async function assertSeatOwnership(req: Parameters<typeof requireAuth>[0], seatId: number): Promise<void> {
  const asiento = await queryOne<{ layout_id: number | null }>('SELECT layout_id FROM seats WHERE id = ? LIMIT 1', [seatId]);
  if (!asiento) throw ApiError.notFound('Asiento no encontrado');
  if (asiento.layout_id === null) throw ApiError.badRequest('Este asiento no pertenece a ninguna versión de distribución');
  await assertLayoutOwnership(req, asiento.layout_id);
}

// ------------------------------------------------------------------ pisos

layoutsRouter.get(
  '/:id/decks',
  requirePermission('buses.view'),
  asyncHandler(async (req, res) => {
    const layoutId = parseId(req.params.id);
    await assertLayoutOwnership(req, layoutId);
    sendSuccess(res, await layouts.listDecks(layoutId));
  }),
);

layoutsRouter.post(
  '/:id/decks',
  requirePermission('buses.update'),
  asyncHandler(async (req, res) => {
    const layoutId = parseId(req.params.id);
    await assertLayoutOwnership(req, layoutId);

    const deck = await layouts.createDeck(layoutId, req.body as layouts.DeckInput);
    await recordAudit(req, {
      action: 'CREATE',
      entityType: 'bus_layout_decks',
      entityId: deck.id,
      description: `Añadió el piso ${deck.deck_number} a la versión ${layoutId}`,
    });
    sendSuccess(res, deck, 201);
  }),
);

decksRouter.patch(
  '/:id',
  requirePermission('buses.update'),
  asyncHandler(async (req, res) => {
    const deckId = parseId(req.params.id);
    await assertDeckOwnership(req, deckId);

    const deck = await layouts.updateDeck(deckId, req.body as layouts.DeckInput);
    await recordAudit(req, { action: 'UPDATE', entityType: 'bus_layout_decks', entityId: deckId, description: 'Editó un piso' });
    sendSuccess(res, deck);
  }),
);

decksRouter.delete(
  '/:id',
  requirePermission('buses.delete'),
  asyncHandler(async (req, res) => {
    const deckId = parseId(req.params.id);
    await assertDeckOwnership(req, deckId);

    await layouts.deleteDeck(deckId);
    await recordAudit(req, { action: 'DELETE', entityType: 'bus_layout_decks', entityId: deckId, description: 'Eliminó un piso' });
    sendSuccess(res, { deleted: true });
  }),
);

// -------------------------------------------------------------- elementos

decksRouter.get(
  '/:id/elements',
  requirePermission('buses.view'),
  asyncHandler(async (req, res) => {
    const deckId = parseId(req.params.id);
    await assertDeckOwnership(req, deckId);
    sendSuccess(res, await layouts.listElements(deckId));
  }),
);

decksRouter.post(
  '/:id/elements',
  requirePermission('buses.update'),
  asyncHandler(async (req, res) => {
    const deckId = parseId(req.params.id);
    await assertDeckOwnership(req, deckId);

    const elemento = await layouts.createElement(deckId, req.body as layouts.ElementInput);
    await recordAudit(req, {
      action: 'CREATE',
      entityType: 'bus_layout_elements',
      entityId: elemento.id,
      description: `Añadió un elemento ${elemento.element_type}`,
    });
    sendSuccess(res, elemento, 201);
  }),
);

elementsRouter.patch(
  '/:id',
  requirePermission('buses.update'),
  asyncHandler(async (req, res) => {
    const elementId = parseId(req.params.id);
    await assertElementOwnership(req, elementId);

    const elemento = await layouts.updateElement(elementId, req.body as layouts.ElementInput);
    await recordAudit(req, { action: 'UPDATE', entityType: 'bus_layout_elements', entityId: elementId, description: 'Editó un elemento' });
    sendSuccess(res, elemento);
  }),
);

elementsRouter.delete(
  '/:id',
  requirePermission('buses.delete'),
  asyncHandler(async (req, res) => {
    const elementId = parseId(req.params.id);
    await assertElementOwnership(req, elementId);

    await layouts.deleteElement(elementId);
    await recordAudit(req, { action: 'DELETE', entityType: 'bus_layout_elements', entityId: elementId, description: 'Eliminó un elemento' });
    sendSuccess(res, { deleted: true });
  }),
);

// --------------------------------------------------------------- asientos

decksRouter.get(
  '/:id/seats',
  requirePermission('buses.view'),
  asyncHandler(async (req, res) => {
    const deckId = parseId(req.params.id);
    await assertDeckOwnership(req, deckId);
    sendSuccess(res, await layouts.listSeats(deckId));
  }),
);

decksRouter.post(
  '/:id/seats',
  requirePermission('buses.update'),
  asyncHandler(async (req, res) => {
    const deckId = parseId(req.params.id);
    await assertDeckOwnership(req, deckId);

    const asiento = await layouts.createSeat(deckId, req.body as layouts.SeatInput);
    await recordAudit(req, {
      action: 'CREATE',
      entityType: 'seats',
      entityId: asiento.id,
      description: `Añadió el asiento ${asiento.seat_number}`,
    });
    sendSuccess(res, asiento, 201);
  }),
);

seatsRouter.patch(
  '/:id',
  requirePermission('buses.update'),
  asyncHandler(async (req, res) => {
    const seatId = parseId(req.params.id);
    await assertSeatOwnership(req, seatId);

    const asiento = await layouts.updateSeat(seatId, req.body as layouts.SeatInput);
    await recordAudit(req, { action: 'UPDATE', entityType: 'seats', entityId: seatId, description: 'Editó un asiento' });
    sendSuccess(res, asiento);
  }),
);

seatsRouter.delete(
  '/:id',
  requirePermission('buses.delete'),
  asyncHandler(async (req, res) => {
    const seatId = parseId(req.params.id);
    await assertSeatOwnership(req, seatId);

    await layouts.deleteSeat(seatId);
    await recordAudit(req, { action: 'DELETE', entityType: 'seats', entityId: seatId, description: 'Eliminó un asiento' });
    sendSuccess(res, { deleted: true });
  }),
);

export {
  busesRouter as busLayoutsOfBusRouter,
  layoutsRouter as busLayoutsRouter,
  decksRouter as layoutDecksRouter,
  elementsRouter as layoutElementsRouter,
  seatsRouter as layoutSeatsRouter,
};
