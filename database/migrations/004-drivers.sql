-- ---------------------------------------------------------------------------
-- 004 · Conductor y copiloto del viaje (mockup 31)
--
-- Implementa la propuesta de PENDIENTES.md §4 SIN cambios: la tabla `drivers` con sus
-- mismas columnas e índices, y las dos columnas que `trips` necesita para referenciar
-- al conductor y al copiloto.
--
-- Ejecutar con:
--   "C:\xampp\mysql\bin\mysql.exe" -u root -p busperu < database/migrations/004-drivers.sql
--
-- NOTA SOBRE EL ALTER
-- Es el único ALTER del proyecto sobre una tabla existente y está prescrito
-- explícitamente por PENDIENTES.md §4: no hay otra forma de asociar la tripulación a un
-- viaje. Es aditivo y no destructivo: dos columnas NULL con `ON DELETE SET NULL`, de modo
-- que los viajes existentes quedan intactos (sin tripulación) y borrar un conductor nunca
-- borra un viaje. Cada ALTER va condicionado a que la columna no exista,
-- de modo que la migración puede reejecutarse sin error.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `drivers` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `company_id` int(10) unsigned NOT NULL,
  `first_name` varchar(100) NOT NULL,
  `last_name` varchar(100) NOT NULL,
  `document_number` varchar(30) NOT NULL,
  `license_number` varchar(50) NOT NULL,
  `license_expires_at` date DEFAULT NULL,
  `phone` varchar(30) DEFAULT NULL,
  `status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `document_number` (`document_number`),
  KEY `idx_drivers_company` (`company_id`),
  CONSTRAINT `fk_drivers_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Columnas de tripulación en `trips`, idempotentes ----------------------------
-- Se usa PREPARE/EXECUTE en lugar de un procedimiento con DELIMITER: DELIMITER es una
-- directiva del cliente mysql y no la entiende un driver que ejecuta sentencia a
-- sentencia. Así la migración vale igual desde la consola que desde la suite de tests.

SET @existe := (SELECT COUNT(*) FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = 'trips' AND column_name = 'driver_id');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `trips` ADD COLUMN `driver_id` int(10) unsigned DEFAULT NULL AFTER `bus_id`',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @existe := (SELECT COUNT(*) FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = 'trips' AND column_name = 'co_driver_id');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `trips` ADD COLUMN `co_driver_id` int(10) unsigned DEFAULT NULL AFTER `driver_id`',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @existe := (SELECT COUNT(*) FROM information_schema.table_constraints
                WHERE table_schema = DATABASE() AND table_name = 'trips' AND constraint_name = 'fk_trips_driver');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `trips` ADD CONSTRAINT `fk_trips_driver` FOREIGN KEY (`driver_id`) REFERENCES `drivers` (`id`) ON DELETE SET NULL',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @existe := (SELECT COUNT(*) FROM information_schema.table_constraints
                WHERE table_schema = DATABASE() AND table_name = 'trips' AND constraint_name = 'fk_trips_co_driver');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `trips` ADD CONSTRAINT `fk_trips_co_driver` FOREIGN KEY (`co_driver_id`) REFERENCES `drivers` (`id`) ON DELETE SET NULL',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Comprobación
SELECT 'drivers' AS tabla,
       (SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'drivers') AS existe,
       (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'trips' AND column_name IN ('driver_id','co_driver_id')) AS columnas_en_trips,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()) AS tablas_totales;
