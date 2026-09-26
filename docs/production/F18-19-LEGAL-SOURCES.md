# F18-19 · Fuentes legales y clasificación del contenido

> **Esto no es asesoría legal.** Es un inventario técnico de qué dicen las fuentes oficiales consultadas y de cómo se
> reflejó cada punto en BusPerú. Todos los textos publicados llevan el aviso «Versión propuesta, pendiente de validación
> legal». **Antes de producción deben revisarlos un abogado y el titular del negocio.**
> Consulta: 25/09/2026. Producción: **NOT DEPLOYED**.

## 1. Clasificación usada

| Etiqueta | Significado | Cómo aparece en la web |
| --- | --- | --- |
| **REQUISITO LEGAL VERIFICADO** | Leído en el texto de una norma o en una fuente oficial citada abajo | texto normal, con la norma citada cuando ayuda |
| **DECISIÓN DE NEGOCIO** | Regla que aplica hoy el código de BusPerú (verificable en el repositorio), no una exigencia legal | texto normal («tal como funciona hoy») |
| **TEXTO PROPUESTO** | Redacción razonable pendiente de validación legal | todo documento lleva el aviso de versión propuesta |
| **DATO PENDIENTE** | Dato que no se conoce y **no se inventa** | `[PENDIENTE: …]` resaltado en la página (componente `Pending`) o valor `NULL` en `legal.*` |

## 2. Fuentes consultadas

| # | Fuente | Qué se usó | Estado |
| --- | --- | --- | --- |
| F1 | **DS 011-2011-PCM**, Reglamento del Libro de Reclamaciones. Texto publicado por el INEI: `https://www.inei.gob.pe/media/libro_reclamaciones/DS011_2011_PCM.pdf` | art. 3 (definiciones de reclamo, queja y aviso), art. 4 (libro virtual: constancia y copia al correo), art. 5 (campos mínimos de la hoja; en el virtual un mecanismo que **reemplace la firma** y acredite la conformidad), art. 9 (aviso), art. 11 (Indecopi puede pedir copias de las hojas), art. 12 (**conservación 2 años**), art. 13 (el reclamo no impide otras vías ni es requisito previo para denunciar ante Indecopi). Anexo 1 (formato de la hoja) | leído (PDF descargado y extraído con `pypdf`) |
| F2 | **DS 101-2022-PCM**, modificación del reglamento. El Peruano: `https://busquedas.elperuano.pe/dispositivo/NL/2095978-1` | definiciones vigentes de **reclamo** y **queja**; **plazo de respuesta no mayor a 15 días hábiles** (art. 6); respuesta por correo o por el medio indicado por el consumidor (art. 6-B) | leído |
| F3 | **Indecopi, «Preguntas y respuestas — Libro de Reclamaciones»**, versión del 12.11.2025: `https://consumidor.gob.pe/wp-content/uploads/2020/07/Preguntas_Respuestas_LR_12.11.2025.pdf` | el virtual debe estar en el mismo medio donde se ofrece el servicio; **Libro físico de respaldo** para cuando el virtual no pueda usarse; proveedores con ingresos anuales **≥ 3000 UIT** reportan al **SIREC**; conservar el correo enviado como evidencia; el proveedor (no Indecopi) responde | leído (PDF extraído con `pypdf`) |
| F4 | **Indecopi, página del Libro de Reclamaciones**: `https://consumidor.gob.pe/libro-de-reclamaciones/` | definiciones divulgativas de reclamo y queja (coinciden con F2) | leído |
| F5 | **Ley 29733**, Ley de Protección de Datos Personales, y **DS 016-2024-JUS**, su nuevo Reglamento. Nota oficial en El Peruano: `https://www.elperuano.pe/noticia/259141--…-nuevo-reglamento` | vigencia **31/03/2025**; obligación de **notificar a la Autoridad determinados incidentes de seguridad dentro de las 48 horas** de conocerlos (texto de la nota, reconsultado el 25/09/2026); derechos del titular (acceso, rectificación, cancelación, oposición) | leído (nota oficial; **el texto íntegro del reglamento no se revisó artículo por artículo**) |
| F6 | gob.pe «Qué son los derechos ARCO» (`/9270-…`) y «Inscribir banco de datos en el Registro Nacional» (`/8060-…`) | plazos ARCO; coste y forma de la inscripción | **no disponible**: el servidor respondió HTTP 418 (dos intentos, 25/09/2026). Nada de estas páginas se usó |
| F7 | `www.indecopi.gob.pe/es/web/dpc/libro-de-reclamaciones` | — | **no disponible** (DNS no resuelve desde este equipo) |
| F8 | **Ley 29571**, Código de Protección y Defensa del Consumidor | solo se **cita** como marco legal general. No se consultó su texto ni se extrajeron obligaciones concretas de él | citado, no analizado |

Herramienta: para extraer el texto de F1 y F3 se instaló el paquete `pypdf` en el Python local con `pip` (solo en
este equipo; no es dependencia del proyecto). Los textos extraídos quedaron en el directorio temporal de la sesión, no
en el repositorio.

## 3. Libro de Reclamaciones — requisito por requisito

| Requisito | Fuente | Clasificación | Implementación |
| --- | --- | --- | --- |
| Libro virtual accesible en el mismo medio donde se venden los pasajes | F1 art. 4 · F3 | VERIFICADO | `/libro-de-reclamaciones`, enlazado desde el pie de todas las páginas públicas |
| Aviso del Libro visible | F1 art. 9 | VERIFICADO | bloque «Libro de Reclamaciones» con icono en el pie y en «Información útil». **El formato exacto del Anexo 2 no se reprodujo**: DATO PENDIENTE de validar |
| Campos mínimos de la hoja (proveedor, consumidor, padre/madre si es menor, bien contratado, monto, reclamo/queja, detalle, pedido, fecha, correlativo) | F1 art. 5, Anexo 1 | VERIFICADO | formulario y `createComplaintSchema` (los obligatorios se exigen en el cliente y en la API) |
| Conformidad que **reemplaza la firma** | F1 art. 5 | VERIFICADO | casilla obligatoria (`accepted: true`) y `accepted_at` registrado; la hoja lo indica expresamente |
| Correlativo | F1 Anexo 1 | VERIFICADO | `LR-AAAA-NNNNNN` con bloqueo de fila (`complaint_book_counters`) |
| Constancia inmediata y **copia al correo** del consumidor | F1 art. 4 | VERIFICADO | pantalla de constancia imprimible + correo con la hoja completa; `copy_emailed_at` y evento `COPY_EMAILED` como evidencia (F3) |
| Definiciones de reclamo y queja en la hoja | F2 · F4 | VERIFICADO | leyenda al pie del formulario y de la hoja |
| Respuesta en **≤ 15 días hábiles** | F2 art. 6 | VERIFICADO | `due_date` calculada al registrar; filtro «vencidas sin respuesta» para el ADMIN |
| Cálculo de días hábiles | F2 | **DATO PENDIENTE** | hoy excluye sábados y domingos, **no los feriados nacionales** → la fecha mostrada puede ser 1–2 días más tardía que la real en semanas con feriado. Decidir fuente de feriados |
| Respuesta por correo o el medio indicado | F2 art. 6-B | VERIFICADO | respuesta única con canal `EMAIL` (envío automático, `response_emailed_at`) o `CARTA` |
| El reclamo no impide otras vías ni es requisito para denunciar ante Indecopi | F1 art. 13 | VERIFICADO | leyenda en la hoja, en el formulario y en los Términos §10 |
| Conservar las hojas **2 años** | F1 art. 12 | VERIFICADO | no existe endpoint de borrado; test «no existe forma de borrar una hoja» |
| Entregar copias a Indecopi cuando las pida | F1 art. 11 | VERIFICADO | el ADMIN consulta e imprime cada hoja. **Exportación masiva no implementada**: DATO PENDIENTE (bajo demanda) |
| Datos del proveedor (razón social, RUC, domicilio) | F1 Anexo 1 | **DATO PENDIENTE** | `legal.*` en `NULL`; la hoja muestra `[PENDIENTE: …]`. **Bloquea la puesta en producción del Libro** |
| Libro físico de respaldo | F3 | VERIFICADO (obligación operativa) | fuera del software: **DATO PENDIENTE** de negocio |
| Reporte al SIREC si ingresos ≥ 3000 UIT | F3 | VERIFICADO (condicional) | no implementado; **DATO PENDIENTE**: confirmar si aplica a BusPerú |
| Quién responde: BusPerú o la empresa de transporte | — | DECISIÓN DE NEGOCIO | el Libro es **de BusPerú** (el proveedor de la plataforma). La empresa relacionada ve la hoja sin datos de contacto y aporta su descargo; la respuesta formal la da BusPerú. **Validar con asesoría legal** si cada empresa debe además tener su propio Libro |

## 4. Protección de datos (Política de privacidad)

| Punto | Fuente | Clasificación | Texto publicado |
| --- | --- | --- | --- |
| Marco: Ley 29733 y DS 016-2024-JUS | F5 | VERIFICADO | descripción de la política |
| Responsable del tratamiento (identidad y contacto) | F5 | **DATO PENDIENTE** | `legal.*` en `NULL` → `[PENDIENTE]` |
| Qué datos se tratan | código | DECISIÓN DE NEGOCIO (hechos verificados en el código) | cuenta, reservas y pasajeros, pagos (**sin datos de tarjeta**: Culqi), soporte/opiniones/Libro, IP y auditoría |
| Finalidades | código | TEXTO PROPUESTO | lista de §3 |
| Base legal de cada finalidad; comunicaciones comerciales | F5 | **DATO PENDIENTE** | `[PENDIENTE]` |
| Destinatarios y flujo transfronterizo | código / infraestructura | VERIFICADO en el proyecto | empresa de transporte, Culqi, AWS **sa-east-1 (São Paulo, Brasil)**, Google/Microsoft solo si se usan para entrar |
| Proveedor de correo definitivo | F18-18 (Resend LIVE no configurado) | **DATO PENDIENTE** | `[PENDIENTE]` |
| Conservación | F1 art. 12 (Libro) | VERIFICADO solo para el Libro | reservas/pagos y cuentas tras la baja: **DATO PENDIENTE** |
| Derechos del titular | F5 | VERIFICADO (existencia) | canal = correo de `legal.email` (**pendiente**). **Plazos de respuesta ARCO no verificados** (F6 no disponible): no se publica ningún plazo |
| Notificación de incidentes | F5 (48 h) | VERIFICADO | «lo comunicaremos conforme exige el Reglamento». El procedimiento interno de 48 h es **DATO PENDIENTE** operativo |
| Inscripción del banco de datos en el Registro Nacional | F5 / F6 | **DATO PENDIENTE** | `[PENDIENTE]`. Coste, forma y alcance de la inscripción sin verificar (F6 no disponible) |
| Medidas de seguridad | código | VERIFICADO en el proyecto | HTTPS, contraseñas con bcrypt («un solo sentido»), datos bancarios cifrados (AES-256-GCM, 019), aislamiento por empresa, auditoría |

## 5. Cookies y almacenamiento (Política de cookies)

Clasificación: **VERIFICADO en el proyecto** (búsqueda en el código del frontend y del backend).

| Hecho | Evidencia |
| --- | --- |
| BusPerú **no crea cookies propias** ni usa analítica o publicidad | ningún `document.cookie` ni `Set-Cookie` en el código; sin scripts de analítica |
| `localStorage` `busperu.token` = sesión (se borra al cerrar sesión) | `services/api.ts` (`TOKEN_KEY`) |
| `sessionStorage` de la reserva en curso | `CheckoutContext` |
| Terceros que se cargan: Culqi (solo al pagar con tarjeta), Google Fonts, Wikimedia Commons (fotos de destinos), OpenStreetMap (solo al pulsar «Ver en mapa») | CSP de producción (F18-18) + componentes |

No se afirma nada sobre cookies de terceros más allá de «puede usar sus propias cookies» (Culqi). No se añadió banner
de consentimiento: no hay cookies propias no esenciales. **Validar con asesoría legal** si Google Fonts/Wikimedia
(IP enviada a terceros) requieren aviso o consentimiento adicional (TEXTO PROPUESTO).

## 6. Términos, reservas y pagos

| Punto | Clasificación | Nota |
| --- | --- | --- |
| **BusPerú no presta el transporte**: lo presta la empresa indicada en cada viaje | DECISIÓN DE NEGOCIO (modelo de marketplace del código) | redactado así a propósito |
| Alcance de la responsabilidad de BusPerú como intermediario (Ley 29571) | **DATO PENDIENTE** | `[PENDIENTE]` en Términos §2 |
| Retención de asientos sin pagar = `booking.hold_minutes` | DECISIÓN DE NEGOCIO | se lee de la configuración pública (15 en los datos de prueba) |
| Cancelación hasta `booking.cancellation_hours` antes de la salida, con solicitud de reembolso del importe pagado no reembolsado | DECISIÓN DE NEGOCIO | valor leído en vivo (24 por defecto) |
| Viaje cancelado por la empresa → reembolso de las pagadas + aviso por correo | DECISIÓN DE NEGOCIO | comportamiento existente |
| Plazo de procesamiento de reembolsos; tratamiento del cargo por servicio | **DATO PENDIENTE** | |
| Cambios de fecha, no presentación, equipaje | **DATO PENDIENTE** | la plataforma no los ofrece hoy |
| Tarjeta vía Culqi (BusPerú no ve la tarjeta); Yape/Plin/transferencia/efectivo en verificación manual | DECISIÓN DE NEGOCIO | |
| Cuentas y puntos de pago autorizados | **DATO PENDIENTE** | |
| Comprobantes de pago electrónicos | **DATO PENDIENTE** | no implementado |
| Ley aplicable peruana | TEXTO PROPUESTO | jurisdicción competente: **DATO PENDIENTE** |
| Opiniones solo de pasajeros con reserva, moderadas | DECISIÓN DE NEGOCIO | comportamiento existente |

## 7. Lo que NO se hizo a propósito

- No se inventó razón social, RUC, domicilio, representante, registro ni número alguno.
- No se publicó ningún plazo ARCO ni ningún plazo de reembolso.
- No se afirmó ningún servicio o cookie que el código no use.
- No se dijo que BusPerú presta el transporte.
- No se copiaron textos de terceros: las citas de la norma se limitan a nombrar el artículo.

## 8. Pendientes para la puesta en producción (resumen)

1. `legal.business_name`, `legal.ruc`, `legal.address`, `legal.email`, `legal.phone` (configurar en `system_settings`).
2. Revisión por abogado de todos los textos «versión propuesta», en particular la responsabilidad del intermediario y
   quién mantiene el Libro.
3. Feriados nacionales en el cómputo de los 15 días hábiles.
4. Plazos ARCO y procedimiento; inscripción del banco de datos; procedimiento interno de incidentes (48 h).
5. Plazos de conservación de reservas, pagos y cuentas.
6. Plazo de reembolsos y política de cambios.
7. Libro físico de respaldo; confirmar si aplica el SIREC (≥ 3000 UIT); formato del Aviso (Anexo 2).
8. Proveedor de correo definitivo (Resend LIVE sigue sin configurar, F18-18).
