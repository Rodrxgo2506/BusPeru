# BusPerú — Guía de producción

Este documento reúne **lo que el código exige** para funcionar en producción y **lo que el despliegue tiene que
aportar**. No describe una infraestructura concreta: el proyecto todavía no tiene una estrategia de despliegue
definida (no hay Docker, PM2 ni configuración de proxy en el repositorio, y no se ha inventado ninguna). Donde una
decisión depende de esa infraestructura se dice explícitamente.

Plantillas sin valores reales:

- [`backend/.env.production.example`](backend/.env.production.example)
- [`frontend/.env.production.example`](frontend/.env.production.example)

> Los archivos `.env` y `.env.*` reales están en `.gitignore` (salvo las plantillas `*.example`). Ningún secreto
> se escribe en el repositorio ni en el bundle del frontend.

---

## 1. Qué comprueba el propio código al arrancar

Con `NODE_ENV=production`, el backend **no arranca** si la configuración está incompleta o es insegura. Los mensajes
nombran la variable y la regla, nunca el valor. Las guardas son:

| Guarda | Archivo | Qué exige |
| --- | --- | --- |
| Configuración de producción (F15-04, F15-05, F15-11) | `backend/src/config/production-guard.ts` | Variables críticas explícitas, sin defaults locales (tabla de la sección 2) |
| Secretos (F12-08) | `backend/src/config/secrets-guard.ts` | `JWT_SECRET` ≥ 32 caracteres y ≥ 10 distintos; `INTEGRATIONS_ENCRYPTION_KEY`, si existe, de 32 bytes |
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
`PASSWORD_RESET_*`, `INTEGRATIONS_ENCRYPTION_KEY` (sin ella el módulo de integraciones responde 503).

En producción, toda variable numérica definida debe ser un entero positivo (un valor mal escrito ya no se convierte en
`NaN` en silencio).

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
2. Aplicar `database/migrations/002` a `014` en orden (ver README). **`014` es obligatoria antes de desplegar este
   código**: el middleware de autenticación consulta `revoked_sessions` en cada petición.
3. Hacer un backup antes de cada migración (sección 8).

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
- el directorio `STORAGE_DIR` (documentos de empresas) incluido en el backup;
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

## 11. Lista de comprobación antes del go-live

- [ ] Configuración de producción creada en el gestor de secretos; el backend arranca sin errores de guarda.
- [ ] `TRUST_PROXY` fijado según la topología real; comprobado que `req.ip` es la del cliente.
- [ ] Frontend construido con la `VITE_API_URL` definitiva; sirve `index.html` como fallback y envía CSP (primero Report-Only).
- [ ] HTTPS extremo a extremo; HSTS activo.
- [ ] Usuario de base de datos dedicado con privilegios mínimos; puerto de la base no expuesto.
- [ ] Migraciones 002–014 aplicadas en la base de producción, con backup previo.
- [ ] Backups automáticos y una restauración probada.
- [ ] Dominio verificado en Resend (o SMTP propio) y envío real comprobado.
- [ ] Culqi en el entorno deseado y webhook registrado con su secreto.
- [ ] OAuth: redirect URIs registradas (si se habilita).
- [ ] Una sola instancia, o store de rate limit compartido si hay varias.
- [ ] Código desplegado desde una versión controlada (commit/tag), no desde una copia de trabajo.
