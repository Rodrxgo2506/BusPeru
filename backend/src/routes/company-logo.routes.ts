import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { receiveSingleFile } from '../middleware/upload.middleware';
import * as logos from '../services/company-logo.service';
import { MAX_LOGO_BYTES, type UploadedFile } from '../services/file-storage.service';
import { asyncHandler, sendSuccess } from '../utils/http';

/**
 * Logotipo de la empresa (F17C-COMPANY-LOGO-01).
 *
 * Permisos reutilizados, ninguno nuevo:
 *   · Leer     → `companies.view`   (ADMIN, COMPANY_ADMIN, OPERATOR, CUSTOMER)
 *   · Escribir → `companies.update` (ADMIN, COMPANY_ADMIN)
 *
 * No hay id de empresa en la ruta **a propósito**: el servicio la toma de la sesión, así que un rol
 * de empresa solo puede tocar la suya. Un ADMIN puede indicar otra con `?company_id=`.
 *
 * El archivo se sirve por el canal público de siempre (`GET /public/media/<referencia>`): un
 * logotipo es información pública, igual que el nombre de la empresa.
 */
const router = Router();
router.use(authenticate);

/** Primera barrera del archivo: ver `upload.middleware.ts`. El almacén vuelve a validarlo. */
const receiveLogo = receiveSingleFile(MAX_LOGO_BYTES);

router.get(
  '/',
  requirePermission('companies.view'),
  asyncHandler(async (req, res) => {
    sendSuccess(res, await logos.getLogo(req, req.query.company_id));
  }),
);

router.post(
  '/',
  requirePermission('companies.update'),
  receiveLogo,
  asyncHandler(async (req, res) => {
    sendSuccess(res, await logos.setLogo(req, req.file as UploadedFile | undefined, req.query.company_id));
  }),
);

router.delete(
  '/',
  requirePermission('companies.update'),
  asyncHandler(async (req, res) => {
    sendSuccess(res, await logos.removeLogo(req, req.query.company_id));
  }),
);

export default router;
