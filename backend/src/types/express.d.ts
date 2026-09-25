import type { ApiKeyIdentity } from '../services/api-key.service';
import type { AuthenticatedUser } from './entities';

declare global {
  namespace Express {
    interface Request {
      /** Identificador único de la petición. Lo pone `attachRequestId`. */
      id?: string;
      /** Persona autenticada con JWT. La pone `authenticate`. */
      user?: AuthenticatedUser;
      /**
       * F12-07 · identificador y caducidad del token con el que llegó la petición, para que
       * `POST /auth/logout` revoque ESE token. Nunca contiene el token.
       */
      session?: { jti: string | null; exp: number | null };
      /**
       * Empresa autenticada con una API Key. La pone `authenticateApiKeyRequest`.
       *
       * Vive aparte de `user` a propósito: una llave no es una persona y no debe
       * suplantarla. Los middlewares de rol y permiso siguen mirando solo `user`.
       */
      apiKey?: ApiKeyIdentity;
    }
  }
}

export {};
