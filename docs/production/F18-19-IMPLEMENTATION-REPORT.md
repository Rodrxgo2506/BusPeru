# F18-19 · Información pública y perfil completo de empresas — informe de implementación

| | |
| --- | --- |
| Fase | F18-19 |
| Base del trabajo | `master` = `origin/master` = `a235680` (F18-18). El brief citaba la release de referencia `0120415`; el HEAD real era `a235680`, que la contiene |
| Estado | **PASS WITH FINDINGS**: funcionalidad completa y probada. Quedan datos legales y de negocio pendientes, que **no se inventaron** (§10) |
| Producción | **NOT DEPLOYED** |
| Commit | **no realizado** (pendiente de autorización explícita) |

Documentos de la fase:

- este informe;
- [`F18-19-CONTENT-MODEL.md`](F18-19-CONTENT-MODEL.md): modelo de datos, publicación y permisos;
- [`F18-19-LEGAL-SOURCES.md`](F18-19-LEGAL-SOURCES.md): fuentes oficiales y clasificación de cada texto;
- [`MIGRATIONS.md`](MIGRATIONS.md): 020 y 021.

## 1. Qué se construyó

### 1.1 Perfil público de empresa — `/empresas/:slug`

- **Una sola página, generada desde datos, para todas las empresas.** No hay páginas escritas a mano.
- Secciones con ancla y navegación fija:
  - Inicio, Nosotros, Servicios.
  - **Agencias:** por ciudad, con horario semanal, fechas especiales, servicios por agencia, mapa bajo demanda, «Cómo llegar», teléfono y WhatsApp.
  - Destinos, Flota, Galería (filtro por categoría, paginada, visor ampliado), Opiniones (carga diferida), Contacto.
- **Derivados, sin duplicar datos:**
  - Destinos: rutas activas de la empresa, más las fichas de ciudad del CMS.
  - Flota: buses por tipo, sin placa, código ni marca.
  - Opiniones: reseñas aprobadas, solo con el nombre de pila del autor.
- **SEO:** `usePageMeta` fija el título, la descripción, `og:*` y el JSON-LD `Organization`, y los restaura al salir. El slug es único.
- **Listado `/empresas`:** usa `tagline` y enlaza al perfil solo cuando está publicado.

### 1.2 Panel de la empresa — `/company/profile` («Perfil público»)

- **Pestañas:** General, Nosotros, Servicios, Agencias, Destinos, Galería, Contacto y **Vista previa** (la copia de trabajo, incluido lo pendiente).
- **Seguimiento:** estado por elemento (borrador, en revisión, aprobado, rechazado con motivo visible).
- **Acciones:** envío a revisión, reordenar, activar y desactivar, baja lógica, imágenes.
- **Acceso:** COMPANY_ADMIN edita; OPERATOR solo lee.

### 1.3 Moderación — `/admin/company-profiles` («Perfiles públicos»)

- **Cola:** perfiles con elementos pendientes o rechazados.
- **Detalle:** las mismas pestañas, más «Auditoría», «Editar» (el ADMIN puede corregir contenido de cualquier empresa) y «Vista previa».
- **Acciones:** aprobar (publica la instantánea), rechazar (nota obligatoria), suspender y levantar la suspensión, cambiar el slug.

### 1.4 Información útil

- **Índice `/informacion`.** Enlaza las páginas nuevas y las existentes:
  - nuevas: `/terminos`, `/privacidad`, `/cookies`, `/reservas-y-cancelaciones`, `/pagos`, `/libro-de-reclamaciones`;
  - existentes: Preguntas frecuentes (`/ayuda`) y Ayuda y soporte (`/customer/support`).
- **Pie de página:** nueva columna «Información útil» y aviso del Libro de Reclamaciones.
- **Textos:** llevan el aviso «versión propuesta, pendiente de validación legal» y marcas `[PENDIENTE: …]` donde falta un dato. Las reglas de reservas se leen en vivo de la configuración (`booking.hold_minutes`, `booking.cancellation_hours`).

### 1.5 Libro de Reclamaciones virtual

- **Público:**
  - formulario con los campos del Anexo I (DS 011-2011-PCM), padre, madre o representante si es menor, y conformidad obligatoria que reemplaza la firma;
  - al registrar: constancia imprimible y copia por correo;
  - consulta del estado con código más documento.
- **ADMIN (`/admin/complaints`):**
  - filtros por estado, tipo, empresa, vencidas sin respuesta, fechas y búsqueda;
  - detalle con la hoja completa;
  - cambio de estado, respuesta única (correo o carta) y notas internas.
- **Empresa (`/company/complaints`):**
  - ve solo las hojas enlazadas a ella, sin documento, domicilio, teléfono ni correo del consumidor;
  - puede dejar su descargo;
  - el historial se muestra en castellano.
- **Enlace con la empresa:**
  - el consumidor puede elegirla;
  - si indica un código de reserva **propio** y tiene sesión iniciada, la hoja queda enlazada a esa reserva;
  - una reserva ajena queda solo como texto.

## 2. Base de datos

| Migración | Contenido | Tablas |
| --- | --- | --- |
| `020-company-public-profiles.sql` | `company_profiles`, `company_services`, `company_agencies`, `company_gallery_images`, con columnas de moderación | 49 → 53 |
| `021-complaint-book.sql` | `complaint_book_counters`, `complaint_book_entries`, `complaint_book_events`, más 5 claves `legal.*` en `NULL` | 53 → 56 |

- **Idempotencia:**
  - ambas usan `CREATE TABLE IF NOT EXISTS` / `INSERT IGNORE`;
  - las 21 migraciones se reaplicaron sobre una base 10.11 ya migrada: 21/21 sin error y la misma huella.
- **Nueva referencia de esquema** (`schema-reference.json`, instalación limpia en MariaDB 10.11.19):
  - 56 tablas, 645 columnas, 253 índices, 96 FK y 25 CHECK;
  - `schema-fingerprint.cjs` da ✔ contra ella.
- **Herramientas de despliegue ajustadas:**
  - `apply-migrations.sh` exige 21 migraciones;
  - `apply-one-migration.sh` acepta 49, 53 o 56 tablas.
- **Documentación actualizada:** README, PRODUCCION.md, STAGING-RUNBOOK.md y MIGRATIONS.md.
- **Migraciones ejecutadas en esta fase, solo en bases locales:**
  - `busperu_test`: la suite;
  - `busperu_1011_test`: la suite;
  - `busperu_1011_ref`: la referencia.
- **Sin migrar:** `busperu`, `busperu_staging` y producción. Nada se tocó en AWS.

## 3. API

Todas las rutas cuelgan de `/api`. El `company_id` sale del token: solo el ADMIN puede pasar `?company_id=`.

| Método y ruta | Quién |
| --- | --- |
| `GET /public/companies` (ahora con `slug` y `tagline`) · `GET /public/companies/:slug` · `GET …/:slug/gallery?page&category` · `GET …/:slug/reviews?page` | público |
| `GET /public/legal` (datos del proveedor, `null` si están pendientes) | público |
| `POST /public/complaints` · `POST /public/complaints/lookup` (con límite de peticiones) | público; la sesión es opcional y solo sirve para enlazar una reserva propia |
| `GET /company/profile` · `GET /company/profile/preview` · `GET /company/profile/:items(services\|agencies\|gallery)` | ADMIN, COMPANY_ADMIN, OPERATOR (`companies.view`) |
| `PUT /company/profile` · `POST /company/profile/submit` · `POST\|DELETE /company/profile/images/:slot(cover\|about)` | ADMIN, COMPANY_ADMIN (`companies.update`) |
| `POST /company/profile/services\|agencies\|gallery` · `PUT …/:items/:id` · `DELETE …/:items/:id` · `POST …/:items/:id/submit` · `PATCH …/:items/:id/active` · `PUT …/:items/reorder` · `POST\|DELETE …/(services\|agencies)/:id/image` | ADMIN, COMPANY_ADMIN |
| `PUT /company/profile/slug` | ADMIN |
| `GET /admin/company-profiles` · `GET /admin/company-profiles/:companyId` · `POST …/:companyId/moderation` · `GET …/:companyId/audit` | ADMIN |
| `GET /admin/complaints` · `GET /admin/complaints/:id` · `PATCH /admin/complaints/:id` · `POST /admin/complaints/:id/notes` | ADMIN |
| `GET /company/complaints` · `GET /company/complaints/:id` · `POST /company/complaints/:id/notes` | ADMIN, COMPANY_ADMIN |

Un elemento de otra empresa responde **404** (no 403): no se revela si existe.

## 4. Seguridad

| Riesgo | Mitigación | Prueba |
| --- | --- | --- |
| Salto de tenant | `resolveCompanyId`; esquemas `strict` que rechazan `company_id` en el cuerpo; cada consulta filtra por `company_id` | tests 83 «no puede escapar…», «otra empresa no puede ver, editar…» |
| XSS almacenado | texto plano (se rechaza cualquier etiqueta HTML) y React escapa al pintar; URLs solo `https`; redes sociales solo en su dominio oficial; `safeExternalUrl` en el cliente | «rechaza HTML…», «solo acepta https…», test del Libro «rechaza HTML en el detalle» |
| Imágenes maliciosas | *magic bytes* + MIME + extensión; sin SVG; ≤ 5 MB; dimensiones leídas del archivo (160–6000 px, ≤ 36 MP); nombre aleatorio | «no es imagen aunque se llame .png», «SVG…», «demasiado pequeñas o enormes» |
| Contenido sin moderar | la instantánea solo la crea el ADMIN; la vista previa exige sesión | «enviar → PENDING; el público sigue sin verlo», «edición posterior…» |
| Fuga de datos internos | el público no recibe placas, códigos, marcas, ids de moderación ni notas; opiniones solo con nombre de pila | «flota: … SIN placa, código ni marca» |
| Datos del consumidor en el Libro | la empresa no ve documento, domicilio, teléfono ni correo; la consulta pública exige código y documento, y responde el mismo 404 a cualquier discrepancia | tests 84 |
| Enumeración de reservas | una reserva ajena no enlaza empresa ni reserva | «una reserva ajena (o sin sesión)…» |
| Abuso del formulario | `rateLimit` en el registro y la consulta del Libro | configuración `env.rateLimit.auth` |
| Mapa de terceros | iframe de OpenStreetMap con `sandbox`, cargado solo al pulsar, y permitido en `frame-src` de la CSP de producción | verificación en el navegador; regla nueva en `check-prod-templates.mjs` |
| Auditoría | cada cambio del perfil y cada moderación quedan en `audit_logs` | «guarda un perfil válido… con auditoría», «detalle con… auditoría» |

**Incompatibilidad documentada con F18-18.** El mapa necesitaba `https://www.openstreetmap.org` en `frame-src`:

- se añadió en `build-prod-web-template.mjs`, con su justificación, y se regeneró `busperu-prod-web.json`;
- `check-prod-templates.mjs` comprueba ahora que el host del mapa, leído del código del frontend, esté permitido. La regla se probó con un host erróneo y lo detecta;
- **es el único cambio sobre plantillas de F18-18.** Nada se desplegó.

## 5. Pruebas

| Batería | Resultado |
| --- | --- |
| Backend completo, MariaDB 10.4 (`busperu_test`) | **2194/2194**. Una primera ejecución dio 2193/2194: `79-mariadb-1011` contaba 9 columnas JSON; se ajustó (abajo) y se repitió la batería completa |
| Backend completo, MariaDB 10.11.19 (`busperu_1011_test`) | **2194/2194** |
| Subconjunto de seguridad (33 archivos del conjunto histórico + 83 y 84) | **991 pruebas en 35 archivos, 0 fallidas**, en ambos motores |
| Nuevas: `83-f1819-perfil-empresas` (40) y `84-f1819-libro-reclamaciones` (18) | 58/58 en ambos motores |
| Frontend: typecheck, lint (0 avisos), tests | OK · OK · **36/36** (9 del perfil y 1 de las etiquetas del Libro) |
| Build de producción (con API https, guard de build activo) | OK. `index` 285 994 B (antes 280 268 B, +2 %). Las páginas nuevas van en chunks aparte, entre 2,5 y 34,5 kB |
| Plantillas: `check-template`, `check-web-template`, `check-prod-templates` | PASS |
| Huella del esquema (10.11.19) | ✔ idéntica a la referencia nueva |

`79-mariadb-1011-compatibilidad` se ajustó porque contaba 9 columnas JSON y ahora son 19: la 020 añade 10 y la
021 ninguna. La prueba enumera las 10 nuevas y comprueba que una de ellas llega como texto.

### 5.1 Verificación manual en el navegador (servidores locales sobre `busperu_test`)

- **Datos:** sembrados por la API local con la contraseña de los fixtures de prueba. El script `seed-local.mjs` y tres PNG reales viven en el directorio temporal de la sesión, fuera del repositorio. **No se usaron imágenes del usuario**: no se adjuntó ninguna.
- **Público:**
  - `/empresas/empresa-a` muestra las 9 secciones, el título SEO y el JSON-LD;
  - el servicio pendiente no aparece;
  - el iframe del mapa pasa de 0 a 1 solo al pulsar, con `sandbox`;
  - «Cómo llegar» usa las coordenadas y el horario tiene 7 filas;
  - al salir se restaura el título del documento.
- **Moderación:**
  - el ADMIN aprueba «Comercial» desde la UI (diálogo «Aprobar y publicar»);
  - la API pública pasa a incluirlo, la cola queda en 0 pendientes y la auditoría registra `APPROVE`.
- **Libro:**
  - el ADMIN ve el listado y la hoja completa con `[PENDIENTE: razón social/RUC/domicilio]`;
  - la empresa ve solo sus 2 hojas, sin documento, correo, teléfono ni domicilio del consumidor;
  - el historial está en castellano (corregido durante la verificación).
- **Legales:** las 7 páginas se muestran con título propio, los enlaces del pie son correctos y el formulario vacío no llega a enviarse.
- **Sin envíos reales:** no se envió ninguna hoja desde el navegador, porque el backend de desarrollo tiene `MAIL_TRANSPORT=resend` y se evita un correo real. El registro está cubierto por los tests con el transporte en memoria.
- **Consola:** tras recargar, sin errores. Solo queda el aviso de React Router (`v7_relativeSplatPath`), que ya existía.

## 6. Decisiones

1. **Moderación por instantánea** (`published_content`) en lugar de tablas «borrador/publicado» duplicadas: menos esquema, y el público nunca ve una edición a medias.
2. **El Libro es de BusPerú.** La empresa aporta su descargo y BusPerú responde (a validar legalmente, ver LEGAL-SOURCES §3).
3. **Mapa OpenStreetMap bajo demanda y «Cómo llegar» con la URL pública de Google Maps:** sin claves ni costes, y sin cargar terceros hasta que el usuario lo pide.
4. **Horarios en JSON validado** en lugar de tablas por día, porque se leen siempre completos y la validación (solapes, rangos) vive en un solo esquema zod.
5. **Sin dependencias nuevas** (ni Redis ni bibliotecas de imágenes: las dimensiones se leen de la cabecera del archivo).
6. **Cambios que no pasan por moderación:** reordenar y activar/desactivar, porque no cambian contenido.
7. **F18-16 intacta:** SWR, caché, AbortController, prefetch y la navegación ADMIN no se tocaron. Solo se añadieron 2 entradas a `ADMIN_ROUTE_CHUNKS` para las páginas nuevas.

## 7. Riesgos

| Riesgo | Impacto | Mitigación / estado |
| --- | --- | --- |
| Textos legales sin validar | alto (legal) | aviso visible en cada documento; revisión obligatoria antes de producción |
| Datos del proveedor en `NULL` | alto: la hoja sale con `[PENDIENTE]` | bloqueador de producción del Libro (§10) |
| Días hábiles sin feriados | medio: la fecha límite mostrada puede ser más tardía que la legal | pendiente de fuente de feriados |
| Imágenes en disco local de la instancia | medio (heredado): igual que logos y destinos | sin cambio; el almacén de archivos es el existente |
| Moderación manual | bajo: un perfil puede tardar en publicarse | cola del ADMIN con contador de pendientes |
| `busperu_staging` en 001→019 | bajo: la huella nueva no coincide hasta aplicar 020–021 | documentado en MIGRATIONS y STAGING-RUNBOOK |

## 8. Cambios en el repositorio

**Nuevos:**

- backend: `routes/company-profile.routes.ts`, `services/company-profile.service.ts`, `services/complaint-book.service.ts`, `validators/company-profile.validators.ts`, `utils/image-dimensions.ts`, `test/83-…`, `test/84-…`;
- base de datos: `database/migrations/020-…`, `021-…`;
- frontend: `types/company-profile.ts`, `services/company-profile.ts`, `utils/company-profile.ts` (+ test), `hooks/usePageMeta.ts`, `components/company-profile/*`, `pages/public/CompanyProfilePage.tsx`, `pages/public/LegalPages.tsx`, `pages/company/CompanyPublicProfilePage.tsx`, `pages/company/CompanyComplaintsPage.tsx`, `pages/admin/PublicContentAdminPages.tsx`;
- documentación: los 3 documentos de la fase.

**Modificados:**

- backend: `routes/index.ts`, `routes/public.routes.ts`, `services/file-storage.service.ts` (destino `company-media`), `test/helpers/database.ts`, `test/79-…`;
- frontend: `routes/index.tsx`, `routes/admin-chunks.ts`, `constants/navigation.tsx`, `layouts/PublicLayout.tsx`, `pages/public/InfoPages.tsx`, `services/index.ts`, `package.json` (script de tests);
- infraestructura: `build-prod-web-template.mjs`, `busperu-prod-web.json`, `check-prod-templates.mjs`, `apply-migrations.sh`, `apply-one-migration.sh`, `schema-reference.json`;
- documentación: `README.md`, `PRODUCCION.md`, `MIGRATIONS.md`, `STAGING-RUNBOOK.md`.

**Sin tocar:** los 5 archivos sin seguimiento heredados (`F18-12-COMMIT-PREP.md`, `F18-12A-…`, `F18-12B-…`, `F18-12C-…`, `qa-manifest-e2e-mug3ixsf.json`).

**Escaneo de secretos** sobre los 45 archivos nuevos o modificados: limpio. Patrones buscados:

- claves AWS, Culqi `live`/`test`, Resend y bloques de clave privada;
- JWT e identificadores de 12 dígitos;
- la contraseña de los fixtures y la credencial temporal de MariaDB 10.11.

**Fuera del repositorio:** se instaló `pypdf` en el Python local con `pip`, para extraer el texto de los PDF oficiales.

## 9. Lo que NO se hizo

Por restricción del brief:

- no se desplegó, ni se tocó AWS, DNS, Resend LIVE, Culqi LIVE, RDS ni `busperu_staging`;
- no se ejecutaron migraciones fuera de las bases locales de prueba;
- no se reabrió F18-16;
- no se inventaron datos legales;
- no se hizo commit.

## 10. Pendientes y bloqueadores

**Bloqueadores para publicar en producción las páginas legales y el Libro:**

1. **Datos del proveedor:** `legal.business_name`, `legal.ruc`, `legal.address`, `legal.email`, `legal.phone`.
2. **Revisión legal** de todos los textos propuestos:
   - alcance de la responsabilidad del intermediario;
   - quién mantiene el Libro;
   - base legal del tratamiento de datos;
   - jurisdicción.
3. **Correo transaccional LIVE (F18-18):** sin él, la copia obligatoria de la hoja no llega al consumidor.

**Pendientes (no bloquean el código):**

4. Feriados nacionales en el cómputo de 15 días hábiles.
5. Plazos ARCO (fuente oficial no accesible desde este equipo) y procedimiento interno de incidentes (48 h).
6. Inscripción del banco de datos en el Registro Nacional.
7. Plazos de conservación de reservas, pagos y cuentas.
8. Plazo de reembolsos, tratamiento del cargo por servicio y política de cambios, no presentación y equipaje.
9. Cuentas y puntos de pago autorizados; comprobantes electrónicos.
10. Libro físico de respaldo; ¿aplica el SIREC (≥ 3000 UIT)?; formato exacto del Aviso (Anexo 2).
11. Exportación masiva de hojas para requerimientos de Indecopi (hoy: consulta e impresión por hoja).
12. Aplicar 020 y 021 en `busperu_staging` (con snapshot previo) cuando se autorice desplegar F18-19.
13. B-11 de F18-18 (comisión de plataforma), que sigue pendiente y no se toca aquí.
