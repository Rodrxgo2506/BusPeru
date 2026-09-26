#!/usr/bin/env bash
# BusPerú · F18-18 (B-10) · crea la base busperu_prod y sus dos usuarios SIN dar al runtime acceso al maestro.
#
#   BOOTSTRAP_PROFILE=<perfil del rol busperu-prod-db-bootstrap> OPERATOR_PROFILE=<perfil de BusPeruProdOperator> \
#     bash infra/aws/scripts/prod-db-bootstrap.sh [--ejecutar] [--resincronizar]
#
# Se ejecuta en CloudShell (sa-east-1). F18-08: las contraseñas se generan en CloudShell o en la instancia,
# nunca en un equipo personal. El rol de la EC2 conserva su `Deny secretsmanager:*`: el maestro lo lee SOLO
# el rol temporal busperu-prod-db-bootstrap (pila busperu-prod-db-bootstrap), que el administrador asume con MFA.
#
# Qué hace (sin --ejecutar solo comprueba y dice lo que haría):
#   1. Identidades: BOOTSTRAP_PROFILE es el rol temporal (sesión busperu-db-bootstrap); OPERATOR_PROFILE es
#      BusPeruProdOperator. Salidas de busperu-prod: instancia, endpoint y ARN del secreto maestro.
#   2. /busperu/prod/app/DB_PASSWORD y /busperu/prod/ops/MIGRATOR_DB_PASSWORD NO existen (salvo --resincronizar).
#   3. Genera las dos contraseñas en /tmp (0600) con el alfabeto que exige db-common.sh.
#   4. Lee el maestro a /tmp (0600) con el rol temporal.
#   5. Abre un túnel de Session Manager (AWS-StartPortForwardingSessionToRemoteHost) por la instancia de
#      producción hasta RDS, en 127.0.0.1:${PUERTO_LOCAL:-13306}.
#   6. create-db-users.sh por el túnel (modo de archivos, BUSPERU_ENV=prod): base busperu_prod y usuarios
#      busperu_app / busperu_migrator limitados a 10.30.% (la VPC de producción).
#   7. Guarda las dos contraseñas como SecureString con alias/busperu-prod-secrets, con el OPERADOR (solo cifra).
#   8. Rota el secreto maestro (la contraseña que pasó por CloudShell deja de valer).
#   9. Cierra el túnel y destruye los temporales. Después: el administrador BORRA la pila busperu-prod-db-bootstrap.
#
# Nunca imprime una contraseña. No toca la API, ni el esquema (eso es apply-migrations.sh en la instancia), ni IAM.
set -euo pipefail
umask 077
AQUI="$(cd "$(dirname "$0")" && pwd)"
REGION="sa-east-1"
PILA="busperu-prod"
SESION="busperu-db-bootstrap"
PUERTO_LOCAL="${PUERTO_LOCAL:-13306}"
EJECUTAR=0; RESINCRONIZAR=0
for a in "$@"; do
  case "$a" in
    --ejecutar) EJECUTAR=1 ;;
    --resincronizar) RESINCRONIZAR=1 ;;
    *) echo "argumento desconocido: $a" >&2; exit 2 ;;
  esac
done
: "${BOOTSTRAP_PROFILE:?falta BOOTSTRAP_PROFILE (rol busperu-prod-db-bootstrap)}"
: "${OPERATOR_PROFILE:?falta OPERATOR_PROFILE (BusPeruProdOperator)}"
parar() { echo "DETENIDO: $*" >&2; exit 2; }
sin_cuenta() { sed -E 's/[0-9]{12}/<cuenta>/g'; }
boot() { aws --profile "${BOOTSTRAP_PROFILE}" --region "${REGION}" "$@"; }
oper() { aws --profile "${OPERATOR_PROFILE}" --region "${REGION}" "$@"; }

# ------------------------------------------------------------------ 1. identidades y salidas
for h in aws jq openssl session-manager-plugin "${MARIADB_CLIENT:-mariadb}"; do command -v "$h" >/dev/null || parar "falta la herramienta $h"; done
ID_BOOT="$(boot sts get-caller-identity --query Arn --output text)"
ID_OPER="$(oper sts get-caller-identity --query Arn --output text)"
[[ "${ID_BOOT}" == *":assumed-role/${PILA}-db-bootstrap/${SESION}" ]] || parar "BOOTSTRAP_PROFILE no es el rol temporal con la sesión ${SESION}: $(sin_cuenta <<< "${ID_BOOT}")"
[[ "${ID_OPER}" == *":assumed-role/BusPeruProdOperator/"* ]] || parar "OPERATOR_PROFILE no es BusPeruProdOperator: $(sin_cuenta <<< "${ID_OPER}")"
echo "[PASS] rol temporal: $(sin_cuenta <<< "${ID_BOOT}")"
echo "[PASS] operador:     $(sin_cuenta <<< "${ID_OPER}")"
salida() { oper cloudformation describe-stacks --stack-name "${PILA}" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
INSTANCIA="$(salida AppInstanceId)"; DB_ENDPOINT="$(salida DatabaseEndpoint)"; SECRETO="$(salida DatabaseMasterSecretArn)"
[[ "${INSTANCIA}" =~ ^i-[0-9a-f]+$ ]] || parar "sin AppInstanceId en ${PILA}"
[[ "${DB_ENDPOINT}" == ${PILA}-db.* ]] || parar "el endpoint no es de ${PILA}-db"
[[ "${SECRETO}" == arn:aws:secretsmanager:${REGION}:*:secret:rds!* ]] || parar "ARN del secreto maestro inesperado"
echo "[PASS] ${PILA}: instancia ${INSTANCIA} · base ${PILA}-db · secreto maestro de RDS"

# ------------------------------------------------------------------ 2. parámetros de destino
existe() { [ "$(oper ssm describe-parameters --parameter-filters "Key=Name,Values=$1" --query 'length(Parameters)' --output text)" != 0 ]; }
P_APP="/busperu/prod/app/DB_PASSWORD"; P_MIG="/busperu/prod/ops/MIGRATOR_DB_PASSWORD"
for p in "${P_APP}" "${P_MIG}"; do
  if existe "$p"; then
    [ "${RESINCRONIZAR}" = 1 ] || parar "$p ya existe: el bootstrap ya se hizo. Con --resincronizar se generan contraseñas NUEVAS y se sustituyen (historial de versiones)."
    echo "[AVISO] $p existe: se sustituirá (--resincronizar)"
  fi
done
echo "[PASS] destino: ${P_APP} y ${P_MIG}"

if [ "${EJECUTAR}" != 1 ]; then
  echo
  echo "SIMULACIÓN: no se ha leído el maestro, ni abierto el túnel, ni creado nada. Repite con --ejecutar."
  exit 0
fi

# ------------------------------------------------------------------ 3–4. secretos a /tmp (0600)
TMP="$(mktemp -d /tmp/busperu-bootstrap.XXXXXX)"
TUNEL_PID=""
limpiar() {
  [ -n "${TUNEL_PID}" ] && kill "${TUNEL_PID}" 2>/dev/null || true
  find "${TMP}" -type f -exec shred -u {} + 2>/dev/null || true
  rm -rf "${TMP}"
}
trap limpiar EXIT
# Sin salto de línea final: el mismo valor exacto va a MariaDB (create-db-users.sh) y a Parameter Store
# (render-env.sh rechaza valores con saltos de línea).
generar() { openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' | cut -c1-43 | tr -d '\n'; }
generar > "${TMP}/app"; generar > "${TMP}/mig"
[[ "$(cat "${TMP}/app")" =~ ^[A-Za-z0-9_-]{43}$ ]] || parar "formato de contraseña inesperado"
cmp -s "${TMP}/app" "${TMP}/mig" && parar "contraseñas idénticas (imposible salvo fallo de openssl)"
boot secretsmanager get-secret-value --secret-id "${SECRETO}" --query SecretString --output text > "${TMP}/maestro.json"
jq -r .password "${TMP}/maestro.json" > "${TMP}/maestro"
USUARIO_MAESTRO="$(jq -r .username "${TMP}/maestro.json")"
shred -u "${TMP}/maestro.json"
[ -s "${TMP}/maestro" ] && [ -n "${USUARIO_MAESTRO}" ] || parar "no se pudo leer el maestro"
echo "[PASS] contraseñas generadas y maestro leído (en ${TMP}, 0600, no se muestran)"

# ------------------------------------------------------------------ 5. túnel
boot ssm start-session --target "${INSTANCIA}" --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"${DB_ENDPOINT}\"],\"portNumber\":[\"3306\"],\"localPortNumber\":[\"${PUERTO_LOCAL}\"]}" \
  > "${TMP}/tunel.log" 2>&1 &
TUNEL_PID=$!
for _ in $(seq 1 60); do (exec 3<>"/dev/tcp/127.0.0.1/${PUERTO_LOCAL}") 2>/dev/null && break; sleep 1; done
(exec 3<>"/dev/tcp/127.0.0.1/${PUERTO_LOCAL}") 2>/dev/null || parar "el túnel no abrió 127.0.0.1:${PUERTO_LOCAL}"
echo "[PASS] túnel por ${INSTANCIA} hasta ${PILA}-db en 127.0.0.1:${PUERTO_LOCAL}"

# ------------------------------------------------------------------ 6. base y usuarios
BUSPERU_ENV=prod BUSPERU_LOCAL=1 DB_HOST=127.0.0.1 DB_PORT="${PUERTO_LOCAL}" \
  LOCAL_MASTER_USER="${USUARIO_MAESTRO}" LOCAL_MASTER_PASSWORD_FILE="${TMP}/maestro" \
  LOCAL_APP_PASSWORD_FILE="${TMP}/app" LOCAL_MIGRATOR_PASSWORD_FILE="${TMP}/mig" \
  bash "${AQUI}/create-db-users.sh"

# ------------------------------------------------------------------ 7. contraseñas a Parameter Store (el operador solo cifra)
MODO=(--no-overwrite); [ "${RESINCRONIZAR}" = 1 ] && MODO=(--overwrite)
oper ssm put-parameter --name "${P_APP}" --type SecureString --key-id alias/busperu-prod-secrets --value "file://${TMP}/app" "${MODO[@]}" >/dev/null
oper ssm put-parameter --name "${P_MIG}" --type SecureString --key-id alias/busperu-prod-secrets --value "file://${TMP}/mig" "${MODO[@]}" >/dev/null
echo "[PASS] ${P_APP} y ${P_MIG} guardados (SecureString, alias/busperu-prod-secrets)"

# ------------------------------------------------------------------ 8. rotar el maestro
boot secretsmanager rotate-secret --secret-id "${SECRETO}" >/dev/null
echo "[PASS] rotación del secreto maestro solicitada (la contraseña leída deja de valer)"

echo
echo "✔ bootstrap de la base terminado. Siguiente: el administrador borra la pila ${PILA}-db-bootstrap;"
echo "  después, en la instancia: apply-migrations.sh (BUSPERU_ENV=prod) y schema-fingerprint.cjs (runbook §5.5)."
