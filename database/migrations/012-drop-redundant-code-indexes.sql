-- ===========================================================================
-- Migracion 012 · fuera dos indices duplicados de codigo
-- ===========================================================================
--
-- QUE PASABA (auditoria final, hallazgo H-19). El dump original crea dos veces el
-- mismo indice sobre dos columnas:
--
--   bookings.booking_code   UNIQUE KEY `booking_code` (`booking_code`)
--                           KEY `idx_bookings_code`   (`booking_code`)
--
--   coupons.code            UNIQUE KEY `code`             (`code`)
--                           KEY `idx_coupons_code`        (`code`)
--
-- En cada pareja los dos indices son BTREE, sobre la MISMA unica columna, sin
-- prefijo, con la misma collation (utf8mb4_unicode_ci) y sin expresion ni
-- condicion. El UNIQUE ya es un indice de busqueda completo; el KEY secundario
-- solo duplica el trabajo de escritura y el espacio.
--
-- COMO SE COMPROBO, antes de escribir esta migracion:
--   · SHOW INDEX y SHOW CREATE TABLE en `busperu_test` y, en solo lectura, en
--     `busperu`: la definicion es identica en las dos bases.
--   · Ninguna FK usa esas columnas: las claves ajenas de ambas tablas tienen sus
--     propios indices y las que las referencian apuntan a `id`.
--   · Ningun codigo, seed, test ni documento nombra estos indices ni usa
--     USE / FORCE / IGNORE INDEX.
--   · EXPLAIN de las consultas reales, con y sin el KEY duplicado (tambien con
--     5000 cupones cargados temporalmente en `busperu_test`):
--       - `SELECT id FROM bookings WHERE booking_code = ?`            → const por `booking_code`
--       - `… FROM coupons c … WHERE c.code = ? … FOR UPDATE`          → const por `code`
--       - listado de cupones `ORDER BY c.code, c.id LIMIT … OFFSET …` → mismo plan con y sin
--         el KEY (ninguno de los dos se usa: la consulta selecciona `c.*`)
--     El plan de cada consulta es el mismo con o sin el indice duplicado.
--
-- QUE HACE: elimina SOLO `idx_bookings_code` e `idx_coupons_code`.
--
-- LO QUE NO CAMBIA:
--   · los UNIQUE `booking_code` y `code`: los codigos duplicados se siguen
--     rechazando exactamente igual;
--   · columnas, datos, claves primarias, claves ajenas y el resto de indices.
--
-- Es reejecutable: cada indice se elimina solo si todavia existe.
--
-- COMO VOLVER ATRAS (el proyecto no usa migraciones "down"):
--   ALTER TABLE `bookings` ADD KEY `idx_bookings_code` (`booking_code`);
--   ALTER TABLE `coupons`  ADD KEY `idx_coupons_code`  (`code`);
--
-- Ejecutar con:
--   "C:\xampp\mysql\bin\mysql.exe" -u root -p busperu < database/migrations/012-drop-redundant-code-indexes.sql

-- ---------------------------------------------------------------------------
-- 1 · bookings: fuera `idx_bookings_code`, solo si sigue existiendo y el UNIQUE esta
-- ---------------------------------------------------------------------------

SET @duplicado := (SELECT COUNT(*) FROM information_schema.statistics
                   WHERE table_schema = DATABASE() AND table_name = 'bookings' AND index_name = 'idx_bookings_code');
SET @unico := (SELECT COUNT(*) FROM information_schema.statistics
               WHERE table_schema = DATABASE() AND table_name = 'bookings' AND index_name = 'booking_code'
                 AND non_unique = 0 AND column_name = 'booking_code');
SET @sql := IF(@duplicado > 0 AND @unico = 1,
  'ALTER TABLE `bookings` DROP INDEX `idx_bookings_code`',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 2 · coupons: fuera `idx_coupons_code`, solo si sigue existiendo y el UNIQUE esta
-- ---------------------------------------------------------------------------

SET @duplicado := (SELECT COUNT(*) FROM information_schema.statistics
                   WHERE table_schema = DATABASE() AND table_name = 'coupons' AND index_name = 'idx_coupons_code');
SET @unico := (SELECT COUNT(*) FROM information_schema.statistics
               WHERE table_schema = DATABASE() AND table_name = 'coupons' AND index_name = 'code'
                 AND non_unique = 0 AND column_name = 'code');
SET @sql := IF(@duplicado > 0 AND @unico = 1,
  'ALTER TABLE `coupons` DROP INDEX `idx_coupons_code`',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 3 · Comprobacion: deben quedar los UNIQUE y ningun indice duplicado
-- ---------------------------------------------------------------------------

SELECT table_name AS tabla, index_name AS indice, non_unique AS no_unico, column_name AS columna
FROM information_schema.statistics
WHERE table_schema = DATABASE()
  AND ((table_name = 'bookings' AND column_name = 'booking_code')
    OR (table_name = 'coupons' AND column_name = 'code'))
ORDER BY table_name, index_name;
