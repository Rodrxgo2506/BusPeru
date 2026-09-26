// BusPerú · F18-18 · estructura de Parameter Store de PRODUCCIÓN (infra/aws/parameters/prod-parameters.json).
//
//   node infra/aws/scripts/prod-parameters.mjs plan                               # sin AWS: tabla de lo que hace falta
//   AWS_PROFILE=… node infra/aws/scripts/prod-parameters.mjs verificar            # SOLO metadatos: nunca lee un valor
//   AWS_PROFILE=… node infra/aws/scripts/prod-parameters.mjs generar <nombre> [--ejecutar]
//   AWS_PROFILE=… node infra/aws/scripts/prod-parameters.mjs fijos [--ejecutar]   # los String de valor conocido
//
// · `verificar` usa describe-parameters (nombre, tipo, clave KMS y versión): comprueba que estén los obligatorios,
//   que cada SecureString use SU CMK (secretos o datos) y que no exista ninguno prohibido ni ninguno fuera del
//   manifiesto. No descifra nada: el operador de producción no puede descifrar (solo cifra), y no hace falta.
// · `generar` crea un secreto aleatorio (formatos que aceptan los guards de la API y db-common.sh) y lo escribe
//   con `--no-overwrite`: nunca pisa un valor existente. El valor no se imprime ni pasa por la línea de órdenes:
//   va en un archivo temporal 0600 que se borra al terminar. F18-08: ejecutarlo en CloudShell, no en un
//   equipo personal.
// · Los secretos de terceros (Resend, Culqi, OAuth) NO pasan por este script: los carga el propietario en su
//   terminal con `aws ssm put-parameter --type SecureString --key-id <alias> --value file://<archivo 0600>`.
// · Sin --ejecutar, `generar` y `fijos` solo dicen lo que harían.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const M = JSON.parse(fs.readFileSync(path.join(AQUI, '../parameters/prod-parameters.json'), 'utf8'));
const [orden, nombreArg] = process.argv.slice(2);
const EJECUTAR = process.argv.includes('--ejecutar');
const log = (m) => process.stdout.write(`${m}\n`);
const parar = (m) => { process.stderr.write(`DETENIDO: ${m}\n`); process.exit(2); };
const completo = (p) => `${M.prefijo}${p.nombre}`;

const FORMATOS = {
  db: () => randomBytes(32).toString('base64url'),     // ^[A-Za-z0-9_-]{43}$ (db-common.sh: validar_clave)
  jwt: () => randomBytes(48).toString('base64url'),    // 64 caracteres (secrets-guard: ≥ 32 y ≥ 10 distintos)
  clave32: () => randomBytes(32).toString('hex'),      // 32 bytes en hex (INTEGRATIONS_ENCRYPTION_KEY)
  hex32: () => randomBytes(32).toString('hex'),        // cabecera de origen / segmento del webhook
};

function aws(...a) {
  const r = spawnSync('aws', [...a, '--region', M.region, '--output', 'json'], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  if (r.error) parar(`no se pudo ejecutar aws: ${r.error.message}`);
  if (r.status !== 0) parar(`aws ${a.slice(0, 2).join(' ')}: ${(r.stderr || '').trim().replace(/\b\d{12}\b/g, '<cuenta>')}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
}
function identidad() {
  const yo = aws('sts', 'get-caller-identity');
  if (/:root$/.test(yo.Arn)) parar('no con la cuenta raíz');
  log(`identidad ${yo.Arn.replace(/\b\d{12}\b/g, '<cuenta>')}`);
}

if (orden === 'plan') {
  log(`${'parámetro'.padEnd(36)} ${'tipo'.padEnd(12)} ${'CMK'.padEnd(9)} ${'req.'.padEnd(5)} origen`);
  for (const p of M.parametros) log(`${completo(p).padEnd(36)} ${p.tipo.padEnd(12)} ${(p.clave ?? '-').padEnd(9)} ${(p.requerido ? 'sí' : 'no').padEnd(5)} ${p.origen}${p.valor ? ` = ${p.valor}` : ''}${p.salida ? ` ← ${p.salida}` : ''}`);
  log(`\n${M.parametros.length} parámetros · ${M.parametros.filter((p) => p.requerido).length} obligatorios · prohibidos: ${M.prohibidos.join(', ')}`);
} else if (orden === 'verificar') {
  identidad();
  const alias = Object.fromEntries(aws('kms', 'list-aliases').Aliases.filter((a) => Object.values(M.claves).includes(a.AliasName)).map((a) => [a.AliasName, a.TargetKeyId]));
  for (const a of Object.values(M.claves)) if (!alias[a]) parar(`no existe la CMK ${a}`);
  const existentes = new Map();
  let token;
  do {
    const r = aws('ssm', 'describe-parameters', '--parameter-filters', `Key=Path,Option=Recursive,Values=${M.prefijo.replace(/\/$/, '')}`, ...(token ? ['--next-token', token] : []));
    for (const p of r.Parameters ?? []) existentes.set(p.Name, p);
    token = r.NextToken;
  } while (token);
  const problemas = [];
  for (const p of M.parametros) {
    const e = existentes.get(completo(p));
    if (!e) { if (p.requerido) problemas.push(`falta ${completo(p)} (${p.origen})`); continue; }
    if (e.Type !== p.tipo) problemas.push(`${completo(p)} es ${e.Type} y debe ser ${p.tipo}`);
    if (p.tipo === 'SecureString') {
      const clave = String(e.KeyId ?? '');
      const esperado = M.claves[p.clave];
      if (clave !== esperado && !clave.endsWith(alias[esperado])) problemas.push(`${completo(p)} no usa ${esperado}`);
    }
  }
  const conocidos = new Set(M.parametros.map(completo));
  for (const n of existentes.keys()) {
    if (M.prohibidos.some((x) => n === `${M.prefijo}${x}`)) problemas.push(`${n} está PROHIBIDO en producción`);
    else if (!conocidos.has(n)) problemas.push(`${n} no está en el manifiesto`);
  }
  log(`${existentes.size} parámetros en ${M.prefijo} · ${M.parametros.filter((p) => p.requerido).length} obligatorios en el manifiesto`);
  if (problemas.length) { log(`✖ ${problemas.length}:\n - ${problemas.join('\n - ')}`); process.exit(1); }
  log('✔ estructura completa y cada SecureString con su CMK (sin leer ningún valor)');
} else if (orden === 'generar') {
  const p = M.parametros.find((x) => x.nombre === nombreArg);
  if (!p) parar(`${nombreArg} no está en el manifiesto`);
  if (p.origen !== 'generado' || !FORMATOS[p.formato]) parar(`${completo(p)} no se genera (origen ${p.origen})`);
  if (!EJECUTAR) { log(`SIMULACIÓN: generaría ${completo(p)} (${p.formato}) como SecureString con ${M.claves[p.clave]} y --no-overwrite`); process.exit(0); }
  identidad();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'busperu-param-'));
  const archivo = path.join(dir, 'entrada.json');
  try {
    fs.writeFileSync(archivo, JSON.stringify({ Name: completo(p), Type: 'SecureString', KeyId: M.claves[p.clave], Value: FORMATOS[p.formato](), Description: `BusPeru prod · ${p.nota ?? p.nombre}`.slice(0, 1000) }), { mode: 0o600 });
    aws('ssm', 'put-parameter', '--cli-input-json', `file://${archivo}`, '--no-overwrite');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  log(`✔ ${completo(p)} creado (valor no mostrado)${p.nombre.includes('INTEGRATIONS_ENCRYPTION_KEY') ? ' · ATENCIÓN: haz ya la copia fuera de línea (emergencia)' : ''}`);
} else if (orden === 'fijos') {
  const fijos = M.parametros.filter((p) => p.origen === 'fijo' && p.tipo === 'String' && p.requerido);
  if (!EJECUTAR) { for (const p of fijos) log(`SIMULACIÓN: ${completo(p)} = ${p.valor}`); process.exit(0); }
  identidad();
  for (const p of fijos) {
    aws('ssm', 'put-parameter', '--name', completo(p), '--type', 'String', '--value', p.valor, '--no-overwrite');
    log(`✔ ${completo(p)} = ${p.valor}`);
  }
} else {
  parar('uso: prod-parameters.mjs plan | verificar | generar <nombre> [--ejecutar] | fijos [--ejecutar]');
}
