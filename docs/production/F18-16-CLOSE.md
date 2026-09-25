# F18-16 — Cierre: caché stale-while-revalidate del panel ADMIN

> Solo STAGING; producción no se tocó. Sin cambios en backend, base de datos, IAM, CloudFront, ALB ni en la lista de
> IPs. Sin secretos, tokens ni IPs reales en este documento. El commit que contiene este archivo es
> `perf(admin): add stale-while-revalidate navigation cache`.

## 1. Objetivo

Cerrar F18-16: revisar el diff y la lógica SWR, probar la caché (invalidación, paginación, filtros, sesión,
cancelación), purgar solo los datos QA sintéticos, pasar la regresión completa, publicar en `origin/master` y
verificar staging.

## 2. Causa raíz

La caché de F18-11B era «fresca o nada» (30 s). En el uso real, con más de 30 s por pantalla, cada sección se
montaba vacía, mostraba el esqueleto y esperaba a la red. En staging eso daba una mediana de 218 ms y 11/11
navegaciones con esqueleto. La primera visita a cada sección pagaba además el preflight CORS: mediana 342 ms.

Detalle en `F18-16-ADMIN-NAV-SWR.md`.

## 3. Cambios realizados

- Caché SWR: fresca 30 s y utilizable hasta 10 min.
- Pintado antes del primer fotograma.
- Revalidación en segundo plano tras 250 ms.
- Precarga de chunks y datos, que cede el paso a las lecturas de las pantallas.
- Precarga al pasar el ratón por el menú.
- Favicon sin petición en cada navegación.
- Mensaje de red dirigido al usuario.

**Añadido en el cierre**, al revisar los 25 puntos:

| Punto | Antes del cierre | Ahora |
| --- | --- | --- |
| 23 · un dato viejo no debe parecer confirmado | solo `ResourcePage` tenía indicador; Dashboard, estadísticas y Destinos no | aviso global en la cabecera: «Actualizando…» desde el primer fotograma en que se ve un dato viejo |
| 24 · fallo al revalidar | se conservaba el contenido, pero en silencio | se conserva y la cabecera avisa: «No se pudo actualizar · se muestran los últimos datos» |
| 21/22 · otra página u otro filtro | mientras llegaba la nueva consulta se veían las filas de la anterior | solo se mantiene lo visible para la **misma** consulta; con otra consulta sin caché se muestra el esqueleto y nunca filas ajenas |

## 4. Archivos modificados

| Archivo | Tipo |
| --- | --- |
| `frontend/src/services/response-cache.ts` | caché: frescura, `maxAge`, `peek` |
| `frontend/src/services/response-cache.test.ts` | +3 tests |
| `frontend/src/services/api.ts` | ámbitos (`default` / `cache-only` / `network`), peticiones compartidas, invalidación total |
| `frontend/src/services/refresh-status.ts` (nuevo) | estado global de las actualizaciones en segundo plano |
| `frontend/src/services/refresh-status.test.ts` (nuevo) | 4 tests |
| `frontend/src/hooks/useList.ts` | SWR, misma consulta, aviso |
| `frontend/src/hooks/useAsync.ts` | SWR, reinicio al cambiar de entidad, aviso |
| `frontend/src/layouts/index.tsx` | activación de la caché en el render de `AdminLayout`, precarga |
| `frontend/src/layouts/PortalLayout.tsx` | `onNavIntent` y aviso en la cabecera |
| `frontend/src/routes/admin-chunks.ts` | chunks de todas las entradas del menú ADMIN |
| `frontend/src/routes/admin-prefetch.ts` (nuevo) | precarga de datos y chunks |
| `frontend/src/context/BrandingContext.tsx` | favicon `data:,` sin configurar |
| `frontend/src/components/ui/States.tsx` | texto del error de red |
| `frontend/package.json` | `refresh-status.test.ts` en `npm test` |
| `docs/production/F18-16-ADMIN-NAV-SWR.md`, `docs/production/F18-16-CLOSE.md` | informes |

Son 11 archivos modificados (+559/−116) y 5 nuevos (3 de código y test, y los 2 informes). `ResourcePage` quedó
**sin cambios**: su indicador local se sustituyó por el aviso global. Fuera del commit quedan
`qa-manifest-e2e-mug3ixsf.json` y los informes de proceso F18-12*.

## 5. Estrategia SWR

1. **Lectura inmediata.** Cada hook consulta primero la caché con `cache-only`, que acepta datos frescos o viejos y nunca va a la red. Lo que encuentra lo aplica con `flushSync` en `useLayoutEffect`, antes de que el navegador pinte.
2. **Dato fresco** (menos de 30 s): nada más.
3. **Dato viejo** (entre 30 s y 10 min): aviso «Actualizando…» y revalidación con `network` 250 ms después. Se cancela si el usuario se va antes, así que la navegación rápida no dispara peticiones.
4. **Sin dato** (o más de 10 min): esqueleto y lectura normal.
5. **Escrituras** (POST, PUT, PATCH, DELETE), login, logout, 401 y desactivación de la caché: se vacía todo, incluidas las peticiones compartidas en vuelo. Además, la generación impide guardar una lectura iniciada antes de la invalidación.

## 6. Controles de seguridad de la caché

- La clave es **token + URL completa**, con ruta y todos los parámetros: dos sesiones, dos páginas o dos filtros nunca comparten entrada.
- Solo se cachean lecturas GET de rutas permitidas del panel, y **solo respuestas correctas**: 401, 403, 404 y 5xx nunca se guardan.
- La caché solo se activa dentro de `AdminLayout`, que únicamente se renderiza para ADMIN, y se desactiva y vacía al salir.
- Vive solo en memoria de la pestaña: nada va a `localStorage` ni a `sessionStorage`.

## 7. Pruebas específicas (laboratorio: build de producción, base de test, 120 ms de RTT)

| Prueba | Resultado |
| --- | --- |
| A · fresco: volver antes de 30 s | PASS: 0 GET, contenido en 5 ms, sin esqueleto |
| B · viejo (frescura escalada a 3 s) | PASS: contenido en 4,4 ms, sin esqueleto, «Actualizando», revalidación 257 ms después |
| C · caducado (vida máxima escalada a 12 s) | PASS: no se pinta el dato caducado; esqueleto y GET |
| D · editar desde la interfaz | PASS: tras guardar y tras volver se ve el dato nuevo |
| E · eliminar desde la interfaz | PASS: desaparece y no reaparece al volver |
| F · paginación 1 → 2 → 1 | PASS: 10 + 2 filas, vuelta idéntica, **0 fotogramas con mezcla** |
| G · búsqueda A → B → A | PASS: 9 / 3 / 9 filas; tras el debounce, 0 fotogramas con filas de B |
| K · la revalidación falla | PASS: se conservan las filas y aparece «No se pudo actualizar» |
| H · logout y login, cambio de sesión | PASS (script de seguridad 8/8) |
| I · 401 | PASS (caché vacía y sesión fuera) |
| COMPANY_ADMIN / OPERATOR / CUSTOMER | PASS: la caché no se activa ni guarda nada |
| J · 8 clics rápidos | PASS: sección final consistente y sin errores. En frío, 14 lecturas canceladas de páginas abandonadas; en caliente, 3 peticiones (≤ 10) |
| Errores de consola en todas las pruebas | 0 |

Los TTL escalados de B y C se probaron en un build de laboratorio (3 s y 12 s) con **el mismo código**. El valor de
producción (30 s y 10 min) lo cubre además el test unitario de `response-cache`.

## 8. Limpieza de datos QA en staging

Herramienta: `qa-staging.sh purgar`, que ejecuta `purge-qa-data.cjs` en la EC2 por SSM sobre **`busperu_staging`**.
La herramienta rechaza cualquier otra base; la base `busperu` no interviene. Primero hizo un ensayo con ROLLBACK
(sin discrepancias) y después la ejecución con **COMMIT**.

- **Manifiestos (8):**
  - F18-11B, ejecución 02:18Z (smoke + E2E);
  - F18-16, ejecuciones 17:48Z, 18:00Z y 18:59Z (smoke + E2E).
- **Marcas:** `mugc18m8`, `mugc0w83`, `muh98zzy`, `muh98ns1`, `muh9nl3x`, `muh9nawe`, `muhbrrxr`, `muhbrgb0`.
- **IDs raíz:**
  - empresas 20–27;
  - usuarios 58–81, todos `@busperu-staging.example`, ninguno ADMIN;
  - ubicaciones 34–49;
  - tipos de bus 16–23;
  - tipos de asiento 16–23.
- **302 filas en 22 tablas:** companies 8, users 24, locations 16, bus_types 8, seat_types 8, routes 12, trips 12, buses 8, bookings 20, booking_groups 4, payments 4, booking_seats 20, financial_transactions 12, bus_layouts 8, bus_layout_decks 8, bus_layout_elements 4, seats 40, company_users 16, company_commission_settings 8, api_keys 4, notifications 37, revoked_sessions 21.
- **Almacenamiento:** 4 carpetas vacías de logotipo retiradas (`public/companies/20, 22, 24, 26`).
- **`audit_logs`** no se toca: el `user_id` pasa a NULL por la FK y el registro se conserva.
- **Fuera del alcance:** el manifiesto `qa-manifest-e2e-mug3ixsf.json`, de una ejecución anterior a F18-11B. Queda pendiente de decisión.

**DEMO intacto** (foto antes y después, por la API):

| Elemento | Estado |
| --- | --- |
| Empresa 16 «BusPerú Demo» | ACTIVE |
| Usuarios 46, 47 y 48 (COMPANY_ADMIN, OPERATOR, CUSTOMER) | ACTIVE |
| Terminales DEMO | 4 |
| Rutas y viajes de la empresa 16 | 6 y 12 |
| Bus 14 | ACTIVE, 40 plazas |
| Destino Pucallpa | ACTIVE |

Todo idéntico antes y después. `/api/ready` y `/api/health` responden 200.

## 9. Backend

| Base | Resultado |
| --- | --- |
| MariaDB 10.4 | **2136/2136** |
| MariaDB 10.11 | **2136/2136** |

En 10.11, el primer intento terminó con 2118/2119: el proceso de Node de `55-refund-overrefund-guard.test.ts` se cayó a nivel nativo en Windows (código `0xC0000409`) antes de ejecutar ninguna prueba. Aislado dio 18/18, y la regresión completa repetida da **2136/2136 en una sola ejecución**. El backend no cambió en F18-16.

## 10. Seguridad

**933/933** en 10.4 y en 10.11 (33 archivos).

## 11. Frontend

| Comprobación | Resultado |
| --- | --- |
| Typecheck | 0 errores |
| Lint | 0 avisos |
| Tests | **26/26** (22 anteriores + 4 de `refresh-status`) |
| Build de producción | OK |

## 12. Smoke y E2E

**37/37 y 18/18** contra el build final (ejecución de las 18:59Z). Sus datos QA se purgaron en §8.

## 13. Staging

**Build servido:** `index-BxZI4lM0.js`. No `D7DjjFFG`, ni `CDg81feK`, ni un build local: la API es la de staging y no hay localhost.

**Navegación con el build final** (Chrome real, Dashboard → Empresas → Usuarios → Viajes → Reservas → Pagos → Destinos → Configuración → Dashboard → …):

| Escenario | Resultado |
| --- | --- |
| Primera visita | mediana **9,5 ms**, 0/11 con esqueleto |
| Tras 32 s en cada sección | mediana **6,3 ms**, 0/11 con esqueleto |
| Pantalla en blanco | 0 |
| Errores HTTP | 0 |
| Errores de consola | 0 |
| Navegación rápida | 2 peticiones, sin errores |

**Infraestructura:**
- ALB: 0 errores 5xx en 3 h (1363 peticiones).
- CloudWatch: 0 alarmas en ALARM; las 12 de staging en OK.

**Carga inicial del Dashboard** (A/B simétrico, `index.html` servido igual a las dos versiones):

Tres versiones intercaladas, 6 muestras cada una, con la misma sesión:

| Versión | Mediana hasta el Dashboard útil | Mediana desde `load` | Peticiones API | Chunks |
| --- | --- | --- | --- | --- |
| Anterior a F18-16 (`D7DjjFFG`) | 581,5 ms | 517,5 ms | 5 | 9 |
| F18-16 inicial (`CDg81feK`) | 557 ms | 496,5 ms | 5–6 | 9 |
| **Final (`BxZI4lM0`)** | **559 ms** | **492 ms** | 5–6 | 9 |

**Sin regresión.** Una primera tanda, con un login en cada ejecución, dio una mediana de 880 frente a 794 ms; la
tanda intercalada de tres versiones muestra que era variación de red. En esa primera tanda las mediciones
dispararon el **limitador de login de la API** (429), que funcionó como se esperaba.

## 14. Build

**Frontend:** `index-BxZI4lM0.js` (280,27 kB), desplegado con `web.py publicar`. La invalidación de CloudFront web fue `/*`. Solo staging.

## 15. Commit

`perf(admin): add stale-while-revalidate navigation cache`, el commit que contiene este archivo, sobre `3c839aa`.

## 16. GitHub `origin/master`

Push normal, sin `--force`. La verificación posterior al push (HEAD igual a `origin/master`) consta en el informe
final de la sesión.

## 17. Secret scan

`git diff --check` sin avisos. Revisé todas las líneas añadidas y los archivos nuevos en busca de claves AWS,
secretos, tokens de sesión, JWT, contraseñas, claves de Culqi y Resend, claves privadas, el ID de cuenta, las IPs
del operador, restos de laboratorio y credenciales de test: **0 coincidencias**.

## 18. Resultado final

**F18-16 — CLOSED / PASS**, con las condiciones de §15–16 verificadas tras el push.
