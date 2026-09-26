// BusPerú · F18-18 · publica el frontend (SPA) en el bucket privado del entorno e invalida CloudFront.
//
//   AWS_PROFILE=<sesión MFA> node infra/aws/scripts/publish-web.mjs --env <staging|prod> --release <id> [--dist <dir>] [--ejecutar]
//
// Sustituye al script auxiliar de sesión que se usó en F18-09…F18-16 (no estaba en el repositorio). Por
// defecto SIMULA: compila (o toma --dist), revisa el bundle y escribe el manifiesto, pero no sube nada.
// Solo con --ejecutar sube a S3 y crea la invalidación.
//
// Todo sale de la pila `busperu-<env>-web` (FrontendBucketName, WebDistributionId, ApiUrl): no se escribe a
// mano ningún bucket ni distribución, así que es imposible publicar el build de un entorno en el otro.
//
// Pasos:
//   1. Identidad: sesión temporal (no la raíz, no una clave permanente), región sa-east-1.
//   2. Pila `busperu-<env>-web` en *_COMPLETE; el bucket empieza por `busperu-<env>-web-`.
//   3. Build con VITE_API_URL = salida ApiUrl de la pila (o comprobación de --dist contra ella).
//   4. Revisión del bundle: contiene la URL de SU API y ninguna del otro entorno, sin localhost, sin
//      source maps y sin nada que parezca un secreto (llaves privadas de Culqi, claves de Resend o AWS, JWT,
//      claves privadas PEM).
//   5. Manifiesto SHA-256 de cada archivo (+ hash global) en --salida (por defecto ./web-releases/).
//   6. Con --ejecutar:
//      - assets/ con `Cache-Control: public,max-age=31536000,immutable`;
//      - el resto (index.html) con `no-cache`, después de los assets;
//      - sin --delete: los chunks de versiones anteriores se conservan para las pestañas ya abiertas;
//      - verificación: tamaño y MD5 (ETag) de cada objeto y Content-Type de index.html, JS y CSS;
//      - invalidación de `/` y `/index.html`, esperando a que termine. Los assets llevan hash y son
//        inmutables, así que no se invalidan.
//
// Vuelta atrás: volver a publicar el dist/ del release anterior (el build es reproducible desde su tag, o se
// usa la copia guardada en --salida), con el mismo comando.
//
// Nunca imprime credenciales. No toca DNS, certificados, la API ni la base de datos.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REGION = 'sa-east-1';
const ENTORNOS = {
  staging: { pila: 'busperu-staging-web', ajenos: ['busperuonline.pe'] },
  prod: { pila: 'busperu-prod-web', ajenos: ['d25z2lpl1efut1.cloudfront.net', 'd1lfpi7fp62ntk.cloudfront.net', 'staging.busperu', 'busperu-staging'] },
};
const SECRETOS = [
  ['llave privada de Culqi', /sk_(live|test)_[0-9A-Za-z]{8,}/],
  ['clave de Resend', /\bre_[0-9A-Za-z]{8,}_[0-9A-Za-z]{8,}/],
  ['clave de acceso AWS', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['clave privada PEM', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const args = process.argv.slice(2);
const opcion = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const EJECUTAR = args.includes('--ejecutar');
const ENV = opcion('env');
const RELEASE = opcion('release');
// El id de cuenta (forma parte del nombre del bucket) no se muestra ni se guarda en el manifiesto.
const sinCuenta = (t) => String(t).replace(/\b\d{12}\b/g, '<cuenta>');
const log = (m) => process.stdout.write(`${sinCuenta(m)}\n`);
const parar = (m) => { process.stderr.write(`\nDETENIDO: ${m}\n`); process.exit(2); };

if (!ENTORNOS[ENV]) parar('--env debe ser staging o prod');
if (!RELEASE || !/^[0-9A-Za-z._-]{1,64}$/.test(RELEASE)) parar('--release <id> obligatorio (p. ej. v1.0.0 o 2026-09-25-1)');
const { pila: PILA, ajenos: AJENOS } = ENTORNOS[ENV];

function aws(...a) {
  const r = spawnSync('aws', [...a, '--region', REGION, '--output', 'json'], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  if (r.error) parar(`no se pudo ejecutar aws: ${r.error.message}`);
  if (r.status !== 0) parar(`aws ${a.slice(0, 2).join(' ')}: ${(r.stderr || '').trim().replace(/\b\d{12}\b/g, '<cuenta>')}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
}
const listar = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listar(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const rel = (dist, f) => path.relative(dist, f).split(path.sep).join('/');
const hash = (alg, buf) => createHash(alg).update(buf).digest('hex');

// ------------------------------------------------------------------ 1. identidad
const yo = aws('sts', 'get-caller-identity');
if (/:root$/.test(yo.Arn)) parar('no se publica con la cuenta raíz');
if (!process.env.AWS_PROFILE && !process.env.AWS_SESSION_TOKEN) parar('usa un perfil de sesión temporal (AWS_PROFILE) con MFA');
log(`[PASS] identidad ${yo.Arn.replace(/\b\d{12}\b/g, '<cuenta>')} · región ${REGION} · entorno ${ENV} · release ${RELEASE}`);

// ------------------------------------------------------------------ 2. pila del entorno
const st = aws('cloudformation', 'describe-stacks', '--stack-name', PILA).Stacks?.[0];
if (!st || !/_COMPLETE$/.test(st.StackStatus) || /ROLLBACK|DELETE/.test(st.StackStatus)) parar(`${PILA} no está en un estado estable (${st?.StackStatus})`);
const out = Object.fromEntries((st.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
const BUCKET = out.FrontendBucketName;
const DIST_ID = out.WebDistributionId;
const API_URL = out.ApiUrl;
if (!BUCKET?.startsWith(`busperu-${ENV}-web-`)) parar(`bucket inesperado para ${ENV}: ${BUCKET}`);
if (!DIST_ID || !API_URL?.startsWith('https://') || !API_URL.endsWith('/api')) parar('salidas de la pila incompletas (WebDistributionId / ApiUrl)');
if (AJENOS.some((a) => API_URL.includes(a))) parar(`la ApiUrl de ${PILA} apunta a otro entorno: ${API_URL}`);
log(`[PASS] ${PILA} ${st.StackStatus} · bucket ${BUCKET} · distribución ${DIST_ID} · API ${API_URL}`);

// ------------------------------------------------------------------ 3. build
let DIST = opcion('dist');
if (!DIST) {
  const fe = path.join(RAIZ, 'frontend');
  const b = spawnSync('npm', ['run', 'build'], { cwd: fe, encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, VITE_API_URL: API_URL } });
  if (b.status !== 0) parar(`npm run build falló:\n${(b.stdout + b.stderr).slice(-2000)}`);
  DIST = path.join(fe, 'dist');
  log(`[PASS] build con VITE_API_URL=${API_URL}`);
}
DIST = path.resolve(DIST);
if (!fs.existsSync(path.join(DIST, 'index.html'))) parar(`${DIST} no contiene index.html`);

// ------------------------------------------------------------------ 4. revisión del bundle
const archivos = listar(DIST).sort();
const mapas = archivos.filter((f) => f.endsWith('.map'));
if (mapas.length) parar(`el build incluye source maps: ${mapas.slice(0, 3).map((f) => rel(DIST, f))}`);
let conApi = false;
for (const f of archivos) {
  if (!/\.(html|js|css|json|txt|svg)$/.test(f)) continue;
  const texto = fs.readFileSync(f, 'utf8');
  if (texto.includes(API_URL)) conApi = true;
  for (const malo of ['localhost', '127.0.0.1', ...AJENOS]) if (texto.includes(malo)) parar(`${rel(DIST, f)} contiene «${malo}»`);
  for (const [nombre, patron] of SECRETOS) if (patron.test(texto)) parar(`${rel(DIST, f)} contiene algo que parece un secreto (${nombre})`);
}
if (!conApi) parar(`el bundle no contiene ${API_URL}: se compiló para otra API`);
log(`[PASS] bundle: ${archivos.length} archivos · apunta a ${API_URL} · sin localhost, sin el otro entorno, sin source maps, sin secretos`);

// ------------------------------------------------------------------ 5. manifiesto
const manifiesto = archivos.map((f) => {
  const buf = fs.readFileSync(f);
  return { ruta: rel(DIST, f), bytes: buf.length, sha256: hash('sha256', buf), md5: hash('md5', buf) };
});
const global = hash('sha256', manifiesto.map((m) => `${m.sha256}  ${m.ruta}\n`).join(''));
const salida = path.resolve(opcion('salida') ?? path.join(process.cwd(), 'web-releases'));
fs.mkdirSync(salida, { recursive: true });
const fichero = path.join(salida, `web-${ENV}-${RELEASE}.manifest.json`);
fs.writeFileSync(fichero, `${JSON.stringify({ entorno: ENV, release: RELEASE, api: API_URL, bucket: sinCuenta(BUCKET), distribucion: DIST_ID, sha256: global, archivos: manifiesto.map(({ md5, ...m }) => m) }, null, 1)}\n`);
log(`[PASS] manifiesto ${fichero} · sha256 global ${global}`);

if (!EJECUTAR) {
  log('\nSIMULACIÓN: no se ha subido nada. Repite con --ejecutar para publicar.');
  process.exit(0);
}

// ------------------------------------------------------------------ 6. publicación
aws('s3', 'sync', path.join(DIST, 'assets'), `s3://${BUCKET}/assets`, '--cache-control', 'public,max-age=31536000,immutable', '--only-show-errors');
aws('s3', 'sync', DIST, `s3://${BUCKET}`, '--exclude', 'assets/*', '--cache-control', 'no-cache', '--only-show-errors');
const remotos = new Map();
let token;
do {
  const r = aws('s3api', 'list-objects-v2', '--bucket', BUCKET, ...(token ? ['--continuation-token', token] : []));
  for (const o of r.Contents ?? []) remotos.set(o.Key, o);
  token = r.NextContinuationToken;
} while (token);
const distintos = manifiesto.filter((m) => {
  const o = remotos.get(m.ruta);
  if (!o || o.Size !== m.bytes) return true;
  const etag = String(o.ETag).replaceAll('"', '');
  return !etag.includes('-') && etag !== m.md5;
});
if (distintos.length) parar(`objetos ausentes o distintos en S3: ${distintos.slice(0, 10).map((m) => m.ruta)}`);
const revisar = manifiesto.filter((m) => m.ruta === 'index.html' || /\.(js|css)$/.test(m.ruta));
for (const m of revisar) {
  const h = aws('s3api', 'head-object', '--bucket', BUCKET, '--key', m.ruta);
  const esperado = TIPOS[path.extname(m.ruta)];
  const tipo = String(h.ContentType ?? '').split(';')[0];
  const js = esperado === 'text/javascript' && ['text/javascript', 'application/javascript'].includes(tipo);
  if (!js && tipo !== esperado) parar(`${m.ruta} tiene Content-Type ${tipo} (se esperaba ${esperado})`);
  const cache = m.ruta.startsWith('assets/') ? 'immutable' : 'no-cache';
  if (!String(h.CacheControl ?? '').includes(cache)) parar(`${m.ruta} sin Cache-Control ${cache}`);
}
log(`[PASS] ${manifiesto.length} archivos en s3://${BUCKET} con el mismo tamaño y MD5 · Content-Type y Cache-Control correctos en ${revisar.length} · ${remotos.size - manifiesto.length} objetos de versiones anteriores conservados`);
const inv = aws('cloudfront', 'create-invalidation', '--distribution-id', DIST_ID, '--paths', '/', '/index.html').Invalidation;
aws('cloudfront', 'wait', 'invalidation-completed', '--distribution-id', DIST_ID, '--id', inv.Id);
log(`[PASS] invalidación ${inv.Id} (/ y /index.html) completada`);
log(`\nPUBLICADO ${ENV} ${RELEASE} · sha256 ${global}`);
