// BusPerú · F18-03B · inicializa `platform.default_commission` en una instalación nueva.
//
//   API_BASE_URL=https://API_DOMAIN/api ADMIN_EMAIL=admin@… ADMIN_PASSWORD_FILE=/ruta/admin.pw \
//   PLATFORM_DEFAULT_COMMISSION=<porcentaje decidido por negocio> \
//     node infra/aws/scripts/set-platform-commission.mjs
//
// POR QUÉ HACE FALTA. El dump solo trae el catálogo de RBAC y ninguna migración crea este ajuste;
// solo lo siembran el seed de desarrollo y las fixtures de prueba. Sin él, la API se niega a dar de
// alta o aprobar empresas (409) —a propósito: nunca vende asumiendo una comisión de 0—.
//
// POR QUÉ NO TRAE VALOR. El proyecto no documenta ninguna comisión de negocio: el 10.00 del seed es
// un dato de ejemplo de desarrollo. El porcentaje lo decide el negocio y se pasa explícitamente; sin
// él, este script no hace nada.
//
// CÓMO. Por la API y con el ADMIN, igual que el panel: pasa por el RBAC (solo ADMIN puede escribir
// ajustes de plataforma) y queda en la auditoría. Aplica la misma regla que el servicio que la lee
// (`company-commission.service.ts`): hasta 3 enteros y 2 decimales, y como mucho 100. Es idempotente:
// si ya tiene ese valor no escribe; si tiene otro, lo cambia solo con PLATFORM_COMMISSION_OVERWRITE=1.
import fs from 'node:fs';

const API = (process.env.API_BASE_URL || '').replace(/\/+$/, '');
const ADMIN = process.env.ADMIN_EMAIL || '';
const VALOR = (process.env.PLATFORM_DEFAULT_COMMISSION ?? '').trim();
const SOBRESCRIBIR = process.env.PLATFORM_COMMISSION_OVERWRITE === '1';
const CLAVE = 'platform.default_commission';

const salir = (mensaje, codigo = 1) => { console.error(mensaje); process.exit(codigo); };
if (!API || !ADMIN || !process.env.ADMIN_PASSWORD_FILE) salir('Faltan API_BASE_URL, ADMIN_EMAIL o ADMIN_PASSWORD_FILE.', 2);
if (VALOR === '') salir('PLATFORM_DEFAULT_COMMISSION es obligatorio y no tiene valor por defecto: es una decisión de negocio.', 2);
// Misma regla que `porcentajeValido` en backend/src/services/company-commission.service.ts.
if (!/^\d{1,3}(\.\d{1,2})?$/.test(VALOR) || Number(VALOR) > 100) salir(`Porcentaje no válido: "${VALOR}". Usa hasta 3 enteros y 2 decimales, entre 0 y 100.`, 2);

const clave = fs.readFileSync(process.env.ADMIN_PASSWORD_FILE, 'utf8').replace(/[\r\n]+$/, '');
async function pedir(metodo, ruta, token, cuerpo) {
  const r = await fetch(`${API}${ruta}`, {
    method: metodo,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* sin cuerpo JSON */ }
  return { estado: r.status, datos: json?.data, mensaje: json?.message };
}

const login = await pedir('POST', '/auth/login', null, { email: ADMIN, password: clave });
if (login.estado !== 200 || !login.datos?.token) salir(`No se pudo iniciar sesión como administrador (${login.estado}).`);
const token = login.datos.token;
// Dentro de la sesión los errores se lanzan (no process.exit) para que el `finally` cierre siempre la sesión.
const fallar = (mensaje) => { throw new Error(mensaje); };
try {
  const lista = await pedir('GET', `/system-settings?search=${encodeURIComponent(CLAVE)}&limit=50`, token);
  if (lista.estado !== 200) fallar(`No se pudieron leer los ajustes (${lista.estado}): ${lista.mensaje ?? ''}`);
  const filas = Array.isArray(lista.datos) ? lista.datos : lista.datos?.items ?? [];
  const actual = filas.find((f) => f.setting_key === CLAVE);

  if (!actual) {
    const r = await pedir('POST', '/system-settings', token, {
      setting_key: CLAVE, setting_value: VALOR, setting_type: 'DECIMAL', is_public: false,
      description: 'Comisión por defecto de la plataforma (%): se copia a cada empresa al aprobarla',
    });
    if (r.estado !== 201) fallar(`No se pudo crear el ajuste (${r.estado}): ${r.mensaje ?? ''}`);
    console.log(`✔ ${CLAVE} creada con ${VALOR} %`);
  } else if (actual.setting_value === VALOR && actual.setting_type === 'DECIMAL') {
    console.log(`✔ ${CLAVE} ya estaba en ${VALOR} %: no se cambia nada`);
  } else if (!SOBRESCRIBIR) {
    fallar(`${CLAVE} ya existe con "${actual.setting_value}" (${actual.setting_type}). No se sobrescribe sin PLATFORM_COMMISSION_OVERWRITE=1.\n` +
      'Recuerda: cambiarla no afecta a las empresas ya aprobadas, que conservan su propia tasa.');
  } else {
    const r = await pedir('PUT', `/system-settings/${actual.id}`, token, { setting_value: VALOR, setting_type: 'DECIMAL' });
    if (r.estado !== 200) fallar(`No se pudo actualizar el ajuste (${r.estado}): ${r.mensaje ?? ''}`);
    console.log(`✔ ${CLAVE} cambiada de "${actual.setting_value}" a ${VALOR} % (las empresas ya aprobadas conservan su tasa)`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pedir('POST', '/auth/logout', token);
}
