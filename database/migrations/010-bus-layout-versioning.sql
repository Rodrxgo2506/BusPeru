-- ---------------------------------------------------------------------------
-- 010 · Versionado de la configuración física del bus y precios por tipo de asiento
--
-- Ejecutar con:
--   "C:\xampp\mysql\bin\mysql.exe" -u root -p busperu < database/migrations/010-bus-layout-versioning.sql
--
-- QUÉ RESUELVE
-- Hoy `seats` cuelga directamente de `buses` y `seatMap()` resuelve el mapa de un viaje
-- contra los asientos VIVOS del bus. Reordenar un bus le cambia el mapa a los viajes ya
-- vendidos. Esta migración interpone una VERSIÓN entre el bus y sus asientos:
--
--   buses → bus_layouts → bus_layout_decks → bus_layout_elements
--                      └→ seats
--   trips.bus_layout_id ─┘   (el viaje fija su versión y ya no puede cambiar)
--
-- Además separa el precio del viaje del precio del asiento: `trip_seat_type_prices` da un
-- precio por tipo de asiento y viaje, y `trips.base_price` sigue siendo el valor por
-- defecto cuando no hay fila específica.
--
-- ES ADITIVA
-- No hay DROP TABLE, ni DELETE, ni TRUNCATE. Solo se crean cuatro tablas, se añaden tres
-- columnas NULL y se sustituye UN índice único de `seats` (ver la nota más abajo, es el
-- único cambio delicado). Ningún id existente cambia. `buses.capacity` no se toca.
--
-- ES REEJECUTABLE
-- Todas las creaciones usan IF NOT EXISTS y todos los ALTER van guardados con el patrón
-- PREPARE/EXECUTE de la migración 004, que no depende de DELIMITER y por tanto vale igual
-- desde la consola de mysql que desde el ejecutor de la suite de pruebas. Los rellenos
-- están escritos con WHERE ... IS NULL / NOT EXISTS, de modo que una segunda pasada no
-- duplica nada.
--
-- NOTA SOBRE LOS NOMBRES `row_count` / `column_count`
-- El piso guarda su rejilla en `row_count` y `column_count`, no en `rows` y `columns`.
-- `rows` es PALABRA RESERVADA en el MariaDB 10.4.32 de este proyecto —comprobado: `SELECT 1
-- AS rows` es un error de parseo y solo funciona entre acentos graves—, de modo que llamarla
-- así obligaría a citarla en cada consulta futura para siempre. Los nombres elegidos, además
-- de no estar reservados, dicen lo que contienen: el número de filas y de columnas de la
-- rejilla del piso.
--
-- NOTA SOBRE EL CAMBIO DE ÍNDICE EN `seats`
-- `uq_bus_seat_number (bus_id, seat_number)` es incompatible con el versionado: el asiento
-- «01» del bus 3 existirá una vez por versión. Se sustituye por
-- `uq_layout_seat_number (layout_id, seat_number)`, que es además la garantía correcta —un
-- número no puede repetirse DENTRO de una distribución—. El orden importa y está resuelto
-- abajo: primero se rellena `layout_id`, después se crea el índice nuevo y solo entonces se
-- retira el viejo. `bus_id` conserva su índice `idx_seats_bus`, así que la clave ajena
-- `fk_seats_bus` sigue teniendo soporte y el DROP no puede fallar por ese motivo.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- BLOQUE 1 · Tablas nuevas
-- ===========================================================================

-- La versión. `published_scope` es una columna GENERADA, no un dato nuevo: repite el
-- `bus_id` solo cuando la fila está publicada y vale NULL en el resto. Como en
-- MySQL/MariaDB los NULL no colisionan dentro de un índice único, la clave
-- `uq_layout_published_bus` deja infinitas versiones DRAFT o ARCHIVED por bus y como mucho
-- UNA publicada. Es la misma técnica que ya usa `company_integrations.company_scope`
-- (migración 009); no se inventa un mecanismo distinto para el mismo problema.
CREATE TABLE IF NOT EXISTS `bus_layouts` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `bus_id` int(10) unsigned NOT NULL,
  `version` smallint(5) unsigned NOT NULL DEFAULT 1,
  `status` enum('DRAFT','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
  `published_scope` int(10) unsigned AS (IF(`status` = 'PUBLISHED', `bus_id`, NULL)) STORED COMMENT 'Derivada: garantiza una sola version PUBLISHED por bus.',
  `name` varchar(100) DEFAULT NULL,
  `seat_count` smallint(5) unsigned NOT NULL DEFAULT 0 COMMENT 'Cache del numero de asientos de la version.',
  `published_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_layout_bus_version` (`bus_id`, `version`),
  UNIQUE KEY `uq_layout_published_bus` (`published_scope`),
  KEY `idx_bus_layouts_bus` (`bus_id`),
  KEY `idx_bus_layouts_status` (`status`),
  CONSTRAINT `fk_bus_layouts_bus` FOREIGN KEY (`bus_id`) REFERENCES `buses` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Los pisos de una versión. Un bus de un piso tendrá una fila; uno de dos, dos.
CREATE TABLE IF NOT EXISTS `bus_layout_decks` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `layout_id` int(10) unsigned NOT NULL,
  `deck_number` smallint(5) unsigned NOT NULL DEFAULT 1,
  `name` varchar(100) DEFAULT NULL,
  `row_count` smallint(5) unsigned NOT NULL DEFAULT 0,
  `column_count` smallint(5) unsigned NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_deck_layout_number` (`layout_id`, `deck_number`),
  KEY `idx_bus_layout_decks_layout` (`layout_id`),
  CONSTRAINT `fk_bus_layout_decks_layout` FOREIGN KEY (`layout_id`) REFERENCES `bus_layouts` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Todo lo que ocupa una casilla y NO es un asiento. No tiene numero de asiento, no cuenta
-- como pasajero, no afecta a la capacidad y nunca entra en `booking_seats`.
CREATE TABLE IF NOT EXISTS `bus_layout_elements` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `deck_id` int(10) unsigned NOT NULL,
  `element_type` enum('BATHROOM','STAIRS','DRIVER','DOOR','EMPTY') NOT NULL,
  `row_number` smallint(5) unsigned NOT NULL,
  `column_number` smallint(5) unsigned NOT NULL,
  `row_span` smallint(5) unsigned NOT NULL DEFAULT 1,
  `col_span` smallint(5) unsigned NOT NULL DEFAULT 1,
  `label` varchar(100) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_bus_layout_elements_deck` (`deck_id`),
  KEY `idx_bus_layout_elements_position` (`deck_id`, `row_number`, `column_number`),
  CONSTRAINT `fk_bus_layout_elements_deck` FOREIGN KEY (`deck_id`) REFERENCES `bus_layout_decks` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Precio por tipo de asiento Y viaje. La ausencia de fila NO es un error: significa
-- «cobrar `trips.base_price`». El importe realmente cobrado se sigue guardando en
-- `booking_seats.price`, que es donde vive el historico.
CREATE TABLE IF NOT EXISTS `trip_seat_type_prices` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `trip_id` int(10) unsigned NOT NULL,
  `seat_type_id` int(10) unsigned NOT NULL,
  `price` decimal(10,2) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_trip_seat_type_price` (`trip_id`, `seat_type_id`),
  KEY `idx_trip_seat_type_prices_trip` (`trip_id`),
  KEY `idx_trip_seat_type_prices_type` (`seat_type_id`),
  CONSTRAINT `fk_trip_seat_type_prices_trip` FOREIGN KEY (`trip_id`) REFERENCES `trips` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_trip_seat_type_prices_type` FOREIGN KEY (`seat_type_id`) REFERENCES `seat_types` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ===========================================================================
-- BLOQUE 2 · Columnas nuevas en tablas existentes (nullable, sin clave ajena todavia)
-- ===========================================================================
-- Se anaden vacias y SIN clave ajena para poder rellenarlas antes de validarlas. Las
-- claves se crean en el bloque 5, cuando los datos ya son coherentes: asi cualquier
-- inconsistencia sale como error del ALTER y no queda escondida.

SET @existe := (SELECT COUNT(*) FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = 'seats' AND column_name = 'layout_id');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `seats` ADD COLUMN `layout_id` int(10) unsigned DEFAULT NULL AFTER `bus_id`',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @existe := (SELECT COUNT(*) FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = 'seats' AND column_name = 'deck_id');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `seats` ADD COLUMN `deck_id` int(10) unsigned DEFAULT NULL AFTER `layout_id`',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @existe := (SELECT COUNT(*) FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = 'trips' AND column_name = 'bus_layout_id');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `trips` ADD COLUMN `bus_layout_id` int(10) unsigned DEFAULT NULL AFTER `bus_id`',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- ===========================================================================
-- BLOQUE 3 · Version 1 para cada bus existente
-- ===========================================================================
-- Una version PUBLISHED por bus, con `seat_count` calculado de sus asientos reales. El
-- WHERE NOT EXISTS hace la sentencia reejecutable y evita crear una segunda version a un
-- bus que ya la tenga.

INSERT INTO `bus_layouts` (`bus_id`, `version`, `status`, `name`, `seat_count`, `published_at`)
SELECT b.`id`,
       1,
       'PUBLISHED',
       'Version 1',
       (SELECT COUNT(*) FROM `seats` s WHERE s.`bus_id` = b.`id`),
       NOW()
FROM `buses` b
WHERE NOT EXISTS (SELECT 1 FROM `bus_layouts` bl WHERE bl.`bus_id` = b.`id`);


-- ===========================================================================
-- BLOQUE 4 · Piso 1 de cada version, y anclaje de asientos y viajes
-- ===========================================================================

-- Un unico piso por version. `row_count` y `column_count` se calculan de los asientos que ya
-- existen; COALESCE cubre el caso de un bus cuyos asientos no tengan rejilla declarada, que
-- queda con 0 y se comporta como hasta ahora.
INSERT INTO `bus_layout_decks` (`layout_id`, `deck_number`, `name`, `row_count`, `column_count`)
SELECT bl.`id`,
       1,
       'Piso 1',
       COALESCE((SELECT MAX(s.`row_number`) FROM `seats` s WHERE s.`bus_id` = bl.`bus_id`), 0),
       COALESCE((SELECT MAX(s.`column_number`) FROM `seats` s WHERE s.`bus_id` = bl.`bus_id`), 0)
FROM `bus_layouts` bl
WHERE bl.`version` = 1
  AND NOT EXISTS (SELECT 1 FROM `bus_layout_decks` d WHERE d.`layout_id` = bl.`id` AND d.`deck_number` = 1);

-- Los asientos existentes se enganchan a la version 1 de su bus y a su piso 1. No se toca
-- ni el id, ni el numero, ni la fila, ni la columna, ni el tipo, ni el estado, ni bus_id.
UPDATE `seats` s
JOIN `bus_layouts` bl ON bl.`bus_id` = s.`bus_id` AND bl.`version` = 1
JOIN `bus_layout_decks` d ON d.`layout_id` = bl.`id` AND d.`deck_number` = 1
SET s.`layout_id` = bl.`id`,
    s.`deck_id` = d.`id`
WHERE s.`layout_id` IS NULL;

-- Los viajes quedan anclados a la version 1, incluidos los pasados: a partir de aqui su
-- mapa ya no depende de lo que la empresa haga con el bus.
UPDATE `trips` t
JOIN `bus_layouts` bl ON bl.`bus_id` = t.`bus_id` AND bl.`version` = 1
SET t.`bus_layout_id` = bl.`id`
WHERE t.`bus_layout_id` IS NULL;


-- ===========================================================================
-- BLOQUE 5 · Claves ajenas e indices, ya con los datos coherentes
-- ===========================================================================
-- Politica de borrado, siguiendo las convenciones del esquema actual:
--   · seats.layout_id / seats.deck_id  → CASCADE, igual que `fk_seats_bus`. El asiento es
--     parte de la version; si la version desapareciera, el asiento no tiene sentido. La
--     historia no corre peligro: `fk_booking_seats_seat` es RESTRICT y no deja borrar un
--     asiento vendido, asi que la version que lo contiene tampoco se puede borrar.
--   · trips.bus_layout_id → SIN ON DELETE, es decir RESTRICT, exactamente como
--     `fk_trips_bus`. Este es el candado que sostiene el historico: una version usada por
--     un viaje no se puede borrar nunca.

SET @existe := (SELECT COUNT(*) FROM information_schema.table_constraints
                WHERE table_schema = DATABASE() AND table_name = 'seats' AND constraint_name = 'fk_seats_layout');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `seats` ADD CONSTRAINT `fk_seats_layout` FOREIGN KEY (`layout_id`) REFERENCES `bus_layouts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @existe := (SELECT COUNT(*) FROM information_schema.table_constraints
                WHERE table_schema = DATABASE() AND table_name = 'seats' AND constraint_name = 'fk_seats_deck');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `seats` ADD CONSTRAINT `fk_seats_deck` FOREIGN KEY (`deck_id`) REFERENCES `bus_layout_decks` (`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @existe := (SELECT COUNT(*) FROM information_schema.table_constraints
                WHERE table_schema = DATABASE() AND table_name = 'trips' AND constraint_name = 'fk_trips_bus_layout');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `trips` ADD CONSTRAINT `fk_trips_bus_layout` FOREIGN KEY (`bus_layout_id`) REFERENCES `bus_layouts` (`id`) ON UPDATE CASCADE',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Indice de apoyo para resolver el mapa de un viaje por version.
SET @existe := (SELECT COUNT(*) FROM information_schema.statistics
                WHERE table_schema = DATABASE() AND table_name = 'seats' AND index_name = 'idx_seats_layout');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `seats` ADD KEY `idx_seats_layout` (`layout_id`)',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @existe := (SELECT COUNT(*) FROM information_schema.statistics
                WHERE table_schema = DATABASE() AND table_name = 'seats' AND index_name = 'idx_seats_deck');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `seats` ADD KEY `idx_seats_deck` (`deck_id`)',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @existe := (SELECT COUNT(*) FROM information_schema.statistics
                WHERE table_schema = DATABASE() AND table_name = 'trips' AND index_name = 'idx_trips_bus_layout');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `trips` ADD KEY `idx_trips_bus_layout` (`bus_layout_id`)',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- ===========================================================================
-- BLOQUE 6 · Sustitucion del indice unico de `seats`
-- ===========================================================================
-- PRIMERO se crea el nuevo, DESPUES se retira el viejo. Si el nuevo fallara por datos
-- inconsistentes, la migracion se detiene con el indice antiguo todavia puesto y la tabla
-- protegida. `bus_id` conserva `idx_seats_bus`, de modo que `fk_seats_bus` sigue teniendo
-- indice de soporte y el DROP no puede fallar por dependencia de la clave ajena.

SET @existe := (SELECT COUNT(*) FROM information_schema.statistics
                WHERE table_schema = DATABASE() AND table_name = 'seats' AND index_name = 'uq_layout_seat_number');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `seats` ADD UNIQUE KEY `uq_layout_seat_number` (`layout_id`, `seat_number`)',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @existe := (SELECT COUNT(*) FROM information_schema.statistics
                WHERE table_schema = DATABASE() AND table_name = 'seats' AND index_name = 'uq_bus_seat_number');
SET @sql := IF(@existe > 0,
  'ALTER TABLE `seats` DROP INDEX `uq_bus_seat_number`',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- ===========================================================================
-- Comprobacion
-- ===========================================================================

SELECT 'bus_layouts' AS tabla,
       (SELECT COUNT(*) FROM `bus_layouts`) AS versiones,
       (SELECT COUNT(*) FROM `bus_layout_decks`) AS pisos,
       (SELECT COUNT(*) FROM `seats` WHERE `layout_id` IS NULL) AS asientos_sin_version,
       (SELECT COUNT(*) FROM `trips` WHERE `bus_layout_id` IS NULL) AS viajes_sin_version,
       (SELECT COUNT(*) FROM `seats`) AS asientos_totales,
       (SELECT COUNT(*) FROM `booking_seats`) AS booking_seats_intactos,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()) AS tablas_totales;
