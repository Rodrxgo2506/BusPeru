-- ===========================================================================
-- Migracion 014 · sesiones revocadas al cerrar sesion
-- ===========================================================================
--
-- QUE PASABA (auditoria final FASE 12, hallazgo F12-07). El JWT es sin estado y dura
-- 8 horas. `POST /auth/logout` solo dejaba constancia en la auditoria: el token seguia
-- siendo valido hasta caducar, de modo que un token copiado antes del cierre de sesion
-- (por ejemplo, desde `localStorage` en un equipo compartido) seguia entrando.
--
-- QUE HACE. Crea `revoked_sessions`: una fila por token revocado, identificado por su
-- `jti` (identificador aleatorio que ahora lleva cada token emitido). El middleware
-- rechaza un token cuyo `jti` este aqui. Guarda la caducidad del token (`expires_at`)
-- para que el planificador borre las filas que ya no pueden coincidir con ningun token
-- vivo: la tabla no crece sin limite.
--
-- LO QUE NO GUARDA: ni el token, ni su firma, ni ningun dato de la sesion. Un `jti` no
-- sirve para autenticarse.
--
-- LO QUE NO CAMBIA: ninguna tabla existente. Cambiar la contrasena sigue invalidando todas
-- las sesiones por la huella de BP-18, sin pasar por esta tabla.
--
-- DESPLIEGUE: el middleware de autenticacion consulta esta tabla en cada peticion
-- autenticada, asi que la migracion debe aplicarse ANTES de desplegar el codigo que la usa.
--
-- Es reejecutable (`CREATE TABLE IF NOT EXISTS`).
--
-- COMO VOLVER ATRAS: `DROP TABLE revoked_sessions;` (junto con el codigo anterior).
--
-- Ejecutar con:
--   "C:\xampp\mysql\bin\mysql.exe" -u root -p <base> < database/migrations/014-revoked-sessions.sql

CREATE TABLE IF NOT EXISTS `revoked_sessions` (
  `jti` char(32) NOT NULL COMMENT 'Identificador aleatorio del token revocado. No es un secreto ni permite autenticarse.',
  `user_id` int(10) unsigned NOT NULL,
  `expires_at` datetime NOT NULL COMMENT 'Caducidad del token: pasada esta fecha la fila ya no hace falta.',
  `revoked_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`jti`),
  KEY `idx_revoked_sessions_expires` (`expires_at`),
  KEY `idx_revoked_sessions_user` (`user_id`),
  CONSTRAINT `fk_revoked_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'revoked_sessions' AS tabla,
       (SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'revoked_sessions') AS existe,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()) AS tablas_totales;
