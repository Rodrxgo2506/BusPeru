import crypto from 'crypto';
import { env } from '../config/env';
import * as repository from '../repositories/api-key.repository';
import { ApiError } from '../utils/ApiError';
import { businessTimeMs } from '../utils/businessTime';
import { logError } from '../utils/logger';

/**
 * Autenticación por API Key (auditoría BP-11).
 *
 * El módulo de llaves generaba credenciales, guardaba su hash y las mostraba una sola vez
 * —todo correcto—, pero **nadie las leía nunca**: `key_hash` solo se escribía, el middleware
 * únicamente aceptaba `Authorization: Bearer <JWT>` y `last_used_at` era siempre `NULL`. Una
 * llave emitida no abría absolutamente nada. Esto es la pieza que faltaba.
 *
 * DECISIONES, todas resueltas aquí y ninguna a partir de la petición:
 *
 *   · **Transporte.** Cabecera propia `X-API-Key`. No se mezcla con el `Bearer` del JWT:
 *     son dos credenciales distintas y confundirlas obligaría a adivinar el formato.
 *   · **Identidad.** Una llave es una EMPRESA, nunca una persona. `api_keys.user_id` queda
 *     como rastro de quién la creó y no amplía el alcance ni un permiso.
 *   · **Alcance.** La empresa sale de `api_keys.company_id`. Un `company_id` en el cuerpo,
 *     en la query o en una cabecera no cambia nada, porque no se lee.
 *   · **Permisos.** `permissions` es un subconjunto RESTRICTIVO, nunca una concesión: los
 *     efectivos son la intersección con el techo de la empresa. Una llave no puede darse a
 *     sí misma un permiso que su empresa no tiene, por mucho que lo escriba en su JSON.
 *   · **Entorno.** El entorno de la llave debe coincidir con el del proceso. Ver
 *     `assertEnvironmentMatches`.
 */

/** Cabecera por la que viaja la credencial. */
export const API_KEY_HEADER = 'x-api-key';

/** Identidad que una API Key deja en la petición. No es un usuario y no lo suplanta. */
export interface ApiKeyIdentity {
  id: number;
  name: string;
  companyId: number;
  environment: 'TEST' | 'PRODUCTION';
  /** Permisos EFECTIVOS: intersección del techo de la empresa con lo declarado. */
  permissions: string[];
}

/**
 * Todos los rechazos comparten mensaje.
 *
 * Distinguir «no existe» de «está revocada» o «ha caducado» convertiría el endpoint en un
 * oráculo con el que averiguar qué llaves existen. Quien presenta una credencial que no
 * sirve solo necesita saber que no sirve.
 */
function rejected(): ApiError {
  return ApiError.unauthorized('La clave de API no es válida');
}

/** Formato que produce `generateApiKey`: `bp_<8 hex>.<48 hex>`. */
const KEY_FORMAT = /^bp_[0-9a-f]{8}\.[0-9a-f]{48}$/;

/**
 * Hash de la clave presentada, con el mismo algoritmo con el que se guardó.
 * La clave en claro no se registra en ningún sitio ni se devuelve nunca.
 */
function hashKey(plain: string): string {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

/** Comparación en tiempo constante sobre los hashes, nunca sobre la clave. */
function matches(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * El entorno de la llave debe coincidir con el del proceso.
 *
 * LIMITACIÓN, y es deliberado dejarla escrita: esta instalación tiene **una sola base de
 * datos**, así que no existe una separación real entre pruebas y producción. No se simula:
 * lo único que se comprueba es el entorno del proceso, que sí es real. La consecuencia que
 * importa está garantizada —una llave TEST no autentica contra un servidor de producción—,
 * pero una llave TEST y una de producción siguen viendo los mismos datos si el servidor es
 * el mismo. Una separación de verdad exige dos entornos, y eso es despliegue, no código.
 */
function assertEnvironmentMatches(keyEnvironment: 'TEST' | 'PRODUCTION'): void {
  const expected = env.isProduction ? 'PRODUCTION' : 'TEST';
  if (keyEnvironment !== expected) throw rejected();
}

/**
 * Permisos efectivos: el techo de la empresa recortado por lo que declare la llave.
 *
 * `permissions` a `null` significa «sin restricción declarada», y entonces la llave hereda
 * el techo completo de la empresa. Es la lectura coherente con que la columna sea un
 * subconjunto restrictivo: si significara «ninguno», sería una lista de concesiones y las
 * llaves creadas sin especificar nada —las dos que hay hoy— no servirían para nada. Si
 * prefieres el criterio contrario (sin declaración, sin permisos), es un cambio de una
 * línea aquí; queda documentado a propósito para que sea una decisión y no un descuido.
 */
function effectivePermissions(baseline: string[], declared: string | null): string[] {
  if (declared === null) return baseline;

  let parsed: unknown;
  try {
    parsed = JSON.parse(declared);
  } catch {
    // Un JSON ilegible no se interpreta como «todo»: la llave se queda sin permisos.
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const requested = new Set(parsed.filter((value): value is string => typeof value === 'string'));
  // La intersección es la garantía: lo que la empresa no tiene, la llave tampoco.
  return baseline.filter((permission) => requested.has(permission));
}

/**
 * Autentica una clave en claro y devuelve la identidad de la empresa.
 *
 * Lanza `401` ante cualquier problema con la credencial y `403` cuando la credencial es
 * buena pero su empresa no está operativa, que es el mismo criterio que se aplica a una
 * cuenta de usuario suspendida.
 */
export async function authenticateApiKey(plainKey: string): Promise<ApiKeyIdentity> {
  const candidate = plainKey.trim();
  if (!KEY_FORMAT.test(candidate)) throw rejected();

  // El prefijo (no secreto, indexado) acota la búsqueda; el hash completo se compara aquí
  // en tiempo constante. Puede haber más de una candidata: el prefijo no es único.
  const presented = hashKey(candidate);
  const candidates = await repository.findByPrefix(candidate.split('.')[0]!);
  const row = candidates.find((entry) => matches(entry.key_hash, presented));
  if (!row) throw rejected();

  if (row.status !== 'ACTIVE') throw rejected();
  if (row.expires_at !== null && businessTimeMs(row.expires_at) <= Date.now()) throw rejected();

  assertEnvironmentMatches(row.environment);

  // Una llave sin empresa no puede autenticar: la identidad de una API Key ES la empresa.
  if (row.company_id === null) throw rejected();
  if (row.company_status !== 'ACTIVE') {
    throw ApiError.forbidden('La empresa de esta clave de API no está activa');
  }

  const baseline = await repository.companyPermissionBaseline();
  const identity: ApiKeyIdentity = {
    id: row.id,
    name: row.name,
    companyId: row.company_id,
    environment: row.environment,
    permissions: effectivePermissions(baseline, row.permissions),
  };

  // Solo se marca el uso de una llave que ha autenticado. Un fallo aquí no puede tumbar la
  // petición: es un dato de operación, no parte de la decisión de acceso.
  try {
    await repository.touchLastUsed(row.id);
  } catch (error) {
    logError('No se pudo actualizar last_used_at de la clave de API', error);
  }

  return identity;
}

/** `true` si la identidad tiene alguno de los permisos indicados. */
export function apiKeyHasPermission(identity: ApiKeyIdentity, ...permissions: string[]): boolean {
  return permissions.some((permission) => identity.permissions.includes(permission));
}

/**
 * Comprueba que un recurso pertenece a la empresa de la llave.
 *
 * 404 y no 403, como en el resto de la API: un recurso de otra empresa no se confirma que
 * exista.
 */
export function assertApiKeyOwns(identity: ApiKeyIdentity, companyId: number | null | undefined): void {
  if (companyId === null || companyId === undefined || Number(companyId) !== identity.companyId) {
    throw ApiError.notFound('Recurso no encontrado');
  }
}
