-- ---------------------------------------------------------------------------
-- Concede `reviews.update` al rol COMPANY_ADMIN.
--
-- Es un cambio de DATOS sobre `role_permissions`: no crea, altera ni elimina tablas.
-- El esquema sigue teniendo las mismas 34 tablas.
--
-- Motivo: los mockups del Portal Empresa incluyen moderar y responder reseñas, pero
-- Dump20260831.sql solo asignaba `reviews.update` a ADMIN y CUSTOMER, de modo que la
-- pantalla existía sin que ningún rol de empresa pudiera usarla.
--
-- El aislamiento multiempresa lo garantiza el backend: con este permiso, COMPANY_ADMIN
-- solo puede ver, moderar y responder las reseñas cuya `company_id` esté entre sus
-- empresas (`company_users`). Las de otras empresas devuelven 404 / 403.
--
-- Idempotente: puede ejecutarse varias veces sin duplicar la fila.
--
-- Ejecutar con:
--   "C:\xampp\mysql\bin\mysql.exe" -u root -p busperu < database/migrations/001-permiso-resenas-company-admin.sql
-- ---------------------------------------------------------------------------

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.name = 'reviews.update'
WHERE r.name = 'COMPANY_ADMIN'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

-- Comprobación
SELECT r.name AS rol, p.name AS permiso
FROM role_permissions rp
JOIN roles r ON r.id = rp.role_id
JOIN permissions p ON p.id = rp.permission_id
WHERE p.module = 'reviews'
ORDER BY r.id, p.name;
