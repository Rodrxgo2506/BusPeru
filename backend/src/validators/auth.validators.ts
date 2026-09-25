import { z } from 'zod';

const password = z
  .string()
  .min(8, 'La contraseña debe tener al menos 8 caracteres')
  .max(72, 'La contraseña es demasiado larga')
  .regex(/[A-Z]/, 'Debe incluir al menos una mayúscula')
  .regex(/[0-9]/, 'Debe incluir al menos un número');

/**
 * La misma regla de contraseña del registro y del cambio de contraseña, para quien necesite
 * aplicarla fuera de estos esquemas (F18-02: alta del primer administrador). Una sola definición.
 */
export const strongPasswordSchema = password;

export const loginSchema = z.object({
  email: z.string().email('Correo electrónico inválido').max(150),
  password: z.string().min(1, 'La contraseña es obligatoria'),
});

export const registerSchema = z.object({
  first_name: z.string().trim().min(2, 'Ingresa tus nombres').max(100),
  last_name: z.string().trim().min(2, 'Ingresa tus apellidos').max(100),
  email: z.string().email('Correo electrónico inválido').max(150),
  phone: z.string().trim().max(30).optional().nullable(),
  password,
});

export const registerCompanySchema = z.object({
  company: z.object({
    name: z.string().trim().min(2, 'Ingresa el nombre comercial').max(150),
    legal_name: z.string().trim().min(2, 'Ingresa la razón social').max(200),
    tax_id: z.string().trim().regex(/^\d{11}$/, 'El RUC debe tener 11 dígitos'),
    email: z.string().email('Correo corporativo inválido').max(150),
    phone: z.string().trim().max(30).optional().nullable(),
    description: z.string().trim().max(2000).optional().nullable(),
  }),
  admin: z.object({
    first_name: z.string().trim().min(2).max(100),
    last_name: z.string().trim().min(2).max(100),
    email: z.string().email('Correo electrónico inválido').max(150),
    phone: z.string().trim().max(30).optional().nullable(),
    password,
    position: z.string().trim().max(100).optional().nullable(),
  }),
});

export const updateProfileSchema = z.object({
  first_name: z.string().trim().min(2).max(100).optional(),
  last_name: z.string().trim().min(2).max(100).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  avatar_url: z.string().trim().url('URL inválida').max(500).nullable().optional(),
});

const resetEmail = z.string().trim().toLowerCase().email('Correo electrónico inválido').max(150);

export const forgotPasswordSchema = z.object({ email: resetEmail });

export const verifyResetCodeSchema = z.object({
  email: resetEmail,
  // Exactamente 6 dígitos: cualquier otra forma se rechaza antes de tocar la base.
  code: z.string().trim().regex(/^\d{6}$/, 'El código debe tener 6 dígitos'),
});

export const resetPasswordSchema = z
  .object({
    email: resetEmail,
    // Ticket opaco emitido al verificar el código (32 bytes en hexadecimal).
    ticket: z.string().trim().regex(/^[a-f0-9]{64}$/, 'Solicitud de recuperación inválida'),
    new_password: password,
    confirm_password: z.string().optional(),
  })
  .refine((value) => value.confirm_password === undefined || value.confirm_password === value.new_password, {
    message: 'Las contraseñas no coinciden',
    path: ['confirm_password'],
  });

export const changePasswordSchema = z.object({
  current_password: z.string().min(1, 'Ingresa tu contraseña actual'),
  new_password: password,
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type RegisterCompanyInput = z.infer<typeof registerCompanySchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type VerifyResetCodeInput = z.infer<typeof verifyResetCodeSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
