# F18-20 · Rediseño del sitio público de empresas — informe de implementación

Fecha: 2026-09-26 · Base: `2e05222` · Entornos: LOCAL y STAGING (sa-east-1). **Producción no se toca.**

---

## 1. Objetivo

Convertir el perfil público de cada empresa (`/empresas/:slug`, antes una única página larga con anclas) en un
mini sitio corporativo con una ruta por sección, cabecera y pie propios, y la misma marca BusPerú (naranja `brand-*`
y tinta `ink`). Las capturas de otra empresa de transporte se usaron **solo como referencia de estructura**: no se
copió ningún texto, imagen, color ni identidad.

## 2. Auditoría

Antes de tocar código se escribió `docs/production/F18-20-DESIGN-AUDIT.md`, que recoge:
- la arquitectura y los endpoints existentes;
- los datos disponibles por página y sus huecos;
- 12 decisiones, los archivos y los riesgos.

Conclusiones clave:
- **Nada exige tablas ni endpoints nuevos.**
- **Hueco real: no hay buzón de mensajes para empresas.** Los formularios entregan el mensaje por el correo o el WhatsApp de la empresa y BusPerú no guarda nada. El buzón queda como pendiente técnico.
- **Hueco menor: faltaba la fecha de la próxima salida en el perfil.** Se añadió al endpoint existente.
- **La vista previa del panel y de la moderación mantiene la vista de una página.** Así no se toca el flujo editar → enviar → aprobar.

## 3. Arquitectura de rutas

Todo va bajo `PublicLayout`, dentro de `frontend/src/routes/index.tsx`:

```
empresas/:slug            → CompanySiteLayout (carga el perfil UNA vez; contexto del Outlet)
  index                   → Inicio
  nosotros                → Nosotros (incluye la Galería)
  servicios · agencias · destinos · flota · opiniones · contacto
  *                       → «Página no encontrada» dentro del sitio (p. ej. /galeria)
```

- **Sin ruta de galería:** `/empresas/x/galeria` responde «Página no encontrada».
- **Un único fragmento:** las páginas se cargan juntas (`pages/public/company-site/index.ts`, 74,8 kB), con un límite `Suspense` propio. Cambiar de sección no descarga código ni vuelve a pedir el perfil.
- **Empresa no encontrada:** un slug inexistente, no publicado, suspendido o inactivo muestra «Empresa no encontrada» en cualquiera de sus rutas. La API ya devolvía 404 sin distinguir el motivo.
- **Cabecera de empresa** (`CompanySiteHeader`):
  - barra oscura bajo la cabecera global (`sticky top-16 / lg:top-[72px]`, `z-30`);
  - logo y nombre, menú de 8 secciones con `NavLink` (`end` en Inicio y `aria-current`);
  - «Buscar viajes» y «Contacto»;
  - en móvil (< 1024 px), un botón con `aria-expanded`/`aria-controls` y un panel de 8 enlaces más «Buscar viajes»; se cierra con Escape (devuelve el foco) y al navegar.
- **Pie de empresa** (`CompanySiteFooter`) en todas las páginas: identidad, secciones, contacto configurado y redes. Debajo se mantiene el pie global de BusPerú, con el Libro de Reclamaciones y los legales.
- **Banner** (`CompanyPageHero`) en todas las páginas:
  - imagen propia con velo, título centrado y breadcrumb «Inicio › Sección»;
  - sin imagen, o si el archivo no carga, un degradado BusPerú con patrón CSS.

## 4. Inicio

- **Portada:** logo, «Empresa de transporte», nombre, lema, valoración con enlace a Opiniones, y los botones «Buscar viajes» y «Contacto».
- **Presentación breve:** la descripción de la empresa (en el DEMO incluye el aviso de datos ficticios) y 4 contadores enlazados a su página (destinos, agencias, servicios, buses).
- **Destinos destacados:** máximo 3, con «Ver todos los destinos».
- **Servicios destacados:** máximo 3, con «Ver servicios».
- **«Reserva tu próximo viaje»:** buscador de la empresa en la fecha de su próxima salida.
- **«¿Necesitas ayuda?»:**
  - formulario (nombre, teléfono, correo, comentario, Enviar) a la izquierda;
  - canales configurados y redes a la derecha;
  - una columna en móvil.
- **Qué no incluye:** pestañas de servicios, direcciones de agencias, «Contáctanos», web ni dirección principal. Lo verifica el QA.

## 5. Nosotros

- Banner «Nosotros» con breadcrumb «Inicio › Nosotros».
- «Quiénes somos» en dos columnas, [imagen][texto], si hay `about_image`; si no, el texto centrado.
- «Nuestra historia», Misión y Visión en bloques separados, y Valores como tarjetas (solo los configurados).
- La Galería al final.
- Sin «¿Necesitas ayuda?».
- Sin contenido publicado: «Presentación en preparación».

## 6. Galería

`CompanyGallery`:
- carrusel con imagen grande redondeada, anterior/siguiente, teclado ←/→ en la región y contador «n / N»;
- indicadores (hasta 12; con más, solo el contador) y miniaturas;
- visor ampliado (`Modal`, Escape lo cierra) con anterior/siguiente;
- «Ver más fotos» paginado (12 por página, endpoint existente).

Cada foto se identifica por su archivo (F18-19B, sin ids). Si un archivo no carga, se ve un marcador neutro, nunca el icono roto. Sin fotos, el estado vacío dice «Aún no hay fotos en la galería».

## 7. Servicios

- Una pestaña por servicio publicado: los nombres salen de los datos, nada está fijo en el código. Las pestañas van pegadas a la tarjeta.
- Teclado ←/→/Inicio/Fin con foco itinerante (`role=tablist/tab/tabpanel`).
- La tarjeta muestra imagen o ilustración, nombre, descripción, características y «Buscar viajes».

## 8. Agencias

- Pestañas por ciudad con recuento y soporte de teclado.
- Por agencia, el mapa a la izquierda y los datos a la derecha: nombre, dirección, referencia, teléfono, WhatsApp y correo si existen, servicios, horario semanal y horarios especiales.
- **Mapa:** se mantiene OpenStreetMap, que **solo se descarga al pulsar «Ver en mapa»** y solo con coordenadas válidas (`isValidCoordinate`, límites de Perú). No se inventan coordenadas.
- **Sin coordenadas:** «No hay ubicación disponible para mostrar en el mapa.».

## 9. Destinos

- Todas las tarjetas de las rutas activas: ciudad, orígenes, viajes programados, precio «desde», próxima salida y ficha editorial si existe.
- «Ver viajes» abre `/buscar?origin=<origen con la salida más próxima>&destination=…&date=<esa salida>&company_id=…`. Así la búsqueda nunca cae en un día vacío.
- «Buscar viajes» general en el banner.

## 10. Flota

- Tipos de bus activos: número de buses, capacidad y comodidades.
- **Sin placa, código, marca ni ids.** El backend ya no los enviaba y el QA lo vuelve a comprobar.
- El modelo no tiene fotos de flota, así que cada tipo lleva una ilustración.

## 11. Opiniones

- Media, estrellas, total y distribución, que incluye texto para lectores de pantalla.
- Reseñas **publicadas** con nombre de pila, fecha (`<time>`), título, comentario y respuesta de la empresa; paginación con «Ver más opiniones».
- Sin opiniones: «Aún no hay opiniones». No se muestran opiniones de ejemplo.

## 12. Contacto

- Formulario «Contáctanos» a la izquierda; canales publicados (teléfono, WhatsApp, correo, web y dirección) y redes a la derecha.
- Enlace al Libro de Reclamaciones de BusPerú.
- **Entrega del formulario:** valida y abre `mailto:` con asunto y cuerpo ya redactados. Solo acepta un correo de destino simple, sin `?`, `&` ni saltos, para evitar la inyección de destinatarios.
- Si la empresa tiene WhatsApp, ofrece «Enviar por WhatsApp». El formulario avisa de que BusPerú no guarda el mensaje.
- Sin canal de entrega, no hay formulario. Sin ningún dato: «Datos de contacto en preparación». Nada se inventa.

## 13. Responsive

| Ancho | Menú de empresa |
|---|---|
| < 1024 px | desplegable |
| 1024 px | 8 secciones + «Buscar viajes» |
| ≥ 1280 px | 8 secciones + «Buscar viajes» + «Contacto» |

- **Desborde horizontal: 0** en 8 anchos (1920, 1440, 1280, 1024, 768, 430, 390, 375) × 8 rutas, en local (Empresa A y DEMO) y en staging (DEMO).
- Se revisaron capturas de página completa y por pantalla en escritorio, 1024 y 390.

## 14. SEO

- **Títulos:** Inicio «<Empresa> | BusPerú»; subpáginas «<Sección> | <Empresa>»; ruta inexistente «Página no encontrada | <Empresa>»; empresa inexistente «Empresa no encontrada | BusPerú».
- **Descripciones:** una por ruta, todas distintas y de ≤ 160 caracteres (texto de la empresa si existe; si no, una frase neutra).
- **URLs:** `og:title`, `og:url` y `<link rel="canonical">` por ruta, con el origen real (en staging, staging).
- **Imagen:** `og:image`, con la portada o el logo.
- **JSON-LD:** `Organization` en Inicio y `BreadcrumbList` (Empresas › Empresa › Sección) en las subpáginas.

## 15. Accesibilidad

- Enlaces semánticos (`Link`/`NavLink`) y botones reales; `aria-current` en el menú y en el breadcrumb.
- Menú móvil con `aria-expanded`/`aria-controls` y Escape.
- Pestañas ARIA con foco itinerante, y carrusel con `aria-roledescription` y teclado.
- Foco visible (`focus-visible:ring`) en todos los controles.
- Formularios con `label`, `aria-invalid`, alerta de resumen y foco en el primer error.
- `alt` en las imágenes de contenido; las decorativas llevan `aria-hidden`.
- Jerarquía de encabezados con un único `h1` por página.

## 16. Tests

| Suite | Resultado |
|---|---|
| Backend 10.4 | **2197/2197** (+1: próxima salida del perfil) |
| Backend 10.11 | **2197/2197** |
| Security | **994/994** (35 archivos, ambos motores) |
| Frontend | **60/60** (+15 en `utils/company-site.test.ts`) |
| Typecheck | PASS (backend y frontend) |
| Lint | PASS (frontend, 0 avisos) |
| Build | PASS (entrada 288,7 kB; sitio de empresa 74,8 kB) |
| Smoke (staging) | **37/37** |
| E2E (staging) | **18/18** · expiry **1/1** |
| QA F18-19 + F18-19B (staging, `qa-f1819b.mjs`) | **51/51** |
| Flujo F18-19D (`flujo.mjs`, adaptado al nuevo menú) | local **13/13** · staging **13/13** |
| QA del sitio F18-20 (`qa-sitio.mjs`) | local DEMO **73/73** · staging **73/73** (CSP de producción inyectada) |
| Mapa + CSP de producción (local, agencia con coordenadas) | **70/70** |
| Vista previa de moderación ADMIN (local) | PASS |

Los 20 puntos pedidos están en `qa-sitio.mjs`:
- las 8 rutas cargan (h1, título y sin «no encontrada»);
- Nosotros contiene la Galería y la Galería no es una ruta (`/galeria` → no encontrada);
- el Inicio contiene «¿Necesitas ayuda?» con formulario;
- Servicios, Agencias y Contacto no aparecen completos en el Inicio;
- navegación activa única por ruta;
- menú móvil (abrir, Escape y foco, cerrar al navegar);
- slug erróneo → «Empresa no encontrada» (también en una subruta) y API 404;
- empresa no publicada o suspendida → API 404 y página «no encontrada»;
- aislamiento: ningún dato de otra empresa y todos los enlaces del buscador con el id propio;
- SEO por ruta.

El script comprueba además:
- consola, red y CSP;
- «Buscar viajes» y «Ver viajes», con resultados reales;
- validación del formulario, pestañas de ciudad con teclado y carrusel con visor;
- flota sin datos sensibles y opiniones reales o estado vacío.

## 17. QA visual

Capturas de página completa en los 8 anchos × 8 rutas, en local y en staging, más capturas por pantalla en 390 y 1024. Correcciones que salieron de la revisión:
- **Separación de fondos:** línea divisoria entre «¿Necesitas ayuda?» y el pie de empresa, que usan el mismo fondo oscuro.
- **Imágenes que no cargan:** banner, fondo de ayuda, galería, tarjetas, servicios, Nosotros y agencias muestran un respaldo en lugar del icono roto (`OwnImage`).

## 18. Staging

- **Backend:** release `2026-09-26-3` (SHA-256 `140288766a32…`, 178 entradas), subida a los artefactos y desplegada por SSM en `i-096d4caac0e479052`. `/api/ready` responde 200 y el servicio está activo.
- **Frontend:** `publish-web.mjs --env staging --release 2026-09-26-3` (sha256 global `6fa089d7c2c7…`, 106 archivos, bundle sin localhost ni secretos, invalidación `I7BWP8NQYY42M1BT1G99MB76EJ`).
- **Verificado:**
  - `/empresas` con la tarjeta «Ver perfil»;
  - las 8 rutas de `busperu-demo` y la ruta inexistente;
  - carga directa de cada subruta, con 200 desde CloudFront;
  - la próxima salida del DEMO (`2026-09-27`) en la empresa, en los 4 destinos y en cada origen;
  - «Buscar viajes» muestra 6 viajes.
- **DEMO:** no hizo falta cambiarlo. Sigue sin imágenes ni coordenadas; la galería y el mapa muestran sus estados vacíos, como estaba decidido.
- **Limpieza:** purga oficial de los manifiestos smoke, E2E y QA F18-20, primero el ensayo (ROLLBACK) y después la ejecución (COMMIT).
  - Quedan 2 empresas, 7 usuarios, 62 viajes, 5 reservas y 1 perfil: igual que al cerrar F18-19D.
  - Se borraron las imágenes QA y 0 hojas del Libro quedan ligadas a QA.
  - **Las 8 huellas del DEMO son idénticas** antes y después (empresa, usuarios, 60 viajes, reserva, perfil, 4 servicios, 3 agencias, 48 viajes futuros).
  - **Esquema idéntico** a `schema-reference.json`.
- La empresa heredada `E2E mug3ixsf` (INACTIVE) sigue sin tocarse.

## 19. Commit

`feat(public): redesign company websites`. Incluye:
- **Backend:** `company-profile.service.ts` (`next_departure_date` en empresa, destinos y orígenes) y `83-f1819-perfil-empresas.test.ts` (+1 prueba).
- **Frontend nuevo:** `components/company-site/*` (layout, cabecera, pie, banner, formulario, galería, tarjetas y utilidades), `pages/public/company-site/*` (8 páginas, no encontrada e índice) y `utils/company-site.ts` con sus pruebas.
- **Frontend modificado:** `routes/index.tsx`, `types/company-profile.ts` y `package.json` (script de pruebas).
- **Eliminado:** `pages/public/CompanyProfilePage.tsx`, sustituido por el layout.
- **Documentación:** `F18-20-DESIGN-AUDIT.md` y este informe.

No se incluye ninguno de los 5 archivos heredados sin seguimiento.

## 20. Git HEAD / origin

Se verifica tras el push, sin `--force`: `HEAD == origin/master`.

## 21. Producción

**PRODUCCIÓN: NOT DEPLOYED.** No existe ninguna pila `busperu-prod*`, se consultó en solo lectura en sa-east-1 y us-east-1. No se tocó nada de `/busperu/prod/*`, RDS, EC2, CloudFront, ALB, SNS, ACM ni Route53 de producción.

## 22. Pendientes

**Técnicos**
- **Buzón de mensajes para empresas:** requiere una tabla, moderación y notificaciones; hoy se usa correo o WhatsApp del visitante.
- **Vista previa con el nuevo diseño:** llevarlo al panel de empresa y a la moderación ADMIN, que siguen con la vista de una página.
- **Fotos de flota:** el modelo no las tiene.
- **Imagen de banner por sección:** hoy se usan la portada y la imagen de Nosotros.
- **Prerender o SSR para SEO:** los metadatos se ponen en el cliente.
- **Aviso de React Router `v7_relativeSplatPath`:** aparece solo en desarrollo y es previo a esta fase.

**Contenido**
- **Contenido real:** el DEMO no tiene imágenes, coordenadas, teléfonos ni redes. Las empresas reales deben subir portada, logo, galería y coordenadas de sus agencias.
- **Viajes del DEMO:** caducan en 7 días; hay que repetir `seed-demo-staging.mjs --execute` antes de cada demostración.

**Legales**
- `legal.*` sigue en NULL (RUC, razón social y domicilio sin inventar).
- Revisar el texto del aviso de que BusPerú no guarda los formularios cuando exista un buzón.

**Comerciales**
- B-11 (comisión) sigue pendiente, sin valor inventado.
- Resend y Culqi en modo LIVE siguen sin configurar.
