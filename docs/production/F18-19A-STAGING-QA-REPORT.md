# F18-19A — STAGING MIGRATION & QA

> Fase F18-19A. Solo STAGING. Producción: **NOT DEPLOYED**. Sin commit ni push.
> Fechas en UTC salvo indicación. Cuenta AWS mostrada como 6578****68. No se incluyen secretos, contraseñas,
> tokens, IPs de operador ni credenciales DEMO.

## 1. Estado final

**PASS WITH FINDINGS**

- Migraciones 020 y 021 aplicadas en staging con snapshot previo; esquema idéntico a la referencia F18-19.
- F18-19 (commit `4213568`) desplegado en staging (backend `2026-09-25-2` + frontend).
- Toda la funcionalidad validada en staging, sin 5xx y sin regresión de F18-16.
- Limpieza de QA completa; DEMO intacto; producción intacta.
- Findings sin bloqueo para staging (§20). Lo más relevante:
  - **MEDIUM:** CloudFront cachea ~10 s los 404 de la API.
  - **MEDIUM:** la portada del perfil tapa el logo y el nombre de la empresa.
- Los bloqueadores de **producción** heredados de F18-19 siguen abiertos: datos del titular, revisión jurídica, Resend LIVE y B-11.

## 2. Git

| | |
| --- | --- |
| HEAD | `4213568d3ffe6ba25527feb6c84f2afb28b81525` |
| origin/master | `4213568d3ffe6ba25527feb6c84f2afb28b81525` |
| Working tree | limpio salvo los 5 archivos heredados sin seguimiento (F18-12*, `qa-manifest-e2e-mug3ixsf.json`), que no se tocaron, y este informe (nuevo, sin versionar) |
| Commit / push | **no realizados** |

## 3. Infraestructura staging

Identificada y verificada antes de tocar nada (fase 1):

| | |
| --- | --- |
| ENVIRONMENT | STAGING |
| REGION | sa-east-1 |
| Stack | `busperu-staging` (parámetro `EnvName=staging`) + `busperu-staging-web` |
| RDS | `busperu-staging-db` · MariaDB 10.11.19 · Multi-AZ no · cifrado · protección contra borrado · backups 7 días |
| DATABASE | `busperu_staging`. Leída de `/busperu/staging/app/DB_NAME`; `DB_HOST` coincide con el endpoint de `busperu-staging-db`. La instancia RDS no tiene `DBName` propio |
| EC2 | `i-096d4caac0e479052` · `busperu-staging-app` (stack `busperu-staging`) |
| ALB | `busperu-staging-alb` |
| CloudFront | API `d1lfpi7fp62ntk.cloudfront.net` · web `d25z2lpl1efut1.cloudfront.net` |
| Usuario de migración | `busperu_migrator` (contraseña en SSM `/busperu/staging/ops/`, leída en la EC2 a un temporal 0600 que se destruye) |
| Mecanismo | `infra/aws/scripts/apply-one-migration.sh` del paquete nuevo, extraído en `/tmp/f1819a` de la EC2, ejecutado por SSM Run Command |
| Correo en staging | `MAIL_TRANSPORT=smtp` hacia `smtp.staging.busperu.invalid`: **no entrega correo a nadie** (a propósito) |

No existen recursos de producción: ningún stack `busperu-prod*`, RDS, EC2, ALB, CloudFront, parámetro
`/busperu/prod/*`, certificado ACM ni zona Route 53.

## 4. Snapshot

| | |
| --- | --- |
| Identificador | `busperu-staging-before-f18-19a-20260925` |
| RDS | `busperu-staging-db` |
| Creado | 2026-09-26T03:02:03Z (petición aceptada a las 03:01:52Z) |
| Estado | `available`, 100 %, cifrado |
| Backups automáticos | activos, retención 7 días; último automático 2026-09-25T07:06Z |

## 5. Migraciones

| Momento | Tablas | Columnas | Índices | FK | CHECK | Resultado |
| --- | --- | --- | --- | --- | --- | --- |
| Antes | 49 | 496 | 221 | 81 | 12 | exactamente 001→019: huella idéntica a la referencia anterior; 0 tablas de F18-19; 0 claves `legal.*` |
| Tras **020** | 53 | 597 | 239 | 90 | 24 | `020-company-public-profiles.sql OK`, exit 0 |
| Tras **021** | 56 | 645 | 253 | 96 | 25 | `021-complaint-book.sql OK`, exit 0 |

- Orden 020 → 021, cada una en su propia ejecución, sin `--force`.
- `apply-one-migration.sh` verificó el servidor (10.11.19, modo estricto) y el número de tablas antes de cada una.
- Sin `DROP`, `TRUNCATE` ni `DELETE`: las dos migraciones solo crean tablas y hacen `INSERT IGNORE` de 5 ajustes.
- El proyecto **no tiene tabla de control de migraciones** (decisión documentada en `MIGRATIONS.md`). El estado se determinó con la huella del esquema y la presencia de tablas y columnas.

## 6. Schema

`schema-fingerprint.cjs` del paquete `2026-09-25-2` contra `busperu_staging`:

```
✔ columnas  645 [e970d1328474]  referencia 645 [e970d1328474]
✔ indices   253 [0ab3681cfa99]  referencia 253 [0ab3681cfa99]
✔ fks        96 [5fc422fb71e2]  referencia 96 [5fc422fb71e2]
✔ checks     25 [7087d7d9c88d]  referencia 25 [7087d7d9c88d]
tablas 56 · con otra colación: 0 · columnas JSON con jsonStrings: string
✔ Esquema idéntico a la referencia (schema-reference.json).
```

**Tablas nuevas:**

- `company_profiles`, `company_services`, `company_agencies` y `company_gallery_images`. En las agencias, los servicios por agencia y los horarios semanal y especiales son columnas JSON validadas, no tablas aparte.
- `complaint_book_counters`, `complaint_book_entries` y `complaint_book_events`. La respuesta y los estados son columnas de la hoja más el historial de eventos.

**Integridad:**

- **Únicos:** `uq_company_profiles_slug`, `uq_complaint_book_code` y `uq_complaint_book_sequence` (año + número).
- **CHECK (13):** `json_valid` de las 10 columnas JSON, latitud, longitud e importe reclamado.
- **Claves ajenas (15):**
  - todas `ON UPDATE RESTRICT`;
  - `ON DELETE CASCADE` hacia `companies` y hacia la hoja;
  - `SET NULL` hacia `users`, `locations` y `bookings`.
- **Colación:** `utf8mb4_unicode_ci` en todas.

**`legal.*`:** `business_name`, `ruc`, `address`, `email` y `phone` siguen en **NULL** (públicas). No se rellenó ningún dato.

## 7. Health

| Comprobación | Resultado |
| --- | --- |
| `GET /api/ready` | 200 `{"status":"ready"}`, `no-store`, sin detalles internos. Antes y después de migrar y tras desplegar |
| Versión anterior sobre el esquema nuevo | `/public/companies`, `/public/settings` y `/public/cities` siguieron en 200 entre la migración y el despliegue |
| Despliegue backend | `deploy-release.sh`: artefacto verificado por SHA-256, `2026-09-25-1 → 2026-09-25-2`, `/api/ready` 200 |
| Despliegue frontend | 107 archivos en el bucket de la web, invalidación `/*` completada; staging sirve `index-Kagh9JmM.js` (idéntico al build local) |
| Infraestructura web (16 comprobaciones) | 16/16: HTTPS, fallback del SPA, 404 y 401 JSON de la API, bucket privado con Block Public Access, ALB restringido |
| CORS | `Access-Control-Allow-Origin` = origen de la web; un origen ajeno no se refleja; nunca `*` |
| Cabeceras de seguridad | web: HSTS, `X-Content-Type-Options`, `X-Frame-Options`; API: Helmet sin `X-Powered-By` |
| CSP | la web de staging **no emite CSP** (nunca lo hizo). Se validó la **CSP de producción** inyectándola en el navegador de QA, con el origen de la API cambiado al de staging: 0 violaciones en 33 páginas (§10) |
| 5xx | **0** en los logs de la API de toda la fase |
| Errores en logs | 3, todos «No se pudo enviar un correo» (`ENOTFOUND smtp.staging.busperu.invalid`): esperados (§13) |

La allowlist de CloudFront y del ALB no se modificó.

## 8. Public company profile

- **Datos:** empresa sintética «QA Perfil A qamuic51h4» (marca `qamuic51h4`), creada solo para QA con datos ficticios. Sin datos DEMO ni legales.
- **API:** script `qa-f1819.mjs` más una segunda pasada.
- **Interfaz:** Chrome headless por CloudFront en 1440×900, 768×1024 y 375×812.

| Sección | API | Interfaz (3 tamaños) |
| --- | --- | --- |
| Inicio | lema, contadores (destinos 1, agencias 2, servicios 2, buses 1) | ✔ |
| Nosotros | título, texto, historia, misión, visión y valores | ✔ |
| Servicios | 2 aprobados con características e imagen; orden respetado | ✔ |
| Agencias | 2, agrupadas por ciudad (§9) | ✔ |
| Destinos | derivado: Arequipa desde Lima, 1 viaje, desde S/ 90.00, «Ver viajes» | ✔ |
| Flota | derivado: tipo y capacidad, **sin placa, código ni marca** | ✔ |
| Galería | paginada (12 por página) y visor | ✔ |
| Opiniones | resumen (0 opiniones) y carga diferida | ✔ |
| Contacto | teléfono, WhatsApp, correo, web y redes (solo https) | ✔ |

**Casos de navegación:**

| Caso | Resultado |
| --- | --- |
| Navegación directa y refresco | ✔ `/empresas/<slug>` directo renderiza |
| Deep-link `#agencias` | ✔ |
| Slug válido | 200 |
| Slug inexistente | 404 limpio: «Empresa no encontrada · Ver empresas» |
| Empresa sin perfil aprobado (borrador de B) | 404 |
| Antes de la primera aprobación | 404, y el listado `/empresas` no enlaza el perfil |
| Perfil suspendido | 404; al levantar la suspensión vuelve (tras ≤10 s, ver finding F-01) |
| Empresa INACTIVE | cubierto por la batería automática (83) |

**EDITAR ≠ PUBLICAR (verificado):**

- Tras editar y enviar el lema, el público siguió viendo el aprobado («Lema de prueba…») mientras estaba PENDING.
- La vista previa mostró el nuevo, y la vista previa sin sesión responde 401.
- Al aprobar, el público pasó al nuevo.

**Desactivar y activar:** desactivar una agencia la oculta al instante (2 → 1); activarla la devuelve (1 → 2) sin nueva revisión y sigue APPROVED.

**Defecto visual (finding F-02):** en escritorio y móvil la portada tapa la parte superior del logo y del nombre de la empresa.

## 9. Agencies

| | Agencia QA Centro (Lima) | Agencia QA Arequipa (Arequipa) |
| --- | --- | --- |
| Servicios | Venta de pasajes + Embarque | Encomiendas + Atención al cliente |
| Horario | lunes 06:00–13:00 / 14:00–22:00 (dividido), martes 06:00–22:00, domingo **Cerrado**, resto «No informado» | lunes 08:00–18:00, sábado 08:00–12:00 |
| Especial | 2026-12-25 cerrado («Feriado (QA)») | — |
| Contacto | teléfono (`tel:`) | WhatsApp (`wa.me`) |
| Estado | activa (activar/desactivar verificado) | activa |

**Resultados:**

- Una agencia tiene servicios distintos de la otra: ✔.
- La página agrupa por ciudad en pestañas «Arequipa (1)» y «Lima (1)».
- **Validación (422):**
  - franjas que se solapan;
  - coordenadas fuera del Perú;
  - latitud sin longitud.
- Todos los datos (direcciones, teléfonos `000…`, correos `@busperu-staging.example`) son ficticios.

## 10. OpenStreetMap

| Comprobación | Resultado |
| --- | --- |
| Carga inicial | **0 iframes y 0 peticiones** a openstreetmap.org |
| «Ver en mapa» | botón presente; tras pulsarlo, 1 iframe `https://www.openstreetmap.org/export/embed.html?bbox=…&marker=…` con `sandbox="allow-scripts allow-same-origin allow-popups"`; documento OSM **200** |
| CSP de producción inyectada | **0 violaciones**; el mapa se renderiza (captura) |
| CORS / consola | 0 errores |
| Enlaces | «Cómo llegar» → `google.com/maps/dir/?api=1&destination=<lat,lng>`; «Ver mapa más grande» → openstreetmap.org |

**Alcance del cambio de CSP de F18-18:** solo se añadió `https://www.openstreetmap.org` a `frame-src`. No se abrió `script-src`, `img-src` ni `connect-src`. Las teselas cargan dentro del iframe, que tiene su propio origen.

## 11. COMPANY_ADMIN

| Acción | Resultado |
| --- | --- |
| Abrir «Perfil público» | se crea en BORRADOR con slug derivado del nombre |
| Editar general, Nosotros, historia, misión, visión, valores, contacto y redes | ✔ (DRAFT) |
| Gestionar servicios (2), agencias (2), horarios, galería (2) e imágenes | ✔ |
| Ordenar servicios | ✔: el orden público cambia |
| Activar / desactivar | ✔ |
| Baja lógica de una imagen de galería | ✔: desaparece del público (2 → 1) |
| Vista previa | ✔: muestra lo pendiente |
| Enviar a revisión | 7 envíos → PENDING; el público no lo ve |
| Rechazo | motivo visible para la empresa → corregir → reenviar → aprobado → publicado |
| Interfaz | `/company/profile` carga con 8 pestañas (Información general, Nosotros, Servicios, Agencias, Destinos y flota, Galería, Contacto, Vista previa); `/company/complaints` carga; 0 errores de consola |
| OPERATOR | lee (200), no edita (403) |

## 12. ADMIN moderation

| Acción | Resultado |
| --- | --- |
| Cola | empresa A con sus pendientes; `/admin/company-profiles` carga («Nada que revisar» al terminar) |
| Detalle | company, profile, services, agencies, gallery, destinations, fleet, reviews |
| Aprobar | publica la instantánea (copia congelada) |
| Rechazar | sin motivo → 422; con motivo → REJECTED |
| Suspender | sin motivo → 422; con motivo → el perfil desaparece (404); levantar → vuelve |
| Editar tras aprobar | no altera lo publicado hasta nueva aprobación (§8) |
| Cambiar slug | COMPANY_ADMIN → 403; slug ocupado por otra empresa → **409**; ADMIN → `qa-perfil-a-qamuic51h4` → `qa-slug-nuevo-qamuic51h4`: el nuevo 200, el anterior 404 y el listado actualizado |
| Auditoría | 34 registros de la empresa: CREATE, UPDATE, SUBMIT, APPROVE, REJECT, SUSPEND, UNSUSPEND, DELETE |
| Acceso | COMPANY_ADMIN a `/admin/company-profiles` → 403 |

## 13. Complaint Book

**Registro:**

| Comprobación | Resultado |
| --- | --- |
| Validación | sin conformidad → 422; HTML en el detalle → 422 |
| Hoja 1 (RECLAMO, empresa A) | **`LR-2026-000001`**, RECEIVED, registrada 2026-09-26 06:58:01 (Lima), **límite 2026-10-16** (15 días hábiles) |
| Hoja 2 (QUEJA, empresa B) | `LR-2026-000002` |
| Constancia | texto completo imprimible con `[PENDIENTE: razón social/RUC/domicilio]`, porque `legal.*` es NULL |
| Copia por correo | **no enviada**: `copy_emailed=false`, `copy_emailed_at=NULL` |

**Sobre el correo:**

- El SMTP de staging apunta a un host `.invalid` y no entrega a nadie.
- La API lo trata sin error (201, sin 5xx) y la constancia lo dice con honestidad: «No pudimos enviar la copia por correo: imprímela o guarda el código».
- **No se afirma que el correo funcione:** la copia y la respuesta por correo quedan sin validar hasta configurar Resend LIVE (pendiente heredado).
- No se envió correo a ninguna dirección real: el consumidor era `consumidor.<marca>@busperu-staging.example` y el documento, `OTRO` sintético.

**Consulta (fase 13):**

| Caso | Resultado |
| --- | --- |
| Código + documento correctos | 200 con datos mínimos: código, tipo, estado, fechas y respuesta. Sin correo, teléfono, domicilio, IP ni usuario |
| Documento ajeno | 404 |
| Código inexistente | 404 con **el mismo mensaje** |
| Rate limiting | **429** tras llegar al límite (`RateLimit-Limit: 20` por 15 min, compartido por registro y consulta) |

**COMPANY_ADMIN (fase 14):**

- La empresa A lista **solo** su hoja, sin documento, domicilio, teléfono ni correo del consumidor.
- Deja su descargo.
- **Aislamiento:**
  - A no abre la hoja de B: 404;
  - B no abre la de A: 404;
  - nota sobre una hoja ajena: 404;
  - `/admin/complaints` como empresa: 403; anónimo: 401.
- La empresa **no** ve la nota interna del ADMIN.

**ADMIN (fase 15):**

- Lista global con filtros por tipo y empresa y búsqueda por código: ✔.
- Transiciones:
  - RECEIVED → IN_REVIEW;
  - nota interna;
  - respuesta (EMAIL) → **ANSWERED**; una segunda respuesta → **409** (respuesta única);
  - → **CLOSED**; reabrir → **409**.
- `response_emailed_at=NULL` (mismo motivo que la copia).
- La consulta pública refleja CLOSED.
- `/admin/complaints` en la interfaz: carga sin errores.

## 14. Legal pages

Las rutas se abrieron por URL directa en los 3 tamaños, con la CSP de producción inyectada.

| Ruta | Título propio | description / og | [PENDIENTE] | Consola | Desbordamiento en móvil |
| --- | --- | --- | --- | --- | --- |
| `/informacion` | ✔ | ✔ / ✔ | 0 | 0 | no |
| `/terminos` | ✔ | ✔ / ✔ | 7 | 0 | no |
| `/privacidad` | ✔ | ✔ / ✔ | 11 | 0 | no |
| `/cookies` | ✔ | ✔ / ✔ | 1 | 0 | no |
| `/reservas-y-cancelaciones` | ✔ | ✔ / ✔ | 3 | 0 | no |
| `/pagos` | ✔ | ✔ / ✔ | 3 | 0 | no |
| `/ayuda` (FAQ, anterior a F18-19) | título genérico | genérica / — | 0 | 0 | no |
| `/libro-de-reclamaciones` | ✔ | ✔ / ✔ | 3 | 0 | no |

- «Contacto» y «Ayuda y soporte» se enlazan desde `/informacion` y el pie.
- El pie de página contiene todos los enlaces de «Información útil» y el aviso del Libro.
- Los datos legales pendientes aparecen como `[PENDIENTE: …]` y **no se afirman como hechos**.

## 15. Security

| Control | Resultado en staging |
| --- | --- |
| Tenant: `?company_id=` de otra empresa | ignorado: el tenant sale del token (devuelve la empresa propia) |
| Tenant: `company_id` en el cuerpo | 422 |
| Tenant: ver, editar, enviar, borrar o activar un elemento de otra empresa | 404 en los 5 casos; la lista de B no contiene datos de A |
| XSS: HTML en textos del perfil y del Libro | 422 |
| URL `http://` | 422 |
| Red social en un dominio ajeno | 422 |
| Teléfono inválido | 422 |
| Imágenes | SVG 400 · MIME incoherente 400 · «.png» falsa 400 · 10×10 400 · 9000×9000 400 · 6 MB 400 · PNG válido 200 |
| Vista previa sin sesión | 401 |
| Moderación y Libro ADMIN como COMPANY_ADMIN | 403 |
| OPERATOR escribiendo | 403 |
| Libro: consulta con documento ajeno | mismo 404 que un código inexistente |
| Libro: rate limiting | 429 |
| Respuesta pública | sin placa, código de bus, `plate_number`, `moderation_note`, `reviewed_by`, `published_content`, `legal_name`, `tax_id` ni `review_status` |
| Batería de seguridad automatizada | 991/991 (§18) |

## 16. F18-16 regression

Misma herramienta y escenarios que el cierre de F18-16 (`lab.mjs`, modo staging, Chrome headless). Comparación con la medición final de F18-16 en staging:

| Escenario | Métrica | F18-16 | F18-19A |
| --- | --- | --- | --- |
| Primera visita (11 transiciones) | mediana útil / p90 (ms) | 8,7 / 20,4 | 11,5 / 21,3 |
| Uso realista, 32 s por sección (11) | mediana / p90 | 7,3 / 16,6 | 5,7 / 18,0 |
| Vueltas calientes (22) | mediana / p90 | 6,0 / 17,3 | 5,6 / 15,1 |
| Todas | con esqueleto · pantalla en blanco · errores HTTP | 0 · 0 · 0 | 0 · 0 · 0 |
| Todas | `OPTIONS` por navegación | 0,0 | 0,0 |
| Todas | chunks descargados al navegar | 0 | 0 |
| Navegación rápida (8 clics a 150 ms) | peticiones · canceladas · errores · esqueleto final | 1 · 0 · 0 · no | 1 · 0 · 0 · no |
| Carga inicial del Dashboard | útil (ms) · peticiones API · chunks | 1695 · 6 · 9 | 1595 · 5 · 9 |
| Consola | errores | 0 | 0 |

Secciones medidas: Dashboard, Empresas, Usuarios, Viajes, Reservas, Pagos, Destinos y Configuración.

- **Sin llamadas a `drivers`** en Viajes (el cambio de F18-11B sigue vigente).
- **SWR:** con datos en caché, ninguna transición mostró esqueleto; «Actualizando…» y la revalidación funcionan.
- **Cancelación:** la navegación rápida no dejó peticiones abandonadas.
- **F18-16 sin regresión.** La mediana de la primera visita (+2,8 ms) se debe a un valor atípico en Configuración (94 ms), dentro del ruido de red. p90, esqueletos, peticiones y cancelaciones son iguales.

## 17. Performance

Mediciones reales en staging por CloudFront desde el equipo del operador (sin simulación de red):

| | |
| --- | --- |
| Transiciones del panel ADMIN | mediana 5,6–11,5 ms según escenario; p90 ≤ 21,3 ms |
| Carga en frío del Dashboard | 1595 ms hasta contenido útil |
| API | `/api/ready` ≈ 0,35 s de ida y vuelta; `/api/public/*` ≈ 0,38 s |
| Perfil público | 33 cargas de página sin errores de red; el mapa solo cuesta cuando se pide |
| Bundle | `index` 285 994 B (86,1 kB gzip); las páginas de F18-19 van en chunks aparte |

## 18. Automated tests

| Suite | Resultado |
| --- | --- |
| Backend completo, MariaDB 10.4 (`busperu_test`) | **2194/2194** |
| Subconjunto de seguridad (35 archivos, incluidos 83 y 84) | **991/991** |
| Frontend: typecheck · lint · tests · build | OK · OK (0 avisos) · **36/36** · OK (bundle idéntico al desplegado) |
| Smoke de staging (`smoke-staging.mjs`) | **37/37** |
| E2E de staging (`e2e-staging.mjs`) | **18/18** |
| E2E «expiry» (≥ 16 min después) | **1/1**: la reserva 60 caducó sola (planificador) y liberó el asiento |
| QA F18-19 por API (`qa-f1819.mjs`, 1.ª pasada) | 41/50. Los 9 fallos tienen dos causas ajenas al código de F18-19: el finding F-01 (404 cacheado por CloudFront tras aprobar) y un error de diseño de la propia prueba (el slug «nuevo» coincidía con el generado). Se repitieron correctamente en la 2.ª pasada: **8/8** (la de agencias, tras reactivar la agencia que la 1.ª pasada dejó inactiva al cortarse) |
| QA de interfaz (`ui-f1819.mjs`) | 33 cargas de página + perfil + 4 paneles: 0 errores de consola, 0 violaciones de CSP, 0 desbordamientos. Las únicas «incidencias» son el 404 esperado del slug inexistente |

No se modificó ningún test ni archivo del repositorio para hacer pasar nada.

## 19. QA cleanup

**Creado en esta fase (todo sintético):**

| Origen | Marca | Empresas | Usuarios | Otros |
| --- | --- | --- | --- | --- |
| QA F18-19 | `qamuic51h4` | 28 (A), 29 (B) | 82, 83, 84 | ubicaciones 50–51 · tipo de bus 24 · tipo de asiento 24 · bus 26 · ruta 39 · viaje 45. F18-19: perfiles 2, servicios 2, agencias 2, galería 2, hojas del Libro 1 y 2 (`LR-2026-000001/2`), 8 eventos, contador 2026, 5 imágenes |
| Smoke oficial | `muicqy2z` | 30 | 85, 86, 87 | ubicaciones 52–53 · tipos 25 |
| E2E oficial | `muicr9rq` | 31 | 88, 89, 90 | ubicaciones 54–55 · tipos 26 |

**Eliminación, en dos pasos:**

1. **Datos de F18-19** con `purge-f1819-qa.cjs` (script de la fase, fuera del repositorio), porque la purga oficial no contempla estas tablas (finding F-03).
   - Borra solo por IDs exactos y exige la marca en cada empresa y en el correo de cada hoja.
   - Comprueba que no quede ninguna hoja ajena ligada y borra el contador del año solo si todas sus hojas son de QA.
   - Verifica que únicamente cambian las 7 tablas previstas y que `audit_logs` no cambia.
   - Ensayo (ROLLBACK) y después ejecución: **COMMIT · 19 filas** (eventos 8, hojas 2, contador 1, galería 2, agencias 2, servicios 2, perfiles 2) · **5/5 archivos** de imagen borrados (`public/companies/28/` queda vacía).
2. **Raíces** con la purga oficial (`qa-staging.sh purgar`, `purge-qa-data.cjs`) de los manifiestos QA F18-19 + smoke + E2E: ensayo (ROLLBACK) y ejecución **COMMIT**.
   - **Raíces:** empresas 4, usuarios 9, ubicaciones 6, tipos de bus 3, tipos de asiento 3.
   - **Derivado:** rutas 4, viajes 4, buses 3, reservas 5, grupos 1, pagos 1, asientos reservados 5, movimientos 3, distribuciones 3, pisos 3, elementos 1, asientos 14, vínculos empresa-usuario 7, comisiones 4, llaves de API 1, notificaciones 10, sesiones revocadas 10.
   - Las carpetas vacías `public/companies/28` y `public/companies/30` se retiraron.

**Se conserva, por diseño:** `audit_logs` (1344 filas; la purga lo exige y los registros quedan con el usuario a NULL).

**Estado final, igual al previo a la fase:**

- **Recuentos:** empresas 2, usuarios 7, viajes 14, reservas 5.
- **Tablas de F18-19:** 0 filas en las 7.
- **`legal.*`:** en NULL.
- **Archivos:** ningún archivo ni carpeta en `public/companies/`.

**DEMO:** huella de filas (MD5 de id, nombre, estado y `updated_at`) idéntica antes y después de la limpieza:

- empresa DEMO: 1;
- usuarios DEMO: 3;
- viajes DEMO: 12;
- reservas DEMO: 1.

Ningún dato DEMO se modificó en toda la fase.

## 20. Findings

### BLOCKER
Ninguno para staging.

Para **producción** siguen abiertos los bloqueadores heredados de F18-19, sin cambios:
1. datos reales del titular (`legal.*`);
2. revisión jurídica de los textos;
3. Resend LIVE: sin él no llegan la copia ni la respuesta del Libro, como se confirmó en §13;
4. B-11, comisión de la plataforma.

### HIGH
Ninguno.

### MEDIUM

**F-01 · CloudFront cachea los errores 404 de la API durante ~10 s.**

| | |
| --- | --- |
| Archivo | infraestructura: distribución API `d1lfpi7fp62ntk` (plantilla `infra/aws/cloudformation/build-web-template.mjs`; la de producción usa el mismo patrón) y respuestas de la API sin `Cache-Control` |
| Causa | por defecto, CloudFront guarda en caché respuestas de error (400, 403, 404, 405, 414 y 5xx) durante 10 s aunque la política de caché esté desactivada. Las respuestas de la API no llevan `Cache-Control: no-store`. Comprobado: 3 peticiones seguidas al mismo slug inexistente → `X-Cache: Error from cloudfront` con `Age` 0, 1 y 2 |
| Impacto | tras aprobar o levantar la suspensión de un perfil, la página pública sigue diciendo «Empresa no encontrada» hasta ~10 s. Por inferencia (no reproducido), cualquier GET de la API que dé 403, 404 o 5xx puede servirse cacheado a otro usuario durante 10 s. No expone datos: solo sirve errores |
| Afecta a staging | sí (previo a F18-19; F18-19 lo hace visible) |
| Propuesta | la API envía `Cache-Control: no-store` en todas las respuestas `/api/*`, o la distribución de la API define `CustomErrorResponses` con `ErrorCachingMinTTL: 0`, sin página de respuesta, para esos códigos |
| Fase | **F18-19B** |

**F-02 · La portada del perfil público tapa el logo y el nombre de la empresa.**

| | |
| --- | --- |
| Archivo | `frontend/src/components/company-profile/CompanyProfileView.tsx:139-144` |
| Causa | la portada es un elemento posicionado (`relative`) y el bloque del logo y el nombre sube sobre ella con margen negativo (`-mt-14` / `sm:-mt-16`) sin estar posicionado, así que el navegador pinta la portada encima |
| Impacto | visual: en escritorio el nombre queda cortado por arriba y el logo, medio oculto; en móvil se corta el logo. No afecta a datos ni a seguridad (capturas `perfil-desktop.png` y `perfil-mobile.png`) |
| Afecta a staging | sí |
| Propuesta | añadir `relative z-10` al bloque de la línea 144 y, en escritorio, solapar solo el logo (el texto bajo la portada) |
| Fase | **F18-19B** |

### LOW

**F-03 · La purga oficial de QA no contempla las tablas de F18-19.**

| | |
| --- | --- |
| Archivo | `infra/aws/scripts/purge-qa-data.cjs` |
| Causa | al borrar una empresa sintética con perfil, las filas del perfil caen en cascada y la postcondición aborta («perdió N fila(s) y no estaba previsto»). Además, las hojas del Libro (`company_id` SET NULL) quedarían huérfanas y no se borrarían |
| Impacto | operativo: sin el paso previo de esta fase, un QA que toque F18-19 no se puede purgar con la herramienta oficial |
| Afecta a staging | sí (herramienta de QA) |
| Propuesta | incorporar `company_profiles`, `company_services`, `company_agencies` y `company_gallery_images` (y sus imágenes) y `complaint_book_*` (con la regla del contador) a la purga, con recuentos y postcondiciones |
| Fase | F18-19B |

**F-04 · La documentación de F18-19 describe un filtro de galería por categoría que no existe.**

| | |
| --- | --- |
| Archivo | `docs/production/F18-19-CONTENT-MODEL.md` §5 y `F18-19-IMPLEMENTATION-REPORT.md` §1.1 |
| Causa | la API `/public/companies/:slug/gallery` y la vista solo paginan: la categoría se guarda y se usa como texto alternativo |
| Impacto | discrepancia entre la documentación y el código |
| Afecta a staging | no, funcionalmente |
| Propuesta | corregir los documentos o implementar el filtro |
| Fase | F18-19B |

**F-05 · SEO sin `canonical`; `/ayuda` y `/empresas` con título genérico.**

| | |
| --- | --- |
| Archivo | `frontend/src/hooks/usePageMeta.ts` y las páginas `/ayuda` y `/empresas` (anteriores a F18-19) |
| Causa | `usePageMeta` no define `<link rel="canonical">`; esas dos páginas no lo usan |
| Impacto | SEO menor |
| Propuesta | añadir `canonical` a `usePageMeta` y usarlo en esas páginas |
| Fase | F18-19B u otra posterior |

**F-06 · La respuesta pública del perfil incluye ids numéricos.**

| | |
| --- | --- |
| Detalle | incluye el id de la empresa y los de servicios y agencias |
| Contexto | el id de empresa ya era público antes de F18-19 (`/public/companies` y el filtro `company_id` del buscador «Ver viajes»); los de los elementos sirven de clave de lista |
| Impacto | no revelan nada sensible, pero el brief pide no exponer ids internos |
| Propuesta | quitar los ids de los elementos de la respuesta pública (o aceptar la excepción) |
| Fase | F18-19B |

### NON-BLOCKING

- **Correo en staging:** el SMTP apunta a un host `.invalid`, así que la copia y la respuesta del Libro no se entregan (`copy_emailed=false`, `response_emailed_at=NULL`). La API lo trata sin error y la interfaz avisa al consumidor. Depende de Resend LIVE.
- **Días hábiles:** el cómputo no descuenta feriados nacionales (pendiente heredado de F18-19; la hoja de prueba dio 2026-10-16).
- **Temas SNS `busperu-prod-alarms` y `busperu-prod-security`:** existen desde 2026-09-24 como parte del stack `busperu-security-baseline` (fase anterior). No se tocaron.

## 21. Production

**NOT DEPLOYED**

```
PRODUCTION_DEPLOYED=NO
PRODUCTION_DATABASE_CHANGED=NO
PRODUCTION_INFRA_CHANGED=NO
```

- No existe `busperu_prod` ni ningún recurso de producción: ningún stack `busperu-prod*`, RDS, EC2, ALB, CloudFront, parámetro `/busperu/prod/*`, certificado ACM ni zona Route 53. No se creó ninguno.
- En CloudTrail, los únicos eventos de escritura del día en SNS, RDS, CloudFormation y CloudFront son el `CreateDBSnapshot` de staging. La invalidación de CloudFront de la web de staging es un evento global que no aparece en `sa-east-1`.
- No se tocaron DNS, Resend, Culqi ni datos legales. No se asignó ninguna comisión.

## 22. Recomendación de siguiente fase

**F18-19B (código e infraestructura, con autorización):**
- F-01: `Cache-Control: no-store` en la API o `ErrorCachingMinTTL: 0` en la distribución de la API.
- F-02: capas de la cabecera del perfil.
- F-03: purga de QA ampliada a F18-19.
- F-04: documentación de la galería o filtro por categoría.
- F-05 y F-06, según se decida.

**Pendientes antes de producción (sin suposiciones):**
- datos reales del titular (`legal.*`);
- revisión jurídica;
- Resend LIVE (y repetir entonces la verificación de la copia y la respuesta del Libro por correo);
- B-11 (comisión);
- feriados en los días hábiles.
