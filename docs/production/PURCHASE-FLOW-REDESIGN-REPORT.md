# Rediseño de búsqueda, calendario, resultados, loading y selección de asientos

Base: `d63288a` (master = origin/master). Solo frontend + script de publicación web. Sin cambios de base de datos,
sin migraciones, sin cambios de backend, RBAC, tenancy, autenticación ni reglas de negocio.

**STAGING: NOT DEPLOYED · PRODUCTION: NOT DEPLOYED** (a la espera de autorización).

## A. Auditoría (estado previo)

| Área | Hallazgo |
|---|---|
| Calendario | `<input type="date">` nativo: aspecto distinto por navegador, semana empezando en domingo en algunos, sin identidad visual. |
| Loading | `LoadingState` genérico; sin continuidad visual con los resultados. |
| Estados | Error mostraba texto técnico; «sin viajes» mostraba filtros vacíos (0 en todo). |
| Resultados | Resumen de búsqueda mínimo; orden en `<select>`; tarjetas sin jerarquía de horario/duración. |
| Asientos | Mapa funcional pero plano; resumen sin «precio × cantidad»; en móvil el botón de WhatsApp tapaba «Continuar». |
| Imágenes | Wikimedia `Special:FilePath` (2 redirecciones + 429), fotos de 1920 px pintadas a ~890 px, sin `srcset`/`sizes`/`fetchpriority`, sin créditos CC. |
| CLS | 0,546 en portada: el pie saltaba mientras cargaba el chunk perezoso de la ruta. |

Se usó como referencia de *interacción* (no de marca, colores, textos ni código) un vídeo y capturas de un
comparador de pasajes.

## B. Calendario — `components/common/DatePicker.tsx`, `utils/calendar.ts`

- Cabecera naranja (`brand`) «‹ SEP 2026 ›»; semana de lunes a domingo; hoy con punto; seleccionado relleno.
- Fechas pasadas (y fuera de `max`) deshabilitadas; mes anterior deshabilitado antes de `min`.
- Teclado: flechas (día/semana), Inicio/Fin (semana), RePág/AvPág (mes; con Mayús, año), Intro/Espacio, Escape
  (cierra y devuelve el foco). `role="dialog"` + `role="grid"`, `aria-pressed`, `aria-current="date"`, roving tabindex.
- Se abre en portal (`FloatingPanel`), así no lo recorta el `overflow-hidden` del hero.
- Pie con «Hoy» y «Cerrar». Fecha de vuelta opcional y borrable.
- Lógica pura en `calendar.ts` (UTC, cadenas `AAAA-MM-DD`), 9 pruebas.

## C. Loading — `components/search/SearchLoading.tsx`

- Ligado al estado real de la petición (`loading` del hook de búsqueda). **Sin `setTimeout` ni retardo artificial.**
- «Buscando tus viajes», origen → destino, bus recorriendo una ruta punteada (solo `transform`), 2 esqueletos
  de tarjeta con la misma altura que las reales → sin salto de maquetación al llegar los resultados.
- `role="status"` para lectores de pantalla. También en la búsqueda por tramos (`ItineraryResultsPage`).

## D. Resultados — `pages/public/SearchResultsPage.tsx`, `utils/trip-results.ts`

- Resumen: origen → destino, fecha larga, pasajeros reales (`?passengers`), día anterior / siguiente
  (anterior deshabilitado en hoy), «Cambiar búsqueda» con el formulario precargado en línea.
- Orden en píldoras (`radiogroup`) solo con criterios reales: Recomendados, Hora de salida, Menor precio,
  Más rápido, Mejor calificados (sin calificación → al final).
- Filtros existentes intactos: barra lateral fija en escritorio, cajón en móvil; esqueleto de filtros mientras carga.
- Estados: inicial, cargando, resultados, sin resultados («No encontramos viajes para esta fecha…» +
  «Cambiar fecha» / «Ver el día siguiente»), sin coincidencias con filtros, error («No pudimos cargar los viajes.»
  + «Reintentar», sin detalles técnicos). Sin viajes/errores se ocultan filtros y contadores.

## E. Tarjetas — `components/search/TripCard.tsx`

Solo datos del backend: empresa (logo/iniciales), calificación **solo si existe**, tipo de servicio, horas,
ciudades y terminales, duración calculada, «+1» si llega otro día, comodidades reales, «Desde S/ X»,
disponibilidad («¡Últimos N asientos!» con ≤ 5) y «Ver asientos» o «Agotado». Se retiró la etiqueta «Directo»
(no hay dato que la respalde). Entrada escalonada (`animate-rise-in`).

## F. Selección de asientos — `pages/public/checkout/SeatSelectionPage.tsx`, `components/common/SeatMap.tsx`, `utils/seat-map.ts`

- Construida desde el layout congelado del viaje (`GET /public/trips/:id/layout`) y los asientos
  (`GET /public/trips/:id/seats`): filas, columnas, baño, escalera, conductor, puerta, huecos con sus spans.
- Estados: 🟠 disponible, 🔴/naranja intenso seleccionado (con ✓), ⚪ ocupado (con ✕), inactivo punteado.
- Tooltip (número, tipo, precio) en hover y foco; navegación con flechas entre asientos; táctil.
- Resumen «Tu selección»: «N de máx. M», lista de asientos (tipo · piso), `S/ X × n` (o «n pasajes» si difieren),
  cargo por servicio y total. Nota fiel al comportamiento real: el bloqueo se crea al confirmar en el pago.
- Barra fija en móvil con asientos, total y «Continuar»; el botón de WhatsApp sube en esa pantalla.
- Información del viaje siempre visible arriba. **Regla de negocio sin cambios**: límite
  `booking.max_seats_per_booking`, misma lógica de alternar (`toggleSeatSelection`), mismo flujo de checkout,
  mismos tramos (`?segment=N`), restauración de selección previa filtrada por disponibilidad.

## G. 1 o 2 pisos

Número de pisos = número de `decks` del layout (sin cambio de BD). Pestañas solo si hay 2 (`DeckSelector` devuelve
`null` con ≤ 1), con «N libres» por piso. Cambiar de piso **no** pierde la selección. Verificado en local con un bus
de 2 pisos (12 camas abajo con 3 ocupadas, escalera, baño y puerta; 42 asientos arriba) y uno de 1 piso (sin pestañas).

## H. Animaciones — `tailwind.config.js`, `index.css`

`pop-in`, `month-next/prev`, `rise-in`, `seat-pop`, `bus-drive`, `route-dash`, `soft-pulse`; solo `transform`
y `opacity`. `@media (prefers-reduced-motion: reduce)` global: duración 1 ms, una iteración.

## I. Performance

- Fotos alojadas en BusPerú (`src/assets/photos`, 25 variantes WebP, ~2,3 MB en total en el repo; el navegador
  baja solo una por imagen) con hash de Vite y caché `immutable` de un año.
- `srcset` + `sizes` en todas las imágenes; `width`/`height` para reservar hueco; `fetchpriority="high"` y
  `loading="eager"` solo en la imagen LCP de cada página; el resto `lazy`.
- CLS: `<main>` reserva el alto de la ventana mientras carga el chunk de la ruta.
- `publish-web.mjs`: los `.webp` se suben con `Content-Type: image/webp` explícito y se verifica junto a HTML/JS/CSS.
- Créditos CC (autor, licencia y fuente) en «Información útil → Créditos de las fotografías» (enlace en el pie).

## J. Imágenes — ANTES / DESPUÉS

Builds de producción servidos en local con las mismas cabeceras que CloudFront, 4G emulado, 3 repeticiones.

| Página | Métrica | ANTES (`d63288a`) | DESPUÉS |
|---|---|---|---|
| Portada escritorio, frío | LCP | 2080–2120 ms | 950–970 ms |
| | 1.ª imagen pintada | 2060–2100 ms | ~1000 ms |
| | Bytes de imágenes | 523 KB | 83 KB |
| | Bytes totales | 972 KB | 551 KB |
| | Redirecciones | 1 | 0 |
| | CLS | 0,546 | 0,000 |
| Portada escritorio, caché | LCP | 680–700 ms | 144 ms |
| | 1.ª imagen | 650 ms | 115 ms |
| `/empresas`, frío | LCP | 1910–2080 ms | 860 ms |
| | Bytes de imágenes | 406 KB | 66 KB |
| | CLS | 0,090 | 0 |
| `/empresas`, caché | LCP | 670–680 ms | 130 ms |
| Portada móvil 390×844 DPR3, frío | LCP | 1736–1744 ms (imagen) | 924–956 ms (texto) |
| | 1.ª imagen | ~1730 ms | 1038–1070 ms |
| | Bytes de imágenes | 138 KB | 141 KB |
| Portada móvil, caché | LCP | ~660 ms | ~144 ms |

Referencia en staging (`d63288a`, escritorio, sin limitación): LCP 1,98–2,65 s en frío, 2,6 MB de imágenes, 3 redirecciones.

## K. Pruebas

| Suite | Resultado |
|---|---|
| Backend MariaDB 10.4 (`busperu_test`) | 2160/2160 |
| Backend MariaDB 10.11 (`busperu_1011_test`) | 2160/2160 |
| Seguridad (35 archivos, en ambas) | 957/957 |
| Frontend (`node --test`, +29 nuevas: calendario 9, resultados 9, asientos 11) | 58/58 |
| E2E / smoke | No ejecutadas: requieren staging (sin autorización de despliegue) |
| Typecheck backend / frontend | OK / OK |
| Lint frontend | OK |
| Build frontend | OK |

Verificación manual local (CDP): teclado del calendario, loading con la API retrasada 4 s, error y vacío por
intercepción, orden, bus de 1 y 2 pisos, selección entre pisos, móvil sin desbordamiento horizontal, consola limpia.

## L. Base de datos

Sin cambios: ninguna migración, ningún DDL, ningún DELETE. El bus de 2 pisos de prueba se creó solo en la BD local.

## M. Git

Un commit nuevo sobre `d63288a`, push normal. Sin reset, sin force push, sin reescritura. Los 5 archivos heredados sin
seguimiento no se añadieron ni se borraron.

## N. Deploy

**STAGING: NOT DEPLOYED · PRODUCTION: NOT DEPLOYED.** Al desplegar staging, comprobar con `curl -I` que un
`assets/*.webp` responde `image/webp` y `Cache-Control: public,max-age=31536000,immutable`.

## Pendientes conocidos

- Las imágenes subidas por la API (p. ej. una de destino de 1,78 MB) no se redimensionan: el backend no tiene
  librería de imágenes; requiere variantes en servidor.
- Google Fonts sigue bloqueando el render.
- No hay API de precio por categoría de asiento: la leyenda usa el precio real de cada asiento.
- El seed DEMO no tiene salidas del mismo día.
- Dos caídas aisladas de Node en Windows (`0xC0000409`) vistas antes en la suite de backend; no se repitieron.
