# BusPerú · Production Readiness (F18-08)

> **F18-08 CERRADO (técnicamente) el 2026-09-24 por el propietario.** Resultado para producción: **NOT READY** por
> acciones pendientes del propietario (§19). Solo se creó la línea base de seguridad autorizada; ninguna
> infraestructura de aplicación productiva.
>
> **Fase de preparación.** No se ha desplegado nada. Este documento
> separa **A. Diseño · B. Validación · C. Autorización · D. Despliegue**: C y D requieren autorización explícita del
> propietario («Autorizo el deployment de producción.»). Sin cuentas, claves, secretos ni datos reales.
> Marcadores: `<cuenta>`, `<dominio>`, `<correo-remitente>`.

---

## 1. Arquitectura objetivo (primera producción, una sola instancia)

```
Navegador ──HTTPS──► CloudFront (OAC) ──► S3 privado: frontend (build de Vite)          [us-east-1: certificado ACM]
          └─HTTPS──► ALB :443 (ACM sa-east-1, :80 → 301) ──► EC2 t4g (API Node 24, systemd) ──► RDS MariaDB 10.11 privada
                                                               │                                (KMS alias/busperu-prod-rds)
                                                               ├─ /data (EBS gp3 cifrado, DLM diario) · subidas y logotipos
                                                               └─ Parameter Store /busperu/prod/app/* (KMS alias/busperu-prod-secrets)
Cuenta: CloudTrail multirregión → S3 privado (integridad) y → CloudWatch Logs → filtros → alarmas → SNS (seguridad)
        CloudWatch: alarmas de infraestructura, base de datos, aplicación y backup → SNS busperu-prod-alarms
```

Pilas previstas (todo como código, sin recursos manuales sin documentar):

| Pila | Contenido | La aplica | Estado |
| --- | --- | --- | --- |
| `busperu-security-baseline` (cuenta) | CloudTrail, su bucket, filtros y alarmas de seguridad, 3 claves KMS, roles `/busperu/Prod*`, SNS, Access Analyzer | administrador con MFA (autorizado) | **CREATE_COMPLETE el 2026-09-24** (§18.3) |
| `busperu-prod` (sa-east-1) | la plantilla de staging con `EnvName=prod` + listener HTTPS + CMK de RDS + alarmas nuevas | rol de ejecución (C) vía operador | **no creada** |
| `busperu-prod-edge` (us-east-1) | CloudFront, OAC, bucket del frontend, certificado ACM | administrador u operador con excepción regional | pendiente de dominio |

## 2. IAM de producción (diseño C + B, como código)

`infra/aws/iam/prod/build-iam-prod.mjs` genera 18 documentos a partir de las políticas de staging ya validadas
(prefijo `busperu-prod`) y `check-iam-prod.mjs` los comprueba (mutantes detectados; validación en AWS en §18.2). Ninguno se ha creado.

| Principal | Qué puede | Qué no puede (Deny explícito o ausencia de Allow) |
| --- | --- | --- |
| `BusPeruProdOperator` (humano, MFA) | change sets **solo con** `cloudformation:RoleArn` = rol de ejecución; ejecutarlos; lecturas; snapshot manual; subir versiones; Run Command a la EC2 de la pila; escribir parámetros (sin poder descifrarlos) | escritura directa en RDS/EC2/ELB/SG/DLM/alarmas; `kms:Decrypt`; borrar la base, snapshots, backups, secretos, claves KMS, trail, reglas y bucket de auditoría; IAM sobre sí mismo o personas; restaurar en público |
| `BusPeruProdCloudFormationExecution` (servicio) | lo que hoy crea la pila de staging, en `busperu-prod-*`; roles de la carga solo con límite; KMS de RDS solo vía RDS | las mismas barreras; nada de KMS de secretos, CloudTrail ni IAM de `/busperu/` |
| `BusPeruProdRecovery` (humano, MFA) | describir; PITR y restaurar desde snapshot **solo** a `busperu-prod-dr-*`, **solo privadas**; KMS de RDS vía RDS | `rds:Delete*/Modify*/Reboot*`, IAM, CloudFormation, SSM, Secrets Manager, S3, EC2 destructivo, `kms:Decrypt`, CloudTrail |
| `BusPeruProdBreakGlass` (humano, MFA, alarma al usarlo) | leer y descifrar un parámetro de `/busperu/prod/*` vía SSM | cualquier otra acción (`NotAction` en Deny) |
| `busperu-prod-app-role` (EC2) | leer **solo** `/busperu/prod/app/*` y descifrarlo vía SSM; registros, métricas, versiones, almacenamiento | IAM, CloudFormation, escribir parámetros, RDS control, `kms:Encrypt`, Secrets Manager, CloudTrail |

Frontend en CloudFront: el certificado va en **us-east-1**; la barrera `SoloSaoPaulo` lo impediría al rol de
ejecución. Se resuelve con la pila `busperu-prod-edge` aplicada por el administrador o añadiendo `acm:*`/`cloudfront:*`
a la excepción regional solo para esa pila (decisión con el dominio).

## 3. KMS de producción

Tres CMK simétricas propias (nunca `aws/ssm` ni claves de staging), rotación anual automática, espera de borrado de
30 días y `DeletionPolicy: Retain`. Separación lógica aprobada por el propietario: la clave de datos de la app
(cuentas bancarias e integraciones) tiene su propia CMK, distinta de la del resto de secretos:

| Alias | Protege | Usan (vía servicio) | Administra |
| --- | --- | --- | --- |
| `alias/busperu-prod-data` | solo `/busperu/prod/app/INTEGRATIONS_ENCRYPTION_KEY*` | app: `Decrypt` vía SSM y solo ese parámetro; operador: `Encrypt`; emergencia: `Decrypt` vía SSM | administrador con MFA, **sin** Encrypt/Decrypt |
| `alias/busperu-prod-secrets` | resto de SecureString de `/busperu/prod/*` | app: `Decrypt` vía SSM y solo `…/app/*` (contexto `PARAMETER_ARN`); operador: `Encrypt` vía SSM; emergencia: `Decrypt` vía SSM | administrador con MFA, **sin** Encrypt/Decrypt |
| `alias/busperu-prod-rds` | almacenamiento, snapshots y backups de RDS | rol de ejecución y de recuperación, solo vía RDS | administrador con MFA |

Las políticas de clave **no** incluyen la declaración «raíz de la cuenta → `kms:*`»: así ninguna política IAM
(ni AdministratorAccess) concede `Decrypt`; la identidad humana solo descifra asumiendo la de emergencia (auditada).
Riesgo asumido: el administrador puede cambiar la política de la clave (`PutKeyPolicy`); por eso esa llamada tiene
alerta (§5) y las barreras de C la niegan. Borrado de clave: solo el administrador, espera de 30 días y alerta.

Validación: estructura comprobada en local. El simulador de IAM **no puede** modelar una política de clave con
roles como llamante (su `CallerArn` solo admite usuarios), así que la prueba definitiva de «humano: Decrypt = DENY /
app: Decrypt = ALLOW / principal o región equivocados = DENY» se hace **al crear la clave** en F18-09, con
`get-parameter --with-decryption` desde cada identidad (resultado, nunca el valor).

## 4. Custodia de secretos — decisión del propietario

Recomendación (combinación B + C del enunciado): **Parameter Store SecureString con la CMK propia** para todos los
secretos de la app, porque la app ya los lee así (`render-env.sh`), sin coste por secreto y con historial; Secrets
Manager solo para el secreto maestro de RDS (lo gestiona RDS). Complementos obligatorios:

| Aspecto | Diseño |
| --- | --- |
| Generación | en la instancia o en CloudShell (`openssl rand`), directo a Parameter Store; nunca en un equipo personal ni en un chat |
| Acceso | app: solo `app/`; operador: escribe sin leer; emergencia: lee con MFA y alerta |
| Copia / recuperación | `INTEGRATIONS_ENCRYPTION_KEY`: **copia fuera de línea** en custodia del propietario (gestor de contraseñas con MFA o sobre sellado); perderla hace ilegibles cuentas bancarias e integraciones para siempre |
| Borrado | `Deny ssm:DeleteParameter*` (clave de cifrado y JWT) en C; historial de versiones ante sobrescrituras; alerta |
| Rotación | runbook §5.2 (`--recifrar`); `JWT_SECRET` por sustitución (cierra sesiones); contraseñas de BD coordinadas |
| Clave anterior | `…_PREVIOUS` solo durante una rotación; se retira tras `--verificar` = 0 con la anterior |
| Tras un PITR | la base restaurada contiene sobres cifrados con la clave **vigente en ese momento**: si hubo rotación entre la hora restaurada y hoy, hay que volver a poner la anterior como `…_PREVIOUS` (por eso el historial del parámetro se conserva) |
| Auditoría | CloudTrail registra `GetParameter`/`Decrypt` de la emergencia y toda escritura |

### Inventario de secretos (sin valores)

| Nombre (`/busperu/prod/…`) | Dueño | Almacén | Rotación | Acceso |
| --- | --- | --- | --- | --- |
| `app/JWT_SECRET` | propietario | SSM + CMK | sustitución (cierra sesiones) | app |
| `app/INTEGRATIONS_ENCRYPTION_KEY` (+ `_PREVIOUS` temporal) | propietario | SSM + CMK + copia fuera de línea | runbook §5.2 | app; emergencia |
| `app/DB_PASSWORD` | propietario | SSM + CMK | coordinada con la BD | app |
| `ops/MIGRATOR_DB_PASSWORD` | propietario | SSM + CMK | antes y después de cada migración grande | rol de la instancia **solo ese parámetro** (las migraciones corren allí; la API no lo recibe: `render-env.sh` lee solo `app/`); emergencia |
| `ops/ADMIN_PASSWORD` (arranque) | propietario | SSM + CMK | **temporal**: se cambia al primer inicio y se borra el parámetro | emergencia |
| secreto maestro de RDS | RDS | Secrets Manager (gestionado) | automática de RDS | nadie de forma permanente: para crear los usuarios de BD una vez (`create-db-users.sh`), el administrador adjunta al rol de la instancia una política temporal con `GetSecretValue` de ese secreto y la retira al terminar (queda en CloudTrail) |
| `app/CULQI_*`, `app/RESEND_API_KEY`, `app/GOOGLE_*`, `app/MICROSOFT_*` | propietario | SSM + CMK | en el panel del proveedor | app |

## 5. CloudTrail y alertas de seguridad

Trail `busperu-prod-trail`: multirregión, eventos globales (IAM, STS, Route 53, CloudFront), eventos de gestión de
lectura y escritura de todos los servicios (IAM, STS, RDS, S3 de control, SSM, Secrets Manager, KMS, CloudFormation,
EC2, ELB, Route 53, CloudWatch), **validación de integridad**, bucket propio privado con bloqueo público, SSE,
versionado, `Deny` de TLS inseguro y de borrado para todos salvo la emergencia, retención 400 días (ciclo de vida).
Coste: el primer trail de eventos de gestión no factura eventos; solo S3.

Alertas: CloudTrail → CloudWatch Logs (`/busperu/security/cloudtrail`, 90 días) → **filtros de métrica** → alarmas →
SNS `busperu-prod-security`. Se eligió esto y no EventBridge porque los eventos de IAM, STS y de la cuenta raíz solo
llegan a EventBridge en us-east-1; así todo queda en sa-east-1 y en una sola pila. El trail es de toda la cuenta, así
que las alertas también cubren staging (deseable; el volumen es bajo):

| Evento | Detección (patrón) | Alarma | SNS |
| --- | --- | --- | --- |
| Uso de la cuenta raíz | `userIdentity.type = Root` | inmediata | security |
| Cambios de políticas IAM | `iam:*Policy*`, `Attach*/Detach*`, `CreatePolicyVersion`, `SetDefaultPolicyVersion` | inmediata | security |
| Cambios de confianza | `iam:UpdateAssumeRolePolicy` | inmediata | security |
| Política o estado de claves KMS | `kms:PutKeyPolicy`, `ScheduleKeyDeletion`, `DisableKey`, `CreateGrant` sobre la de secretos | inmediata | security |
| Secrets Manager | `DeleteSecret`, `PutSecretValue`, `UpdateSecret` | inmediata | security |
| Borrado de parámetros | `ssm:DeleteParameter(s)` en `/busperu/prod/` | inmediata | security |
| Uso de la emergencia | `sts:AssumeRole` sobre `BusPeruProdBreakGlass` | inmediata | security |

Plantilla: `infra/aws/security-baseline/build-baseline.mjs` (51 recursos) y su comprobación `check-baseline.mjs`
(solo tipos autorizados, KMS con Retain y rotación, trail completo, bucket privado, 11 alertas, SNS sin suscripciones;
3 mutantes detectados).
| Borrado o exposición de RDS | `DeleteDBInstance`, `ModifyDBInstance` con `publiclyAccessible`/`backupRetentionPeriod=0`/`deletionProtection=false`, `ModifyDBSnapshotAttribute` | inmediata | security |
| Grupos de seguridad | `Authorize/RevokeSecurityGroup*`, `CreateSecurityGroup` | inmediata | security |
| Auditoría apagada | `cloudtrail:StopLogging`, `DeleteTrail`, `UpdateTrail`, `PutEventSelectors`; `events:DisableRule/DeleteRule` | inmediata | security |

Sin ruido: solo eventos de escritura concretos; las lecturas no alertan.

## 6. Monitorización

Se mantienen las 12 alarmas de staging (con `busperu-prod-*`) y se añaden:

| Alarma | Métrica | Umbral | Periodo × evaluaciones | Acción |
| --- | --- | --- | --- | --- |
| `alb-latency` | ALB `TargetResponseTime` p95 | > 1,5 s | 300 s × 3 | SNS alarms |
| `app-5xx-rate` | filtro de registros `status>=500` (métrica `BusPeru/App`) | > 10 en 5 min | 300 s × 1 | SNS alarms |
| `app-ready-failures` | filtro «readiness falló» | ≥ 1 | 60 s × 3 | SNS alarms |
| `app-payment-failures` | filtro de errores de Culqi/webhook | ≥ 3 en 15 min | 900 s × 1 | SNS alarms |
| `app-db-errors` | filtro `ER_`/`ECONNREFUSED` saneado | ≥ 5 en 5 min | 300 s × 1 | SNS alarms |
| `app-scheduler-errors` | filtro «Error al expirar/ciclo de vida» | ≥ 3 en 15 min | 900 s × 1 | SNS alarms |
| `rds-backup-failure` | evento RDS `backup` con fallo (EventBridge) | 1 | evento | SNS alarms |
| `dlm-snapshot-failure` | evento DLM `failed` (EventBridge) | 1 | evento | SNS alarms |
| `auth-failures` | filtro de 401 en `/auth/login` | > 50 en 5 min | 300 s × 1 | SNS alarms |

Registros: grupo `/busperu/prod/app` con retención 90 días (decisión del propietario), ya estructurados y saneados
(sin secretos, tokens ni números completos: pruebas de F18-07). Réplica de lectura: no aplica (sin réplicas).

## 7. RDS de producción

MariaDB 10.11 (misma menor que staging), subredes privadas, SG solo desde la EC2, `PubliclyAccessible=false`,
cifrado con `alias/busperu-prod-rds`, `DeletionProtection`, `DeletionPolicy/UpdateReplacePolicy: Snapshot`,
backups automáticos **14 días** (propuesta; decisión del propietario), PITR, ventana de backup 07:00–07:30 UTC
(02:00–02:30 Lima) y de mantenimiento dom 08:00–08:30 UTC, `sql_mode` estricto, registros `error` y `slowquery` a
CloudWatch, Performance Insights (retención gratuita de 7 días), sin Multi-AZ en la primera producción (decisión de
coste; RTO por restauración, §8), gp3 20 GiB con autoescalado de almacenamiento.

Usuarios de base de datos: se mantiene el modelo de staging (`create-db-users.sh`): `busperu_app` con
SELECT/INSERT/UPDATE/DELETE sobre `busperu_prod`; `busperu_migrator` con DDL sobre `busperu_prod`; ninguno con
`CREATE USER`, `GRANT OPTION` ni acceso a `mysql.*`; el maestro solo en Secrets Manager.

Migraciones en producción: base nueva → `apply-migrations.sh` (dump + 001 → 019, sin `--force`); futuras →
snapshot manual → `apply-one-migration.sh` → huella de esquema → despliegue → humo → vuelta atrás documentada.
Datos bancarios: en una base nueva no hay filas heredadas; la versión con la 019 cifra desde la primera escritura, así
que `bank:encrypt` solo se usa si se importan datos (no autorizado).

## 8. Backup, DR, RTO y RPO

* **Probado (F18-06, staging):** PITR independiente, 49 tablas y CHECKSUM idénticos, RDS disponible 580 s,
  conexión 591 s, validación 618 s.
* **RTO completo de aplicación: MEDIDO en staging el 2026-09-24 = 615 s (10,3 min)** (simulacro controlado, §18.4):
  T0→T1 5 s · T1→T2 588 s (RDS) · T2→T3 19 s (comprobación de esquema/integridad, repuntar y reiniciar) · T3→T4 0 s ·
  T4→T5 3 s (humo). Base de 20 GiB casi vacía: en producción la restauración crece con el tamaño de la base.
* **RPO configurado:** PITR con granularidad de segundos hasta `LatestRestorableTime` (en staging, el 2026-09-24,
  `LatestRestorableTime` iba ≈ 3 min por detrás de la hora actual). «No actual data-loss window was measured.»
* **Almacenamiento /data:** snapshots diarios de DLM (RPO de hasta 24 h para logotipos y documentos subidos).

### Runbook de DR de producción

1. **Incidente**: declarar, hora T0, congelar despliegues. 2. **Evaluar**: qué falló (base, instancia, región, datos
lógicos) y hora objetivo. 3. **Aislar**: si hay compromiso, rotar credenciales afectadas y cortar acceso (SG) antes de
restaurar. 4. **Restaurar** (rol de recuperación): PITR o snapshot a `busperu-prod-dr-<fecha>`, privada, mismo subnet
group, SG y parameter group. 5. **Secretos**: sin cambios (la restaurada conserva usuarios); si hubo rotación de la
clave de datos tras la hora restaurada, reponer la anterior como `…_PREVIOUS`. 6. **KMS**: la restaurada usa la misma
CMK de RDS; comprobar que la clave está habilitada. 7. **DB_HOST**: snapshot de la original (si vive) y actualizar
`/busperu/prod/app/DB_HOST` (operador). 8. **API**: reiniciar el servicio. 9. **Frontend**: sin cambios (estático).
10. **DNS**: sin cambios (el ALB no cambia); solo si se pierde la región. 11. **Humo**: `/health`, `/ready`, login,
reserva de lectura, cuenta bancaria enmascarada. 12. **Validación**: huella de esquema, recuentos, CHECKSUM.
13. **Comunicación**: aviso a usuarios si hubo pérdida de datos o indisponibilidad. 14. **Vuelta atrás**: repuntar al
`DB_HOST` anterior. 15. **Postmortem**: tiempos, RPO real, causa y acciones; la original no se borra (solo el
administrador) hasta cerrarlo.

## 9. Respuesta a incidentes

| Incidente | Primeros pasos |
| --- | --- |
| Clave de acceso comprometida | 1) desactivar; 2) CloudTrail: qué hizo y desde dónde; 3) rotar secretos a los que pudo llegar; 4) invalidar sesiones (cambiar `JWT_SECRET` cierra todas); 5) investigar y borrar la clave |
| IAM comprometido | quitar sesiones (`Revoke older sessions` del rol), revisar políticas y confianzas con Access Analyzer, restaurar desde el repositorio (`build-iam*`) |
| Fuga de secreto | rotar ese secreto (runbook §5.2 para la clave de datos), revisar CloudTrail de `GetParameter`/`Decrypt` |
| Compromiso de RDS | aislar SG, snapshot forense, rotar contraseñas de BD, restaurar a la hora previa (§8) |
| Corrupción de datos | PITR a una instancia nueva, comparar, repuntar |
| Problema de KMS | no borrar ni deshabilitar; si se deshabilitó, habilitar (administrador); si se programó borrado, cancelar |
| Caída de pagos | Culqi: el webhook es idempotente; reconciliar por el panel y `reconcileApprovedCharge` |
| Caída de correo | los correos no bloquean la operación; reintentar tras resolver en Resend |
| Caída de EC2 / ALB | la pila recrea la instancia; `/data` es un volumen aparte; comprobar destinos del ALB |

## 10. Almacenamiento

Decisión recomendada para la primera producción: **A · EBS gp3 persistente** (lo que ya usa staging, sin cambios de
código): volumen de datos separado de la instancia, cifrado, `DeletionPolicy: Snapshot`, snapshots diarios de DLM,
sobrevive a reinicios, despliegues y sustitución de la instancia. **B · S3** para subidas cuando se escale a varias
instancias (requiere cambiar `file-storage.service`): deuda técnica, no bloqueante con una instancia.

## 11. Límite de peticiones y planificador

«Initial production uses one API instance.» «Horizontal scaling requires shared rate-limit storage.»
«Scheduler is single-instance.» Escalar exige coordinación por líder/bloqueo. Sin Redis ni elección de líder ahora.

## 12. Correo (Resend), pagos (Culqi), dominio y HTTPS — pendientes de decisión

* **Resend**: dominio de envío verificado (SPF, DKIM de Resend, DMARC `p=quarantine` al inicio), remitente
  `<correo-remitente>`, clave de producción en `app/RESEND_API_KEY` (SSM + CMK), correo de prueba solo con
  autorización, alarma de fallos de envío por filtro de registros.
* **Culqi**: llaves de producción en `app/CULQI_*`; webhook `https://<dominio-api>/api/culqi/webhook/<segmento secreto>`
  (Culqi no firma: el segmento secreto + re-consulta del cargo + idempotencia por `chr_…` + comprobación de importe y
  moneda PEN, ya implementados y auditados); reembolsos y reembolso compensatorio probados en local (suite 81).
  Staging sigue en sandbox.
* **Dominio/HTTPS**: ACM en sa-east-1 (ALB) y us-east-1 (CloudFront), validación DNS, listener 443 con política TLS
  moderna, 80 → 301, HSTS (Helmet ya lo emite detrás de HTTPS), CORS con el origen exacto del frontend (nunca `*`).

## 13. Aplicación

Backend: Node 24, systemd con `EnvironmentFile` en `/run` (0600) generado desde SSM, `NODE_ENV=production` (la guarda
de producción exige secretos fuertes y `FRONTEND_URL` https), `/health` y `/ready` con `no-store`, registros saneados,
cierre ordenado. Frontend: build con `VITE_API_URL=https://<dominio-api>/api`, sin `localhost`, sin secretos, S3
privado + CloudFront OAC. Cabeceras (Helmet, CORS, CORP, HSTS) cubiertas por las suites 74 y 29.

## 14. Despliegue y vuelta atrás

Estrategia inicial: **sustitución controlada** en la instancia única (`deploy-release.sh`: descarga verificada por
SHA-256, cambio atómico de enlace, espera de `/ready` y **vuelta atrás automática** a la versión anterior). Nunca
código que necesite un esquema aún no aplicado (migración primero, compatible con la versión anterior).

| Qué | Vuelta atrás |
| --- | --- |
| Aplicación | enlace a la versión anterior (automático si `/ready` falla) |
| Frontend | versión anterior del bucket (versionado) + invalidación de CloudFront |
| Base de datos | snapshot previo a la migración → restaurar a instancia nueva y repuntar |
| Migración 019 tras cifrar | **no** basta con volver a la versión anterior: runbook §5.1 (`--revertir` y vaciar columnas nuevas) o corregir hacia delante |
| Secretos | versión anterior del parámetro (historial) |
| KMS | nunca borrar; deshabilitar solo con plan; cancelar borrado programado |
| Cifrado | la clave anterior como `…_PREVIOUS` |
| Infraestructura | change set revisado antes de ejecutar; política de pila niega reemplazar la base |

## 15. Coste

Cost Explorer no es accesible con el rol de despliegue: **sin estimación mensual verificada**. Componentes con
coste: EC2 t4g, RDS db.t4g + almacenamiento y backups por encima del tamaño de la base, ALB (horas + LCU), EBS gp3 y
snapshots, S3, CloudFront (transferencia), CloudWatch (registros, alarmas, métricas personalizadas), CloudTrail (solo
S3 para el primer trail), KMS (2 CMK ≈ 1 USD/mes cada una + peticiones), Route 53 (zona + consultas). Sin NAT Gateway
(la EC2 sale por su IP pública; ya así en staging). Estimación a hacer con la calculadora de AWS o Cost Explorer por
el propietario.

## 16. Gates de producción

| Gate | Estado | Qué falta |
| --- | --- | --- |
| 1 · IAM | **PASS** | 75/75 sobre documentos y sobre roles reales; `validate-policy` 0; Access Analyzer 0 hallazgos (§18.3). Identity Center: requiere AWS Organizations (USER ACTION, no autorizado) |
| 2 · Secretos | **PASS (línea base)** | custodia aprobada (§4); 3 CMK creadas y verificadas (§18.3); los secretos de producción se crean con la app (F18-09) |
| 3 · Base de datos | **DISEÑO LISTO** | se valida al crearla (privada, cifrada, backups, PITR, DeletionProtection) |
| 4 · Monitorización | **PASS con hallazgo** | CloudTrail y 11 alertas creados y verificados (§18.3); suscripción SNS pendiente de autorización; alarmas de aplicación y backup: diseño (§6) para la pila de producción |
| 5 · Red | **PENDIENTE** | HTTPS depende del dominio |
| 6 · Aplicación | **PASS (staging)** | build, salud, readiness, sin secretos; falta el build con el dominio real |
| 7 · Pagos | **PENDIENTE** | llaves y webhook de producción de Culqi (decisión del propietario) |
| 8 · Correo | **PENDIENTE** | dominio de envío y clave de Resend de producción |
| 9 · Almacenamiento | **DISEÑO LISTO** | EBS persistente + DLM; recuperación de un snapshot de `/data` sin probar |
| 10 · DR | **PASS (staging)** | RPO definido; **RTO de aplicación medido: 615 s**; restauración probada con esquema e integridad; runbook |

## 17. Línea base de seguridad: verificación previa por recurso (antes de crear)

Pila `busperu-security-baseline`, sa-east-1, la aplica la identidad administradora (autorizado), por change set revisado
(solo altas de estos tipos; cualquier otra cosa lo descarta sin ejecutar). No crea VPC, EC2, ALB, RDS, CloudFront ni DNS.

| Recurso | Nombre | Dependencia | Coste aproximado | Política | Rollback | Impacto |
| --- | --- | --- | --- | --- | --- | --- |
| 3 CMK + alias | `alias/busperu-prod-{secrets,data,rds}` | roles (principales de la política) | ~1 USD/mes cada una + peticiones | sin raíz; administrador sin uso; app/operador/emergencia vía SSM; RDS vía RDS | `Retain`: no se borran con la pila (solo el administrador, 30 días) | ninguno sobre staging |
| 10 políticas gestionadas | `/busperu/BusPeruProd*` | — | 0 | documentos de `infra/aws/iam/prod/` | se borran con la pila | ninguno |
| 6 roles | C (ejecución, operador), B, emergencia, runtime, CloudTrail→Logs | políticas | 0 | confianzas con MFA (humanos) o de servicio con `aws:SourceAccount` | se borran con la pila | ninguno; nadie los asume hasta F18-09 |
| Bucket de auditoría | `busperu-prod-cloudtrail-<cuenta>` | — | céntimos/mes (S3) | privado, TLS, sin borrado salvo emergencia | `Retain` | ninguno |
| Trail | `busperu-prod-trail` (multirregión) | bucket y su política, grupo de logs | primer trail de gestión sin coste por eventos | integridad, globales, lectura+escritura | se borra con la pila | registra también staging (deseable) |
| Grupo de logs | `/busperu/security/cloudtrail` (90 días) | — | ingesta de CloudWatch Logs (bajo volumen) | — | `Retain` | ninguno |
| 11 filtros + 11 alarmas | `busperu-prod-security-*` | grupo de logs, tema | 0,10 USD/alarma/mes | → `busperu-prod-security` | se borran con la pila | alertan de cambios también en staging |
| 2 temas SNS | `busperu-prod-security`, `busperu-prod-alarms` | — | 0 sin suscripciones | por defecto de la cuenta | se borran con la pila | ninguno |
| Access Analyzer | `busperu-account-external-access` | — | 0 (acceso externo) | — | se borra con la pila | ninguno |

## 18. Resultados de F18-08 (2026-09-24)

### 18.1 Decisiones aprobadas por el propietario

Parameter Store SecureString + KMS dedicado + copia de recuperación fuera de línea · modelo C + B + emergencia ·
Identity Center ahora (sin borrar la clave) · dominio `busperuonline.pe` (`api.` para la API, `www` → principal) ·
remitente `soporte@busperuonline.pe` (sin clave de Resend) · Culqi LIVE no autorizado · RDS de producción con 14 días de
backups/PITR · registros 90 días · simulacro de RTO en staging · identidad administradora solo lectura · línea base de
seguridad (CloudTrail, KMS, roles, alertas, SNS). No autorizado: despliegue de producción, RDS/EC2/ALB/CloudFront de
producción, DNS, Culqi LIVE, Resend real, rotación de claves, borrar la clave de acceso.

**Custodia de la copia fuera de línea:** la guarda el **propietario** (gestor de contraseñas con MFA o sobre sellado en
lugar seguro); se genera junto con la clave de datos de producción en F18-09 (aún no existe); se recupera leyéndola con
el rol de emergencia (MFA, alerta `break-glass-usage`) o desde la copia si la CMK se perdiera; se rota con el runbook
§5.2 y cada rotación actualiza la copia. El material de las CMK no es exportable (queda en KMS, que conserva las claves
con `Retain` y espera de borrado de 30 días).

### 18.2 IAM de producción — validación con la identidad administradora (solo lectura)

* Inventario: 0 roles, 0 alias KMS propios, 0 trails, 0 certificados ACM, 0 zonas Route 53 antes de empezar (sin
  duplicados); ningún rol con AdministratorAccess; pila de staging **IN_SYNC** (deriva).
* Simulador (`simulate-custom-policy`, 50 casos: operador, ejecución, recuperación, emergencia, runtime): **49/50**.
  Access Analyzer `validate-policy` (18 documentos): **2 ERROR**. `check-no-public-access` (3 CMK + bucket de
  auditoría): **PASS**. La validación **detuvo la creación**, como estaba previsto. Defectos corregidos en el código:
  1. **OP14**: la barrera heredada `Deny iam:*` sobre `role/busperu/*` impedía al operador pasar el rol de ejecución
     (que vive ahí). Ahora la barrera del operador excluye `iam:PassRole` y una barrera nueva
     (`SoloPasaElRolDeEjecucion`) niega `PassRole` sobre cualquier rol que no sea el de ejecución.
  2. **`UNSUPPORTED_ACTION_FOR_CONDITION_KEY`**: `kms:DescribeKey` con condición de contexto de cifrado en las políticas
     de las claves de secretos y de datos; `DescribeKey` pasa a una declaración propia.
* **Pendiente**: repetir simulador y Access Analyzer sobre los documentos corregidos (esperado 0 permisos inesperados)
  antes de crear nada.

### 18.3 Línea base de seguridad — CREADA Y VERIFICADA (2026-09-24)

**Primer intento (16:22Z) — fallido y limpiado.** CloudFormation creaba las CMK con la clave de acceso **sin MFA**, y
la política de las claves solo permite administrarlas **con MFA**: el control anti-bloqueo de KMS («la nueva política no
le permitirá actualizarla») rechazó las 3 claves y la pila hizo rollback. No se debilitó la política. Limpieza
autorizada y verificada recurso a recurso (vínculo inequívoco por los eventos `DELETE_SKIPPED` de la pila fallida):
registro de la pila borrado; grupo de logs vacío (0 bytes) borrado; bucket con 2 marcadores de 0 bytes de CloudTrail
borrado (autorización expresa); **ninguna clave KMS llegó a existir** (0 claves de cliente).

**Reintento (17:18Z) con sesión de administrador con MFA** (el propietario la obtuvo en su terminal con su código; la
clave de acceso se desactivó al terminar):

| Comprobación | Resultado |
| --- | --- |
| Antes de crear: simulador (documentos) | **75/75**, 0 permisos inesperados |
| Antes de crear: `validate-policy` (18 documentos) | **0 hallazgos** |
| Antes de crear: `check-no-public-access` (3 CMK, bucket) | **PASS** |
| `check-baseline.mjs` / change set | PASS / 51 altas, solo tipos autorizados, sa-east-1 |
| Pila | **CREATE_COMPLETE** en 90 s; 51 recursos = plantilla por tipo |
| CMK `secrets`, `data`, `rds` | Enabled · rotación activada · `Retain` · espera de borrado 30 días · políticas desplegadas = documentos generados (MFA en la administración, administrador sin Encrypt/Decrypt, sin raíz ni `*`) |
| Uso humano de las CMK (administrador con MFA) | `Encrypt` y `GenerateDataKey` **denegados** en las 3 |
| CloudTrail `busperu-prod-trail` | registrando · multirregión · eventos globales · validación de integridad · entrega a S3 (23 objetos en los primeros minutos) y a CloudWatch Logs sin errores |
| Bucket de auditoría | bloqueo público · SSE AES256 · versionado · TLS obligatorio · borrado denegado salvo emergencia |
| Registros `/busperu/security/cloudtrail` | 90 días |
| Alertas | 11 filtros = 11 alarmas (mismas métricas), todas OK → `busperu-prod-security` |
| SNS | `busperu-prod-security` y `busperu-prod-alarms` **sin suscripciones** (no autorizadas) |
| Simulador sobre los roles REALES | **75/75** |
| Access Analyzer de la cuenta | **PASS** tras la corrección A (ver abajo): 0 hallazgos; las 3 CMK analizadas sin error, no públicas, no compartidas |

**Access Analyzer — corregido (autorizado, 2026-09-24 17:34Z).** Los 3 hallazgos iniciales no eran accesos externos
(`error: ACCESS_DENIED`, sin principal ni acción): el analizador no podía **leer** las políticas porque, por diseño, no
delegan en la raíz de la cuenta. Corrección A: a cada política se añadió **una** declaración `AccessAnalyzerSoloLee` que
permite **solo** al rol vinculado `AWSServiceRoleForAccessAnalyzer` `kms:DescribeKey`, `kms:GetKeyPolicy`,
`kms:ListKeyPolicies` y `kms:ListGrants` (sin condiciones, sin ningún permiso criptográfico). Comprobado antes de aplicar
(diferencia exacta de 1 declaración por clave, 0 quitadas, MFA de administración intacta, `validate-policy` 0,
`check-no-public-access` PASS) y aplicado por change set de actualización con sesión MFA: **3 `Modify` de
`AWS::KMS::Key`, solo `KeyPolicy`, sin reemplazo**; pila `UPDATE_COMPLETE` en 71 s. Después: Access Analyzer **0
hallazgos**; políticas desplegadas = generadas; las 3 CMK Enabled, con rotación y las mismas claves; uso humano
(`Encrypt`, `GenerateDataKey`) **denegado** (`AccessDeniedException`); regresión: simulador 75/75 sobre documentos y
75/75 sobre roles reales, `validate-policy` 0 en los 18 documentos. `check-iam-prod.mjs` exige ahora esa declaración
exacta (mutantes de añadir `Decrypt` o un principal humano detectados).

Nota de la herramienta: la primera comprobación posterior marcó por error `generate-data-key: ALLOW` porque el script
recortaba el mensaje de error y perdía el código `AccessDeniedException`; repetida mostrando el código, las 6 pruebas
dan `AccessDeniedException`.

Rol nuevo en la cuenta: `AWSServiceRoleForAccessAnalyzer` (vinculado a servicio, gestionado por AWS, esperado).

### 18.4 Simulacro de RTO en staging (rol de despliegue con MFA, sin clave de acceso)

| Paso | Resultado |
| --- | --- |
| Estado de partida | staging sano; `DB_HOST` = original |
| T0 → T1 | PITR (`--use-latest-restorable-time`) a `busperu-staging-dr-f1808`, privada, cifrada, retención 0, etiquetada `Temporary` |
| T2 | disponible a los 588 s |
| Esquema e integridad | huella = referencia; 49 tablas; 81 FK sin huérfanos; sin PK/únicos duplicados; NOT NULL correctos |
| T3 / T4 | `DB_HOST` → restaurada, reinicio, `/ready` local y por el ALB = 200 |
| T5 | humo: health, ready, login, me, empresas, viaje, asientos, cuenta bancaria (enmascarado/lectura ADMIN), logout |
| Evidencia | `audit_logs` 177 → 179 en la restaurada; la original sin cambios (177) |
| **RTO** | **615 s (10,3 min)** |
| Vuelta atrás | `DB_HOST` → original, reinicio, `/ready` 200, humo OK |
| Limpieza | instancia temporal borrada tras comprobar nombre, etiquetas y que la app ya no la usa; herramienta de S3 retirada |
| Original | available, mismo endpoint, DeletionProtection, 7 días |

**RPO:** la restauración llegó a `LatestRestorableTime` (≈ 4 min antes de T0); la última escritura de la original era
anterior (staging sin actividad), así que tablas, recuentos y CHECKSUM coinciden. **No actual data-loss window was
measured.** Las 2 filas de auditoría escritas en la restaurada durante el simulacro se descartaron con ella (sintéticas).
La alerta `rds-deletion` de la línea base habría saltado con el borrado de la temporal (la línea base no existe aún).

### 18.5 Identity Center — USER ACTION REQUIRED

La cuenta **no pertenece a AWS Organizations** y no hay instancia de Identity Center. Los conjuntos de permisos que
dan acceso a la cuenta exigen una instancia de organización, así que configurar Identity Center requiere crear AWS
Organizations (esta cuenta pasaría a ser la de gestión, sin cuentas miembro). No está autorizado: no se creó. Después,
el propietario tendría que registrar su dispositivo MFA en Identity Center y probar el acceso. La clave de acceso sigue
existiendo, Inactive.

### 18.6 Dominio, correo y pagos

* **`busperuonline.pe`**: DNS público **NXDOMAIN** (no delegado; probablemente sin registrar). Route 53 Domains no
  admite `.pe` (`UnsupportedTLD`): el registro sería en un registrador `.pe` (NIC.pe o agente). **DOMAIN CONTROL / DNS:
  USER ACTION REQUIRED**. Plan de registros (cuando exista el dominio y una zona hospedada):

  | Registro | Tipo | Destino |
  | --- | --- | --- |
  | `busperuonline.pe` | A/AAAA alias | CloudFront (frontend) |
  | `www.busperuonline.pe` | CNAME o alias | redirección 301 a `busperuonline.pe` (función de CloudFront) |
  | `api.busperuonline.pe` | A alias | ALB de producción (listener 443) |
  | `_…acm-validations…` | CNAME | validación DNS de ACM (us-east-1 para CloudFront, sa-east-1 para el ALB) |
  | `busperuonline.pe` | TXT | SPF `v=spf1 include:<el de Resend> ~all` |
  | `resend._domainkey…` | TXT/CNAME | DKIM que entregue Resend al verificar el dominio |
  | `_dmarc.busperuonline.pe` | TXT | `v=DMARC1; p=quarantine; rua=mailto:<buzón del propietario>` |
  | `send.busperuonline.pe` | MX/TXT | los de retorno que indique Resend |

  CORS: `FRONTEND_URL=https://busperuonline.pe` (origen exacto, sin `*`); HSTS por Helmet detrás de HTTPS; 80 → 301.
* **Frontend de producción (build local)**: `VITE_API_URL=https://api.busperuonline.pe/api` → build correcto; en el
  bundle 0 `localhost`, 0 dominio de staging, 0 claves de Culqi/Resend, 0 JWT, 0 secretos de BD, 0 claves privadas,
  sin source maps. No publicado.
* **Resend**: remitente `soporte@busperuonline.pe`; `app/RESEND_API_KEY` (SSM + CMK de secretos) **sin cargar**;
  registros de la tabla anterior; monitorización por filtro de registros (§6). **USER ACTION REQUIRED**: cuenta y
  dominio en Resend y la clave.
* **Culqi**: `app/CULQI_PUBLIC_KEY` (la sirve la API al navegador en tiempo de ejecución; no va en el build) y
  `app/CULQI_PRIVATE_KEY`, `app/CULQI_WEBHOOK_SECRET` en SSM + CMK de secretos, **sin cargar**; webhook
  `https://api.busperuonline.pe/api/culqi/webhook/<segmento secreto>`; Culqi no firma: segmento secreto + re-consulta del
  cargo + idempotencia por identificador del cargo + importe y moneda PEN (suites 31, 54, 70); reembolsos y reembolso
  compensatorio (55, 81). Staging sigue en sandbox. **USER ACTION REQUIRED**: claves LIVE.

### 18.7 Recursos

* **Creados en producción:** ninguno.
* **Creados temporalmente (staging) y retirados:** `busperu-staging-dr-f1808` (RDS), `qa/f1808/dr-db.cjs` (S3).
* **Cambios en staging:** `DB_HOST` pasó a la restaurada y volvió a la original (el historial del parámetro guarda ambas
  versiones); 2 reinicios del servicio.
* **Creados en la cuenta (línea base de seguridad autorizada, pila `busperu-security-baseline`):** 51 recursos
  (3 CMK con alias, 10 políticas y 6 roles de producción, trail, bucket de auditoría y su política, grupo de logs, 11
  filtros y 11 alarmas, 2 temas SNS, Access Analyzer) + el rol vinculado `AWSServiceRoleForAccessAnalyzer` (AWS).
* **Modificados después:** solo las políticas de las 3 CMK (lectura de Access Analyzer, §18.3).
* **Creados y retirados en el primer intento fallido:** registro de pila, grupo de logs vacío, bucket con 2 marcadores
  de 0 bytes (borrados con autorización; ninguna CMK llegó a existir).
* **No creados:** AWS Organizations/Identity Center, suscripciones SNS de producción, todo lo de aplicación de
  producción (VPC, EC2, RDS, ALB, CloudFront, S3 de frontend), DNS, certificados.

### 18.8 Estado al cierre

Ver §19.

## 19. Cierre de F18-08 (aceptado por el propietario el 2026-09-24)

### 19.1 Cerrado

| Área | Resultado |
| --- | --- |
| Modelo IAM C + B + emergencia + runtime | como código (`infra/aws/iam/prod/`), aprobado; simulador **75/75** sobre documentos y **75/75** sobre roles reales; `validate-policy` **0** en 18 documentos; 0 permisos inesperados |
| Línea base de seguridad | `busperu-security-baseline` **CREATE_COMPLETE** (después `UPDATE_COMPLETE`); **51** recursos = plantilla por tipo; solo tipos autorizados |
| KMS | 3 CMK (`secrets`, `data`, `rds`): Enabled, rotación, `Retain`, 30 días de espera; administración solo con MFA; sin raíz ni `*`; uso criptográfico humano **denegado**; políticas desplegadas = generadas |
| Access Analyzer | **0 hallazgos**; `check-no-public-access` **PASS** (3 CMK y bucket de auditoría) |
| CloudTrail | multirregión, eventos globales, lectura y escritura, validación de integridad; S3 privado (TLS, SSE, versionado, sin borrado) y CloudWatch Logs 90 días; entregando sin errores |
| Alertas de seguridad | 11 filtros = 11 alarmas, OK, hacia `busperu-prod-security` |
| Custodia de secretos | aprobada: Parameter Store SecureString + CMK dedicadas + copia fuera de línea custodiada por el propietario (§4, §18.1) |
| RDS de producción (diseño) | MariaDB 10.11, privada, CMK propia, 14 días de backups/PITR, DeletionProtection, snapshot antes de migrar (§7) |
| DR | **RTO de aplicación medido en staging: 615 s** (T0→T5), esquema e integridad verificados, vuelta atrás y limpieza correctas; RPO definido («No actual data-loss window was measured») |
| Almacenamiento, límite de peticiones, planificador | EBS persistente + DLM; «Initial production uses one API instance.» «Horizontal scaling requires shared rate-limit storage.» «Scheduler is single-instance.» |
| Aplicación | sin cambios de código; backend 10.4 **2133/2133**, 10.11 **2133/2133**, frontend **13/13**, seguridad **944/944**; build de producción con `https://api.busperuonline.pe/api` limpio (sin localhost ni secretos) |
| Seguridad de la fase | 0 secretos expuestos; 0 HIGH/CRITICAL; sin commit ni push; clave de acceso **Inactive** |

### 19.2 Pendiente (no bloquea el cierre de F18-08)

* Suscripción de los temas SNS de producción (requiere correo autorizado).
* Alarmas de aplicación y de backup (§6): se crean con la pila de producción.
* Prueba real de `Decrypt` del runtime (el simulador lo da ALLOW; la prueba efectiva requiere la EC2 de producción).
* Cost Explorer no habilitado en la cuenta: sin estimación de coste mensual verificada.
* Deuda técnica: react-router 7 (avisos moderados ya mitigados); S3 para subidas antes de escalar a varias instancias.

### 19.3 Bloqueantes para producción (READY FOR PRODUCTION DEPLOYMENT)

1. Dominio `busperuonline.pe` registrado y bajo control (hoy NXDOMAIN; `.pe` no se registra en Route 53) y
   certificados ACM (us-east-1 para CloudFront, sa-east-1 para el ALB).
2. Resend: dominio de envío verificado (SPF, DKIM, DMARC) y clave de producción.
3. Culqi LIVE: llaves de producción y webhook.
4. Suscripción confirmada de `busperu-prod-security` y `busperu-prod-alarms`.
5. Decisión sobre IAM Identity Center (requiere AWS Organizations) o aceptar el flujo actual con MFA.
6. Autorización explícita de F18-09 («Autorizo el deployment de producción.»).

### 19.4 USER ACTION REQUIRED (intervención del propietario)

| # | Acción | Estado |
| --- | --- | --- |
| 1 | Registrar `busperuonline.pe` en un registrador `.pe`, delegar el DNS y autorizar la emisión de certificados | pendiente |
| 2 | Resend: cuenta, dominio de envío `soporte@busperuonline.pe` y carga de la clave (sin compartirla) | pendiente |
| 3 | Culqi LIVE: decidir cuándo cargar las llaves de producción | pendiente |
| 4 | Autorizar el correo de suscripción de los temas SNS de producción y confirmar el enlace | pendiente |
| 5 | Decidir IAM Identity Center / AWS Organizations | pendiente |
| 6 | Autorizar el borrado definitivo de la clave de acceso (después de Identity Center o del flujo alternativo aceptado) | pendiente |
| — | Opcional: borrar de su equipo el perfil temporal `busperu-admin-mfa` (caducado) | recomendado |

**Estado para producción: NOT READY.**

NO PRODUCTION DEPLOYMENT WAS PERFORMED.
