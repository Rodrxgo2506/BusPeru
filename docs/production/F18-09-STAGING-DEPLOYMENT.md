# F18-09 — Staging Deployment

> BusPerú en AWS **staging** (sa-east-1), sin dominio, accesible mediante URLs temporales de CloudFront. La cuenta se
> muestra como `6578****68`. Este informe no contiene secretos, contraseñas, claves de acceso, tokens ni JWT.

## 1. Objetivo

Dejar BusPerú accesible para pruebas reales con URLs temporales de AWS, sin comprar ni configurar `busperuonline.pe`
y sin tocar producción. El criterio de éxito es el flujo real
**USUARIO → CLOUDFRONT → FRONTEND → (CLOUDFRONT) → ALB → EC2 → API → RDS**, no que los recursos estén `healthy`.

Arquitectura resultante (el porqué del tramo CloudFront delante de la API está en §10, H-2 y H-3):

```
Navegador ──HTTPS──► CloudFront «web» ──OAC/SigV4──► S3 privado (dist/)
    │
    └──HTTPS──► CloudFront «api» ──HTTP + cabecera de origen──► ALB :80 ──► EC2 :3000 (Node, systemd) ──► RDS MariaDB
                (solo IP de operador,                            (403 a todo lo que no traiga la cabecera
                 CloudFront Function)                             o no venga de una IP de operador)
```

## 2. Fecha/hora

| Hito | Momento (UTC, 2026-09-24) |
| --- | --- |
| Inventario del repositorio y de AWS (solo lectura) | 18:20–18:26Z |
| Plan de ejecución presentado | ~18:27Z |
| Builds y pruebas locales del backend y del frontend | 18:27–18:32Z |
| E2E y RBAC por el ALB (línea base) | 18:28–18:33Z; expiración comprobada a las 18:50Z |
| Prueba de reinicio del servicio | 18:33:56Z |
| Autorización del propietario | antes de las 19:32Z |
| Comprobador repetido; plantilla idéntica a la aprobada; preflight | 19:32–19:36Z |
| Pila `busperu-staging-web`: change set y creación | 19:37:15–19:42:34Z (CREATE_COMPLETE en 277 s) |
| Build del frontend, subida de `dist/` e invalidación | 19:43:36Z |
| `FRONTEND_URL` / `TRUST_PROXY` y reinicio | 19:43:57Z |
| Verificación de infraestructura, E2E por CloudFront y navegador | 19:44–19:54Z |
| Expiración por CloudFront (comprobación diferida) | 20:08:50Z — **PASS** |

## 3. Infraestructura utilizada

**Reutilizada sin modificarla:** la pila `busperu-staging` sigue en UPDATE_COMPLETE y su última actualización es del
2026-09-23 20:48Z.

| Pieza | Estado |
| --- | --- |
| VPC propia | Subredes públicas para el ALB y la EC2, privadas para RDS; sin NAT Gateway |
| ALB `busperu-staging-alb` | Oyente HTTP:80, que es la configuración aprobada de staging sin certificado; target `healthy` con `GET /api/ready` |
| EC2 `i-096d4caac0e479052` | t4g.small, AL2023 arm64, IMDSv2, SSM Online; sin puerto 22 |
| RDS `busperu-staging-db` | MariaDB 10.11.19, privada, cifrada, 7 días de backup, DeletionProtection; **no se reinició** |
| SG de la app / de la BD | 3000 solo desde el SG del ALB / 3306 solo desde el SG de la app (**sin cambios**) |
| Parameter Store `/busperu/staging/` | 18 parámetros (17 + el nuevo SecureString de §11) |
| CloudWatch / SNS / DLM | 23 alarmas en OK antes y después; `busperu-staging-alarms` con 1 suscripción confirmada; DLM ENABLED |

**Creada en F18-09:** la pila **`busperu-staging-web`**, CREATE_COMPLETE, con exactamente los 11 recursos validados.

| Recurso lógico | Tipo | Identificador / nota |
| --- | --- | --- |
| `FrontendBucket` | S3 Bucket | `busperu-staging-web-6578****68`. Privado, con Block Public Access completo, SSE-S3, versionado (las versiones antiguas caducan a los 30 días), `BucketOwnerEnforced` y `Retain`. |
| `FrontendBucketPolicy` | S3 BucketPolicy | `s3:GetObject` solo para `cloudfront.amazonaws.com` con `AWS:SourceArn` = la distribución web. Deniega todo acceso sin TLS. |
| `FrontendOac` | CloudFront OAC | `busperu-staging-web-oac`, SigV4, firma siempre |
| `ViewerAllowlist` | CloudFront Function | `busperu-staging-viewer-allowlist` (cloudfront-js-2.0). Solo <IP-operador-1> y <IP-operador-2>. |
| `ApiCachePolicy` | CloudFront CachePolicy | `busperu-staging-api-sin-cache`: TTL 0/0/1; `Authorization` y las query strings llegan al origen |
| `WebDistribution` | CloudFront Distribution | `E2A2KY5BGZ8ZZQ`. HTTP→HTTPS; fallback 403/404 → `/index.html` (200); política gestionada de cabeceras de seguridad. |
| `ApiDistribution` | CloudFront Distribution | `E1O34SN785WQBD`. Solo HTTPS; origen el ALB por HTTP con la cabecera de origen; sin páginas de error; todos los métodos. |
| `AlbFromCloudFront` | SG Ingress | SG del ALB: tcp/80 desde `pl-5da64334` (`com.amazonaws.global.cloudfront.origin-facing`) |
| `RuleFromApiDistribution` | ListenerRule 10 | Cabecera `X-BusPeru-Origin` = secreto → forward |
| `RuleFromOperators` | ListenerRule 20 | `source-ip` = las 2 IP de operador → forward |
| `RuleDenyEverythingElse` | ListenerRule 30 | `path-pattern *` → **403** fijo |

Código:
- `infra/aws/cloudformation/build-web-template.mjs` → `busperu-staging-web.json` (sha256 `7f201fbe4eef7a46…`, 16.198 bytes).
- `check-web-template.mjs`: PASS. Además rechazó las 3 mutaciones de prueba: fallback en la API, bucket con BPA incompleto y SG con `0.0.0.0/0`.

## 4. Backend

| Punto | Resultado |
| --- | --- |
| Versión de Node | **v24.15.0** (local y EC2) |
| Typecheck / build | `npm run typecheck`: 0 errores. `npm run build`: OK. |
| Tests | `npm test`: **2133/2133**, 0 fallidos, 0 fallos fuera de test (base `busperu_test`) |
| Release | `/opt/busperu/releases/2026-09-23-3`. Su `dist/` es **idéntico** al build local (0 `.js` distintos; lockfile y migraciones idénticos), así que no se redesplegó. |
| Servicio systemd | `busperu-api`, usuario **`busperu`** (no root). `/run/busperu/api.env` (0600) se genera desde Parameter Store en cada arranque. |
| Configuración cambiada | `FRONTEND_URL`: `https://staging.busperu.invalid` → `https://d25z2lpl1efut1.cloudfront.net`. `TRUST_PROXY`: `1` → `2` (CloudFront + ALB). |
| Endpoint | `https://d1lfpi7fp62ntk.cloudfront.net/api` (y el ALB directo, solo desde IP de operador) |
| Healthcheck | `/api/ready` → 200 `{"status":"ready"}`, `Cache-Control: no-store`, por CloudFront y por el ALB |
| Reinicio (solo el servicio) | Prueba dedicada: `/api/ready` en 200 a los **1,6 s**, 0 errores en el journal. El reinicio de configuración de las 19:43Z también dio `ready` 200. |

## 5. Frontend

| Punto | Resultado |
| --- | --- |
| Typecheck / lint / tests | 0 errores; `eslint --max-warnings 0` OK; **13/13** |
| Build | `npm run build` con `VITE_API_URL=https://d1lfpi7fp62ntk.cloudfront.net/api` (la guarda del build la aceptó). Se comprobó que el bundle contiene esa URL y **no** contiene `localhost`, `127.0.0.1`, `busperuonline` ni `staging.busperu.invalid`. |
| Bucket | `busperu-staging-web-6578****68`: **96 objetos**, exactamente los archivos de `dist/`. `assets/*` con `max-age=31536000, immutable`; el resto (incluido `index.html`) con `no-cache`. |
| CloudFront | `E2A2KY5BGZ8ZZQ` (web) y `E1O34SN785WQBD` (API), las dos `Deployed`. Invalidación `/*` `I81YEP8UIMU3X0I6S5NL4XTLSY` completada. |
| URL temporal | **https://d25z2lpl1efut1.cloudfront.net** (solo desde las IP de operador) |

## 6. Base de datos

| Punto | Resultado |
| --- | --- |
| RDS | `busperu-staging-db`: privada, cifrada, backups de 7 días, DeletionProtection. Sin reinicio. |
| MariaDB | 10.11.19; `sql_mode` estricto; `time_zone` UTC; `utf8mb4` |
| Migraciones | 001→019 aplicadas; coinciden con las del repositorio. **No falta ninguna** y no se ejecutó ninguna. |
| Estado | `schema-fingerprint.cjs` (solo lectura, vía SSM): **idéntico a la referencia**, con 49 tablas, 496 columnas, 221 índices, 81 FKs y 12 CHECKs, 0 colaciones distintas y JSON como texto (`jsonStrings`) |

## 7. Pruebas

Las pruebas se hicieron **por las URLs de CloudFront**, con el `Origin` de la web. Antes se hizo una línea base por el
ALB. Para ADMIN se usó el **administrador de staging existente**. Para el resto, `smoke-staging.mjs` (arnés de F18-03)
y el E2E de esta fase crearon usuarios **sintéticos**: COMPANY_ADMIN y OPERATOR de una empresa sintética, y un
CUSTOMER. Ninguno es ADMIN y no se tocó ningún rol ni permiso.

| Prueba | Resultado |
|---|---|
| Frontend | **PASS**. `/` sirve `index.html`. Las rutas profundas (`/login`, `/buscar?…`) funcionan por el fallback y un objeto inexistente también devuelve `index.html`. Hay HSTS, `nosniff` y `X-Frame-Options`. HTTP responde **301** a HTTPS. El bucket leído directamente da **403**. En el navegador: la portada, la búsqueda y el mapa de asientos cargan sin errores de consola, y todas las llamadas a la API van a `d1lfpi7fp62ntk.cloudfront.net/api` con 200. |
| API | **PASS**. `ready` 200 con no-store. Un 404 llega como 404 JSON, no como `index.html`, y un 401 como 401. CORS devuelve exactamente la `WebUrl`, nunca `*` ni un origen ajeno. El preflight con `Authorization` da 204. La API por HTTP recibe 403 (solo HTTPS). Rate limit activo; el webhook de Culqi rechaza un secreto inválido. |
| Login | **PASS** por API y CloudFront: ADMIN, COMPANY_ADMIN, OPERATOR y CUSTOMER. `/auth/me` devuelve el rol correcto y una contraseña incorrecta da 401. En el navegador se comprobó la **página** de login, pero **no** se escribieron credenciales: el asistente no introduce contraseñas y ese paso le corresponde al propietario. |
| RBAC | **PASS**:<br>• `/users/stats`: ADMIN 200; COMPANY_ADMIN, OPERATOR y CUSTOMER 403.<br>• Ajustes de plataforma: 403 para los 3 roles no ADMIN (el valor no cambió).<br>• Aprobar pago: OPERATOR 403, CUSTOMER 403, COMPANY_ADMIN 200.<br>• Crear un usuario ADMIN: 403 para los 3 roles.<br>• El cliente solo se ve a sí mismo en `/users`. |
| Búsqueda | **PASS**: búsqueda pública de ida, itinerario ida y vuelta, y búsqueda en la interfaz (`/buscar`: 1 viaje, S/ 60.00, 3 asientos libres, coherente con las reservas creadas) |
| Reserva | **PASS**: reserva simple PENDING con `expires_at`; cancelación; itinerario ida y vuelta en una transacción (2 tramos); «Mis viajes» con 4 reservas propias y ninguna ajena. **Expiración:** por el ALB, la reserva 10 pasó sola a EXPIRED y liberó el asiento; por CloudFront, la reserva 15 (vencía a las 20:07:08Z) pasó sola a **EXPIRED** a las 20:08:50Z y el asiento 37 quedó libre. |
| Asientos | **PASS**: el mapa público no expone datos internos, la reserva PENDING retiene el asiento (`is_taken=1`) y en la interfaz se ven 01–03 ocupados, 04–06 libres y el asiento 04 seleccionable con su resumen de precio |
| Pago sandbox | **NOT TESTED**: staging no tiene claves de prueba reales de Culqi y no se usó Culqi LIVE. *(Corrección posterior: la integración de plataforma estaba «conectada» con claves **ficticias** que dejaba `smoke-staging.mjs`; se eliminó el 2026-09-24, ver `F18-09-QA-DATA-INVENTORY.md`.)* Sustituto sin pasarela: **pago manual YAPE → PENDING (202) → aprobado por COMPANY_ADMIN → reserva CONFIRMED** (**PASS**). |
| Notificaciones | **PASS en la aplicación** (5 en la bandeja del cliente). **Correo: NOT TESTED**: requiere configuración externa (`MAIL_TRANSPORT=smtp` hacia `smtp.staging.busperu.invalid`; Resend no está configurado ni autorizado). |
| Logout | **PASS**: logout 200 → el token revocado da 401 → nuevo login 200 |
| Reinicio del servicio | **PASS** (§4) |
| Monitorización | **PASS**: 23 alarmas en OK después de los cambios, target `healthy` |

Seguridad de la ruta, verificada:

| Comprobación | Resultado |
| --- | --- |
| CloudFront Function (`test-function` sobre la etapa LIVE) | IP ajena 203.0.113.50 → **403**; <IP-operador-1> y <IP-operador-2> → pasan |
| Oyente del ALB | 10 cabecera → forward · 20 IP de operador → forward · 30 `*` → 403 fijo · default (inalcanzable) |
| SG del ALB | solo tcp/80: 2 IP /32 + la prefix list de CloudFront; sin `0.0.0.0/0` |
| `X-Forwarded-For` falsificada por CloudFront | se ignora: comparte contador del rate limit con las peticiones normales, así que la clave es la IP real del cliente |
| Bucket | `IsPublic=False`, BPA completo, lectura directa 403 |

Resultados brutos:

| Ejecución | Por el ALB (línea base) | Por CloudFront |
| --- | --- | --- |
| `smoke-staging.mjs` | 32/32 | **32/32** |
| E2E complementario | 15/16. El fallo era del arnés, que leía `status` en lugar de `is_taken`; ya está corregido (H-7). | **16/16** |
| Verificación de infraestructura (`web.py verificar`) | — | **16/16** |
| Expiración diferida | 1/1 | **1/1** |

## 8. URLs temporales

| Uso | URL |
| --- | --- |
| **Frontend** | https://d25z2lpl1efut1.cloudfront.net |
| **API** (la que usa el frontend) | https://d1lfpi7fp62ntk.cloudfront.net/api |
| ALB directo (operación; HTTP; solo IP de operador) | http://busperu-staging-alb-1863481353.sa-east-1.elb.amazonaws.com/api |

Las tres responden **solo a <IP-operador-1> y <IP-operador-2>**. Cualquier otra IP recibe 403.

## 9. Seguridad

- **Producción NO tocada.** La línea base de seguridad de F18-08 no se modificó: `busperu-security-baseline` conserva su última actualización de las 17:34Z (F18-08). Tampoco se tocaron las CMK, CloudTrail, las alarmas de seguridad ni los roles `BusPeruProd*`.
- **Dominio NO configurado.** Ni `busperuonline.pe`, ni DNS, ni ACM. Se usan los nombres y el certificado por defecto de `*.cloudfront.net`.
- **Culqi LIVE NO utilizado.** Staging no tiene claves reales de Culqi (la integración ficticia del smoke se eliminó después; ver `F18-09-QA-DATA-INVENTORY.md`).
- **Resend NO utilizado.**
- **Secretos NO expuestos.**
  - El valor de la cabecera de origen se generó localmente (32 bytes aleatorios), se guardó como SecureString y se pasó a CloudFormation como parámetro `NoEcho` mediante un archivo temporal, borrado al terminar. Nunca se imprimió.
  - La contraseña del ADMIN de staging se leyó a un archivo temporal 0600 fuera del repositorio, que se borró.
  - Ningún token, JWT ni clave aparece en registros ni en este informe.
- **Sin cambios de IAM**: ni roles, ni políticas, ni permisos nuevos. La única operación de IAM fue desactivar de nuevo la access key al terminar (§11).
- **Clave de acceso de larga duración:** el propietario la reactivó temporalmente para abrir la sesión MFA de administrador. Se **desactivó de nuevo** al terminar (20:09:11Z; estado verificado: `Inactive`). Ni su identificador ni el secreto aparecen en los registros..
- **Red:** EC2 y RDS siguen sin exposición a Internet y no hay SSH. El ALB no es público: solo acepta CloudFront **con** la cabecera de origen y las 2 IP de operador; todo lo demás recibe 403.
- **KMS, CloudTrail y SNS sin cambios.**
- **Sin commit ni push.**

## 10. Problemas encontrados

| Id | Clase | Hallazgo | Tratamiento / estado |
| --- | --- | --- | --- |
| H-1 | Permisos | El rol de despliegue de staging no tiene permisos `cloudfront:*` y solo crea buckets `busperu-staging-artifacts-*`. | **Resuelto sin cambiar IAM**: la pila la creó la identidad administradora con MFA, con autorización expresa. Pendiente (decisión): §13. |
| H-2 | Arquitectura | Sin dominio no hay certificado para el ALB: un SPA en HTTPS no puede llamar a un ALB HTTP (contenido mixto) y la guarda del build rechaza un `VITE_API_URL` con `http`. | **Resuelto**: la API se sirve por su propia distribución CloudFront (HTTPS). |
| H-3 | Arquitectura | El fallback 403/404 → `index.html` afecta a toda la distribución: la API no puede compartirla. | **Resuelto** con dos distribuciones. Verificado: un 404 de la API llega como 404 JSON. |
| H-4 | Red | Abrir el SG del ALB a CloudFront permitiría llegar desde cualquier distribución ajena. | **Resuelto**: cabecera secreta de origen, IP de operador y 403 para el resto. |
| H-5 | Configuración | `FRONTEND_URL` y `TRUST_PROXY` no correspondían a la nueva ruta. | **Resuelto**: la `WebUrl` y `2`; la IP real del cliente llega a la API (§7). |
| H-6 | Integraciones | Culqi sin claves de prueba reales en staging (solo tenía las ficticias del smoke, ya eliminadas); el correo apunta a un SMTP `.invalid`. | **Abierto (externo)**: pago sandbox y correo NOT TESTED. Requieren claves de prueba de Culqi y la configuración o autorización de Resend. |
| H-7 | Arnés (A) | La primera versión del E2E miraba `status` (estado físico) y no `is_taken`. | Corregido. No es un defecto de la aplicación. |
| H-8 | LOW | La cabecera de origen es un secreto compartido, visible para quien lea la configuración de CloudFront o las reglas del ALB. El tramo CloudFront → ALB va por HTTP. | Aceptado para staging con datos sintéticos. En producción: ALB con HTTPS y ACM, y dominio (F18-08). |
| H-9 | LOW | Con `TRUST_PROXY=2`, una petición **directa al ALB** con `X-Forwarded-For` falsificada cambia la IP que ve la API (verificado: estrena contador del rate limit). Solo es posible desde las 2 IP de operador, las únicas que llegan al ALB directamente. Por CloudFront no ocurre. | Aceptado para staging. Para operar, usar la URL de CloudFront. Alternativa futura: quitar la regla 20 cuando no haga falta el acceso directo. |
| H-10 | Observación | La salida a Internet del operador alterna entre <IP-operador-1> y <IP-operador-2> (distintos servicios de eco ven IP distintas). Por eso hay 2 IP en la lista y, en una misma ventana, el rate limit puede contar por separado. | Informativo. Si el proveedor cambia esas IP, hay que actualizar a la vez el SG y los parámetros `OperatorCidrs`/`ViewerAllowedIps` de la pila. |
| H-11 | Operación | El CLI intentó renovar en silencio el perfil `busperu-mfa` (rol de despliegue) y se quedó esperando el código MFA. | Se detuvo esa tarea y se continuó solo con la sesión de administrador. Ninguna operación quedó a medias. |
| H-12 | Deriva esperada | La entrada del SG del ALB y las reglas del oyente pertenecen a `busperu-staging-web`, no a `busperu-staging`. Una detección de deriva de la pila principal puede señalarlo. | Esperado y documentado. Al borrar la pila web desaparecen. |

## 11. Cambios realizados

**AWS (staging, sa-east-1), en este orden:**
1. Parameter Store: **nuevo** `/busperu/staging/ops/CLOUDFRONT_ORIGIN_SECRET` (SecureString, `alias/aws/ssm`).
2. CloudFormation: **nueva** pila `busperu-staging-web`, con change set `f1809-creacion` de **11 altas y 0 modificaciones o bajas** (recursos en §3). Etiquetas: `Project=busperu`, `Environment=staging`, `Stack=staging-web`. Como efecto sobre recursos existentes, **solo añade**: una entrada al SG del ALB y 3 reglas al oyente HTTP:80. La pila principal no se modificó.
3. S3: 96 objetos de `frontend/dist/` subidos a `busperu-staging-web-6578****68`.
4. CloudFront: invalidación `/*` en la distribución web.
5. Parameter Store: `/busperu/staging/app/FRONTEND_URL` (`https://staging.busperu.invalid` → `https://d25z2lpl1efut1.cloudfront.net`) y `/busperu/staging/app/TRUST_PROXY` (`1` → `2`).
6. EC2: dos reinicios de `busperu-api` por SSM, uno de prueba y otro para aplicar la configuración. Además, una lectura de la huella del esquema.
7. Datos sintéticos por la API (dominio `@busperu-staging.example`, nombres `Humo`/`E2E`):
   - Por el ALB: empresas 8 y 9 y usuarios 22, 25, 26 y 27.
   - Por CloudFront: empresas 10 y 11 y usuarios 28, 31, 32 y 33, con sus buses, viajes, reservas, un itinerario por ejecución y un pago manual aprobado.
8. IAM: única operación: `UpdateAccessKey` → **Inactive** sobre la clave del administrador, para devolverla al estado anterior a la fase (20:09:11Z). Sin cambios de roles ni de políticas.

**Repositorio (sin commit):**
- `infra/aws/cloudformation/build-web-template.mjs` (nuevo)
- `infra/aws/cloudformation/check-web-template.mjs` (nuevo)
- `infra/aws/cloudformation/busperu-staging-web.json` (nuevo, generado)
- `docs/production/F18-09-STAGING-DEPLOYMENT.md` (este informe)
- `frontend/dist/`: regenerado por el build. Está ignorado por git.

**Scratchpad (fuera del repositorio):**
- `web.py`: orquestador con `preflight`, `crear`, `publicar`, `config` y `verificar`.
- `e2e-f1809.mjs`.
- Los registros.
- `web-estado.json`: identificadores, URLs y valores anteriores de configuración, sin secretos.

## 12. Rollback

Con la sesión de administrador con MFA, en este orden:

1. Restaurar la configuración y reiniciar:
   ```bash
   aws ssm put-parameter --region sa-east-1 --overwrite --type String --name /busperu/staging/app/FRONTEND_URL --value https://staging.busperu.invalid
   aws ssm put-parameter --region sa-east-1 --overwrite --type String --name /busperu/staging/app/TRUST_PROXY --value 1
   # y reiniciar busperu-api por SSM (runbook)
   ```
2. `aws cloudformation delete-stack --region sa-east-1 --stack-name busperu-staging-web`. Esto elimina:
   - las 2 distribuciones, la OAC, la función y la política de caché;
   - **la entrada del SG del ALB y las 3 reglas del oyente**, con lo que el ALB vuelve exactamente al estado anterior.
3. El bucket `busperu-staging-web-6578****68` **se conserva** (`Retain`). Vaciarlo y borrarlo es una decisión aparte, con autorización.
4. `/busperu/staging/ops/CLOUDFRONT_ORIGIN_SECRET` se puede conservar o borrar, con autorización.

**Solo el frontend:** volver a publicar el `dist/` anterior (o restaurar versiones anteriores, porque el bucket tiene versionado) e invalidar `/*`.

**Los datos sintéticos** no requieren rollback.

## 13. Estado final

## **PASS WITH FINDINGS**

**Ruta completa comprobada:** USUARIO → CLOUDFRONT → FRONTEND (navegador) → CLOUDFRONT → ALB → EC2 → API → RDS.

**Lo que funciona:**
- Login de los 4 roles y RBAC.
- Búsqueda, itinerario, asientos, reserva, expiración, pago manual, Mis viajes y logout.
- Notificaciones dentro de la aplicación.
- Reinicio del servicio y monitorización.
- El bucket es privado y el ALB solo acepta CloudFront y a los operadores.

**Hallazgos que impiden un PASS limpio:**
- **Pago sandbox: NOT TESTED** y **correo: NOT TESTED** (H-6, dependen de configuración externa).
- El **login en la interfaz** debe hacerlo el propietario: el asistente no introduce contraseñas. El login sí está verificado por la API a través de CloudFront.
- Los hallazgos LOW H-8 y H-9.

**USER ACTION REQUIRED (sin prisa, nada bloquea el uso de staging):**
1. Si lo desea, iniciar sesión en https://d25z2lpl1efut1.cloudfront.net con un usuario de staging y recorrer una compra desde la interfaz.
2. Para probar el pago sandbox: claves de **prueba** de Culqi para staging, cargadas por la vía de integraciones y **nunca** en el chat.
3. Para probar el correo: decidir y autorizar Resend en staging.
4. Decidir si el rol de despliegue de staging debe tener permisos acotados para futuras publicaciones: `s3:PutObject`/`DeleteObject`/`ListBucket` sobre `busperu-staging-web-*` y `cloudfront:CreateInvalidation`/`GetInvalidation` sobre la distribución web. Hoy cada publicación requiere la sesión de administrador.
5. Mantener pendientes los temas de F18-08: dominio y certificados, Culqi LIVE, Resend, suscripción SNS de producción, Identity Center/Organizations y la eliminación definitiva de la access key.

**NO PRODUCTION DEPLOYMENT WAS PERFORMED.**

---

### Anexo — git

```
$ git rev-parse --short HEAD && git branch --show-current
e71a1b1
master

$ git status --short | wc -l
242            # mismo número que al empezar F18-09

$ git diff --stat | tail -1
 107 files changed, 3650 insertions(+), 1069 deletions(-)
```

- `git diff --stat` solo cubre archivos **versionados**. Esas 107 modificaciones son **anteriores** a F18-09 (F17/F18-07A/F18-08) y no se han tocado: F18-09 no modificó ningún archivo versionado.
- Los archivos nuevos de F18-09 están dentro de directorios no versionados que ya figuraban como `??`, así que el número de entradas no cambia:
  - `?? infra/` contiene `build-web-template.mjs`, `check-web-template.mjs` y `busperu-staging-web.json`.
  - `?? docs/` contiene este informe.
- `frontend/dist/` está en `.gitignore`.
- Sin commit, push, reset ni clean. No se borró ningún archivo del proyecto.
