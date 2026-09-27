import { createHash } from 'crypto';
import { CloudFrontClient, CreateInvalidationCommand, type CreateInvalidationCommandInput } from '@aws-sdk/client-cloudfront';
import { env } from '../config/env';
import { logError, logEvent } from '../utils/logger';
import { deletePublicFile, isPublicReference } from './file-storage.service';

/**
 * Invalidación en CloudFront de las imágenes públicas retiradas.
 *
 * POR QUÉ. La distribución de la API guarda `/api/public/media/*` en el borde (caché larga: el nombre de
 * cada archivo es aleatorio y el origen responde `immutable`). Una imagen que se BORRA o se REEMPLAZA deja
 * de existir en el origen, pero su copia seguiría sirviéndose desde el borde hasta que caducara. Por eso,
 * al retirarla, además de borrar el archivo se pide a CloudFront que invalide SU ruta, y solo la suya.
 *
 * ORDEN. Primero la base (quien llama ya confirmó la transacción), luego el archivo y por último la
 * invalidación: si se invalidase antes de borrar, una petición intermedia volvería a llenar el borde con
 * la copia vieja. Un fallo de CloudFront NO deshace nada ni rompe la petición: la imagen ya no está en el
 * origen ni referenciada; se registra el fallo para poder repetirlo a mano.
 *
 * QUÉ NO SE INVALIDA. Nada que no sea una referencia pública con la forma exacta de `isPublicReference`
 * (la misma que usa el origen para servirla): ni comodines, ni `/*`, ni documentos privados, ni rutas
 * que lleguen de fuera. Los archivos recién subidos que se descartan porque su transacción falló tampoco:
 * nunca se publicaron y su nombre aleatorio no lo conoce nadie (se siguen borrando con `deletePublicFile`).
 * El reemplazo solo invalida la referencia ANTERIOR: la nueva es un nombre nuevo que el borde nunca vio.
 */

/** Prefijo con el que la distribución de la API sirve las imágenes públicas (el `PathPattern` de la plantilla). */
export const MEDIA_CDN_PATH_PREFIX = '/api/public/media/';

/** Forma de un id de distribución de CloudFront. Cualquier otra cosa se trata como «sin configurar». */
const DISTRIBUTION_ID = /^E[A-Z0-9]{8,20}$/;

export type MediaInvalidationStatus = 'REQUESTED' | 'NOT_CONFIGURED' | 'NOTHING_TO_INVALIDATE' | 'FAILED';

export interface MediaInvalidationResult {
  status: MediaInvalidationStatus;
  paths: string[];
  invalidationId?: string;
}

/** Rutas a invalidar: solo referencias públicas válidas, sin repetir y en orden estable. */
export function mediaInvalidationPaths(references: readonly unknown[]): string[] {
  const paths = references.filter(isPublicReference).map((reference) => `${MEDIA_CDN_PATH_PREFIX}${reference}`);
  return [...new Set(paths)].sort();
}

/**
 * Identificador de la petición. Determinista para el mismo conjunto de rutas: si se repite (reintento),
 * CloudFront devuelve la invalidación ya creada en lugar de crear otra. Como los nombres de archivo no se
 * reutilizan nunca, el mismo conjunto de rutas solo vuelve a aparecer en un reintento.
 */
export function mediaInvalidationReference(paths: readonly string[]): string {
  return `media-${createHash('sha256').update(paths.join('\n')).digest('hex').slice(0, 40)}`;
}

let client: CloudFrontClient | null = null;

/**
 * Transporte hacia CloudFront, separado para poder sustituirlo en las pruebas. Las credenciales son las
 * del rol de la instancia (cadena por defecto del SDK): nunca van en el código ni en la configuración.
 * La API de CloudFront es global y se atiende en us-east-1.
 */
export const mediaCdn = {
  send: async (input: CreateInvalidationCommandInput): Promise<string | undefined> => {
    client ??= new CloudFrontClient({ region: 'us-east-1', maxAttempts: 3 });
    const output = await client.send(new CreateInvalidationCommand(input));
    return output.Invalidation?.Id;
  },
};

/** Pide la invalidación de las imágenes públicas indicadas. Nunca lanza: devuelve y registra el resultado. */
export async function invalidatePublicMedia(references: readonly unknown[]): Promise<MediaInvalidationResult> {
  const paths = mediaInvalidationPaths(references);
  if (paths.length === 0) return { status: 'NOTHING_TO_INVALIDATE', paths };

  const distributionId = env.cdn.mediaDistributionId.trim();
  if (!DISTRIBUTION_ID.test(distributionId)) {
    if (distributionId) {
      logEvent('CDN_MEDIA_DISTRIBUTION_ID no tiene forma de id de CloudFront: no se invalida', {
        provider: 'CLOUDFRONT', event: 'media.invalidation', outcome: 'INVALID_CONFIG',
      });
    }
    return { status: 'NOT_CONFIGURED', paths };
  }

  const detail = paths.join(' ').slice(0, 900);
  try {
    const invalidationId = await mediaCdn.send({
      DistributionId: distributionId,
      InvalidationBatch: { CallerReference: mediaInvalidationReference(paths), Paths: { Quantity: paths.length, Items: paths } },
    });
    logEvent('Invalidación de CloudFront solicitada para imágenes públicas retiradas', {
      provider: 'CLOUDFRONT', event: 'media.invalidation', outcome: 'REQUESTED', detail: `${invalidationId ?? 'sin id'} · ${detail}`,
    });
    return { status: 'REQUESTED', paths, ...(invalidationId ? { invalidationId } : {}) };
  } catch (error) {
    logError('No se pudo invalidar en CloudFront una imagen pública retirada', error, {
      provider: 'CLOUDFRONT', event: 'media.invalidation', outcome: 'FAILED', detail,
    });
    return { status: 'FAILED', paths };
  }
}

/**
 * Retira imágenes públicas que YA estaban publicadas (borrado o reemplazo confirmados en la base): borra
 * cada archivo del almacén y después invalida sus rutas en CloudFront en una sola petición.
 */
export async function retirePublicFiles(references: readonly unknown[]): Promise<MediaInvalidationResult> {
  for (const reference of references) deletePublicFile(reference);
  return invalidatePublicMedia(references);
}
