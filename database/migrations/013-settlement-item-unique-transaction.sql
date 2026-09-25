-- ===========================================================================
-- Migracion 013 · un movimiento financiero pertenece como mucho a UNA liquidacion
-- ===========================================================================
--
-- QUE PASABA (auditoria final FASE 12, hallazgo F12-02). `POST /settlements`
-- elegia los movimientos «sin liquidar» con `NOT EXISTS (settlement_items ...)` y no
-- bloqueaba nada. Dos generaciones simultaneas para la misma empresa y periodo leian
-- los mismos movimientos y creaban DOS liquidaciones con los mismos
-- `financial_transaction_id`: la sonda lo reprodujo 5 de 5 veces. Pagar las dos
-- duplicaba el pago a la empresa.
--
-- La correccion principal esta en el codigo (bloqueo de la empresa y de los movimientos
-- dentro de la transaccion). Esta migracion es la RED en la base: aunque un camino futuro
-- olvidara el bloqueo, un mismo movimiento no puede entrar en dos liquidaciones.
--
-- QUE HACE, en UNA sentencia `ALTER TABLE` (atomica):
--   · crea `uq_settlement_items_transaction` UNIQUE (`financial_transaction_id`);
--   · elimina `idx_settlement_items_transaction`, que pasa a ser un indice duplicado
--     del UNIQUE (misma unica columna; es el criterio de la migracion 012).
--
-- `financial_transaction_id` admite NULL y un UNIQUE admite varios NULL: los items cuyo
-- movimiento se libero al anular una liquidacion (NULL) no chocan entre si.
--
-- LO QUE NO CAMBIA: datos, columnas, clave primaria, el resto de indices y las claves
-- ajenas. `fk_settlement_items_transaction` (ON DELETE SET NULL, ON UPDATE CASCADE) sigue
-- igual; MariaDB exige un indice que empiece por la columna y el UNIQUE lo es.
--
-- SEGURIDAD AL APLICARLA:
--   · Es reejecutable: si el UNIQUE ya existe no hace nada.
--   · Si la tabla tuviera movimientos repetidos, NO modifica nada y FALLA de forma
--     visible (una sentencia invalida cuyo texto explica el motivo): hay que resolver los
--     duplicados antes, decidiendo que liquidacion conserva cada movimiento.
--
-- Comprobacion previa recomendada:
--   SELECT financial_transaction_id, COUNT(*) FROM settlement_items
--   WHERE financial_transaction_id IS NOT NULL
--   GROUP BY financial_transaction_id HAVING COUNT(*) > 1;
--
-- COMO VOLVER ATRAS (el proyecto no usa migraciones "down"):
--   ALTER TABLE `settlement_items`
--     ADD KEY `idx_settlement_items_transaction` (`financial_transaction_id`),
--     DROP INDEX `uq_settlement_items_transaction`;
--
-- Ejecutar con:
--   "C:\xampp\mysql\bin\mysql.exe" -u root -p <base> < database/migrations/013-settlement-item-unique-transaction.sql

-- ---------------------------------------------------------------------------
-- 1 · Estado actual
-- ---------------------------------------------------------------------------

SET @ya_unico := (SELECT COUNT(*) FROM information_schema.statistics
                  WHERE table_schema = DATABASE() AND table_name = 'settlement_items'
                    AND index_name = 'uq_settlement_items_transaction');
SET @indice_viejo := (SELECT COUNT(*) FROM information_schema.statistics
                      WHERE table_schema = DATABASE() AND table_name = 'settlement_items'
                        AND index_name = 'idx_settlement_items_transaction');
SET @duplicados := (SELECT COUNT(*) FROM (
                      SELECT financial_transaction_id FROM settlement_items
                      WHERE financial_transaction_id IS NOT NULL
                      GROUP BY financial_transaction_id HAVING COUNT(*) > 1) AS repetidos);

-- ---------------------------------------------------------------------------
-- 2 · UNIQUE (y fuera el indice que duplica), solo si no existe y no hay duplicados
-- ---------------------------------------------------------------------------

SET @sql := IF(@ya_unico > 0,
  'DO 0',
  IF(@duplicados > 0,
    'ABORTADO_013_HAY_MOVIMIENTOS_EN_VARIAS_LIQUIDACIONES_resuelvalos_antes_de_aplicar',
    IF(@indice_viejo > 0,
      'ALTER TABLE `settlement_items` ADD UNIQUE KEY `uq_settlement_items_transaction` (`financial_transaction_id`), DROP INDEX `idx_settlement_items_transaction`',
      'ALTER TABLE `settlement_items` ADD UNIQUE KEY `uq_settlement_items_transaction` (`financial_transaction_id`)')));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 3 · Comprobacion: un unico indice sobre la columna, y UNIQUE
-- ---------------------------------------------------------------------------

SELECT index_name AS indice, non_unique AS no_unico, column_name AS columna
FROM information_schema.statistics
WHERE table_schema = DATABASE() AND table_name = 'settlement_items' AND column_name = 'financial_transaction_id';
