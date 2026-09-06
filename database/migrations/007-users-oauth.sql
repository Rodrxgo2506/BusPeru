-- ---------------------------------------------------------------------------
-- 007 · Inicio de sesión con Google / Microsoft (mockups 8, 12, 30)
--
-- Implementa la propuesta de PENDIENTES.md §2 SIN cambios: las dos columnas de proveedor
-- en `users` y su clave única compuesta.
--
-- Ejecutar con:
--   "C:\xampp\mysql\bin\mysql.exe" -u root -p busperu < database/migrations/007-users-oauth.sql
--
-- NOTA SOBRE EL ALTER
-- Es el segundo ALTER del proyecto sobre una tabla existente y está prescrito
-- explícitamente por PENDIENTES.md §2: no hay otra forma de asociar una identidad externa
-- a un usuario. Es aditivo y no destructivo: dos columnas NULL. Las cuentas actuales
-- quedan con `(NULL, NULL)` y siguen entrando con correo y contraseña exactamente igual.
--
-- SOBRE LA CLAVE ÚNICA
-- En MySQL/MariaDB los NULL no colisionan entre sí dentro de un índice único, así que
-- `uq_users_oauth` admite tantas filas `(NULL, NULL)` como usuarios sin OAuth haya, y a la
-- vez impide que una misma identidad de proveedor quede vinculada a dos cuentas.
--
-- SOBRE `password_hash`
-- PENDIENTES.md §2 señala que `password_hash` es NOT NULL y ofrece dos salidas: permitir
-- NULL o guardar un hash inutilizable. Se eligió la segunda por ser la mínima: NO se toca
-- una columna de la que dependen login, registro y cambio de contraseña. Una cuenta creada
-- por OAuth recibe un hash bcrypt de 32 bytes aleatorios que nadie conoce, de modo que
-- ninguna contraseña puede validar contra él.
--
-- Cada ALTER va condicionado a que la columna o la clave no existan, de modo que la
-- migración puede reejecutarse sin error.
-- ---------------------------------------------------------------------------

SET @existe := (SELECT COUNT(*) FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'oauth_provider');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `users` ADD COLUMN `oauth_provider` enum(''GOOGLE'',''MICROSOFT'') DEFAULT NULL AFTER `password_hash`',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @existe := (SELECT COUNT(*) FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'oauth_id');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `users` ADD COLUMN `oauth_id` varchar(191) DEFAULT NULL AFTER `oauth_provider`',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @existe := (SELECT COUNT(*) FROM information_schema.statistics
                WHERE table_schema = DATABASE() AND table_name = 'users' AND index_name = 'uq_users_oauth');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `users` ADD UNIQUE KEY `uq_users_oauth` (`oauth_provider`, `oauth_id`)',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Comprobación
SELECT COUNT(*) AS columnas_oauth FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'users'
    AND column_name IN ('oauth_provider', 'oauth_id');
SELECT COUNT(DISTINCT index_name) AS clave_unica FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'users' AND index_name = 'uq_users_oauth';
