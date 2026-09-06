import { z } from 'zod';

/**
 * Validación de los datos bancarios (mockup 36).
 *
 * Los esquemas describen SOLO las columnas escribibles: Zod descarta el resto, así que
 * `company_id`, `id`, `status` o `created_at` que llegaran en el cuerpo se pierden aquí
 * antes de tocar el servicio. La lista blanca del repositorio es la segunda barrera.
 */

/** Cuentas peruanas: dígitos con guiones o espacios de separación. */
const accountNumber = z
  .string()
  .trim()
  .min(8, 'El número de cuenta es demasiado corto')
  .max(50, 'El número de cuenta es demasiado largo')
  .regex(/^[0-9][0-9\s-]*[0-9]$/, 'El número de cuenta solo admite dígitos, espacios y guiones');

/** El CCI peruano tiene 20 dígitos; se aceptan separadores. */
const interbankCode = z
  .string()
  .trim()
  .max(50, 'El CCI es demasiado largo')
  .regex(/^[0-9][0-9\s-]*[0-9]$/, 'El CCI solo admite dígitos, espacios y guiones')
  .refine((value) => value.replace(/\D/g, '').length === 20, 'El CCI debe tener 20 dígitos')
  .nullable()
  .optional();

const holderDocument = z
  .string()
  .trim()
  .regex(/^\d{8}$|^\d{11}$/, 'Ingresa un DNI (8 dígitos) o un RUC (11 dígitos)')
  .nullable()
  .optional();

const base = {
  bank_name: z.string().trim().min(2, 'Ingresa el nombre del banco').max(150),
  account_type: z.enum(['CHECKING', 'SAVINGS'], { errorMap: () => ({ message: 'Tipo de cuenta inválido' }) }),
  currency: z.enum(['PEN', 'USD'], { errorMap: () => ({ message: 'Moneda no admitida' }) }),
  account_number: accountNumber,
  interbank_code: interbankCode,
  holder_name: z.string().trim().min(3, 'Ingresa el titular de la cuenta').max(200),
  holder_document: holderDocument,
  is_primary: z.boolean().optional(),
};

export const createBankAccountSchema = z.object({
  ...base,
  account_type: base.account_type.default('CHECKING'),
  currency: base.currency.default('PEN'),
});

export const updateBankAccountSchema = z
  .object({
    bank_name: base.bank_name.optional(),
    account_type: base.account_type.optional(),
    currency: base.currency.optional(),
    account_number: accountNumber.optional(),
    interbank_code: interbankCode,
    holder_name: base.holder_name.optional(),
    holder_document: holderDocument,
    is_primary: base.is_primary,
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Debes enviar al menos un campo para actualizar' });

export type CreateBankAccountInput = z.infer<typeof createBankAccountSchema>;
export type UpdateBankAccountInput = z.infer<typeof updateBankAccountSchema>;
