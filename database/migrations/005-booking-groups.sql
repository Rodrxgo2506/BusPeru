-- ---------------------------------------------------------------------------
-- 005 · Ida y vuelta / multidestino (mockup 1)
--
-- PENDIENTES.md §8 plantea dos alternativas sin elegir: "una reserva por tramo o una
-- tabla de agrupación". Se implementa la primera, con una tabla que agrupa las reservas
-- de una misma compra.
--
-- POR QUÉ ESTA Y NO LA OTRA
-- Cada tramo sigue siendo una fila normal de `bookings`, así que:
--   · El flujo de IDA no cambia: una compra de un solo tramo no crea grupo (group_id NULL).
--   · Las ocho tablas que dependen de `bookings` (payments, refunds, reviews, coupon_usages,
--     financial_transactions, settlement_items, support_tickets, booking_seats) conservan
--     exactamente su significado.
--   · Un ida y vuelta puede combinar empresas distintas: cada tramo lleva su empresa a
--     través de trip → route → company_id, de modo que comisiones, liquidaciones y
--     reembolsos siguen cuadrando por empresa. Con una sola reserva multitramo eso se
--     rompería.
--
-- Ejecutar con:
--   "C:\xampp\mysql\bin\mysql.exe" -u root -p busperu < database/migrations/005-booking-groups.sql
--
-- Aditiva y no destructiva: una tabla nueva y dos columnas en `bookings`, ambas con valor
-- por defecto, de modo que las reservas existentes quedan intactas como tramo único.
-- Idempotente: cada ALTER va condicionado a que la columna no exista.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `booking_groups` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `group_code` varchar(20) NOT NULL,
  `user_id` int(10) unsigned NOT NULL,
  `trip_type` enum('ROUND_TRIP','MULTI_CITY') NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `group_code` (`group_code`),
  KEY `idx_booking_groups_user` (`user_id`),
  CONSTRAINT `fk_booking_groups_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Columnas de agrupación en `bookings`, idempotentes -------------------------
SET @existe := (SELECT COUNT(*) FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = 'bookings' AND column_name = 'group_id');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `bookings` ADD COLUMN `group_id` int(10) unsigned DEFAULT NULL AFTER `user_id`',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @existe := (SELECT COUNT(*) FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = 'bookings' AND column_name = 'segment_order');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `bookings` ADD COLUMN `segment_order` tinyint(3) unsigned NOT NULL DEFAULT 1 AFTER `group_id`',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @existe := (SELECT COUNT(*) FROM information_schema.statistics
                WHERE table_schema = DATABASE() AND table_name = 'bookings' AND index_name = 'idx_bookings_group');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `bookings` ADD KEY `idx_bookings_group` (`group_id`)',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ON DELETE SET NULL: borrar el grupo nunca borra las reservas ni su historial.
SET @existe := (SELECT COUNT(*) FROM information_schema.table_constraints
                WHERE table_schema = DATABASE() AND table_name = 'bookings' AND constraint_name = 'fk_bookings_group');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `bookings` ADD CONSTRAINT `fk_bookings_group` FOREIGN KEY (`group_id`) REFERENCES `booking_groups` (`id`) ON DELETE SET NULL',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Comprobación
SELECT 'booking_groups' AS tabla,
       (SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'booking_groups') AS existe,
       (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'bookings' AND column_name IN ('group_id','segment_order')) AS columnas_en_bookings,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()) AS tablas_totales;
