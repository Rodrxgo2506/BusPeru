-- ===========================================================================
-- Migracion 021 · Libro de Reclamaciones virtual (F18-19)
-- ===========================================================================
--
-- BASE LEGAL (verificada en fuentes oficiales; ver docs/production/F18-19-LEGAL-SOURCES.md):
--   · Ley 29571, Codigo de Proteccion y Defensa del Consumidor, art. 150.
--   · Reglamento del Libro de Reclamaciones, DS 011-2011-PCM:
--       - art. 3.3 y 3.4: RECLAMO vs QUEJA;
--       - art. 4: libro virtual con copia imprimible y copia al correo del consumidor;
--       - art. 5 / Anexo 1: contenido minimo de la Hoja de Reclamacion;
--       - art. 12: conservacion por DOS (2) anos.
--   · DS 101-2022-PCM: respuesta en un plazo no mayor a quince (15) dias habiles (arts. 6 y 6-B).
--
-- QUE HACE:
--   · `complaint_book_entries`  una hoja por reclamo o queja, con numeracion correlativa anual
--                               (codigo LR-<anio>-<000001>) y los campos del Anexo 1.
--   · `complaint_book_events`   historial: alta, cambios de estado, respuesta, notas internas y de
--                               la empresa relacionada. Nada se borra: la conservacion es legal.
--   · `complaint_book_counters` el correlativo por anio (se bloquea la fila al numerar).
--   · Claves publicas `legal.*` en `system_settings` SIN VALOR: razon social, RUC, domicilio,
--     correo y telefono del proveedor. Son DATOS PENDIENTES del propietario; no se inventan.
--
-- La hoja pertenece al Libro de BusPeru (la plataforma que vende). Si el consumidor la relaciona con
-- una reserva o una empresa de transporte, `company_id` permite que esa empresa la vea y aporte su
-- descargo, pero la respuesta formal y el estado los gestiona el ADMIN. Ver F18-19-LEGAL-SOURCES.md.
--
-- Es reejecutable (`CREATE TABLE IF NOT EXISTS`, `INSERT IGNORE`).
--
-- COMO VOLVER ATRAS: no aplica una vez que haya hojas registradas (deben conservarse 2 anios). Antes
-- de eso: DROP TABLE complaint_book_events, complaint_book_entries, complaint_book_counters;
--          DELETE FROM system_settings WHERE setting_key LIKE 'legal.%';
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `complaint_book_counters` (
  `year` smallint(5) unsigned NOT NULL,
  `last_sequence` int(10) unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY (`year`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `complaint_book_entries` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(30) NOT NULL COMMENT 'Numeracion correlativa visible: LR-<anio>-<secuencia de 6 digitos>.',
  `year` smallint(5) unsigned NOT NULL,
  `sequence` int(10) unsigned NOT NULL,
  `kind` enum('RECLAMO','QUEJA') NOT NULL,
  `consumer_name` varchar(150) NOT NULL,
  `consumer_document_type` enum('DNI','CE','PASAPORTE','RUC','OTRO') NOT NULL,
  `consumer_document_number` varchar(20) NOT NULL,
  `consumer_address` varchar(255) NOT NULL,
  `consumer_phone` varchar(30) NOT NULL,
  `consumer_email` varchar(150) NOT NULL,
  `is_minor` tinyint(1) NOT NULL DEFAULT 0,
  `guardian_name` varchar(150) DEFAULT NULL,
  `guardian_address` varchar(255) DEFAULT NULL,
  `guardian_phone` varchar(30) DEFAULT NULL,
  `guardian_email` varchar(150) DEFAULT NULL,
  `item_type` enum('PRODUCTO','SERVICIO') NOT NULL DEFAULT 'SERVICIO',
  `item_description` varchar(500) NOT NULL,
  `claimed_amount` decimal(10,2) DEFAULT NULL,
  `booking_code` varchar(30) DEFAULT NULL COMMENT 'Codigo de reserva tal como lo escribio el consumidor.',
  `booking_id` int(10) unsigned DEFAULT NULL COMMENT 'Solo si la reserva existe y pertenece al usuario autenticado.',
  `company_id` int(10) unsigned DEFAULT NULL COMMENT 'Empresa de transporte relacionada (no es el proveedor del libro).',
  `detail` text NOT NULL,
  `request` text NOT NULL COMMENT 'Pedido concreto del consumidor.',
  `accepted_at` datetime NOT NULL COMMENT 'Conformidad del consumidor: reemplaza la firma en el libro virtual (art. 5).',
  `user_id` int(10) unsigned DEFAULT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `status` enum('RECEIVED','IN_REVIEW','ANSWERED','CLOSED') NOT NULL DEFAULT 'RECEIVED',
  `due_date` date NOT NULL COMMENT '15 dias habiles (lunes a viernes). Los feriados no se descuentan: ver informe.',
  `response` text DEFAULT NULL,
  `response_channel` enum('EMAIL','CARTA') DEFAULT NULL,
  `response_at` datetime DEFAULT NULL,
  `responded_by` int(10) unsigned DEFAULT NULL,
  `copy_emailed_at` datetime DEFAULT NULL,
  `response_emailed_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_complaint_book_code` (`code`),
  UNIQUE KEY `uq_complaint_book_sequence` (`year`,`sequence`),
  KEY `idx_complaint_book_status` (`status`),
  KEY `idx_complaint_book_kind` (`kind`),
  KEY `idx_complaint_book_company` (`company_id`),
  KEY `idx_complaint_book_created_at` (`created_at`),
  KEY `fk_complaint_book_booking` (`booking_id`),
  KEY `fk_complaint_book_user` (`user_id`),
  KEY `fk_complaint_book_responder` (`responded_by`),
  CONSTRAINT `fk_complaint_book_booking` FOREIGN KEY (`booking_id`) REFERENCES `bookings` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT `fk_complaint_book_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT `fk_complaint_book_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT `fk_complaint_book_responder` FOREIGN KEY (`responded_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT `chk_complaint_book_amount` CHECK (`claimed_amount` IS NULL OR `claimed_amount` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `complaint_book_events` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `entry_id` int(10) unsigned NOT NULL,
  `event` enum('CREATED','COPY_EMAILED','STATUS_CHANGED','RESPONSE_SENT','INTERNAL_NOTE','COMPANY_NOTE') NOT NULL,
  `from_status` varchar(20) DEFAULT NULL,
  `to_status` varchar(20) DEFAULT NULL,
  `note` text DEFAULT NULL,
  `actor_user_id` int(10) unsigned DEFAULT NULL,
  `actor_role` varchar(30) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_complaint_events_entry` (`entry_id`,`created_at`),
  KEY `fk_complaint_events_actor` (`actor_user_id`),
  CONSTRAINT `fk_complaint_events_entry` FOREIGN KEY (`entry_id`) REFERENCES `complaint_book_entries` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT `fk_complaint_events_actor` FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Datos del proveedor que la Hoja de Reclamacion exige (art. 5): los completa el propietario desde el
-- panel. Mientras esten vacios, la hoja los muestra como PENDIENTES; no se inventa ninguno.
INSERT IGNORE INTO `system_settings` (`setting_key`, `setting_value`, `setting_type`, `description`, `is_public`) VALUES
  ('legal.business_name', NULL, 'STRING', 'Razon social del proveedor (Libro de Reclamaciones y documentos legales). PENDIENTE.', 1),
  ('legal.ruc', NULL, 'STRING', 'RUC del proveedor. PENDIENTE.', 1),
  ('legal.address', NULL, 'STRING', 'Domicilio del proveedor. PENDIENTE.', 1),
  ('legal.email', NULL, 'STRING', 'Correo de contacto legal y de datos personales. PENDIENTE.', 1),
  ('legal.phone', NULL, 'STRING', 'Telefono de contacto legal. PENDIENTE.', 1);
