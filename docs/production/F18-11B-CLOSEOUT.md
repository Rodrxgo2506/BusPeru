# F18-11B — Closeout: cierre de la optimización ADMIN y preparación del diff

> Solo staging. Esta fase **no** añade optimizaciones ni cambia la arquitectura. Su alcance: documentar F18-11B, revisar
> el diff, excluir de git los artefactos de release, verificar secretos, DEMO y QA, y repetir los tests. **NO COMMIT ·
> NO PUSH · NO PRODUCTION CHANGES.** Sin secretos en este documento. Cuenta `6578****68`.

## 1. Objetivo

Cerrar F18-11B, que ya está aceptada técnicamente. Se deja el repositorio listo para un commit futuro:
- cambios clasificados por tipo;
- artefactos generados excluidos;
- sin secretos;
- con los tests de cierre ejecutados.

## 2. Estado F18-11B

**PASS WITH FINDINGS** (ver `F18-11B-ADMIN-NAV-OPTIMIZATION.md`), desplegada en staging:
- release **2026-09-25-1**;
- CloudFront API con `OriginKeepaliveTimeout` 55 s;
- frontend `index-D7DjjFFG.js`.

En esta fase de cierre **no se cambió código funcional ni infraestructura**. El build de verificación produce el mismo
hash de entrada que el desplegado.

## 3. Métricas antes / después (de F18-11B, medidas en staging)

| Métrica | Antes | Después |
| --- | ---: | ---: |
| Navegación repetida (mediana R2–R4) | 293 ms | **6 ms** |
| Peticiones API por navegación repetida | 4,7 | **0,05** |
| Primera visita (mediana R1, con precarga) | 454 ms | **395 ms** |
| Navegación rápida (8 clics) | 46–47 peticiones | **9** |
| Peticiones canceladas (rápida en frío) | 0 | **14** |
| `/company/drivers` 400 | 22 | **0** |

La red Lima → São Paulo varió entre mediciones; hay un A/B a la misma hora en el informe de F18-11B, §15.

## 4. Optimizaciones implementadas (revisión funcional)

| # | Archivo(s) | Comportamiento | Test que lo cubre | ¿Seguridad? | ¿RBAC? | ¿Multitenancy? |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `frontend/src/services/response-cache.ts` (nuevo) | Caché en memoria. Clave `token\nURL`, TTL 30 s, copias con `structuredClone`, contador de generación, solo rutas del panel permitidas | `response-cache.test.ts` (6 pruebas); UI: volver a Usuarios en menos de 30 s no repite GET | Sí, positivamente: nada en `localStorage`, se aísla por sesión y se excluyen autenticación, notificaciones, llaves, auditoría, integraciones y cuentas bancarias | No: el backend sigue autorizando cada GET real | No: la clave lleva el token y solo existe en el panel ADMIN |
| 2 | `frontend/src/services/api.ts` | Invalidación **total** ante POST/PUT/PATCH/DELETE (antes y después de la escritura), login y logout (`tokenStorage.set/clear`) y 401. Guarda solo con la misma sesión y la misma generación. Activación con `setResponseCacheEnabled` | Pruebas de generación y `clear`; UI: tras el PUT de la empresa QA 20, Usuarios vuelve a pedir datos; el logout de la UI borra el token (me 401) | Sí, positivamente: evita reutilizar datos de otra sesión | No | No |
| 3 | `frontend/src/hooks/useAsync.ts`, `useList.ts`, `api.ts` (`withRequestSignal`, `ApiError.aborted`) | `AbortController` por carga: cancela al desmontar o al sustituir. Las cancelaciones no son error ni toast. Nunca cancela escrituras | Medido: navegación rápida en frío, 14 `net::ERR_ABORTED`, 0 errores, página final correcta (4 casos); frontend 19/19 | No | No | No |
| 4 | `frontend/src/layouts/PortalLayout.tsx` | `unread-count`: al montar, cada 60 s con la pestaña visible, al volver a la pestaña (≥ 15 s) y al navegar solo si pasaron más de 30 s o se entra o sale de Notificaciones | Medido: 104 → 0 peticiones en las rondas; UI de los 4 roles 33/33 | No | No | No |
| 5 | `frontend/src/pages/modules/TripPages.tsx` | El ADMIN no pide `/company/drivers` (siempre daba 400); en pantalla, igual. COMPANY_ADMIN y OPERATOR, sin cambios | UI: «Viajes sin /company/drivers ni 400»; medido 22 → 0 | No | **No cambia**: el backend sigue exigiendo empresa | No: el endpoint sigue acotado por la sesión para los roles de empresa |
| 6 | `frontend/src/routes/admin-chunks.ts` (nuevo), `routes/index.tsx`, `layouts/index.tsx` | Precarga de 5 módulos ADMIN (secuencial, ociosa, ≥ 2 s tras montar, una vez). Se mantiene el lazy loading | Medido: 0 chunks en la primera visita tras la precarga; build: mismos chunks por sección | No | No: los permisos se siguen aplicando al renderizar (`PermissionRoute`) | No |
| 7 | `backend/src/app.ts`, `backend/src/config/http-server.ts` (nuevo) | CORS `maxAge: 7200`. No cambian el origen exacto, credenciales, métodos ni cabeceras | `74-cors-cabeceras-seguridad.test.ts` (+1 prueba: max-age 7200, origen exacto, credenciales, origen ajeno sin permiso, sin `*`); verificación HTTP real | Revisado: **no abre CORS** | No | No |
| 8 | `backend/src/server.ts`, `http-server.ts`; `infra/aws/cloudformation/*web*` | Node `keepAliveTimeout` 65 s / `headersTimeout` 66 s; CloudFront `OriginKeepaliveTimeout` 55 s (< ALB 60 s) | `82-f1811b-http-keepalive.test.ts` (2 pruebas); `check-web-template.mjs` (regla 30–59 s); 0 respuestas 5xx desde el despliegue | No | No | No |
| 9 | Tests nuevos | Frontend: 6. Backend: 1 (CORS) + 2 (keep-alive) | Incluidos en 19/19 y en 2136/2136 | — | — | — |

**Sin errores evidentes introducidos por F18-11B** en la revisión del diff; no fue necesario modificar código funcional.

## 5. Tests (cierre, 2026-09-25)

| Suite | Esperado | Resultado |
| --- | --- | --- |
| Backend MariaDB 10.4 (`busperu_test`) | 2136/2136 | **2136/2136** (0 fallidas, exit 0) |
| Backend MariaDB 10.11 estricto (`busperu_1011_test`, local, puerto 3311) | 2136/2136 | **2136/2136** (0 fallidas, exit 0) |
| Seguridad (lista reproducible de 33 archivos) | 933/933 | **933/933** en 10.4 y en 10.11 (33 archivos, 0 fallidas) |
| Frontend: typecheck / lint / tests | OK / OK / 19/19 | **0 errores / 0 avisos / 19/19** |
| Build frontend (staging) | limpio | **OK**. `index-D7DjjFFG.js` (275,02 kB, gzip 83,03), el mismo hash que el desplegado. Solo aparece la URL de la API de staging. 0 apariciones de localhost, 127.0.0.1, busperuonline, `.invalid`, `sk_live`/`sk_test_`, `AKIA`, el ID de cuenta, JWT y correos DEMO. **No se publicó.** |

## 6. Security baseline actual

- El **«944/944» de F18-08 queda retirado como referencia**: no se registró la lista de archivos y no es reproducible.
- **Referencia reproducible desde ahora:** estos 33 archivos de la regresión backend, que se cuentan sobre la salida del runner. Fueron **932** pruebas antes de F18-11B y **933** después; la nueva es la de CORS `max-age`.

  `01-auth`, `02-rbac`, `03-tenancy`, `10-privileges`, `11-password-reset`, `12-bank-accounts`, `17-oauth`,
  `18-company-integrations`, `19-api-keys`, `20-integration-api`, `29-hardening`, `31-culqi`, `52-manual-payment-verification`,
  `53-customer-resource-scope`, `54-culqi-timeout-reconciliation`, `55-refund-overrefund-guard`,
  `56-coupon-isolation-and-paid-cancellation`, `60-dev-database-isolation`, `61-f12-cross-company-and-settlements`,
  `62-f12-p3-dates-sessions-secrets`, `63-f15-production-hardening`, `67-sec-01-hallazgos`, `69-cuerpo-ilegible`,
  `70-webhook-moneda`, `71-recuperacion-sesiones`, `72-revocacion-sesiones`, `74-cors-cabeceras-seguridad`,
  `75-cifrado-rotacion-claves`, `76-terminacion-sesiones-auditoria`, `77-reserva-entre-empresas`,
  `78-bootstrap-admin-readiness`, `80-f1807-cifrado-bancario`, `81-f1807-auditoria-financiera`.

**Revisión estática de secretos** sobre el diff preparado, el sin preparar y los archivos no versionados (65.969 líneas):
- Patrones buscados: claves AWS, secretos y tokens de sesión, JWT, claves de Culqi y Resend, cabeceras `Bearer` literales, el ID de cuenta, claves PEM, contraseñas asignadas y cookies.
- **Ningún secreto real.**
- Las 30 coincidencias son fixtures de tests anteriores a esta fase, falsos positivos (nombres de FK, la clave `platform.default_commission`) o valores sintéticos de los arneses (claves de validación ficticias, la contraseña «incorrecta» del smoke).
- Los `.env` reales están ignorados; solo se versionan plantillas `*.example`.

## 7. QA pendiente (PENDING)

Datos QA de F18-11B, que siguen en staging **a propósito** (la fase anterior prohibía purgarlos):
- una ejecución de `qa-staging.sh pruebas` a las 02:18Z. Los manifiestos están en el scratchpad de la sesión (`f1811b/qa/qa-manifest-{smoke,e2e}-20260925T021856Z.json`);
- la **empresa QA 20** está INACTIVE, con la descripción editada desde la interfaz. No se modificó en esta fase;
- los restos de la ejecución e2e de las 22:21Z, con su manifiesto `qa-manifest-e2e-mug3ixsf.json` en la raíz del repositorio (ver §14).

Purgarlos queda **pendiente de una autorización separada**. En esta fase no se ejecutó ninguna purga.

## 8. DEMO integrity

Comprobado solo con **lecturas** de la API como ADMIN, sin seed ni purga:

| Elemento | Estado |
| --- | --- |
| Empresa 16 «BusPerú Demo» | ACTIVE |
| Usuarios 46 COMPANY_ADMIN, 47 OPERATOR, 48 CUSTOMER | ACTIVE |
| Terminales / rutas / viajes | 4 / 6 / **12** |
| Bus 14 | 40 plazas, ACTIVE, layout 12 publicado con 40 asientos |
| Público | 2 viajes Lima → Pucallpa visibles |
| Culqi de plataforma | DISCONNECTED |

Protecciones de la caché verificadas en el código: memoria (`Map`), activa solo en `AdminLayout`, clave con el token,
TTL `30_000`, limpieza en `tokenStorage.set/clear` (login y logout), en 401 y antes y después de cada escritura, y
generación contra lecturas en vuelo. **No se modificaron datos ni credenciales DEMO.**

## 9. AWS status (solo lecturas; sin cambios en esta fase)

Se reutilizó la sesión de administrador que seguía abierta de F18-11B. No se renovó MFA ni se activó ninguna clave.

| Comprobación | Resultado |
| --- | --- |
| `/api/ready` y `/api/health` por CloudFront | 200 |
| Web CloudFront | sirve `index-D7DjjFFG.js`; `/admin/login` 200 |
| CORS real | `Access-Control-Max-Age: 7200`, origen exacto, credenciales; origen ajeno sin permiso; GET sin token 401 |
| ALB desde el despliegue (02:03Z) | 0 `ELB_5XX`, 0 `Target_5XX` en 1658 peticiones |
| Alarmas staging | 12/12 OK |
| Pilas | `busperu-staging-web` UPDATE_COMPLETE (última de F18-11B, 02:05Z); `busperu-staging` UPDATE_COMPLETE (sin cambios desde el 2026-09-23) |

Sin cambios en IAM, RDS, ALB, CloudFront, S3, Parameter Store, dominio ni DNS en esta fase.

## 10. `.gitignore`

Regla añadida al final del `.gitignore` raíz, en CRLF como el resto del archivo:

```
# F18-11B: paquetes que genera infra/aws/scripts/make-release.sh (se suben a S3; nunca se versionan).
infra/aws/.releases/
```

- Es específica: no se añadió `*.tar.gz` global.
- `git check-ignore -v` confirma que se ignoran los 2 artefactos existentes y cualquier `.tar.gz` futuro en esa carpeta (`.gitignore:20`).
- `infra/aws/scripts/make-release.sh` y `infra/aws/cloudformation/busperu-staging-web.json` **no** quedan ignorados.
- `.gitignore` ya tenía un cambio preparado anterior (`M ` → ahora `MM`); esta fase solo añade esas 2 líneas sin preparar.

## 11. Archivos modificados (versionados)

Todos los cambios de F18-11B están **sin preparar**: nunca se hizo `git add`. En los archivos marcados «mixto», el diff
sin preparar contiene además cambios **anteriores** que nunca se prepararon.

| Archivo | Clasificación | Hunks de F18-11B | Otros cambios en el mismo diff |
| --- | --- | --- | --- |
| `backend/src/app.ts` | IMPLEMENTATION (mixto) | import `http-server` y `maxAge` | readiness `/api/ready`, `no-store` en `/api/health`, `env.corsOrigin` (F18-02/F18-07A/SEC-07) |
| `backend/src/server.ts` | IMPLEMENTATION | `applyKeepAlive` | — |
| `frontend/src/services/api.ts` | IMPLEMENTATION (mixto) | caché, cancelación, `aborted` e invalidación | `mediaUrl` |
| `frontend/src/hooks/useAsync.ts` | IMPLEMENTATION | `AbortController` | — (tenía cambios preparados anteriores) |
| `frontend/src/hooks/useList.ts` | IMPLEMENTATION | `AbortController` | — |
| `frontend/src/layouts/index.tsx` | IMPLEMENTATION (mixto) | caché y precarga en `AdminLayout` | `RouteSuspense` en `CustomerLayout` |
| `frontend/src/layouts/PortalLayout.tsx` | IMPLEMENTATION (mixto) | `unread-count` | `RouteSuspense` (F17C-NAV-01) |
| `frontend/src/routes/index.tsx` | IMPLEMENTATION (mixto) | import de `admin-chunks` y 14 `lazy` | `RouteSuspense`, `ScrollToTop`, páginas de Destinos, LF/CRLF |
| `frontend/src/pages/modules/TripPages.tsx` | IMPLEMENTATION (mixto) | sin `/company/drivers` para el ADMIN | descripción según el ámbito |
| `frontend/package.json` | TESTS / CONFIG (mixto) | `response-cache.test.ts` en `test` | `search-helpers.test.ts` (misma línea) |
| `.gitignore` | CONFIG | regla `infra/aws/.releases/` | cambio preparado anterior |

## 12. Archivos nuevos (no versionados)

| Archivo | Clasificación |
| --- | --- |
| `backend/src/config/http-server.ts` | IMPLEMENTATION |
| `frontend/src/services/response-cache.ts` | IMPLEMENTATION |
| `frontend/src/routes/admin-chunks.ts` | IMPLEMENTATION |
| `backend/src/test/82-f1811b-http-keepalive.test.ts` | TESTS |
| `frontend/src/services/response-cache.test.ts` | TESTS |
| `backend/src/test/74-cors-cabeceras-seguridad.test.ts` | TESTS (el archivo ya existía sin versionar; F18-11B le añadió 1 prueba) |
| `infra/aws/cloudformation/build-web-template.mjs`, `check-web-template.mjs`, `busperu-staging-web.json` | INFRAESTRUCTURA (creados en F18-09; F18-11B cambió el keep-alive y la regla del comprobador). Dentro del directorio `infra/`, que aún no se versiona. |
| `docs/production/F18-11B-ADMIN-NAV-OPTIMIZATION.md`, `docs/production/F18-11B-CLOSEOUT.md` | DOCS (dentro de `docs/`, que aún no se versiona) |

## 13. Artefactos ignorados (GENERATED/IGNORED)

| Ruta | Origen | Estado |
| --- | --- | --- |
| `infra/aws/.releases/busperu-2026-09-25-1.tar.gz` (383.753 B) y `.sha256` (94 B) | `make-release.sh` (F18-11B); es la release desplegada, cuya copia también está en S3 | **Ignorados** por la regla nueva. No versionados. No se borraron: son la copia local de la release desplegada |
| `frontend/dist/`, `backend/dist/` | builds | Ignorados (`dist/`) |

## 14. Cambios preexistentes (PREEXISTING)

- **148 archivos preparados** (`A`, `M`, `MM`, `AM`, `D`) y los cambios sin preparar ajenos a F18-11B, de las fases F15–F18-10: backend, frontend, migraciones 015–019, `docs/` e `infra/`. No se tocaron ni se revirtieron.
- En los archivos mixtos de §11, los hunks ajenos a F18-11B se conservan tal cual.
- **FINDING:** `qa-manifest-e2e-mug3ixsf.json` en la raíz, sin versionar y **no ignorado**. Lo generó una ejecución de `e2e-staging.mjs` sin `QA_MANIFEST` a las 22:21Z, fuera de mis fases. Contiene solo ids y marcas QA, sin secretos. **No se borró** porque su origen no es de esta sesión. Debe quedar fuera de cualquier commit: moverlo o añadir una regla `qa-manifest-*.json`, a decidir.

## 15. Riesgos

1. **Diff mixto:** 7 archivos contienen hunks de F18-11B y cambios anteriores sin preparar. Un commit «solo F18-11B» exigiría preparar por hunks (`git add -p`), y no se ha hecho. Un commit conjunto incluiría también esos cambios anteriores.
2. **`frontend/src/routes/index.tsx`** tiene además cambios de fin de línea (LF frente al CRLF de HEAD): unas 950 líneas en el diff bruto. Conviene normalizar antes de hacer commit.
3. **Datos obsoletos** hasta 30 s en el panel si otro usuario cambia datos (las escrituras propias invalidan al instante).
4. **`max-age` de 2 h:** si CORS se restringe más adelante, los navegadores podrían tardar hasta 2 h en aplicarlo.
5. **Restos QA** en staging (§7).

## 16. Trabajo pendiente

| Estado | Tarea |
| --- | --- |
| PENDING | Purga autorizada de los restos QA (F18-11B y 22:21Z) |
| PENDING | Decidir qué hacer con `qa-manifest-e2e-mug3ixsf.json` (moverlo o ignorarlo) |
| PENDING | Preparación por hunks (o commit conjunto consciente) y normalización LF/CRLF antes de un commit |
| PENDING | Desactivar la access key de administrador cuando termine su uso |
| FUTURO | API en el mismo origen para eliminar los preflights de la primera visita (cambio de arquitectura, no autorizado) |

## 17. Git status final

Ver §19. Sin commit, push, reset, clean, rebase ni merge. HEAD sin cambios: `e71a1b1` (`master`).

## 18. Declaración

- **NO COMMIT**
- **NO PUSH**
- **NO PRODUCTION CHANGES**
- Sin cambios en IAM, RDS ni AWS en esta fase. Sin purga ni seed. Sin datos ni credenciales DEMO modificados.

**Estado de F18-11B-CLOSE: PASS.** Se cumplen todos los criterios de la fase:
- tests en verde: 2136/2136 ×2, 933/933 y 19/19;
- build limpio y sin secretos;
- DEMO intacta y staging sano;
- sin cambios en producción, IAM ni RDS;
- `.releases` ignorado;
- diff revisado y cambios anteriores identificados;
- sin commit ni push.

Quedan abiertos los puntos PENDING de §16, que no son regresiones.

## 19. Anexo — salida de git al cierre

HEAD `e71a1b1` (`master`), sin commits nuevos. `git status --short`: **250 entradas**, las mismas que al inicio de la fase
salvo `.gitignore`, que pasa de `M ` a `MM`:

| Código | Entradas |
| --- | ---: |
| ` M` | 40 |
| `MM` | 47 |
| `M ` | 35 |
| `A ` | 41 |
| `AM` | 24 |
| `D ` | 1 |
| `??` | 62 |

- **Preparado (índice, preexistente, no tocado):** 148 archivos, +27136/−1328.
- **Sin preparar:** 111 archivos, +3862/−1102. Incluye los hunks de F18-11B y los cambios anteriores sin preparar.
- **Archivos no versionados:** 129. Eran 130; salen los 2 artefactos `.releases` ya ignorados y entra este informe.
- **`infra/aws/.releases/`:** ignorado (`.gitignore:20`), 0 archivos en el índice.

Archivos de F18-11B (estado de git / diff sin preparar):

```
[MM] .gitignore                                            +2/-0
[MM] backend/src/app.ts                                    +28/-1    (mixto)
[ M] backend/src/server.ts                                 +3/-0
[??] backend/src/config/http-server.ts                     nuevo
[??] backend/src/test/74-cors-cabeceras-seguridad.test.ts  (+1 prueba F18-11B)
[??] backend/src/test/82-f1811b-http-keepalive.test.ts     nuevo
[MM] frontend/package.json                                 +1/-1    (mixto)
[MM] frontend/src/services/api.ts                          +102/-8  (mixto)
[??] frontend/src/services/response-cache.ts               nuevo
[??] frontend/src/services/response-cache.test.ts          nuevo
[MM] frontend/src/hooks/useAsync.ts                        +16/-4
[ M] frontend/src/hooks/useList.ts                         +15/-3
[MM] frontend/src/layouts/index.tsx                        +30/-1   (mixto)
[ M] frontend/src/layouts/PortalLayout.tsx                 +40/-4   (mixto)
[ M] frontend/src/routes/index.tsx                         +506/-446 (mixto; LF/CRLF)
[??] frontend/src/routes/admin-chunks.ts                   nuevo
[MM] frontend/src/pages/modules/TripPages.tsx              +6/-3    (mixto)
[??] infra/  (build-web-template.mjs, check-web-template.mjs, busperu-staging-web.json)
[??] docs/   (F18-11B-ADMIN-NAV-OPTIMIZATION.md, F18-11B-CLOSEOUT.md)
```

La salida completa de `git status --short`, `git diff --stat`, `git diff --name-status` y la lista de no versionados, al
inicio y al final, está en el scratchpad de la sesión (`f1811b-close/git-*-inicial.txt`, `git-*-final.txt`).
