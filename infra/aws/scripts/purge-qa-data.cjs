// BusPerú · F18-09 · purga FÍSICA de datos sintéticos de QA en STAGING (nunca en producción).
//
//   DB_HOST=… DB_USER=busperu_migrator DB_PASSWORD_FILE=/ruta DB_NAME=busperu_staging STORAGE_DIR=/data/busperu/storage \
//     node purge-qa-data.cjs manifiesto.json            # ENSAYO: hace todo y termina en ROLLBACK
//     node purge-qa-data.cjs manifiesto.json --ejecutar # igual, pero hace COMMIT si todo cuadra
//
// El manifiesto lista EXPLÍCITAMENTE las raíces a borrar (nunca se selecciona por patrón de nombre):
//   { "marcas": ["mufy7aal", …], "companies": [..], "users": [..], "locations": [..], "bus_types": [..],
//     "seat_types": [..], "esperado": { "<tabla>": <filas a borrar>, … } }   // "esperado" es opcional
// Lo dependiente (rutas, viajes, buses, reservas, pagos…) se DERIVA de esas raíces y se comprueba que el conjunto
// es cerrado: ningún dato ajeno cuelga de una raíz sintética ni una raíz sintética de un dato ajeno.
//
// Aborta con ROLLBACK (código 2) ante cualquier discrepancia:
//   · DB_NAME distinto de busperu_staging;
//   · una raíz no existe, no lleva una de las marcas del manifiesto, un usuario no es @busperu-staging.example o es ADMIN;
//   · el conjunto no es cerrado (p. ej. una reserva de un cliente real en un viaje sintético);
//   · filas en tablas que esta purga no contempla (reseñas, liquidaciones, soporte, cupones…) ligadas al conjunto;
//   · los recuentos no coinciden con "esperado";
//   · tras borrar: queda algo del conjunto, o cambió cualquier tabla de configuración o de auditoría.
// audit_logs NO se toca: al borrar un usuario su user_id pasa a NULL (FK SET NULL) y el registro se conserva.
// Tras el COMMIT borra los archivos de logotipo que aún referenciaran las empresas purgadas (solo bajo
// STORAGE_DIR/public/companies/<id>/, con <id> del conjunto). Sin secretos en la salida.
//
// F18-19B (F-03) · también purga lo de F18-19 que cuelga del conjunto:
//   · perfil público: company_profiles, company_services, company_agencies (horarios y servicios por agencia van en
//     columnas JSON de la propia agencia) y company_gallery_images de las empresas del conjunto, y sus imágenes
//     (portada, «nosotros», servicios, agencias y galería; copia de trabajo y publicada) bajo public/companies/<id>/;
//   · Libro de Reclamaciones: las hojas ligadas a una empresa, un usuario o una reserva del conjunto (y sus eventos).
//     Cada una debe ser de un consumidor sintético (@busperu-staging.example) y no estar ligada a nada ajeno: una hoja
//     real ligada a una empresa sintética ABORTA la purga (las hojas se conservan 2 años, DS 011-2011-PCM art. 12).
//     El contador del año solo se borra si todas las hojas de ese año son del conjunto.
'use strict';
const fs = require('fs');
const path = require('path');
const mysql = require(require.resolve('mysql2/promise', { paths: [path.resolve(__dirname, '../../../backend'), process.cwd()] }));

const DOMINIO = '@busperu-staging.example';
// F18-10: los datos DEMO permanentes (seed-demo-staging.mjs) NUNCA se purgan, aunque un manifiesto los listara.
const DOMINIO_DEMO = '@demo.staging.busperu.invalid';
const ES_DEMO = (t) => { const x = String(t ?? ''); return x.endsWith(DOMINIO_DEMO) || /^BusPerú Demo\b|^Terminal Demo |^Demo · /.test(x); };
// Tablas que la purga NO borra: se exige que no tengan nada ligado al conjunto.
const NO_CONTEMPLADAS = [
  ['reviews', 'booking_id', 'K'], ['reviews', 'trip_id', 'T'], ['reviews', 'user_id', 'U'], ['reviews', 'company_id', 'C'],
  ['review_responses', 'user_id', 'U'], ['coupon_usages', 'booking_id', 'K'], ['coupon_usages', 'user_id', 'U'],
  ['settlements', 'company_id', 'C'], ['settlement_items', 'booking_id', 'K'], ['support_tickets', 'user_id', 'U'],
  ['support_tickets', 'booking_id', 'K'], ['support_tickets', 'company_id', 'C'], ['support_messages', 'user_id', 'U'],
  ['route_stops', 'location_id', 'L'], ['trip_seat_type_prices', 'seat_type_id', 'ST'], ['destinations', 'location_id', 'L'],
  ['destinations', 'origin_location_id', 'L'], ['drivers', 'company_id', 'C'], ['company_documents', 'company_id', 'C'],
  ['promotions', 'company_id', 'C'],
];
// Configuración y auditoría: su recuento no puede cambiar.
const INTOCABLES = ['roles', 'permissions', 'role_permissions', 'notification_templates', 'system_settings', 'audit_logs'];

class Aborto extends Error {}
const falla = (m) => { throw new Aborto(m); };
const lista = (x) => (Array.isArray(x) ? [...new Set(x.map(Number))].sort((a, b) => a - b) : []);
const enSql = (ids) => (ids.length ? ids.join(',') : 'NULL');

(async () => {
  const [archivo, modo] = process.argv.slice(2);
  const ejecutar = modo === '--ejecutar';
  if (process.env.DB_NAME !== 'busperu_staging') falla(`DB_NAME no permitido: ${process.env.DB_NAME} (solo busperu_staging)`);
  const m = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  const marcas = (m.marcas || []).map(String).filter((x) => /^[a-z0-9]{6,}$/.test(x));
  if (!marcas.length) falla('el manifiesto no trae marcas válidas');
  const C = lista(m.companies), U = lista(m.users), L = lista(m.locations), BT = lista(m.bus_types), ST = lista(m.seat_types);
  if (U.includes(1)) falla('el usuario 1 (ADMIN de staging) no puede estar en la purga');
  const lleva = (texto) => marcas.some((x) => String(texto ?? '').includes(x));

  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER,
    password: fs.readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').replace(/[\r\n]+$/, ''), database: 'busperu_staging',
    jsonStrings: true, dateStrings: true, multipleStatements: false,
  });
  const q = async (s, p) => (await c.query(s, p))[0];
  const n = async (s, p) => Number((await q(s, p))[0].n);
  const informe = { modo: ejecutar ? 'EJECUTAR' : 'ENSAYO', marcas, raices: { companies: C.length, users: U.length, locations: L.length, bus_types: BT.length, seat_types: ST.length } };
  let logos = [];
  try {
    await c.query('SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await c.beginTransaction();

    // ------------------------------------------------------------ 1. raíces: existen y llevan su marca
    const comprobarRaices = async (tabla, ids, columnas, extra) => {
      if (!ids.length) return;
      const filas = await q(`SELECT id, ${columnas.join(', ')} FROM \`${tabla}\` WHERE id IN (${enSql(ids)}) FOR UPDATE`);
      if (filas.length !== ids.length) falla(`${tabla}: existen ${filas.length} de ${ids.length} ids del manifiesto`);
      for (const f of filas) {
        if (columnas.some((col) => ES_DEMO(f[col]))) falla(`${tabla} ${f.id}: es un dato DEMO permanente; la purga de QA no lo toca`);
        if (!columnas.some((col) => lleva(f[col]))) falla(`${tabla} ${f.id}: no lleva ninguna marca del manifiesto`);
        if (extra) extra(f);
      }
    };
    await comprobarRaices('companies', C, ['name', 'email'], (f) => { if (!String(f.email).endsWith(DOMINIO)) falla(`companies ${f.id}: correo fuera de ${DOMINIO}`); });
    const rolesU = U.length ? await q(`SELECT u.id, r.name rol FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id IN (${enSql(U)})`) : [];
    await comprobarRaices('users', U, ['email'], (f) => {
      if (!String(f.email).endsWith(DOMINIO)) falla(`users ${f.id}: correo fuera de ${DOMINIO}`);
      if (rolesU.find((r) => r.id === f.id)?.rol === 'ADMIN') falla(`users ${f.id}: es ADMIN`);
    });
    await comprobarRaices('locations', L, ['name', 'city']);
    await comprobarRaices('bus_types', BT, ['name']);
    await comprobarRaices('seat_types', ST, ['name']);

    // ------------------------------------------------------------ 2. conjunto derivado y cerrado
    const ids = async (s) => (await q(s)).map((r) => Number(r.id));
    const R = await ids(`SELECT id FROM routes WHERE company_id IN (${enSql(C)})`);
    const B = await ids(`SELECT id FROM buses WHERE company_id IN (${enSql(C)})`);
    const T = await ids(`SELECT id FROM trips WHERE route_id IN (${enSql(R)}) OR bus_id IN (${enSql(B)})`);
    const K = await ids(`SELECT id FROM bookings WHERE trip_id IN (${enSql(T)}) OR user_id IN (${enSql(U)})`);
    const G = await ids(`SELECT id FROM booking_groups WHERE user_id IN (${enSql(U)}) OR id IN (SELECT group_id FROM bookings WHERE id IN (${enSql(K)}))`);
    const P = await ids(`SELECT id FROM payments WHERE booking_id IN (${enSql(K)})`);
    const cerrado = [
      ['viajes sintéticos con ruta o bus ajenos', `SELECT COUNT(*) n FROM trips WHERE id IN (${enSql(T)}) AND (route_id NOT IN (${enSql(R)}) OR bus_id NOT IN (${enSql(B)}))`],
      ['reservas con viaje o cliente ajenos', `SELECT COUNT(*) n FROM bookings WHERE id IN (${enSql(K)}) AND (trip_id NOT IN (${enSql(T)}) OR user_id NOT IN (${enSql(U)}))`],
      ['grupos con reservas ajenas o de otro usuario', `SELECT COUNT(*) n FROM bookings WHERE group_id IN (${enSql(G)}) AND id NOT IN (${enSql(K)})`],
      ['grupos de usuarios ajenos', `SELECT COUNT(*) n FROM booking_groups WHERE id IN (${enSql(G)}) AND user_id NOT IN (${enSql(U)})`],
      ['rutas sintéticas con ubicaciones ajenas', `SELECT COUNT(*) n FROM routes WHERE id IN (${enSql(R)}) AND (origin_location_id NOT IN (${enSql(L)}) OR destination_location_id NOT IN (${enSql(L)}))`],
      ['ubicaciones sintéticas usadas por rutas ajenas', `SELECT COUNT(*) n FROM routes WHERE id NOT IN (${enSql(R)}) AND (origin_location_id IN (${enSql(L)}) OR destination_location_id IN (${enSql(L)}))`],
      ['tipos de bus sintéticos en buses ajenos', `SELECT COUNT(*) n FROM buses WHERE bus_type_id IN (${enSql(BT)}) AND id NOT IN (${enSql(B)})`],
      ['tipos de asiento sintéticos en asientos ajenos', `SELECT COUNT(*) n FROM seats WHERE seat_type_id IN (${enSql(ST)}) AND bus_id NOT IN (${enSql(B)})`],
      ['vínculos empresa-usuario mixtos', `SELECT COUNT(*) n FROM company_users WHERE (company_id IN (${enSql(C)})) <> (user_id IN (${enSql(U)}))`],
      ['llaves de API de usuarios sintéticos en empresas ajenas', `SELECT COUNT(*) n FROM api_keys WHERE user_id IN (${enSql(U)}) AND (company_id IS NULL OR company_id NOT IN (${enSql(C)}))`],
      ['movimientos contables ajenos ligados al conjunto', `SELECT COUNT(*) n FROM financial_transactions WHERE (company_id IN (${enSql(C)}) OR user_id IN (${enSql(U)})) AND (booking_id IS NULL OR booking_id NOT IN (${enSql(K)}))`],
      ['reembolsos ligados al conjunto', `SELECT COUNT(*) n FROM refunds WHERE booking_id IN (${enSql(K)}) OR payment_id IN (${enSql(P)})`],
    ];
    // F18-19: hojas del Libro de Reclamaciones ligadas al conjunto.
    const LR = await ids(`SELECT id FROM complaint_book_entries WHERE company_id IN (${enSql(C)}) OR user_id IN (${enSql(U)}) OR booking_id IN (${enSql(K)})`);
    cerrado.push(
      ['hojas del Libro ligadas también a una empresa, usuario o reserva ajenos', `SELECT COUNT(*) n FROM complaint_book_entries WHERE id IN (${enSql(LR)}) AND ((company_id IS NOT NULL AND company_id NOT IN (${enSql(C)})) OR (user_id IS NOT NULL AND user_id NOT IN (${enSql(U)})) OR (booking_id IS NOT NULL AND booking_id NOT IN (${enSql(K)})))`],
      ['hojas del Libro de consumidores reales ligadas al conjunto (se conservan 2 años)', `SELECT COUNT(*) n FROM complaint_book_entries WHERE id IN (${enSql(LR)}) AND consumer_email NOT LIKE '%${DOMINIO}'`],
    );
    for (const [que, sql] of cerrado) { const x = await n(sql); if (x) falla(`conjunto no cerrado: ${que} (${x})`); }
    for (const [t, col, conj] of NO_CONTEMPLADAS) {
      const set = { C, U, L, T, K, ST }[conj];
      const x = await n(`SELECT COUNT(*) n FROM \`${t}\` WHERE \`${col}\` IN (${enSql(set)})`);
      if (x) falla(`${t}.${col}: ${x} fila(s) ligadas al conjunto; esta purga no las contempla`);
    }

    // ------------------------------------------------------------ 3. recuentos previstos
    const aBorrar = {
      companies: C.length, users: U.length, locations: L.length, bus_types: BT.length, seat_types: ST.length,
      routes: R.length, trips: T.length, buses: B.length, bookings: K.length, booking_groups: G.length, payments: P.length,
      booking_seats: await n(`SELECT COUNT(*) n FROM booking_seats WHERE booking_id IN (${enSql(K)})`),
      financial_transactions: await n(`SELECT COUNT(*) n FROM financial_transactions WHERE booking_id IN (${enSql(K)})`),
      bus_layouts: await n(`SELECT COUNT(*) n FROM bus_layouts WHERE bus_id IN (${enSql(B)})`),
      bus_layout_decks: await n(`SELECT COUNT(*) n FROM bus_layout_decks WHERE layout_id IN (SELECT id FROM bus_layouts WHERE bus_id IN (${enSql(B)}))`),
      bus_layout_elements: await n(`SELECT COUNT(*) n FROM bus_layout_elements WHERE deck_id IN (SELECT d.id FROM bus_layout_decks d JOIN bus_layouts l ON l.id = d.layout_id WHERE l.bus_id IN (${enSql(B)}))`),
      seats: await n(`SELECT COUNT(*) n FROM seats WHERE bus_id IN (${enSql(B)})`),
      company_users: await n(`SELECT COUNT(*) n FROM company_users WHERE company_id IN (${enSql(C)})`),
      company_commission_settings: await n(`SELECT COUNT(*) n FROM company_commission_settings WHERE company_id IN (${enSql(C)})`),
      company_bank_accounts: await n(`SELECT COUNT(*) n FROM company_bank_accounts WHERE company_id IN (${enSql(C)})`),
      company_integrations: await n(`SELECT COUNT(*) n FROM company_integrations WHERE company_id IN (${enSql(C)})`),
      api_keys: await n(`SELECT COUNT(*) n FROM api_keys WHERE company_id IN (${enSql(C)}) OR user_id IN (${enSql(U)})`),
      notifications: await n(`SELECT COUNT(*) n FROM notifications WHERE user_id IN (${enSql(U)})`),
      revoked_sessions: await n(`SELECT COUNT(*) n FROM revoked_sessions WHERE user_id IN (${enSql(U)})`),
      // F18-19 (en cascada al borrar la empresa o la hoja; se cuentan igual para las postcondiciones)
      company_profiles: await n(`SELECT COUNT(*) n FROM company_profiles WHERE company_id IN (${enSql(C)})`),
      company_services: await n(`SELECT COUNT(*) n FROM company_services WHERE company_id IN (${enSql(C)})`),
      company_agencies: await n(`SELECT COUNT(*) n FROM company_agencies WHERE company_id IN (${enSql(C)})`),
      company_gallery_images: await n(`SELECT COUNT(*) n FROM company_gallery_images WHERE company_id IN (${enSql(C)})`),
      complaint_book_entries: LR.length,
      complaint_book_events: await n(`SELECT COUNT(*) n FROM complaint_book_events WHERE entry_id IN (${enSql(LR)})`),
    };
    // Contador del Libro: solo se retira el de un año cuyas hojas son TODAS del conjunto (si no, el correlativo sigue).
    const aniosLR = LR.length ? (await q(`SELECT DISTINCT YEAR(created_at) y FROM complaint_book_entries WHERE id IN (${enSql(LR)})`)).map((r) => Number(r.y)) : [];
    const contadores = [];
    for (const y of aniosLR) if (!(await n(`SELECT COUNT(*) n FROM complaint_book_entries WHERE YEAR(created_at) = ${Number(y)} AND id NOT IN (${enSql(LR)})`))) contadores.push(y);
    aBorrar.complaint_book_counters = contadores.length ? await n(`SELECT COUNT(*) n FROM complaint_book_counters WHERE year IN (${contadores.join(',')})`) : 0;
    informe.a_borrar = aBorrar;
    for (const [t, v] of Object.entries(m.esperado || {})) {
      if (aBorrar[t] === undefined) falla(`esperado.${t}: tabla no contemplada por la purga`);
      if (Number(v) !== aBorrar[t]) falla(`recuento distinto del manifiesto: ${t} esperado ${v}, hay ${aBorrar[t]}`);
    }
    const antes = {};
    const todas = (await q("SELECT table_name t FROM information_schema.tables WHERE table_schema = 'busperu_staging' AND table_type = 'BASE TABLE'")).map((r) => r.t);
    for (const t of todas) antes[t] = await n(`SELECT COUNT(*) n FROM \`${t}\``);
    logos = (await q(`SELECT id, logo_url FROM companies WHERE id IN (${enSql(C)}) AND logo_url IS NOT NULL`)).map((r) => ({ id: Number(r.id), url: r.logo_url }));
    // F18-19: imágenes del perfil público (copia de trabajo y publicada) de las empresas del conjunto.
    const textos = [
      ...(await q(`SELECT company_id id, CONCAT_WS(' ', cover_image, about_image, published_content) t FROM company_profiles WHERE company_id IN (${enSql(C)})`)),
      ...(await q(`SELECT company_id id, CONCAT_WS(' ', image, published_content) t FROM company_services WHERE company_id IN (${enSql(C)})`)),
      ...(await q(`SELECT company_id id, CONCAT_WS(' ', image, published_content) t FROM company_agencies WHERE company_id IN (${enSql(C)})`)),
      ...(await q(`SELECT company_id id, CONCAT_WS(' ', image, published_content) t FROM company_gallery_images WHERE company_id IN (${enSql(C)})`)),
    ];
    const vistos = new Set();
    for (const r of textos) {
      for (const x of String(r.t ?? '').matchAll(/public\/companies\/(\d+)\/[a-f0-9]{32}\.(?:png|jpe?g|webp)/g)) {
        if (Number(x[1]) !== Number(r.id)) falla(`imagen de otra empresa referenciada por la empresa ${r.id}: ${x[0]}`);
        if (!vistos.has(x[0]) && !logos.some((l) => l.url === x[0])) { vistos.add(x[0]); logos.push({ id: Number(r.id), url: x[0] }); }
      }
    }
    informe.imagenes_perfil = vistos.size;

    // ------------------------------------------------------------ 4. borrado (orden que respeta las FK RESTRICT)
    const borrados = {};
    const del = async (clave, sql) => { const [r] = await c.query(sql); borrados[clave] = (borrados[clave] || 0) + r.affectedRows; };
    await del('financial_transactions', `DELETE FROM financial_transactions WHERE booking_id IN (${enSql(K)})`);
    await del('payments', `DELETE FROM payments WHERE id IN (${enSql(P)})`);
    await del('bookings', `DELETE FROM bookings WHERE id IN (${enSql(K)})`);                 // + booking_seats (CASCADE)
    await del('booking_groups', `DELETE FROM booking_groups WHERE id IN (${enSql(G)})`);
    await del('trips', `DELETE FROM trips WHERE id IN (${enSql(T)})`);
    await del('complaint_book_entries', `DELETE FROM complaint_book_entries WHERE id IN (${enSql(LR)})`);   // + eventos (CASCADE)
    if (contadores.length) await del('complaint_book_counters', `DELETE FROM complaint_book_counters WHERE year IN (${contadores.join(',')})`);
    await del('companies', `DELETE FROM companies WHERE id IN (${enSql(C)})`);              // + rutas, buses, llaves, cuentas, perfil público…
    await del('locations', `DELETE FROM locations WHERE id IN (${enSql(L)})`);
    await del('bus_types', `DELETE FROM bus_types WHERE id IN (${enSql(BT)})`);
    await del('seat_types', `DELETE FROM seat_types WHERE id IN (${enSql(ST)})`);
    await del('api_keys', `DELETE FROM api_keys WHERE user_id IN (${enSql(U)})`);
    await del('users', `DELETE FROM users WHERE id IN (${enSql(U)})`);                       // + notificaciones, sesiones…
    informe.borrados_directos = borrados;

    // ------------------------------------------------------------ 5. postcondiciones
    const despues = {};
    for (const t of todas) despues[t] = await n(`SELECT COUNT(*) n FROM \`${t}\``);
    const diferencia = Object.fromEntries(todas.filter((t) => antes[t] !== despues[t]).map((t) => [t, antes[t] - despues[t]]));
    informe.diferencia = diferencia;
    for (const t of INTOCABLES) if (antes[t] !== despues[t]) falla(`postcondición: ${t} cambió (${antes[t]} → ${despues[t]})`);
    for (const [t, v] of Object.entries(diferencia)) {
      if (INTOCABLES.includes(t)) continue;
      if (aBorrar[t] === undefined) falla(`postcondición: ${t} perdió ${v} fila(s) y no estaba previsto`);
      if (aBorrar[t] !== v) falla(`postcondición: ${t} perdió ${v} y se esperaban ${aBorrar[t]}`);
    }
    for (const [t, v] of Object.entries(aBorrar)) if (v && diferencia[t] !== v) falla(`postcondición: ${t} debía perder ${v} y perdió ${diferencia[t] || 0}`);
    const admin = await n("SELECT COUNT(*) n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'ADMIN' AND u.status = 'ACTIVE'");
    if (admin < 1) falla('postcondición: no queda ningún ADMIN activo');
    informe.quedan = Object.fromEntries(['users', 'companies', 'locations', 'trips', 'bookings', 'company_profiles', 'complaint_book_entries', ...INTOCABLES].map((t) => [t, despues[t]]));

    if (ejecutar) { await c.commit(); informe.resultado = 'COMMIT'; } else { await c.rollback(); informe.resultado = 'ROLLBACK (ensayo)'; }
  } catch (e) {
    await c.rollback().catch(() => {});
    await c.end();
    console.log(JSON.stringify({ ...informe, resultado: 'ABORTADO · ROLLBACK', motivo: e instanceof Aborto ? e.message : `${e.code || ''} ${String(e.message).slice(0, 200)}` }, null, 1));
    process.exit(2);
  }
  await c.end();

  // ------------------------------------------------------------ 6. archivos de logotipo (solo tras COMMIT)
  informe.archivos = [];
  if (ejecutar && logos.length) {
    const base = path.resolve(process.env.STORAGE_DIR || '', 'public', 'companies');
    for (const { id, url } of logos) {
      const destino = path.resolve(process.env.STORAGE_DIR || '', url);
      const dentro = destino.startsWith(`${base}${path.sep}${id}${path.sep}`) && /^public\/companies\/\d+\/[a-f0-9]{32}\.(png|jpe?g|webp)$/.test(url);
      if (!process.env.STORAGE_DIR || !dentro) { informe.archivos.push({ id, url, estado: 'NO BORRADO (ruta fuera de lo permitido)' }); continue; }
      try { fs.unlinkSync(destino); informe.archivos.push({ id, url, estado: 'borrado' }); } catch (e) { informe.archivos.push({ id, url, estado: `no borrado: ${e.code}` }); }
    }
  }
  // Carpetas public/companies/<id> de las empresas purgadas: se retiran SOLO si están vacías (rmdir falla si no).
  if (ejecutar && process.env.STORAGE_DIR) {
    const base = path.resolve(process.env.STORAGE_DIR, 'public', 'companies');
    for (const id of lista(JSON.parse(fs.readFileSync(archivo, 'utf8')).companies)) {
      const dir = path.join(base, String(id));
      if (!fs.existsSync(dir)) continue;
      try { fs.rmdirSync(dir); informe.archivos.push({ id, dir: `public/companies/${id}`, estado: 'carpeta vacía retirada' }); } catch (e) { informe.archivos.push({ id, dir: `public/companies/${id}`, estado: `carpeta conservada: ${e.code}` }); }
    }
  }
  console.log(JSON.stringify(informe, null, 1));
})().catch((e) => { console.log(JSON.stringify({ resultado: 'ABORTADO', motivo: e instanceof Aborto ? e.message : String(e.message).slice(0, 200) })); process.exit(2); });
