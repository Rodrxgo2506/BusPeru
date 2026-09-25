# BusPerú — Guía de producción

Este documento reúne **lo que el código exige** para funcionar en producción y **lo que el despliegue tiene que
aportar**. No describe una infraestructura concreta: el proyecto todavía no tiene una estrategia de despliegue
definida (no hay Docker, PM2 ni configuración de proxy en el repositorio, y no se ha inventado ninguna). Donde una
decisión depende de esa infraestructura se dice explícitamente.

**Arquitectura de producción propuesta (AWS):** [`docs/production/AWS-ARCHITECTURE.md`](docs/production/AWS-ARCHITECTURE.md)
(F18-01, diseño; todavía no desplegada). Ese documento es la fuente de la arquitectura; esta guía sigue siendo la
referencia operativa de lo que el código exige.

Plantillas sin valores reales:

- [`backend/.env.production.example`](backend/.env.production.example)
- [`frontend/.env.production.example`](frontend/.env.production.example)

> Los archivos `.env` y `.env.*` reales están en `.gitignore` (salvo las plantillas `*.example`). Ningún secreto
> se escribe en el repositorio ni en el bundle del frontend.

---

## Estado actual: qué está listo y qué no (F17C-SEC-12)

> **El sistema todavía no está listo para recibir tráfico real.** El código ha superado la auditoría de seguridad,
> pero faltan decisiones y piezas de infraestructura que el repositorio no puede aportar por sí solo.

**Implementado y verificado en el código**

- Autenticación, RBAC y aislamiento entre empresas, incluida la frontera al crear reservas (F17C-SEC-11C).
- Revocación de sesiones al cerrar sesión, al cambiar la contraseña y al **suspender** una cuenta (F17C-SEC-10).
- Guardas de arranque que impiden producir con configuración incompleta o insegura (sección 1).
- Cifrado de credenciales de integraciones con soporte de rotación (sección 2).
- Registros saneados y cierre ordenado con `SIGTERM`/`SIGINT`.
- Alta segura del **primer administrador** por consola: `npm run admin:bootstrap` (sección 3, F18-02).
- Comprobación de disponibilidad `GET /api/ready`, separada de `GET /api/health` (sección 3, F18-02).
- **MariaDB 10.11 + modo estricto VALIDATED** (F18-02B): instalación limpia 001→018 y batería completa 3/3 sobre un MariaDB 10.11.19 real (sección 3, *Modo SQL*).

**Pendiente: requiere decisión de infraestructura o una fase propia**

| Pendiente | Por qué importa |
| --- | --- |
| Despliegue (AWS u otro), dominio real y HTTPS | No existe todavía ninguna infraestructura de producción |
| Variables de producción y claves `live` de Culqi, Resend y OAuth | Sin ellas la guarda no deja arrancar, o esas integraciones quedan desactivadas |
| **Almacenamiento persistente para `STORAGE_DIR`** (volumen persistente o S3) | Los archivos subidos (documentos, logos, imágenes de destinos, favicon) se escriben en el **disco local** del servidor: en un servidor efímero se pierden en cada redespliegue |
| **Backups automáticos y definición de RPO/RTO** | El repositorio no automatiza backups (sección 9); RPO y RTO no están definidos |
| **Cifrado de los datos bancarios** (`company_bank_accounts.account_number` e `interbank_code`) | Hoy se guardan en claro. La API solo los devuelve completos a quien puede editarlos, pero un volcado o un backup los expondría. Debe resolverse **antes de almacenar datos bancarios reales** |
| Monitorización y alertas | No hay APM, métricas ni alertas |
| Rate limit compartido | En memoria del proceso: correcto con una sola instancia (sección 4) |
| Índice `(status, expires_at)` en `bookings` | Rendimiento del barrido de expiración cuando crezca el volumen; no es necesario con el volumen actual |

---

## 1. Qué comprueba el propio código al arrancar

Con `NODE_ENV=production`, el backend **no arranca** si la configuración está incompleta o es insegura. Los mensajes
nombran la variable y la regla, nunca el valor. Las guardas son:

| Guarda | Archivo | Qué exige |
| --- | --- | --- |
| Configuración de producción (F15-04, F15-05, F15-11) | `backend/src/config/production-guard.ts` | Variables críticas explícitas, sin defaults locales (tabla de la sección 2) |
| Secretos (F12-08, F17C-SEC-08) | `backend/src/config/secrets-guard.ts` | `JWT_SECRET` ≥ 32 caracteres y ≥ 10 distintos; `INTEGRATIONS_ENCRYPTION_KEY`, si existe, de 32 bytes; `INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS`, si existe, con el mismo formato y **distinta** de la vigente |
| Base de datos (11F-0) | `backend/src/config/database-guard.ts` | Fuera de producción, solo bases `*_test` |
| Build del frontend (F15-02) | `frontend/vite.config.ts` → `src/config/api-url.ts` | `vite build` falla sin `VITE_API_URL` o si apunta a localhost / no usa https |

Fuera de producción nada de esto cambia: los defaults locales (`localhost`, `root`, `MAIL_TRANSPORT=log`, remitente
de pruebas de Resend…) siguen funcionando para desarrollo y para la suite.

---

## 2. Variables del backend

### Obligatorias en producción (sin default)

| Variable | Regla |
| --- | --- |
| `NODE_ENV` | `production` |
| `DB_HOST`, `DB_PORT` | Explícitas. `DB_PORT` entero positivo |
| `DB_NAME` | Explícita (no tiene default en ningún entorno) |
| `DB_USER` | Explícita y **distinta de `root`** (ver sección 5) |
| `DB_PASSWORD` | Explícita y no vacía |
| `JWT_SECRET` | ≥ 32 caracteres aleatorios, ≥ 10 distintos |
| `FRONTEND_URL` | URL **https** pública del frontend (es el único origen permitido por CORS). No localhost |
| `TRUST_PROXY` | Explícita. Ver sección 4 |
| `MAIL_TRANSPORT` | `resend` o `smtp`. `log` y `memory` se rechazan al arrancar |

### Obligatorias según lo que se habilite

| Si… | Entonces | Regla |
| --- | --- | --- |
| `MAIL_TRANSPORT=resend` | `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | El remitente debe ser de un **dominio verificado**; `*@resend.dev` se rechaza |
| `MAIL_TRANSPORT=smtp` | `MAIL_HOST`, `MAIL_FROM` (y normalmente `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_PORT`, `MAIL_SECURE`) | `MAIL_FROM` con formato `Nombre <correo@dominio>` o `correo@dominio` |
| Se define cualquier llave de Culqi | `CULQI_PUBLIC_KEY`, `CULQI_PRIVATE_KEY`, `CULQI_WEBHOOK_SECRET` | Llaves `pk_…`/`sk_…` del **mismo entorno** (test o live); secreto del webhook ≥ 32 caracteres |
| Se define `GOOGLE_CLIENT_ID`/`SECRET` o `MICROSOFT_CLIENT_ID`/`SECRET` | La pareja completa y `OAUTH_CALLBACK_BASE_URL` | Callback **https** pública (no localhost) |

### Opcionales (con default correcto)

`PORT` (3000), `JWT_EXPIRES_IN` (8h), `BOOKING_EXPIRY_INTERVAL_MS` (60000), `RATE_LIMIT_GLOBAL` (300/min),
`RATE_LIMIT_AUTH` (20 cada 15 min), `STORAGE_DIR` (`storage`), `CULQI_TIMEOUT_MS` (20000), `CULQI_API_URL`
(`https://api.culqi.com/v2`; si se define debe ser https), `OAUTH_STATE_TTL_SECONDS` (600),
`OAUTH_TICKET_TTL_SECONDS` (60), `OAUTH_FRONTEND_CALLBACK_PATH`, `MICROSOFT_TENANT` (`common`),
`PASSWORD_RESET_*`, `INTEGRATIONS_ENCRYPTION_KEY` (sin ella el módulo de integraciones responde 503),
`INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS` (vacía salvo durante una rotación de la clave anterior; ver más abajo).

En producción, toda variable numérica definida debe ser un entero positivo (un valor mal escrito ya no se convierte en
`NaN` en silencio).

### Clave de cifrado de integraciones y su rotación (F17C-SEC-08)

Las credenciales que cada empresa guarda en `company_integrations.credentials` se cifran con **AES-256-GCM**
(`backend/src/services/encryption.service.ts`). Dos variables intervienen:

| Variable | Papel | Formato |
| --- | --- | --- |
| `INTEGRATIONS_ENCRYPTION_KEY` | Clave **vigente**. Cifra todo lo que se escribe y es la primera que se prueba al descifrar. Sin ella el módulo responde 503 y no guarda nada en claro | 32 bytes: 64 caracteres hex o base64 canónico (44 caracteres) |
| `INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS` | Clave **anterior**, opcional. **Solo se usa para descifrar**, y solo si la vigente no abre el dato. Nunca cifra nada | El mismo formato, y distinta de la vigente (la guarda lo exige en producción) |

**Lo que el código hace de verdad durante una rotación:**

1. La clave que estaba vigente pasa a `INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS` y en `INTEGRATIONS_ENCRYPTION_KEY` se pone
   una clave **nueva**, generada para la ocasión. La anterior no debe reutilizarse como nueva clave vigente.
2. Lo ya guardado se sigue leyendo con la anterior; todo lo que se escribe a partir de ese momento usa la nueva.
3. Un registro pasa a la clave nueva **cuando esa integración se vuelve a guardar**: el guardado reescribe el sobre
   completo con la clave vigente (re-cifrado perezoso). Nada se re-cifra por sí solo.
4. La anterior se puede retirar cuando ninguna integración dependa ya de ella.

**Lo que NO está implementado**, y conviene saberlo antes de rotar:

- No hay herramienta para **re-cifrar en bloque** ni para **listar** qué registros siguen con la clave anterior. Hasta
  que exista, confirmar que no queda ninguno exige volver a guardar cada integración configurada.
- No hay identificador de clave dentro del sobre: el código sabe cuál abre un registro probando las dos.
- Solo existe **una** clave anterior: no se puede encadenar una segunda rotación mientras la primera no haya terminado.

Retirar la anterior demasiado pronto **no destruye datos**: los sobres siguen intactos, las integraciones afectadas se
ven como no configuradas y guardarlas se rechaza con 409 para no sobrescribirlas (F17C-SEC-08, SEC08-01). Basta con
volver a poner la clave anterior para recuperarlas.

### Prohibidas en producción

`GOOGLE_ISSUER`, `GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`, `GOOGLE_JWKS_URI`, `MICROSOFT_ISSUER`, `MICROSOFT_AUTH_URL`,
`MICROSOFT_TOKEN_URL`, `MICROSOFT_JWKS_URI`. Solo existen para apuntar la suite a un proveedor OAuth de prueba; si
se definen, el proceso no arranca.

### Valores que nunca deben quedar con su default local

`DB_HOST=localhost`, `DB_USER=root`, `DB_PASSWORD` vacía, `FRONTEND_URL=http://localhost:5173`,
`OAUTH_CALLBACK_BASE_URL=http://localhost:3000/api`, `MAIL_TRANSPORT=log`, `RESEND_FROM_EMAIL=onboarding@resend.dev`.
La guarda los rechaza todos.

---

## 3. Build y arranque

Requisitos: Node.js 18+ (probado con 24.x), MySQL 8 o MariaDB 10.4+.

### Backend

```bash
cd backend
npm ci
npm run build          # compila TypeScript a dist/
NODE_ENV=production npm run start   # node dist/server.js
```

Las variables se leen del entorno del proceso (o de `backend/.env` en el directorio de trabajo). Lo recomendable en
producción es inyectarlas desde el gestor de procesos o la plataforma, no desde un archivo en el servidor.

El proceso escribe en `stdout` los mensajes de arranque y en `stderr` una línea JSON por petición atendida y por
error (ver sección 7). Cierra ordenadamente con `SIGINT`/`SIGTERM`; un gestor de procesos (systemd, PM2, contenedor…)
debe reiniciarlo si termina.

### Frontend

```bash
cd frontend
npm ci
VITE_API_URL=https://api.tu-dominio/api npm run build   # o definirla en frontend/.env.production
```

- `VITE_API_URL` se incrusta en el bundle **en tiempo de build**: cambiarla exige reconstruir.
- Se admite una URL https pública o una ruta del mismo origen (`/api`) si un proxy sirve frontend y API bajo el mismo
  dominio.
- Sin la variable, o con localhost / http, la build falla con un mensaje claro. El literal de localhost ya no llega
  al bundle de producción.
- `dist/` es estático: cualquier hosting sirve. Debe devolver `index.html` para las rutas del SPA (fallback de
  historial) y enviar las cabeceras de la sección 6.

### Base de datos

1. Importar `database/schema/Dump20260831.sql`.
2. **Hacer un backup** antes de migrar (sección 9).
3. Aplicar **todas** las migraciones de `database/migrations/`, **de la `001` a la `018`, una detrás de otra y en ese
   orden**, sin saltarse ninguna. La lista con los comandos está en el README (sección *Migraciones*). La última es
   `018-fk-on-update-restrict-mariadb-1011.sql`.
4. **Verificar el esquema resultante** antes de arrancar el backend (ver abajo).

Obligatorias para el código actual, porque se consultan en cada petición o en páginas públicas:

| Migración | Qué aporta | Qué falla sin ella |
| --- | --- | --- |
| `014-revoked-sessions.sql` | Tabla `revoked_sessions` (cierre de sesión, F12-07) | El middleware de autenticación la consulta en **cada** petición autenticada |
| `015-destinations-content-branding.sql` y `016-destination-enhancements.sql` | Tablas y columnas de destinos | La portada y `/destinos/:slug` |
| **`017-users-sessions-valid-from.sql`** | Columna **`users.sessions_valid_from`** (`DATETIME NULL`): terminar las sesiones de una cuenta al suspenderla (F17C-SEC-10) | El middleware de autenticación la lee en **cada** petición autenticada: sin ella, **todas** fallan. **No se puede saltar** |

`001` no toca el esquema: concede `reviews.update` al rol `COMPANY_ADMIN`, sin el cual las empresas no pueden moderar
reseñas. Las migraciones `001` y de la `010` a la `018` son **reejecutables** (comprueban antes de actuar: `017`
consulta `information_schema` y no hace nada si la columna ya existe); aun así, cada una debe aplicarse una sola vez y
en orden.

**Verificación mínima** tras migrar (sobre la base de producción, con el usuario de migraciones):

```sql
SHOW COLUMNS FROM users LIKE 'sessions_valid_from';   -- debe devolver una fila: datetime, NULL
SHOW TABLES LIKE 'revoked_sessions';                   -- debe existir
SHOW TABLES LIKE 'destinations';                       -- debe existir
```

`017` no rellena nada: `NULL` significa «esta cuenta nunca se ha suspendido» y no restringe ninguna sesión, así que
aplicarla no corta a ningún usuario.

### Modo SQL (F18-02)

La base de producción debe correr en **modo estricto**, el valor por defecto de MariaDB 10.11:

```
STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION
```

Con el modo de desarrollo (`NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION`) la base **acepta y altera en
silencio** un texto demasiado largo, un número fuera de rango, una fecha imposible, un valor de ENUM inexistente o un
`NULL` en una columna obligatoria: solo deja un aviso. En modo estricto rechaza la sentencia. La aplicación valida
todo eso antes con Zod, así que el modo estricto es la segunda barrera, no la primera.

**MariaDB 10.11 + modo estricto VALIDATED (F18-02B).** Sobre un MariaDB **10.11.19** real (ZIP portable oficial,
instancia aislada en `127.0.0.1:3311`, modo estricto global):

- instalación limpia —dump y migraciones **001 → 018**, sin `--force`— sin ningún error;
- batería completa **3 de 3 en verde (2097/2097)**, reconstruyendo la base en cada ejecución, sin fallos fuera de
  un test ni transacciones huérfanas; los procesos hijo (suites 17 y 78) usan la misma instancia y el mismo modo.

Esa validación destapó tres incompatibilidades con 10.4, ya corregidas:

| Problema en 10.11 | Corrección |
| --- | --- |
| 009 y 010 fallaban (ERROR 1901): columna generada STORED sobre una columna con clave ajena `ON UPDATE CASCADE` | `fk_integrations_company` y `fk_bus_layouts_bus` pasan a `ON DELETE CASCADE ON UPDATE RESTRICT` en 009/010; la **018** ajusta las bases ya creadas |
| `row_number` sin comillas es un error de sintaxis (ERROR 1064) | Citado como `` `row_number` `` en todo el SQL de la distribución física, el seed y las pruebas |
| Las columnas JSON llegaban del driver ya convertidas en objeto | `jsonStrings: true` en el pool: llegan como texto, igual que en 10.4 |

La validación se repite apuntando las variables del proceso de pruebas a otra instancia (nunca en `.env`):

```bash
DB_HOST=127.0.0.1 DB_PORT=3311 DB_NAME=busperu_1011_test DB_USER=root DB_PASSWORD=<credencial de esa instancia> npm test
```

En MariaDB 10.4 se puede ensayar el modo estricto solo en las conexiones de prueba con
`TEST_SQL_MODE="STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION" npm test`
(los procesos hijo de las suites 17 y 78 no aplican esa variable; con un servidor en modo estricto global no hace falta).

### Primer administrador (F18-02)

El dump no trae usuarios y el seed se niega a correr en producción. El primer `ADMIN` se crea con un comando de
consola, **una sola vez**, desde la propia instancia y con la configuración de producción ya cargada:

```bash
npm run admin:bootstrap
```

(En desarrollo, sin compilar: `npm run admin:bootstrap:dev`.)

- Pide correo, nombres, apellidos y la contraseña **dos veces**, sin eco en la terminal. **No acepta ningún argumento**:
  una contraseña en la línea de órdenes quedaría en el historial y en la lista de procesos, así que cualquier
  `--password=...` hace que el comando termine sin hacer nada.
- Muestra el entorno y el nombre de la base y exige **teclear el nombre de la base** para confirmar.
- Aplica las mismas guardas que el servidor: si la configuración de producción está incompleta o la base no es la
  permitida, se detiene **antes de conectar**.
- **Se niega si ya existe un administrador**, o si el correo ya pertenece a otra cuenta (no la convierte en ADMIN).
- Contraseña con las reglas de la aplicación (8–72 caracteres, una mayúscula, un número), guardada con bcrypt. La
  cuenta nace `ACTIVE` con el rol `ADMIN` y deja un registro en `audit_logs` (actor `system:admin-bootstrap`) **sin**
  correo, contraseña ni hash.
- Todo ocurre en una transacción con bloqueo: dos ejecuciones simultáneas no pueden crear dos administradores.

Nunca se crea el administrador con un `INSERT` manual ni con un endpoint.

### Liveness y readiness (F18-02)

| Endpoint | Pregunta que responde | Consulta | Respuesta |
| --- | --- | --- | --- |
| `GET /api/health` | ¿El proceso está vivo? | Nada | Siempre `200` mientras el proceso responda |
| `GET /api/ready` | ¿Puede atender tráfico? | `SELECT 1` en el pool (máx. 2 s) y permisos de `STORAGE_DIR` | `200 {"status":"ready"}` o `503 {"status":"not_ready"}` |

`/api/ready` no escribe archivos ni modifica la base, responde con `Cache-Control: no-store` y **no revela** qué
falló: el host o el nombre de la base, rutas y trazas van solo al registro saneado. Úsese `/api/ready` para el health
check del balanceador y las alertas de disponibilidad; `/api/health`, para saber si hay que reiniciar el proceso.

---

## 4. HTTPS, proxy inverso y rate limit

- **HTTPS es obligatorio.** El JWT viaja en la cabecera `Authorization`, las credenciales en el cuerpo del login y
  Culqi exige https para el webhook. `FRONTEND_URL`, `OAUTH_CALLBACK_BASE_URL` y `VITE_API_URL` deben ser https.
  El TLS lo termina el hosting o el proxy inverso; la app no gestiona certificados.
- **`TRUST_PROXY`** (F15-05) controla `app.set('trust proxy', …)`:
  - `false` (default fuera de producción): la IP del cliente es la del socket; `X-Forwarded-For` se ignora.
  - `1`..`10`: número de proxies de confianza delante de la app (lo habitual detrás de un único proxy: `1`).
  - Lista de IPs/CIDR o `loopback`, `linklocal`, `uniquelocal`: solo se confía en esos saltos.
  - `true` **no se admite**: confiaría en cualquier `X-Forwarded-For` y cualquier cliente podría fijarse la IP y
    saltarse el rate limit.

  Un valor demasiado alto permite falsear la IP; uno demasiado bajo hace que todos los usuarios compartan la IP del
  proxy y agoten juntos el rate limit. **Debe fijarse según la topología real**, que todavía no existe.
- **Rate limit en memoria.** `express-rate-limit` usa la memoria del proceso. Es correcto con **una sola instancia**.
  Con varias réplicas cada una lleva su propia cuenta (el límite efectivo se multiplica por el número de réplicas) y
  un reinicio lo pone a cero. Escalar horizontalmente requiere un store compartido (por ejemplo Redis); no se ha
  añadido porque no hay infraestructura Redis.
- **Planificador.** Cada instancia ejecuta su propio ciclo de expiración, ciclo de vida de viajes y purgas. Las
  operaciones son idempotentes (bloqueos `FOR UPDATE`, `UPDATE` condicionados por estado, `DELETE` por caducidad) y
  las plantillas del sistema toleran arranques simultáneos (F15-10), así que varias réplicas no corrompen datos,
  pero repiten trabajo. Si se escala, conviene dejar el planificador en una sola.

---

## 5. Base de datos: usuario de la aplicación (F15-07)

El entorno local usa `root` (XAMPP). **En producción no.** La guarda rechaza `DB_USER=root` y una contraseña vacía.

El usuario de la aplicación debe ser:

- **dedicado** a BusPerú (no compartido con otras apps ni personas);
- con **contraseña fuerte** y aleatoria, guardada en el gestor de secretos del despliegue;
- con **privilegios mínimos** sobre la base de producción: `SELECT`, `INSERT`, `UPDATE`, `DELETE` (la app no crea ni
  altera tablas en ejecución);
- **sin permisos administrativos**: ni `GRANT OPTION`, ni `SUPER`, ni `FILE`, ni `PROCESS`, ni acceso a otras bases;
- con **acceso restringido al host** de la aplicación (`'usuario'@'ip-o-subred-de-la-app'`, nunca `'%'`), y el puerto
  de la base no expuesto a Internet.

Las migraciones las aplica una persona con **otro** usuario con permisos de esquema (`CREATE`, `ALTER`, `INDEX`,
`DROP`, `REFERENCES`), no el de la aplicación.

Esqueleto orientativo (los nombres, el host y la contraseña los decide quien administre la base; **no** se ha
ejecutado en ningún entorno):

```sql
CREATE USER 'busperu_app'@'<host-de-la-app>' IDENTIFIED BY '<contraseña-fuerte>';
GRANT SELECT, INSERT, UPDATE, DELETE ON `<base_de_produccion>`.* TO 'busperu_app'@'<host-de-la-app>';
```

---

## 6. Frontend: sesión, XSS y cabeceras (F15-06)

**Decisión vigente (F12-07):** el JWT se guarda en `localStorage`. No se migra a cookies en esta fase. La consecuencia
es que un XSS podría leer el token, así que la defensa se centra en impedir el XSS:

- React escapa todo lo que renderiza; no hay `dangerouslySetInnerHTML` ni `innerHTML` en el código.
- Las redirecciones tras el login solo aceptan rutas internas (`/…`, nunca `//` ni `\`, H-35).
- El token nunca viaja en la URL ni se escribe en consola; al cerrar sesión se revoca también en el servidor.
- La API ya envía las cabeceras de `helmet` (incluida su CSP por defecto) en sus propias respuestas JSON.

**La CSP del frontend debe configurarse en el hosting o proxy que sirve `dist/`**, no en el código. No se ha añadido
una `<meta>` CSP porque la app carga recursos de terceros que no se pueden validar sin el entorno real (Checkout v4 de
Culqi y sus iframes, Google Fonts) y una política incorrecta rompería el pago. Punto de partida, **a desplegar
primero como `Content-Security-Policy-Report-Only`** y ajustar con los informes antes de hacerla obligatoria:

```
default-src 'self';
script-src 'self' https://checkout.culqi.com;
frame-src https://checkout.culqi.com https://checkoutview.culqi.com;
connect-src 'self' https://api.tu-dominio;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com;
img-src 'self' data: blob:;
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

Cabeceras recomendadas además en el hosting del frontend: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` restrictiva.

---

## 7. Registros (F15-08)

- **Acceso**: con `NODE_ENV=production`, una línea JSON por petición en `stderr`:
  `{"timestamp","level":"info","message":"http_request","requestId","method","path","status","durationMs","userId"}`.
- **No se registra**: la query string (se descarta entera), ninguna cabecera (`Authorization`, cookies, API Keys), el
  cuerpo, correos ni tokens. La ruta pasa por `sanitizeUrl` (el secreto del webhook de Culqi y los segmentos con forma
  de token se ocultan) y cualquier secreto configurado que apareciera se sustituye por `[REDACTED]`.
- **Errores**: `logError`, mismo formato, sin `req.body`, sin cabeceras y sin la sentencia SQL.
- `X-Request-Id` se devuelve en todas las respuestas y aparece en ambos registros.
- En desarrollo sigue morgan (URL saneada); en la suite no se registra nada.

La rotación y retención de los registros corresponde al gestor de procesos o a la plataforma.

---

## 8. Integraciones externas

### Culqi

- Modelo agregador: una sola cuenta de plataforma. La llave privada no sale nunca del backend; la pública sí viaja
  al navegador.
- Webhook a registrar en CulqiPanel: `https://<dominio-del-backend>/api/culqi/webhook/<CULQI_WEBHOOK_SECRET>`.
  Con el secreto vacío el endpoint responde 404. El pago nunca se da por bueno por el webhook: se relee el cargo
  contra la API de Culqi.
- Pasar a llaves `live` es una decisión de negocio y exige la cuenta de Culqi en producción. Sin llaves, el pago con
  tarjeta queda deshabilitado y el resto de la app funciona.

### OAuth (Google / Microsoft)

- Un proveedor sin client id y secret queda desactivado (503 y sin botón).
- Redirect URI a registrar: `<OAUTH_CALLBACK_BASE_URL>/auth/oauth/google/callback` y `…/microsoft/callback`.
- Microsoft no emite `email_verified` de forma fiable: sin ese claim no se da de alta una cuenta nueva con Microsoft
  (sí se puede iniciar sesión con una identidad ya vinculada).

### Resend

- `MAIL_TRANSPORT=resend`, `RESEND_API_KEY` y `RESEND_FROM_EMAIL` con un dominio **verificado en Resend**.
- El remitente `onboarding@resend.dev` solo entrega al dueño de la cuenta: sirve en desarrollo y se rechaza en
  producción.

---

## 9. Backups y recuperación

El repositorio no automatiza backups. Hasta ahora se han hecho volcados manuales con `mysqldump` antes de cada
migración. Producción necesita, como mínimo y **decidido por quien opere la base**:

- backup automático periódico (y binlog si se quiere recuperación a un punto en el tiempo);
- copias fuera del servidor de la base, cifradas y con retención definida;
- el directorio `STORAGE_DIR` incluido en el backup: documentos de empresas (`documents/`) e imágenes públicas de
  destinos e identidad visual (`public/`, FASE 17);
- una **restauración probada** sobre una base aparte antes del go-live.

---

## 10. Dependencias con avisos conocidos

`npm audit` del frontend informa 2 avisos moderados en `react-router`/`react-router-dom` 6.30.6 (corregidos solo en
7.18+, salto mayor). Evaluación (F15-09):

| Aviso | ¿Aplica a BusPerú? |
| --- | --- |
| GHSA-337j-9hxr-rhxg · inyección de constructor en `deserializeErrors()` al hidratar SSR | **No explotable**: la app es un SPA sin SSR, usa `<BrowserRouter>` (no un data router) y nunca define `window.__staticRouterHydrationData` |
| GHSA-wrjc-x8rr-h8h6 · open redirect con barra invertida en `<Link>`/`useNavigate` | **Mitigado**: el único destino que viene de fuera (`from` del login) solo se sigue si es ruta interna sin `//` ni `\` (H-35); el resto de destinos son constantes del código |

Recomendación: planificar la actualización a React Router 7 en una fase propia, con pruebas de navegación, en lugar de
forzarla con `npm audit fix --force`.

---

## 11. Orden de despliegue

Orden lógico, independiente de la plataforma. Para AWS, el procedimiento concreto —con la plantilla, los scripts y
las comprobaciones— está en `docs/production/STAGING-RUNBOOK.md` (F18-03).

1. **Preparar la infraestructura**: servidor o servicio para el backend, hosting estático para el frontend y base de
   datos MySQL/MariaDB.
2. **Configurar los secretos** en el gestor del despliegue (sección 2). Nunca en el repositorio.
3. **Preparar la base**: importar el dump y crear el usuario de la aplicación con privilegios mínimos (sección 5).
4. **Hacer un backup** (sección 9).
5. **Aplicar las migraciones `001` a `018` en orden** (sección 3, *Base de datos*).
6. **Verificar el esquema**, en particular `users.sessions_valid_from` (sección 3).
7. **Configurar y arrancar el backend** con `NODE_ENV=production`: si falta o sobra algo, la guarda lo impide y lo dice.
   `GET /api/ready` debe responder `200`.
8. **Crear el primer administrador** con `npm run admin:bootstrap` (sección 3). Una sola vez.
9. **Configurar la comisión por defecto de la plataforma** (`platform.default_commission`) con
   `infra/aws/scripts/set-platform-commission.mjs` y el porcentaje que decida el negocio. Una base
   recién instalada no la trae y **sin ella la API rechaza dar de alta empresas** con un 409. El
   valor es una **DECISIÓN PENDIENTE**: el `10.00` del seed es un ejemplo de desarrollo (F18-03B).
10. **Construir y publicar el frontend** con la `VITE_API_URL` definitiva.
11. **Dominio y HTTPS** para frontend y API; `TRUST_PROXY` según la topología real (sección 4).
12. **Integraciones**, según se habiliten: Culqi (webhook con su secreto), Resend (dominio verificado) y OAuth
    (redirect URIs) (sección 8).
13. **Almacenamiento**: `STORAGE_DIR` en un volumen persistente e incluido en los backups (ver *Estado actual*).
14. **Pruebas de humo**: login, búsqueda, reserva, panel de empresa y, si aplica, un pago en entorno de pruebas de Culqi.
15. **Revisar registros y salud**: `GET /api/ready` devuelve 200 (base y almacenamiento disponibles), `GET /api/health`
    devuelve 200 y los registros JSON no muestran errores de arranque.
16. **Habilitar el tráfico.**

---

## 12. Lista de comprobación antes del go-live

- [ ] Configuración de producción creada en el gestor de secretos; el backend arranca sin errores de guarda.
- [ ] `TRUST_PROXY` fijado según la topología real; comprobado que `req.ip` es la del cliente.
- [ ] Frontend construido con la `VITE_API_URL` definitiva; sirve `index.html` como fallback y envía CSP (primero Report-Only).
- [ ] HTTPS extremo a extremo; HSTS activo.
- [ ] Usuario de base de datos dedicado con privilegios mínimos; puerto de la base no expuesto.
- [ ] Migraciones **001–018** aplicadas en la base de producción, en orden y con backup previo; `users.sessions_valid_from` verificada.
- [ ] `STORAGE_DIR` en almacenamiento persistente e incluido en los backups.
- [ ] Base en modo estricto (compatibilidad validada: MariaDB 10.11.19 + strict, F18-02B); pruebas de humo contra la RDS real.
- [ ] Primer administrador creado con `npm run admin:bootstrap`; ninguna cuenta de prueba en la base.
- [ ] `platform.default_commission` configurada con el valor **decidido por el negocio** (sin ella no se pueden dar de alta empresas).
- [ ] Health check del balanceador apuntando a `GET /api/ready`.
- [ ] Datos bancarios cifrados antes de guardar cuentas reales (pendiente de su propia fase).
- [ ] Destinos y atractivos cargados con información verificada (los del seed son DEMO y no se copian a producción).
- [ ] Backups automáticos y una restauración probada.
- [ ] Dominio verificado en Resend (o SMTP propio) y envío real comprobado.
- [ ] Culqi en el entorno deseado y webhook registrado con su secreto.
- [ ] OAuth: redirect URIs registradas (si se habilita).
- [ ] Una sola instancia, o store de rate limit compartido si hay varias.
- [ ] Código desplegado desde una versión controlada (commit/tag), no desde una copia de trabajo.
