import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';

/**
 * Diálogo con el proveedor de identidad (PENDIENTES.md §2).
 *
 * Aquí vive TODO lo que depende de Google o Microsoft: los extremos, el canje del código
 * por tokens y la verificación criptográfica del `id_token`. El resto del sistema recibe
 * únicamente una identidad ya verificada, nunca un token del proveedor.
 *
 * La identidad **jamás** procede del cuerpo de la petición: sale de un `id_token` firmado
 * por el proveedor cuya firma, emisor, audiencia, vigencia y `nonce` se comprueban aquí.
 *
 * No se guarda ningún token del proveedor. El `access_token` y el `refresh_token` se
 * descartan en cuanto se extrae la identidad: §2 no pide acceso a las APIs del proveedor,
 * solo autenticar, así que conservarlos sería asumir un riesgo sin ninguna contrapartida.
 */

export const OAUTH_PROVIDERS = ['GOOGLE', 'MICROSOFT'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return typeof value === 'string' && (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  jwksUri: string;
  /** Emisor esperado. En Microsoft lleva el marcador `{tenantid}`, que se resuelve con el claim `tid`. */
  issuer: string;
  /** Emisores adicionales admitidos. Google firma indistintamente con y sin esquema. */
  alternateIssuers: string[];
  scope: string;
}

/** Extremos reales de Microsoft, derivados del tenant configurado. */
function microsoftDefaults(tenant: string) {
  return {
    authorizationUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    jwksUri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
    // `{tenantid}` se sustituye por el claim `tid` del token: es la forma que documenta
    // Microsoft para validar el emisor cuando la aplicación acepta varios tenants.
    issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
  };
}

export function providerConfig(provider: OAuthProvider): ProviderConfig {
  if (provider === 'GOOGLE') {
    const google = env.oauth.google;
    return {
      clientId: google.clientId,
      clientSecret: google.clientSecret,
      authorizationUrl: google.authorizationUrl,
      tokenUrl: google.tokenUrl,
      jwksUri: google.jwksUri,
      issuer: google.issuer,
      // Google emite `accounts.google.com` y `https://accounts.google.com` indistintamente.
      alternateIssuers: google.issuer === 'https://accounts.google.com' ? ['accounts.google.com'] : [],
      scope: 'openid email profile',
    };
  }

  const microsoft = env.oauth.microsoft;
  const defaults = microsoftDefaults(microsoft.tenant);
  return {
    clientId: microsoft.clientId,
    clientSecret: microsoft.clientSecret,
    authorizationUrl: microsoft.authorizationUrl || defaults.authorizationUrl,
    tokenUrl: microsoft.tokenUrl || defaults.tokenUrl,
    jwksUri: microsoft.jwksUri || defaults.jwksUri,
    issuer: microsoft.issuer || defaults.issuer,
    alternateIssuers: [],
    scope: 'openid email profile',
  };
}

/** Un proveedor solo está disponible si tiene identificador y secreto. */
export function isConfigured(provider: OAuthProvider): boolean {
  const config = providerConfig(provider);
  return config.clientId !== '' && config.clientSecret !== '';
}

export function assertConfigured(provider: OAuthProvider): ProviderConfig {
  const config = providerConfig(provider);
  if (!config.clientId || !config.clientSecret) {
    throw ApiError.serviceUnavailable(
      `El inicio de sesión con ${provider === 'GOOGLE' ? 'Google' : 'Microsoft'} no está configurado en este servidor`,
    );
  }
  return config;
}

/** `redirect_uri` exacto: debe coincidir con el registrado en el proveedor. */
export function redirectUri(provider: OAuthProvider): string {
  return `${env.oauth.callbackBaseUrl.replace(/\/$/, '')}/auth/oauth/${provider.toLowerCase()}/callback`;
}

// --- JWKS -------------------------------------------------------------------

interface Jwk { kid?: string; kty?: string; alg?: string; use?: string; [key: string]: unknown }

interface CachedKeys { keys: Jwk[]; fetchedAt: number }

const jwksCache = new Map<OAuthProvider, CachedKeys>();
const JWKS_TTL_MS = 60 * 60 * 1000;

/** Vacía la caché de claves. La usa la suite entre escenarios. */
export function resetJwksCache(): void {
  jwksCache.clear();
}

async function fetchJwks(provider: OAuthProvider, force: boolean): Promise<Jwk[]> {
  const cached = jwksCache.get(provider);
  if (!force && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;

  const config = providerConfig(provider);
  let response: Response;
  try {
    response = await fetch(config.jwksUri, { headers: { Accept: 'application/json' } });
  } catch {
    throw ApiError.serviceUnavailable('No se pudo contactar con el proveedor de identidad');
  }
  if (!response.ok) throw ApiError.serviceUnavailable('El proveedor de identidad no devolvió sus claves públicas');

  const body = (await response.json().catch(() => null)) as { keys?: Jwk[] } | null;
  const keys = body?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw ApiError.serviceUnavailable('El proveedor de identidad no devolvió sus claves públicas');
  }

  jwksCache.set(provider, { keys, fetchedAt: Date.now() });
  return keys;
}

/**
 * Clave pública correspondiente al `kid` del token. Si no aparece en la caché se recargan
 * las claves una sola vez: los proveedores las rotan y así no hay que reiniciar el servidor.
 */
async function publicKeyFor(provider: OAuthProvider, kid: string): Promise<crypto.KeyObject> {
  for (const force of [false, true]) {
    const keys = await fetchJwks(provider, force);
    const jwk = keys.find((key) => key.kid === kid);
    if (jwk) {
      try {
        return crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
      } catch {
        throw ApiError.unauthorized('No se pudo validar la identidad del proveedor');
      }
    }
  }
  throw ApiError.unauthorized('No se pudo validar la identidad del proveedor');
}

// --- Verificación del id_token ----------------------------------------------

export interface VerifiedIdentity {
  provider: OAuthProvider;
  /** Identificador estable del usuario en el proveedor. Es lo que se guarda en `users.oauth_id`. */
  subject: string;
  email: string;
  emailVerified: boolean;
  firstName: string;
  lastName: string;
}

interface IdTokenClaims {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  given_name?: string;
  family_name?: string;
  name?: string;
  nonce?: string;
  tid?: string;
  oid?: string;
  preferred_username?: string;
  iss?: string;
}

/** Emisor esperado, resolviendo el marcador de tenant de Microsoft con el claim `tid`. */
function expectedIssuers(config: ProviderConfig, claims: IdTokenClaims): string[] {
  if (!config.issuer.includes('{tenantid}')) return [config.issuer, ...config.alternateIssuers];

  // Sin `tid` no se puede resolver el emisor, así que no hay nada válido con lo que comparar.
  if (!claims.tid) return [];
  return [config.issuer.replace('{tenantid}', claims.tid)];
}

/**
 * Verifica el `id_token` de principio a fin: algoritmo, firma contra el JWKS, emisor,
 * audiencia, vigencia y `nonce`. Cualquier fallo es 401 con un mensaje neutro.
 */
export async function verifyIdToken(
  provider: OAuthProvider,
  idToken: string,
  expectedNonce: string,
): Promise<VerifiedIdentity> {
  const config = assertConfigured(provider);

  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || typeof decoded === 'string') throw ApiError.unauthorized('El token del proveedor no es válido');

  // Solo RS256: aceptar `alg` del propio token abriría la puerta a `none` o a HS256 firmado
  // con la clave pública, que son los dos ataques clásicos contra la verificación de JWT.
  if (decoded.header.alg !== 'RS256') throw ApiError.unauthorized('El token del proveedor no es válido');
  if (!decoded.header.kid) throw ApiError.unauthorized('El token del proveedor no es válido');

  const key = await publicKeyFor(provider, decoded.header.kid);
  const issuers = expectedIssuers(config, (decoded.payload ?? {}) as IdTokenClaims);
  const [firstIssuer, ...otherIssuers] = issuers;
  if (firstIssuer === undefined) throw ApiError.unauthorized('El token del proveedor no es válido');

  let claims: IdTokenClaims;
  try {
    claims = jwt.verify(idToken, key, {
      algorithms: ['RS256'],
      audience: config.clientId,
      issuer: [firstIssuer, ...otherIssuers],
      clockTolerance: 60,
    }) as IdTokenClaims;
  } catch {
    throw ApiError.unauthorized('El token del proveedor no es válido');
  }

  // El `nonce` ata el token a ESTA petición: sin él, un id_token robado de otra sesión
  // podría reutilizarse aquí.
  if (!claims.nonce || claims.nonce !== expectedNonce) {
    throw ApiError.unauthorized('El token del proveedor no es válido');
  }

  // Microsoft identifica al usuario con `oid` dentro del tenant; Google con `sub`.
  const subject = provider === 'MICROSOFT' ? (claims.oid ?? claims.sub) : claims.sub;
  if (!subject) throw ApiError.unauthorized('El token del proveedor no es válido');

  const email = (claims.email ?? claims.preferred_username ?? '').trim().toLowerCase();
  if (!email) throw ApiError.unauthorized('El proveedor no entregó un correo electrónico');

  const fromName = (claims.name ?? '').trim().split(/\s+/);
  const firstName = claims.given_name?.trim() || fromName[0] || email.split('@')[0] || 'Usuario';
  const lastName = claims.family_name?.trim() || fromName.slice(1).join(' ') || '';

  return {
    provider,
    subject: String(subject),
    email,
    /**
     * Verificación del correo, tal y como la declara el proveedor. No se deduce de nada
     * más: solo se lee el claim `email_verified` que el token traiga.
     *
     *   · Google lo emite siempre, y es `true` para las cuentas cuyo correo ha confirmado.
     *   · Microsoft NO lo emite de forma fiable. En cuentas personales no viene, y en
     *     cuentas de organización tampoco de serie: la vía documentada es habilitar el
     *     claim opcional correspondiente en el registro de la aplicación.
     *
     * La consecuencia está asumida y es deliberada: mientras Microsoft no envíe el claim,
     * un correo suyo se trata como NO verificado, y `resolveLogin` no dará de alta con él.
     * Iniciar sesión con una identidad ya vinculada sigue funcionando, porque ese camino no
     * depende del correo. Preferimos negar un alta legítima antes que aceptar una identidad
     * que el proveedor no respalda.
     */
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    firstName: firstName.slice(0, 100),
    lastName: (lastName || firstName).slice(0, 100),
  };
}

// --- Canje del código --------------------------------------------------------

/**
 * Canjea el `code` por tokens. El `client_secret` y el `code_verifier` viajan de servidor a
 * servidor; nunca pasan por el navegador. Del resultado solo se conserva el `id_token`.
 */
export async function exchangeCode(provider: OAuthProvider, code: string, codeVerifier: string): Promise<string> {
  const config = assertConfigured(provider);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(provider),
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: codeVerifier,
  });

  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch {
    throw ApiError.serviceUnavailable('No se pudo contactar con el proveedor de identidad');
  }

  const payload = (await response.json().catch(() => null)) as { id_token?: string } | null;
  // El cuerpo del error del proveedor puede contener el código y datos de la aplicación:
  // no se propaga al cliente ni se registra.
  if (!response.ok || !payload?.id_token) throw ApiError.unauthorized('El proveedor rechazó la autenticación');

  return payload.id_token;
}

/** URL de autorización con PKCE (S256), `state` y `nonce`. */
export function authorizationUrl(
  provider: OAuthProvider,
  params: { state: string; nonce: string; codeChallenge: string },
): string {
  const config = assertConfigured(provider);

  const query = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(provider),
    scope: config.scope,
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  });

  return `${config.authorizationUrl}?${query.toString()}`;
}
