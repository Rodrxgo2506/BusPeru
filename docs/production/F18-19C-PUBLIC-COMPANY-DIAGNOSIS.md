# F18-19C — Diagnóstico de acceso al perfil público

> Solo diagnóstico, del 26/09/2026. No se modificó código, AWS, staging ni datos DEMO. Sin commit ni push.
>
> **Evidencias:**
>
> - código del repositorio (`HEAD` `4213568` + los cambios de F18-19B sin commit, que no tocan estos componentes);
> - API pública de staging, sin autenticación;
> - navegador headless contra staging, en solo lectura;
> - la lectura de la base de staging del cierre de F18-19B (mismo día);
> - `F18-10-DEMO-STAGING.md`.
>
> Una consulta adicional de solo lectura a la base no se pudo ejecutar porque la sesión MFA había caducado; la salvaguarda del script se detuvo sin ejecutar nada.

## 1. Problema observado

En `https://d25z2lpl1efut1.cloudfront.net/empresas` la única tarjeta es **BusPerú Demo**: «Empresa verificada», su descripción DEMO, «6 rutas activas» y un único botón **«Ver viajes»**. No hay forma visible de entrar al perfil público `/empresas/:slug` con sus 9 secciones.

## 2. Ruta pública implementada

| | |
| --- | --- |
| ¿Existe `/empresas/:slug`? | **Sí**: `frontend/src/routes/index.tsx:180`, `<Route path="empresas/:slug" element={<CompanyPublicPage />} />` (lazy `CompanyProfilePage`), bajo `PublicLayout` |
| Listado | `path="empresas"` → `CompaniesPage` (`frontend/src/pages/public/InfoPages.tsx`) |
| Campo del slug | `company_profiles.slug` (único). Se genera del nombre al crear el perfil (`ensureProfile` + `slugify`) y solo el ADMIN lo cambia |
| Cuándo existe un perfil | se crea **en borrador** la primera vez que un COMPANY_ADMIN (o el ADMIN para esa empresa) abre «Perfil público» (`GET /company/profile`). No se crea solo al dar de alta la empresa |
| Cuándo es público | fila en `company_profiles` **con `published_content`** (aprobado por un ADMIN) **y** sin `suspended_at` **y** empresa `ACTIVE` (`publicCompanyBySlug`, `company-profile.service.ts`) |

## 3. Slug real de BusPerú Demo

**No tiene.** El DEMO (empresa `id 16`, `ACTIVE`) **no tiene perfil público**: ni publicado ni, según la última lectura de la base, en borrador.

| Fuente | Resultado |
| --- | --- |
| `GET /api/public/companies` (staging, hoy) | `{"id":16,"name":"BusPerú Demo","slug":null,"tagline":null,…,"routes_count":6}` |
| Base de staging (lectura al cierre de F18-19B, hoy) | `company_profiles`: **0 filas en toda la base** (tampoco servicios, agencias, galería ni hojas del Libro) |
| Siembra del DEMO (`infra/aws/scripts/seed-demo-staging.mjs`, F18-10) | anterior a F18-19: no contiene ninguna referencia a perfiles |

`busperu-demo` es solo el slug que se **generaría** a partir del nombre si se creara el perfil; no existe. No se inventa otro.

## 4. Endpoint público

| | |
| --- | --- |
| Perfil | `GET /api/public/companies/:slug` → `publicProfile(slug)`; sin perfil publicado → 404 `{"success":false,"message":"Empresa no encontrada"}` |
| Galería / opiniones | `GET /api/public/companies/:slug/gallery?page` · `GET …/:slug/reviews?page` |
| Listado | `GET /api/public/companies` → cada empresa `ACTIVE` con `slug` y `tagline` **solo si tiene perfil publicado** (`publicSlugs()`); si no, `null` |
| Cliente | `publicCompanyService.profile(slug)` (`frontend/src/services/company-profile.ts:76`) |

**Comprobado hoy en staging:** `GET /api/public/companies/busperu-demo` → **404** «Empresa no encontrada». `/api/ready` → 200.

## 5. Resultado de acceso directo

`https://d25z2lpl1efut1.cloudfront.net/empresas/busperu-demo` muestra «**Empresa no encontrada** · Esta empresa no tiene un perfil público disponible o la dirección no es correcta · Ver empresas». La API da 404.

Es el comportamiento correcto para una empresa sin perfil publicado, no un fallo de routing.

**La ruta y la vista sí funcionan.** En F18-19A y F18-19B se comprobaron en este mismo staging con empresas de QA con perfil aprobado:

- `/empresas/<slug>` renderiza las 9 secciones en 3 tamaños, con el mapa bajo demanda, SEO y 0 errores;
- el listado enlazaba el perfil;
- esas empresas de QA se purgaron al terminar cada fase.

Es decir: **el perfil público funciona directamente cuando existe. El DEMO no tiene uno, y además la tarjeta no ofrece un enlace identificable al perfil** (§6).

## 6. Comportamiento de /empresas

`CompaniesPage` (`InfoPages.tsx:47-57`) pinta una `CompanyCard` por empresa con:

```tsx
to={company.slug ? `/empresas/${company.slug}` : `/buscar?company_id=${company.id}&date=${todayIso()}`}
```

`CompanyCard` (`frontend/src/components/companies/CompanyCard.tsx`) tiene **un único enlace**, el botón, con el texto **fijo «Ver viajes»**, sea cual sea el destino.

- **Con perfil publicado:** el botón dice «Ver viajes» pero lleva al **perfil**. La etiqueta no corresponde al destino, no hay un «Ver perfil» reconocible y se pierde el acceso directo a los viajes de la empresa.
- **Sin perfil (caso del DEMO):** el botón lleva a la búsqueda. Es coherente con su texto, pero no hay forma de llegar a un perfil que no existe.
- El nombre, el logo y el resto de la tarjeta **no son enlaces**. Tampoco hay ningún elemento oculto que abra el perfil.

**Inspección real en staging** (navegador headless): una tarjeta, «BusPerú Demo», con un solo enlace «Ver viajes» → `href="/buscar?company_id=16&date=2026-09-26"`.

**Diseño de F18-19:** la tarjeta **se adaptó para abrir el perfil** cuando existe (comentario «con perfil público aprobado, la tarjeta lleva al perfil; si no, al buscador como antes»). Solo se cambió el destino del enlace; ni la etiqueta ni un segundo CTA. Ninguna validación de F18-19A/B comprobó el **texto** del botón.

## 7. Comportamiento de «Ver viajes»

| | |
| --- | --- |
| Destino (DEMO) | `/buscar?company_id=16&date=<hoy, hora de Lima>` |
| Qué hace | búsqueda de **todos los orígenes → todos los destinos** de esa empresa en esa fecha (`GET /api/public/trips?company_id=16&date=…`; todos los filtros son opcionales) |
| Resultado hoy | **0 viajes**, con la fecha de hoy y también sin fecha. La búsqueda pública solo lista viajes `SCHEDULED/BOARDING/DELAYED` con salida `>= NOW()` |
| Por qué | según `F18-10-DEMO-STAGING.md`, los viajes DEMO se crearon **relativos al momento de la siembra** («mañana 20:00» y «pasado mañana 08:00»), y el propio documento advierte que «los viajes pasan con el tiempo» y que hay que volver a ejecutar `seed-demo-staging.mjs --execute` otro día para añadir salidas futuras. Hoy el DEMO **no tiene salidas futuras** |

Hallazgo secundario, ajeno al perfil: el botón funciona, pero muestra una búsqueda vacía.

## 8. Datos actuales del DEMO

| Bloque | Estado | Fuente |
| --- | --- | --- |
| Empresa | `id 16`, «BusPerú Demo», `ACTIVE`, descripción DEMO, **sin logo**, correo y teléfono ficticios | API pública + F18-10 |
| Perfil público (aprobado o borrador) | **no existe** | API (`slug null`) + base (0 filas) |
| Nosotros, historia, misión, visión, valores | **no existen** (serían campos del perfil) | idem |
| Servicios | **0** | base al cierre de F18-19B |
| Agencias, horarios y servicios por agencia | **0** | idem |
| Galería | **0** | idem |
| Contacto y redes del perfil | **no existen** (el contacto de la empresa no se muestra en `/empresas`) | idem |
| Destinos (derivados de rutas) | 6 rutas activas entre las 4 terminales DEMO (Lima, Pucallpa, Cusco, Arequipa) | API (`routes_count 6`) + F18-10 |
| Viajes futuros | **0** hoy | API de búsqueda |
| Flota (derivada de buses) | 1 bus DEMO (`DEMO-01`, placa ficticia `DEMO-001`, 40 asientos) según F18-10. Estado actual no releído en esta fase | F18-10 |
| Opiniones | 0 publicadas; `rating null` | API pública |
| Usuarios DEMO | 3 (COMPANY_ADMIN, OPERATOR y CUSTOMER de F18-10) | F18-10 + base (3 usuarios DEMO) |

No se creó ni se modificó ningún dato.

## 9. Causa

**Clasificación:**

1. **Datos DEMO incompletos (causa principal, respuestas B + D del brief).** El DEMO nunca tuvo perfil público. La siembra de F18-10 es anterior a F18-19 y el perfil solo nace cuando una empresa lo edita y un ADMIN lo aprueba. Sin perfil publicado, la API devuelve `slug: null` y el listado enlaza, correctamente según su lógica, a la búsqueda. **No hay bug de routing ni de backend.**
2. **UX/enlace faltante (causa de fondo, respuestas A + C).** Aunque hubiera perfil, la tarjeta no lo haría descubrible. Su único botón conserva el texto «Ver viajes» aunque lleve al perfil, no hay un «Ver perfil» ni ninguna otra parte clicable, y al redirigir el botón al perfil desaparece el acceso directo a los viajes. Es un defecto real de F18-19, menor y de interfaz.
3. **Datos DEMO caducados (hallazgo secundario, respuesta E).** El DEMO no tiene viajes futuros, así que «Ver viajes» muestra 0 resultados.

No es: un bug de routing (la ruta existe y responde bien), ni un bug de backend (el 404 es el contrato: sin perfil publicado no hay página), ni un problema de despliegue.

## 10. Archivos involucrados

| Archivo | Papel |
| --- | --- |
| `frontend/src/components/companies/CompanyCard.tsx` | tarjeta con un único CTA de texto fijo «Ver viajes» |
| `frontend/src/pages/public/InfoPages.tsx` (`CompaniesPage`) | elige el destino del CTA según `slug` |
| `frontend/src/routes/index.tsx:179-180` | rutas `empresas` y `empresas/:slug` |
| `frontend/src/pages/public/CompanyProfilePage.tsx` + `components/company-profile/CompanyProfileView.tsx` | perfil público (correcto) |
| `backend/src/routes/public.routes.ts` (`/companies`, `/companies/:slug`) · `backend/src/services/company-profile.service.ts` (`publicSlugs`, `publicCompanyBySlug`, `ensureProfile`) | slug solo si el perfil está publicado; perfil perezoso |
| `infra/aws/scripts/seed-demo-staging.mjs` | siembra DEMO sin perfil público y con viajes relativos a su fecha de ejecución |

## 11. Corrección propuesta (no aplicada)

**1. Tarjeta del listado (código, frontend).**

- Con `slug`: CTA principal **«Ver perfil»** → `/empresas/:slug` y CTA secundario **«Ver viajes»** → `/buscar?company_id=…`.
- Sin `slug`: solo «Ver viajes», como hoy.
- Opcional: que el nombre o el logo de la tarjeta enlacen al perfil cuando existe.
- `CompaniesPage` pasaría dos destinos (`profileTo?`, `tripsTo`) en lugar de uno.
- Añadir una comprobación automática del texto y destino de los CTA, por ejemplo con una función pura testeable o en el QA de interfaz, porque F18-19A/B no la tenían.

**2. Perfil público del DEMO (datos de staging; requiere decisión y autorización).** Crearlo por el **flujo oficial**: el COMPANY_ADMIN DEMO lo completa en «Perfil público», lo envía y el ADMIN lo aprueba. Lo más reproducible sería ampliar `seed-demo-staging.mjs` (idempotente, por la API) con contenido **explícitamente marcado como DEMO/ficticio**, como el resto de F18-10. Hay que decidir:

- el texto;
- si incluir agencias con coordenadas genéricas;
- las imágenes, que tendrían que ser propias o libres;
- que no parezca una empresa real.

Esta fase no lo hace porque el brief prohíbe crear o rellenar datos DEMO.

**3. Viajes DEMO (datos de staging; operación ya documentada).** Volver a ejecutar `seed-demo-staging.mjs --execute`, que según F18-10 solo añade las salidas futuras que falten. Opcional y con autorización.

## 12. Impacto

| | |
| --- | --- |
| Usuarios de staging | no pueden ver ningún perfil público desde `/empresas`, porque el único que existe, el DEMO, no tiene perfil. «Ver viajes» del DEMO muestra una búsqueda vacía |
| Producción (cuando exista) | las empresas con perfil aprobado serían accesibles, pero con un botón «Ver viajes» que lleva al perfil (etiqueta engañosa) y sin acceso directo a sus viajes desde el listado |
| Seguridad / datos | ninguno |
| Validaciones anteriores | los resultados de F18-19A/B siguen siendo válidos (el perfil, la API y el enlace por `slug` funcionan), pero no cubrían el texto del CTA ni el estado del DEMO |

## 13. ¿Requiere código?

**Sí**, para la corrección 1 (tarjeta del listado: frontend, cambio pequeño, sin backend). **No** para las correcciones 2 y 3, que son datos de staging por flujos existentes; ampliar la siembra DEMO sí sería código de herramienta.

## 14. ¿Requiere AWS?

- **Corrección 1:** sí, **solo para desplegarla en staging** (publicar el frontend con `publish-web.mjs --env staging` e invalidar según el procedimiento). Sin cambios de infraestructura.
- **Correcciones 2 y 3:** sí, operaciones de datos en staging por la API (con autorización).
- **Esta fase:** ninguna acción en AWS.

## 15. ¿Requiere migración?

**No.** El esquema (020/021) ya soporta todo; ninguna corrección cambia tablas.

## 16. Estado de producción

**NOT DEPLOYED**

`PRODUCTION_DEPLOYED=NO` · `PRODUCTION_DATABASE_CHANGED=NO` · `PRODUCTION_INFRA_CHANGED=NO`. En esta fase no se ejecutó ningún comando sobre AWS que modificara algo, ni en staging ni en producción.
