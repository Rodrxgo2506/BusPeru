import type { Request } from 'express';
import { queryOne } from '../config/database';
import { requireAuth } from '../middleware/auth.middleware';
import * as repository from '../repositories/company-document.repository';
import type { CompanyDocumentRow, DocumentStatus, DocumentType } from '../repositories/company-document.repository';
import { ApiError } from '../utils/ApiError';
import { deleteFile, readFile, storeFile, type UploadedFile } from './file-storage.service';
import { NOTIFICATION_EVENTS, notifyStandalone } from './notification.service';

/**
 * Documentos de verificación de empresa (mockups 13 y 14).
 *
 * Reglas, todas resueltas aquí y nunca a partir del cuerpo de la petición:
 *
 *   · La empresa sale de `company_users` del usuario autenticado. `company_id` no es un
 *     campo escribible: enviarlo no cambia nada.
 *   · `status`, `reviewed_by` y `reviewed_at` NO son escribibles por la empresa. Un
 *     documento siempre nace PENDING y solo la revisión administrativa los cambia.
 *   · Aprobar o rechazar es exclusivo del ADMIN de la plataforma: un COMPANY_ADMIN tiene
 *     `companies.update`, así que el permiso no basta y se exige además el rol.
 *   · Subir un documento NO cambia `companies.status`. Aprobar la empresa sigue siendo
 *     una acción aparte del ADMIN, igual que antes de esta funcionalidad.
 */

/** Resuelve la empresa sobre la que se opera. Nunca desde el cuerpo de la petición. */
export function resolveCompanyId(req: Request, requestedCompanyId?: unknown): number {
  const user = requireAuth(req);

  if (user.role === 'ADMIN') {
    if (requestedCompanyId === undefined || requestedCompanyId === null || requestedCompanyId === '') {
      const [own] = user.companyIds;
      if (own !== undefined) return own;
      throw ApiError.badRequest('Indica la empresa con el parámetro company_id');
    }
    const companyId = Number(requestedCompanyId);
    if (!Number.isInteger(companyId) || companyId <= 0) throw ApiError.badRequest('company_id inválido');
    return companyId;
  }

  const [companyId] = user.companyIds;
  if (companyId === undefined) throw ApiError.forbidden('Tu usuario no está asociado a ninguna empresa');
  return companyId;
}

/** La revisión es del ADMIN de la plataforma: nadie se aprueba sus propios documentos. */
function assertPlatformAdmin(req: Request): void {
  if (requireAuth(req).role !== 'ADMIN') {
    throw ApiError.forbidden('Solo un administrador de la plataforma puede revisar documentos');
  }
}

/** Lo que ve el cliente: el mismo documento SIN la referencia interna del archivo. */
export type PublicCompanyDocument = Omit<CompanyDocumentRow, 'file_url'> & { has_file: true };

/**
 * `file_url` es una ruta interna del almacén privado y nunca sale del servidor: el archivo
 * se obtiene por `GET /:id/file`, que vuelve a comprobar sesión y empresa.
 */
export function toPublic(document: CompanyDocumentRow): PublicCompanyDocument {
  const { file_url: _internal, ...rest } = document;
  return { ...rest, has_file: true };
}

export async function list(req: Request, requestedCompanyId?: unknown): Promise<PublicCompanyDocument[]> {
  const rows = await repository.findByCompany(resolveCompanyId(req, requestedCompanyId));
  return rows.map(toPublic);
}

/** Bandeja de revisión del ADMIN: documentos pendientes de todas las empresas. */
export async function pendingReview(req: Request): Promise<PublicCompanyDocument[]> {
  assertPlatformAdmin(req);
  return (await repository.findPendingReview()).map(toPublic);
}

/** Documento completo, con `file_url`. Solo para uso interno del servicio. */
async function detailInternal(req: Request, id: number): Promise<CompanyDocumentRow> {
  const user = requireAuth(req);

  // El ADMIN revisa documentos de cualquier empresa; el resto solo los de la suya.
  const document = user.role === 'ADMIN'
    ? await repository.findById(id)
    : await repository.findByIdForCompany(id, resolveCompanyId(req));

  // 404 y no 403: un 403 confirmaría que el documento existe en otra empresa.
  if (!document) throw ApiError.notFound('Documento no encontrado');
  return document;
}

export async function detail(req: Request, id: number): Promise<PublicCompanyDocument> {
  return toPublic(await detailInternal(req, id));
}

export interface UploadInput {
  type: DocumentType;
  notes?: string | null;
}

export async function upload(
  req: Request,
  file: UploadedFile,
  input: UploadInput,
): Promise<{ document: PublicCompanyDocument; companyId: number; replaced: boolean }> {
  const companyId = resolveCompanyId(req);

  // El archivo se valida y guarda ANTES de tocar la base: si el formato no encaja, no
  // queda ninguna fila creada.
  const stored = storeFile(file, companyId);

  const existing = await repository.findByType(companyId, input.type);
  const notes = input.notes?.trim() || null;

  try {
    if (existing) {
      // Reemplazo: el documento vuelve a revisión y el archivo anterior se descarta.
      await repository.replaceFile(existing.id, companyId, stored.reference, notes);
      deleteFile(existing.file_url);

      const document = await repository.findByIdForCompany(existing.id, companyId);
      if (!document) throw ApiError.internal();
      return { document: toPublic(document), companyId, replaced: true };
    }

    const id = await repository.create(companyId, input.type, stored.reference, notes);
    const document = await repository.findByIdForCompany(id, companyId);
    if (!document) throw ApiError.internal();
    return { document: toPublic(document), companyId, replaced: false };
  } catch (error) {
    // Si la base falla, el archivo recién guardado no debe quedar huérfano en disco.
    deleteFile(stored.reference);
    throw error;
  }
}

export async function remove(req: Request, id: number): Promise<{ previous: CompanyDocumentRow; companyId: number }> {
  const companyId = resolveCompanyId(req);

  const previous = await repository.findByIdForCompany(id, companyId);
  if (!previous) throw ApiError.notFound('Documento no encontrado');

  // Un documento ya verificado es parte del expediente: no se borra desde la empresa.
  if (previous.status === 'VERIFIED') {
    throw ApiError.badRequest('Un documento verificado no puede eliminarse. Súbelo de nuevo para reemplazarlo.');
  }

  const affected = await repository.remove(id, companyId);
  if (affected === 0) throw ApiError.notFound('Documento no encontrado');

  deleteFile(previous.file_url);
  return { previous, companyId };
}

/** Entrega el archivo. Acotado igual que el detalle: nadie ve documentos ajenos. */
export async function download(req: Request, id: number) {
  const document = await detailInternal(req, id);
  const file = readFile(document.file_url);
  return { ...file, document };
}

export interface ReviewInput {
  status: Extract<DocumentStatus, 'VERIFIED' | 'REJECTED'>;
  notes?: string | null;
}

/**
 * Resuelve la revisión de un documento. Solo ADMIN.
 * Rechazar exige un motivo: es lo que la empresa verá para poder corregir.
 */
export async function reviewDocument(req: Request, id: number, input: ReviewInput): Promise<PublicCompanyDocument> {
  assertPlatformAdmin(req);
  const reviewer = requireAuth(req);

  const document = await repository.findById(id);
  if (!document) throw ApiError.notFound('Documento no encontrado');

  if (input.status === 'REJECTED' && !input.notes?.trim()) {
    throw ApiError.badRequest('Indica el motivo del rechazo para que la empresa pueda corregirlo');
  }

  const notes = input.notes?.trim() || null;
  await repository.review(id, input.status, reviewer.id, notes);

  // Aviso a los administradores de la empresa, con el sistema de notificaciones existente.
  const destinatarios = await companyAdmins(document.company_id);
  const event = input.status === 'VERIFIED'
    ? NOTIFICATION_EVENTS.DOCUMENT_VERIFIED
    : NOTIFICATION_EVENTS.DOCUMENT_REJECTED;

  for (const userId of destinatarios) {
    await notifyStandalone({
      userId,
      event,
      // La clave incluye el estado: un documento rechazado y luego aprobado avisa dos veces.
      eventKey: `${event}:${id}:${input.status}`,
      context: {
        document_type: DOCUMENT_TYPE_LABELS[document.type],
        company_name: document.company_name,
        notes: notes ?? '',
      },
    });
  }

  const updated = await repository.findById(id);
  if (!updated) throw ApiError.internal();
  return toPublic(updated);
}

/** Etiquetas legibles de los tipos definidos en PENDIENTES.md. */
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  RUC: 'Ficha RUC',
  LICENSE: 'Licencia de operación',
  INSURANCE: 'Póliza de seguro',
  LEGAL_REP_ID: 'Documento del representante legal',
  OTHER: 'Otro documento',
};

async function companyAdmins(companyId: number): Promise<number[]> {
  const rows = await queryOne<{ ids: string | null }>(
    `SELECT GROUP_CONCAT(cu.user_id) AS ids
     FROM company_users cu JOIN users u ON u.id = cu.user_id JOIN roles r ON r.id = u.role_id
     WHERE cu.company_id = ? AND r.name = 'COMPANY_ADMIN'`,
    [companyId],
  );
  return (rows?.ids ?? '').split(',').filter(Boolean).map(Number);
}

export interface VerificationStage {
  key: string;
  label: string;
  description: string;
  status: 'DONE' | 'IN_PROGRESS' | 'PENDING' | 'BLOCKED';
}

/**
 * Línea de tiempo de verificación del mockup 14.
 *
 * PENDIENTES.md no propone tabla de etapas, así que se DERIVAN de `companies.status` y
 * del estado de los documentos. No se almacena nada.
 */
export async function verificationStatus(req: Request, requestedCompanyId?: unknown) {
  const companyId = resolveCompanyId(req, requestedCompanyId);

  const company = await queryOne<{ id: number; name: string; status: string; created_at: string }>(
    'SELECT id, name, status, created_at FROM companies WHERE id = ? LIMIT 1',
    [companyId],
  );
  if (!company) throw ApiError.notFound('Empresa no encontrada');

  const summary = await repository.summaryByCompany(companyId);
  const aprobada = company.status === 'ACTIVE';
  const hayRechazados = summary.rejected > 0;
  const todosVerificados = summary.total > 0 && summary.verified === summary.total;

  const stages: VerificationStage[] = [
    {
      key: 'information',
      label: 'Información de la empresa',
      description: 'Datos básicos y representante legal.',
      status: 'DONE',
    },
    {
      key: 'documents',
      label: 'Documentos legales',
      description: 'RUC, licencia y documentos adicionales.',
      status: hayRechazados ? 'BLOCKED' : todosVerificados ? 'DONE' : summary.total > 0 ? 'IN_PROGRESS' : 'PENDING',
    },
    {
      key: 'administrative',
      label: 'Verificación administrativa',
      description: 'Nuestro equipo está validando tu información.',
      status: aprobada ? 'DONE' : todosVerificados ? 'IN_PROGRESS' : 'PENDING',
    },
    {
      key: 'approval',
      label: 'Aprobación final',
      description: 'Te notificaremos cuando finalice el proceso.',
      status: aprobada ? 'DONE' : 'PENDING',
    },
  ];

  return { company, documents: summary, stages };
}
