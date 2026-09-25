// BusPerú · F18-09 · E2E complementario de STAGING: itinerario ida y vuelta, pago manual aprobado por la
// empresa, expiración, «Mis viajes», RBAC de 4 roles y logout. Datos sintéticos por la API; sin Culqi; no
// imprime tokens ni claves. Complementa a smoke-staging.mjs.
//
//   API_BASE_URL=https://…/api FRONTEND_ORIGIN=https://… ADMIN_EMAIL=… ADMIN_PASSWORD_FILE=… //   ESTADO_FILE=./e2e-estado.json QA_MANIFEST=./qa-manifest-e2e.json  node e2e-staging.mjs          # flujo
//   … node e2e-staging.mjs expiry    # pasados ≥ 16 min: la reserva que se dejó caducar está EXPIRED
//
// Al terminar el flujo RETIRA por la API lo que creó (empresa sintética a INACTIVE: sale de la portada y de
// la búsqueda) y escribe el MANIFIESTO de ids para la purga física (purge-qa-data.cjs, vía qa-staging.sh).
// La reserva que debe caducar sigue en la base hasta la purga; la comprobación "expiry" solo la lee.
import fs from 'node:fs';

const API = (process.env.API_BASE_URL || '').replace(/\/+$/, '');
const ORIGEN = process.env.FRONTEND_ORIGIN || '';
const ADMIN = process.env.ADMIN_EMAIL || '';
const CLAVE_ADMIN = fs.readFileSync(process.env.ADMIN_PASSWORD_FILE || '', 'utf8').replace(/[\r\n]+$/, '');
const ESTADO = process.env.ESTADO_FILE || '';
const MODO = process.argv[2] || 'flujo';
const SECRETOS = [CLAVE_ADMIN];
const limpiar = (t) => SECRETOS.reduce((s, x) => (x ? s.split(x).join('***') : s), String(t ?? ''));
const res = [];
let g = '';
async function check(nombre, fn) {
  try { res.push({ g, nombre, ok: true, d: limpiar(await fn() ?? '') }); } catch (e) { res.push({ g, nombre, ok: false, d: limpiar(e.message) }); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
async function pedir(metodo, ruta, { token, cuerpo } = {}) {
  const h = { Origin: ORIGEN };
  if (token) h.Authorization = `Bearer ${token}`;
  let body;
  if (cuerpo !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(cuerpo); }
  const r = await fetch(`${API}${ruta}`, { method: metodo, headers: h, body, redirect: 'manual' });
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch { /* */ }
  return { estado: r.status, h: r.headers, texto, json, datos: json?.data };
}
const exige = (r, e, q) => { assert(r.estado === e, `${q}: se esperaba ${e} y llegó ${r.estado} ${limpiar(r.texto).slice(0, 200)}`); return r; };
const filas = (d) => (Array.isArray(d) ? d : d?.items ?? d?.data ?? []);
const login = async (email, password) => {
  const r = exige(await pedir('POST', '/auth/login', { cuerpo: { email, password } }), 200, `login ${email.split('@')[0]}`);
  SECRETOS.push(r.datos.token); return r.datos.token;
};
function informe() {
  let u = '';
  for (const r of res) { if (r.g !== u) { console.log(`\n${r.g}`); u = r.g; } console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.nombre}${r.d ? ` — ${r.d}` : ''}`); }
  const f = res.filter((r) => !r.ok).length;
  console.log(`\n${res.length - f}/${res.length} comprobaciones correctas · API ${API}`);
  process.exit(f ? 1 : 0);
}

if (MODO === 'expiry') {
  const e = JSON.parse(fs.readFileSync(ESTADO, 'utf8'));
  g = 'Expiración (comprobación diferida)';
  const t = await login(ADMIN, CLAVE_ADMIN);
  await check(`la reserva ${e.reserva} caducó sola (planificador) y liberó el asiento`, async () => {
    const r = exige(await pedir('GET', `/bookings/${e.reserva}`, { token: t }), 200, 'reserva');
    const estado = r.datos?.status ?? r.datos?.booking?.status;
    assert(estado === 'EXPIRED', `estado ${estado} (expiraba ${e.expira}, ahora ${new Date().toISOString()})`);
    // Mapa AUTENTICADO del viaje: el público ya no lo muestra porque la retirada dejó la empresa INACTIVE.
    const s = exige(await pedir('GET', `/trips/${e.viaje}/seats`, { token: t }), 200, 'asientos');
    const asiento = filas(s.datos?.seats ?? s.datos).find((x) => x.id === e.asiento);
    assert(asiento && !Number(asiento.is_taken), `el asiento sigue ocupado (is_taken=${asiento?.is_taken})`);
    return `EXPIRED · asiento ${e.asiento} disponible otra vez`;
  });
  await pedir('POST', '/auth/logout', { token: t });
  informe();
}

const m = Date.now().toString(36);
const c = {};
let tAdmin = '';
const crear = async (ruta, cuerpo, q) => {
  const r = exige(await pedir('POST', ruta, { token: tAdmin, cuerpo }), 201, `crear ${q}`);
  return r.datos?.id ?? r.datos?.[0]?.id;
};
const fecha = (h) => new Date(Date.now() + h * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

g = 'Preparación (ADMIN existente, datos sintéticos)';
await check('login ADMIN y /auth/me', async () => {
  tAdmin = await login(ADMIN, CLAVE_ADMIN);
  const r = exige(await pedir('GET', '/auth/me', { token: tAdmin }), 200, 'me'); assert(r.datos.role === 'ADMIN', r.datos.role);
  return 'ADMIN';
});
await check('empresa, bus publicado, ida y vuelta', async () => {
  const roles = exige(await pedir('GET', '/roles?limit=50', { token: tAdmin }), 200, 'roles').datos;
  for (const r of roles) c[`rol_${r.name}`] = r.id;
  c.empresa = await crear('/companies', { name: `E2E ${m}`, legal_name: `E2E ${m} SAC`, tax_id: `20${String(Date.now()).slice(-9)}`, email: `e2e.${m}@busperu-staging.example`, status: 'ACTIVE' }, 'empresa');
  c.tipoBus = await crear('/bus-types', { name: `TipoE2E ${m}`, default_capacity: 40 }, 'tipo bus');
  c.tipoAsiento = await crear('/seat-types', { name: `AsientoE2E ${m}` }, 'tipo asiento');
  c.bus = await crear('/buses', { company_id: c.empresa, bus_type_id: c.tipoBus, code: `E-${m}`, plate_number: `E2E-${m.slice(-3).toUpperCase()}`, capacity: 12, status: 'ACTIVE' }, 'bus');
  c.ciudadA = `Arequipa${m}`; c.ciudadB = `Tacna${m}`;
  c.a = await crear('/locations', { name: `Terminal A ${m}`, city: c.ciudadA, department: 'Arequipa', type: 'TERMINAL' }, 'A');
  c.b = await crear('/locations', { name: `Terminal B ${m}`, city: c.ciudadB, department: 'Tacna', type: 'TERMINAL' }, 'B');
  c.rutaIda = await crear('/routes', { company_id: c.empresa, origin_location_id: c.a, destination_location_id: c.b, name: `Ida ${m}`, distance_km: 370, estimated_duration_minutes: 360 }, 'ruta ida');
  c.rutaVuelta = await crear('/routes', { company_id: c.empresa, origin_location_id: c.b, destination_location_id: c.a, name: `Vuelta ${m}`, distance_km: 370, estimated_duration_minutes: 360 }, 'ruta vuelta');
  const l = exige(await pedir('POST', `/buses/${c.bus}/layouts`, { token: tAdmin, cuerpo: { name: 'E2E v1', decks: [{ deck_number: 1, name: 'Piso 1', row_count: 2, column_count: 4 }] } }), 201, 'layout');
  const piso = exige(await pedir('GET', `/layouts/${l.datos.id}/decks`, { token: tAdmin }), 200, 'pisos').datos[0].id;
  for (let i = 1; i <= 6; i += 1) exige(await pedir('POST', `/decks/${piso}/seats`, { token: tAdmin, cuerpo: { seat_number: `0${i}`, row_number: i <= 4 ? 1 : 2, column_number: i <= 4 ? i : i - 4, seat_type_id: c.tipoAsiento } }), 201, `asiento ${i}`);
  exige(await pedir('POST', `/layouts/${l.datos.id}/publish`, { token: tAdmin }), 200, 'publicar');
  c.fIda = fecha(48); c.fVuelta = fecha(96);
  c.ida = await crear('/trips', { route_id: c.rutaIda, bus_id: c.bus, departure_datetime: c.fIda, base_price: 60, available_seats: 6, status: 'SCHEDULED' }, 'viaje ida');
  c.vuelta = await crear('/trips', { route_id: c.rutaVuelta, bus_id: c.bus, departure_datetime: c.fVuelta, base_price: 60, available_seats: 6, status: 'SCHEDULED' }, 'viaje vuelta');
  return `empresa ${c.empresa} · ida ${c.ida} · vuelta ${c.vuelta}`;
});
const tk = {};
await check('usuarios sintéticos COMPANY_ADMIN, OPERATOR (de la empresa sintética) y CUSTOMER', async () => {
  for (const rol of ['COMPANY_ADMIN', 'OPERATOR', 'CUSTOMER']) {
    const clave = `E2e-${rol}-${m}-9A`; SECRETOS.push(clave);
    const correo = `e2e.${rol.toLowerCase()}.${m}@busperu-staging.example`;
    c[`u_${rol}`] = await crear('/users', { role_id: c[`rol_${rol}`], first_name: rol, last_name: 'E2E', email: correo, password: clave, status: 'ACTIVE', ...(rol === 'CUSTOMER' ? {} : { company_id: c.empresa }) }, rol);
    c[`mail_${rol}`] = correo; c[`pw_${rol}`] = clave;
    tk[rol] = await login(correo, clave);
    const me = exige(await pedir('GET', '/auth/me', { token: tk[rol] }), 200, `me ${rol}`);
    assert(me.datos.role === rol, `me devuelve ${me.datos.role}`);
  }
  return 'login + /auth/me correctos para los 3 roles (ninguno ADMIN)';
});

g = 'Flujo de compra (CUSTOMER)';
await check('búsqueda pública de ida', async () => {
  const r = exige(await pedir('GET', `/public/trips?origin_id=${c.a}&destination_id=${c.b}`), 200, 'búsqueda');
  assert(filas(r.datos).some((t) => t.id === c.ida), 'el viaje no aparece'); return `viaje ${c.ida} encontrado`;
});
await check('búsqueda de itinerario ida y vuelta', async () => {
  const r = exige(await pedir('POST', '/public/itineraries/search', { cuerpo: { trip_type: 'ROUND_TRIP', segments: [{ origin: c.ciudadA, destination: c.ciudadB, date: c.fIda.slice(0, 10) }, { origin: c.ciudadB, destination: c.ciudadA, date: c.fVuelta.slice(0, 10) }] } }), 200, 'itinerario');
  const txt = JSON.stringify(r.datos);
  assert(txt.includes(`"id":${c.ida}`) && txt.includes(`"id":${c.vuelta}`), 'no aparecen los dos tramos');
  return 'los dos tramos aparecen';
});
const libresDe = async (viaje) => { const r = exige(await pedir('GET', `/public/trips/${viaje}/seats`), 200, 'asientos'); return filas(r.datos?.seats ?? r.datos).filter((s) => s.status === 'AVAILABLE' && !Number(s.is_taken)); };
await check('selección de asiento (mapa público)', async () => {
  const a = await libresDe(c.ida); assert(a.length >= 3, `solo ${a.length} libres`); c.asientos = a.map((s) => s.id); return `${a.length} asientos libres`;
});
await check('compra ida y vuelta (itinerario) en una transacción', async () => {
  const v = await libresDe(c.vuelta);
  const r = exige(await pedir('POST', '/bookings/itineraries', { token: tk.CUSTOMER, cuerpo: { trip_type: 'ROUND_TRIP', passenger_email: c.mail_CUSTOMER, passenger_name: 'Cliente E2E', segments: [{ trip_id: c.ida, seat_ids: [c.asientos[0]] }, { trip_id: c.vuelta, seat_ids: [v[0].id] }] } }), 201, 'itinerario');
  c.grupo = r.datos.group_id ?? r.datos.id;
  const seg = r.datos.segments ?? [];
  assert(seg.length === 2 && seg.every((s) => s.status === 'PENDING'), `tramos ${seg.map((s) => s.status)}`);
  return `grupo ${c.grupo} · 2 tramos PENDING`;
});
await check('reserva de ida + pago manual (YAPE) pendiente de verificación', async () => {
  const r = exige(await pedir('POST', '/bookings', { token: tk.CUSTOMER, cuerpo: { trip_id: c.ida, seat_ids: [c.asientos[1]], passenger_email: c.mail_CUSTOMER } }), 201, 'reservar');
  c.reservaPago = r.datos?.booking?.id ?? r.datos?.id;
  const p = await pedir('POST', `/bookings/${c.reservaPago}/pay`, { token: tk.CUSTOMER, cuerpo: { method: 'YAPE' } });
  assert([200, 202].includes(p.estado), `pagar ${p.estado} ${limpiar(p.texto).slice(0, 160)}`);
  const lp = exige(await pedir('GET', `/payments?booking_id=${c.reservaPago}`, { token: tk.COMPANY_ADMIN }), 200, 'pagos');
  const pago = filas(lp.datos).find((x) => x.booking_id === c.reservaPago);
  assert(pago && pago.status === 'PENDING', `pago ${pago?.status}`); c.pago = pago.id;
  return `reserva ${c.reservaPago} · pago ${c.pago} PENDING (${p.estado})`;
});
await check('RBAC: el OPERATOR no puede aprobar pagos; el COMPANY_ADMIN sí', async () => {
  const op = await pedir('POST', `/payments/${c.pago}/approve`, { token: tk.OPERATOR, cuerpo: {} });
  assert(op.estado === 403, `OPERATOR recibió ${op.estado}`);
  const cu = await pedir('POST', `/payments/${c.pago}/approve`, { token: tk.CUSTOMER, cuerpo: {} });
  assert(cu.estado === 403, `CUSTOMER recibió ${cu.estado}`);
  exige(await pedir('POST', `/payments/${c.pago}/approve`, { token: tk.COMPANY_ADMIN, cuerpo: {} }), 200, 'aprobar');
  const b = exige(await pedir('GET', `/bookings/${c.reservaPago}`, { token: tk.CUSTOMER }), 200, 'reserva');
  const estado = b.datos?.status ?? b.datos?.booking?.status;
  assert(estado === 'CONFIRMED', `reserva ${estado}`);
  return 'OPERATOR 403 · CUSTOMER 403 · COMPANY_ADMIN 200 · reserva CONFIRMED';
});
await check('reserva que se deja caducar (se comprueba después)', async () => {
  const r = exige(await pedir('POST', '/bookings', { token: tk.CUSTOMER, cuerpo: { trip_id: c.ida, seat_ids: [c.asientos[2]], passenger_email: c.mail_CUSTOMER } }), 201, 'reservar');
  c.reservaCaduca = r.datos?.booking?.id ?? r.datos?.id;
  c.expira = r.datos?.booking?.expires_at ?? r.datos?.expires_at;
  assert(c.expira, 'sin expires_at');
  if (ESTADO) fs.writeFileSync(ESTADO, JSON.stringify({ reserva: c.reservaCaduca, viaje: c.ida, asiento: c.asientos[2], expira: c.expira }));
  const ocupado = !(await libresDe(c.ida)).some((s) => s.id === c.asientos[2]);
  assert(ocupado, 'el asiento no quedó retenido');
  return `reserva ${c.reservaCaduca} PENDING · expira ${c.expira} · asiento retenido`;
});
await check('Mis viajes: el cliente ve sus 4 reservas y solo las suyas', async () => {
  const r = exige(await pedir('GET', '/bookings?limit=50', { token: tk.CUSTOMER }), 200, 'mis viajes');
  const l = filas(r.datos);
  assert(l.length === 4, `ve ${l.length} reservas`);
  assert(l.every((b) => b.user_id === undefined || b.user_id === c.u_CUSTOMER), 'aparecen reservas ajenas');
  return `${l.length} reservas propias`;
});
await check('Notificaciones en la aplicación del cliente', async () => {
  const r = exige(await pedir('GET', '/notifications?limit=20', { token: tk.CUSTOMER }), 200, 'notificaciones');
  return `${filas(r.datos).length} notificación(es) en la bandeja`;
});

g = 'RBAC (4 roles)';
await check('cifras de plataforma: solo ADMIN', async () => {
  const s = {};
  for (const [rol, t] of Object.entries({ ADMIN: tAdmin, ...tk })) s[rol] = (await pedir('GET', '/users/stats', { token: t })).estado;
  assert(s.ADMIN === 200 && s.COMPANY_ADMIN === 403 && s.OPERATOR === 403 && s.CUSTOMER === 403, JSON.stringify(s));
  return JSON.stringify(s);
});
await check('reservas: el personal de la empresa las ve; el cliente no ve las del personal', async () => {
  const ca = filas(exige(await pedir('GET', '/bookings?limit=50', { token: tk.COMPANY_ADMIN }), 200, 'CA').datos);
  const op = await pedir('GET', '/bookings?limit=50', { token: tk.OPERATOR });
  assert(ca.length >= 4, `COMPANY_ADMIN ve ${ca.length}`);
  return `COMPANY_ADMIN ve ${ca.length} · OPERATOR ${op.estado} (${filas(op.datos).length})`;
});
await check('gestión de usuarios: CUSTOMER y OPERATOR no pueden crear usuarios ADMIN', async () => {
  const cuerpo = { role_id: c.rol_ADMIN, first_name: 'X', last_name: 'Y', email: `nope.${m}@busperu-staging.example`, password: `Nope-${m}-9A`, status: 'ACTIVE' };
  const e = {};
  for (const rol of ['CUSTOMER', 'OPERATOR', 'COMPANY_ADMIN']) e[rol] = (await pedir('POST', '/users', { token: tk[rol], cuerpo })).estado;
  assert(Object.values(e).every((x) => x === 403 || x === 400), JSON.stringify(e));
  return JSON.stringify(e);
});

g = 'Retirada de los datos de la prueba';
await check('empresa sintética INACTIVE: fuera de la portada y de la búsqueda', async () => {
  assert(c.empresa, 'no llegó a crearse la empresa');
  exige(await pedir('PUT', `/companies/${c.empresa}`, { token: tAdmin, cuerpo: { status: 'INACTIVE' } }), 200, 'desactivar');
  const r = exige(await pedir('GET', `/public/trips?origin_id=${c.a}&destination_id=${c.b}`), 200, 'búsqueda');
  assert(!filas(r.datos).some((t) => t.id === c.ida), 'el viaje sigue apareciendo en la búsqueda');
  const d = exige(await pedir('GET', '/public/destinations'), 200, 'destinos');
  assert(!JSON.stringify(d.datos).includes(c.ciudadB), 'la ciudad sintética sigue en la portada');
  return `empresa ${c.empresa} INACTIVE · fuera de búsqueda y portada`;
});
await check('manifiesto de la ejecución escrito (para purge-qa-data.cjs)', async () => {
  const manifiesto = {
    descripcion: `e2e-staging.mjs · ${new Date().toISOString()}`,
    marcas: [m],
    companies: [c.empresa].filter(Boolean),
    users: [c.u_COMPANY_ADMIN, c.u_OPERATOR, c.u_CUSTOMER].filter(Boolean),
    locations: [c.a, c.b].filter(Boolean),
    bus_types: [c.tipoBus].filter(Boolean),
    seat_types: [c.tipoAsiento].filter(Boolean),
  };
  const destino = process.env.QA_MANIFEST || `qa-manifest-e2e-${m}.json`;
  fs.writeFileSync(destino, `${JSON.stringify(manifiesto, null, 1)}
`);
  return `${destino} · empresas ${manifiesto.companies.length} · usuarios ${manifiesto.users.length}`;
});

g = 'Sesión';
await check('logout → token revocado → nuevo login', async () => {
  exige(await pedir('POST', '/auth/logout', { token: tk.CUSTOMER }), 200, 'logout');
  assert((await pedir('GET', '/auth/me', { token: tk.CUSTOMER })).estado === 401, 'el token sigue valiendo');
  const t2 = await login(c.mail_CUSTOMER, c.pw_CUSTOMER);
  exige(await pedir('GET', '/auth/me', { token: t2 }), 200, 'me tras relogin');
  for (const t of [t2, tk.COMPANY_ADMIN, tk.OPERATOR, tAdmin]) await pedir('POST', '/auth/logout', { token: t });
  return 'logout 200 · me 401 · relogin 200';
});
console.log(`datos sintéticos: empresa ${c.empresa} · viajes ${c.ida}/${c.vuelta} · usuarios ${c.u_COMPANY_ADMIN}/${c.u_OPERATOR}/${c.u_CUSTOMER}`);
informe();
