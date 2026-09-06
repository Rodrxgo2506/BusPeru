-- ---------------------------------------------------------------------------
-- 006 · Documentos de verificación de empresa (mockups 13 y 14)
--
-- Crea UNA tabla nueva con la estructura propuesta en PENDIENTES.md §6, sin ningún
-- cambio: mismos tipos, mismos estados, mismas claves foráneas. No contiene ALTER ni
-- DROP sobre el esquema existente y es idempotente.
--
-- Ejecutar con:
--   "C:\xampp\mysql\bin\mysql.exe" -u root -p busperu < database/migrations/006-company-documents.sql
--
-- SOBRE `file_url`
-- Guarda una REFERENCIA INTERNA relativa al almacén de documentos, nunca una URL
-- pública. El archivo vive fuera de cualquier carpeta servida estáticamente y solo se
-- entrega a través de un endpoint autorizado, de modo que un documento no puede
-- descargarse conociendo la ruta.
--
-- SOBRE LAS ETAPAS DE VERIFICACIÓN
-- El mockup 14 muestra una línea de tiempo de cuatro etapas. PENDIENTES.md no propone
-- tabla de etapas, así que se derivan de `companies.status` y del estado de estos
-- documentos. No se almacenan.
--
-- SOBRE `companies.status`
-- Esta migración no lo toca ni lo condiciona: aprobar una empresa sigue siendo una
-- acción independiente del ADMIN, tal como funciona hoy.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `company_documents` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `company_id` int(10) unsigned NOT NULL,
  `type` enum('RUC','LICENSE','INSURANCE','LEGAL_REP_ID','OTHER') NOT NULL,
  `file_url` varchar(500) NOT NULL,
  `status` enum('PENDING','VERIFIED','REJECTED') NOT NULL DEFAULT 'PENDING',
  `reviewed_by` int(10) unsigned DEFAULT NULL,
  `reviewed_at` datetime DEFAULT NULL,
  `notes` varchar(500) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_company_documents_company` (`company_id`),
  KEY `idx_company_documents_reviewer` (`reviewed_by`),
  CONSTRAINT `fk_company_documents_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_company_documents_reviewer` FOREIGN KEY (`reviewed_by`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Comprobación
SELECT 'company_documents' AS tabla,
       (SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'company_documents') AS existe,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()) AS tablas_totales;
