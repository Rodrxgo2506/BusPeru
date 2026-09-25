-- ===========================================================================
-- Migracion 018 · claves ajenas compatibles con MariaDB 10.11 (F18-02B)
-- ===========================================================================
--
-- QUE PASABA (F18-02A). Las migraciones 009 y 010 no se podian aplicar sobre MariaDB 10.11:
--
--   ERROR 1901: Function or expression 'company_id' cannot be used in the GENERATED ALWAYS AS
--   clause of `company_scope`   (y lo mismo con `bus_id` / `published_scope` en 010)
--
-- MariaDB 10.11 no admite una columna generada STORED cuya columna base tenga una clave ajena
-- con `ON UPDATE CASCADE` (ni con `ON DELETE SET NULL`). MariaDB 10.4, la version de desarrollo,
-- no comprobaba esa regla, y por eso nunca aparecio. Son dos casos:
--
--   company_integrations.company_scope = COALESCE(company_id, 0)   → fk_integrations_company
--   bus_layouts.published_scope        = IF(status='PUBLISHED', bus_id, NULL) → fk_bus_layouts_bus
--
-- QUE HACE. Deja esas dos claves en `ON DELETE CASCADE ON UPDATE RESTRICT`, que es como las
-- crean ahora 009 y 010. Solo cambia la regla de ACTUALIZACION de la clave primaria referida:
--
--   · el borrado en cascada se conserva tal cual;
--   · `companies.id` y `buses.id` son AUTO_INCREMENT y ningun codigo actualiza una clave
--     primaria, asi que `ON UPDATE CASCADE` nunca llegaba a ejecutarse;
--   · las columnas generadas, sus expresiones y sus indices unicos no se tocan;
--   · las claves que APUNTAN a `bus_layouts.id` no cambian: `id` no es base de ninguna columna
--     generada.
--
-- CUANDO HACE FALTA. Solo en bases creadas con la version anterior de 009/010 (las de MariaDB
-- 10.4). Una instalacion nueva ya nace con RESTRICT, y ahi esta migracion no hace nada.
--
-- POR QUE EN DOS PASOS. MariaDB no permite quitar y volver a crear una clave ajena con el mismo
-- nombre en un solo ALTER (errno 121, comprobado en 10.11.19). Cada paso lleva su propia guarda
-- sobre information_schema:
--
--   1. se QUITA la clave solo si existe con la forma antigua exacta (CASCADE / CASCADE);
--   2. se CREA solo si no existe ninguna clave con ese nombre y la tabla existe.
--
-- Por eso es reejecutable: la segunda pasada no encuentra nada que quitar ni que crear. Si una
-- ejecucion se interrumpiera entre los dos pasos, la siguiente completaria el segundo. Una clave
-- con una forma inesperada (ni la antigua ni la nueva) no se toca: la comprobacion del final lo
-- deja a la vista.
--
-- Al volver a crear la clave, InnoDB valida las filas existentes: si hubiera alguna huerfana, el
-- ALTER falla y no se cambia nada en esa tabla. No borra ni modifica datos.
--
-- Mismo patron PREPARE/EXECUTE que 004, 010 y 017: solo se preparan cadenas constantes de este
-- archivo, nunca texto que venga de fuera, y no depende de DELIMITER.
--
-- COMO VOLVER ATRAS (solo en MariaDB 10.4, en 10.11 no es posible): repetir los dos pasos con
-- `ON UPDATE CASCADE`.
--
-- Ejecutar con:
--   "C:\xampp\mysql\bin\mysql.exe" -u root -p <base> < database/migrations/018-fk-on-update-restrict-mariadb-1011.sql
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- company_integrations.fk_integrations_company
-- ---------------------------------------------------------------------------

SET @antigua := (SELECT COUNT(*) FROM information_schema.referential_constraints
                 WHERE constraint_schema = DATABASE() AND table_name = 'company_integrations'
                   AND constraint_name = 'fk_integrations_company' AND referenced_table_name = 'companies'
                   AND update_rule = 'CASCADE' AND delete_rule = 'CASCADE');
SET @sql := IF(@antigua > 0,
  'ALTER TABLE `company_integrations` DROP FOREIGN KEY `fk_integrations_company`',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @tabla := (SELECT COUNT(*) FROM information_schema.tables
               WHERE table_schema = DATABASE() AND table_name = 'company_integrations');
SET @existe := (SELECT COUNT(*) FROM information_schema.table_constraints
                WHERE table_schema = DATABASE() AND table_name = 'company_integrations'
                  AND constraint_name = 'fk_integrations_company' AND constraint_type = 'FOREIGN KEY');
SET @sql := IF(@tabla > 0 AND @existe = 0,
  'ALTER TABLE `company_integrations` ADD CONSTRAINT `fk_integrations_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- ---------------------------------------------------------------------------
-- bus_layouts.fk_bus_layouts_bus
-- ---------------------------------------------------------------------------

SET @antigua := (SELECT COUNT(*) FROM information_schema.referential_constraints
                 WHERE constraint_schema = DATABASE() AND table_name = 'bus_layouts'
                   AND constraint_name = 'fk_bus_layouts_bus' AND referenced_table_name = 'buses'
                   AND update_rule = 'CASCADE' AND delete_rule = 'CASCADE');
SET @sql := IF(@antigua > 0,
  'ALTER TABLE `bus_layouts` DROP FOREIGN KEY `fk_bus_layouts_bus`',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @tabla := (SELECT COUNT(*) FROM information_schema.tables
               WHERE table_schema = DATABASE() AND table_name = 'bus_layouts');
SET @existe := (SELECT COUNT(*) FROM information_schema.table_constraints
                WHERE table_schema = DATABASE() AND table_name = 'bus_layouts'
                  AND constraint_name = 'fk_bus_layouts_bus' AND constraint_type = 'FOREIGN KEY');
SET @sql := IF(@tabla > 0 AND @existe = 0,
  'ALTER TABLE `bus_layouts` ADD CONSTRAINT `fk_bus_layouts_bus` FOREIGN KEY (`bus_id`) REFERENCES `buses` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- ---------------------------------------------------------------------------
-- Comprobacion: las dos claves deben salir con update_rule = RESTRICT y delete_rule = CASCADE
-- ---------------------------------------------------------------------------

SELECT table_name AS tabla, constraint_name AS clave, update_rule, delete_rule
FROM information_schema.referential_constraints
WHERE constraint_schema = DATABASE()
  AND constraint_name IN ('fk_integrations_company', 'fk_bus_layouts_bus')
ORDER BY table_name;
