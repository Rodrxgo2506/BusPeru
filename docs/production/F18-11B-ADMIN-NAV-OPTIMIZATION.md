# F18-11B — Optimización incremental de la navegación ADMIN (staging)

> Solo **staging** (sa-east-1). Producción no existe y no se tocó. Sin dominio, DNS ni Culqi/Resend reales. Sin cambios
> de IAM, RDS, ALB ni credenciales, y sin migraciones. Sin commit ni push. Cuenta `6578****68`. Este informe no contiene
> contraseñas, tokens ni claves. Fuente: auditoría F18-11.

## 1. Resumen ejecutivo

**Estado final: PASS WITH FINDINGS.**

Se implementaron las 7 optimizaciones de bajo riesgo en el orden pedido, se desplegaron en staging y se midieron con el
mismo método de F18-11 (Chrome headless, ADMIN real, clics reales, Resource Timing + CDP).

| Qué | Antes (F18-11) | Después (F18-11B) |
| --- | ---: | ---: |
| **Navegación repetida** (R2–R4, mediana) | **293 ms**, con indicador de carga el 100 % de las veces | **6 ms**, sin indicador |
| Peticiones API por navegación repetida | 4,7 (1,8 OPTIONS + 2,9 GET) | **0,05** |
| Primera visita (R1, mediana) | 454 ms · A/B a la misma hora: 498 ms | **395 ms** con precarga |
| Navegación rápida (8 clics, módulos cargados) | 46–47 peticiones, 121–220 ms hasta la página final | **9 peticiones, ≈10 ms** |
| Navegación rápida en frío | 47 peticiones, 0 canceladas, un 400 | 36 peticiones, **14 canceladas**, 0 errores |
| `/company/drivers` 400 (en 2 ejecuciones completas) | 22 peticiones | **0** |
| Errores HTTP en las rondas | 4 | **0** |

Regresión: backend **2136/2136** en MariaDB 10.4 y en 10.11 estricto (2133 más 3 pruebas nuevas). Frontend **19/19**
(13 más 6 nuevas). Seguridad: **933/933** en la lista explícita de 33 archivos. Pruebas de QA por CloudFront: smoke
**37/37** y E2E **18/18**. Interfaz de los 4 roles: **33/33**. ALB/target: 0 respuestas 5xx; aplicación: 0 errores.

Hallazgos (§23): la red Lima → São Paulo estaba más lenta durante la medición posterior, así que se añadió un A/B a la
misma hora. La primera visita sigue dominada por preflight + GET de cada URL nueva. Otros: baseline de seguridad
reconstruido, tarball de la release dentro del repositorio y restos QA sin purgar (por regla de la fase).

## 2. Estado inicial (00:10–00:20Z, 2026-09-25)

- **Git:** `master` en `e71a1b1`, con 243 entradas en `git status --short` (la 243.ª es `qa-manifest-e2e-mug3ixsf.json`, ajena) y `git diff --stat` en 107 archivos.
- **Staging:**
  - release `2026-09-23-3`;
  - frontend `index-2GKeKp9S.js`;
  - distribución API con `OriginKeepaliveTimeout` 5 s;
  - ALB con `idle_timeout` 60 s;
  - Node con `keepAliveTimeout` por defecto (5 s).
- **DEMO presente:** empresa 16, usuarios 46–48, 12 viajes (2 Lima → Pucallpa).
- **Purga QA:** rechaza DEMO (`ES_DEMO` en `purge-qa-data.cjs`).
- **Restos QA:** los de la ejecución e2e de las 22:21Z seguían sin purgar (empresa 19, usuarios 55–57).

## 3. Baseline (antes de cambiar código)

| Suite | Resultado |
| --- | --- |
| Backend MariaDB 10.4 (`busperu_test`) | **2133/2133** |
| Backend MariaDB 10.11 estricto (`busperu_1011_test`, instancia local en el puerto 3311) | **2133/2133** |
| Frontend: typecheck / lint / tests | 0 errores / 0 avisos / **13/13** |
| Seguridad | **932/932** (ver nota) |
| `/api/ready` | 200 |
| Smoke mínimo (portada DEMO, búsqueda) | OK |

**Nota sobre seguridad (FINDING).** El «944/944 en 33 suites» de F18-08 no se puede reproducir: no quedó registrada la
lista exacta de archivos. Para esta fase se fija una **lista explícita de 33 archivos de seguridad dentro de la
regresión backend**:
auth, rbac, tenancy, privileges, password-reset, bank-accounts, oauth, company-integrations, api-keys, integration-api,
hardening, culqi, manual-payment, customer-resource-scope, culqi-timeout, refund-overrefund, coupon-isolation,
dev-database-isolation, cross-company, dates-sessions-secrets, production-hardening, sec-01, cuerpo-ilegible,
webhook-moneda, recuperación y revocación de sesiones, cors, cifrado-rotación, terminación de sesiones,
reserva-entre-empresas, bootstrap-admin, cifrado bancario y auditoría financiera. Esa lista suma **932** pruebas antes
y **933** después.

## 4. Cambios realizados (en el orden pedido)

1. **CORS `Access-Control-Max-Age: 7200`.** No cambian ni el origen exacto (`FRONTEND_URL`), ni `credentials`, ni los métodos o cabeceras.
2. **`/company/drivers` para el ADMIN.** La llamada era innecesaria (A):
   - el ADMIN no tiene empresa propia;
   - el endpoint exige `company_id`;
   - respondía siempre 400 y el selector quedaba vacío.

   Ya no se pide cuando la página es la del ADMIN. En pantalla se ve exactamente igual (selector vacío con su aviso), y el backend y el RBAC no cambian.
3. **Keep-alive** en la cadena CloudFront → ALB → Node:
   - CloudFront: `OriginKeepaliveTimeout` pasa de 5 a **55 s**, por debajo de los 60 s del ALB, para que cierre él primero;
   - Node: `keepAliveTimeout` pasa de 5 a **65 s**, con `headersTimeout` de 66 s, por encima del ALB. Evita reutilizar un socket que Node ya cerró, la causa clásica de 502.
4. **Caché de lecturas en memoria** en el frontend, solo mientras el panel ADMIN está montado (§10).
5. **`AbortController`** en `useAsync` y `useList` (§11).
6. **`unread-count` menos frecuente** y sin bloquear la navegación (§12).
7. **Precarga de los chunks de 5 módulos ADMIN** con el navegador ocioso (§13).

## 5. Archivos modificados

| Archivo | Cambio |
| --- | --- |
| `backend/src/app.ts` | `maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS` en `cors()` |
| `backend/src/server.ts` | `applyKeepAlive(server)` |
| `backend/src/config/http-server.ts` (nuevo) | Constantes de CORS y keep-alive, y `applyKeepAlive` |
| `backend/src/test/74-cors-cabeceras-seguridad.test.ts` | +1 prueba: max-age 7200 sin abrir CORS |
| `backend/src/test/82-f1811b-http-keepalive.test.ts` (nuevo) | 2 pruebas: keep-alive > ALB y tope de max-age |
| `frontend/src/services/response-cache.ts` (nuevo) | Caché: memoria, clave con token, TTL, generación y copias |
| `frontend/src/services/response-cache.test.ts` (nuevo) | 6 pruebas |
| `frontend/src/services/api.ts` | Caché, `withRequestSignal`, `ApiError.aborted` e invalidación ante escrituras y cambios de sesión |
| `frontend/src/hooks/useAsync.ts`, `useList.ts` | `AbortController` por carga; las cancelaciones no se tratan como error |
| `frontend/src/layouts/index.tsx` | `AdminLayout`: activa la caché (`useLayoutEffect`) y programa la precarga |
| `frontend/src/layouts/PortalLayout.tsx` | Nueva estrategia de `unread-count` |
| `frontend/src/routes/admin-chunks.ts` (nuevo) | Cargadores de los módulos compartidos entre `lazy` y la precarga |
| `frontend/src/routes/index.tsx` | 14 rutas `lazy` usan esos cargadores; 5 módulos, mismos chunks |
| `frontend/src/pages/modules/TripPages.tsx` | Sin `/company/drivers` para el ADMIN |
| `frontend/package.json` | El script `test` incluye `response-cache.test.ts` |
| `infra/aws/cloudformation/build-web-template.mjs` / `busperu-staging-web.json` | `OriginKeepaliveTimeout` 5 → 55 (único cambio de la plantilla) |
| `infra/aws/cloudformation/check-web-template.mjs` | Regla nueva: keep-alive entre 30 y 59 s |

## 6. Cambios de infraestructura

| Recurso | Cambio | Cómo |
| --- | --- | --- |
| EC2 (`busperu-api`) | Release **2026-09-25-1** | Paquete verificado con SHA-256. El diff con la `-3` demostró que solo cambian `app.js`, `server.js` y `config/http-server.js`. Se desplegó con `deploy-release.sh` (vuelta automática si `/api/ready` falla). La `-3` sigue en `/opt/busperu/releases/`. |
| CloudFront API (`E1O34SN785WQBD`) | `OriginKeepaliveTimeout` 55 | Change set `f1811b-keepalive` sobre `busperu-staging-web`: **1** `Modify ApiDistribution`, `Replacement=False`, `UPDATE_COMPLETE` en 68 s, `Deployed` |
| S3 web | 96 archivos de la build nueva | Los 90 objetos con hash de la publicación anterior se **conservan** (inmutables) para clientes con el `index.html` anterior |
| CloudFront web | Invalidación `/*` `ICRRWEASDBZ5JZBLA0EJD1KQVM` | Completada |
| S3 artefactos | `releases/busperu-2026-09-25-1.tar.gz` (+ `.sha256`) | — |
| ALB, RDS, IAM, Parameter Store, SG | **Sin cambios.** El `idle_timeout` del ALB (60 s) se leyó, no se modificó. | — |

## 7. CORS antes / después

| Comprobación (HTTP real por CloudFront) | Antes | Después |
| --- | --- | --- |
| `OPTIONS /companies` desde la web | 204, sin `Access-Control-Max-Age` | 204 · `Access-Control-Max-Age: 7200` |
| `Access-Control-Allow-Origin` | `https://d25z2lpl1efut1.cloudfront.net` | igual (exacto, nunca `*`) |
| `Access-Control-Allow-Credentials` | `true` | `true` |
| Métodos / cabeceras | `GET,HEAD,PUT,PATCH,POST,DELETE` / `authorization` | igual |
| Origen ajeno | no se refleja | no se refleja ni hay comodín |
| Ruta con barra final (`/companies/`) | — | 204, mismo origen y max-age |
| GET sin token | 401 | 401 |
| Preflights en navegación repetida | 1,8 por navegación | **0** |

## 8. `/company/drivers` antes / después

- **Causa:** `TripsPage` pedía `driverService.list({status:'ACTIVE'})` para todos los roles. Para el ADMIN (sin empresa), `resolveCompanyId` responde **400** «Indica la empresa con el parámetro company_id».
- **Corrección:** con `scope === 'admin'` no se pide y el selector recibe una lista vacía, que es lo mismo que se veía antes. COMPANY_ADMIN y OPERATOR siguen pidiéndolo con el aislamiento del backend intacto.
- **Resultado:** **0** peticiones a `/company/drivers` y **0** errores 400 en todas las rondas y en la interfaz. Antes eran 22 peticiones en 2 ejecuciones.

## 9. Keep-alive antes / después

| | Antes | Después |
| --- | --- | --- |
| CloudFront → ALB (`OriginKeepaliveTimeout`) | 5 s | **55 s** |
| ALB `idle_timeout` | 60 s | 60 s (sin cambios) |
| Node `keepAliveTimeout` / `headersTimeout` | 5 s / por defecto | **65 s / 66 s** |
| 502/504/5xx del ALB (24 h previas / desde el despliegue) | 0 / — | 0 / 0 (1639 peticiones) |

**Mejora de latencia por reutilizar conexiones: NOT MEASURED de forma aislable.**
- La latencia de la red Lima → São Paulo cambió entre mediciones, y también en la distribución web, que no se tocó (§15.3).
- Evidencia indirecta: con 6 s de pausa entre peticiones (más que el keep-alive anterior de 5 s), 4 de 5 respuestas siguieron en el tramo rápido (192–217 ms frente a 403).
- La cadena queda configurada de forma coherente: CloudFront (55 s) < ALB (60 s) < Node (65 s).

## 10. Caché implementada

- **Dónde:**
  - `services/response-cache.ts` es un módulo puro con pruebas;
  - `api.ts` lo usa en `request()`;
  - `AdminLayout` la activa con `useLayoutEffect` y la **desactiva y vacía al salir** del panel;
  - los portales CUSTOMER y COMPANY no la usan.
- **Qué se cachea:** solo **GET** correctas de rutas explícitas del panel: `companies`, `users`, `roles`, `trips`, `routes`, `buses`, `bus-types`, `seat-types`, `locations`, `bookings`, `payments`, `destinations`, `system-settings` y `dashboard/admin`.
  - Quedan fuera `auth`, `notifications`, `api-keys`, `audit-logs`, integraciones, cuentas bancarias, `company/*` y `public/*`.
- **TTL:** 30 s.
- **Almacenamiento:** solo en **memoria**, sin `localStorage`.
- **Aislamiento:**
  - la clave es **token de la sesión + URL completa**, así que dos sesiones (otro usuario, rol o empresa) nunca comparten entrada, ni entre pestañas;
  - se devuelven copias con `structuredClone`.
- **Invalidación (total, a propósito):**
  - cualquier **POST/PUT/PATCH/DELETE**, antes y después de la escritura;
  - **login y logout**: `tokenStorage.set/clear`;
  - **401**;
  - salir del panel.

  Un contador de **generación** descarta las lecturas que salieron antes de una invalidación, para que una GET en vuelo durante una escritura nunca guarde datos anteriores a ella.
- **Pruebas unitarias (6):** TTL, aislamiento por token, copias, descarte por generación, `clear` y rutas permitidas y excluidas.
- **Prueba en interfaz:**
  - volver a Usuarios en menos de 30 s **no** repite GET;
  - se editó la empresa QA 20 desde el formulario (**PUT 200**), la lista se volvió a pedir y **después Usuarios sí volvió a pedir** sus datos (caché invalidada);
  - el cambio quedó en la API;
  - el logout desde la interfaz borra el token, `/admin` pide login y el token queda revocado (401).

## 11. AbortController implementado

- `useAsync` y `useList` crean un `AbortController` por carga. La carga nueva **cancela la anterior** (una respuesta vieja nunca pisa a una nueva) y **desmontar la página cancela** la que esté en curso.
- `withRequestSignal` pasa la señal a las GET que el cargador lanza de forma síncrona. **Nunca se cancelan escrituras.** Las llamadas globales (`/auth/me`, branding, `unread-count`) no se cancelan.
- Una cancelación es `ApiError.aborted`: no se muestra como error ni como toast, y no marca `isNetworkError`.
- **Medido, navegación rápida en frío (clic cada 150 ms y cada 60 ms):**
  - **14 peticiones canceladas (`net::ERR_ABORTED`)** de 36;
  - **0** errores HTTP y **0** excepciones;
  - la página final es la correcta (`/admin/dashboard`, «¡Bienvenido de vuelta, Admin!»), sin datos de otra página;
  - el frontend anterior, en las mismas condiciones: 47 peticiones, 0 canceladas y un 400.

## 12. `unread-count` antes / después

| | Antes | Después |
| --- | --- | --- |
| Cuándo se pide | **En cada cambio de ruta** | Al montar el panel, cada 60 s con la pestaña visible, al volver a la pestaña (como mucho cada 15 s) y al navegar solo si el dato tiene más de 30 s o si se entra o se sale de Notificaciones |
| ¿Bloquea la navegación? | No (en paralelo) | No |
| Peticiones en las rondas medidas (2 ejecuciones) | 104 | 0, más la del montaje |

## 13. Precarga implementada

- `routes/admin-chunks.ts` define los cargadores de `AdminManagementPages` (Empresas, Usuarios), `TripPages` (Viajes), `SalesPages` (Reservas, Pagos), `DestinationsAdminPage` y `SystemPages` (Configuración).
  - `React.lazy` y la precarga usan el **mismo `import()`**, y por tanto el mismo chunk.
  - Se mantiene el lazy loading: no hay bundle monolítico.
- `AdminLayout` los descarga **uno tras otro**, una vez por sesión, **2 s después de montar y con el navegador ocioso** (`requestIdleCallback`). No se precarga nada de CUSTOMER ni COMPANY.
- **Medido:** con 5 s en el Dashboard, **0 chunks** se descargan durante la primera visita a esas secciones (antes 1–19 chunks, 16–1172 ms).
  - Si se navega antes de que termine la precarga, se descargan igual que antes (ejecución 1: 1193 ms en Dashboard → Empresas con los chunks recién publicados aún sin cachear en el edge).
- **Bundle:** `index` pasa de 273,3 kB a **275,0 kB** (gzip de 82,0 a **83,0 kB**). El tiempo de carga inicial no empeora de forma medible (1,7–3,4 s frente a 2,1–2,3 s, dentro de la variación de la red).

## 14. Tests

| Suite | Antes | Después |
| --- | --- | --- |
| Backend MariaDB 10.4 | 2133/2133 | **2136/2136** |
| Backend MariaDB 10.11 estricto | 2133/2133 | **2136/2136** |
| Seguridad (lista explícita de 33 archivos) | 932/932 | **933/933** |
| Frontend: typecheck / lint / tests | OK / OK / 13/13 | OK / OK / **19/19** |
| Plantilla web: `check-web-template` | PASS | PASS (con la regla nueva de keep-alive) |
| Smoke por CloudFront (`smoke-staging.mjs`) | — | **37/37** |
| E2E por CloudFront (`e2e-staging.mjs`) | — | **18/18** |
| Interfaz, 4 roles (`ui-funcional.mjs`) | — | **33/33** |

## 15. Performance antes / después

Método idéntico a F18-11 (`medir2.mjs` = `medir.mjs` + título final, canceladas y errores). **Antes:** 2 ejecuciones de
F18-11 (23:53Z y 23:58Z). **Después:** 4 ejecuciones (02:08–02:16Z), 3 de ellas con 5 s en el Dashboard antes de R1.
**A/B a la misma hora:** el frontend anterior (`index-2GKeKp9S.js`, cuyos assets siguen en el bucket) servido al mismo
Chrome headless mediante intercepción CDP del documento, sin tocar AWS, contra el mismo backend y la misma red.

### 15.1 Navegación repetida (R3, módulos cargados), mediana en ms

| Transición | F18-11 | F18-11B | Diferencia |
|---|---:|---:|---:|
| Dashboard → Empresas | 215 | 5,5 | −210 (−97 %) |
| Empresas → Usuarios | 334 | 6,2 | −328 (−98 %) |
| Usuarios → Viajes | 303 | 10,5 | −292 (−97 %) |
| Viajes → Reservas | 258 | 4,4 | −254 (−98 %) |
| Reservas → Pagos | 336 | 4,9 | −331 (−99 %) |
| Pagos → Destinos | 254 | 4,3 | −249 (−98 %) |
| Destinos → Configuración | 254 | 2,4 | −252 (−99 %) |
| Configuración → Dashboard | 301 | 11,5 | −289 (−96 %) |

A/B a la misma hora, frontend anterior: 163–226 ms. Ya se beneficia de `max-age`: una sola GET sin preflight.

### 15.2 Primera visita (R1), mediana en ms (F18-11B con precarga)

| Transición | F18-11 | F18-11B | Diferencia | A/B anterior, misma hora |
|---|---:|---:|---:|---:|
| Dashboard → Empresas | 528 | 393 | −135 | 667 |
| Empresas → Usuarios | 439 | 416 | −24 | 562 |
| Usuarios → Viajes | 583 | 508 | −75 | 736 |
| Viajes → Reservas | 405 | 386 | −20 | 649 |
| Reservas → Pagos | 403 | 388 | −15 | 440 |
| Pagos → Destinos | 454 | 497 | +43 | 673 |
| Destinos → Configuración | 511 | 504 | −8 | 728 |
| Configuración → Dashboard | 319 | 15 | −304 | 180 |

### 15.3 Métricas

| Métrica | Antes | Después |
|---|---:|---:|
| OPTIONS por navegación, repetida / primera | 1,83 / 2,13 | **0 / 1,75** |
| OPTIONS, duración media | 125 ms | 160 ms* |
| GET por navegación, repetida / primera | 2,85 / 3,13 | **0,05 / 1,88** |
| GET, duración media (CDP, incluye la espera del preflight) | 224 ms | 290 ms* |
| Peticiones API por navegación, repetida / primera | 4,68 / 5,25 | **0,05 / 3,63** |
| TTFB de la API (`/ready`, curl, mediana / p90) | 98 / 176 ms | 145 / 268 ms* |
| First visit (mediana R1) | 454 ms | **395 ms** (A/B anterior: 498) |
| Repeat navigation (mediana R2–R4) | 293 ms | **6,1 ms** |
| Tras recarga (R5, preflight cacheado por `max-age`) | 224 ms (1,1 OPTIONS) | **167 ms (0 OPTIONS)** |
| CPU 4× lenta (R6) | 308–351 ms | **30–86 ms** |
| Rapid navigation (8 clics) | 46–47 peticiones, 121–220 ms, con indicador | **9 peticiones, ≈10 ms, sin indicador** |
| Errores HTTP en las rondas | 4 | **0** |
| 400 innecesarios | 22 | **0** |
| Peticiones canceladas (rápida en frío) | 0 | **14** |

\* **Variación de la red, no del cambio.** Durante la medición posterior, el tramo Lima → São Paulo de CloudFront iba más lento:
- la API por CloudFront pasó de 98 a 145 ms (mediana);
- el ALB directo apenas cambió (160 → 168 ms);
- el edge sigue a 13–14 ms;
- la distribución **web, que no se tocó**, necesitó como mínimo ~151 ms para llegar a su origen en São Paulo.

Ambas distribuciones salen por el mismo POP, **LIM50-P3**. Por eso se añadió el A/B a la misma hora: con la red de ese
momento, el frontend nuevo gana 26–224 ms en la primera visita (R1) y 157–220 ms en la navegación repetida (R3).

## 16. Rapid navigation

| Caso | Peticiones API | OPTIONS | Canceladas | Errores | Página final | Indicador de carga |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Antes (F18-11, módulos cargados) | 46–47 | ≈15 | 0 | 0 | 121–220 ms | sí |
| Después (módulos y datos en caché) | 9 | 0 | 0 | 0 | ≈10 ms, `/admin/dashboard`, h1 correcto | no |
| Después en frío (cada 150 ms) | 36 | 14 | **14** | 0 | 11,8 ms, correcta | no |
| Después en frío (cada 60 ms) | 36 | 14 | **14** | 0 | 14,9 ms, correcta | no |
| Frontend anterior en frío (A/B) | 47 | 15 | 0 | 1 (400 drivers) | 172–203 ms | sí |

Ninguna condición de carrera observada: en todas las transiciones el `<h1>` y la ruta finales son los de la sección
pedida (comprobado en cada transición de todas las rondas).

## 17. Seguridad

- CORS no se abrió: origen exacto, credenciales, sin comodín y el origen ajeno sin permiso (prueba automática y verificación HTTP real).
- La caché nunca sale de la memoria de la pestaña. Su clave incluye el token, se vacía al iniciar o cerrar sesión y ante un 401, y solo existe dentro del panel ADMIN. No se cachean autenticación, notificaciones, llaves de API, auditoría, integraciones ni cuentas bancarias.
- Sin secretos en código, informes ni registros. La contraseña del ADMIN de staging se leyó a un temporal 0600 del scratchpad, que se borró.
- Datos de la aplicación modificados por las pruebas:
  - una ejecución de QA (datos sintéticos, retirados a INACTIVE);
  - la descripción de la empresa **QA 20**, editada desde la interfaz;
  - los `LOGIN`/`LOGOUT` que la app audita.

## 18. RBAC

- Backend: suites de RBAC y privilegios dentro de 2136/2136.
- Smoke y E2E por CloudFront:
  - las cifras de plataforma solo las ve el ADMIN;
  - los 3 roles no ADMIN reciben 403 al escribir ajustes o crear un ADMIN;
  - el OPERATOR recibe 403 al aprobar pagos;
  - el cliente solo se ve a sí mismo.
- Interfaz: COMPANY_ADMIN, OPERATOR y CUSTOMER (usuarios QA sintéticos) ven **«No tienes permisos»** en `/admin/dashboard`, sin ningún enlace ni dato del panel ADMIN. Sus portales cargan: Viajes, Reservas, Mis buses y Mis viajes.
- **No se cambiaron roles ni permisos.**

## 19. Multitenancy

- Backend: suites de tenancy, cross-company y reserva entre empresas dentro de 2136/2136.
- El E2E comprueba que el personal de la empresa solo ve sus reservas.
- La caché no puede mezclar empresas: solo existe en el panel ADMIN, la clave lleva el token y se vacía al cambiar de sesión.
- `/company/drivers` sigue acotado por la sesión para COMPANY_ADMIN y OPERATOR. Solo el ADMIN deja de pedirlo.

## 20. DEMO integrity

Comprobado por la API tras todos los cambios, solo con lecturas y **sin ejecutar el seed**:
- empresa **16** «BusPerú Demo» ACTIVE;
- usuarios 46 (COMPANY_ADMIN), 47 (OPERATOR) y 48 (CUSTOMER) ACTIVE;
- 4 terminales DEMO, 6 rutas y **12 viajes**;
- bus `DEMO-001` (40 plazas) con su layout publicado de 40 asientos;
- en la portada, Lima, Pucallpa, Cusco y Arequipa.

**No se modificaron ni borraron datos DEMO ni sus credenciales.** Por eso no se usó `seed-demo --verify`, que rota las contraseñas DEMO. Culqi de plataforma sigue **DISCONNECTED**.

## 21. AWS impact

- **Pila `busperu-staging-web`:** UPDATE_COMPLETE, con un único cambio en `ApiDistribution`, sin reemplazos.
- **Pila `busperu-staging`:** sin cambios.
- **EC2:** release 2026-09-25-1; la `-3` se conserva para volver atrás.
- **Sin** cambios en IAM, RDS, ALB, SG, Parameter Store, KMS, CloudTrail ni SNS.
- 12/12 alarmas de staging en OK; 0 respuestas 5xx y 0 errores de aplicación desde el despliegue.

**Rollback:**
- **Backend:** `sudo /opt/busperu/bin/deploy-release.sh <ArtifactsBucket> 2026-09-23-3` (por SSM).
- **CloudFront:** `OriginKeepaliveTimeout: 5` en `build-web-template.mjs`, y después change set y ejecución.
- **Frontend:** volver a publicar el `index.html` anterior (sus assets `index-2GKeKp9S.js` y demás siguen en el bucket) e invalidar `/*`, o hacer build y publicar el código anterior.

## 22. Cost impact

Despreciable. No se crearon recursos:
- 1 invalidación `/*` (dentro de las 1000 rutas gratuitas al mes);
- unos 2 MB más en S3 (artefacto y assets nuevos).

Las conexiones mantenidas con el origen no tienen coste. La navegación repetida hace **≈99 % menos peticiones** a la API.

## 23. Riesgos y hallazgos

| Id | Tipo | Detalle |
| --- | --- | --- |
| F1 | FINDING (medición) | La red Lima → São Paulo de CloudFront iba más lenta durante la medición posterior (API 98 → 145 ms; la distribución web, sin cambios, también). Las cifras absolutas de primera visita no son comparables directamente; se aporta el A/B a la misma hora. |
| F2 | FINDING (rendimiento) | La **primera visita** sigue costando 380–510 ms: cada URL nueva paga preflight + GET, y `max-age` solo sirve desde la segunda vez. La solución de fondo es servir la API en el mismo origen (`/api` en la distribución web), un cambio de arquitectura **no implementado** (§24). |
| F3 | FINDING (baseline) | El «944/944» de seguridad de F18-08 no es reproducible. Se fija una lista explícita de 33 archivos (932 → 933). |
| F4 | FINDING (repositorio) | `make-release.sh` deja `infra/aws/.releases/busperu-2026-09-25-1.tar.gz` dentro del repositorio **sin `.gitignore`**. No se borró; conviene ignorarlo antes de cualquier commit. |
| F5 | Pendiente | Restos QA **sin purgar** (la fase lo prohíbe): la ejecución de las 02:18Z (manifiestos en el scratchpad `f1811b/qa/`), más la de las 22:21Z (`qa-manifest-e2e-mug3ixsf.json` en la raíz). La empresa QA 20 quedó con la descripción editada desde la interfaz. |
| F6 | LOW (ya conocido) | `/public/stats` cuenta rutas y terminales de empresas inactivas (hoy 11 rutas y 10 terminales con los restos QA). |
| F7 | NOT MEASURED | La mejora aislada del keep-alive no se pudo separar de la variación de la red (§9). |
| R1 | Riesgo | Datos hasta 30 s obsoletos en el panel si **otro** usuario o el planificador los cambia (las escrituras propias invalidan al instante). Es aceptable para el panel; si molesta, hay que bajar el TTL. |
| R2 | Riesgo | La invalidación es total ante cualquier escritura: es correcta pero vacía también listados no afectados. Es un coste menor. |
| R3 | Riesgo | Si CORS se restringe en el futuro, los navegadores podrían seguir usando la política anterior hasta 2 h (`max-age`). |

## 24. Trabajo futuro (no implementado; solo documentado)

1. **API en el mismo origen:** comportamiento `/api/*` en la distribución web, con una CloudFront Function para el fallback del SPA en lugar de páginas de error. Elimina **todos** los preflights, incluidos los de la primera visita. Es un cambio de arquitectura: requiere decisión y fase propia (reabre H-3 de F18-09).
2. **Mostrar datos cacheados vencidos mientras se refrescan** (*stale-while-revalidate*). Evitaría el indicador de carga también al volver tras más de 30 s.
3. **Invalidación selectiva** por recurso en lugar de total.
4. **Endpoint ligero** para listas auxiliares (hoy `limit=200` se corta a 100).
5. `.gitignore` para `infra/aws/.releases/` y purga autorizada de los restos QA.
6. TanStack Query, Service Worker, SSR y similares: **no necesarios** con los datos actuales.

## 25. Git status

Sin commit, sin push, sin reset ni clean. HEAD sigue en `e71a1b1` (`master`).

```
$ git status --short | wc -l
250          # 243 antes + los 5 archivos nuevos de §5 + 2 archivos versionados que pasan a estar modificados

$ git diff --stat | tail -1
 110 files changed, 3860 insertions(+), 1102 deletions(-)      # antes: 107 archivos, +3650/−1069
```

Archivos de esta fase (ver §5):
- versionados y modificados: `backend/src/app.ts`, `backend/src/server.ts`, `frontend/package.json`, `frontend/src/services/api.ts`, `frontend/src/hooks/useAsync.ts`, `frontend/src/hooks/useList.ts`, `frontend/src/layouts/index.tsx`, `frontend/src/layouts/PortalLayout.tsx`, `frontend/src/routes/index.tsx` y `frontend/src/pages/modules/TripPages.tsx`;
- nuevos o no versionados: `backend/src/config/http-server.ts`, `backend/src/test/82-f1811b-http-keepalive.test.ts`, `backend/src/test/74-cors-cabeceras-seguridad.test.ts` (ya estaba sin versionar; se le añadió 1 prueba), `frontend/src/services/response-cache.ts` y su test, `frontend/src/routes/admin-chunks.ts`, y bajo `infra/` y `docs/` la plantilla, su comprobador, el tarball de la release (F4) y este informe.

El diff grande de `frontend/src/routes/index.tsx` y de otros archivos es anterior a esta fase (finales de línea LF/CRLF y
cambios de fases previas). Esta fase añade unas 210 líneas.
