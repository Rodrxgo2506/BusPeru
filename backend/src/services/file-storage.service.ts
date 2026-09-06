import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';

/**
 * Almacén de archivos subidos.
 *
 * Los documentos de verificación son información empresarial sensible, así que:
 *
 *   · Viven en un directorio PRIVADO (`STORAGE_DIR`), fuera de cualquier carpeta servida
 *     estáticamente y fuera del frontend. No hay URL pública que los alcance.
 *   · El nombre en disco lo genera el servidor con `crypto.randomBytes`; el nombre que
 *     envía el usuario no se usa jamás como ruta. Eso cierra el path traversal por
 *     construcción: no hay concatenación de entrada del usuario en la ruta.
 *   · Se comprueban tres cosas antes de aceptar: extensión, MIME declarado y los bytes
 *     mágicos reales del archivo. Renombrar un .exe a .pdf no basta.
 *   · Se sirven únicamente por un endpoint que valida sesión y empresa.
 */

/** Formatos admitidos, los del mockup: un documento legal escaneado o fotografiado. */
export const ALLOWED_TYPES = [
  { extension: '.pdf', mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  { extension: '.jpg', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { extension: '.jpeg', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { extension: '.png', mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
] as const;

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface StoredFile {
  /** Referencia interna que se guarda en `company_documents.file_url`. */
  reference: string;
  /** Nombre original, solo para mostrarlo. Nunca se usa como ruta. */
  displayName: string;
  size: number;
  mime: string;
}

function storageRoot(): string {
  return path.resolve(process.cwd(), env.storage.dir);
}

/** Los documentos se agrupan por empresa: `documents/<companyId>/<aleatorio>.<ext>`. */
function absolutePath(reference: string): string {
  const root = storageRoot();
  const resolved = path.resolve(root, reference);

  // Defensa en profundidad: aunque la referencia la genera el servidor, se comprueba que
  // el resultado siga dentro del almacén antes de tocar el disco.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw ApiError.badRequest('Referencia de archivo inválida');
  }
  return resolved;
}

/** Nombre visible saneado: sin rutas, sin caracteres de control, longitud acotada. */
function safeDisplayName(original: string): string {
  const base = path.basename(original.replace(/\\/g, '/'));
  const clean = base.replace(/[^\w.\- ()]/g, '_').slice(0, 120);
  return clean || 'documento';
}

/**
 * Valida el archivo y lo guarda. Lanza si algo no encaja: nunca escribe un archivo
 * que no haya pasado las tres comprobaciones.
 */
export function storeFile(file: UploadedFile, companyId: number): StoredFile {
  if (!file || file.size === 0) throw ApiError.badRequest('El archivo está vacío');
  if (file.size > MAX_FILE_BYTES) {
    throw ApiError.badRequest(`El archivo supera el máximo de ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB`);
  }

  const original = file.originalname ?? '';
  // Se toma SOLO la última extensión: `factura.pdf.exe` se lee como `.exe` y se rechaza.
  const extension = path.extname(path.basename(original.replace(/\\/g, '/'))).toLowerCase();

  const allowed = ALLOWED_TYPES.find((entry) => entry.extension === extension);
  if (!allowed) {
    throw ApiError.badRequest('Formato no admitido. Sube un PDF, JPG o PNG');
  }
  if (file.mimetype !== allowed.mime) {
    throw ApiError.badRequest('El tipo del archivo no coincide con su extensión');
  }

  // Bytes mágicos: la comprobación que un atacante no puede falsear renombrando.
  const magic = Buffer.from(allowed.magic);
  if (file.buffer.length < magic.length || !file.buffer.subarray(0, magic.length).equals(magic)) {
    throw ApiError.badRequest('El contenido del archivo no corresponde a su extensión');
  }

  const folder = path.join('documents', String(companyId));
  const filename = `${crypto.randomBytes(16).toString('hex')}${allowed.extension}`;
  const reference = path.posix.join('documents', String(companyId), filename);

  const target = absolutePath(reference);
  fs.mkdirSync(path.resolve(storageRoot(), folder), { recursive: true });
  // Sin permisos de ejecución: un archivo subido nunca debe poder ejecutarse.
  fs.writeFileSync(target, file.buffer, { mode: 0o600 });

  return { reference, displayName: safeDisplayName(original), size: file.size, mime: allowed.mime };
}

export interface ReadFile {
  buffer: Buffer;
  mime: string;
  /** Extensión real, para nombrar la descarga. El nombre interno nunca sale del servidor. */
  extension: string;
}

/** Lee un archivo del almacén a partir de su referencia interna. */
export function readFile(reference: string): ReadFile {
  const target = absolutePath(reference);
  if (!fs.existsSync(target)) throw ApiError.notFound('El archivo ya no está disponible');

  const extension = path.extname(target).toLowerCase();
  const allowed = ALLOWED_TYPES.find((entry) => entry.extension === extension);

  return {
    buffer: fs.readFileSync(target),
    mime: allowed?.mime ?? 'application/octet-stream',
    extension,
  };
}

/** Borra el archivo. Un fallo aquí no debe tumbar la operación de negocio. */
export function deleteFile(reference: string): void {
  try {
    const target = absolutePath(reference);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch (error) {
    console.error('No se pudo eliminar el archivo del almacén:', error);
  }
}
