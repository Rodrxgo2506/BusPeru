import type { Request } from 'express';
import { execute, queryOne, withTransaction } from '../config/database';
import { ApiError } from '../utils/ApiError';
import { recordAudit } from './audit.service';
import { resolveCompanyId } from './company-document.service';
import { deletePublicFile, storePublicImage, type UploadedFile } from './file-storage.service';

/**
 * Logotipo de la empresa (F17C-COMPANY-LOGO-01).
 *
 * No hay estructura nueva: se reutiliza `companies.logo_url`, que ya existía en el esquema, y el
 * almacén de imágenes públicas de la FASE 17. La columna guarda una REFERENCIA
 * (`public/companies/<id>/<32 hex>.<ext>`), nunca una ruta de disco ni una URL absoluta, así que
 * mover el almacén a S3/R2 no tocaría ni la base ni esta capa.
 *
 * SOBRE LA PERTENENCIA: la empresa sale de `resolveCompanyId`, el mismo resolutor que usan los
 * documentos de verificación. Para un rol de empresa la empresa es SIEMPRE la suya, tomada de la
 * sesión; el `company_id` de la petición solo lo atiende un ADMIN. Por eso estos endpoints no
 * aceptan un id de empresa en la ruta: no habría forma de subir un logo a una empresa ajena.
 */

interface CompanyLogoRow {
  id: number;
  name: string;
  logo_url: string | null;
}

export interface CompanyLogo {
  company_id: number;
  logo_url: string | null;
}

async function findCompany(companyId: number): Promise<CompanyLogoRow> {
  const company = await queryOne<CompanyLogoRow>('SELECT id, name, logo_url FROM companies WHERE id = ?', [companyId]);
  if (!company) throw ApiError.notFound('Empresa no encontrada');
  return company;
}

/**
 * Sube o reemplaza el logotipo.
 *
 * El archivo se guarda primero y la columna después, dentro de una transacción con la fila
 * bloqueada: si la escritura falla, se borra el archivo recién subido y no queda basura en disco.
 * El logotipo anterior se borra solo cuando el cambio ya está confirmado.
 */
export async function setLogo(req: Request, file: UploadedFile | undefined, requestedCompanyId?: unknown): Promise<CompanyLogo> {
  if (!file) throw ApiError.badRequest('Adjunta la imagen en el campo «file»');

  const companyId = resolveCompanyId(req, requestedCompanyId);
  const company = await findCompany(companyId);
  const stored = storePublicImage(file, { kind: 'company', companyId });

  try {
    const previous = await withTransaction(async (connection) => {
      const [rows] = await connection.query('SELECT logo_url FROM companies WHERE id = ? FOR UPDATE', [companyId]);
      const current = (rows as CompanyLogoRow[])[0];
      if (!current) throw ApiError.notFound('Empresa no encontrada');
      await connection.execute('UPDATE companies SET logo_url = ? WHERE id = ?', [stored.reference, companyId]);
      return current.logo_url;
    });

    // Solo cuando el cambio está confirmado: si se borrase antes, un fallo dejaría a la empresa sin logo.
    deletePublicFile(previous);
    await recordAudit(req, {
      action: 'UPDATE',
      entityType: 'companies',
      entityId: companyId,
      description: `Actualizó el logotipo de «${company.name}»`,
      oldValues: { logo_url: previous },
      newValues: { logo_url: stored.reference },
    });
    return { company_id: companyId, logo_url: stored.reference };
  } catch (error) {
    deletePublicFile(stored.reference);
    throw error;
  }
}

/** Quita el logotipo y borra el archivo. La empresa vuelve a mostrarse con sus iniciales. */
export async function removeLogo(req: Request, requestedCompanyId?: unknown): Promise<CompanyLogo> {
  const companyId = resolveCompanyId(req, requestedCompanyId);
  const company = await findCompany(companyId);

  if (company.logo_url) {
    await execute('UPDATE companies SET logo_url = NULL WHERE id = ?', [companyId]);
    deletePublicFile(company.logo_url);
    await recordAudit(req, {
      action: 'UPDATE',
      entityType: 'companies',
      entityId: companyId,
      description: `Quitó el logotipo de «${company.name}»`,
      oldValues: { logo_url: company.logo_url },
      newValues: { logo_url: null },
    });
  }

  return { company_id: companyId, logo_url: null };
}

/** Logotipo vigente. Sirve para que el panel pinte la vista previa sin recargar la ficha entera. */
export async function getLogo(req: Request, requestedCompanyId?: unknown): Promise<CompanyLogo> {
  const companyId = resolveCompanyId(req, requestedCompanyId);
  const company = await findCompany(companyId);
  return { company_id: companyId, logo_url: company.logo_url };
}
