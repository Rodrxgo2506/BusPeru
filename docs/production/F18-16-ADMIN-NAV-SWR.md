# F18-16 — Navegación del panel ADMIN: causa real y solución

> Solo STAGING. **Sin commit ni push** (cambios locales listos para revisión). Solo cambió el frontend: sin
> cambios en backend, base de datos, CloudFront, ALB, IAM ni producción. Sin secretos en este documento.

## Resultado

**PASS** (implementación). Las métricas de §5–10 se tomaron con el build `index-CDg81feK.js`. El cierre
(`F18-16-CLOSE.md`) añadió el aviso de la cabecera y el ajuste de consulta de `useList`: staging sirve el build
final `index-BxZI4lM0.js`.

- Web: <https://d25z2lpl1efut1.cloudfront.net>
- API: <https://d1lfpi7fp62ntk.cloudfront.net/api>
- `/api/ready`: 200.
- Smoke **37/37** y E2E **18/18** contra el build final.
- ALB: **0 errores 5xx** en las últimas 2 h (956 peticiones) y **0 alarmas** en ALARM.

## 1. ¿Por qué el ADMIN seguía sintiéndose lento?

**La caché de F18-11B era «fresca o nada».** Con 30 s de TTL funcionaba al ir y volver rápido, que es justo lo
que medía la prueba de F18-11B: esperaba solo 400 ms entre clics. En el uso real, con más de 30 s en cada pantalla,
la caché ya había caducado al volver. Entonces cada sección se montaba vacía, pintaba el esqueleto y esperaba a la
red.

En staging, con 32 s por sección, **las 11 navegaciones medidas mostraron esqueleto: mediana 218 ms y p90 298 ms**.
La primera visita a cada sección era peor: **mediana 342 ms**, porque además pagaba el preflight CORS de cada URL
nueva.

## 2. ¿Qué parte exacta causaba la espera?

Medí el recorrido completo en un navegador real (Chrome, CDP), detectando en cada fotograma el cambio visual y el
contenido útil:

- **Router y React:** la ruta y el título cambian en ~4–6 ms. El router no era el cuello de botella.
- **Chunks:** ya estaban precargados (F18-11B): 0 chunks por navegación.
- **Datos:** ahí estaba la espera. `useList` y `useAsync` arrancaban siempre con `rows=[]` y `loading=true`: esqueleto → GET (1 RTT, o 2 en la primera visita por el preflight) → render. Incluso con acierto de caché, el esqueleto aparecía **un fotograma**, porque la caché respondía de forma asíncrona.
- **Además:** `/public/branding/favicon` (204) se volvía a pedir en **cada** navegación.

## 3. ¿Qué cambiaste?

| Archivo | Cambio |
| --- | --- |
| `services/response-cache.ts` | **Stale-while-revalidate:** el dato está fresco 30 s; entre 30 s y 10 min está «viejo» (`peek` lo devuelve marcado, `get` no). |
| `services/api.ts` | Ámbito de petición con políticas `default` / `cache-only` / `network`. Las precargas en vuelo se comparten y se unen a las lecturas de las pantallas. `invalidateReads()` vacía la caché y las peticiones compartidas en login, logout, 401 y cada escritura. |
| `hooks/useList.ts`, `hooks/useAsync.ts` | 1) Leen primero la caché (fresca o vieja) en `useLayoutEffect` y la aplican con `flushSync`, **antes del primer pintado**. 2) Si el dato era viejo, revalidan en segundo plano tras 250 ms, cancelable si el usuario se va. 3) Solo se actualiza «en caliente», sin esqueleto, la **misma consulta** (revalidación o recarga). Si cambian la página, el filtro o la búsqueda y no están en caché, se muestra el esqueleto: la tabla **nunca** enseña filas de otra consulta. 4) Un fallo al revalidar no borra lo visible y avisa en la cabecera. `useAsync` limpia los datos cuando cambian sus dependencias, porque serían de otra entidad. |
| `routes/admin-chunks.ts` | Cargadores y mapa ruta → chunk para **todas** las entradas del menú ADMIN; antes eran 5. |
| `routes/admin-prefetch.ts` (nuevo) | Precarga **de datos** de las 7 secciones principales, además de sus chunks, con las mismas URLs que usa cada página. Cede el paso mientras haya lecturas de pantalla en vuelo o recientes. También precarga al pasar el ratón o el foco por el menú. |
| `layouts/index.tsx` | La caché se activa durante el render de `AdminLayout`, porque los efectos de los hijos corren antes que los del padre. Programa la precarga y conecta `onNavIntent`. |
| `layouts/PortalLayout.tsx` | Prop `onNavIntent`: `mouseenter`, `focus` y `touchstart` en los enlaces del menú (empresa y cliente no la usan). Aviso en la cabecera: «Actualizando…» mientras se muestran datos pendientes de confirmar, y «No se pudo actualizar · se muestran los últimos datos» si la revalidación falla. No bloquea nada. |
| `services/refresh-status.ts` (nuevo) + test | Estado global de las actualizaciones en segundo plano (en curso o fallida), sin React, para que la cabecera lo muestre. |
| `context/BrandingContext.tsx` | Sin favicon configurado usa `data:,`, así que no hay petición por navegación. |
| `components/ui/States.tsx` | Mensaje de error de red dirigido al usuario del panel, no a quien desarrolla. |
| `services/response-cache.test.ts` | +3 tests: dato viejo, `maxAge` y aislamiento por sesión también en los datos viejos. |
| `package.json` | Añade `refresh-status.test.ts` a `npm test`. |

Son 11 archivos modificados y 3 nuevos (ver `F18-16-CLOSE.md` para el estado final). Se mantienen el code splitting, React Router 6.28,
las mismas librerías y los mismos endpoints: **ningún endpoint nuevo**.

## 4. ¿Por qué la solución elimina el problema?

La espera era de **datos**, y ahora ninguna navegación espera a la red para enseñar algo útil:
- una sección ya visitada se pinta con lo último conocido en el mismo fotograma del clic y se actualiza sola en segundo plano;
- una sección no visitada ya tiene sus datos precargados tras el Dashboard, o al pasar el ratón por el enlace.

## 5–10. Antes y después (staging, red real Lima → CloudFront → São Paulo)

| Métrica | Antes | Después | Cambio |
| --- | ---: | ---: | --- |
| Primera visita · contenido útil, mediana | 342 ms | **8,7 ms** | −97 % |
| Primera visita · p90 | 458 ms | **20 ms** | −96 % |
| Primera visita · navegaciones con esqueleto | 9/11 | **0/11** | eliminado |
| Primera visita · peticiones API / navegación | 2,36 | **0,09** | −96 % |
| Primera visita · OPTIONS / navegación | 1,27 | **0** | eliminado |
| Uso realista (32 s) · contenido útil, mediana | 218 ms | **7,3 ms** | −97 % |
| Uso realista · p90 | 298 ms | **16,6 ms** | −94 % |
| Uso realista · con esqueleto | 11/11 | **0/11** | eliminado |
| Uso realista · peticiones / navegación | 3,73 (bloquean) | 2,73 (en segundo plano) | ya no bloquean |
| Vueltas calientes · p90 | 192 ms | **17 ms** | −91 % |
| Vueltas calientes · con esqueleto | 14/22 | **0/22** | eliminado |
| Vueltas calientes · peticiones / navegación | 2,05 | **1,05** | −49 % |
| Navegación rápida (8 clics a 150 ms) · peticiones | 16 | **1** | −94 % |
| Navegación rápida · canceladas | 4 | **0** | — |
| Chunks descargados al navegar | 0 | 0 | = (ya precargados) |
| Carga inicial del Dashboard (A/B simétrico, 4+4, mediana) | 795 ms | 805 ms | = (ruido) |
| Pantalla en blanco / errores HTTP / errores de consola | 0 / 0 / 0 | 0 / 0 / 0 | = |

Laboratorio local (build de producción, 120 ms de RTT simulado), mismas pruebas:

| Métrica | Antes | Después |
| --- | ---: | ---: |
| Primera visita, mediana | 266 ms | 6,6 ms |
| Uso realista, mediana | 129 ms | 4,6 ms |
| Uso realista, con esqueleto | 11/11 | 0/11 |
| Rápida, peticiones | 14 | 0 |

«Cambio visual» (la ruta y el título ya son de la nueva sección) está por debajo de 20 ms antes y después. Ahora
coincide con «contenido útil», porque la tabla llega en el mismo fotograma.

## 11. ¿Se mantiene el contenido visible durante la navegación?

Sí:
- sin pantalla en blanco en ninguna medición;
- el sidebar y la cabecera no se desmontan;
- sin esqueletos en las secciones ya conocidas;
- al paginar, filtrar o revalidar se mantienen las filas y se muestra el indicador «Actualizando».

## 12. ¿Se cancelan las peticiones abandonadas?

Sí. En la navegación rápida en frío, justo tras el Dashboard y antes de la precarga, se cancelan **las 14 lecturas
de las 7 páginas abandonadas**, sin errores y con la última pantalla correcta. Una respuesta vieja nunca pisa a una
nueva.

La precarga en segundo plano espera a que el usuario pare. Con los datos calientes, 8 clics rápidos generan
0 peticiones en el laboratorio y 1 en staging (el contador de no leídas).

## 13. ¿La caché funciona entre secciones?

Sí. La clave es token + URL, y las lecturas compartidas son las mismas: por ejemplo, `/companies?limit=200` sirve
tanto a Usuarios como a su precarga.

Seguridad (punto 27), verificada en el laboratorio con los usuarios de test: **8/8**.
- ADMIN activa la caché.
- El logout la desactiva y la vacía.
- Un login nuevo no hereda nada.
- Un 401 la vacía y cierra la sesión.
- COMPANY_ADMIN, OPERATOR y CUSTOMER no activan la caché ni guardan nada.
- ADMIN, después de otros roles, no hereda nada.

La caché solo existe dentro de `AdminLayout` y su clave incluye el token, así que no puede compartirse entre roles
ni entre empresas.

## 14. ¿Se probó con navegación rápida real?

Sí: Chrome real controlado por CDP contra staging, con clics en el menú, 8 clics a 150 ms y uso realista con 32 s
por sección.

## 15. ¿Todos los tests pasan?

| Suite | Resultado |
| --- | --- |
| Frontend: typecheck / lint / tests | 0 / 0 / **22/22** (19 anteriores + 3 nuevos) |
| Backend MariaDB 10.4 | **2136/2136** |
| Backend MariaDB 10.11 | **2136/2136** |
| Seguridad (33 archivos) | **933/933** en ambas |
| Staging: `/api/ready` · smoke · E2E | 200 · **37/37** · **18/18** (build final) |
| Seguridad de la caché (laboratorio) | **8/8** |
| Errores de consola durante la navegación | 0 |

## 16. ¿Qué queda pendiente?

1. **Revisión humana, commit y push:** no se hizo ninguno.
2. **Datos QA en staging:** smoke y E2E se ejecutaron dos veces (manifiestos en el scratchpad de la sesión, `f1816/qa` y `f1816/qa2`). Su purga queda pendiente, igual que la de las fases anteriores.
3. **Una sesión revocada** puede seguir viendo, como mucho durante 30 s, datos que su pestaña **ya tenía**, hasta que la siguiente lectura o revalidación reciba el 401. Nunca obtiene datos nuevos. Ya pasaba en F18-11B y es propio de cualquier caché.
4. **Datos de otros usuarios:** un dato puede mostrarse con hasta 10 min de antigüedad durante un instante, antes de revalidarse, si otro usuario lo cambió. Las escrituras propias invalidan todo al momento.
5. **La navegación rápida en frío** (8 clics en el primer segundo tras el login) sigue lanzando y cancelando las lecturas de cada página. Es inevitable sin retrasar la primera visita.
6. **Portales público, cliente y empresa:** la arquitectura (caché con clave de token, ámbitos y stale-while-revalidate en los hooks) sirve también para ellos, pero sigue activada **solo en ADMIN**. Extenderla sería una fase aparte.
7. **Verificación visual en tu navegador:** el panel se probó en Chrome real (headless). Para confirmar la sensación, entra al panel y recorre las secciones.
