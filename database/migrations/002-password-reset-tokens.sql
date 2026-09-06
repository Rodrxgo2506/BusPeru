-- ---------------------------------------------------------------------------
-- 002 · Recuperación de contraseña con código de verificación (mockup 10)
--
-- Crea UNA tabla nueva. No modifica ni elimina ninguna de las 34 tablas existentes:
-- no contiene ALTER ni DROP sobre el esquema actual. Es idempotente.
--
-- Ejecutar con:
--   "C:\xampp\mysql\bin\mysql.exe" -u root -p busperu < database/migrations/002-password-reset-tokens.sql
--
-- Base: la propuesta de PENDIENTES.md §3, extendida para soportar el código de 6
-- dígitos del mockup 10 (ver el apartado "Extensión aplicada" en PENDIENTES.md):
--
--   · attempts           un código de 6 dígitos son 10^6 combinaciones: sin límite de
--                        intentos es forzable. Se bloquea a los 5 fallos.
--   · ticket_hash        la verificación del código NO cambia la contraseña: emite un
--                        ticket opaco de un solo uso que autoriza el cambio. Así el
--                        código no puede reutilizarse contra /auth/reset-password.
--   · ticket_expires_at  el ticket vive menos que el código (10 min frente a 15).
--
--   · token_hash pasa de UNIQUE a índice normal: dos usuarios distintos pueden recibir
--     por azar el mismo código de 6 dígitos y un UNIQUE haría fallar el INSERT. La
--     unicidad real la aporta el hash, que incluye el id del usuario y el secreto.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `password_reset_tokens` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int(10) unsigned NOT NULL,
  `token_hash` varchar(255) NOT NULL COMMENT 'sha256(user_id:codigo:secreto). Nunca el código en claro.',
  `attempts` tinyint(3) unsigned NOT NULL DEFAULT 0 COMMENT 'Intentos fallidos de verificación.',
  `ticket_hash` varchar(255) DEFAULT NULL COMMENT 'sha256 del ticket de un solo uso emitido al verificar.',
  `ticket_expires_at` datetime DEFAULT NULL,
  `expires_at` datetime NOT NULL,
  `used_at` datetime DEFAULT NULL COMMENT 'Marca la solicitud como consumida o invalidada.',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_reset_tokens_user` (`user_id`),
  KEY `idx_reset_tokens_token` (`token_hash`),
  KEY `idx_reset_tokens_ticket` (`ticket_hash`),
  KEY `idx_reset_tokens_expires` (`expires_at`),
  CONSTRAINT `fk_reset_tokens_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Comprobación
SELECT 'password_reset_tokens' AS tabla,
       (SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'password_reset_tokens') AS existe,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()) AS tablas_totales;
