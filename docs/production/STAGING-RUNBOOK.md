# BusPerú · Runbook de staging en AWS (F18-03)

> **Estado (F18-04, 2026-09-23):** staging **desplegado en AWS** (`sa-east-1`, pila `busperu-staging`) con el
> rol `BusPeruStagingDeployer`: esquema 001→018 idéntico a la referencia, versión `2026-09-23-2`, primer
> administrador sintético, comisión 10.00 y **32/32 pruebas de humo**, con reinicio del servicio y de la EC2.
> Sin dominio ni HTTPS: el ALB solo admite las dos IP del operador. Los tropiezos del primer despliegue y sus
> correcciones están en §2 (DLM, ELB, KMS, plan de la cuenta) y §6 (`EnvironmentFile`).
>
> **Staging no es producción.** Datos sintéticos, Culqi en modo prueba y nunca abierto al público.

Región objetivo: **sa-east-1 (São Paulo)**, la más cercana a Perú. Todo se nombra `busperu-staging-*`.

---

## 0. Qué se necesita antes de empezar

| Requisito | Estado |
| --- | --- |
| AWS CLI v2 instalada | hecho (F18-03C) |
| Identidad de despliegue `BusPeruStagingDeployer` (rol, sin AdministratorAccess) | **hecho (F18-03D)** · ver `AWS-ARCHITECTURE.md` §9-ter |
| Credenciales para asumir el rol | **MFA obligatoria desde F18-07B** (2026-09-24): el propietario inicia cada sesión con su código (`IAM-MONITORING-F18-07B.md` §2); la clave de origen queda Inactive fuera de las sesiones |
| Autorización de coste (RDS, EC2, ALB, EBS y la instancia temporal del restore facturan) | **pendiente** |
| `FRONTEND_DOMAIN` y `API_DOMAIN` reales | **pendientes** (§11) |

Nada de lo que sigue debe ejecutarse con credenciales de producción de terceros (Culqi live, Resend
de producción, OAuth de producción): staging usa claves de prueba.

---

## 1. Inventario previo (solo lectura, obligatorio)

```bash
AWS_PROFILE=busperu-staging bash infra/aws/scripts/inventory.sh sa-east-1
```

Lista VPC, subredes, security groups, EC2, RDS, ALB, ACM, S3, CloudFront, Route 53, roles IAM,
parámetros y secretos (**solo nombres**), logs, alarmas y pilas de CloudFormation. No modifica nada.
Sirve para confirmar qué existe ya y para **no** tocarlo. Anotar también, de su última sección, las
versiones `10.11.x` disponibles en la región: la exacta se fija en el paso siguiente.

---

## 2. Desplegar la infraestructura

**Todo lo que sigue se ejecuta con el rol `BusPeruStagingDeployer`, nunca con el usuario administrador.**
Sus políticas viven en `infra/aws/iam/` (`node build-iam.mjs && node check-iam.mjs` para regenerarlas y
comprobarlas); se despliegan con la cuenta real solo fuera del repositorio (`--account … --out …`).
Los roles que crea la pila llevan el límite `BusPeruStagingWorkloadBoundary`: sin él, el rol de despliegue no
puede crearlos.

La plantilla vive en `infra/aws/cloudformation/` como generador JS (`build-template.mjs`) que escribe
`busperu-staging.json`. Antes de desplegar, regenerar y comprobar:

```bash
cd infra/aws/cloudformation && node build-template.mjs && node check-template.mjs
```

`check-template.mjs` valida referencias y las reglas de la fase: RDS privada y cifrada, MariaDB
10.11, modo estricto, sin puerto 22, sin `0.0.0.0/0` de entrada, 3306 solo desde la EC2, API solo
desde el ALB, IMDSv2, health check en `/api/ready` y ningún secreto dentro de la plantilla.

```bash
aws cloudformation deploy --region sa-east-1 \
  --stack-name busperu-staging \
  --template-file infra/aws/cloudformation/busperu-staging.json \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      AllowedIngressCidr=<TU_IP>/32 \
      AllowedIngressCidr2=<TU_SEGUNDA_IP>/32 \
      DbEngineVersion=10.11.<minor del inventario> \
      AlarmEmail=<correo para alarmas>
```

- **`AllowedIngressCidr` es obligatorio** y no admite `0.0.0.0/0`: staging solo se abre a tu IP. Su patrón
  acepta de `/16` a `/32`.
- **`AllowedIngressCidr2`** (opcional, solo `/32`): segunda IP permitida. Hace falta cuando la conexión del
  operador sale por dos IP públicas que se alternan (NAT del proveedor), como ocurrió en F18-04; se comprueba
  consultando varias veces `https://checkip.amazonaws.com`. En cada actualización de la pila hay que pasar
  ambos con `UsePreviousValue=true`, o la segunda regla desaparece.
- Lo que el change set **no** valida y falló al crear en F18-04 (ya corregido y cubierto por
  `check-template.mjs`): la descripción de DLM solo admite `[0-9A-Za-z _-]`, y el ALB necesita que el rol de
  despliegue tenga `ec2:GetSecurityGroupsForVpc` (el servicio ELB la invoca con sus credenciales).
- **Sin `CertificateArn` no hay HTTPS**: el ALB queda en HTTP y por eso el acceso va restringido por
  IP. Con dominio y certificado (§11) se redespliega con `CertificateArn=arn:aws:acm:…` y entonces
  hay 443 con redirección desde 80.
- Red y permisos revisados en F18-03B (`AWS-ARCHITECTURE.md` §8): la EC2 sale a Internet por su IP pública y el
  Internet Gateway, así que **no hace falta NAT**; su salida se limita a 443, hora y 3306 hacia la base; y el rol de
  la instancia no usa políticas gestionadas, solo lo mínimo, con los parámetros limitados a `/busperu/staging/`.
- Qué crea: VPC (2 subredes públicas y 2 privadas, sin NAT), security groups, RDS MariaDB 10.11
  privada y cifrada con su parameter group en modo estricto, EC2 sin SSH, volumen EBS de datos con
  snapshots diarios (DLM), ALB, bucket de artefactos, grupo de logs, tema SNS y 12 alarmas.
- Salidas útiles: `LoadBalancerDns`, `DatabaseEndpoint`, `DatabaseMasterSecretArn`, `AppInstanceId`,
  `DataVolumeId`, `ArtifactsBucketName`.

```bash
aws cloudformation describe-stacks --region sa-east-1 --stack-name busperu-staging \
  --query 'Stacks[0].Outputs' --output table
```

---

## 3. Parámetros y secretos (Parameter Store)

La aplicación **solo** lee `/busperu/staging/app/`. El migrador vive en `/busperu/staging/ops/`, así
que sus credenciales nunca entran en el entorno de la API.

| Parámetro (`/busperu/staging/app/…`) | Tipo | Notas |
| --- | --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_NAME` | String | `DB_NAME` = `busperu_staging` |
| `DB_USER` | String | `busperu_app` (nunca el maestro ni root) |
| `DB_PASSWORD` | SecureString | la genera §4 |
| `JWT_SECRET` | SecureString | ≥ 32 caracteres aleatorios |
| `INTEGRATIONS_ENCRYPTION_KEY` | SecureString | 32 bytes en base64 (44 caracteres) |
| `INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS` | SecureString | **solo durante una rotación** |
| `FRONTEND_URL` | String | https pública; sin ella la guarda no deja arrancar |
| `TRUST_PROXY` | String | `1` detrás del ALB |
| `STORAGE_DIR` | String | `/data/busperu/storage` |
| `PORT` | String | `3000` |
| `MAIL_TRANSPORT` | String | `resend` o `smtp` |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | SecureString / String | con `MAIL_TRANSPORT=resend` |
| `OAUTH_CALLBACK_BASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | String / SecureString | opcionales; cada proveedor va en pareja o no va |
| `CULQI_PUBLIC_KEY`, `CULQI_PRIVATE_KEY`, `CULQI_WEBHOOK_SECRET`, `CULQI_API_URL` | SecureString / String | **solo llaves `test` en staging** |

`/busperu/staging/ops/MIGRATOR_DB_PASSWORD` (SecureString) es la del migrador.
`VITE_API_URL` **no** va aquí: es una variable de build del frontend (§10).

Generar un secreto sin que aparezca en el historial ni en `ps`:

```bash
umask 077; f=$(mktemp)
openssl rand -base64 36 | tr '+/' '-_' | tr -d '=\n' > "$f"      # contraseñas de base de datos
aws ssm put-parameter --region sa-east-1 --name /busperu/staging/app/DB_PASSWORD \
  --type SecureString --value "file://$f" --overwrite
shred -u "$f"
```

Para `INTEGRATIONS_ENCRYPTION_KEY` el formato es distinto: `openssl rand -base64 32` (44 caracteres,
con `=` final). **Si ya existe una clave en uso, no se genera otra**: perdería el acceso a las
credenciales cifradas que haya guardadas. Ninguna de estas claves debe imprimirse ni pegarse en
documentación, tickets o chats.

---

## 4. Usuarios de base de datos

Los crea el usuario maestro, y solo aquí. Para que la EC2 pueda leer ese secreto un momento, se
redespliega con `AllowMasterSecretAccess=true`, se ejecuta el script y se vuelve a `false`.

```bash
aws cloudformation deploy … --parameter-overrides AllowMasterSecretAccess=true …   # resto igual
aws ssm start-session --region sa-east-1 --target <AppInstanceId>
# ya dentro de la instancia:
sudo DB_HOST=<DatabaseEndpoint> MASTER_SECRET_ARN=<DatabaseMasterSecretArn> \
  bash /opt/busperu/current/infra/aws/scripts/create-db-users.sh
exit
aws cloudformation deploy … --parameter-overrides AllowMasterSecretAccess=false …
```

Crea `busperu_staging` (utf8mb4 / utf8mb4_unicode_ci) y dos usuarios, ambos limitados a esa base y
a la red de la VPC (`10.20.%`):

| Usuario | Privilegios | Para qué |
| --- | --- | --- |
| `busperu_app` | `SELECT, INSERT, UPDATE, DELETE` | la API en ejecución (`GET_LOCK` no necesita privilegio) |
| `busperu_migrator` | los anteriores + `CREATE, ALTER, DROP, INDEX, REFERENCES, LOCK TABLES` | importar el dump y aplicar migraciones |

Comprobado en el ensayo: con esos permisos, `busperu_app` no puede crear, alterar ni borrar tablas,
ni leer otras bases ni `mysql.user`; `busperu_migrator` tampoco puede crear bases ni dar permisos.

---

## 5. Esquema: dump y migraciones 001 → 021

```bash
sudo DB_HOST=<DatabaseEndpoint> bash /opt/busperu/current/infra/aws/scripts/apply-migrations.sh
```

Se ejecuta como `busperu_migrator`, **sin `--force`**, y se detiene en el primer error. Antes
comprueba que el servidor sea MariaDB 10.11 con el modo estricto esperado y que la base esté vacía.
Resultado esperado: dump + 21 migraciones OK y 56 tablas (F18-19; eran 19 y 49 hasta F18-18).

Verificación obligatoria frente a la referencia (`schema-reference.json`, regenerada en MariaDB 10.11.19 en F18-19):

```bash
umask 077; f=$(mktemp)
aws ssm get-parameter --region sa-east-1 --name /busperu/staging/ops/MIGRATOR_DB_PASSWORD \
  --with-decryption --query Parameter.Value --output text > "$f"
DB_HOST=<endpoint> DB_USER=busperu_migrator DB_PASSWORD_FILE="$f" DB_NAME=busperu_staging \
  node /opt/busperu/current/infra/aws/scripts/schema-fingerprint.cjs
shred -u "$f"
```

Compara columnas, índices, claves ajenas y CHECKs con `schema-reference.json` (645 / 253 / 96 / 25 desde F18-19; con
001→019 eran 496 / 221 / 81 / 12, y 492 columnas hasta la 018) y
comprueba las reglas de F18-02B: columnas generadas STORED, `ON UPDATE RESTRICT` en
`fk_integrations_company` y `fk_bus_layouts_bus`, colación `utf8mb4_unicode_ci` y columnas JSON como
texto. Cualquier diferencia detiene el despliegue.

> **`busperu_staging` existente (F18-19):** está en 001→019. Antes de desplegar el código de F18-19 hay que aplicarle
> `020-company-public-profiles.sql` y después `021-complaint-book.sql` con `apply-one-migration.sh` (una por una, con
> snapshot previo) y pasar la huella. Hasta entonces, la huella nueva da diferencias: es lo esperado.

### 5.1 Base que ya existe: migración 019 y cifrado de los datos bancarios (F18-07)

La versión con la migración 019 **exige** esa migración antes de desplegar: la API escribe los datos bancarios
en columnas nuevas y ya no en claro. En una base con datos (como `busperu_staging`, instalada con 001 → 018):

1. Snapshot manual de RDS (el rol de despliegue puede crearlos; no puede borrarlos).
2. `019-bank-accounts-encryption.sql` con `busperu_migrator`, **sin `--force`**. Es idempotente y no borra nada:
   añade 4 columnas y permite NULL en `account_number`. Con el paquete de la versión nueva extraído en un
   directorio temporal (la versión en marcha aún no trae el script):
   `DB_HOST=<endpoint> bash infra/aws/scripts/apply-one-migration.sh 019-bank-accounts-encryption.sql busperu_staging <raíz>`
   (F18-07A). Aplica solo ese archivo, exige repetir el nombre de la base y que tenga las 49 tablas, y se
   detiene en el primer error. Ensayado en MariaDB 10.11.19 estricto antes de usarlo en AWS.
3. Desplegar la versión nueva (`deploy-release.sh`).
4. En la instancia, con el entorno de la API: `npm run bank:encrypt -- --cifrar` y después `-- --verificar`
   (debe dar `sin cifrar 0 · ilegibles 0 · discrepancias 0`). «Entorno de la API» = las líneas de
   `/run/busperu/api.env` **más `NODE_ENV=production`**, que pone la unidad systemd y no está en ese archivo; sin
   ella la aplicación se niega a arrancar contra una base que no termina en `_test` (visto en F18-07A):
   `cd /opt/busperu/current/backend && while IFS= read -r l; do export "$l"; done < /run/busperu/api.env && NODE_ENV=production npm run bank:encrypt -- --verificar`
5. Solo entonces: `npm run bank:encrypt -- --purgar-texto-plano --base=busperu_staging`, que se niega si la
   verificación no es perfecta y vuelve a comprobar cada fila antes de vaciarla.
6. `schema-fingerprint.cjs` debe dar la referencia de 496 columnas.

Vuelta atrás: `-- --revertir --base=busperu_staging` repone el texto en claro desde el cifrado y la versión
anterior de la API vuelve a funcionar. **Cuidado (F18-07A):** la versión anterior a F18-07 devuelve todas las
columnas de la fila, así que con las columnas nuevas llenas serviría el sobre cifrado y los últimos 4 a quien ya
veía la cuenta. Antes de volver a ella, tras `--revertir` y comprobar que la API anterior lee el número, vaciar
`account_number_encrypted`, `account_number_last4`, `interbank_code_encrypted` e `interbank_code_last4`. Entre la
019 y el despliegue de la versión nueva esas columnas están a NULL, sin nada que exponer. Preferible corregir hacia
delante. El script solo imprime recuentos.
Requiere `INTEGRATIONS_ENCRYPTION_KEY` (la misma clave, con su rotación, que las integraciones).

### 5.2 Rotación de `INTEGRATIONS_ENCRYPTION_KEY` con datos bancarios (F18-07A)

1. `…/app/INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS` ← valor vigente; `…/app/INTEGRATIONS_ENCRYPTION_KEY` ← clave
   nueva de 32 bytes aleatorios (SecureString). Reiniciar el servicio (`render-env.sh` vuelve a leer `app/`).
2. `npm run bank:encrypt -- --verificar`: `solo con la clave anterior N` indica cuántas cuentas dependen aún de
   la anterior (se siguen leyendo; lo nuevo ya va con la nueva).
3. `npm run bank:encrypt -- --recifrar`: vuelve a cifrar con la vigente esas cuentas. Se niega si alguna cuenta
   es ilegible o tiene discrepancias, y comprueba cada sobre nuevo antes de escribirlo.
4. `-- --verificar` debe dar `solo con la clave anterior 0 · ilegibles 0`.
5. Retirar `…_PREVIOUS` **solo si** tampoco hay integraciones (`company_integrations`) cifradas con ella: las
   integraciones se re-cifran al volver a guardarse, no en bloque. Reiniciar y repetir `--verificar`.

Ninguno de estos pasos imprime una clave: el valor antiguo queda en el historial del parámetro, que solo leen
quienes ya podían leer el vigente.

---

## 6. Instancia: Node 24, almacenamiento y servicio

```bash
aws ssm start-session --region sa-east-1 --target <AppInstanceId>
sudo bash /opt/busperu/current/infra/aws/scripts/bootstrap-ec2.sh \
  --data-volume <DataVolumeId> --format-new-volume    # --format-new-volume SOLO la primera vez
```

Sin *plugin* de Session Manager en el equipo del operador, los mismos comandos pueden lanzarse con Run Command
(`aws ssm send-command --document-name AWS-RunShellScript --targets Key=tag:aws:cloudformation:stack-name,Values=busperu-staging …`),
que el rol de despliegue tiene permitido solo sobre la instancia de la pila (F18-04).

Instala Node **24.15.0** verificando su SHA-256, crea el usuario de sistema `busperu`, monta el EBS
en `/data` por UUID en `/etc/fstab` (**no formatea un volumen que ya tenga datos**), prepara
`/data/busperu/storage`, instala la unidad systemd, logrotate y el agente de CloudWatch.

La unidad (`infra/aws/systemd/busperu-api.service`) corre como `busperu` (nunca root), recibe
`SIGTERM` con 30 s de margen para el cierre ordenado, reinicia si falla y monta los secretos en
`/run/busperu/api.env` (tmpfs, 0600) que genera `render-env.sh` desde Parameter Store en cada
arranque y borra al parar. La directiva es `EnvironmentFile=-/run/busperu/api.env`: sin el `-`, systemd
intenta leer el archivo antes del `ExecStartPre` que lo crea y el servicio no arranca nunca («unavailable
resources»; ocurrió en F18-04 y se corrigió en la versión `2026-09-23-2`). `ProtectSystem=strict` deja escribibles solo el almacén y los logs.

---

## 7. Desplegar la aplicación

En el equipo del operador:

```bash
bash infra/aws/scripts/make-release.sh 2026-09-23-1
aws s3 cp infra/aws/.releases/busperu-2026-09-23-1.tar.gz        s3://<ArtifactsBucket>/releases/
aws s3 cp infra/aws/.releases/busperu-2026-09-23-1.tar.gz.sha256 s3://<ArtifactsBucket>/releases/
```

En la instancia:

```bash
sudo /opt/busperu/bin/deploy-release.sh <ArtifactsBucket> 2026-09-23-1
```

Verifica el SHA-256, instala dependencias de producción, cambia el enlace `current` de forma
atómica, reinicia el servicio y espera a que `/api/ready` responda 200. **Si no lo hace en 90 s,
vuelve solo a la versión anterior.** El paquete no incluye `.env`, `node_modules` ni `storage`.

---

## 8. Primer administrador y ajuste obligatorio

```bash
sudo -u busperu env $(sudo cat /run/busperu/api.env | xargs) \
  /opt/node/bin/node /opt/busperu/current/backend/dist/scripts/bootstrap-admin.js
```

Pide correo, nombres y contraseña (dos veces, sin eco) y exige teclear el nombre de la base. Se
niega si ya existe un administrador y no acepta argumentos.

**Ajuste obligatorio que una base recién instalada no trae: `platform.default_commission`.**
Ninguna migración lo crea (solo el seed de desarrollo y las fixtures de prueba) y, sin él, la API
**rechaza dar de alta o aprobar empresas** con un 409 —a propósito: nunca vende con comisión 0—.

> **DECISIÓN PENDIENTE (negocio):** el porcentaje. El proyecto no documenta ninguno; el `10.00` del
> seed es un dato de ejemplo de desarrollo y **no** debe copiarse a staging ni a producción sin que
> el negocio lo confirme.

Con el valor decidido:

```bash
API_BASE_URL=https://API_DOMAIN/api ADMIN_EMAIL=<admin> ADMIN_PASSWORD_FILE=<archivo> \
PLATFORM_DEFAULT_COMMISSION=<porcentaje decidido> \
  node infra/aws/scripts/set-platform-commission.mjs
```

Va por la API con el ADMIN (queda en la auditoría y respeta el RBAC: COMPANY_ADMIN, OPERATOR y
CUSTOMER reciben 403), aplica la misma validación que el servicio (hasta 3 enteros y 2 decimales,
máximo 100), **no tiene valor por defecto** y es idempotente. Si el ajuste ya existe con otro valor,
no lo cambia salvo con `PLATFORM_COMMISSION_OVERWRITE=1`, y cambiarlo no afecta a las empresas ya
aprobadas, que conservan su propia tasa.

---

## 9. Comprobaciones y pruebas de humo

```bash
API_BASE_URL=https://API_DOMAIN/api  FRONTEND_ORIGIN=https://FRONTEND_DOMAIN \
ADMIN_EMAIL=<correo del admin> ADMIN_PASSWORD_FILE=<archivo con su contraseña> \
  node infra/aws/scripts/smoke-staging.mjs
```

32 comprobaciones (exige haber hecho antes el §8 completo, incluida la comisión): disponibilidad (`/api/health` y `/api/ready` sin filtrar nada), cabeceras de
Helmet, CORS (origen permitido, origen ajeno, sin origen, webhook con secreto inválido), límite de
peticiones, login/`me`/logout con revocación, RBAC (401 sin token, alcance del cliente, cifras solo
para ADMIN, y ajustes de plataforma que solo escribe el ADMIN), alta de empresa/catálogos/bus, ubicaciones y ruta, distribución física completa
(asientos con `row_number`, elemento y publicación), viaje y búsqueda pública, reserva con
expiración y cancelación, columnas JSON (llaves de API e integración cifrada) y subida y lectura del
logotipo. Crea sus propios datos sintéticos por la API y no imprime tokens ni contraseñas.

### 9.1 Pruebas sin dejar datos atrás (F18-09)

Desde F18-09, `smoke-staging.mjs` y `e2e-staging.mjs` (itinerario, pago manual, expiración, «Mis viajes», RBAC de 4
roles) **retiran por la API** lo que crean al terminar:
- la integración CULQI ficticia, solo si la crearon ellos;
- el logotipo y su archivo;
- la llave de API;
- la empresa, que pasa a `INACTIVE` y deja de verse en la portada y la búsqueda.

Además escriben un **manifiesto** con los ids creados. La purga física de esos ids la hace `purge-qa-data.cjs` en la EC2.
Es una transacción con salvaguardas: por defecto hace un ensayo con ROLLBACK, borra por ids explícitos y aborta ante
cualquier dato ajeno ligado, ante tablas no contempladas o ante cambios en la configuración o la auditoría. `qa-staging.sh`
lo encadena todo:

```bash
export AWS_PROFILE=busperu-mfa QA_API_URL=https://<api>.cloudfront.net/api QA_WEB_URL=https://<web>.cloudfront.net
infra/aws/scripts/qa-staging.sh pruebas                  # smoke + E2E; manifiestos en ./.qa-staging/
infra/aws/scripts/qa-staging.sh expiry                   # ≥ 16 min después
infra/aws/scripts/qa-staging.sh purgar ./.qa-staging/qa-manifest-*-<sello>.json            # ensayo (ROLLBACK)
infra/aws/scripts/qa-staging.sh purgar ./.qa-staging/qa-manifest-*-<sello>.json --ejecutar # COMMIT
```

`audit_logs` no se toca nunca: al purgar un usuario, su `user_id` pasa a NULL.

**F18-19B · datos de F18-19.** La purga también cubre lo que cuelga de las empresas y usuarios del manifiesto:

- **Perfil público:** perfil, servicios, agencias (con sus horarios y servicios por agencia) y galería, más sus
  imágenes bajo `public/companies/<id>/`.
- **Libro de Reclamaciones:** hojas ligadas a una empresa, un usuario o una reserva del conjunto, y sus eventos. Cada
  hoja debe ser de un consumidor `@busperu-staging.example`; una hoja real ligada a una empresa sintética **aborta** la
  purga, porque las hojas se conservan 2 años. El contador de un año solo se retira si todas sus hojas son del conjunto.

Una prueba que cree hojas sin empresa ni usuario sintéticos (p. ej. anónimas y sin empresa) no las liga al manifiesto:
debe relacionarlas con su empresa sintética.

### 9.2 Datos DEMO permanentes (F18-10)

`infra/aws/scripts/seed-demo-staging.mjs` crea por la API la empresa «BusPerú Demo»: 3 usuarios
`@demo.staging.busperu.invalid`, 4 terminales, 6 rutas, bus `DEMO-001` con 40 asientos y viajes futuros calculados al
ejecutarlo.
- Modos: `--dry-run` (por defecto), `--execute` (idempotente, con deshacer por la API si falla), `--verify [--qa-manifest m.json]` y `--entregar-credenciales` (solo en la terminal del propietario; las muestra una vez).
- La purga de QA **rechaza** cualquier dato DEMO.
- Repetir `--execute` renueva los viajes cuando hayan pasado. Detalle y comandos: `F18-10-DEMO-STAGING.md`. Antes de una purga grande (no la de una
ejecución normal), crear un snapshot manual de RDS. Inventario y limpieza de F18-09: `F18-09-QA-DATA-INVENTORY.md`.

Además, a mano:

- **Readiness real:** parar un momento la base (o quitar la regla del security group) y comprobar
  `/api/ready` → 503, `/api/health` → 200 y que el ALB marca el destino como no sano; restaurar.
- **Persistencia:** subir un logotipo, `sudo systemctl restart busperu-api` y volver a pedirlo;
  después reiniciar la instancia y repetir (el EBS se monta por `fstab`).
- **Cierre ordenado:** `sudo systemctl stop busperu-api` y confirmar en el log que termina sin errores.

---

## 10. Frontend

```bash
cd frontend && VITE_API_URL=https://API_DOMAIN/api npm ci && npm run build
```

El build se niega si la URL no es https pública. Publicación en S3 + CloudFront: **pendiente de
dominio** (§11). En `VITE_*` no va ningún secreto: todo lo que se pone ahí es público.

---

## 11. Dominios, HTTPS y CORS

`FRONTEND_DOMAIN` y `API_DOMAIN` están **sin decidir**, así que:

- el certificado ACM no se puede emitir (se valida por DNS);
- el ALB queda en HTTP restringido por IP y **la aplicación no se publica**;
- `FRONTEND_URL`, `VITE_API_URL` y `OAUTH_CALLBACK_BASE_URL` quedan como marcadores.

Cuando existan: ACM en sa-east-1 para el ALB y en us-east-1 para CloudFront, redespliegue con
`CertificateArn`, y `FRONTEND_URL` **exactamente igual** al origen real (sin barra final): de ahí
sale la única cabecera CORS que la API emite, y no hay comodín ni reflejo del origen.

---

## 12. Backups, restore y rollback

- **RDS:** backups automáticos con 7 días de retención y PITR; snapshot manual antes de cada
  migración. La pila usa `DeletionPolicy: Snapshot`.
- **EBS de datos:** snapshot diario con DLM, 7 copias.
- **RPO/RTO propuestos para staging (DECISIÓN PENDIENTE para producción):** RPO 24 h y RTO 4 h.

**Prueba de restauración (obligatoria, aún no ejecutada):**

```bash
aws rds restore-db-instance-to-point-in-time --region sa-east-1 \
  --source-db-instance-identifier busperu-staging-db \
  --target-db-instance-identifier busperu-staging-restore \
  --use-latest-restorable-time --no-publicly-accessible \
  --db-subnet-group-name <subnet group de la pila> --vpc-security-group-ids <DbSecurityGroup>
```

Cuando esté disponible: ejecutar `schema-fingerprint.cjs` contra la instancia restaurada, comprobar
tablas, índices, claves, CHECKs y algunos datos, y **anotar backup usado, hora, duración y
resultado**. Borrar la instancia temporal solo después, y solo con confirmación explícita:
`aws rds delete-db-instance --db-instance-identifier busperu-staging-restore --skip-final-snapshot`.

**Rollback de la aplicación:** `deploy-release.sh <bucket> <versión anterior>` (o automático si la
nueva no alcanza readiness). **Rollback de esquema:** no hay migraciones «down»; se restaura el
snapshot previo.

---

## 13. Observabilidad

Log de la aplicación en `/busperu/staging/app` (14 días). Alarmas al tema SNS: destinos no sanos del
ALB (readiness), 5xx de destino y del propio ALB, estado y CPU de EC2, memoria y disco (`/` y
`/data`) del agente, y de RDS: CPU, espacio libre, memoria libre y número de conexiones. Los
registros de la aplicación ya van saneados; aun así, nunca añadir secretos a los logs.

---

## 14. Qué se validó en local y qué queda pendiente en AWS

Ensayado contra un **MariaDB 10.11.19 real** (instancia portable aislada) con la API en
`NODE_ENV=production` y el usuario `busperu_app`:

| Validado en local | Resultado |
| --- | --- |
| `create-db-users.sh` (dos veces) | usuarios y permisos correctos e idempotentes |
| Privilegios mínimos | `busperu_app` no puede CREATE/ALTER/DROP/TRUNCATE ni leer otras bases |
| `apply-migrations.sh` | dump + 001→021 sin `--force`; se niega si la base ya tiene tablas (019 validada en 10.11.19 en F18-07; 020–021 en F18-19) |
| `apply-one-migration.sh` | UNA migración nombrada sobre una base existente de 49 tablas, repitiendo el nombre de la base (F18-07A, §5.1) |
| `schema-fingerprint.cjs` | idéntico a la referencia de F18-02B |
| Arranque con configuración de producción | todas las guardas pasan; `/api/ready` 200 |
| `bootstrap-admin` | administrador creado; la contraseña no aparece en la salida |
| `smoke-staging.mjs` | 32/32 (F18-03B) |
| Instalación limpia sin comisión | alta de empresa → 409; el smoke lo señala sin inventar el valor |
| `set-platform-commission.mjs` | se niega sin valor o con valores no válidos; idempotente; no sobrescribe sin permiso explícito |
| Readiness degradado | base caída → 503; `STORAGE_DIR` ausente o archivo → 503; `health` sigue 200 |
| Persistencia de archivos | el logotipo sobrevive al reinicio del proceso |
| Plantilla CloudFormation | `check-template.mjs` en verde (incluye conectividad, salidas de los SG e IAM mínimo) y 9/9 controles negativos detectados |

**Validado en AWS (F18-04):** inventario, despliegue de la pila, RDS MariaDB 10.11.19 real (usuarios,
dump + 001→018, huella idéntica), EC2 con systemd y EBS (persistencia tras reinicio del servicio y de la
instancia), ALB con destino sano, 12 alarmas en OK y 32/32 pruebas de humo contra el ALB.

**Requisito de cuenta:** el plan gratuito de AWS rechaza una retención de backups de 7 días en RDS; la cuenta
debe estar en el plan de pago (F18-04).

**Pendiente de AWS:** **prueba de restauración** de backups, readiness degradado con la base caída, HTTPS y
DNS, correo real, llaves sandbox de Culqi, suscripción al tema de alarmas, y el frontend en S3 + CloudFront.

---

## 15. Coste y desmontaje

Facturan de forma continua: RDS (instancia y almacenamiento), EC2, volúmenes EBS y sus snapshots,
ALB (coste fijo por hora), tráfico de salida y, mientras exista, la instancia del restore. **No se
incluyen cifras aquí**: consultar la calculadora de AWS para sa-east-1 antes de desplegar, y revisar
Cost Explorer después.

Para desmontar staging (destructivo, solo con confirmación explícita):

```bash
aws cloudformation delete-stack --region sa-east-1 --stack-name busperu-staging
```

Deja snapshot de la base y del volumen de datos por `DeletionPolicy`. El bucket de artefactos hay
que vaciarlo antes. `DbDeletionProtection=true` impide borrar la base por accidente: hay que
redesplegar con `false` a propósito.
