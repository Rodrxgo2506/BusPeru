import { Router, type RequestHandler } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission, requireRole } from '../middleware/permission.middleware';
import { receiveSingleFile } from '../middleware/upload.middleware';
import { validate } from '../middleware/validate.middleware';
import * as complaints from '../services/complaint-book.service';
import * as profiles from '../services/company-profile.service';
import { MAX_IMAGE_BYTES, type UploadedFile } from '../services/file-storage.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendList, sendSuccess } from '../utils/http';
import { buildPagination, parseId, parseListQuery } from '../utils/query';
import {
  complaintNoteSchema,
  createCompanyAgencySchema,
  createCompanyServiceSchema,
  createGalleryImageSchema,
  moderationSchema,
  reorderSchema,
  setActiveSchema,
  updateCompanyAgencySchema,
  updateCompanyProfileSchema,
  updateCompanyServiceSchema,
  updateComplaintSchema,
  updateGalleryImageSchema,
  updateProfileSlugSchema,
} from '../validators/company-profile.validators';

/**
 * F18-19 · perfil público de empresas (panel) y Libro de Reclamaciones (gestión).
 *
 * PERMISOS (reutilizados, ninguno nuevo):
 *   · Leer el perfil      → rol ADMIN, COMPANY_ADMIN u OPERATOR + `companies.view`. CUSTOMER también tiene
 *                           `companies.view`, por eso se exige además el rol.
 *   · Escribir el perfil  → rol ADMIN o COMPANY_ADMIN + `companies.update`.
 *   · Moderar / Libro     → solo ADMIN.
 * La empresa nunca viene en la ruta ni en el cuerpo: sale de la sesión (`resolveCompanyId`); solo un ADMIN
 * puede operar sobre otra con `?company_id=`.
 */

const readProfile: RequestHandler[] = [requireRole('ADMIN', 'COMPANY_ADMIN', 'OPERATOR'), requirePermission('companies.view')];
const writeProfile: RequestHandler[] = [requireRole('ADMIN', 'COMPANY_ADMIN'), requirePermission('companies.update')];
const receiveImage = receiveSingleFile(MAX_IMAGE_BYTES);

type ItemEntity = 'service' | 'agency' | 'gallery';
const ITEM_PATHS: Record<string, ItemEntity> = { services: 'service', agencies: 'agency', gallery: 'gallery' };

function itemEntity(segment: string | undefined): ItemEntity {
  const entity = ITEM_PATHS[segment ?? ''];
  if (!entity) throw ApiError.notFound('Recurso no encontrado');
  return entity;
}

// ================================================================================ /company/profile
export const companyProfileRouter = Router();
companyProfileRouter.use(authenticate);

companyProfileRouter.get('/', ...readProfile, asyncHandler(async (req, res) => sendSuccess(res, await profiles.getProfile(req))));
companyProfileRouter.put('/', ...writeProfile, validate(updateCompanyProfileSchema), asyncHandler(async (req, res) => sendSuccess(res, await profiles.updateProfile(req, req.body))));
companyProfileRouter.put('/slug', requireRole('ADMIN'), validate(updateProfileSlugSchema), asyncHandler(async (req, res) => sendSuccess(res, await profiles.updateProfileSlug(req, req.body.slug))));
companyProfileRouter.post('/submit', ...writeProfile, asyncHandler(async (req, res) => sendSuccess(res, await profiles.submitForReview(req, 'profile', null))));
companyProfileRouter.get('/preview', ...readProfile, asyncHandler(async (req, res) => sendSuccess(res, await profiles.previewProfile(req))));

companyProfileRouter.post('/images/:slot', ...writeProfile, receiveImage, asyncHandler(async (req, res) => {
  const slot = String(req.params.slot) as profiles.ProfileImageSlot;
  if (!(slot in profiles.PROFILE_IMAGE_SLOTS)) throw ApiError.notFound('Imagen no encontrada');
  sendSuccess(res, await profiles.setProfileImage(req, slot, req.file as UploadedFile | undefined));
}));
companyProfileRouter.delete('/images/:slot', ...writeProfile, asyncHandler(async (req, res) => {
  const slot = String(req.params.slot) as profiles.ProfileImageSlot;
  if (!(slot in profiles.PROFILE_IMAGE_SLOTS)) throw ApiError.notFound('Imagen no encontrada');
  sendSuccess(res, await profiles.removeProfileImage(req, slot));
}));

// Servicios, agencias y galería comparten el mismo contrato.
companyProfileRouter.get('/:items(services|agencies|gallery)', ...readProfile, asyncHandler(async (req, res) => {
  sendSuccess(res, await profiles.listItems(req, itemEntity(req.params.items)));
}));
companyProfileRouter.post('/services', ...writeProfile, validate(createCompanyServiceSchema), asyncHandler(async (req, res) => {
  sendSuccess(res, await profiles.createItem(req, 'service', req.body), 201);
}));
companyProfileRouter.post('/agencies', ...writeProfile, validate(createCompanyAgencySchema), asyncHandler(async (req, res) => {
  sendSuccess(res, await profiles.createItem(req, 'agency', req.body), 201);
}));
companyProfileRouter.post('/gallery', ...writeProfile, receiveImage, validate(createGalleryImageSchema), asyncHandler(async (req, res) => {
  sendSuccess(res, await profiles.createGalleryImage(req, req.file as UploadedFile | undefined, req.body), 201);
}));
companyProfileRouter.put('/:items(services|agencies|gallery)/reorder', ...writeProfile, validate(reorderSchema), asyncHandler(async (req, res) => {
  sendSuccess(res, await profiles.reorderItems(req, itemEntity(req.params.items), req.body.ids));
}));

const UPDATE_SCHEMAS = { service: updateCompanyServiceSchema, agency: updateCompanyAgencySchema, gallery: updateGalleryImageSchema };
companyProfileRouter.put('/:items(services|agencies|gallery)/:id', ...writeProfile, (req, res, next) => {
  validate(UPDATE_SCHEMAS[itemEntity(req.params.items)])(req, res, next);
}, asyncHandler(async (req, res) => {
  sendSuccess(res, await profiles.updateItem(req, itemEntity(req.params.items), parseId(req.params.id), req.body));
}));
companyProfileRouter.delete('/:items(services|agencies|gallery)/:id', ...writeProfile, asyncHandler(async (req, res) => {
  await profiles.deleteItem(req, itemEntity(req.params.items), parseId(req.params.id));
  sendSuccess(res, { deleted: true });
}));
companyProfileRouter.post('/:items(services|agencies|gallery)/:id/submit', ...writeProfile, asyncHandler(async (req, res) => {
  sendSuccess(res, await profiles.submitForReview(req, itemEntity(req.params.items), parseId(req.params.id)));
}));
companyProfileRouter.patch('/:items(services|agencies|gallery)/:id/active', ...writeProfile, validate(setActiveSchema), asyncHandler(async (req, res) => {
  sendSuccess(res, await profiles.setItemActive(req, itemEntity(req.params.items), parseId(req.params.id), req.body.is_active));
}));
companyProfileRouter.post('/:items(services|agencies)/:id/image', ...writeProfile, receiveImage, asyncHandler(async (req, res) => {
  const entity = itemEntity(req.params.items) as 'service' | 'agency';
  sendSuccess(res, await profiles.setItemImage(req, entity, parseId(req.params.id), req.file as UploadedFile | undefined));
}));
companyProfileRouter.delete('/:items(services|agencies)/:id/image', ...writeProfile, asyncHandler(async (req, res) => {
  const entity = itemEntity(req.params.items) as 'service' | 'agency';
  sendSuccess(res, await profiles.removeItemImage(req, entity, parseId(req.params.id)));
}));

// ================================================================================ /admin/company-profiles
export const adminCompanyProfileRouter = Router();
adminCompanyProfileRouter.use(authenticate, requireRole('ADMIN'));

adminCompanyProfileRouter.get('/', asyncHandler(async (req, res) => {
  sendSuccess(res, await profiles.moderationQueue(typeof req.query.status === 'string' ? req.query.status : undefined));
}));
adminCompanyProfileRouter.get('/:companyId', asyncHandler(async (req, res) => {
  sendSuccess(res, await profiles.adminDetail(parseId(req.params.companyId)));
}));
adminCompanyProfileRouter.post('/:companyId/moderation', validate(moderationSchema), asyncHandler(async (req, res) => {
  sendSuccess(res, await profiles.moderate(req, parseId(req.params.companyId), req.body));
}));
adminCompanyProfileRouter.get('/:companyId/audit', asyncHandler(async (req, res) => {
  const list = parseListQuery(req.query as Record<string, unknown>);
  const { rows, total } = await profiles.profileAudit(parseId(req.params.companyId), list.page, list.limit);
  sendList(res, rows, buildPagination(total, list.page, list.limit));
}));

// ================================================================================ /admin/complaints
export const adminComplaintRouter = Router();
adminComplaintRouter.use(authenticate, requireRole('ADMIN'));

adminComplaintRouter.get('/', asyncHandler(async (req, res) => {
  const list = parseListQuery(req.query as Record<string, unknown>);
  const { rows, total } = await complaints.listComplaints(list.filters, list.search, list.page, list.limit);
  sendList(res, rows, buildPagination(total, list.page, list.limit));
}));
adminComplaintRouter.get('/:id', asyncHandler(async (req, res) => sendSuccess(res, await complaints.complaintDetail(parseId(req.params.id)))));
adminComplaintRouter.patch('/:id', validate(updateComplaintSchema), asyncHandler(async (req, res) => {
  sendSuccess(res, await complaints.updateComplaint(req, parseId(req.params.id), req.body));
}));
adminComplaintRouter.post('/:id/notes', validate(complaintNoteSchema), asyncHandler(async (req, res) => {
  sendSuccess(res, await complaints.addInternalNote(req, parseId(req.params.id), req.body.note));
}));

// ================================================================================ /company/complaints
export const companyComplaintRouter = Router();
companyComplaintRouter.use(authenticate, requireRole('ADMIN', 'COMPANY_ADMIN'));

companyComplaintRouter.get('/', asyncHandler(async (req, res) => {
  const list = parseListQuery(req.query as Record<string, unknown>);
  const { rows, total } = await complaints.companyComplaints(req, list.page, list.limit);
  sendList(res, rows, buildPagination(total, list.page, list.limit));
}));
companyComplaintRouter.get('/:id', asyncHandler(async (req, res) => sendSuccess(res, await complaints.companyComplaintDetail(req, parseId(req.params.id)))));
companyComplaintRouter.post('/:id/notes', validate(complaintNoteSchema), asyncHandler(async (req, res) => {
  sendSuccess(res, await complaints.addCompanyNote(req, parseId(req.params.id), req.body.note));
}));
