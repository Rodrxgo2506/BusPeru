# F18-19 · Modelo de contenido — perfil público de empresas y Libro de Reclamaciones

> Fase F18-19. Producción: **NOT DEPLOYED**. Migraciones `020` y `021` (inventario en `MIGRATIONS.md`).
> Este documento describe **qué** se guarda, **quién** lo edita, **cómo** se publica y **qué** ve el público.

## 1. Principios

1. **Un solo componente para todas las empresas.** `/empresas/:slug` se genera a partir de los datos: no existe ninguna
   página escrita a mano para una empresa concreta.
2. **Nada se publica sin aprobación.** Lo que edita la empresa es una *copia de trabajo*. Lo público es una *instantánea*
   (`published_content`) que solo el ADMIN crea al aprobar.
3. **Editar no despublica.** Tras una edición, el público sigue viendo lo último aprobado hasta que se apruebe lo nuevo.
4. **La empresa solo toca lo suyo.** El `company_id` sale siempre del token. Solo el ADMIN elige empresa
   (`resolveCompanyId`), y un `company_id` en el cuerpo se rechaza porque los esquemas son `strict`.
5. **Texto plano.** Ningún campo admite HTML. React escapa al pintar y la API además rechaza etiquetas: doble barrera
   contra el XSS almacenado.
6. **Datos derivados, no duplicados.** Destinos, flota y opiniones se calculan desde rutas, viajes, buses y reseñas
   ya existentes. La empresa no los reescribe.

## 2. Entidades (migración 020)

| Tabla | Relación | Contenido editable | Imágenes |
| --- | --- | --- | --- |
| `company_profiles` | 1:1 con `companies` (PK `company_id`) | `slug` (único; solo ADMIN lo cambia), `tagline`, `about_title`, `about_body`, `history`, `mission`, `vision`, `values_list` (JSON, lista), contacto (`contact_phone`, `contact_whatsapp`, `contact_email`, `website_url`, `social_links` JSON), `main_address` | `cover_image`, `about_image` |
| `company_services` | N:1 | `name`, `description`, `features` (JSON, lista sin repetidos), `display_order`, `is_active` | `image` |
| `company_agencies` | N:1 | `name`, `city`, `department`, `location_id` (opcional, FK a `locations`), `address`, `reference`, `phone`, `whatsapp`, `email`, `latitude`/`longitude`, `services` (JSON), `weekly_hours` (JSON), `special_hours` (JSON), `display_order`, `is_active` | `image` |
| `company_gallery_images` | N:1 | `title`, `description`, `category`, `display_order`, `is_active` | `image` (con `width`/`height` leídos del archivo) |

Columnas comunes de moderación en las cuatro tablas: `review_status` (`DRAFT` · `PENDING` · `APPROVED` · `REJECTED`),
`published_content`, `published_at`, `moderation_note`, `submitted_at`, `reviewed_at`, `reviewed_by`, `suspended_at`,
`suspension_reason`. En servicios, agencias y galería se suman `deleted_at` (baja lógica), `is_active` y `display_order`.

Integridad en la base:

- Columnas JSON como `longtext` con `CHECK (json_valid(...))`. El driver usa `jsonStrings` y MariaDB 10.4/10.11 se
  comportan igual.
- `CHECK` de latitud en [-90, 90] y longitud en [-180, 180]. La API además exige que el punto esté dentro del Perú
  (`PERU_BOUNDS`) y que latitud y longitud vayan juntas.
- Claves ajenas `ON DELETE CASCADE` (empresa) o `SET NULL` (`location_id`, `reviewed_by`), siempre `ON UPDATE RESTRICT`
  (compatible con MariaDB 10.11, regla de F18-02B).

### 2.1 Formatos JSON

```jsonc
// company_agencies.weekly_hours — clave ISO del día (1 = lunes … 7 = domingo). Un día sin clave = «No informado».
{ "1": { "ranges": [{ "open": "06:00", "close": "13:00" }, { "open": "14:00", "close": "22:00" }] },
  "7": { "closed": true } }

// company_agencies.special_hours — máx. 30 fechas; cada una cerrada o con franjas.
[{ "date": "2026-12-25", "label": "Navidad", "closed": true },
 { "date": "2026-12-31", "ranges": [{ "open": "08:00", "close": "14:00" }] }]

// company_agencies.services
["TICKET_SALES", "BOARDING", "PARCELS", "CUSTOMER_SERVICE", "BAGGAGE_STORAGE", "WAITING_ROOM"]

// company_profiles.social_links — solo https y solo en el dominio oficial de cada red.
{ "facebook": "https://www.facebook.com/…", "instagram": "https://www.instagram.com/…" }
```

Reglas de horario: franjas `HH:MM`, apertura antes que cierre, sin solapes dentro del día, como mucho 3 franjas por
día. Una fecha especial no puede estar cerrada y tener franjas a la vez, ni repetirse.

## 3. Ciclo de publicación

```
            editar (cualquier campo de contenido)
   ┌──────────────────────────────────────────────┐
   ▼                                              │
 DRAFT ──enviar──▶ PENDING ──aprobar (ADMIN)──▶ APPROVED ──▶ published_content = copia de trabajo
   ▲                 │                                         published_at = ahora
   │                 └──rechazar (ADMIN, nota obligatoria)──▶ REJECTED (la nota la ve la empresa;
   │                                                            lo publicado antes se mantiene)
   └──────────────── editar tras REJECTED / APPROVED
```

- **Cambios que no pasan por moderación:** reordenar (`display_order`) y activar/desactivar (`is_active`). Afectan solo
  a *qué* elementos aprobados se muestran y en *qué orden*, no a su contenido.
- **Suspender (ADMIN, motivo obligatorio):** oculta el perfil o el elemento de inmediato, sea cual sea su estado.
  Levantar la suspensión lo devuelve con su última instantánea.
- **Baja lógica:** `deleted_at` lo quita del panel y del público. La fila se conserva para la auditoría.
- **Empresa no `ACTIVE`:** sin página pública, aunque el perfil esté aprobado.
- **Visibilidad pública** = perfil `published_content` no nulo **y** sin `suspended_at` **y** empresa `ACTIVE`. Cada
  elemento requiere lo mismo más `is_active = 1` y `deleted_at IS NULL`.
- **Vista previa de la empresa:** muestra la *copia de trabajo* (incluido lo pendiente), marcada como tal. El ADMIN
  tiene la misma vista desde el detalle de moderación.
- **Auditoría:** cada edición, envío, moderación, cambio de imagen, orden o activación se registra en `audit_logs` con
  `entity_type = 'company_profile'`, `entity_id = company_id` y `{ entity, item_id }` en los valores. El ADMIN la ve
  en la pestaña «Auditoría».

## 4. Imágenes

| Regla | Valor |
| --- | --- |
| Formatos | PNG, JPEG, WebP. **SVG rechazado** |
| Validación | firma binaria (*magic bytes*) + MIME + extensión coherentes. No se confía en la extensión que envía el navegador |
| Tamaño de archivo | ≤ 5 MB |
| Dimensiones | 160 px ≤ lado ≤ 6000 px y ≤ 36 MP, leídas de la cabecera (PNG IHDR, JPEG SOF, WebP VP8/VP8L/VP8X) |
| Destino | carpeta `public/companies/<company_id>/` del almacén de archivos (la misma de los logos), con nombre aleatorio. Se guarda la referencia, no el binario en la base |
| Sustitución | la imagen anterior se libera solo si ya no la referencia ni la copia de trabajo ni la instantánea publicada |
| En la página | `loading="lazy"` salvo la portada; `alt` con el título o el nombre de la empresa |

## 5. Qué ve el público en `/empresas/:slug`

| Sección | Origen | Notas |
| --- | --- | --- |
| Inicio | instantánea del perfil + logo de `companies` | portada, lema, valoración media, botones «Ver viajes» y «Contacto» |
| Nosotros | instantánea del perfil | quiénes somos, historia, misión, visión, valores |
| Servicios | instantáneas de `company_services` | nombre, descripción, características e imagen |
| Agencias | instantáneas de `company_agencies` | agrupadas por ciudad. Horario semanal completo (7 filas; «Cerrado» / «No informado»), fechas especiales próximas y servicios de la agencia. El mapa de OpenStreetMap **solo se carga al pulsar «Ver en mapa»**. «Cómo llegar» usa la URL pública de navegación de Google Maps, sin clave. Enlaces `tel:` y WhatsApp |
| Destinos | **derivado**: rutas activas de la empresa y ciudades con ficha en el CMS | enlace al buscador existente filtrado por empresa, origen y destino |
| Flota | **derivado**: buses activos agrupados por tipo | tipo, capacidad y comodidades. **Nunca** placa, código interno ni marca |
| Galería | instantáneas de `company_gallery_images` | 12 por página («Ver más»), en el orden definido por la empresa, y visor ampliado. **No hay filtro por categoría**: la categoría se guarda y se usa como texto alternativo de la imagen cuando no tiene título (corregido en F18-19B, F-04) |
| Opiniones | **derivado**: reseñas aprobadas | se cargan al acercarse a la sección. Solo el nombre de pila del autor y la respuesta de la empresa |
| Contacto | instantánea del perfil | teléfono, WhatsApp, correo, web, redes (solo https en su dominio) |

**Nunca se expone:** placas, `company_id` ni otros identificadores internos en la URL, RUC u otros datos del registro
de la empresa, notas de moderación, copia de trabajo sin aprobar, documentos ni contacto de los pasajeros.

**SEO:** título `«<empresa> · Pasajes, agencias y destinos | BusPerú»`, `description`, `og:*` y JSON-LD `Organization`
(`usePageMeta`, que restaura los valores anteriores al salir). Slug derivado del nombre, único, editable solo por
ADMIN. El listado `/empresas` enlaza el perfil únicamente cuando está publicado.

## 6. Libro de Reclamaciones (migración 021)

| Tabla | Para qué |
| --- | --- |
| `complaint_book_counters` | correlativo por año. Se bloquea la fila (`FOR UPDATE`) al numerar: dos hojas simultáneas no comparten número |
| `complaint_book_entries` | la hoja con los campos del Anexo I (DS 011-2011-PCM): proveedor (de `legal.*`), consumidor, padre/madre/representante si es menor, bien contratado, monto, tipo, detalle, pedido, conformidad (`accepted_at`), plazo (`due_date`), respuesta y envío de correos |
| `complaint_book_events` | historial: `CREATED`, `COPY_EMAILED`, `STATUS_CHANGED`, `RESPONSE_SENT`, `INTERNAL_NOTE` (solo plataforma), `COMPANY_NOTE` (descargo de la empresa) |

Flujo:

```
Consumidor ─registrar─▶ RECEIVED ─(ADMIN)─▶ IN_REVIEW ─responder─▶ ANSWERED ─cerrar─▶ CLOSED
   │  código LR-AAAA-NNNNNN + fecha límite (15 días hábiles)          (respuesta única, por EMAIL o CARTA)
   └─ copia de la hoja al correo + constancia imprimible
```

- **Relación con una empresa:** el consumidor puede elegir la empresa. Si está autenticado e indica un código de
  reserva **suyo**, la hoja se enlaza con esa reserva y su empresa. Una reserva ajena, o sin sesión, queda solo como
  texto y no enlaza nada (sin enumeración de reservas).
- **Consulta pública:** código + número de documento. Cualquier discrepancia devuelve el mismo 404 que un código
  inexistente. Límite de peticiones compartido con el registro.
- **Vista de la empresa:** solo las hojas enlazadas a ella y **sin** documento, domicilio, teléfono ni correo del
  consumidor. Puede aportar su descargo; no ve las notas internas; la respuesta formal la da BusPerú.
- **No se borra:** no hay endpoint de borrado (conservación mínima de 2 años).
- **Datos del proveedor:** `legal.business_name`, `legal.ruc`, `legal.address`, `legal.email` y `legal.phone` en
  `system_settings`, públicos y **en `NULL`** hasta que el titular los configure. Mientras tanto la hoja y las páginas
  legales muestran «[PENDIENTE: …]».

## 7. Permisos

| Acción | CUSTOMER | OPERATOR | COMPANY_ADMIN | ADMIN |
| --- | --- | --- | --- | --- |
| Ver perfil público / Libro (registrar y consultar) | ✔ (también anónimo) | ✔ | ✔ | ✔ |
| Leer panel del perfil de **su** empresa | ✖ | ✔ | ✔ | ✔ (cualquier empresa) |
| Editar, enviar, imágenes, orden, activar | ✖ | ✖ | ✔ (solo la suya) | ✔ |
| Cambiar slug · moderar · suspender · auditoría | ✖ | ✖ | ✖ | ✔ |
| Libro: hojas de su empresa + descargo | ✖ | ✖ | ✔ | ✔ |
| Libro: gestión completa (estado, respuesta, notas internas) | ✖ | ✖ | ✖ | ✔ |
