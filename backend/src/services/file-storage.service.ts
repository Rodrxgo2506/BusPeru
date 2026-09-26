import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';
import { logError } from '../utils/logger';

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
 *
 * FASE 17 añade las imágenes PÚBLICAS (destinos e identidad visual) al final del archivo. Pasan
 * por la MISMA validación (`storeWithProfile`); no hay un segundo sistema de subidas.
 */

/**
 * Una firma de bytes mágicos: `bytes` deben aparecer a partir de `offset`. Casi todos los formatos
 * se reconocen por su comienzo, pero WebP necesita dos (`RIFF` al principio y `WEBP` en el byte 8).
 */
interface MagicSignature {
  offset: number;
  bytes: readonly number[];
}

interface FileType {
  extension: string;
  mime: string;
  magic: readonly MagicSignature[];
}

const at0 = (...bytes: number[]): MagicSignature[] => [{ offset: 0, bytes }];

const PDF: FileType = { extension: '.pdf', mime: 'application/pdf', magic: at0(0x25, 0x50, 0x44, 0x46) };
const JPG: FileType = { extension: '.jpg', mime: 'image/jpeg', magic: at0(0xff, 0xd8, 0xff) };
const JPEG: FileType = { extension: '.jpeg', mime: 'image/jpeg', magic: at0(0xff, 0xd8, 0xff) };
const PNG: FileType = { extension: '.png', mime: 'image/png', magic: at0(0x89, 0x50, 0x4e, 0x47) };
const WEBP: FileType = {
  extension: '.webp',
  mime: 'image/webp',
  magic: [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  ],
};
const ICO: FileType = { extension: '.ico', mime: 'image/x-icon', magic: at0(0x00, 0x00, 0x01, 0x00) };

/** Formatos admitidos, los del mockup: un documento legal escaneado o fotografiado. */
export const ALLOWED_TYPES = [PDF, JPG, JPEG, PNG] as const;

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

export function storageRoot(): string {
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

function matchesMagic(buffer: Buffer, type: FileType): boolean {
  return type.magic.every(({ offset, bytes }) => {
    const signature = Buffer.from(bytes);
    return buffer.length >= offset + signature.length && buffer.subarray(offset, offset + signature.length).equals(signature);
  });
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`;
}

interface StoreProfile {
  types: readonly FileType[];
  maxBytes: number;
  /** Carpeta relativa al almacén, siempre construida por el servidor (nunca con entrada del usuario). */
  folder: string;
  formatsLabel: string;
}

/**
 * Valida el archivo contra un perfil y lo guarda. Es la única implementación: los documentos
 * privados y las imágenes públicas pasan por las mismas tres comprobaciones y el mismo nombre
 * aleatorio; solo cambian los formatos admitidos, el tamaño y la carpeta.
 */
function storeWithProfile(file: UploadedFile, profile: StoreProfile): StoredFile {
  if (!file || file.size === 0) throw ApiError.badRequest('El archivo está vacío');
  if (file.size > profile.maxBytes) {
    throw ApiError.badRequest(`El archivo supera el máximo de ${formatBytes(profile.maxBytes)}`);
  }

  const original = file.originalname ?? '';
  // Se toma SOLO la última extensión: `factura.pdf.exe` se lee como `.exe` y se rechaza.
  const extension = path.extname(path.basename(original.replace(/\\/g, '/'))).toLowerCase();

  const allowed = profile.types.find((entry) => entry.extension === extension);
  if (!allowed) {
    throw ApiError.badRequest(`Formato no admitido. Sube ${profile.formatsLabel}`);
  }
  if (file.mimetype !== allowed.mime) {
    throw ApiError.badRequest('El tipo del archivo no coincide con su extensión');
  }

  // Bytes mágicos: la comprobación que un atacante no puede falsear renombrando.
  if (!matchesMagic(file.buffer, allowed)) {
    throw ApiError.badRequest('El contenido del archivo no corresponde a su extensión');
  }

  const filename = `${crypto.randomBytes(16).toString('hex')}${allowed.extension}`;
  const reference = path.posix.join(profile.folder, filename);

  const target = absolutePath(reference);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Sin permisos de ejecución: un archivo subido nunca debe poder ejecutarse.
  fs.writeFileSync(target, file.buffer, { mode: 0o600 });

  return { reference, displayName: safeDisplayName(original), size: file.size, mime: allowed.mime };
}

/**
 * Valida el archivo y lo guarda. Lanza si algo no encaja: nunca escribe un archivo
 * que no haya pasado las tres comprobaciones.
 */
export function storeFile(file: UploadedFile, companyId: number): StoredFile {
  return storeWithProfile(file, {
    types: ALLOWED_TYPES,
    maxBytes: MAX_FILE_BYTES,
    folder: path.posix.join('documents', String(companyId)),
    formatsLabel: 'un PDF, JPG o PNG',
  });
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
    logError('No se pudo eliminar el archivo del almacén', error);
  }
}

/* ===========================================================================
 * Imágenes PÚBLICAS: contenido de destinos, identidad visual (FASE 17) y logotipos de empresa.
 *
 * Mismo almacén y mismas comprobaciones que los documentos, pero en su propia rama `public/`.
 * Nada de `documents/` puede servirse por el canal público: `readPublicFile` solo acepta
 * referencias con la forma EXACTA que genera este módulo. Sin SVG a propósito: puede llevar script.
 *
 * Migrar a R2/S3 más adelante solo cambia estas funciones: la base guarda referencias, no rutas
 * del disco ni URLs.
 * =========================================================================== */

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_FAVICON_BYTES = 512 * 1024;
/** Un logotipo es una marca, no una fotografía: 2 MB sobran y evitan subidas descuidadas. */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const IMAGE_TYPES: readonly FileType[] = [JPG, JPEG, PNG, WEBP];
const FAVICON_TYPES: readonly FileType[] = [PNG, ICO];
const PUBLIC_TYPES: readonly FileType[] = [JPG, JPEG, PNG, WEBP, ICO];

/** Piezas de identidad visual: clave de la API → carpeta en disco. */
export const BRANDING_ASSETS = {
  logo: 'logo',
  favicon: 'favicon',
  logo_mobile: 'logo-mobile',
  og_image: 'og',
} as const;
export type BrandingAsset = keyof typeof BRANDING_ASSETS;

export function isBrandingAsset(value: unknown): value is BrandingAsset {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BRANDING_ASSETS, value);
}

export type PublicImageTarget =
  | { kind: 'destination'; destinationId: number }
  | { kind: 'company'; companyId: number }
  /** F18-19 · perfil público y galería: misma carpeta que el logotipo, fotografías de hasta 5 MB. */
  | { kind: 'company-media'; companyId: number }
  | { kind: 'branding'; asset: BrandingAsset };

/**
 * Forma EXACTA de una referencia pública. Todo lo demás —`documents/...`, `..`, barras invertidas,
 * rutas absolutas, otras extensiones— no es una referencia pública y no se sirve ni se borra.
 */
const PUBLIC_REFERENCE =
  /^public\/(?:destinations\/[1-9]\d{0,9}|companies\/[1-9]\d{0,9}|branding\/(?:logo|favicon|logo-mobile|og))\/[0-9a-f]{32}\.(?:jpg|jpeg|png|webp|ico)$/;

export function isPublicReference(reference: unknown): reference is string {
  return typeof reference === 'string' && PUBLIC_REFERENCE.test(reference);
}

export function storePublicImage(file: UploadedFile, target: PublicImageTarget): StoredFile {
  if (target.kind === 'destination') {
    if (!Number.isInteger(target.destinationId) || target.destinationId <= 0) throw ApiError.badRequest('Destino inválido');
    return storeWithProfile(file, {
      types: IMAGE_TYPES,
      maxBytes: MAX_IMAGE_BYTES,
      folder: path.posix.join('public', 'destinations', String(target.destinationId)),
      formatsLabel: 'una imagen JPG, PNG o WebP',
    });
  }
  if (target.kind === 'company' || target.kind === 'company-media') {
    if (!Number.isInteger(target.companyId) || target.companyId <= 0) throw ApiError.badRequest('Empresa inválida');
    return storeWithProfile(file, {
      types: IMAGE_TYPES,
      maxBytes: target.kind === 'company' ? MAX_LOGO_BYTES : MAX_IMAGE_BYTES,
      folder: path.posix.join('public', 'companies', String(target.companyId)),
      formatsLabel: 'una imagen JPG, PNG o WebP',
    });
  }
  const favicon = target.asset === 'favicon';
  return storeWithProfile(file, {
    types: favicon ? FAVICON_TYPES : IMAGE_TYPES,
    maxBytes: favicon ? MAX_FAVICON_BYTES : MAX_IMAGE_BYTES,
    folder: path.posix.join('public', 'branding', BRANDING_ASSETS[target.asset]),
    formatsLabel: favicon ? 'un PNG o ICO' : 'una imagen JPG, PNG o WebP',
  });
}

/** Lee una imagen pública. Una referencia con otra forma responde 404, igual que una inexistente. */
export function readPublicFile(reference: string): ReadFile {
  if (!isPublicReference(reference)) throw ApiError.notFound('Archivo no encontrado');
  const target = absolutePath(reference);
  if (!fs.existsSync(target)) throw ApiError.notFound('Archivo no encontrado');

  const extension = path.extname(target).toLowerCase();
  const type = PUBLIC_TYPES.find((entry) => entry.extension === extension);
  if (!type) throw ApiError.notFound('Archivo no encontrado');
  return { buffer: fs.readFileSync(target), mime: type.mime, extension };
}

/** Borra una imagen pública. Ignora referencias vacías o que no sean públicas. */
export function deletePublicFile(reference: unknown): void {
  if (!isPublicReference(reference)) return;
  deleteFile(reference);
}
