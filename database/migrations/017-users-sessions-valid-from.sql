-- ===========================================================================
-- Migracion 017 · terminacion real de sesiones al suspender (F17C-SEC-10)
-- ===========================================================================
--
-- QUE PASABA (F17C-SEC-09, hallazgo A). El estado del usuario se relee de la base en CADA
-- peticion, asi que mientras la cuenta esta SUSPENDED su JWT recibe 403: la suspension SI
-- surte efecto. Lo que no ocurria es la TERMINACION. El JWT es sin estado y vive 8 horas,
-- de modo que al volver la cuenta a ACTIVE cualquier token emitido ANTES de la suspension
-- volvia a funcionar hasta agotar su plazo. En el escenario que importa —se suspende una
-- cuenta porque se sospecha que esta comprometida— el token del atacante no se destruia:
-- solo quedaba en pausa, y revivia con la reactivacion.
--
-- Habia una forma de invalidarlo, cambiar la contrasena (la huella `pwd` de BP-18 deja de
-- coincidir), pero es un paso aparte que nadie obliga a dar y que no es lo que significa
-- "suspender".
--
-- QUE HACE. Anade `users.sessions_valid_from`: el instante a partir del cual las sesiones de
-- esa cuenta son validas. Al pasar el estado a algo distinto de ACTIVE, la marca avanza a
-- NOW() y todo token emitido antes deja de valer. Reactivar NO retrocede la marca, asi que
-- los tokens viejos siguen invalidados y hay que iniciar sesion de nuevo.
--
-- POR QUE UNA COLUMNA Y NO UNA TABLA DE SESIONES. El proyecto ya tiene dos mecanismos sin
-- estado (`pwd` y `jti` en `revoked_sessions`) y no guarda sesiones. Una marca por usuario
-- invalida TODAS sus sesiones de golpe con un solo dato, sin inventariar tokens que ni
-- siquiera se conocen: al suspender no hay forma de enumerar los JWT emitidos.
--
-- NULL = nunca se ha suspendido esta cuenta, y entonces no hay restriccion. Por eso la
-- columna admite NULL y NO hace falta ningun backfill: las cuentas existentes se quedan
-- exactamente como estan y ninguna sesion viva se corta al desplegar.
--
-- SIN INDICE A PROPOSITO: la columna se lee siempre por `users.id`, que es la clave
-- primaria, y jamas se filtra ni se ordena por ella.
--
-- PRECISION. El `iat` de un JWT va en SEGUNDOS. La comparacion es ESTRICTA (`iat` posterior
-- a la marca): si un token se emitio en el mismo segundo en que se suspendio la cuenta, se
-- rechaza. Es el lado seguro, y el unico coste es que ese usuario vuelva a iniciar sesion.
--
-- LO QUE NO CAMBIA: ninguna otra tabla, ni la duracion del JWT, ni su firma, ni `pwd`, ni
-- `revoked_sessions`. Las tres comprobaciones conviven; esta se suma, no sustituye a nadie.
--
-- DESPLIEGUE: el middleware de autenticacion lee esta columna en cada peticion autenticada,
-- asi que la migracion debe aplicarse ANTES de desplegar el codigo que la usa.
--
-- Es reejecutable: si la columna ya existe, no hace nada.
--
-- COMO VOLVER ATRAS: `ALTER TABLE users DROP COLUMN sessions_valid_from;` (junto con el
-- codigo anterior). No se pierde ningun dato de negocio.
--
-- Ejecutar con:
--   "C:\xampp\mysql\bin\mysql.exe" -u root -p <base> < database/migrations/017-users-sessions-valid-from.sql
-- ===========================================================================

SET @ddl := (SELECT IF(COUNT(*) > 0, 'SELECT 1',
  'ALTER TABLE `users` ADD COLUMN `sessions_valid_from` datetime DEFAULT NULL COMMENT ''Instante desde el que son validas las sesiones. NULL = sin restriccion. Avanza al suspender; reactivar no lo retrocede.'' AFTER `last_login_at`')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'sessions_valid_from');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Comprobacion
SELECT 'users.sessions_valid_from' AS columna,
       (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'sessions_valid_from') AS existe,
       (SELECT COUNT(*) FROM users) AS usuarios,
       (SELECT COUNT(*) FROM users WHERE sessions_valid_from IS NOT NULL) AS con_marca;
