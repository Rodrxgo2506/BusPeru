-- ---------------------------------------------------------------------------
-- Limpieza de los datos generados por las auditorías funcionales (marcados QA-AUDIT).
--
-- Solo borra FILAS de prueba. No contiene ALTER ni DROP: el esquema no se toca.
-- Ejecutar con:
--   "C:\xampp\mysql\bin\mysql.exe" -u root -p busperu < database/seeds/limpiar-datos-qa-audit.sql
--
-- Todos los bloques están acotados al marcador QA-AUDIT, así que no tocan datos
-- reales. Revisa los SELECT de control del final antes de dar por buena la limpieza.
-- ---------------------------------------------------------------------------

START TRANSACTION;

-- 1. Reservas de auditoría y todo lo que cuelga de ellas -----------------------
CREATE TEMPORARY TABLE qa_bookings AS
SELECT id FROM bookings
WHERE notes LIKE '%QA-AUDIT%' OR passenger_name LIKE '%QA-AUDIT%';

DELETE FROM settlement_items       WHERE booking_id IN (SELECT id FROM qa_bookings);
DELETE FROM financial_transactions WHERE booking_id IN (SELECT id FROM qa_bookings);
DELETE FROM refunds                WHERE booking_id IN (SELECT id FROM qa_bookings);
DELETE FROM coupon_usages          WHERE booking_id IN (SELECT id FROM qa_bookings);
DELETE FROM reviews                WHERE booking_id IN (SELECT id FROM qa_bookings);
DELETE FROM payments               WHERE booking_id IN (SELECT id FROM qa_bookings);
DELETE FROM booking_seats          WHERE booking_id IN (SELECT id FROM qa_bookings);
DELETE FROM support_tickets        WHERE booking_id IN (SELECT id FROM qa_bookings);
DELETE FROM bookings               WHERE id IN (SELECT id FROM qa_bookings);

-- 2. Tickets de soporte de auditoría ------------------------------------------
DELETE sm FROM support_messages sm
JOIN support_tickets st ON st.id = sm.ticket_id
WHERE st.subject LIKE '%QA-AUDIT%';
DELETE FROM support_tickets WHERE subject LIKE '%QA-AUDIT%';

-- 3. Promociones y cupones de auditoría ---------------------------------------
DELETE cu FROM coupon_usages cu
JOIN coupons c ON c.id = cu.coupon_id
WHERE c.code LIKE '%QA-AUDIT%' OR c.code LIKE 'TEST%';
DELETE FROM coupons    WHERE code LIKE '%QA-AUDIT%' OR code LIKE 'TEST%';
DELETE FROM promotions WHERE name LIKE '%QA-AUDIT%';

-- 4. Reseñas y notificaciones de auditoría ------------------------------------
DELETE rr FROM review_responses rr
JOIN reviews r ON r.id = rr.review_id
WHERE r.title LIKE '%QA-AUDIT%';
DELETE FROM reviews       WHERE title LIKE '%QA-AUDIT%';
DELETE FROM notifications WHERE title LIKE '%QA-AUDIT%';

-- 5. Viajes, rutas, paradas y buses de auditoría ------------------------------
--    Se borran de dentro hacia fuera para no chocar con las claves foráneas.
CREATE TEMPORARY TABLE qa_buses AS SELECT id FROM buses WHERE code LIKE '%QA-AUDIT%';
CREATE TEMPORARY TABLE qa_routes AS SELECT id FROM routes WHERE name LIKE '%QA-AUDIT%';

DELETE FROM trips WHERE bus_id IN (SELECT id FROM qa_buses) OR route_id IN (SELECT id FROM qa_routes);
DELETE FROM route_stops WHERE route_id IN (SELECT id FROM qa_routes);
DELETE FROM routes WHERE id IN (SELECT id FROM qa_routes);
DELETE FROM seats  WHERE bus_id IN (SELECT id FROM qa_buses);
DELETE FROM buses  WHERE id IN (SELECT id FROM qa_buses);

-- 6. Catálogos globales creados durante las pruebas ---------------------------
DELETE FROM locations  WHERE name LIKE '%QA-AUDIT%';
DELETE FROM bus_types  WHERE name LIKE '%QA-AUDIT%';
DELETE FROM seat_types WHERE name LIKE '%QA-AUDIT%';

-- 7. Usuarios y empresas de auditoría -----------------------------------------
DELETE FROM company_users WHERE user_id IN (SELECT id FROM (SELECT id FROM users WHERE email LIKE 'qa-audit%') AS u);
DELETE FROM audit_logs    WHERE user_id IN (SELECT id FROM (SELECT id FROM users WHERE email LIKE 'qa-audit%') AS u);
DELETE FROM users         WHERE email LIKE 'qa-audit%';

DELETE FROM company_users WHERE company_id IN (SELECT id FROM (SELECT id FROM companies WHERE name LIKE '%QA-AUDIT%' OR legal_name LIKE '%QA-AUDIT%') AS c);
DELETE FROM companies     WHERE name LIKE '%QA-AUDIT%' OR legal_name LIKE '%QA-AUDIT%';

-- 8. Notificaciones huérfanas: su reserva ya se borró en los bloques anteriores ---
DELETE n FROM notifications n
LEFT JOIN bookings b ON b.id = JSON_UNQUOTE(JSON_EXTRACT(n.data, '$.booking_id'))
WHERE JSON_EXTRACT(n.data, '$.booking_id') IS NOT NULL AND b.id IS NULL;

-- 9. Entradas de auditoría de la propia auditoría ------------------------------
DELETE FROM audit_logs WHERE description LIKE '%QA-AUDIT%';

DROP TEMPORARY TABLE qa_bookings;
DROP TEMPORARY TABLE qa_buses;
DROP TEMPORARY TABLE qa_routes;

COMMIT;

-- Comprobación posterior: todas las filas deben quedar en 0 --------------------
SELECT 'reservas QA'   AS control, COUNT(*) AS quedan FROM bookings        WHERE notes LIKE '%QA-AUDIT%' OR passenger_name LIKE '%QA-AUDIT%'
UNION ALL SELECT 'usuarios QA',    COUNT(*) FROM users           WHERE email LIKE 'qa-audit%'
UNION ALL SELECT 'empresas QA',    COUNT(*) FROM companies       WHERE name LIKE '%QA-AUDIT%'
UNION ALL SELECT 'buses QA',       COUNT(*) FROM buses           WHERE code LIKE '%QA-AUDIT%'
UNION ALL SELECT 'rutas QA',       COUNT(*) FROM routes          WHERE name LIKE '%QA-AUDIT%'
UNION ALL SELECT 'terminales QA',  COUNT(*) FROM locations       WHERE name LIKE '%QA-AUDIT%'
UNION ALL SELECT 'tipos bus QA',   COUNT(*) FROM bus_types       WHERE name LIKE '%QA-AUDIT%'
UNION ALL SELECT 'promociones QA', COUNT(*) FROM promotions      WHERE name LIKE '%QA-AUDIT%'
UNION ALL SELECT 'cupones QA',     COUNT(*) FROM coupons         WHERE code LIKE '%QA-AUDIT%' OR code LIKE 'TEST%'
UNION ALL SELECT 'tickets QA',     COUNT(*) FROM support_tickets WHERE subject LIKE '%QA-AUDIT%'
UNION ALL SELECT 'avisos QA',      COUNT(*) FROM notifications   WHERE title LIKE '%QA-AUDIT%'
UNION ALL SELECT 'avisos huérfanos', COUNT(*) FROM notifications n
  LEFT JOIN bookings b ON b.id = JSON_UNQUOTE(JSON_EXTRACT(n.data, '$.booking_id'))
  WHERE JSON_EXTRACT(n.data, '$.booking_id') IS NOT NULL AND b.id IS NULL;
