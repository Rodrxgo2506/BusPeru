# F18-09 — Inventario de datos sintéticos de QA en staging y propuesta de limpieza

> Solo **staging** (`busperu_staging` en `busperu-staging-db`, sa-east-1). Inventario hecho el 2026-09-24 a las 20:15–20:21Z
> con consultas de **solo lectura**: `START TRANSACTION READ ONLY` y `ROLLBACK`, ejecutadas por SSM en la EC2 con el
> usuario migrador, más un listado de archivos de `STORAGE_DIR`. **No se borró ni se modificó nada.** Producción no se tocó.
> Los correos no sintéticos aparecen enmascarados.

## 1. Origen de «Arequipamufy7aal» / «Tacnamufy7aal» en la página principal

- La sección «Destinos populares» llama a `GET /api/public/destinations`. Esa consulta devuelve la **ciudad destino** de
  cualquier viaje `SCHEDULED` con salida futura cuya empresa esté `ACTIVE` (`backend/src/routes/public.routes.ts`).
- El E2E complementario de F18-09 (`e2e-f1809.mjs`) crea ubicaciones con la ciudad `Arequipa<marca>` / `Tacna<marca>`. La
  marca es `Date.now().toString(36)`, que la hace única en cada ejecución. También crea viajes de ida y vuelta a 48 h y 96 h.
  - Ejecución por **CloudFront** (19:52Z): marca `mufy7aal`, empresa 11, viajes 8 y 9.
  - Ejecución por el **ALB** (18:32Z): marca `mufvdk07`, empresa 9, viajes 5 y 6.
- Ninguno de los dos arneses (`e2e-f1809.mjs` ni `smoke-staging.mjs`) retira sus datos al terminar. Sus viajes siguen
  programados, así que salen en la portada.
- **No son los únicos.** Esto es lo que devuelve hoy `/public/destinations`, **todo sintético**:

  | Ciudad destino | Viajes | Origen |
  | --- | --- | --- |
  | Cusco | 3 | `smoke-staging.mjs` (F18-03, F18-09 ALB y F18-09 CloudFront) |
  | Puno | 2 | QA de F18-05 (2 ejecuciones) |
  | Arequipamufy7aal / Tacnamufy7aal | 1 + 1 | E2E de F18-09 por CloudFront |
  | Arequipamufvdk07 / Tacnamufvdk07 | 1 + 1 | E2E de F18-09 por el ALB |

- `GET /api/public/stats` también muestra cifras 100 % sintéticas: 11 empresas, 9 rutas y 14 terminales.

## 2. Conclusión del inventario

En staging **no hay datos de negocio reales**.
- Todas las empresas, ubicaciones, rutas, buses, viajes, reservas y pagos se crearon con los arneses de QA. Son 6
  ejecuciones: F18-03, F18-05 ×2, F18-07A y F18-09 ×2 (ALB y CloudFront).
- Todos llevan una marca inequívoca: el dominio `@busperu-staging.example` y los prefijos `Humo`, `QA F18-05`, `QA F18-07A` o `E2E`, seguidos de la marca de la ejecución.
- Lo único real es la **configuración de la plataforma** y el **administrador de staging** (usuario 1).

## 3. Qué se conserva (configuración y cuenta reales)

| Tabla | Filas | Motivo |
| --- | --- | --- |
| `users` id **1** | 1 | ADMIN de staging (bootstrap F18-03, `a***@staging.busperu.invalid`). Sus credenciales están en `ops/ADMIN_*`. |
| `revoked_sessions` del usuario 1 | 6 | Revocaciones de sus propias sesiones |
| `roles` | 4 | ADMIN, COMPANY_ADMIN, OPERATOR, CUSTOMER |
| `permissions` / `role_permissions` | 43 / 104 | Modelo RBAC |
| `notification_templates` | 11 | Plantillas de la plataforma |
| `system_settings` | 5 | `platform.default_commission` = 10.00 (decisión de negocio del bootstrap) y `branding.*` (4, vacíos) |
| `audit_logs` | **327** | **Se conservan todas**: es el rastro de auditoría. Al borrar los usuarios sintéticos, su `user_id` pasa a NULL (FK `SET NULL`) y la entidad y la acción siguen registradas. |
| Esquema (49 tablas, migraciones 001→019) | — | Intacto |
| Parameter Store, EC2, RDS, ALB, CloudFront, S3 del frontend | — | Fuera del alcance de la limpieza |

## 4. Qué es sintético (a limpiar)

### 4.1 Raíces

| Entidad | Ids | Detalle |
| --- | --- | --- |
| `companies` | **1–11** (todas) | 1 `Empresa Humo muel0fpe` (F18-03) · 2, 3 `QA F18-05 A/B f1805muemfh1y` · 4, 5 `QA F18-07A A/B f1807amuet6pyz` · 6, 7 `QA F18-05 A/B f1805muetonqk` · 8 `Empresa Humo mufvag1x` · 9 `E2E mufvdk07` · 10 `Empresa Humo mufy6z0l` · 11 `E2E mufy7aal`. Todas con correo `@busperu-staging.example`. |
| `users` | **2–33** (32) | Todos `@busperu-staging.example`: 10 COMPANY_ADMIN, 8 OPERATOR y 14 CUSTOMER. **Ninguno es ADMIN.** |
| `locations` | 1–4, 6–15 (14) | `Lima/Cusco Humo <marca>`, `QA Arequipa/Puno <marca>`, `Terminal A/B <marca>` |
| `bus_types` / `seat_types` | 1–7 / 1–7 | `Tipo…` / `Asiento…` con la marca de la ejecución |

### 4.2 Dependientes (se van con sus raíces)

| Tabla | Filas | Vínculo |
| --- | --- | --- |
| `routes` | 9 | empresas 1, 2, 6, 8–11 |
| `trips` | 9 (todos `SCHEDULED`) | rutas 1–9 · son los que alimentan la portada |
| `buses` / `bus_layouts` / `bus_layout_decks` / `bus_layout_elements` / `seats` | 9 / 7 / 7 / 5 / 40 | empresas sintéticas |
| `bookings` / `booking_seats` / `booking_groups` | 15 / 15 / 2 | clientes sintéticos: 8 CANCELLED, 5 EXPIRED y 2 CONFIRMED |
| `payments` | 2 | YAPE PAID (reservas 9 y 14; aprobados en el E2E) |
| `financial_transactions` | 6 | reservas 9 y 14. Incluye 2 filas de cargo por servicio con `company_id` NULL, identificables por `booking_id`. |
| `company_users` | 18 | usuarios y empresas sintéticos |
| `company_commission_settings` | 11 | una por empresa |
| `company_bank_accounts` | 2 | empresa 4 (QA F18-07A; datos ficticios **cifrados**) |
| `api_keys` | 3 | `Humo <marca>` (empresas 1, 8 y 10) |
| `notifications` | 30 | clientes sintéticos |
| `revoked_sessions` de usuarios sintéticos | 14 | usuarios 22–33 |
| Archivos en `STORAGE_DIR` | 3 | `public/companies/{1,8,10}/<hash>.png`: PNG de 1×1 (70 bytes) del smoke |

### 4.3 Hallazgo aparte: integración CULQI de plataforma con claves ficticias

- `company_integrations` id **2**: `provider=CULQI`, `company_id` NULL (plataforma), `status=CONNECTED`.
- Cada ejecución de `smoke-staging.mjs` guarda en ella `pk_test_humo_<marca>` / `sk_test_humo_<marca>` (cifradas) y la conecta, porque así prueba que las credenciales se guardan cifradas y no se devuelven en claro.
- **No son claves de Culqi reales**, así que no puede producirse ningún cobro. Pero staging queda con una pasarela «conectada» con claves inválidas: un pago con tarjeta intentaría llamar a Culqi y fallaría.
- **Corrección al informe F18-09:** «Culqi no está configurado en staging» es inexacto. Lo correcto es: «solo tiene las claves ficticias del smoke; no hay claves de prueba reales». La conclusión se mantiene: **pago sandbox NOT TESTED**.

## 5. Propuesta de limpieza segura (ejecutada la opción B: ver §7)

### Opción A — inmediata y reversible (recomendada como primer paso)

Retira todo de la portada sin borrar nada: por la **API como ADMIN**, pasar las 11 empresas a `INACTIVE` (queda auditado).
`/public/destinations` y la búsqueda filtran `co.status='ACTIVE'`, así que la portada queda vacía al instante.
Se revierte volviendo a `ACTIVE`. **Sin riesgo para la configuración.**

### Opción B — borrado físico de los datos sintéticos (limpieza definitiva)

**Salvaguardas:**
1. **Snapshot manual de RDS** antes de empezar (`busperu-staging-db-pre-limpieza-qa-<fecha>`), además del PITR de 7 días.
2. **Una sola transacción SQL** con el usuario migrador. **Listas de ids explícitas** (las de §4), nunca borrados por patrón.
3. **Precondiciones que abortan con ROLLBACK:**
   - cada empresa, usuario y ubicación de la lista cumple **a la vez** su marca sintética (dominio `@busperu-staging.example`, prefijo `Humo`/`QA F18-0x`/`E2E`/`Terminal`/`Lima|Cusco Humo`);
   - el usuario 1 **no** está en la lista y su rol es ADMIN;
   - no hay filas en tablas no inventariadas (reviews, refunds, settlements, support, coupons, drivers, route_stops) que apunten a la lista;
   - los recuentos coinciden con este inventario (si algo cambió desde entonces, se aborta y se vuelve a inventariar).
4. **Orden de borrado**, que respeta las FK `RESTRICT` (las `CASCADE`/`SET NULL` las resuelve el motor):
   1. `financial_transactions`, luego `payments` (por `booking_id` ∈ reservas sintéticas).
   2. `bookings`: arrastra `booking_seats`.
   3. `booking_groups`.
   4. `trips`.
   5. `companies` 1–11: arrastra `routes`, `buses` → `bus_layouts`/`decks`/`elements`/`seats`, `api_keys`, `company_bank_accounts`, `company_commission_settings`, `company_users` y las integraciones de empresa.
   6. `locations` (14).
   7. `bus_types` 1–7 y `seat_types` 1–7.
   8. `users` 2–33: arrastra `notifications`, `revoked_sessions` y `company_users`; `audit_logs.user_id` pasa a NULL.
5. **Postcondiciones**, antes del COMMIT:
   - companies 0 · users 1 (el ADMIN) · locations/routes/trips/bookings/payments/financial_transactions 0;
   - roles 4 · permissions 43 · role_permissions 104 · notification_templates 11 · system_settings 5 · audit_logs 327.
6. **Integración CULQI ficticia (id 2):** desconectarla y eliminarla por la API de administración (`/admin/integrations/CULQI`), no por SQL, para que quede auditada. Queda **sin pasarela** hasta cargar claves de prueba reales.
7. **Archivos:** borrar solo los 3 PNG de §4.2, verificando antes ruta, tamaño (70 B) y que su empresa estaba en la lista.
8. **Verificación final:**
   - `schema-fingerprint.cjs` idéntico a la referencia (el borrado no toca el esquema);
   - `/api/ready` 200;
   - `/public/destinations` vacío y `/public/stats` a cero;
   - login del ADMIN correcto.

**Rollback de la opción B:** restaurar el snapshot en una instancia nueva y cambiar `DB_HOST`, según el runbook §8 (restauración). No hay forma de «deshacer» el borrado sin el snapshot, y por eso es obligatorio.

### Evitar que vuelva a pasar (cambio de arneses, a decidir)

Hoy cada ejecución de QA vuelve a llenar la portada. Propuesta, sin tocar la aplicación:
- `smoke-staging.mjs` y `e2e-f1809.mjs` terminan con un paso de retirada por API: cancelar sus viajes y pasar su empresa a `INACTIVE`.
- El smoke, además, desconecta la integración CULQI que conectó.
- Alternativa más simple: usar salidas en fechas más allá de la ventana visible. Es peor, porque la búsqueda sí las mostraría.

## 6. Decisiones que necesito

1. ¿Opción A ahora (reversible), opción B (borrado físico con snapshot), o A y luego B?
2. ¿Conservar `audit_logs` íntegro (recomendado) o también borrar las entradas de los usuarios sintéticos?
3. ¿Eliminar la integración CULQI ficticia de plataforma (recomendado) o dejarla?
4. ¿Modificar los arneses de QA para que retiren sus datos al terminar?

Credenciales: la sesión de administrador con MFA caduca hacia las 20:36Z y la access key ya está `Inactive`. Para
ejecutar cualquiera de las opciones hará falta una sesión nueva: la del rol de despliegue (`busperu-mfa`, que pide el
código MFA en su terminal) basta para la opción B por SSM y para la opción A por la API. No hace falta reactivar la access
key salvo que prefiera la identidad administradora.

---

## 7. Ejecución de la limpieza (opción B) — 2026-09-24, autorizada por el propietario

Decisiones del propietario:
- opción B, con snapshot previo;
- **conservar íntegra la auditoría**;
- eliminar por la API la integración CULQI ficticia;
- borrar solo los ids del inventario;
- borrar los 3 PNG;
- adaptar los arneses de QA.

Identidad: rol `BusPeruStagingDeployer` con MFA. **Sin cambios de IAM.** Producción no se tocó.

| Paso | Hora (UTC) | Resultado |
| --- | --- | --- |
| 1. Snapshot manual `busperu-staging-db-pre-limpieza-qa-20260924` | 20:42:56–20:44:30Z | `available`, 100 %, cifrado, instancia `busperu-staging-db`, MariaDB 10.11.19, 20 GiB. Además hay PITR de 7 días. |
| 2a. Logotipos de las empresas 1, 8 y 10 retirados por la API (`DELETE /company/logo`) | 20:45Z | `logo_url` a NULL. Los 3 PNG se borraron del disco (comprobado en la EC2) y las URLs devuelven 404. Auditado como `UPDATE companies` «Quitó el logotipo». |
| 2b. Integración CULQI ficticia (plataforma) | 20:45Z | `POST …/CULQI/disconnect` 200 y `DELETE /admin/integrations/CULQI` 200. Queda sin campos configurados. Auditado como `DISCONNECT` y `DELETE company_integrations`. |
| 3. Ensayo de `purge-qa-data.cjs` (ROLLBACK) | 20:46Z | Las 23 tablas pierden **exactamente** lo inventariado y ninguna otra cambia. Configuración y auditoría intactas. |
| 4. Purga real (COMMIT) | 20:46:29–20:47:00Z | **275 filas en 23 tablas**. Quedan: users 1 (ADMIN) · roles 4 · permissions 43 · role_permissions 104 · notification_templates 11 · system_settings 5 · **audit_logs 334** (las 327 del inventario + 7 de los pasos 2a y 2b, ninguna borrada). |
| 5a. Directorios vacíos `public/companies/{1,2,6,8,10}` | 20:47Z | Retirados con `rmdir`, que solo borra directorios vacíos. `STORAGE_DIR` queda vacío. |
| 5b. Verificación independiente | 20:47–20:48Z | Inventario de solo lectura: solo quedan filas en `users` (1, ADMIN), `roles`, `permissions`, `role_permissions`, `notification_templates`, `system_settings`, `audit_logs` y `revoked_sessions` (7, todas del ADMIN). `schema-fingerprint.cjs` es **idéntico** a la referencia. `/api/ready` 200. `/public/destinations` `[]`. `/public/stats` a cero. |

`revoked_sessions` del ADMIN pasa de 6 a 7: la diferencia es su propio logout del paso 2.

### 7.1 Arneses de QA adaptados

| Archivo | Cambio |
| --- | --- |
| `infra/aws/scripts/smoke-staging.mjs` | Si ya hay una integración CULQI de plataforma, **no la toca** y omite esa comprobación. Si no la hay, crea la ficticia y **la elimina** al final. Grupo final «Retirada»: logotipo y archivo (con reintento, porque CloudFront puede servir la imagen hasta 1 s más), llave de API revocada y empresa `INACTIVE` comprobada fuera de la búsqueda. Escribe el manifiesto `QA_MANIFEST`. |
| `infra/aws/scripts/e2e-staging.mjs` (nuevo, antes solo en el scratchpad) | E2E de F18-09 con retirada (empresa `INACTIVE`, fuera de la búsqueda y de la portada) y manifiesto. La comprobación diferida de expiración lee el mapa de asientos **autenticado**, porque el público ya no muestra el viaje de una empresa inactiva. |
| `infra/aws/scripts/purge-qa-data.cjs` (nuevo) | Purga física transaccional por ids explícitos con todas las salvaguardas de §5 (ensayo por defecto). |
| `infra/aws/scripts/qa-staging.sh` (nuevo) | `pruebas` · `expiry` · `purgar [--ejecutar]` · `todo`. Sube la purga y el manifiesto a `s3://<artefactos>/qa/<fecha>/` con SHA-256, la EC2 lo verifica y después se borran del bucket. URLs por `QA_API_URL`/`QA_WEB_URL`. |
| `docs/production/STAGING-RUNBOOK.md` §9.1 | Procedimiento nuevo |

### 7.2 Pruebas posteriores por CloudFront

| Ciclo | Resultado |
| --- | --- |
| 1 (20:48Z) | Smoke **37/37** y E2E **18/18**, incluida la retirada. Portada vacía nada más terminar. Expiración diferida: la reserva **pasó a EXPIRED**, pero la comprobación del asiento falló por el arnés, que miraba el mapa público de un viaje ya inactivo. Corregido. Purga de sus 2 manifiestos: ensayo = COMMIT, 78 filas en 22 tablas. Todo a cero otra vez. |
| 2 (21:07–21:25Z, arnés corregido) | Smoke **37/37** y E2E **18/18**; portada vacía al terminar. Expiración diferida **1/1**: la reserva 25 pasó sola a EXPIRED y liberó el asiento. Purga de sus 2 manifiestos: ensayo = COMMIT, 78 filas. `/api/ready` 200; destinos `[]`; estadísticas a cero. |

Las carpetas vacías `public/companies/12` y `14` que dejó el ciclo (quitar un logotipo borra el archivo, no su carpeta)
se retiraron con `rmdir`. Desde entonces `purge-qa-data.cjs` también retira, tras el COMMIT, la carpeta de cada empresa
purgada **si está vacía**. `STORAGE_DIR` queda vacío.

### 7.3 Estado final de staging (21:26Z)

- Base: solo el ADMIN (usuario 1), roles 4, permisos 43, asignaciones 104, plantillas 11 y ajustes 5 (comisión 10.00 y
  branding vacío). `audit_logs` = 492: se conservan las 327 originales y se añadieron las de las operaciones y pruebas
  posteriores. **Ninguna se borró.**
- Sin integración CULQI de plataforma: pago sandbox sigue NOT TESTED hasta cargar claves de prueba reales.
- Portada, búsqueda y estadísticas vacías. Esquema idéntico a la referencia. 23 alarmas en OK.
- Snapshot de respaldo: `busperu-staging-db-pre-limpieza-qa-20260924`. Se conserva, y borrarlo requiere autorización.
- Queda en el bucket de artefactos `qa/f1807a/bd-f1807a.cjs` (8 KB, de F18-07A, ajeno a esta limpieza). No se tocó.

### 7.4 Observaciones

- **`/public/stats` cuenta rutas y terminales de empresas inactivas.** Entre la retirada y la purga mostró «3 rutas, 4 terminales» con 0 empresas. Es un comportamiento de la aplicación (LOW) y no se ha cambiado. Tras la purga vuelve a cero.
- **El rol de despliegue no puede leer la pila `busperu-staging-web`**, por el alcance de su política. Por eso `qa-staging.sh` acepta las URLs por entorno. No se amplió IAM.
- **Rollback:** restaurar el snapshot `busperu-staging-db-pre-limpieza-qa-20260924` en una instancia nueva y cambiar `DB_HOST` (runbook §12). Los 3 PNG eran imágenes de 1×1 generadas por el propio smoke y no tienen copia; no hace falta.
