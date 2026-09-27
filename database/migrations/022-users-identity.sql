-- ---------------------------------------------------------------------------
-- 022 · Documento de identidad y fecha de nacimiento del cliente (perfil «Mi perfil»)
--
-- Tres columnas NULL en `users`, aditivas y no destructivas. Las cuentas actuales quedan con
-- (NULL, NULL, NULL) y siguen funcionando igual: el perfil muestra «No registrado» y el cliente
-- puede completarlas UNA vez. No se copia nada de otras tablas (tampoco `passenger_document`).
--
-- DECISIONES
--   · `document_type` es VARCHAR y no ENUM: hoy admite DNI, CE y PASAPORTE (validación en la
--     aplicación, mismas reglas de formato que el Libro de Reclamaciones), y ampliar la lista no
--     debe exigir otro ALTER.
--   · `document_number` VARCHAR(20), igual que `complaint_book_entries.consumer_document_number`:
--     CE y pasaporte llevan letras; un CHAR(8) solo serviría para el DNI.
--   · SIN índice único: no hay verificación de identidad (RENIEC), así que un UNIQUE permitiría
--     «ocupar» el documento de otra persona y el aviso «documento ya registrado» revelaría qué
--     documentos tienen cuenta. Tampoco índice normal: ninguna consulta busca por documento.
--   · `birth_date` DATE: solo la fecha, sin hora ni zona.
--   · Las cuentas creadas por Google/Microsoft (007) nacen sin estos datos: por eso son NULL.
--
-- Ejecutar con (nunca contra producción sin autorización; las pruebas la aplican a *_test):
--   mysql -u <usuario> -p <base> < database/migrations/022-users-identity.sql
--
-- Cada ALTER va condicionado a que la columna no exista: la migración puede reejecutarse.
-- ---------------------------------------------------------------------------

SET @existe := (SELECT COUNT(*) FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'document_type');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `users` ADD COLUMN `document_type` varchar(20) DEFAULT NULL AFTER `phone`',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @existe := (SELECT COUNT(*) FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'document_number');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `users` ADD COLUMN `document_number` varchar(20) DEFAULT NULL AFTER `document_type`',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @existe := (SELECT COUNT(*) FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'birth_date');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `users` ADD COLUMN `birth_date` date DEFAULT NULL AFTER `document_number`',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Comprobación: tres columnas NULL y ningún usuario con datos inventados.
SELECT column_name, column_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = DATABASE() AND table_name = 'users'
   AND column_name IN ('document_type', 'document_number', 'birth_date')
 ORDER BY ordinal_position;
