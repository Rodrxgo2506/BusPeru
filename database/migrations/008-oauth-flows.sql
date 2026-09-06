-- ---------------------------------------------------------------------------
-- 008 · Estado efímero del flujo OAuth (PENDIENTES.md §2)
--
-- Ejecutar con:
--   "C:\xampp\mysql\bin\mysql.exe" -u root -p busperu < database/migrations/008-oauth-flows.sql
--
-- POR QUÉ EXISTE ESTA TABLA
-- PENDIENTES.md §2 **no la propone**: solo define las columnas de `users`. La primera
-- implementación guardó el `state` y los tickets en memoria del proceso, lo que ataba el
-- backend a una sola instancia y perdía los flujos en vuelo en cada reinicio. Esta tabla
-- sustituye esa memoria por almacenamiento persistente, de modo que `/start`, `/callback` y
-- `/session` puedan atenderse en instancias distintas y sobrevivir a un reinicio.
--
-- QUÉ GUARDA
-- Un intento de OAuth por fila, con dos consumos encadenados sobre ella:
--   /start     INSERT  state_hash + expires_at (600 s)
--   /callback  consume el state  →  emite ticket_hash + ticket_expires_at (60 s) + user_id
--   /session   consume el ticket →  emite el JWT
--
-- QUÉ **NO** GUARDA, en ningún caso:
--   · el `state` ni el `ticket` en claro (solo su sha256 con el secreto de la instalación);
--   · el `nonce` ni el `code_verifier` — se DERIVAN del state y del secreto en cada paso,
--     así que no existe ningún secreto en reposo;
--   · `access_token`, `refresh_token` ni `id_token` del proveedor;
--   · el `client_secret`;
--   · el JWT de BusPerú;
--   · correo, nombre o foto del proveedor (eso solo llega a `users` si se crea la cuenta);
--   · IP ni user-agent.
--
-- CONSUMO ATÓMICO
-- Cada consumo es un único UPDATE condicional (`... AND state_used_at IS NULL AND
-- expires_at > NOW()`). InnoDB serializa con bloqueo de fila, así que de dos peticiones
-- concurrentes con el mismo state solo una obtiene `affectedRows = 1`. La otra recibe 0 y
-- se traduce en `invalid_state`. Lo mismo para el ticket.
--
-- LIMPIEZA
-- `purgeExpiredOAuthFlows()` borra por `idx_oauth_flows_expires` con LIMIT, desde el
-- planificador que ya existe para la expiración de reservas. No se añade ningún proceso.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `oauth_flows` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `state_hash` varchar(255) NOT NULL COMMENT 'sha256(state:state:secreto). Nunca el state en claro.',
  `provider` enum('GOOGLE','MICROSOFT') NOT NULL,
  `scope` enum('CUSTOMER','COMPANY','ADMIN') NOT NULL DEFAULT 'CUSTOMER' COMMENT 'Portal de origen. Solo restringe el alta; nunca concede rol.',
  `mode` enum('LOGIN','LINK') NOT NULL DEFAULT 'LOGIN',
  `user_id` int(10) unsigned DEFAULT NULL COMMENT 'En LINK, la cuenta a vincular fijada en /start. En LOGIN, la cuenta resuelta en /callback.',
  `expires_at` datetime NOT NULL COMMENT 'Caducidad del state (600 s).',
  `state_used_at` datetime DEFAULT NULL COMMENT 'Consumo del state. Un solo uso.',
  `ticket_hash` varchar(255) DEFAULT NULL COMMENT 'sha256(ticket:ticket:secreto) emitido al consumir el state.',
  `ticket_expires_at` datetime DEFAULT NULL COMMENT 'Caducidad del ticket (60 s).',
  `ticket_used_at` datetime DEFAULT NULL COMMENT 'Consumo del ticket. Un solo uso.',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_oauth_flows_state` (`state_hash`),
  UNIQUE KEY `uq_oauth_flows_ticket` (`ticket_hash`),
  KEY `idx_oauth_flows_expires` (`expires_at`),
  KEY `idx_oauth_flows_user` (`user_id`),
  CONSTRAINT `fk_oauth_flows_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Comprobación
SELECT 'oauth_flows' AS tabla,
       (SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'oauth_flows') AS existe,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()) AS tablas_totales;
