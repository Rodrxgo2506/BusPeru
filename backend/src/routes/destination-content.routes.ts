import { Router, type RequestHandler } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission, requireRole } from '../middleware/permission.middleware';
import { receiveSingleFile } from '../middleware/upload.middleware';
import { validate } from '../middleware/validate.middleware';
import * as content from '../services/destination-content.service';
import { isBrandingAsset, MAX_IMAGE_BYTES, type UploadedFile } from '../services/file-storage.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendSuccess } from '../utils/http';
import { parseId } from '../utils/query';
import { reorderChildrenSchema, reorderSchema } from '../validators/destination.validators';

/**
 * Operaciones del contenido de destinos que el CRUD genérico no cubre (FASE 17): imágenes,
 * orden en bloque e identidad visual.
 *
 * Mismo control que el CRUD de esas tablas: `settings.update` Y rol ADMIN. La autenticación va
 * en cada ruta y no en `router.use`, porque estos routers comparten prefijo con el CRUD genérico
 * y las peticiones que no casan aquí siguen hacia él (que ya autentica por su cuenta).
 */

const adminWrite: RequestHandler[] = [authenticate, requirePermission('settings.update'), requireRole('ADMIN')];
const receiveImage = receiveSingleFile(MAX_IMAGE_BYTES);
const uploaded = (file: unknown) => file as UploadedFile | undefined;

/* ------------------------------------------------------------------ /destinations */
export const destinationExtrasRouter = Router();

destinationExtrasRouter.post(
  '/reorder',
  ...adminWrite,
  validate(reorderSchema),
  asyncHandler(async (req, res) => {
    await content.reorderDestinations(req, (req.body as { ids: number[] }).ids);
    sendSuccess(res, { reordered: true });
  }),
);

destinationExtrasRouter.post(
  '/:id/image',
  ...adminWrite,
  receiveImage,
  asyncHandler(async (req, res) => {
    sendSuccess(res, await content.setDestinationImage(req, parseId(req.params.id), uploaded(req.file)));
  }),
);

/** FASE 17B · imagen de la sección «Calendario festivo» del destino. */
destinationExtrasRouter.post(
  '/:id/festivities-image',
  ...adminWrite,
  receiveImage,
  asyncHandler(async (req, res) => {
    sendSuccess(res, await content.setFestivitiesImage(req, parseId(req.params.id), uploaded(req.file)));
  }),
);

destinationExtrasRouter.delete(
  '/:id/festivities-image',
  ...adminWrite,
  asyncHandler(async (req, res) => {
    sendSuccess(res, await content.removeFestivitiesImage(req, parseId(req.params.id)));
  }),
);

destinationExtrasRouter.delete(
  '/:id/image',
  ...adminWrite,
  asyncHandler(async (req, res) => {
    sendSuccess(res, await content.removeDestinationImage(req, parseId(req.params.id)));
  }),
);

/* ------------------------------------------------------------------ /destination-attractions */
export const attractionExtrasRouter = Router();

attractionExtrasRouter.post(
  '/reorder',
  ...adminWrite,
  validate(reorderChildrenSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as { destination_id: number; ids: number[] };
    await content.reorderChildren(req, 'destination_attractions', body.destination_id, body.ids);
    sendSuccess(res, { reordered: true });
  }),
);

attractionExtrasRouter.post(
  '/:id/image',
  ...adminWrite,
  receiveImage,
  asyncHandler(async (req, res) => {
    sendSuccess(res, await content.setAttractionImage(req, parseId(req.params.id), uploaded(req.file)));
  }),
);

attractionExtrasRouter.delete(
  '/:id/image',
  ...adminWrite,
  asyncHandler(async (req, res) => {
    sendSuccess(res, await content.removeAttractionImage(req, parseId(req.params.id)));
  }),
);

/* ------------------------------------------------------------------ /destination-festivities */
export const festivityExtrasRouter = Router();

festivityExtrasRouter.post(
  '/reorder',
  ...adminWrite,
  validate(reorderChildrenSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as { destination_id: number; ids: number[] };
    await content.reorderChildren(req, 'destination_festivities', body.destination_id, body.ids);
    sendSuccess(res, { reordered: true });
  }),
);

/* ------------------------------------------------------------------ /admin/branding */
export const brandingAdminRouter = Router();
brandingAdminRouter.use(authenticate, requireRole('ADMIN'));

function brandingAsset(value: unknown) {
  if (!isBrandingAsset(value)) throw ApiError.notFound('Elemento de identidad visual no encontrado');
  return value;
}

brandingAdminRouter.get(
  '/',
  requirePermission('settings.view'),
  asyncHandler(async (_req, res) => {
    sendSuccess(res, await content.readBranding());
  }),
);

brandingAdminRouter.post(
  '/:asset',
  requirePermission('settings.update'),
  (req, _res, next) => {
    try {
      brandingAsset(req.params.asset);
      next();
    } catch (error) {
      next(error);
    }
  },
  receiveImage,
  asyncHandler(async (req, res) => {
    sendSuccess(res, await content.setBrandingAsset(req, brandingAsset(req.params.asset), uploaded(req.file)));
  }),
);

brandingAdminRouter.delete(
  '/:asset',
  requirePermission('settings.update'),
  asyncHandler(async (req, res) => {
    sendSuccess(res, await content.removeBrandingAsset(req, brandingAsset(req.params.asset)));
  }),
);
