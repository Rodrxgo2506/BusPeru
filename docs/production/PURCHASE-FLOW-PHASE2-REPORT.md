# Fase 2 — pulido del rediseño de compra + validación real de bus de 2 pisos

Base: `665068c` (desplegado en staging). Alcance: solo los pendientes del QA de staging. Sin rediseño, sin
funcionalidades nuevas, sin cambios de base de datos, de backend ni de perfiles, Libro o páginas legales.

**STAGING: NOT DEPLOYED (pendiente de autorización) · PRODUCTION: NOT DEPLOYED.**

## 1. Bus de 2 pisos — validación con datos reales de STAGING

Datos sintéticos **creados por la API oficial de staging** (mismo flujo que el panel: layout → pisos → asientos →
elementos → publicar), en una empresa de QA propia, el 2026-09-27 15:43 UTC (marca `mujzno9b`). Sin mocks ni
respuestas interceptadas: el mapa llega de `GET /public/trips/119/layout` y `/seats`. No se tocó el DEMO.
**No purgados.** El manifiesto (IDs, sin credenciales) queda fuera del repositorio, en el espacio de trabajo de QA.

| Qué | Valor |
|---|---|
| Empresa | `QA 2 pisos mujzno9b` · `company_id` **52** (ACTIVE) |
| Usuario | COMPANY_ADMIN **140** `qa2p.admin.mujzno9b@busperu-staging.example` (contraseña aleatoria, nunca guardada) |
| Bus | **45** (`Q2P-mujzno9b`), tipo de bus 43, tipos de asiento 43 (Cama) y 44 (Semicama) |
| Layout | **43** (publicado) · Piso 1 = deck **43**: rejilla 7×4, 12 camas (asientos 247–258), escalera, baño 2×2, puerta · Piso 2 = deck **44**: rejilla 11×5, 42 semicamas (asientos 259–300), escalera |
| Ruta / ubicaciones | ruta 65 · `QA Origen mujzno9b` (88) → `QA Destino mujzno9b` (89) |
| Viaje | **119** · 2026-09-28 20:00 → 2026-09-29 14:00 (llega al día siguiente) · S/ 80 |
| Reservas CONFIRMED | **91** (`BP-668516`): Piso 1, asiento **05** (id 251) · **92** (`BP-672261`): Piso 2, asiento **19** (id 265). Cobro en efectivo (pagos 18 y 19) aprobado por el COMPANY_ADMIN de la empresa QA |

Validación en navegador (`dos-pisos.mjs`: Chrome real, clics/toques reales), empezando en **Resultados → «Ver
asientos»**: pestañas con los libres de la API; cada piso pinta exactamente sus asientos, su ocupado CONFIRMED y sus
elementos; selección cruzada A (piso 1) + B (piso 2) → piso 1 (A sigue) → piso 2 (B sigue); resumen con A y B y su
piso; `S/ 80.00 × 2` = S/ 160.00 + cargo = total; máximo `booking.max_seats_per_booking` (6) contando ambos pisos;
misma URL (no se reinicia el viaje).

## 2. Tooltip de asientos recortado

- **Problema:** el tooltip vivía dentro del asiento; el contenedor del mapa necesita `overflow-x-auto` (un bus
  ancho no debe ensanchar la página) y recortaba el tooltip (~238 px) en las columnas exteriores del bus (~276 px).
- **Solución:** un único tooltip por mapa en un **portal** con `position: fixed` (mismo patrón que `FloatingPanel`).
  Su sitio lo calcula `placeTooltip` (función pura): centrado sobre el asiento, se desliza para quedar entero dentro
  de la ventana en columnas extremas, pasa debajo si arriba no cabe y la flecha sigue apuntando al asiento. Se abre
  con el ratón o con el foco del teclado; en táctil no (el asiento aparece en el resumen). `aria-label` intacto.
  El texto sale **completo**: sin elipsis, sin truncar y sin `overflow` oculto; si no cabe en una línea (ancho
  máximo 18 rem o la ventana menos 16 px) se parte en varias. El relleno superior que reservaba sitio al tooltip
  de la fila 1 (`pt-9`) ya no hace falta (`pt-3`).
- **Pruebas:** 7 unitarias (`seat-map.test.ts`: central, extremo izquierdo, extremo derecho, primera fila, última
  fila, tooltip de varias líneas, texto más ancho que la ventana) + navegador (`asientos-tooltip.mjs`) en
  1440/768/390/320 sobre un bus real de 1 piso y otro de 2 pisos: asiento central, primera y última columna,
  primera fila (bajo la cabecera fija) y última fila (sobre la barra fija): texto completo, dentro de la ventana,
  por encima de todo (comprobado con `elementFromPoint`), flecha al asiento; teclado, foco visible y toque sin tooltip.

## 2 bis. Icono real de asiento

- **Icono:** `Armchair` de **lucide-react** (ya era dependencia del proyecto, 0.469.0; licencia **ISC**;
  https://lucide.dev/icons/armchair). SVG en línea, tree-shakeable, sin peticiones ni dependencias nuevas.
- **Asiento:** icono arriba y **número debajo** (nunca lo tapa). Estados: disponible (naranja claro), seleccionado
  (naranja con icono blanco + insignia ✓) y ocupado (gris + insignia ✕): el estado no depende solo del color.
  Área táctil 38×38 px en móvil y 42×42 px desde `sm` (≥ 24×24 de WCAG 2.2). La leyenda usa las mismas muestras.
- **Conductor:** el elemento `DRIVER` del layout pasa de `Armchair` al volante que el mapa ya dibujaba en «Frente del
  bus», para que nunca parezca un asiento a la venta.
- Sin cambios en selección, disponibilidad, precios, máximo, total, checkout ni layouts.

## 3. «+1» en la pantalla de asientos

- **Problema:** la tarjeta de resultados mostraba «+1» y el resumen del viaje en asientos no.
- **Solución:** componente compartido `ArrivalDayBadge` (tarjeta y asientos dicen lo mismo). Sale de
  `arrivalDayOffset(departure_datetime, arrival_datetime)` —fechas reales— y `arrivalDayNote` da el texto para
  `title` y lectores de pantalla («Llega al día siguiente»). Sin llegada o mismo día: nada.
- **Pruebas:** `trip-results.test.ts` — 27 SEP 20:00 → 28 SEP 14:00 = +1, cruce de medianoche por un minuto,
  mismo día, cambio de mes y de año, +2, llegada nula/indefinida/ilegible.

## 4. Caché de `/api/public/media/*` en CloudFront

- **Causa:** la distribución de la API aplica a todo `/api/*` la política `busperu-staging-api-sin-cache` (MaxTTL
  1 s), así que las fotos públicas nunca se guardaban en el borde aunque el origen responda
  `public, max-age=31536000, immutable`.
- **Cambio (solo plantilla de staging, `build-web-template.mjs` → `busperu-staging-web.json`):**
  - Behavior nuevo `PathPattern: /api/public/media/*` → mismo origen ALB (con su cabecera secreta), `https-only`,
    **solo GET/HEAD**, misma restricción opcional por IP (CloudFront Function) y **sin** política de petición al
    origen (al ALB no llega Authorization ni cookies).
  - Cache policy nueva `busperu-staging-api-media`: clave **sin cabeceras (tampoco Authorization), sin cookies y
    sin query string**; DefaultTTL 1 día, MaxTTL 7 días en el borde (el navegador conserva el año del origen; una
    imagen retirada deja de servirse sola en ≤ 7 días sin invalidar).
  - `/api/*` sigue exactamente igual: `api-sin-cache`, Authorization reenviado, errores con TTL 0.
- **Seguridad:** `/public/media` solo sirve referencias `public/(destinations|companies|branding)/<32 hex>.<ext>`
  (`readPublicFile`); los documentos privados dan 404 por construcción. La respuesta no depende de la sesión.
  `Access-Control-Allow-Origin` es fijo (no refleja `Origin`), así que cachearla no mezcla orígenes. La CSP de
  la web no cambia (las imágenes ya venían de ese origen).
- **Pruebas:** `check-web-template.mjs` con reglas nuevas; rechaza las 6 mutaciones inseguras: Authorization en la
  clave, patrón `/api/*`, métodos de escritura, caché en el behavior por defecto, reenvío de cabeceras al origen y
  behavior sin la restricción por IP.
- **Producción:** su plantilla es otro generador (`build-prod-web-template.mjs`) y no se tocó. Recomendación: el
  mismo behavior y la misma política cuando se prepare el despliegue de producción.
- **Headers esperados tras desplegar** (a verificar con `curl -I` dos veces): 1.ª `X-Cache: Miss from cloudfront`,
  2.ª `Hit from cloudfront` con `Age` > 0 y el mismo `Cache-Control: public, max-age=31536000, immutable`; y un
  endpoint privado (p. ej. `/api/auth/me`) sigue `Miss` y 401 sin token.

## 5. Imagen de 1,78 MB

- **Qué es:** `GET /api/public/media/public/destinations/1/d907d69acd0e5405caec1d6896f2063f.jpg` — JPEG progresivo
  de **3888 × 1578 px, 1 779 907 bytes**, subido por el panel (destino 1). Se guarda tal cual en
  `STORAGE_DIR/public/destinations/<id>/<hash>.jpg` y lo sirve `sendPublicImage` (backend Express, sin librería de
  imágenes; `storePublicImage` solo valida extensión, MIME, bytes mágicos y ≤ 5 MB).
- **Dónde se ve:** tarjetas de destino (~300–450 px CSS) y cabecera del detalle del destino (ancho completo). Nunca
  hace falta 3888 px; como mucho ~1920 px.
- **Variantes medidas** (mismo codificador que las fotos propias, WebP calidad 0,8 / JPEG 0,82):

  | Ancho | WebP | JPEG | vs. original |
  |---:|---:|---:|---:|
  | 480 | 19 KB | 24 KB | −98,9 % |
  | 800 | 44 KB | 60 KB | −97,5 % |
  | 1280 | 103 KB | 141 KB | −94,1 % |
  | 1920 | 189 KB | 277 KB | −89,1 % |
  | original 3888 | — | 1 739 KB | — |

- **Decisión: no se implementa ahora** (requiere procesamiento en el backend, que esta fase no debe cambiar sin
  necesidad). Solución técnica recomendada:
  - **Dependencia:** `sharp` (libvips). ~20 MB instalados en linux-x64 (`sharp` 0,96 MB + `@img/sharp-linux-x64`
    0,43 MB + `@img/sharp-libvips-linux-x64` 18,7 MB); binarios precompilados, sin compilar en la EC2; Node ≥ 20.9.
  - **Cuándo:** al subir (`storePublicImage`): además del original se guardan `<hash>-480.webp`, `-800`, `-1280` y
    `-1920` (nunca por encima del ancho original). Coste: ~0,2–0,4 s de CPU por subida, solo en el panel.
  - **Contrato:** la referencia guardada no cambia (URLs actuales intactas, nada se borra). El regex de referencias
    públicas acepta el sufijo `-<ancho>.webp`; el frontend arma `srcSet`/`sizes` a partir de la referencia.
  - **Seguridad:** decodificar imágenes de terceros amplía superficie → `limitInputPixels`, `failOn: 'error'`,
    quitar metadatos (EXIF/GPS), mismo límite de 5 MB, y solo para subidas autenticadas de ADMIN/empresa.
  - **Almacenamiento:** ~+20 % sobre el original (las 4 variantes suman ~355 KB frente a 1,74 MB).
  - **Migración:** script idempotente de relleno que recorre `public/destinations|companies` y crea las variantes que
    falten; sin cambios de esquema ni de datos. Hasta tenerlas, el frontend usa el original como hoy (sin roturas).
  - Alternativa sin dependencia (menor): reducir la imagen en el navegador del administrador antes de subirla. Solo
    arregla subidas nuevas y no da variantes; no se recomienda como solución principal.
- **Mientras tanto:** la caché de `/api/public/media/*` (punto 4) la sirve desde el borde de Lima tras la primera
  visita y el navegador la guarda un año; en la portada se pide diferida (`loading="lazy"`, prioridad baja) y no es
  el LCP. Sigue siendo el **cuello de botella de bytes**: 1 739 KB de ~1 870 KB de imágenes en la portada de escritorio.

## 6. Performance

**PERFORMANCE STAGING: PENDING DEPLOY AUTHORIZATION.** No se desplegó nada para medir. Referencias:

| Métrica | Antes (`d63288a`) | `665068c` | Fase 2 |
|---|---:|---:|---:|
| Desktop LCP frío | 2868–3144 ms | 1080–1228 ms | pendiente de despliegue |
| Desktop primera imagen | 2060–2493 ms | 1064–1209 ms | pendiente de despliegue |
| Desktop peso imágenes | 2596 KB (857 propias) | ~1870 KB (117 propias) | pendiente de despliegue |
| Desktop CLS | 0,547 | 0,001 | pendiente de despliegue |
| Desktop LCP caliente | 1132–1316 ms | 552–716 ms | pendiente de despliegue |
| Mobile LCP frío | 1748–1800 ms | 1176–1724 ms (mediana 1304) | pendiente de despliegue |
| Mobile primera imagen | 1740–1784 ms | 1145–1287 ms | pendiente de despliegue |
| Mobile peso imágenes | 334 KB | 312 KB | pendiente de despliegue |
| Mobile LCP caliente | 1076–1236 ms | 548–552 ms | pendiente de despliegue |

La Fase 2 no cambia ninguna imagen de la portada: lo que mueve la tabla es la caché de media en CloudFront, que solo
existe tras desplegar la pila web. Efecto esperado: la foto de la API deja de ir al origen de São Paulo en cada
visita (hoy `Miss` y 2,3–2,7 s en frío); los bytes no bajan hasta implementar el punto 5.

## 7. Google Fonts (sin cambios, solo documentado)

- La hoja `fonts.googleapis.com/css2?family=Inter…` (≈1 KB, prioridad máxima) **bloquea el render** 198–299 ms;
  el `woff2` de Inter (47 KB) añade ~225 ms; son 2 dominios de terceros (DNS + TLS).
- Bloqueándolas solo en el navegador de medición: FCP/LCP −30 a −110 ms.
- Mejora posible (a evaluar): servir Inter desde `/assets` (misma caché inmutable), `font-display: swap`,
  `preload` del `woff2` latino y quitar la hoja externa (y `fonts.*` de la CSP).

## 8. Pruebas

| Suite | Resultado |
|---|---|
| Backend MariaDB 10.4 / 10.11 (sin cambios de backend en esta fase) | 2160/2160 · 2160/2160 |
| Seguridad (suite de backend, 35 archivos) | 957/957 |
| Frontend (`node --test`) | 66/66 |
| Typecheck · lint · build · `check-web-template` | PASS |
| Staging · seguridad (`seguridad.mjs`) | 18/18 |
| Staging · aislamiento QA ↔ DEMO (`qa-2pisos.mjs`, solo lecturas contra el DEMO) | 14/14 |
| Staging · smoke | 37/37 |
| Staging · E2E | 18/18 |
| Staging · flujo de compra (`qa-ui.mjs`, sin respuestas reescritas) | 1440: 59/59 · 768: 59/59 · 390: 61/61 |
| Bus real de 2 pisos en el bundle desplegado (`665068c`) | 1440/768/390: 24/25 (falla solo el «+1», corrección de esta fase aún sin desplegar) |
| Bus real de 2 pisos con el build de la Fase 2 + API real de staging | 1440/768/390: 25/25 |
| Asientos + tooltip (icono, número, estados, 5 posiciones, ambos pisos, teclado, toque), build Fase 2 + API staging | 94/94 (1440/768/390/320) |
| Conductor con volante (layout real con `DRIVER`, API local: staging no tiene ningún layout con conductor) | PASS |

**Bundle desplegado vs. Fase 2.** Staging sigue sirviendo `665068c` (`index-Cgczqp-j.js`): 0/12 asientos con `Armchair`,
tooltip dentro del botón y sin «+1» en asientos. El icono, el tooltip en portal y el «+1» se validaron con el build de
la Fase 2 (`index-Lwb9FKEe.js`) servido en local contra la **API real de staging** (el navegador de prueba desactiva
CORS, que solo admite el origen de staging; ninguna respuesta se modifica). Quedan por comprobar en el bundle de
staging tras autorizar el despliegue.

## 9. Base de datos y DEMO

Sin migraciones, DDL, DROP, ALTER ni DELETE. Esquema idéntico antes y después (645 columnas, `ff82f84c…`). Las 8
huellas del DEMO (empresa, usuarios, viajes, reservas, perfil, servicios, agencias, viajes futuros) son **idénticas**
antes y después. Datos nuevos solo sintéticos: la empresa QA de 2 pisos y los del smoke/E2E
(`qa-manifest-smoke/e2e-20260927T155309Z.json`), sin purgar.

## Pendientes independientes

- `infra/aws/cloudformation/check-prod-templates.mjs` ya fallaba antes de esta fase: lee
  `frontend/src/utils/company-profile.ts` (eliminado en el rollback de perfiles, `75ea4ce`) y, desde `665068c`, busca
  `COMMONS` en `constants/images.ts` (las fotos ya no vienen de Commons). Tooling de producción: no se tocó.
- En 390 px el botón flotante de WhatsApp puede superponerse a un asiento de la columna derecha mientras están
  alineados (se libera al hacer scroll). Ya ocurría con `665068c`; no es una regresión de esta fase.
- El mapa del portal de empresa (con precio dentro del asiento) no se validó visualmente en esta fase.
- Imagen de 1,78 MB: solución de backend documentada en el punto 5, sin implementar.
