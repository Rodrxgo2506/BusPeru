-- ---------------------------------------------------------------------------
-- 003 · Datos bancarios de la empresa (mockup 36)
--
-- Crea UNA tabla nueva con la estructura propuesta en PENDIENTES.md §1, sin ningún
-- cambio: mismas columnas, mismos tipos, misma clave foránea. No contiene ALTER ni
-- DROP sobre el esquema existente y es idempotente.
--
-- Ejecutar con:
--   "C:\xampp\mysql\bin\mysql.exe" -u root -p busperu < database/migrations/003-company-bank-accounts.sql
--
-- Los datos bancarios viven en su propia tabla y no dentro de `companies`: una empresa
-- puede tener una cuenta principal y cuentas adicionales (`is_primary`), tal como
-- muestra el mockup. `settlements` sigue intacto; la asociación empresa → cuenta →
-- liquidación queda preparada a través de `company_id`, sin tocar el módulo financiero.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `company_bank_accounts` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `company_id` int(10) unsigned NOT NULL,
  `bank_name` varchar(150) NOT NULL,
  `account_type` enum('CHECKING','SAVINGS') NOT NULL DEFAULT 'CHECKING',
  `currency` char(3) NOT NULL DEFAULT 'PEN',
  `account_number` varchar(50) NOT NULL,
  `interbank_code` varchar(50) DEFAULT NULL,
  `holder_name` varchar(200) NOT NULL,
  `holder_document` varchar(30) DEFAULT NULL,
  `is_primary` tinyint(1) NOT NULL DEFAULT 0,
  `status` enum('PENDING','VERIFIED','REJECTED') NOT NULL DEFAULT 'PENDING',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_bank_accounts_company` (`company_id`),
  CONSTRAINT `fk_bank_accounts_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Comprobación
SELECT 'company_bank_accounts' AS tabla,
       (SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'company_bank_accounts') AS existe,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()) AS tablas_totales;
