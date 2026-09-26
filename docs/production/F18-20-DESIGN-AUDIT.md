# F18-20 · Auditoría de diseño — sitio público de empresas

Fecha: 2026-09-26 · Base: `2e05222` (HEAD = origin/master) · Alcance: LOCAL (auditoría previa a cualquier cambio de código).

Las capturas de referencia (sitio de otra empresa de transporte) se usan **solo como referencia visual de estructura**
(hero con breadcrumb, pestañas pegadas a una tarjeta, bloque de ayuda con formulario, pie corporativo). No se copian
textos, imágenes, colores ni identidad: el sitio sigue siendo BusPerú, con su naranja (`brand-*`) y su tinta/azul
(`ink #0F172A`).

---

## 1. Arquitectura actual

| Pieza | Archivo | Estado |
|---|---|---|
| Ruta pública | `frontend/src/routes/index.tsx:180` · `empresas/:slug` → `CompanyProfilePage` (lazy) bajo `PublicLayout` | una única ruta |
| Página pública | `frontend/src/pages/public/CompanyProfilePage.tsx` (83 líneas) | carga `publicCompanyService.profile(slug)`, `usePageMeta` + JSON-LD `Organization`, 404 «Empresa no encontrada» |
| Vista | `frontend/src/components/company-profile/CompanyProfileView.tsx` (773 líneas) | **una página larga** con 9 secciones ancla (`#inicio … #contacto`) y una barra de secciones `sticky top-16` |
| Vista previa del panel EMPRESA | `pages/company/CompanyPublicProfilePage.tsx` → pestaña «Vista previa» usa `CompanyProfileView` con `companyProfileService.preview()` | copia de trabajo, marcada |
| Vista previa de moderación ADMIN | `pages/admin/PublicContentAdminPages.tsx` usa `CompanyProfileView` | copia de trabajo |
| Armazón público | `layouts/PublicLayout.tsx` | cabecera global `sticky top-0 z-40` (h-16 / lg:h-[72px]), pie global con Libro de Reclamaciones, `useCanonicalLink(pathname)`, barra inferior móvil `fixed z-40` |
| SEO | `hooks/usePageMeta.ts` (título, description, og:*, og:url canónica, JSON-LD) · `utils/seo.ts` `canonicalUrl` | reutilizable por ruta |
| Utilidades | `utils/company-profile.ts` (horarios, agrupación por ciudad, OSM, `safeExternalUrl` solo https, `searchTripsUrl`, `telUrl`, `whatsappUrl`, etiquetas) | reutilizable |
| Tarjeta de empresa | `components/companies/CompanyCard.tsx` + `utils/company-links.ts` (F18-19D) | enlaza a `/empresas/<slug>` |

## 2. Endpoints públicos (se reutilizan; no se crean nuevos)

- `GET /api/public/companies/:slug` → `{ company{id,name,logo_url,description}, slug, profile{tagline, cover_image, about_title,
  about_body, history, mission, vision, values_list, about_image, contact_phone, contact_whatsapp, contact_email, website_url,
  social_links, main_address}, reviews{rating,total,distribution}, services[], agencies[], gallery{items,total,page_size}, destinations[], fleet[] }`.
  404 sin distinguir motivo si el perfil no está publicado, está suspendido o la empresa no está ACTIVE (aislamiento y
  no exposición ya garantizados en backend, F18-19/F18-19B).
- `GET /api/public/companies/:slug/gallery?page` (12 por página) · `GET /api/public/companies/:slug/reviews?page&limit`.
- `GET /api/public/companies` (listado con `slug`, `next_departure_date`).
- Búsqueda de viajes: `/buscar?origin&destination&date&company_id` (flujo real existente).

## 3. Datos disponibles por página

| Página | Datos | Huecos |
|---|---|---|
| Inicio | nombre, logo, tagline, cover_image, description, contadores (destinos, agencias, servicios, buses), destinos, servicios, contacto | — |
| Nosotros | about_title, about_body, history, mission, vision, values_list, about_image, galería paginada | valores sin descripción (solo texto corto) → tarjetas con el texto |
| Servicios | name, description, features, image | — |
| Agencias | name, city, department, address, reference, phone, whatsapp, email, services, weekly_hours, special_hours, latitude/longitude, image | sin coordenadas → texto fijo, sin mapa |
| Destinos | city, department, destination editorial (slug, name, subtitle, image), upcoming_trips, min_price, origins | **sin fecha de próxima salida**: «Buscar viajes» abre la fecha de hoy y puede salir vacío |
| Flota | type, description, buses, min/max capacity, amenities | **no hay imágenes de flota en el modelo** → ilustración/ícono (sin placas, códigos ni ids: ya garantizado) |
| Opiniones | resumen + distribución + listado paginado con respuesta de la empresa | — |
| Contacto | contact_phone, contact_whatsapp, contact_email, website_url, social_links, main_address | **no hay endpoint de mensajes de contacto** |

## 4. Decisiones (documentadas antes de implementar)

1. **Rutas anidadas** bajo `empresas/:slug` con un `CompanySiteLayout` que carga el perfil **una sola vez** y lo pasa a
   cada página por el contexto del `Outlet` (cambiar de sección no vuelve a pedir datos). Rutas hijas: `index` (Inicio),
   `nosotros`, `servicios`, `agencias`, `destinos`, `flota`, `opiniones`, `contacto`, y `*` → «Página no encontrada» dentro
   del sitio de la empresa. **No hay ruta `galeria`**: la galería vive en Nosotros.
2. **Cabecera de empresa** propia (logo + nombre + menú interno), pegajosa debajo de la cabecera global
   (`top-16 lg:top-[72px]`, `z-30` < `z-40` global), con `NavLink` (`end` en Inicio) y estado activo, CTA «Buscar viajes»
   y «Contacto». En móvil: botón con `aria-expanded`/`aria-controls`, panel desplegable, cierre con Escape y al navegar.
   El menú muestra las 8 secciones siempre (cada una tiene estado vacío profesional), para que la navegación sea estable.
3. **Hero por página** (`CompanyPageHero`): `cover_image` de la empresa con velo oscuro, título centrado y breadcrumb
   «Inicio / Sección»; sin imagen → degradado BusPerú (naranja → tinta) con patrón geométrico CSS. **Nunca** imágenes
   de `constants/images.ts` (Wikimedia) ni URL externas. Nosotros usa `about_image` si no hay portada.
4. **Pie de empresa** (`CompanySiteFooter`) al final de cada página: logo, nombre, secciones, contacto configurado y
   redes; debajo se mantiene el pie global de BusPerú (Libro de Reclamaciones y legales siguen visibles).
5. **Formularios «¿Necesitas ayuda?» (Inicio) y «Contáctanos» (Contacto)**: no existe endpoint público de mensajes
   (los tickets de soporte exigen sesión y un usuario) y crear tablas está prohibido. Se implementa como
   **redacción asistida**: el formulario valida y abre el correo del visitante (`mailto:` al `contact_email` de la empresa)
   con asunto y cuerpo prellenados, y, si la empresa configuró WhatsApp, ofrece enviarlo por WhatsApp. BusPerú no
   guarda nada (aviso visible). Sin `contact_email` ni WhatsApp el formulario no se muestra y se enseñan los canales
   existentes. Pendiente técnico: bandeja de mensajes de empresa (requiere tabla y moderación; fuera de alcance).
6. **Próxima salida** (cambio mínimo en el endpoint existente, sin tablas ni endpoints nuevos): se añade
   `next_departure_date` a la empresa en `GET /public/companies/:slug` (misma regla que el listado F18-19D) y a cada
   destino y origen de `destinations[]`, para que «Buscar viajes»/«Ver viajes» abran una fecha con salidas. Si no hay
   salidas, se usa hoy (comportamiento actual). Con prueba backend.
7. **Vista previa del panel y de moderación**: se mantiene `CompanyProfileView` (una página) sin cambios para no romper el
   flujo editar → enviar → aprobar ni la moderación ADMIN. Pendiente técnico: previsualizar con el nuevo diseño.
   `CompanyProfilePage.tsx` deja de usarse y se elimina.
8. **SEO por ruta**: título «<Empresa> | BusPerú» en Inicio y «<Sección> | <Empresa>» en subpáginas; description
   específica por sección; og:image = portada si existe; canónica por ruta (ya la pone `PublicLayout`); JSON-LD
   `Organization` en Inicio y `BreadcrumbList` en subpáginas.
9. **Inicio limitado**: resumen, 4 contadores, hasta 3 destinos y 3 servicios destacados con «Ver todos», CTA
   «Reserva tu próximo viaje», «¿Necesitas ayuda?». No incluye las secciones completas de Servicios/Agencias/Contacto.
10. **Mapas**: se conserva OpenStreetMap embebido, solo con coordenadas válidas (`isValidCoordinate`, límites de Perú) y
    solo cuando el visitante lo pide (carga diferida); sin coordenadas: «No hay ubicación disponible para mostrar en el
    mapa.». No se inventan coordenadas.
11. **Galería** (en Nosotros): carrusel accesible (anterior/siguiente, indicadores, teclado ←/→) + cuadrícula con
    lightbox (`Modal`) y «Ver más fotos» paginado; sin fotos: estado vacío elegante.
12. **DEMO**: no se cambian datos salvo necesidad (no se prevé): sin imágenes ni coordenadas inventadas.

## 5. Archivos

**Nuevos (frontend)**
- `src/utils/company-site.ts` (+ `company-site.test.ts`): modelo de navegación, metadatos por ruta, límites del Inicio,
  construcción de mensajes `mailto:`/WhatsApp, selección de fecha de próxima salida, validación del formulario.
- `src/components/company-site/` : `CompanySiteLayout.tsx` (carga + contexto + cabecera + pie), `CompanySiteHeader.tsx`,
  `CompanySiteFooter.tsx`, `CompanyPageHero.tsx`, `CompanyContactForm.tsx`, `CompanyGallery.tsx`, `shared.tsx` (estrellas, títulos, vacíos).
- `src/pages/public/company-site/` : `HomePage.tsx`, `AboutPage.tsx`, `ServicesPage.tsx`, `AgenciesPage.tsx`,
  `DestinationsPage.tsx`, `FleetPage.tsx`, `ReviewsPage.tsx`, `ContactPage.tsx`, `NotFoundPage.tsx`.

**Modificados**
- `frontend/src/routes/index.tsx` (rutas anidadas), `frontend/package.json` (script de pruebas), `frontend/src/types/company-profile.ts`
  (`next_departure_date` opcional).
- `backend/src/services/company-profile.service.ts` (`next_departure_date`), `backend/src/test/83-f1819-perfil-empresas.test.ts`.

**Eliminado**: `frontend/src/pages/public/CompanyProfilePage.tsx` (sustituido por el layout).

## 6. Riesgos

| Riesgo | Mitigación |
|---|---|
| Romper la vista previa del panel/moderación | `CompanyProfileView` no se toca |
| Doble cabecera pegajosa tapando contenido | cabecera de empresa bajo la global (`top-16/lg:top-[72px]`, `z-30`), altura contenida; QA 375–1920 |
| Desbordamiento horizontal del menú | menú de escritorio solo ≥ lg; móvil en panel desplegable |
| Peticiones repetidas al cambiar de sección | carga única en el layout (contexto del Outlet) |
| CSP (iframes, imágenes) | solo OSM (ya permitido) y medios propios (`mediaUrl`) |
| Mailto sin cliente de correo | se muestra el correo en claro y opción WhatsApp; aviso de que BusPerú no guarda el mensaje |
| Regresión de F18-19/B/D (tarjeta «Ver perfil», 404, aislamiento, sin ids) | pruebas backend 42 + nuevas, `flujo.mjs`, QA 51 |
| Cabeceras 404 cacheadas en CloudFront | ya corregido (F-01, `ErrorCachingMinTTL: 0`); rutas hijas son del SPA |
