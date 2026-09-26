#!/usr/bin/env bash
# BusPerú · F18-03 · preparación única de la EC2 (Amazon Linux 2023, arm64). Como root, por
# Session Manager, con los scripts ya copiados en /opt/busperu/current/infra/aws (runbook §6):
#
#   sudo bash bootstrap-ec2.sh --data-volume vol-0123456789abcdef0 [--format-new-volume] [--env staging|prod]
#
# · Instala Node.js 24.15.0 (la versión validada en F18) verificando su SHA-256 oficial.
# · Crea el usuario de sistema `busperu` (sin shell ni home de login).
# · Monta el volumen EBS de datos en /data de forma persistente (fstab por UUID). SOLO lo formatea
#   si se pasa --format-new-volume Y el volumen no tiene ya un sistema de archivos: un volumen con
#   datos nunca se formatea.
# · Deja STORAGE_DIR en /data/busperu/storage, instala la unidad systemd, logrotate y el agente de
#   CloudWatch. No toca secretos.
# · F18-18: --env (por defecto staging) queda en /etc/busperu/env y decide la ruta de Parameter Store que lee
#   render-env.sh y el grupo de logs del agente (/busperu/<env>/app). Se niega si el perfil de la instancia
#   no es de ese entorno (busperu-<env>-…), para no mezclar staging y producción.
set -euo pipefail

NODE_VERSION="24.15.0"
VOLUMEN=""
FORMATEAR="no"
ENTORNO="staging"
while [ $# -gt 0 ]; do
  case "$1" in
    --data-volume) VOLUMEN="$2"; shift 2 ;;
    --format-new-volume) FORMATEAR="si"; shift ;;
    --env) ENTORNO="$2"; shift 2 ;;
    *) echo "argumento desconocido: $1" >&2; exit 2 ;;
  esac
done
[ -n "${VOLUMEN}" ] || { echo "falta --data-volume vol-…" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "ejecutar como root" >&2; exit 1; }
case "${ENTORNO}" in staging|prod) ;; *) echo "--env debe ser staging o prod" >&2; exit 2 ;; esac
TOKEN_IMDS="$(curl -sS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')"
# Sin jq: todavía no está instalado en una instancia nueva (se instala en «paquetes»).
PERFIL="$(curl -sS -H "X-aws-ec2-metadata-token: ${TOKEN_IMDS}" http://169.254.169.254/latest/meta-data/iam/info \
  | sed -n 's/.*"InstanceProfileArn"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' || true)"
[[ "${PERFIL##*/}" == busperu-${ENTORNO}-* ]] || { echo "ABORTADO: el perfil de la instancia (${PERFIL##*/}) no es de ${ENTORNO}" >&2; exit 1; }
ORIGEN="$(cd "$(dirname "$0")/.." && pwd)"   # …/infra/aws

echo "== paquetes"
dnf install -y -q jq tar xz mariadb105 amazon-cloudwatch-agent logrotate

echo "== Node.js ${NODE_VERSION} (linux-arm64) con verificación SHA-256"
if [ "$(/opt/node/bin/node --version 2>/dev/null || true)" != "v${NODE_VERSION}" ]; then
  TMP="$(mktemp -d)"; trap 'rm -rf "${TMP}"' EXIT
  ARCHIVO="node-v${NODE_VERSION}-linux-arm64.tar.xz"
  curl -fsSL -o "${TMP}/${ARCHIVO}" "https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVO}"
  curl -fsSL -o "${TMP}/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  (cd "${TMP}" && grep " ${ARCHIVO}\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "${TMP}/${ARCHIVO}" -C /opt/node --strip-components=1
fi
/opt/node/bin/node --version
ln -sf /opt/node/bin/node /usr/local/bin/node
ln -sf /opt/node/bin/npm /usr/local/bin/npm

echo "== usuario busperu"
id busperu >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin busperu

echo "== volumen de datos ${VOLUMEN} en /data"
# En instancias Nitro el volumen aparece como NVMe; su número de serie es el id sin guion.
DISPOSITIVO="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${VOLUMEN/-/}"
for _ in $(seq 1 30); do [ -e "${DISPOSITIVO}" ] && break; sleep 2; done
[ -e "${DISPOSITIVO}" ] || { echo "no aparece ${DISPOSITIVO}: ¿está adjuntado el volumen?" >&2; exit 1; }
if ! blkid "${DISPOSITIVO}" >/dev/null 2>&1; then
  if [ "${FORMATEAR}" != "si" ]; then
    echo "El volumen no tiene sistema de archivos. Si es NUEVO, repetir con --format-new-volume." >&2; exit 1
  fi
  echo "   volumen vacío: se formatea como XFS"
  mkfs.xfs -q "${DISPOSITIVO}"
else
  echo "   ya tiene sistema de archivos: NO se formatea"
fi
UUID="$(blkid -s UUID -o value "${DISPOSITIVO}")"
mkdir -p /data
grep -q "UUID=${UUID}" /etc/fstab || echo "UUID=${UUID} /data xfs defaults,nofail,noatime 0 2" >> /etc/fstab
systemctl daemon-reload
mountpoint -q /data || mount /data
mkdir -p /data/busperu/storage
chown -R busperu:busperu /data/busperu
chmod 750 /data/busperu /data/busperu/storage

echo "== entorno ${ENTORNO}"
mkdir -p /etc/busperu
printf 'BUSPERU_ENV=%s\n' "${ENTORNO}" > /etc/busperu/env
chmod 0644 /etc/busperu/env

echo "== directorios, logs y scripts"
mkdir -p /opt/busperu/releases /opt/busperu/bin /var/log/busperu
chown busperu:busperu /var/log/busperu && chmod 750 /var/log/busperu
install -m 0750 -o root -g root "${ORIGEN}/scripts/render-env.sh" /opt/busperu/bin/render-env.sh
install -m 0750 -o root -g root "${ORIGEN}/scripts/deploy-release.sh" /opt/busperu/bin/deploy-release.sh
install -m 0644 "${ORIGEN}/systemd/busperu-api.service" /etc/systemd/system/busperu-api.service
cat > /etc/logrotate.d/busperu <<'EOF'
/var/log/busperu/api.log {
  daily
  rotate 7
  compress
  missingok
  notifempty
  copytruncate
}
EOF

echo "== agente de CloudWatch"
sed "s#{{BUSPERU_ENV}}#${ENTORNO}#g" "${ORIGEN}/cloudwatch/amazon-cloudwatch-agent.json" > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
chmod 0644 /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

systemctl daemon-reload
systemctl enable busperu-api.service
echo "Listo. Falta desplegar una versión (deploy-release.sh) y cargar los parámetros (runbook §5)."
