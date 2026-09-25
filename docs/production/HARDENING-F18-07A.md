# BusPerú · Cierre de hardening (F18-07A)

> Estado: **staging**. No existe producción. Continúa `SECURITY-F18-07.md`: cierra, valida o deja como acción
> explícita cada bloqueante de F18-07. No contiene cuentas, claves, secretos ni datos bancarios.

---

## 1. Respuestas cortas

| Pregunta | Respuesta |
| --- | --- |
| ¿Quién puede desplegar? | El rol `BusPeruStagingDeployer` (solo lo asume el usuario administrador). CloudFormation actúa con las credenciales de ese rol: no hay rol de servicio en staging. |
| ¿Quién puede recuperar? | Hoy, el mismo rol: restaurar PITR o desde snapshot **solo en privado**. El rol de recuperación separado está diseñado (§5) y se crea con producción. |
| ¿Quién puede modificar RDS? | El rol de despliegue (`ModifyDBInstance`, `RebootDBInstance`: riesgo residual MEDIO, §3) y el administrador. |
| ¿Quién puede eliminar RDS? | Solo el administrador. Al rol se le deniega borrar `busperu-staging-db` sin condiciones, también cuando CloudFormation actúa con sus credenciales. |
| ¿Quién puede modificar IAM? | Solo el administrador. El rol no puede tocar usuarios, grupos, claves, MFA, políticas ni roles de `/busperu/` (incluidos él mismo y sus políticas). Solo gestiona los roles `busperu-staging-*` de la carga, con el límite `BusPeruStagingWorkloadBoundary` obligatorio. |
| ¿Cómo se protege la base original? | `DeletionProtection`, `DeletionPolicy`/`UpdateReplacePolicy: Snapshot`, `Deny rds:DeleteDBInstance` sobre ella, `Deny` de borrar/compartir/exportar snapshots y backups retenidos, restauraciones públicas denegadas, 7 días de PITR, cifrado KMS, subredes privadas. |
| ¿Cómo se cifran los datos bancarios? | AES-256-GCM con `INTEGRATIONS_ENCRYPTION_KEY` (sobre v1, nonce aleatorio, campo y empresa dentro del texto cifrado). En la base solo quedan el sobre y los últimos 4 (migración 019 + `bank:encrypt`). |
| ¿Cómo se rotan las claves? | Vigente → `…_PREVIOUS`, clave nueva, `bank:encrypt -- --recifrar`, verificar y retirar la anterior (runbook §5.2). `JWT_SECRET`: se sustituye y se reinicia (invalida sesiones). |
| ¿Cómo funciona el audit trail? | Toda acción de usuario y todo suceso de sistema con efecto (webhook, reembolso compensatorio, ciclo de vida) deja una fila en `audit_logs` **en la misma transacción** que el cambio; solo identificadores públicos y valores enmascarados. |
| ¿Rate limiting? | En memoria, por IP. **Initial production uses one API instance.** **Horizontal scaling requires shared rate-limit storage.** |
| ¿Scheduler? | En proceso, cada 60 s, idempotente con bloqueo de filas. **Scheduler is single-instance.** Para escalar: **Requires leader/lock based coordination.** |

## 2. Auditoría IAM (parte 1)

Principal: `BusPeruStagingDeployer` salvo que se indique. «Implícito» = ninguna política lo permite.
La columna Allow/Deny es la del simulador de políticas de IAM sobre las políticas desplegadas (§8).

| Acción | Recurso | Allow/Deny | Condición | Riesgo |
| --- | --- | --- | --- | --- |
| `rds:CreateDBInstance` | `db:busperu-staging-*` | Allow | — | BAJO (coste; instancias nuevas, privadas por la pila) |
| `rds:ModifyDBInstance` | `db:busperu-staging-db` | Allow | RDS no ofrece clave para distinguir un cambio peligroso | **MEDIO residual** (retención 0, quitar `DeletionProtection`) |
| `rds:DeleteDBInstance` | `db:busperu-staging-db` | **Deny** explícito | ninguna (aplica también vía CloudFormation) | cerrado |
| `rds:DeleteDBInstance` | `db:busperu-staging-dr-*` | Allow | — | BAJO (limpieza de restauraciones temporales) |
| `rds:RebootDBInstance` | `db:busperu-staging-db` | Allow | — | BAJO (disponibilidad) |
| `rds:RestoreDBInstanceToPointInTime` | nueva `dr-*` desde la original | Allow privada / **Deny** pública | `rds:PubliclyAccessible` | cerrado |
| `rds:RestoreDBInstanceFromDBSnapshot` | nueva `dr-*` | Allow privada / **Deny** pública | `rds:PubliclyAccessible` | cerrado |
| `rds:CreateDBSnapshot` | original y `snapshot:busperu-staging-*` | Allow | — | BAJO (necesario antes de migrar) |
| `rds:DeleteDBSnapshot` | cualquiera (manual o automático) | **Deny** explícito | — | cerrado |
| `rds:ModifyDBSnapshotAttribute` (compartir) | cualquiera | **Deny** explícito | — | cerrado |
| `rds:ModifyDBSnapshot` | cualquiera | Implícito | — | cerrado |
| `rds:DeleteDBInstanceAutomatedBackup`, `rds:StartExportTask` | cualquiera | **Deny** explícito | — | cerrado |
| `rds:DeleteDBCluster`, `rds:ModifyDBCluster` | cualquiera | Implícito (no hay Aurora) | — | cerrado |
| `iam:CreatePolicyVersion`, `SetDefaultPolicyVersion` | `policy/busperu/*` (las suyas) | **Deny** explícito | — | cerrado |
| `iam:PutRolePolicy`, `AttachRolePolicy`, `UpdateAssumeRolePolicy` | `role/busperu/*` (él mismo) | **Deny** explícito | — | cerrado |
| `iam:CreateUser`, `CreateAccessKey`, `AddUserToGroup`, `*MFADevice*` | cualquiera | **Deny** explícito | — | cerrado |
| `iam:CreateRole` | `role/busperu-staging-*` | Allow **solo con** el límite | `iam:PermissionsBoundary` | MEDIO acotado (el límite no incluye IAM ni escritura fuera de la carga) |
| `iam:PassRole` | `busperu-staging-app-role` → EC2; `DlmRole-*` → DLM | Allow | `iam:PassedToService` | BAJO |
| `iam:PassRole` | `role/busperu/*` o cualquier otro | Deny / Implícito | — | cerrado (sin escalada) |
| `cloudformation:UpdateStack`, `ExecuteChangeSet` | `stack/busperu-staging/*` | Allow | — | MEDIO (inherente al despliegue) |
| `cloudformation:DeleteStack` | `stack/busperu-staging/*` | Allow | — | MEDIO: la base no se borra (Deny + `DeletionPolicy`), sí EC2/ALB/red, recreables |
| `ec2:TerminateInstances`, `ec2:DeleteVolume` | recursos con la etiqueta de la pila | Allow | `aws:ResourceTag/...stack-name` | MEDIO: el volumen `/data` se puede borrar (tras desmontarlo); sus snapshots DLM no (`ec2:DeleteSnapshot` implícito) |
| `elasticloadbalancing:DeleteLoadBalancer` | ALB de la pila | Allow | — | BAJO (recreable) |
| `s3:DeleteObjectVersion`, `PutBucketPolicy` | bucket de artefactos | Allow | — | BAJO (solo versiones del backend y herramientas; bloqueo público activo) |
| `ssm:GetParameter` (con descifrado) | `/busperu/staging/*` | Allow | clave KMS gestionada `aws/ssm` | **MEDIO para producción**: la identidad humana lee los secretos de la app |
| `ssm:DeleteParameter` | `/busperu/staging/*` | Allow | — | **MEDIO para producción**: borrar `INTEGRATIONS_ENCRYPTION_KEY` deja ilegibles datos bancarios e integraciones (no hay historial tras un borrado) |
| `ssm:SendCommand`, `ssm:StartSession` | solo la EC2 de la pila, `AWS-RunShellScript` | Allow | `ssm:resourceTag/...stack-name` | MEDIO (root en la instancia de la pila) |
| `secretsmanager:GetSecretValue` | cualquiera | **Deny** explícito | — | cerrado (maestro de RDS) |
| `kms:Decrypt` directo, `kms:ScheduleKeyDeletion` | cualquiera | Implícito | — | cerrado |
| `cloudwatch:DeleteAlarms`, `logs:DeleteLogGroup` | `busperu-staging-*`, `/busperu/staging/*` | Allow | — | BAJO (staging) |
| `dlm:DeleteLifecyclePolicy` | política etiquetada del proyecto | Allow | etiquetas | MEDIO (detiene los snapshots de `/data`; los existentes quedan) |
| `sts:AssumeRole` de otros roles | cualquiera | Implícito | — | cerrado |

Otros principales: el usuario administrador (grupo con AdministratorAccess) puede todo; el rol de la aplicación
(EC2) solo lee `/busperu/staging/*`, escribe sus registros y métricas y lee el secreto maestro de RDS, bajo el
límite; no puede ni leer ni tocar RDS por la API de control.

## 3. Rol de despliegue (parte 2) y opción elegida (parte 5)

| Opción | Qué cubre | Coste | Decisión |
| --- | --- | --- | --- |
| A · rol + `Deny` explícitos | borrar la base, snapshots y backups; restaurar en público; tocar IAM | ya aplicada (F18-07, política v3) | **staging** |
| B · + rol de recuperación | separa «recuperar» de «desplegar» | un rol más, solo tiene sentido con MFA | diseñado (§5), **con producción** |
| C · + rol de ejecución de CloudFormation | quita al humano la escritura directa (cierra el `ModifyDBInstance` residual) | otro rol, `--role-arn` en cada operación | **producción (F18-08)** |
| D · combinación mínima | — | — | **= A en staging; A + B + C en producción** |

Por qué no C/B en staging ahora: los datos son sintéticos, A ya impide la pérdida irreversible (borrar la base,
sus copias o exponerla), y crear roles en `/busperu/` exige al administrador (ver §9, BLOCKED). Se sube a
producción, donde el riesgo residual de `ModifyDBInstance` sí importa.

**Hallazgo de F18-07A para la opción C.** La referencia de autorización de CloudFormation admite la clave
`cloudformation:RoleArn` en `CreateStack`, `UpdateStack`, `DeleteStack`, `CreateChangeSet`, `ContinueUpdateRollback`
y `RollbackStack`, pero **no** en `ExecuteChangeSet`, `CancelUpdateStack`, `DeleteChangeSet`, `SetStackPolicy`,
`UpdateTerminationProtection` ni `DetectStackDrift`. El diseño lo resuelve así: el operador solo puede **crear**
change sets con el rol de ejecución (condición en `CreateChangeSet`) y la ejecución usa el rol fijado al crearlo;
`iam:PassRole` solo para ese rol y solo hacia `cloudformation.amazonaws.com`, de modo que no puede asociar a la pila
un rol más potente. `SetStackPolicy` y `UpdateTerminationProtection` se reservan al administrador.

## 4. `aws:CalledVia` (parte 6)

**NOT USED.** Reason: la documentación de IAM solo garantiza la clave cuando un servicio que la admite usa las
credenciales del principal mediante *forward access sessions*; no garantiza que CloudFormation llame a RDS así al
gestionar `AWS::RDS::DBInstance` sin rol de servicio, y comprobarlo exigiría tocar la base real. Una condición
así podría no proteger nada o romper las actualizaciones. Las barreras de A no llevan condición. En producción la
distinción «CloudFormation frente a humano» se hace por **identidad** (opción C), no por esta clave.

## 5. Rol de recuperación (parte 4) — diseño aprobado para F18-08

Decisión: **no se crea en staging**. En staging el rol de despliegue ya restaura en privado (probado en F18-06) y
no puede borrar la original; un segundo rol no reduce riesgo real con datos sintéticos y exige al administrador.
Se crea junto con producción, en la ruta `/busperu/` (así el rol de despliegue, que tiene `Deny iam:*` sobre
`role/busperu/*`, no puede modificarlo).

Confianza (solo el administrador, con MFA reciente):

```json
{ "Version": "2012-10-17", "Statement": [{ "Sid": "SoloAdministradorConMfa", "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::<cuenta>:user/<administrador>" }, "Action": "sts:AssumeRole",
  "Condition": { "Bool": { "aws:MultiFactorAuthPresent": "true" }, "NumericLessThan": { "aws:MultiFactorAuthAge": "3600" } } }] }
```

Permisos (`<env>` = `prod`; sesión máxima 1 h):

```json
{ "Version": "2012-10-17", "Statement": [
  { "Sid": "LeerParaRecuperar", "Effect": "Allow", "Resource": "*",
    "Action": ["rds:DescribeDBInstances", "rds:DescribeDBSnapshots", "rds:DescribeDBInstanceAutomatedBackups",
               "rds:DescribeDBSubnetGroups", "rds:DescribeDBParameterGroups", "rds:DescribeEvents", "rds:ListTagsForResource",
               "ec2:DescribeSecurityGroups", "ec2:DescribeSubnets", "ec2:DescribeVpcs"],
    "Condition": { "StringEquals": { "aws:RequestedRegion": "<región>" } } },
  { "Sid": "RestaurarSoloEnPrivadoYEnInstanciaNueva", "Effect": "Allow",
    "Action": ["rds:RestoreDBInstanceToPointInTime", "rds:RestoreDBInstanceFromDBSnapshot"],
    "Resource": ["arn:aws:rds:<región>:<cuenta>:db:busperu-<env>-dr-*", "arn:aws:rds:<región>:<cuenta>:db:busperu-<env>-db",
                 "arn:aws:rds:<región>:<cuenta>:snapshot:*", "arn:aws:rds:<región>:<cuenta>:auto-backup:*",
                 "arn:aws:rds:<región>:<cuenta>:subgrp:busperu-<env>-*", "arn:aws:rds:<región>:<cuenta>:pg:busperu-<env>-*",
                 "arn:aws:rds:<región>:<cuenta>:og:default:mariadb-10-11"],
    "Condition": { "Bool": { "rds:PubliclyAccessible": "false" } } },
  { "Sid": "EtiquetarLaRestaurada", "Effect": "Allow", "Action": "rds:AddTagsToResource",
    "Resource": "arn:aws:rds:<región>:<cuenta>:db:busperu-<env>-dr-*" },
  { "Sid": "UsarLaClaveKmsDeLaBaseSoloViaRds", "Effect": "Allow", "Action": ["kms:DescribeKey", "kms:CreateGrant"],
    "Resource": "arn:aws:kms:<región>:<cuenta>:key/<clave de la base>",
    "Condition": { "StringEquals": { "kms:ViaService": "rds.<región>.amazonaws.com" }, "Bool": { "kms:GrantIsForAWSResource": "true" } } },
  { "Sid": "NadaDestructivoNiFueraDeRecuperar", "Effect": "Deny", "Resource": "*",
    "Action": ["rds:Delete*", "rds:Modify*", "rds:Reboot*", "rds:StartExportTask", "rds:CopyDBSnapshot",
               "iam:*", "sts:AssumeRole", "cloudformation:*", "ssm:*",
               "secretsmanager:*", "ec2:Delete*", "ec2:Terminate*", "s3:*", "kms:ScheduleKeyDeletion", "kms:DisableKey"] }
] }
```

`rds:PubliclyAccessible=false` en un `Allow` obliga a pasar `--no-publicly-accessible` explícitamente: si la
petición no lo lleva, no hay coincidencia y se deniega. Repuntar la aplicación (`DB_HOST`) y borrar la instancia
temporal lo hace después el rol de operación, no el de recuperación.

## 6. MFA (parte 7) — USER ACTION REQUIRED

Estado: **Pending user action**. El usuario administrador tiene un dispositivo MFA, pero la confianza del rol de
despliegue **no** exige MFA y el flujo actual asume el rol con la clave de acceso sin MFA. Exigirla es un cambio
de IAM (`UpdateAssumeRolePolicy`) que solo puede hacer el administrador, y después cada sesión necesita el código
del dispositivo, que solo tiene su propietario. No se ha implementado ni se simula que lo esté.

Confianza objetivo del rol de despliegue (roles de servicio, EC2 y DLM **sin** MFA: no se tocan):

```json
{ "Version": "2012-10-17", "Statement": [{ "Sid": "SoloElUsuarioAdministradorConMfa", "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::<cuenta>:user/Rodrigo" }, "Action": "sts:AssumeRole",
  "Condition": { "Bool": { "aws:MultiFactorAuthPresent": "true" }, "NumericLessThan": { "aws:MultiFactorAuthAge": "3600" } } }] }
```

Flujo alternativo (sin clave de larga duración en el día a día), en este orden:

1. **Preferido: IAM Identity Center** con MFA y un conjunto de permisos que solo permita asumir el rol; la CLI usa
   `aws sso login` (credenciales temporales, sin claves en disco). Requiere al administrador.
2. **Mínimo: perfil de la CLI con `mfa_serial`** (`role_arn`, `source_profile`, `mfa_serial`, `duration_seconds`):
   la CLI pide el código una vez y guarda solo credenciales temporales del rol. Sigue necesitando una clave de
   origen, que queda **desactivada** fuera de las sesiones de trabajo.

Efecto en la operación asistida: con la confianza con MFA, cada sesión la inicia el propietario (código MFA) y
entrega al asistente solo credenciales temporales del rol por un canal que no las imprima ni las guarde en archivos.

## 7. Clave de acceso de larga duración (parte 8)

Una sola clave humana, del usuario administrador. En reposo está **Inactive**: se reactiva para cada sesión y se
desactiva justo después de asumir el rol (patrón seguido desde F18-04). No se ha borrado. Para retirarla:
1) implantar §6 (Identity Center o perfil con MFA); 2) comprobar un despliegue completo con ese flujo;
3) desactivar y observar un ciclo; 4) **borrarla con autorización explícita del propietario** (USER ACTION REQUIRED).

## 8. Validación sin ejecutar nada destructivo (parte 3)

Simulador de políticas de IAM sobre las políticas **desplegadas** y Access Analyzer (`validate-policy`) sobre las
cinco: resultados en el informe de F18-07A. Nunca se llamó a `DeleteDBInstance`, `DeleteDBSnapshot` ni a una
restauración pública.

## 9. Cambios de IAM pendientes (BLOCKED: requieren AdministratorAccess)

Ninguno se aplicó: la regla de F18-07A prohíbe usar AdministratorAccess para suplir un permiso. El rol de despliegue
no puede hacerlos por diseño (`Deny iam:*` sobre `role/busperu/*` y `policy/busperu/*`).

| # | Cambio exacto | Permiso | Por qué |
| --- | --- | --- | --- |
| 1 | `iam update-assume-role-policy --role-name BusPeruStagingDeployer` con la confianza de §6 | `iam:UpdateAssumeRolePolicy` | MFA obligatoria para el rol humano |
| 2 | Nueva versión de `BusPeruStagingDeployerPolicy` con `Deny ssm:DeleteParameter*` sobre `parameter/busperu/*/app/INTEGRATIONS_ENCRYPTION_KEY` y `…/app/JWT_SECRET` | `iam:CreatePolicyVersion` | Que un borrado no destruya la clave de los datos cifrados (sobrescribir deja historial; borrar no) |
| 3 | (Producción) crear `role/busperu/BusPeruProdCloudFormationExecution` y `role/busperu/BusPeruProdRecovery` (§3 y §5) | `iam:CreateRole`, `iam:PutRolePolicy` | Opciones C y B |
| 4 | (Tras 1) borrar la clave de acceso de larga duración | `iam:DeleteAccessKey` | Retirada definitiva (§7) |

## 10. Límite de peticiones (parte 18)

* Límites: global 300/min por IP; autenticación (7 rutas) y OAuth (2 rutas) 20 cada 15 min por IP. La IP real llega
  del ALB (`TRUST_PROXY=1`).
* Almacenamiento: memoria del proceso (`express-rate-limit`). Se reinicia con cada despliegue.
* Estrategia inicial (opción A): **Initial production uses one API instance.** No se introduce Redis.
* **Horizontal scaling requires shared rate-limit storage.** Con N instancias el límite efectivo sería N veces el
  configurado: la API **no** es *multi-instance safe* en este aspecto.

## 11. Planificador (parte 19)

* En proceso, cada 60 s (`BOOKING_EXPIRY_INTERVAL_MS`): expiración de reservas, ciclo de vida de viajes (con su
  auditoría) y purgas de códigos, flujos OAuth y revocaciones caducadas.
* Estrategia: idempotencia con `SELECT … FOR UPDATE`; probado de nuevo en F18-07A: expiración, dos barridos
  simultáneos (cada reserva una vez), cancelar y expirar a la vez (el asiento se libera una vez), notificaciones sin
  duplicar, dos pasadas concurrentes del ciclo de vida sin transiciones ni auditorías duplicadas, y arrancarlo dos
  veces no crea dos planificadores. No se crea elección de líder.
* **Scheduler is single-instance.** Para escala horizontal: **Requires leader/lock based coordination.**
* Deuda técnica (BAJA): dentro de un mismo proceso, una pasada que tardara más de 60 s se solaparía con la siguiente;
  los efectos siguen sin duplicarse (bloqueos), solo compiten por ellos.

## 12. Alarmas (parte 20)

12 alarmas de la pila, todas con acción al tema `busperu-staging-alarms` (alarma y vuelta a OK). Umbrales sin cambios.

| Alarma | Métrica | Umbral | Periodo | Evaluaciones | Datos ausentes |
| --- | --- | --- | --- | --- | --- |
| `unhealthy-hosts` | ALB `UnHealthyHostCount` (máx.) | > 0 | 60 s | 3 | breaching |
| `target5xx` | ALB `HTTPCode_Target_5XX_Count` (suma) | > 5 | 300 s | 1 | notBreaching |
| `elb5xx` | ALB `HTTPCode_ELB_5XX_Count` (suma) | > 5 | 300 s | 1 | notBreaching |
| `ec2-status` | EC2 `StatusCheckFailed` (máx.) | > 0 | 60 s | 3 | notBreaching |
| `ec2-cpu` | EC2 `CPUUtilization` (media) | > 80 % | 300 s | 3 | notBreaching |
| `ec2-memory` | CWAgent `mem_used_percent` | > 85 % | 300 s | 3 | notBreaching |
| `data-disk` | CWAgent `disk_used_percent` `/data` | > 80 % | 300 s | 3 | breaching |
| `root-disk` | CWAgent `disk_used_percent` `/` | > 80 % | 300 s | 3 | notBreaching |
| `db-cpu` | RDS `CPUUtilization` | > 80 % | 300 s | 3 | notBreaching |
| `db-free-storage` | RDS `FreeStorageSpace` | < 2 GiB | 300 s | 3 | notBreaching |
| `db-free-memory` | RDS `FreeableMemory` | < 100 MiB | 300 s | 3 | notBreaching |
| `db-connections` | RDS `DatabaseConnections` | > 40 | 300 s | 3 | notBreaching |

**USER ACTION REQUIRED:** el tema no tiene suscriptores: nadie recibe los avisos. Suscribir un correo del
propietario y **confirmar él** el enlace (no se confirma en su nombre). Faltan para producción: alarma de registros
de error de la aplicación y de fallos de backup (F18-08).

## 13. RTO completo de aplicación (parte 21) — NOT TESTED · READY FOR CONTROLLED DRILL

Medido en F18-06 (solo base de datos, restauración independiente): RDS disponible 580 s · conexión 591 s ·
validación completa 618 s. El RTO de la **aplicación** no se ha medido: exige repuntar el staging real.

Runbook del simulacro controlado (cronometrar cada paso; `T0` = declaración del incidente):

1. **Incidente.** Declarar, congelar despliegues, anotar la hora objetivo de recuperación (antes del daño) y avisar.
2. **PITR.** Elegir `restore-time` ≤ `LatestRestorableTime`; si el daño es lógico, justo antes del primer error.
3. **Restauración RDS.** `restore-db-instance-to-point-in-time` a `busperu-<env>-dr-<fecha>` con el mismo subnet group,
   SG y parameter group, `--no-publicly-accessible`, `DeletionProtection`; esperar `available` (~580 s en staging).
4. **Secretos.** Sin cambios: la restaurada conserva usuarios y contraseñas de la original (`busperu_app`,
   `busperu_migrator`); verificar con `schema-fingerprint.cjs` y los recuentos de `dr-db.cjs`.
5. **`DB_HOST`.** Snapshot manual de la original (si sigue viva); cambiar `/busperu/<env>/app/DB_HOST` al endpoint
   restaurado (se guarda el anterior para volver).
6. **Aplicación.** `systemctl restart busperu-api` (render-env vuelve a leer `app/`).
7. **Readiness.** `curl 127.0.0.1:3000/api/ready` = 200 en la instancia.
8. **ALB.** Destino `healthy` y `GET /api/ready` = 200 por el ALB → `T1`. RTO de aplicación = `T1 − T0`.
9. **Smoke test.** `smoke-staging.mjs` + lectura de una reserva y una cuenta bancaria conocidas + login.
10. **Rollback / reconciliación.** Si falla: volver a poner el `DB_HOST` anterior y reiniciar. Si funciona:
    reconciliar lo escrito entre la hora objetivo y `T1` (pagos de Culqi por su panel, reservas), mantener la
    original sin borrar (solo el administrador puede) hasta cerrar el incidente, y registrar tiempos y datos perdidos
    (RPO).

No se declara PASS: es un diseño listo para ensayar en una ventana controlada.

## 14. Datos bancarios y rotación

* Migración 019 validada 018 → 019 en `busperu_test` (MariaDB 10.4) y en 10.11.19 estricto: 492 → 496 columnas, solo
  las 4 nuevas y `account_number` NULL, índices/FKs/CHECKs idénticos, filas heredadas intactas, idempotente, y la
  huella coincide con `schema-reference.json`.
* `bank:encrypt`: `--verificar | --cifrar | --recifrar | --purgar-texto-plano --base= | --revertir --base=`. F18-07A
  añade `--recifrar` y el recuento `solo con la clave anterior` en `--verificar`: con ellos la rotación ya no depende
  de volver a guardar cada cuenta a mano.
* Pruebas: `80-f1807-cifrado-bancario.test.ts` pasa de 21 a 27 (etiqueta GCM alterada, clave desconocida, ADMIN,
  CUSTOMER, rotación completa y negativa de `--recifrar`), con controles negativos por mutación.
* El texto en claro de producción no existirá: la versión con la 019 cifra desde la primera escritura.

## 15. Secretos locales (parte 9)

El `JWT_SECRET` local (`backend/.env`, solo desarrollo y pruebas) se rotó en F18-07A tras la exposición parcial de
F18-07. El valor antiguo no aparece en el repositorio ni en archivos de trabajo; su prefijo de 8 caracteres solo
consta en dos transcripciones locales de la sesión de F18-07 y ya no firma nada. El secreto de staging es otro,
generado en F18-04 directamente en Parameter Store.

## 16. Aplicado en staging (2026-09-24)

* Snapshot manual `busperu-staging-pre019-f1807a` (cifrado; el rol no puede borrarlo).
* 019 sola con `apply-one-migration.sh`: esquema = referencia (496/221/81/12); antes/después en el mismo comando
  359 filas y CHECKSUM idénticos.
* Versión `2026-09-23-3` desplegada (`/health` y `/ready` 200 con `no-store`).
* `bank:encrypt`: 1 cuenta heredada sintética detectada → cifrada → verificada (0 ilegibles, 0 discrepancias) →
  purgada. Estado final: 2 cuentas, 0 en claro, 2 cifradas, sobres v1 con nonce de 12 B y etiqueta de 16 B.
* RBAC por la API: ADMIN y COMPANY_ADMIN completo; OPERATOR solo últimos 4 y sin escritura; CUSTOMER 403;
  COMPANY_ADMIN de otra empresa sin acceso. Auditoría y registros de CloudWatch sin números completos ni sobres.
* Pila, base original, alarmas (12 OK), DLM y Parameter Store (17) sin cambios. Rotación de clave en staging: **no
  autorizada** (probada en local, §14).
* Lecciones: `bank:encrypt` necesita `NODE_ENV=production` además de `api.env` (la guarda se negó sin ella, como
  debe); y la versión anterior a F18-07 serializa todas las columnas (runbook §5.1, vuelta atrás).

## 17. Otros cambios de código de F18-07A

* `/api/health` envía `Cache-Control: no-store`, como ya hacía `/api/ready` (prueba en la suite 78).
* `infra/aws/scripts/apply-one-migration.sh`: aplica una migración nombrada a una base existente (runbook §5.1).
* `bank:encrypt -- --recifrar` e `isEncryptedWithCurrentKey` (§14).
