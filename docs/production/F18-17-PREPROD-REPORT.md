# F18-17 — Informe de preparación pre-producción

> Solo diagnóstico y preparación. **Sin despliegue, sin recursos nuevos, sin cambios en AWS, DNS, Culqi ni Resend, sin
> commit y sin push.** Las consultas a AWS fueron de solo lectura, con la sesión MFA del administrador. La cuenta
> aparece como 6578****68. Sin secretos, IP de operador ni credenciales DEMO en este documento.
> Fecha: 2026-09-25.

## 1. Executive Summary

La **aplicación** está lista para producción:

- el commit está publicado y es reproducible;
- 2136/2136 tests en MariaDB 10.4 y en 10.11, y 933/933 de seguridad;
- el frontend pasa sus 26/26 tests y su build es reproducible;
- el esquema coincide con la referencia y las migraciones son idempotentes;
- los guards de producción son estrictos;
- la línea base de seguridad de AWS (KMS, CloudTrail, Access Analyzer, IAM) está sana.

La **plataforma de producción no existe todavía** y el go-live está **bloqueado** por dos motivos:

1. Dependencias externas que solo puede resolver el propietario: dominio, certificados, Resend, Culqi LIVE y suscripciones de alarmas.
2. Falta la infraestructura de aplicación de producción como código: hoy solo hay plantillas de staging.

No hay ningún recurso de producción de aplicación: ni VPC, EC2, RDS, ALB, CloudFront o S3 web, ni parámetros SSM
de producción.

**Estado final: BLOCKED.** Hay 9 bloqueantes (§19) y 14 riesgos o hallazgos no bloqueantes (§20). Ningún
bloqueante está en el código de la aplicación.

## 2. Current Release

| Elemento | Valor |
| --- | --- |
| Rama | `master` |
| Commit | `0120415ae5150ac86e8b80349a6c5ff1e2a5b0b2`, «perf(admin): add stale-while-revalidate navigation cache» |
| `origin/master` | igual a HEAD (`https://github.com/Rodrxgo2506/BusPeru.git`), sin divergencia |
| Working tree | limpio en archivos versionados. Sin versionar: 4 documentos F18-12\*, `qa-manifest-e2e-mug3ixsf.json` y los 2 documentos de esta fase |
| Tags de release | **ninguno** (hallazgo R-01) |
| Build del frontend | reproducible: `index-BxZI4lM0.js`, idéntico al servido por staging |
| Staging | backend `releases/2026-09-25-1` en la EC2 y web con el build `index-BxZI4lM0.js`, ambos del commit actual; `/api/ready` 200 |

Clasificación de los archivos sin versionar. **No se borró ninguno.**

| Archivo | Clasificación | Recomendación |
| --- | --- | --- |
| `docs/production/F18-12-COMMIT-PREP.md`, `F18-12A-…`, `F18-12B-…`, `F18-12C-…` | Informes de proceso de F18-12, ya superados por el historial publicado | Archivar fuera del repo o versionar en `docs/production/history/`; decide el propietario |
| `qa-manifest-e2e-mug3ixsf.json` (raíz) | Manifiesto de una ejecución E2E anterior a F18-11B, con IDs de datos QA de staging | Decidir si esos IDs ya se purgaron (`qa-staging.sh purgar`) y luego archivarlo; no versionarlo |
| `docs/production/F18-17-*.md` | Entregables de esta fase | Versionar tras la revisión (commit pendiente de autorización) |

## 3. F18-16 Verification

Las 21 piezas de F18-16 están presentes en HEAD: caché SWR, ámbitos de petición, `invalidateReads`, hooks
`useList` y `useAsync`, `refresh-status` con su test, precarga de datos de ADMIN, `RefreshNotice`, favicon `data:,`
y documentación.

| Verificación | Resultado |
| --- | --- |
| Frontend: typecheck / lint / tests | 0 / 0 / **26/26** |
| Build de producción | reproducible, mismo hash que staging |
| Staging | `/api/ready` 200, `/api/health` 200; ALB: 0 errores 5xx de destino en 24 h; 23/23 alarmas en OK |
| Rendimiento, línea base de F18-16 | navegación ADMIN: contenido útil con mediana 6–9 ms y 0/11 esqueletos; carga del Dashboard ~800 ms (sin cambio) |

## 4. Application Readiness

**Configuración de producción.** El backend lee 53 variables: 52 en `config/env.ts` y `LOG_ERRORS`. Con
`NODE_ENV=production`, `production-guard.ts` y `secrets-guard.ts` impiden arrancar si la configuración es insegura.
`render-env.sh` genera `/run/busperu/api.env` desde `/busperu/${BUSPERU_ENV}/app/` (con `BUSPERU_ENV=prod` →
`/busperu/prod/app/`).

**Matriz de configuración** (secreta = SecureString con `alias/busperu-prod-secrets`):

| Variable | Requerida | Existe plantilla | Secreta | Fuente esperada | Estado |
| --- | --- | --- | --- | --- | --- |
| NODE_ENV | Sí (`production`) | Sí | No | unidad systemd / env | listo en plantilla |
| PORT | Sí (3000) | Sí | No | SSM `app/PORT` | pendiente de carga |
| DB_HOST | Sí | Sí | No | SSM (endpoint RDS de prod) | **no existe RDS** |
| DB_PORT | Sí | Sí | No | SSM | pendiente |
| DB_NAME | Sí (`busperu_prod`) | Sí | No | SSM | pendiente; ver §5 sobre el nombre |
| DB_USER | Sí (`busperu_app`, no root) | Sí | No | SSM | pendiente |
| DB_PASSWORD | Sí | Sí (vacía) | **Sí** | SSM SecureString | pendiente |
| JWT_SECRET | Sí (≥32 caracteres, ≥10 distintos) | Sí (vacía) | **Sí** | SSM SecureString, **nuevo**, no el de staging | pendiente |
| JWT_EXPIRES_IN | No (8h) | Sí | No | SSM / valor por defecto | listo |
| FRONTEND_URL | Sí (https pública) | Sí | No | SSM `https://busperuonline.pe` | depende del dominio |
| TRUST_PROXY | Sí (saltos o IP, no `true`) | Sí | No | SSM (CloudFront → ALB: `2`, verificar) | pendiente |
| MAIL_TRANSPORT | Sí (`resend` o `smtp`) | Sí (`resend`) | No | SSM | pendiente |
| RESEND_API_KEY | Sí con resend | Sí (vacía) | **Sí** | SSM SecureString (propietario) | **bloqueante B-03** |
| RESEND_FROM_EMAIL | Sí con resend (sin dominio sandbox) | Sí | No | SSM `soporte@busperuonline.pe` | depende del dominio |
| MAIL_HOST / MAIL_PORT / MAIL_SECURE / MAIL_USER / MAIL_FROM | Solo con smtp | Sí (comentadas) | MAIL_PASSWORD **Sí** | — | no aplica con Resend |
| CULQI_PUBLIC_KEY | Sí para cobrar (trío completo) | Sí (vacía) | No (pública), se guarda igual en SSM | SSM | **bloqueante B-04** |
| CULQI_PRIVATE_KEY | Ídem | Sí (vacía) | **Sí** | SSM SecureString (propietario) | **B-04** |
| CULQI_WEBHOOK_SECRET | Ídem (longitud mínima) | Sí (vacía) | **Sí** | SSM SecureString | **B-04** |
| CULQI_API_URL | No (valor por defecto https) | No | No | por defecto | listo |
| CULQI_TIMEOUT_MS | No | Sí | No | por defecto | listo |
| OAUTH_CALLBACK_BASE_URL | Solo si hay OAuth (https) | Sí | No | SSM `https://api.busperuonline.pe/api` | opcional |
| OAUTH_FRONTEND_CALLBACK_PATH / OAUTH_STATE_TTL_SECONDS / OAUTH_TICKET_TTL_SECONDS | No | Sí | No | valores por defecto | listo |
| GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET | Opcional (en par) | Sí | secret **Sí** | SSM | opcional al lanzar |
| MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET / MICROSOFT_TENANT | Opcional (en par) | Sí | secret **Sí** | SSM | opcional al lanzar |
| GOOGLE_/MICROSOFT_ AUTH_URL, TOKEN_URL, ISSUER, JWKS_URI | **Prohibidas** en producción (solo tests) | No (correcto) | No | — | correcto |
| INTEGRATIONS_ENCRYPTION_KEY | Recomendada (sin ella las integraciones dan 503) | Sí (vacía) | **Sí** | SSM SecureString, 32 bytes, nueva | pendiente |
| INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS | Solo al rotar | Sí | **Sí** | SSM | vacía al lanzar |
| STORAGE_DIR | Sí en la práctica | Sí | No | SSM (volumen EBS persistente) | pendiente |
| BOOKING_EXPIRY_INTERVAL_MS | No | Sí | No | por defecto | listo |
| RATE_LIMIT_GLOBAL / RATE_LIMIT_AUTH | No (300/min, 20/15 min) | Sí | No | por defecto | listo (almacén en memoria) |
| PASSWORD_RESET_* (4) | No | Sí | No | por defecto | listo |
| LOG_ERRORS | No | No | No | por defecto | listo |
| Frontend `VITE_API_URL` | Sí (en build; https, no localhost) | Sí (vacía) | No | variable de build | depende del dominio |

Parámetros actuales en `/busperu/prod/*`: **0**. Los de staging existen: 14 en `app/` y 4 en `ops/`.

**Scripts de la aplicación:**

- **seed de desarrollo:** se niega a ejecutarse con `NODE_ENV=production`;
- **scripts de base de datos:** rechazan `busperu` y `busperu_test`.

**Resultado del §4:** **PASS**. La configuración falta por dependencias de infraestructura y de terceros, no por el
código.

## 5. Database Readiness

| Verificación | Resultado |
| --- | --- |
| Migraciones en el repo | **001 → 019**. El brief decía «001–014»: 015–019 son de F17/F18 (destinos, `sessions_valid_from`, FK en 10.11, cifrado bancario) |
| Orden | numérico y estricto; `apply-migrations.sh` exige 19 y se detiene en el primer error, sin `--force` |
| Idempotencia | **Probada**: se volvieron a aplicar las 19 sobre `busperu_1011_test` ya migrada → 19/19 OK, y la huella siguió idéntica |
| Operaciones destructivas | ningún `DROP TABLE`, `DELETE` masivo ni `TRUNCATE` ejecutable. Hay `DROP INDEX`/`DROP FOREIGN KEY` guardados por `information_schema` en 010–013 y 018; el resto aparece solo en comentarios |
| Rollback | cada migración documenta su vuelta atrás manual. No hay migraciones *down* automáticas: se avanza con una corrección nueva o, como último recurso, se restaura el snapshot (§15) |
| Instalación nueva | `apply-migrations.sh` (dump + 001→019) solo sobre una base **vacía**: se niega si hay tablas, porque el dump contiene 34 `DROP TABLE IF EXISTS` |
| Base existente | `apply-one-migration.sh <archivo> <base>`: confirmación repetida del nombre y exige 49 tablas |
| Huella del esquema | `schema-fingerprint.cjs` en 10.11.19 local: **idéntico** a `schema-reference.json` (49 tablas, 496 columnas, 221 índices, 81 FK, 12 CHECK, utf8mb4_unicode_ci). Staging fue idéntico en F18-09 (vía SSM) y no hubo migraciones después |
| Registro de migraciones aplicadas | **no hay tabla de control** (R-05): el estado se verifica con la huella |
| Nombre de la base | **Discrepancia (D-01)**: el brief dice «DB `busperu`», mientras que F18-08 y los scripts usan `busperu_prod` (`db-common.sh`: `busperu_${BUSPERU_ENV}`, con `busperu` **prohibido** por ser la base local de desarrollo). Se recomienda `busperu_prod` |

**Resultado del §5:** **PASS**, con la decisión D-01 pendiente.

## 6. Security Readiness

| Área | Verificación | Resultado |
| --- | --- | --- |
| JWT | HS256 fijado en `verify` (sin `alg` del token), `jti` aleatorio de 128 bits, 8 h | OK |
| Revocación | logout revoca el `jti` (`revoked_sessions`); `sessions_valid_from` invalida todas las sesiones de un usuario | OK (suites 71, 72, 76) |
| OAuth | Authorization Code con **PKCE S256**, `state` y `nonce`; `id_token` solo RS256 con JWKS; ticket de un solo uso | OK (suite 17) |
| Roles y tenencia | `requireRole` y `requirePermission`; alcance por empresa; catálogos globales de solo escritura para ADMIN | OK (suites 02, 03, 53, 61, 77) |
| Límites de peticiones | global 300/min, auth 20/15 min, OAuth con su propio limitador | OK; en memoria, válido con **una** instancia (R-07) |
| CORS | origen exacto de `FRONTEND_URL`. En staging, una petición con otro origen no se refleja | OK (suite 74, y en vivo) |
| Cabeceras de la API (staging, en vivo) | CSP estricta, HSTS 1 año con subdominios, `nosniff`, `X-Frame-Options`, COOP, CORP, `Referrer-Policy: no-referrer`, sin `X-Powered-By` | OK |
| Cabeceras de la web (staging, en vivo) | HSTS, `nosniff`, `X-Frame-Options`, Referrer-Policy; **sin CSP** (política gestionada SecurityHeadersPolicy) | **Hallazgo R-02** |
| Sesión y cookies | token Bearer en `localStorage`; sin cookies de sesión, así que el CSRF no aplica. El riesgo es la exposición a XSS (se mitiga con la CSP de R-02) | aceptado, con la mitigación pendiente |
| Tamaño del cuerpo | JSON de 1 MB como máximo; subidas con su propio middleware | OK |
| Guards de arranque | `production-guard` y `secrets-guard` (ver §4) | OK (suites 62, 63) |
| Dependencias de producción | backend: 0 vulnerabilidades. Frontend: 2 moderadas (react-router 6.x, ya conocidas y mitigadas en F18-08) | aceptado (R-08) |
| Tests de seguridad | **933/933** (33 archivos) en 10.4 y en 10.11 | OK |

**Resultado del §6:** **PASS WITH FINDINGS** (R-02, R-07 y R-08).

## 7. AWS Readiness

Arquitectura de producción objetivo (F18-08):

```
Route 53 (busperuonline.pe) ──► CloudFront web (ACM us-east-1) ──OAC──► S3 privado (frontend)
                         └────► api.busperuonline.pe ──► ALB :443 (ACM sa-east-1) ──► EC2 (busperu-api, systemd)
                                                                                     └──► RDS MariaDB 10.11 privada (busperu_prod)
```

| Componente | Estado actual en la cuenta |
| --- | --- |
| Pilas en sa-east-1 | `busperu-staging`, `busperu-staging-web`, `busperu-security-baseline`. **No existe `busperu-prod`** |
| Pilas en us-east-1 | ninguna (`busperu-prod-edge` no existe) |
| Plantillas IaC de la aplicación de producción | **No existen**. En `infra/aws/cloudformation/` solo hay generadores y comprobadores de staging (**B-06**) |
| VPC, EC2, RDS, ALB y CloudFront de producción | no existen |
| Staging (referencia) | EC2 t4g.small con IMDSv2 obligatorio y perfil propio; RDS 10.11.19 cifrada, `DeletionProtection`, privada, 7 días de backups; DLM diario del volumen de datos |
| Coste | sin AWS Budgets ni alarma de facturación (R-09); Cost Explorer no está habilitado (F18-08) |

**Resultado del §7:** **BLOCKED** para producción (B-06).

## 8. KMS / IAM / CloudTrail

Consultas de solo lectura del 2026-09-25:

| Verificación | Resultado |
| --- | --- |
| `alias/busperu-prod-secrets`, `-data`, `-rds` | Enabled, CUSTOMER, SYMMETRIC_DEFAULT, de una sola región, **rotación activada** |
| Roles de producción | `BusPeruProdOperator` (sesión de 2 h), `BusPeruProdCloudFormationExecution`, `BusPeruProdRecovery`, `BusPeruProdBreakGlass`, `busperu-prod-app-role`, `BusPeruProdCloudTrailToLogs` (1 h) |
| CloudTrail `busperu-prod-trail` | `IsLogging=true`, multirregión, eventos globales, validación de integridad; última entrega a S3 y a CloudWatch Logs de hoy, **sin errores** |
| Logs de CloudTrail | `/busperu/security/cloudtrail`, 90 días |
| Access Analyzer | `busperu-account-external-access` ACTIVE, **0 hallazgos activos** |
| Alarmas de seguridad | 11 `busperu-prod-*` en OK |
| Raíz de la cuenta | MFA activado; sin claves de acceso |
| Usuario IAM humano | 1 usuario con 1 dispositivo MFA. Su clave de acceso está **Active**: F18-08 la dejó Inactive y se reactivó para las sesiones MFA de F18-12→F18-17 (R-03) |
| Política de contraseñas IAM | **no definida** (R-04) |
| Identity Center | no configurado; requiere AWS Organizations. Es decisión del propietario (**B-08**) |

**Resultado del §8:** **PASS WITH FINDINGS**.

## 9. Domain / ACM / DNS

| Verificación | Resultado |
| --- | --- |
| `busperuonline.pe`, NS en 8.8.8.8 | **NXDOMAIN**: sin registrar o sin delegar (**B-01**) |
| Zonas hospedadas de Route 53 | **0** |
| ACM en us-east-1 (CloudFront) | **0 certificados** (**B-02**) |
| ACM en sa-east-1 (ALB) | **0 certificados** (**B-02**) |
| Plan de registros | F18-08 §18.6: apex y `api`, `www` con 301, CNAME de validación de ACM, SPF, DKIM, DMARC y retorno de Resend |

SAN necesarios:

- **us-east-1:** `busperuonline.pe` y `www.busperuonline.pe`.
- **sa-east-1:** `api.busperuonline.pe`.

Route 53 Domains no registra `.pe` (`UnsupportedTLD`): hay que usar NIC.pe o un agente acreditado.

**Resultado del §9:** **BLOCKED** (acción del propietario).

## 10. Resend

| Punto | Estado |
| --- | --- |
| Cuenta de Resend | no consta (propietario) |
| Dominio de envío verificado (SPF, DKIM, DMARC, return-path) | depende de B-01 |
| `RESEND_API_KEY` en SSM (SecureString, CMK de secretos) | **no cargada** (B-03) |
| `RESEND_FROM_EMAIL` | `soporte@busperuonline.pe` (el guard rechaza el dominio sandbox) |
| Staging | usa `MAIL_TRANSPORT=smtp`; Resend **no se ha probado de extremo a extremo** con la cuenta real (R-10) |
| Prueba previa al go-live | 1 correo a un buzón del propietario; comprobar SPF/DKIM `pass` en las cabeceras |

**Resultado del §10:** **BLOCKED**.

## 11. Culqi

| Punto | Estado |
| --- | --- |
| Llaves LIVE (pública, privada y secreto de webhook) | **no cargadas** (B-04). El guard exige el trío completo y el mismo modo |
| Webhook | `https://api.busperuonline.pe/api/culqi/webhook/<segmento secreto>`. Culqi no firma: segmento secreto, re-consulta del cargo, idempotencia por el ID del cargo, importe y moneda PEN (suites 31, 54 y 70) |
| Reembolsos | total, parcial y compensatorio, sin reembolsar de más (suites 55 y 81) |
| Staging | sandbox |
| Primer cargo LIVE | uno solo, mínimo, con la tarjeta del propietario y reembolso inmediato; requiere autorización expresa |

**Resultado del §11:** **BLOCKED**.

## 12. Backups / Recovery

| Punto | Estado |
| --- | --- |
| Diseño de RDS en producción | 14 días de backups con PITR, CMK propia, `DeletionProtection`, snapshot manual antes de cada migración (F18-08 §7) |
| Staging, referencia real | 7 días, PITR (última restauración posible de hoy), 3 snapshots automáticos y 2 manuales (`pre019-f1807a`, `pre-limpieza-qa-20260924`) |
| Volumen de datos (`STORAGE_DIR`) | DLM diario ENABLED en staging; mismo diseño para producción |
| Ensayo de recuperación | F18-08: RTO de la aplicación medido en staging, **615 s**, con esquema e integridad verificados |
| RPO | PITR (~5 min) en RDS y 24 h en archivos subidos (snapshot diario de EBS) |
| Copia de secretos | copia fuera de línea custodiada por el propietario (F18-08 §4) |

**Resultado del §12:** **PASS**, a aplicar al crear la pila de producción.

## 13. Observability

| Punto | Estado |
| --- | --- |
| Alarmas | 23 en total, todas OK: 12 de staging y 11 de seguridad de producción |
| SNS | `busperu-staging-alarms`: 1 suscripción confirmada. `busperu-prod-security` y `busperu-prod-alarms`: **0 suscripciones** (**B-05**) |
| Logs | `/busperu/staging/app` con 14 días; `/busperu/security/cloudtrail` con 90 días; `/aws/rds/instance/busperu-staging-db/error` **sin retención** (R-11) |

Alarmas mínimas de aplicación en producción (se crean con la pila):

- ALB:
  - 5xx de destino superior a 5 en 5 min;
  - `UnHealthyHostCount` de 1 o más;
  - p95 de `TargetResponseTime` superior a 2 s.
- EC2:
  - `StatusCheckFailed`;
  - CPU superior al 80 % durante 15 min.
- RDS:
  - CPU superior al 80 %;
  - `FreeStorageSpace` por debajo de 2 GB;
  - `FreeableMemory` por debajo de 100 MB;
  - `DatabaseConnections` por encima del umbral.
- Aplicación:
  - errores en `/busperu/prod/app` por filtro;
  - fallo del job de expiración de reservas;
  - fallo de envío de Resend;
  - rechazos de webhook de Culqi.
- Backups: fallo de snapshot o de DLM.
- Facturación: presupuesto mensual.

Todas deben notificar a `busperu-prod-alarms`, con su suscripción confirmada.

**Resultado del §13:** **PASS WITH FINDINGS** para lo existente; lo de producción queda pendiente de la pila.

## 14. Deployment Plan

Proceso, basado en el que ya se usa en staging:

1. **Etiqueta:** `git tag -a vX.Y.Z` sobre el commit aprobado y `git push origin vX.Y.Z`, con autorización.
2. **Artefactos:**
   - `make-release.sh`: tar del backend y SHA-256;
   - build del frontend con `VITE_API_URL=https://api.busperuonline.pe/api` y un manifiesto SHA-256 de `dist/`;
   - verificación del bundle: sin localhost, dominios de staging, claves ni source maps.
3. **Infraestructura** (una sola vez, tras B-06):
   - change set de `busperu-prod` en sa-east-1 y de `busperu-prod-edge` en us-east-1;
   - revisar solo los tipos autorizados y ejecutar con el rol `BusPeruProdCloudFormationExecution`.
4. **Secretos:** el propietario carga `/busperu/prod/app/*` en su terminal. Nunca por chat.
5. **Base de datos:**
   - `create-db-users.sh`, luego `apply-migrations.sh` (base vacía) y `schema-fingerprint.cjs`;
   - en releases posteriores: snapshot y después `apply-one-migration.sh`.
6. **Backend:** `deploy-release.sh`, que extrae, ejecuta `npm ci --omit=dev`, cambia el enlace `current` y reinicia; comprobar `/api/ready`.
7. **Frontend:** subir `assets/` (inmutables) e `index.html` (`no-cache`) al bucket de producción e invalidar `/` y `/index.html`.
8. **Smoke** no destructivo (checklist §D), luego DNS, y luego la verificación posterior (checklist §C).

Hallazgo R-06: la publicación del frontend en staging se hizo con un script auxiliar de la sesión que **no está
versionado**. Antes de producción hay que llevarlo al repo (`infra/aws/scripts/publish-web.*`), con verificación de
hashes y la invalidación.

## 15. Rollback Plan

| Capa | Procedimiento | Tiempo estimado |
| --- | --- | --- |
| Frontend | volver a subir el `dist/` del release anterior (se conserva por versión) e invalidar `/index.html`. Con el bucket versionado también se puede restaurar la versión previa de `index.html` | < 5 min |
| Backend | apuntar `/opt/busperu/current` al release anterior (se conservan en `/opt/busperu/releases/`) y reiniciar `busperu-api`; comprobar `/api/ready` | < 2 min |
| Base de datos: preferente | **siempre hacia delante**: las migraciones son aditivas o están guardadas. El código anterior tolera el esquema nuevo; si una migración falla, se corrige con otra migración | — |
| Base de datos: último recurso | restaurar el snapshot `pre-<release>` o PITR **en una instancia nueva**, cambiar `DB_HOST` en SSM y reiniciar. Se pierden las escrituras posteriores al snapshot. Requiere autorización del propietario | ~10–15 min (RTO medido: 615 s) |
| DNS | revertir los alias (TTL bajo previo) | TTL |
| Terceros | Culqi: desactivar el webhook o volver a sandbox. Resend: `MAIL_TRANSPORT` sin envío real | minutos |

Criterio de rollback: cualquier fallo del smoke (checklist §D), errores 5xx sostenidos, fallo de login o
revocación, o errores de pago.

## 16. Go-Live Checklist

Ver `docs/production/F18-17-GO-LIVE-CHECKLIST.md`:

- **antes:** 13 bloques, de dominio a autorizaciones;
- **durante:** snapshot, release ID, hash, migración, backend, frontend, salud, smoke y DNS;
- **después:** login, logout, los 4 roles, búsqueda, reserva, pago, cancelación, reembolso, notificaciones, reportes, logs, métricas y alarmas;
- **smoke de go-live no destructivo:** 14 pasos y script de referencia.

Los pasos sin autenticación del smoke se validaron contra staging: rutas web 4/4 → 200, `/api/ready` 200,
`/api/health` 200, sin eco de CORS para un origen ajeno, y `/auth/me` y `/admin/branding` sin token → 401.

## 17. Secret Scan

Alcance:

- `git grep` sobre **HEAD**, más los documentos sin versionar.
- Patrones buscados: claves AWS (`AKIA`/`ASIA`), claves privadas PEM, llaves de Culqi `sk_`/`pk_` (live y test), claves de Resend, JWT, tokens de GitHub y Slack, claves de Google, URL de base de datos con credenciales, números de 12 dígitos, ID de cuenta real, IP de operador, endpoints de RDS y literales `password`/`secret`.

| Hallazgo | Ubicación | Clasificación |
| --- | --- | --- |
| Token `eyJ…` | `backend/src/test/01-auth.test.ts:55` | SYNTHETIC TEST VALUE |
| `eyJhbGciOiJIUzI1NiJ9.…firma-ficticia-del-token-15a` | `63-f15-production-hardening.test.ts:246` | SYNTHETIC TEST VALUE |
| `pk_/sk_live_ficticia15a`, `pk_/sk_test_ficticia15a` | `63-…:113–119` | SYNTHETIC TEST VALUE |
| `pk_test_…1234`, `sk_test_…5678`, `pk_test_0000abcd`, `pk_test_incompleta` | `18-company-integrations.test.ts` | SYNTHETIC TEST VALUE |
| Números de 12 dígitos (cuentas bancarias o CCI ficticias, timestamps) | tests 12, 17, 59, 63, 73, 80 y `BankAccountsPage.tsx:52` (placeholder) | SYNTHETIC TEST VALUE / NON-SENSITIVE IDENTIFIER |
| `DEMO_PASSWORD = 'BusPeru2026'` | `backend/src/database/seed.ts:11` (seed local; se niega con `NODE_ENV=production`) | SYNTHETIC TEST VALUE (credencial de desarrollo local, no de staging ni producción) |
| `'contrasena-incorrecta-de-prueba'` | `smoke-staging.mjs:141` | SYNTHETIC TEST VALUE |
| Dominios `d1lfpi7fp62ntk` / `d25z2lpl1efut1.cloudfront.net` | docs y scripts de staging | PUBLIC CONFIG |
| `rds.amazonaws.com` | políticas IAM y filtros de CloudTrail (nombre de servicio) | FALSE POSITIVE |
| ID de cuenta AWS real | HEAD: **0**; documentos sin versionar: **0** | — |
| IP de operador | HEAD: **0** | — |
| Endpoint real de RDS | HEAD: **0** | — |
| Archivos `.env` reales versionados | **0** (solo `*.example`; `.gitignore` excluye `.env.*`) | — |

**REAL SECRET: 0.** **Resultado del §17:** **PASS**.

## 18. Tests Executed

| Suite | Resultado |
| --- | --- |
| Backend, MariaDB 10.4 (`busperu_test`) | **2136/2136**, 0 fallos fuera de un test, sin cierres nativos |
| Backend, MariaDB 10.11.19 (`busperu_1011_test`) | **2136/2136**, 0 fallos fuera de un test, sin cierres nativos |
| Seguridad (33 archivos) | **933/933** en ambas |
| Backend typecheck | 0 errores |
| Frontend typecheck / lint / tests | 0 / 0 / **26/26** |
| Build del frontend | reproducible (`index-BxZI4lM0.js` = staging) |
| Idempotencia de migraciones (19 reaplicadas, 10.11) | **19/19 OK**; huella idéntica después |
| `schema-fingerprint.cjs` (10.11 local) | idéntico a la referencia |
| Staging en vivo: `/api/ready`, `/api/health`, cabeceras, CORS, rutas SPA, 401 sin token | PASS |
| Staging: ALB 5xx en 24 h / alarmas | 0 / 23 OK |
| AWS de solo lectura: KMS, IAM, CloudTrail, Access Analyzer, ACM, Route 53, RDS, SSM, SNS, alarmas, logs, DLM, EC2 | ver §7–§13 |
| `npm audit --omit=dev` | backend 0; frontend 2 moderadas (react-router) |

No se ejecutaron smoke ni E2E autenticados contra staging, porque crean datos QA. Sus últimas ejecuciones fueron
37/37 y 18/18 en el cierre de F18-16, con los datos purgados.

## 19. Blockers

| # | Bloqueante | Responsable | Qué lo cierra |
| --- | --- | --- | --- |
| B-01 | Dominio `busperuonline.pe` sin registrar o sin delegar (NXDOMAIN); 0 zonas en Route 53 | Propietario | Registro `.pe`, zona hospedada y delegación NS |
| B-02 | 0 certificados ACM (us-east-1 y sa-east-1) | Propietario, luego operador | Emisión con validación DNS tras B-01 |
| B-03 | Resend: sin dominio verificado ni `RESEND_API_KEY` | Propietario | Cuenta, dominio (SPF, DKIM, DMARC) y clave cargada en SSM |
| B-04 | Culqi LIVE: sin llaves ni webhook | Propietario | Llaves LIVE en SSM y webhook registrado |
| B-05 | `busperu-prod-security` y `busperu-prod-alarms` sin suscripciones | Propietario | Correo autorizado y suscripción confirmada |
| B-06 | **No existe IaC de la aplicación de producción** (VPC, EC2, RDS, ALB, CloudFront, S3, alarmas de aplicación) | Siguiente fase | Plantillas `busperu-prod` / `busperu-prod-edge` generadas desde las de staging, con comprobadores, sin desplegar |
| B-07 | `/busperu/prod/app/*` vacío (0 parámetros) | Propietario y operador | Carga según la matriz §4, después de B-06 |
| B-08 | Decisión sobre IAM Identity Center frente al flujo actual con MFA | Propietario | Decisión registrada |
| B-09 | Sin autorización explícita de despliegue de producción | Propietario | «Autorizo el deployment de producción.» |

## 20. Risks

| # | Riesgo o hallazgo | Severidad | Recomendación |
| --- | --- | --- | --- |
| R-01 | Sin tags de release | Media | Etiquetar `v1.0.0` sobre el commit aprobado antes del go-live |
| R-02 | La web (CloudFront) no envía CSP; el token vive en `localStorage` | Media | Política de cabeceras propia con CSP (`default-src 'self'`, `connect-src` a la API y a Culqi, `frame-src` de Culqi) en la distribución de producción |
| R-03 | Clave de acceso del usuario humano en **Active** | Media | Desactivarla al terminar cada ventana; mejor aún, pasar a Identity Center (B-08) |
| R-04 | Sin política de contraseñas IAM | Baja | Definirla (el único usuario ya tiene MFA) |
| R-05 | Sin tabla de control de migraciones aplicadas | Baja | Mantener la huella como control; valorar una tabla `schema_migrations` en una fase aparte |
| R-06 | El script de publicación del frontend no está en el repo | Media | Versionarlo antes de producción |
| R-07 | Limitador de peticiones y planificador en memoria: una sola instancia | Media (al escalar) | Mantener 1 instancia; al escalar, almacén compartido y *leader election* |
| R-08 | react-router 6.x: 2 avisos moderados | Baja | Actualizar a 7 en una fase de mantenimiento |
| R-09 | Sin AWS Budgets ni alarma de facturación | Media | Crear un presupuesto con alerta antes de crear recursos de producción |
| R-10 | Resend nunca probado de extremo a extremo (staging usa SMTP) | Media | Prueba con el buzón del propietario antes de abrir tráfico |
| R-11 | Log de errores de RDS de staging sin retención | Baja | Fijar la retención (p. ej. 30 días) |
| R-12 | Checkout en Windows con CRLF rompe los comprobadores de plantillas; no hay `.gitattributes` | Baja | Añadir `.gitattributes` con `eol=lf` para `*.sh`, `*.mjs`, `*.json` y `*.sql` |
| R-13 | `qa-manifest-e2e-mug3ixsf.json` sin resolver | Baja | Confirmar la purga de sus IDs y archivarlo |
| R-14 | Caché SWR de ADMIN: datos de hasta 10 min durante un instante y ≤30 s tras una revocación (documentado en F18-16) | Baja | Aceptado |

Decisión pendiente **D-01**: el nombre de la base de producción. Se recomienda `busperu_prod`, coherente con
F18-08 y los scripts; `busperu` está prohibido por las herramientas.

## 21. Recommended Next Phase

**F18-18 — Infraestructura de producción como código (sin desplegar)**, en paralelo con las acciones del
propietario:

1. **Operador (F18-18):**
   - generadores y comprobadores de `busperu-prod` (sa-east-1) y `busperu-prod-edge` (us-east-1), derivados de los de staging, con estos cambios:
     - ALB en 443 con ACM;
     - RDS con 14 días de backups, `DeletionProtection` y la CMK `rds`;
     - CloudFront con alias, certificado y **CSP (R-02)**;
     - las alarmas de aplicación del §13;
     - un presupuesto (R-09);
   - `validate-template` y el comprobador de tipos autorizados, **sin crear pilas**;
   - versionar el script de publicación de la web (R-06) y `.gitattributes` (R-12).
2. **Propietario, en paralelo:**
   - B-01 dominio;
   - B-03 Resend;
   - B-04 Culqi LIVE;
   - B-05 suscripciones;
   - B-08 Identity Center;
   - D-01 nombre de la base.
3. **F18-19 — Despliegue de producción**, solo con B-01…B-08 cerrados y la autorización B-09.

## 22. Final Status

**BLOCKED**

| Área | Estado |
| --- | --- |
| Aplicación (código, tests, esquema, secretos) | PASS |
| Seguridad de la aplicación | PASS WITH FINDINGS |
| Línea base de seguridad de AWS | PASS WITH FINDINGS |
| Infraestructura de producción | BLOCKED (B-06, B-07) |
| Dominio, correo, pagos y alarmas | BLOCKED (B-01…B-05) |
| Producción | **NOT READY** |

Cambios de esta fase:

- 2 documentos nuevos sin versionar: este informe y el checklist.
- La base **local** de pruebas `busperu_1011_test` recibió las 19 migraciones reaplicadas (idempotentes, sin cambios de esquema).

Sin cambios en el código, AWS, staging, DNS, Culqi, Resend ni git. Sin commit y sin push.
