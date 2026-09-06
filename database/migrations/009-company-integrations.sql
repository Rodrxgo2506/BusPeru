-- ---------------------------------------------------------------------------
-- 009 · Integraciones por empresa (PENDIENTES.md §5, mockup 37)
--
-- Ejecutar con:
--   "C:\xampp\mysql\bin\mysql.exe" -u root -p busperu < database/migrations/009-company-integrations.sql
--
-- Implementa la propuesta de PENDIENTES.md §5 con **una sola adición**, explicada abajo.
--
-- ALCANCE
-- Esta tabla guarda CONFIGURACIÓN, no operación. Conectar una integración almacena sus
-- credenciales cifradas; NO activa ningún cobro, ni ningún webhook, ni ninguna llamada a
-- un proveedor externo. El procesamiento real es una fase posterior y separada.
--
-- LA ADICIÓN: `company_scope`
-- §5 propone `UNIQUE (company_id, provider)`. En MySQL/MariaDB los NULL no colisionan entre
-- sí dentro de un índice único, de modo que esa clave impide dos filas `(7,'CULQI')` pero
-- **permite infinitas filas `(NULL,'CULQI')`** — justo la integración a nivel de plataforma,
-- que es la que guardaría las credenciales reales de cobro.
--
-- Se añade una columna GENERADA (no un dato nuevo: `COALESCE(company_id, 0)`) con su propia
-- clave única. La clave de §5 se conserva tal cual, aunque quede cubierta por la nueva.
--
-- SOBRE `credentials`
-- Nunca contiene credenciales en claro. Guarda el sobre de AES-256-GCM, que es JSON válido
-- para satisfacer el CHECK que §5 prescribe:
--   {"v":1,"alg":"AES-256-GCM","iv":"…","tag":"…","data":"…"}
-- La clave de cifrado vive en `INTEGRATIONS_ENCRYPTION_KEY` (backend/.env), nunca en la base.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `company_integrations` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `company_id` int(10) unsigned DEFAULT NULL COMMENT 'NULL = integración a nivel de plataforma, solo gestionable por ADMIN.',
  `company_scope` int(10) unsigned AS (COALESCE(`company_id`, 0)) STORED COMMENT 'Derivada: hace que las filas de plataforma también sean únicas por proveedor.',
  `provider` varchar(50) NOT NULL,
  `category` enum('PAYMENT_GATEWAY','INVOICING','ANALYTICS','MESSAGING','OTHER') NOT NULL DEFAULT 'OTHER',
  `credentials` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Sobre AES-256-GCM. Jamás credenciales en claro.' CHECK (json_valid(`credentials`)),
  `status` enum('CONNECTED','DISCONNECTED','NEEDS_CONFIG') NOT NULL DEFAULT 'DISCONNECTED',
  `connected_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_integration_company_provider` (`company_id`, `provider`),
  UNIQUE KEY `uq_integration_scope_provider` (`company_scope`, `provider`),
  CONSTRAINT `fk_integrations_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Comprobación
SELECT 'company_integrations' AS tabla,
       (SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'company_integrations') AS existe,
       (SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'company_integrations'
          AND index_name LIKE 'uq_integration%') AS claves_unicas,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()) AS tablas_totales;
