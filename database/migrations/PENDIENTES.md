# Extensiones de esquema requeridas por los mockups

`Dump20260831.sql` es la fuente de verdad de la base de datos y **no se ha modificado**. Los mockups muestran
funcionalidades que la estructura actual no soporta. Cada una se documenta aquí con la migración segura propuesta.

Cada sección declara su estado. Hay tres, y conviene no confundirlos:

| Estado | Significado |
| --- | --- |
| **Implementado** | La migración se aplicó y la funcionalidad está construida y probada. Secciones 1, 2, 3, 4, 5, 6 y 8 (migraciones `002`–`009`). |
| **Propuesto, sin ejecutar** | Ninguna sección queda en este estado. |
| **Decisión: no implementar** | Se evaluó y se decidió deliberadamente **no** construirlo. No es un pendiente. Sección 7. |

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

## Decisiones de mapeo de permisos

El esquema define 43 permisos en 13 módulos. Algunas pantallas de los mockups no tienen un módulo propio, por lo
que reutilizan el permiso más cercano en lugar de inventar permisos nuevos:

| Pantalla / recurso                      | Permiso utilizado                                     |
| --------------------------------------- | ----------------------------------------------------- |
| Tipos de bus, tipos de asiento, asientos | `buses.*`                                             |
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
