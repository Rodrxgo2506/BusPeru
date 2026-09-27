/**
 * Documento de identidad y fecha de nacimiento del cliente (sin React ni DOM: se prueban con `node --test`).
 *
 * SOLO FORMATO. Nada aquí verifica que el documento exista o sea de quien lo escribe (no hay RENIEC). Las
 * reglas son las mismas que aplica el backend (`identity.validators.ts`), que a su vez son las del Libro de
 * Reclamaciones: la API vuelve a validar siempre; esto solo evita un viaje de ida y vuelta.
 *
 * FECHA. Se escribe `DD/MM/AAAA` (máscara con teclado numérico) y viaja como `AAAA-MM-DD`. No se usa el
 * calendario del buscador: está pensado para fechas cercanas y llegar a 1999 exigiría decenas de clics.
 */

export type IdentityDocumentType = 'DNI' | 'CE' | 'PASAPORTE';

export const DOCUMENT_TYPE_OPTIONS: Array<{ value: IdentityDocumentType; label: string }> = [
  { value: 'DNI', label: 'DNI' },
  { value: 'CE', label: 'Carné de extranjería (CE)' },
  { value: 'PASAPORTE', label: 'Pasaporte' },
];

export const DOCUMENT_UI: Record<IdentityDocumentType, { placeholder: string; hint: string; inputMode: 'numeric' | 'text'; maxLength: number }> = {
  DNI: { placeholder: 'Ingresa tu DNI', hint: 'Ingresa tu DNI de 8 dígitos.', inputMode: 'numeric', maxLength: 8 },
  CE: { placeholder: 'Ingresa tu carné de extranjería', hint: 'Entre 8 y 12 letras o números, sin espacios.', inputMode: 'text', maxLength: 12 },
  PASAPORTE: { placeholder: 'Ingresa tu pasaporte', hint: 'Entre 6 y 12 letras o números, sin espacios.', inputMode: 'text', maxLength: 12 },
};

const FORMATS: Record<IdentityDocumentType, RegExp> = {
  DNI: /^\d{8}$/,
  CE: /^[A-Z0-9]{8,12}$/,
  PASAPORTE: /^[A-Z0-9]{6,12}$/,
};

const MESSAGES: Record<IdentityDocumentType, string> = {
  DNI: 'El DNI debe tener exactamente 8 dígitos, solo números',
  CE: 'El carné de extranjería debe tener entre 8 y 12 letras o números, sin espacios ni símbolos',
  PASAPORTE: 'El pasaporte debe tener entre 6 y 12 letras o números, sin espacios ni símbolos',
};

export function isDocumentType(value: unknown): value is IdentityDocumentType {
  return value === 'DNI' || value === 'CE' || value === 'PASAPORTE';
}

/** Quita los espacios de los extremos; CE y pasaporte en mayúsculas. No «arregla» nada más. */
export function normalizeDocumentNumber(type: IdentityDocumentType, value: string): string {
  const trimmed = value.trim();
  return type === 'DNI' ? trimmed : trimmed.toUpperCase();
}

/** `null` si el número tiene el formato del tipo; si no, el mensaje que se muestra junto al campo. */
export function documentNumberError(type: IdentityDocumentType | '', value: string): string | null {
  if (!type) return 'Elige el tipo de documento';
  if (!value.trim()) return 'Ingresa tu número de documento';
  return FORMATS[type].test(normalizeDocumentNumber(type, value)) ? null : MESSAGES[type];
}

/** «DNI — 12345678». */
export function formatIdentityDocument(type: string | null | undefined, number: string | null | undefined): string | null {
  return type && number ? `${type} — ${number}` : null;
}

/** Hoy en Perú (`AAAA-MM-DD`). */
export function todayInPeru(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Máscara mientras se escribe: solo dígitos y las barras en su sitio (`17051999` → `17/05/1999`). */
export function maskBirthDateInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

function isRealDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** `DD/MM/AAAA` → `AAAA-MM-DD`, o el error. Fecha real y no posterior a hoy; sin edad mínima ni máxima. */
export function parseBirthDateInput(text: string, today: string = todayInPeru()): { iso: string } | { error: string } {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!match) return { error: 'Escribe la fecha como DD/MM/AAAA' };
  const [, dd, mm, yyyy] = match as unknown as [string, string, string, string];
  if (!isRealDate(Number(yyyy), Number(mm), Number(dd))) return { error: 'Esa fecha no existe' };
  const iso = `${yyyy}-${mm}-${dd}`;
  if (iso > today) return { error: 'La fecha de nacimiento no puede ser posterior a hoy' };
  return { iso };
}

/** `AAAA-MM-DD` → `DD/MM/AAAA` (para mostrar). */
export function formatBirthDate(iso: string | null | undefined): string | null {
  const match = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  return match ? `${match[3]}/${match[2]}/${match[1]}` : null;
}

export interface IdentityOwner {
  document_type: string | null;
  document_number: string | null;
  birth_date: string | null;
}

/** Qué puede completar todavía el cliente desde su perfil: solo lo que está vacío (una sola vez). */
export function editableIdentity(user: IdentityOwner | null | undefined): { document: boolean; birthDate: boolean } {
  return { document: !(user?.document_type && user?.document_number), birthDate: !user?.birth_date };
}

/**
 * Parte de identidad de «Editar perfil». Solo incluye lo editable y lo que se rellenó (dejarlo vacío no
 * borra nada); lo ya registrado nunca se envía. El backend vuelve a hacer cumplir la regla.
 */
export function buildIdentityUpdate(
  values: { document_type?: unknown; document_number?: unknown; birth_date?: unknown },
  user: IdentityOwner | null | undefined,
  today: string = todayInPeru(),
): { payload: Record<string, string>; errors: Record<string, string> } {
  const editable = editableIdentity(user);
  const payload: Record<string, string> = {};
  const errors: Record<string, string> = {};
  const type = String(values.document_type ?? '').trim();
  const number = String(values.document_number ?? '').trim();
  const birth = String(values.birth_date ?? '').trim();

  if (editable.document && (type || number)) {
    const error = documentNumberError(isDocumentType(type) ? type : '', number);
    if (error) errors[isDocumentType(type) ? 'document_number' : 'document_type'] = error;
    else if (isDocumentType(type)) {
      payload.document_type = type;
      payload.document_number = normalizeDocumentNumber(type, number);
    }
  }
  if (editable.birthDate && birth) {
    const parsed = parseBirthDateInput(maskBirthDateInput(birth), today);
    if ('error' in parsed) errors.birth_date = parsed.error;
    else payload.birth_date = parsed.iso;
  }
  return { payload, errors };
}
