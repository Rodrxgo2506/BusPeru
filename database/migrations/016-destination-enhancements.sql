-- ===========================================================================
-- Migracion 016 · datos que necesita la ficha de destino (FASE 17B)
-- ===========================================================================
--
-- QUE HACE. La pagina publica de un destino muestra, ademas de lo que ya guarda `015`:
--
--   · la ALTITUD en msnm y la TEMPERATURA, como insignias circulares;
--   · el TIEMPO DE VIAJE desde la ciudad de origen sugerida (ej. 18hr / Desde Lima);
--   · dos HORARIOS separados: pasajes y encomiendas;
--   · una IMAGEN propia para la seccion Calendario festivo;
--   · la CIUDAD del destino y la CIUDAD DE ORIGEN sugerida, para que el buscador de la ficha
--     llegue precargado sin que el codigo adivine nombres.
--
-- POR QUE DOS CLAVES A `locations`. El buscador trabaja con CIUDADES, y las ciudades del sistema
-- salen de `locations` (no existe una tabla de ciudades). Se referencia una ubicacion real en
-- lugar de guardar texto libre: asi no se duplican ciudades ni se inventan nombres. Ambas son
-- OPCIONALES: un destino editorial puede publicarse sin ciudad asociada todavia.
--   · `location_id`        → ciudad del destino (el "a donde").
--   · `origin_location_id` → ciudad desde la que se sugiere el viaje (el "desde").
-- `ON DELETE SET NULL`: borrar un terminal no puede borrar contenido editorial.
--
-- COLUMNAS QUE QUEDAN OBSOLETAS. `schedule` y `weather` de la `015` se sustituyen por
-- `ticket_schedule` y `temperature`. NO se borran (un DROP es irreversible y aqui no hace falta):
-- se copian sus valores y dejan de usarse. Una migracion futura puede retirarlas.
--
-- LO QUE NO CAMBIA: ninguna otra tabla, ningun rol ni permiso. La administracion sigue usando
-- `settings.*` + rol ADMIN. `price_from` sigue siendo contenido comercial y no toca precios reales.
--
-- Es reejecutable: cada ALTER comprueba antes en information_schema.
--
-- COMO VOLVER ATRAS:
--   ALTER TABLE destinations
--     DROP FOREIGN KEY fk_destinations_location, DROP FOREIGN KEY fk_destinations_origin_location,
--     DROP COLUMN altitude_masl, DROP COLUMN temperature, DROP COLUMN time_from_lima,
--     DROP COLUMN ticket_schedule, DROP COLUMN package_schedule, DROP COLUMN festivities_image,
--     DROP COLUMN location_id, DROP COLUMN origin_location_id;
--
-- Ejecutar con:
--   "C:\xampp\mysql\bin\mysql.exe" -u root -p <base> < database/migrations/016-destination-enhancements.sql

SET @ddl := (SELECT IF(COUNT(*) > 0, 'SELECT 1',
  'ALTER TABLE `destinations` ADD COLUMN `altitude_masl` smallint(5) unsigned DEFAULT NULL AFTER `weather`')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'destinations' AND column_name = 'altitude_masl');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (SELECT IF(COUNT(*) > 0, 'SELECT 1',
  'ALTER TABLE `destinations` ADD COLUMN `temperature` varchar(60) DEFAULT NULL AFTER `altitude_masl`')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'destinations' AND column_name = 'temperature');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (SELECT IF(COUNT(*) > 0, 'SELECT 1',
  'ALTER TABLE `destinations` ADD COLUMN `time_from_lima` varchar(30) DEFAULT NULL AFTER `temperature`')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'destinations' AND column_name = 'time_from_lima');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (SELECT IF(COUNT(*) > 0, 'SELECT 1',
  'ALTER TABLE `destinations` ADD COLUMN `ticket_schedule` varchar(255) DEFAULT NULL AFTER `schedule`')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'destinations' AND column_name = 'ticket_schedule');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (SELECT IF(COUNT(*) > 0, 'SELECT 1',
  'ALTER TABLE `destinations` ADD COLUMN `package_schedule` varchar(255) DEFAULT NULL AFTER `ticket_schedule`')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'destinations' AND column_name = 'package_schedule');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (SELECT IF(COUNT(*) > 0, 'SELECT 1',
  'ALTER TABLE `destinations` ADD COLUMN `festivities_image` varchar(255) DEFAULT NULL AFTER `hero_image`')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'destinations' AND column_name = 'festivities_image');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (SELECT IF(COUNT(*) > 0, 'SELECT 1',
  'ALTER TABLE `destinations` ADD COLUMN `location_id` int(10) unsigned DEFAULT NULL AFTER `display_order`')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'destinations' AND column_name = 'location_id');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (SELECT IF(COUNT(*) > 0, 'SELECT 1',
  'ALTER TABLE `destinations` ADD COLUMN `origin_location_id` int(10) unsigned DEFAULT NULL AFTER `location_id`')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'destinations' AND column_name = 'origin_location_id');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (SELECT IF(COUNT(*) > 0, 'SELECT 1',
  'ALTER TABLE `destinations` ADD KEY `idx_destinations_location` (`location_id`)')
  FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'destinations' AND index_name = 'idx_destinations_location');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (SELECT IF(COUNT(*) > 0, 'SELECT 1',
  'ALTER TABLE `destinations` ADD KEY `idx_destinations_origin_location` (`origin_location_id`)')
  FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'destinations' AND index_name = 'idx_destinations_origin_location');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (SELECT IF(COUNT(*) > 0, 'SELECT 1',
  'ALTER TABLE `destinations` ADD CONSTRAINT `fk_destinations_location` FOREIGN KEY (`location_id`) REFERENCES `locations` (`id`) ON DELETE SET NULL ON UPDATE CASCADE')
  FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND constraint_name = 'fk_destinations_location');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (SELECT IF(COUNT(*) > 0, 'SELECT 1',
  'ALTER TABLE `destinations` ADD CONSTRAINT `fk_destinations_origin_location` FOREIGN KEY (`origin_location_id`) REFERENCES `locations` (`id`) ON DELETE SET NULL ON UPDATE CASCADE')
  FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND constraint_name = 'fk_destinations_origin_location');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Los valores de las columnas que quedan obsoletas pasan a las nuevas, sin pisar nada ya escrito.
UPDATE `destinations` SET `ticket_schedule` = `schedule` WHERE `ticket_schedule` IS NULL AND `schedule` IS NOT NULL;
UPDATE `destinations` SET `temperature` = `weather` WHERE `temperature` IS NULL AND `weather` IS NOT NULL;

SELECT 'destinations' AS tabla,
       (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'destinations'
          AND column_name IN ('altitude_masl','temperature','time_from_lima','ticket_schedule','package_schedule','festivities_image','location_id','origin_location_id')) AS columnas_nuevas,
       (SELECT COUNT(*) FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE()
          AND constraint_name IN ('fk_destinations_location','fk_destinations_origin_location')) AS claves_ajenas,
       (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'destinations'
          AND index_name IN ('idx_destinations_location','idx_destinations_origin_location')) AS indices;
