-- ===========================================================================
-- Migracion 011 · borrar un tipo de asiento ya no borra los precios de viajes
-- ===========================================================================
--
-- QUE PASABA (auditoria 6F, hallazgo H-08). La clave ajena que une
-- `trip_seat_type_prices` con `seat_types` se creo en la migracion 010 con
-- ON DELETE CASCADE. El catalogo de tipos de asiento lo administra el ADMIN de
-- la plataforma, y borrar uno arrastraba en silencio TODAS las filas de precios
-- configurados para ese tipo en cualquier viaje.
--
-- El efecto no era un error visible sino algo peor: un cambio de precio mudo.
-- El precio efectivo de un asiento se resuelve con
--
--     COALESCE(trip_seat_type_prices.price, trips.base_price)
--
-- asi que al desaparecer la fila el viaje dejaba de cobrar su precio especifico
-- y pasaba a cobrar el base, sin que nadie hubiera tocado ese viaje.
--
-- QUE SE CORRIGE. La misma clave ajena pasa a RESTRICT: un tipo de asiento con
-- precios configurados en viajes ya no se puede borrar. La API no necesita
-- cambiar porque el manejador de errores del proyecto ya traduce
-- `ER_ROW_IS_REFERENCED_2` a un 409 con un mensaje de negocio.
--
-- LO QUE NO CAMBIA:
--   · las columnas, los indices y los datos de la tabla;
--   · `ON UPDATE CASCADE`, que se conserva tal cual;
--   · `fk_trip_seat_type_prices_trip`, la clave hacia `trips`, que sigue en
--     CASCADE a proposito: borrar un viaje si debe llevarse sus precios, porque
--     sin viaje no significan nada;
--   · `booking_seats.price`, que es donde vive el precio historico de una venta
--     y que esta migracion no toca en absoluto.
--
-- Es reejecutable: si la clave ya esta en RESTRICT, no hace nada.

-- ---------------------------------------------------------------------------
-- 1 · Fuera la clave con CASCADE, solo si sigue estando asi
-- ---------------------------------------------------------------------------

SET @en_cascada := (SELECT COUNT(*) FROM information_schema.referential_constraints
                    WHERE constraint_schema = DATABASE()
                      AND table_name = 'trip_seat_type_prices'
                      AND constraint_name = 'fk_trip_seat_type_prices_type'
                      AND delete_rule = 'CASCADE');
SET @sql := IF(@en_cascada = 1,
  'ALTER TABLE `trip_seat_type_prices` DROP FOREIGN KEY `fk_trip_seat_type_prices_type`',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 2 · La misma clave, con RESTRICT
-- ---------------------------------------------------------------------------
--
-- El indice `idx_trip_seat_type_prices_type` sigue donde estaba: soltar una
-- clave ajena no lo borra, y la clave nueva lo reutiliza.

SET @existe := (SELECT COUNT(*) FROM information_schema.table_constraints
                WHERE table_schema = DATABASE()
                  AND table_name = 'trip_seat_type_prices'
                  AND constraint_name = 'fk_trip_seat_type_prices_type');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `trip_seat_type_prices` ADD CONSTRAINT `fk_trip_seat_type_prices_type` FOREIGN KEY (`seat_type_id`) REFERENCES `seat_types` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 3 · Comprobacion
-- ---------------------------------------------------------------------------

SELECT constraint_name AS clave, delete_rule AS al_borrar, update_rule AS al_actualizar
FROM information_schema.referential_constraints
WHERE constraint_schema = DATABASE()
  AND table_name = 'trip_seat_type_prices'
ORDER BY constraint_name;
