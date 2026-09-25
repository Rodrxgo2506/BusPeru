# BusPerú · Cierre de IAM y monitorización (F18-07B)

> Estado: **staging**. No existe producción y esta fase no la crea. Continúa `HARDENING-F18-07A.md`.
> No contiene cuentas, claves, secretos ni datos bancarios: `<cuenta>`, `<región>` y `<administrador>` son marcadores.

---

## 1. Cambios de IAM de esta fase (como código en `infra/aws/iam/`)

| Cambio | Archivo generado | Validación local | Aplicación (2026-09-24, identidad administradora con autorización explícita del propietario) |
| --- | --- | --- | --- |
| Barrera `NoBorrarSecretosCriticos`: `Deny ssm:DeleteParameter` y `ssm:DeleteParameters` sobre `parameter/busperu/*/app/INTEGRATIONS_ENCRYPTION_KEY` y `…/app/JWT_SECRET`, sin condiciones | `policies/BusPeruStagingDeployerPolicy.json` (5 826 de 6 144 caracteres) | `check-iam.mjs` la exige exacta (acciones, recursos, sin condición); mutantes detectados | **Aplicada: v3 → v4** (v3 conservada). Simulador 29/29 antes y después; Access Analyzer 0; reinicio del servicio con `/ready` 200 |
| Confianza con MFA (`aws:MultiFactorAuthPresent=true`, `aws:MultiFactorAuthAge < 3600`) | `policies/trust-policy.json` | `check-iam.mjs` exige ambas condiciones y un único usuario | **Aplicada.** `AssumeRole` sin MFA → `AccessDenied` (prueba real). Con MFA: prueba del propietario (§2) |

Por qué solo esas dos: `PutParameter` (sobrescribir) deja historial y lo necesita la rotación, y
`INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS` se retira al acabar cada rotación, así que no se protegen. La vuelta atrás
de la política es `iam set-default-policy-version` a la v3, que se conserva.

## 2. MFA para el rol humano

Estado vigente: **exigida desde el 2026-09-24**. Prueba con MFA **hecha por el propietario** con su dispositivo, mediante el perfil de la CLI `busperu-mfa` (`role_arn` + `source_profile` + `mfa_serial`); comprobada desde AWS: `sts get-caller-identity` con ese perfil devuelve el rol asumido. El diseño no cambia respecto a F18-07A §6 y no afecta a ningún rol de servicio: la
EC2 usa su perfil de instancia y DLM su rol; ninguno asume `BusPeruStagingDeployer`.

Referencia (ya aplicada) y prueba con MFA que debe hacer el propietario:

```bash
# (ya aplicada; para reaplicarla o revisarla)
node infra/aws/iam/build-iam.mjs --account <cuenta> --out <carpeta fuera del repo>
aws iam update-assume-role-policy --role-name BusPeruStagingDeployer --policy-document file://<carpeta>/trust-policy.json
# sin MFA → debe fallar con AccessDenied
aws sts assume-role --role-arn arn:aws:iam::<cuenta>:role/busperu/BusPeruStagingDeployer --role-session-name prueba-sin-mfa
# con MFA → debe funcionar (no pegar la salida: contiene credenciales)
aws sts assume-role --role-arn arn:aws:iam::<cuenta>:role/busperu/BusPeruStagingDeployer --role-session-name prueba-mfa \
  --serial-number <ARN del dispositivo MFA> --token-code <código de 6 dígitos> --query 'AssumedRoleUser.Arn'
```

Consecuencia operativa: desde ese momento ninguna sesión automatizada puede asumir el rol sin el código del
propietario. Flujo recomendado para las fases siguientes: perfil de la CLI con `role_arn`, `source_profile`,
`mfa_serial` y `duration_seconds = 7200`; el propietario ejecuta una orden con ese perfil (la CLI pide el código
una vez y guarda solo credenciales temporales del rol en su caché) y el asistente trabaja con ese perfil hasta que
caducan. La clave de origen puede desactivarse durante la sesión.

## 3. Clave de acceso de larga duración

Estado: **Inactive** en reposo; nunca se muestra su ID. **No se borra en F18-07B**: con MFA en la confianza, la CLI
sigue necesitando una credencial de origen para pedir la sesión con MFA. Borrarla solo es posible cuando exista
otra vía de acceso: **IAM Identity Center** (`aws sso login`, con MFA, sin claves en disco) o trabajar desde
CloudShell. Orden: 1) Identity Center con un conjunto de permisos que solo permita asumir el rol; 2) un despliegue
completo por esa vía; 3) borrar la clave con autorización explícita del propietario.

## 4. Rol de ejecución de CloudFormation para producción (opción C) — DEFERRED TO F18-08

Se crea con la pila de producción; crearlo antes sería crear IAM de producción sin producción. Diseño completo:

**Trust** (solo el servicio, solo esta cuenta):

```json
{ "Version": "2012-10-17", "Statement": [{ "Sid": "SoloCloudFormationDeEstaCuenta", "Effect": "Allow",
  "Principal": { "Service": "cloudformation.amazonaws.com" }, "Action": "sts:AssumeRole",
  "Condition": { "StringEquals": { "aws:SourceAccount": "<cuenta>" } } }] }
```

**Permisos**: los de escritura que hoy tienen `-Compute`, `-Data` y `-Operate` sobre los recursos `busperu-prod-*`
(misma estructura, prefijo de producción), `iam:PassRole` del rol de la app solo hacia EC2 y del de DLM solo hacia
DLM, y creación de roles de la carga solo con el límite de permisos. **Denies explícitos** idénticos a las barreras
de staging: `rds:DeleteDBInstance` sobre `db:busperu-prod-db`; borrar, compartir o exportar snapshots y backups;
restauraciones públicas; `iam:*` sobre `role/busperu/*` y `policy/busperu/*`; administrar personas y credenciales;
`secretsmanager:GetSecretValue`; `ssm:DeleteParameter*` sobre la clave de cifrado y `JWT_SECRET`.

**Rol del operador humano** (`BusPeruProdOperator`, confianza con MFA como §2, ruta `/busperu/`):

* `cloudformation:CreateChangeSet`, `CreateStack`, `UpdateStack`, `DeleteStack`, `ContinueUpdateRollback`,
  `RollbackStack` sobre `stack/busperu-prod/*` **con** `StringEquals cloudformation:RoleArn = <rol de ejecución>`.
* `cloudformation:ExecuteChangeSet`, `DescribeChangeSet`, `DeleteChangeSet`, lecturas: sin esa clave (no la admiten);
  la ejecución usa el rol fijado al crear el change set, y el operador solo puede crearlos con ese rol.
* `iam:PassRole` **solo** del rol de ejecución y solo con `iam:PassedToService = cloudformation.amazonaws.com`.
* Sin escritura directa en RDS, EC2, ELB, S3, DLM ni CloudWatch (ahí se cierra el `ModifyDBInstance` residual),
  salvo `rds:CreateDBSnapshot` (snapshot manual antes de migrar) y lecturas `Describe*`.
* Operación: `ssm:SendCommand`/`StartSession` solo a la instancia de la pila con `AWS-RunShellScript`;
  `s3:PutObject` solo en `releases/` del bucket de artefactos; `ssm:PutParameter` solo en `/busperu/prod/app/*`
  de valores no secretos (los secretos, por el procedimiento de custodia, §6).
* `SetStackPolicy`, `UpdateTerminationProtection`: solo el administrador. La pila lleva política de pila que niega
  `Update:Replace` y `Update:Delete` sobre la base de datos y el volumen de datos, y protección de terminación.

**KMS**: la base con una CMK propia; el rol de ejecución solo `kms:DescribeKey` y `kms:CreateGrant` con
`kms:ViaService = rds.<región>.amazonaws.com` y `kms:GrantIsForAWSResource`. Nadie salvo el administrador puede
programar el borrado o deshabilitar la clave.

**Registro**: un *trail* de CloudTrail multirregión con validación de integridad de archivos, en un bucket propio con
bloqueo público, cifrado y versionado (y retención), más alarmas de CloudWatch para cambios de IAM, cambios de la
política de la pila, uso de la cuenta raíz, `DeleteParameter`/`PutParameter` sobre secretos y `ModifyDBInstance`
de la base de producción.

## 5. Rol de recuperación para producción (opción B) — DEFERRED TO F18-08

Diseño de `HARDENING-F18-07A.md` §5, validado contra los requisitos de F18-07B:

| Requisito | Diseño |
| --- | --- |
| Describe | `rds:Describe*` necesarios, `DescribeEvents`, `ListTagsForResource`, `ec2:Describe*` de red (lectura) |
| PITR y snapshot | `RestoreDBInstanceToPointInTime` y `RestoreDBInstanceFromDBSnapshot` solo hacia `db:busperu-<env>-dr-*` |
| Privada obligatoria | `Allow` condicionado a `rds:PubliclyAccessible = false` (sin el parámetro explícito, no coincide y se deniega) |
| KMS solo vía RDS | `kms:DescribeKey`, `kms:CreateGrant` con `kms:ViaService` de RDS y `kms:GrantIsForAWSResource` |
| Deny | `rds:Delete*`, `rds:Modify*`, `rds:Reboot*`, `rds:StartExportTask`, `rds:CopyDBSnapshot`, `iam:*`, `sts:AssumeRole`, `cloudformation:*`, **`ssm:*`** (F18-07B: antes solo escrituras y `SendCommand`; el rol no necesita leer parámetros), `secretsmanager:*`, `s3:*`, `ec2:Delete*`, `ec2:Terminate*`, `kms:ScheduleKeyDeletion`, `kms:DisableKey` |
| Trust | solo el administrador, con MFA y edad < 1 h |
| Ruta | `/busperu/`: el rol de despliegue/operación no puede modificarlo (`Deny iam:*` sobre `role/busperu/*`) |
| Registro | sus llamadas quedan en el *trail* de §4; alarma al asumirlo (evento `AssumeRole` sobre ese ARN) |

No se crea en staging: el rol de despliegue ya restaura en privado (F18-06) y no puede borrar la original.

## 6. Custodia de la clave de cifrado de producción — decisión pendiente (conceptual)

No se crea ni se genera ninguna clave productiva. Hoy (staging) la clave vive en Parameter Store como SecureString
con la clave gestionada `aws/ssm`; la protege el `Deny` de borrado (§1) y el historial de versiones ante
sobrescrituras.

| Aspecto | Parameter Store (`aws/ssm`) | Parameter Store con CMK propia | Secrets Manager |
| --- | --- | --- | --- |
| Quién puede descifrar | cualquier principal de la cuenta con `ssm:GetParameter` (política de la clave gestionada) | solo quien la política de la CMK permita | solo quien la política del secreto y la CMK permitan |
| Borrado | inmediato, se lleva el historial (mitigado por el `Deny`) | igual | ventana de recuperación de 7–30 días |
| Copia de seguridad | ninguna nativa | ninguna nativa | réplica a otra región opcional |
| Rotación | manual (runbook §5.2) | manual | orquestable (Lambda), aunque aquí la rotación exige `--recifrar` |
| Coste | nulo | CMK ~1 USD/mes | ~0,40 USD/secreto/mes + CMK |

**Recomendación para F18-08**: CMK propia para los secretos de producción, con política de clave que permita
`Decrypt` solo al rol de la aplicación (vía SSM) y a una identidad de emergencia (*break-glass*) del administrador
con MFA; el operador puede escribir (`Encrypt`/`GenerateDataKey`) pero no leer. La clave de datos se guarda además
en una **copia fuera de línea** custodiada por el propietario (sobre sellado o gestor de contraseñas con MFA), porque
perderla es irreversible. Borrado de la CMK solo por el administrador, con la espera máxima (30 días) y alarma.

## 7. Acceso de la identidad humana a los SecureString (F18-07A: MEDIUM)

Causa: la clave gestionada `aws/ssm` permite descifrar a cualquier principal de la cuenta autorizado a usar SSM, y
el rol de despliegue tiene `ssm:GetParameter` sobre `/busperu/staging/*`. La aplicación no depende de ese permiso:
su EC2 lee con su propio rol.

Opciones evaluadas: (a) `Deny kms:Decrypt` en el rol humano con `kms:EncryptionContext:PARAMETER_ARN` de
`/busperu/<env>/app/*`: impide leer los secretos de la app sin tocar la app ni el despliegue, pero la rotación
(que lee la clave vigente para moverla a `…_PREVIOUS`) pasaría a hacerla la identidad de emergencia; (b) CMK propia
con política restrictiva (§6). **Decisión**: no se cambia en staging en F18-07B (no es la modificación documentada
y el operador aún usa parámetros de `ops/` en las pruebas); **(b) + (a) en producción, F18-08**.

## 8. Riesgo residual `ModifyDBInstance` / `RebootDBInstance`

* **Staging**: barreras `Deny` explícitas (opción A): no se puede borrar la base, sus copias ni restaurar en público;
  modificar y reiniciar siguen permitidos porque las actualizaciones de la pila los necesitan. No se ejecutó ninguna
  modificación como prueba y no se tocaron ni la retención ni `DeletionProtection`.
* **Producción**: A + B + C (§4 y §5). El humano pierde la escritura directa en RDS.

## 9. Monitorización

12 alarmas sin cambios (métrica, umbral, periodo y evaluaciones iguales a la plantilla), todas hacia el tema
`busperu-staging-alarms`. Suscripción: **1 correo del propietario** (autorizado explícitamente el 2026-09-24),
**confirmada por él**: verificación final (solo lectura, sesión MFA) = 1 suscripción, 1 confirmada, 0 pendientes,
endpoint = el correo autorizado. Ningún otro cambio en SNS ni en las alarmas (12, todas OK, métrica, umbral,
periodo, evaluaciones y acciones sin cambios). Nota (LOW): `ConfirmationWasAuthenticated=false`, lo normal al
confirmar por enlace: el enlace de baja de los correos no exige autenticarse. Endurecerlo (`AuthenticateOnUnsubscribe`)
queda para F18-08 si se decide. Pendiente para F18-08: *trail* de CloudTrail y
las alarmas de §4, alarmas de errores de la aplicación y de fallos de backup.
