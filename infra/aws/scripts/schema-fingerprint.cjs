// BusPerú · F18-03 · huella del esquema (solo lectura de information_schema) comparada con la
// referencia validada en F18-02B sobre MariaDB 10.11.19 (dump + 001→018).
//
//   DB_HOST=… DB_PORT=3306 DB_USER=busperu_migrator DB_PASSWORD_FILE=/ruta DB_NAME=busperu_staging \
//     node infra/aws/scripts/schema-fingerprint.cjs
//
// La contraseña se lee de un archivo (nunca de la línea de órdenes). Sale con código 1 si la huella
// no coincide y enumera qué parte difiere. Además comprueba las reglas que F18-02B dejó fijadas:
// columnas generadas STORED, `ON UPDATE RESTRICT` en las dos claves, columnas JSON como texto
// (jsonStrings) y utf8mb4_unicode_ci en todas las tablas.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require(require.resolve('mysql2/promise', { paths: [path.resolve(__dirname, '../../../backend'), process.cwd()] }));

const REFERENCIA = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema-reference.json'), 'utf8'));

(async () => {
  const base = process.env.DB_NAME;
  if (!base || base === 'busperu' || base === 'busperu_test') throw new Error(`DB_NAME no permitido: ${base}`);
  const password = fs.readFileSync(process.env.DB_PASSWORD_FILE || '', 'utf8').replace(/[\r\n]+$/, '');
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password,
    database: base, jsonStrings: true,
  });
  const q = async (sql) => (await c.query(sql, [base]))[0];

  // Mismas consultas y normalización que en F18-02B: si cambian, la referencia deja de valer.
  const cols = await q('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,GENERATION_EXPRESSION,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY 1,2');
  const idx = await q('SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? GROUP BY 1,2,3 ORDER BY 1,2');
  const fks = await q('SELECT r.TABLE_NAME,r.CONSTRAINT_NAME,r.REFERENCED_TABLE_NAME,r.UPDATE_RULE,r.DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS r WHERE r.CONSTRAINT_SCHEMA=? ORDER BY 1,2');
  const chk = await q('SELECT TABLE_NAME,CONSTRAINT_NAME,CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=? ORDER BY 1,2');
  const norm = (o) => JSON.stringify(o).replace(/"COLUMN_DEFAULT":"NULL"/g, '"COLUMN_DEFAULT":null');
  const partes = { columnas: cols.map(norm), indices: idx.map(norm), fks: fks.map(norm), checks: chk.map(norm) };
  const hash = (k) => crypto.createHash('sha256').update(partes[k].join('\n')).digest('hex').slice(0, 12);

  const problemas = [];
  const [[v]] = await c.query('SELECT VERSION() v, @@GLOBAL.sql_mode g, @@SESSION.sql_mode s, @@GLOBAL.time_zone tz, @@character_set_server cs');
  console.log(`servidor ${v.v} · sql_mode global ${v.g} · time_zone ${v.tz} · character_set_server ${v.cs}`);
  if (!/^10\.11\./.test(v.v)) problemas.push(`versión ${v.v}: se esperaba 10.11.x`);
  if (v.g !== REFERENCIA.sql_mode) problemas.push(`sql_mode global ${v.g}`);

  for (const k of Object.keys(partes)) {
    const ok = partes[k].length === REFERENCIA[k].total && hash(k) === REFERENCIA[k].huella;
    console.log(`${ok ? '✔' : '✖'} ${k.padEnd(9)} ${String(partes[k].length).padStart(3)} [${hash(k)}]  referencia ${REFERENCIA[k].total} [${REFERENCIA[k].huella}]`);
    if (!ok) problemas.push(`${k} distinto de la referencia`);
  }

  const generadas = cols.filter((r) => r.GENERATION_EXPRESSION).map((r) => `${r.TABLE_NAME}.${r.COLUMN_NAME}:${r.EXTRA}`);
  if (generadas.sort().join() !== 'bus_layouts.published_scope:STORED GENERATED,company_integrations.company_scope:STORED GENERATED') problemas.push(`columnas generadas: ${generadas}`);
  const reglas = fks.filter((r) => ['fk_integrations_company', 'fk_bus_layouts_bus'].includes(r.CONSTRAINT_NAME)).map((r) => `${r.CONSTRAINT_NAME}:${r.UPDATE_RULE}/${r.DELETE_RULE}`);
  if (reglas.sort().join() !== 'fk_bus_layouts_bus:RESTRICT/CASCADE,fk_integrations_company:RESTRICT/CASCADE') problemas.push(`claves 018: ${reglas}`);
  const [tablas] = await c.query("SELECT TABLE_NAME t, TABLE_COLLATION k FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE'", [base]);
  const otras = tablas.filter((t) => t.k !== 'utf8mb4_unicode_ci');
  console.log(`tablas ${tablas.length} · con otra colación: ${otras.length}`);
  if (tablas.length !== REFERENCIA.tablas) problemas.push(`tablas ${tablas.length}, se esperaban ${REFERENCIA.tablas}`);
  if (otras.length) problemas.push(`tablas sin utf8mb4_unicode_ci: ${otras.map((t) => t.t)}`);
  const [[j]] = await c.query("SELECT JSON_OBJECT('a', 1) AS j");
  console.log(`columnas JSON con jsonStrings: ${typeof j.j}`);
  if (typeof j.j !== 'string') problemas.push('las columnas JSON no llegan como texto');

  await c.end();
  if (problemas.length) { console.error(`✖ ${problemas.length} diferencia(s):\n - ${problemas.join('\n - ')}`); process.exit(1); }
  console.log('✔ Esquema idéntico a la referencia (schema-reference.json).');
})().catch((e) => { console.error('ERROR', e.code || e.message); process.exit(1); });
