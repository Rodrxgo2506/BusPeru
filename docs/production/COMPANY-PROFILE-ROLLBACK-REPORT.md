# Rollback de perfiles públicos de empresas — informe

Fecha: 2026-09-26 · Base: `846d26f` · Alcance: repositorio y entorno LOCAL. Staging y producción no se tocaron.

> **Ajuste posterior** (commit `fix(public): open company trips on today's date` sobre `75ea4ce`): por decisión del
> propietario, «Ver viajes» vuelve exactamente al comportamiento de `a235680` y usa **la fecha de hoy**. Se retiró
> también la mejora de F18-19D que abría la próxima salida (`next_departure_date` del listado y `company-links.ts`).
> Este informe ya refleja el estado final.

## 1. Estado solicitado

`/empresas` vuelve al listado anterior a los perfiles públicos de F18-19:
- cada empresa muestra logo o iniciales, «Empresa verificada», nombre, descripción y rutas activas;
- la única acción es **«Ver viajes»** (`/buscar?company_id=<id>&date=<hoy>`), como en `a235680`;
- no existen «Ver perfil», `/empresas/:slug` ni sus subrutas, el panel de edición del perfil ni la moderación de perfiles.

Se conservan el Libro de Reclamaciones, las páginas legales y todo lo anterior a F18-19. Las migraciones y tablas 020/021 y sus datos también se conservan: no hay `DROP` ni `ALTER`.

## 2. Commit histórico identificado

**`a2356807cd5fb7f88065ed83a10aec5013c55ade`** — `feat(infra): prepare production infrastructure`, del 2026-09-25 20:11:07 -05:00.

Es el padre directo de `4213568` (`feat(public): company public profiles and complaint book`), el commit de F18-19. La cadena posterior es:
- `da4d474` (F18-19B);
- `2e05222` (F18-19D);
- `e07acb1` (F18-20) y `f8725ad` (su revert);
- `846d26f` (informe del rollback de F18-20).

## 3. Evidencia

- **Primer commit que añade cada pieza** (`git log --diff-filter=A`):
  - `CompanyProfileView.tsx`, `CompanyProfilePage.tsx`, `company-profile.service.ts`, `company-profile.routes.ts` y las migraciones `020` y `021`: **`4213568`**;
  - `company-links.ts`: `2e05222`.
- **Búsqueda en el árbol de `a235680`:** `git grep` de «Ver perfil», `company_profiles`, `CompanyProfileView`, `next_departure_date`, `libro-de-reclamaciones` y `complaint_book` no devuelve **ninguna** coincidencia en `frontend/src`, `backend/src` ni `database`.
- **Tarjeta en `a235680`:** `CompanyCard` solo tiene un enlace, «Ver viajes», con `to={`/buscar?company_id=${company.id}&date=${todayIso()}`}`. El nombre y el logo no son enlaces.
- **Rutas en `a235680`:** solo `empresas`, sin `empresas/:slug`.
- **Fase 8:** en `a235680`, «Ver viajes» usaba siempre **hoy**. La fecha de la próxima salida la añadió F18-19D.

**Por qué no se usó `git revert`.** `4213568` mezcla el perfil con el Libro de Reclamaciones, las páginas legales, el SEO y cambios de infraestructura. Revertir los commits de F18-19 habría eliminado funciones independientes. Se hizo una restauración controlada, archivo por archivo, en un único commit nuevo.

## 4. Funcionalidades eliminadas (perfil público)

- **Página pública:** `/empresas/:slug` (`CompanyProfilePage`, `CompanyProfileView`) y, en consecuencia, cualquier subruta.
- **Tarjeta:** botón «Ver perfil» y los enlaces del nombre y el logo al perfil.
- **API pública:** `GET /api/public/companies/:slug`, `…/:slug/gallery` y `…/:slug/reviews`. El listado ya no devuelve `slug` ni `tagline`.
- **Panel de empresa:** menú y página «Perfil público» (`/company/profile`, `CompanyPublicProfilePage`, `ProfileEditors`) y toda la API `/api/company/profile/*` (perfil, imágenes, servicios, agencias, galería, envío a revisión y vista previa).
- **Moderación ADMIN:** menú y página «Perfiles públicos» (`/admin/company-profiles`) y la API `/api/admin/company-profiles/*`.
- **Módulos de backend solo del perfil:** `company-profile.service.ts`, `company-profile.routes.ts`, `company-profile.validators.ts`, `utils/image-dimensions.ts` y el tipo de almacenamiento `company-media` de `file-storage.service.ts`, que se restauró a `a235680`.
- **Módulos de frontend solo del perfil:** `services/company-profile.ts`, `types/company-profile.ts` y `utils/company-profile.ts` con su prueba.
- **Prueba backend:** `83-f1819-perfil-empresas.test.ts` (42 pruebas del perfil).
- **Seed DEMO** (`seed-demo-staging.mjs`): la parte que creaba y publicaba el perfil, los servicios y las agencias del DEMO.
- **«Ver viajes» con la próxima salida (F18-19D):** retirado por decisión del propietario. Salen `next_departure_date` de
  `GET /api/public/companies`, `utils/company-links.ts` y su prueba. La tarjeta vuelve a `date=<hoy>`, como en `a235680`.

## 5. Funcionalidades conservadas

- **Libro de Reclamaciones:**
  - formulario y consulta públicos (`/libro-de-reclamaciones`, `POST /api/public/complaints` y `…/lookup`);
  - bandeja del ADMIN (`/admin/complaints`) y de la empresa (`/company/complaints`);
  - servicio `complaint-book.service.ts` sin cambios y prueba `84-f1819-libro-reclamaciones` (18/18).
  - Su código se trasladó sin cambios a archivos propios: `complaint-book.routes.ts`, `complaint-book.validators.ts`, `ComplaintsAdminPage.tsx`, y en el frontend `services`, `types` y `utils/complaint-book.ts`.
- **Legal:** `/informacion`, `/terminos`, `/privacidad`, `/cookies`, `/reservas-y-cancelaciones`, `/pagos`, `GET /api/public/legal` y la columna «Información útil» del pie.
- **SEO de F18-19B:** `usePageMeta`, `useCanonicalLink`, `seo.ts` y los títulos de `/empresas` y `/ayuda`.
- **Seed DEMO:** empresa, rutas, bus y viajes, más las salidas a 7 días de F18-19D. Es solo siembra de datos, no el
  comportamiento de «Ver viajes»: con una salida diaria a las 20:00, la búsqueda de «hoy» del DEMO tiene viajes hasta esa
  hora. No se borra la empresa DEMO ni sus viajes.
- **Base de datos:** migraciones `020` y `021` en el historial y tablas y datos intactos. `schema-reference.json`, la purga de QA y la limpieza de la base de pruebas siguen contemplando esas tablas.
- **Infraestructura:** sin cambios. Se mantienen la plantilla con `frame-src` de OpenStreetMap y la corrección F-01 de caché de errores; cambiar las plantillas exigiría actualizar pilas.
- **Todo lo anterior a F18-19:** intacto. Frente a `a235680`:
  - la tarjeta (`CompanyCard.tsx`), el tipo del listado (`services/index.ts`) y el endpoint `/public/companies` son **idénticos**;
  - `InfoPages.tsx` solo añade el SEO de F18-19B;
  - el menú del panel solo difiere en las entradas del Libro, y las rutas solo en las páginas legales y del Libro.

## 6. Cambios realizados

Commit `75ea4ce` (41 archivos) más el ajuste de «Ver viajes» (8 archivos):
- **Eliminados (18 + 2):** los módulos de perfil de la sección 4, más `company-links.ts` y su prueba.
- **Añadidos (9):** los módulos del Libro trasladados, la prueba `85-empresas-listado.test.ts` y `utils/complaint-book.test.ts`.
- **Modificados (14):** rutas, menús, listado, tarjeta, servicio del listado, almacenamiento, seed, `package.json` y notas en `README.md`, `PRODUCCION.md`, `MIGRATIONS.md` y `STAGING-RUNBOOK.md` indicando que las tablas de la `020` se conservan sin uso.

No hubo ningún cambio de esquema, migración, AWS ni datos.

## 7. Tests

| Suite | Resultado |
|---|---|
| Backend MariaDB 10.4 | **2160/2160** (2196 − 42 del perfil + 6 del listado) |
| Backend MariaDB 10.11 | **2160/2160** |
| Security (35 archivos, ambos motores) | **957/957** (993 − 42 + 6) |
| Frontend (`node --test`) | **29/29** (sin las 3 pruebas de `company-links`) |
| Typecheck | PASS (backend y frontend) |
| Lint | PASS (frontend, 0 avisos) |
| Build | PASS · `index-DD4jTN7K.js` 285,69 kB; el bundle no contiene «Ver perfil», `CompanyProfileView`, «Perfil(es) público(s)» ni `next_departure_date` |
| Listado, backend (`85-empresas-listado`) | **6/6** |
| Listado en el navegador (local, Chrome headless) | **22/22** |

**Cierres del proceso de Node en Windows (`0xC0000409`).** En dos ejecuciones, un archivo de pruebas terminó a los
~0,8 s por un cierre del proceso de Node, antes de ejecutar ninguna prueba; no fue una aserción fallida:
- `15-itinerary-payment.test.ts`, en la primera pasada en 10.4 de `75ea4ce`;
- `78-bootstrap-admin-readiness.test.ts`, en la primera pasada en 10.11 del ajuste.

Ninguno de los dos toca nada de lo cambiado. Aislados dieron 25/25 (dos veces) y 29/29, y la suite completa repetida dio
2160/2160 en ambos casos. Queda como pendiente técnico investigar esos cierres del entorno local (Node 24 en Windows).

`85-empresas-listado.test.ts` (backend) comprueba:
- el listado, con sus datos básicos y rutas, sin `slug` ni `tagline`;
- que el listado ya no trae `next_departure_date` («Ver viajes» usa hoy);
- 404 del perfil y de sus subrecursos;
- 404 del panel de edición y de la moderación;
- que el Libro de Reclamaciones y los datos legales siguen disponibles.

La prueba en el navegador cubre los 10 puntos pedidos:
1. `/empresas` carga.
2. Las empresas aparecen.
3. «Ver viajes» existe.
4. «Ver viajes» va a `/buscar?company_id=<id>&date=<HOY>`, y la API ya no trae `next_departure_date`.
5. No aparece «Ver perfil».
6. El nombre no es enlace.
7. El logo no es enlace; hay un único enlace por tarjeta.
8. `/empresas/<slug>` da el 404 general.
9. Las 7 subrutas dan el 404 general.
10. No hay enlaces al perfil.

Además comprueba que «Ver viajes» muestra lo mismo que el buscador para esa fecha, y que la consola y la red están limpias.

## 8. Estado de /empresas

El listado original, con cada tarjeta mostrando:
- monograma o logo, sin enlace;
- «Empresa verificada»;
- nombre, sin enlace;
- descripción de la empresa;
- «N rutas activas»;
- **[ Ver viajes ]** como único enlace.

El título SEO es «Empresas de transporte interprovincial | BusPerú».

## 9. Estado de Ver viajes

Comportamiento de `a235680`: `/buscar?company_id=<id>&date=<hoy>` (hora de Lima), sin calcular ni seleccionar la
próxima salida.

En local lleva a `/buscar?company_id=1&date=2026-09-26` y muestra «0 viajes encontrados», lo mismo que la API para ese
día: los viajes de prueba son de otra fecha. Es el comportamiento original. Si una empresa no tiene salidas hoy, la
búsqueda sale vacía y el visitante cambia la fecha en el buscador.

## 10. Estado de /empresas/:slug

La ruta no existe: `/empresas/<slug>` y `/empresas/<slug>/{nosotros,servicios,agencias,destinos,flota,opiniones,contacto}` muestran el **404 general** («Página no encontrada»). `GET /api/public/companies/<slug>` responde 404.

Los datos de perfiles que ya existan, como el perfil del DEMO en staging, quedan en la base de datos sin ninguna vía de acceso.

## 11. Producción

**NOT DEPLOYED.** No se tocó AWS.

## 12. Staging

**NOT MODIFIED en esta fase.** Staging sigue sirviendo F18-19D: backend `2026-09-26-2` y web `2026-09-26-4`. Por tanto, todavía muestra «Ver perfil» hasta que se autorice el despliegue.

Al desplegar:
- Hará falta **una release nueva del backend**, porque ninguna release anterior en el bucket corresponde a este estado, además de publicar el frontend.
- **No se necesita migración.**
- El seed DEMO ya no llama a los endpoints de perfil.

## 13. Commit de rollback

- `75ea4ce` — `revert(public): restore company listing without profiles`: commit nuevo sobre `846d26f` con el rollback y
  la primera versión de este informe.
- Ajuste de «Ver viajes» a la fecha de hoy — `fix(public): open company trips on today's date`: commit nuevo sobre
  `75ea4ce` que actualiza este informe.

No se modificó ni reescribió ningún commit anterior (`75ea4ce`, `f8725ad`, `846d26f`, `2e05222`, `da4d474`, `4213568`,
`a235680`), sin reset ni force push.

## 14. HEAD == origin/master

Se verifica tras el `git push origin master` normal. Los 5 archivos heredados sin seguimiento (`F18-12-COMMIT-PREP.md`, `F18-12A-…`, `F18-12B-…`, `F18-12C-…` y `qa-manifest-e2e-mug3ixsf.json`) no se incluyeron ni se modificaron: su SHA-256 es idéntico.
