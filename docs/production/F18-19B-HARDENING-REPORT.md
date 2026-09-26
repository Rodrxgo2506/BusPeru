# F18-19B — HARDENING REPORT

> Fase F18-19B: corrección de los findings F-01…F-06 de F18-19A en código, configuración y documentación, desplegada
> y validada **solo en STAGING**.
> Producción: **NOT DEPLOYED**. Sin commit ni push. Cuenta AWS mostrada como 6578****68. Sin secretos, tokens,
> IPs de operador ni credenciales DEMO.

## 1. Estado final

**PASS**

- Los seis findings están corregidos y probados, en local y en staging.
- Tests, build, staging, regresión de F18-16, smoke y E2E en verde.
- Limpieza de QA hecha con la purga oficial ampliada; DEMO intacto; producción intacta.
- Siguen abiertos solo los pendientes **legales y comerciales** de producción (§11), que no son findings técnicos de esta fase.

## 2. Git

| | |
| --- | --- |
| HEAD | `4213568d3ffe6ba25527feb6c84f2afb28b81525` |
| origin/master | `4213568d3ffe6ba25527feb6c84f2afb28b81525` |
| Working tree | cambios de F18-19B sin commit (lista en §3 y §12) + dos archivos nuevos (`frontend/src/utils/seo.ts` y `seo.test.ts`) + este informe |
| Fuera de Git, sin tocar | los 5 heredados (`F18-12-COMMIT-PREP.md`, `F18-12A-…`, `F18-12B-…`, `F18-12C-…`, `qa-manifest-e2e-mug3ixsf.json`) y `F18-19A-STAGING-QA-REPORT.md` (informe de la fase anterior, tampoco versionado) |
| Commit / push | **no realizados** |

## 3. Findings

### F-01 · MEDIUM · Caché de errores de la API en CloudFront — **CORREGIDO**

**Análisis previo:**

- La distribución de la API usa `ApiCachePolicy`: MinTTL 0, DefaultTTL 0, MaxTTL 1, y la clave incluye `Authorization` y toda la query. Las respuestas correctas no se cachean (o como mucho 1 s si el origen lo pide).
- F18-16 no depende de CloudFront: su caché SWR vive en el navegador.
- La distribución **no definía `CustomErrorResponses`**, así que CloudFront aplicaba su caché de errores por defecto (10 s) a 400, 403, 404, 405, 414, 416 y 5xx.

| | |
| --- | --- |
| Causa | caché de errores por defecto de CloudFront. Las respuestas de la API no llevan `Cache-Control` |
| Opciones | **A** `Cache-Control: no-store` en la API. **B** `ErrorCachingMinTTL: 0` en la distribución de la API |
| Decisión | **B**: actúa solo sobre errores, no toca las respuestas correctas ni el código de la API, y es la misma técnica que ya usa la distribución web (fallback del SPA con TTL 0). A habría cambiado todas las respuestas `/api/*` sin necesidad |
| Cambio | la distribución de la API define `CustomErrorResponses` para los 11 códigos cacheables con `ErrorCachingMinTTL: 0` y **sin** `ResponsePagePath` ni `ResponseCode`: el error llega tal cual y nunca se convierte en `index.html` |
| Archivos | `infra/aws/cloudformation/build-web-template.mjs` (constante `API_ERROR_CODES` y la distribución), `busperu-staging-web.json` (regenerada), `check-web-template.mjs` (regla nueva). Igual en `build-prod-web-template.mjs`, `busperu-prod-web.json` y `check-prod-templates.mjs` (**solo la plantilla: producción no se despliega**) |
| Checkers | la regla anterior («la API no puede tener `CustomErrorResponses`») pasa a exigir los 11 códigos con TTL 0 y sin página de sustitución. Probado con mutaciones: TTL 10 → falla; página `/index.html` → falla (en staging y en producción) |
| Endpoints afectados | todas las respuestas de error de `/api/*` por CloudFront (antes se guardaban ≈10 s y ahora no). Las respuestas 2xx no cambian |
| Despliegue en staging | change set `f1819b-api-error-ttl` sobre `busperu-staging-web`: **1 × Modify ApiDistribution, Replacement=False** (verificado antes de ejecutar); `UPDATE_COMPLETE` en 64 s; distribución `Deployed` |

**Antes y después, en staging** (mismo slug inexistente pedido 3 veces, con 1 s entre peticiones):

| | 1.ª | 2.ª | 3.ª |
| --- | --- | --- | --- |
| Antes | 404 · `X-Cache: Error from cloudfront` · sin `Age` | 404 · **`Age: 1`** | 404 · **`Age: 2`** |
| Después | 404 · `Error from cloudfront` · sin `Age` | 404 · sin `Age` | 404 · sin `Age` |

«Error from cloudfront» solo indica que la respuesta es un error; que no aparezca `Age` indica que llegó del origen.

**Prueba específica (A–E) con el flujo real, en `qa-f1819b.mjs`:**

1. perfil de QA creado → `GET /public/companies/<slug>` → **404** (sin aprobar);
2. envío y aprobación por el ADMIN;
3. `GET` **inmediato**, sin espera → **200** · `X-Cache: Miss from cloudfront` · sin `Age` · sin `Cache-Control` · ETag presente · `Via` de CloudFront;
4. suspensión → 404; levantar → `GET` inmediato → **200** (`Miss from cloudfront`, sin `Age`).

En F18-19A estos mismos pasos daban 404 durante ~10 s.

### F-02 · MEDIUM · Logo y nombre tapados por la portada — **CORREGIDO**

| | |
| --- | --- |
| Causa (verificada en el DOM) | la portada es un elemento posicionado (`relative`) y el bloque del logo y el nombre subía con margen negativo sin estar posicionado. Por el orden de pintado, la portada quedaba encima. No había otra causa: la barra del sitio es `z-40` y la navegación de secciones `z-20` |
| Cambio | el bloque pasa a `relative z-10` (queda por debajo de ambas barras). **Solo el logo** sube sobre la portada; el nombre, el lema y los botones quedan debajo, sobre fondo claro (en oscuro sobre la portada no se leería) |
| Archivo | `frontend/src/components/company-profile/CompanyProfileView.tsx` |
| Prueba | `layout-f02.mjs`: en 6 tamaños (360, 375, 768, 1024, 1440, 1920) comprueba con `elementFromPoint` en 5 puntos que nada tapa el logo ni el nombre, que el nombre no queda cortado ni bajo la portada y que no hay desbordamiento horizontal. Se usó `elementFromPoint` porque las capturas no bastan para asegurar la superposición |
| Control | con el componente **original** la misma prueba falla (logo tapado en todos los tamaños; en 768 el nombre oculto por completo) |
| Local | 4 variantes × 6 tamaños: con/sin portada y con/sin logo → 24/24 |
| Staging | con portada sin logo · con portada y logo · sin portada con logo → **18/18**, 0 errores de consola; capturas revisadas en escritorio, tablet y móvil |

### F-03 · LOW · La purga oficial no contemplaba F18-19 — **CORREGIDO**

| | |
| --- | --- |
| Cambio | `infra/aws/scripts/purge-qa-data.cjs`: el conjunto derivado de las raíces del manifiesto incluye lo siguiente |
| Archivos | `infra/aws/scripts/purge-qa-data.cjs`, `docs/production/STAGING-RUNBOOK.md` §9.1 |

**Qué incluye ahora el conjunto:**

- `company_profiles`, `company_services`, `company_agencies` (sus horarios y servicios por agencia son columnas JSON de la propia agencia) y `company_gallery_images` de las empresas del conjunto;
- sus **imágenes** (portada, «nosotros», servicios, agencias y galería; copia de trabajo y publicada), borradas tras el COMMIT solo bajo `public/companies/<id del conjunto>/`;
- las hojas del Libro (`complaint_book_entries`) ligadas a una empresa, un usuario o una reserva del conjunto, con sus eventos;
- el contador del año, que se borra solo si todas las hojas de ese año son del conjunto.

**Salvaguardas:**

- La hoja debe ser de un consumidor sintético (`@busperu-staging.example`). Si una hoja real está ligada a una empresa sintética, **aborta con ROLLBACK**: las hojas se conservan 2 años (DS 011-2011-PCM, art. 12).
- Una hoja ligada también a algo ajeno aborta.
- Las 7 tablas entran en los recuentos previstos y en las postcondiciones existentes (que abortan ante cualquier fila perdida no prevista).
- `audit_logs` sigue intocable y el DEMO sigue protegido por `ES_DEMO`.

**Prueba local** (MariaDB 10.11 portátil, base local `busperu_staging`; el script exige ese nombre y la salvaguarda no se relajó): `ensayo-purga.mjs`, **11/11**.

| Escenario | Resultado |
| --- | --- |
| A · conjunto QA completo (perfil, 2 servicios, agencia, galería, 6 imágenes en disco, 2 hojas, 4 eventos) | ensayo = ROLLBACK sin cambios; ejecución = COMMIT, nada del conjunto queda, 6 imágenes borradas, carpeta retirada, contador conservado (el año tiene una hoja ajena) |
| B · hoja de un consumidor real ligada a una empresa QA | **aborta**: «hojas del Libro de consumidores reales ligadas al conjunto (se conservan 2 años)», sin borrar nada |
| C · año cuyas hojas son todas de QA | contador de ese año retirado; el otro intacto |
| DEMO (empresa, perfil, servicio, hoja real y contadores) | idéntico antes y después |

**Prueba en staging:** ensayo y ejecución con datos QA reales de esta fase (§8).

Se probó con un harness fuera del repositorio porque la salvaguarda del script exige una base llamada `busperu_staging`, que no existe en la batería del backend.

### F-04 · LOW · Documentación de la galería — **CORREGIDO**

- **Implementación real:** la API `/public/companies/:slug/gallery` y la vista solo paginan (12 por página, «Ver más», orden de la empresa, visor). La categoría se guarda y se usa como texto alternativo. **No hay filtro por categoría.**
- **Referencias corregidas (todas las que había):**
  - `F18-19-CONTENT-MODEL.md` §5 (tabla del público);
  - `F18-19-IMPLEMENTATION-REPORT.md` §1.1 (descripción de la galería);
  - la misma §3 (`?page&category` → `?page`).
- No se implementó ningún filtro nuevo.

### F-05 · LOW · Canonical y SEO — **CORREGIDO**

| | |
| --- | --- |
| Estrategia | URL canónica = **origen real de la página** (`window.location.origin`) + ruta, sin query ni `#`, sin barra final salvo en la raíz. Staging apunta a staging y producción, a su propio dominio. No hay ningún dominio escrito en el código ni hace falta una variable de entorno nueva |
| Cambios | `<link rel="canonical">` en todas las rutas públicas (`useCanonicalLink` en `PublicLayout`, restaurado al salir). `og:url` y la `url` del JSON-LD del perfil pasan a la URL canónica (antes, `location.href`, con `#agencias` o parámetros). Títulos y descripciones propios en `/ayuda` («Centro de ayuda y preguntas frecuentes \| BusPerú») y `/empresas` («Empresas de transporte interprovincial \| BusPerú») |
| Archivos | `frontend/src/utils/seo.ts` (nuevo), `seo.test.ts` (nuevo, 2 tests), `hooks/usePageMeta.ts`, `layouts/PublicLayout.tsx`, `pages/public/CompanyProfilePage.tsx`, `pages/public/InfoPages.tsx`, `package.json` (script de tests) |
| Staging | `/empresas/<slug>#agencias` → canonical, `og:url` y JSON-LD `url` = `https://d25z2lpl1efut1.cloudfront.net/empresas/<slug>`. `/ayuda?utm=x` y `/empresas?utm=x` → título propio, descripción, `og:title`, `og:description` y canonical sin query. Portada → `…/`. 11 rutas públicas con su canonical de staging. Ninguna URL apunta a otro dominio |

### F-06 · LOW · Ids numéricos en la respuesta pública — **CORREGIDO** (con una excepción justificada)

**Análisis de consumidores:**

- `company.id`: se usa en «Buscar viajes» y «Ver viajes» (`/buscar?company_id=…`, contrato del buscador existente) y ya era público antes de F18-19 (`/public/companies`, resultados de búsqueda).
- Ids de servicios, agencias, galería y opiniones: solo servían de clave de lista y de estado de la interfaz.
- `location_id` de la agencia: la vista pública no lo usaba; solo el formulario del panel.

| | |
| --- | --- |
| Cambio (mínimo) | la respuesta pública ya no lleva el `id` de servicios, agencias ni fotos, ni el `location_id` de las agencias, ni el `id` de las opiniones. La vista previa y el panel de la empresa, y la moderación, **conservan** sus ids (hacen falta para editar). El frontend identifica los servicios por posición, las agencias por posición y las fotos por su archivo (nombre aleatorio de 32 hex, único). Las opiniones usan la posición en una lista que solo crece |
| Excepción justificada | `company.id` se mantiene: lo requiere el contrato del buscador y ya era público. Cambiarlo por el slug obligaría a cambiar la API de búsqueda, fuera del alcance de «cambio mínimo» |
| Archivos | `backend/src/services/company-profile.service.ts`, `frontend/src/components/company-profile/CompanyProfileView.tsx`, `frontend/src/types/company-profile.ts`, `backend/src/test/83-f1819-perfil-empresas.test.ts` |
| Tests | prueba nueva en 83: servicios, agencias, galería (también paginada) y opiniones sin `id`; agencias sin `location_id`; la vista previa conserva los ids. La prueba de agencia completa buscaba la agencia pública por id y ahora la busca por nombre (cambio de contrato buscado) y además comprueba la ausencia de `id` y `location_id` |
| Staging | las pestañas de servicios, el «Ver en mapa» por agencia (un solo mapa, el de la agencia pulsada), «Ocultar mapa» y el visor (abre la foto pulsada) funcionan, sin avisos de React por claves. JSON público: ningún elemento con `id` |

## 4. Tests

| Suite | Resultado |
| --- | --- |
| Backend completo, MariaDB 10.4 | **2195/2195** (antes 2194; +1, la prueba de F-06) |
| Backend completo, MariaDB 10.11.19 | **2195/2195** |
| Seguridad (35 archivos) | **992/992** en ambos motores (antes 991; +1) |
| Frontend tests | **38/38** (antes 36; +2 de `seo.test.ts`) |
| Typecheck backend / frontend | OK / OK |
| Lint frontend | OK (0 avisos). El backend no tiene lint configurado; su typecheck pasa |
| Build de producción del frontend | OK (lo compila `publish-web.mjs`) |
| Checkers de plantillas (`check-template`, `check-web-template`, `check-prod-templates`) | PASS, con mutaciones de F-01 detectadas |
| Ensayo local de la purga | 11/11 |

No se modificó ningún test para ocultar un fallo. El único test existente que cambió (agencia completa) lo hizo por el cambio de contrato buscado de F-06, y ahora comprueba más, no menos.

## 5. Staging

| | |
| --- | --- |
| Backend release | `2026-09-26-1`, construida desde el árbol de trabajo (`4213568` + F18-19B), 178 entradas. SHA-256 verificado por `deploy-release.sh`; `2026-09-25-2 → 2026-09-26-1`; `/api/ready` 200 (la vuelta atrás automática no hizo falta) |
| Frontend | `publish-web.mjs --env staging --release 2026-09-26-1`: simulación y después `--ejecutar`; 106 archivos con el mismo tamaño y MD5; `Content-Type` y `Cache-Control` correctos; 554 objetos anteriores conservados; invalidación de `/` y `/index.html` completada; staging sirve `index-BxRACTrl.js` |
| `/api/ready` | 200 `{"status":"ready"}` |
| CloudFront | API `d1lfpi7fp62ntk`: F-01 aplicado (`CustomErrorResponses` 11 × TTL 0), `Deployed`. Web `d25z2lpl1efut1`: solo contenido. Allowlists sin cambios |
| ALB / EC2 | `busperu-staging-alb` sin cambios; EC2 `i-096d4caac0e479052` con la release nueva, servicio `active` |
| Migraciones | ninguna (F18-19B no cambia el esquema) |

## 6. F18-16

Misma herramienta y escenarios que el cierre de F18-16 (`lab.mjs`, modo staging); comparación con la medición final de F18-16 en staging.

| Escenario | Métrica | F18-16 | F18-19B |
| --- | --- | --- | --- |
| Primera visita (11) | mediana útil / p90 (ms) | 8,7 / 20,4 | 7,4 / 18,9 |
| Uso realista, 32 s (11) | mediana / p90 | 7,3 / 16,6 | 5,7 / 17,6 |
| Vueltas calientes (22) | mediana / p90 | 6,0 / 17,3 | 5,7 / 17,2 |
| Todas | esqueletos · pantalla en blanco · errores HTTP | 0 · 0 · 0 | 0 · 0 · 0 |
| Todas | peticiones API por navegación (primera / realista / calientes) | 0,09 / 2,73 / 1,05 | 0,09 / 2,73 / 1,05 |
| Todas | `OPTIONS` | 0 | 0 |
| Todas | peticiones totales · `unread-count` · `drivers` | 54 · 7 · 0 | 54 · 7 · 0 |
| Navegación rápida (8 clics a 150 ms) | peticiones · canceladas · errores | 1 · 0 · 0 | 1 · 0 · 0 |
| Carga en frío del Dashboard | útil (ms) · peticiones | 1695 · 6 | 1606 · 6 |
| Consola | errores | 0 | 0 |

- **SWR:** con datos en caché, ninguna transición mostró esqueleto; el contenido anterior se conserva mientras revalida.
- **Caché ligada a la sesión, limpieza en logout y en 401:** la batería E2E hace logout → token revocado → nuevo login y pasa. Los tests de F18-16 (`response-cache` y `refresh-status`) están dentro de los 38/38.
- **F18-16 sin regresión.** No se tocó ningún archivo de F18-16.

## 7. QA

| Batería | Resultado |
| --- | --- |
| QA funcional F18-19 en staging (`qa-f1819b.mjs`) | **51/51** · 164 peticiones · 0 × 5xx. Incluye F-01 (200 inmediato tras aprobar y al levantar la suspensión) y F-06 |
| Smoke de staging | **37/37** |
| E2E de staging | **18/18** |
| E2E «expiry» | **1/1**: la reserva de prueba caducó sola y liberó el asiento |
| F-02 (maquetación) | **18/18** en staging |
| F-05/F-06 (interacción + SEO) | **13/13** en staging |
| Interfaz (`ui-f1819.mjs`, CSP de producción inyectada) | 33 cargas en 3 tamaños + perfil + 4 paneles: 0 errores de consola, 0 violaciones de CSP, 0 desbordamientos, 0 errores de red. Única «incidencia»: el 404 esperado del slug inexistente. Mapa: 0 iframes → 1 al pulsar (OSM 200, `sandbox`) |

**Funcionalidad de F18-19 revalidada en staging:**

- `/api/ready` y el perfil público con sus 9 secciones;
- agencias, servicios y horarios; mapa y galería;
- moderación (aprobar, rechazar con motivo, suspender, cambiar slug, auditoría) y COMPANY_ADMIN;
- Libro de Reclamaciones: `LR-2026-000001`/`000002`, consulta con el mismo 404 ante datos incorrectos y rate limit 429;
- páginas legales, SEO, responsive, consola y red.

## 8. Cleanup

**Creado en esta fase (todo sintético, en staging):**

| Origen | Marca | Empresas | Usuarios | Otros |
| --- | --- | --- | --- | --- |
| QA F18-19B | `qamuif4fy9` | 32 (A), 33 (B) | 91, 92, 93 | ubicaciones 56–57 · tipos 27 · bus 29 · ruta 43 · viaje 49 · perfiles 2 · servicios 2 · agencias 3 · fotos 3 · logo 1 · hojas `LR-2026-000001/2` (ids 3 y 4) · 8 eventos · contador 2026 |
| Smoke oficial | (del manifiesto) | 1 | 3 | ubicaciones, tipos, bus, viaje, reserva… |
| E2E oficial | (del manifiesto) | 1 | 3 | itinerario, pago manual, reserva caducada… |

**Limpieza con la purga OFICIAL ampliada (F-03 en uso real)** mediante `qa-staging.sh purgar` con los 3 manifiestos:

1. **Ensayo** (ROLLBACK). A borrar:
   - raíces: empresas 4, usuarios 9, ubicaciones 6, tipos 3 + 3;
   - rutas 4, viajes 4, buses 3, reservas 5, grupos 1, pagos 1, asientos reservados 5, movimientos 3, distribuciones 3, pisos 3, elementos 1, asientos 14, vínculos 7, comisiones 4, llaves de API 1, notificaciones 10, sesiones revocadas 11;
   - **F18-19:** perfiles 2, servicios 2, agencias 3, fotos 3, hojas 2, eventos 8, contador 1;
   - imágenes del perfil 5.
2. **Ejecución**: **COMMIT** con exactamente esos recuentos (postcondiciones superadas); **6 archivos** borrados (5 imágenes del perfil + el logo QA) y **2 carpetas vacías** retiradas.

Antes, un ensayo solo con el manifiesto de F18-19B dio los mismos recuentos de F18-19 (ROLLBACK).

**Después:**

| | Antes de la limpieza | Después |
| --- | --- | --- |
| Empresas · usuarios · viajes · reservas | 4 · 10 · 15 · 5 (con QA de esta fase) | **2 · 7 · 14 · 5** (igual que al empezar) |
| Tablas de F18-19 | 2 · 2 · 3 · 3 · 2 · 8 · 1 | **0** en las 7 |
| Archivos en `public/companies/` | 6 (empresa 32) | **ninguno** |
| `legal.*` | NULL | NULL |
| `audit_logs` | se conserva (la purga no lo toca; los registros quedan con el usuario a NULL) | 1518 |
| Huella del esquema | idéntica a la referencia F18-19 | **idéntica** (645/253/96/25) |

**DEMO:** huella de filas (MD5 de id, nombre, estado y `updated_at`) de empresa (1), usuarios (3), viajes (12) y reservas (1) **idéntica antes y después** de la limpieza.

La huella de los viajes DEMO difiere de la del cierre de F18-19A porque sus estados y `updated_at` los actualiza el planificador con el paso del tiempo. Por eso la comparación válida es la de dentro de esta fase.

**Otras limpiezas:**

- Change set de CloudFront ejecutado; no queda ninguno pendiente.
- Temporales de credenciales borrados.
- Base local de ensayo de la purga (MariaDB portátil) retirada.

## 9. Seguridad

| Control | Resultado en staging |
| --- | --- |
| Tenant isolation | `?company_id=` ajeno ignorado (tenant del token); `company_id` en el cuerpo → 422; ver, editar, enviar, borrar o activar un elemento ajeno → 404 (5/5); la lista de B no contiene datos de A; hojas del Libro ajenas → 404; moderación y Libro ADMIN como empresa → 403 |
| XSS | HTML en textos del perfil y del Libro → 422 |
| URLs | `http://` → 422; red social en un dominio ajeno → 422 |
| Imágenes | SVG, MIME incoherente, «.png» falsa, 10×10, 9000×9000 y 6 MB → 400; PNG válido → 200 |
| Rate limiting | Libro → 429 al llegar a `RateLimit-Limit: 20` |
| Datos públicos | sin placa, código, `plate_number`, `moderation_note`, `reviewed_by`, `published_content`, `legal_name`, `tax_id`, `location_id` ni ids de elementos (F-06) |
| Caché de errores | los errores de la API ya no se guardan en CloudFront (F-01), así que un error no puede servirse a otro usuario desde caché |
| Batería automatizada | 992/992 |

## 10. Producción

**NOT DEPLOYED**

```
PRODUCTION_DEPLOYED=NO
PRODUCTION_DATABASE_CHANGED=NO
PRODUCTION_INFRA_CHANGED=NO
```

Comprobado explícitamente al terminar (solo lectura):

- **Recursos:** ningún stack `busperu-prod*`; RDS, EC2, ALB y CloudFront solo de staging; 0 parámetros `/busperu/prod/*`; 0 certificados ACM; 0 zonas Route 53.
- **SNS:** los temas `busperu-prod-alarms` y `busperu-prod-security` son del stack `busperu-security-baseline` (2026-09-24) y no se tocaron.
- **CloudTrail del día, escrituras en `sa-east-1`:** `CreateChangeSet` y `ExecuteChangeSet` (sobre `busperu-staging-web`) y `SendCommand` (EC2 de staging).
- **CloudTrail en `us-east-1` (CloudFront):** un `UpdateDistribution` (la de la API de staging, por el change set) y un `CreateInvalidation` (web de staging).
- **Plantilla de producción:** `busperu-prod-web.json` se regeneró con F-01, pero **no se desplegó**.

## 11. Pendientes

### Blockers técnicos
Ninguno.

### Medium (técnicos)
Ninguno abierto: F-01 y F-02 corregidos.

### Low (técnicos) y observaciones
- **`publish-web.mjs`** (F18-18) emite el aviso de Node `DEP0190` por usar `shell: true` al compilar. No afecta al resultado. Revisar en una fase de mantenimiento.
- **Página de slug inexistente** (`/empresas/<no-existe>`): responde con el título genérico y un `canonical` a sí misma, porque el SPA responde 200. Se podría añadir `noindex` en esa vista. Mejora menor, no pedida.
- La prueba de purga (`ensayo-purga.mjs`) vive fuera del repositorio porque el script exige una base `busperu_staging`. Si se quiere en CI, habría que preparar una base con ese nombre en un MariaDB efímero.

### Producción (legales y comerciales, sin cambios en esta fase)
1. Datos reales del titular (`legal.*` sigue en NULL).
2. Revisión jurídica de los textos.
3. Resend LIVE (sin él no se entregan la copia ni la respuesta del Libro; en staging siguen `copy_emailed=false` y `response_emailed_at=NULL` por diseño).
4. B-11, comisión de la plataforma.
5. Feriados nacionales en el cómputo de días hábiles.

Nota para el despliegue de producción (cuando se autorice): la plantilla `busperu-prod-web` ya incluye la corrección de F-01, así que no hace falta ningún paso adicional.

## 12. Archivos de F18-19B (para un commit futuro, si se autoriza)

**Modificados:**

- backend: `backend/src/services/company-profile.service.ts`, `backend/src/test/83-f1819-perfil-empresas.test.ts`;
- frontend: `frontend/package.json`, `frontend/src/components/company-profile/CompanyProfileView.tsx`, `frontend/src/hooks/usePageMeta.ts`, `frontend/src/layouts/PublicLayout.tsx`, `frontend/src/pages/public/CompanyProfilePage.tsx`, `frontend/src/pages/public/InfoPages.tsx`, `frontend/src/types/company-profile.ts`;
- infraestructura: `infra/aws/cloudformation/build-web-template.mjs`, `build-prod-web-template.mjs`, `busperu-staging-web.json`, `busperu-prod-web.json`, `check-web-template.mjs`, `check-prod-templates.mjs`, `infra/aws/scripts/purge-qa-data.cjs`;
- documentación: `docs/production/F18-19-CONTENT-MODEL.md`, `F18-19-IMPLEMENTATION-REPORT.md`, `STAGING-RUNBOOK.md`.

**Nuevos:** `frontend/src/utils/seo.ts`, `frontend/src/utils/seo.test.ts` y este informe.

**Excluidos:** los 5 heredados, `F18-19A-STAGING-QA-REPORT.md` (decidir aparte), `.env`, releases (`infra/aws/.releases/`, ignorado), manifiestos de QA, logs y artefactos temporales (fuera del repositorio).
