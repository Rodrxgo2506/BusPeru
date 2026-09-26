#!/usr/bin/env bash
# BusPerú · F18-03 · crea la base del entorno (BUSPERU_ENV: staging | prod) y los dos usuarios de la aplicación (idempotente).
#
#   DB_HOST=<endpoint RDS> MASTER_SECRET_ARN=<arn> bash create-db-users.sh
#
# Usa el usuario MAESTRO solo aquí (y la EC2 solo puede leer su secreto mientras el parámetro de la
# plantilla AllowMasterSecretAccess está en "true"). Crea:
#
#   busperu_migrator  SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, LOCK TABLES
#                     → importar el dump (DROP/CREATE/LOCK TABLES) y aplicar migraciones (ALTER, índices, FK)
#   busperu_app       SELECT, INSERT, UPDATE, DELETE → lo único que usa la API en ejecución
#                     (GET_LOCK, usado por los pagos, no requiere privilegio)
#
# Ambos, solo sobre `${DB_NAME}`.* y solo desde la VPC (DB_USER_HOST; por defecto la VPC de la plantilla de cada
# entorno: 10.20.% en staging y 10.30.% en producción). Una
# segunda ejecución re-sincroniza contraseñas y permisos sin duplicar nada.
source "$(dirname "$0")/db-common.sh"
case "${BUSPERU_ENV}" in prod) VPC_POR_DEFECTO="10.30.%" ;; *) VPC_POR_DEFECTO="10.20.%" ;; esac
DB_USER_HOST="${DB_USER_HOST:-${VPC_POR_DEFECTO}}"
[[ "${DB_USER_HOST}" =~ ^[0-9.%]+$|^localhost$|^127\.0\.0\.1$ ]] || { echo "DB_USER_HOST no válido" >&2; exit 1; }

temporal; MAESTRO="${REPLY}"; credencial_maestra "${MAESTRO}"
verificar_servidor "${MAESTRO}"
APP="$(clave_app)"; validar_clave "${APP}" busperu_app
MIG="$(clave_migrador)"; validar_clave "${MIG}" busperu_migrator
[ "${APP}" != "${MIG}" ] || { echo "ABORTADO: la app y el migrador no pueden compartir contraseña" >&2; exit 1; }

"${MARIADB}" --defaults-extra-file="$(ruta_cliente "${MAESTRO}")" <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'busperu_migrator'@'${DB_USER_HOST}' IDENTIFIED BY '${MIG}';
ALTER USER 'busperu_migrator'@'${DB_USER_HOST}' IDENTIFIED BY '${MIG}';
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'busperu_migrator'@'${DB_USER_HOST}';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, LOCK TABLES
  ON \`${DB_NAME}\`.* TO 'busperu_migrator'@'${DB_USER_HOST}';

CREATE USER IF NOT EXISTS 'busperu_app'@'${DB_USER_HOST}' IDENTIFIED BY '${APP}';
ALTER USER 'busperu_app'@'${DB_USER_HOST}' IDENTIFIED BY '${APP}';
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'busperu_app'@'${DB_USER_HOST}';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${DB_NAME}\`.* TO 'busperu_app'@'${DB_USER_HOST}';
SQL
unset APP MIG

echo "== permisos resultantes (sin hashes)"
for U in busperu_migrator busperu_app; do
  "${MARIADB}" --defaults-extra-file="$(ruta_cliente "${MAESTRO}")" -N -B -e "SHOW GRANTS FOR '${U}'@'${DB_USER_HOST}'" \
    | sed -E "s/IDENTIFIED BY PASSWORD '[^']*'/IDENTIFIED BY PASSWORD '***'/"
done
if [ "${BUSPERU_ENV}" = prod ]; then
  echo "✔ base ${DB_NAME} y usuarios listos (producción: prod-db-bootstrap.sh guarda las contraseñas y rota el maestro)."
else
  echo "✔ base ${DB_NAME} y usuarios listos. Volver a poner AllowMasterSecretAccess=false (runbook §4)."
fi
