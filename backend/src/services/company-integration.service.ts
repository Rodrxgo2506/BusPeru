import type { Request } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import * as repository from '../repositories/company-integration.repository';
import { ApiError } from '../utils/ApiError';
import { decryptJson, encryptJson, hasUnreadableCredentials, isEncryptionConfigured } from './encryption.service';
import {
  PROVIDERS,
  findProvider,
  maskCredential,
  missingFields,
  type IntegrationStatus,
  type ProviderDefinition,
} from './integration-catalog';

/**
 * Integraciones por empresa (PENDIENTES.md §5, mockup 37).
 *
 * ALCANCE: esta funcionalidad **solo guarda configuración**. Conectar una integración cifra
 * y almacena sus credenciales; no activa ningún cobro, ni webhook, ni llamada a un proveedor
 * externo. `status` significa «configurado», no «operativo».
 *
 * Reglas, todas resueltas aquí y nunca a partir del cuerpo de la petición:
 *
 *   · La empresa sale de `company_users` del usuario autenticado. `company_id` no es un
 *     campo escribible: enviarlo no cambia nada.
 *   · `company_id = NULL` es la integración **a nivel de plataforma** (modelo agregador) y
 *     solo el ADMIN puede verla o tocarla. Nunca aparece en el listado de una empresa.
 *   · Las credenciales son de **solo escritura**: la API jamás las devuelve descifradas.
 *     Solo se publica qué campos están configurados y sus 4 últimos caracteres.
 */

/** Ámbito sobre el que se opera: una empresa, o la plataforma. */
export type Scope = { kind: 'COMPANY'; companyId: number } | { kind: 'PLATFORM' };

/** Resuelve la empresa del usuario autenticado. Nunca lee `company_id` del cuerpo. */
export function resolveCompanyScope(req: Request): Scope {
  const [companyId] = requireAuth(req).companyIds;
  if (companyId === undefined) throw ApiError.forbidden('Tu usuario no está asociado a ninguna empresa');
  return { kind: 'COMPANY', companyId };
}

/**
 * Ámbito de plataforma. Exclusivo del ADMIN: un COMPANY_ADMIN también tiene
 * `companies.update`, de modo que el permiso no basta y se exige además el rol.
 */
export function resolvePlatformScope(req: Request): Scope {
  if (requireAuth(req).role !== 'ADMIN') {
    throw ApiError.forbidden('Solo un administrador de la plataforma puede gestionar sus integraciones');
  }
  return { kind: 'PLATFORM' };
}

const scopeId = (scope: Scope): number | null => (scope.kind === 'PLATFORM' ? null : scope.companyId);

export interface IntegrationView {
  provider: string;
  label: string;
  category: string;
  description: string;
  status: IntegrationStatus;
  connected_at: string | null;
  /** Campos que el proveedor espera, para que el formulario los pinte sin inventárselos. */
  fields: Array<{ name: string; label: string; secret: boolean; required: boolean }>;
  configured_fields: string[];
  missing_fields: string[];
  /** Solo los 4 últimos caracteres de cada credencial. Nunca el valor completo. */
  credentials_preview: Record<string, string | null>;
  /** Recordatorio explícito: configurar no es operar. */
  processing_active: false;
}

/**
 * Construye la vista pública de un proveedor. Descifra en memoria únicamente para calcular
 * qué campos están puestos y su vista parcial; el valor completo se descarta aquí y **no
 * sale de esta función**.
 */
function toView(definition: ProviderDefinition, row: repository.CompanyIntegrationRow | null): IntegrationView {
  const credentials = row ? decryptJson(row.credentials) : null;
  const configured = definition.fields
    .filter((entry) => typeof credentials?.[entry.name] === 'string' && String(credentials[entry.name]).trim() !== '')
    .map((entry) => entry.name);

  const preview: Record<string, string | null> = {};
  for (const entry of definition.fields) preview[entry.name] = maskCredential(credentials?.[entry.name]);

  return {
    provider: definition.provider,
    label: definition.label,
    category: definition.category,
    description: definition.description,
    status: row?.status ?? 'DISCONNECTED',
    connected_at: row?.connected_at ?? null,
    fields: definition.fields,
    configured_fields: configured,
    missing_fields: missingFields(definition, credentials),
    credentials_preview: preview,
    processing_active: false,
  };
}

/** Catálogo completo con el estado de cada proveedor dentro del ámbito indicado. */
export async function list(scope: Scope): Promise<{ encryption_configured: boolean; integrations: IntegrationView[] }> {
  const rows = await repository.findAllForScope(scopeId(scope));
  const byProvider = new Map(rows.map((row) => [row.provider, row]));

  return {
    // El frontend avisa si el servidor no puede cifrar, en vez de dejar guardar y fallar.
    encryption_configured: isEncryptionConfigured(),
    integrations: PROVIDERS.map((definition) => toView(definition, byProvider.get(definition.provider) ?? null)),
  };
}

export async function detail(scope: Scope, provider: string): Promise<IntegrationView> {
  const definition = assertProvider(provider);
  return toView(definition, await repository.findForScope(scopeId(scope), provider));
}

function assertProvider(provider: string): ProviderDefinition {
  const definition = findProvider(provider);
  // 404 y no 400: un proveedor que no está en el catálogo sencillamente no existe.
  if (!definition) throw ApiError.notFound('Integración no encontrada');
  return definition;
}

/**
 * Guarda la configuración.
 *
 * Solo se aceptan los campos que el proveedor declara: cualquier otra clave del cuerpo se
 * descarta aquí, de modo que no puede colarse `company_id`, `status` ni `connected_at`.
 * Un campo que llega vacío conserva el valor anterior, para poder cambiar solo una llave
 * sin tener que reescribir las demás.
 */
export async function save(
  scope: Scope,
  provider: string,
  input: Record<string, unknown>,
): Promise<{ view: IntegrationView; created: boolean }> {
  const definition = assertProvider(provider);
  const existing = await repository.findForScope(scopeId(scope), provider);

  /**
   * NO SE ESCRIBE ENCIMA DE UN SOBRE QUE NO SE PUEDE LEER (F17C-SEC-08, SEC08-01).
   *
   * Un campo en blanco significa «déjalo como está», y para respetarlo hay que releer lo
   * guardado. Si el sobre existe pero ninguna clave lo abre —clave cambiada sin re-cifrar, clave
   * mal configurada, fila alterada— esa relectura no distingue «no había nada» de «no lo puedo
   * leer», y guardar un solo campo borraba definitivamente los demás. Además el panel mostraba la
   * integración como «sin configurar», así que volver a teclear un campo era la reacción natural.
   *
   * Se corta antes de tocar la base. Si de verdad se quiere empezar de cero, el camino explícito
   * ya existe: desconectar la integración borra las credenciales y luego se configura de nuevo.
   */
  if (existing && hasUnreadableCredentials(existing.credentials)) {
    throw ApiError.conflict(
      'Las credenciales guardadas no se pueden descifrar con la clave actual de este servidor. '
      + 'No se sobrescriben para no perderlas: revisa la clave de cifrado, o desconecta la integración para configurarla desde cero.',
    );
  }

  const previous = existing ? decryptJson(existing.credentials) : null;

  const credentials: Record<string, unknown> = {};
  for (const entry of definition.fields) {
    const incoming = input[entry.name];
    const value = typeof incoming === 'string' ? incoming.trim() : '';
    // Vacío = «no lo cambies», no «bórralo».
    if (value !== '') credentials[entry.name] = value;
    else if (typeof previous?.[entry.name] === 'string') credentials[entry.name] = previous[entry.name];
  }

  const pending = missingFields(definition, credentials);
  // Guardar no conecta: mientras falten campos, la integración queda NEEDS_CONFIG. Si ya
  // estaba conectada y sigue completa, conserva su estado.
  const status: IntegrationStatus = pending.length > 0
    ? 'NEEDS_CONFIG'
    : existing?.status === 'CONNECTED'
      ? 'CONNECTED'
      : 'DISCONNECTED';

  await repository.upsert({
    companyId: scopeId(scope),
    provider,
    category: definition.category,
    credentials: Object.keys(credentials).length > 0 ? encryptJson(credentials) : null,
    status,
  });

  return { view: await detail(scope, provider), created: existing === null };
}

/** Marca la integración como conectada. Exige que no falte ningún campo obligatorio. */
export async function connect(scope: Scope, provider: string): Promise<IntegrationView> {
  const definition = assertProvider(provider);
  const existing = await repository.findForScope(scopeId(scope), provider);
  if (!existing) throw ApiError.badRequest('Configura la integración antes de conectarla');

  const pending = missingFields(definition, decryptJson(existing.credentials));
  if (pending.length > 0) {
    throw ApiError.badRequest(`Faltan datos obligatorios: ${pending.join(', ')}`);
  }

  await repository.updateStatus(scopeId(scope), provider, 'CONNECTED', false);
  return detail(scope, provider);
}

/**
 * Desconecta y **borra las credenciales**. Es deliberado: una integración desconectada no
 * debe conservar llaves vivas en la base «por si acaso».
 */
export async function disconnect(scope: Scope, provider: string): Promise<IntegrationView> {
  assertProvider(provider);

  const affected = await repository.updateStatus(scopeId(scope), provider, 'DISCONNECTED', true);
  if (affected === 0) throw ApiError.notFound('Integración no encontrada');

  return detail(scope, provider);
}

export async function remove(scope: Scope, provider: string): Promise<void> {
  assertProvider(provider);

  const affected = await repository.remove(scopeId(scope), provider);
  if (affected === 0) throw ApiError.notFound('Integración no encontrada');
}
