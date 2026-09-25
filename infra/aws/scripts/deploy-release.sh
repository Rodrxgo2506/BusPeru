#!/usr/bin/env bash
# BusPerú · F18-03 · despliegue de una versión en la EC2 (como root, por Session Manager).
#
#   sudo /opt/busperu/bin/deploy-release.sh <bucket> <version>
#
# 1. Descarga s3://<bucket>/releases/busperu-<version>.tar.gz y su .sha256 y verifica el hash.
# 2. La extrae en /opt/busperu/releases/<version> e instala dependencias de producción (npm ci).
# 3. Cambia el enlace /opt/busperu/current de forma atómica y reinicia el servicio.
# 4. Espera a que GET /api/ready responda 200 en local. Si no llega en 90 s, VUELVE a la versión
#    anterior y reinicia: un despliegue fallido no deja la API caída.
# No aplica migraciones: eso es un paso aparte y explícito (runbook §8).
set -euo pipefail

BUCKET="${1:?uso: deploy-release.sh <bucket> <version>}"
VERSION="${2:?uso: deploy-release.sh <bucket> <version>}"
[[ "${VERSION}" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "versión no válida" >&2; exit 2; }
BASE=/opt/busperu
DESTINO="${BASE}/releases/${VERSION}"
ANTERIOR="$(readlink -f "${BASE}/current" 2>/dev/null || true)"

TMP="$(mktemp -d)"; trap 'rm -rf "${TMP}"' EXIT
aws s3 cp --only-show-errors "s3://${BUCKET}/releases/busperu-${VERSION}.tar.gz" "${TMP}/r.tar.gz"
aws s3 cp --only-show-errors "s3://${BUCKET}/releases/busperu-${VERSION}.tar.gz.sha256" "${TMP}/r.sha256"
ESPERADO="$(awk '{print $1}' "${TMP}/r.sha256")"
OBTENIDO="$(sha256sum "${TMP}/r.tar.gz" | awk '{print $1}')"
[ "${ESPERADO}" = "${OBTENIDO}" ] || { echo "SHA-256 no coincide: artefacto descartado" >&2; exit 1; }
echo "artefacto verificado (${OBTENIDO})"

rm -rf "${DESTINO}" && mkdir -p "${DESTINO}"
tar -xzf "${TMP}/r.tar.gz" -C "${DESTINO}"
(cd "${DESTINO}/backend" && /opt/node/bin/npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R root:busperu "${DESTINO}" && chmod -R g+rX,o-rwx "${DESTINO}"

ln -sfn "${DESTINO}" "${BASE}/current.nuevo" && mv -Tf "${BASE}/current.nuevo" "${BASE}/current"
systemctl restart busperu-api.service

esperar_ready() {
  for _ in $(seq 1 45); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/ready)" = "200" ] && return 0
    sleep 2
  done
  return 1
}

if esperar_ready; then
  echo "✔ ${VERSION} desplegada: /api/ready = 200"
else
  echo "✖ ${VERSION} no quedó lista en 90 s" >&2
  if [ -n "${ANTERIOR}" ] && [ -d "${ANTERIOR}" ]; then
    ln -sfn "${ANTERIOR}" "${BASE}/current.nuevo" && mv -Tf "${BASE}/current.nuevo" "${BASE}/current"
    systemctl restart busperu-api.service
    esperar_ready && echo "↩ vuelta a $(basename "${ANTERIOR}"): /api/ready = 200" >&2 || echo "↩ vuelta a $(basename "${ANTERIOR}") SIN readiness: revisar /var/log/busperu/api.log" >&2
  fi
  exit 1
fi
