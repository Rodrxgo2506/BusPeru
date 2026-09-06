import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import * as authService from '../services/auth.service';
import * as oauth from '../services/oauth.service';
import { isOAuthProvider, type OAuthProvider } from '../services/oauth-provider.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendSuccess } from '../utils/http';
import { oauthSessionSchema, startOAuthSchema } from '../validators/oauth.validators';

/**
 * Inicio de sesión con Google / Microsoft (PENDIENTES.md §2, mockups 8, 12 y 30).
 *
 * Flujo Authorization Code + PKCE:
 *
 *   1. `GET  /auth/oauth/:provider/start`     → 302 al proveedor, con state + nonce + PKCE
 *   2. `GET  /auth/oauth/:provider/callback`  → 302 al frontend con un ticket de un solo uso
 *   3. `POST /auth/oauth/session`             → canjea el ticket por el JWT de siempre
 *
 * El paso 3 existe para no poner el JWT en la URL: un ticket opaco de 32 bytes, válido un
 * minuto y de un solo uso, no sirve de nada si queda en el historial del navegador.
 *
 * **No hay un segundo sistema de autorización.** El token que se emite es el mismo
 * `signToken()` del login con contraseña, con la misma expiración, y el middleware sigue
 * releyendo rol, permisos y empresas desde la base en cada petición.
 *
 * Los tres pasos son independientes del proceso: el estado del flujo vive en `oauth_flows`,
 * así que cada uno puede atenderlo una instancia distinta del backend.
 */
const router = Router();

/** Mismo limitador que el resto de `/auth`: el flujo OAuth no es una vía más barata. */
const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.rateLimit.auth,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Demasiados intentos. Vuelve a intentarlo en unos minutos.' },
});

/** Traduce `:provider` de la URL al proveedor del esquema. 404 si no es uno de los dos. */
function parseProvider(value: unknown): OAuthProvider {
  const provider = String(value ?? '').toUpperCase();
  if (!isOAuthProvider(provider)) throw ApiError.notFound('Proveedor no soportado');
  return provider;
}

/** A dónde vuelve el navegador tras el callback, con el ticket o con el código de error. */
function frontendRedirect(params: Record<string, string>): string {
  const url = new URL(env.oauth.frontendCallbackPath, env.frontendUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** Proveedores realmente configurados. El frontend no pinta botones que no funcionan. */
router.get(
  '/providers',
  asyncHandler(async (_req, res) => {
    sendSuccess(res, oauth.availableProviders());
  }),
);

router.get(
  '/:provider/start',
  oauthLimiter,
  validate(startOAuthSchema, 'query'),
  asyncHandler(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    const scope = (req.query.scope ?? 'CUSTOMER') as oauth.OAuthScope;

    res.redirect(await oauth.startFlow({ provider, scope, mode: 'LOGIN' }));
  }),
);

/**
 * Inicio del flujo de VINCULACIÓN. Es un POST autenticado que devuelve la URL en JSON, no
 * una redirección: una navegación de primer nivel no puede llevar la cabecera
 * `Authorization`, así que la sesión se comprueba aquí y la cuenta a vincular queda
 * guardada del lado del servidor junto al `state`. El callback nunca la recibe del cliente.
 */
router.post(
  '/:provider/link',
  authenticate,
  oauthLimiter,
  asyncHandler(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    const user = requireAuth(req);

    const url = await oauth.startFlow({ provider, scope: 'CUSTOMER', mode: 'LINK', userId: user.id });
    sendSuccess(res, { url });
  }),
);

router.get(
  '/:provider/callback',
  oauthLimiter,
  asyncHandler(async (req, res) => {
    const provider = parseProvider(req.params.provider);

    try {
      const ticket = await oauth.handleCallback(
        provider,
        typeof req.query.code === 'string' ? req.query.code : undefined,
        typeof req.query.state === 'string' ? req.query.state : undefined,
      );
      res.redirect(frontendRedirect({ ticket }));
    } catch (error) {
      // El flujo termina SIEMPRE en el frontend: un error aquí es una redirección con un
      // código, no un JSON que el navegador mostraría como una página en blanco.
      const code = error instanceof oauth.OAuthFlowError ? error.code : 'provider_error';
      res.redirect(frontendRedirect({ error: code, provider: provider.toLowerCase() }));
    }
  }),
);

/** Canje del ticket por la sesión. Emite exactamente el mismo JWT que el login normal. */
router.post(
  '/session',
  oauthLimiter,
  validate(oauthSessionSchema),
  asyncHandler(async (req, res) => {
    const userId = await oauth.consumeTicket(req.body.ticket);
    const result = await authService.issueSession(userId);

    await recordAudit(req, {
      action: 'LOGIN',
      entityType: 'users',
      entityId: result.user.id,
      description: 'Inicio de sesión con proveedor externo',
      actorId: result.user.id,
    });
    sendSuccess(res, result);
  }),
);

/** Vinculación actual de la cuenta autenticada. */
router.get(
  '/link',
  authenticate,
  asyncHandler(async (req, res) => {
    sendSuccess(res, await oauth.currentLink(requireAuth(req).id));
  }),
);

router.delete(
  '/link',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = requireAuth(req);
    await oauth.unlink(user.id);

    await recordAudit(req, {
      action: 'UPDATE',
      entityType: 'users',
      entityId: user.id,
      description: 'Desvinculó su proveedor de inicio de sesión',
    });
    sendSuccess(res, { message: 'Proveedor desvinculado' });
  }),
);

export default router;
