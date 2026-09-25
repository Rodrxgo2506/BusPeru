#!/usr/bin/env bash
# BusPerú · F18-09 · pruebas de QA contra STAGING que no dejan datos atrás.
#
#   AWS_PROFILE=busperu-mfa infra/aws/scripts/qa-staging.sh pruebas                      # smoke + E2E por CloudFront
#   AWS_PROFILE=busperu-mfa infra/aws/scripts/qa-staging.sh expiry                       # ≥ 16 min después
#   AWS_PROFILE=busperu-mfa infra/aws/scripts/qa-staging.sh purgar m1.json [m2.json …] [--ejecutar]
#   AWS_PROFILE=busperu-mfa infra/aws/scripts/qa-staging.sh todo                         # todo lo anterior, en orden
#
# · smoke-staging.mjs y e2e-staging.mjs retiran por la API lo que crean (la portada queda limpia al terminar) y
#   dejan un manifiesto con sus ids en ${QA_DIR:-./.qa-staging}/.
# · "purgar" une los manifiestos y ejecuta purge-qa-data.cjs en la EC2 por SSM (usuario migrador): sube el script y
#   el manifiesto a s3://<artefactos>/qa/<fecha>/ con su SHA-256, la EC2 los verifica y después se borran del bucket.
#   Sin --ejecutar es un ENSAYO que termina en ROLLBACK.
# · URLs: QA_API_URL / QA_WEB_URL o, si no se pasan, las salidas de la pila busperu-staging-web; contraseña del ADMIN de staging a un temporal 0600 que se borra al salir.
#   Nada secreto se imprime. Solo staging: se niega si la pila principal no tiene EnvName=staging.
set -euo pipefail
REGION=sa-east-1
AQUI="$(cd "$(dirname "$0")" && pwd)"
TRABAJO="${QA_DIR:-${PWD}/.qa-staging}"
mkdir -p "${TRABAJO}"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP}"' EXIT
# En Git Bash (Windows) los nombres /busperu/… no deben convertirse en rutas; las rutas locales se pasan en nativo.
aws_() { MSYS_NO_PATHCONV=1 aws --region "${REGION}" "$@" < /dev/null; }
nativo() { if command -v cygpath > /dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
salida() { aws_ cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }

[ "$(aws_ cloudformation describe-stacks --stack-name busperu-staging --query "Stacks[0].Parameters[?ParameterKey=='EnvName'].ParameterValue" --output text)" = "staging" ] \
  || { echo "la pila busperu-staging no es staging: me niego" >&2; exit 2; }

preparar_api() {
  export API_BASE_URL FRONTEND_ORIGIN ADMIN_EMAIL ADMIN_PASSWORD_FILE="${TMP}/admin.pw"
  # El rol de despliegue de staging no puede leer la pila busperu-staging-web: se aceptan las URLs por entorno.
  API_BASE_URL="${QA_API_URL:-$(salida busperu-staging-web ApiUrl)}"
  FRONTEND_ORIGIN="${QA_WEB_URL:-$(salida busperu-staging-web WebUrl)}"
  ADMIN_EMAIL="$(aws_ ssm get-parameter --name /busperu/staging/ops/ADMIN_EMAIL --query Parameter.Value --output text)"
  (umask 077; aws_ ssm get-parameter --name /busperu/staging/ops/ADMIN_PASSWORD --with-decryption --query Parameter.Value --output text > "${ADMIN_PASSWORD_FILE}")
  ADMIN_PASSWORD_FILE="$(nativo "${ADMIN_PASSWORD_FILE}")"
}

pruebas() {
  preparar_api
  local sello r=0; sello="$(date -u +%Y%m%dT%H%M%SZ)"
  QA_MANIFEST="${TRABAJO}/qa-manifest-smoke-${sello}.json" node "${AQUI}/smoke-staging.mjs" || r=1
  QA_MANIFEST="${TRABAJO}/qa-manifest-e2e-${sello}.json" ESTADO_FILE="${TRABAJO}/e2e-estado.json" node "${AQUI}/e2e-staging.mjs" || r=1
  echo "manifiestos:"; ls -1 "${TRABAJO}"/qa-manifest-*-"${sello}".json
  return ${r}
}

expiry() { preparar_api; ESTADO_FILE="${TRABAJO}/e2e-estado.json" node "${AQUI}/e2e-staging.mjs" expiry; }

# Une manifiestos: listas sin duplicados; "esperado" solo se conserva si hay un único manifiesto.
unir_manifiestos() {
  node - "$@" <<'JS'
const fs = require('fs');
const archivos = process.argv.slice(2, -1), destino = process.argv.at(-1);
const claves = ['companies', 'users', 'locations', 'bus_types', 'seat_types'];
const out = { descripcion: `qa-staging.sh purgar · ${archivos.length} manifiesto(s)`, marcas: [] };
for (const k of claves) out[k] = [];
for (const f of archivos) {
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  out.marcas.push(...(m.marcas || []));
  for (const k of claves) out[k].push(...(m[k] || []));
  if (archivos.length === 1 && m.esperado) out.esperado = m.esperado;
}
for (const k of ['marcas', ...claves]) out[k] = [...new Set(out[k])];
fs.writeFileSync(destino, JSON.stringify(out));
console.log(`manifiesto: ${claves.map((k) => `${k} ${out[k].length}`).join(' · ')} · marcas ${out.marcas.length}${out.esperado ? ' · con recuentos esperados' : ''}`);
JS
}

orden_ssm() {   # $1 bucket · $2 prefijo · $3 "--ejecutar" o "" → JSON de AWS-RunShellScript
  node - "$@" <<'JS'
const [b, p, e = ''] = process.argv.slice(2);
const commands = [
  'set -u; umask 077; d=$(mktemp -d); f=$d/pw; trap "shred -u $f 2>/dev/null; rm -rf $d" EXIT',
  `for x in purge-qa-data.cjs manifiesto.json sums.txt; do aws s3 cp --only-show-errors s3://${b}/${p}/$x $d/$x || exit 3; done`,
  '(cd $d && sha256sum -c --quiet sums.txt) || { echo "SHA-256 NO COINCIDE: no se ejecuta nada"; exit 3; }',
  'aws ssm get-parameter --region sa-east-1 --name /busperu/staging/ops/MIGRATOR_DB_PASSWORD --with-decryption --query Parameter.Value --output text > $f',
  'H=$(aws ssm get-parameter --region sa-east-1 --name /busperu/staging/app/DB_HOST --query Parameter.Value --output text)',
  'S=$(aws ssm get-parameter --region sa-east-1 --name /busperu/staging/app/STORAGE_DIR --query Parameter.Value --output text)',
  `cd /opt/busperu/current/backend && DB_HOST=$H DB_USER=busperu_migrator DB_PASSWORD_FILE=$f DB_NAME=busperu_staging STORAGE_DIR=$S node $d/purge-qa-data.cjs $d/manifiesto.json ${e}`,
];
process.stdout.write(JSON.stringify({ commands }));
JS
}

purgar() {
  local ejecutar="" manifiestos=() a
  for a in "$@"; do if [ "${a}" = "--ejecutar" ]; then ejecutar="--ejecutar"; else manifiestos+=("${a}"); fi; done
  [ ${#manifiestos[@]} -gt 0 ] || { echo "uso: qa-staging.sh purgar manifiesto.json … [--ejecutar]" >&2; exit 2; }
  unir_manifiestos "${manifiestos[@]}" "${TMP}/manifiesto.json"
  local bucket instancia prefijo cmd estado=""
  bucket="$(salida busperu-staging ArtifactsBucketName)"; instancia="$(salida busperu-staging AppInstanceId)"
  prefijo="qa/$(date -u +%Y%m%dT%H%M%SZ)"
  cp "${AQUI}/purge-qa-data.cjs" "${TMP}/purge-qa-data.cjs"
  (cd "${TMP}" && sha256sum purge-qa-data.cjs manifiesto.json > sums.txt)
  for a in purge-qa-data.cjs manifiesto.json sums.txt; do aws_ s3 cp --only-show-errors "$(nativo "${TMP}/${a}")" "s3://${bucket}/${prefijo}/${a}"; done
  orden_ssm "${bucket}" "${prefijo}" "${ejecutar}" > "${TMP}/cmd.json"
  cmd="$(aws_ ssm send-command --instance-ids "${instancia}" --document-name AWS-RunShellScript \
        --comment "qa-staging purgar ${ejecutar:-ensayo}" --parameters "file://$(nativo "${TMP}/cmd.json")" --query Command.CommandId --output text)"
  for _ in $(seq 1 100); do
    estado="$(aws_ ssm get-command-invocation --command-id "${cmd}" --instance-id "${instancia}" --query Status --output text 2>/dev/null || true)"
    case "${estado}" in Success|Failed|Cancelled|TimedOut) break ;; esac; sleep 3
  done
  aws_ ssm get-command-invocation --command-id "${cmd}" --instance-id "${instancia}" --query StandardOutputContent --output text
  for a in purge-qa-data.cjs manifiesto.json sums.txt; do aws_ s3 rm --only-show-errors "s3://${bucket}/${prefijo}/${a}"; done
  echo "purga ${ejecutar:-(ensayo)}: ${estado}"
  [ "${estado}" = "Success" ]
}

case "${1:-}" in
  pruebas) pruebas ;;
  expiry) expiry ;;
  purgar) shift; purgar "$@" ;;
  todo)
    r=0; pruebas || r=1
    mapfile -t ultimos < <(ls -1t "${TRABAJO}"/qa-manifest-*.json | head -2)
    echo "esperando 17 min a que venza la reserva de prueba…"; sleep 1020
    expiry || r=1
    purgar "${ultimos[@]}" && purgar "${ultimos[@]}" --ejecutar || r=1
    exit ${r} ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
