# Extensiones de esquema requeridas por los mockups

`Dump20260831.sql` es la fuente de verdad de la base de datos y **no se ha modificado**. Los mockups muestran
funcionalidades que la estructura actual no soporta. Cada una se documenta aquí con la migración segura propuesta.

Cada sección declara su estado. Hay cuatro, y conviene no confundirlos:

| Estado | Significado |
| --- | --- |
| **Implementado** | La migración se aplicó y la funcionalidad está construida y probada. Secciones 1, 2, 3, 4, 5, 6, 8 y 9 (migraciones `002`–`011`), y la sección 11, que no necesitó migración. |
| **Creada, pendiente en la base real** | Migración `012-drop-redundant-code-indexes.sql` (auditoría H-19): quita `idx_bookings_code` e `idx_coupons_code`, duplicados de sus índices únicos. Migración `013-settlement-item-unique-transaction.sql` (auditoría F12-02): UNIQUE sobre `settlement_items.financial_transaction_id`. Migración `014-revoked-sessions.sql` (auditoría F12-07): tabla `revoked_sessions` para revocar tokens al cerrar sesión; debe aplicarse antes de desplegar el código que la consulta. La suite aplica las tres en `busperu_test`. **Actualización F18-18:** las tres están aplicadas en `busperu` (FASE 13), `busperu_test` y `busperu_staging`, así que ninguna migración queda ya en este estado. La cadena vigente es `001`–`019` (inventario en `docs/production/MIGRATIONS.md`). |
| **Parcial** | Una parte está construida y otra no; la propia sección dice cuál. Hoy: la configuración de precios por tipo de asiento (sección 9) y la creación de reseñas desde el portal del cliente (sección 10). |
| **Propuesto, sin ejecutar** | Ninguna sección queda en este estado. |
| **Decisión: no implementar** | Se evaluó y se decidió deliberadamente **no** construirlo. No es un pendiente. Sección 7. |

La sección 10 recoge el resultado de la auditoría H-18 sobre servicios del frontend sin pantalla, y la 12 el de la
auditoría H-21 sobre `ON UPDATE` en tres claves ajenas, que no requirió cambio. La sección 9 no
nace de un mockup concreto sino del modelo de datos: versiona la distribución física del bus para
que un viaje vendido no cambie de mapa. Cierra con su propia lista de lo **parcial** y de la **deuda
técnica**.

---

## 1. Datos bancarios de la empresa (mockup 36)

**Qué muestra el mockup:** cuenta bancaria principal (banco, tipo de cuenta, moneda, número de cuenta, CCI,
titular, historial de cambios) y cuentas adicionales.

**Qué falta:** no existe ninguna tabla de cuentas bancarias. `settlements.payment_reference` solo guarda un texto
libre de referencia de pago.

**Migración propuesta:**

```sql
CREATE TABLE `company_bank_accounts` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `company_id` int(10) unsigned NOT NULL,
  `bank_name` varchar(150) NOT NULL,
  `account_type` enum('CHECKING','SAVINGS') NOT NULL DEFAULT 'CHECKING',
  `currency` char(3) NOT NULL DEFAULT 'PEN',
  `account_number` varchar(50) NOT NULL,
  `interbank_code` varchar(50) DEFAULT NULL,
  `holder_name` varchar(200) NOT NULL,
  `holder_document` varchar(30) DEFAULT NULL,
  `is_primary` tinyint(1) NOT NULL DEFAULT 0,
  `status` enum('PENDING','VERIFIED','REJECTED') NOT NULL DEFAULT 'PENDING',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_bank_accounts_company` (`company_id`),
  CONSTRAINT `fk_bank_accounts_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Estado actual: implementado** (migración `003-company-bank-accounts.sql`). La tabla se creó **exactamente** como
se propone arriba: mismas columnas, mismos tipos y la misma clave foránea. La base pasa de 35 a **36 tablas** y
ninguna existente se modificó.

| | |
| --- | --- |
| Endpoints | `GET/POST /company/bank-accounts`, `PUT/DELETE /company/bank-accounts/:id`, `GET /company/bank-accounts/history` |
| Permisos | Reutilizados, **ninguno nuevo**: `companies.view` para leer, `companies.update` para escribir. OPERATOR conserva sus permisos actuales y por tanto solo puede consultar. |
| Aislamiento | La empresa se resuelve desde `company_users` del usuario autenticado. `company_id` no es una columna escribible: si llega en el cuerpo o en la query, se ignora. Un CUSTOMER —que también tiene `companies.view` para el listado público— recibe 403 por no pertenecer a ninguna empresa. |
| Datos sensibles | El número de cuenta y el CCI solo viajan completos a quien puede editarlos; el resto recibe `XXXX XXXX 1234`. `account_number` e `interbank_code` se añadieron a las claves sensibles de `audit_logs`, así que el historial guarda quién, cuándo y sobre qué cuenta, pero nunca el número. |
| Reglas | Una sola cuenta principal por empresa; la primera cuenta lo es automáticamente; al borrar la principal asciende la más antigua; no se admiten números duplicados dentro de la misma empresa; `status` solo lo cambia la plataforma. |
| Liquidaciones | Queda preparada la asociación empresa → cuenta → liquidación a través de `company_id`. **No** se tocó el módulo financiero ni se implementó transferencia real. |

---

## 2. Inicio de sesión con Google / Microsoft (mockups 8, 12, 30)

**Qué falta:** `users` solo tiene `email` + `password_hash`. No hay columnas de proveedor OAuth.

**Migración propuesta:**

```sql
ALTER TABLE `users`
  ADD COLUMN `oauth_provider` enum('GOOGLE','MICROSOFT') DEFAULT NULL AFTER `password_hash`,
  ADD COLUMN `oauth_id` varchar(191) DEFAULT NULL AFTER `oauth_provider`,
  ADD UNIQUE KEY `uq_users_oauth` (`oauth_provider`, `oauth_id`);
```

Además `password_hash` es `NOT NULL`, por lo que una cuenta puramente OAuth requeriría permitir `NULL` o guardar
un hash aleatorio inutilizable.

**Estado actual: implementado** (migración `007-users-oauth.sql`), con una salvedad importante que se detalla más
abajo: **el login real contra Google o Microsoft requiere credenciales que este proyecto no tiene**.

Las dos columnas y la clave única se crearon **exactamente** como se proponen arriba. No se creó ninguna tabla —la
base sigue en **39 tablas**— y no se modificó ninguna otra columna.

### Decisiones que §2 dejaba abiertas

§2 solo definía el esquema. Estas cuatro decisiones no estaban en el documento y se tomaron de forma explícita:

0. **Dónde vive el estado efímero del flujo.** §2 no propone ninguna tabla. La primera implementación guardó el
   `state` y los tickets en memoria del proceso, lo que ataba el backend a **una sola instancia** y perdía los
   flujos en vuelo en cada reinicio. Se sustituyó por la tabla `oauth_flows` (migración `008`), que **no forma
   parte de §2** y se añade como decisión explícita. Detalle completo más abajo.
1. **`password_hash`.** De las dos salidas que ofrece §2 se eligió la mínima: **hash aleatorio inutilizable**, no
   permitir `NULL`. Así no se toca una columna de la que dependen login, registro y cambio de contraseña. Una
   cuenta creada por OAuth recibe un bcrypt de 32 bytes aleatorios que nadie conoce. Si su dueño quiere una
   contraseña, la establece por el flujo de recuperación (§3), que exige demostrar la posesión del correo.
2. **Flujo: Authorization Code + PKCE (S256).** El `client_secret` nunca sale del servidor y el `id_token` nunca
   pasa por el navegador. Se descartó recibir un `id_token` desde el frontend por ser una superficie mayor.
3. **Caso «el correo ya existe con contraseña»: se RECHAZA (`email_taken`).** No se fusionan cuentas por
   coincidencia de correo, ni siquiera con `email_verified` a `true` — eso sería confiar en la palabra del
   proveedor para entregar una cuenta ajena. El usuario vincula su proveedor **desde el perfil**, ya autenticado,
   donde la prueba de identidad es su propia sesión.
4. **Alta automática: solo en el flujo de cliente.** Un correo desconocido crea una cuenta `CUSTOMER` / `ACTIVE`
   únicamente cuando el flujo arranca desde el login público. En Portal Empresa y Panel Admin —donde las cuentas
   se aprovisionan a mano— un correo desconocido se rechaza con `account_not_found`. El `scope` que envía el
   navegador **solo puede restringir**: jamás concede un rol.

### Qué requiere configuración externa

| | |
| --- | --- |
| Implementado y probado | Todo el flujo: arranque con PKCE, canje del código, verificación completa del `id_token` (firma contra JWKS, emisor, audiencia, vigencia, `nonce`), reglas de alta y vinculación, emisión de sesión, pantallas y auditoría. |
| Requiere credenciales | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` y `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`, más registrar el `redirect_uri` en la consola de cada proveedor. **Sin ellas el proveedor queda desactivado**: el backend responde 503 y el frontend no pinta el botón. |
| Probado de verdad | 72 tests contra un proveedor local con criptografía real (par RSA propio, JWKS publicado, tokens firmados), más una sonda de seguridad independiente. |
| **NO probado** | **El inicio de sesión real contra Google o Microsoft.** No se han usado credenciales ni cuentas reales de ningún proveedor, y no se ha simulado que se hiciera. Queda pendiente de una prueba con credenciales del comercio. |

### Detalle

| | |
| --- | --- |
| Endpoints | `GET /auth/oauth/providers`, `GET /auth/oauth/:provider/start`, `GET /auth/oauth/:provider/callback`, `POST /auth/oauth/session`, `POST /auth/oauth/:provider/link`, `GET /auth/oauth/link`, `DELETE /auth/oauth/link` |
| Proveedores | Google (mockups 8, 12 y 30) y Microsoft (solo mockup 30, el Panel Admin). Cada pantalla pinta los del mockup que le corresponde. |
| Un proveedor por cuenta | El esquema de §2 pone las columnas en `users`, no en una tabla aparte, así que una cuenta admite **un solo proveedor**. Intentar añadir un segundo devuelve `already_linked`. |
| Sesión | Se emite **el mismo JWT** que el login con contraseña, con la misma expiración. No hay un segundo sistema de autorización: el middleware sigue releyendo rol, permisos y empresas desde la base en cada petición. |
| Permisos | **Ninguno nuevo.** OAuth es autenticación, no autorización. Una cuenta creada por OAuth es `CUSTOMER` y no pertenece a ninguna empresa. OPERATOR conserva sus permisos exactos. |
| Estados de cuenta | `SUSPENDED`, `INACTIVE` y `PENDING` no pueden entrar, con la **misma** función compartida que usa el login con contraseña: OAuth no es una puerta trasera. |
| `state`, `nonce`, PKCE | `state` y `nonce` de 32 bytes, verificador PKCE de 64. Todos se guardan **del lado del servidor** y el `state` es de un solo uso: reproducir el callback no vale. En modo vinculación, la cuenta a vincular va atada al `state` en el servidor, nunca llega del cliente. |
| Ticket | El callback no devuelve el JWT en la URL: entrega un ticket opaco de 32 bytes, de un solo uso y 60 segundos de vida, que el frontend canjea por la sesión. |
| Tokens del proveedor | **No se guarda ninguno.** El `access_token` se descarta en cuanto se extrae la identidad: §2 solo pide autenticar. |
| Almacén de `state` y tickets | Tabla `oauth_flows` (migración `008`). **Persistente**: soporta reinicios, varias instancias y balanceador. Ver la sección siguiente. |
| Auditoría | La entrada por OAuth queda en `audit_logs` como `LOGIN`, igual que la entrada con contraseña, y la vinculación y desvinculación como `UPDATE`. |

### `oauth_flows`: el estado efímero del flujo (migración `008`)

**§2 no propone esta tabla.** Se añade para que el flujo no dependa de la memoria del proceso. Una fila por intento
de OAuth, con dos consumos encadenados:

```
/start     INSERT  state_hash + expires_at (600 s)
/callback  consume el state  ->  emite ticket_hash + ticket_expires_at (60 s) + user_id
/session   consume el ticket ->  emite el JWT
```

| | |
| --- | --- |
| Qué se guarda | `state_hash`, `ticket_hash`, proveedor, `scope`, `mode`, `user_id`, las caducidades y las dos marcas de consumo. |
| Qué **NO** se guarda | El `state` y el `ticket` en claro · el `nonce` y el `code_verifier` · `access_token`, `refresh_token` e `id_token` del proveedor · el `client_secret` · el JWT de BusPerú · correo, nombre o foto del proveedor · IP y user-agent. |
| Hashes | `sha256(state:state:JWT_SECRET)` y `sha256(ticket:ticket:JWT_SECRET)`. El secreto liga el hash a esta instalación: una filtración de la tabla no permite reconstruir nada. |
| `nonce` y `code_verifier` | **Derivados, no almacenados**: `sha256(state:nonce:JWT_SECRET)` y `sha256(state:pkce:JWT_SECRET)`. El proveedor devuelve el `state` en el callback, así que se recalculan de forma determinista sin compartir memoria. El verificador cumple el RFC 7636 (64 caracteres, dentro del rango 43-128, solo `unreserved`) y el `code_challenge` sigue siendo su SHA-256 en base64url (S256). |
| Consumo atómico | Un único `UPDATE` condicional por consumo (`... AND state_used_at IS NULL AND expires_at > NOW()`). InnoDB bloquea la fila, de modo que de dos peticiones concurrentes con el mismo `state` solo una obtiene `affectedRows = 1`; la otra recibe `invalid_state`. Idéntico para el ticket. |
| Multiinstancia y reinicios | `/start`, `/callback` y `/session` pueden atenderse en **instancias distintas**, y un reinicio no invalida un flujo en vuelo. Comprobado en la suite contra una segunda instancia real, lanzada en otro proceso. |
| TTL | `state` 600 s (`OAUTH_STATE_TTL_SECONDS`), `ticket` 60 s (`OAUTH_TICKET_TTL_SECONDS`). |
| Limpieza | `purgeExpiredOAuthFlows()` desde el planificador que ya existe para la expiración de reservas. `DELETE ... WHERE expires_at < NOW() - 1 HORA LIMIT 500`, por el índice `idx_oauth_flows_expires`. **Nunca se recorre la tabla entera, y jamás durante una petición.** |
| Cascada | `user_id` con FK `ON DELETE CASCADE`: borrar una cuenta se lleva sus flujos pendientes. |

---

## 3. Recuperación de contraseña y verificación por código (mockups 10)

**Qué falta:** no existe tabla de tokens de recuperación ni de códigos OTP. `users.email_verified_at` existe pero no
hay dónde guardar el código enviado.

**Migración propuesta:**

```sql
CREATE TABLE `password_reset_tokens` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int(10) unsigned NOT NULL,
  `token_hash` varchar(255) NOT NULL,
  `expires_at` datetime NOT NULL,
  `used_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `token_hash` (`token_hash`),
  KEY `idx_reset_tokens_user` (`user_id`),
  CONSTRAINT `fk_reset_tokens_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### Extensión aplicada (migración `002-password-reset-tokens.sql`)

La tabla propuesta arriba estaba pensada para un **enlace con token**, pero el mockup 10 y el
flujo acordado usan un **código de 6 dígitos**. Se implementó la tabla con tres columnas más y
un cambio de índice, todos necesarios para que ese flujo sea seguro:

| Cambio | Motivo |
| --- | --- |
| `attempts tinyint unsigned NOT NULL DEFAULT 0` | Un código de 6 dígitos son 10⁶ combinaciones: sin límite de intentos es forzable. Se bloquea al quinto fallo. |
| `ticket_hash varchar(255) NULL` | La verificación del código no cambia la contraseña: emite un ticket opaco de un solo uso. Así el código no puede reutilizarse contra `/auth/reset-password`. |
| `ticket_expires_at datetime NULL` | El ticket vive menos que el código (10 min frente a 15). |
| `token_hash` pasa de `UNIQUE` a índice normal | Dos usuarios pueden recibir por azar el mismo código y un `UNIQUE` haría fallar el `INSERT`. La unicidad la aporta el hash, que incluye el id del usuario y el secreto. |

**Estado actual: implementado.** La base pasa de 34 a **35 tablas**; ninguna tabla existente se
modificó. Endpoints: `POST /auth/forgot-password`, `/auth/verify-reset-code`,
`/auth/reset-password` y `/auth/resend-reset-code`, todos con el `authLimiter` que ya existía.
El código se genera con `crypto.randomInt`, se guarda como `sha256(user_id:código:JWT_SECRET)`
y nunca viaja en la respuesta HTTP. La purga de solicitudes caducadas se engancha al
planificador de expiración de reservas, sin añadir otro proceso periódico.

---

## 4. Conductor y copiloto del viaje (mockup 31)

**Qué falta:** `trips` no tiene `driver_id` ni `co_driver_id`, y no existe una tabla de conductores.

**Migración propuesta:**

```sql
CREATE TABLE `drivers` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `company_id` int(10) unsigned NOT NULL,
  `first_name` varchar(100) NOT NULL,
  `last_name` varchar(100) NOT NULL,
  `document_number` varchar(30) NOT NULL,
  `license_number` varchar(50) NOT NULL,
  `license_expires_at` date DEFAULT NULL,
  `phone` varchar(30) DEFAULT NULL,
  `status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `document_number` (`document_number`),
  CONSTRAINT `fk_drivers_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `trips`
  ADD COLUMN `driver_id` int(10) unsigned DEFAULT NULL AFTER `bus_id`,
  ADD COLUMN `co_driver_id` int(10) unsigned DEFAULT NULL AFTER `driver_id`,
  ADD CONSTRAINT `fk_trips_driver` FOREIGN KEY (`driver_id`) REFERENCES `drivers` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_trips_co_driver` FOREIGN KEY (`co_driver_id`) REFERENCES `drivers` (`id`) ON DELETE SET NULL;
```

**Estado actual: implementado** (migración `004-drivers.sql`). La tabla `drivers` se creó **exactamente** como se
propone arriba y `trips` recibió las dos columnas indicadas. La base pasa de 36 a **37 tablas**.

> **Nota sobre el `ALTER`.** Es el único `ALTER` del proyecto sobre una tabla existente y está prescrito por esta
> misma sección: no hay otra forma de asociar la tripulación a un viaje. Es aditivo (dos columnas `NULL` con
> `ON DELETE SET NULL`), no destructivo, y cada sentencia va condicionada a que la columna no exista, de modo que
> la migración es idempotente.

| | |
| --- | --- |
| Endpoints | `GET/POST /company/drivers`, `GET/PUT/DELETE /company/drivers/:id`. La asignación al viaje usa el `PUT /trips/:id` que ya existía. |
| Permisos | Reutilizados, **ninguno nuevo**: `buses.view` para leer y `buses.create` / `buses.update` / `buses.delete` para administrar, el mismo mapeo ya documentado para asientos y tipos de bus. Asignar tripulación usa `trips.update`. **OPERATOR conserva sus permisos**: consulta la plantilla y asigna tripulación (ya tenía `trips.update`), pero no da de alta ni edita personal. |
| Modelo | Los conductores **no son usuarios de BusPerú**: son personal de la empresa. La tabla no distingue conductor de copiloto; el puesto lo decide el viaje (`driver_id` frente a `co_driver_id`), así que cualquier conductor activo puede ocupar cualquiera de los dos. |
| Aislamiento | La empresa sale de `company_users` del usuario autenticado; `company_id` no es columna escribible. La tripulación se valida contra la empresa **de la ruta del viaje**, así que ni el ADMIN puede mezclar personal entre empresas. |
| Reglas | Conductor y copiloto no pueden ser la misma persona (se comprueba la combinación resultante, no solo la enviada); no se admite personal `INACTIVE`; no se puede desactivar ni borrar a quien tenga viajes por delante; el documento es único en toda la tabla y el conflicto se comunica con un mensaje neutro que no revela en qué empresa está registrado. |
| Estados | `ACTIVE` / `INACTIVE`, los definidos por la propuesta. |
| Auditoría | Alta, modificación y baja quedan registradas con el nombre de la persona; el documento y el teléfono no se guardan en `audit_logs`. La asignación se audita en la entrada de `trips`. |

---

## 5. Integraciones y pasarelas de pago (mockup 37)

**Qué muestra el mockup:** Izipay, Niubiz, Culqi, PayPal, Google Analytics, Google Maps, WhatsApp Business, con
estado de conexión y configuración por empresa.

**Qué falta:** no hay tabla de integraciones. `api_keys` sirve para llaves salientes de BusPerú, no para credenciales
de proveedores externos.

**Migración propuesta:**

```sql
CREATE TABLE `company_integrations` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `company_id` int(10) unsigned DEFAULT NULL,
  `provider` varchar(50) NOT NULL,
  `category` enum('PAYMENT_GATEWAY','INVOICING','ANALYTICS','MESSAGING','OTHER') NOT NULL DEFAULT 'OTHER',
  `credentials` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`credentials`)),
  `status` enum('CONNECTED','DISCONNECTED','NEEDS_CONFIG') NOT NULL DEFAULT 'DISCONNECTED',
  `connected_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_integration_company_provider` (`company_id`, `provider`),
  CONSTRAINT `fk_integrations_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Las credenciales deben cifrarse en reposo, nunca guardarse en texto plano.

**Estado actual: implementado** (migración `009-company-integrations.sql`), **en el alcance literal de §5**.

### Alcance: configuración, no operación

Conviene decirlo sin rodeos, porque el título de la sección induce a error: **§5 no propone un sistema de cobro.**
Propone una sola tabla, que es el catálogo de credenciales del mockup 37 — una pantalla de *configuración*. No
define cargos, ni webhooks, ni tokenización, ni ningún cambio en `payments`, `bookings` o el flujo de compra.
Tampoco singulariza ninguna pasarela: lista Izipay, Niubiz, Culqi, PayPal, Google Analytics, Google Maps y
WhatsApp Business al mismo nivel.

Lo implementado **guarda y cifra configuración**. Conectar una integración **no activa nada**: ningún cobro,
notificación ni informe se envía a esos proveedores. `status` significa «configurado», no «operativo», y la
interfaz lo advierte de forma permanente en lugar de aparentar que la integración opera.

### Diferencias respecto a la propuesta

La tabla se creó como se propone arriba, con **una adición**: la columna generada `company_scope`
(`COALESCE(company_id, 0)`) y su clave única `uq_integration_scope_provider`.

**Por qué.** `UNIQUE (company_id, provider)` no protege las filas de plataforma: en MySQL/MariaDB los `NULL` no
colisionan entre sí dentro de un índice único, de modo que esa clave impide dos filas `(7,'CULQI')` pero permite
infinitas `(NULL,'CULQI')` — justo la integración a nivel de plataforma, que en el modelo agregador guardaría las
credenciales reales de cobro. La clave original de §5 se conserva tal cual.

### Decisiones que §5 dejaba abiertas

1. **Modelo de cobro: agregador.** Un solo comercio, de BusPerú. El dinero entra a la plataforma, que retiene su
   comisión y liquida el neto a la empresa por `settlements`. La pantalla por empresa **no** implica que cada
   empresa tenga su propio comercio: `company_id = NULL` representa la integración de plataforma.
2. **Algoritmo de cifrado: AES-256-GCM**, sin dependencias nuevas. Se eligió cifrado *autenticado* para que una
   fila manipulada falle al descifrar en vez de devolver basura en silencio. El sobre es JSON válido, como exige
   el `CHECK (json_valid(...))` que §5 prescribe.
3. **Clave de cifrado**: `INTEGRATIONS_ENCRYPTION_KEY`, 32 bytes, **independiente de `JWT_SECRET`** (rotar el JWT
   no debe inutilizar las credenciales). Si falta, el módulo responde 503 y **no guarda nada en claro**.
4. **Credenciales de solo escritura.** La API **jamás** las devuelve descifradas, a nadie. Publica qué campos
   están configurados y sus **cuatro últimos caracteres**, lo justo para distinguir una llave de pruebas de una de
   producción.
5. **Catálogo y campos por proveedor**: derivados del mockup 37, porque §5 no los enumera. La categoría `INVOICING`
   existe en el enum y su pestaña se dibuja vacía, sin inventar proveedores.

| | |
| --- | --- |
| Endpoints | `GET /company/integrations`, `GET /company/integrations/:provider`, `PUT /company/integrations/:provider`, `POST …/:provider/connect`, `POST …/:provider/disconnect`, `DELETE …/:provider`. Los mismos bajo `/admin/integrations` para la plataforma |
| Direccionamiento | Por `:provider`, no por id numérico: natural para un catálogo fijo y sin IDOR posible |
| Permisos | Reutilizados, **ninguno nuevo**: `companies.view` para leer, `companies.update` para escribir. La plataforma exige además **rol ADMIN**. OPERATOR conserva sus permisos: consulta, pero no modifica, y tampoco ve credenciales |
| Aislamiento | La empresa sale de `company_users`; `company_id` no es columna escribible ni en el cuerpo ni en la query. Una integración ajena devuelve 404. `company_id` y `provider` **nunca se actualizan** en el upsert, así que una fila no puede reasignarse a otra empresa |
| Estados | `NEEDS_CONFIG` si faltan campos obligatorios · `DISCONNECTED` por defecto y al desconectar · `CONNECTED` solo con la configuración completa y una acción explícita |
| Desconectar | **Borra las credenciales**. Una integración desconectada no conserva llaves vivas |
| Auditoría | `CREATE`, `UPDATE`, `CONNECT`, `DISCONNECT` y `DELETE` en `audit_logs`, con el proveedor y **los nombres** de los campos tocados, nunca sus valores. Se añadieron a las claves redactadas: `credentials`, `public_key`, `private_key`, `secret_key`, `api_key`, `access_key`, `access_token`, `client_secret`, `webhook_secret` |

### Riesgos conocidos para una futura fase de cobro real

Detectados durante el análisis y **documentados sin modificar el código**, porque corregirlos excede el alcance de
§5:

1. **`provider_transaction_id` se acepta del cliente** en `POST /bookings/:id/pay` y
   `POST /bookings/itineraries/:id/pay`. Hoy es inofensivo —no hay dinero real de por medio— pero **el día que
   exista una pasarela permitiría marcar una reserva como pagada inventando un identificador**. Debe dejar de
   aceptarse el mismo día que entre un cobro real.
2. **No hay clave de idempotencia** de petición: `payments.provider_transaction_id` tiene índice **no único**.
3. **`express.json()` es global**, lo que destruye el cuerpo en crudo necesario para verificar firmas de webhook.
   Una ruta de webhook necesitaría `express.raw` montado antes del parser.
4. **Ventana entre cobrar y confirmar**: hoy no existe porque no hay llamada externa. Con una pasarela real, un
   cobro exitoso seguido de un fallo de base dejaría dinero cobrado sin reserva; exige registro de intento y
   conciliación.
5. **`payments.provider`, `payments.payment_data` y `refunds.provider_refund_id` ya existen y están sin usar**: la
   fase de cobro no necesitará migración para ellos.

**Lo que NO se implementó, por estar fuera de §5:** cobros reales · Culqi.js · tokenización de tarjetas · PAN/CVV ·
cargos · webhooks de pago · reembolsos contra el proveedor · conciliación · idempotencia del cobro · sandbox ·
credenciales reales. El flujo de pagos existente **no se modificó**.

---

## 6. Documentos de verificación de empresa (mockups 13, 14)

**Qué muestra el mockup:** paso "Documentos" del registro y línea de tiempo de verificación (información,
documentos legales, verificación administrativa, aprobación final) con fecha y hora por etapa.

**Qué falta:** `companies.status` guarda el estado final, pero no hay tabla de documentos ni de etapas.

**Migración propuesta:**

```sql
CREATE TABLE `company_documents` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `company_id` int(10) unsigned NOT NULL,
  `type` enum('RUC','LICENSE','INSURANCE','LEGAL_REP_ID','OTHER') NOT NULL,
  `file_url` varchar(500) NOT NULL,
  `status` enum('PENDING','VERIFIED','REJECTED') NOT NULL DEFAULT 'PENDING',
  `reviewed_by` int(10) unsigned DEFAULT NULL,
  `reviewed_at` datetime DEFAULT NULL,
  `notes` varchar(500) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_company_documents_company` (`company_id`),
  CONSTRAINT `fk_company_documents_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_company_documents_reviewer` FOREIGN KEY (`reviewed_by`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Estado actual: implementado** (migración `006-company-documents.sql`). La tabla se creó **exactamente** como se
propone arriba; solo se añadió el índice `idx_company_documents_reviewer`, que MariaDB necesita para la clave
foránea del revisor. La base pasa de 38 a **39 tablas** y ninguna existente se modificó.

Tres decisiones que la propuesta dejaba abiertas:

1. **Dónde viven los archivos.** El proyecto no tenía ninguna infraestructura de subida (ni multer, ni
   `express.static`). Se optó por un **almacén privado en disco** (`backend/storage/`, fuera de cualquier carpeta
   pública y fuera del repositorio). `file_url` guarda una **referencia interna relativa**, nunca una URL: el
   archivo solo se obtiene por `GET /company/documents/:id/file`, que vuelve a validar sesión y empresa.
2. **La línea de tiempo del mockup 14 se deriva**, no se almacena: PENDIENTES.md no propone tabla de etapas, así
   que las cuatro fases salen de `companies.status` y del recuento de documentos por estado.
3. **Subir documentos no cambia `companies.status`.** PENDIENTES.md nunca los hace obligatorios para aprobar una
   empresa, así que aprobarla sigue siendo una acción aparte del ADMIN, igual que antes.

| | |
| --- | --- |
| Endpoints | `GET /company/documents`, `GET /company/documents/verification-status`, `GET /company/documents/pending-review` (ADMIN), `GET /company/documents/:id`, `GET /company/documents/:id/file`, `POST /company/documents`, `DELETE /company/documents/:id`, `PUT /company/documents/:id/review` |
| Estados | `PENDING` → `VERIFIED` o `REJECTED`. Un documento **siempre nace PENDING**; reemplazar el archivo lo devuelve a PENDING y borra la revisión anterior. `PENDING` no es un destino válido de la revisión. |
| Permisos | Reutilizados, **ninguno nuevo**: `companies.view` para leer, `companies.update` para escribir. La revisión exige `companies.update` **y además rol ADMIN**, porque un COMPANY_ADMIN también tiene ese permiso y no puede aprobarse sus propios documentos. OPERATOR conserva sus permisos actuales: consulta, pero no sube ni elimina. |
| Aislamiento | La empresa se resuelve desde `company_users` del usuario autenticado; `company_id` no es una columna escribible y el `company_id` de la query solo lo honra el ADMIN. Un documento de otra empresa devuelve **404, no 403**, para no confirmar su existencia. Un CUSTOMER recibe 403 por no pertenecer a ninguna empresa. |
| Almacenamiento | Archivo validado **antes** de tocar la base (si falla, no queda fila); nombre aleatorio de 16 bytes, nunca el del usuario; permisos `0600`; ruta resuelta y comprobada contra la raíz del almacén, así que `../../etc/passwd.pdf` no escapa. Si la base falla después de guardar, el archivo se borra para no dejarlo huérfano. |
| Validaciones de archivo | PDF, JPG y PNG; máximo 5 MB; se comprueban **extensión** (solo la última, así que `x.pdf.exe` se lee como `.exe`), **MIME declarado** y **bytes mágicos** del contenido. Un ejecutable renombrado a `.pdf` se rechaza. |
| Datos que no salen del servidor | La API **nunca** devuelve `file_url`: en su lugar publica `has_file`. El nombre interno del archivo tampoco viaja, y la descarga va con `Content-Disposition: attachment` y `X-Content-Type-Options: nosniff` para que el navegador nunca lo interprete. |
| Revisión | Solo ADMIN. Rechazar **exige motivo** (`notes`), que es lo que la empresa ve para corregir. Al resolver se notifica a los COMPANY_ADMIN de la empresa con el sistema de notificaciones existente (`company.document_verified` / `company.document_rejected`), de forma idempotente. |
| Auditoría | `audit_logs` registra `CREATE` (subida), `UPDATE` (reemplazo), `DELETE`, `APPROVE` y `REJECT`, con usuario, empresa y tipo de documento — **nunca la referencia del archivo ni su contenido**. |
| Frontend | Portal Empresa: *Gestión → Verificación* (`/company/documents`), con la línea de tiempo del mockup 14, una tarjeta por tipo de documento, subida/reemplazo, motivo del rechazo y descarga autenticada. Panel Admin: *Verificación de empresas* (`/admin/company-documents`), bandeja de pendientes con aprobar/rechazar. |

---

## 7. Puntos de fidelidad del cliente (mockup 11)

**Estado: decisión de no implementar.** No es un pendiente pospuesto: es una decisión tomada y ratificada. Esta
sección es la única que **no propone migración**, y esa ausencia es deliberada.

**Qué muestra el mockup:** "Puntos acumulados: 250 pts" e "Invita a tus amigos".

**Qué falta:** no hay columna ni tabla de puntos. El dump no contiene absolutamente nada de fidelización: ni tabla,
ni columna, ni ajuste en `system_settings`, ni permiso.

**Por qué no se construye.** El mockup aporta un número de maqueta (250) y un texto, no un programa. Todo lo demás
tendría que inventarse, y no es una decisión técnica sino de producto:

- cuántos puntos otorga cada sol y sobre qué base (importe pagado, tarifa sin comisión, por reserva o por tramo);
- en qué momento se acreditan (pago confirmado, viaje realizado, liquidación);
- si son canjeables y cuánto vale un punto al canjearlo;
- qué ocurre ante cancelación, reembolso parcial o expiración de la reserva;
- si caducan y con qué plazo.

Ninguna de esas reglas está en los mockups ni en el dump. Implementarlas supondría inventar una economía completa
y, además, tocar el cálculo de importes de `bookings` —hoy cubierto por las suites de reservas, pagos, cupones y
liquidaciones— para sostener un canje que nadie ha especificado.

**Qué se hace en su lugar.** La UI **no muestra puntos inventados**. El resumen de la cuenta (mockup 11) usa solo
datos derivables y reales: viajes realizados, gasto total, estado de la cuenta y fechas. El campo "Puntos
acumulados" se renderiza en su posición exacta del mockup, con el valor *No disponible* y la nota "El programa de
puntos no existe en el esquema actual"; la tarjeta "Invita a tus amigos" se muestra con su control desactivado.
Es la misma regla que se aplicó al documento de identidad, la fecha de nacimiento y las preferencias de viaje:
**posición fiel al mockup, dato jamás inventado.**

**Si algún día se decide construirlo**, esto es lo que haría falta antes de escribir una sola línea: fijar las
cinco reglas de arriba y, a partir de ellas, añadir un libro mayor de movimientos (nunca una columna de saldo
editable) ligado a `bookings`, con acreditación dentro de la transacción de confirmación de pago, asiento negativo
de reversión ante cancelación o reembolso, y clave de idempotencia para impedir la doble acreditación. Mientras
esas reglas no existan, esta sección se queda como está.

---

## 8. Ida y vuelta / multidestino (mockup 1)

**Qué faltaba:** `bookings` referencia un único `trip_id`. Un viaje de ida y vuelta requeriría una reserva por
tramo o una tabla de agrupación.

**Estado actual: implementado** (migración `005-booking-groups.sql`). De las dos alternativas que planteaba esta
sección se eligió **una reserva por tramo, agrupadas por una tabla**, por tres motivos:

1. **IDA no cambia.** Una compra de un solo tramo no crea grupo (`group_id` queda a `NULL`), así que su flujo, sus
   endpoints y su comportamiento son exactamente los de antes.
2. **Las ocho tablas que dependen de `bookings`** (`payments`, `refunds`, `reviews`, `coupon_usages`,
   `financial_transactions`, `settlement_items`, `support_tickets`, `booking_seats`) conservan su significado: una
   fila de `bookings` sigue siendo un viaje.
3. **Tramos de empresas distintas.** En un ida y vuelta la ida y la vuelta pueden ser de dos empresas. Como cada
   tramo es su propia reserva, cada una lleva su empresa por `trip → route → company_id` y las comisiones,
   liquidaciones y reembolsos siguen cuadrando. Con una sola reserva multitramo eso se rompería.

```
booking_groups            una compra (IT-123456)
  └── bookings            un tramo cada una, con segment_order
        └── booking_seats los asientos de ESE tramo, con su propio trip_id
```

| | |
| --- | --- |
| Esquema | Tabla `booking_groups` + `bookings.group_id` (FK `ON DELETE SET NULL`) y `bookings.segment_order`. La base pasa de 37 a **38 tablas**. |
| Búsqueda | `POST /public/itineraries/search` recibe los tramos y devuelve los resultados de cada uno. La de IDA sigue siendo `GET /public/trips`, sin cambios. |
| Compra | `POST /bookings/itineraries` crea todas las reservas en **una** transacción: si un tramo falla, el `ROLLBACK` deshace también los anteriores. |
| Pago | `POST /bookings/itineraries/:id/pay` confirma tramo a tramo reutilizando `confirmBookingPayment`, de modo que cada empresa cobra su parte. |
| Asientos | La disponibilidad se evalúa por `trip_id` + `seat_id`: el asiento 5 de la ida y el 5 de la vuelta son asientos distintos y no entran en conflicto. |
| Concurrencia | Intacta. `createBookingOnConnection` conserva los `SELECT ... FOR UPDATE` sobre viaje, asientos y reservas solapadas. |
| Validaciones | Origen ≠ destino por tramo, fechas reales en formato `AAAA-MM-DD`, orden cronológico entre tramos, 2 tramos exactos en ida y vuelta, máximo 5, y ningún viaje repetido. |
| Cupón | Se aplica una sola vez, al primer tramo: aplicarlo a todos multiplicaría el descuento. |
| Pasajeros | Los datos del titular son comunes a toda la compra, como en la ida simple. |

### Decisión sobre los pagos: un `payment` por tramo, ninguno de grupo

**Se mantiene un `payment` por `booking`/tramo, agrupado conceptualmente por `booking_group`.
No existe un `payment` a nivel de grupo.** `payments.booking_id` sigue siendo `NOT NULL` y la tabla `payments`
no se modificó.

**Motivo.** La atribución financiera se deriva de `payment → booking → trip → route → company_id`. Un ida y vuelta
o un multidestino **puede combinar tramos de empresas distintas**: Lima→Huánuco con una empresa y la vuelta con
otra. Con un pago único por compra esa cadena se rompe —una sola fila no puede pertenecer a dos empresas— y con
ella se romperían tres cosas:

- el módulo **Pagos** del Portal Empresa, que está acotado por empresa: ¿en cuál de las dos aparecería ese cobro?
- las **comisiones**, que se calculan sobre el importe de cada empresa;
- las **liquidaciones**, que agrupan `financial_transactions` por empresa.

Con un pago por tramo cada empresa ve, cobra y liquida exactamente lo suyo, sin lógica de reparto.

**Reembolsos.** Se conserva el modelo `refund → payment → booking`. Cancelar la vuelta genera un reembolso por el
importe exacto del pago de ese tramo, sin tocar el otro. No hacen falta reembolsos parciales sobre un pago
compartido, porque no hay pago compartido.

**Compatibilidad futura con una pasarela.** Cuando se integre el cobro externo, un **único** cargo puede quedar
registrado en los N pagos de la compra: `provider_transaction_id` se propaga a todos los tramos. Así el cliente ve
un solo cargo en su tarjeta y la plataforma conserva la atribución por empresa. El sentido contrario —repartir un
pago único entre empresas— no tendría solución limpia.

**Atomicidad de la confirmación.** Lo que sí es atómico es confirmar la compra. `payItinerary` abre **una sola
transacción** y confirma los N tramos sobre esa misma conexión con `confirmBookingPaymentOnConnection`, extraída
de `confirmBookingPayment` con el mismo criterio que `createBookingOnConnection`. Si cualquier tramo falla, el
`ROLLBACK` revierte también los ya confirmados: estados de reserva, pagos, movimientos financieros y
notificaciones. Nunca queda una compra medio pagada.

La idempotencia no cambió: una reserva ya confirmada se omite sin tocar nada, y el pago `PENDING` existente se
reutiliza en lugar de crear otro.

---

## 9. Distribución física versionada del bus y precios por tipo de asiento

**Qué faltaba:** `seats` colgaba directamente de `buses`, y el mapa de un viaje se resolvía contra los asientos
**vivos** del bus: reordenar un bus le cambiaba el mapa a los viajes ya vendidos. No existía la noción de piso, ni
de elementos que ocupan sitio sin ser asientos (baño, escalera, conductor, puerta), ni un precio distinto por tipo
de asiento dentro de un mismo viaje.

**Estado actual: implementado, con una parte parcial** (migraciones `010-bus-layout-versioning.sql` y
`011-trip-seat-type-prices-restrict.sql`). La configuración de los precios por tipo de asiento **no tiene API ni
pantalla**: ver 9.8.

| Pieza | Estado |
| --- | --- |
| Versionado DRAFT → PUBLISHED → ARCHIVED, clonación y publicación | **Implementado** |
| Pisos, rejilla, asientos y elementos no-asiento, con validación de colisiones | **Implementado** |
| Editor de la distribución (Portal Empresa y Panel Admin) | **Implementado** |
| Viaje anclado a una versión concreta | **Implementado** |
| Mapa de asientos del cliente dibujado desde la distribución | **Implementado** |
| Capacidad vendible (`seat_count` sin asientos `INACTIVE`) | **Implementado** |
| Resolución del precio por tipo de asiento y congelado en la venta | **Implementado** |
| Alta y edición de precios por tipo de asiento | **Parcial**: solo por base de datos |

### 9.1 Modelo

```
buses
  └── bus_layouts            una VERSIÓN de la distribución (v1, v2, …)
        └── bus_layout_decks       sus pisos, cada uno con su rejilla filas × columnas
              ├── seats                  asientos: se venden
              └── bus_layout_elements    baño, escalera, conductor, puerta, hueco: no se venden

trips.bus_layout_id ──→ bus_layouts   el viaje fija su versión al crearse
trip_seat_type_prices                 precio por (viaje, tipo de asiento)
booking_seats.price                   precio realmente cobrado, congelado en la venta
```

`seats` conserva `bus_id`: cada asiento pertenece a la vez a un bus, a una versión (`layout_id`) y a un piso
(`deck_id`).

### 9.2 Esquema

**Migración `010` — aditiva y reejecutable.** No hay `DROP TABLE`, `DELETE` ni `TRUNCATE`. Los `ALTER` van guardados
con el patrón `PREPARE/EXECUTE` y los rellenos con `WHERE … IS NULL` / `NOT EXISTS`, de modo que una segunda pasada
no duplica nada. La base pasa de 41 a **45 tablas**.

| Tabla / columna | Contenido |
| --- | --- |
| `bus_layouts` | `bus_id`, `version`, `status` (`DRAFT`/`PUBLISHED`/`ARCHIVED`), `name`, `seat_count`, `published_at`. Únicas: `uq_layout_bus_version (bus_id, version)` y `uq_layout_published_bus (published_scope)`. |
| `bus_layouts.published_scope` | Columna **generada** `STORED`: vale `bus_id` si la fila está publicada y `NULL` en otro caso. Como los `NULL` no colisionan en un índice único, admite cualquier número de versiones `DRAFT` o `ARCHIVED` por bus y **como mucho una `PUBLISHED`**. Es la técnica de `company_integrations.company_scope` (sección 5). |
| `bus_layout_decks` | `layout_id`, `deck_number`, `name`, `row_count`, `column_count`. Única `(layout_id, deck_number)`. La rejilla se llama `row_count`/`column_count` porque `rows` es palabra reservada en MariaDB 10.4. |
| `bus_layout_elements` | `deck_id`, `element_type` (`BATHROOM`, `STAIRS`, `DRIVER`, `DOOR`, `EMPTY`), `row_number`, `column_number`, `row_span` y `col_span` (ambos 1 por defecto), `label`. |
| `trip_seat_type_prices` | `trip_id`, `seat_type_id`, `price`. Única `(trip_id, seat_type_id)`. |
| `seats.layout_id`, `seats.deck_id` | Nuevas, `NULL`, con índice. |
| `trips.bus_layout_id` | Nueva, `NULL`, con índice. |
| Índice único de `seats` | `uq_bus_seat_number (bus_id, seat_number)` se sustituye por `uq_layout_seat_number (layout_id, seat_number)`: el asiento «01» existe una vez **por versión**. Primero se crea el nuevo y después se retira el viejo. |

**Claves ajenas de la `010`:**

| Clave | ON DELETE | Por qué |
| --- | --- | --- |
| `fk_bus_layouts_bus` | CASCADE | La versión es parte del bus. |
| `fk_bus_layout_decks_layout`, `fk_bus_layout_elements_deck` | CASCADE | El piso y sus elementos son parte de la versión. |
| `fk_seats_layout`, `fk_seats_deck` | CASCADE | Igual que `fk_seats_bus`. El histórico no corre peligro: `fk_booking_seats_seat` es RESTRICT y no deja borrar un asiento vendido. |
| `fk_trips_bus_layout` | RESTRICT | El candado del histórico: **una versión usada por un viaje no se puede borrar**. |
| `fk_trip_seat_type_prices_trip` | CASCADE | Sin viaje, sus precios no significan nada. |
| `fk_trip_seat_type_prices_type` | CASCADE → **RESTRICT en la `011`** | Ver abajo. |

**Relleno de la `010`.** Cada bus existente recibió una versión 1 `PUBLISHED` con un piso 1 cuya rejilla se calculó
con el `MAX(row_number)` y `MAX(column_number)` de sus asientos (0 si no los tenía). Todos sus asientos y **todos sus
viajes, incluidos los pasados**, quedaron anclados a esa versión. No cambió ningún id, número, fila, columna, tipo ni
estado de asiento, y `buses.capacity` no se tocó.

**Migración `011` — un tipo de asiento con precios ya no se borra.** `fk_trip_seat_type_prices_type` pasa de
`ON DELETE CASCADE` a **`ON DELETE RESTRICT`** y conserva `ON UPDATE CASCADE`. Con CASCADE, borrar un tipo del
catálogo arrastraba en silencio los precios configurados en todos los viajes, y esos asientos pasaban a cobrar
`trips.base_price` sin que nadie tocara el viaje. Ahora el borrado falla con `ER_ROW_IS_REFERENCED_2`, que
`error.middleware.ts` traduce a **409**. `fk_trip_seat_type_prices_trip` sigue en CASCADE. La `011` no cambia columnas,
índices ni datos, y es reejecutable: solo actúa si la clave sigue en CASCADE.

### 9.3 Ciclo de vida de una versión

| Estado | Qué significa | ¿Se edita? |
| --- | --- | --- |
| `DRAFT` | Borrador. | **Sí.** Es el único estado editable. |
| `PUBLISHED` | Versión vigente del bus. Como mucho una por bus. | **No.** Para cambiarla se clona. |
| `ARCHIVED` | Versión anterior. Los viajes que la usan la siguen usando. | **No.** |

- **Copy-on-write.** Ninguna operación modifica una versión publicada o archivada; el servicio responde «Una versión
  publicada o archivada no se modifica: clónala para editarla».
- **Crear un borrador** (`POST /buses/:id/layouts`) crea una versión `DRAFT` vacía con `seat_count` 0 y, si no se
  indican pisos, un «Piso 1» con rejilla 0 × 0. El número de versión lo calcula el servidor; `status`, `version` y
  `bus_id` no se leen del cuerpo. El backend no impide que un bus tenga varios borradores.
- **Clonar** (`POST /layouts/:id/clone`) copia pisos, elementos y asientos —con su estado— a una versión `DRAFT`
  nueva, en una sola transacción. El `seat_count` del clon se **recuenta** sobre los asientos copiados; no se hereda.
- **Publicar** (`POST /layouts/:id/publish`) exige un `DRAFT` con al menos un piso y al menos un asiento, sin asientos
  fuera de un piso de la versión, y valida la geometría completa de cada piso (9.4). Después archiva la versión
  publicada anterior, recalcula `seat_count`, marca la nueva como `PUBLISHED` y copia su `seat_count` a
  `buses.capacity`. **Los viajes ya creados no cambian de versión.**
- **Eliminar** (`DELETE /layouts/:id`) solo borra un `DRAFT` sin viajes asociados.

### 9.4 Pisos, asientos, elementos y geometría

La rejilla de cada piso va de `(1, 1)` a `(row_count, column_count)`. **Un 0 en `row_count` o `column_count` significa
«rejilla sin declarar» y no limita**, para no dejar inservibles los pisos heredados de la migración.

**Al colocar o mover** (en el editor, dentro de la transacción de la operación):

- Fila y columna empiezan en 1, y la pieza, con toda su extensión, debe caber en la rejilla.
- Un **elemento ocupa todas las casillas** de su `row_span × col_span`, no solo la de origen.
- Ninguna casilla puede estar ocupada a la vez por dos piezas: dos asientos, dos elementos o un asiento y un elemento.
- Un asiento necesita número (máximo 10 caracteres) único dentro de la versión; su tipo, si se indica, debe existir;
  su estado es `AVAILABLE` o `INACTIVE`. Puede moverse a otro piso **de la misma versión**, nunca a otra versión ni a
  otro bus.
- `row_span` y `col_span` deben ser 1 o mayores, y el tipo de elemento, uno de los cinco.
- **La rejilla no puede encoger** por debajo de los asientos ni de la extensión completa de los elementos que ya
  contiene.
- Un piso solo se borra **vacío**: con asientos o elementos se rechaza; nunca se borra en cascada.
- Un asiento con reservas no se puede borrar.

**Al publicar** se repasa además cada piso entero con la misma geometría del editor: posición y extensión válidas de
cada elemento, elementos dentro de la rejilla, ningún par de elementos solapado y ningún asiento en una casilla ya
ocupada. Así un dato que no entró por el editor —una carga manual, un clon de datos antiguos— no llega publicado.

**Concurrencia.** Todas las escrituras del editor bloquean la fila del bus (`SELECT … FROM buses … FOR UPDATE`) y
releen el estado dentro de la transacción. El ciclo de reserva bloquea viaje → reserva → asientos de la reserva y
nunca `buses`, así que los dos conjuntos de cerrojos son disjuntos y no pueden formar un ciclo.

### 9.5 Viaje y versión

- `POST /trips` ancla el viaje a la versión **publicada** del bus en ese momento y, si no se envía `available_seats`,
  lo inicializa con su `seat_count`. Un bus sin versión publicada no admite viajes. El cliente no puede enviar
  `bus_layout_id`.
- `PUT /trips/:id` **no permite cambiar el bus de un viaje que ya tiene `booking_seats`**. Sin ventas, cambiar de bus
  reancla el viaje a la versión publicada del bus nuevo y reinicia `available_seats` con su `seat_count`. Enviar el
  mismo bus no cuenta como cambio. Todo ocurre en una transacción, tras bloquear el viaje.
- El mapa de un viaje sale de **su** versión (`trips.bus_layout_id`) aunque el bus ya vaya por otra. Solo si el viaje
  no tuviera versión propia se usa la publicada del bus: es una red de transición para datos anteriores a la `010`.

### 9.6 Capacidad vendible

**`bus_layouts.seat_count` es el número de asientos VENDIBLES de la versión: los `AVAILABLE`.** Un asiento `INACTIVE`
sigue existiendo, ocupa su casilla y se dibuja en el mapa, pero **no cuenta**, y la reserva lo rechaza con «El
asiento N no está habilitado».

| Dato | Definición actual |
| --- | --- |
| `bus_layouts.seat_count` | Asientos de la versión con `status = 'AVAILABLE'`. Definido una sola vez en `SELLABLE_SEAT_COUNT_SQL` (`bus-layout.service.ts`) y usado por el editor, la clonación, la publicación, el seed y las fixtures de la suite. Se recalcula al crear, borrar o **cambiar el estado** de un asiento. |
| `buses.capacity` | Caché: al publicar se copia el `seat_count` de la versión publicada. Es la capacidad **actual** del bus, no la de sus viajes. Sigue siendo una columna escribible de `PUT /buses/:id`, así que un cambio manual prevalece hasta la siguiente publicación. En la capacidad de un viaje solo interviene si el viaje no tiene versión propia. |
| Capacidad de un viaje | `TRIP_SEAT_CAPACITY_SQL` (`trip.service.ts`): el `seat_count` de la versión del viaje y, solo si el viaje no tuviera versión, `buses.capacity`. La usan la búsqueda pública, el listado de viajes, el panel, los reportes y las fichas de viaje de la API de integración. |
| `trips.available_seats` | Nace con el `seat_count` de la versión; baja al vender y, al liberar asientos, no supera la capacidad del viaje. |
| `seats_available` (búsqueda pública) | Capacidad del viaje − asientos retenidos (reservas `CONFIRMED`, `COMPLETED` o `PENDING` dentro de plazo). |
| `seats_count` (`GET /buses`) | Otro dato: número de **filas de asiento** de la versión publicada del bus, `INACTIVE` incluidos. La pantalla de flota lo muestra como «Asientos creados», junto a «Capacidad». |

> **Nota histórica.** El relleno de la `010` calculó `seat_count` contando **todas** las filas, y el `COMMENT` de la
> columna en el esquema sigue diciendo «Cache del numero de asientos de la version». La semántica vendible rige en el
> código desde la corrección H-15. En la base actual las dos cifras coinciden porque todos sus asientos son
> `AVAILABLE`, así que no hizo falta migración ni relleno.

### 9.7 API de integración: disponibilidad de un viaje

`GET /integration/v1/trips/:id/availability` (autenticado con `X-API-Key`) devuelve el mapa completo de asientos de la
versión del viaje y este desglose, calculado sobre esa lista:

| Campo | Significado |
| --- | --- |
| `capacity` | Capacidad **física** del mapa: todos los asientos de la versión, `INACTIVE` incluidos. |
| `seats_taken` | Asientos retenidos por una reserva (`CONFIRMED`, `COMPLETED` o `PENDING` dentro de plazo). |
| `seats_inactive` | Asientos físicos no vendibles (`INACTIVE`). |
| `seats_available` | Asientos vendibles libres: `capacity − seats_taken − seats_inactive`. |

En esa respuesta se cumple `capacity = seats_taken + seats_inactive + seats_available`, y `seats_available` coincide
con el de la búsqueda pública. En cambio, el `capacity` de `GET /integration/v1/trips` y de
`GET /integration/v1/trips/:id` —igual que el de la búsqueda pública— es la capacidad **vendible**
(`TRIP_SEAT_CAPACITY_SQL`). Con asientos `INACTIVE` las dos cifras difieren exactamente en `seats_inactive`.

### 9.8 Precios por tipo de asiento

| | |
| --- | --- |
| Resolución | Precio de un asiento en un viaje = `trip_seat_type_prices.price` del par (viaje, tipo del asiento) y, si no hay fila, `trips.base_price`. |
| Mapa | `GET /public/trips/:id/seats` y `GET /trips/:id/seats` proyectan ese `price` en cada asiento. El frontend lo muestra y suma, sin multiplicar el precio base por la cantidad. |
| Cobro | `createBooking` lee los precios con los asientos ya bloqueados y calcula el importe con ellos. |
| Histórico | El precio cobrado se escribe en **`booking_seats.price`** al vender. Cambiar después `trips.base_price` o `trip_seat_type_prices` no reescribe las ventas hechas. |
| Borrado de un tipo | Rechazado con 409 mientras tenga precios configurados (migración `011`). |
| **Configuración** | **Parcial.** No hay endpoint ni pantalla que cree, edite o borre filas de `trip_seat_type_prices`: hoy solo se cargan directamente en la base. Sin filas, cada viaje cobra su `base_price`. El editor de distribución no tiene campo de precio a propósito: el precio es por viaje, no por distribución. |

### 9.9 Endpoints

Permisos reutilizados, **ninguno nuevo**: leer `buses.view`, crear y editar `buses.update`, borrar `buses.delete`. En el
dump, ADMIN y COMPANY_ADMIN tienen los tres y OPERATOR solo `buses.view`, así que consulta pero no edita. `company_id`,
`layout_id` y `bus_id` nunca se aceptan del cliente: la propiedad se resuelve hacia arriba (asiento → piso → versión →
bus → empresa). Un bus de otra empresa responde **403** «El bus pertenece a otra empresa». Todas las escrituras quedan
en `audit_logs`.

| Endpoint | Permiso | Qué hace |
| --- | --- | --- |
| `GET /buses/:id/layouts` | `buses.view` | Versiones del bus, de la más reciente a la más antigua. |
| `POST /buses/:id/layouts` | `buses.update` | Crea un borrador. |
| `GET /layouts/:id` | `buses.view` | Árbol completo: `{ layout, decks, elements, seats }`. |
| `POST /layouts/:id/clone` | `buses.update` | Clona en un borrador nuevo. |
| `POST /layouts/:id/publish` | `buses.update` | Publica un borrador y archiva la versión anterior. |
| `DELETE /layouts/:id` | `buses.delete` | Borra un borrador sin viajes. |
| `GET` / `POST /layouts/:id/decks` | `buses.view` / `buses.update` | Lista o añade pisos. |
| `PATCH` / `DELETE /decks/:id` | `buses.update` / `buses.delete` | Edita número, nombre o rejilla; borra un piso vacío. |
| `GET` / `POST /decks/:id/elements` | `buses.view` / `buses.update` | Lista o coloca elementos. |
| `PATCH` / `DELETE /elements/:id` | `buses.update` / `buses.delete` | Edita tipo, posición, extensión o etiqueta; borra. |
| `GET` / `POST /decks/:id/seats` | `buses.view` / `buses.update` | Lista o coloca asientos. |
| `PATCH` / `DELETE /layout-seats/:id` | `buses.update` / `buses.delete` | Edita número, tipo, posición, piso, estado, ventana o pasillo; borra uno sin reservas. |
| `GET /public/trips/:id/layout` | Público | Geometría de la versión **del viaje**: `{ layout_id, version, status, name, decks: [{ id, deck_number, name, row_count, column_count, elements }] }`. **Sin asientos, sin precios y sin datos de empresa.** El id de la versión no se acepta como parámetro: sale del viaje. Aplica la misma visibilidad que `GET /public/trips/:id`. |
| `GET /public/trips/:id/seats` | Público | Asientos de la versión del viaje con `status`, `deck_id`, `deck_number`, `price` e `is_taken`. Los elementos no salen aquí. |

**El recurso genérico `/seats` se retiró** (auditoría FASE 7, hallazgo H-16). Sus escrituras ya estaban cerradas,
ninguna pantalla usaba su lectura, y esa lectura no distinguía versiones ni pisos y no aplicaba alcance por empresa a
un `CUSTOMER`. `GET`, `POST`, `PUT` y `DELETE` sobre `/seats` y `/seats/:id` responden hoy **404**. Los asientos se
leen y administran solo por los endpoints versionados de esta tabla: `/decks/:id/seats`, `/layout-seats/:id` y el
árbol `GET /layouts/:id`. Los asientos de un viaje se consultan en `/public/trips/:id/seats` y `/trips/:id/seats`.
La tabla `seats` no cambió.

### 9.10 Frontend

| Ruta | Guardia | Pantalla |
| --- | --- | --- |
| `/company/buses/:busId/asientos` | `buses.view` | `SeatConfigPage`, Portal Empresa |
| `/admin/buses/:busId/asientos` | `buses.view` | `SeatConfigPage`, Panel Admin |
| `/viaje/:tripId/asientos` | Pública | `SeatSelectionPage`, selección de asientos del cliente |

**`SeatConfigPage`** tiene dos pestañas: «Editor» e «Historial de versiones». Si el bus tiene versión publicada, crea
el borrador clonándola; si no, crea la primera versión como borrador. Solo se edita un `DRAFT`, y solo con
`buses.update`. Herramientas: seleccionar, asiento, baño, escalera, conductor, puerta y espacio vacío; se pulsa una
casilla libre para colocar. Permite añadir pisos, cambiar filas y columnas de la rejilla, editar número, tipo, fila,
columna, piso, estado (Disponible / Inactivo), ventana y pasillo de un asiento, y tipo, posición, extensión y
etiqueta de un elemento, y borrar asientos, elementos y pisos. Cada cambio se guarda en el momento contra su endpoint, sin un «guardar todo», así que las
validaciones son las del backend. La pantalla **no borra borradores** aunque el endpoint exista, y **no tiene campo de
precio**.

**Mapa del cliente** (`SeatSelectionPage` + `SeatMap`). Pide la geometría (`/public/trips/:id/layout`) y los asientos
(`/public/trips/:id/seats`) y dibuja la rejilla de cada piso con sus elementos. Muestra un selector de piso solo
cuando hay más de uno, pinta los asientos `INACTIVE` como no disponibles y ofrece una leyenda por tipo de asiento con
su precio real.

### 9.11 Pruebas

| Archivo | Tests | Cubre |
| --- | --- | --- |
| `33-bus-layout.test.ts` | 21 | Distribución versionada: modelo, anclaje y lectura |
| `34-seat-pricing.test.ts` | 20 | Precio por tipo de asiento y capacidad por versión |
| `35-layout-versioning.test.ts` | 35 | Borrador, clonación, publicación y archivado |
| `36-layout-editor.test.ts` | 49 | Editor: pisos, elementos, asientos, reglas y permisos |
| `37-bus-seats-count.test.ts` | 14 | `seats_count` del listado de buses |
| `38-public-trip-layout.test.ts` | 26 | `GET /public/trips/:id/layout` |
| `39-trip-bus-change.test.ts` | 28 | Un viaje con ventas no cambia de bus |
| `40-seed.test.ts` | 25 | El seed crea versiones de distribución completas |
| `41-trip-capacity.test.ts` | 24 | Capacidad efectiva del viaje |
| `42-deck-bounds.test.ts` | 30 | La rejilla no encoge por debajo de su contenido |
| `43-element-concurrency.test.ts` | 24 | Elementos y rejilla bajo el cerrojo del bus |
| `44-seat-concurrency.test.ts` | 28 | Asientos y geometría bajo el cerrojo del bus |
| `45-seat-type-prices.test.ts` | 22 | Los precios por tipo de asiento sobreviven al catálogo (`011`) |
| `46-layout-publish-validation.test.ts` | 31 | Validación geométrica completa al publicar |
| `48-inactive-seat-capacity.test.ts` | 15 | Capacidad vendible con asientos `INACTIVE` |

No hay pruebas automáticas del frontend: el proyecto no tiene framework de tests de interfaz.

### 9.12 Parcial y deuda técnica de esta sección

| Tipo | Punto |
| --- | --- |
| **Parcial** | Precios por tipo de asiento sin API ni pantalla de configuración (9.8). |
| **Observación / deuda técnica abierta** | `fk_seats_type` es `ON DELETE SET NULL`: borrar un tipo de asiento deja sus asientos sin tipo, y esos asientos pasan a cobrar `trips.base_price`. Se deja constancia del comportamiento actual. **No forma parte de H-17, no requiere acción, no es una tarea pendiente de implementación y no se propone ni se ejecuta ninguna migración sobre esta clave.** |
| **Deuda técnica** | El `COMMENT` de `bus_layouts.seat_count` en el esquema describe la semántica anterior (9.6). |
| **Deuda técnica** | El editor y el mapa de asientos no tienen pruebas automáticas de interfaz. |

---

## 10. Servicios del frontend sin pantalla: reseñas, reembolsos, roles y reportes (auditoría H-18)

**Qué se auditó:** la capa `frontend/src/services/index.ts` declara métodos que ninguna página, componente, hook o
contexto llama hoy. La auditoría final del proyecto (FASE 7, hallazgo H-18) los revisó uno a uno contra el backend: 30
métodos en total.

**Estado: H-18 cerrado.** Cerrarlo **no** significa que todas las pantallas posibles existan. Significa esto:

- **No hay código muerto que eliminar.** Los 30 métodos apuntan a endpoints que existen y funcionan, y ninguno se ha
  borrado.
- La mayoría no tiene consumidor directo **por diseño**, y se mantienen (10.5).
- Se identificaron **mejoras funcionales futuras**, ninguna crítica: la creación de reseñas desde el portal del cliente
  (**parcial**), la vista pública del texto de las reseñas y el alta manual o parcial de reembolsos desde una interfaz
  administrativa (ambas **opcionales**).
- Roles y reportes quedan documentados como **decisión arquitectónica** y **deuda menor**, respectivamente.

| Pieza | Estado |
| --- | --- |
| Creación de reseñas desde el portal del cliente | **Parcial**: backend completo, sin interfaz |
| Moderación y respuesta de reseñas (empresa y ADMIN) | **Implementado** |
| Vista pública del texto de las reseñas | Mejora opcional: endpoint existente, sin pantalla |
| Solicitud y procesamiento de reembolsos | **Implementado** |
| Alta manual o parcial de reembolsos desde una interfaz administrativa | Mejora opcional: solo por API |
| Roles de aplicación | Decisión arquitectónica: cuatro roles fijos |
| Lista de reportes | Deuda menor: duplicada en el frontend |

### 10.1 Reseñas

| | |
| --- | --- |
| Backend | `POST /reviews` existe y está probado (`08-review.test.ts`). Recibe `booking_id`, `rating` (1–5), `title` y `comment`; `trip_id` y `company_id` los deduce el servidor de la reserva. |
| Frontend | `reviewService.create` existe y apunta a `POST /reviews`. |
| Permiso | `reviews.create`, que en el dump tienen `CUSTOMER` y `ADMIN`. |
| Reglas | La reserva debe ser del propio usuario (salvo ADMIN) y estar `CONFIRMED` o `COMPLETED`; una sola reseña por reserva y usuario (409 si se repite). Nace `PENDING` y no se ve en público hasta que se modera. |
| Moderación | **Implementada, con pantalla**: `/company/reviews` y `/admin/reviews` publican u ocultan, y la empresa responde. El contenido es del pasajero y la empresa no puede reescribirlo. |
| Interfaz del cliente | **No existe.** Ninguna pantalla del portal del cliente permite crear una reseña. |
| Público | `GET /public/reviews` y `publicService.reviews` existen y devuelven las 12 reseñas `PUBLISHED` más recientes, opcionalmente por empresa. **Ninguna pantalla muestra hoy su texto**; el sitio público solo enseña la nota media y el número de reseñas. |

**Estado: parcial.** La creación de reseñas desde el portal del cliente es una **mejora funcional futura**, no un fallo
del sistema: reservas, pagos y moderación funcionan sin ella. Mientras no exista, la moderación y la nota pública solo
reflejan reseñas creadas por API. Mostrar el texto de las reseñas publicadas en el sitio público es una **mejora
opcional**.

**Decisión pendiente antes de construir esa interfaz: `CONFIRMED` frente a `COMPLETED`.** Hoy el backend admite
reseñar reservas `CONFIRMED` —pagadas, de un viaje que todavía no ha salido— además de las `COMPLETED`, aunque su
mensaje de error hable de «viajes realizados». La suite (`08-review`) fija ese comportamiento. Antes de la interfaz hay
que decidir si se podrán reseñar **solo viajes `COMPLETED`** o **también reservas `CONFIRMED`**. Esta regla no se ha
cambiado.

### 10.2 Reembolsos

**El flujo normal de reembolso está implementado de principio a fin, con pantalla:**

1. El cliente cancela su reserva desde «Mis viajes», o la empresa o el ADMIN la cancelan desde el listado de reservas.
   Además, **cancelar un viaje** cancela sus reservas y abre los reembolsos de lo cobrado automáticamente (sección 11).
   Se aplican las reglas de `cancelBooking`: no se cancela una reserva ya cancelada, completada o vencida, ni con el
   viaje en curso o realizado, y hace falta `booking.cancellation_hours` de antelación (24 h por defecto) salvo que el
   viaje esté cancelado.
2. Si la reserva tenía un pago `PAID`, se abre un reembolso `PENDING` por su importe, en la misma transacción. También
   se abre uno automáticamente cuando Culqi cobra pero la reserva no se puede confirmar.
3. Los reembolsos se consultan en `/company/refunds` y `/admin/refunds`. Quien tiene `payments.refund` —en el dump, solo
   ADMIN— los **completa o rechaza** ahí mismo.
4. Al completar un reembolso de un pago cobrado con Culqi, la devolución se pide a Culqi antes de cerrarlo; si Culqi
   falla, el reembolso queda como estaba y se puede reintentar. Un pago en efectivo o por transferencia se cierra sin
   pasarela.

**`refundService.create` → `POST /refunds` es otra cosa:** un **mecanismo manual del ADMIN** (`payments.refund`) para
abrir un reembolso fuera de ese flujo, incluso parcial. Valida que el pago esté `PAID`, pertenezca a la reserva indicada
y no se reembolse por encima de lo cobrado. **No tiene pantalla propia**, y eso **no** significa que falte el flujo
normal de reembolso. Una posible mejora futura sería el **alta manual o parcial de reembolsos desde una interfaz
administrativa**.

### 10.3 Roles

La aplicación tiene **cuatro roles**: `ADMIN`, `COMPANY_ADMIN`, `OPERATOR` y `CUSTOMER`. Están integrados en el frontend:

- `RoleName` es exactamente esa unión;
- `RoleRoute` restringe el Portal Empresa a `COMPANY_ADMIN`, `OPERATOR` y `ADMIN` (este último, con empresa) y el
  Panel Admin a `ADMIN`;
- `homePathFor` decide el portal de inicio de cada rol.

Por eso **no existe una interfaz para crear roles arbitrarios**: un rol nuevo no tendría portal, página de inicio ni
navegación. La pantalla de roles lista los roles y edita **sus permisos**, que es como se ajusta el acceso.
`roleService.create`, `update` y `remove` (`POST /roles`, `PUT /roles/:id`, `DELETE /roles/:id`, solo ADMIN) siguen
disponibles para administración por API. **No se recomienda implementar la creación arbitraria de roles** mientras la
aplicación use roles fijos.

### 10.4 Reportes

`GET /reports` existe y devuelve las claves de los reportes disponibles. El frontend no lo usa: `FinancePages` mantiene
su propia lista en `REPORT_LABELS`, con título y descripción de cada uno. **Hoy las dos listas coinciden** (las siete
claves). Es una pequeña duplicación, no un fallo: un reporte nuevo en el backend no aparecería en pantalla hasta
añadirlo también a `REPORT_LABELS`.

### 10.5 Resto de métodos sin consumidor directo

Se mantienen. Ninguno es código muerto:

| Métodos | Por qué no tienen consumidor directo |
| --- | --- |
| `get` de `userService`, `tripService`, `busTypeService`, `seatTypeService`, `locationService`, `routeService`, `routeStopService`, `promotionService`, `couponService`, `settingService`, `commissionService` y `templateService` | Los genera el helper genérico `crud()`, que da los cinco métodos a cada recurso; las pantallas editan desde el listado. |
| `routeStopService.update` | Mismo helper; las paradas se crean y eliminan desde la pantalla, pero no se editan. |
| `paymentService.get`, `driverService.get`, `integrationService.get`, `reviewService.get` | Operaciones de detalle: la pantalla trabaja con los datos del listado. Quedan disponibles para una vista de detalle futura. |
| `reviewService.remove` | La moderación oculta o rechaza reseñas cambiando su estado en lugar de borrarlas. `DELETE /reviews/:id` queda para el ADMIN por API. |
| `publicService.terminals` | El buscador trabaja con `publicService.cities`. |
| `busLayoutService.listDecks`, `listElements`, `listSeats` | El editor lee la versión entera de una vez con `GET /layouts/:id` (sección 9). |
| `busLayoutService.removeLayout` | El editor no borra borradores, aunque el endpoint existe (sección 9.10). |

`notificationService.unreadCount` **sí tiene consumidor**: el contador de avisos de `PortalLayout`.

---

## 11. Cancelación de viajes, reservas y reembolsos (FASE 8H)

**Qué faltaba** (auditoría 8G): `POST /trips/:id/cancel` solo cambiaba `trips.status`. Las reservas pagadas quedaban
`CONFIRMED` sin reembolso ni aviso, una reserva `PENDING` podía pagarse después, y `PUT /trips/:id` permitía cancelar
sin efectos o reactivar un viaje cancelado.

**Estado actual: implementado, sin migración.** Usa el esquema, los estados y las tablas existentes; las plantillas
nuevas las crea `ensureSystemTemplates` al arrancar el backend.

### 11.1 Quién y desde qué estado

| | |
| --- | --- |
| Endpoint | `POST /trips/:id/cancel` |
| Permiso | `trips.update` **y** rol `ADMIN` o `COMPANY_ADMIN`. **OPERATOR no puede cancelar** (403), aunque conserva `trips.update` para operar el viaje. `role_permissions` no cambió. |
| Alcance | Una empresa solo cancela viajes de sus rutas; uno ajeno responde 404. ADMIN cancela cualquiera. |
| Se puede cancelar desde | `SCHEDULED`, `BOARDING`, `DELAYED` |
| No se puede cancelar desde | `IN_PROGRESS`, `COMPLETED` (400). Un viaje ya `CANCELLED` responde 200 sin hacer nada: repetir la llamada es seguro. |
| `PUT /trips/:id` | No puede sacar a un viaje de `CANCELLED` (no se reactiva) ni ponerlo en `CANCELLED`: cancelar tiene efectos que solo aplica `POST /trips/:id/cancel`. Ambos casos responden 400. El resto de la edición no cambia. |
| Interfaz | En `/company/trips` y `/admin/trips` el botón «Cancelar viaje» solo aparece en los estados cancelables y para ADMIN o COMPANY_ADMIN. |

### 11.2 Qué hace la cancelación

Todo ocurre en **una transacción** que empieza bloqueando el viaje (el mismo primer cerrojo que la venta, el pago y la
expiración):

| Reserva antes | Reserva después | Asientos | Pago | Reembolso | Aviso |
| --- | --- | --- | --- | --- | --- |
| `PENDING` | `CANCELLED` | Liberados; `available_seats` recupera sus cupos | `PENDING` → `CANCELLED`. Un `PROCESSING` (cobro con tarjeta en vuelo) no se toca: lo resuelve el flujo de Culqi (11.4) | No | `trip.cancelled`: «no se realizó ningún cobro» |
| `CONFIRMED` con pago `PAID` | `CANCELLED` | Liberados | Sigue `PAID` hasta procesar el reembolso | **Uno**, `PENDING`, por el importe cobrado | `trip.cancelled`: «generamos una solicitud de reembolso» |
| `CANCELLED`, `EXPIRED`, `COMPLETED` | Sin cambio | Sin cambio | Sin cambio | No | No |

- `booking_seats` **se conserva siempre**: el asiento deja de estar retenido porque la reserva ya no está vigente.
- Cada reserva se cancela con `cancelBookingOnConnection`, las mismas reglas que cuando cancela el pasajero.
- La cancelación **no crea movimientos financieros**.
- Auditoría: la cancelación del viaje (con los ids afectados), cada reserva cancelada y cada reembolso abierto.
- Tras confirmar la transacción se envía el correo `trip.cancelled_email` a cada pasajero con `sendEmail` (Resend si
  está configurado). Si el envío falla se registra y la cancelación sigue en pie.

**Itinerarios.** Solo se cancela y reembolsa la reserva del tramo cuyo viaje se cancela. Los demás tramos siguen
`CONFIRMED`, con su pago intacto, y el grupo conserva todas sus reservas.

### 11.3 Pagos de un viaje cancelado

**Una reserva de un viaje `CANCELLED` no puede pagarse.** `confirmBookingPaymentOnConnection` relee el estado del viaje
bajo su cerrojo y lo rechaza (400). Por esa función pasan efectivo, transferencia, Yape y Plin, el pago de
itinerarios, la tarjeta y el webhook de Culqi. El cobro con tarjeta además lo comprueba **antes** de pedir el cargo, así
que en el caso normal Culqi no llega a cobrar.

### 11.4 Culqi: cargo aprobado sobre una reserva que ya no se puede confirmar

Si Culqi cobra y la reserva ya no es confirmable —viaje cancelado, reserva cancelada o vencida, asiento tomado—, el
dinero se cubre con `openCompensatingRefund`, la misma función por las dos vías:

- **Respuesta HTTP del cobro:** el pago queda `PAID` con su `provider_transaction_id` y se abre un reembolso `PENDING`.
- **Webhook de Culqi** (cuando la respuesta HTTP no llegó, por ejemplo tras un TIMEOUT): hace lo mismo y responde 200.

La reserva **no se confirma**. La función es idempotente: bloquea el pago y, si ya está `PAID` o `REFUNDED`, no hace
nada; y el reembolso solo se inserta si el pago no tiene ya uno vivo. Un webhook repetido no duplica el reembolso.

### 11.5 Reembolsos

| | |
| --- | --- |
| Creación | Idempotente: se inserta solo si el pago no tiene otro reembolso que no sea `FAILED` ni `CANCELLED`. Nace `PENDING`; el dinero no se da por devuelto. |
| Procesamiento | `POST /refunds/:id/process`, con `payments.refund` (ADMIN). |
| Concurrencia | Todo el procesamiento va bajo `GET_LOCK('<base>:refund:<id>', 0)` de MariaDB: una segunda petición simultánea sobre el mismo reembolso recibe 409 y no llega a Culqi. |
| Culqi | Si el pago se cobró con Culqi, la devolución se pide antes de cerrar el reembolso y su identificador se guarda en `provider_refund_id` en cuanto Culqi responde. Un reintento que lo encuentra no pide una segunda devolución. |
| Fallo de Culqi | El reembolso queda `PENDING` sin `provider_refund_id`, el pago sigue `PAID` y no hay movimiento: se puede reintentar. |
| Al completar | Reembolso `COMPLETED`, pago `REFUNDED`, un movimiento `REFUND`/`DEBIT` y la notificación `refund.completed`. Un reembolso `COMPLETED` no se reprocesa. |

### 11.6 Notificaciones

| Plantilla | Tipo | Cuándo |
| --- | --- | --- |
| `trip.cancelled` | Interna | Al cancelar el viaje, a cada pasajero afectado, dentro de la transacción. `{{refund_message}}` dice si hubo reembolso o no hubo cobro. |
| `trip.cancelled_email` | Correo | Al cancelar el viaje, tras confirmar la transacción. |
| `refund.completed` | Interna | Al completar el reembolso. |

### 11.7 Concurrencia validada

| Situación | Resultado |
| --- | --- |
| Dos cancelaciones del mismo viaje | Se serializan en el cerrojo del viaje; la segunda no hace nada. Un solo reembolso. |
| Cancelación y expiración de la misma reserva | Ambas bloquean primero el viaje; la reserva acaba `CANCELLED` o `EXPIRED`, con un solo aviso y los cupos liberados una vez. |
| Pago mientras se cancela | El pago encuentra el viaje cancelado y se rechaza. |
| Muchas cancelaciones a la vez | El alta del reembolso toma un cerrojo de hueco en `idx_refunds_payment` e InnoDB puede elegir víctima (`ER_LOCK_DEADLOCK`). La transacción se deshace entera y `withDeadlockRetry` la repite, hasta cinco veces con espera aleatoria. Lo mismo en cada transacción de la expiración. |
| Cierre de pagos pendientes | Se bloquean solo los pagos de la reserva (`cancelOpenPayments`). Un `UPDATE … WHERE booking_id = ? AND status …` usaba `index_merge` con el índice de estado y bloqueaba pagos de otras reservas. |

Cubierto por `49-trip-cancellation.test.ts` (38 tests), con escenarios de extremo a extremo para reserva pagada y
pendiente, webhook sobre viaje cancelado y cancelación y expiración concurrentes.

### 11.8 Deuda técnica

| Punto | Detalle |
| --- | --- |
| ~~Reembolso compensatorio sin venta registrada~~ | **Resuelto en 11E-2 (H-26).** El compensatorio ya no toca la contabilidad de la empresa: su cobro (`PAYMENT`/`CREDIT`) y su devolución (`REFUND`/`DEBIT`) se asientan en el libro de la plataforma, con `company_id` NULL, y el pago lleva la marca `compensation` en `payment_data`. Sin migración: `financial_transactions.company_id` ya admitía NULL. |
| ~~Aviso en la carrera tarjeta ↔ cancelación~~ | **Resuelto en 11F (H-29).** Con un cobro en vuelo (`PROCESSING`) o terminado en `TIMEOUT`, el aviso de cancelación ya no afirma que no hubo cobro: dice que el resultado aún no se puede confirmar. Si después se detecta el cargo, el compensatorio envía `booking.payment_compensated`, una vez por pago. |

---

## 12. `ON UPDATE RESTRICT` en tres claves ajenas (auditoría H-21)

**Estado: revisado — no requiere cambio.** De las 76 claves ajenas, 73 usan `ON UPDATE CASCADE` y tres `RESTRICT`:

| Tabla | FK | Columna → padre | ON DELETE | ON UPDATE | Origen |
| --- | --- | --- | --- | --- | --- |
| `trips` | `fk_trips_driver` | `driver_id` → `drivers.id` | SET NULL | RESTRICT | Migración `004` |
| `trips` | `fk_trips_co_driver` | `co_driver_id` → `drivers.id` | SET NULL | RESTRICT | Migración `004` |
| `bookings` | `fk_bookings_group` | `group_id` → `booking_groups.id` | SET NULL | RESTRICT | Migración `005` |

**Por qué son RESTRICT.** Las migraciones 004 y 005 (y sus propuestas en las secciones 4 y 8) declaran solo
`ON DELETE SET NULL`, que sí es una decisión explícita: borrar un conductor o un grupo nunca borra viajes ni reservas.
`ON UPDATE` no se escribió y MariaDB aplica su valor por defecto, `RESTRICT`. El dump original escribe
`ON UPDATE CASCADE` en sus 57 claves; de ahí la diferencia.

**Por qué se deja así.**

- Las tres columnas padre son `id` `AUTO_INCREMENT`. Ningún código, seed ni script las actualiza. `drivers` solo se escribe
  por `driver.repository.update`, cuya lista blanca y el validador Zod excluyen `id`. `booking_groups` no tiene ningún
  `UPDATE` ni API de edición: solo se inserta en `itinerary.service`.
- Mientras nadie cambie esos ids, `RESTRICT` y `CASCADE` se comportan igual. Si alguien lo intentara a mano, `RESTRICT`
  rechaza el cambio (error 1451) y deja intactos viajes y reservas; `CASCADE` reescribiría en silencio la tripulación de
  viajes ya realizados o el grupo de reservas ya pagadas. Para relaciones históricas es la opción más protectora.
- Comprobado en `busperu_test`, dentro de una transacción revertida: el `UPDATE` del id padre falla con 1451 sin tocar
  a los hijos, y el `DELETE` sigue dejando la referencia a `NULL`.

Cambiarlas a `CASCADE` solo daría uniformidad estética, así que no hay migración. Si algún día se unifican las 76
reglas, debería ser una decisión de conjunto, no un cambio de estas tres.

---

## Decisiones de mapeo de permisos

El esquema define 43 permisos en 13 módulos. Algunas pantallas de los mockups no tienen un módulo propio, por lo
que reutilizan el permiso más cercano en lugar de inventar permisos nuevos:

| Pantalla / recurso                      | Permiso utilizado                                     |
| --------------------------------------- | ----------------------------------------------------- |
| Tipos de bus, tipos de asiento           | `buses.*`                                             |
| Distribución del bus (versiones, pisos, elementos y asientos del editor) | `buses.view` / `buses.update` / `buses.delete` |
| Ciudades, terminales, paradas de ruta    | `routes.*`                                            |
| Reembolsos                               | `payments.view` / `payments.refund`                   |
| Liquidaciones, comisiones, finanzas      | `reports.view` (lectura) + `settings.update` (cambios) |
| Plantillas de notificación, API keys, configuración | `settings.view` / `settings.update`        |
| Notificaciones personales                | Solo sesión iniciada (cada usuario ve las suyas)      |
| Soporte                                  | Alcance por identidad: cliente ve las suyas, empresa las de su empresa, ADMIN todas |

### Restricciones añadidas tras la auditoría del Portal Empresa y el Panel Admin

Los permisos del dump son más amplios de lo que conviene en algunos puntos. En lugar de tocar
`role_permissions` (que es dato del cliente), las restricciones se aplican en la capa de rutas:

| Regla                                                        | Motivo                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `locations`, `bus_types`, `seat_types`: escritura solo ADMIN  | No tienen `company_id`; son datos maestros compartidos entre empresas   |
| `companies`: alta y baja solo ADMIN                           | `COMPANY_ADMIN` tiene `companies.create` en el dump, pero dar de alta empresas es una acción de plataforma |
| Roles asignables por un rol de empresa: `COMPANY_ADMIN` y `OPERATOR` | Evita que `users.create` permita crear un usuario con rol ADMIN |
| Un INSERT que queda fuera del alcance del autor se revierte    | Antes dejaba una fila huérfana y respondía 404                          |

### Pantallas del portal empresa que no usan el módulo `settings`

Ningún rol de empresa tiene `settings.view` ni `settings.update`, y abrirlos daría acceso a
`system_settings` y a las plantillas globales, que son de plataforma. Por eso:

- **`/company/settings`** muestra la ficha de la propia empresa (`companies.view` / `companies.update`),
  no la configuración del sistema.
- **`/company/notifications`** muestra la bandeja de avisos del propio usuario. El catálogo de plantillas
  y el envío masivo siguen siendo exclusivos de `/admin/notifications`.
