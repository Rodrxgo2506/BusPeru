# BusPerú — AWS Production Architecture

> **Estado:** diseño aprobable, **no desplegado** (F18-01). No existe todavía ningún recurso AWS, dominio ni secreto de
> producción. Este documento es la **fuente de la arquitectura**; la guía operativa sigue siendo
> [`PRODUCCION.md`](../../PRODUCCION.md), que no se duplica aquí.
>
> Todo lo que se afirma sobre el comportamiento del sistema se ha comprobado contra el código del repositorio. Donde
> algo depende de una decisión que aún no se ha tomado, se marca como **DECISIÓN PENDIENTE** y se da una propuesta de
> partida, no una decisión.

---

## 1. Objetivo

Definir una primera arquitectura de producción en AWS que:

- ejecute BusPerú **tal como es hoy**, sin cambios funcionales obligatorios para arrancar;
- respete las restricciones reales del código: almacenamiento en disco local, planificador dentro del proceso, rate
  limit en memoria, cierre ordenado con `SIGTERM`;
- mantenga la base de datos privada y los secretos fuera del repositorio y del servidor;
- permita a las fases de despliegue (F18-03 en adelante) ejecutarlo sin volver a descubrir el proyecto.

Fuera de alcance de la primera versión: alta disponibilidad multi-instancia, escalado horizontal, CDN delante de la API
y migración de archivos a S3. Se explica por qué en cada sección.

---

## 2. Arquitectura

| Capa | Servicio | Por qué |
| --- | --- | --- |
| Frontend | **S3 (privado) + CloudFront** con OAC, certificado ACM y fallback de SPA | El frontend es estático (`vite build` → `dist/`) y usa `BrowserRouter`, que exige servir `index.html` en cualquier ruta |
| API | **Application Load Balancer** (HTTPS, ACM) → **una instancia EC2** | El proceso Node es persistente, tiene planificador propio y escribe en disco local |
| Proceso | Node.js 24 bajo **systemd** en Amazon Linux 2023 | Es la versión con la que se han validado las 2054 pruebas; systemd reinicia el proceso y entrega `SIGTERM` |
| Archivos | **Volumen EBS gp3 dedicado** montado en la instancia (`STORAGE_DIR`) | Encaja con el código actual **sin modificarlo** (sección 7) |
| Base de datos | **RDS for MariaDB 10.11**, subredes privadas, cifrada, backups automáticos | Misma familia de motor que desarrollo (MariaDB 10.4); 10.4 ya no se ofrece como LTS |
| Secretos | **SSM Parameter Store (SecureString)**; contraseña maestra de RDS en **Secrets Manager** gestionada por RDS | Sin coste por secreto para la app; rotación nativa para la credencial maestra |
| Correo | **Resend** (externo), dominio verificado | Ya integrado |
| Pagos | **Culqi** (externo), webhook público por HTTPS | Ya integrado |
| Identidad | **Google / Microsoft OAuth** (externos) | Ya integrados |
| Observabilidad | **CloudWatch** Logs, Metrics y Alarms (agente en la instancia) | El backend ya escribe JSON en `stderr` |
| Backups | **RDS automated backups + PITR**, **snapshots EBS** diarios (AWS Backup o DLM) | Cubren base y archivos |

### Inventario de dependencias de producción

Cada componente que el sistema necesita, con lo que usa hoy, lo que usará en AWS y lo que falta decidir. Los secretos
se nombran, nunca se muestran.

| # | Componente | Función | Hoy | En AWS | Configuración | Secretos | Riesgo / blocker | Decisión propuesta |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Frontend | SPA de venta y paneles | `vite build` → `dist/` servido en local | S3 privado + CloudFront | `VITE_API_URL` en el build; fallback de SPA; cabeceras y CSP | — | Sin fallback, las rutas del SPA dan 404 (`BrowserRouter`) | S3 + CloudFront con OAC (§4) |
| 2 | Backend | API, reglas de negocio, planificador | `node` en Windows | EC2 + systemd tras un ALB | Todas las variables de `PRODUCCION.md` §2 | Todos los de §9 | Proceso con estado local (disco, rate limit, planificador) | Una instancia EC2 (§5) |
| 3 | Base de datos | Datos transaccionales | MariaDB 10.4 (XAMPP), sin modo estricto | RDS for MariaDB 10.11 | Parameter group, usuarios, migraciones 001→018 | `DB_PASSWORD`; contraseña maestra | **MariaDB 10.11 + strict mode VALIDATED** (F18-02B) | RDS privada y cifrada (§6) |
| 4 | Almacenamiento de archivos | Documentos, logotipos, imágenes, favicon | Disco local (`STORAGE_DIR`) | Volumen EBS gp3 dedicado | `STORAGE_DIR` absoluto; montaje y permisos | — | En un servidor efímero se perderían; S3 exige cambiar código | EBS ahora, S3 al escalar (§7) |
| 5 | Correo | Recuperación de contraseña y notificaciones | Resend / `log` en desarrollo | Resend | `MAIL_TRANSPORT=resend`, `RESEND_FROM_EMAIL` | `RESEND_API_KEY` | Dominio sin verificar → la guarda no arranca | Resend con dominio verificado (§12) |
| 6 | OAuth Google | Login social | Configurable, desactivado sin credenciales | Igual | `GOOGLE_CLIENT_ID`, `OAUTH_CALLBACK_BASE_URL`, redirect URI | `GOOGLE_CLIENT_SECRET` | Redirect URI mal registrada → login roto | Registrar `…/auth/oauth/google/callback` (§10) |
| 7 | OAuth Microsoft | Login social | Igual | Igual | `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT`, redirect URI | `MICROSOFT_CLIENT_SECRET` | Ídem; no da de alta cuentas sin `email_verified` | Registrar `…/auth/oauth/microsoft/callback` (§10) |
| 8 | Culqi | Pagos con tarjeta y webhook | Llaves de prueba | Igual (live por decisión de negocio) | `CULQI_PUBLIC_KEY`, URL del webhook en CulqiPanel | `CULQI_PRIVATE_KEY`, `CULQI_WEBHOOK_SECRET` | El secreto del webhook viaja en la URL (registros del ALB) | Webhook por HTTPS en `API_DOMAIN` (§11) |
| 9 | DNS | Resolución de dominios | — | Route 53 u otro proveedor | `FRONTEND_DOMAIN`, `API_DOMAIN`, `MAIL_DOMAIN`; validación ACM | — | Dominios no decididos; CORS admite un solo origen | DECISIÓN PENDIENTE (§18) |
| 10 | HTTPS | Cifrado en tránsito | — (HTTP local) | ACM en CloudFront (`us-east-1`) y en el ALB | Certificados; redirección 80→443; HSTS | — | La guarda exige URLs https | ACM gestionado (§4, §5) |
| 11 | Logging | Registros de acceso y errores | JSON saneado en `stderr` (producción) | CloudWatch Logs vía agente | Log group, retención | — | Los access logs del ALB incluirían el secreto del webhook | CloudWatch Agent (§14) |
| 12 | Monitoring | Métricas y alertas | No existe | CloudWatch Metrics + Alarms + SNS | Metric filters, alarmas, métricas de memoria y disco | — | Readiness disponible: `GET /api/ready` (F18-02) | Alarmas mínimas de §14 |
| 13 | Backups | Recuperación de datos | Volcados manuales | RDS PITR + snapshots EBS | Retención, plan de snapshots, prueba de restauración | — (los secretos no se respaldan) | **RPO/RTO sin definir** | Propuesta de §13; decisión pendiente |
| 14 | Scheduler | Expiración, ciclo de vida de viajes, purgas | `setInterval` en el proceso | Igual, en la única instancia | `BOOKING_EXPIRY_INTERVAL_MS` | — | Con varias instancias, trabajo duplicado | Una instancia (§15) |
| 15 | Rate limiting | Protección contra abuso | En memoria del proceso | Igual | `TRUST_PROXY=1`, límites | — | Con varias instancias no es global | Una instancia; Redis al escalar (§16) |
| 16 | Secrets management | Custodia de secretos | `backend/.env` local | Parameter Store (SecureString) + Secrets Manager | Prefijo `/busperu/prod/`, IAM del rol, `EnvironmentFile` en tmpfs | Todos los de §9 | Ninguno de diseño | Parameter Store para la app (§9) |

---

## 3. Diagrama textual

```
                    Internet
        ┌──────────────┴───────────────┐
        │                              │
  FRONTEND_DOMAIN                 API_DOMAIN
  (Route 53 / DNS)                (Route 53 / DNS)
        │                              │
  ┌─────▼──────┐                 ┌─────▼─────────────────┐
  │ CloudFront │  HTTPS (ACM)    │ Application Load       │  HTTPS 443 (ACM)
  │  + OAC     │                 │ Balancer (subred       │  HTTP 80 → 301 HTTPS
  └─────┬──────┘                 │ pública, 2 AZ)         │
        │                        └─────┬─────────────────┘
  ┌─────▼──────┐                       │ HTTP 3000 (solo desde el SG del ALB)
  │ S3 bucket  │               ┌───────▼────────────────────────────┐
  │ dist/      │               │ EC2 (Amazon Linux 2023)            │
  │ (privado)  │               │  systemd → node dist/server.js     │
  └────────────┘               │  planificador en proceso           │
                               │  EBS gp3 → /srv/busperu/storage    │──► Culqi API / Resend / OAuth
                               │  CloudWatch Agent                  │    (salida HTTPS 443)
                               └───────┬───────────────┬────────────┘
                                       │ 3306          │ HTTPS (endpoints de AWS)
                               ┌───────▼────────┐  ┌───▼──────────────────────┐
                               │ RDS MariaDB    │  │ SSM Parameter Store      │
                               │ 10.11          │  │ CloudWatch Logs/Metrics  │
                               │ subredes       │  │ AWS Backup (snapshots)   │
                               │ PRIVADAS       │  └──────────────────────────┘
                               └────────────────┘

  Culqi ──HTTPS──► API_DOMAIN/api/culqi/webhook/<secreto>        (webhook entrante)
  Navegador ──► Google / Microsoft ──► API_DOMAIN/api/auth/oauth/<proveedor>/callback
```

---

## 4. Frontend

**Lo que el código exige (verificado):**

- Build: `npm ci && npm run build` (`tsc -b && vite build`) → `dist/`.
- `VITE_API_URL` se incrusta **en el build**; la build falla si falta, si usa `http` o si apunta a localhost
  (`frontend/src/config/api-url.ts`). Valor de producción: `https://API_DOMAIN/api`.
- Enrutado con `BrowserRouter` (`src/App.tsx`): toda ruta desconocida para el hosting debe devolver `index.html`.
- Las imágenes públicas (logos, destinos, favicon) **no se sirven desde el frontend**: se piden a la API como
  `${VITE_API_URL}/public/media/<referencia>` (`src/services/api.ts`).

**Diseño:**

- Bucket S3 **privado** (Block Public Access activado) con `dist/`. Solo CloudFront lo lee, mediante **Origin Access
  Control**.
- CloudFront con certificado **ACM en `us-east-1`** (requisito de CloudFront) para `FRONTEND_DOMAIN`.
- **Fallback de SPA**: respuestas de error personalizadas 403 y 404 → `/index.html` con código 200.
- **Caché**: `index.html` con `Cache-Control: no-cache`; los recursos con hash de `assets/` con `max-age` largo e
  `immutable`. Invalidar `/index.html` en cada despliegue.
- **Cabeceras** mediante una *response headers policy*: HSTS, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` restrictiva y la CSP de `PRODUCCION.md` §6,
  **primero como `Content-Security-Policy-Report-Only`** (debe permitir `checkout.culqi.com`, `checkoutview.culqi.com`,
  Google Fonts y `connect-src https://API_DOMAIN`).
- **Dominio canónico**: CORS admite **un único origen** (`FRONTEND_URL`). Si se usan a la vez el dominio raíz y `www`,
  uno debe redirigir al otro; no pueden coexistir como orígenes (**DECISIÓN PENDIENTE**: cuál es el canónico).

---

## 5. Backend

### Servicio elegido: EC2 (una instancia) detrás de un ALB

| Opción | Encaje con BusPerú hoy |
| --- | --- |
| **EC2 + ALB** | ✔ Proceso persistente, disco persistente (EBS) para `STORAGE_DIR`, planificador y rate limit de una sola instancia funcionan tal cual. Control total del cierre ordenado |
| ECS/Fargate | ✖ para empezar: las tareas son efímeras. El almacenamiento local exigiría EFS o S3, y el rate limit y el planificador pedirían resolver primero la multi-instancia |
| Elastic Beanstalk | ✖ para empezar: reemplaza instancias en cada despliegue y el disco local se perdería; mismo problema que Fargate |

**Configuración propuesta:**

- Amazon Linux 2023, arquitectura ARM (Graviton, familia `t4g`) o x86 (`t3`). El proyecto **no tiene addons nativos**
  (verificado en F17C-SEC-11A), así que ambas sirven. Tamaño inicial pequeño (**DECISIÓN PENDIENTE**, sección 23).
- **Node.js 24**, fijado en el despliegue (el `package.json` no declara `engines`).
- Artefacto: `npm ci --omit=dev && npm run build` fuera de la instancia o en ella; se ejecuta `node dist/server.js`.
- **systemd**: `Restart=always`, usuario sin privilegios, `EnvironmentFile` con los secretos (sección 9),
  `KillSignal=SIGTERM`, `TimeoutStopSec` ≥ 15 s. El backend ya cierra con orden: detiene el planificador, cierra el
  servidor y el pool, con red de seguridad de 10 s (`src/server.ts`).
- **Arranque**: `verifyConnection()` comprueba la base y `ensureSystemTemplates()` crea las plantillas del sistema de
  forma idempotente. Si falta configuración, las guardas impiden arrancar.
- **Acceso de administración** por **SSM Session Manager**, sin puerto SSH abierto.

### ALB

- Oyente 443 con certificado **ACM** (en la región del ALB) para `API_DOMAIN`; oyente 80 que redirige a 443.
- Grupo de destino HTTP al puerto 3000 de la instancia; **health check `GET /api/ready`** (sección 17).
- **Deregistration delay** ≈ 30 s, por encima de los 10 s de cierre del proceso.
- La API **no** pasa por CloudFront en esta versión. Así hay un solo proxy delante de Express y **`TRUST_PROXY=1`**
  es el valor correcto: `req.ip` será la IP real del cliente para el rate limit. Si algún día se pone CloudFront
  delante del ALB, pasará a `2`.

---

## 6. Database

**Motor: RDS for MariaDB 10.11.** El dump se generó desde MariaDB 10.4.32 y la suite se ejecuta sobre ese motor.
Mantener la familia minimiza el riesgo de importación; MySQL 8 también es viable, pero añade diferencias de sintaxis y
de comportamiento sin ganancia para este proyecto.

**Estado real que condiciona la configuración (comprobado sobre `busperu_test`):**

| Aspecto | Desarrollo y tests hoy | Implicación en RDS |
| --- | --- | --- |
| Versión | MariaDB 10.4.32 | **MariaDB 10.11 + strict mode VALIDATED** (F18-02B): 10.11.19 real, instalación limpia 001→018 y batería 3/3 (2097/2097) |
| `sql_mode` | Desarrollo: **sin `STRICT_TRANS_TABLES`** (`NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION`). Validación: MariaDB 10.11.19 con modo estricto global (F18-02B) | Usar el modo estricto por defecto del motor. Dump, migraciones 001→018 y batería completa (3/3) pasan sobre 10.11 (`PRODUCCION.md` §3, *Modo SQL*) |
| Zona horaria | la app fija `time_zone = '-05:00'` en **cada conexión** del pool | Independiente de la zona del servidor. RDS puede quedarse en UTC |
| Collation | tablas en `utf8mb4_unicode_ci` declarado en el DDL | Fijar `character_set_server=utf8mb4` en el parameter group |
| Conexiones | pool de 10 | Holgado incluso para la clase más pequeña |

**Diseño:**

- Subredes **privadas** en dos AZ (el *DB subnet group* lo exige aunque la instancia sea Single-AZ). **Sin acceso
  público.**
- Security group: entrada **3306 solo desde el SG del backend**.
- **Cifrado en reposo** (KMS) activado al crear la base: no se puede activar después.
- **Backups automáticos** con PITR y **deletion protection**.
- **Parameter group propio**: `character_set_server=utf8mb4` y `sql_mode` **estricto**
  (`STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION`, el defecto de 10.11).
  Validado con la batería completa sobre MariaDB 10.11.19 real (F18-02B).
- **Usuarios** (`PRODUCCION.md` §5): la aplicación usa un usuario dedicado con `SELECT, INSERT, UPDATE, DELETE` sobre
  la base de BusPerú, restringido a la subred del backend. Las migraciones usan otro usuario con permisos de esquema.
  La contraseña maestra de RDS queda en Secrets Manager y no la usa la aplicación.
- **Multi-AZ**: DECISIÓN PENDIENTE. Mejora la disponibilidad y aproximadamente duplica el coste de la base.
- **TLS en tránsito**: el tráfico va dentro de la VPC. Exigir TLS (`require_secure_transport`) obligaría a pasar la
  opción `ssl` al pool de `mysql2`, que hoy no la tiene: es un cambio de código (opcional).

### Procedimiento conceptual

1. Crear la instancia RDS en subredes privadas, cifrada, con su parameter group.
2. Crear la base de BusPerú.
3. Crear el usuario de la aplicación (privilegios mínimos) y el de migraciones.
4. Importar `database/schema/Dump20260831.sql`. **Solo trae el catálogo de RBAC** (`roles`, `permissions`,
   `role_permissions`): ni usuarios ni ajustes.
5. Snapshot manual y aplicar **001 → 018 en orden** (sección 20).
6. Verificar el esquema (`PRODUCCION.md` §3: `users.sessions_valid_from`, `revoked_sessions`, `destinations`).
7. Confirmar los backups automáticos y la retención.
8. Revisar zona horaria y `sql_mode` en el parameter group.
9. Arrancar el backend: `verifyConnection()` confirma la conectividad.
10. Comprobar `GET /api/ready` → `200`.
11. Crear el primer administrador con `npm run admin:bootstrap` desde la instancia, vía Session Manager
    (`PRODUCCION.md` §3). Una sola vez; se niega si ya existe un ADMIN. Después, las pruebas de humo.

Las migraciones se lanzan desde la instancia del backend (que tiene red hasta la base), vía Session Manager y con el
cliente `mysql`. No hace falta bastión.

---

## 7. Storage

### Qué guarda el sistema en disco (verificado en `src/services/file-storage.service.ts`)

| Tipo | Referencia guardada en la base | Límite | Cómo se sirve |
| --- | --- | --- | --- |
| Documentos de empresa (privados) | `documents/<companyId>/<aleatorio>.<ext>` | 5 MB | Endpoint autenticado con alcance de empresa, como descarga |
| Imágenes de destinos | `public/destinations/<id>/<aleatorio>.<ext>` | 5 MB | `GET /api/public/media/<referencia>` |
| Logotipos de empresa | `public/companies/<id>/<aleatorio>.<ext>` | 2 MB | ídem |
| Identidad visual (favicon, etc.) | `public/branding/<activo>/…` | 512 KB (favicon) | ídem y `GET /api/public/branding/favicon` |

- Nombre en disco **aleatorio** (`crypto.randomBytes`); tipo validado por **bytes mágicos**; permisos de archivo
  `0600`.
- La base guarda **referencias relativas**, nunca rutas: la raíz la decide `STORAGE_DIR`
  (`path.resolve(process.cwd(), STORAGE_DIR)`). Una ruta **absoluta** funciona tal cual.
- Consumidores del módulo: 8 archivos (documentos, logotipos, destinos, rutas públicas y middleware de subida). Las
  funciones son **síncronas** (`fs.writeFileSync`, `readFileSync`, `unlinkSync`).

### Comparación

| Criterio | EBS (volumen dedicado) | EFS | S3 |
| --- | --- | --- | --- |
| Cambios en el backend | **Ninguno** (`STORAGE_DIR` apunta al punto de montaje) | Ninguno | **Sí**: API síncrona → asíncrona en el módulo y en sus 8 consumidores, más pruebas |
| Persistencia | Sobrevive a reinicios y redespliegues | Sí | Sí, máxima durabilidad |
| Multi-instancia | ✖ Un volumen solo se monta en una instancia | ✔ | ✔ |
| Backups | Snapshots incrementales (AWS Backup/DLM) | AWS Backup | Versionado y réplica |
| Coste | Bajo | Medio (por GB y acceso) | Bajo |
| Latencia | Disco local | Red (NFS) | Red |
| Simplicidad | Alta | Media | Media (requiere código) |
| Disponibilidad | Atado a una AZ; ante fallo, se adjunta el volumen (o un snapshot) a una instancia nueva | Multi-AZ | Regional |

### Decisión propuesta: **EBS gp3 dedicado** en la primera versión

Es la única opción que pone el sistema en producción **sin tocar código**, y la arquitectura inicial ya es de una sola
instancia por el rate limit y el planificador. EFS solo aporta la multi-instancia, que hoy no se puede aprovechar.
S3 es el destino natural cuando se escale: el módulo ya aísla el almacenamiento y el propio código lo anticipa, pero
exige una fase propia.

- Volumen gp3 **separado del disco raíz**, **cifrado**, montado en `/srv/busperu/storage`, propiedad del usuario del
  servicio y modo `0700`. `STORAGE_DIR=/srv/busperu/storage`.
- El volumen de datos no se destruye al terminar la instancia (*DeleteOnTermination* desactivado).
- Snapshots diarios y uno manual antes de cada despliegue (sección 13).
- Alarma de ocupación del disco (sección 14).

---

## 8. Networking

- **VPC propia** con dos AZ.
- **Subredes públicas** (2 AZ): el ALB y la instancia EC2.
- **Subredes privadas** (2 AZ): RDS.

| Security group | Entrada | Salida |
| --- | --- | --- |
| `sg-alb` | 443 y 80 desde Internet | 3000 hacia `sg-backend` |
| `sg-backend` | **3000 solo desde `sg-alb`**. Sin SSH (Session Manager) | 443 a Internet (Culqi, Resend, OAuth, endpoints de AWS); 3306 hacia `sg-rds` |
| `sg-rds` | **3306 solo desde `sg-backend`** | — |

**Por qué la EC2 va en subred pública sin entrada abierta:** el backend necesita salir a Internet (Culqi, Resend, los
proveedores OAuth, SSM y CloudWatch). En subred privada eso exige un NAT Gateway, que es uno de los costes fijos más
altos de una arquitectura pequeña. En subred pública, con una IP pública y **sin ninguna regla de entrada desde
Internet**, la instancia sigue siendo inalcanzable salvo a través del ALB. Mover la instancia a subred privada con NAT
Gateway (o con endpoints de VPC para los servicios de AWS) es una mejora posterior (**DECISIÓN PENDIENTE**).

### Conectividad de la EC2, demostrada desde la plantilla (F18-03B)

`check-template.mjs` recorre la cadena real y falla si se rompe cualquier eslabón:

| Eslabón | Recurso | Valor |
| --- | --- | --- |
| Subred de la EC2 | `AppInstance.SubnetId` → `PublicSubnetA` | `MapPublicIpOnLaunch: true` → la instancia recibe IPv4 pública |
| Tabla de rutas | `PublicSubnetARoutes` → `PublicRouteTable` | ruta `0.0.0.0/0` → `InternetGateway` |
| Internet Gateway | `GatewayAttachment` | adjunto a la misma `Vpc` |
| NACL | — | la de la VPC por defecto (permite todo); la plantilla no crea NACL propias |
| Salida del SG | `AppSecurityGroup` | 443/tcp a Internet, 123/udp a Amazon Time Sync, 3306 solo hacia `sg-rds` |

**Qué necesita salir, y por dónde (todo HTTPS por el Internet Gateway):**

| Momento | Destino | Para qué |
| --- | --- | --- |
| Bootstrap | `nodejs.org` | Node.js 24.15.0 y su `SHASUMS256.txt` |
| Bootstrap | repositorios de Amazon Linux 2023 | `jq`, `mariadb105`, `amazon-cloudwatch-agent`, `logrotate` |
| Despliegue | S3 (bucket de artefactos) y `registry.npmjs.org` | paquete de la versión y `npm ci --omit=dev` |
| Siempre | SSM / `ssmmessages` | Session Manager |
| Siempre | Parameter Store, Secrets Manager (solo al crear usuarios) | secretos del entorno |
| Siempre | CloudWatch Logs y métricas | log de la API y métricas del agente |
| Ejecución | Culqi, Resend, Google / Microsoft | pagos (en staging, modo prueba), correo y OAuth |
| Ejecución | RDS (dentro de la VPC, ruta `local`) | 3306, solo hacia `sg-rds` |

**NAT: no hace falta.** Todo lo anterior sale por la IP pública de la instancia y el Internet Gateway; la base no
necesita salir a ningún sitio (su SG no tiene salida y su subred no tiene ruta a Internet). Un NAT solo aportaría algo si
la EC2 pasara a una subred privada, y añadiría un coste fijo por hora y por GB procesado. Si alguna vez se usa
`MAIL_TRANSPORT=smtp`, hay que abrir la salida al puerto del servidor SMTP (hoy solo está abierto 443).

**Endpoints de VPC: no hacen falta ahora.** Los de interfaz (SSM, `ssmmessages`, CloudWatch Logs, Secrets Manager)
facturan por hora y por zona, y solo son imprescindibles sin salida a Internet. El de tipo *gateway* para S3 no tiene
coste y mantendría la descarga de artefactos dentro de la red de AWS: mejora opcional, no necesaria.

**Riesgo de la EC2 en subred pública, y cómo se contiene:** tiene IP pública, pero ningún puerto de entrada salvo el
3000 desde el ALB (ni 22, ni `0.0.0.0/0`); IMDSv2 obligatorio; sin clave SSH; y salida limitada a 443, hora y la base.
Lo que no cambia: la IP pública se factura aparte, y si alguien abriera un puerto en el SG quedaría expuesto
directamente, por eso el comprobador rechaza cualquier entrada desde Internet.

### Permisos de la instancia (F18-03B)

Sin políticas gestionadas. `AmazonSSMManagedInstanceCore` concede `ssm:GetParameter(s)` sobre `"*"`, y junto con el
`kms:Decrypt` de Parameter Store la instancia podría leer **cualquier** SecureString de la cuenta.
`CloudWatchAgentServerPolicy` concede creación de grupos de logs, cambio de retención y X-Ray sobre `"*"`. Ambas se
sustituyen por una política propia:

| Declaración | Acciones | Alcance |
| --- | --- | --- |
| Session Manager | `ssm:UpdateInstanceInformation`, `ssmmessages:{Create,Open}{Control,Data}Channel` | `*` (mínimo documentado por AWS; no admiten recurso) |
| Parámetros | `ssm:GetParameter(s)`, `ssm:GetParametersByPath` | solo `/busperu/<env>` y `/busperu/<env>/*` |
| Descifrar | `kms:Decrypt` | solo vía SSM **y** con `kms:EncryptionContext:PARAMETER_ARN` de `/busperu/<env>/*` |
| Logs | `logs:CreateLogStream`, `logs:PutLogEvents`, `logs:DescribeLogStreams` | solo el grupo `/busperu/<env>/app` |
| Métricas | `cloudwatch:PutMetricData` | `*` con `cloudwatch:namespace = CWAgent` |
| Artefactos | `s3:GetObject`, `s3:ListBucket` | solo el bucket de artefactos |
| Secreto maestro | `secretsmanager:GetSecretValue` | solo el secreto de RDS y solo mientras `AllowMasterSecretAccess=true` |

Pendiente de comprobar en staging: que el agente de CloudWatch no pida `ec2:DescribeTags` con esta configuración
(solo usa `InstanceId`, que lee de los metadatos).

Público: CloudFront, ALB. Privado o inalcanzable desde fuera: la EC2 (solo a través del ALB) y RDS (solo desde el
backend). El bucket del frontend no es público (OAC).

---

## 9. Secrets

**Propuesta:** SSM Parameter Store (**SecureString**, cifrado con KMS) para los secretos de la aplicación, bajo el
prefijo `/busperu/prod/`. La contraseña **maestra** de RDS queda en **Secrets Manager**, gestionada por RDS.

| Criterio | Parameter Store | Secrets Manager |
| --- | --- | --- |
| Coste | Nivel estándar sin coste | Coste por secreto y mes |
| Rotación automática | No (manual) | Sí, nativa para credenciales de RDS |
| Uso aquí | Todos los secretos de la app | Credencial maestra de RDS |

**Secretos detectados en el código** (nombres, nunca valores):

`DB_PASSWORD` (usuario de la app), `JWT_SECRET`, `INTEGRATIONS_ENCRYPTION_KEY`, `INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS`
(solo durante una rotación), `CULQI_PRIVATE_KEY`, `CULQI_WEBHOOK_SECRET`, `RESEND_API_KEY` (o `MAIL_PASSWORD` si se
usa SMTP), `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET`.

No son secretos, pero se guardan junto a ellos como parámetros normales: `CULQI_PUBLIC_KEY` (viaja al navegador),
`GOOGLE_CLIENT_ID`, `MICROSOFT_CLIENT_ID`, `FRONTEND_URL`, `OAUTH_CALLBACK_BASE_URL`, `TRUST_PROXY`,
`RESEND_FROM_EMAIL`, `DB_HOST`, `DB_NAME`, `DB_USER`.

**Cómo los consume el backend sin cambiar código:** el backend lee variables de entorno. Un paso previo del servicio
(`ExecStartPre` de systemd) descarga `/busperu/prod/*` con descifrado y escribe un `EnvironmentFile` en `/run`
(tmpfs, propiedad del usuario del servicio, modo `0600`), que no se persiste en disco ni en snapshots.

**Quién puede leerlos:** solo el *instance profile* de la EC2, con `ssm:GetParametersByPath` sobre
`/busperu/prod/*` y `kms:Decrypt` sobre la clave usada. Ninguna persona necesita leerlos para operar.

**Rotación:**

- `JWT_SECRET`: cambiarlo invalida todas las sesiones vivas (se vuelve a iniciar sesión). Procedimiento: actualizar el
  parámetro y reiniciar el servicio.
- `INTEGRATIONS_ENCRYPTION_KEY`: rotación con `INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS` **tal como la implementa el
  código** (`PRODUCCION.md` §2): la vigente pasa a anterior, se crea una nueva, las integraciones se re-cifran al
  volver a guardarse y la anterior se retira cuando ninguna depende de ella. No hay re-cifrado en bloque.
- Credenciales de terceros (Culqi, Resend, OAuth): se rotan en el panel del proveedor, se actualiza el parámetro y se
  reinicia.
- Contraseña del usuario de la app: se cambia en RDS y en el parámetro a la vez, con un reinicio controlado.

---

## 9-ter. Identidad de despliegue (F18-03D)

El despliegue y la operación de staging **no** se hacen con el usuario administrador. Se hacen con un rol
dedicado, creado en F18-03D y definido como código en `infra/aws/iam/`:

```
usuario IAM administrador (Rodrigo) ──sts:AssumeRole──▶ rol /busperu/BusPeruStagingDeployer ──▶ CloudFormation (pila busperu-staging)
```

| Pieza | Valor |
| --- | --- |
| Rol | `arn:aws:iam::<cuenta>:role/busperu/BusPeruStagingDeployer` · sesión máxima 2 h (CloudFormation usa las credenciales de quien lanza la operación, y crear o borrar RDS puede acercarse a una hora) |
| Confianza | **solo** `arn:aws:iam::<cuenta>:user/Rodrigo`. Sin `*`, sin otras cuentas ni roles |
| Permisos | 4 políticas propias en `/busperu/` (`BusPeruStagingDeployerPolicy`, `-Compute`, `-Data`, `-Operate`); **sin** AdministratorAccess ni PowerUserAccess |
| Límite de los roles de la carga | `BusPeruStagingWorkloadBoundary`: todo rol que cree la pila debe llevarlo, o el despliegue no puede crearlo |

**De dónde salen los permisos.** De los *handlers* del registro de CloudFormation para los 29 tipos de recurso
de la plantilla, recortados a las propiedades que la plantilla usa, y contrastados acción por acción (322) con
la *Service Authorization Reference* de AWS: todas existen y las que se acotan a un ARN admiten recurso. Las
lecturas (`Describe/Get/List`) que invocan los handlers se conceden; las escrituras, solo las necesarias.

**Alcance.** Todo va limitado a `sa-east-1` y a los nombres de la plantilla: pila `busperu-staging`, roles e
*instance profiles* `busperu-staging-*`, RDS `busperu-staging-*`, bucket `busperu-staging-artifacts-*`, ALB
`busperu-staging-alb` / `busperu-staging-api`, logs `/busperu/staging/*`, alarmas y tema `busperu-staging-*`,
parámetros `/busperu/staging/*`. Las escrituras sobre recursos EC2 existentes exigen la etiqueta
`aws:cloudformation:stack-name = busperu-staging`, que solo CloudFormation puede poner. La plantilla de
lanzamiento y la política de DLM se acotan con `Project=busperu` y `Environment=staging`.

**Run Command (F18-04).** Para configurar la instancia sin SSH ni *plugin* local, el rol puede usar
`ssm:SendCommand` **solo** con el documento `AWS-RunShellScript` y **solo** sobre instancias con
`aws:cloudformation:stack-name = busperu-staging`; y leer o cancelar resultados (`GetCommandInvocation`,
`ListCommandInvocations`, `ListCommands`, `CancelCommand`, que no admiten ARN) en `sa-east-1`. La instancia no
necesita permisos nuevos: desde SSM Agent 3.3.40.0, Run Command usa el canal `ssmmessages`, que su rol ya tiene
para Session Manager (documentación de AWS, *Reference: ec2messages, ssmmessages, and other API operations*).

**`iam:PassRole`.** Solo `busperu-staging-app-role` hacia `ec2.amazonaws.com` y `busperu-staging-DlmRole-*` hacia
`dlm.amazonaws.com`. Crear roles o escribirles políticas exige el límite de permisos; adjuntar políticas
gestionadas solo admite la de DLM.

**Barreras explícitas (Deny).** Cualquier región distinta de `sa-east-1`; cualquier escritura sobre la VPC por
defecto; administrar usuarios, grupos, claves de acceso, MFA o políticas; tocar la propia identidad de
despliegue (`role/busperu/*`, `policy/busperu/*`); leer o cambiar secretos; `organizations:*` y `account:*`.
**F18-07:** además, borrar la base original (`DeleteDBInstance` sobre `db:busperu-staging-db`, sin condiciones:
aplica también a CloudFormation con las credenciales del rol, de modo que ni un borrado directo ni un borrado o
reemplazo de la pila pueden destruirla); borrar, compartir o exportar snapshots y borrar backups retenidos; y
cualquier restauración con `PubliclyAccessible=true`. `ModifyDBInstance` y `RebootDBInstance` siguen permitidos
(las actualizaciones de la pila los necesitan y RDS no ofrece claves de condición para distinguir un cambio
peligroso). `aws:CalledVia` **no** se usa: la documentación de IAM no garantiza que CloudFormation llame a RDS por
FAS. Análisis completo y diseño para producción en `SECURITY-F18-07.md`.

**`Resource: "*"`.** Solo donde AWS no admite ARN, y siempre documentado en `JUSTIFICACION_COMODIN` de
`build-iam.mjs`: `Describe*` de EC2, ELB y RDS, `ListAllMyBuckets`, `DescribeLogGroups`, `DescribeParameters`,
métricas y listados, `iam:ListRoles`, `ValidateTemplate`, y `dlm:CreateLifecyclePolicy` (este último, con
`aws:RequestTag` obligatorio). KMS casi nulo: las claves gestionadas por AWS (`aws/rds`, `aws/ebs`,
`aws/ssm`) ya autorizan a los principales de la cuenta a través de su servicio (comprobado en sus políticas
de clave). La única excepción es `kms:DescribeKey` con `kms:ViaService = rds.sa-east-1.amazonaws.com`:
con `ManageMasterUserPassword`, RDS describe `aws/secretsmanager` con las credenciales de quien crea la
instancia, y la política de esa clave solo lo permite vía Secrets Manager (F18-04).

**Permisos que ningún handler declara (F18-04).** Algunos servicios invocan otras API con las credenciales
de quien despliega, y no aparecen en los esquemas de CloudFormation: ELB llama a `ec2:GetSecurityGroupsForVpc`
(concedido solo sobre la VPC de la pila) y RDS a `kms:DescribeKey` (arriba). Ambos salieron al desplegar,
uno por intento; si aparece otro, se trata igual: se detiene, se investiga y se añade lo mínimo.

**Validación (F18-03D).** Comprobador local (`check-iam.mjs`, 8/8 controles negativos detectados); IAM Access
Analyzer sin hallazgos en las 6 políticas; simulador de políticas 65/65; y `AssumeRole` real con 25/25 lecturas
permitidas y rechazos esperados, incluida la validación de la plantilla real. CloudTrail confirma que la fase
solo creó IAM.

**Cómo asumirlo.** Nunca con credenciales guardadas en el repositorio:

- Consola: *Switch role* → cuenta, rol `busperu/BusPeruStagingDeployer`.
- CloudShell (en `sa-east-1`, desde la consola del usuario):
  `aws sts assume-role --role-arn arn:aws:iam::<cuenta>:role/busperu/BusPeruStagingDeployer --role-session-name despliegue`
- CLI local: un perfil con `role_arn` y `source_profile`. Hoy **no** hay credenciales de CLI activas: la clave
  de acceso del inventario quedó desactivada en F18-03D (ver §24).

**Recomendado y no aplicado todavía:** exigir MFA en la confianza (`"Bool": {"aws:MultiFactorAuthPresent": "true"}`).
Obliga a pasar `--serial-number` y `--token-code` al asumir el rol desde la CLI; conviene aplicarlo junto con la
decisión sobre cómo se hará el despliegue (§24).

## 10. Authentication/OAuth

- Proveedores: **Google** y **Microsoft** (`src/services/oauth.service.ts`). Flujo de servidor con **PKCE**, `state`
  de un solo uso guardado como hash en la base y `nonce` derivado. Un proveedor sin credenciales queda desactivado.
- `OAUTH_CALLBACK_BASE_URL = https://API_DOMAIN/api`. La guarda exige https pública.
- **Redirect URIs** a registrar en cada consola:
  - `https://API_DOMAIN/api/auth/oauth/google/callback`
  - `https://API_DOMAIN/api/auth/oauth/microsoft/callback`
- Tras el callback, el backend redirige al frontend: `FRONTEND_URL` + `OAUTH_FRONTEND_CALLBACK_PATH` (por defecto
  `/auth/oauth/callback`), que es una ruta del SPA y depende del fallback de CloudFront.
- **Orígenes de JavaScript**: el flujo es de servidor (el navegador navega al backend), así que no hace falta registrar
  orígenes JavaScript para el login.
- Microsoft: `MICROSOFT_TENANT` (por defecto `common`); la app no da de alta cuentas nuevas sin `email_verified`.
- Las variables `GOOGLE_*_URL` y `MICROSOFT_*_URL` de prueba están **prohibidas en producción**: la guarda no deja
  arrancar si se definen.

---

## 11. Payments

- **Culqi**, modelo agregador con una sola cuenta de plataforma. La llave privada no sale del backend; la pública la
  sirve el backend al navegador en `GET /api/culqi/config` (con sesión), así que no hay variable de Culqi en el build
  del frontend.
- **Webhook** a registrar en CulqiPanel: `https://API_DOMAIN/api/culqi/webhook/<CULQI_WEBHOOK_SECRET>`.
  - Culqi no publica un esquema de firma HMAC. La autenticación del webhook es el **secreto en la ruta**, comparado en
    tiempo constante, y la **prueba del pago** es siempre la **relectura del cargo** contra la API de Culqi, que
    comprueba importe, moneda y metadatos (F17C-SEC-03C).
  - El secreto aparece en la URL: el registro de acceso lo oculta (`sanitizeUrl`), y así debe mantenerse en cualquier
    registro adicional del ALB (sección 14).
- **Sandbox frente a live**: la guarda exige que la llave pública y la privada sean del **mismo entorno** (`pk_test`
  con `sk_test`, o `pk_live` con `sk_live`). Pasar a live es una **decisión de negocio** fuera de esta fase.
- La CSP del frontend debe permitir `checkout.culqi.com` y `checkoutview.culqi.com`.

---

## 12. Email

- **Resend**: `MAIL_TRANSPORT=resend`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`. SMTP es la alternativa soportada.
- El remitente debe pertenecer a un **dominio verificado en Resend**. La guarda rechaza `*@resend.dev` en producción.
- DNS del dominio de envío: los registros de **SPF** y **DKIM** que muestre el panel de Resend al verificar el dominio,
  y una política **DMARC** (empezar en `p=none` para observar). Los valores exactos los da Resend.
- Remitente sugerido: `BusPerú <no-reply@MAIL_DOMAIN>`, donde `MAIL_DOMAIN` es el dominio verificado.

---

## 13. Backups

| Qué | Cómo | Frecuencia | Retención propuesta |
| --- | --- | --- | --- |
| Base de datos | Backups automáticos de RDS con **PITR** | Continuo (PITR) + diario | 7–14 días |
| Base de datos, antes de migrar | **Snapshot manual** | Antes de cada migración | Hasta validar el cambio |
| Archivos (`STORAGE_DIR`) | **Snapshots EBS** con AWS Backup o DLM | Diario + antes de cada despliegue | 7–14 días |
| Configuración | Este documento, `PRODUCCION.md` y la definición de la infraestructura en el repositorio | Con cada cambio | Historial de git |
| Secretos | **No se incluyen en backups**. Viven en Parameter Store / Secrets Manager (cifrados con KMS) | — | — |

**Coherencia entre base y archivos:** la base puede recuperarse a un minuto concreto (PITR), pero los archivos solo a
la hora del último snapshot. Una restauración puede dejar referencias a archivos subidos después de ese snapshot:
las imágenes responderían 404 y los documentos no se podrían descargar. Se acepta en la primera versión y se documenta
como parte del RTO.

**RPO / RTO — DECISIÓN DEL PROYECTO PENDIENTE.** Valores de referencia, **no decididos**:

| | Propuesta inicial |
| --- | --- |
| RPO base de datos | ≤ 5 minutos (PITR) |
| RPO archivos | ≤ 24 horas (snapshot diario) |
| RTO | 2–4 horas (restauración manual de RDS y del volumen, con el procedimiento probado) |

**Prueba de restauración** obligatoria antes del go-live: restaurar RDS y un snapshot EBS en recursos aparte y
arrancar el backend contra ellos.

---

## 14. Monitoring

**Registros (verificado):** en producción, el backend escribe **una línea JSON por petición y por error en
`stderr`** (`src/middleware/access-log.middleware.ts`, `src/utils/logger.ts`), sin query string, cabeceras, cuerpo ni
tokens, con los secretos configurados sustituidos por `[REDACTED]`. No escribe archivos de log. Los `audit_logs` van a
la base.

**Diseño:**

- **CloudWatch Agent** en la instancia: envía el `journald` del servicio a un log group `/busperu/prod/api` con
  retención definida (**DECISIÓN PENDIENTE**, p. ej. 30 días), y publica las métricas de **memoria** y **disco**, que
  EC2 no expone por defecto.
- Si se activan los *access logs* del ALB (en S3), incluirán la URL completa del webhook de Culqi **con su secreto**:
  en ese caso el bucket debe ser privado, cifrado y con retención corta.
- **Metric filters** sobre el log group: `"level":"error"`, el aviso del planificador
  (`Algunas reservas vencidas no se pudieron expirar`) y los errores de Culqi (`logError` en el webhook y en la
  conciliación).

**Alarmas mínimas (a un tema SNS):**

| Alarma | Fuente |
| --- | --- |
| Backend caído | ALB `UnHealthyHostCount` > 0 / `HealthyHostCount` < 1; EC2 `StatusCheckFailed` |
| 5xx elevados | ALB `HTTPCode_Target_5XX_Count` y `HTTPCode_ELB_5XX_Count` |
| Latencia | ALB `TargetResponseTime` (p95) |
| Base o almacenamiento no disponibles | ALB `UnHealthyHostCount` > 0 (el health check es `/api/ready`); RDS `DatabaseConnections` anómalo |
| CPU | EC2 y RDS `CPUUtilization` |
| Memoria | CloudWatch Agent (`mem_used_percent`) |
| Disco | Agente: disco raíz y **volumen de `STORAGE_DIR`**; RDS `FreeStorageSpace` |
| Planificador | Metric filter del aviso de expiración fallida |
| Webhook de pagos | Metric filter de errores de Culqi |

---

## 15. Scheduler

**Qué hay (verificado en `src/server.ts` y `booking-expiry.service.ts`):** un `setInterval` en el propio proceso
(`BOOKING_EXPIRY_INTERVAL_MS`, 60 s por defecto) que en cada ciclo expira reservas vencidas, avanza el ciclo de vida
de los viajes y purga tokens y flujos caducados. Se detiene en el cierre ordenado.

**Con una instancia** (esta arquitectura): funciona tal cual.

**Con varias instancias:** cada una ejecutaría su propio ciclo. Las operaciones **no corrompen datos**: expirar usa
`FOR UPDATE` con revalidación dentro de la transacción, los cambios de estado están condicionados y las purgas borran
por caducidad (demostrado con barridos simultáneos en F17C-SEC-06 y SEC-10). Pero:

- el trabajo se repite y aumentan los bloqueos cruzados en la base;
- los registros y las métricas se duplican por instancia;
- no escala linealmente.

Antes de escalar habría que ejecutar el planificador en **una sola** instancia (por ejemplo, una variable que lo
desactive en las demás, o una tarea programada aparte). Es un cambio de código y **no se hace ahora**.

---

## 16. Rate limiting

**Qué hay:** `express-rate-limit` con el almacén **en memoria del proceso**: límite global (300/min por IP) y de
autenticación (20 cada 15 min). La clave es `req.ip`, que depende de `TRUST_PROXY`.

- **Una instancia:** correcto, con `TRUST_PROXY=1` detrás del ALB. Un reinicio pone los contadores a cero.
- **Varias instancias:** cada una cuenta por su lado y el límite efectivo se multiplica por el número de instancias.
  Hace falta un almacén compartido (p. ej. ElastiCache for Redis con el store correspondiente): cambio de código e
  infraestructura, **fuera de la primera versión**.
- Los health checks del ALB pasan por el limitador global. A su frecuencia (una petición cada pocos segundos por nodo
  del ALB) no se acercan al límite.

---

## 17. Health checks

Dos endpoints distintos (F18-02; detalle en `PRODUCCION.md` §3, *Liveness y readiness*):

| Endpoint | Tipo | Comprueba | Respuesta |
| --- | --- | --- | --- |
| `GET /api/health` | **Liveness** | Nada: que el proceso responde | Siempre `200` |
| `GET /api/ready` | **Readiness** | `SELECT 1` por el pool (máx. 2 s) y que `STORAGE_DIR` existe, es un directorio y tiene permisos de lectura, escritura y paso | `200 {"status":"ready"}` / `503 {"status":"not_ready"}` |

`/api/ready` no escribe archivos ni modifica la base, lleva `Cache-Control: no-store` y no revela host, nombre de la
base, rutas ni trazas: el motivo del fallo va solo al registro saneado (CloudWatch Logs).

**Uso recomendado:**

- **Health check del ALB → `/api/ready`**, con umbrales que toleren un corte breve (p. ej. intervalo 15 s, 3 fallos
  para marcar no sano, 2 éxitos para volver). Con una sola instancia no cambia lo que ve el usuario (el ALB, si todos
  los destinos están no sanos, sigue enviándoles tráfico), pero convierte «la base no responde» o «el volumen no está
  montado» en `UnHealthyHostCount` y en una alarma. Con varias instancias, saca del balanceo a la que no puede servir.
- **`/api/health`** para decidir si el **proceso** está colgado (systemd, un reinicio): un fallo de la base no debe
  provocar reinicios en bucle del backend.
- Ambos pasan por el limitador global; a la frecuencia de un health check no se acercan al límite.

---

## 18. Domains

Marcadores de posición; los dominios reales son una **DECISIÓN PENDIENTE**.

| Marcador | Uso | Dónde se configura |
| --- | --- | --- |
| `FRONTEND_DOMAIN` | SPA | CloudFront (alias + certificado ACM en `us-east-1`); DNS |
| `API_DOMAIN` | API | ALB (certificado ACM regional); DNS |
| `MAIL_DOMAIN` | Remitente de correo | Resend (verificación) y DNS (SPF, DKIM, DMARC) |

**Variables que dependen de estas URLs:**

| Variable | Valor de producción | Afecta a |
| --- | --- | --- |
| `FRONTEND_URL` | `https://FRONTEND_DOMAIN` | **Único origen CORS** (normalizado, F17C-SEC-07) y destino del retorno de OAuth |
| `VITE_API_URL` (build del frontend) | `https://API_DOMAIN/api` | Todas las llamadas del SPA y las URLs de imágenes |
| `OAUTH_CALLBACK_BASE_URL` | `https://API_DOMAIN/api` | Redirect URIs de Google y Microsoft |
| Webhook de Culqi | `https://API_DOMAIN/api/culqi/webhook/<secreto>` | Registro en CulqiPanel |
| `RESEND_FROM_EMAIL` | `…@MAIL_DOMAIN` | Remitente verificado |

---

## 19. Environment variables

La tabla completa, con reglas y defaults, está en `PRODUCCION.md` §2 y se ha contrastado con el código
(F17C-SEC-13). Resumen por origen en AWS:

| Grupo | Variables | Origen |
| --- | --- | --- |
| Entorno | `NODE_ENV=production`, `PORT=3000`, `TRUST_PROXY=1` | Parámetro normal |
| Base de datos | `DB_HOST` (endpoint de RDS), `DB_PORT`, `DB_NAME`, `DB_USER` | Parámetro normal |
| | `DB_PASSWORD` | SecureString |
| Sesión | `JWT_SECRET` (`JWT_EXPIRES_IN` opcional) | SecureString |
| Cifrado | `INTEGRATIONS_ENCRYPTION_KEY`; `INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS` solo durante una rotación | SecureString |
| URLs | `FRONTEND_URL`, `OAUTH_CALLBACK_BASE_URL` | Parámetro normal |
| Correo | `MAIL_TRANSPORT=resend`, `RESEND_FROM_EMAIL` / `RESEND_API_KEY` | Normal / SecureString |
| Culqi | `CULQI_PUBLIC_KEY` / `CULQI_PRIVATE_KEY`, `CULQI_WEBHOOK_SECRET` | Normal / SecureString |
| OAuth | `GOOGLE_CLIENT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT` / los `*_CLIENT_SECRET` | Normal / SecureString |
| Almacenamiento | `STORAGE_DIR=/srv/busperu/storage` | Parámetro normal |
| Frontend (build) | `VITE_API_URL` | Variable del proceso de build; no es secreta |

---

## 19-bis. Infraestructura como código y runbook (F18-03)

El diseño de este documento está escrito como plantilla y guiones reproducibles, **todavía no
ejecutados en AWS** (en la máquina de desarrollo no hay CLI ni credenciales):

| Archivo | Qué hace |
| --- | --- |
| `infra/aws/cloudformation/build-template.mjs` | Genera `busperu-staging.json`: VPC, security groups, RDS MariaDB 10.11 privada y cifrada, EC2 sin SSH, EBS de datos con snapshots (DLM), ALB con health check en `/api/ready`, bucket de artefactos, logs y 12 alarmas |
| `infra/aws/cloudformation/check-template.mjs` | Comprueba referencias y las reglas de seguridad antes de desplegar |
| `infra/aws/scripts/inventory.sh` | Inventario de solo lectura de la cuenta (paso obligatorio previo) |
| `infra/aws/scripts/create-db-users.sh` | `busperu_app` y `busperu_migrator` con privilegios mínimos |
| `infra/aws/scripts/apply-migrations.sh` | Dump + 001→018 sin `--force`, con el usuario migrador |
| `infra/aws/scripts/schema-fingerprint.cjs` | Compara el esquema con la referencia validada en F18-02B |
| `infra/aws/scripts/bootstrap-ec2.sh` | Node 24.15.0 verificado, usuario sin privilegios, EBS en `/data`, systemd, agente de CloudWatch |
| `infra/aws/scripts/deploy-release.sh` | Despliegue atómico con verificación SHA-256 y vuelta atrás automática si no hay readiness |
| `infra/aws/scripts/render-env.sh` | Secretos de Parameter Store a un archivo tmpfs 0600 para systemd |
| `infra/aws/scripts/smoke-staging.mjs` | 31 pruebas de humo contra el entorno desplegado |
| `docs/production/STAGING-RUNBOOK.md` | El procedimiento completo, paso a paso |

## 20. Deployment sequence

Orden para F18-03 en adelante. Coincide con `PRODUCCION.md` §11, concretado en AWS.

1. **Decisiones previas**: dominios, RPO/RTO, `sql_mode`, Multi-AZ, tamaños (sección 24).
2. **Validaciones previas**: resueltas. Alta del primer administrador y readiness (F18-02); **MariaDB 10.11 + strict
   mode VALIDATED** sobre un 10.11.19 real (F18-02B). En RDS quedan solo las pruebas de humo.
3. **Red**: VPC, subredes públicas y privadas en dos AZ, security groups.
4. **Certificados ACM**: `API_DOMAIN` en la región y `FRONTEND_DOMAIN` en `us-east-1`; validación por DNS.
5. **RDS**: parameter group, subnet group, instancia cifrada, backups y deletion protection.
6. **Secretos** en Parameter Store; IAM del *instance profile*.
7. **EC2**: instancia, volumen EBS de datos montado en `STORAGE_DIR`, Node 24, CloudWatch Agent, unidad systemd.
8. **Base**: importar el dump, **snapshot manual**, aplicar **001 → 018**, verificar el esquema, crear los usuarios.
9. **Backend**: desplegar el build y arrancar; las guardas deben pasar.
10. **ALB** con los oyentes 443/80 y el grupo de destino; health check en verde.
11. **Frontend**: build con `VITE_API_URL`, subida a S3, distribución CloudFront con el fallback y las cabeceras.
12. **DNS** de `FRONTEND_DOMAIN` y `API_DOMAIN`.
13. **Integraciones**: redirect URIs de OAuth, dominio de Resend, webhook de Culqi (entorno de pruebas).
14. **Backups**: plan de AWS Backup/DLM para el volumen; **prueba de restauración**.
15. **Alarmas** de CloudWatch y su tema SNS.
16. **Pruebas de humo**: login, búsqueda, reserva, panel de empresa, subida y lectura de una imagen, pago de prueba en
    Culqi, correo de recuperación.
17. **Habilitar el tráfico.**

---

## 21. Rollback strategy

| Componente | Cómo se vuelve atrás |
| --- | --- |
| Backend | Conservar el build anterior en su propio directorio y apuntar a él (enlace simbólico + reinicio del servicio). Snapshot del volumen de datos antes de cada despliegue |
| Frontend | Volver a publicar el artefacto anterior (o una versión anterior del bucket, con el versionado de S3 activado) e invalidar `/index.html` en CloudFront |
| Base de datos | **Las migraciones son solo hacia delante**: no hay scripts de vuelta. Volver atrás significa restaurar el snapshot manual previo (o PITR), **perdiendo lo escrito después**. Por eso cada migración debe ser compatible con la versión anterior del backend siempre que se pueda: `017` es aditiva y el código anterior ignora la columna |
| Configuración | Parameter Store guarda el historial de versiones de cada parámetro |
| Archivos | Restaurar un snapshot EBS (con la limitación de coherencia de la sección 13) |

---

## 22. Security considerations

Ya garantizado por el código (auditorías F17C): guardas de arranque en producción, JWT con algoritmo fijado,
revocación por JTI y terminación de sesiones al suspender, RBAC y aislamiento entre empresas (también al crear
reservas), CORS de origen único, cabeceras de Helmet, rate limit, cifrado AES-256-GCM de credenciales de integraciones
con rotación, registros saneados, conciliación de pagos por relectura del cargo.

Lo que aporta esta arquitectura:

- Base de datos **sin acceso público**, cifrada, con un usuario de aplicación de privilegios mínimos.
- EC2 **sin puertos de entrada desde Internet**, administrada por Session Manager.
- Secretos en Parameter Store / Secrets Manager, leídos solo por el rol de la instancia y nunca escritos en disco
  persistente.
- TLS en CloudFront y en el ALB (ACM); HTTP redirigido a HTTPS; HSTS.
- Bucket del frontend privado (OAC); volumen de datos y backups cifrados.

Pendiente antes de guardar datos reales:

- **Cifrado de los datos bancarios** (`company_bank_accounts.account_number`, `interbank_code`, hoy en claro): debe
  hacerse **antes de almacenar cuentas bancarias reales**. Los snapshots de RDS los contendrían en claro.
- CSP del frontend pasada de *Report-Only* a obligatoria tras observar los informes.

---

## 23. Cost considerations

Estimación cualitativa, sin precios. Los tamaños exactos son una **DECISIÓN PENDIENTE**.

| Componente | Coste | Nota |
| --- | --- | --- |
| Frontend (S3 + CloudFront) | LOW | Estático, con caché |
| Backend (una EC2 pequeña + IP pública) | LOW–MEDIUM | Depende del tamaño de la instancia |
| ALB | MEDIUM | Coste fijo por hora, aunque haya poco tráfico. La alternativa (nginx y certificado en la propia EC2) es más barata, pero pierde los health checks gestionados y el certificado ACM |
| RDS MariaDB | MEDIUM | **Multi-AZ lo duplica aproximadamente** |
| Almacenamiento EBS | LOW | gp3 y snapshots incrementales |
| Transferencia | LOW–MEDIUM | Crece con el tráfico y las imágenes |
| Monitorización (CloudWatch) | LOW | Depende del volumen de logs y de la retención |
| Backups | LOW | Retención de 7–14 días |
| **NAT Gateway** (si se elige EC2 en subred privada) | **MEDIUM–HIGH** | Coste fijo notable: por eso esta propuesta no lo usa (sección 8) |
| Redis/ElastiCache (si se escala) | MEDIUM | Solo con varias instancias |

---

## 24. Open decisions

### Bloqueantes para el go-live

- **Cifrado de los datos bancarios** antes de guardar cuentas reales (fase propia).
- **Prueba de restauración** de la base y del volumen.

### Decisiones requeridas

- Dominios: `FRONTEND_DOMAIN`, `API_DOMAIN`, `MAIL_DOMAIN`, y cuál es el canónico (raíz o `www`). **Sigue pendiente y bloquea HTTPS y la publicación** (F18-03).
- RPO / RTO definitivos y retención de backups y de logs.
- `sql_mode` de RDS: se recomienda el estricto por defecto de 10.11, validado con la batería completa sobre 10.11.19 (F18-02B).
- Multi-AZ en RDS.
- Tamaños de EC2 y RDS. **Región decidida: `sa-east-1` (São Paulo)**, la más cercana a Perú (F18-03).
- EC2 en subred pública sin entrada (propuesta, **revisada en F18-03B**: funciona sin NAT y con salida limitada) o privada con NAT Gateway / endpoints de VPC.
- ALB (propuesta) o terminación TLS en la propia instancia.
- Exigir TLS entre el backend y RDS (requiere cambio de código).
- Paso de Culqi a live (negocio).
- **Cómo se ejecuta el despliegue (F18-03D):** la clave de acceso administrativa quedó desactivada. Opciones:
  CloudShell desde la consola; IAM Identity Center; o una clave nueva, rotada, solo para asumir el rol (con MFA).
- Exigir MFA en la confianza de `BusPeruStagingDeployer`.

### Deuda técnica

- Resueltos en F18-02: `npm run admin:bootstrap` y `GET /api/ready`. Resuelto en F18-02B: compatibilidad con MariaDB 10.11 (migraciones 009/010 + 018, `row_number`, columnas JSON).
- Los procesos hijo de las suites 17 y 78 no heredan `TEST_SQL_MODE`: esa parte se ejecuta con el modo del servidor.
- Opción `ssl` del pool de `mysql2` si se exige TLS hacia RDS.
- `engines` en el `package.json` del backend para fijar la versión de Node.
- `database/migrations/PENDIENTES.md` desactualizado (llega hasta `014`).
- Documentar en `PRODUCCION.md` que la versión mínima de Node no está verificada por debajo de 22.

### Mejoras futuras

- Archivos en **S3** (módulo de almacenamiento asíncrono) cuando se necesiten varias instancias.
- Rate limit con almacén compartido y planificador en una sola instancia; después, escalado horizontal (ECS o grupo
  de autoescalado).
- CloudFront delante de la API (con `TRUST_PROXY=2`) y AWS WAF.
- Auditoría de las transiciones automáticas pendientes (F17C-SEC-12 §6).
- Índice `(status, expires_at)` en `bookings` cuando crezca el volumen.

---

## 25. AWS deployment checklist

- [ ] Decisiones de la sección 24 tomadas y registradas (región: `sa-east-1`, decidida en F18-03).
- [ ] Inventario previo de la cuenta ejecutado (`infra/aws/scripts/inventory.sh`) y revisado.
- [x] Suite completa en verde sobre MariaDB 10.11 real con el `sql_mode` estricto (F18-02B: 10.11.19, 3/3).
- [ ] Primer administrador creado con `npm run admin:bootstrap`; ninguna cuenta de prueba en la base.
- [ ] VPC, subredes y security groups según la sección 8; RDS sin acceso público.
- [ ] Certificados ACM emitidos (`us-east-1` para CloudFront, regional para el ALB).
- [ ] RDS cifrada, con backups automáticos, PITR y deletion protection; parameter group revisado.
- [ ] Usuario de aplicación con privilegios mínimos; usuario de migraciones separado.
- [ ] Dump importado, snapshot manual, migraciones **001 → 018** aplicadas en orden y esquema verificado.
- [ ] Secretos en Parameter Store; instance profile con acceso mínimo; nada de secretos en disco persistente.
- [ ] EC2 con Node 24, systemd y CloudWatch Agent; `STORAGE_DIR` en un volumen EBS dedicado y cifrado.
- [ ] Backend arranca con `NODE_ENV=production` sin errores de guarda; `TRUST_PROXY=1`.
- [ ] ALB con HTTPS, redirección de HTTP y health check en `/api/ready` en verde.
- [ ] Frontend construido con `VITE_API_URL=https://API_DOMAIN/api`, en S3 privado + CloudFront con fallback de SPA y
      cabeceras (CSP en Report-Only).
- [ ] DNS de `FRONTEND_DOMAIN` y `API_DOMAIN`; un único dominio canónico para `FRONTEND_URL`.
- [ ] Redirect URIs de OAuth registradas; dominio de Resend verificado (SPF, DKIM, DMARC); webhook de Culqi registrado.
- [ ] Plan de snapshots del volumen y **restauración probada** de base y archivos.
- [ ] Alarmas de CloudWatch activas y notificando.
- [ ] Datos bancarios cifrados antes de guardar cuentas reales.
- [ ] Pruebas de humo completas; despliegue desde una versión etiquetada.
