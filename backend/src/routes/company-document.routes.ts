import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { receiveSingleFile } from '../middleware/upload.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import * as documents from '../services/company-document.service';
import { MAX_FILE_BYTES } from '../services/file-storage.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendSuccess } from '../utils/http';
import { parseId } from '../utils/query';
import { reviewDocumentSchema, uploadDocumentSchema } from '../validators/company-document.validators';

/**
 * Documentos de verificación de empresa (mockups 13 y 14).
 *
 * Permisos reutilizados, ninguno nuevo:
 *   · Leer     → `companies.view`   (ADMIN, COMPANY_ADMIN, OPERATOR)
 *   · Escribir → `companies.update` (ADMIN, COMPANY_ADMIN)
 *   · Revisar  → `companies.update` **y además rol ADMIN**, porque un COMPANY_ADMIN
 *     también tiene ese permiso y no puede aprobarse sus propios documentos.
 *
 * El permiso no basta: el servicio exige además pertenecer a una empresa, de modo que un
 * CUSTOMER —que también tiene `companies.view` para el listado público— queda fuera.
 *
 * Los archivos NO se sirven estáticamente. `GET /:id/file` los entrega tras validar
 * sesión y empresa, así que conocer la referencia interna no da acceso a nada.
 */
const router = Router();
router.use(authenticate);

/** Primera barrera del archivo: ver `upload.middleware.ts`. El servicio vuelve a validarlo. */
const receiveFile = receiveSingleFile(MAX_FILE_BYTES);

router.get(
  '/',
  requirePermission('companies.view'),
  asyncHandler(async (req, res) => {
    sendSuccess(res, await documents.list(req, req.query.company_id));
  }),
);

/** Línea de tiempo del mockup 14, derivada del estado de la empresa y sus documentos. */
router.get(
  '/verification-status',
  requirePermission('companies.view'),
  asyncHandler(async (req, res) => {
    sendSuccess(res, await documents.verificationStatus(req, req.query.company_id));
  }),
);

/** Bandeja de revisión del ADMIN: todo lo pendiente, de cualquier empresa. */
router.get(
  '/pending-review',
  requirePermission('companies.update'),
  asyncHandler(async (req, res) => {
    sendSuccess(res, await documents.pendingReview(req));
  }),
);

router.get(
  '/:id',
  requirePermission('companies.view'),
  asyncHandler(async (req, res) => {
    sendSuccess(res, await documents.detail(req, parseId(req.params.id)));
  }),
);

/** Descarga del archivo. Nunca se expone la ruta interna al cliente. */
router.get(
  '/:id/file',
  requirePermission('companies.view'),
  asyncHandler(async (req, res) => {
    const { buffer, mime, extension, document } = await documents.download(req, parseId(req.params.id));

    // `attachment` y `nosniff`: el navegador descarga el archivo, nunca lo interpreta.
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="documento-${document.id}${extension}"`);
    res.send(buffer);
  }),
);

router.post(
  '/',
  requirePermission('companies.update'),
  receiveFile as never,
  validate(uploadDocumentSchema),
  asyncHandler(async (req, res) => {
    const file = (req as { file?: Express.Multer.File }).file;
    if (!file) throw ApiError.badRequest('Adjunta el archivo del documento');

    const { document, companyId, replaced } = await documents.upload(req, file, req.body);

    await recordAudit(req, {
      action: replaced ? 'UPDATE' : 'CREATE',
      entityType: 'company_documents',
      entityId: document.id,
      description: `${replaced ? 'Reemplazó' : 'Subió'} el documento ${documents.DOCUMENT_TYPE_LABELS[document.type]} (empresa ${companyId})`,
      // Nunca se registra la referencia interna del archivo ni su contenido.
      newValues: { type: document.type, status: document.status },
    });

    sendSuccess(res, document, replaced ? 200 : 201);
  }),
);

router.delete(
  '/:id',
  requirePermission('companies.update'),
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const { previous, companyId } = await documents.remove(req, id);

    await recordAudit(req, {
      action: 'DELETE',
      entityType: 'company_documents',
      entityId: id,
      description: `Eliminó el documento ${documents.DOCUMENT_TYPE_LABELS[previous.type]} (empresa ${companyId})`,
    });

    sendSuccess(res, { id });
  }),
);

/**
 * Revisión administrativa: verificar o rechazar. Exige rol ADMIN además del permiso.
 * No cambia `companies.status`: aprobar la empresa sigue siendo una acción aparte.
 */
router.put(
  '/:id/review',
  requirePermission('companies.update'),
  validate(reviewDocumentSchema),
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const document = await documents.reviewDocument(req, id, req.body);

    await recordAudit(req, {
      action: document.status === 'VERIFIED' ? 'APPROVE' : 'REJECT',
      entityType: 'company_documents',
      entityId: id,
      description: `${document.status === 'VERIFIED' ? 'Verificó' : 'Rechazó'} el documento ${documents.DOCUMENT_TYPE_LABELS[document.type]} de ${document.company_name}`,
      newValues: { status: document.status },
    });

    sendSuccess(res, document);
  }),
);

export default router;
