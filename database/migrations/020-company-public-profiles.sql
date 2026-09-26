-- ===========================================================================
-- Migracion 020 · perfil publico de empresas (F18-19)
-- ===========================================================================
--
-- QUE HACE. Cuatro tablas nuevas para el perfil publico de cada empresa, administrable por su
-- COMPANY_ADMIN y moderado por el ADMIN de la plataforma:
--
--   · `company_profiles`       1:1 con `companies`: slug, portada, «Nosotros» (historia, mision,
--                              vision, valores) y contacto publico.
--   · `company_services`       modalidades de servicio (Bus Cama, Ejecutivo...) con caracteristicas.
--   · `company_agencies`       agencias con ciudad, direccion, coordenadas, horarios y servicios.
--   · `company_gallery_images` galeria de fotos.
--
-- LO QUE NO CREA (se reutiliza lo que ya existe):
--   · Destinos → `routes` + `locations` + fichas de `destinations` (015/016).
--   · Flota    → `buses` + `bus_types` (sin placa, codigo ni datos internos).
--   · Opiniones → `reviews` + `review_responses`.
--   · Imagenes → el almacen publico de siempre (`public/companies/<id>/...`): la base guarda la
--     REFERENCIA, nunca el binario.
--
-- MODERACION (mismo patron en las cuatro tablas). La empresa edita la COPIA DE TRABAJO (columnas
-- normales). Lo que ve el publico es `published_content`, una instantanea JSON que solo escribe el
-- ADMIN al aprobar. Asi una edicion pendiente nunca se publica sola y lo ya aprobado sigue visible
-- mientras se revisa el cambio:
--
--   DRAFT ──enviar──► PENDING ──aprobar──► APPROVED (se publica: published_content)
--                        └────rechazar──► REJECTED (con nota; lo publicado antes se mantiene)
--   cualquier edicion ──► DRAFT        suspended_at (ADMIN) ──► oculto aunque este publicado
--   is_active = 0 (empresa) ──► oculto sin borrar      deleted_at ──► baja logica, sin romper historial
--
-- Todos los textos son TEXTO PLANO: el frontend los muestra escapados, nunca como HTML.
--
-- Es reejecutable (`CREATE TABLE IF NOT EXISTS`). No toca ninguna tabla existente.
--
-- COMO VOLVER ATRAS (solo si nada depende todavia de estos datos):
--   DROP TABLE company_gallery_images, company_agencies, company_services, company_profiles;
--   (y las imagenes subidas en `STORAGE_DIR/public/companies/<id>/`, que comparten carpeta con el logo)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `company_profiles` (
  `company_id` int(10) unsigned NOT NULL,
  `slug` varchar(120) NOT NULL COMMENT 'URL publica /empresas/<slug>: minusculas, digitos y guiones.',
  `tagline` varchar(300) DEFAULT NULL,
  `cover_image` varchar(255) DEFAULT NULL COMMENT 'Referencia interna del archivo en el almacen.',
  `about_title` varchar(150) DEFAULT NULL,
  `about_body` text DEFAULT NULL,
  `history` text DEFAULT NULL,
  `mission` text DEFAULT NULL,
  `vision` text DEFAULT NULL,
  `values_list` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`values_list`)),
  `about_image` varchar(255) DEFAULT NULL COMMENT 'Referencia interna del archivo en el almacen.',
  `contact_phone` varchar(30) DEFAULT NULL,
  `contact_whatsapp` varchar(30) DEFAULT NULL,
  `contact_email` varchar(150) DEFAULT NULL,
  `website_url` varchar(300) DEFAULT NULL,
  `social_links` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`social_links`)),
  `main_address` varchar(255) DEFAULT NULL,
  `review_status` enum('DRAFT','PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'DRAFT',
  `published_content` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`published_content`)),
  `published_at` datetime DEFAULT NULL,
  `moderation_note` varchar(500) DEFAULT NULL,
  `submitted_at` datetime DEFAULT NULL,
  `reviewed_at` datetime DEFAULT NULL,
  `reviewed_by` int(10) unsigned DEFAULT NULL,
  `suspended_at` datetime DEFAULT NULL,
  `suspension_reason` varchar(500) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`company_id`),
  UNIQUE KEY `uq_company_profiles_slug` (`slug`),
  KEY `idx_company_profiles_review_status` (`review_status`),
  KEY `fk_company_profiles_reviewer` (`reviewed_by`),
  CONSTRAINT `fk_company_profiles_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT `fk_company_profiles_reviewer` FOREIGN KEY (`reviewed_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `company_services` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `company_id` int(10) unsigned NOT NULL,
  `name` varchar(100) NOT NULL,
  `description` text DEFAULT NULL,
  `features` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`features`)),
  `image` varchar(255) DEFAULT NULL COMMENT 'Referencia interna del archivo en el almacen.',
  `display_order` int(10) unsigned NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `deleted_at` datetime DEFAULT NULL,
  `review_status` enum('DRAFT','PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'DRAFT',
  `published_content` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`published_content`)),
  `published_at` datetime DEFAULT NULL,
  `moderation_note` varchar(500) DEFAULT NULL,
  `submitted_at` datetime DEFAULT NULL,
  `reviewed_at` datetime DEFAULT NULL,
  `reviewed_by` int(10) unsigned DEFAULT NULL,
  `suspended_at` datetime DEFAULT NULL,
  `suspension_reason` varchar(500) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_company_services_company` (`company_id`,`deleted_at`,`display_order`),
  KEY `idx_company_services_review_status` (`review_status`),
  KEY `fk_company_services_reviewer` (`reviewed_by`),
  CONSTRAINT `fk_company_services_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT `fk_company_services_reviewer` FOREIGN KEY (`reviewed_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `company_agencies` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `company_id` int(10) unsigned NOT NULL,
  `name` varchar(150) NOT NULL,
  `city` varchar(150) NOT NULL,
  `department` varchar(150) DEFAULT NULL,
  `location_id` int(10) unsigned DEFAULT NULL COMMENT 'Terminal o ciudad del catalogo `locations`, si la agencia coincide con uno.',
  `address` varchar(255) NOT NULL,
  `reference` varchar(255) DEFAULT NULL,
  `phone` varchar(30) DEFAULT NULL,
  `whatsapp` varchar(30) DEFAULT NULL,
  `email` varchar(150) DEFAULT NULL,
  `latitude` decimal(10,7) DEFAULT NULL,
  `longitude` decimal(10,7) DEFAULT NULL,
  `image` varchar(255) DEFAULT NULL COMMENT 'Referencia interna del archivo en el almacen.',
  `services` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`services`)),
  `weekly_hours` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`weekly_hours`)),
  `special_hours` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`special_hours`)),
  `display_order` int(10) unsigned NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `deleted_at` datetime DEFAULT NULL,
  `review_status` enum('DRAFT','PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'DRAFT',
  `published_content` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`published_content`)),
  `published_at` datetime DEFAULT NULL,
  `moderation_note` varchar(500) DEFAULT NULL,
  `submitted_at` datetime DEFAULT NULL,
  `reviewed_at` datetime DEFAULT NULL,
  `reviewed_by` int(10) unsigned DEFAULT NULL,
  `suspended_at` datetime DEFAULT NULL,
  `suspension_reason` varchar(500) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_company_agencies_company` (`company_id`,`deleted_at`,`display_order`),
  KEY `idx_company_agencies_city` (`city`),
  KEY `idx_company_agencies_review_status` (`review_status`),
  KEY `fk_company_agencies_location` (`location_id`),
  KEY `fk_company_agencies_reviewer` (`reviewed_by`),
  CONSTRAINT `fk_company_agencies_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT `fk_company_agencies_location` FOREIGN KEY (`location_id`) REFERENCES `locations` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT `fk_company_agencies_reviewer` FOREIGN KEY (`reviewed_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT `chk_company_agencies_latitude` CHECK (`latitude` IS NULL OR `latitude` BETWEEN -90 AND 90),
  CONSTRAINT `chk_company_agencies_longitude` CHECK (`longitude` IS NULL OR `longitude` BETWEEN -180 AND 180)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `company_gallery_images` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `company_id` int(10) unsigned NOT NULL,
  `image` varchar(255) NOT NULL COMMENT 'Referencia interna del archivo en el almacen.',
  `width` smallint(5) unsigned DEFAULT NULL,
  `height` smallint(5) unsigned DEFAULT NULL,
  `title` varchar(120) DEFAULT NULL,
  `description` varchar(500) DEFAULT NULL,
  `category` enum('BUS','INTERIOR','EXTERIOR','AGENCY','OFFICE','FACILITIES','OTHER') NOT NULL DEFAULT 'OTHER',
  `display_order` int(10) unsigned NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `deleted_at` datetime DEFAULT NULL,
  `review_status` enum('DRAFT','PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'DRAFT',
  `published_content` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`published_content`)),
  `published_at` datetime DEFAULT NULL,
  `moderation_note` varchar(500) DEFAULT NULL,
  `submitted_at` datetime DEFAULT NULL,
  `reviewed_at` datetime DEFAULT NULL,
  `reviewed_by` int(10) unsigned DEFAULT NULL,
  `suspended_at` datetime DEFAULT NULL,
  `suspension_reason` varchar(500) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_company_gallery_company` (`company_id`,`deleted_at`,`display_order`),
  KEY `idx_company_gallery_review_status` (`review_status`),
  KEY `fk_company_gallery_reviewer` (`reviewed_by`),
  CONSTRAINT `fk_company_gallery_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT `fk_company_gallery_reviewer` FOREIGN KEY (`reviewed_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
