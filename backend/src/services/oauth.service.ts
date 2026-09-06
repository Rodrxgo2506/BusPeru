import crypto from 'crypto';
import { env } from '../config/env';
import {
  createOAuthUser,
  findByEmailForOAuth,
  findByOAuthIdentity,
  findOAuthLink,
  linkOAuthIdentity,
  unlinkOAuthIdentity,
  type OAuthAccount,
} from '../repositories/user.repository';
import * as flows from '../repositories/oauth-flow.repository';
import { ApiError } from '../utils/ApiError';
import { hashPassword } from '../utils/security';
import { assertAccountCanSignIn, roleIdByName } from './auth.service';
import {
  assertConfigured,
  authorizationUrl,
  exchangeCode,
  isConfigured,
  verifyIdToken,
  type OAuthProvider,
} from './oauth-provider.service';

/**
 * Reglas de negocio del inicio de sesión con Google / Microsoft (PENDIENTES.md §2).
 *
 * §2 solo define el esquema (`users.oauth_provider` + `users.oauth_id` + clave única). Las
 * tres reglas que el documento dejaba abiertas se decidieron y quedan documentadas allí:
 *
 *   1. **Flujo**: Authorization Code + PKCE. El `client_secret` nunca sale del servidor.
 *   2. **Caso C — el correo ya existe con contraseña**: se RECHAZA (409). No se fusionan
 *      cuentas por coincidencia de correo. El usuario vincula su proveedor desde el perfil,
 *      ya autenticado, donde la prueba de identidad es su propia sesión.
 *   3. **Caso A — correo desconocido**: solo el flujo de CLIENTE da de alta (CUSTOMER
 *      ACTIVE). Portal Empresa y Panel Admin exigen una cuenta ya aprovisionada.
 *
 * El `scope` que llega del navegador solo puede RESTRINGIR: elegir COMPANY o ADMIN impide
 * el alta, y elegir CUSTOMER no concede absolutamente ningún privilegio — el rol lo fija
 * este servicio y los permisos los relee el middleware desde la base en cada petición.
 *
 * ESTADO EFÍMERO DEL FLUJO
 * `state` y tickets viven en la tabla `oauth_flows` (migración `008`), **no en memoria del
 * proceso**. Por eso `/start`, `/callback` y `/session` pueden atenderse en instancias
 * distintas del backend y un reinicio no invalida un flujo en vuelo.
 *
 * El `nonce` y el `code_verifier` no se guardan en ninguna parte: se DERIVAN del `state`
 * —que el proveedor devuelve en el callback— y del secreto de la instalación. La
 * derivación es determinista, así que `/start` y `/callback` obtienen exactamente el mismo
 * valor sin compartir memoria y sin dejar ningún secreto en reposo.
 */

/** Portal desde el que se inició el flujo. Determina únicamente si se permite el alta. */
export const OAUTH_SCOPES = ['CUSTOMER', 'COMPANY', 'ADMIN'] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

type Mode = 'LOGIN' | 'LINK';

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Hashes que se guardan en la base. El secreto liga el hash a esta instalación: una
 * filtración de la tabla no permite reconstruir ningún `state` ni ningún ticket.
 */
function hashState(state: string): string {
  return digest(`${state}:state:${env.jwt.secret}`);
}

function hashTicket(ticket: string): string {
  return digest(`${ticket}:ticket:${env.jwt.secret}`);
}

/**
 * `nonce` y `code_verifier` DERIVADOS del `state`, no almacenados.
 *
 * El proveedor devuelve el `state` en el callback, así que ambos se recalculan allí de
 * forma determinista. Quien vea la URL conoce el `state`, pero sin `JWT_SECRET` no puede
 * derivar el verificador; y quien tuviera `JWT_SECRET` podría falsificar sesiones
 * directamente, de modo que no se introduce ninguna debilidad nueva.
 *
 * El verificador cumple el RFC 7636: 64 caracteres hexadecimales, dentro del rango 43-128
 * y usando solo caracteres `unreserved`. El `code_challenge` sigue siendo su SHA-256 en
 * base64url (S256).
 */
function deriveNonce(state: string): string {
  return digest(`${state}:nonce:${env.jwt.secret}`);
}

function deriveCodeVerifier(state: string): string {
  return digest(`${state}:pkce:${env.jwt.secret}`);
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Proveedores realmente disponibles. El frontend solo pinta los que estén configurados. */
export function availableProviders(): Array<{ provider: OAuthProvider; configured: boolean }> {
  return [
    { provider: 'GOOGLE' as const, configured: isConfigured('GOOGLE') },
    { provider: 'MICROSOFT' as const, configured: isConfigured('MICROSOFT') },
  ];
}

/**
 * Arranca el flujo: genera `state`, `nonce` y el par PKCE, los guarda del lado del servidor
 * y devuelve la URL de autorización. Nada de esto es adivinable ni manipulable por el
 * cliente: el `state` es un identificador opaco de 32 bytes.
 */
export async function startFlow(options: {
  provider: OAuthProvider;
  scope: OAuthScope;
  mode: Mode;
  userId?: number;
}): Promise<string> {
  assertConfigured(options.provider);

  const state = base64Url(crypto.randomBytes(32));
  const nonce = deriveNonce(state);
  const codeVerifier = deriveCodeVerifier(state);
  const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());

  // Solo el hash llega a la base. El `state` en claro vive únicamente en la URL del
  // navegador, y de él se rederivan `nonce` y verificador en el callback.
  await flows.createFlow({
    stateHash: hashState(state),
    provider: options.provider,
    scope: options.scope,
    mode: options.mode,
    userId: options.userId ?? null,
    ttlSeconds: env.oauth.stateTtlSeconds,
  });

  return authorizationUrl(options.provider, { state, nonce, codeChallenge });
}

/**
 * Códigos de error que el callback pasa al frontend por la URL.
 *
 * Son deliberadamente genéricos: describen qué hacer, no qué cuenta existe. `email_taken`
 * es el único que revela algo, y es inevitable — es exactamente la información que el
 * usuario necesita para saber que debe entrar con su contraseña.
 */
export type OAuthError =
  | 'invalid_state'
  | 'provider_error'
  | 'email_taken'
  | 'account_not_found'
  | 'already_linked'
  | 'identity_taken'
  | 'account_blocked'
  | 'not_configured'
  /** El proveedor no confirma que el correo pertenezca a quien está entrando. */
  | 'email_unverified';

export class OAuthFlowError extends Error {
  readonly code: OAuthError;
  constructor(code: OAuthError) {
    super(code);
    this.code = code;
  }
}

/** Ticket de un solo uso que el frontend canjea por la sesión real. */
async function issueTicket(flowId: number, userId: number): Promise<string> {
  const ticket = base64Url(crypto.randomBytes(32));
  await flows.attachTicket({
    id: flowId,
    ticketHash: hashTicket(ticket),
    userId,
    ttlSeconds: env.oauth.ticketTtlSeconds,
  });
  return ticket;
}

/**
 * Resuelve el callback del proveedor y devuelve el ticket.
 *
 * El `state` se consume ANTES que ninguna otra cosa, con un UPDATE condicional: de dos
 * callbacks simultáneos con el mismo `state`, solo uno lo gana y el otro recibe
 * `invalid_state`. El perdedor ni siquiera llega a hablar con el proveedor.
 */
export async function handleCallback(
  provider: OAuthProvider,
  code: string | undefined,
  state: string | undefined,
): Promise<string> {
  if (!state || !code) throw new OAuthFlowError('invalid_state');

  const flow = await flows.consumeState(hashState(state));
  if (!flow) throw new OAuthFlowError('invalid_state');
  // El `state` pertenece al proveedor que lo emitió: no vale para cerrar otro flujo.
  if (flow.provider !== provider) throw new OAuthFlowError('invalid_state');

  let identity;
  try {
    // Verificador y `nonce` se rederivan del `state`: no hacía falta guardarlos, y por eso
    // este paso funciona igual en una instancia que no atendió el `/start`.
    const idToken = await exchangeCode(provider, code, deriveCodeVerifier(state));
    identity = await verifyIdToken(provider, idToken, deriveNonce(state));
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 503) throw new OAuthFlowError('not_configured');
    throw new OAuthFlowError('provider_error');
  }

  const userId = flow.mode === 'LINK'
    ? await resolveLink(flow.user_id, identity.provider, identity.subject)
    : await resolveLogin(flow.scope, identity.provider, identity.subject, identity);

  return issueTicket(flow.id, userId);
}

/** Estados que no pueden abrir sesión, traducidos al código de error del flujo. */
function assertCanSignIn(account: OAuthAccount): void {
  try {
    assertAccountCanSignIn(account.status);
  } catch {
    throw new OAuthFlowError('account_blocked');
  }
}

async function resolveLogin(
  scope: OAuthScope,
  provider: OAuthProvider,
  subject: string,
  identity: { email: string; firstName: string; lastName: string; emailVerified: boolean },
): Promise<number> {
  // CASO B — la identidad ya está vinculada: es el camino normal de vuelta.
  const linked = await findByOAuthIdentity(provider, subject);
  if (linked) {
    assertCanSignIn(linked);
    return linked.id;
  }

  // CASO C — el correo existe pero con otra forma de entrar. No se fusiona nada.
  const byEmail = await findByEmailForOAuth(identity.email);
  if (byEmail) throw new OAuthFlowError('email_taken');

  // CASO A — correo desconocido. Solo el flujo de cliente da de alta.
  if (scope !== 'CUSTOMER') throw new OAuthFlowError('account_not_found');

  /**
   * Y solo si el proveedor CONFIRMA que ese correo es de quien está entrando.
   *
   * El alta es el único punto del flujo que se apoya en el correo: crea una cuenta nueva
   * con esa dirección como identidad. Sin verificación, quien pudiera hacerse pasar por un
   * correo ajeno ante el proveedor se quedaría con esa dirección en BusPerú, y su dueño
   * legítimo chocaría después contra el caso C —«ese correo ya existe»— sin poder entrar.
   *
   * El resto de caminos no necesita esta comprobación y no la lleva: el CASO B entra por
   * una identidad ya vinculada, no por el correo, y el CASO C sigue rechazando la fusión
   * automática con una cuenta existente, verificado o no.
   */
  if (!identity.emailVerified) throw new OAuthFlowError('email_unverified');

  const roleId = await roleIdByName('CUSTOMER');
  // Contraseña imposible de adivinar y que nadie conoce: la cuenta entra por OAuth. Si su
  // dueño quiere una contraseña, la establece por el flujo de recuperación (§3), que exige
  // demostrar la posesión del correo.
  const passwordHash = await hashPassword(base64Url(crypto.randomBytes(32)));

  try {
    return await createOAuthUser({
      roleId,
      firstName: identity.firstName,
      lastName: identity.lastName,
      email: identity.email,
      provider,
      oauthId: subject,
      passwordHash,
      emailVerified: identity.emailVerified,
    });
  } catch {
    // Carrera contra otro alta simultánea con el mismo correo o la misma identidad: la
    // clave única de la base decide, y aquí se traduce a un conflicto limpio.
    throw new OAuthFlowError('email_taken');
  }
}

async function resolveLink(userId: number | null, provider: OAuthProvider, subject: string): Promise<number> {
  if (userId === null) throw new OAuthFlowError('invalid_state');

  const account = await findOAuthLink(userId);
  if (!account) throw new OAuthFlowError('invalid_state');
  assertCanSignIn(account);

  // CASO D — la cuenta ya tiene un proveedor. El esquema de §2 guarda uno solo por usuario.
  if (account.oauth_provider) {
    // Vincular lo mismo dos veces no es un error: el resultado ya es el deseado.
    if (account.oauth_provider === provider && account.oauth_id === subject) return userId;
    throw new OAuthFlowError('already_linked');
  }

  // CASO E — esa identidad ya pertenece a otra cuenta.
  const owner = await findByOAuthIdentity(provider, subject);
  if (owner && owner.id !== userId) throw new OAuthFlowError('identity_taken');

  const affected = await linkOAuthIdentity(userId, provider, subject);
  if (affected === 0) throw new OAuthFlowError('already_linked');

  return userId;
}

/**
 * Canjea el ticket por el identificador del usuario. Un solo uso.
 *
 * Igual que el `state`: UPDATE condicional, así que de dos canjes simultáneos del mismo
 * ticket solo uno obtiene la sesión.
 */
export async function consumeTicket(ticket: string): Promise<number> {
  const userId = await flows.consumeTicket(hashTicket(ticket));
  if (userId === null) {
    throw ApiError.unauthorized('El enlace de acceso ha caducado. Vuelve a iniciar sesión.');
  }
  return userId;
}

/** Vinculación actual de una cuenta, para pintarla en el perfil. */
export async function currentLink(userId: number): Promise<{ provider: OAuthProvider | null }> {
  const account = await findOAuthLink(userId);
  return { provider: (account?.oauth_provider as OAuthProvider | null) ?? null };
}

/**
 * Desvincula el proveedor de la cuenta autenticada.
 *
 * No se comprueba que exista contraseña utilizable porque una cuenta creada por OAuth
 * siempre conserva su correo, y con él puede recuperar el acceso por el flujo de §3. Aun
 * así se avisa en la interfaz de que quedará entrando solo con contraseña.
 */
export async function unlink(userId: number): Promise<void> {
  const affected = await unlinkOAuthIdentity(userId);
  if (affected === 0) throw ApiError.badRequest('Tu cuenta no tiene ningún proveedor vinculado');
}
