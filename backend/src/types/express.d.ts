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
