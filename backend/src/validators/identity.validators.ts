import { z } from 'zod';
import { businessNow } from '../utils/businessTime';

/**
 * Documento de identidad y fecha de nacimiento del cliente (migración 022).
 *
 * SOLO FORMATO. Nada de esto verifica que el documento exista o pertenezca a quien lo escribe: no hay
 * integración con RENIEC ni con Migraciones. Las reglas son las mismas que ya usa el Libro de
 * Reclamaciones para esos tres tipos (`complaint-book.validators.ts`), para que BusPerú no acepte un
 * documento en un sitio y lo rechace en otro.
 *
 * NORMALIZACIÓN. Se quitan los espacios de los extremos. En CE y pasaporte las letras se guardan en
 * mayúsculas (el documento no distingue mayúsculas de minúsculas, así que no cambia su significado); el
 * DNI son solo dígitos. Espacios intermedios, guiones y cualquier otro símbolo se RECHAZAN en lugar de
 * «arreglarse» en silencio: quitarlos podría convertir un dato erróneo en otro documento.
 */
export const IDENTITY_DOCUMENT_TYPES = ['DNI', 'CE', 'PASAPORTE'] as const;
export type IdentityDocumentType = (typeof IDENTITY_DOCUMENT_TYPES)[number];

export const IDENTITY_DOCUMENT_FORMATS: Record<IdentityDocumentType, RegExp> = {
  DNI: /^\d{8}$/,
  CE: /^[A-Z0-9]{8,12}$/,
  PASAPORTE: /^[A-Z0-9]{6,12}$/,
};

const MENSAJES: Record<IdentityDocumentType, string> = {
  DNI: 'El DNI debe tener exactamente 8 dígitos, solo números',
  CE: 'El carné de extranjería debe tener entre 8 y 12 letras o números, sin espacios ni símbolos',
  PASAPORTE: 'El pasaporte debe tener entre 6 y 12 letras o números, sin espacios ni símbolos',
};

export function normalizeDocumentNumber(type: IdentityDocumentType, value: string): string {
  const limpio = value.trim();
  return type === 'DNI' ? limpio : limpio.toUpperCase();
}

/** `null` si el número tiene el formato del tipo; si no, el mensaje de error. */
export function documentNumberError(type: IdentityDocumentType, value: string): string | null {
  return IDENTITY_DOCUMENT_FORMATS[type].test(normalizeDocumentNumber(type, value)) ? null : MENSAJES[type];
}

/** Hoy en Perú (`AAAA-MM-DD`): una fecha de nacimiento no puede ser posterior. */
export const todayInPeru = (): string => businessNow().slice(0, 10);

/** `AAAA-MM-DD` de un día que existe en el calendario (sin 31/02, sin 30/02 fuera de bisiesto…). */
export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Fecha de nacimiento: fecha real, formato `AAAA-MM-DD` y no futura. Sin edad mínima ni máxima. */
export const birthDateSchema = z
  .string()
  .trim()
  .refine(isRealDate, 'La fecha de nacimiento no es una fecha válida (AAAA-MM-DD)')
  .refine((value) => value <= todayInPeru(), 'La fecha de nacimiento no puede ser posterior a hoy');

/**
 * Campos de identidad, todos opcionales. Tipo y número van JUNTOS: uno sin el otro no significa nada.
 * Se aplica igual al registro y a la edición del perfil.
 */
export const identityFields = {
  document_type: z.enum(IDENTITY_DOCUMENT_TYPES, { errorMap: () => ({ message: 'Elige DNI, CE o PASAPORTE' }) }).optional(),
  document_number: z.string().max(20, 'Número de documento demasiado largo').optional(),
  birth_date: birthDateSchema.optional(),
};

/**
 * Los mismos campos, OBLIGATORIOS: el registro de un cliente nuevo por `/auth/register` no se acepta sin
 * documento y fecha de nacimiento. Las columnas siguen siendo NULL en la base: cuentas antiguas y las
 * creadas por Google/Microsoft nacen sin ellos y los completan después desde su perfil.
 */
export const requiredIdentityFields = {
  document_type: z.enum(IDENTITY_DOCUMENT_TYPES, {
    errorMap: (issue, ctx) => ({ message: issue.code === 'invalid_type' && ctx.data === undefined ? 'Elige el tipo de documento' : 'Elige DNI, CE o PASAPORTE' }),
  }),
  document_number: z.string({ required_error: 'Ingresa tu número de documento' }).max(20, 'Número de documento demasiado largo'),
  birth_date: z.string({ required_error: 'Ingresa tu fecha de nacimiento' }).pipe(birthDateSchema),
};

type IdentityShape = { document_type?: IdentityDocumentType; document_number?: string };

/** Comprueba la pareja tipo/número y deja el número normalizado. */
export function refineIdentity<T extends IdentityShape>(value: T, ctx: z.RefinementCtx): void {
  const hasType = value.document_type !== undefined;
  const hasNumber = value.document_number !== undefined;
  if (hasType !== hasNumber) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [hasType ? 'document_number' : 'document_type'], message: 'Indica el tipo y el número de documento' });
    return;
  }
  if (hasType && hasNumber) {
    const error = documentNumberError(value.document_type!, value.document_number!);
    if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['document_number'], message: error });
  }
}

export function normalizeIdentity<T extends IdentityShape>(value: T): T {
  if (value.document_type && value.document_number !== undefined) {
    return { ...value, document_number: normalizeDocumentNumber(value.document_type, value.document_number) };
  }
  return value;
}
