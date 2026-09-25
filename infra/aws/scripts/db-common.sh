# BusPerú · F18-03 · funciones comunes de los scripts de base de datos (se incluye con `source`).
#
# Ninguna contraseña pasa por la línea de órdenes ni se imprime: cada credencial se escribe en un
# archivo de opciones temporal (0600) y el cliente lo lee con --defaults-extra-file. Las sentencias
# con contraseñas entran por stdin.
#
# Origen de las credenciales:
#   · AWS (por defecto): maestro en Secrets Manager (MASTER_SECRET_ARN), usuario de la app en
#     /busperu/<env>/app/DB_PASSWORD y migrador en /busperu/<env>/ops/MIGRATOR_DB_PASSWORD.
#   · Ensayo local (BUSPERU_LOCAL=1): LOCAL_MASTER_USER y los archivos LOCAL_MASTER_PASSWORD_FILE,
#     LOCAL_APP_PASSWORD_FILE y LOCAL_MIGRATOR_PASSWORD_FILE. Sirve para validar los scripts contra
#     el MariaDB 10.11 portable antes de tocar AWS.

set -euo pipefail
umask 077

BUSPERU_ENV="${BUSPERU_ENV:-staging}"
DB_NAME="${DB_NAME:-busperu_${BUSPERU_ENV}}"
MARIADB="${MARIADB_CLIENT:-mariadb}"
TEMPORALES=()
limpiar_temporales() { local f; for f in "${TEMPORALES[@]:-}"; do [ -n "${f}" ] && rm -f "${f}"; done; }
trap limpiar_temporales EXIT

# Nunca contra la base local real ni contra la de las pruebas locales.
case "${DB_NAME}" in
  busperu|busperu_test) echo "ABORTADO: DB_NAME=${DB_NAME} está prohibido para estos scripts" >&2; exit 1 ;;
esac
[[ "${DB_NAME}" =~ ^busperu_[a-z0-9_]+$ ]] || { echo "ABORTADO: DB_NAME no válido (${DB_NAME})" >&2; exit 1; }
: "${DB_HOST:?falta DB_HOST (endpoint de RDS)}"
DB_PORT="${DB_PORT:-3306}"

region() {
  local token
  token="$(curl -sS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')"
  curl -sS -H "X-aws-ec2-metadata-token: ${token}" http://169.254.169.254/latest/meta-data/placement/region
}

parametro() { # parametro <ruta completa>  → valor por stdout (solo para capturarlo en una variable)
  aws ssm get-parameter --region "$(region)" --name "$1" --with-decryption --query Parameter.Value --output text
}

# Los archivos temporales se crean en el shell PRINCIPAL (no dentro de $(...), que es un subshell y
# no podría registrarlos para borrarlos al salir). `temporal` deja la ruta en REPLY.
temporal() { REPLY="$(mktemp)"; TEMPORALES+=("${REPLY}"); }

# Ruta que entiende el cliente: en el ensayo local sobre Windows, el mariadb.exe nativo necesita
# rutas de Windows; en la EC2 (Linux) se usa tal cual.
ruta_cliente() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

# escribir_opciones <archivo> <usuario> <contraseña>
escribir_opciones() {
  printf '[client]\nhost=%s\nport=%s\nuser=%s\npassword=%s\n' "${DB_HOST}" "${DB_PORT}" "$2" "$3" > "$1"
}

leer_archivo() { local v; v="$(tr -d '\r\n' < "$1")"; [ -n "${v}" ] || { echo "archivo vacío: $1" >&2; exit 1; }; printf '%s' "${v}"; }

credencial_maestra() { # credencial_maestra <archivo> → escribe las opciones del usuario maestro
  if [ "${BUSPERU_LOCAL:-0}" = 1 ]; then
    escribir_opciones "$1" "${LOCAL_MASTER_USER:?}" "$(leer_archivo "${LOCAL_MASTER_PASSWORD_FILE:?}")"
  else
    local json
    json="$(aws secretsmanager get-secret-value --region "$(region)" --secret-id "${MASTER_SECRET_ARN:?falta MASTER_SECRET_ARN}" --query SecretString --output text)"
    escribir_opciones "$1" "$(jq -r .username <<< "${json}")" "$(jq -r .password <<< "${json}")"
  fi
}

clave_app() {
  if [ "${BUSPERU_LOCAL:-0}" = 1 ]; then leer_archivo "${LOCAL_APP_PASSWORD_FILE:?}"; else parametro "/busperu/${BUSPERU_ENV}/app/DB_PASSWORD"; fi
}
clave_migrador() {
  if [ "${BUSPERU_LOCAL:-0}" = 1 ]; then leer_archivo "${LOCAL_MIGRATOR_PASSWORD_FILE:?}"; else parametro "/busperu/${BUSPERU_ENV}/ops/MIGRATOR_DB_PASSWORD"; fi
}

# Las contraseñas se generan con un alfabeto seguro (runbook §5): así pueden ir entre comillas
# simples en SQL sin escaparse. Cualquier otra cosa se rechaza.
validar_clave() { [[ "$1" =~ ^[A-Za-z0-9_-]{32,}$ ]] || { echo "ABORTADO: la contraseña de $2 no cumple ^[A-Za-z0-9_-]{32,}\$" >&2; exit 1; }; }

# Comprueba que el servidor es MariaDB 10.11 en modo estricto antes de hacer nada.
verificar_servidor() { # verificar_servidor <archivo de opciones>
  local info
  info="$("${MARIADB}" --defaults-extra-file="$(ruta_cliente "$1")" -N -B -e "SELECT CONCAT(VERSION(), '|', @@GLOBAL.sql_mode)")"
  echo "servidor: ${info}"
  [[ "${info}" == 10.11.*-MariaDB*"|STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION" ]] \
    || { echo "ABORTADO: el servidor no es MariaDB 10.11 con el modo estricto esperado" >&2; exit 1; }
}
