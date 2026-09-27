# Fase 3 — invalidación de `/api/public/media/*` en CloudFront al retirar imágenes públicas

Base: `61d3d2f` (Fase 2, desplegada en staging). Alcance: solo la invalidación de media. Sin cambios en el frontend,
en el smoke, en el esquema de base de datos ni en producción.

**STAGING: NO DEPLOY · PRODUCTION: NOT DEPLOYED.**

## Causa

La Fase 2 cachea `/api/public/media/*` en la distribución de la API (política `busperu-staging-api-media`, hasta 7
días en el borde). El smoke sube un logotipo, lo lee (queda en el borde), lo borra y espera **404**. El origen lo
borra de verdad, pero CloudFront sigue sirviendo su copia (`200`, `X-Cache: Hit`). Antes pasaba porque toda la API
tenía MaxTTL 1 s. La prueba es correcta: una imagen pública retirada no debe seguir sirviéndose.

## Diseño

- **Un único punto:** todas las retiradas de imágenes públicas ya confirmadas en la base pasan por
  `retirePublicFiles(referencias)` (`backend/src/services/media-cdn.service.ts`): borra cada archivo del almacén y
  después pide **una** invalidación con las rutas `/api/public/media/<referencia>`.
- **Orden:** base (la transacción ya confirmada por quien llama) → archivo → invalidación. Invalidar antes de borrar
  permitiría que una petición intermedia volviera a llenar el borde con la copia vieja.
- **Dónde se usa (retiradas):** logotipo de empresa (reemplazar y quitar); imagen de destino, festividades y
  atractivo (reemplazar y quitar); borrado de un destino (todas sus imágenes en una sola petición) y de un atractivo;
  identidad visual (reemplazar y quitar).
- **Dónde NO:** los archivos recién subidos que se descartan porque su transacción falló (`deletePublicFile`): nunca
  se publicaron y su nombre aleatorio no lo conoce nadie. Documentos privados: no se sirven por el canal público.
- **Reemplazo:** solo se invalida la referencia **anterior**. La nueva es un nombre nuevo (32 hex aleatorios) que el
  borde nunca vio: invalidarla no aporta nada.
- **Errores:** `invalidatePublicMedia` nunca lanza. Un fallo de CloudFront (permisos, red, cuota) no deshace la
  retirada ni rompe la petición: se registra (`logError`, `provider: CLOUDFRONT`, `event: media.invalidation`,
  `outcome: FAILED`, rutas) para repetirla a mano. El éxito se registra con `logEvent` (`outcome: REQUESTED` e id).
- **Idempotencia:** `CallerReference` = hash de las rutas ordenadas. Un reintento con las mismas rutas devuelve la
  invalidación ya creada en vez de crear otra. Varias rutas de una misma operación van en una sola petición.
- **Sin configuración** (local, pruebas, producción mientras no tenga caché de media): no se llama a CloudFront
  (`NOT_CONFIGURED`); la retirada del origen funciona igual.

## Archivos

| Archivo | Cambio |
|---|---|
| `backend/src/services/media-cdn.service.ts` | Nuevo: rutas, invalidación, `retirePublicFiles` |
| `backend/src/services/company-logo.service.ts` | Retiradas del logotipo → `retirePublicFiles` |
| `backend/src/services/destination-content.service.ts` | Retiradas de imágenes de destino, atractivo y marca → `retirePublicFiles` |
| `backend/src/config/env.ts` | `env.cdn.mediaDistributionId` (`CDN_MEDIA_DISTRIBUTION_ID`) |
| `backend/package.json`, `package-lock.json` | `@aws-sdk/client-cloudfront` ^3.1141.0 (cliente oficial modular) |
| `backend/src/test/86-media-cdn-invalidacion.test.ts` | Nuevo: 14 pruebas |
| `backend/src/test/helpers/testEnv.ts` | La suite fuerza `CDN_MEDIA_DISTRIBUTION_ID=''` (nunca llama a AWS) |
| `infra/aws/cloudformation/build-web-template.mjs` → `busperu-staging-web.json` | Política IAM mínima y parámetro SSM |
| `infra/aws/cloudformation/check-web-template.mjs` | Reglas de la política y del parámetro |
| `infra/aws/iam/build-iam.mjs` → `policies/BusPeruStagingWorkloadBoundary.json` | Techo `InvalidarMedia` en el límite de permisos |
| `infra/aws/iam/check-iam.mjs` | Regla: CloudFront en el límite solo `CreateInvalidation` sobre distribuciones de la cuenta |

## IAM

- **Rol afectado:** `busperu-staging-app-role` (el `AppRole` de la pila principal, con el que corre la API en la EC2).
  Ningún otro rol, usuario ni política.
- **Política nueva** (pila `busperu-staging-web`, `ApiMediaInvalidationPolicy`, inline en ese rol): una declaración,
  `Allow cloudfront:CreateInvalidation` sobre `arn:aws:cloudfront::<cuenta>:distribution/<ApiDistribution>`.
- **Límite de permisos** (`BusPeruStagingWorkloadBoundary`): sin CloudFront hasta ahora, así que la política sola no
  bastaría. Se añade el techo `InvalidarMedia`: `cloudfront:CreateInvalidation` sobre `distribution/*` de la cuenta
  (el límite es genérico y no conoce el id). **Permiso efectivo = intersección:** esa acción, sobre la distribución
  de la API de staging y nada más.
- Producción: ni `infra/aws/iam/prod` ni la plantilla `busperu-prod-web` cambian. Producción no recibe ningún permiso.

## Configuración

- **`CDN_MEDIA_DISTRIBUTION_ID`**: id de la distribución de la API. En staging lo escribe la propia pila web en SSM
  (`/busperu/staging/app/CDN_MEDIA_DISTRIBUTION_ID`, `String`, valor `Ref ApiDistribution`): no hay id escrito a mano.
  `render-env.sh` ya carga todo `/busperu/<entorno>/app/` en cada arranque de la API. No es un secreto.
- Solo se acepta con forma de id de CloudFront (`^E[A-Z0-9]{8,20}$`); cualquier otro valor = sin configurar.
- Producción no tiene el parámetro → no invalida (y tampoco tiene caché de media). Antes de llevar la caché de media a
  producción habría que añadir allí el mismo behavior, la misma política IAM y el mismo parámetro.
- Credenciales: las del rol de la instancia (cadena por defecto del SDK). Nada en código ni en configuración.

## Pruebas

Ver «Resultados» al final.

## Seguridad

- **Solo la ruta afectada:** las rutas se construyen únicamente a partir de referencias que cumplen `isPublicReference`
  (`public/(destinations|companies|branding)/<id>/<32 hex>.<ext>`), la misma forma que usa el origen para servirlas.
  Comodines, `/*`, `..`, query strings, documentos privados o texto arbitrario se descartan antes de llegar a CloudFront.
- **Sin entrada del usuario:** las referencias salen de la base (la que se acaba de retirar), nunca de la petición.
- **Permisos:** una acción, un recurso, un rol; límite de permisos acotado; los comprobadores rechazan 9 mutaciones
  inseguras de la plantilla y 3 del límite.
- **Caché:** la clave de `/api/public/media/*` no cambia (sin Authorization, cookies ni query); el resto de `/api/*`
  sigue con la política sin caché. Lo comprueban el comprobador de la plantilla y una prueba del backend.
- **Registros:** solo rutas públicas e id de invalidación; nunca credenciales (el logger además redacta secretos).

## Performance

La caché larga se conserva sin tocar: DefaultTTL 1 día y MaxTTL 7 días en el borde, `immutable` de un año en el
navegador. En staging (Fase 2) la foto de la API pasó de 2021–2135 ms (`Miss`) a 1630–1691 ms (`Hit`). La
invalidación solo actúa sobre imágenes retiradas, que son operaciones puntuales del panel.

## Despliegue (pendiente de autorización; no ejecutado)

1. Límite de permisos: nueva versión por defecto de `BusPeruStagingWorkloadBoundary` a partir del JSON (con la cuenta
   sustituida); la política admite 5 versiones.
2. Pila `busperu-staging-web`: change set con `--capabilities CAPABILITY_IAM` y parámetros previos. Esperado:
   2 altas (`ApiMediaInvalidationPolicy`, `ApiMediaDistributionIdParam`) y 0 cambios en las distribuciones.
3. Release de backend desde el commit de la Fase 3 (`deploy-release.sh` instala `@aws-sdk/client-cloudfront` con
   `npm ci`; el reinicio vuelve a generar el entorno con `CDN_MEDIA_DISTRIBUTION_ID`).
4. Verificar: evento `media.invalidation` `REQUESTED` en los registros; smoke **37/37** sin cambiarlo.

**Riesgo a medir en staging:** el smoke espera el 404 durante ~9 s. Si una invalidación de CloudFront tarda más en
completarse, la comprobación podría seguir fallando aunque la invalidación se pida bien. Hay que medirlo en el
despliegue; si ocurre, se reporta antes de tocar nada (ni el TTL ni el smoke).

## Resultados

| Suite | Resultado |
|---|---|
| Backend MariaDB 10.4 | 2174/2174 (2160 previas + 14 nuevas) |
| Backend MariaDB 10.11 | 2174/2174 |
| Seguridad (subconjunto de 36 archivos, incluida la suite nueva) | 971/971 en ambas |
| `86-media-cdn-invalidacion` | 14/14: rutas (solo públicas, sin `*`, sin inyección), prefijo = `PathPattern` de la plantilla y resto de `/api/*` sin caché, sin distribución / id inválido, petición única e idempotente, no públicas no llegan, error de CloudFront → `FAILED`; logotipo reemplazar/quitar (archivo borrado ANTES de invalidar, solo la referencia anterior, 404 en origen), fallo de CloudFront sin romper la retirada, sin configurar; destino reemplazar/quitar, borrado de destino en una sola petición, marca; documento privado sin invalidación |
| Backend typecheck · build | PASS · PASS (el backend no tiene script de lint) |
| `check-web-template.mjs` | PASS · 9/9 mutaciones inseguras rechazadas (acción, recurso, rol, declaración extra, parámetro SSM) |
| `check-iam.mjs` | PASS · 3/3 mutaciones del límite rechazadas (`cloudfront:*`, otra acción, `Resource: *`) |
| Frontend (sin cambios) | 66/66 · typecheck · lint · build PASS |
| Smoke | Sin cambios en `smoke-staging.mjs`: sigue exigiendo 404 tras borrar el logotipo. Se ejecutará tras el despliegue |
