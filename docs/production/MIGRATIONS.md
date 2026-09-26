# Migraciones de base de datos — inventario vigente (F18-19)

> Fuente de verdad: `database/migrations/`. La cadena vigente va de la **001 a la 021**. Antes de F18-18, algunos
> textos históricos decían «001–014» o «001→018». Todos esos rangos quedaron atrás: los añadidos se hicieron en
> FASE 17 (015–016), F17C-SEC-10 (017), F18-02B (018), F18-07 (019) y F18-19 (020–021). Ni F18-18 ni F18-19
> **ejecutaron ninguna migración en producción** (no existe base de producción) ni en `busperu_staging`.

## Resumen

| # | Archivo | Qué hace | Tablas | Reejecutable | Vuelta atrás |
| --- | --- | --- | --- | --- | --- |
| 001 | `001-permiso-resenas-company-admin.sql` | Concede `reviews.update` a `COMPANY_ADMIN` (solo datos de `role_permissions`; no cambia el esquema) | — | sí (`INSERT … WHERE NOT EXISTS`) | borrar esa fila de `role_permissions` |
| 002 | `002-password-reset-tokens.sql` | Recuperación de contraseña por código | +1 | sí | en el archivo |
| 003 | `003-company-bank-accounts.sql` | Cuentas bancarias de la empresa | +1 | sí | en el archivo |
| 004 | `004-drivers.sql` | Conductor y copiloto del viaje | +1 | sí | en el archivo |
| 005 | `005-booking-groups.sql` | Ida y vuelta / multidestino | +1 | sí | en el archivo |
| 006 | `006-company-documents.sql` | Documentos de verificación de empresa | +1 | sí | en el archivo |
| 007 | `007-users-oauth.sql` | Columnas OAuth en `users` | — | sí (`information_schema`) | en el archivo |
| 008 | `008-oauth-flows.sql` | Estado efímero del flujo OAuth (persistente, multiinstancia) | +1 | sí | en el archivo |
| 009 | `009-company-integrations.sql` | Integraciones por empresa (credenciales cifradas) | +1 | sí | en el archivo |
| 010 | `010-bus-layout-versioning.sql` | Versionado de la distribución del bus y precios por tipo de asiento | +4 | sí (`information_schema`) | en el archivo (sin `DROP TABLE` ni `DELETE`) |
| 011 | `011-trip-seat-type-prices-restrict.sql` | La FK de precios por tipo de asiento pasa a `RESTRICT` | — | sí | en el archivo |
| 012 | `012-drop-redundant-code-indexes.sql` | Quita dos índices duplicados de sus únicos (H-19) | — | sí | recrear los índices (en el archivo) |
| 013 | `013-settlement-item-unique-transaction.sql` | `UNIQUE` en `settlement_items.financial_transaction_id` (F12-02); falla sin cambiar nada si hay duplicados | — | sí | en el archivo |
| 014 | `014-revoked-sessions.sql` | Tabla `revoked_sessions` (logout por `jti`, F12-07). **La consulta cada petición autenticada** | +1 | sí | `DROP TABLE revoked_sessions` junto con el código anterior |
| 015 | `015-destinations-content-branding.sql` | CMS de destinos (`destinations`, `destination_attractions`, `destination_festivities`) y claves `branding.*` en `system_settings` | +3 → **49** | sí (`IF NOT EXISTS`, `INSERT IGNORE`) | en el archivo |
| 016 | `016-destination-enhancements.sql` | Ficha de destino: altitud, temperatura, tiempo de viaje, horarios, imagen del calendario y 2 FK a `locations` (`ON DELETE SET NULL`). `schedule`/`weather` quedan obsoletas pero **no se borran** | — | sí (`information_schema`) | en el archivo |
| 017 | `017-users-sessions-valid-from.sql` | `users.sessions_valid_from DATETIME NULL`: suspender una cuenta invalida sus tokens (F17C-SEC-10). **El middleware la lee en cada petición**. Sin relleno: `NULL` no restringe | — | sí (`information_schema`) | `ALTER TABLE users DROP COLUMN sessions_valid_from` con el código anterior |
| 018 | `018-fk-on-update-restrict-mariadb-1011.sql` | `fk_integrations_company` y `fk_bus_layouts_bus` a `ON DELETE CASCADE ON UPDATE RESTRICT`: requisito de MariaDB 10.11 (columnas generadas STORED). En una instalación nueva no hace nada | — | sí (`information_schema`) | no aplica (`ON UPDATE CASCADE` nunca se ejecutaba) |
| 019 | `019-bank-accounts-encryption.sql` | `company_bank_accounts`: `account_number_encrypted`, `account_number_last4`, `interbank_code_encrypted`, `interbank_code_last4`; `account_number` admite `NULL`. La app cifra con AES-256-GCM (`INTEGRATIONS_ENCRYPTION_KEY`). **No borra datos en claro**: eso lo hace `npm run bank:encrypt` (cifrar, verificar y purgar) cuando hay filas previas | — | sí (`ADD COLUMN IF NOT EXISTS`) | las columnas nuevas pueden quedarse; el código anterior no las usa |
| 020 | `020-company-public-profiles.sql` | Perfil público de empresas (F18-19): `company_profiles` (1:1 con `companies`, `slug` único), `company_services`, `company_agencies` (horarios semanales y especiales en JSON, coordenadas con CHECK de rango) y `company_gallery_images`. Todas con columnas de moderación (`review_status`, `published_content` = instantánea pública, `suspended_at`…). JSON como `longtext` + `CHECK json_valid`; FK `ON DELETE CASCADE/SET NULL ON UPDATE RESTRICT` (compatible con 10.11) | +4 → **53** | sí (`CREATE TABLE IF NOT EXISTS`) | `DROP TABLE` de las 4 (orden en la cabecera del archivo) con el código anterior; se pierden los perfiles |
| 021 | `021-complaint-book.sql` | Libro de Reclamaciones virtual (F18-19): `complaint_book_counters` (correlativo por año), `complaint_book_entries` (campos del Anexo I del DS 011-2011-PCM, plazo y respuesta) y `complaint_book_events` (historial). Añade `legal.business_name`, `legal.ruc`, `legal.address`, `legal.email`, `legal.phone` en `system_settings` **con valor `NULL`** (dato pendiente; no se inventa) | +3 → **56** | sí (`CREATE TABLE IF NOT EXISTS`, `INSERT IGNORE`) | **No se debe revertir con datos**: las hojas se conservan al menos 2 años (DS 011-2011-PCM art. 12). Sin datos: `DROP TABLE` de las 3 y borrar las 5 claves `legal.*` |

Esquema resultante (dump + 001→021): **56 tablas, 645 columnas, 253 índices, 96 FK y 25 CHECK**, en utf8mb4_unicode_ci.
Es la huella de `infra/aws/scripts/schema-reference.json`, que comprueba `schema-fingerprint.cjs` (regenerada en F18-19
sobre MariaDB 10.11.19 con una instalación limpia en `busperu_1011_ref`). La referencia anterior (001→019: 49 tablas,
496 columnas, 221 índices, 81 FK, 12 CHECK) queda anotada en el campo `origen`. **Consecuencia:** `busperu_staging`
(001→019) dará diferencias con la referencia nueva hasta que se le apliquen 020 y 021.

## Qué cambió respecto a la documentación histórica

| Documento | Decía | Corregido en F18-18 |
| --- | --- | --- |
| `README.md` §Migraciones | comandos y cadena hasta `018` | añade `019`, su descripción y su estado; la suite aplica `002`→`019` |
| `PRODUCCION.md` §3 y guía rápida | «de la `001` a la `018`», sin `019` | «`001` a `019`», fila de `019` como obligatoria y su verificación |
| `database/migrations/PENDIENTES.md` | `012`–`014` «pendientes en la base real» | aplicadas en `busperu`, `busperu_test` y `busperu_staging` |
| Brief de F18-17 | «001–014» | la cadena real es 001–019 (este documento) |

## Estado por base

| Base | Estado | Evidencia |
| --- | --- | --- |
| `busperu` (desarrollo local) | 001→014 aplicadas (FASE 13); 015→021 no aplicadas (el README lo indica por migración) | README §Migraciones |
| `busperu_test` / `busperu_1011_test` | la suite las reconstruye (dump + 002→021) en cada ejecución | `backend/src/test/helpers/database.ts`; 2194/2194 en 10.4 y 10.11 (F18-19) |
| `busperu_1011_ref` (local, 10.11.19) | dump + 001→021, instalación limpia | origen de la referencia de esquema de F18-19 |
| `busperu_staging` | 001→019 · **020 y 021 pendientes** | F18-07A (019 con `apply-one-migration.sh`). F18-19 no la tocó: 020 y 021 se aplicarán con `apply-one-migration.sh`, una por una y con snapshot previo, cuando se autorice desplegar F18-19 |
| `busperu_prod` | **no existe** | se instalará vacía con `apply-migrations.sh` (dump + 001→021) |

## Idempotencia y orden (verificado en F18-17/F18-18; repetido en F18-19)

- **Orden:** numérico estricto. `apply-migrations.sh` exige exactamente 21 (F18-19), sin `--force`, y se detiene en el primer error. `apply-one-migration.sh` acepta una base con 49 (001→019), 53 (+020) o 56 (+021) tablas.
- **Reaplicación:** las 19 se ejecutaron de nuevo sobre `busperu_1011_test` (MariaDB 10.11.19) ya migrada: **19/19 sin error** y la huella del esquema siguió idéntica. Ninguna duplica columnas, índices ni filas.
  En F18-19 se repitió con las 21 sobre `busperu_1011_ref` ya migrada: **21/21 sin error** y huella idéntica a la referencia nueva.
- **Operaciones destructivas:**
  - Ninguna tiene `DROP TABLE`, `TRUNCATE` ni `DELETE` masivo ejecutables (en 020 y 021 la vuelta atrás está solo comentada en la cabecera).
  - Los `DROP INDEX` / `DROP FOREIGN KEY` de 010–013 y 018 están guardados por `information_schema` y recrean el objeto equivalente.
  - El dump sí contiene 34 `DROP TABLE IF EXISTS`. Por eso `apply-migrations.sh` se niega a importarlo sobre una base con tablas.
- **Sin tabla de control:** el estado se verifica con la huella del esquema, no con un registro de migraciones aplicadas. Es una decisión consciente: no se añade una tabla nueva en esta fase.

## Producción (`busperu_prod`)

**Primera instalación (base vacía).** Snapshot n/a; se usa `apply-migrations.sh`:

```bash
BUSPERU_ENV=prod DB_HOST=<salida DatabaseEndpoint> bash infra/aws/scripts/apply-migrations.sh
```

Se ejecuta en la EC2 con el usuario migrador. Después se pasa `schema-fingerprint.cjs`, que debe dar la referencia.

**Una migración futura sobre datos:**

1. Snapshot manual `busperu-prod-pre-<release>`.
2. `apply-one-migration.sh <archivo> busperu_prod`, **una por una**.
3. `schema-fingerprint.cjs` con la referencia nueva.
4. Despliegue y humo.

**Datos bancarios:**

- Una base nueva no tiene filas heredadas y el código cifra desde la primera escritura, así que `bank:encrypt` **no** se usa.
- `INTEGRATIONS_ENCRYPTION_KEY` es **obligatoria**: sin ella, crear o editar una cuenta bancaria responde 503 (`bank-account.service.ts`).
