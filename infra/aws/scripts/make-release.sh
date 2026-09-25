#!/usr/bin/env bash
# BusPerú · F18-03 · empaqueta una versión del backend para desplegarla (en el equipo del operador).
#
#   bash infra/aws/scripts/make-release.sh <version> [directorio de salida]
#
# Compila el backend y crea busperu-<version>.tar.gz (+ .sha256) con: backend/dist, package.json,
# package-lock.json, database/ (dump y migraciones), infra/aws y el runbook. Nunca incluye .env,
# node_modules, storage ni tests: el paquete se revisa antes de escribirlo.
set -euo pipefail
VERSION="${1:?uso: make-release.sh <version> [salida]}"
[[ "${VERSION}" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "versión no válida" >&2; exit 2; }
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
SALIDA="${2:-${RAIZ}/infra/aws/.releases}"
mkdir -p "${SALIDA}"

(cd "${RAIZ}/backend" && npm run build >/dev/null)

LISTA=(
  backend/dist backend/package.json backend/package-lock.json
  database/schema database/migrations
  infra/aws/scripts infra/aws/systemd infra/aws/cloudwatch
  docs/production/STAGING-RUNBOOK.md
)
ARCHIVO="${SALIDA}/busperu-${VERSION}.tar.gz"
tar -czf "${ARCHIVO}" -C "${RAIZ}" --exclude='*.map' --exclude='backend/dist/test' "${LISTA[@]}"

# Revisión: nada de secretos, dependencias ni datos locales dentro del paquete.
if tar -tzf "${ARCHIVO}" | grep -Eq '(^|/)\.env($|\.)|node_modules/|(^|/)storage/|\.releases/'; then
  echo "El paquete contiene archivos prohibidos (.env, node_modules, storage):" >&2
  tar -tzf "${ARCHIVO}" | grep -E '(^|/)\.env($|\.)|node_modules/|(^|/)storage/' >&2
  rm -f "${ARCHIVO}"; exit 1
fi
(cd "${SALIDA}" && sha256sum "busperu-${VERSION}.tar.gz" > "busperu-${VERSION}.tar.gz.sha256")
echo "✔ ${ARCHIVO} ($(tar -tzf "${ARCHIVO}" | wc -l) entradas)"
cat "${ARCHIVO}.sha256"
