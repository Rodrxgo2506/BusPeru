import '../helpers/testEnv';
import type { AddressInfo } from 'net';
import { createApp } from '../../app';
import { execute, pool, query, queryOne } from '../../config/database';
import { env } from '../../config/env';
import { TEST_DATABASE } from './testEnv';
import { startFakeProvider } from './oauthProvider';

/**
 * Sonda de seguridad de OAuth, ejecutable a mano contra la API de PRUEBAS.
 *
 *   npx tsx src/test/helpers/oauthProbe.ts
 *
 * Complementa a `17-oauth.test.ts`: en vez de aserciones, imprime un informe de cada
 * intento de abuso y su resultado, para poder leerlo de un vistazo.
 *
 * Se niega a arrancar si la base no termina en `_test`.
 */

let fallos = 0;

function check(descripcion: string, ok: boolean, detalle = ''): void {
  console.log(`  ${ok ? '✔' : '✖'} ${descripcion}${detalle ? ` — ${detalle}` : ''}`);
  if (!ok) fallos += 1;
}

async function main(): Promise<void> {
  if (!TEST_DATABASE.endsWith('_test') || env.db.name !== TEST_DATABASE) {
    throw new Error(`ABORTADO: la sonda solo corre contra la base de pruebas, y se obtuvo "${env.db.name}"`);
  }

  const provider = await startFakeProvider({ clientId: 'probe-client', clientSecret: 'probe-secreto' });
  env.oauth.google.clientId = provider.clientId;
  env.oauth.google.clientSecret = provider.clientSecret;
  env.oauth.google.issuer = provider.issuer;
  env.oauth.google.authorizationUrl = `${provider.url}/authorize`;
  env.oauth.google.tokenUrl = `${provider.url}/token`;
  env.oauth.google.jwksUri = `${provider.url}/jwks`;

  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  console.log(`\n▶ Sonda de seguridad OAuth sobre "${env.db.name}"\n`);

  /** Arranca el flujo y devuelve state y nonce. */
  async function start(scope = 'CUSTOMER') {
    const response = await fetch(`${base}/auth/oauth/google/start?scope=${scope}`, { redirect: 'manual' });
    const url = new URL(response.headers.get('location')!);
    return { state: url.searchParams.get('state')!, nonce: url.searchParams.get('nonce')! };
  }

  /** Canjea un ticket por la sesión. */
  async function canjear(ticket: string) {
    const response = await fetch(`${base}/auth/oauth/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }),
    });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as any };
  }

  async function callback(state: string, code = 'codigo') {
    const response = await fetch(
      `${base}/auth/oauth/google/callback?code=${code}&state=${encodeURIComponent(state)}`,
      { redirect: 'manual' },
    );
    const url = new URL(response.headers.get('location')!);
    return { ticket: url.searchParams.get('ticket'), error: url.searchParams.get('error') };
  }

  try {
    await execute('DELETE FROM oauth_flows');

    console.log('▶ Manipulación de identidad');

    // 1. Identidad inventada en el cuerpo: el endpoint de sesión no acepta identidades.
    const inventada = await fetch(`${base}/auth/oauth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.pe', user_id: 1, role: 'ADMIN', sub: 'lo-que-sea' }),
    });
    check('no se puede abrir sesión enviando una identidad', inventada.status === 422, `HTTP ${inventada.status}`);

    // 2. Token firmado por un tercero.
    const flujo = await start();
    provider.nextIdToken = provider.sign(
      { sub: 'atacante', email: 'atacante@probe.test', nonce: flujo.nonce },
      { wrongKey: true },
    );
    const firmaFalsa = await callback(flujo.state);
    check('una firma que no es del proveedor se rechaza', firmaFalsa.error === 'provider_error', firmaFalsa.error ?? '');

    // 3. Confusión de algoritmo.
    const flujoHs = await start();
    provider.nextIdToken = provider.sign(
      { sub: 'atacante', email: 'atacante@probe.test', nonce: flujoHs.nonce },
      { algorithm: 'HS256' },
    );
    const hs = await callback(flujoHs.state);
    check('HS256 firmado con el client_id se rechaza', hs.error === 'provider_error', hs.error ?? '');

    // 4. Token de otra aplicación (audiencia distinta).
    const flujoAud = await start();
    provider.nextIdToken = provider.sign({
      sub: 'atacante', email: 'atacante@probe.test', nonce: flujoAud.nonce, aud: 'otra-app',
    });
    const aud = await callback(flujoAud.state);
    check('un token emitido para otra aplicación se rechaza', aud.error === 'provider_error', aud.error ?? '');

    // 5. Reutilización de un id_token de otro flujo (nonce ajeno).
    const flujoNonce = await start();
    provider.nextIdToken = provider.sign({ sub: 'atacante', email: 'atacante@probe.test', nonce: 'nonce-ajeno' });
    const nonce = await callback(flujoNonce.state);
    check('un id_token de otra sesión no se reutiliza', nonce.error === 'provider_error', nonce.error ?? '');

    console.log('\n▶ Apropiación de cuentas');

    // 6. Correo de un administrador existente.
    const flujoAdmin = await start();
    provider.nextClaims = { sub: 'sub-atacante', email: 'admin@test.pe', email_verified: true, nonce: flujoAdmin.nonce };
    const apropiacion = await callback(flujoAdmin.state);
    const admin = await queryOne<{ oauth_id: string | null }>('SELECT oauth_id FROM users WHERE email = ?', ['admin@test.pe']);
    check('no se puede tomar la cuenta de un ADMIN por su correo', apropiacion.error === 'email_taken', apropiacion.error ?? '');
    check('la cuenta del ADMIN sigue sin proveedor vinculado', admin?.oauth_id === null);

    // 7. Alta encubierta desde el portal de administración.
    const flujoAlta = await start('ADMIN');
    provider.nextClaims = { sub: 'sub-alta-admin', email: 'nuevo.admin@probe.test', nonce: flujoAlta.nonce };
    const alta = await callback(flujoAlta.state);
    const creado = await queryOne<{ id: number }>('SELECT id FROM users WHERE email = ?', ['nuevo.admin@probe.test']);
    check('el portal de administración no da de alta', alta.error === 'account_not_found', alta.error ?? '');
    check('no se creó ninguna cuenta', creado === null);

    console.log('\n▶ state, ticket y repetición');

    // 8. state inventado.
    const inventado = await callback('state-que-no-existe');
    check('un state inventado no abre sesión', inventado.error === 'invalid_state', inventado.error ?? '');

    // 9. Repetición del callback.
    const flujoOk = await start();
    provider.nextClaims = { sub: 'sub-probe', email: 'probe@probe.test', nonce: flujoOk.nonce };
    const primera = await callback(flujoOk.state);
    const repetida = await callback(flujoOk.state);
    check('el primer callback entrega ticket', primera.ticket !== null);
    check('repetir el callback no entrega otro', repetida.error === 'invalid_state', repetida.error ?? '');

    // 10. Reutilización del ticket.
    const sesion = await canjear(primera.ticket!);
    const repetido = await canjear(primera.ticket!);
    check('el ticket abre sesión una vez', sesion.status === 200);
    check('el ticket no se puede canjear dos veces', repetido.status === 401, `HTTP ${repetido.status}`);

    // 11. Ticket inventado / inyección.
    for (const ticket of ["' OR 1=1 --", 'a'.repeat(64), '../../etc/passwd']) {
      const intento = await canjear(ticket);
      check(`un ticket manipulado no abre sesión (${ticket.slice(0, 18)}…)`, intento.status === 401, `HTTP ${intento.status}`);
    }

    console.log('\n▶ Privilegios de la sesión emitida');

    const token = sesion.body.data?.token as string;
    const usuario = sesion.body.data?.user;
    check('la sesión es del rol CUSTOMER', usuario?.role === 'CUSTOMER', usuario?.role ?? '');
    check('la sesión no pertenece a ninguna empresa', Array.isArray(usuario?.companyIds) && usuario.companyIds.length === 0);

    async function conToken(path: string) {
      const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      return response.status;
    }
    check('no accede al Portal Empresa', (await conToken('/company/documents')) === 403);
    check('no accede a las cuentas bancarias', (await conToken('/company/bank-accounts')) === 403);
    check('no puede crear usuarios', (await (async () => {
      const response = await fetch(`${base}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ first_name: 'X', last_name: 'Y', email: 'x@probe.test', password: 'PruebaSegura1', role_id: 1 }),
      });
      return response.status;
    })()) === 403);

    console.log('\n▶ Vinculación');

    // 12. Vinculación sin sesión.
    const sinSesion = await fetch(`${base}/auth/oauth/google/link`, { method: 'POST' });
    check('no se puede iniciar una vinculación sin sesión', sinSesion.status === 401, `HTTP ${sinSesion.status}`);

    // 13. Vinculación apuntando a otra cuenta. Se usa una cuenta de contraseña SIN proveedor
    //     (la sesión anterior ya tiene uno, y una cuenta solo admite uno).
    const conPassword = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'cliente@test.pe', password: 'PruebaSegura1' }),
    });
    const sesionPassword = (await conPassword.json()) as any;
    const tokenCliente = sesionPassword.data.token as string;
    const idCliente = sesionPassword.data.user.id as number;

    const conCuerpo = await fetch(`${base}/auth/oauth/google/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenCliente}` },
      body: JSON.stringify({ user_id: 1, email: 'admin@test.pe' }),
    });
    const cuerpo = (await conCuerpo.json()) as any;
    const urlVinculo = new URL(cuerpo.data.url);
    provider.nextClaims = {
      sub: 'sub-vinculo-probe', email: 'cliente@test.pe', nonce: urlVinculo.searchParams.get('nonce')!,
    };
    await callback(urlVinculo.searchParams.get('state')!);

    const adminTrasVinculo = await queryOne<{ oauth_id: string | null }>('SELECT oauth_id FROM users WHERE id = 1');
    const propio = await queryOne<{ oauth_id: string | null }>('SELECT oauth_id FROM users WHERE id = ?', [idCliente]);
    check('el user_id del cuerpo se ignora', adminTrasVinculo?.oauth_id !== 'sub-vinculo-probe');
    check('se vincula la cuenta de la sesión, no la del cuerpo', propio?.oauth_id === 'sub-vinculo-probe');

    // 14. Desvincular sin sesión.
    const desvincular = await fetch(`${base}/auth/oauth/link`, { method: 'DELETE' });
    check('no se puede desvincular sin sesión', desvincular.status === 401, `HTTP ${desvincular.status}`);

    console.log('\n▶ Replay y consumo concurrente');

    // 15. Replay de state: dos callbacks EN PARALELO con el mismo state.
    const flujoConcurrente = await start();
    provider.nextClaims = {
      sub: 'sub-concurrente', email: 'concurrente@probe.test', nonce: flujoConcurrente.nonce,
    };
    const [a, b] = await Promise.all([callback(flujoConcurrente.state), callback(flujoConcurrente.state)]);
    const ticketsEmitidos = [a.ticket, b.ticket].filter(Boolean);
    check('dos callbacks simultáneos: solo uno obtiene ticket', ticketsEmitidos.length === 1, `${ticketsEmitidos.length} tickets`);
    check('el otro recibe invalid_state', [a.error, b.error].filter((e) => e === 'invalid_state').length === 1);

    const cuentasCreadas = await query('SELECT id FROM users WHERE oauth_id = ?', ['sub-concurrente']);
    check('la carrera no duplicó la cuenta', cuentasCreadas.length === 1, `${cuentasCreadas.length} cuentas`);

    // 16. Replay de state en serie, después de un consumo válido.
    const replay = await callback(flujoConcurrente.state);
    check('reproducir el state más tarde tampoco vale', replay.error === 'invalid_state', replay.error ?? '');

    // 17. Replay de ticket: dos canjes EN PARALELO.
    const ticketConcurrente = ticketsEmitidos[0]!;
    const [c, d] = await Promise.all([canjear(ticketConcurrente), canjear(ticketConcurrente)]);
    check('dos canjes simultáneos: solo uno obtiene JWT', [c.status, d.status].filter((s) => s === 200).length === 1);
    check('el otro canje se rechaza', [c.status, d.status].filter((s) => s === 401).length === 1);

    console.log('\n▶ Manipulación del estado persistido');

    // 18. State alterado en un carácter.
    const flujoIntacto = await start();
    provider.nextClaims = { sub: 'sub-intacto', email: 'intacto@probe.test', nonce: flujoIntacto.nonce };
    const alterado = `${flujoIntacto.state.slice(0, -1)}${flujoIntacto.state.endsWith('A') ? 'B' : 'A'}`;
    const conAlterado = await callback(alterado);
    check('un state alterado no encuentra flujo', conAlterado.error === 'invalid_state', conAlterado.error ?? '');
    const legitimo = await callback(flujoIntacto.state);
    check('y no invalida el flujo legítimo', legitimo.ticket !== null);

    // 19. El state en claro no está en la base.
    const flujoVivo = await start();
    const filas = await query<{ state_hash: string }>('SELECT state_hash FROM oauth_flows WHERE state_used_at IS NULL');
    const enClaro = filas.some((fila) => JSON.stringify(fila).includes(flujoVivo.state));
    check('el state nunca se guarda en claro', !enClaro);
    check('se guarda como sha256', filas.every((fila) => /^[0-9a-f]{64}$/.test(fila.state_hash)));

    // 20. Ticket de otro flujo: no sirve para una sesión ajena.
    const flujoUno = await start();
    provider.nextClaims = { sub: 'sub-uno', email: 'uno@probe.test', nonce: flujoUno.nonce };
    const resultadoUno = await callback(flujoUno.state);
    const flujoDos = await start();
    provider.nextClaims = { sub: 'sub-dos', email: 'dos@probe.test', nonce: flujoDos.nonce };
    await callback(flujoDos.state);

    const sesionUno = await canjear(resultadoUno.ticket!);
    check(
      'el ticket abre la sesión de SU flujo, no la de otro',
      sesionUno.body?.data?.user?.email === 'uno@probe.test',
      sesionUno.body?.data?.user?.email ?? '',
    );

    console.log('\n▶ Aislamiento del modo LINK');

    // 21. Un state de LINK pertenece a un usuario concreto: no se puede desviar.
    const sesionCliente = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'operador-a@test.pe', password: 'PruebaSegura1' }),
    });
    const datosOperador = (await sesionCliente.json()) as any;
    const tokenOperador = datosOperador.data.token as string;
    const idOperador = datosOperador.data.user.id as number;

    const inicioLink = await fetch(`${base}/auth/oauth/google/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenOperador}` },
      body: JSON.stringify({}),
    });
    const cuerpoLink = (await inicioLink.json()) as any;
    const urlLink = new URL(cuerpoLink.data.url);
    const stateLink = urlLink.searchParams.get('state')!;

    const filaLink = await queryOne<{ mode: string; user_id: number }>(
      'SELECT mode, user_id FROM oauth_flows WHERE state_used_at IS NULL ORDER BY id DESC LIMIT 1',
    );
    check('el flujo LINK guarda el usuario en la base', Number(filaLink?.user_id) === idOperador && filaLink?.mode === 'LINK');

    // Otro usuario intenta cerrar ese mismo state: la vinculación va al dueño del state,
    // nunca a quien llama al callback (que además no lleva sesión alguna).
    provider.nextClaims = { sub: 'sub-desvio', email: 'operador-a@test.pe', nonce: urlLink.searchParams.get('nonce')! };
    await callback(stateLink);

    const operadorTras = await queryOne<{ oauth_id: string | null }>('SELECT oauth_id FROM users WHERE id = ?', [idOperador]);
    const adminTras = await queryOne<{ oauth_id: string | null }>('SELECT oauth_id FROM users WHERE id = 1');
    check('el state de LINK vincula solo a su dueño', operadorTras?.oauth_id === 'sub-desvio');
    check('ninguna otra cuenta resulta vinculada', adminTras?.oauth_id !== 'sub-desvio');

    console.log('\n▶ Superficie');

    const proveedores = await fetch(`${base}/auth/oauth/providers`);
    const listado = await proveedores.text();
    check('el listado de proveedores no filtra secretos', !listado.includes('probe-secreto'));

    const arranque = await fetch(`${base}/auth/oauth/google/start?scope=CUSTOMER`, { redirect: 'manual' });
    check('el secreto no viaja en la redirección', !(arranque.headers.get('location') ?? '').includes('probe-secreto'));

    const desconocido = await fetch(`${base}/auth/oauth/facebook/start`, { redirect: 'manual' });
    check('un proveedor desconocido devuelve 404', desconocido.status === 404, `HTTP ${desconocido.status}`);
  } finally {
    // Limpieza de todo lo que la sonda haya creado.
    await execute("DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@probe.test')");
    await execute("DELETE FROM users WHERE email LIKE '%@probe.test'");
    await execute('UPDATE users SET oauth_provider = NULL, oauth_id = NULL');
    await execute('DELETE FROM oauth_flows');

    const restos = await query("SELECT id FROM users WHERE email LIKE '%@probe.test'");
    const flujos = await query('SELECT id FROM oauth_flows');
    check('la sonda no deja datos', restos.length === 0 && flujos.length === 0);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await provider.stop();
    await pool.end().catch(() => undefined);
  }

  console.log(`\n${fallos === 0 ? '✔ Todas las comprobaciones de seguridad pasaron.' : `✖ ${fallos} comprobaciones fallaron.`}`);
  process.exit(fallos === 0 ? 0 : 1);
}

void main().catch((error) => {
  console.error('\n✖ Error inesperado:', error);
  process.exit(1);
});
