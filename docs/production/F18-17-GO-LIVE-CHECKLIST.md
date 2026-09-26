# F18-17 — Checklist de go-live de BusPerú

> Documento de preparación. **No autoriza ningún despliegue.** Actualizado en F18-18: rutas públicas reales (`/destinos`,
> `/empresas`, `/ofertas`; `/destinations`, `/companies` y `/offers` dan la página 404 del SPA), `api` detrás de
> CloudFront y EBS con `aws/ebs`. El procedimiento completo está en `PRODUCTION-RUNBOOK.md`. Cada casilla la marca el operador durante la fase de
> producción (F18-18 o posterior), con evidencia, después de la autorización explícita del propietario.
> Sin secretos: donde un paso usa una credencial, el operador la introduce en su terminal. Nunca se pega en un chat
> ni en un documento.

Convenciones:

- **Prod web:** `https://busperuonline.pe`
- **Prod API:** `https://api.busperuonline.pe/api`
- **Región:** sa-east-1. El certificado de CloudFront va en us-east-1.
- **Cuenta:** 6578****68
- **Base de producción:** `busperu_prod`. Es el valor por defecto de `db-common.sh`: los scripts rechazan `busperu` y `busperu_test`, ver el informe §5.
- **Responsable:** la persona que marca la casilla anota fecha y hora (UTC) y dónde está la evidencia.

Estado de cada casilla al cierre de F18-17: **[x]** hecho y verificado · **[ ]** pendiente · **[!]** bloqueante hoy.

---

## A. Antes del despliegue

### A.1 Dominio, ACM y DNS

- [!] `busperuonline.pe` registrado en un registrador `.pe` a nombre del propietario. Route 53 Domains no admite `.pe`, y hoy la consulta DNS da NXDOMAIN.
- [!] Zona hospedada pública en Route 53, con la delegación NS configurada en el registrador. Hoy hay 0 zonas.
- [!] Certificado ACM en **us-east-1** para CloudFront: `busperuonline.pe` y `www.busperuonline.pe`, validación DNS, estado `ISSUED`.
- [!] Certificado ACM en **sa-east-1** para el ALB (`api.busperuonline.pe`), estado `ISSUED`. Hoy hay 0 certificados en ambas regiones.
- [ ] Registros preparados pero **no** activados todavía:
  - alias A/AAAA de `busperuonline.pe` hacia CloudFront;
  - alias de `api` hacia la distribución CloudFront de la API (F18-18: el ALB solo admite CloudFront);
  - `www` con redirección 301.
- [ ] TTL bajo (60–300 s) en los registros que se van a cambiar, al menos 24 h antes del corte.

### A.2 Frontend

- [x] El build es reproducible y usa el mismo commit en staging (F18-17: `index-BxZI4lM0.js`).
- [ ] Build con `VITE_API_URL=https://api.busperuonline.pe/api`. El build falla con localhost o sin https.
- [ ] Verificar que el bundle no contiene `localhost`, ningún dominio de staging, claves de Culqi o Resend, JWT ni source maps.
- [ ] Bucket S3 de producción privado con OAC, bloqueo público, SSE y versionado.
- [ ] Distribución de CloudFront con:
  - alias de dominio y certificado de us-east-1;
  - TLS 1.2 como mínimo;
  - reescritura SPA;
  - **política de cabeceras con CSP** (staging no tiene CSP en la web; ver el informe §6).
- [ ] Script de publicación del frontend versionado en el repo. Hoy vive fuera del repo; ver el informe §14.

### A.3 Backend

- [ ] Artefacto `make-release.sh` desde un commit etiquetado (`vX.Y.Z`). Hoy no hay tags.
- [ ] SHA-256 del artefacto anotado y comprobado en la EC2 antes de extraerlo.
- [ ] EC2 de producción:
  - IMDSv2 obligatorio;
  - rol `busperu-prod-app-role`;
  - sin SSH abierto, acceso por SSM;
  - EBS cifrado (clave `aws/ebs`: el rol de ejecución no puede usar la CMK de datos, F18-18) y DLM activo con 14 copias.
- [ ] Servicio systemd `busperu-api` con `render-env.sh` y `BUSPERU_ENV=prod`, que lee `/busperu/prod/app/`.

### A.4 RDS

- [ ] RDS MariaDB 10.11 con esta configuración:
  - privada (`PubliclyAccessible=false`);
  - cifrada con `alias/busperu-prod-rds`;
  - `DeletionProtection=true`;
  - retención de backups de **14 días** con PITR;
  - Multi-AZ, según la decisión de coste.
- [ ] Base `busperu_prod` y usuarios `busperu_migrator` / `busperu_app` creados con `create-db-users.sh`, limitados a la VPC.
- [ ] Esquema instalado con `apply-migrations.sh` en una base **vacía**: dump y migraciones 001→019.
- [ ] `schema-fingerprint.cjs` en PASS contra `schema-reference.json`: 49 tablas, 496 columnas, 221 índices, 81 FK y 12 CHECK.

### A.5 KMS, IAM y CloudTrail

- [x] Las tres CMK (`busperu-prod-secrets`, `busperu-prod-data` y `busperu-prod-rds`) están Enabled y con rotación activada. F18-17 lo verificó.
- [x] Roles de producción presentes:
  - `BusPeruProdOperator`
  - `BusPeruProdCloudFormationExecution`
  - `BusPeruProdRecovery`
  - `BusPeruProdBreakGlass`
  - `busperu-prod-app-role`
  - `BusPeruProdCloudTrailToLogs`
- [x] CloudTrail `busperu-prod-trail`:
  - registrando, multirregión, con eventos globales y validación de integridad;
  - entrega sin errores a S3 y a CloudWatch Logs.
- [x] Access Analyzer `busperu-account-external-access` ACTIVE, con 0 hallazgos activos.
- [ ] Decisión sobre IAM Identity Center: requiere AWS Organizations. La alternativa es aceptar el flujo actual con MFA.
- [ ] Clave de acceso del usuario humano: **Inactive** fuera de las ventanas de trabajo. Hoy está Active; ver el informe §8.
- [ ] Política de contraseñas de la cuenta IAM definida. Hoy no existe.
- [ ] Prueba real de `kms:Decrypt` del runtime desde la EC2 de producción.

### A.6 CloudWatch

- [x] 11 alarmas de seguridad de producción en estado OK.
- [!] Suscripción **confirmada** a `busperu-prod-security` y `busperu-prod-alarms`. Hoy hay 0 suscripciones.
- [ ] Alarmas de aplicación de producción (lista mínima en el informe §13):
  - 5xx del ALB;
  - destinos no sanos;
  - latencia p95;
  - CPU y estado de la EC2;
  - CPU, memoria libre, almacenamiento y conexiones de RDS;
  - fallos del job de expiración;
  - backups.
- [ ] Grupo de logs `/busperu/prod/app` con 90 días de retención. Fijar también la retención del grupo `/aws/rds/.../error`.
- [ ] Presupuesto de AWS Budgets con alerta de coste. Hoy no hay ninguno.

### A.7 Resend

- [!] Cuenta de Resend y dominio de envío `busperuonline.pe` verificado con SPF, DKIM, DMARC y return-path.
- [!] `RESEND_API_KEY` en `/busperu/prod/app/RESEND_API_KEY`, como SecureString con la CMK de secretos. La carga el propietario.
- [ ] `MAIL_TRANSPORT=resend` y `RESEND_FROM_EMAIL=soporte@busperuonline.pe`. El guard rechaza el dominio sandbox de Resend.
- [ ] Envío de prueba **a un buzón del propietario**, no a clientes.

### A.8 Culqi

- [!] Llaves LIVE: `CULQI_PUBLIC_KEY`, `CULQI_PRIVATE_KEY` y `CULQI_WEBHOOK_SECRET`, como SecureString. Las carga el propietario.
- [ ] Las tres llaves tienen el mismo modo (el guard lo exige).
- [ ] `CULQI_API_URL` en https.
- [ ] Webhook registrado en el panel de Culqi: `https://api.busperuonline.pe/api/culqi/webhook/<segmento secreto>`.
- [ ] Plan de pago real mínimo acordado: importe, tarjeta del propietario y reembolso inmediato.

### A.9 OAuth (opcional al lanzar)

- [ ] Google y Microsoft: cliente de producción con redirect `https://api.busperuonline.pe/api/auth/oauth/<proveedor>/callback`.
- [ ] `OAUTH_CALLBACK_BASE_URL` en https.
- [ ] Si OAuth no se activa al lanzar, dejar vacíos los pares `*_CLIENT_ID` / `*_CLIENT_SECRET`. El guard exige pares completos.

### A.10 Secretos y configuración

- [ ] `/busperu/prod/app/*` completo según la matriz del informe §4. Hoy hay 0 parámetros.
- [ ] `JWT_SECRET` nuevo, de al menos 32 caracteres y 10 distintos. **No** reutilizar el de staging.
- [ ] `INTEGRATIONS_ENCRYPTION_KEY` de 32 bytes, nueva.
- [ ] Copia fuera de línea custodiada por el propietario.
- [ ] `NODE_ENV=production`, `FRONTEND_URL=https://busperuonline.pe` y `TRUST_PROXY`, que debe ser un número de saltos o una lista de IP, nunca `true`.
- [ ] El proceso arranca: `production-guard` y `secrets-guard` sin errores.

### A.11 CORS, cookies y límites

- [ ] CORS con el origen exacto `https://busperuonline.pe`, sin `*`.
- [ ] La sesión usa un token Bearer en `localStorage`: no hay cookies de sesión y el CSRF no aplica. El riesgo que queda es XSS, que se mitiga con la CSP de A.2.
- [ ] `RATE_LIMIT_GLOBAL=300/min` y `RATE_LIMIT_AUTH=20/15 min`. El almacén vive en memoria, así que solo sirve con **una** instancia.
- [ ] HSTS activo tanto en la web como en la API.

### A.12 Migraciones y vuelta atrás

- [ ] Snapshot manual de RDS antes de cualquier migración, identificado con el release.
- [ ] Plan de vuelta atrás leído y aceptado (informe §15): frontend, backend y base de datos. En la base se avanza siempre con una corrección nueva; la restauración desde snapshot queda como última opción.
- [ ] Ventana de mantenimiento comunicada, si procede.

### A.13 Autorizaciones

- [!] Autorización explícita del propietario para el despliegue de producción.
- [ ] Autorización para crear recursos con coste: VPC, EC2, RDS, ALB, CloudFront, S3 y NAT si aplica.
- [ ] Autorización para cambiar el DNS público.
- [ ] Autorización para activar Culqi LIVE y Resend de producción.

---

## B. Durante el despliegue

- [ ] **B.1 Snapshot.** Crear `busperu-prod-pre-<release>` y esperar a `available`. Si es la primera instalación y la base está vacía, anotar «n/a».
- [ ] **B.2 Release ID.** Anotar el tag `vX.Y.Z`, el commit y el nombre del release en la EC2.
- [ ] **B.3 Hash del artefacto.** Anotar el SHA-256 del tar del backend y el manifiesto (SHA-256) de `dist/`. Comprobar ambos en destino.
- [ ] **B.4 Migración.**
  - En una base vacía: `apply-migrations.sh`.
  - En una base existente: `apply-one-migration.sh <archivo> busperu_prod`, **una por una**.
  - En ambos casos, después pasar `schema-fingerprint.cjs`.
- [ ] **B.5 Backend.** Ejecutar `deploy-release.sh`, cambiar el enlace `current` y reiniciar `busperu-api`. Revisar `journalctl` sin errores.
- [ ] **B.6 Frontend.** Subir `assets/` con caché larga e `index.html` con `no-cache`, e invalidar `/index.html` y `/`.
- [ ] **B.7 Salud.**
  - `GET /api/ready` → 200.
  - `GET /api/health` → 200.
  - Target group `healthy`.
- [ ] **B.8 Smoke.** Ejecutar la sección D. Si **cualquier** paso falla, aplicar el rollback de §15 antes de abrir tráfico.
- [ ] **B.9 DNS.** Solo después de B.7 y B.8: activar los alias y confirmar la resolución desde fuera.

---

## C. Después del despliegue

Usar solo cuentas del propietario o cuentas QA marcadas. Nada contra usuarios reales.

| # | Verificación | Resultado esperado |
| --- | --- | --- |
| C.1 | Login con email y contraseña | 200 y panel correcto según el rol |
| C.2 | Logout | 200; el mismo token da 401 después (revocación por `jti`) |
| C.3 | CUSTOMER | Portal del cliente: sus reservas y ningún dato ajeno |
| C.4 | OPERATOR | Solo su empresa; sin menús de ADMIN (`/api/admin/branding` → 403) |
| C.5 | COMPANY_ADMIN | Solo su empresa; los catálogos globales son de solo lectura |
| C.6 | ADMIN | Panel completo; la caché SWR solo existe en ADMIN |
| C.7 | Búsqueda | `/` y la búsqueda de viajes devuelven resultados publicados |
| C.8 | Reserva | Se crea una reserva y su expiración queda programada |
| C.9 | Pago | Primero en modo **sandbox** en staging. En LIVE, un único cargo mínimo del propietario, previamente autorizado |
| C.10 | Cancelación | Reserva cancelada y asientos liberados |
| C.11 | Reembolso | Reembolso del cargo de C.9 visible en Culqi y en BusPerú, sin reembolsar de más |
| C.12 | Notificaciones | Correo de Resend recibido en el buzón del propietario |
| C.13 | Reportes | Los reportes de ADMIN y de empresa cargan sin 5xx |
| C.14 | Logs | `/busperu/prod/app` recibe logs sin secretos ni tokens |
| C.15 | Métricas | ALB: 0 errores 5xx y latencia estable durante 1 h |
| C.16 | Alarmas | Todas en OK; una prueba de notificación llega a la suscripción confirmada |

---

## D. Smoke test de go-live (no destructivo)

Solo lecturas y sesión, sin crear datos. Un fallo en cualquier paso hace fallar el go-live. Las credenciales se leen
de archivos locales del operador (`chmod 600`) y nunca se imprimen.

| # | Petición | Esperado |
| --- | --- | --- |
| D.1 | `GET https://busperuonline.pe/` | 200, `index.html` con `Cache-Control: no-cache`, HSTS y CSP |
| D.2 | `GET /destinos` | 200 (SPA) y la página renderiza destinos |
| D.3 | `GET /empresas` | 200 (SPA) |
| D.4 | `GET /ofertas` | 200 (SPA) |
| D.5 | `GET /api/ready` | 200 `{"status":"ready"}` |
| D.6 | `GET /api/health` | 200 `{"success":true,...}` |
| D.7 | `OPTIONS /api/auth/login` con `Origin: https://evil.example` | Sin eco de ese origen |
| D.8 | `GET /api/auth/me` sin token | 401 |
| D.9 | `POST /api/auth/login` (cuenta QA de cada rol) | 200 con token (no se imprime) |
| D.10 | `GET /api/auth/me` con el token | 200 y rol correcto |
| D.11 | `POST /api/auth/logout` | 200 |
| D.12 | `GET /api/auth/me` con el token revocado | **401** |
| D.13 | D.9–D.12 para CUSTOMER, OPERATOR, COMPANY_ADMIN y ADMIN | Los 4 pasan |
| D.14 | Con OPERATOR: `GET /api/admin/branding` (solo ADMIN, `requireRole('ADMIN')`) | 403 |

Script de referencia (bash; requiere `curl` y `jq`). Las contraseñas se leen de archivos locales del operador y nunca
se imprimen:

```bash
#!/usr/bin/env bash
set -euo pipefail
WEB=https://busperuonline.pe
API=https://api.busperuonline.pe/api
CRED_DIR=${CRED_DIR:?directorio con <rol>.email y <rol>.pw, chmod 600}
fallos=0
ok() { printf 'PASS %s\n' "$1"; }
ko() { printf 'FAIL %s\n' "$1"; fallos=$((fallos + 1)); }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

for p in / /destinos /empresas /ofertas; do
  [ "$(code "$WEB$p")" = 200 ] && ok "web $p" || ko "web $p"
done
[ "$(code "$API/ready")" = 200 ] && ok ready || ko ready
[ "$(code "$API/health")" = 200 ] && ok health || ko health
eco=$(curl -s -D - -o /dev/null -X OPTIONS "$API/auth/login" -H 'Origin: https://evil.example' \
  -H 'Access-Control-Request-Method: POST' | grep -ci 'access-control-allow-origin: https://evil.example' || true)
[ "$eco" = 0 ] && ok "cors evil" || ko "cors evil"
[ "$(code "$API/auth/me")" = 401 ] && ok "me sin token" || ko "me sin token"

for rol in CUSTOMER OPERATOR COMPANY_ADMIN ADMIN; do
  body=$(jq -n --rawfile e "$CRED_DIR/$rol.email" --rawfile p "$CRED_DIR/$rol.pw" \
    '{email: ($e | rtrimstr("\n")), password: ($p | rtrimstr("\n"))}')
  tok=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' -d "$body" | jq -r '.data.token // empty')
  [ -n "$tok" ] && ok "$rol login" || { ko "$rol login"; continue; }
  r=$(curl -s "$API/auth/me" -H "Authorization: Bearer $tok" | jq -r '.data.role // empty')
  [ "$r" = "$rol" ] && ok "$rol me" || ko "$rol me"
  if [ "$rol" = OPERATOR ]; then
    [ "$(code "$API/admin/branding" -H "Authorization: Bearer $tok")" = 403 ] && ok "OPERATOR sin admin" || ko "OPERATOR sin admin"
  fi
  [ "$(code -X POST "$API/auth/logout" -H "Authorization: Bearer $tok")" = 200 ] && ok "$rol logout" || ko "$rol logout"
  [ "$(code "$API/auth/me" -H "Authorization: Bearer $tok")" = 401 ] && ok "$rol revocado" || ko "$rol revocado"
  unset tok
done
echo "fallos=$fallos"
[ "$fallos" = 0 ]
```

Notas:

- Staging ya tiene su smoke y su E2E versionados: `infra/aws/scripts/smoke-staging.mjs` (37/37) y `e2e-staging.mjs` (18/18). **Crean datos QA**, así que en producción solo se usa este smoke de solo lectura y sesión.
- El límite de login es de 20 intentos por 15 min: una ejecución completa consume 4.
- Adaptar `jq` si la forma de `/auth/me` cambia. Validar el script en staging (con `WEB`/`API` de staging) antes del go-live.
