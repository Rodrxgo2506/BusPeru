/**
 * Catálogo de integraciones del mockup 37 (PENDIENTES.md §5).
 *
 * §5 define la tabla y las categorías, pero **no enumera proveedores ni campos**. El
 * catálogo se deriva de lo que el mockup dibuja, y los nombres de campo son la decisión
 * mínima necesaria para poder validar la configuración y calcular `NEEDS_CONFIG`.
 *
 * IMPORTANTE — alcance actual: conectar una integración **solo guarda su configuración**.
 * No activa ningún cobro, ni webhook, ni llamada a ningún proveedor externo. `status`
 * significa «configurado», no «operativo».
 */

export const INTEGRATION_CATEGORIES = ['PAYMENT_GATEWAY', 'INVOICING', 'ANALYTICS', 'MESSAGING', 'OTHER'] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

export const INTEGRATION_STATUSES = ['CONNECTED', 'DISCONNECTED', 'NEEDS_CONFIG'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export interface CredentialField {
  name: string;
  label: string;
  /** Un campo secreto nunca se devuelve, ni siquiera parcialmente, salvo sus 4 últimos caracteres. */
  secret: boolean;
  required: boolean;
}

export interface ProviderDefinition {
  provider: string;
  label: string;
  category: IntegrationCategory;
  description: string;
  fields: CredentialField[];
}

const field = (name: string, label: string, secret: boolean, required = true): CredentialField => ({
  name,
  label,
  secret,
  required,
});

/** Los siete proveedores del mockup 37, con sus categorías. */
export const PROVIDERS: ProviderDefinition[] = [
  {
    provider: 'IZIPAY',
    label: 'Izipay',
    category: 'PAYMENT_GATEWAY',
    description: 'Acepta pagos con tarjetas de crédito, débito, Yape, Plin y más.',
    fields: [field('public_key', 'Clave pública', false), field('private_key', 'Clave privada', true)],
  },
  {
    provider: 'NIUBIZ',
    label: 'Niubiz',
    category: 'PAYMENT_GATEWAY',
    description: 'Pasarela líder en Perú. Acepta tarjetas nacionales e internacionales.',
    fields: [
      field('merchant_id', 'Código de comercio', false),
      field('access_key', 'Usuario de acceso', false),
      field('secret_key', 'Clave secreta', true),
    ],
  },
  {
    provider: 'CULQI',
    label: 'Culqi',
    category: 'PAYMENT_GATEWAY',
    description: 'Pagos online para negocios. Fácil integración.',
    fields: [field('public_key', 'Llave pública', false), field('private_key', 'Llave privada', true)],
  },
  {
    provider: 'PAYPAL',
    label: 'PayPal',
    category: 'PAYMENT_GATEWAY',
    description: 'Acepta pagos internacionales con tarjetas y saldo PayPal.',
    fields: [field('client_id', 'Client ID', false), field('client_secret', 'Client secret', true)],
  },
  {
    provider: 'GOOGLE_ANALYTICS',
    label: 'Google Analytics',
    category: 'ANALYTICS',
    description: 'Analiza el comportamiento de tus clientes y ventas.',
    fields: [field('measurement_id', 'ID de medición', false)],
  },
  {
    provider: 'GOOGLE_MAPS',
    label: 'Google Maps',
    category: 'OTHER',
    description: 'Mejora la visualización de rutas y ubicación de terminales.',
    fields: [field('api_key', 'Clave de API', true)],
  },
  {
    provider: 'WHATSAPP_BUSINESS',
    label: 'WhatsApp Business',
    category: 'MESSAGING',
    description: 'Envía confirmaciones y notificaciones por WhatsApp.',
    fields: [
      field('phone_number_id', 'ID del número', false),
      field('access_token', 'Token de acceso', true),
    ],
  },
];

/**
 * La categoría `INVOICING` existe en el enum que propone §5 y el mockup dibuja su pestaña,
 * pero **no muestra ningún proveedor**. Se deja vacía en lugar de inventar uno.
 */
export const PROVIDER_NAMES = PROVIDERS.map((entry) => entry.provider) as [string, ...string[]];

export function findProvider(provider: string): ProviderDefinition | null {
  return PROVIDERS.find((entry) => entry.provider === provider) ?? null;
}

/** Campos obligatorios que faltan en unas credenciales dadas. */
export function missingFields(definition: ProviderDefinition, credentials: Record<string, unknown> | null): string[] {
  return definition.fields
    .filter((entry) => entry.required)
    .filter((entry) => {
      const value = credentials?.[entry.name];
      return typeof value !== 'string' || value.trim() === '';
    })
    .map((entry) => entry.name);
}

/**
 * Vista parcial de una credencial: solo los 4 últimos caracteres, para poder distinguir
 * «la de pruebas» de «la de producción» sin exponer nada aprovechable.
 */
export function maskCredential(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  return trimmed.length <= 4 ? '••••' : `•••• ${trimmed.slice(-4)}`;
}
