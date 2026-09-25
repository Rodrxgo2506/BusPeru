// BusPerú · F18-03 · pruebas de humo contra un entorno de STAGING.
//
//   API_BASE_URL=https://API_DOMAIN/api FRONTEND_ORIGIN=https://FRONTEND_DOMAIN \
//   ADMIN_EMAIL=admin@… ADMIN_PASSWORD_FILE=/ruta/admin.pw \
//     node infra/aws/scripts/smoke-staging.mjs
//
// Recorre el camino real de la aplicación creando SUS PROPIOS datos sintéticos por la API (el seed
// del repositorio solo funciona sobre bases *_test, así que no sirve para staging). No usa datos de
// clientes, no cobra nada —Culqi nunca se llama— y no imprime tokens ni contraseñas.
//
// F18-09 · al terminar RETIRA lo que creó por la API (logotipo y su archivo, llave de API, integración
// CULQI de plataforma si la creó él, empresa a INACTIVE para que desaparezca de la portada y la
// búsqueda) y escribe un MANIFIESTO con los ids creados (QA_MANIFEST, por defecto
// ./qa-manifest-smoke-<marca>.json). La purga física de esos ids la hace purge-qa-data.cjs en la EC2
// (qa-staging.sh encadena las dos cosas). Si ya había una integración CULQI de plataforma, NO la toca.
//
// Cada comprobación sale como PASS/FAIL con el motivo. Código de salida 1 si algo falla.
import fs from 'node:fs';

const API = (process.env.API_BASE_URL || '').replace(/\/+$/, '');
const ORIGEN = process.env.FRONTEND_ORIGIN || '';
const ADMIN = process.env.ADMIN_EMAIL || '';
const CLAVE_ADMIN = fs.readFileSync(process.env.ADMIN_PASSWORD_FILE || '', 'utf8').replace(/[\r\n]+$/, '');
if (!API || !ORIGEN || !ADMIN) throw new Error('faltan API_BASE_URL, FRONTEND_ORIGIN, ADMIN_EMAIL o ADMIN_PASSWORD_FILE');

const marca = Date.now().toString(36);
const SECRETOS = [CLAVE_ADMIN];
const limpiar = (t) => SECRETOS.reduce((s, x) => (x ? s.split(x).join('***') : s), String(t ?? ''));

const resultados = [];
let grupoActual = '';
const grupo = (n) => { grupoActual = n; };
async function check(nombre, fn) {
  try {
    const detalle = await fn();
    resultados.push({ grupo: grupoActual, nombre, ok: true, detalle: limpiar(detalle ?? '') });
  } catch (e) {
    resultados.push({ grupo: grupoActual, nombre, ok: false, detalle: limpiar(e.message) });
  }
}
const assert = (cond, mensaje) => { if (!cond) throw new Error(mensaje); };

async function pedir(metodo, ruta, { token, cuerpo, origen, cabeceras = {}, form } = {}) {
  const h = { ...cabeceras };
  if (token) h.Authorization = `Bearer ${token}`;
  if (origen) h.Origin = origen;
  let body;
  if (form) body = form;
  else if (cuerpo !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(cuerpo); }
  const r = await fetch(`${API}${ruta}`, { method: metodo, headers: h, body, redirect: 'manual' });
  const texto = await r.text();
  let json = null;
  try { json = JSON.parse(texto); } catch { /* no todas las respuestas son JSON */ }
  return { estado: r.status, cabeceras: r.headers, texto, json, datos: json?.data };
}
const exige = (r, esperado, que) => {
  assert(r.estado === esperado, `${que}: se esperaba ${esperado} y llegó ${r.estado} ${limpiar(r.texto).slice(0, 160)}`);
  return r;
};

// ---------------------------------------------------------------- disponibilidad
grupo('Disponibilidad');
await check('GET /api/health responde 200 (liveness)', async () => {
  const r = exige(await pedir('GET', '/health'), 200, 'health');
  assert(r.datos?.status === 'ok', 'el cuerpo no trae status ok');
  return 'status ok';
});
await check('GET /api/ready responde 200 y no filtra nada', async () => {
  const r = exige(await pedir('GET', '/ready'), 200, 'ready');
  assert(r.json?.status === 'ready', `cuerpo inesperado: ${r.texto.slice(0, 80)}`);
  assert(Object.keys(r.json).length === 1, `el cuerpo trae más campos de la cuenta: ${Object.keys(r.json)}`);
  assert((r.cabeceras.get('cache-control') || '').includes('no-store'), 'falta Cache-Control: no-store');
  assert(!/mysql|mariadb|ECONNREFUSED|\/data|password|busperu_/i.test(r.texto), 'el cuerpo filtra detalles internos');
  return 'ready · sin detalles internos';
});

// -------------------------------------------------------------------- cabeceras
grupo('Cabeceras y CORS');
await check('cabeceras de seguridad (Helmet) y sin X-Powered-By', async () => {
  const r = await pedir('GET', '/health');
  assert(r.cabeceras.get('x-content-type-options') === 'nosniff', 'falta X-Content-Type-Options: nosniff');
  assert(!r.cabeceras.get('x-powered-by'), 'la API anuncia X-Powered-By');
  const marco = r.cabeceras.get('x-frame-options') || r.cabeceras.get('content-security-policy') || '';
  assert(marco, 'no hay X-Frame-Options ni CSP');
  const hsts = r.cabeceras.get('strict-transport-security');
  return `nosniff · ${marco.slice(0, 40)}${hsts ? ` · HSTS presente` : ' · HSTS: solo con HTTPS'}`;
});
await check('CORS: el origen del frontend se refleja tal cual (nunca *)', async () => {
  const r = await pedir('GET', '/health', { origen: ORIGEN });
  const permitido = r.cabeceras.get('access-control-allow-origin');
  assert(permitido === ORIGEN, `Access-Control-Allow-Origin = ${permitido}`);
  assert(permitido !== '*', 'CORS con comodín');
  return permitido;
});
await check('CORS: a un origen ajeno NUNCA se le devuelve su propio origen', async () => {
  const ajeno = 'https://sitio-que-no-es-el-frontend.example';
  const r = await pedir('GET', '/health', { origen: ajeno });
  const permitido = r.cabeceras.get('access-control-allow-origin');
  // La API publica un origen FIJO (el del frontend). Lo que no puede hacer nunca es reflejar el
  // origen que le llegue ni responder con comodín: eso daría acceso a cualquier sitio.
  assert(permitido !== ajeno, 'la API refleja el origen del atacante');
  assert(permitido !== '*', 'CORS con comodín');
  return permitido ? `origen fijo ${permitido}` : 'sin Access-Control-Allow-Origin';
});
await check('sin Origin (webhook o cliente no navegador) la API responde igual', async () => {
  const r = exige(await pedir('GET', '/health'), 200, 'health sin Origin');
  const permitido = r.cabeceras.get('access-control-allow-origin');
  assert(permitido !== '*', 'CORS con comodín');
  return `200 · Access-Control-Allow-Origin: ${permitido ?? 'ausente'}`;
});
await check('el webhook de Culqi rechaza un secreto inválido sin cobrar nada', async () => {
  // La ruta lleva el secreto en el camino: con uno inválido debe fallar, nunca dar 404 ni 5xx.
  const r = await pedir('POST', '/culqi/webhook/secreto-invalido-de-prueba', { cuerpo: { prueba: true } });
  assert(r.estado >= 400 && r.estado < 500, `estado ${r.estado}`);
  assert(!/culqi_|sk_|secret/i.test(r.texto), 'la respuesta filtra información del secreto');
  return `${r.estado} sin filtrar el secreto`;
});
await check('el limitador de peticiones está activo', async () => {
  const r = await pedir('GET', '/health');
  const nombres = [...r.cabeceras.keys()].filter((k) => /ratelimit/i.test(k));
  assert(nombres.length > 0, 'no hay cabeceras RateLimit');
  return nombres.join(', ');
});

// ------------------------------------------------------------------------ auth
grupo('Autenticación y RBAC');
let tokenAdmin = '';
await check('login del administrador', async () => {
  const r = exige(await pedir('POST', '/auth/login', { cuerpo: { email: ADMIN, password: CLAVE_ADMIN }, origen: ORIGEN }), 200, 'login');
  tokenAdmin = r.datos?.token;
  assert(tokenAdmin, 'la respuesta no trae token');
  SECRETOS.push(tokenAdmin);
  return `rol ${r.datos?.user?.role}`;
});
await check('GET /auth/me devuelve el administrador', async () => {
  const r = exige(await pedir('GET', '/auth/me', { token: tokenAdmin }), 200, 'me');
  assert(r.datos?.role === 'ADMIN', `rol ${r.datos?.role}`);
  return r.datos.role;
});
await check('una contraseña incorrecta se rechaza con 401', async () => {
  const r = await pedir('POST', '/auth/login', { cuerpo: { email: ADMIN, password: 'contrasena-incorrecta-de-prueba' } });
  assert(r.estado === 401, `estado ${r.estado}`);
  assert(!/hash|sql|stack/i.test(r.texto), 'el error filtra detalles internos');
  return '401';
});
await check('sin token, /users responde 401', async () => (await pedir('GET', '/users')).estado === 401 ? '401' : (() => { throw new Error('no exige autenticación'); })());

// ------------------------------------------------------------- datos sintéticos
grupo('Datos sintéticos (creados por la API)');
const creado = {};
const crear = async (ruta, cuerpo, etiqueta) => {
  const r = exige(await pedir('POST', ruta, { token: tokenAdmin, cuerpo }), 201, `crear ${etiqueta}`);
  const id = r.datos?.id ?? r.datos?.[0]?.id;
  assert(id, `crear ${etiqueta}: la respuesta no trae id`);
  return id;
};
await check('roles disponibles', async () => {
  const r = exige(await pedir('GET', '/roles?limit=50', { token: tokenAdmin }), 200, 'roles');
  for (const rol of r.datos) creado[`rol_${rol.name}`] = rol.id;
  assert(creado.rol_CUSTOMER && creado.rol_COMPANY_ADMIN, 'faltan roles CUSTOMER o COMPANY_ADMIN');
  return `${r.datos.length} roles`;
});
await check('la comisión por defecto de la plataforma está configurada', async () => {
  // F18-03B: este script NO la crea. Una base recién instalada no la trae y la API se niega a dar
  // de alta empresas sin ella; su valor es una decisión de negocio que se aplica en el bootstrap con
  // set-platform-commission.mjs (runbook §8). Aquí solo se comprueba que ese paso se hizo.
  const lista = exige(await pedir('GET', '/system-settings?search=platform.default_commission', { token: tokenAdmin }), 200, 'ajustes');
  const filas = Array.isArray(lista.datos) ? lista.datos : lista.datos?.items ?? [];
  const actual = filas.find((f) => f.setting_key === 'platform.default_commission');
  assert(actual, 'falta platform.default_commission: ejecutar set-platform-commission.mjs con el valor decidido (runbook §8)');
  assert(/^\d{1,3}(\.\d{1,2})?$/.test(actual.setting_value) && Number(actual.setting_value) <= 100, `valor no válido: ${actual.setting_value}`);
  creado.ajusteComision = actual.id;
  return `configurada: ${actual.setting_value} %`;
});
await check('empresa, catálogos y bus', async () => {
  creado.empresa = await crear('/companies', { name: `Empresa Humo ${marca}`, legal_name: `Empresa Humo ${marca} SAC`, tax_id: `20${String(Date.now()).slice(-9)}`, email: `empresa.${marca}@busperu-staging.example`, status: 'ACTIVE' }, 'empresa');
  creado.tipoBus = await crear('/bus-types', { name: `Tipo ${marca}`, default_capacity: 40 }, 'tipo de bus');
  creado.tipoAsiento = await crear('/seat-types', { name: `Asiento ${marca}` }, 'tipo de asiento');
  creado.bus = await crear('/buses', { company_id: creado.empresa, bus_type_id: creado.tipoBus, code: `H-${marca}`, plate_number: `HUM-${String(marca).slice(-3).toUpperCase()}`, capacity: 12, status: 'ACTIVE' }, 'bus');
  return `empresa ${creado.empresa} · bus ${creado.bus}`;
});
await check('edición de la empresa (PUT)', async () => {
  exige(await pedir('PUT', `/companies/${creado.empresa}`, { token: tokenAdmin, cuerpo: { description: 'Empresa de pruebas de humo' } }), 200, 'editar empresa');
  const r = exige(await pedir('GET', `/companies/${creado.empresa}`, { token: tokenAdmin }), 200, 'leer empresa');
  assert(r.datos.description === 'Empresa de pruebas de humo', 'no guardó la descripción');
  return 'descripción actualizada';
});
await check('ubicaciones, ruta y viaje', async () => {
  creado.origen = await crear('/locations', { name: `Lima Humo ${marca}`, city: 'Lima', department: 'Lima', type: 'TERMINAL' }, 'origen');
  creado.destino = await crear('/locations', { name: `Cusco Humo ${marca}`, city: 'Cusco', department: 'Cusco', type: 'TERMINAL' }, 'destino');
  creado.ruta = await crear('/routes', { company_id: creado.empresa, origin_location_id: creado.origen, destination_location_id: creado.destino, name: `Ruta Humo ${marca}`, distance_km: 1100, estimated_duration_minutes: 1200 }, 'ruta');
  return `origen ${creado.origen} · destino ${creado.destino} · ruta ${creado.ruta}`;
});

// ---------------------------------------------------------------- distribución
grupo('Distribución física del bus (row_number)');
await check('borrador, piso, asientos y elemento', async () => {
  const b = exige(await pedir('POST', `/buses/${creado.bus}/layouts`, { token: tokenAdmin, cuerpo: { name: 'Humo v1', decks: [{ deck_number: 1, name: 'Piso 1', row_count: 4, column_count: 4 }] } }), 201, 'borrador');
  creado.layout = b.datos.id;
  const pisos = exige(await pedir('GET', `/layouts/${creado.layout}/decks`, { token: tokenAdmin }), 200, 'pisos');
  creado.piso = pisos.datos[0].id;
  for (let i = 1; i <= 4; i += 1) {
    exige(await pedir('POST', `/decks/${creado.piso}/seats`, { token: tokenAdmin, cuerpo: { seat_number: `0${i}`, row_number: 1, column_number: i, seat_type_id: creado.tipoAsiento } }), 201, `asiento ${i}`);
  }
  exige(await pedir('POST', `/decks/${creado.piso}/elements`, { token: tokenAdmin, cuerpo: { element_type: 'BATHROOM', row_number: 4, column_number: 4 } }), 201, 'elemento');
  const asientos = exige(await pedir('GET', `/decks/${creado.piso}/seats`, { token: tokenAdmin }), 200, 'listar asientos');
  assert(asientos.datos.length === 4 && asientos.datos.every((s) => typeof s.row_number === 'number'), 'row_number no llega como número');
  return `${asientos.datos.length} asientos con row_number`;
});
await check('publicación de la versión', async () => {
  const r = exige(await pedir('POST', `/layouts/${creado.layout}/publish`, { token: tokenAdmin }), 200, 'publicar');
  assert(r.datos.status === 'PUBLISHED', `estado ${r.datos.status}`);
  return 'PUBLISHED';
});
await check('el viaje se crea una vez el bus tiene versión publicada', async () => {
  const salida = new Date(Date.now() + 36 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  creado.viaje = await crear('/trips', { route_id: creado.ruta, bus_id: creado.bus, departure_datetime: salida, base_price: 80.5, available_seats: 4, status: 'SCHEDULED' }, 'viaje');
  return `viaje ${creado.viaje}`;
});
await check('la distribución se ve en el canal público del viaje', async () => {
  const r = exige(await pedir('GET', `/public/trips/${creado.viaje}/layout`), 200, 'layout público');
  const texto = JSON.stringify(r.datos);
  assert(/row_number/.test(texto), 'la respuesta pública no trae row_number');
  assert(!/plate_number/.test(texto), 'la respuesta pública filtra la placa');
  return 'layout público sin datos internos';
});

// --------------------------------------------------------------- viajes/reserva
grupo('Búsqueda y reserva');
await check('el viaje aparece en la búsqueda pública', async () => {
  const r = exige(await pedir('GET', `/public/trips?origin_id=${creado.origen}&destination_id=${creado.destino}`), 200, 'búsqueda');
  const lista = Array.isArray(r.datos) ? r.datos : r.datos?.items ?? [];
  assert(lista.some((t) => t.id === creado.viaje), `el viaje ${creado.viaje} no aparece (${lista.length} resultados)`);
  return `${lista.length} resultado(s)`;
});
let tokenCliente = '';
await check('alta de un cliente sintético y su inicio de sesión', async () => {
  const clave = `Humo-${marca}-9A`;
  SECRETOS.push(clave);
  creado.correoCliente = `cliente.${marca}@busperu-staging.example`;
  creado.cliente = await crear('/users', { role_id: creado.rol_CUSTOMER, first_name: 'Cliente', last_name: 'Humo', email: creado.correoCliente, password: clave, status: 'ACTIVE' }, 'cliente');
  const r = exige(await pedir('POST', '/auth/login', { cuerpo: { email: creado.correoCliente, password: clave } }), 200, 'login cliente');
  tokenCliente = r.datos.token; SECRETOS.push(tokenCliente);
  return `cliente ${creado.cliente}`;
});
await check('RBAC: el cliente solo se ve a sí mismo en /users', async () => {
  const r = exige(await pedir('GET', '/users', { token: tokenCliente }), 200, 'usuarios como cliente');
  const filas = Array.isArray(r.datos) ? r.datos : r.datos?.items ?? [];
  assert(filas.length === 1 && filas[0].id === creado.cliente, `el cliente ve ${filas.length} usuario(s)`);
  return 'solo su propia ficha';
});
await check('RBAC: las cifras de plataforma son solo del ADMIN', async () => {
  const cliente = await pedir('GET', '/users/stats', { token: tokenCliente });
  assert(cliente.estado === 403, `el cliente recibió ${cliente.estado}`);
  exige(await pedir('GET', '/users/stats', { token: tokenAdmin }), 200, 'stats como admin');
  return 'cliente 403 · admin 200';
});
await check('RBAC: solo el ADMIN puede escribir ajustes de plataforma', async () => {
  // COMPANY_ADMIN y OPERATOR de la empresa sintética, además del cliente ya creado.
  const tokens = { CUSTOMER: tokenCliente };
  for (const rol of ['COMPANY_ADMIN', 'OPERATOR']) {
    assert(creado[`rol_${rol}`], `no existe el rol ${rol}`);
    const clave = `Humo-${rol}-${marca}-9A`; SECRETOS.push(clave);
    const correo = `${rol.toLowerCase()}.${marca}@busperu-staging.example`;
    creado[`usuario_${rol}`] = await crear('/users', { role_id: creado[`rol_${rol}`], first_name: rol, last_name: 'Humo', email: correo, password: clave, status: 'ACTIVE', company_id: creado.empresa }, rol);
    const r = exige(await pedir('POST', '/auth/login', { cuerpo: { email: correo, password: clave } }), 200, `login ${rol}`);
    tokens[rol] = r.datos.token; SECRETOS.push(tokens[rol]);
  }
  const resumen = [];
  for (const [rol, token] of Object.entries(tokens)) {
    const cambiar = await pedir('PUT', `/system-settings/${creado.ajusteComision}`, { token, cuerpo: { setting_value: '99.99' } });
    const crearOtro = await pedir('POST', '/system-settings', { token, cuerpo: { setting_key: `humo.${marca}`, setting_value: '1', setting_type: 'INTEGER' } });
    assert(cambiar.estado === 403 && crearOtro.estado === 403, `${rol}: PUT ${cambiar.estado} · POST ${crearOtro.estado}`);
    resumen.push(`${rol} 403`);
  }
  const sigue = exige(await pedir('GET', `/system-settings/${creado.ajusteComision}`, { token: tokenAdmin }), 200, 'releer ajuste');
  assert(sigue.datos.setting_value !== '99.99', 'el valor cambió pese a los 403');
  for (const t of Object.values(tokens)) if (t !== tokenCliente) await pedir('POST', '/auth/logout', { token: t });
  return `${resumen.join(' · ')} · valor intacto`;
});
await check('reserva de un asiento y expiración prevista', async () => {
  const asientos = exige(await pedir('GET', `/public/trips/${creado.viaje}/seats`), 200, 'asientos del viaje');
  const lista = (Array.isArray(asientos.datos) ? asientos.datos : asientos.datos?.seats ?? []).filter((s) => s.status === 'AVAILABLE' || s.available);
  assert(lista.length > 0, 'no hay asientos disponibles');
  const r = exige(await pedir('POST', '/bookings', { token: tokenCliente, cuerpo: { trip_id: creado.viaje, seat_ids: [lista[0].id], passenger_email: creado.correoCliente } }), 201, 'reservar');
  creado.reserva = r.datos?.booking?.id ?? r.datos?.id;
  const estado = r.datos?.booking?.status ?? r.datos?.status;
  const expira = r.datos?.booking?.expires_at ?? r.datos?.expires_at;
  assert(creado.reserva && estado === 'PENDING', `reserva ${creado.reserva} en estado ${estado}`);
  assert(expira, 'la reserva no trae expires_at');
  return `reserva ${creado.reserva} · PENDING · expira ${expira}`;
});
await check('el cliente ve su reserva y puede cancelarla', async () => {
  exige(await pedir('GET', `/bookings/${creado.reserva}`, { token: tokenCliente }), 200, 'ver reserva');
  const r = exige(await pedir('POST', `/bookings/${creado.reserva}/cancel`, { token: tokenCliente, cuerpo: { reason: 'prueba de humo' } }), 200, 'cancelar');
  return `estado ${r.datos?.status ?? 'cancelada'}`;
});

// ----------------------------------------------------------------------- JSON
grupo('Columnas JSON (jsonStrings)');
await check('las llaves de API conservan sus permisos', async () => {
  const r = exige(await pedir('POST', '/api-keys', { token: tokenAdmin, cuerpo: { name: `Humo ${marca}`, company_id: creado.empresa, permissions: ['trips.view'] } }), 201, 'crear llave');
  if (r.datos?.key) SECRETOS.push(r.datos.key);
  creado.llave = r.datos?.api_key?.id ?? r.datos?.id;
  const lista = exige(await pedir('GET', '/api-keys', { token: tokenAdmin }), 200, 'listar llaves');
  const mia = (Array.isArray(lista.datos) ? lista.datos : lista.datos?.items ?? []).find((k) => k.id === creado.llave);
  assert(mia, 'la llave creada no aparece en el listado');
  const permisos = typeof mia.permissions === 'string' ? JSON.parse(mia.permissions) : mia.permissions;
  assert(Array.isArray(permisos) && permisos.includes('trips.view'), `permisos inesperados: ${JSON.stringify(mia.permissions)}`);
  return `permisos ${JSON.stringify(permisos)}`;
});
await check('las credenciales de una integración se guardan cifradas y se leen', async () => {
  // F18-09: si la plataforma ya tiene una integración CULQI (p. ej. claves de prueba reales), no se
  // sobrescribe: esta comprobación se omite. Si no la hay, se crea con claves FICTICIAS y se elimina al final.
  const previas = exige(await pedir('GET', '/admin/integrations', { token: tokenAdmin }), 200, 'listar integraciones');
  const existente = (previas.datos?.integrations ?? []).find((i) => i.provider === 'CULQI' && (i.status === 'CONNECTED' || (i.configured_fields ?? []).length > 0));
  if (existente) return `OMITIDA: ya existe una integración CULQI de plataforma (${existente.status}, ${existente.configured_fields.length} campo(s)); no se toca`;
  creado.integracionCulqi = true;
  // Primero se configuran las credenciales (quedan cifradas) y solo después se conecta.
  const guardar = await pedir('PUT', '/admin/integrations/CULQI', { token: tokenAdmin, cuerpo: { credentials: { public_key: `pk_test_humo_${marca}`, private_key: `sk_test_humo_${marca}` } } });
  assert([200, 201].includes(guardar.estado), `configurar: estado ${guardar.estado} ${guardar.texto.slice(0, 160)}`);
  const conectar = await pedir('POST', '/admin/integrations/CULQI/connect', { token: tokenAdmin });
  assert([200, 201].includes(conectar.estado), `conectar: estado ${conectar.estado} ${conectar.texto.slice(0, 160)}`);
  const r = exige(await pedir('GET', '/admin/integrations', { token: tokenAdmin }), 200, 'listar integraciones');
  const texto = JSON.stringify(r.datos);
  assert(!texto.includes(`sk_test_humo_${marca}`), 'la API devuelve la credencial en claro');
  assert(/CONNECTED/.test(texto), 'la integración no aparece conectada');
  return 'CONNECTED · credencial no expuesta';
});

// -------------------------------------------------------------------- uploads
grupo('Almacenamiento de archivos');
await check('subida del logotipo de la empresa y lectura posterior', async () => {
  // PNG de 1×1 válido, generado aquí: no se sube ningún archivo real.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'logo.png');
  const r = await pedir('POST', `/company/logo?company_id=${creado.empresa}`, { token: tokenAdmin, form });
  assert([200, 201].includes(r.estado), `subida: estado ${r.estado} ${r.texto.slice(0, 160)}`);
  const url = r.datos?.logo_url ?? r.datos?.url;
  assert(url, 'la respuesta no trae la URL del logotipo');
  creado.logo = url;
  // El almacén devuelve una REFERENCIA (`public/...`); la imagen se sirve en /public/media/<ref>.
  const absoluta = url.startsWith('http') ? url : `${API}/public/media/${String(url).replace(/^\/+/, '')}`;
  const archivo = await fetch(absoluta);
  assert(archivo.ok, `el archivo no se puede leer (${archivo.status})`);
  creado.logoUrl = absoluta;
  return `${url} · ${archivo.headers.get('content-type')}`;
});

// -------------------------------------------------------------------- sesiones
grupo('Cierre de sesión');
await check('al cerrar sesión el token deja de valer', async () => {
  exige(await pedir('POST', '/auth/logout', { token: tokenCliente }), 200, 'logout');
  const r = await pedir('GET', '/auth/me', { token: tokenCliente });
  assert(r.estado === 401, `el token revocado sigue sirviendo (${r.estado})`);
  return 'token revocado';
});

// ------------------------------------------------------------------ retirada
// F18-09: se ejecuta SIEMPRE (también si algo falló antes), solo sobre lo que creó esta ejecución.
grupo('Retirada de los datos de la prueba');
if (creado.integracionCulqi) {
  await check('integración CULQI ficticia eliminada (auditado)', async () => {
    const r = await pedir('DELETE', '/admin/integrations/CULQI', { token: tokenAdmin });
    assert(r.estado === 200, `eliminar: estado ${r.estado}`);
    const l = exige(await pedir('GET', '/admin/integrations', { token: tokenAdmin }), 200, 'listar');
    const culqi = (l.datos?.integrations ?? []).find((i) => i.provider === 'CULQI');
    assert(culqi && culqi.status !== 'CONNECTED' && (culqi.configured_fields ?? []).length === 0, 'la integración sigue configurada');
    return 'sin integración CULQI de plataforma';
  });
}
if (creado.logo) {
  await check('logotipo y su archivo eliminados', async () => {
    exige(await pedir('DELETE', `/company/logo?company_id=${creado.empresa}`, { token: tokenAdmin }), 200, 'quitar logotipo');
    // Detrás de CloudFront la imagen puede seguir en caché hasta 1 s (MaxTTL de la política de la API).
    let estado = 0;
    for (let i = 0; i < 10 && estado !== 404; i += 1) {
      if (i) await new Promise((r) => setTimeout(r, 1000));
      estado = (await fetch(creado.logoUrl)).status;
    }
    assert(estado === 404, `el archivo sigue sirviéndose (${estado})`);
    return 'archivo retirado (404)';
  });
}
if (creado.llave) {
  await check('llave de API revocada', async () => {
    exige(await pedir('POST', `/api-keys/${creado.llave}/revoke`, { token: tokenAdmin }), 200, 'revocar');
    return `llave ${creado.llave} revocada`;
  });
}
if (creado.empresa) {
  await check('empresa sintética INACTIVE: fuera de la portada y de la búsqueda', async () => {
    exige(await pedir('PUT', `/companies/${creado.empresa}`, { token: tokenAdmin, cuerpo: { status: 'INACTIVE' } }), 200, 'desactivar');
    if (creado.origen && creado.destino) {
      const r = exige(await pedir('GET', `/public/trips?origin_id=${creado.origen}&destination_id=${creado.destino}`), 200, 'búsqueda');
      const lista = Array.isArray(r.datos) ? r.datos : r.datos?.items ?? [];
      assert(!lista.some((t) => t.id === creado.viaje), 'el viaje sigue apareciendo en la búsqueda');
    }
    return `empresa ${creado.empresa} INACTIVE · viaje ${creado.viaje ?? '-'} fuera de la búsqueda`;
  });
}
await check('manifiesto de la ejecución escrito (para purge-qa-data.cjs)', async () => {
  const manifiesto = {
    descripcion: `smoke-staging.mjs · ${new Date().toISOString()}`,
    marcas: [marca],
    companies: [creado.empresa].filter(Boolean),
    users: [creado.cliente, creado.usuario_COMPANY_ADMIN, creado.usuario_OPERATOR].filter(Boolean),
    locations: [creado.origen, creado.destino].filter(Boolean),
    bus_types: [creado.tipoBus].filter(Boolean),
    seat_types: [creado.tipoAsiento].filter(Boolean),
  };
  const destino = process.env.QA_MANIFEST || `qa-manifest-smoke-${marca}.json`;
  fs.writeFileSync(destino, `${JSON.stringify(manifiesto, null, 1)}\n`);
  if (tokenAdmin) await pedir('POST', '/auth/logout', { token: tokenAdmin });
  return `${destino} · empresas ${manifiesto.companies.length} · usuarios ${manifiesto.users.length}`;
});

// ------------------------------------------------------------------- informe
const fallos = resultados.filter((r) => !r.ok);
let ultimo = '';
for (const r of resultados) {
  if (r.grupo !== ultimo) { console.log(`\n${r.grupo}`); ultimo = r.grupo; }
  console.log(`  ${r.ok ? '✔' : '✖'} ${r.nombre}${r.detalle ? ` — ${r.detalle}` : ''}`);
}
console.log(`\n${resultados.length - fallos.length}/${resultados.length} comprobaciones correctas`);
if (creado.empresa) console.log(`datos sintéticos creados: empresa ${creado.empresa}, bus ${creado.bus}, viaje ${creado.viaje}, cliente ${creado.cliente}`);
process.exit(fallos.length ? 1 : 0);
