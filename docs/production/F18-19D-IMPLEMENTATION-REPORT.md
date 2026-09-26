# F18-19D — Implementación

> Fase F18-19D: experiencia pública de empresas completa y demostrable en STAGING (tarjeta del listado, perfil DEMO y
> viajes DEMO futuros). Producción: **NOT DEPLOYED**. Cuenta AWS mostrada como 6578****68. Sin secretos, tokens,
> IPs de operador ni credenciales DEMO.

## 1. Objetivo

Que staging permita demostrar el flujo completo:

- `/empresas` → **BusPerú Demo** → **Ver perfil** → `/empresas/<slug>` → secciones del perfil;
- `/empresas` → **Ver viajes** → `/buscar?company_id=<id>&date=<fecha futura>` → viajes DEMO.

## 2. Causa encontrada en F18-19C

1. **El DEMO no tenía perfil público:** la siembra de F18-10 es anterior a F18-19.
2. **La tarjeta solo ofrecía «Ver viajes»:** el texto era fijo aunque el destino fuera el perfil.
3. **El DEMO no tenía viajes futuros:** la siembra creaba salidas a 1–2 días vista.

**Hallazgo añadido en esta fase:** aun con viajes futuros, «Ver viajes» abría la búsqueda de **hoy**. Para cualquier empresa sin salida ese día, la búsqueda salía vacía.

## 3. Cambios frontend

| Archivo | Cambio |
| --- | --- |
| `frontend/src/utils/company-links.ts` (nuevo) | `companyCardActions()`: «Ver perfil» → `/empresas/<slug>` **solo** si el backend entrega el slug de un perfil publicado (no lo deriva nunca del nombre). «Ver viajes» → `/buscar?company_id=<id>&date=<próxima salida visible o hoy>`. Nombres accesibles «Ver el perfil de …» y «Ver los viajes de …» |
| `frontend/src/utils/company-links.test.ts` (nuevo) | 7 tests: con perfil, «Ver viajes» conserva su destino, sin perfil (null, vacío, ausente), no deriva slugs, fecha de próxima salida y alternativa, accesibilidad, codificación |
| `frontend/src/components/companies/CompanyCard.tsx` | con perfil: **[Ver perfil] [Ver viajes]** (principal y secundario); el nombre enlaza al perfil y el logo también (fuera del tabulador y oculto a lectores de pantalla, para no repetir el enlace). Sin perfil: solo **[Ver viajes]**, como antes |
| `frontend/src/pages/public/InfoPages.tsx` | usa `companyCardActions(company, todayIso())` |
| `frontend/src/services/index.ts` | tipo del listado con `next_departure_date` |
| `frontend/package.json` | registra el test nuevo |

**Backend (mínimo, para «Ver viajes»):**

| Archivo | Cambio |
| --- | --- |
| `backend/src/routes/public.routes.ts` | `GET /public/companies` añade `next_departure_date`: la fecha de la próxima salida visible en la búsqueda pública, con **las mismas condiciones que `searchTrips`** (`SCHEDULED`/`BOARDING`/`DELAYED`, ruta y empresa `ACTIVE`, salida `>= NOW()`). Si no hay ninguna, es `null` y la tarjeta usa hoy |
| `backend/src/test/83-f1819-perfil-empresas.test.ts` | prueba nueva: la fecha coincide con la del único viaje de la empresa B, la búsqueda con esa fecha lo encuentra, y con el viaje cancelado pasa a `null` |

## 4. Cambios del seed DEMO

`infra/aws/scripts/seed-demo-staging.mjs`, idempotente, limitado a staging por sus salvaguardas previas. Solo se amplió.

- **Perfil público** por el **flujo oficial**:
  - el ADMIN de staging abre el perfil de la empresa DEMO (`?company_id=`), lo edita, lo envía a revisión y lo aprueba, igual que la pestaña «Editar» de moderación;
  - así no hace falta conocer ni rotar la contraseña del COMPANY_ADMIN DEMO;
  - el **slug lo genera la aplicación** al crear el perfil.
- **Idempotencia:**
  - el dry-run solo lee: cola de moderación, listas del perfil y perfil público;
  - la ejecución compara lo publicado con lo definido y solo crea, edita, envía o aprueba lo que falte o difiera;
  - un perfil suspendido o un elemento suspendido **detienen** la siembra, que no levanta suspensiones sola.
- **Validación previa** del perfil, los servicios y las agencias con los esquemas reales del backend (además de lo que ya validaba).
- **Salidas:**
  - F18-10 creaba 2 por ruta, a 1 y 2 días. Ahora hay una diaria a las 20:00 durante 7 días más la de las 08:00 de pasado mañana: 8 por ruta y 48 en total;
  - la clave es fecha y hora exactas: repetir la siembra otro día reutiliza las existentes y solo añade las nuevas;
  - la fecha se calcula en cada ejecución, sin fechas fijas.
- **Deshacer:** si algo falla, se deshace por la API lo creado en esa ejecución, incluidos servicios y agencias (baja lógica). El perfil no se puede borrar por la API: quedaría en borrador, no público.

## 5. Perfil DEMO creado

Todo el contenido está marcado como ficticio.

| Bloque | Contenido |
| --- | --- |
| Inicio | «BusPerú Demo» · lema «Servicio de transporte interprovincial — entorno DEMO. Perfil DEMO de staging: toda la información mostrada es ficticia.» |
| Nosotros | «Perfil DEMO de staging»: «Este perfil pertenece exclusivamente al entorno DEMO de staging. Todos los datos son ficticios y no corresponden a una empresa real…»; historia, misión y visión rotuladas «ficticia (DEMO)»; valores, incluido «Datos 100 % ficticios (DEMO)» |
| Servicios (4) | Viajes interprovinciales (DEMO) · Venta y reserva de pasajes DEMO · Equipaje (DEMO) · Atención al pasajero (DEMO) |
| Agencias (3) | Agencia DEMO Lima (venta, embarque, atención; lun–sáb 06:00–22:00, domingo cerrado) · Agencia DEMO Pucallpa (venta, embarque, custodia; lun–vie en horario partido, sábado de mañana, domingo cerrado) · Agencia DEMO Cusco (embarque, encomiendas, sala de espera; todos los días 05:00–21:00). Dirección «ficticia (DEMO)», vinculadas a las terminales DEMO. **Sin teléfono ni coordenadas** |
| Destinos | derivados de las 6 rutas DEMO: Lima, Arequipa, Cusco y Pucallpa |
| Flota | derivada: «Demo · Semicama 40», 1 bus, 40 asientos (sin placa) |
| Galería | **vacía** → la sección no se muestra. No hay imágenes propias versionadas en el proyecto y no se descargó ninguna |
| Opiniones | sección visible con «Aún no hay opiniones publicadas…»; no se crearon opiniones artificiales (requieren un viaje realizado) |
| Contacto | solo `contacto@demo.staging.busperu.invalid` (dominio reservado, nunca entrega) y «Dirección ficticia (DEMO) · sin atención al público». Sin teléfono, WhatsApp, web ni redes, para no enlazar nada que pueda ser real |
| Mapa | **no se muestra**: no hay coordenadas DEMO en la siembra ni en los fixtures, y no se inventaron. La interfaz lo maneja sin botón de mapa y sin iframe. El mapa bajo demanda se verificó con datos QA con coordenadas (§10) |

## 6. Slug final

**`busperu-demo`**, generado por la aplicación (`ensureProfile` + `slugify`) al abrir el perfil por primera vez en la ejecución de la siembra en staging. Empresa DEMO `id 16`.

## 7. Secciones verificadas

`https://d25z2lpl1efut1.cloudfront.net/empresas/busperu-demo`:

| Sección | Estado |
| --- | --- |
| Inicio | ✔ |
| Nosotros | ✔ |
| Servicios | ✔ (4; pestañas funcionan) |
| Agencias | ✔ (3, por ciudad, con horarios y servicios por agencia) |
| Destinos | ✔ (4) |
| Flota | ✔ (1 tipo) |
| Galería | — no se muestra (sin imágenes permitidas) |
| Opiniones | ✔ (mensaje de «aún no hay») |
| Contacto | ✔ |

**8 de 9 secciones visibles; la ausencia de la galería es deliberada.**

**Verificado además:**

- escritorio, tablet y móvil sin desbordamiento;
- cabecera sin nada tapado en 6 tamaños;
- consola y red sin errores;
- 0 violaciones con la CSP de producción inyectada;
- `canonical`, `og:url` y JSON-LD `url` = `https://d25z2lpl1efut1.cloudfront.net/empresas/busperu-demo`, JSON-LD `Organization`;
- ni placa, ni `location_id`, ni ids internos en la respuesta pública.

## 8. Viajes DEMO

- **Tras la siembra:** 48 salidas futuras nuevas (6 rutas × 8, del 27/09 al 03/10/2026, hora de Lima), sin tocar reservas ni otras empresas.
- **Listado:** `next_departure_date = 2026-09-27`.
- **«Ver viajes»** → `/buscar?company_id=16&date=2026-09-27` → **6 viajes encontrados** (los 6 de las 20:00 de ese día).
- **Qué hacer para no quedarse sin viajes:** los viajes caducan a los 7 días de la última ejecución. Repetir `seed-demo-staging.mjs --execute`, que es idempotente, antes de cada demostración o semanalmente.

## 9. Tests

| Suite | Resultado |
|---|---|
| Backend 10.4 | **2196/2196** |
| Backend 10.11 | **2196/2196** |
| Security | **993/993** (35 archivos, ambos motores) |
| Frontend | **45/45** |
| Typecheck | PASS (backend y frontend) |
| Lint | PASS (frontend, 0 avisos; el backend no tiene lint) |
| Build | PASS (`index` 287,7 kB, `index-sNNAxLvE.js`, el mismo publicado) |
| Smoke | **37/37** |
| E2E | **18/18** · expiry **1/1** |

**Otras suites:**

| Suite | Resultado |
| --- | --- |
| QA F18-19 + F18-19B en staging (`qa-f1819b.mjs`) | **51/51** (incluye F-01: 200 inmediato tras aprobar) |
| Flujo de descubrimiento F18-19D (`flujo.mjs`) | local 13/13 · **staging 13/13** |
| Interacción y SEO (`interaccion.mjs`) | **13/13** en staging |
| Cabecera (`layout-f02.mjs`) | **6/6** tamaños en staging |
| Interfaz pública (`ui-f1819.mjs`, CSP de producción) | 33 cargas, 0 incidencias salvo el 404 esperado del slug inexistente |
| Checkers de plantillas | PASS |
| Siembra en local (copia de ensayo contra `busperu_test`) | 1.ª: 73 creados · 2.ª: 0 creados, 74 reutilizados · corrección de un servicio editado a mano: detectado, restaurado y publicado |

## 10. QA manual

Chrome headless contra staging, por CloudFront.

| Comprobación | Resultado |
| --- | --- |
| `/empresas` | aparece **BusPerú Demo** con **[Ver perfil] [Ver viajes]** |
| Ver perfil | `href="/empresas/busperu-demo"`, `aria-label="Ver el perfil de BusPerú Demo"`; el nombre también enlaza; el logo enlaza con `tabindex=-1` y `aria-hidden` |
| Ver viajes | `href="/buscar?company_id=16&date=2026-09-27"`, `aria-label="Ver los viajes de BusPerú Demo"` → «6 viajes encontrados» |
| Clic en «Ver perfil» | `/empresas/busperu-demo`, título «BusPerú Demo · Pasajes, agencias y destinos \| BusPerú», aviso DEMO visible |
| Mapa bajo demanda (perfil QA con coordenadas, CSP de producción) | 0 iframes y 0 peticiones a OSM al cargar; «Ver en mapa» → 1 iframe `www.openstreetmap.org` con `sandbox`, 200; 0 violaciones de CSP |
| Consola / red | sin errores (en desarrollo solo aparece el aviso previo de React Router `v7_relativeSplatPath`, que no está en el build publicado) |
| Paneles ADMIN (perfiles públicos, Libro) | cargan sin errores |

**Regresión de F18-16** (`lab.mjs` en staging frente a la medición final de F18-16):

| | F18-16 | F18-19D |
| --- | --- | --- |
| Esqueletos · pantallas en blanco · errores HTTP | 0 · 0 · 0 | 0 · 0 · 0 |
| `OPTIONS` por navegación | 0 | 0 |
| Peticiones API por navegación (primera / realista / calientes) | 0,09 / 2,73 / 1,05 | 0,09 / 2,82 / 1,05 |
| Navegación rápida: peticiones · canceladas · errores | 1 · 0 · 0 | 1 · 0 · 0 |
| `drivers` · `unread-count` (en toda la medición) | 0 · 7 | 0 · 8 (8 también en F18-19A) |
| Mediana útil primera / realista / calientes (ms) | 8,7 / 7,3 / 6,0 | 12,0 / 7,9 / 6,4 |
| p90 (ms) | 20,4 / 16,6 / 17,3 | 24,7 / 19,6 / 17,5 |
| Carga en frío del Dashboard (ms · peticiones · chunks) | 1695 · 6 · 9 | 1462 · 5 · 9 |

**Sin regresión estructural:**

- la caché SWR sirve lo conocido sin esqueleto y revalida;
- la navegación rápida cancela lo abandonado;
- la precarga deja 0 chunks por navegación.

**Tiempos:** varían unos milisegundos, dentro del ruido de una medición de red real; F18-19D no toca el panel ADMIN ni la caché.

**Caché, filtros y paginación:** la batería específica de F18-16 (casos A–K) necesita builds instrumentados preparados a mano en F18-16, que no están en el repositorio, así que no se repitió. Ningún archivo de F18-16 cambió en esta fase. Lo cubren los tests `response-cache.test.ts` y `refresh-status.test.ts` (dentro de los 45/45) y la medición anterior.

## 11. Staging URL

- Web: `https://d25z2lpl1efut1.cloudfront.net/empresas` → `https://d25z2lpl1efut1.cloudfront.net/empresas/busperu-demo`
- API: `https://d1lfpi7fp62ntk.cloudfront.net/api`
- **Backend:** release `2026-09-26-2` (`2026-09-26-1 → 2026-09-26-2` con `deploy-release.sh`; SHA-256 verificado; `/api/ready` 200).
- **Frontend:** `publish-web.mjs --env staging --release 2026-09-26-2`, en simulación y después `--ejecutar`: 106 archivos con el mismo tamaño y MD5; invalidación de `/` y `/index.html`; sirve `index-sNNAxLvE.js`.
- **Sin cambios de infraestructura.**

## 12. Commit F18-19B

`da4d47408d75a54c0d11e351951caa6c0c09746b` · `fix(public): harden company profiles and staging QA`. Push `4213568..da4d474` a `origin/master`, sin force. Incluye los informes de F18-19A y F18-19B.

## 13. Commit F18-19D

`feat(public): complete company profile discovery demo`: el commit que contiene este informe (su SHA lo da `git log`; un archivo no puede contener el hash de su propio commit). Push a `origin/master` sin force.

## 14. HEAD == origin/master

Verificado tras el push con `git rev-parse HEAD` y `git rev-parse origin/master` (mismo SHA, indicado en la respuesta de cierre de la fase).

## 15. Producción

**NOT DEPLOYED**

```
PRODUCTION_DEPLOYED=NO
PRODUCTION_DATABASE_CHANGED=NO
PRODUCTION_INFRA_CHANGED=NO
```

Comprobado al terminar (solo lectura):

- **Recursos:** 0 stacks `busperu-prod*`; RDS, EC2, ALB y CloudFront solo de staging; 0 parámetros `/busperu/prod/*`; 0 certificados ACM; 0 zonas Route 53.
- **CloudTrail del periodo de la fase:** en `sa-east-1`, solo `SendCommand` a la EC2 de staging (despliegue y lecturas de verificación); en CloudFront, solo la invalidación de la web de staging. La siembra y la purga escriben por la API y la base de **staging**.
- **Logs de la API de staging:** 0 respuestas 5xx; 3 errores «No se pudo enviar un correo» del Libro en la QA (SMTP de staging `.invalid`, esperado).
- **Esquema de staging:** idéntico a la referencia (645/253/96/25). Sin migraciones.

**Limpieza de QA** (purga oficial ampliada en F18-19B, ensayo y después ejecución) de los manifiestos QA F18-19D, smoke y E2E:

- **COMMIT:** empresas 4, usuarios 9, más lo derivado. De F18-19: 2 perfiles, 2 servicios, 2 agencias, 2 fotos y 2 hojas del Libro con sus 8 eventos y el contador. 5 imágenes y 2 carpetas.
- **DEMO:** huellas de empresa, usuarios, reservas, perfil, servicios, agencias, viajes (60) y viajes futuros (48) **idénticas antes y después**.
- **Estado final:** empresas 2 (DEMO y el resto E2E antiguo), usuarios 7, viajes 62, reservas 5, perfiles 1, servicios 4, agencias 3, `legal.*` en NULL, ninguna imagen en `public/companies/`.
- **Flujo tras la limpieza:** 13/13.

## 16. Cambios pendientes

### Técnicos
- **Galería DEMO:** no hay imágenes propias en el proyecto. Si se quiere mostrar la 9.ª sección, hace falta decidir y versionar imágenes propias o con licencia y marcarlas como DEMO.
- **Mapa DEMO:** no hay coordenadas DEMO. Añadirlas requiere decidir un criterio que no apunte a direcciones reales.
- **Viajes DEMO:** caducan a los 7 días de la última siembra. Conviene repetirla antes de cada demostración, o programarla.
- **Resto de una fase anterior:** la empresa `E2E mug3ixsf` (INACTIVE) sigue en staging y está ligada al manifiesto heredado `qa-manifest-e2e-mug3ixsf.json`. No es de esta fase y no se tocó; su purga es una decisión aparte.
- **Botón «Buscar viajes» de la cabecera del perfil:** sigue usando la fecha de hoy. Podría usar la próxima salida igual que la tarjeta, pero el perfil no expone esa fecha. Mejora menor.
- **Batería de caché A–K de F18-16:** no reproducible sin sus builds instrumentados (§10).

### Legales (sin cambios; no se inventó nada)
- Datos reales del titular (`legal.*` sigue en NULL).
- Revisión jurídica de los textos.
- Feriados nacionales en el cómputo de días hábiles del Libro.

### Comerciales
- Resend LIVE: sin él no se entregan la copia ni la respuesta del Libro.
- B-11, comisión de la plataforma.
- Contenido real del perfil de cada empresa: lo cargará cada empresa desde su panel, con moderación.
