import type { Request } from 'express';
import { execute, query, queryOne, withTransaction } from '../config/database';
import { requireAuth } from '../middleware/auth.middleware';
import { ApiError } from '../utils/ApiError';
import { readImageSize } from '../utils/image-dimensions';
import { slugify } from '../validators/destination.validators';
import { recordAudit } from './audit.service';
import { resolveCompanyId } from './company-document.service';
import { deletePublicFile, storePublicImage, type UploadedFile } from './file-storage.service';

/**
 * F18-19 · perfil público de empresas.
 *
 * MODELO (migración 020). Cada contenido tiene una COPIA DE TRABAJO (columnas) que edita la empresa y una
 * INSTANTÁNEA PUBLICADA (`published_content`) que solo escribe el ADMIN al aprobar. El público lee siempre
 * la instantánea: una edición pendiente jamás se publica sola, y lo ya aprobado sigue visible mientras
 * se revisa el cambio. Estados: DRAFT → PENDING → APPROVED (publicado) | REJECTED (con nota).
 *
 * AISLAMIENTO. La empresa sale SIEMPRE de `resolveCompanyId`: para un rol de empresa, la de su sesión;
 * solo un ADMIN puede indicar otra con `?company_id=`. Ninguna consulta de escritura toca una fila sin
 * `company_id = ?` en el WHERE, así que un id ajeno responde 404, igual que uno inexistente.
 *
 * REUTILIZA: `companies` (nombre, logo, estado), `routes`/`locations`/`destinations` (destinos),
 * `buses`/`bus_types` (flota, sin placa ni código) y `reviews`/`review_responses` (opiniones).
 */

export type Entity = 'profile' | 'service' | 'agency' | 'gallery';
type ItemEntity = Exclude<Entity, 'profile'>;
export type ReviewStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED';

const TABLES: Record<ItemEntity, string> = {
  service: 'company_services',
  agency: 'company_agencies',
  gallery: 'company_gallery_images',
};

/** Campos que forman la instantánea pública de cada entidad. */
const SNAPSHOT_FIELDS: Record<Entity, readonly string[]> = {
  profile: ['tagline', 'cover_image', 'about_title', 'about_body', 'history', 'mission', 'vision', 'values_list', 'about_image',
    'contact_phone', 'contact_whatsapp', 'contact_email', 'website_url', 'social_links', 'main_address'],
  service: ['name', 'description', 'features', 'image'],
  agency: ['name', 'city', 'department', 'location_id', 'address', 'reference', 'phone', 'whatsapp', 'email', 'latitude', 'longitude',
    'image', 'services', 'weekly_hours', 'special_hours'],
  gallery: ['image', 'width', 'height', 'title', 'description', 'category'],
};
const IMAGE_FIELDS: Record<Entity, readonly string[]> = {
  profile: ['cover_image', 'about_image'],
  service: ['image'],
  agency: ['image'],
  gallery: ['image'],
};
const JSON_FIELDS = new Set(['values_list', 'social_links', 'features', 'services', 'weekly_hours', 'special_hours']);
/** Campos editables por la empresa (el resto lo fija el servidor: imágenes, estado, orden, instantánea). */
const EDITABLE: Record<Entity, readonly string[]> = {
  profile: SNAPSHOT_FIELDS.profile.filter((f) => !IMAGE_FIELDS.profile.includes(f)),
  service: ['name', 'description', 'features', 'display_order'],
  agency: ['name', 'city', 'department', 'location_id', 'address', 'reference', 'phone', 'whatsapp', 'email', 'latitude', 'longitude',
    'services', 'weekly_hours', 'special_hours', 'display_order'],
  gallery: ['title', 'description', 'category', 'display_order'],
};
const ENTITY_LABEL: Record<Entity, string> = { profile: 'perfil', service: 'servicio', agency: 'agencia', gallery: 'imagen de galería' };
const MAX_ITEMS: Record<ItemEntity, number> = { service: 30, agency: 80, gallery: 120 };

/** Límites de una fotografía de perfil o galería (además de formato, MIME, bytes mágicos y 5 MB). */
export const IMAGE_LIMITS = { minSide: 160, maxSide: 6000, maxPixels: 36_000_000 };

type Row = Record<string, unknown>;

// =============================================================================== utilidades
function parseJson(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Una fila tal como la usa la API: JSON parseado y booleanos reales. */
function decode(row: Row): Row {
  const out: Row = { ...row };
  for (const field of JSON_FIELDS) if (field in out) out[field] = parseJson(out[field]);
  if ('published_content' in out) out.published_content = parseJson(out.published_content);
  if ('is_active' in out) out.is_active = Boolean(out.is_active);
  return out;
}

function encode(field: string, value: unknown): unknown {
  if (!JSON_FIELDS.has(field)) return value;
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function snapshotOf(entity: Entity, row: Row): Row {
  const decoded = decode(row);
  return Object.fromEntries(SNAPSHOT_FIELDS[entity].map((field) => [field, decoded[field] ?? null]));
}

function imagesOf(entity: Entity, row: Row | null | undefined): string[] {
  if (!row) return [];
  return IMAGE_FIELDS[entity].map((field) => row[field]).filter((v): v is string => typeof v === 'string' && v !== '');
}

/** Borra los archivos que ya no usa ni la copia de trabajo ni la instantánea publicada. */
function releaseImages(candidates: string[], stillUsed: string[]): void {
  const keep = new Set(stillUsed);
  for (const reference of new Set(candidates)) if (!keep.has(reference)) deletePublicFile(reference);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function companyFor(req: Request): number {
  return resolveCompanyId(req, req.query.company_id);
}

function actorIsAdmin(req: Request): boolean {
  return requireAuth(req).role === 'ADMIN';
}

async function audit(req: Request, companyId: number, entity: Entity, itemId: number | null, action: string, description: string,
  oldValues: Row | null, newValues: Row | null): Promise<void> {
  await recordAudit(req, {
    action,
    // Todo el contenido de un perfil se audita bajo la empresa: el ADMIN lo consulta en un solo historial.
    entityType: 'company_profile',
    entityId: companyId,
    description: description.slice(0, 500),
    oldValues: oldValues ? { entity, item_id: itemId, ...oldValues } : null,
    newValues: newValues ? { entity, item_id: itemId, ...newValues } : null,
  });
}

// =============================================================================== perfil (1:1)
interface CompanyRow {
  id: number;
  name: string;
  status: string;
  logo_url: string | null;
  description: string | null;
}

async function findCompany(companyId: number): Promise<CompanyRow> {
  const company = await queryOne<CompanyRow>('SELECT id, name, status, logo_url, description FROM companies WHERE id = ?', [companyId]);
  if (!company) throw ApiError.notFound('Empresa no encontrada');
  return company;
}

/** Slug único derivado del nombre comercial: «Transportes Línea» → transportes-linea (-2, -3… si ya existe). */
async function uniqueSlug(base: string, exceptCompanyId?: number): Promise<string> {
  const root = slugify(base).slice(0, 100) || 'empresa';
  for (let n = 1; n < 500; n += 1) {
    const candidate = n === 1 ? root : `${root}-${n}`;
    const taken = await queryOne('SELECT company_id FROM company_profiles WHERE slug = ? AND company_id <> ?', [candidate, exceptCompanyId ?? 0]);
    if (!taken) return candidate;
  }
  throw ApiError.conflict('No se pudo generar una URL única para la empresa');
}

/** El perfil se crea la primera vez que la empresa (o el ADMIN) lo abre: en DRAFT, sin publicar nada. */
async function ensureProfile(companyId: number): Promise<Row> {
  const existing = await queryOne<Row>('SELECT * FROM company_profiles WHERE company_id = ?', [companyId]);
  if (existing) return existing;
  const company = await findCompany(companyId);
  const slug = await uniqueSlug(company.name);
  try {
    await execute('INSERT INTO company_profiles (company_id, slug) VALUES (?, ?)', [companyId, slug]);
  } catch (error) {
    // Dos pestañas abriendo el perfil a la vez: la segunda encuentra la fila de la primera.
    if ((error as { code?: string }).code !== 'ER_DUP_ENTRY') throw error;
  }
  return (await queryOne<Row>('SELECT * FROM company_profiles WHERE company_id = ?', [companyId]))!;
}

function presentProfile(row: Row, company: CompanyRow): Row {
  const decoded = decode(row);
  return {
    ...decoded,
    company: { id: company.id, name: company.name, status: company.status, logo_url: company.logo_url },
    is_published: decoded.published_content !== null,
  };
}

export async function getProfile(req: Request): Promise<Row> {
  const companyId = companyFor(req);
  const company = await findCompany(companyId);
  return presentProfile(await ensureProfile(companyId), company);
}

export async function updateProfile(req: Request, body: Row): Promise<Row> {
  const companyId = companyFor(req);
  const company = await findCompany(companyId);
  const current = await ensureProfile(companyId);
  const decoded = decode(current);

  const changed: Row = {};
  const previous: Row = {};
  for (const field of EDITABLE.profile) {
    if (!(field in body) || body[field] === undefined) continue;
    if (sameValue(decoded[field], body[field])) continue;
    changed[field] = body[field];
    previous[field] = decoded[field];
  }
  if (Object.keys(changed).length === 0) return presentProfile(current, company);

  const sets = Object.keys(changed).map((field) => `\`${field}\` = ?`);
  await execute(
    `UPDATE company_profiles SET ${sets.join(', ')}, review_status = 'DRAFT', submitted_at = NULL WHERE company_id = ?`,
    [...Object.keys(changed).map((field) => encode(field, changed[field])), companyId],
  );
  await audit(req, companyId, 'profile', null, 'UPDATE', `Editó el perfil público de «${company.name}» (queda en borrador)`, previous, changed);
  return getProfile(req);
}

/** Solo el ADMIN cambia la URL pública (información crítica). */
export async function updateProfileSlug(req: Request, slug: string): Promise<Row> {
  if (!actorIsAdmin(req)) throw ApiError.forbidden('Solo un administrador de la plataforma puede cambiar la URL pública');
  const companyId = companyFor(req);
  const current = await ensureProfile(companyId);
  if (current.slug === slug) return getProfile(req);
  const taken = await queryOne('SELECT company_id FROM company_profiles WHERE slug = ? AND company_id <> ?', [slug, companyId]);
  if (taken) throw ApiError.conflict('Esa URL ya la usa otra empresa');
  await execute('UPDATE company_profiles SET slug = ? WHERE company_id = ?', [slug, companyId]);
  await audit(req, companyId, 'profile', null, 'UPDATE', `Cambió la URL pública a /empresas/${slug}`, { slug: current.slug }, { slug });
  return getProfile(req);
}

// =============================================================================== imágenes
function validateSize(file: UploadedFile): { width: number; height: number } {
  const size = readImageSize(file.buffer, file.mimetype);
  if (!size) throw ApiError.badRequest('No se pudo leer el tamaño de la imagen: sube un JPG, PNG o WebP válido');
  const { minSide, maxSide, maxPixels } = IMAGE_LIMITS;
  if (size.width < minSide || size.height < minSide) throw ApiError.badRequest(`La imagen es demasiado pequeña: mínimo ${minSide} × ${minSide} px`);
  if (size.width > maxSide || size.height > maxSide || size.width * size.height > maxPixels) {
    throw ApiError.badRequest(`La imagen es demasiado grande: máximo ${maxSide} px por lado`);
  }
  return size;
}

/** Guarda la foto en el almacén público de la empresa. Si algo falla después, quien llama la borra. */
function storeCompanyImage(companyId: number, file: UploadedFile | undefined): { reference: string; width: number; height: number } {
  if (!file) throw ApiError.badRequest('Adjunta la imagen en el campo «file»');
  const stored = storePublicImage(file, { kind: 'company-media', companyId });
  try {
    return { reference: stored.reference, ...validateSize(file) };
  } catch (error) {
    deletePublicFile(stored.reference);
    throw error;
  }
}

export const PROFILE_IMAGE_SLOTS = { cover: 'cover_image', about: 'about_image' } as const;
export type ProfileImageSlot = keyof typeof PROFILE_IMAGE_SLOTS;

export async function setProfileImage(req: Request, slot: ProfileImageSlot, file: UploadedFile | undefined): Promise<Row> {
  const field = PROFILE_IMAGE_SLOTS[slot];
  if (!field) throw ApiError.notFound('Imagen no encontrada');
  const companyId = companyFor(req);
  const company = await findCompany(companyId);
  const current = await ensureProfile(companyId);
  const stored = storeCompanyImage(companyId, file);
  try {
    await execute(`UPDATE company_profiles SET \`${field}\` = ?, review_status = 'DRAFT', submitted_at = NULL WHERE company_id = ?`, [stored.reference, companyId]);
  } catch (error) {
    deletePublicFile(stored.reference);
    throw error;
  }
  const published = parseJson(current.published_content) as Row | null;
  // La foto anterior se conserva si la instantánea pública todavía la usa.
  releaseImages(imagesOf('profile', { [field]: current[field] }), imagesOf('profile', published));
  await audit(req, companyId, 'profile', null, 'UPDATE', `Cambió la imagen «${slot}» del perfil de «${company.name}»`, { [field]: current[field] }, { [field]: stored.reference });
  return getProfile(req);
}

export async function removeProfileImage(req: Request, slot: ProfileImageSlot): Promise<Row> {
  const field = PROFILE_IMAGE_SLOTS[slot];
  if (!field) throw ApiError.notFound('Imagen no encontrada');
  const companyId = companyFor(req);
  const current = await ensureProfile(companyId);
  if (current[field]) {
    await execute(`UPDATE company_profiles SET \`${field}\` = NULL, review_status = 'DRAFT', submitted_at = NULL WHERE company_id = ?`, [companyId]);
    releaseImages(imagesOf('profile', { [field]: current[field] }), imagesOf('profile', parseJson(current.published_content) as Row | null));
    await audit(req, companyId, 'profile', null, 'UPDATE', `Quitó la imagen «${slot}» del perfil`, { [field]: current[field] }, { [field]: null });
  }
  return getProfile(req);
}

// =============================================================================== elementos (servicios, agencias, galería)
async function findItem(entity: ItemEntity, companyId: number, id: number): Promise<Row> {
  const row = await queryOne<Row>(`SELECT * FROM ${TABLES[entity]} WHERE id = ? AND company_id = ? AND deleted_at IS NULL`, [id, companyId]);
  if (!row) throw ApiError.notFound(`No se encontró el ${ENTITY_LABEL[entity]}`);
  return row;
}

export async function listItems(req: Request, entity: ItemEntity): Promise<Row[]> {
  const companyId = companyFor(req);
  const rows = await query<Row>(
    `SELECT * FROM ${TABLES[entity]} WHERE company_id = ? AND deleted_at IS NULL ORDER BY display_order ASC, id ASC`,
    [companyId],
  );
  return rows.map((row) => ({ ...decode(row), is_published: row.published_content !== null }));
}

async function assertLocation(locationId: unknown): Promise<void> {
  if (locationId === null || locationId === undefined) return;
  const location = await queryOne("SELECT id FROM locations WHERE id = ? AND status = 'ACTIVE'", [locationId]);
  if (!location) throw ApiError.badRequest('La ubicación indicada no existe o está inactiva');
}

async function nextOrder(entity: ItemEntity, companyId: number): Promise<number> {
  const row = await queryOne<{ n: number; next: number }>(
    `SELECT COUNT(*) AS n, COALESCE(MAX(display_order), -1) + 1 AS next FROM ${TABLES[entity]} WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );
  if (Number(row?.n ?? 0) >= MAX_ITEMS[entity]) throw ApiError.badRequest(`Como máximo ${MAX_ITEMS[entity]} elementos de este tipo`);
  return Number(row?.next ?? 0);
}

export async function createItem(req: Request, entity: Exclude<ItemEntity, 'gallery'>, body: Row): Promise<Row> {
  const companyId = companyFor(req);
  await findCompany(companyId);
  if (entity === 'agency') await assertLocation(body.location_id);
  const next = await nextOrder(entity, companyId); // también aplica el tope de elementos
  const order = body.display_order !== undefined ? Number(body.display_order) : next;

  const fields = EDITABLE[entity].filter((field) => field !== 'display_order' && body[field] !== undefined);
  const columns = ['company_id', 'display_order', ...fields];
  const values = [companyId, order, ...fields.map((field) => encode(field, body[field]))];
  const result = await execute(
    `INSERT INTO ${TABLES[entity]} (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    values,
  );
  const created = await findItem(entity, companyId, result.insertId);
  await audit(req, companyId, entity, result.insertId, 'CREATE', `Creó ${ENTITY_LABEL[entity]} «${String(created.name ?? result.insertId)}» (borrador)`, null, snapshotOf(entity, created));
  return { ...decode(created), is_published: false };
}

export async function updateItem(req: Request, entity: ItemEntity, id: number, body: Row): Promise<Row> {
  const companyId = companyFor(req);
  const current = await findItem(entity, companyId, id);
  const decoded = decode(current);
  if (entity === 'agency' && body.location_id !== undefined) await assertLocation(body.location_id);

  const changed: Row = {};
  const previous: Row = {};
  for (const field of EDITABLE[entity]) {
    if (!(field in body) || body[field] === undefined) continue;
    if (sameValue(decoded[field], body[field])) continue;
    changed[field] = body[field];
    previous[field] = decoded[field];
  }
  if (Object.keys(changed).length === 0) return { ...decoded, is_published: current.published_content !== null };

  // Cambiar solo el orden no altera el contenido: no hace falta volver a revisarlo.
  const onlyOrder = Object.keys(changed).every((field) => field === 'display_order');
  const sets = Object.keys(changed).map((field) => `\`${field}\` = ?`);
  await execute(
    `UPDATE ${TABLES[entity]} SET ${sets.join(', ')}${onlyOrder ? '' : ", review_status = 'DRAFT', submitted_at = NULL"} WHERE id = ? AND company_id = ?`,
    [...Object.keys(changed).map((field) => encode(field, changed[field])), id, companyId],
  );
  await audit(req, companyId, entity, id, 'UPDATE', `Editó ${ENTITY_LABEL[entity]} #${id}${onlyOrder ? ' (orden)' : ' (queda en borrador)'}`, previous, changed);
  const updated = await findItem(entity, companyId, id);
  return { ...decode(updated), is_published: updated.published_content !== null };
}

/**
 * Baja LÓGICA: la fila sigue existiendo (historial, auditoría y referencias), pero deja de mostrarse en
 * el panel y en el público al instante. Ocultar contenido propio no necesita aprobación.
 */
export async function deleteItem(req: Request, entity: ItemEntity, id: number): Promise<void> {
  const companyId = companyFor(req);
  const current = await findItem(entity, companyId, id);
  await execute(`UPDATE ${TABLES[entity]} SET deleted_at = NOW() WHERE id = ? AND company_id = ?`, [id, companyId]);
  await audit(req, companyId, entity, id, 'DELETE', `Eliminó ${ENTITY_LABEL[entity]} #${id} (baja lógica)`, snapshotOf(entity, current), null);
}

export async function setItemActive(req: Request, entity: ItemEntity, id: number, isActive: boolean): Promise<Row> {
  const companyId = companyFor(req);
  const current = await findItem(entity, companyId, id);
  if (Boolean(current.is_active) !== isActive) {
    await execute(`UPDATE ${TABLES[entity]} SET is_active = ? WHERE id = ? AND company_id = ?`, [isActive ? 1 : 0, id, companyId]);
    await audit(req, companyId, entity, id, 'UPDATE', `${isActive ? 'Activó' : 'Desactivó'} ${ENTITY_LABEL[entity]} #${id}`, { is_active: Boolean(current.is_active) }, { is_active: isActive });
  }
  const updated = await findItem(entity, companyId, id);
  return { ...decode(updated), is_published: updated.published_content !== null };
}

/** Reordena con la lista completa de ids de la empresa. Un id ajeno o que falte → 400, sin tocar nada. */
export async function reorderItems(req: Request, entity: ItemEntity, ids: number[]): Promise<Row[]> {
  const companyId = companyFor(req);
  const own = await query<{ id: number }>(`SELECT id FROM ${TABLES[entity]} WHERE company_id = ? AND deleted_at IS NULL`, [companyId]);
  const ownIds = new Set(own.map((row) => Number(row.id)));
  if (ids.length !== ownIds.size || new Set(ids).size !== ids.length || ids.some((id) => !ownIds.has(id))) {
    throw ApiError.badRequest('Envía todos los elementos de tu empresa, cada uno una sola vez');
  }
  await withTransaction(async (connection) => {
    for (const [index, id] of ids.entries()) {
      await connection.execute(`UPDATE ${TABLES[entity]} SET display_order = ? WHERE id = ? AND company_id = ?`, [index, id, companyId]);
    }
  });
  await audit(req, companyId, entity, null, 'UPDATE', `Reordenó ${ENTITY_LABEL[entity]}s`, null, { order: ids });
  return listItems(req, entity);
}

export async function setItemImage(req: Request, entity: Exclude<ItemEntity, 'gallery'>, id: number, file: UploadedFile | undefined): Promise<Row> {
  const companyId = companyFor(req);
  const current = await findItem(entity, companyId, id);
  const stored = storeCompanyImage(companyId, file);
  try {
    await execute(`UPDATE ${TABLES[entity]} SET image = ?, review_status = 'DRAFT', submitted_at = NULL WHERE id = ? AND company_id = ?`, [stored.reference, id, companyId]);
  } catch (error) {
    deletePublicFile(stored.reference);
    throw error;
  }
  releaseImages(imagesOf(entity, current), imagesOf(entity, parseJson(current.published_content) as Row | null));
  await audit(req, companyId, entity, id, 'UPDATE', `Cambió la imagen de ${ENTITY_LABEL[entity]} #${id}`, { image: current.image }, { image: stored.reference });
  const updated = await findItem(entity, companyId, id);
  return { ...decode(updated), is_published: updated.published_content !== null };
}

export async function removeItemImage(req: Request, entity: Exclude<ItemEntity, 'gallery'>, id: number): Promise<Row> {
  const companyId = companyFor(req);
  const current = await findItem(entity, companyId, id);
  if (current.image) {
    await execute(`UPDATE ${TABLES[entity]} SET image = NULL, review_status = 'DRAFT', submitted_at = NULL WHERE id = ? AND company_id = ?`, [id, companyId]);
    releaseImages(imagesOf(entity, current), imagesOf(entity, parseJson(current.published_content) as Row | null));
    await audit(req, companyId, entity, id, 'UPDATE', `Quitó la imagen de ${ENTITY_LABEL[entity]} #${id}`, { image: current.image }, { image: null });
  }
  const updated = await findItem(entity, companyId, id);
  return { ...decode(updated), is_published: updated.published_content !== null };
}

/** Galería: el archivo ES el elemento. Se sube con sus metadatos y nace en borrador. */
export async function createGalleryImage(req: Request, file: UploadedFile | undefined, body: Row): Promise<Row> {
  const companyId = companyFor(req);
  await findCompany(companyId);
  const order = await nextOrder('gallery', companyId);
  const stored = storeCompanyImage(companyId, file);
  let insertId: number;
  try {
    const result = await execute(
      `INSERT INTO company_gallery_images (company_id, image, width, height, title, description, category, display_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [companyId, stored.reference, stored.width, stored.height, body.title ?? null, body.description ?? null, body.category ?? 'OTHER',
        body.display_order !== undefined ? Number(body.display_order) : order],
    );
    insertId = result.insertId;
  } catch (error) {
    deletePublicFile(stored.reference);
    throw error;
  }
  const created = await findItem('gallery', companyId, insertId);
  await audit(req, companyId, 'gallery', insertId, 'CREATE', `Subió una imagen a la galería (#${insertId}, borrador)`, null, snapshotOf('gallery', created));
  return { ...decode(created), is_published: false };
}

// =============================================================================== envío a revisión
export async function submitForReview(req: Request, entity: Entity, id: number | null): Promise<Row> {
  const companyId = companyFor(req);
  const row = entity === 'profile' ? await ensureProfile(companyId) : await findItem(entity, companyId, id!);
  const status = row.review_status as ReviewStatus;
  if (status === 'PENDING') throw ApiError.conflict('Ya está pendiente de revisión');
  if (status === 'APPROVED') throw ApiError.conflict('No hay cambios que revisar: lo publicado coincide con lo guardado');

  if (entity === 'profile') {
    const decoded = decode(row);
    const hasContent = ['tagline', 'about_body', 'history', 'mission', 'vision', 'contact_phone', 'contact_email'].some((field) => Boolean(decoded[field]));
    if (!hasContent) throw ApiError.badRequest('Completa al menos la descripción o un dato de contacto antes de enviar el perfil');
    await execute("UPDATE company_profiles SET review_status = 'PENDING', submitted_at = NOW() WHERE company_id = ?", [companyId]);
  } else {
    await execute(`UPDATE ${TABLES[entity]} SET review_status = 'PENDING', submitted_at = NOW() WHERE id = ? AND company_id = ?`, [id, companyId]);
  }
  await audit(req, companyId, entity, id, 'SUBMIT', `Envió a revisión ${ENTITY_LABEL[entity]}${id ? ` #${id}` : ''}`, { review_status: status }, { review_status: 'PENDING' });
  return entity === 'profile' ? getProfile(req) : { ...decode(await findItem(entity, companyId, id!)) };
}

// =============================================================================== moderación (ADMIN)
export interface ModerationInput {
  entity: Entity;
  id?: number;
  action: 'approve' | 'reject' | 'suspend' | 'unsuspend';
  note?: string | null;
}

export async function moderate(req: Request, companyId: number, input: ModerationInput): Promise<Row> {
  const reviewer = requireAuth(req);
  if (reviewer.role !== 'ADMIN') throw ApiError.forbidden('Solo un administrador de la plataforma puede moderar');
  const company = await findCompany(companyId);
  const table = input.entity === 'profile' ? 'company_profiles' : TABLES[input.entity];
  const where = input.entity === 'profile' ? 'company_id = ?' : 'id = ? AND company_id = ? AND deleted_at IS NULL';
  const whereParams = input.entity === 'profile' ? [companyId] : [input.id, companyId];

  const row = await queryOne<Row>(`SELECT * FROM ${table} WHERE ${where}`, whereParams);
  if (!row) throw ApiError.notFound(`No se encontró el ${ENTITY_LABEL[input.entity]}`);
  const status = row.review_status as ReviewStatus;
  const label = `${ENTITY_LABEL[input.entity]}${input.id ? ` #${input.id}` : ''} de «${company.name}»`;
  const note = input.note ?? null;

  switch (input.action) {
    case 'approve': {
      // Se aprueba lo enviado; el ADMIN también puede aprobar un borrador que él mismo corrigió.
      if (status !== 'PENDING' && status !== 'DRAFT') throw ApiError.conflict('Solo se aprueba contenido pendiente o en borrador');
      const snapshot = snapshotOf(input.entity, row);
      const previous = parseJson(row.published_content) as Row | null;
      await execute(
        `UPDATE ${table} SET review_status = 'APPROVED', published_content = ?, published_at = NOW(), moderation_note = NULL,
           reviewed_at = NOW(), reviewed_by = ? WHERE ${where}`,
        [JSON.stringify(snapshot), reviewer.id, ...whereParams],
      );
      // Las fotos de la versión publicada anterior que ya nadie usa se borran.
      releaseImages(imagesOf(input.entity, previous), imagesOf(input.entity, snapshot));
      await audit(req, companyId, input.entity, input.id ?? null, 'APPROVE', `Aprobó y publicó ${label}`, { review_status: status }, { review_status: 'APPROVED' });
      break;
    }
    case 'reject': {
      if (status !== 'PENDING') throw ApiError.conflict('Solo se rechaza contenido pendiente de revisión');
      await execute(
        `UPDATE ${table} SET review_status = 'REJECTED', moderation_note = ?, reviewed_at = NOW(), reviewed_by = ? WHERE ${where}`,
        [note, reviewer.id, ...whereParams],
      );
      await audit(req, companyId, input.entity, input.id ?? null, 'REJECT', `Rechazó ${label}: ${note ?? ''}`, { review_status: status }, { review_status: 'REJECTED', moderation_note: note });
      break;
    }
    case 'suspend': {
      if (row.suspended_at) throw ApiError.conflict('Ya está suspendido');
      await execute(`UPDATE ${table} SET suspended_at = NOW(), suspension_reason = ? WHERE ${where}`, [note, ...whereParams]);
      await audit(req, companyId, input.entity, input.id ?? null, 'SUSPEND', `Suspendió ${label}: ${note ?? ''}`, { suspended: false }, { suspended: true, suspension_reason: note });
      break;
    }
    case 'unsuspend': {
      if (!row.suspended_at) throw ApiError.conflict('No está suspendido');
      await execute(`UPDATE ${table} SET suspended_at = NULL, suspension_reason = NULL WHERE ${where}`, whereParams);
      await audit(req, companyId, input.entity, input.id ?? null, 'UNSUSPEND', `Levantó la suspensión de ${label}`, { suspended: true }, { suspended: false });
      break;
    }
    default:
      throw ApiError.badRequest('Acción no válida');
  }
  return adminDetail(companyId);
}

export async function moderationQueue(filter: string | undefined): Promise<Row[]> {
  const rows = await query<Row>(
    `SELECT co.id AS company_id, co.name, co.status AS company_status, co.logo_url,
            cp.slug, cp.review_status AS profile_status, cp.published_at AS profile_published_at, cp.suspended_at AS profile_suspended_at,
            (SELECT COUNT(*) FROM company_services s WHERE s.company_id = co.id AND s.deleted_at IS NULL AND s.review_status = 'PENDING')
          + (SELECT COUNT(*) FROM company_agencies a WHERE a.company_id = co.id AND a.deleted_at IS NULL AND a.review_status = 'PENDING')
          + (SELECT COUNT(*) FROM company_gallery_images g WHERE g.company_id = co.id AND g.deleted_at IS NULL AND g.review_status = 'PENDING')
          + (CASE WHEN cp.review_status = 'PENDING' THEN 1 ELSE 0 END) AS pending_count,
            (SELECT COUNT(*) FROM company_services s WHERE s.company_id = co.id AND s.deleted_at IS NULL AND s.review_status = 'REJECTED')
          + (SELECT COUNT(*) FROM company_agencies a WHERE a.company_id = co.id AND a.deleted_at IS NULL AND a.review_status = 'REJECTED')
          + (SELECT COUNT(*) FROM company_gallery_images g WHERE g.company_id = co.id AND g.deleted_at IS NULL AND g.review_status = 'REJECTED')
          + (CASE WHEN cp.review_status = 'REJECTED' THEN 1 ELSE 0 END) AS rejected_count
     FROM companies co
     LEFT JOIN company_profiles cp ON cp.company_id = co.id
     ORDER BY pending_count DESC, co.name ASC`,
  );
  const list = rows.map((row) => ({ ...row, pending_count: Number(row.pending_count), rejected_count: Number(row.rejected_count) }));
  if (filter === 'PENDING') return list.filter((row) => row.pending_count > 0);
  if (filter === 'REJECTED') return list.filter((row) => row.rejected_count > 0);
  return list;
}

export async function adminDetail(companyId: number): Promise<Row> {
  const company = await findCompany(companyId);
  const profile = await ensureProfile(companyId);
  const items = async (entity: ItemEntity) =>
    (await query<Row>(`SELECT * FROM ${TABLES[entity]} WHERE company_id = ? AND deleted_at IS NULL ORDER BY display_order ASC, id ASC`, [companyId]))
      .map((row) => ({ ...decode(row), is_published: row.published_content !== null }));
  return {
    company,
    profile: presentProfile(profile, company),
    services: await items('service'),
    agencies: await items('agency'),
    gallery: await items('gallery'),
    destinations: await companyDestinations(companyId),
    fleet: await companyFleet(companyId),
    reviews: await reviewSummary(companyId),
  };
}

export async function profileAudit(companyId: number, page: number, limit: number): Promise<{ rows: Row[]; total: number }> {
  const total = await queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM audit_logs WHERE entity_type = 'company_profile' AND entity_id = ?", [companyId]);
  const rows = await query<Row>(
    `SELECT al.id, al.action, al.description, al.old_values, al.new_values, al.created_at, u.first_name, u.last_name, r.name AS role
     FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id LEFT JOIN roles r ON r.id = u.role_id
     WHERE al.entity_type = 'company_profile' AND al.entity_id = ?
     ORDER BY al.created_at DESC, al.id DESC LIMIT ? OFFSET ?`,
    [companyId, limit, (page - 1) * limit],
  );
  return { rows: rows.map((row) => ({ ...row, old_values: parseJson(row.old_values), new_values: parseJson(row.new_values) })), total: Number(total?.total ?? 0) };
}

// =============================================================================== datos derivados (reutilizados)
/** Estados de viaje que ofrece la búsqueda pública (`/public/trips`): la «próxima salida» usa la misma regla. */
const SEARCHABLE_TRIP_STATUSES = "'SCHEDULED', 'BOARDING', 'DELAYED'";

/**
 * F18-20 · fecha (AAAA-MM-DD) de la próxima salida de la empresa, con la misma regla que el listado `/public/companies`
 * (F18-19D): así «Buscar viajes» del sitio de la empresa abre un día con salidas. `null` si no hay ninguna.
 */
export async function nextDepartureDate(companyId: number): Promise<string | null> {
  const row = await queryOne<{ next_departure_date: string | null }>(
    `SELECT DATE_FORMAT(MIN(t.departure_datetime), '%Y-%m-%d') AS next_departure_date
     FROM trips t JOIN routes r ON r.id = t.route_id JOIN buses b ON b.id = t.bus_id
     WHERE r.company_id = ? AND r.status = 'ACTIVE' AND t.status IN (${SEARCHABLE_TRIP_STATUSES}) AND t.departure_datetime >= NOW()`,
    [companyId],
  );
  return row?.next_departure_date ? String(row.next_departure_date) : null;
}

/** Destinos de la empresa a partir de sus rutas ACTIVAS; imagen y ficha si existe un destino editorial. */
export async function companyDestinations(companyId: number): Promise<Row[]> {
  const rows = await query<Row>(
    `SELECT dl.city AS city, dl.department AS department, ol.city AS origin_city,
            COUNT(DISTINCT CASE WHEN t.status = 'SCHEDULED' AND t.departure_datetime >= NOW() THEN t.id END) AS upcoming_trips,
            MIN(CASE WHEN t.status = 'SCHEDULED' AND t.departure_datetime >= NOW() THEN t.base_price END) AS min_price,
            DATE_FORMAT(MIN(CASE WHEN t.status IN (${SEARCHABLE_TRIP_STATUSES}) AND t.departure_datetime >= NOW() THEN t.departure_datetime END), '%Y-%m-%d') AS next_departure_date
     FROM routes r
     JOIN locations ol ON ol.id = r.origin_location_id
     JOIN locations dl ON dl.id = r.destination_location_id
     LEFT JOIN trips t ON t.route_id = r.id
     WHERE r.company_id = ? AND r.status = 'ACTIVE'
     GROUP BY dl.city, dl.department, ol.city
     ORDER BY dl.city ASC, ol.city ASC`,
    [companyId],
  );
  const editorial = await query<Row>(
    `SELECT l.city, d.slug, d.name, d.subtitle, d.hero_image
     FROM destinations d JOIN locations l ON l.id = d.location_id
     WHERE d.status = 'ACTIVE' ORDER BY d.display_order ASC, d.id ASC`,
  );
  const byCity = new Map<string, Row>();
  for (const entry of editorial) if (!byCity.has(String(entry.city))) byCity.set(String(entry.city), entry);

  const grouped = new Map<string, Row & { origins: Row[] }>();
  for (const row of rows) {
    const key = String(row.city);
    const card = grouped.get(key) ?? {
      city: row.city,
      department: row.department,
      destination: byCity.has(key)
        ? { slug: byCity.get(key)!.slug, name: byCity.get(key)!.name, subtitle: byCity.get(key)!.subtitle, image: byCity.get(key)!.hero_image }
        : null,
      upcoming_trips: 0,
      min_price: null as number | null,
      next_departure_date: null as string | null,
      origins: [] as Row[],
    };
    card.upcoming_trips = Number(card.upcoming_trips) + Number(row.upcoming_trips ?? 0);
    const price = row.min_price === null || row.min_price === undefined ? null : Number(row.min_price);
    if (price !== null && (card.min_price === null || price < Number(card.min_price))) card.min_price = price;
    const next = row.next_departure_date ? String(row.next_departure_date) : null;
    if (next && (!card.next_departure_date || next < String(card.next_departure_date))) card.next_departure_date = next;
    card.origins.push({ city: row.origin_city, upcoming_trips: Number(row.upcoming_trips ?? 0), next_departure_date: next });
    grouped.set(key, card);
  }
  return [...grouped.values()].sort((a, b) => Number(b.upcoming_trips) - Number(a.upcoming_trips) || String(a.city).localeCompare(String(b.city), 'es'));
}

/** Flota ACTIVA agrupada por tipo. Nunca placa, código, marca ni identificadores internos. */
export async function companyFleet(companyId: number): Promise<Row[]> {
  const buses = await query<{ type_id: number | null; type_name: string | null; type_description: string | null; capacity: number; amenities: string | null }>(
    `SELECT bt.id AS type_id, bt.name AS type_name, bt.description AS type_description, b.capacity, b.amenities
     FROM buses b LEFT JOIN bus_types bt ON bt.id = b.bus_type_id
     WHERE b.company_id = ? AND b.status = 'ACTIVE'`,
    [companyId],
  );
  const groups = new Map<string, { type: string; description: string | null; buses: number; min_capacity: number; max_capacity: number; amenities: Set<string> }>();
  for (const bus of buses) {
    const key = String(bus.type_id ?? 'otro');
    const group = groups.get(key) ?? { type: bus.type_name ?? 'Otros buses', description: bus.type_description, buses: 0, min_capacity: bus.capacity, max_capacity: bus.capacity, amenities: new Set<string>() };
    group.buses += 1;
    group.min_capacity = Math.min(group.min_capacity, bus.capacity);
    group.max_capacity = Math.max(group.max_capacity, bus.capacity);
    const amenities = parseJson(bus.amenities);
    if (Array.isArray(amenities)) {
      for (const item of amenities) if (typeof item === 'string' && item.trim() && item.length <= 60) group.amenities.add(item.trim());
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, amenities: [...group.amenities].sort((a, b) => a.localeCompare(b, 'es')) }))
    .sort((a, b) => b.buses - a.buses);
}

async function reviewSummary(companyId: number): Promise<Row> {
  const summary = await queryOne<Row>(
    "SELECT ROUND(AVG(rating), 1) AS rating, COUNT(*) AS total FROM reviews WHERE company_id = ? AND status = 'PUBLISHED'",
    [companyId],
  );
  const distribution = await query<{ rating: number; total: number }>(
    "SELECT rating, COUNT(*) AS total FROM reviews WHERE company_id = ? AND status = 'PUBLISHED' GROUP BY rating",
    [companyId],
  );
  return {
    rating: summary?.rating === null || summary?.rating === undefined ? null : Number(summary.rating),
    total: Number(summary?.total ?? 0),
    distribution: Object.fromEntries([5, 4, 3, 2, 1].map((stars) => [stars, Number(distribution.find((d) => Number(d.rating) === stars)?.total ?? 0)])),
  };
}

// =============================================================================== vista pública y vista previa
const PUBLIC_GALLERY_PAGE = 12;

async function publicCompanyBySlug(slug: string): Promise<{ company: CompanyRow; profile: Row }> {
  const profile = await queryOne<Row>(
    `SELECT cp.* FROM company_profiles cp JOIN companies co ON co.id = cp.company_id
     WHERE cp.slug = ? AND co.status = 'ACTIVE' AND cp.published_content IS NOT NULL AND cp.suspended_at IS NULL`,
    [slug],
  );
  // Sin perfil publicado (o empresa no activa, o suspendido) la URL no existe: 404, sin distinguir el motivo.
  if (!profile) throw ApiError.notFound('Empresa no encontrada');
  return { company: await findCompany(Number(profile.company_id)), profile };
}

type Source = 'published' | 'working';

/**
 * F18-19B (F-06) · la vista PÚBLICA no lleva identificadores internos: ni el id secuencial de cada elemento (la
 * interfaz usa el orden y, en la galería, la imagen, que es un nombre aleatorio) ni el `location_id` de la agencia
 * (clave interna de `locations`; el público ya ve ciudad, dirección y coordenadas). La copia de trabajo del panel
 * de la empresa y la moderación los conservan: allí sí hacen falta para editar.
 */
const PUBLIC_OMIT: Record<ItemEntity, readonly string[]> = { service: [], agency: ['location_id'], gallery: [] };
function publicContent(entity: ItemEntity, content: Row): Row {
  return Object.fromEntries(Object.entries(content).filter(([key]) => !PUBLIC_OMIT[entity].includes(key)));
}

async function visibleItems(entity: ItemEntity, companyId: number, source: Source, limit?: number, offset = 0): Promise<{ rows: Row[]; total: number }> {
  const filter = source === 'published'
    ? 'published_content IS NOT NULL AND suspended_at IS NULL AND is_active = 1 AND deleted_at IS NULL'
    : 'is_active = 1 AND deleted_at IS NULL';
  const total = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM ${TABLES[entity]} WHERE company_id = ? AND ${filter}`, [companyId]);
  const rows = await query<Row>(
    `SELECT * FROM ${TABLES[entity]} WHERE company_id = ? AND ${filter} ORDER BY display_order ASC, id ASC${limit ? ' LIMIT ? OFFSET ?' : ''}`,
    limit ? [companyId, limit, offset] : [companyId],
  );
  return {
    total: Number(total?.total ?? 0),
    rows: rows.map((row) => {
      const content = source === 'published' ? (parseJson(row.published_content) as Row) : snapshotOf(entity, row);
      return source === 'published'
        ? publicContent(entity, content)
        : { id: row.id, ...content, review_status: row.review_status, is_published: row.published_content !== null };
    }),
  };
}

async function assemble(company: CompanyRow, profileContent: Row, slug: string, source: Source): Promise<Row> {
  const [services, agencies, gallery] = await Promise.all([
    visibleItems('service', company.id, source),
    visibleItems('agency', company.id, source),
    visibleItems('gallery', company.id, source, PUBLIC_GALLERY_PAGE, 0),
  ]);
  return {
    company: { id: company.id, name: company.name, logo_url: company.logo_url, description: company.description },
    slug,
    profile: profileContent,
    reviews: await reviewSummary(company.id),
    services: services.rows,
    agencies: agencies.rows,
    gallery: { items: gallery.rows, total: gallery.total, page_size: PUBLIC_GALLERY_PAGE },
    destinations: await companyDestinations(company.id),
    fleet: await companyFleet(company.id),
    next_departure_date: await nextDepartureDate(company.id),
  };
}

export async function publicProfile(slug: string): Promise<Row> {
  const { company, profile } = await publicCompanyBySlug(slug);
  return assemble(company, parseJson(profile.published_content) as Row, String(profile.slug), 'published');
}

/** Vista previa de la empresa: la COPIA DE TRABAJO (incluido lo pendiente), marcada como tal. Nunca pública. */
export async function previewProfile(req: Request): Promise<Row> {
  const companyId = companyFor(req);
  const company = await findCompany(companyId);
  const profile = await ensureProfile(companyId);
  const assembled = await assemble(company, snapshotOf('profile', profile), String(profile.slug), 'working');
  return { ...assembled, preview: true, profile_status: profile.review_status, is_published: profile.published_content !== null };
}

export async function publicGallery(slug: string, page: number): Promise<{ rows: Row[]; total: number; limit: number }> {
  const { company } = await publicCompanyBySlug(slug);
  const { rows, total } = await visibleItems('gallery', company.id, 'published', PUBLIC_GALLERY_PAGE, (page - 1) * PUBLIC_GALLERY_PAGE);
  return { rows, total, limit: PUBLIC_GALLERY_PAGE };
}

/** Opiniones PUBLICADAS del sistema de reseñas existente, con la respuesta de la empresa si la hay. */
export async function publicReviews(slug: string, page: number, limit: number): Promise<{ rows: Row[]; total: number }> {
  const { company } = await publicCompanyBySlug(slug);
  const total = await queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM reviews WHERE company_id = ? AND status = 'PUBLISHED'", [company.id]);
  const rows = await query<Row>(
    `SELECT rv.id, rv.rating, rv.title, rv.comment, rv.created_at, u.first_name,
            (SELECT rr.response FROM review_responses rr WHERE rr.review_id = rv.id ORDER BY rr.id DESC LIMIT 1) AS company_response,
            (SELECT rr.created_at FROM review_responses rr WHERE rr.review_id = rv.id ORDER BY rr.id DESC LIMIT 1) AS company_response_at
     FROM reviews rv JOIN users u ON u.id = rv.user_id
     WHERE rv.company_id = ? AND rv.status = 'PUBLISHED'
     ORDER BY rv.created_at DESC, rv.id DESC LIMIT ? OFFSET ?`,
    [company.id, limit, (page - 1) * limit],
  );
  // F18-19B (F-06): el id de la reseña solo servía de clave de lista; no se publica.
  return { rows: rows.map(({ id: _id, ...review }) => review), total: Number(total?.total ?? 0) };
}

/** Enlace del listado público: solo las empresas con perfil publicado tienen URL propia. */
export async function publicSlugs(): Promise<Map<number, { slug: string; tagline: string | null }>> {
  const rows = await query<{ company_id: number; slug: string; published_content: string }>(
    'SELECT company_id, slug, published_content FROM company_profiles WHERE published_content IS NOT NULL AND suspended_at IS NULL',
  );
  return new Map(rows.map((row) => [Number(row.company_id), { slug: row.slug, tagline: ((parseJson(row.published_content) as Row | null)?.tagline as string | null) ?? null }]));
}
