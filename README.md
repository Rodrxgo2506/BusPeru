# BusPerú

Plataforma full-stack de venta de pasajes de bus interprovincial en Perú, con tres portales: público/cliente,
Portal Empresa y panel administrativo.

| Capa | Stack |
| --- | --- |
| Frontend | React 18 · TypeScript · Vite · Tailwind CSS · Lucide React · React Router · Recharts |
| Backend | Node.js · Express · TypeScript · mysql2 · Zod · Helmet · rate limiting |
| Base de datos | MySQL / MariaDB (`Dump20260831.sql`, sin modificar) |
| Autenticación | JWT + bcrypt (`bcryptjs`) |
| Autorización | RBAC real sobre `roles` → `role_permissions` → `permissions` |

---

## 1. Requisitos

- **Node.js** 18 o superior (probado con 24.x)
- **MySQL 8** o **MariaDB 10.4+** (XAMPP funciona)
- **npm** 9 o superior

---

## 2. Instalación

```bash
# 1. Crear la base de datos e importar el esquema
mysql -u root -p < database/schema/Dump20260831.sql

# 2. Backend
cd backend
npm install
cp .env.example .env       # completa DB_PASSWORD y JWT_SECRET

# 3. Frontend
cd ../frontend
npm install
cp .env.example .env
```

En Windows con XAMPP, el cliente de MySQL suele estar en `C:\xampp\mysql\bin\mysql.exe`:

```bash
"C:\xampp\mysql\bin\mysql.exe" -u root -p < database/schema/Dump20260831.sql
```

### Variables de entorno

`backend/.env`

```
PORT=3000
NODE_ENV=development
DB_HOST=localhost
DB_PORT=3306
DB_NAME=busperu
DB_USER=root
DB_PASSWORD=          # tu contraseña local
JWT_SECRET=           # cadena aleatoria larga
JWT_EXPIRES_IN=8h
FRONTEND_URL=http://localhost:5173
BOOKING_EXPIRY_INTERVAL_MS=60000   # cada cuánto se expiran las reservas vencidas
STORAGE_DIR=storage               # almacén privado de documentos, fuera de cualquier carpeta pública

# OAuth. Vacío = proveedor desactivado (503 y sin botón en el frontend).
OAUTH_CALLBACK_BASE_URL=http://localhost:3000/api
OAUTH_STATE_TTL_SECONDS=600       # vida del state entre /start y /callback
OAUTH_TICKET_TTL_SECONDS=60       # vida del ticket entre /callback y /session
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT=common

# Cifrado de credenciales de integraciones (§5). 32 bytes. Sin ella, el módulo
# responde 503 y no guarda nada en texto plano. Independiente de JWT_SECRET.
# Generar con:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
INTEGRATIONS_ENCRYPTION_KEY=
```

El `redirect_uri` que hay que registrar en la consola de cada proveedor es
`<OAUTH_CALLBACK_BASE_URL>/auth/oauth/google/callback` (y el equivalente de `microsoft`).
`.env.example` documenta el resto de variables, incluidas las que permiten apuntar a un
proveedor de prueba en un entorno de integración y que **deben quedar vacías en producción**.

`frontend/.env`

```
VITE_API_URL=http://localhost:3000/api
```

Ningún secreto está escrito en el código y `.env` está en `.gitignore`.

---

## 3. Ejecución

```bash
# Terminal 1 — API en http://localhost:3000/api
cd backend && npm run dev

# Terminal 2 — App en http://localhost:5173
cd frontend && npm run dev
```

### Seed de desarrollo (opcional)

El dump llega con las tablas vacías salvo `roles`, `permissions` y `role_permissions`. El seed crea datos de prueba
sin borrar nada y evitando duplicados (puede ejecutarse varias veces):

```bash
cd backend && npm run seed
```

Crea: configuración del sistema, tipos de bus y de asiento, 10 terminales, 2 empresas, 3 buses con sus asientos,
4 rutas con paradas y viajes programados para los próximos 7 días, más estos usuarios (contraseña `BusPeru2026`):

| Correo | Rol |
| --- | --- |
| `admin@busperu.com` | ADMIN |
| `empresa@busperu.com` | COMPANY_ADMIN |
| `operador@busperu.com` | OPERATOR |
| `cliente@busperu.com` | CUSTOMER |

Las contraseñas se guardan hasheadas con bcrypt. El seed se niega a ejecutarse con `NODE_ENV=production`.

---

## 4. Arquitectura

```
Navegador
   ↓
React (páginas → hooks → services/api.ts)
   ↓ HTTP + JWT
Express Route → Middleware (auth, permisos, validación) → Controller → Service → Repository
   ↓
MySQL (mysql2/promise, pool + transacciones)
```

```
busperu/
├── backend/
│   └── src/
│       ├── config/         # env y pool de MySQL
│       ├── core/           # fábrica de routers CRUD con scoping por empresa
│       ├── middleware/     # auth, permisos, validación, errores
│       ├── repositories/   # acceso a datos
│       ├── routes/         # endpoints por módulo
│       ├── services/       # lógica de negocio (reservas, viajes, auditoría, auth)
│       ├── types/          # tipos espejo del esquema SQL
│       ├── utils/          # errores, paginación, seguridad, helpers HTTP
│       ├── validators/     # esquemas Zod
│       └── database/seed.ts
├── frontend/
│   └── src/
│       ├── components/     # ui/ (design system), common/, charts/
│       ├── constants/      # etiquetas ES de los ENUM y navegación por permisos
│       ├── context/        # AuthContext, ToastContext
│       ├── guards/         # ProtectedRoute, RoleRoute, PermissionRoute, GuestRoute
│       ├── hooks/          # useAsync, useList (búsqueda/filtros/paginación server-side)
│       ├── layouts/        # Public, Customer, Company, Admin
│       ├── pages/          # public/, auth/, customer/, company/, admin/, modules/
│       ├── routes/         # árbol de rutas con lazy loading
│       ├── services/       # cliente API centralizado + servicios por módulo
│       └── types/          # tipos espejo del esquema
└── database/
    ├── schema/Dump20260831.sql
    └── migrations/            # 002..006 aplicadas + PENDIENTES.md (extensiones que piden los mockups)
```

### Flujo de autenticación

1. `POST /api/auth/login` valida el correo y compara la contraseña con bcrypt.
2. Si es correcta, devuelve un JWT (`sub`, `roleId`, `role`) y el usuario con sus permisos.
3. El frontend guarda el token y lo envía en `Authorization: Bearer`.
4. `auth.middleware` verifica el token y **recarga desde la base de datos** el rol, los permisos y las empresas del
   usuario en cada request, de modo que un cambio de permisos surte efecto de inmediato.
5. Un 401 en cualquier respuesta limpia la sesión en el cliente.

`password_hash` nunca se selecciona fuera del repositorio de usuarios ni se devuelve al frontend.

### Recuperación de contraseña (mockup 10)

Tres pasos, con el código separado del cambio de contraseña para que no pueda reutilizarse:

| Paso | Endpoint | Qué hace |
| --- | --- | --- |
| 1 | `POST /auth/forgot-password` | Genera un código de 6 dígitos con `crypto.randomInt`, guarda solo `sha256(user_id:código:JWT_SECRET)` y lo envía por correo. Responde **siempre** el mismo mensaje, exista o no la cuenta. |
| 2 | `POST /auth/verify-reset-code` | Comprueba el código (expiración 15 min, máximo 5 intentos) y devuelve un **ticket** opaco de un solo uso. No emite JWT ni inicia sesión. |
| 3 | `POST /auth/reset-password` | Exige el ticket, no el código. Cambia `password_hash` con bcrypt y consume todas las solicitudes vivas del usuario. |
| — | `POST /auth/resend-reset-code` | Invalida el código anterior y envía uno nuevo, con un cooldown de 45 s por usuario. |

Los cuatro usan el `authLimiter` que ya protegía login y registro; no hay un segundo limitador.
El código nunca se guarda en claro, nunca viaja en la respuesta HTTP y solo aparece en consola
con el transporte de correo de desarrollo. La tabla `password_reset_tokens` (migración
[`002`](database/migrations/002-password-reset-tokens.sql)) es la única añadida al esquema.

### Envío de correo

`services/email.service.ts` aísla el envío del resto de la aplicación. El transporte se elige
con `MAIL_TRANSPORT`:

- **`log`** (por defecto en desarrollo) escribe el correo en consola y no envía nada. Está
  **bloqueado en producción**: si `NODE_ENV=production` y el transporte es `log`, el envío lanza.
- **`smtp`** usa nodemailer con `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_USER`,
  `MAIL_PASSWORD` y `MAIL_FROM`. Es el único válido en producción.
- **`memory`** retiene los mensajes en memoria; lo usa la suite de tests.

El texto del correo vive en `notification_templates` como plantilla de tipo `EMAIL`
(`auth.password_reset_code`), así que un administrador puede editarlo sin tocar código.

### Inicio de sesión con Google / Microsoft (mockups 8, 12 y 30)

> **Requiere credenciales del proveedor.** Sin `CLIENT_ID` y `CLIENT_SECRET` el proveedor queda desactivado: el
> backend responde 503 y el frontend **no pinta el botón**. Nunca se simula un inicio de sesión. El flujo está
> implementado y probado de extremo a extremo contra un proveedor local con criptografía real, pero **el login
> real contra Google o Microsoft no se ha podido verificar** porque el proyecto no tiene credenciales.

Se añadieron a `users` las columnas `oauth_provider` y `oauth_id` con su clave única compuesta
(migración [`007`](database/migrations/007-users-oauth.sql)). No se creó ninguna tabla.

**Flujo Authorization Code + PKCE.** El `client_secret` nunca sale del servidor y el `id_token` nunca pasa por el
navegador:

| Paso | Endpoint | Qué hace |
| --- | --- | --- |
| 1 | `GET /auth/oauth/:provider/start?scope=` | Genera `state`, `nonce` y el par PKCE, los guarda del lado del servidor y redirige al proveedor. |
| 2 | `GET /auth/oauth/:provider/callback` | Canjea el código con el secreto, **verifica el `id_token`** y redirige al frontend con un ticket. |
| 3 | `POST /auth/oauth/session` | Canjea el ticket por el JWT de siempre. |
| — | `GET /auth/oauth/providers` | Qué proveedores están configurados. El frontend no ofrece los que no lo estén. |
| — | `POST /auth/oauth/:provider/link` | Inicia la vinculación desde el perfil. **Autenticado.** |
| — | `GET`/`DELETE /auth/oauth/link` | Consulta y elimina la vinculación de la cuenta autenticada. |

**Qué se verifica del `id_token`**, antes de mirar la base de datos: algoritmo `RS256` —nunca el `alg` que diga el
token, para cerrar la confusión de algoritmo y el `alg: none`—, firma contra el JWKS del proveedor (con recarga si
el `kid` rotó), emisor, audiencia igual al `client_id`, vigencia y `nonce` de esa misma petición. En Microsoft el
emisor se resuelve sustituyendo el marcador de tenant con el claim `tid`, como documenta el propio proveedor.

**La identidad nunca procede del cliente.** Ni el correo, ni el rol, ni el `user_id`, ni la empresa: todo sale del
token firmado o se resuelve en el servidor. El `scope` que envía el navegador es el único dato que se acepta, y
**solo puede restringir**.

**Reglas de cuenta**, decididas explícitamente porque §2 no las cubría:

- **Correo desconocido:** el flujo de cliente crea una cuenta `CUSTOMER` / `ACTIVE`; Portal Empresa y Panel Admin
  la rechazan, porque ahí las cuentas se aprovisionan a mano.
- **Correo ya registrado con contraseña:** se **rechaza**, no se fusiona — ni siquiera con `email_verified`. La
  vinculación se hace desde el perfil, ya autenticado, donde la prueba de identidad es la propia sesión.
- **Una cuenta, un proveedor:** las columnas viven en `users`, así que añadir un segundo devuelve `already_linked`.
- **Estados:** `SUSPENDED`, `INACTIVE` y `PENDING` no entran, con la misma función que usa el login con
  contraseña. OAuth no es una puerta trasera.

**La sesión es la de siempre.** Se emite el mismo JWT, con la misma expiración, y el middleware sigue releyendo
rol, permisos y empresas desde la base en cada petición. No se creó ningún permiso ni se tocó ninguno: una cuenta
nacida de OAuth es `CUSTOMER` y no pertenece a ninguna empresa.

El callback **no devuelve el JWT en la URL**: entrega un ticket opaco de 32 bytes, de un solo uso y 60 segundos de
vida.

**El estado del flujo es persistente**, en la tabla `oauth_flows`
(migración [`008`](database/migrations/008-oauth-flows.sql)). No hay nada en memoria del proceso, así que el
despliegue admite **reinicios, varias instancias y balanceador**: `/start`, `/callback` y `/session` pueden
atenderlos servidores distintos, y un reinicio no invalida un flujo a medio completar.

| | |
| --- | --- |
| Se guarda | `state_hash` = `sha256(state:state:JWT_SECRET)` y `ticket_hash` = `sha256(ticket:ticket:JWT_SECRET)`, más proveedor, `scope`, `mode`, `user_id`, caducidades y marcas de consumo. |
| **No** se guarda | El `state` ni el `ticket` en claro · el `nonce` ni el `code_verifier` · ningún token del proveedor · el `client_secret` · el JWT · IP ni user-agent. |
| `nonce` y `code_verifier` | Se **derivan** del `state` y del secreto (`sha256(state:nonce:JWT_SECRET)` y `sha256(state:pkce:JWT_SECRET)`), así que no existe ningún secreto en reposo. La derivación es determinista: la instancia que atiende el callback obtiene los mismos valores que la que atendió el `/start`. El verificador cumple el RFC 7636 y el challenge sigue siendo S256. |
| Un solo uso | Cada consumo es un `UPDATE` condicional único. De dos callbacks —o dos canjes— simultáneos con el mismo valor, solo uno gana; el otro recibe `invalid_state` o 401. Lo arbitra la base, así que funciona también entre instancias distintas. |
| TTL | `state` 600 s, `ticket` 60 s. Configurables con `OAUTH_STATE_TTL_SECONDS` y `OAUTH_TICKET_TTL_SECONDS`. |
| Limpieza | `DELETE ... WHERE expires_at < NOW() - 1 HORA LIMIT 500`, por índice, desde el planificador que ya expira reservas. Sin procesos nuevos y sin barridos durante las peticiones. |

### Datos bancarios de la empresa (mockup 36)

Cada empresa registra las cuentas donde quiere recibir sus liquidaciones. Viven en su propia tabla
`company_bank_accounts` (migración [`003`](database/migrations/003-company-bank-accounts.sql)), no dentro de
`companies`, porque el mockup contempla una cuenta principal más cuentas adicionales.

| Endpoint | Permiso | Qué hace |
| --- | --- | --- |
| `GET /company/bank-accounts` | `companies.view` | Cuentas de la empresa del usuario. El ADMIN puede indicar `?company_id=`. |
| `POST /company/bank-accounts` | `companies.update` | Registra una cuenta. La primera queda como principal. |
| `PUT /company/bank-accounts/:id` | `companies.update` | Edita una cuenta propia. |
| `DELETE /company/bank-accounts/:id` | `companies.update` | Elimina una cuenta; si era la principal, asciende la más antigua. |
| `GET /company/bank-accounts/history` | `companies.view` | Historial de cambios de las cuentas de esa empresa, leído de `audit_logs` sin exigir `audit_logs.view`. |

No se creó ningún permiso: `companies.view` y `companies.update` ya existían. OPERATOR mantiene sus permisos, así
que puede consultar pero no modificar. El permiso por sí solo no basta: el servicio exige además pertenecer a una
empresa, de modo que un CUSTOMER (que tiene `companies.view` para el listado público) recibe 403.

**El `company_id` nunca se acepta del cliente.** Se resuelve desde `company_users` del usuario autenticado y no
figura entre las columnas escribibles, así que enviarlo en el cuerpo o en la query no cambia nada.

**Datos sensibles:** el número de cuenta y el CCI solo se devuelven completos a quien puede editarlos
(`companies.update`); el resto recibe únicamente la versión enmascarada `XXXX XXXX 1234`. La auditoría registra
quién, cuándo y sobre qué cuenta, pero `account_number` e `interbank_code` están en las claves que
`audit.service.ts` redacta, así que el número completo nunca llega a `audit_logs`.

### Conductor y copiloto del viaje (mockup 31)

Cada empresa mantiene su plantilla de personal de conducción en `drivers` (migración
[`004`](database/migrations/004-drivers.sql)), y cada viaje puede referenciar a un conductor y a un copiloto.
Los conductores **no son usuarios de BusPerú**: son personal de la empresa, sin acceso al sistema.

| Endpoint | Permiso | Qué hace |
| --- | --- | --- |
| `GET /company/drivers` | `buses.view` | Plantilla de la empresa. Admite `?status=` y `?search=`. |
| `GET /company/drivers/:id` | `buses.view` | Ficha de un conductor propio. |
| `POST /company/drivers` | `buses.create` | Registra personal. |
| `PUT /company/drivers/:id` | `buses.update` | Edita o cambia el estado. |
| `DELETE /company/drivers/:id` | `buses.delete` | Da de baja al personal sin viajes pendientes. |
| `PUT /trips/:id` | `trips.update` | Asigna o retira `driver_id` y `co_driver_id`. |

Se reutiliza el mismo mapeo de permisos que ya usaban asientos y tipos de bus; **no se creó ninguno nuevo**.
OPERATOR mantiene sus permisos exactos: consulta la plantilla y asigna tripulación (ya tenía `trips.update`),
pero no puede dar de alta ni editar personal.

**Reglas de asignación**, todas comprobadas en el backend:

- La tripulación se valida contra la empresa **de la ruta del viaje**, no contra el rol de quien edita: ni un
  ADMIN puede poner un conductor de una empresa en el viaje de otra.
- Conductor y copiloto no pueden ser la misma persona. Se evalúa la combinación **resultante**, así que asignar
  como copiloto a quien ya figura como conductor también se rechaza.
- El personal `INACTIVE` no puede asignarse.
- No se puede desactivar ni eliminar a quien tenga viajes futuros sin cancelar.
- La FK usa `ON DELETE SET NULL`: borrar a un conductor deja el viaje sin tripulación, nunca borra el viaje.

El `document_number` es único en toda la tabla (así lo define la migración). Si el documento ya existe la API
responde 409 con un mensaje neutro, para no revelar en qué otra empresa está registrada esa persona.

### Integraciones por empresa (mockup 37)

> **Alcance: configuración, no operación.** Conectar una integración guarda sus credenciales cifradas; **no activa
> ningún cobro, webhook ni llamada a un proveedor externo**. `status` significa «configurado», no «operativo», y la
> pantalla lo advierte de forma permanente. El procesamiento real es una fase posterior y separada.

Cada empresa configura sus integraciones en `company_integrations`
(migración [`009`](database/migrations/009-company-integrations.sql)). El catálogo son los siete proveedores del
mockup 37: Izipay, Niubiz, Culqi y PayPal (pasarelas), Google Analytics, Google Maps y WhatsApp Business.

| Endpoint | Permiso | Qué hace |
| --- | --- | --- |
| `GET /company/integrations` | `companies.view` | Catálogo con el estado de cada proveedor |
| `GET /company/integrations/:provider` | `companies.view` | Detalle, sin credenciales descifradas |
| `PUT /company/integrations/:provider` | `companies.update` | Guarda la configuración |
| `POST /company/integrations/:provider/connect` | `companies.update` | Marca como conectada, si no falta ningún campo |
| `POST /company/integrations/:provider/disconnect` | `companies.update` | Desconecta y **borra las credenciales** |
| `DELETE /company/integrations/:provider` | `companies.update` | Elimina la configuración |
| `…/admin/integrations/…` | `companies.update` + rol ADMIN | Lo mismo para la integración de **plataforma** |

Ningún permiso nuevo. OPERATOR conserva los suyos: consulta el estado, pero no modifica nada y tampoco ve
credenciales. Un CUSTOMER recibe 403 por no pertenecer a ninguna empresa.

**Cifrado en reposo.** Las credenciales se guardan con **AES-256-GCM** y la clave vive en
`INTEGRATIONS_ENCRYPTION_KEY`, independiente de `JWT_SECRET`. Se eligió cifrado autenticado para que una fila
manipulada falle al descifrar en lugar de devolver basura. El sobre almacenado es JSON válido —lo exige el
`CHECK (json_valid(...))` de la tabla— con la forma `{"v":1,"alg":"AES-256-GCM","iv":…,"tag":…,"data":…}`, y cada
escritura usa un IV nuevo. **Sin clave configurada el módulo responde 503 y no guarda nada en texto plano.**

**Las credenciales son de solo escritura.** La API nunca las devuelve descifradas, ni siquiera a quien puede
editarlas: publica qué campos están configurados y sus **cuatro últimos caracteres** (`•••• 5678`), lo justo para
distinguir una llave de pruebas de una de producción. Al desconectar una integración, sus credenciales se borran.

**Modelo agregador.** Un solo comercio, de BusPerú: el dinero entra a la plataforma, que retiene su comisión y
liquida el neto a la empresa. La pantalla por empresa **no** implica que cada empresa tenga su propio comercio —
`company_id = NULL` representa la integración de plataforma y **solo el ADMIN** puede gestionarla o verla. La clave
única de la tabla no bastaba para protegerla (los `NULL` no colisionan en un índice único), así que se añadió la
columna generada `company_scope`.

### Documentos de verificación de empresa (mockups 13 y 14)

Cada empresa sube su documentación legal (ficha RUC, licencia de operación, póliza de seguro, documento del
representante legal y otros) y el ADMIN de la plataforma la verifica o la rechaza. Vive en `company_documents`
(migración [`006`](database/migrations/006-company-documents.sql)).

| Endpoint | Permiso | Qué hace |
| --- | --- | --- |
| `GET /company/documents` | `companies.view` | Documentos de la empresa del usuario. El ADMIN puede indicar `?company_id=`. |
| `GET /company/documents/verification-status` | `companies.view` | Línea de tiempo de verificación del mockup 14. |
| `GET /company/documents/pending-review` | `companies.update` + rol ADMIN | Bandeja de todo lo pendiente de revisar. |
| `GET /company/documents/:id` | `companies.view` | Ficha de un documento propio. |
| `GET /company/documents/:id/file` | `companies.view` | Descarga el archivo. Única forma de obtenerlo. |
| `POST /company/documents` | `companies.update` | Sube o **reemplaza** el documento de ese tipo. |
| `DELETE /company/documents/:id` | `companies.update` | Elimina un documento que aún no esté verificado. |
| `PUT /company/documents/:id/review` | `companies.update` + rol ADMIN | Verifica o rechaza indicando el motivo. |

No se creó ningún permiso. La revisión exige `companies.update` **y además rol ADMIN**: un COMPANY_ADMIN también
tiene ese permiso y no puede aprobarse sus propios documentos. OPERATOR mantiene sus permisos exactos —consulta,
pero no sube ni elimina—, y un CUSTOMER recibe 403 por no pertenecer a ninguna empresa.

**Ciclo de vida.** Un documento **siempre nace `PENDING`**; ni `status`, ni `reviewed_by`, ni `reviewed_at`, ni
`file_url` son campos que el cliente pueda enviar. Subir un documento del mismo tipo **reemplaza** el anterior
(borrando su archivo), lo devuelve a `PENDING` y limpia la revisión previa, así que el ciclo rechazo → corrección
→ nueva revisión no duplica filas. Un documento ya `VERIFIED` no puede eliminarse desde la empresa.

**Los archivos no son públicos.** Se guardan en `backend/storage/` —fuera del frontend, fuera del repositorio— con
un nombre aleatorio de 16 bytes y permisos `0600`; `file_url` es una referencia interna relativa que **la API nunca
devuelve** (publica `has_file` en su lugar). La descarga va con `Content-Disposition: attachment` y
`X-Content-Type-Options: nosniff`, de modo que el navegador jamás interpreta el contenido.

**Validación de la subida**, en este orden y antes de tocar la base: tamaño (máximo 5 MB), extensión —solo la
última, así que `x.pdf.exe` se lee como `.exe`—, MIME declarado y **bytes mágicos** del contenido. Solo PDF, JPG y
PNG. Un ejecutable renombrado a `.pdf` se rechaza. El nombre que envía el usuario no se usa nunca para construir
la ruta, así que `../../../etc/passwd.pdf` no escapa del almacén. Si la base falla después de escribir el archivo,
este se borra para no dejarlo huérfano.

**Al resolver la revisión** se notifica a los COMPANY_ADMIN de la empresa con el sistema de notificaciones
existente (`company.document_verified` / `company.document_rejected`), y `audit_logs` registra `CREATE`, `UPDATE`,
`DELETE`, `APPROVE` y `REJECT` con usuario, empresa y tipo de documento — nunca la referencia del archivo.

Verificar documentos **no cambia `companies.status`**: aprobar la empresa sigue siendo una acción aparte. La línea
de tiempo del mockup 14 se **deriva** de `companies.status` y del recuento de documentos por estado; no se
almacenan etapas.

### Ida y vuelta y multidestino (mockup 1)

El buscador ofrece tres modalidades. **Ida no cambió**: mismo endpoint, misma URL de resultados y mismo flujo de
compra que antes. Las otras dos se apoyan en una tabla de agrupación
(migración [`005`](database/migrations/005-booking-groups.sql)):

```
booking_groups            una compra (IT-123456)
  └── bookings            un tramo cada una, con segment_order
        └── booking_seats los asientos de ESE tramo, con su propio trip_id
```

Cada tramo es una reserva normal. Esa es la clave: una compra de ida simple no crea grupo (`group_id` a `NULL`) y
todo lo que cuelga de `bookings` —pagos, reembolsos, reseñas, comisiones, liquidaciones— sigue funcionando sin
cambios. Además permite que la ida y la vuelta sean **de empresas distintas**, cada una con su propio cobro.

| Endpoint | Qué hace |
| --- | --- |
| `GET /public/trips` | Búsqueda de ida. Sin cambios. |
| `POST /public/itineraries/search` | Busca los viajes de cada tramo y los devuelve agrupados. Público. |
| `POST /bookings` | Compra de ida. Sin cambios. |
| `POST /bookings/itineraries` | Crea todas las reservas de la compra en **una** transacción. |
| `GET /bookings/itineraries/:id` | Itinerario completo, acotado a su dueño. |
| `POST /bookings/itineraries/:id/pay` | Confirma el pago de todos los tramos. |

**Transaccionalidad:** si cualquier tramo falla —asiento tomado, viaje partido, cupón inválido— el `ROLLBACK`
deshace también los tramos ya creados. Nunca queda una compra a medias ni un grupo huérfano. Lo mismo vale al
pagar: `payItinerary` confirma los N tramos en **una sola transacción**, así que un fallo en el tercero revierte
los dos primeros (estados, pagos, movimientos financieros y notificaciones).

**Un pago por tramo, ninguno de grupo.** `payments.booking_id` sigue siendo `NOT NULL` y no existe
`payments.group_id`. La razón es la atribución financiera: se deriva de `payment → booking → trip → route →
company_id`, y una compra puede combinar **tramos de empresas distintas**. Con un pago único por compra, ni el
módulo Pagos del Portal Empresa ni las comisiones ni las liquidaciones podrían repartirlo. Cuando se integre una
pasarela, un único cargo externo podrá registrarse en los N pagos compartiendo `provider_transaction_id`.

**Asientos:** la disponibilidad se evalúa por `trip_id` + `seat_id`, así que elegir el asiento 5 en la ida no
bloquea el 5 de la vuelta. Los `SELECT ... FOR UPDATE` que protegen contra la doble reserva son los mismos de
antes: el cuerpo de `createBooking` se extrajo a `createBookingOnConnection` para poder reutilizarlo por tramo
dentro de una única transacción, sin tocar su lógica.

**Validaciones (backend y frontend):** origen distinto del destino en cada tramo, fechas que existan de verdad,
orden cronológico entre tramos —la vuelta no puede ser anterior a la ida—, exactamente dos tramos en un ida y
vuelta, un máximo de cinco, y ningún viaje repetido.

### Flujo de permisos

`requirePermission('buses.create')` consulta los permisos reales del usuario, obtenidos de
`roles → role_permissions → permissions`. No existe ningún atajo del tipo `if (role === 'ADMIN')`: ADMIN pasa las
comprobaciones porque el dump le asigna los 43 permisos.

El sidebar se construye con los mismos permisos, pero **ocultar en el frontend no es seguridad**: cada endpoint
vuelve a comprobarlo en el backend.

### Aislamiento multiempresa

- `COMPANY_ADMIN` y `OPERATOR` solo ven filas cuya empresa esté en `company_users` para su usuario.
- El alcance se resuelve en SQL a partir del usuario autenticado (`companyScopeExpression`), nunca con un filtro
  enviado por el cliente.
- Al crear o actualizar, la empresa del registro se fuerza a una de las del usuario.
- `CUSTOMER` solo accede a sus propias reservas, pagos, reseñas, notificaciones y tickets.

Tres tablas maestras (`locations`, `bus_types`, `seat_types`) no tienen `company_id`: las comparten todas las
empresas. Se leen con el permiso del módulo (`routes.view` / `buses.view`) pero **solo el ADMIN de la plataforma
puede escribirlas** (`adminOnlyActions` en `core/resource.ts`); si no, un `COMPANY_ADMIN` con `routes.delete` podría
borrar una terminal que usan las demás empresas. Por el mismo motivo el alta y la baja de empresas son exclusivas
del ADMIN, mientras que editar la ficha propia sigue disponible para su `COMPANY_ADMIN`.

Al crear o editar usuarios, un rol de empresa solo puede asignar `COMPANY_ADMIN` u `OPERATOR`. Sin esa comprobación
un `COMPANY_ADMIN` con `users.create` podía darse de alta un usuario con rol ADMIN y escalar a la plataforma.

### Notificaciones automáticas

El sistema genera notificaciones en `notifications` usando las plantillas de
`notification_templates` (no se crearon tablas). Eventos cubiertos:

| Evento | Plantilla | Cuándo |
| --- | --- | --- |
| Reserva creada | `booking.created` | Al crear la reserva (PENDING) |
| Pago confirmado | `booking.payment_confirmed` | Al confirmarse el pago |
| Reserva cancelada | `booking.cancelled` | Al cancelar |
| Reserva expirada | `booking.expired` | Al vencer `expires_at` |
| Reembolso procesado | `refund.completed` | Al completarse el reembolso |

- Las plantillas se crean solas al arrancar (`ensureSystemTemplates`) si no existen; **nunca
  se sobrescriben** si el administrador las edita, y el cuerpo admite variables `{{variable}}`.
- Cada notificación guarda una `event_key` única en `notifications.data`
  (p. ej. `booking.created:42`) y **no se inserta si ya existe**: pagar tres veces o
  reejecutar la expiración no duplica avisos.
- La notificación se inserta **dentro de la misma transacción** que la operación: si la
  reserva o el pago se revierten, el aviso tampoco queda.

### Expiración automática de reservas

Las reservas `PENDING` retienen los asientos durante `booking.hold_minutes` (15 por defecto).
Al vencer `expires_at`, un planificador en proceso (`BOOKING_EXPIRY_INTERVAL_MS`, 60 s por
defecto) las procesa una a una, cada una en su propia transacción:

1. Bloquea la reserva con `FOR UPDATE` y **revalida** que siga `PENDING` y vencida.
2. La marca como `EXPIRED`.
3. Cancela los pagos que siguieran `PENDING`/`PROCESSING`.
4. Restaura `trips.available_seats` sin superar la capacidad del bus.
5. Notifica al pasajero.

Los `booking_seats` **no se borran**: la disponibilidad se deriva del estado de la reserva
(una `EXPIRED` deja de retener el asiento), de modo que el asiento vuelve a venderse y se
conserva el rastro de qué se había reservado.

También puede forzarse con `POST /api/bookings/expire` (requiere `bookings.cancel`), que es
idempotente y solo afecta a reservas ya vencidas.

### Transacciones

Se usan transacciones MySQL donde una operación toca varias tablas:

- **Crear reserva:** bloquea los asientos con `SELECT ... FOR UPDATE`, valida disponibilidad, aplica el cupón, inserta
  `bookings` + `booking_seats` + `coupon_usages` + `payments` y ajusta `trips.available_seats`.
- **Confirmar pago:** marca `payments` como pagado, confirma la reserva y registra las transacciones financieras de
  pago y comisión.
- **Procesar reembolso:** actualiza `refunds`, `payments` y registra la transacción negativa.
- **Generar liquidación:** crea `settlements` y sus `settlement_items` a partir de las transacciones del periodo.
- **Registro de empresa:** crea `companies` + `users` + `company_users`.
- **Permisos de rol:** reemplaza `role_permissions` en bloque.

---

## 5. API REST

Formato de respuesta uniforme:

```jsonc
// éxito
{ "success": true, "data": { } }

// lista
{ "success": true, "data": [], "pagination": { "page": 1, "limit": 20, "total": 100, "totalPages": 5 } }

// error
{ "success": false, "message": "...", "errors": { "campo": "mensaje" } }
```

Todos los listados aceptan `page`, `limit`, `search`, `sort`, `order` y filtros por columna.

| Grupo | Endpoints |
| --- | --- |
| Auth | `POST /api/auth/login` · `POST /api/auth/register` · `POST /api/auth/register/company` · `GET /api/auth/me` · `PUT /api/auth/me` · `PUT /api/auth/me/password` · `POST /api/auth/logout` |
| Público | `GET /api/public/cities` · `/terminals` · `/companies` · `/trips` · `/trips/:id` · `/trips/:id/seats` · `/destinations` · `/promotions` · `/reviews` · `/settings` · `/stats` |
| Usuarios y roles | `/api/users` · `/api/users/stats` · `/api/roles` · `/api/roles/:id/permissions` · `/api/permissions` |
| Catálogos | `/api/companies` · `/api/buses` · `/api/bus-types` · `/api/seats` · `/api/seat-types` · `/api/locations` · `/api/routes` · `/api/route-stops` |
| Operación | `/api/trips` · `/api/trips/:id/seats` · `/api/trips/:id/passengers` · `/api/trips/:id/cancel` |
| Ventas | `/api/bookings` · `/api/bookings/:id/pay` · `/api/bookings/:id/cancel` · `/api/payments` · `/api/payments/summary` · `/api/refunds` · `/api/refunds/:id/process` |
| Marketing | `/api/promotions` · `/api/coupons` · `/api/reviews` · `/api/reviews/:id/responses` |
| Comunicación | `/api/notifications` · `/api/notifications/send` · `/api/notification-templates` · `/api/support/tickets` · `/api/support/tickets/:id/messages` |
| Finanzas | `/api/financial-transactions` · `/api/settlements` · `/api/commissions` · `/api/reports/:report` |
| Sistema | `/api/audit-logs` · `/api/api-keys` · `/api/system-settings` · `/api/dashboard/{admin,company,customer}` |

---

## 6. Rutas del frontend

**Públicas:** `/` · `/buscar` · `/destinos` · `/empresas` · `/ofertas` · `/ayuda` · `/login` · `/registro` ·
`/recuperar-contrasena` (flujo de 3 pasos) · `/empresa/login` · `/empresa/registro` · `/admin/login`

**Compra:** `/viaje/:tripId/asientos` → `/reserva/pasajeros` → `/reserva/pago` → `/reserva/confirmacion/:bookingId`

**Compra de varios tramos:** `/buscar?type=ROUND_TRIP|MULTI_CITY` → `/viaje/:tripId/asientos?segment=N` (uno por
tramo) → `/reserva/pasajeros` → `/reserva/pago` → `/reserva/confirmacion/itinerario/:groupId`

**Cliente:** `/customer/trips` · `/customer/bookings/:id` · `/customer/notifications` · `/customer/support` ·
`/customer/profile`

**Empresa:** `/company/dashboard` · `buses` · `buses/:id/asientos` · `routes` · `terminals` · `trips` · `bookings` ·
`drivers` · `passengers` · `payments` · `refunds` · `settlements` · `reports` · `promotions` · `reviews` · `bank-accounts` ·
`documents` · `users` ·
`notifications` · `support` · `settings`

`terminals` es de solo lectura para la empresa (catálogo global). `notifications` es su propia bandeja de avisos y
`settings` es la ficha de su empresa: la configuración global del sistema y las plantillas de notificación viven
únicamente en el panel de administración.

**Administración:** `/admin/dashboard` · `users` · `roles` · `companies` · `company-documents` · `buses` · `bus-types` · `seat-types` ·
`locations` · `routes` · `trips` · `bookings` · `payments` · `refunds` · `commissions` · `settlements` · `financial` ·
`reports` · `promotions` · `coupons` · `reviews` · `notifications` · `support` · `audit` · `api-keys` · `settings`

---

## 7. Seguridad

- bcrypt para contraseñas; `password_hash` nunca sale del repositorio.
- JWT firmado con `JWT_SECRET` (obligatorio, sin valor por defecto).
- Consultas preparadas en todo el acceso a datos. Los nombres de columna de `sort` y filtros pasan por una lista
  blanca (`safeColumn`), nunca se concatenan desde la request.
- Helmet, CORS restringido a `FRONTEND_URL`, rate limiting global y más estricto en `/api/auth`.
- Validación con Zod en el backend (seguridad) además de la validación en formularios (UX).
- Los errores de MySQL se traducen a mensajes amigables; nunca se devuelven stack traces.
- Las API keys se guardan hasheadas: la llave completa se muestra una sola vez al crearla.
- La auditoría redacta contraseñas, tokens y hashes antes de guardar.
- El rol y los permisos se recargan de la base en cada petición: manipular los *claims* del JWT no sirve de nada.
- Un recurso de otra empresa responde **404, no 403**, para no confirmar su existencia ni permitir enumerarla.
- Los nombres de columna que se interpolan en SQL (`sort`, columnas de escritura, perfil propio) salen siempre de
  una lista blanca del servidor, nunca de las claves del cuerpo de la petición.

---

## 8. Tests automatizados

```bash
cd backend
npm test              # suite completa
npm run test:coverage # suite + informe de cobertura
```

**La suite nunca toca tu base real.** Antes de ejecutarse recrea `busperu_test` desde
`database/schema/Dump20260831.sql` y trabaja solo ahí:

- `src/test/helpers/testEnv.ts` fija `DB_NAME=busperu_test` **antes** de que la aplicación
  lea la configuración.
- `src/test/helpers/database.ts` aborta si el nombre de la base no termina en `_test`, de
  modo que un error de configuración no puede destruir datos reales.
- Cada archivo de test vacía los datos operativos de la base de pruebas y vuelve a sembrar
  fixtures deterministas (dos empresas con flota propia y un usuario por rol), así que los
  tests no dependen del orden ni del resultado de los anteriores.
- La app se levanta en un puerto efímero dentro del propio proceso: no hace falta tener el
  servidor arrancado.

| Archivo | Cubre |
| --- | --- |
| `01-auth.test.ts` | Login, tokens, endpoints protegidos y públicos, registro y aprobación de empresa |
| `02-rbac.test.ts` | Matriz de permisos por rol, acciones sensibles, cambio de permisos en caliente |
| `03-tenancy.test.ts` | Aislamiento multiempresa en lectura, escritura y acceso por id |
| `04-crud.test.ts` | Ciclo CRUD, validaciones, restricciones de la base, paginación e inyección SQL |
| `05-booking.test.ts` | Reservas, importes, retención y **concurrencia de asientos** |
| `06-payment.test.ts` | Pagos, idempotencia, reembolsos y cupones |
| `07-settlement.test.ts` | Liquidaciones, transacciones financieras, reportes y paneles |
| `08-review.test.ts` | Moderación de reseñas y aislamiento entre empresas |
| `09-notification-expiry.test.ts` | Notificaciones automáticas y expiración de reservas |
| `10-privileges.test.ts` | Roles asignables, catálogos globales, alta de empresas, paradas de ruta, superficie de información y perfil propio |
| `11-password-reset.test.ts` | Recuperación de contraseña: código, intentos, expiración, ticket de un solo uso, reenvío y seguridad |
| `12-bank-accounts.test.ts` | Datos bancarios: CRUD, cuenta principal, aislamiento multiempresa, permisos, validaciones, auditoría e historial |
| `13-drivers.test.ts` | Conductor y copiloto: CRUD, asignación al viaje, reglas de tripulación, aislamiento, permisos y auditoría |
| `14-itineraries.test.ts` | Ida y vuelta y multidestino: búsqueda, compra agrupada, rollback, concurrencia y regresión de la ida simple |
| `15-itinerary-payment.test.ts` | Atomicidad del pago del itinerario: confirmación completa, rollback por tramo, idempotencia y atribución por empresa |
| `16-company-documents.test.ts` | Documentos de verificación: subida y reemplazo, revisión ADMIN, línea de tiempo, aislamiento multiempresa, seguridad de archivos y auditoría |
| `17-oauth.test.ts` | Google y Microsoft: flujo completo con PKCE, verificación del `id_token`, alta y vinculación, estados de cuenta, RBAC, aislamiento, **persistencia del flujo contra una segunda instancia real**, consumo atómico concurrente, caducidad y purga, y regresión del login con contraseña |
| `18-company-integrations.test.ts` | Integraciones: catálogo, cifrado AES-256-GCM y detección de manipulación, enmascarado, conectar/desconectar, aislamiento multiempresa, integración de plataforma, permisos y auditoría |

## 9. Scripts

**Backend**

```bash
npm run dev        # desarrollo con recarga
npm run build      # compilar a dist/
npm run start      # ejecutar el build
npm run typecheck  # verificación de tipos
npm run seed       # datos de desarrollo
npm test           # suite de tests (base busperu_test)
```

Para iterar sobre un solo archivo de la suite, `npm test -- --filter=<parte del nombre>`;
por ejemplo `npm test -- --filter=17-oauth`. La sonda de seguridad de OAuth se ejecuta
aparte con `npx tsx src/test/helpers/oauthProbe.ts`: imprime un informe de cada intento de
abuso y se niega a arrancar si la base no termina en `_test`.

**Frontend**

```bash
npm run dev        # servidor de desarrollo
npm run build      # build de producción
npm run preview    # previsualizar el build
npm run typecheck  # verificación de tipos
```

---

## 10. Decisiones documentadas

Las funcionalidades que aparecen en los mockups pero **no tienen soporte en el esquema actual** están documentadas
en [`database/migrations/PENDIENTES.md`](database/migrations/PENDIENTES.md), con la migración segura propuesta para
cada una. No se ha modificado la base de datos ni se han inventado columnas.

Ese documento distingue tres estados, y conviene no confundirlos:

- **Implementadas**, con su migración aplicada: recuperación de contraseña por código (`002`), datos bancarios de
  empresa (`003`), conductor y copiloto del viaje (`004`), ida y vuelta / multidestino (`005`), documentos de
  verificación de empresa (`006`), inicio de sesión con Google/Microsoft (`007` y `008`) e integraciones por empresa
  (`009`). El login con proveedor queda **desactivado hasta que se configuren credenciales**, y su funcionamiento
  real está pendiente de verificar; las integraciones **guardan configuración pero no procesan operaciones**.
- **Propuestas, sin ejecutar**: ninguna. Todas las secciones con migración propuesta están aplicadas.
- **Decisión de no implementar**: los puntos de fidelidad del mockup 11. No es un pendiente pospuesto. El mockup
  aporta un número de maqueta y un texto, no un programa: la tasa de acumulación, el momento de acreditación, el
  valor de canje, el efecto de un reembolso y la caducidad tendrían que inventarse por completo. En su lugar, el
  resumen de la cuenta usa solo datos reales y derivables (viajes realizados, gasto total, estado, fechas), y el
  campo "Puntos acumulados" se muestra en su posición exacta del mockup marcado como *No disponible*. Es la misma
  regla aplicada al documento de identidad, la fecha de nacimiento y las preferencias de viaje: **posición fiel al
  mockup, dato jamás inventado.**

Ese mismo documento incluye el mapeo de pantallas a los 43 permisos reales del dump.

---

## 11. Solución de problemas

| Síntoma | Causa probable | Solución |
| --- | --- | --- |
| `No se pudo conectar a MySQL` al iniciar el backend | Credenciales o servicio | Verifica que MySQL/MariaDB esté corriendo y revisa `DB_*` en `backend/.env` |
| `Falta la variable de entorno obligatoria: JWT_SECRET` | `.env` incompleto | Define `JWT_SECRET` con una cadena aleatoria larga |
| El frontend muestra "Sin conexión con el servidor" | API apagada o CORS | Levanta el backend y comprueba que `FRONTEND_URL` coincida con el origen del frontend |
| "No tienes permisos" en una sección | RBAC funcionando | Revisa los permisos del rol en `/admin/roles` |
| Las listas aparecen vacías | Base de datos sin datos | Ejecuta `npm run seed` en `backend/` |
| El rol de empresa no ve nada | Usuario sin empresa | El usuario debe estar en `company_users`; el seed lo hace para los usuarios de prueba |
