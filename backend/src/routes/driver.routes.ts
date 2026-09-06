import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import * as drivers from '../services/driver.service';
import { asyncHandler, sendSuccess } from '../utils/http';
import { parseId } from '../utils/query';
import { createDriverSchema, updateDriverSchema } from '../validators/driver.validators';

/**
 * Conductores y copilotos de la empresa (mockup 31).
 *
 * Permisos reutilizados, ninguno nuevo. El personal de conducción es dato maestro de la
 * flota, igual que los asientos y los tipos de bus, así que sigue el mismo mapeo:
 *   · Leer    → `buses.view`   (ADMIN, COMPANY_ADMIN, OPERATOR)
 *   · Escribir → `buses.create` / `buses.update` / `buses.delete` (ADMIN, COMPANY_ADMIN)
 *
 * OPERATOR conserva exactamente sus permisos: puede consultar la plantilla para operar los
 * viajes, pero no darla de alta ni modificarla.
 *
 * La asignación al viaje NO vive aquí: se hace con el `PUT /trips/:id` que ya existía,
 * gobernado por `trips.update`.
 */
const router = Router();
router.use(authenticate);

/** La auditoría identifica a la persona sin volcar su documento ni su teléfono. */
function label(driver: { first_name: string; last_name: string }): string {
  return `${driver.first_name} ${driver.last_name}`;
}

router.get(
  '/',
  requirePermission('buses.view'),
  asyncHandler(async (req, res) => {
    const { company_id, status, search } = req.query;
    sendSuccess(res, await drivers.list(req, { company_id, status, search }));
  }),
);

router.get(
  '/:id',
  requirePermission('buses.view'),
  asyncHandler(async (req, res) => {
    sendSuccess(res, await drivers.detail(req, parseId(req.params.id)));
  }),
);

router.post(
  '/',
  requirePermission('buses.create'),
  validate(createDriverSchema),
  asyncHandler(async (req, res) => {
    const { driver, companyId } = await drivers.create(req, req.body as Record<string, unknown>);

    await recordAudit(req, {
      action: 'CREATE',
      entityType: 'drivers',
      entityId: driver.id,
      description: `Registró al conductor ${label(driver)} (empresa ${companyId})`,
    });

    sendSuccess(res, driver, 201);
  }),
);

router.put(
  '/:id',
  requirePermission('buses.update'),
  validate(updateDriverSchema),
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const { driver, previous, companyId } = await drivers.update(req, id, req.body as Record<string, unknown>);

    await recordAudit(req, {
      action: 'UPDATE',
      entityType: 'drivers',
      entityId: id,
      description: `Actualizó al conductor ${label(previous)} (empresa ${companyId})`,
      // `document_number`, `license_number` y `phone` se omiten a propósito: la auditoría
      // registra el cambio, no los datos personales de la persona.
      oldValues: { first_name: previous.first_name, last_name: previous.last_name, status: previous.status },
      newValues: { first_name: driver.first_name, last_name: driver.last_name, status: driver.status },
    });

    sendSuccess(res, driver);
  }),
);

router.delete(
  '/:id',
  requirePermission('buses.delete'),
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const { previous, companyId } = await drivers.remove(req, id);

    await recordAudit(req, {
      action: 'DELETE',
      entityType: 'drivers',
      entityId: id,
      description: `Eliminó al conductor ${label(previous)} (empresa ${companyId})`,
    });

    sendSuccess(res, { id });
  }),
);

export default router;
