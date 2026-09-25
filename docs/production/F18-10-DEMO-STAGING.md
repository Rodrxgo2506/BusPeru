# F18-10 — Demo Staging

> Solo **staging** (sa-east-1, `busperu_staging`). Producción no se tocó. IAM, CloudFront, ALB y el esquema de RDS no se
> modificaron. No se ejecutaron migraciones. La cuenta se muestra como `6578****68`. Este informe **no contiene
> contraseñas, tokens ni claves**.

## Objetivo

Dejar en staging, tras la limpieza de los datos de QA (F18-09), un conjunto de datos **DEMO permanente**, coherente y
separado de QA, para probar BusPerú a mano con los cuatro roles: ADMIN, COMPANY_ADMIN, OPERATOR y CUSTOMER.

**Mecanismo.** `infra/aws/scripts/seed-demo-staging.mjs` crea todo **por la API de la aplicación** (CloudFront → ALB →
EC2), autenticado como el **ADMIN de staging existente**. Así cada recurso pasa por las validaciones, reglas de negocio y
auditoría reales: alta de empresa con su comisión, vínculo empresa-usuario, recuento de asientos y publicación del
layout, y capacidad de los viajes. No se escribió SQL a mano.

**Separación DEMO / QA.**

| | DEMO (este seed) | QA (`smoke`/`e2e`/`qa-staging.sh`) |
| --- | --- | --- |
| Correos | `@demo.staging.busperu.invalid` (dominio reservado, RFC 2606: nunca entrega correo) | `@busperu-staging.example` |
| Nombres | «BusPerú Demo», «Terminal Demo …», «Demo · …», bus `DEMO-01` | marca aleatoria por ejecución (`Humo <marca>`, `E2E <marca>`…) |
| Vida | permanente | retirada al terminar y purga física por manifiesto |

`purge-qa-data.cjs` exige el dominio de QA y la marca de la ejecución en cada raíz. Además, desde F18-10 **rechaza
expresamente** cualquier raíz con el dominio o los nombres DEMO, aunque un manifiesto la liste. Se probó con una
purga real (ver *Pruebas*).

## Datos creados

Ejecución real: 2026-09-24 21:45:15Z (`--execute`). Dry-run previo a las 21:44:54Z: 30 elementos a crear y 0 a reutilizar.

| Recurso | Cantidad | Ids |
| --- | --- | --- |
| Empresa | 1 | 16 |
| Usuarios (COMPANY_ADMIN, OPERATOR, CUSTOMER) | 3 | 46, 47, 48 |
| Terminales | 4 | 24–27 |
| Tipo de bus / tipo de asiento | 1 / 1 | 12 / 12 |
| Bus | 1 | 14 |
| Layout publicado (1 piso, 40 asientos, 1 baño) | 1 | 12 |
| Rutas | 6 | 16–21 |
| Viajes | 12 | 16–27 |

La comisión de la empresa la crea la propia API al darla de alta, con el valor de plataforma de 10.00 %. **No se
crearon** pagos, transacciones de Culqi, integraciones, notificaciones artificiales, logotipos ni archivos.

## Empresa DEMO

| Campo | Valor |
| --- | --- |
| Nombre | BusPerú Demo |
| Razón social | BusPerú Demo S.A.C. (empresa ficticia de staging) |
| RUC | 20999900001: ficticio, cumple la validación actual (11 dígitos) |
| Correo / teléfono | `empresa@demo.staging.busperu.invalid` / +51 900 000 000 (ficticios) |
| Estado | ACTIVE |
| Descripción | «Empresa DEMO del entorno de staging. Todos sus datos son ficticios…» |

Sin cuentas bancarias, documentos ni logotipo.

## Usuarios DEMO

| Rol | Correo | Empresa | Id |
| --- | --- | --- | --- |
| ADMIN | el **existente** de staging (`a***@staging.busperu.invalid`). No se creó otro ni se modificó su contraseña, rol o permisos. | — | 1 |
| COMPANY_ADMIN | `admin.empresa@demo.staging.busperu.invalid` | solo BusPerú Demo | 46 |
| OPERATOR | `operador@demo.staging.busperu.invalid` | solo BusPerú Demo | 47 |
| CUSTOMER | `cliente@demo.staging.busperu.invalid` | — | 48 |

**Credenciales generadas y entregadas de forma segura.**
- Las contraseñas son aleatorias (`crypto.randomInt`, 20 caracteres) y **nunca** se han impreso, registrado ni guardado: ni en Git, ni en Markdown, ni en S3, ni en Parameter Store.
- Durante la verificación se rotaron a valores efímeros que solo vivieron en memoria.
- El propietario las obtiene con `--entregar-credenciales` en **su** terminal: el modo las rota y las muestra **una sola vez**, y se niega a funcionar si la salida no es una terminal interactiva (ver *Rollback / operación*).

## Destinos

| Terminal | Ciudad | Provincia | Departamento | Id |
| --- | --- | --- | --- | --- |
| Terminal Demo Lima | Lima | Lima | Lima | 24 |
| Terminal Demo Pucallpa | Pucallpa | Coronel Portillo | Ucayali | 25 |
| Terminal Demo Cusco | Cusco | Cusco | Cusco | 26 |
| Terminal Demo Arequipa | Arequipa | Arequipa | Arequipa | 27 |

Tipo `TERMINAL` y dirección «Dirección ficticia (DEMO)». No había ubicaciones reutilizables: staging estaba vacío tras F18-09.

## Rutas

| Ruta | Distancia | Duración | Id |
| --- | --- | --- | --- |
| Lima → Pucallpa (Demo) | 780 km | 18 h | 16 |
| Pucallpa → Lima (Demo) | 780 km | 18 h | 17 |
| Lima → Cusco (Demo) | 1100 km | 21 h | 18 |
| Cusco → Lima (Demo) | 1100 km | 21 h | 19 |
| Lima → Arequipa (Demo) | 1010 km | 16 h | 20 |
| Arequipa → Lima (Demo) | 1010 km | 16 h | 21 |

Lima ⇄ Arequipa se añadió para que el cuarto destino obligatorio tenga viajes y se vea en la portada.
Distancias y duraciones son aproximadas.

## Bus

`DEMO-01`, placa **`DEMO-001`**: ficticia, no sigue el formato de placa peruana y no puede corresponder a un vehículo
real. Marca «Demo», modelo «Semicama 40 (ficticio)», 2024, tipo «Demo · Semicama 40», capacidad **40**, estado ACTIVE.

## Layout

Versión publicada «Demo · 40 asientos» (id 12): 1 piso, rejilla de 11 filas × 5 columnas.

```
        col1  col2  [pasillo]  col4  col5
fila 1   01    02               03    04        ventana: col 1 y 5 · pasillo: col 2 y 4
…        …     …                …     …
fila 10  37    38               39    40
fila 11                               Baño
```

- 40 asientos (01–40) de tipo «Demo · Semicama».
- Sin duplicados (restricción `uq_bus_seat_number`) ni solapes: la geometría se validó en el dry-run y la API la volvió a comprobar al publicar.
- Resultado: `seat_count = 40` = capacidad del bus.
- En el frontend el mapa muestra las 10 filas de 4 asientos, el pasillo y el baño, sin errores de consola.

## Viajes

Calculados **respecto al momento de ejecución**, en hora de Lima (UTC-5), no con fechas fijas: dos salidas por ruta,
«mañana a las 20:00» y «pasado mañana a las 08:00». La llegada es la salida más la duración de la ruta. Todos
`SCHEDULED`, con 40 plazas y la nota «Viaje DEMO de staging (ficticio)».

| Ruta | Salidas creadas (Lima) | Ids |
| --- | --- | --- |
| Lima → Pucallpa | 25-09 20:00 · 26-09 08:00 | 16, 17 |
| Pucallpa → Lima | 25-09 20:00 · 26-09 08:00 | 18, 19 |
| Lima → Cusco | 25-09 20:00 · 26-09 08:00 | 20, 21 |
| Cusco → Lima | 25-09 20:00 · 26-09 08:00 | 22, 23 |
| Lima → Arequipa | 25-09 20:00 · 26-09 08:00 | 24, 25 |
| Arequipa → Lima | 25-09 20:00 · 26-09 08:00 | 26, 27 |

Los viajes pasan con el tiempo. Volver a ejecutar `--execute` otro día añade solo las salidas futuras que falten; el
mismo día no crea nada. No se crearon viajes en otros estados (cancelado, en curso…) para no ensuciar la búsqueda.

## Precios

| Ruta | Precio base DEMO |
| --- | --- |
| Lima ⇄ Pucallpa | S/ 60.00 |
| Lima ⇄ Cusco | S/ 80.00 |
| Lima ⇄ Arequipa | S/ 70.00 |

Son **datos DEMO, no precios comerciales**. Al reservar, la aplicación aplica sus reglas actuales: cargo por servicio,
comisión de plataforma del 10 % y cupones. El seed no las altera.

## Pruebas realizadas

`seed-demo-staging.mjs --verify` (21:46:58Z), **23/23 PASS**, por CloudFront. Para probar el aislamiento se usó la
empresa QA que acababa de crear una ejecución de `qa-staging.sh pruebas` (id 17, con su bus y su ruta).

| Rol | Login | Acceso correcto | Aislamiento | Resultado |
|---|---|---|---|---|
| ADMIN | PASS | PASS | N/A | `/auth/me` ADMIN (id 1, existente) · `dashboard/admin` 200 · `users/stats` 200 · ve todas las empresas |
| COMPANY_ADMIN | PASS | PASS | PASS | Empresa 16 · `dashboard/company` 200 · buses 1, rutas 6 y viajes 12, **todos DEMO** · `reports/sales-by-date` 200. Empresa, bus y ruta ajenos: 404; editar la empresa ajena: 404. Plataforma (`dashboard/admin`, `users/stats`, crear empresa, ajustes, crear ADMIN): 403. Logout: 401 después. |
| OPERATOR | PASS | PASS | PASS | Empresa 16 · `dashboard/company` 200 · solo buses, rutas y viajes DEMO · reportes 200. Editar la empresa DEMO o crear buses: 403. Empresa, bus y ruta ajenos: 404 (editarla: 403). Plataforma: 403. Logout: 401 después. |
| CUSTOMER | PASS | PASS | PASS | `dashboard/customer` 200 · búsqueda Lima → Pucallpa (1 viaje DEMO, S/ 60) · mapa de 40 asientos y layout público 200 · **reserva** PENDING → aparece en **Mis viajes** → cancelada, asiento liberado · solo se ve a sí mismo · `users/stats`, `dashboard/company`, `dashboard/admin`, crear o editar empresa: 403 · logout: 401 después. |

**Frontend (CloudFront, navegador integrado):**
- **Portada:** «Destinos populares» muestra Lima (desde S/ 60), Cusco (S/ 80), Arequipa (S/ 70) y Pucallpa (S/ 60). Las cifras son 1 empresa, 6 rutas y 4 terminales. **No aparece ningún resto de QA** (`…mufy…`, «Humo», «E2E»).
- **Búsqueda y resultados:** en `/buscar?origin=Lima&destination=Pucallpa` sale 1 viaje de BusPerú Demo, 20:00 → 14:00 (18 h), S/ 60.00, «40 asientos disponibles».
- **Mapa de asientos:** 01–40 en 10 filas de 4, con pasillo y baño, sin errores de consola.
- **Login:** la página de inicio de sesión se muestra.
- **Pendiente del propietario:** el acceso a los **paneles por rol en la interfaz**. Requiere escribir contraseñas y el asistente no las introduce. Los paneles de los 4 roles se verificaron por la API (tabla anterior).

**Separación QA / DEMO, probada de extremo a extremo:**
- Con DEMO ya creado, `qa-staging.sh pruebas` dio smoke **37/37** y E2E **18/18**.
- La purga de sus manifiestos (ensayo y después COMMIT) borró **solo** las 75 filas de QA. Quedaron users 4 (ADMIN + 3 DEMO), companies 1, locations 4, trips 12 y bookings 1 (la reserva de prueba cancelada).
- Un dry-run posterior del seed encontró los 30 elementos DEMO **intactos**.

**Residuo de la verificación:** 1 reserva **CANCELLED** del cliente DEMO (id 31) y las notificaciones y auditoría que la
aplicación generó al crearla y cancelarla. Es la huella mínima de probar «creación de reserva». No quedan asientos
retenidos.

**Culqi:** sigue **sin integración** (comprobado en cada ejecución del seed). No se conectó nada ni se usaron claves.

## Seguridad

- Producción no tocada. Solo URLs temporales de staging (`*.cloudfront.net`). El script **se niega** si:
  - la API no es una URL temporal de staging;
  - el host parece producción;
  - el ADMIN no es el de staging (`@staging.busperu.invalid`);
  - `/auth/me` no devuelve ADMIN;
  - los roles no son exactamente los 4 esperados.
- Ni IAM, ni CloudFront, ni ALB, ni el esquema, ni migraciones. El snapshot `busperu-staging-db-pre-limpieza-qa-20260924` se **conserva** (`available`); no se creó otro.
- ADMIN, roles, permisos y asignaciones sin cambios. Ningún usuario convertido en ADMIN: los intentos de crear un ADMIN desde COMPANY_ADMIN y OPERATOR recibieron 403.
- **Auditoría:** no se borró ni se editó nada. Pasó de **492 a 668 entradas: 176 nuevas** (recuento final a las 21:52Z), todas generadas por la aplicación.

  | Origen | Entradas |
  | --- | --- |
  | Seed DEMO | 77 (40 de ellas, altas de asientos) |
  | Ejecución QA de aislamiento | 74 |
  | Verificación | 13 |
  | Dry-runs, recuentos y la prueba de `--entregar-credenciales` sin terminal (logins y logouts del ADMIN) | 12 |

- Sin contraseñas, tokens ni claves en el repositorio, informes o registros. La salida del script enmascara con `***` cualquier secreto que viera. La contraseña del ADMIN de staging se leyó de Parameter Store a un temporal 0600 del scratchpad, fuera del repositorio, y se borró.

## Idempotencia

| Ejecución | Resultado |
| --- | --- |
| `--dry-run` (antes) | 30 a crear · 0 a reutilizar |
| `--execute` n.º 1 | 30 creados (+40 asientos y 1 elemento del layout) |
| `--execute` n.º 2 | **0 creados · 30 reutilizados** |
| `--dry-run` tras la purga QA | 0 a crear · 30 a reutilizar (DEMO intacto) |

Cada recurso se busca por su clave natural: RUC, correo, nombre de la terminal o del tipo, placa, nombre de la ruta
dentro de la empresa DEMO, y ruta + hora de salida. Si una clave existe con datos incompatibles, el script **se
detiene**: RUC de otra empresa, correo con otro rol, placa de otra empresa, borradores de layout sin publicar.

## Rollback

- **Durante `--execute`:** si una llamada falla, el script deshace por la API, en orden inverso, **solo** lo creado en esa ejecución. Borra viajes, rutas, bus (con layout y asientos), tipos, terminales, usuarios y empresa, y lo auditado queda así. No hubo que usarlo.
- **Retirar DEMO por completo** (no ejecutado, requiere autorización). Como ADMIN y por la API:
  1. borrar los 12 viajes (sin reservas activas), y la reserva cancelada impedirá borrar su viaje;
  2. desactivar o borrar la empresa 16, lo que arrastra rutas, bus, layout, asientos, comisión y vínculos;
  3. borrar los usuarios 46–48, las terminales 24–27 y los tipos 12.

  Alternativa sin borrar: pasar la empresa a `INACTIVE`, lo que la saca de la portada y la búsqueda.
- **Base completa:** snapshot `busperu-staging-db-pre-limpieza-qa-20260924` (estado previo a F18-10, sin DEMO).

**Operación:**

```powershell
# Entregar (o regenerar) las credenciales DEMO: SOLO en la terminal del propietario (PowerShell o cmd).
$env:AWS_PROFILE = "busperu-mfa"
$f = New-TemporaryFile
aws ssm get-parameter --region sa-east-1 --name /busperu/staging/ops/ADMIN_PASSWORD --with-decryption --query Parameter.Value --output text | Set-Content -NoNewline -Encoding ascii $f
$env:ADMIN_EMAIL = aws ssm get-parameter --region sa-east-1 --name /busperu/staging/ops/ADMIN_EMAIL --query Parameter.Value --output text
$env:API_BASE_URL = "https://d1lfpi7fp62ntk.cloudfront.net/api"
$env:ADMIN_PASSWORD_FILE = $f.FullName
node infra/aws/scripts/seed-demo-staging.mjs --entregar-credenciales
Remove-Item $f; Remove-Item Env:ADMIN_PASSWORD_FILE, Env:ADMIN_EMAIL
```

Para renovar los viajes cuando hayan pasado: las mismas variables y `node infra/aws/scripts/seed-demo-staging.mjs --dry-run`,
después `--execute`.

## Estado final

**PASS WITH FINDINGS**

| Criterio | | Criterio | |
| --- | --- | --- | --- |
| ADMIN existente conservado | ✔ | Búsqueda funcionando | ✔ |
| COMPANY_ADMIN DEMO creado | ✔ | Selección de asiento funcionando | ✔ (API + mapa en la UI) |
| OPERATOR DEMO creado | ✔ | Reserva funcionando | ✔ (API) |
| CUSTOMER DEMO creado | ✔ | Datos DEMO visibles en CloudFront | ✔ |
| Empresa DEMO creada | ✔ | No existen datos QA antiguos | ✔ |
| Destinos disponibles | ✔ | Culqi permanece desconectado | ✔ |
| Rutas disponibles | ✔ | Sin contraseñas en el repositorio | ✔ |
| Bus disponible | ✔ | Script idempotente | ✔ |
| Layout funcional | ✔ | Dry-run probado | ✔ |
| Viajes futuros | ✔ | No se tocó producción | ✔ |
| Precios correctos | ✔ | No se modificó IAM | ✔ |
| Login de los 4 roles | ✔ (API) | Sin commit | ✔ |
| RBAC probado | ✔ | Sin push | ✔ |
| Aislamiento probado | ✔ | | |

Hallazgos que impiden un PASS limpio:
1. **Paneles por rol en la interfaz:** verificados por la API. En el navegador queda que el propietario inicie sesión con las credenciales entregadas, porque el asistente no introduce contraseñas.
2. **Residuo mínimo de la verificación:** 1 reserva CANCELLED del cliente DEMO, visible en su «Mis viajes».
3. **Caducidad natural de los viajes DEMO:** hay que repetir `--execute` para renovarlos. Es idempotente.

**Git** (sin commit ni push). Archivos de esta fase:
- nuevos: `infra/aws/scripts/seed-demo-staging.mjs` y este informe;
- modificado: `infra/aws/scripts/purge-qa-data.cjs`, con el rechazo explícito de lo DEMO y la retirada de la carpeta vacía de cada empresa purgada;
- modificado: `docs/production/STAGING-RUNBOOK.md` §9.2.

Están bajo `infra/` y `docs/`, directorios no versionados (`??`), así que `git status --short` sigue con 242 entradas y
`git diff --stat` no cambia (107 archivos, todos de fases anteriores).
