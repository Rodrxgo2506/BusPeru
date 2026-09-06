import { execute, query, queryOne } from '../config/database';

/**
 * Acceso a datos de `company_documents`. Todo el SQL del módulo vive aquí.
 *
 * El `companyId` lo resuelve siempre el servicio a partir del usuario autenticado; el
 * repositorio se limita a acotar por él, de modo que un id de otra empresa no devuelve
 * ni modifica nada.
 */

export const DOCUMENT_TYPES = ['RUC', 'LICENSE', 'INSURANCE', 'LEGAL_REP_ID', 'OTHER'] as const;
export const DOCUMENT_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export interface CompanyDocument {
  id: number;
  company_id: number;
  type: DocumentType;
  file_url: string;
  status: DocumentStatus;
  reviewed_by: number | null;
  reviewed_at: string | null;
  notes: string | null;
  created_at: string;
}

export interface CompanyDocumentRow extends CompanyDocument {
  reviewer_name: string | null;
  company_name: string;
}

const SELECT = `SELECT d.*,
    CONCAT_WS(' ', u.first_name, u.last_name) AS reviewer_name,
    co.name AS company_name
  FROM company_documents d
  LEFT JOIN users u ON u.id = d.reviewed_by
  JOIN companies co ON co.id = d.company_id`;

export async function findByCompany(companyId: number): Promise<CompanyDocumentRow[]> {
  return query<CompanyDocumentRow>(
    `${SELECT} WHERE d.company_id = ? ORDER BY d.created_at DESC, d.id DESC`,
    [companyId],
  );
}

/** Devuelve el documento solo si pertenece a la empresa indicada. */
export async function findByIdForCompany(id: number, companyId: number): Promise<CompanyDocumentRow | null> {
  return queryOne<CompanyDocumentRow>(`${SELECT} WHERE d.id = ? AND d.company_id = ? LIMIT 1`, [id, companyId]);
}

/** Búsqueda sin acotar por empresa. Solo la usa la revisión administrativa. */
export async function findById(id: number): Promise<CompanyDocumentRow | null> {
  return queryOne<CompanyDocumentRow>(`${SELECT} WHERE d.id = ? LIMIT 1`, [id]);
}

/** Documento vigente de un tipo dentro de una empresa, si lo hay. */
export async function findByType(companyId: number, type: DocumentType): Promise<CompanyDocument | null> {
  return queryOne<CompanyDocument>(
    'SELECT * FROM company_documents WHERE company_id = ? AND type = ? ORDER BY id DESC LIMIT 1',
    [companyId, type],
  );
}

export async function create(companyId: number, type: DocumentType, fileUrl: string, notes: string | null): Promise<number> {
  // `status` no se recibe nunca del cliente: un documento siempre nace PENDING.
  const result = await execute(
    'INSERT INTO company_documents (company_id, type, file_url, status, notes) VALUES (?, ?, ?, ?, ?)',
    [companyId, type, fileUrl, 'PENDING', notes],
  );
  return result.insertId;
}

/** Reemplaza el archivo de un documento y lo devuelve a revisión. */
export async function replaceFile(id: number, companyId: number, fileUrl: string, notes: string | null): Promise<void> {
  await execute(
    `UPDATE company_documents
     SET file_url = ?, status = 'PENDING', reviewed_by = NULL, reviewed_at = NULL, notes = ?
     WHERE id = ? AND company_id = ?`,
    [fileUrl, notes, id, companyId],
  );
}

/** Resolución de la revisión administrativa. `notes` guarda el motivo del rechazo. */
export async function review(id: number, status: DocumentStatus, reviewerId: number, notes: string | null): Promise<void> {
  await execute(
    'UPDATE company_documents SET status = ?, reviewed_by = ?, reviewed_at = NOW(), notes = ? WHERE id = ?',
    [status, reviewerId, notes, id],
  );
}

export async function remove(id: number, companyId: number): Promise<number> {
  const result = await execute('DELETE FROM company_documents WHERE id = ? AND company_id = ?', [id, companyId]);
  return result.affectedRows;
}

export interface DocumentSummary {
  total: number;
  pending: number;
  verified: number;
  rejected: number;
}

/** Recuento por estado, para derivar la línea de tiempo de verificación. */
export async function summaryByCompany(companyId: number): Promise<DocumentSummary> {
  const row = await queryOne<DocumentSummary>(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(status = 'PENDING'), 0) AS pending,
       COALESCE(SUM(status = 'VERIFIED'), 0) AS verified,
       COALESCE(SUM(status = 'REJECTED'), 0) AS rejected
     FROM company_documents WHERE company_id = ?`,
    [companyId],
  );
  return {
    total: Number(row?.total ?? 0),
    pending: Number(row?.pending ?? 0),
    verified: Number(row?.verified ?? 0),
    rejected: Number(row?.rejected ?? 0),
  };
}

/** Empresas con documentos pendientes de revisar, para la bandeja del ADMIN. */
export async function findPendingReview(): Promise<CompanyDocumentRow[]> {
  return query<CompanyDocumentRow>(
    `${SELECT} WHERE d.status = 'PENDING' ORDER BY d.created_at ASC, d.id ASC`,
  );
}
