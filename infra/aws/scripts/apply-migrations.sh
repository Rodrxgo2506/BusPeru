#!/usr/bin/env bash
# BusPerú · F18-03 · instalación del esquema en una base VACÍA, con el usuario migrador.
#
#   DB_HOST=<endpoint RDS> bash apply-migrations.sh [raíz del proyecto]
#
# Aplica el dump (sin sus líneas CREATE DATABASE/USE, que apuntarían a `busperu`) y las migraciones
# 001 → 019 EN ORDEN, sin --force: se detiene en el primer error y lo muestra tal cual. Se niega a
# importar el dump sobre una base que ya tenga tablas (el dump hace DROP TABLE IF EXISTS).
# Para una base que ya existe, aplicar solo las migraciones pendientes a mano (runbook §8).
source "$(dirname "$0")/db-common.sh"
RAIZ="${1:-$(cd "$(dirname "$0")/../../.." && pwd)}"
DUMP="${RAIZ}/database/schema/Dump20260831.sql"
MIGRACIONES="${RAIZ}/database/migrations"
[ -f "${DUMP}" ] || { echo "no encuentro ${DUMP}" >&2; exit 1; }

temporal; MIGRADOR="${REPLY}"; escribir_opciones "${MIGRADOR}" busperu_migrator "$(clave_migrador)"
verificar_servidor "${MIGRADOR}"
m() { "${MARIADB}" --defaults-extra-file="$(ruta_cliente "${MIGRADOR}")" "$@"; }

TABLAS="$(m -N -B -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${DB_NAME}'")"
[ "${TABLAS}" = 0 ] || { echo "ABORTADO: ${DB_NAME} ya tiene ${TABLAS} tablas; el dump solo se importa en una base vacía" >&2; exit 1; }
echo "base destino: ${DB_NAME} (vacía) · usuario: busperu_migrator"

grep -vE '^\s*(CREATE DATABASE|USE)\b' "${DUMP}" | m "${DB_NAME}"
printf '%-52s OK\n' "dump $(basename "${DUMP}")"

ESPERADAS=19
APLICADAS=0
for f in "${MIGRACIONES}"/0[0-9][0-9]-*.sql; do
  if ! salida="$(m "${DB_NAME}" < "${f}" 2>&1)"; then
    printf '%-52s FALLO\n%s\nVALIDACIÓN DETENIDA\n' "$(basename "${f}")" "${salida}" >&2
    exit 1
  fi
  printf '%-52s OK\n' "$(basename "${f}")"
  APLICADAS=$((APLICADAS + 1))
done
[ "${APLICADAS}" = "${ESPERADAS}" ] || { echo "ABORTADO: se esperaban ${ESPERADAS} migraciones y hay ${APLICADAS}" >&2; exit 1; }
echo "✔ esquema instalado: $(m -N -B -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${DB_NAME}'") tablas"
