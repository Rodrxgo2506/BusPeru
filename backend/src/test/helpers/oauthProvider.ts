import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';

/**
 * Proveedor de identidad de mentira, local y con criptografía REAL.
 *
 * No simula la verificación: genera un par RSA de verdad, publica su clave pública en un
 * JWKS y firma los `id_token` con la privada. El backend los valida con el mismo código que
 * usaría contra Google o Microsoft — lo único que cambia es a qué URL apunta.
 *
 * Esto permite probar de forma honesta la firma, el emisor, la audiencia, la vigencia, el
 * `nonce` y PKCE sin inventar credenciales ni cuentas reales de ningún proveedor.
 */

export interface TokenClaims {
  sub?: string;
  oid?: string;
  email?: string;
  email_verified?: boolean;
  given_name?: string;
  family_name?: string;
  name?: string;
  nonce?: string;
  tid?: string;
  iss?: string;
  aud?: string;
  exp?: number;
  iat?: number;
}

export interface FakeProvider {
  /** Base del proveedor falso: de aquí salen `/authorize`, `/token` y `/jwks`. */
  url: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  keyId: string;
  /** Claims que devolverá el próximo canje de código. */
  nextClaims: TokenClaims;
  /** Firma un token con la clave buena del proveedor. */
  sign(claims: TokenClaims, options?: SignOptions): string;
  /** Fuerza el siguiente canje a devolver este token en bruto, en vez de firmar uno nuevo. */
  nextIdToken: string | null;
  /** Fuerza el siguiente canje a fallar con este código HTTP. */
  failNextExchange: number | null;
  /** Cuerpo del último POST al endpoint de token, para comprobar PKCE y el secreto. */
  lastTokenRequest: Record<string, string> | null;
  /** Cuántas veces se ha pedido el JWKS, para comprobar la caché. */
  jwksRequests: number;
  reset(): void;
  stop(): Promise<void>;
}

export interface SignOptions {
  /** Firma con una clave distinta de la publicada: simula una firma falsificada. */
  wrongKey?: boolean;
  /** `kid` distinto del publicado en el JWKS. */
  kid?: string;
  /** Algoritmo alternativo, para probar el rechazo de `none` o HS256. */
  algorithm?: jwt.Algorithm;
}

function toJwk(publicKey: crypto.KeyObject, kid: string): Record<string, unknown> {
  return { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
}

export async function startFakeProvider(options: { clientId?: string; clientSecret?: string } = {}): Promise<FakeProvider> {
  const good = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  // Segundo par: sirve para firmar tokens con una clave que NO está en el JWKS.
  const rogue = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

  const keyId = 'test-key-1';
  const clientId = options.clientId ?? 'client-de-pruebas.apps.example.com';
  const clientSecret = options.clientSecret ?? 'secreto-de-pruebas';

  const state: FakeProvider = {
    url: '',
    issuer: '',
    clientId,
    clientSecret,
    keyId,
    nextClaims: {},
    nextIdToken: null,
    failNextExchange: null,
    lastTokenRequest: null,
    jwksRequests: 0,
    sign(claims, signOptions = {}) {
      const algorithm = signOptions.algorithm ?? 'RS256';
      const key = signOptions.wrongKey ? rogue.privateKey : good.privateKey;
      const now = Math.floor(Date.now() / 1000);

      const payload: TokenClaims = {
        iss: state.issuer,
        aud: clientId,
        iat: now,
        exp: now + 300,
        ...claims,
      };

      // HS256 usa una clave simétrica: se firma con el propio clientId, que es lo que un
      // atacante conocería, para comprobar que el backend rechaza el algoritmo.
      if (algorithm === 'HS256') {
        return jwt.sign(payload, clientId, { algorithm, keyid: signOptions.kid ?? keyId });
      }
      return jwt.sign(payload, key, { algorithm, keyid: signOptions.kid ?? keyId });
    },
    reset() {
      state.nextClaims = {};
      state.nextIdToken = null;
      state.failNextExchange = null;
      state.lastTokenRequest = null;
      state.jwksRequests = 0;
    },
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', state.url || 'http://localhost');

    if (url.pathname === '/jwks') {
      state.jwksRequests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [toJwk(good.publicKey, keyId)] }));
      return;
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        state.lastTokenRequest = Object.fromEntries(new URLSearchParams(body));

        if (state.failNextExchange !== null) {
          const status = state.failNextExchange;
          state.failNextExchange = null;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }

        const idToken = state.nextIdToken ?? state.sign(state.nextClaims);
        state.nextIdToken = null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id_token: idToken, access_token: 'no-se-usa', token_type: 'Bearer' }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  state.url = `http://127.0.0.1:${port}`;
  state.issuer = state.url;

  return state;
}

/** Comprueba que el `code_verifier` enviado corresponde al `code_challenge` anunciado. */
export function pkceMatches(codeVerifier: string, codeChallenge: string): boolean {
  const expected = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return expected === codeChallenge;
}
