#!/usr/bin/env bash
# BusPerú · F18-07A · aplica UNA migración, nombrada explícitamente, a una base que YA existe.
#
#   DB_HOST=<endpoint RDS> bash apply-one-migration.sh <archivo.sql> <base> [raíz del proyecto]
#
# Es el paso «aplicar solo las migraciones pendientes» del runbook (§5.1 y §8) para una base con datos
# (p. ej. 019 sobre busperu_staging, instalada con 001 → 018). Con el usuario migrador, sin --force: se
# detiene en el primer error y lo muestra tal cual. Se niega si:
#   · la base repetida no coincide con DB_NAME (una orden pegada contra otra base no hace nada);
#   · la base no tiene un número de tablas de una instalación de BusPerú conocida: 49 (001 → 019),
#     53 (+020, perfiles públicos) o 56 (+021, Libro de Reclamaciones). 020 y 021 son idempotentes
#     (CREATE TABLE IF NOT EXISTS / INSERT IGNORE), así que repetirlas no cambia nada;
#   · el archivo no es una migración numerada del propio paquete.
# Imprime solo nombres, recuentos y el resultado de las comprobaciones del script (sin datos).
source "$(dirname "$0")/db-common.sh"
ARCHIVO="${1:?uso: apply-one-migration.sh <archivo.sql> <base> [raíz]}"
CONFIRMACION="${2:?uso: apply-one-migration.sh <archivo.sql> <base> [raíz]}"
RAIZ="${3:-$(cd "$(dirname "$0")/../../.." && pwd)}"
MIGRACION="${RAIZ}/database/migrations/${ARCHIVO}"

[[ "${ARCHIVO}" =~ ^0[0-9][0-9]-[a-z0-9-]+\.sql$ ]] || { echo "ABORTADO: nombre de migración no válido (${ARCHIVO})" >&2; exit 1; }
[ -f "${MIGRACION}" ] || { echo "ABORTADO: no existe ${MIGRACION}" >&2; exit 1; }
[ "${CONFIRMACION}" = "${DB_NAME}" ] || { echo "ABORTADO: la base indicada (${CONFIRMACION}) no es DB_NAME (${DB_NAME}). No se ha modificado nada." >&2; exit 1; }

temporal; MIGRADOR="${REPLY}"; escribir_opciones "${MIGRADOR}" busperu_migrator "$(clave_migrador)"
verificar_servidor "${MIGRADOR}"
m() { "${MARIADB}" --defaults-extra-file="$(ruta_cliente "${MIGRADOR}")" "$@"; }

TABLAS="$(m -N -B -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${DB_NAME}'")"
case "${TABLAS}" in 49|53|56) ;; *) echo "ABORTADO: ${DB_NAME} tiene ${TABLAS} tablas y se esperaban 49, 53 o 56" >&2; exit 1 ;; esac
echo "base destino: ${DB_NAME} (${TABLAS} tablas) · usuario: busperu_migrator · migración: ${ARCHIVO}"

if ! salida="$(m "${DB_NAME}" < "${MIGRACION}" 2>&1)"; then
  printf '%-52s FALLO\n%s\nDETENIDO\n' "${ARCHIVO}" "${salida}" >&2
  exit 1
fi
printf '%-52s OK\n' "${ARCHIVO}"
[ -n "${salida}" ] && printf 'comprobación del script:\n%s\n' "${salida}"
exit 0
