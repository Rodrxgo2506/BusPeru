-- ===========================================================================
-- Migracion 015 · contenido publico de destinos (CMS) e identidad visual
-- ===========================================================================
--
-- QUE HACE (FASE 17). Crea el contenido editorial de los destinos turisticos que administra
-- el ADMIN de la plataforma y deja preparadas las claves de identidad visual:
--
--   · `destinations`: una ficha por destino, con `slug` unico para su URL publica
--     (`/destinos/<slug>`), estado ACTIVE/INACTIVE y orden de aparicion.
--   · `destination_attractions`: "Que visitar". Pertenecen a UN destino (FK con CASCADE).
--   · `destination_festivities`: "Calendario festivo". `date_label` es TEXTO a proposito:
--     "Enero", "20 de enero"... no todas las fiestas tienen una fecha exacta.
--   · `system_settings`: cuatro claves publicas `branding.*` (logo, favicon, logo movil,
--     imagen Open Graph) con valor NULL. Solo guardan la REFERENCIA del archivo.
--
-- LO QUE NO GUARDA: ningun binario. Las imagenes viven en el almacen de archivos
-- (`STORAGE_DIR/public/...`) y la base solo guarda su referencia interna.
--
-- `price_from` ES CONTENIDO COMERCIAL. No interviene en viajes, reservas, pagos ni
-- liquidaciones: la busqueda y la compra siguen usando los precios reales de los viajes.
--
-- LO QUE NO CAMBIA: ninguna tabla existente, ningun rol ni permiso. La administracion usa
-- los permisos `settings.*`, que hoy solo tiene el rol ADMIN.
--
-- Es reejecutable (`CREATE TABLE IF NOT EXISTS`, `INSERT IGNORE`).
--
-- COMO VOLVER ATRAS:
--   DROP TABLE destination_festivities, destination_attractions, destinations;
--   DELETE FROM system_settings WHERE setting_key IN
--     ('branding.logo','branding.favicon','branding.logo_mobile','branding.og_image');
--   (y borrar la carpeta `STORAGE_DIR/public` si ya se subieron imagenes)
--
-- Ejecutar con:
--   "C:\xampp\mysql\bin\mysql.exe" -u root -p <base> < database/migrations/015-destinations-content-branding.sql

CREATE TABLE IF NOT EXISTS `destinations` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(120) NOT NULL,
  `slug` varchar(120) NOT NULL COMMENT 'Identificador de URL: minusculas, digitos y guiones.',
  `subtitle` varchar(200) DEFAULT NULL,
  `description` text DEFAULT NULL COMMENT 'Texto plano. El frontend lo muestra escapado.',
  `price_from` decimal(10,2) DEFAULT NULL COMMENT 'Solo presentacion. No afecta precios reales.',
  `hero_image` varchar(255) DEFAULT NULL COMMENT 'Referencia interna del archivo en el almacen.',
  `address` varchar(255) DEFAULT NULL,
  `schedule` varchar(255) DEFAULT NULL,
  `travel_duration` varchar(120) DEFAULT NULL,
  `weather` varchar(120) DEFAULT NULL,
  `status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'INACTIVE',
  `display_order` int(10) unsigned NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_destinations_slug` (`slug`),
  KEY `idx_destinations_public` (`status`, `display_order`),
  CONSTRAINT `chk_destinations_slug` CHECK (`slug` REGEXP '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT `chk_destinations_price_from` CHECK (`price_from` IS NULL OR `price_from` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `destination_attractions` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `destination_id` int(10) unsigned NOT NULL,
  `name` varchar(150) NOT NULL,
  `description` text DEFAULT NULL,
  `image` varchar(255) DEFAULT NULL COMMENT 'Referencia interna del archivo en el almacen.',
  `display_order` int(10) unsigned NOT NULL DEFAULT 0,
  `status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_destination_attractions_order` (`destination_id`, `status`, `display_order`),
  CONSTRAINT `fk_destination_attractions_destination` FOREIGN KEY (`destination_id`) REFERENCES `destinations` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `destination_festivities` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `destination_id` int(10) unsigned NOT NULL,
  `name` varchar(150) NOT NULL,
  `date_label` varchar(80) NOT NULL COMMENT 'Texto libre: Enero, 20 de enero, Febrero...',
  `description` text DEFAULT NULL,
  `display_order` int(10) unsigned NOT NULL DEFAULT 0,
  `status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_destination_festivities_order` (`destination_id`, `status`, `display_order`),
  CONSTRAINT `fk_destination_festivities_destination` FOREIGN KEY (`destination_id`) REFERENCES `destinations` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO `system_settings` (`setting_key`, `setting_value`, `setting_type`, `description`, `is_public`) VALUES
  ('branding.logo', NULL, 'STRING', 'Referencia del logo principal (identidad visual). Se administra desde el panel.', 1),
  ('branding.favicon', NULL, 'STRING', 'Referencia del favicon (identidad visual). Se administra desde el panel.', 1),
  ('branding.logo_mobile', NULL, 'STRING', 'Referencia del logo movil (identidad visual). Se administra desde el panel.', 1),
  ('branding.og_image', NULL, 'STRING', 'Referencia de la imagen Open Graph (identidad visual). Se administra desde el panel.', 1);

SELECT 'destinations' AS tabla,
       (SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name IN ('destinations','destination_attractions','destination_festivities')) AS tablas_cms,
       (SELECT COUNT(*) FROM system_settings WHERE setting_key LIKE 'branding.%') AS claves_branding,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()) AS tablas_totales;
