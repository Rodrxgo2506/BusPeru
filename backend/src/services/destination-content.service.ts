import type { Request } from 'express';
import type { RowDataPacket } from 'mysql2';
import { query, queryOne, withTransaction } from '../config/database';
import { ApiError } from '../utils/ApiError';
import { recordAudit } from './audit.service';
import {
  BRANDING_ASSETS,
  deletePublicFile,
  isPublicReference,
  storePublicImage,
  type BrandingAsset,
  type UploadedFile,
} from './file-storage.service';
import { SLUG_PATTERN } from '../validators/destination.validators';

/**
 * Contenido público de destinos e identidad visual (FASE 17).
 *
 * El CRUD de las tres tablas lo sirve el router genérico (`routes/resources.ts`), con su
 * validación, alcance y auditoría. Aquí vive solo lo que el CRUD genérico no hace:
 *
 *   · imágenes (subir, reemplazar, quitar) con el almacén de archivos compartido;
 *   · reordenación en bloque;
 *   · limpieza de archivos al borrar;
 *   · lecturas públicas (solo contenido ACTIVE y solo campos publicables);
 *   · identidad visual, guardada como referencias en `system_settings`.
 *
 * `price_from` es presentación: nada de este módulo toca viajes, reservas, pagos ni liquidaciones.
 */

type Row = Record<string, unknown>;

/* ------------------------------------------------------------------ imágenes */

interface ImageTable {
  table: 'destinations' | 'destination_attractions';
  column: 'hero_image' | 'festivities_image' | 'image';
  entityName: string;
  /** Carpeta del almacén: siempre la del DESTINO, también para sus atractivos. */
  destinationIdColumn: 'id' | 'destination_id';
}

const DESTINATION_IMAGE: ImageTable = { table: 'destinations', column: 'hero_image', entityName: 'Destino', destinationIdColumn: 'id' };
/** FASE 17B · imagen de la sección «Calendario festivo». Mismo almacén y misma carpeta del destino. */
const FESTIVITIES_IMAGE: ImageTable = { table: 'destinations', column: 'festivities_image', entityName: 'Destino', destinationIdColumn: 'id' };
const ATTRACTION_IMAGE: ImageTable = {
  table: 'destination_attractions',
  column: 'image',
  entityName: 'Atractivo',
  destinationIdColumn: 'destination_id',
};

/**
 * Guarda la imagen y la enlaza a la fila. El archivo se escribe ANTES de la transacción (ya
 * validado); si la fila no existe o el UPDATE falla, se borra el archivo recién escrito. El
 * anterior solo se borra cuando la base ya apunta al nuevo, así nunca queda una referencia rota.
 */
async function replaceImage(req: Request, target: ImageTable, id: number, file: UploadedFile | undefined): Promise<Row> {
  if (!file) throw ApiError.badRequest('Adjunta la imagen');

  const owner = await queryOne<{ destination_id: number }>(
    `SELECT ${target.destinationIdColumn} AS destination_id FROM ${target.table} WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!owner) throw ApiError.notFound(`${target.entityName} no encontrado`);

  const stored = storePublicImage(file, { kind: 'destination', destinationId: Number(owner.destination_id) });
  let previous: unknown;
  try {
    previous = await withTransaction(async (connection) => {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT ${target.column} AS reference FROM ${target.table} WHERE id = ? FOR UPDATE`,
        [id],
      );
      if (rows.length === 0) throw ApiError.notFound(`${target.entityName} no encontrado`);
      await connection.query(`UPDATE ${target.table} SET ${target.column} = ? WHERE id = ?`, [stored.reference, id]);
      return rows[0]!.reference;
    });
  } catch (error) {
    deletePublicFile(stored.reference);
    throw error;
  }
  if (previous !== stored.reference) deletePublicFile(previous);

  await recordAudit(req, {
    action: 'UPDATE',
    entityType: target.table,
    entityId: id,
    description: `Actualizó la imagen de ${target.entityName.toLowerCase()}`,
    oldValues: { [target.column]: previous ?? null },
    newValues: { [target.column]: stored.reference },
  });
  return (await queryOne<Row>(`SELECT * FROM ${target.table} WHERE id = ? LIMIT 1`, [id]))!;
}

async function removeImage(req: Request, target: ImageTable, id: number): Promise<Row> {
  const previous = await withTransaction(async (connection) => {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT ${target.column} AS reference FROM ${target.table} WHERE id = ? FOR UPDATE`,
      [id],
    );
    if (rows.length === 0) throw ApiError.notFound(`${target.entityName} no encontrado`);
    await connection.query(`UPDATE ${target.table} SET ${target.column} = NULL WHERE id = ?`, [id]);
    return rows[0]!.reference;
  });
  deletePublicFile(previous);

  if (previous) {
    await recordAudit(req, {
      action: 'UPDATE',
      entityType: target.table,
      entityId: id,
      description: `Quitó la imagen de ${target.entityName.toLowerCase()}`,
      oldValues: { [target.column]: previous },
      newValues: { [target.column]: null },
    });
  }
  return (await queryOne<Row>(`SELECT * FROM ${target.table} WHERE id = ? LIMIT 1`, [id]))!;
}

export const setDestinationImage = (req: Request, id: number, file: UploadedFile | undefined) => replaceImage(req, DESTINATION_IMAGE, id, file);
export const removeDestinationImage = (req: Request, id: number) => removeImage(req, DESTINATION_IMAGE, id);
export const setFestivitiesImage = (req: Request, id: number, file: UploadedFile | undefined) => replaceImage(req, FESTIVITIES_IMAGE, id, file);
export const removeFestivitiesImage = (req: Request, id: number) => removeImage(req, FESTIVITIES_IMAGE, id);
export const setAttractionImage = (req: Request, id: number, file: UploadedFile | undefined) => replaceImage(req, ATTRACTION_IMAGE, id, file);
export const removeAttractionImage = (req: Request, id: number) => removeImage(req, ATTRACTION_IMAGE, id);

/* ------------------------------------------------------------------ borrado */

/**
 * Un destino ACTIVE no se borra: primero se desactiva (desaparece del público) y luego, si de
 * verdad sobra, se elimina. Antes del DELETE se recogen las imágenes que la cascada va a dejar
 * huérfanas en disco.
 */
export async function prepareDestinationDelete(id: number, previous: Row): Promise<string[]> {
  if (previous.status === 'ACTIVE') {
    throw ApiError.conflict('Desactiva el destino antes de eliminarlo: un destino publicado no se borra directamente');
  }
  const attractions = await query<{ image: string | null }>('SELECT image FROM destination_attractions WHERE destination_id = ?', [id]);
  return [previous.hero_image, previous.festivities_image, ...attractions.map((row) => row.image)].filter(isPublicReference);
}

export async function cleanupDeletedFiles(_id: number, _previous: Row, prepared: unknown): Promise<void> {
  if (Array.isArray(prepared)) prepared.forEach(deletePublicFile);
}

export async function cleanupAttractionImage(_id: number, previous: Row): Promise<void> {
  deletePublicFile(previous.image);
}

/* ------------------------------------------------------------------ orden */

/**
 * Aplica el orden recibido: posición 1, 2, 3… Todos los ids deben existir (y, en los hijos,
 * pertenecer al destino indicado); si uno no encaja no se cambia nada.
 */
async function applyOrder(table: string, ids: number[], destinationId: number | null): Promise<void> {
  await withTransaction(async (connection) => {
    const placeholders = ids.map(() => '?').join(', ');
    const scope = destinationId === null ? '' : ' AND destination_id = ?';
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM ${table} WHERE id IN (${placeholders})${scope} FOR UPDATE`,
      destinationId === null ? ids : [...ids, destinationId],
    );
    if (rows.length !== ids.length) {
      throw ApiError.notFound(destinationId === null ? 'Algún destino no existe' : 'Algún elemento no existe o no pertenece a este destino');
    }
    for (const [index, id] of ids.entries()) {
      await connection.query(`UPDATE ${table} SET display_order = ? WHERE id = ?`, [index + 1, id]);
    }
  });
}

export async function reorderDestinations(req: Request, ids: number[]): Promise<void> {
  await applyOrder('destinations', ids, null);
  await recordAudit(req, { action: 'REORDER', entityType: 'destinations', description: 'Reordenó los destinos', newValues: { ids } });
}

export async function reorderChildren(
  req: Request,
  table: 'destination_attractions' | 'destination_festivities',
  destinationId: number,
  ids: number[],
): Promise<void> {
  await applyOrder(table, ids, destinationId);
  await recordAudit(req, {
    action: 'REORDER',
    entityType: table,
    entityId: destinationId,
    description: table === 'destination_attractions' ? 'Reordenó los atractivos del destino' : 'Reordenó las festividades del destino',
    newValues: { destination_id: destinationId, ids },
  });
}

/* ------------------------------------------------------------------ público */

/** Tarjetas de «Descubre más destinos»: solo ACTIVE y solo lo que la tarjeta necesita. */
export async function listPublicDestinations(): Promise<Row[]> {
  return query<Row>(
    `SELECT id, name, slug, subtitle, price_from, hero_image, display_order
     FROM destinations WHERE status = 'ACTIVE'
     ORDER BY display_order ASC, name ASC, id ASC`,
  );
}

/** Ficha pública por slug. Un slug mal formado o un destino INACTIVE es un 404, sin distinción. */
export async function findPublicDestination(slug: string): Promise<Row> {
  if (!SLUG_PATTERN.test(slug) || slug.length > 120) throw ApiError.notFound('Destino no encontrado');
  const destination = await queryOne<Row>(
    `SELECT d.id, d.name, d.slug, d.subtitle, d.description, d.price_from, d.hero_image, d.festivities_image,
            d.address, d.ticket_schedule, d.package_schedule, d.travel_duration, d.temperature, d.altitude_masl,
            d.time_from_lima, l.city AS city, ol.city AS origin_city
     FROM destinations d
     LEFT JOIN locations l ON l.id = d.location_id AND l.status = 'ACTIVE'
     LEFT JOIN locations ol ON ol.id = d.origin_location_id AND ol.status = 'ACTIVE'
     WHERE d.slug = ? AND d.status = 'ACTIVE' LIMIT 1`,
    [slug],
  );
  if (!destination) throw ApiError.notFound('Destino no encontrado');

  const [attractions, festivities] = await Promise.all([
    query<Row>(
      `SELECT id, name, description, image FROM destination_attractions
       WHERE destination_id = ? AND status = 'ACTIVE' ORDER BY display_order ASC, id ASC`,
      [destination.id],
    ),
    query<Row>(
      `SELECT id, name, date_label, description FROM destination_festivities
       WHERE destination_id = ? AND status = 'ACTIVE' ORDER BY display_order ASC, id ASC`,
      [destination.id],
    ),
  ]);
  return { ...destination, attractions, festivities };
}

/* ------------------------------------------------------------------ identidad visual */

export type BrandingReferences = Record<BrandingAsset, string | null>;

const settingKey = (asset: BrandingAsset) => `branding.${asset}`;

/**
 * Referencias actuales. Un valor que no tenga forma de referencia pública (por ejemplo, editado a
 * mano desde la configuración genérica) se trata como vacío: nunca se publica una ruta arbitraria.
 */
export async function readBranding(): Promise<BrandingReferences> {
  const assets = Object.keys(BRANDING_ASSETS) as BrandingAsset[];
  const rows = await query<{ setting_key: string; setting_value: string | null }>(
    `SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (${assets.map(() => '?').join(', ')})`,
    assets.map(settingKey),
  );
  const values = new Map(rows.map((row) => [row.setting_key, row.setting_value]));
  return Object.fromEntries(
    assets.map((asset) => {
      const value = values.get(settingKey(asset));
      return [asset, isPublicReference(value) ? value : null];
    }),
  ) as BrandingReferences;
}

async function writeBrandingReference(asset: BrandingAsset, reference: string | null): Promise<string | null> {
  return withTransaction(async (connection) => {
    // La fila la crea la migración 015, pero se garantiza aquí: una base restaurada sin ella
    // no debe impedir configurar la identidad visual.
    await connection.query(
      `INSERT INTO system_settings (setting_key, setting_value, setting_type, description, is_public)
       VALUES (?, NULL, 'STRING', 'Identidad visual. Se administra desde el panel.', 1)
       ON DUPLICATE KEY UPDATE setting_key = setting_key`,
      [settingKey(asset)],
    );
    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT setting_value FROM system_settings WHERE setting_key = ? FOR UPDATE',
      [settingKey(asset)],
    );
    await connection.query('UPDATE system_settings SET setting_value = ?, is_public = 1 WHERE setting_key = ?', [reference, settingKey(asset)]);
    const previous = rows[0]?.setting_value;
    return typeof previous === 'string' ? previous : null;
  });
}

export async function setBrandingAsset(req: Request, asset: BrandingAsset, file: UploadedFile | undefined): Promise<BrandingReferences> {
  if (!file) throw ApiError.badRequest('Adjunta la imagen');
  const stored = storePublicImage(file, { kind: 'branding', asset });
  let previous: string | null;
  try {
    previous = await writeBrandingReference(asset, stored.reference);
  } catch (error) {
    deletePublicFile(stored.reference);
    throw error;
  }
  if (previous !== stored.reference) deletePublicFile(previous);

  await recordAudit(req, {
    action: 'UPDATE',
    entityType: 'branding',
    description: `Actualizó la identidad visual (${asset})`,
    oldValues: { [asset]: previous },
    newValues: { [asset]: stored.reference },
  });
  return readBranding();
}

export async function removeBrandingAsset(req: Request, asset: BrandingAsset): Promise<BrandingReferences> {
  const previous = await writeBrandingReference(asset, null);
  deletePublicFile(previous);
  if (previous) {
    await recordAudit(req, {
      action: 'UPDATE',
      entityType: 'branding',
      description: `Quitó de la identidad visual (${asset})`,
      oldValues: { [asset]: previous },
      newValues: { [asset]: null },
    });
  }
  return readBranding();
}

/** Evita que un error de clave única llegue como mensaje genérico: el slug es lo único único. */
export async function assertSlugAvailable(slug: unknown, exceptId: number | null): Promise<void> {
  if (typeof slug !== 'string') return;
  const row = await queryOne<{ id: number }>('SELECT id FROM destinations WHERE slug = ? LIMIT 1', [slug]);
  if (row && Number(row.id) !== exceptId) throw ApiError.conflict(`Ya existe un destino con el slug «${slug}»`);
}
