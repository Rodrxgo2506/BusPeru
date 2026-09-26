import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import * as complaints from '../services/complaint-book.service';
import { asyncHandler, sendList, sendSuccess } from '../utils/http';
import { buildPagination, parseId, parseListQuery } from '../utils/query';
import { complaintNoteSchema, updateComplaintSchema } from '../validators/complaint-book.validators';

/**
 * F18-19 · Libro de Reclamaciones (gestión). Bandeja del ADMIN (solo rol ADMIN) y hojas relacionadas con la empresa
 * (ADMIN o COMPANY_ADMIN; la empresa sale de la sesión). El formulario público vive en `public.routes.ts`.
 */

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
