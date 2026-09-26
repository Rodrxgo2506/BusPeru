# F18-18 — Preparación de producción (infraestructura como código)

> **Estado: PRODUCTION INFRASTRUCTURE PREPARED — NOT DEPLOYED.**
>
> **Qué NO se hizo:**
> - no se creó ningún recurso de producción: ni pila, ni RDS, ni EC2, ni ALB, ni CloudFront, ni certificado, ni DNS, ni parámetro;
> - no se activaron Resend ni Culqi LIVE, no hubo pagos ni correos reales, ni migraciones en producción;
> - ningún cambio destructivo, sin commit y sin push.
>
> Las consultas a AWS fueron de solo lectura, con la sesión MFA del administrador. Cuenta 6578****68. Sin secretos,
> IP de operador ni credenciales en este documento. Fecha: 2026-09-25. Base: commit `0120415` (= `origin/master`).

## 1. Resumen

| Tarea autorizada | Resultado |
| --- | --- |
| Conciliar migraciones 001–019 | **Hecho.** Ningún archivo del repo decía «001–014». Lo desfasado era `README.md` y `PRODUCCION.md` (hasta 018) y `PENDIENTES.md` (012–014 «pendientes»). Corregido, más un inventario nuevo, `MIGRATIONS.md`. Idempotencia probada: 19/19 reaplicadas |
| IaC de producción | **Hecho.** Tres generadores y sus JSON (`busperu-prod`, `busperu-prod-web`, `busperu-prod-observability`) y el comprobador `check-prod-templates.mjs` (14/14 mutaciones detectadas). `validate-template` de AWS: OK en las tres |
| CSP | **Hecho** en la plantilla de producción. Validada contra staging en Chrome: **0 violaciones en 20 páginas** (11 públicas y 9 del panel ADMIN) y con Culqi Checkout v4; los scripts en línea quedan bloqueados |
| Publicación del frontend | **Hecho:** `infra/aws/scripts/publish-web.mjs` (simulación por defecto). Simulación contra staging en PASS; 2 pruebas negativas detenidas |
| `.gitattributes` | **Hecho.** `* text=auto eol=lf`; el índice no cambia. 115 archivos de la copia de trabajo en CRLF por `autocrlf` se reescribieron en LF desde el índice, con el hash comprobado |
| Parámetros de producción | **Hecho, sin valores:** manifiesto con 40 parámetros (16 obligatorios) y `prod-parameters.mjs` (`plan`, `verificar` con solo metadatos, `generar` y `fijos` con simulación por defecto) |
| Observabilidad | **Hecho:** 14 alarmas de infraestructura en `busperu-prod`; 5 filtros y alarmas de aplicación y un presupuesto en `busperu-prod-observability`. Filtros probados con `test-metric-filter`: 5/5 |
| Deployment y rollback | **Hecho:** `PRODUCTION-RUNBOOK.md`; checklist de F18-17 corregido |
| Base `busperu_prod` (D-01) | aplicado en plantillas, manifiesto y scripts; los scripts de base de datos ya lo usaban por defecto |
| **B-10: bootstrap de la base** (decisión del propietario) | **Diseñado e implementado como código:** el runtime conserva su `Deny secretsmanager:*` y un rol aparte, temporal y mínimo (`busperu-prod-db-bootstrap`) crea los usuarios con `prod-db-bootstrap.sh` por un túnel de Session Manager. Detalle en §3.7 |
| **B-11: comisión** | **Sigue pendiente:** no se asignó ningún porcentaje |

## 2. Migraciones 001–019 (conciliación)

Inventario completo, estado por base e idempotencia en `docs/production/MIGRATIONS.md`. Qué hacen 015–019:

| # | Qué hace | Riesgo en producción |
| --- | --- | --- |
| 015 | CMS de destinos: `destinations`, `destination_attractions` y `destination_festivities`, y claves `branding.*`. Pasa de 46 a **49 tablas** | ninguno: `IF NOT EXISTS` / `INSERT IGNORE` |
| 016 | Ficha de destino: altitud, temperatura, tiempo de viaje, horarios, imagen del calendario y 2 FK a `locations` (`SET NULL`); `schedule` y `weather` quedan obsoletas **sin borrarse** | ninguno (guardada por `information_schema`) |
| 017 | `users.sessions_valid_from DATETIME NULL`: suspender una cuenta invalida sus tokens. **El middleware la lee en cada petición** | obligatoria; sin relleno (`NULL` no restringe) |
| 018 | FK `fk_integrations_company` y `fk_bus_layouts_bus` a `ON UPDATE RESTRICT`: requisito de MariaDB 10.11 | en una instalación nueva no hace nada |
| 019 | Columnas cifradas y `*_last4` en `company_bank_accounts`; `account_number` admite `NULL`. Cifrado AES-256-GCM con `INTEGRATIONS_ENCRYPTION_KEY` | obligatoria; la clave pasa a ser **obligatoria** (sin ella, las cuentas bancarias responden 503). `bank:encrypt` no hace falta en una base nueva |

**Verificaciones:**

- Reaplicar las 19 sobre `busperu_1011_test` (10.11.19) ya migrada: **19/19 OK**.
- Después, `schema-fingerprint.cjs` idéntico a la referencia: 49 tablas, 496 columnas, 221 índices, 81 FK y 12 CHECK.

No se ejecutó ninguna migración en staging ni en producción.

## 3. Hallazgos tratados

### 3.1 CSP ausente y sesión en `localStorage`

**Estudio:**

- El SPA no tiene scripts en línea (`index.html` de Vite: un módulo y una hoja).
- Orígenes externos que usa el código:

  | Origen | Para qué |
  | --- | --- |
  | `checkout.culqi.com` | script de Culqi Checkout |
  | `checkoutview.culqi.com` | iframe de pago (descubierto en la prueba) |
  | Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`) | hoja de estilos y fuente |
  | Wikimedia Commons (`commons.wikimedia.org` → `thumb.wikimedia.org`) | fotos |
  | La API | imágenes, favicon y `fetch` |

- `style=` de React y los estilos que inyectan Culqi y las gráficas necesitan `'unsafe-inline'` **solo en `style-src`**.

**Cambio mínimo:**

- La cabecera CSP se sirve desde CloudFront (`AWS::CloudFront::ResponseHeadersPolicy` en `busperu-prod-web`).
- **Sin tocar el código del frontend ni la autenticación.**
- `script-src 'self' https://checkout.culqi.com`, sin `unsafe-inline` ni `unsafe-eval`.
- `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'` y `form-action 'self'`.
- Además: HSTS de 1 año, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` y `Permissions-Policy`.

**Prueba (sin cambiar CloudFront):**

- Chrome headless contra staging, con la cabecera inyectada por CDP.
- Se usó **la política exacta que exporta el generador**, con el origen de la API de staging.

| Paso | Resultado |
| --- | --- |
| Rutas públicas | 11: `/`, `/destinos`, `/empresas`, `/ofertas`, `/buscar`, `/ayuda`, `/login`, `/registro`, `/empresa/login`, `/admin/login` y la 404 |
| Panel ADMIN | 9 secciones: `dashboard` (gráficas), `companies`, `users`, `trips`, `bookings`, `payments`, `destinations` (imágenes), `settings` y `reports` |
| Culqi Checkout v4 | llave pública ficticia, sin reserva ni cargo: el script carga y el iframe `checkoutview` abre |
| Resultado | **0 violaciones, 0 errores de consola**; fuente Inter e imágenes cargadas (0 rotas) |
| Control positivo | un script en línea **se bloquea** |
| Sesión | 1 login y 1 logout de ADMIN; token revocado (`/auth/me` → 401) |

Hubo que añadir dos orígenes que no salían del código: `checkoutview.culqi.com` y los hosts de redirección de Wikimedia (`*.wikimedia.org`).

**Cookies:** no se migra en esta fase. No hay una necesidad técnica demostrada:

- el token Bearer en `localStorage` no expone al CSRF;
- el riesgo que queda, XSS, lo reduce la CSP.

**Mantenimiento:** `check-prod-templates.mjs` extrae los orígenes externos del código (`culqi.ts`, `images.ts` e `index.html`) y **falla** si uno no está permitido o si aparece un origen nuevo sin revisar.

### 3.2 Clave de acceso IAM activa

Inspección de solo lectura, sin mostrar la clave:

| Dato | Resultado |
| --- | --- |
| Usuario | `Rodrigo`, único usuario IAM. MFA desde 2026-09-22. Grupo `ADMINISTRACION` con 11 políticas gestionadas, entre ellas `AdministratorAccess` |
| Clave | 1 clave (`AKIA…TOYB`), **Active**, creada el 2026-09-23 |
| Último uso | 2026-09-25, servicio **sts** |
| Qué pasó | F18-08 la dejó **Inactive**. CloudTrail registra `UpdateAccessKey` hasta el 2026-09-24 22:28Z: se reactivó para las sesiones MFA de F18-12→F18-18 |
| Uso desde la reactivación | **solo `GetSessionToken`** (7 veces, todas **con MFA**, 3600 s, desde el rango del operador). Ninguna llamada directa a otra API. Las llamadas directas del 2026-09-24 (change set, `ValidatePolicy`, `SimulateCustomPolicy`) son del trabajo de F18-08, el mismo día |

**Conclusión:** la clave es hoy solo el medio para obtener la sesión MFA. Sin ella, la CLI con MFA de este flujo no funciona. Se puede sustituir así:

1. **IAM Identity Center** (recomendado a medio plazo). Requiere AWS Organizations (decisión B-08). Con él, `aws sso login` da credenciales temporales y la clave se elimina.
2. **Mitigación inmediata sin Organizations:** una política en el usuario o en el grupo que **deniegue todo salvo `sts:GetSessionToken` y la autogestión de MFA cuando no hay MFA** (`BoolIfExists aws:MultiFactorAuthPresent = false`). La clave deja de servir sin el código MFA.
3. Mientras tanto: desactivarla al terminar cada ventana de trabajo, como en F18-08.

No se desactivó, borró ni modificó nada. Hallazgos adicionales:

- **Sin política de contraseñas IAM.**
- El grupo tiene políticas ajenas a BusPerú (p. ej. `AccountManagementFromVercel` y `AIDevOps*`). Hay que revisar el mínimo privilegio.

### 3.3 Limitador de peticiones en memoria

**El despliegue inicial es de una sola instancia**, como en F18-08 («Initial production uses one API instance»):

- `busperu-prod` crea **exactamente una** EC2, con protección contra terminación y sin grupo de autoescalado.
- El comprobador **falla** si aparece una segunda.

Límites que quedan documentados (runbook §1 y manifiesto de parámetros):

- `express-rate-limit` en memoria: global 300/min y auth 20/15 min.
- El planificador de expiración también vive en memoria.

No se añade Redis ni ninguna otra infraestructura: con una instancia no hace falta. Escalar exige una fase aparte con almacén compartido y elección de líder.

**Nota:** con CloudFront → ALB, `TRUST_PROXY=2`, igual que staging. Así el límite se aplica por IP del visitante.

### 3.4 Publicación del frontend fuera del repo

`infra/aws/scripts/publish-web.mjs` sustituye al auxiliar de sesión de F18-09…F18-16.

**Cómo funciona:**

- Toma el bucket, la distribución y la API **de la pila `busperu-<env>-web`**, así que es imposible publicar un build en el entorno equivocado.
- Revisa el bundle: la URL de su API; ni `localhost` ni el otro entorno; sin source maps ni secretos.
- Escribe un manifiesto SHA-256.
- Con `--ejecutar`:
  - sube `assets/` como inmutables e `index.html` como `no-cache`, sin `--delete`;
  - verifica el tamaño, el MD5 (ETag), el Content-Type y el Cache-Control;
  - invalida solo `/` y `/index.html`.
- La cuenta nunca aparece ni en la salida ni en el manifiesto.

**Pruebas:**

- Simulación contra staging: PASS, 96 archivos.
- Bundle con el dominio de producción publicado en staging: **DETENIDO**.
- Bundle con un `.map`: **DETENIDO**.
- `--env prod` hoy: **DETENIDO**, porque la pila no existe.

### 3.5 `.gitattributes`

La instalación de Git para Windows tiene `core.autocrlf=true`: 115 archivos de la copia de trabajo estaban en CRLF, entre ellos 4 migraciones y el dump, que `make-release.sh` empaqueta para Linux.

**Qué se hizo:**

- `.gitattributes` con `* text=auto eol=lf` y los binarios marcados.
- El índice ya era 100 % LF, así que **no hay diferencias de contenido**.
- Los 115 archivos sin cambios locales se reescribieron desde el índice, comprobando que el hash de cada uno coincide con el del índice.

**Resultado:**

- 424/424 archivos en LF.
- Un paquete de prueba de `make-release.sh`: 170 entradas, **0 archivos con CR**, sin `.env`, `node_modules`, `storage` ni mapas.

### 3.6 Infraestructura de producción como código

| Pila | Recursos | Quién la despliega | Claves |
| --- | --- | --- | --- |
| `busperu-prod` | 49 | operador + `BusPeruProdCloudFormationExecution` | ver abajo |
| `busperu-prod-web` | 8 | administrador con MFA | ver abajo |
| `busperu-prod-observability` | 11 | administrador con MFA | 5 filtros de métrica (errores, fatales, expiración, correo, webhook de Culqi) con sus alarmas, y un presupuesto mensual con avisos al 80 % real y al 100 % previsto |

**`busperu-prod`:**

- **Red:**
  - VPC 10.30.0.0/16 (staging es 10.20.0.0/16);
  - ALB solo en 443, solo desde la prefix list de CloudFront (`pl-5da64334`);
  - 403 por defecto y una sola regla con la cabecera secreta; **sin HTTP ni IP de operador**.
- **RDS:**
  - MariaDB 10.11.19 privada con `alias/busperu-prod-rds`;
  - `DeletionProtection` fija y 14 días de backups;
  - autoescalado de almacenamiento y logs `error` + `slowquery`.
- **EC2:**
  - una sola instancia, con IMDSv2 y protección contra terminación;
  - usa el rol **existente** `busperu-prod-app-role` a través del perfil `busperu-prod-app-profile`.
- **Datos:** EBS cifrado con DLM de 14 copias; bucket de artefactos y `/busperu/prod/app` (90 días) con `Retain`.
- **Alarmas:** 14, hacia el tema **existente** `busperu-prod-alarms`.

**`busperu-prod-web`:**

- **Frontend:** bucket privado `busperu-prod-web-<cuenta>` leído solo por OAC.
- **Distribución web:** `busperuonline.pe` y `www`, con el certificado de us-east-1, TLS 1.2 y la **CSP**.
- **Distribución API:** `api.busperuonline.pe` hacia el ALB por HTTPS. Reenvía el Host, porque el ALB presenta el certificado de `api` en sa-east-1. Keepalive de 55 s, sin caché ni páginas de error.
- **Función de visor:** redirige `www` → raíz y, con `ViewerAccess=operators` (valor por defecto), limita el acceso a las IP de operador antes del go-live.

**Por qué tres pilas.** El rol de ejecución de producción (F18-08) no tiene permisos de CloudFront, `logs:PutMetricFilter` ni Budgets. Además, solo actúa sobre la pila `busperu-prod`.

`busperu-prod-web` sustituye al nombre provisional `busperu-prod-edge` de F18-08. No hace falta una pila en us-east-1: CloudFront acepta el certificado de us-east-1 por ARN.

**Separación de staging, exigida por el comprobador:**

- sin la palabra «staging» ni el CIDR, las distribuciones, la instancia ni los buckets de staging;
- sin IDs de cuenta, IP literales ni secretos;
- todo nombre empieza por `busperu-prod-` o `/busperu/prod/`;
- etiquetas `Project=busperu` y `Environment=prod`;
- solo tipos que el rol de ejecución puede crear, con los nombres que admiten sus políticas.

Scripts de la instancia (cambio mínimo; sin `--env`, staging sigue igual):

| Script | Cambio |
| --- | --- |
| `bootstrap-ec2.sh` | acepta `--env staging\|prod`, escribe `/etc/busperu/env` y fija el grupo de logs `/busperu/<env>/app` en el agente de CloudWatch. **Se niega si el perfil de la instancia no es `busperu-<env>-…`** |
| `render-env.sh` | valida `BUSPERU_ENV` y comprueba el perfil de la instancia: una EC2 de producción nunca arranca con los parámetros de staging, ni al revés. Probado con 5 casos: 2 aceptados y 3 rechazados |
| `busperu-api.service` | lee `EnvironmentFile=-/etc/busperu/env` |
| `create-db-users.sh` | `DB_USER_HOST` por defecto `10.30.%` en producción |
| `make-release.sh` | incluye `PRODUCTION-RUNBOOK.md` y `MIGRATIONS.md` |

**Simulador de IAM** sobre el rol de ejecución **real**, de solo lectura y con contexto `aws:RequestedRegion=sa-east-1`:

| Acciones | Resultado |
| --- | --- |
| `ec2:CreateVpc`, `rds:CreateDBInstance` / `CreateDBSubnetGroup` / `CreateDBParameterGroup` con los nombres de la plantilla | `allowed` |
| `kms:CreateGrant` / `GenerateDataKeyWithoutPlaintext` / `Decrypt` de la CMK `rds` vía RDS | `allowed` |
| `elasticloadbalancing:CreateListener` en `busperu-prod-alb` | `allowed` |
| `s3:CreateBucket` de artefactos, `logs:CreateLogGroup` de `/busperu/prod/app`, `cloudwatch:PutMetricAlarm` | `allowed` |
| `dlm:CreateLifecyclePolicy` con etiquetas de producción, `secretsmanager:CreateSecret` `rds!db-*` | `allowed` |
| `iam:CreateInstanceProfile`, `iam:PassRole` de la app a EC2 | `allowed` |
| `logs:PutMetricFilter`, `cloudfront:CreateDistribution`, bucket de staging | **denegado**, como se esperaba |
| `rds:DeleteDBInstance` de `busperu-prod-db` | **denegado explícitamente** (barrera) |
| `acm:DescribeCertificate` | `implicitDeny`: ver R-02 |

**`validate-template` de AWS:** las tres son válidas. `busperu-prod` requiere `CAPABILITY_NAMED_IAM`, y ya está en el runbook.

### 3.7 B-10 — bootstrap de la base, separado y temporal

**Decisión del propietario:** mantener el `Deny secretsmanager:*` del runtime de la EC2. Por eso se descarta el
procedimiento de F18-08, que consistía en dar al rol de la instancia una política temporal.

**Implementación (solo código, nada desplegado):**

| Pieza | Qué es |
| --- | --- |
| `build-prod-db-bootstrap-template.mjs` → `busperu-prod-db-bootstrap.json` | Pila **temporal** con un único rol, `busperu-prod-db-bootstrap` (detalle abajo) |
| `infra/aws/scripts/prod-db-bootstrap.sh` | Procedimiento en CloudShell, simulación por defecto (detalle abajo) |
| `create-db-users.sh` | mensaje final según el entorno; con `BUSPERU_ENV=prod`, usuarios en `10.30.%` por defecto |
| `check-prod-templates.mjs` | reglas del bootstrap (6/6 mutaciones detectadas) y exigencia de que el rol de la app **conserve** su `Deny` |
| `PRODUCTION-RUNBOOK.md` §5.3 | procedimiento completo |

**El rol `busperu-prod-db-bootstrap`:**

- **Quién:** solo el administrador, con MFA de menos de 1 h, nombre de sesión fijo y sesiones de 1 h como máximo.
- **Secrets Manager:** `Get`, `Describe` y `Rotate` **solo** del secreto maestro de RDS; nunca escribirlo ni borrarlo.
- **KMS:** `Decrypt` solo a través de Secrets Manager.
- **Túnel:** `ssm:StartSession` **solo** con `AWS-StartPortForwardingSessionToRemoteHost` y solo en la instancia de producción.
- **Todo lo demás:** `Deny` explícito.

**`prod-db-bootstrap.sh`:**

1. Comprueba las dos identidades (el rol temporal y el operador), las salidas de `busperu-prod` y que los parámetros de destino no existan.
2. Genera las dos contraseñas en `/tmp`.
3. Lee el maestro y abre el túnel hasta RDS.
4. Ejecuta `create-db-users.sh` por el túnel.
5. Guarda las contraseñas en SSM **con el operador**, que solo cifra.
6. **Rota el maestro**.
7. Destruye los temporales.

Al terminar, el administrador borra la pila.

**Ensayo local:** `create-db-users.sh` en modo producción contra MariaDB 10.11.19.

- Usuarios en `10.30.%` con privilegios mínimos.
- Contraseñas guardadas idénticas byte a byte a las generadas, sin salto de línea.
- Usuarios del ensayo eliminados después.

**Pendiente:**

- `validate-template` y `accessanalyzer validate-policy` de esta plantilla: la sesión MFA caducó.
- Verificar en la primera ejecución real que la rotación de un secreto gestionado por RDS solo necesita `secretsmanager:RotateSecret`.

### 3.8 Parámetros de producción

`infra/aws/parameters/prod-parameters.json` recoge, **sin valores**:

- cada parámetro con su tipo, su CMK y su origen (`fijo`, `generado`, `pila` o `propietario`);
- los prohibidos: URLs de proveedores de prueba, `NODE_ENV` y `MAIL_PASSWORD`.

Cubre todas las variables de `backend/.env.production.example` salvo `NODE_ENV`, que fija la unidad systemd.

`prod-parameters.mjs verificar` contra la cuenta: **0 parámetros en `/busperu/prod/`** (esperado) y la lista de los 16 obligatorios que faltan. Solo lee metadatos: nunca descifra.

`generar` produce valores en los formatos que aceptan los guards:

- contraseñas de base de datos de 43 caracteres;
- JWT de 64 caracteres;
- claves de 32 bytes en hex.

Siempre con `--no-overwrite` y sin imprimir el valor.

## 4. Cambios realizados (exactos)

**Modificados (10):**

| Archivo | Cambio |
| --- | --- |
| `.gitignore` | `web-releases/` |
| `PRODUCCION.md` | migraciones 001→019, fila y verificación de la 019 |
| `README.md` | comando, descripción y estado de la 019; la suite aplica 002→019 |
| `database/migrations/PENDIENTES.md` | estado de 012–014 |
| `infra/aws/cloudwatch/amazon-cloudwatch-agent.json` | grupo de logs por entorno |
| `infra/aws/scripts/bootstrap-ec2.sh` | `--env` y comprobación del perfil |
| `infra/aws/scripts/create-db-users.sh` | `DB_USER_HOST` por entorno y mensaje final según el entorno |
| `infra/aws/scripts/make-release.sh` | runbooks en el paquete |
| `infra/aws/scripts/render-env.sh` | validación del entorno y del perfil |
| `infra/aws/systemd/busperu-api.service` | `EnvironmentFile=-/etc/busperu/env` |

**Nuevos:**

- `.gitattributes`
- `infra/aws/cloudformation/`:
  - `build-prod-template.mjs` y `busperu-prod.json`
  - `build-prod-web-template.mjs` y `busperu-prod-web.json`
  - `build-prod-observability-template.mjs` y `busperu-prod-observability.json`
  - `check-prod-templates.mjs`
- `infra/aws/parameters/prod-parameters.json`
- `infra/aws/cloudformation/build-prod-db-bootstrap-template.mjs` y `busperu-prod-db-bootstrap.json` (B-10)
- `infra/aws/scripts/publish-web.mjs`, `infra/aws/scripts/prod-parameters.mjs` y `infra/aws/scripts/prod-db-bootstrap.sh` (B-10)
- `docs/production/`:
  - `MIGRATIONS.md`
  - `PRODUCTION-RUNBOOK.md`
  - este informe

**Actualizados sin versionar (de F18-17):**

- `F18-17-GO-LIVE-CHECKLIST.md`:
  - rutas reales `/destinos`, `/empresas` y `/ofertas` (las de antes dan la 404 del SPA);
  - `api` detrás de CloudFront;
  - EBS con `aws/ebs`, porque el rol de ejecución no puede usar la CMK de datos.
- `F18-17-PREPROD-REPORT.md`: sin cambios.

**Copia de trabajo:** 115 archivos sin cambios pasaron de CRLF a LF. El índice es idéntico: `git diff` no los muestra.

**Sin cambios de código** en `backend/` ni `frontend/`.

## 5. Qué NO se hizo

- No se creó, modificó ni borró ningún recurso de AWS: ni de producción, ni de staging, ni IAM.
- No se pidieron ni validaron certificados ACM, ni se tocaron Route 53 o el DNS.
- No se creó ningún parámetro en `/busperu/prod/`, ni se generó ni cargó ningún secreto.
- No se ejecutaron migraciones en staging ni en producción. Solo se reaplicaron en la base local de pruebas.
- No se activaron Resend ni Culqi LIVE, y no hubo pagos ni correos.
- No se desactivó ni se borró la clave de acceso IAM.
- No se aplicó la CSP en la CloudFront de staging: se probó inyectándola en el navegador.
- No se cambió el código ni la autenticación (cookies).
- No se añadieron Redis ni otras dependencias.
- No se borraron los documentos F18-12\* ni el manifiesto QA pendiente.
- Sin commit, sin push y sin `--force`.

**Huella en staging:** 1 login y 1 logout del ADMIN DEMO para la prueba de la CSP. Queda 1 fila en `revoked_sessions`, que es el funcionamiento normal del logout. No se crearon datos.

## 6. Pruebas y validaciones

| Prueba | Resultado |
| --- | --- |
| `check-prod-templates.mjs` | **PASS** (4 plantillas, incluida la del bootstrap) |
| Mutaciones del comprobador (ALB abierto, RDS pública, CMK/VPC/bucket/logs de staging, SNS nuevo, CSP debilitada, rol con nombre, listener que reenvía, secreto visible, `DeletionProtection` por parámetro, HTTP 80) | **14/14 detectadas** |
| `check-template` / `check-web-template` (staging, sin cambios) | PASS |
| `check-iam` / `check-iam-prod` / `check-baseline` | PASS |
| `aws cloudformation validate-template` ×3 | OK |
| Simulador de IAM, rol de ejecución real | todo lo necesario `allowed`; lo prohibido denegado; `acm:DescribeCertificate` → R-02 |
| `bash -n` de los 10 scripts | OK |
| Guard del entorno (`render-env` / `bootstrap`) | 5/5 casos |
| CSP en Chrome contra staging | 20 páginas + Culqi, 0 violaciones, control positivo bloqueado |
| `publish-web.mjs` | simulación PASS; 3 negativas DETENIDAS |
| `prod-parameters.mjs` | `plan`, `verificar` (0/16, como se esperaba) y simulaciones de `generar` / `fijos` |
| `test-metric-filter` con líneas reales del logger | **5/5** filtros, sin falsos positivos |
| Paquete de `make-release.sh` | 170 entradas, 0 CR, sin archivos prohibidos |
| Bootstrap B-10: ensayo local de `create-db-users.sh` (prod) | usuarios en `10.30.%`, privilegios mínimos, contraseñas idénticas; limpiado |
| Mutaciones de la plantilla de bootstrap | **6/6 detectadas** |
| Frontend: typecheck / lint / tests | 0 / 0 / **26/26** (sin cambios en el frontend) |
| Backend: typecheck | 0. La regresión completa **no** se repitió porque el backend no cambió; F18-17 dio 2136/2136 en 10.4 y 10.11 y 933/933 de seguridad con el mismo código |
| Escaneo de secretos de todo lo cambiado o nuevo (24 archivos) | **0 secretos reales**. 4 coincidencias en `F18-17-PREPROD-REPORT.md` que citan valores sintéticos de tests; 0 IP de operador; 0 IDs de cuenta |

## 7. Bloqueadores pendientes para crear la infraestructura real

| # | Bloqueador | Responsable |
| --- | --- | --- |
| B-01 | Dominio `busperuonline.pe` registrado y delegado (hoy NXDOMAIN; 0 zonas) | propietario |
| B-02 | Certificados ACM: us-east-1 (raíz, `www`, `api`) y sa-east-1 (`api`), en `ISSUED` | propietario, tras B-01 |
| B-03 | Resend: dominio verificado y clave | propietario |
| B-04 | Culqi LIVE: llaves y webhook | propietario |
| B-05 | Suscripción confirmada a `busperu-prod-alarms` y `busperu-prod-security` | propietario |
| B-07 | Parámetros de producción (0/16 obligatorios) | operador y propietario, **después** de crear `busperu-prod` |
| B-08 | Identity Center frente al flujo actual con MFA; política de clave solo con MFA (§3.2) | propietario |
| B-10 | **Decidido e implementado como código:** el runtime conserva su `Deny secretsmanager:*` y el bootstrap usa la pila temporal `busperu-prod-db-bootstrap` (§3.7). Queda **autorizar crear y borrar** esa pila en la ventana de despliegue | propietario (autorización 🔒) |
| B-11 | Porcentaje de `platform.default_commission`. **Pendiente por decisión del propietario:** no se asigna ningún valor por suposición. Sin él, la API rechaza dar de alta o aprobar empresas (409) | negocio |
| B-09 | Autorización explícita para crear infraestructura de producción, con coste | propietario |

B-06 («falta IaC de producción») **queda cerrado** en esta fase.

## 8. Riesgos y observaciones

| # | Riesgo | Mitigación |
| --- | --- | --- |
| R-01 | Sin tags de release | etiquetar `vX.Y.Z` antes del primer despliegue |
| R-02 | `acm:DescribeCertificate` no está en el rol de ejecución; no está confirmado que el listener HTTPS lo necesite | si el change set falla por eso, vuelve atrás solo; se amplía IAM tras revisarlo |
| R-03 | Clave IAM activa (§3.2) | política solo con MFA o Identity Center; desactivarla fuera de las ventanas |
| R-04 | Sin política de contraseñas IAM; el grupo del administrador tiene políticas ajenas a BusPerú | revisión de mínimo privilegio |
| R-05 | Una sola instancia (limitador y planificador en memoria) | documentado y exigido por el comprobador |
| R-06 | `'unsafe-inline'` en `style-src` | necesario para React `style=`, Culqi y las gráficas; los scripts siguen estrictos |
| R-07 | La CSP depende de terceros (Culqi, Wikimedia) que pueden cambiar de host | el comprobador vigila el código; volver a pasar la prueba en Chrome antes de cada go-live; considerar ensayar la CSP en la CloudFront de staging (requiere autorización) |
| R-08 | El frontend de producción lo publica el administrador (el operador no tiene CloudFront) | aceptado; alternativa: ampliar IAM en una fase aparte |
| R-09 | `/aws/rds/instance/busperu-prod-db/*` lo crea RDS sin retención | `put-retention-policy` tras la creación (runbook) |
| R-10 | Sin WAF ni logs de acceso de CloudFront/ALB | coste y decisión; opcional tras el go-live |
| R-11 | `qa-manifest-e2e-mug3ixsf.json` y los documentos F18-12\* siguen sin versionar | decisión del propietario |

## 9. Prerrequisitos manuales del operador (en orden)

1. Cerrar B-01…B-05, B-08, B-10 y B-11, y dar la autorización B-09.
2. `node check-prod-templates.mjs` y `validate-template` (runbook §3).
3. Generar la cabecera secreta de origen en CloudShell y guardarla en `ops/CLOUDFRONT_ORIGIN_SECRET`.
4. Change set de `busperu-prod` con `CAPABILITY_NAMED_IAM` y el rol de ejecución; revisar que sea solo `Add` y ejecutar.
5. Parámetros: `fijos`, `generar` (CloudShell), los del propietario y `DB_HOST`. Después, `verificar`.
6. `bootstrap-ec2.sh --env prod`; bootstrap de la base (B-10): crear `busperu-prod-db-bootstrap`, `prod-db-bootstrap.sh --ejecutar` y borrar la pila; después `apply-migrations.sh`, huella y `deploy-release.sh`.
7. `busperu-prod-web` con `ViewerAccess=operators`, después `FRONTEND_URL`, y `busperu-prod-observability`.
8. `publish-web.mjs --env prod --ejecutar`; primer administrador y comisión.
9. DNS 🔒, humo del checklist §D, `ViewerAccess=public` 🔒, verificación posterior §C.

## 10. Estado final

**PRODUCTION INFRASTRUCTURE PREPARED — NOT DEPLOYED.** No es READY FOR PRODUCTION: quedan los bloqueadores del §7.
