#!/usr/bin/env bash
# BusPerú · F18-03 · genera el EnvironmentFile de la API a partir de Parameter Store.
#
#   render-env.sh /run/busperu/api.env
#
# Lo ejecuta systemd como root (ExecStartPre=+) antes de arrancar la API. Lee SOLO la ruta
# /busperu/<env>/app/ —las credenciales del migrador y del maestro viven en otras rutas y nunca
# llegan al proceso de la API— y escribe NOMBRE=valor en un archivo 0600 del usuario busperu,
# dentro de /run (tmpfs: desaparece al apagar). No imprime ningún valor, ni siquiera en error.
set -euo pipefail
umask 077

DESTINO="${1:?uso: render-env.sh <archivo destino>}"
ENTORNO="${BUSPERU_ENV:-staging}"
case "${ENTORNO}" in staging|prod) ;; *) echo "render-env: BUSPERU_ENV no válido" >&2; exit 1 ;; esac
RUTA="/busperu/${ENTORNO}/app/"
TOKEN="$(curl -sS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')"
REGION="$(curl -sS -H "X-aws-ec2-metadata-token: ${TOKEN}" http://169.254.169.254/latest/meta-data/placement/region)"
# F18-18: una instancia solo lee los parámetros de SU entorno (perfil busperu-<env>-…). Así una EC2 de producción
# sin /etc/busperu/env no arranca con la configuración de staging, ni al revés.
PERFIL="$(curl -sS -H "X-aws-ec2-metadata-token: ${TOKEN}" http://169.254.169.254/latest/meta-data/iam/info | jq -r .InstanceProfileArn)"
[[ "${PERFIL##*/}" == busperu-${ENTORNO}-* ]] || { echo "render-env: el perfil de la instancia no es de ${ENTORNO}" >&2; exit 1; }

TMP="$(mktemp "${DESTINO}.XXXXXX")"
trap 'rm -f "${TMP}"' EXIT

# La CLI recorre todas las páginas (la API devuelve 10 por página): NO usar --no-paginate.
# --with-decryption descifra los SecureString con la KMS de SSM.
aws ssm get-parameters-by-path --region "${REGION}" --path "${RUTA}" --with-decryption \
  --query 'Parameters[].[Name,Value]' --output json > "${TMP}.json"
trap 'rm -f "${TMP}" "${TMP}.json"' EXIT

jq -r --arg ruta "${RUTA}" '
  .[] | (.[0] | ltrimstr($ruta)) as $nombre | .[1] as $valor
  | if ($nombre | test("^[A-Z][A-Z0-9_]*$") | not) then error("nombre de parámetro no válido")
    elif ($valor | test("[\n\r]")) then error("valor con saltos de línea en " + $nombre)
    else "\($nombre)=\($valor)" end' "${TMP}.json" > "${TMP}"

TOTAL="$(wc -l < "${TMP}")"
for OBLIGATORIA in DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD JWT_SECRET INTEGRATIONS_ENCRYPTION_KEY FRONTEND_URL TRUST_PROXY STORAGE_DIR MAIL_TRANSPORT; do
  grep -q "^${OBLIGATORIA}=" "${TMP}" || { echo "render-env: falta el parámetro ${RUTA}${OBLIGATORIA}" >&2; exit 1; }
done
# La API nunca debe recibir el usuario maestro ni root.
if grep -Eq '^DB_USER=(root|busperu_master|busperu_migrator)$' "${TMP}"; then
  echo "render-env: DB_USER no puede ser root, el maestro ni el migrador" >&2; exit 1
fi

chown busperu:busperu "${TMP}"
chmod 0600 "${TMP}"
mv -f "${TMP}" "${DESTINO}"
echo "render-env: ${TOTAL} variables escritas en ${DESTINO} (valores no mostrados)"
