// BusPerú · F18-10 · datos DEMO permanentes para STAGING (nunca producción).
//
//   API_BASE_URL=https://<api>.cloudfront.net/api ADMIN_EMAIL=… ADMIN_PASSWORD_FILE=/ruta \
//     node infra/aws/scripts/seed-demo-staging.mjs --dry-run            # por defecto: solo lee y valida
//     node infra/aws/scripts/seed-demo-staging.mjs --execute            # crea lo que falte (idempotente)
//     node infra/aws/scripts/seed-demo-staging.mjs --verify [--qa-manifest m.json]   # pruebas por rol
//     node infra/aws/scripts/seed-demo-staging.mjs --entregar-credenciales           # SOLO en la terminal del propietario
//
// · Todo se crea por la API de la aplicación como el ADMIN de staging existente (validaciones, reglas de negocio y
//   auditoría de la propia app). No toca el esquema, ni el ADMIN, ni roles o permisos.
// · Identificación DEMO: dominio reservado `@demo.staging.busperu.invalid` (RFC 2606: nunca entrega correo) y nombres
//   «BusPerú Demo» / «Terminal Demo …». Es distinto del dominio de QA (`@busperu-staging.example`): purge-qa-data.cjs
//   exige ese dominio y rechaza expresamente el DEMO, así que la purga de QA no puede tocar estos datos.
// · Idempotente: cada recurso se busca por su clave natural (RUC, correo, nombre, placa, ruta + hora de salida) y se
//   reutiliza. Los viajes se calculan respecto al momento de ejecución (hora de Lima): repetirlo el mismo día no crea
//   nada; otro día añade las salidas futuras que falten.
// · --execute: si algo falla, deshace por la API, en orden inverso, SOLO lo creado en esa ejecución.
// · F18-19D: además deja PUBLICADO el perfil público de «BusPerú Demo» (/empresas/<slug>) con contenido explícitamente
//   ficticio (servicios y agencias DEMO; sin teléfonos, redes, coordenadas ni imágenes: no hay imágenes propias en el
//   proyecto y no se descargan de internet). Usa el flujo oficial: el ADMIN edita el perfil de la empresa
//   (`?company_id=`, como en la pestaña «Editar» de moderación), lo envía a revisión y lo aprueba; así no hace falta
//   conocer ni rotar la contraseña del COMPANY_ADMIN DEMO. El slug lo genera la aplicación, nunca este script.
//   Idempotente: compara lo publicado con lo definido aquí y solo edita, envía y aprueba lo que falte o difiera.
//   Un perfil no se puede borrar por la API: si una ejecución falla después de crearlo queda en borrador (no público).
// · F18-19D: salidas durante los próximos 7 días (una diaria a las 20:00 más la de las 08:00 de pasado mañana), para
//   que el DEMO siga teniendo viajes futuros aunque la siembra no se repita cada día.
// · Contraseñas DEMO: aleatorias (crypto) y NUNCA impresas ni guardadas. --verify las rota a valores efímeros en
//   memoria para probar cada rol. --entregar-credenciales las rota de nuevo y las muestra UNA vez en stdout: ejecútelo
//   solo el propietario, en su terminal local.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const MODO = ['--execute', '--verify', '--entregar-credenciales'].find((m) => process.argv.includes(m)) ?? '--dry-run';
const API = (process.env.API_BASE_URL || '').replace(/\/+$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const CLAVE_ADMIN = fs.readFileSync(process.env.ADMIN_PASSWORD_FILE || '', 'utf8').replace(/[\r\n]+$/, '');
const QA_MANIFEST = (() => { const i = process.argv.indexOf('--qa-manifest'); return i > 0 ? process.argv[i + 1] : ''; })();

// ------------------------------------------------------------------------------------------ definición DEMO
export const DOMINIO_DEMO = '@demo.staging.busperu.invalid';
const EMPRESA = {
  name: 'BusPerú Demo',
  legal_name: 'BusPerú Demo S.A.C. (empresa ficticia de staging)',
  tax_id: '20999900001',
  email: `empresa${DOMINIO_DEMO}`,
  phone: '+51 900 000 000',
  description: 'Empresa DEMO del entorno de staging. Todos sus datos son ficticios: no es una empresa real ni vende pasajes reales.',
  status: 'ACTIVE',
};
const USUARIOS = [
  { rol: 'COMPANY_ADMIN', email: `admin.empresa${DOMINIO_DEMO}`, first_name: 'Demo', last_name: 'Administrador de empresa', empresa: true, position: 'Administración (DEMO)' },
  { rol: 'OPERATOR', email: `operador${DOMINIO_DEMO}`, first_name: 'Demo', last_name: 'Operador', empresa: true, position: 'Operaciones (DEMO)' },
  { rol: 'CUSTOMER', email: `cliente${DOMINIO_DEMO}`, first_name: 'Demo', last_name: 'Cliente', empresa: false },
];
const TERMINALES = {
  Lima: { name: 'Terminal Demo Lima', city: 'Lima', province: 'Lima', department: 'Lima' },
  Pucallpa: { name: 'Terminal Demo Pucallpa', city: 'Pucallpa', province: 'Coronel Portillo', department: 'Ucayali' },
  Cusco: { name: 'Terminal Demo Cusco', city: 'Cusco', province: 'Cusco', department: 'Cusco' },
  Arequipa: { name: 'Terminal Demo Arequipa', city: 'Arequipa', province: 'Arequipa', department: 'Arequipa' },
};
// Distancias y duraciones aproximadas por carretera; precios DEMO (no comerciales).
const RUTAS = [
  { o: 'Lima', d: 'Pucallpa', km: 780, min: 1080, precio: 60 },
  { o: 'Pucallpa', d: 'Lima', km: 780, min: 1080, precio: 60 },
  { o: 'Lima', d: 'Cusco', km: 1100, min: 1260, precio: 80 },
  { o: 'Cusco', d: 'Lima', km: 1100, min: 1260, precio: 80 },
  { o: 'Lima', d: 'Arequipa', km: 1010, min: 960, precio: 70 },
  { o: 'Arequipa', d: 'Lima', km: 1010, min: 960, precio: 70 },
];
// Salidas: [días desde hoy (hora de Lima), hora local]. F18-10 creaba dos por ruta ([1, 20] y [2, 8]); F18-19D amplía el
// horizonte a 7 días con una salida diaria a las 20:00. Como la clave es la fecha y hora exactas, repetir la siembra al
// día siguiente reutiliza las que ya existen y solo añade las del nuevo último día (y la de las 08:00).
const SALIDAS = [[1, 20], [2, 8], [2, 20], [3, 20], [4, 20], [5, 20], [6, 20], [7, 20]];
const TIPO_BUS = { name: 'Demo · Semicama 40', description: 'Tipo de bus DEMO (ficticio)', default_capacity: 40 };
const TIPO_ASIENTO = { name: 'Demo · Semicama', description: 'Tipo de asiento DEMO (ficticio)' };
const BUS = { code: 'DEMO-01', plate_number: 'DEMO-001', brand: 'Demo', model: 'Semicama 40 (ficticio)', year: 2024, capacity: 40, status: 'ACTIVE' };
// Rejilla de 11 filas × 5 columnas: pasillo en la columna 3, 40 asientos en las filas 1–10 y baño al fondo.
const LAYOUT = { name: 'Demo · 40 asientos', decks: [{ deck_number: 1, name: 'Piso 1', row_count: 11, column_count: 5 }] };
const ASIENTOS = [];
for (let fila = 1; fila <= 10; fila += 1) {
  for (const col of [1, 2, 4, 5]) {
    ASIENTOS.push({ seat_number: String(ASIENTOS.length + 1).padStart(2, '0'), row_number: fila, column_number: col, is_window: col === 1 || col === 5, is_aisle: col === 2 || col === 4 });
  }
}
const ELEMENTOS = [{ element_type: 'BATHROOM', row_number: 11, column_number: 5, label: 'Baño' }];

// F18-19D · perfil público DEMO. Todo el texto dice que es ficticio; ningún dato de contacto enlaza a algo real
// (solo un correo del dominio reservado .invalid, que nunca entrega). Sin web, redes, teléfonos ni coordenadas.
const AVISO_DEMO = 'Perfil DEMO de staging: toda la información mostrada es ficticia.';
const PERFIL = {
  tagline: `Servicio de transporte interprovincial — entorno DEMO. ${AVISO_DEMO}`,
  about_title: 'Perfil DEMO de staging',
  about_body: 'Este perfil pertenece exclusivamente al entorno DEMO de staging. Todos los datos son ficticios y no corresponden a una empresa real.\n\n'
    + 'BusPerú Demo existe solo para mostrar cómo se ve el perfil público de una empresa de transporte en BusPerú. No presta servicios de transporte, no vende pasajes reales y no atiende al público.',
  history: 'Historia ficticia (DEMO): BusPerú Demo se creó en el entorno de staging para probar la plataforma con rutas, viajes y un bus de demostración entre Lima, Pucallpa, Cusco y Arequipa.',
  mission: 'Misión ficticia (DEMO): mostrar con claridad cómo una empresa de transporte presenta sus servicios, agencias y destinos a los pasajeros en BusPerú.',
  vision: 'Visión ficticia (DEMO): servir de ejemplo del perfil público de empresas mientras la plataforma se prueba en staging.',
  values_list: ['Datos 100 % ficticios (DEMO)', 'Seguridad', 'Puntualidad', 'Atención al pasajero'],
  contact_email: `contacto${DOMINIO_DEMO}`,
  main_address: 'Dirección ficticia (DEMO) · sin atención al público',
};
const SERVICIOS = [
  { name: 'Viajes interprovinciales (DEMO)', description: 'Servicio ficticio de demostración: viajes de ejemplo entre Lima, Pucallpa, Cusco y Arequipa en el entorno de staging.', features: ['Bus semicama de 40 asientos (DEMO)', 'Salidas de ejemplo generadas por la siembra', 'Sin validez comercial'] },
  { name: 'Venta y reserva de pasajes DEMO', description: 'La compra se prueba en staging con datos ficticios: no se venden pasajes reales.', features: ['Selección de asiento', 'Reserva de prueba', 'Sin cobros reales'] },
  { name: 'Equipaje (DEMO)', description: 'Condiciones de equipaje de ejemplo, solo para demostración.', features: ['Equipaje de mano (ejemplo)', 'Equipaje en bodega (ejemplo)'] },
  { name: 'Atención al pasajero (DEMO)', description: 'Canal de atención ficticio: los mensajes no llegan a ninguna empresa real.', features: ['Consultas de ejemplo', 'Libro de Reclamaciones de la plataforma'] },
];
const DIAS = (desde, hasta, rangos) => Object.fromEntries(Array.from({ length: hasta - desde + 1 }, (_, i) => [String(desde + i), rangos === 'cerrado' ? { closed: true } : { ranges: rangos }]));
const AGENCIAS = [
  { terminal: 'Lima', name: 'Agencia DEMO Lima', city: 'Lima', department: 'Lima', address: 'Dirección ficticia (DEMO) — Lima', reference: 'Agencia de demostración: sin atención al público',
    services: ['TICKET_SALES', 'BOARDING', 'CUSTOMER_SERVICE'], weekly_hours: { ...DIAS(1, 6, [{ open: '06:00', close: '22:00' }]), ...DIAS(7, 7, 'cerrado') } },
  { terminal: 'Pucallpa', name: 'Agencia DEMO Pucallpa', city: 'Pucallpa', department: 'Ucayali', address: 'Dirección ficticia (DEMO) — Pucallpa', reference: 'Agencia de demostración: sin atención al público',
    services: ['TICKET_SALES', 'BOARDING', 'BAGGAGE_STORAGE'], weekly_hours: { ...DIAS(1, 5, [{ open: '07:00', close: '13:00' }, { open: '15:00', close: '20:00' }]), ...DIAS(6, 6, [{ open: '08:00', close: '12:00' }]), ...DIAS(7, 7, 'cerrado') } },
  { terminal: 'Cusco', name: 'Agencia DEMO Cusco', city: 'Cusco', department: 'Cusco', address: 'Dirección ficticia (DEMO) — Cusco', reference: 'Agencia de demostración: sin atención al público',
    services: ['BOARDING', 'PARCELS', 'WAITING_ROOM'], weekly_hours: DIAS(1, 7, [{ open: '05:00', close: '21:00' }]) },
];

// ------------------------------------------------------------------------------------------ utilidades
const SECRETOS = [CLAVE_ADMIN];
const limpiar = (t) => SECRETOS.reduce((s, x) => (x ? s.split(x).join('***') : s), String(t ?? ''));
const log = (...a) => console.log(...a.map(limpiar));
class Alto extends Error {}
const alto = (m) => { throw new Alto(m); };
const filas = (d) => (Array.isArray(d) ? d : d?.items ?? d?.data ?? []);
// F18-19D · comparación de contenido (la API normaliza igual que aquí: textos ya limpios, listas sin repetidos).
const igual = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const difiere = (actual, deseado) => Object.entries(deseado).filter(([k, v]) => !igual(actual?.[k], v)).map(([k]) => k);
const servicioDeseado = (sv) => ({ name: sv.name, description: sv.description, features: sv.features });
const agenciaDeseada = (ag, terminal) => ({ name: ag.name, city: ag.city, department: ag.department, location_id: terminal ? Number(terminal.id) : null, address: ag.address,
  reference: ag.reference, services: ag.services, weekly_hours: ag.weekly_hours });
const publicado = (x) => Boolean(x && x.is_published && x.review_status === 'APPROVED' && !x.suspended_at && Number(x.is_active ?? 1) === 1);
// Acción sobre un elemento del perfil: CREAR · ACTUALIZAR (contenido distinto) · PUBLICAR (igual, pero sin aprobar) · REUTILIZAR.
function accionElemento(actual, deseado) {
  if (!actual) return 'CREAR';
  if (actual.suspended_at) alto(`«${actual.name}» está suspendido por moderación: revisarlo a mano`);
  if (difiere(actual, deseado).length) return 'ACTUALIZAR';
  return publicado(actual) ? 'REUTILIZAR' : 'PUBLICAR';
}
async function pedir(metodo, ruta, { token, cuerpo } = {}) {
  const h = {};
  if (token) h.Authorization = `Bearer ${token}`;
  let body;
  if (cuerpo !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(cuerpo); }
  const r = await fetch(`${API}${ruta}`, { method: metodo, headers: h, body, redirect: 'manual' });
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch { /* */ }
  return { estado: r.status, texto, datos: json?.data, json };
}
const exige = (r, esperado, que) => {
  if (![].concat(esperado).includes(r.estado)) alto(`${que}: se esperaba ${esperado} y llegó ${r.estado} ${limpiar(r.texto).slice(0, 220)}`);
  return r;
};
function claveSegura() {
  const conjuntos = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '-_.!#%+'];
  const todos = conjuntos.join('');
  const c = conjuntos.map((s) => s[crypto.randomInt(s.length)]);
  while (c.length < 20) c.push(todos[crypto.randomInt(todos.length)]);
  for (let i = c.length - 1; i > 0; i -= 1) { const j = crypto.randomInt(i + 1); [c[i], c[j]] = [c[j], c[i]]; }
  const clave = c.join('');
  SECRETOS.push(clave);
  return clave;
}
// Hora de Lima (UTC-5, sin horario de verano) → "YYYY-MM-DD HH:MM:SS" tal como la guarda la aplicación.
const LIMA = -5 * 3600e3;
function fechaLima(dias, hora, minutosExtra = 0) {
  const hoy = new Date(Date.now() + LIMA);
  const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() + dias, hora, 0, 0) + minutosExtra * 60e3);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// ------------------------------------------------------------------------------------------ comprobaciones de entorno
async function entorno() {
  if (!API || !ADMIN_EMAIL || !CLAVE_ADMIN) alto('faltan API_BASE_URL, ADMIN_EMAIL o ADMIN_PASSWORD_FILE');
  const host = new URL(API).hostname;
  if (/busperuonline|\bprod\b|production/i.test(host)) alto(`API_BASE_URL apunta a algo que parece producción (${host}): me niego`);
  if (!/\.cloudfront\.net$|^busperu-staging-alb-/.test(host)) alto(`API_BASE_URL no es una URL temporal de staging (${host})`);
  if (!ADMIN_EMAIL.endsWith('@staging.busperu.invalid')) alto('ADMIN_EMAIL no es el administrador de staging');
  const ready = await pedir('GET', '/ready');
  exige(ready, 200, 'ready');
  const l = exige(await pedir('POST', '/auth/login', { cuerpo: { email: ADMIN_EMAIL, password: CLAVE_ADMIN } }), 200, 'login ADMIN');
  const token = l.datos.token; SECRETOS.push(token);
  const me = exige(await pedir('GET', '/auth/me', { token }), 200, 'me ADMIN');
  if (me.datos.role !== 'ADMIN') alto(`el usuario no es ADMIN (${me.datos.role})`);
  const roles = filas(exige(await pedir('GET', '/roles?limit=50', { token }), 200, 'roles').datos);
  const rol = Object.fromEntries(roles.map((r) => [r.name, r.id]));
  const nombres = roles.map((r) => r.name).sort().join(',');
  if (nombres !== 'ADMIN,COMPANY_ADMIN,CUSTOMER,OPERATOR') alto(`roles inesperados: ${nombres}`);
  const ajustes = filas(exige(await pedir('GET', '/system-settings?search=platform.default_commission', { token }), 200, 'ajustes').datos);
  const comision = ajustes.find((a) => a.setting_key === 'platform.default_commission');
  if (!comision) alto('falta platform.default_commission: la API no daría de alta la empresa');
  const integ = exige(await pedir('GET', '/admin/integrations', { token }), 200, 'integraciones').datos?.integrations ?? [];
  const culqi = integ.find((i) => i.provider === 'CULQI');
  const culqiConectada = Boolean(culqi && (culqi.status === 'CONNECTED' || (culqi.configured_fields ?? []).length));
  return { token, adminId: me.datos.id, rol, comision: comision.setting_value, culqiConectada };
}

// ------------------------------------------------------------------------------------------ validación local
async function validarLocal() {
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  const archivo = path.resolve(aqui, '../../../backend/dist/validators/resource.validators.js');
  const avisos = [];
  if (!fs.existsSync(archivo)) return ['backend/dist no está construido: se omite la validación con los esquemas reales (npm run build en backend)'];
  const v = createRequire(import.meta.url)(archivo);
  const probar = (esquema, datos, que) => { const r = v[esquema].safeParse(datos); if (!r.success) alto(`${que} no pasa ${esquema}: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`); };
  probar('createCompanySchema', EMPRESA, 'empresa');
  for (const t of Object.values(TERMINALES)) probar('createLocationSchema', { ...t, type: 'TERMINAL', address: 'Dirección ficticia (DEMO)' }, t.name);
  probar('createBusTypeSchema', TIPO_BUS, 'tipo de bus');
  probar('createSeatTypeSchema', TIPO_ASIENTO, 'tipo de asiento');
  probar('createBusSchema', { ...BUS, company_id: 1, bus_type_id: 1 }, 'bus');
  for (const r of RUTAS) probar('createRouteSchema', { company_id: 1, origin_location_id: 1, destination_location_id: 2, name: `${r.o} → ${r.d} (Demo)`, distance_km: r.km, estimated_duration_minutes: r.min }, `ruta ${r.o}→${r.d}`);
  for (const r of RUTAS) for (const [dd, hh] of SALIDAS) probar('createTripSchema', { route_id: 1, bus_id: 1, departure_datetime: fechaLima(dd, hh), arrival_datetime: fechaLima(dd, hh, r.min), base_price: r.precio, status: 'SCHEDULED' }, `viaje ${r.o}→${r.d}`);
  for (const u of USUARIOS) probar('createUserSchema', { role_id: 1, first_name: u.first_name, last_name: u.last_name, email: u.email, password: 'Xx9-validacion', status: 'ACTIVE', ...(u.empresa ? { company_id: 1, position: u.position } : {}) }, u.email);
  // Geometría del layout (lo mismo que comprueba la publicación): dentro de la rejilla, sin solapes ni números repetidos.
  const piso = LAYOUT.decks[0]; const ocupadas = new Set(); const numeros = new Set();
  for (const a of [...ASIENTOS, ...ELEMENTOS]) {
    if (a.row_number < 1 || a.row_number > piso.row_count || a.column_number < 1 || a.column_number > piso.column_count) alto(`(${a.row_number},${a.column_number}) fuera de la rejilla`);
    const k = `${a.row_number}:${a.column_number}`; if (ocupadas.has(k)) alto(`celda ${k} ocupada dos veces`); ocupadas.add(k);
    if (a.seat_number) { if (numeros.has(a.seat_number)) alto(`asiento ${a.seat_number} repetido`); numeros.add(a.seat_number); }
  }
  if (numeros.size !== BUS.capacity) alto(`el layout tiene ${numeros.size} asientos y el bus ${BUS.capacity}`);
  // F18-19D · perfil público DEMO con los esquemas reales de F18-19.
  const cp = path.resolve(aqui, '../../../backend/dist/validators/company-profile.validators.js');
  if (!fs.existsSync(cp)) { avisos.push('backend/dist sin los validadores del perfil público: se omite su validación'); return avisos; }
  const w = createRequire(import.meta.url)(cp);
  const probarPerfil = (esquema, datos, que) => { const r = w[esquema].safeParse(datos); if (!r.success) alto(`${que} no pasa ${esquema}: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`); };
  probarPerfil('updateCompanyProfileSchema', PERFIL, 'perfil DEMO');
  for (const sv of SERVICIOS) probarPerfil('createCompanyServiceSchema', sv, `servicio «${sv.name}»`);
  for (const ag of AGENCIAS) probarPerfil('createCompanyAgencySchema', agenciaDeseada(ag, { id: 1 }), `agencia «${ag.name}»`);
  return avisos;
}

// ------------------------------------------------------------------------------------------ estado actual (solo lectura)
async function estado(ctx) {
  const t = ctx.token;
  const e = { empresa: null, usuarios: {}, terminales: {}, tipoBus: null, tipoAsiento: null, bus: null, layout: null, rutas: {}, viajes: {}, ajenas: [] };
  const empresas = filas(exige(await pedir('GET', '/companies?limit=100', { token: t }), 200, 'empresas').datos);
  const porRuc = filas(exige(await pedir('GET', `/companies?search=${EMPRESA.tax_id}&limit=100`, { token: t }), 200, 'empresa por RUC').datos);
  e.empresa = porRuc.find((c) => c.tax_id === EMPRESA.tax_id) ?? null;
  if (e.empresa && e.empresa.name !== EMPRESA.name) alto(`el RUC ${EMPRESA.tax_id} ya pertenece a «${e.empresa.name}», no a la empresa DEMO`);
  e.ajenas = empresas.filter((c) => c.tax_id !== EMPRESA.tax_id).map((c) => `${c.id}:${c.name}:${c.status}`);
  for (const u of USUARIOS) {
    const l = filas(exige(await pedir('GET', `/users?search=${encodeURIComponent(u.email)}&limit=10`, { token: t }), 200, 'usuarios').datos);
    const x = l.find((y) => y.email === u.email) ?? null;
    if (x && (x.role_name ?? x.role) !== u.rol) alto(`${u.email} existe con rol ${x.role_name ?? x.role}`);
    e.usuarios[u.rol] = x;
  }
  const ubic = filas(exige(await pedir('GET', `/locations?search=${encodeURIComponent('Terminal Demo')}&limit=100`, { token: t }), 200, 'ubicaciones').datos);
  for (const [k, v] of Object.entries(TERMINALES)) e.terminales[k] = ubic.find((l) => l.name === v.name) ?? null;
  e.tipoBus = filas(exige(await pedir('GET', `/bus-types?search=${encodeURIComponent(TIPO_BUS.name)}&limit=100`, { token: t }), 200, 'tipos de bus').datos).find((x) => x.name === TIPO_BUS.name) ?? null;
  e.tipoAsiento = filas(exige(await pedir('GET', `/seat-types?search=${encodeURIComponent(TIPO_ASIENTO.name)}&limit=100`, { token: t }), 200, 'tipos de asiento').datos).find((x) => x.name === TIPO_ASIENTO.name) ?? null;
  const buses = filas(exige(await pedir('GET', `/buses?search=${encodeURIComponent(BUS.plate_number)}&limit=100`, { token: t }), 200, 'buses').datos);
  e.bus = buses.find((b) => b.plate_number === BUS.plate_number) ?? null;
  if (e.bus && e.empresa && Number(e.bus.company_id) !== Number(e.empresa.id)) alto(`la placa ${BUS.plate_number} pertenece a otra empresa`);
  if (e.bus) {
    const ls = filas(exige(await pedir('GET', `/buses/${e.bus.id}/layouts`, { token: t }), 200, 'layouts').datos);
    e.layout = ls.find((l) => l.status === 'PUBLISHED') ?? null;
    e.borradores = ls.filter((l) => l.status === 'DRAFT');
  }
  if (e.empresa) {
    const rs = filas(exige(await pedir('GET', `/routes?company_id=${e.empresa.id}&limit=100`, { token: t }), 200, 'rutas').datos);
    for (const r of RUTAS) e.rutas[`${r.o}>${r.d}`] = rs.find((x) => x.name === `${r.o} → ${r.d} (Demo)` && Number(x.company_id) === Number(e.empresa.id)) ?? null;
    for (const r of RUTAS) {
      const ruta = e.rutas[`${r.o}>${r.d}`];
      const vs = ruta ? filas(exige(await pedir('GET', `/trips?route_id=${ruta.id}&limit=100`, { token: t }), 200, 'viajes').datos) : [];
      for (const [dd, hh] of SALIDAS) {
        const salida = fechaLima(dd, hh);
        e.viajes[`${r.o}>${r.d}@${salida}`] = ruta ? vs.find((v) => Number(v.route_id) === Number(ruta.id) && String(v.departure_datetime).slice(0, 19).replace('T', ' ') === salida) ?? null : null;
      }
    }
    // F18-19D · perfil público. SOLO LECTURA: la cola de moderación y las listas no crean el perfil (abrirlo sí, por
    // eso el dry-run no lo abre). El contenido publicado se lee de la API pública.
    const cola = filas(exige(await pedir('GET', '/admin/company-profiles', { token: t }), 200, 'perfiles').datos);
    const fila = cola.find((c) => Number(c.company_id) === Number(e.empresa.id));
    e.perfil = fila?.slug ? { slug: fila.slug, estado: fila.profile_status, publicado: Boolean(fila.profile_published_at), suspendido: Boolean(fila.profile_suspended_at) } : null;
    if (e.perfil?.suspendido) alto('el perfil DEMO está suspendido por moderación: revisarlo a mano');
    e.perfilPublico = null;
    if (e.perfil?.publicado) {
      const pub = await pedir('GET', `/public/companies/${encodeURIComponent(e.perfil.slug)}`);
      if (pub.estado === 200) e.perfilPublico = pub.datos.profile;
    }
    e.servicios = filas(exige(await pedir('GET', `/company/profile/services?company_id=${e.empresa.id}`, { token: t }), 200, 'servicios del perfil').datos);
    e.agencias = filas(exige(await pedir('GET', `/company/profile/agencies?company_id=${e.empresa.id}`, { token: t }), 200, 'agencias del perfil').datos);
  }
  return e;
}

function plan(e) {
  const p = [];
  const x = (que, existe, detalle = '') => p.push({ que, accion: existe ? 'REUTILIZAR' : 'CREAR', detalle });
  x(`empresa «${EMPRESA.name}» (RUC ${EMPRESA.tax_id}, ACTIVE)`, e.empresa, e.empresa ? `id ${e.empresa.id}` : '');
  for (const u of USUARIOS) x(`usuario ${u.rol} ${u.email}${u.empresa ? ' (empresa DEMO)' : ''}`, e.usuarios[u.rol], e.usuarios[u.rol] ? `id ${e.usuarios[u.rol].id}` : '');
  for (const [k, v] of Object.entries(TERMINALES)) x(`terminal «${v.name}» (${v.city}, ${v.department})`, e.terminales[k], e.terminales[k] ? `id ${e.terminales[k].id}` : '');
  x(`tipo de bus «${TIPO_BUS.name}»`, e.tipoBus); x(`tipo de asiento «${TIPO_ASIENTO.name}»`, e.tipoAsiento);
  x(`bus ${BUS.code} placa ${BUS.plate_number} (capacidad ${BUS.capacity})`, e.bus, e.bus ? `id ${e.bus.id}` : '');
  x(`layout publicado «${LAYOUT.name}»: 1 piso 11×5, ${ASIENTOS.length} asientos, ${ELEMENTOS.length} baño`, e.layout, e.layout ? `id ${e.layout.id} v${e.layout.version}` : '');
  for (const r of RUTAS) x(`ruta ${r.o} → ${r.d} (${r.km} km, ${r.min} min)`, e.rutas[`${r.o}>${r.d}`]);
  for (const r of RUTAS) for (const [dd, hh] of SALIDAS) { const s = fechaLima(dd, hh); x(`viaje ${r.o} → ${r.d} ${s} (Lima) · S/ ${r.precio.toFixed(2)}`, e.viajes[`${r.o}>${r.d}@${s}`]); }
  // F18-19D · perfil público DEMO
  const y = (que, accion, detalle = '') => p.push({ que, accion, detalle });
  const accionPerfil = !e.perfil ? 'CREAR' : !e.perfil.publicado ? 'PUBLICAR' : difiere(e.perfilPublico, PERFIL).length ? 'ACTUALIZAR'
    : e.perfil.estado !== 'APPROVED' ? 'PUBLICAR' : 'REUTILIZAR';
  y('perfil público de la empresa DEMO (slug generado por la aplicación)', accionPerfil, e.perfil ? `slug ${e.perfil.slug} · ${e.perfil.estado}${e.perfil.publicado ? ' · publicado' : ''}` : '');
  for (const sv of SERVICIOS) { const a = (e.servicios ?? []).find((z) => z.name === sv.name); y(`servicio «${sv.name}»`, accionElemento(a, servicioDeseado(sv)), a ? `id ${a.id} · ${a.review_status}` : ''); }
  for (const ag of AGENCIAS) { const a = (e.agencias ?? []).find((z) => z.name === ag.name); y(`agencia «${ag.name}» (${ag.city})`, accionElemento(a, agenciaDeseada(ag, e.terminales[ag.terminal])), a ? `id ${a.id} · ${a.review_status}` : ''); }
  return p;
}

// ------------------------------------------------------------------------------------------ creación (idempotente)
async function crearTodo(ctx, e) {
  const t = ctx.token;
  const creados = [];   // [tipo, id, ruta DELETE] en orden de creación, para deshacer
  const crear = async (ruta, cuerpo, que, borrar) => {
    const r = exige(await pedir('POST', ruta, { token: t, cuerpo }), 201, `crear ${que}`);
    const id = r.datos?.id ?? r.datos?.[0]?.id;
    if (!id) alto(`crear ${que}: la respuesta no trae id`);
    creados.push([que, id, borrar(id)]);
    log(`  + ${que} → id ${id}`);
    return r.datos;
  };
  try {
    const empresa = e.empresa ?? await crear('/companies', EMPRESA, `empresa ${EMPRESA.name}`, (id) => `/companies/${id}`);
    const usuarios = {};
    for (const u of USUARIOS) {
      usuarios[u.rol] = e.usuarios[u.rol] ?? await crear('/users', {
        role_id: ctx.rol[u.rol], first_name: u.first_name, last_name: u.last_name, email: u.email, password: claveSegura(), status: 'ACTIVE',
        ...(u.empresa ? { company_id: empresa.id, position: u.position } : {}),
      }, `usuario ${u.rol}`, (id) => `/users/${id}`);
    }
    const term = {};
    for (const [k, v] of Object.entries(TERMINALES)) term[k] = e.terminales[k] ?? await crear('/locations', { ...v, type: 'TERMINAL', address: 'Dirección ficticia (DEMO)', country_code: 'PE' }, `terminal ${k}`, (id) => `/locations/${id}`);
    const tipoBus = e.tipoBus ?? await crear('/bus-types', TIPO_BUS, 'tipo de bus', (id) => `/bus-types/${id}`);
    const tipoAsiento = e.tipoAsiento ?? await crear('/seat-types', TIPO_ASIENTO, 'tipo de asiento', (id) => `/seat-types/${id}`);
    const bus = e.bus ?? await crear('/buses', { ...BUS, company_id: empresa.id, bus_type_id: tipoBus.id }, `bus ${BUS.plate_number}`, (id) => `/buses/${id}`);
    if (!e.layout) {
      if ((e.borradores ?? []).length) alto(`el bus ${BUS.plate_number} tiene borradores de layout sin publicar: revisarlos a mano antes de reintentar`);
      const l = exige(await pedir('POST', `/buses/${bus.id}/layouts`, { token: t, cuerpo: LAYOUT }), 201, 'crear layout');
      creados.push(['layout (borrador)', l.datos.id, `/layouts/${l.datos.id}`]);
      const piso = exige(await pedir('GET', `/layouts/${l.datos.id}/decks`, { token: t }), 200, 'pisos').datos[0];
      for (const a of ASIENTOS) exige(await pedir('POST', `/decks/${piso.id}/seats`, { token: t, cuerpo: { ...a, seat_type_id: tipoAsiento.id } }), 201, `asiento ${a.seat_number}`);
      for (const el of ELEMENTOS) exige(await pedir('POST', `/decks/${piso.id}/elements`, { token: t, cuerpo: el }), 201, `elemento ${el.element_type}`);
      const pub = exige(await pedir('POST', `/layouts/${l.datos.id}/publish`, { token: t }), 200, 'publicar layout');
      if (pub.datos.status !== 'PUBLISHED' || Number(pub.datos.seat_count) !== BUS.capacity) alto(`layout publicado con estado ${pub.datos.status} y ${pub.datos.seat_count} asientos`);
      creados.at(-1)[0] = 'layout (publicado)'; creados.at(-1)[2] = null;   // publicado: se va con el bus
      log(`  + layout publicado id ${l.datos.id}: ${pub.datos.seat_count} asientos`);
    }
    const rutas = {};
    for (const r of RUTAS) {
      rutas[`${r.o}>${r.d}`] = e.rutas[`${r.o}>${r.d}`] ?? await crear('/routes', {
        company_id: empresa.id, origin_location_id: term[r.o].id, destination_location_id: term[r.d].id,
        name: `${r.o} → ${r.d} (Demo)`, distance_km: r.km, estimated_duration_minutes: r.min, status: 'ACTIVE',
      }, `ruta ${r.o}→${r.d}`, (id) => `/routes/${id}`);
    }
    for (const r of RUTAS) {
      for (const [dd, hh] of SALIDAS) {
        const salida = fechaLima(dd, hh);
        if (e.viajes[`${r.o}>${r.d}@${salida}`]) continue;
        await crear('/trips', {
          route_id: rutas[`${r.o}>${r.d}`].id, bus_id: bus.id, departure_datetime: salida, arrival_datetime: fechaLima(dd, hh, r.min),
          base_price: r.precio, status: 'SCHEDULED', boarding_notes: 'Viaje DEMO de staging (ficticio).',
        }, `viaje ${r.o}→${r.d} ${salida}`, (id) => `/trips/${id}`);
      }
    }

    // ---- F18-19D · perfil público DEMO: el ADMIN edita el perfil de la empresa, lo envía a revisión y lo aprueba.
    const q = `?company_id=${empresa.id}`;
    const publicar = async (rutaEnvio, entity, id, estadoActual, que) => {
      if (estadoActual === 'DRAFT' || estadoActual === 'REJECTED') exige(await pedir('POST', rutaEnvio, { token: t }), 200, `enviar a revisión ${que}`);
      exige(await pedir('POST', `/admin/company-profiles/${empresa.id}/moderation`, { token: t, cuerpo: { entity, action: 'approve', ...(id ? { id } : {}) } }), 200, `aprobar ${que}`);
      log(`  ✓ ${que}: enviado a revisión y aprobado (publicado)`);
    };
    // Abrir el perfil lo crea en borrador si no existe; el slug lo genera la aplicación a partir del nombre.
    const perfil = exige(await pedir('GET', `/company/profile${q}`, { token: t }), 200, 'perfil').datos;
    if (!e.perfil) log(`  + perfil público creado en borrador por la aplicación · slug ${perfil.slug}`);
    if (perfil.suspended_at) alto('el perfil DEMO está suspendido por moderación: revisarlo a mano');
    let estadoPerfil = perfil.review_status;
    const cambiosPerfil = difiere(perfil, PERFIL);
    if (cambiosPerfil.length) {
      const r = exige(await pedir('PUT', `/company/profile${q}`, { token: t, cuerpo: PERFIL }), 200, 'editar perfil');
      estadoPerfil = (r.datos.profile ?? r.datos).review_status;
      log(`  ~ perfil ${perfil.slug}: ${cambiosPerfil.join(', ')}`);
    }
    if (estadoPerfil !== 'APPROVED' || !perfil.is_published) await publicar(`/company/profile/submit${q}`, 'profile', null, estadoPerfil, `perfil ${perfil.slug}`);

    const elementos = [
      ...SERVICIOS.map((sv) => ({ tipo: 'services', entity: 'service', que: `servicio «${sv.name}»`, actual: (e.servicios ?? []).find((z) => z.name === sv.name), deseado: servicioDeseado(sv), cuerpo: sv })),
      ...AGENCIAS.map((ag) => {
        const deseado = agenciaDeseada(ag, term[ag.terminal]);
        return { tipo: 'agencies', entity: 'agency', que: `agencia «${ag.name}»`, actual: (e.agencias ?? []).find((z) => z.name === ag.name), deseado, cuerpo: deseado };
      }),
    ];
    for (const el of elementos) {
      const accion = accionElemento(el.actual, el.deseado);
      if (accion === 'REUTILIZAR') continue;
      let id = el.actual?.id; let estadoEl = el.actual?.review_status;
      if (accion === 'CREAR') {
        const r = exige(await pedir('POST', `/company/profile/${el.tipo}${q}`, { token: t, cuerpo: el.cuerpo }), 201, `crear ${el.que}`);
        id = r.datos.id; estadoEl = r.datos.review_status;
        creados.push([el.que, id, `/company/profile/${el.tipo}/${id}${q}`]);
        log(`  + ${el.que} → id ${id}`);
      } else if (accion === 'ACTUALIZAR') {
        const r = exige(await pedir('PUT', `/company/profile/${el.tipo}/${id}${q}`, { token: t, cuerpo: el.cuerpo }), 200, `editar ${el.que}`);
        estadoEl = r.datos.review_status; log(`  ~ ${el.que}: ${difiere(el.actual, el.deseado).join(', ')}`);
      }
      if (Number(el.actual?.is_active ?? 1) !== 1) exige(await pedir('PATCH', `/company/profile/${el.tipo}/${id}/active${q}`, { token: t, cuerpo: { is_active: true } }), 200, `activar ${el.que}`);
      await publicar(`/company/profile/${el.tipo}/${id}/submit${q}`, el.entity, id, estadoEl, el.que);
    }
    return creados;
  } catch (error) {
    log(`\nFALLO: ${error.message}\nDeshaciendo por la API SOLO lo creado en esta ejecución (${creados.length} recurso(s)), en orden inverso…`);
    for (const [que, id, ruta] of [...creados].reverse()) {
      if (!ruta) { log(`  = ${que} ${id}: se retira con su padre`); continue; }
      const r = await pedir('DELETE', ruta, { token: t });
      log(`  - ${que} ${id}: DELETE ${r.estado}${r.estado >= 300 ? ` ${limpiar(r.texto).slice(0, 120)}` : ''}`);
    }
    throw error;
  }
}

// ------------------------------------------------------------------------------------------ verificación por rol
async function verificar(ctx, e) {
  const t = ctx.token; const res = [];
  const check = async (rol, nombre, fn) => { try { res.push([rol, nombre, 'PASS', limpiar(await fn() ?? '')]); } catch (x) { res.push([rol, nombre, 'FAIL', limpiar(x.message)]); } };
  const codigo = async (m, ruta, token, cuerpo) => (await pedir(m, ruta, { token, cuerpo })).estado;
  const prohibido = (c) => c === 403 || c === 404;
  if (!e.empresa || Object.values(e.usuarios).some((u) => !u)) alto('faltan datos DEMO: ejecute antes --execute');
  // Ajena para el aislamiento: empresa de QA de un manifiesto de qa-staging.sh (si se pasa).
  let ajena = null;
  if (QA_MANIFEST) {
    const m = JSON.parse(fs.readFileSync(QA_MANIFEST, 'utf8'));
    const cid = (m.companies || [])[0];
    if (cid) {
      const bus = filas((await pedir('GET', `/buses?company_id=${cid}&limit=5`, { token: t })).datos)[0];
      const ruta = filas((await pedir('GET', `/routes?company_id=${cid}&limit=5`, { token: t })).datos)[0];
      ajena = { empresa: cid, bus: bus?.id, ruta: ruta?.id };
    }
  }
  // Claves efímeras en memoria para los 3 usuarios DEMO (quedan desconocidas: se entregan con --entregar-credenciales).
  const tok = {};
  for (const u of USUARIOS) {
    const clave = claveSegura();
    exige(await pedir('PUT', `/users/${e.usuarios[u.rol].id}`, { token: t, cuerpo: { password: clave } }), 200, `clave efímera ${u.rol}`);
    const l = exige(await pedir('POST', '/auth/login', { cuerpo: { email: u.email, password: clave } }), 200, `login ${u.rol}`);
    tok[u.rol] = l.datos.token; SECRETOS.push(tok[u.rol]);
  }
  const E = e.empresa.id;
  const soloDemo = (lista) => lista.every((x) => Number(x.company_id ?? E) === Number(E));

  await check('ADMIN', 'login + /auth/me', async () => { const r = exige(await pedir('GET', '/auth/me', { token: t }), 200, 'me'); return `${r.datos.role} (existente, id ${r.datos.id})`; });
  await check('ADMIN', 'panel de plataforma y administración', async () => {
    exige(await pedir('GET', '/dashboard/admin', { token: t }), 200, 'dashboard/admin'); exige(await pedir('GET', '/users/stats', { token: t }), 200, 'users/stats');
    const cs = filas(exige(await pedir('GET', '/companies?limit=100', { token: t }), 200, 'empresas').datos);
    if (!cs.some((c) => c.id === E)) alto('no ve la empresa DEMO');
    return `dashboard/admin 200 · users/stats 200 · ve ${cs.length} empresa(s)`;
  });

  for (const rol of ['COMPANY_ADMIN', 'OPERATOR']) {
    const k = tok[rol];
    await check(rol, 'login + /auth/me con la empresa DEMO', async () => {
      const r = exige(await pedir('GET', '/auth/me', { token: k }), 200, 'me');
      if (r.datos.role !== rol) alto(`rol ${r.datos.role}`);
      const ids = (r.datos.company_ids ?? r.datos.companyIds ?? r.datos.companies?.map((c) => c.id ?? c.company_id) ?? []).map(Number);
      if (ids.length && (ids.length !== 1 || ids[0] !== Number(E))) alto(`empresas asociadas ${ids}`);
      return `${rol} · empresa ${ids.length ? ids.join(',') : '(no expuesta en /auth/me)'}`;
    });
    await check(rol, 'panel de empresa y su propia empresa', async () => {
      exige(await pedir('GET', '/dashboard/company', { token: k }), 200, 'dashboard/company');
      exige(await pedir('GET', `/companies/${E}`, { token: k }), 200, 'empresa DEMO');
      return 'dashboard/company 200 · empresa DEMO 200';
    });
    await check(rol, 'buses, rutas y viajes: solo de la empresa DEMO', async () => {
      const b = filas(exige(await pedir('GET', '/buses?limit=100', { token: k }), 200, 'buses').datos);
      const r = filas(exige(await pedir('GET', '/routes?limit=100', { token: k }), 200, 'rutas').datos);
      const v = filas(exige(await pedir('GET', '/trips?limit=100', { token: k }), 200, 'viajes').datos);
      if (!soloDemo(b) || !soloDemo(r)) alto('ve buses o rutas de otra empresa');
      if (!b.length || !r.length || !v.length) alto(`listas vacías (buses ${b.length}, rutas ${r.length}, viajes ${v.length})`);
      return `buses ${b.length} · rutas ${r.length} · viajes ${v.length}, todos DEMO`;
    });
    await check(rol, 'reportes', async () => { const c = await codigo('GET', '/reports/sales-by-date', k); if (![200, 403].includes(c)) alto(`código ${c}`); return `sales-by-date ${c}`; });
    await check(rol, 'endpoints de plataforma prohibidos', async () => {
      const cs = { 'dashboard/admin': await codigo('GET', '/dashboard/admin', k), 'users/stats': await codigo('GET', '/users/stats', k),
        'POST companies': await codigo('POST', '/companies', k, { name: 'X' }), 'PUT system-settings': await codigo('PUT', '/system-settings/1', k, { setting_value: '1' }),
        'POST users ADMIN': await codigo('POST', '/users', k, { role_id: ctx.rol.ADMIN, first_name: 'X', last_name: 'Y', email: `nope${DOMINIO_DEMO}`, password: 'Xx9-nope-nope', status: 'ACTIVE' }) };
      if (!Object.values(cs).every((c) => c === 403 || c === 400)) alto(JSON.stringify(cs));
      return JSON.stringify(cs);
    });
    if (rol === 'OPERATOR') {
      await check(rol, 'operaciones de administración de empresa prohibidas', async () => {
        const cs = { 'PUT empresa': await codigo('PUT', `/companies/${E}`, k, { description: 'x' }), 'POST buses': await codigo('POST', '/buses', k, { code: 'X', plate_number: 'XXXXXX', capacity: 1 }) };
        return JSON.stringify(cs);
      });
    }
    await check(rol, 'aislamiento frente a otra empresa', async () => {
      if (!ajena) alto('sin empresa ajena para probar (pase --qa-manifest)');
      const cs = { empresa: await codigo('GET', `/companies/${ajena.empresa}`, k), 'PUT empresa': await codigo('PUT', `/companies/${ajena.empresa}`, k, { description: 'x' }),
        ...(ajena.bus ? { bus: await codigo('GET', `/buses/${ajena.bus}`, k) } : {}), ...(ajena.ruta ? { ruta: await codigo('GET', `/routes/${ajena.ruta}`, k) } : {}) };
      if (!Object.values(cs).every(prohibido)) alto(JSON.stringify(cs));
      return JSON.stringify(cs);
    });
  }

  const kc = tok.CUSTOMER;
  let reserva = null; let viaje = null; let asiento = null;
  await check('CUSTOMER', 'login + /auth/me + panel de cliente', async () => {
    const r = exige(await pedir('GET', '/auth/me', { token: kc }), 200, 'me'); if (r.datos.role !== 'CUSTOMER') alto(r.datos.role);
    exige(await pedir('GET', '/dashboard/customer', { token: kc }), 200, 'dashboard/customer'); return 'CUSTOMER · dashboard/customer 200';
  });
  await check('CUSTOMER', 'búsqueda Lima → Pucallpa y selección de viaje', async () => {
    const r = exige(await pedir('GET', `/public/trips?origin=Lima&destination=Pucallpa&date=${fechaLima(1, 20).slice(0, 10)}`), 200, 'búsqueda');
    const l = filas(r.datos).filter((x) => Number(x.company_id) === Number(E));
    if (!l.length) alto('sin resultados DEMO');
    viaje = l[0]; return `${l.length} viaje(s) DEMO · ${viaje.origin_city} → ${viaje.destination_city} ${viaje.departure_datetime} · S/ ${viaje.base_price}`;
  });
  await check('CUSTOMER', 'mapa de asientos', async () => {
    const s = filas(exige(await pedir('GET', `/public/trips/${viaje.id}/seats`), 200, 'asientos').datos?.seats ?? (await pedir('GET', `/public/trips/${viaje.id}/seats`)).datos);
    const libres = s.filter((x) => x.status === 'AVAILABLE' && !Number(x.is_taken));
    if (s.length !== BUS.capacity) alto(`el mapa tiene ${s.length} asientos`);
    asiento = libres.find((x) => x.seat_number === '10') ?? libres[0];
    exige(await pedir('GET', `/public/trips/${viaje.id}/layout`), 200, 'layout público');
    return `${s.length} asientos · ${libres.length} libres · layout público 200`;
  });
  await check('CUSTOMER', 'reserva → Mis viajes → cancelación (libera el asiento)', async () => {
    const r = exige(await pedir('POST', '/bookings', { token: kc, cuerpo: { trip_id: viaje.id, seat_ids: [asiento.id], passenger_email: USUARIOS[2].email, passenger_name: 'Cliente Demo' } }), 201, 'reservar');
    reserva = r.datos?.booking?.id ?? r.datos?.id;
    const mis = filas(exige(await pedir('GET', '/bookings?limit=50', { token: kc }), 200, 'mis viajes').datos);
    if (!mis.some((b) => b.id === reserva)) alto('la reserva no aparece en Mis viajes');
    exige(await pedir('POST', `/bookings/${reserva}/cancel`, { token: kc, cuerpo: { reason: 'Prueba de verificación F18-10' } }), 200, 'cancelar');
    const s = (await pedir('GET', `/public/trips/${viaje.id}/seats`)).datos; const a = filas(s?.seats ?? s).find((x) => x.id === asiento.id);
    if (Number(a?.is_taken)) alto('el asiento no se liberó');
    return `reserva ${reserva} PENDING → en Mis viajes → CANCELLED · asiento ${asiento.seat_number} libre`;
  });
  await check('CUSTOMER', 'aislamiento y permisos de cliente', async () => {
    const u = filas(exige(await pedir('GET', '/users', { token: kc }), 200, 'users').datos);
    const cs = { 'users/stats': await codigo('GET', '/users/stats', kc), 'dashboard/company': await codigo('GET', '/dashboard/company', kc), 'dashboard/admin': await codigo('GET', '/dashboard/admin', kc),
      'POST companies': await codigo('POST', '/companies', kc, { name: 'X' }), [`companies/${E}`]: await codigo('PUT', `/companies/${E}`, kc, { description: 'x' }) };
    if (u.length !== 1 || !Object.values(cs).every(prohibido)) alto(`users ${u.length} · ${JSON.stringify(cs)}`);
    return `se ve solo a sí mismo · ${JSON.stringify(cs)}`;
  });
  for (const rol of Object.keys(tok)) {
    await check(rol, 'logout → token revocado', async () => {
      exige(await pedir('POST', '/auth/logout', { token: tok[rol] }), 200, 'logout');
      const c = await codigo('GET', '/auth/me', tok[rol]); if (c !== 401) alto(`me tras logout ${c}`); return 'logout 200 · me 401';
    });
  }
  return res;
}

// ------------------------------------------------------------------------------------------ principal
(async () => {
  log(`BusPerú · F18-10 · seed DEMO de staging · modo ${MODO} · ${new Date().toISOString()}`);
  if (MODO === '--entregar-credenciales' && !process.stdout.isTTY) alto('este modo solo muestra credenciales en una terminal interactiva (PowerShell o cmd; no redirija la salida a un archivo)');
  const ctx = await entorno();
  log(`entorno: ${new URL(API).hostname} · ADMIN id ${ctx.adminId} · roles ${Object.keys(ctx.rol).join(', ')} · comisión ${ctx.comision} % · Culqi ${ctx.culqiConectada ? 'CONECTADA' : 'sin integración'}`);
  if (ctx.culqiConectada) log('AVISO: hay una integración CULQI de plataforma; el seed no la toca.');

  if (MODO === '--entregar-credenciales') {
    const e = await estado(ctx);
    if (Object.values(e.usuarios).some((u) => !u)) alto('faltan usuarios DEMO: ejecute antes --execute');
    console.log('\n=== Credenciales DEMO (se muestran UNA sola vez; no se guardan en ningún sitio) ===');
    for (const u of USUARIOS) {
      const clave = claveSegura();
      exige(await pedir('PUT', `/users/${e.usuarios[u.rol].id}`, { token: ctx.token, cuerpo: { password: clave } }), 200, `clave ${u.rol}`);
      exige(await pedir('POST', '/auth/login', { cuerpo: { email: u.email, password: clave } }), 200, `login ${u.rol}`);
      console.log(`${u.rol.padEnd(14)} ${u.email.padEnd(44)} ${clave}`);
    }
    console.log('=== Guárdelas en su gestor de contraseñas. Para regenerarlas, repita este comando. ===\n');
    await pedir('POST', '/auth/logout', { token: ctx.token });
    return;
  }

  const avisos = await validarLocal();
  for (const a of avisos) log(`AVISO: ${a}`);
  log(`validación local con los esquemas reales del backend: ${avisos.length ? 'omitida' : 'PASS'} · layout ${ASIENTOS.length} asientos sin solapes ni duplicados`);
  let e = await estado(ctx);
  if (e.ajenas.length) log(`otras empresas en staging (no se tocan): ${e.ajenas.join(' | ')}`);

  if (MODO === '--verify') {
    const r = await verificar(ctx, e);
    let u = '';
    for (const [rol, n, est, d] of r) { if (rol !== u) { log(`\n${rol}`); u = rol; } log(`  ${est} ${n}${d ? ` — ${d}` : ''}`); }
    const f = r.filter((x) => x[2] === 'FAIL').length;
    log(`\n${r.length - f}/${r.length} comprobaciones correctas`);
    await pedir('POST', '/auth/logout', { token: ctx.token });
    process.exit(f ? 1 : 0);
  }

  const p = plan(e);
  const crearN = p.filter((x) => x.accion !== 'REUTILIZAR').length;
  log(`\nPlan (${p.length} elementos: ${crearN} a crear, actualizar o publicar; ${p.length - crearN} a reutilizar):`);
  for (const x of p) log(`  ${x.accion.padEnd(10)} ${x.que}${x.detalle ? ` [${x.detalle}]` : ''}`);
  if (MODO === '--dry-run') { log('\nDRY-RUN: no se ha modificado nada.'); await pedir('POST', '/auth/logout', { token: ctx.token }); return; }

  log('\nEjecutando…');
  const creados = await crearTodo(ctx, e);
  e = await estado(ctx);
  const faltan = plan(e).filter((x) => x.accion !== 'REUTILIZAR');
  if (faltan.length) alto(`tras ejecutar aún faltan: ${faltan.map((x) => x.que).join(' | ')}`);
  log(`\nEJECUTADO: ${creados.length} recurso(s) creado(s) (más asientos y elementos del layout); ${p.length - crearN} reutilizado(s). Estado final completo.`);
  log('Contraseñas DEMO: aleatorias y no mostradas. Entréguelas con --entregar-credenciales en su terminal.');
  await pedir('POST', '/auth/logout', { token: ctx.token });
})().catch((error) => {
  console.log(`\nDETENIDO: ${limpiar(error instanceof Alto ? error.message : error.stack || error.message)}`);
  process.exit(2);
});
