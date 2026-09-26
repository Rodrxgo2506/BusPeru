# BusPerú · Runbook de PRODUCCIÓN en AWS (F18-18)

> **Estado: PREPARADO — NO DESPLEGADO.** Este runbook describe cómo se creará producción cuando el propietario lo
> autorice. En F18-18 no se ha creado ninguna pila, ningún recurso de producción, ningún parámetro, certificado ni
> registro DNS. Cada paso con 🔒 necesita la autorización explícita del propietario **en ese momento**.
> Sin secretos en este documento: los valores los introduce el operador en su terminal (o en CloudShell), nunca en un chat.

Complementa: `STAGING-RUNBOOK.md` (procedimientos probados en staging, que aquí se reutilizan), `MIGRATIONS.md`,
`PRODUCTION-READINESS-F18-08.md` (IAM, KMS, CloudTrail, DR) y `F18-17-GO-LIVE-CHECKLIST.md`.

## 1. Arquitectura y pilas

```
Route 53 (busperuonline.pe) ─► CloudFront web  (ACM us-east-1) ─OAC─► S3 privado busperu-prod-web-<cuenta>
                          └──► CloudFront api (api.busperuonline.pe) ─HTTPS + cabecera secreta─► ALB :443 (ACM sa-east-1)
                                                                                                   └─► EC2 (busperu-api) ─► RDS MariaDB 10.11 privada (busperu_prod)
```

| Pila | Región | Plantilla (generador → JSON) | La despliega | Estado |
| --- | --- | --- | --- | --- |
| `busperu-security-baseline` | sa-east-1 | `infra/aws/security-baseline/` | administrador con MFA | **existe** (F18-08): CMK, roles de producción, CloudTrail, 11 alertas, SNS |
| `busperu-prod` | sa-east-1 | `build-prod-template.mjs` → `busperu-prod.json` | `BusPeruProdOperator` con change set y el rol de servicio `BusPeruProdCloudFormationExecution` | no existe |
| `busperu-prod-web` | sa-east-1 | `build-prod-web-template.mjs` → `busperu-prod-web.json` | administrador con MFA (el rol de ejecución no tiene CloudFront) | no existe |
| `busperu-prod-observability` | sa-east-1 | `build-prod-observability-template.mjs` → `busperu-prod-observability.json` | administrador con MFA (sin permisos de filtros ni de Budgets en el rol de ejecución) | no existe |
| `busperu-prod-db-bootstrap` (**temporal**) | sa-east-1 | `build-prod-db-bootstrap-template.mjs` → `busperu-prod-db-bootstrap.json` | administrador con MFA; se **borra** tras §5.3 | no existe |

`busperu-prod-web` sustituye al nombre provisional `busperu-prod-edge` de F18-08. No hace falta una pila en
us-east-1: CloudFront acepta el certificado de us-east-1 por su ARN desde una pila de sa-east-1, igual que en staging.

**Separación de staging, comprobada por `check-prod-templates.mjs`:**

- VPC propia 10.30.0.0/16; staging es 10.20.0.0/16.
- Todos los nombres empiezan por `busperu-prod-`.
- Parámetros solo bajo `/busperu/prod/`.
- Buckets, distribuciones, grupos de seguridad y base propios.
- Ningún identificador de staging en las plantillas.
- En la EC2, `bootstrap-ec2.sh --env prod` y `render-env.sh` se niegan a funcionar si el perfil de la instancia no es `busperu-prod-…`.

**Una sola instancia.** El limitador de peticiones (`express-rate-limit`) y el planificador de expiración viven en
memoria, así que producción arranca con **una** EC2. La plantilla crea exactamente una y el comprobador lo exige.
Escalar a varias exige antes un almacén compartido para el limitador y elección de líder para el planificador. Es una fase aparte.

## 2. Prerrequisitos (propietario)

| # | Prerrequisito | Cómo se comprueba |
| --- | --- | --- |
| P-1 | `busperuonline.pe` registrado en un registrador `.pe` y delegado a una zona hospedada pública de Route 53 🔒 | `dig NS busperuonline.pe` responde con los NS de Route 53 |
| P-2 | Certificado ACM **us-east-1** con `busperuonline.pe`, `www.busperuonline.pe` y `api.busperuonline.pe`, validación DNS, `ISSUED` 🔒 | `aws acm describe-certificate --region us-east-1` |
| P-3 | Certificado ACM **sa-east-1** con `api.busperuonline.pe`, validación DNS, `ISSUED` 🔒 | `aws acm describe-certificate --region sa-east-1` |
| P-4 | Resend: dominio verificado (SPF, DKIM, DMARC y return-path) y clave de producción 🔒 | panel de Resend; la clave la carga el propietario (§4) |
| P-5 | Culqi LIVE: llaves pública y privada, y URL del webhook registrada 🔒 | panel de Culqi; llaves cargadas por el propietario (§4) |
| P-6 | Suscripción **confirmada** a `busperu-prod-alarms` y `busperu-prod-security` | `aws sns list-subscriptions-by-topic` sin `PendingConfirmation` |
| P-7 | Decisión sobre Identity Center (requiere AWS Organizations) o aceptar el flujo actual con MFA | decisión registrada |
| P-8 | Bootstrap de la base decidido (§5.3): el runtime conserva su `Deny secretsmanager:*`; la pila temporal `busperu-prod-db-bootstrap` se crea y se borra en la ventana | autorización para crear y borrar esa pila 🔒 |
| P-9 | Porcentaje de `platform.default_commission` (decisión de negocio). **Pendiente: no se asigna ningún valor por suposición** (B-11) | decisión registrada |
| P-10 | Presupuesto mensual y buzón para los avisos de coste | valores para `busperu-prod-observability` |
| P-11 | IP del operador para el humo previo al go-live (`ViewerAllowedIps`) | — |
| P-12 | Autorización de despliegue de producción y de los costes asociados 🔒 | «Autorizo el deployment de producción.» |

## 3. Comprobaciones previas (sin cambios en AWS)

```bash
cd infra/aws/cloudformation
node build-prod-template.mjs && node build-prod-web-template.mjs && node build-prod-observability-template.mjs
node check-prod-templates.mjs          # debe terminar en ✔
git diff --exit-code -- .              # los JSON versionados coinciden con los generadores
cd ../iam/prod && node check-iam-prod.mjs && cd ../../security-baseline && node check-baseline.mjs
```

Con una sesión MFA, solo lecturas:

```bash
aws cloudformation validate-template --region sa-east-1 --template-body file://infra/aws/cloudformation/busperu-prod.json
aws cloudformation validate-template --region sa-east-1 --template-body file://infra/aws/cloudformation/busperu-prod-web.json
aws cloudformation validate-template --region sa-east-1 --template-body file://infra/aws/cloudformation/busperu-prod-observability.json
aws ec2 describe-managed-prefix-lists --region sa-east-1 --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing --query 'PrefixLists[0].PrefixListId'
node infra/aws/scripts/prod-parameters.mjs verificar     # metadatos: qué falta, nunca valores
```

## 4. Parámetros y secretos

La estructura completa está en `infra/aws/parameters/prod-parameters.json`: 40 parámetros, 16 obligatorios, cada
SecureString con su CMK. Tabla legible:

```bash
node infra/aws/scripts/prod-parameters.mjs plan
```

| Origen | Cómo se cargan | Quién |
| --- | --- | --- |
| `fijo` (String) | `prod-parameters.mjs fijos --ejecutar` (`--no-overwrite`) | operador |
| `generado` | `prod-parameters.mjs generar <nombre> --ejecutar`: aleatorio, `--no-overwrite`, nunca se imprime. **En CloudShell** (F18-08) | operador |
| `pila` | `DB_HOST` ← salida `DatabaseEndpoint` de `busperu-prod`; `FRONTEND_URL` ← `WebUrl` de `busperu-prod-web` | operador |
| `propietario` | `aws ssm put-parameter --region sa-east-1 --name /busperu/prod/app/<X> --type SecureString --key-id alias/busperu-prod-secrets --value file://<archivo 0600>` y después borrar el archivo | propietario |

Reglas:

- **`JWT_SECRET` e `INTEGRATIONS_ENCRYPTION_KEY` son nuevos:** nunca los de staging.
- **`INTEGRATIONS_ENCRYPTION_KEY` usa `alias/busperu-prod-data`** y necesita la copia fuera de línea del propietario **antes** de guardar el primer dato bancario. La recupera `BusPeruProdBreakGlass`: dispara una alarma y queda en CloudTrail.
- **El operador solo cifra; nunca descifra.** Descifran la instancia (solo `app/*` y `ops/MIGRATOR_DB_PASSWORD`) y el rol de emergencia.
- **Cabecera secreta de origen.** Es un valor que usan dos pilas: se genera una vez en CloudShell y se usa en los dos change sets. Se guarda en `ops/CLOUDFRONT_ORIGIN_SECRET` como copia de emergencia. En actualizaciones posteriores se pasa `UsePreviousValue=true`.

  ```bash
  umask 077; openssl rand -hex 32 > origen.secreto
  aws ssm put-parameter --region sa-east-1 --name /busperu/prod/ops/CLOUDFRONT_ORIGIN_SECRET --type SecureString \
    --key-id alias/busperu-prod-secrets --value file://origen.secreto --no-overwrite
  # … se usa en §5.1 y §5.6 como OriginVerifySecret (archivo de parámetros 0600) …
  shred -u origen.secreto
  ```

## 5. Primera instalación (orden)

### 5.1 🔒 `busperu-prod` (operador + rol de ejecución)

1. Asumir `BusPeruProdOperator` con MFA.
2. Crear el change set con estos parámetros:
   - `CertificateArn`: sa-east-1.
   - `CloudFrontPrefixListId`.
   - `OriginVerifySecret`: en un archivo de parámetros 0600.
   - `DbMultiAz`: decisión de coste.

   ```bash
   aws cloudformation create-change-set --region sa-east-1 --stack-name busperu-prod --change-set-name inicial \
     --change-set-type CREATE --capabilities CAPABILITY_NAMED_IAM \
     --role-arn arn:aws:iam::<cuenta>:role/busperu/BusPeruProdCloudFormationExecution \
     --template-body file://infra/aws/cloudformation/busperu-prod.json --parameters file://params-prod.json \
     --tags Key=Project,Value=busperu Key=Environment,Value=prod
   ```
3. Revisar el change set: **solo `Add`**, 49 recursos, los tipos del comprobador, y ninguno de staging. Solo entonces se ejecuta.
4. Esperar a `CREATE_COMPLETE` y anotar las salidas: `LoadBalancerDns`, `DatabaseEndpoint`, `DatabaseMasterSecretArn`, `AppInstanceId`, `DataVolumeId` y `ArtifactsBucketName`.

Si el change set falla por un permiso que no aparece en el simulador (por ejemplo, ACM al crear el listener HTTPS), la
pila vuelve atrás sola. No se amplía IAM sin revisar el caso: se documenta y se decide.

### 5.2 Parámetros

Cargar todo lo de §4 salvo `FRONTEND_URL`, que depende de §5.6. Después, `prod-parameters.mjs verificar`: solo pueden faltar los de §5.6.

### 5.3 🔒 Usuarios de la base: bootstrap separado y temporal (B-10, decidido)

**Decisión del propietario (F18-18):** el rol de la EC2 (`busperu-prod-app-role`) **conserva su `Deny secretsmanager:*`**. La API nunca
podrá leer el maestro de RDS. Por eso, el procedimiento de F18-08 («política temporal en el rol de la instancia») queda descartado.

En su lugar se usa una identidad **aparte, humana, temporal y mínima**: la pila `busperu-prod-db-bootstrap`
(`build-prod-db-bootstrap-template.mjs`), que despliega el administrador y **se borra al terminar**.

| Aspecto | Rol `busperu-prod-db-bootstrap` |
| --- | --- |
| Quién lo asume | solo el administrador, con MFA de menos de 1 h y el nombre de sesión fijo `busperu-db-bootstrap` |
| Duración | sesiones de 1 h como máximo; la pila se borra tras el bootstrap |
| Secrets Manager | `GetSecretValue`, `DescribeSecret` y `RotateSecret` **solo** del secreto maestro de `busperu-prod-db`; `Deny` de escribirlo o borrarlo |
| KMS | `Decrypt` solo a través de Secrets Manager |
| Red | `ssm:StartSession` **solo** con `AWS-StartPortForwardingSessionToRemoteHost` y solo en la instancia de producción. Sin shell ni comandos. Puede cerrar sus propias sesiones |
| Todo lo demás | `Deny` explícito (`NotAction`) |

Lo exige `check-prod-templates.mjs`, y el comprobador detecta 6/6 mutaciones:

- `secretsmanager:*`;
- cualquier secreto;
- sin MFA;
- sesión interactiva;
- sin el `Deny` final;
- sesiones de 12 h.

Además, el comprobador exige que el rol de la app mantenga su `Deny`.

Procedimiento, en CloudShell de sa-east-1:

1. 🔒 El administrador despliega `busperu-prod-db-bootstrap` con estos parámetros (salidas de `busperu-prod`):
   - `MasterSecretArn` = `DatabaseMasterSecretArn`;
   - `AppInstanceId` = `AppInstanceId`.
2. Crear en CloudShell dos perfiles:
   - `BOOTSTRAP_PROFILE`: el rol temporal, con `mfa_serial` y `role_session_name = busperu-db-bootstrap`;
   - `OPERATOR_PROFILE`: `BusPeruProdOperator`.
3. Simular primero y ejecutar después:

   ```bash
   BOOTSTRAP_PROFILE=… OPERATOR_PROFILE=… bash infra/aws/scripts/prod-db-bootstrap.sh
   BOOTSTRAP_PROFILE=… OPERATOR_PROFILE=… bash infra/aws/scripts/prod-db-bootstrap.sh --ejecutar
   ```

   El script:
   - comprueba las identidades y las salidas de la pila, y que los parámetros de destino no existan;
   - genera las contraseñas de `busperu_app` y `busperu_migrator` en `/tmp` (0600, 43 caracteres, sin salto de línea);
   - lee el maestro con el rol temporal;
   - abre el túnel por la instancia hasta RDS;
   - ejecuta `create-db-users.sh` por el túnel (base `busperu_prod`, usuarios en `10.30.%` con privilegios mínimos);
   - guarda las dos contraseñas como SecureString (`alias/busperu-prod-secrets`) **con el operador**, que solo cifra;
   - **rota el maestro**, cierra el túnel y destruye los temporales.
4. 🔒 El administrador **borra** la pila `busperu-prod-db-bootstrap`. Las alertas de cambios de IAM saltan al crearla y al borrarla: es lo esperado.

Ensayo en F18-18 sin AWS: `create-db-users.sh` en modo archivos con `BUSPERU_ENV=prod` contra MariaDB 10.11.19 local.

- Creó `busperu_app` (SELECT/INSERT/UPDATE/DELETE) y `busperu_migrator` (con DDL) en `10.30.%`.
- Las contraseñas guardadas coinciden byte a byte con los archivos.
- Los usuarios del ensayo se eliminaron después.

La parte de AWS (túnel, rotación del maestro) se verifica en la primera ejecución real. `validate-template` y el
validador de políticas de Access Analyzer de esta plantilla quedan pendientes de una sesión MFA.

### 5.4 Instancia

Por Session Manager o Run Command, como en `STAGING-RUNBOOK.md` §6, con el entorno explícito:

```bash
sudo bash /opt/busperu/current/infra/aws/scripts/bootstrap-ec2.sh --env prod --data-volume <DataVolumeId> --format-new-volume
```

`--format-new-volume` va **solo la primera vez**: un volumen con datos nunca se formatea. El paso deja
`/etc/busperu/env` (`BUSPERU_ENV=prod`) y el agente escribe en `/busperu/prod/app`. Además se niega si el perfil de
la instancia no es `busperu-prod-app-profile`.

### 5.5 Esquema y aplicación

Todo en la instancia. Detalle en `STAGING-RUNBOOK.md` §5 y §7:

```bash
sudo BUSPERU_ENV=prod DB_HOST=<DatabaseEndpoint> bash /opt/busperu/current/infra/aws/scripts/apply-migrations.sh
# huella: DB_NAME=busperu_prod y la clave del migrador de /busperu/prod/ops/ → idéntico a schema-reference.json
sudo /opt/busperu/bin/deploy-release.sh <ArtifactsBucketName> <release>
curl -s http://127.0.0.1:3000/api/ready     # 200
```

El release sale de `make-release.sh` sobre un **tag** (`vX.Y.Z`) y se sube con su `.sha256` a `s3://<ArtifactsBucketName>/releases/`.

### 5.6 🔒 `busperu-prod-web` (administrador)

Parámetros:

- `WebCertificateArn`: us-east-1.
- `AlbDnsName` = `LoadBalancerDns`.
- El mismo `OriginVerifySecret`.
- `ViewerAccess=operators` y `ViewerAllowedIps=<IP del operador>`.

Se crea con change set (solo `Add`, 8 recursos). Salidas:

- `WebDistributionDomain` y `ApiDistributionDomain`: los necesita el DNS.
- `FrontendBucketName` y `WebDistributionId`.

Después se carga `FRONTEND_URL=https://busperuonline.pe` y se reinicia el servicio.

### 5.7 `busperu-prod-observability` (administrador)

Parámetros: `MonthlyBudgetUsd` y `BudgetEmail`. Crea 5 filtros y 5 alarmas sobre `/busperu/prod/app`, y el presupuesto.

Los patrones se prueban antes con `aws logs test-metric-filter` y líneas generadas por el propio `logger.ts`.

### 5.8 Frontend

```bash
AWS_PROFILE=<sesión MFA> node infra/aws/scripts/publish-web.mjs --env prod --release vX.Y.Z             # simulación
AWS_PROFILE=<sesión MFA> node infra/aws/scripts/publish-web.mjs --env prod --release vX.Y.Z --ejecutar
```

Toma el bucket, la distribución y la URL de la API **de la pila `busperu-prod-web`**, así que no puede publicar
un build de staging en producción. Además revisa el bundle, escribe el manifiesto SHA-256, sube, verifica el
tamaño, el MD5, el Content-Type y el Cache-Control, e invalida `/` y `/index.html`.

### 5.9 Primer administrador y comisión

Igual que `STAGING-RUNBOOK.md` §8, con la base `busperu_prod` y el porcentaje decidido (P-9).

### 5.10 🔒 DNS, humo y go-live

1. Crear en Route 53 los alias A/AAAA:
   - `busperuonline.pe` y `www` → `WebDistributionDomain`;
   - `api` → `ApiDistributionDomain`.

   TTL bajo. Con `ViewerAccess=operators`, solo el operador ve la web.
2. Ejecutar el humo de `F18-17-GO-LIVE-CHECKLIST.md` §D, que no crea datos, con las rutas reales:
   - `/`, `/destinos`, `/empresas`, `/ofertas`;
   - `/api/ready`, `/api/health`;
   - los 4 roles, logout y revocación.
3. Si todo pasa: actualizar `busperu-prod-web` con `ViewerAccess=public` (change set: 1 `Modify` de la función). Ahí empieza el tráfico real.
4. Verificación posterior: checklist §C y una hora de métricas.

## 6. Releases posteriores

1. Crear el tag `vX.Y.Z` y generar el paquete con `make-release.sh`. Subir el tar y su `.sha256` al bucket de artefactos.
2. Si hay migración:
   - snapshot manual `busperu-prod-pre-vX.Y.Z` (el operador tiene `rds:CreateDBSnapshot`);
   - `apply-one-migration.sh <archivo> busperu_prod`, una por una;
   - pasar la huella de esquema, que ya incluye la migración.
3. `deploy-release.sh`. Tiene vuelta atrás automática si `/api/ready` no responde en 90 s.
4. `publish-web.mjs --env prod --release vX.Y.Z --ejecutar`.
5. Humo (§D) y métricas.

## 7. Vuelta atrás

| Capa | Procedimiento | Tiempo |
| --- | --- | --- |
| Frontend | volver a ejecutar `publish-web.mjs` con el `dist/` del release anterior (reproducible desde su tag). Los chunks antiguos siguen en el bucket y `index.html` se invalida | < 5 min |
| Backend | `deploy-release.sh <bucket> <release anterior>`, o apuntar `/opt/busperu/current` al directorio anterior y reiniciar | < 2 min |
| Base, opción preferente | **hacia delante**: una migración correctora. Todas son aditivas o están guardadas, y el código anterior tolera el esquema nuevo | — |
| Base, último recurso 🔒 | PITR o snapshot a `busperu-prod-dr-<fecha>` con `BusPeruProdRecovery` (privada), comprobar la huella, cambiar `/busperu/prod/app/DB_HOST` y reiniciar. Se pierden las escrituras posteriores. RTO medido en staging: 615 s. Runbook completo en F18-08 §8 | 10–15 min |
| Infraestructura | un change set fallido vuelve atrás solo. RDS, ALB y EC2 tienen protección contra borrado; RDS y EBS, `DeletionPolicy: Snapshot`; los buckets y el grupo de logs, `Retain` | — |
| Borde | `ViewerAccess=operators` cierra la web al público sin tocar el DNS. Revertir el DNS (TTL bajo) | minutos |
| Terceros | Culqi: quitar las llaves (el pago con tarjeta se desactiva, `card_enabled=false`) o el webhook. Resend: dejar vacía `RESEND_API_KEY` impide arrancar; no aplica, se usa la vuelta atrás del backend | minutos |

Criterio de vuelta atrás: cualquier fallo del humo §D, errores 5xx sostenidos, fallos de login o revocación, o errores de pago.

## 8. Validaciones automáticas

| Qué | Comando | Sin AWS |
| --- | --- | --- |
| Plantillas de producción (separación, IAM, seguridad, CSP frente al código) | `node infra/aws/cloudformation/check-prod-templates.mjs` | sí |
| Plantillas de staging (sin cambios) | `check-template.mjs`, `check-web-template.mjs` | sí |
| IAM y línea base | `check-iam-prod.mjs`, `check-baseline.mjs`, `check-iam.mjs` | sí |
| Parámetros de producción | `prod-parameters.mjs verificar` (metadatos) | no (solo lectura) |
| Sintaxis de CloudFormation | `aws cloudformation validate-template` | no (solo lectura) |
| Frontend antes de publicar | `publish-web.mjs` sin `--ejecutar` | no (solo lectura) |
| Esquema | `schema-fingerprint.cjs` | en la instancia |
