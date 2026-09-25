import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { execute, queryOne } from '../config/database';
import { env } from '../config/env';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { loadAuthenticatedUser } from '../repositories/user.repository';
import { recordAudit } from '../services/audit.service';
import * as authService from '../services/auth.service';
import * as passwordReset from '../services/password-reset.service';
import { revokeSession } from '../services/session-revocation.service';
import { asyncHandler, sendSuccess } from '../utils/http';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerCompanySchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
  verifyResetCodeSchema,
} from '../validators/auth.validators';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.rateLimit.auth,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Demasiados intentos. Vuelve a intentarlo en unos minutos.' },
});

router.post(
  '/login',
  authLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.login(req.body);
    // Se pasa la petición real y el autor por separado: copiar `req` con el operador de
    // propagación perdía `headers` —un getter del prototipo en Node moderno—, de modo que
    // `recordAudit` fallaba y el inicio de sesión NUNCA llegaba a auditarse.
    await recordAudit(req, {
      action: 'LOGIN',
      entityType: 'users',
      entityId: result.user.id,
      description: 'Inicio de sesión',
      actorId: result.user.id,
    });
    sendSuccess(res, result);
  }),
);

router.post(
  '/register',
  authLimiter,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.registerCustomer(req.body);
    sendSuccess(res, result, 201);
  }),
);

router.post(
  '/register/company',
  authLimiter,
  validate(registerCompanySchema),
  asyncHandler(async (req, res) => {
    const result = await authService.registerCompany(req.body);
    sendSuccess(
      res,
      {
        ...result,
        message: 'Tu solicitud fue recibida. Te notificaremos cuando la verificación finalice.',
      },
      201,
    );
  }),
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    sendSuccess(res, requireAuth(req));
  }),
);

/** Únicos campos que un usuario puede cambiar de su propio perfil. */
const PROFILE_COLUMNS = ['first_name', 'last_name', 'phone', 'avatar_url'];

router.put(
  '/me',
  authenticate,
  validate(updateProfileSchema),
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    const data = req.body as Record<string, unknown>;

    // Lista blanca explícita de columnas. Zod ya descarta las claves desconocidas, pero el
    // nombre de columna se interpola en el SQL: no debe depender de lo que llegue en el cuerpo.
    const columns = PROFILE_COLUMNS.filter((column) => data[column] !== undefined);

    if (columns.length > 0) {
      await execute(
        `UPDATE users SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`,
        [...columns.map((column) => data[column]), user.id],
      );
    }
    sendSuccess(res, await loadAuthenticatedUser(user.id));
  }),
);

router.put(
  '/me/password',
  authenticate,
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    await authService.changePassword(user.id, req.body.current_password, req.body.new_password);
    await recordAudit(req, { action: 'UPDATE', entityType: 'users', entityId: user.id, description: 'Cambió su contraseña' });
    sendSuccess(res, { message: 'Contraseña actualizada correctamente' });
  }),
);

/**
 * Recuperación de contraseña con código de verificación (mockup 10).
 *
 * Los cuatro endpoints usan `authLimiter`, el mismo limitador que login y registro: no se
 * añade un segundo limitador. Ninguno revela si el correo existe ni devuelve el código.
 */
router.post(
  '/forgot-password',
  authLimiter,
  validate(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    sendSuccess(res, await passwordReset.requestReset(req.body.email));
  }),
);

router.post(
  '/resend-reset-code',
  authLimiter,
  validate(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    sendSuccess(res, await passwordReset.requestReset(req.body.email, { resend: true }));
  }),
);

router.post(
  '/verify-reset-code',
  authLimiter,
  validate(verifyResetCodeSchema),
  asyncHandler(async (req, res) => {
    // Devuelve un ticket de un solo uso, no un JWT: no inicia sesión.
    sendSuccess(res, await passwordReset.verifyCode(req.body.email, req.body.code));
  }),
);

router.post(
  '/reset-password',
  authLimiter,
  validate(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const result = await passwordReset.resetPassword(req.body.email, req.body.ticket, req.body.new_password);

    // La auditoría se registra sin sesión: el usuario todavía no ha iniciado sesión.
    const account = await queryOne<{ id: number }>('SELECT id FROM users WHERE email = ? LIMIT 1', [req.body.email]);
    if (account) {
      await recordAudit(req, {
        action: 'UPDATE',
        entityType: 'users',
        entityId: account.id,
        description: 'Restableció su contraseña mediante código de recuperación',
      });
    }
    sendSuccess(res, result);
  }),
);

/**
 * F12-07 · cerrar sesión revoca ESTE token en el servidor (`revoked_sessions`), además de que el
 * cliente lo descarte: una copia del token deja de valer. Las demás sesiones del usuario siguen
 * abiertas; para cerrarlas todas está el cambio de contraseña.
 */
router.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    if (req.session?.jti && req.session.exp) await revokeSession(req.session.jti, user.id, req.session.exp);
    await recordAudit(req, { action: 'LOGOUT', entityType: 'users', entityId: user.id, description: 'Cerró sesión' });
    sendSuccess(res, { message: 'Sesión cerrada correctamente' });
  }),
);

export default router;
