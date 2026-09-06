import { z } from 'zod';
import { OAUTH_SCOPES } from '../services/oauth.service';

/**
 * Validación del inicio de sesión con Google / Microsoft (PENDIENTES.md §2).
 *
 * Obsérvese lo que NO aparece aquí: `email`, `user_id`, `role`, `company_id`, `status` ni
 * `oauth_id`. La identidad procede siempre del `id_token` firmado por el proveedor, y el
 * rol y la empresa se resuelven en el servidor. El cliente solo elige desde qué portal
 * arranca el flujo, y esa elección únicamente puede restringir el alta.
 */

export const startOAuthSchema = z.object({
  scope: z.enum(OAUTH_SCOPES).default('CUSTOMER'),
});

export const oauthSessionSchema = z.object({
  ticket: z.string().trim().min(1, 'Falta el ticket de acceso').max(200),
});

export type StartOAuthInput = z.infer<typeof startOAuthSchema>;
export type OAuthSessionInput = z.infer<typeof oauthSessionSchema>;
