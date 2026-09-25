# BusPerú · Seguridad e IAM antes de producción (F18-07)

> Estado: **staging**. No existe producción. Este documento recoge qué se auditó, qué se cambió, qué se decidió
> NO cambiar y por qué, y qué es obligatorio antes de producción. No contiene cuentas, claves ni secretos.

---

## 1. Quién puede modificar, destruir y recuperar RDS

| Principal | Modificar la base original | Destruirla | Borrar snapshots / backups | Recuperar (PITR / snapshot) |
| --- | --- | --- | --- | --- |
| Usuario administrador (`Rodrigo`, grupo `ADMINISTRACION` con AdministratorAccess) | Sí | Sí (tras quitar `DeletionProtection`) | Sí | Sí |
| Rol `BusPeruStagingDeployer` **antes** de F18-07 | Sí | Sí (tras `ModifyDBInstance` para quitar la protección) | Snapshots manuales `busperu-staging-*`: sí | Sí |
| Rol `BusPeruStagingDeployer` **después** de F18-07 | Sí (`ModifyDBInstance`, `RebootDBInstance`) | **No**: `Deny rds:DeleteDBInstance` sobre `db:busperu-staging-db`, también vía CloudFormation | **No**: `Deny` de borrar, compartir o exportar snapshots y de borrar backups retenidos | Sí, **solo privadas** (`Deny` con `rds:PubliclyAccessible=true`) |
| Rol de la aplicación (EC2) | No | No | No | No |

Protecciones adicionales de la propia base: `DeletionProtection=true`, `DeletionPolicy: Snapshot` en la pila, cifrado
KMS, sin acceso público, subredes privadas, SG que solo admite 3306 desde la EC2 y retención de 7 días con PITR.

## 2. Decisiones de IAM

**Opción elegida: A (barreras `Deny` explícitas), sin `aws:CalledVia`.** Es el cambio mínimo que reduce el riesgo
destructivo sin romper el despliegue:

* `NoBorrarLaBaseOriginal` · `rds:DeleteDBInstance` sobre `db:busperu-staging-db` (sin comodín: borrar las
  instancias temporales `busperu-staging-dr-*` de las pruebas de restauración sigue permitido).
* `NoBorrarNiCompartirCopias` · `rds:DeleteDBSnapshot`, `rds:ModifyDBSnapshotAttribute`,
  `rds:DeleteDBInstanceAutomatedBackup`, `rds:StartExportTask`.
* `RestauracionesSiemprePrivadas` · `rds:RestoreDBInstanceToPointInTime` y `RestoreDBInstanceFromDBSnapshot` con
  `rds:PubliclyAccessible = true`.

`check-iam.mjs` exige las tres y comprueba que la primera apunte exactamente a la base original, sin condiciones.

**Aplicado en staging (2026-09-23):** `BusPeruStagingDeployerPolicy` v2 → **v3** (la v2 se conserva para volver
atrás con `iam set-default-policy-version`), Access Analyzer sin hallazgos y **16/16 controles del simulador**:
denegados borrar la original (también con `aws:CalledVia=cloudformation`), borrar/compartir/exportar snapshots,
borrar backups retenidos, restaurar en público y ampliarse a sí mismo; permitidos borrar una restaurada temporal,
restaurar en privado, `Modify`/`Reboot` de la original (riesgo residual), snapshot manual, `UpdateStack` y
lecturas. La pila, la base y la aplicación no cambiaron (`/api/ready` 200). Nada destructivo se ejecutó para probarlo.

**Por qué NO `aws:CalledVia`.** La documentación de IAM dice que la clave solo existe cuando un servicio que la
admite usa las credenciales del principal mediante *forward access sessions* (FAS), y que no existe si el servicio
usa un rol de servicio o si la llamada es directa. No garantiza que CloudFormation llame a RDS por FAS al gestionar
un `AWS::RDS::DBInstance` sin rol de servicio, y comprobarlo exigiría modificar la base de verdad. Una barrera
basada en ella podría no proteger nada o bloquear las actualizaciones de la pila. Por eso las barreras no llevan
condición y afectan también a CloudFormation: borrar o reemplazar la base desde la pila falla, y hace falta un
administrador. Es el comportamiento deseado.

**Riesgo residual (documentado, MEDIUM para producción).** `ModifyDBInstance` sigue permitido porque las
actualizaciones de la pila lo necesitan, y la referencia de autorización de RDS solo ofrece `rds:ManageMasterUserPassword`
como clave de condición de esa acción: no se puede denegar de forma selectiva poner la retención a 0 (que borra los
backups automáticos), quitar `DeletionProtection` o cambiar la contraseña maestra. Lo mitiga que borrar siga
denegado y que la pila no permita retención 0 (`DbBackupRetentionDays` ≥ 1). **Se cierra en producción con la
opción C.**

### Opción C para producción (diseño, no desplegado): rol de ejecución de CloudFormation

* `BusPeruProdCloudFormationExecution` (confianza: solo `cloudformation.amazonaws.com`, con
  `aws:SourceAccount`), con los permisos de escritura que hoy tiene el rol de despliegue y las mismas barreras.
* El rol del operador pierde toda escritura directa sobre RDS, EC2, ELB y S3. Conserva `cloudformation:*` sobre
  su pila (con `--role-arn` obligatorio vía `cloudformation:RoleArn`), `iam:PassRole` solo para ese rol, y lecturas.
* Así «CloudFormation frente a llamada directa» se distingue por **identidad**, no por una clave de condición.

### Rol de recuperación (diseño, no desplegado)

Solo para incidentes; confianza exclusiva del administrador con MFA; límite de permisos obligatorio.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "LeerRds", "Effect": "Allow", "Action": ["rds:Describe*", "rds:ListTagsForResource"], "Resource": "*" },
    { "Sid": "RestaurarEnInstanciaNueva", "Effect": "Allow",
      "Action": ["rds:RestoreDBInstanceToPointInTime", "rds:RestoreDBInstanceFromDBSnapshot", "rds:AddTagsToResource"],
      "Resource": ["arn:aws:rds:<region>:<cuenta>:db:busperu-prod-dr-*", "arn:aws:rds:<region>:<cuenta>:db:busperu-prod-db",
                   "arn:aws:rds:<region>:<cuenta>:snapshot:*", "arn:aws:rds:<region>:<cuenta>:subgrp:busperu-prod-*",
                   "arn:aws:rds:<region>:<cuenta>:pg:busperu-prod-*", "arn:aws:rds:<region>:<cuenta>:og:default:mariadb-10-11"],
      "Condition": { "Bool": { "rds:PubliclyAccessible": "false" } } },
    { "Sid": "NadaDestructivo", "Effect": "Deny",
      "Action": ["rds:Delete*", "rds:ModifyDBSnapshotAttribute", "rds:StartExportTask", "iam:*", "cloudformation:*", "ec2:Delete*", "ec2:Terminate*"],
      "Resource": "*" }
  ]
}
```

Repuntar la aplicación a la instancia restaurada (cambiar `/busperu/<env>/app/DB_HOST` y reiniciar el servicio)
lo hace el operador con su rol normal: el de recuperación no toca parámetros ni la aplicación.

## 3. Cifrado de los datos bancarios

* **Qué:** `company_bank_accounts.account_number` e `interbank_code`.
* **Cómo:** el mismo `encryptJson` de las credenciales de integraciones (AES-256-GCM, nonce aleatorio de 12 bytes en
  cada escritura, sobre versionado `v:1`, rotación con `INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS`). No hay un sistema
  criptográfico nuevo. El texto cifrado lleva dentro el campo y la empresa y se rechaza si no coinciden.
* **Almacenamiento (migración 019):** `*_encrypted` (sobre) y `*_last4` (enmascarado); las columnas en claro quedan a
  NULL para toda escritura nueva. La 019 no borra nada; la purga del texto heredado es un paso explícito y verificado.
* **Acceso:** solo quien tiene `companies.update` (ADMIN, COMPANY_ADMIN de esa empresa) provoca un descifrado. OPERATOR
  recibe el enmascarado desde `last4`, sin descifrar. Ni el sobre ni las columnas internas salen de la API.
* **Duplicados:** se comparan en memoria las cuentas de la empresa (pocas), descifradas en el servidor. No hace falta
  un índice ciego; si algún día hubiera búsqueda global por número, habría que diseñar un HMAC con clave propia.
* **Sin clave configurada** la escritura falla con 503: nunca se guarda un número en claro.
* **Migración de filas existentes:** `npm run bank:encrypt -- --cifrar | --verificar | --purgar-texto-plano --base=<b> |
  --revertir --base=<b>` (runbook de staging §5.1). Solo imprime recuentos.
* **Pruebas:** `80-f1807-cifrado-bancario.test.ts` (21) y la suite 12 existente (46), con controles negativos por
  mutación (escribir en claro, entregar el valor al OPERATOR: ambas detectadas).

## 4. Auditoría de sucesos sin persona detrás

Todas por `recordSystemAudit`: `user_id` NULL, actor en `new_values.actor`, fila escrita **dentro** de la transacción
del cambio (si la auditoría falla, el cambio se deshace; si el cambio se deshace, no queda fila huérfana).

| Suceso | Acción | Actor | Antes de F18-07 |
| --- | --- | --- | --- |
| Webhook de Culqi confirma una reserva | `CONFIRM` (bookings) | `system:culqi-webhook` | solo registro de aplicación |
| Webhook rechaza un cargo (importe, moneda u otro cargo) | `REJECT` (payments) | `system:culqi-webhook` | solo registro de aplicación |
| Webhook marca un pago como fallido | `FAIL` (payments) | `system:culqi-webhook` | nada |
| Reembolso compensatorio abierto (webhook o cobro síncrono) | `COMPENSATE` (payments, con `refund_id`) | `system:payments` | nada en `audit_logs` |
| Viaje sale / llega automáticamente | `START` / `COMPLETE` (trips) | `system:trip-lifecycle` | nada |
| Reserva completada con su viaje | `COMPLETE` (bookings) | `system:trip-lifecycle` | nada |
| Expiración de reservas | `EXPIRE` (bookings) | `system:booking-expiry` | ya existía |

La confirmación por el navegador conserva su auditoría de usuario en la ruta y no se duplica. Nunca se registra el
token de la tarjeta, CVV, secretos, cabeceras de autorización ni llaves: solo identificadores públicos (`chr_…`).
Pruebas: `81-f1807-auditoria-financiera.test.ts` (8), con controles negativos por mutación.

Pendiente (deuda técnica, no bloqueante): auditoría de liquidaciones generadas automáticamente, si en el futuro
existe un proceso automático (hoy se crean por acción de un usuario y ya se auditan en la ruta).

## 5. Planificador y límite de peticiones

* **Planificador en proceso** (cada 60 s, `BOOKING_EXPIRY_INTERVAL_MS`): expiración de reservas, ciclo de vida de
  viajes y purgas. Todas sus escrituras son idempotentes con bloqueo de filas (`FOR UPDATE`): con dos instancias se
  duplican los **intentos**, no los efectos (probado con dos pasadas concurrentes). Aceptable para producción de
  **una sola instancia**; con varias, conviene un líder único (o un planificador externo) para no competir por
  bloqueos. No requiere Redis.
* **Límite de peticiones en memoria** (`express-rate-limit`): global 300/min por IP; autenticación (7 rutas) y OAuth
  (2 rutas) 20 cada 15 min por IP; la IP real llega del ALB (`TRUST_PROXY=1`). Con N instancias el límite efectivo
  es N veces el configurado y se reinicia con cada despliegue. **Condición de producción: una sola instancia** o un
  almacén compartido (Redis) antes de escalar horizontalmente.
* **Readiness:** `/api/health` = proceso vivo; `/api/ready` = base de datos + almacenamiento, y es el health check del
  ALB. No hace falta otra comprobación.

## 6. Secretos

Parameter Store: 17 parámetros en `/busperu/staging/` (5 SecureString); la app solo lee `app/`, el migrador `ops/`.
El secreto maestro de RDS lo gestiona Secrets Manager y ni la app ni el rol de despliegue pueden leerlo. Ningún
secreto en Git, en el bundle del frontend ni en los registros (búsqueda por patrones y por valores reales).
`INTEGRATIONS_ENCRYPTION_KEY` protege ahora integraciones **y** datos bancarios: perderla vuelve ilegibles ambos.
Producción debe tener sus propios secretos (nunca los de staging).

## 7. Obligatorio antes de producción

1. Rol de ejecución de CloudFormation (opción C) y rol de recuperación separado.
2. MFA obligatoria para asumir los roles; retirar la clave de acceso de larga duración del administrador.
3. Desplegar la migración 019 y ejecutar `bank:encrypt` (cifrar → verificar → purgar) en cada entorno con datos.
4. Una sola instancia de la API, o almacén compartido para el límite de peticiones y líder único del planificador.
5. Dominio, certificado y HTTPS; correo real; llaves de Culqi del entorno correcto.
6. Suscripción al tema de alarmas; RTO completo de aplicación medido.

**F18-07A** cierra o convierte en acciones explícitas estos puntos: auditoría IAM final, diseño aprobado de los roles
de recuperación y de ejecución, MFA y retirada de la clave (acción del propietario), rotación completa con
`bank:encrypt -- --recifrar`, estrategia de una instancia y runbook del RTO completo: ver `HARDENING-F18-07A.md`.
