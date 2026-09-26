# F18-20 Rollback Report

Fecha: 2026-09-26 · Alcance: repositorio y entorno LOCAL. Staging y producción no se tocaron en esta fase.

## 1. Motivo

El rediseño convirtió el perfil público en una experiencia demasiado parecida a una web independiente dentro de
BusPerú:
- un segundo navbar;
- un segundo sitio corporativo;
- un segundo footer;
- un Inicio propio demasiado grande;
- una estructura visual demasiado separada del ecosistema principal.

Se decidió detener el desarrollo y volver al estado anterior para replantear el diseño más adelante, de forma incremental.

## 2. Commit revertido

- `e07acb1` — `feat(public): redesign company websites` (padre: `2e05222`).
- Commit de rollback: **`f8725ad`** — `revert(public): rollback F18-20 redesign`.
- Se creó con `git revert --no-commit e07acb1` y un commit con el mensaje pedido. La historia no se reescribió: sin reset y sin force push.
- Antes de revertir se comprobó que no había commits posteriores a `e07acb1` (`e07acb1..origin/master` vacío) y que el árbol de trabajo estaba limpio, salvo los 5 archivos heredados.
- El revert se aplicó **sin conflictos**.

## 3. Estado objetivo

`2e05222` — `feat(public): complete company profile discovery demo` (estado F18-19D).

- Árbol de `f8725ad`: `ed4331a3307828c99b61b417a5944db4f9a02a1d`.
- Árbol de `2e05222`: `ed4331a3307828c99b61b417a5944db4f9a02a1d` → **idénticos**.
- `git diff 2e05222 f8725ad` está vacío.

Se conservan íntegros:
- F18-19: perfil público de una página, Libro de Reclamaciones y moderación.
- F18-19B: endurecimiento F-01…F-06 (sin ids internos, cabecera, canónica).
- F18-19D: tarjetas «Ver perfil» / «Ver viajes» y la fecha de próxima salida del **listado** `/public/companies`.
- Además: slug, SEO anterior, mapa diferido, servicios, agencias, destinos, flota, galería, opiniones, contacto y seguridad.

Único efecto funcional del revert fuera del diseño: desaparece `next_departure_date` de `GET /public/companies/:slug`. Ese campo lo había añadido F18-20; el del listado es de F18-19D y se mantiene.

## 4. Archivos afectados

Estos son los 28 archivos del diff `2e05222..e07acb1`; todos se restauraron al estado de `2e05222`.

| Estado en F18-20 | Archivo | Tras el rollback |
|---|---|---|
| M | `backend/src/services/company-profile.service.ts` | restaurado |
| M | `backend/src/test/83-f1819-perfil-empresas.test.ts` | restaurado (sin la prueba F18-20) |
| A | `docs/production/F18-20-DESIGN-AUDIT.md` | eliminado |
| A | `docs/production/F18-20-IMPLEMENTATION-REPORT.md` | eliminado |
| M | `frontend/package.json` | restaurado (script de pruebas) |
| A | `frontend/src/components/company-site/CompanyContactForm.tsx` | eliminado |
| A | `frontend/src/components/company-site/CompanyGallery.tsx` | eliminado |
| A | `frontend/src/components/company-site/CompanyPageHero.tsx` | eliminado |
| A | `frontend/src/components/company-site/CompanySiteFooter.tsx` | eliminado |
| A | `frontend/src/components/company-site/CompanySiteHeader.tsx` | eliminado |
| A | `frontend/src/components/company-site/CompanySiteLayout.tsx` | eliminado |
| A | `frontend/src/components/company-site/cards.tsx` | eliminado |
| A | `frontend/src/components/company-site/shared.tsx` | eliminado |
| D | `frontend/src/pages/public/CompanyProfilePage.tsx` | restaurado |
| A | `frontend/src/pages/public/company-site/AboutPage.tsx` | eliminado |
| A | `frontend/src/pages/public/company-site/AgenciesPage.tsx` | eliminado |
| A | `frontend/src/pages/public/company-site/ContactPage.tsx` | eliminado |
| A | `frontend/src/pages/public/company-site/DestinationsPage.tsx` | eliminado |
| A | `frontend/src/pages/public/company-site/FleetPage.tsx` | eliminado |
| A | `frontend/src/pages/public/company-site/HomePage.tsx` | eliminado |
| A | `frontend/src/pages/public/company-site/NotFoundPage.tsx` | eliminado |
| A | `frontend/src/pages/public/company-site/ReviewsPage.tsx` | eliminado |
| A | `frontend/src/pages/public/company-site/ServicesPage.tsx` | eliminado |
| A | `frontend/src/pages/public/company-site/index.ts` | eliminado |
| M | `frontend/src/routes/index.tsx` | restaurado (ruta única `empresas/:slug`) |
| M | `frontend/src/types/company-profile.ts` | restaurado |
| A | `frontend/src/utils/company-site.test.ts` | eliminado |
| A | `frontend/src/utils/company-site.ts` | eliminado |

Ni estilos globales, ni seeds, ni migraciones: F18-20 no los había tocado.

## 5. Tests

Ejecutados sobre el árbol revertido, en local:

| Suite | Resultado | Referencia F18-19D |
|---|---|---|
| Backend MariaDB 10.4 | **2196/2196** | 2196 |
| Backend MariaDB 10.11 | **2196/2196** | 2196 |
| Security (35 archivos, ambos motores) | **993/993** | 993 |
| Frontend (`node --test`) | **45/45** | 45 |
| Typecheck | PASS (backend y frontend) | PASS |
| Lint | PASS (frontend, 0 avisos) | PASS |
| Build | PASS · `index-sNNAxLvE.js` 287,66 kB | **mismo hash** que la build F18-19D |
| F18-19 + F18-19B + F18-19D (archivos 83 y 84) | **60/60** (42 perfil + 18 Libro) | 60 |
| Flujo de descubrimiento F18-19D (`flujo.mjs` original, local) | **13/13** | 13/13 |

Las 15 pruebas unitarias y la prueba backend propias de F18-20 desaparecieron con el revert, como correspondía.

## 6. Estado visual

Se comprobó en local, con el DEMO sembrado por el `seed-demo-staging.mjs` de F18-19D:
- **`/empresas`:** las tarjetas vuelven a ser las de F18-19D, con «Ver perfil» y «Ver viajes» para BusPerú Demo y solo «Ver viajes» para las empresas sin perfil.
- **`/empresas/busperu-demo`:** vuelve el perfil de una sola página:
  - portada con degradado, logo, «Empresa de transporte» y nombre;
  - lema con el aviso DEMO, «Buscar viajes» y «Contacto»;
  - barra de anclas «Secciones del perfil» (Inicio, Nosotros, Servicios, Agencias, Destinos, Flota, Opiniones, Contacto);
  - título SEO «BusPerú Demo · Pasajes, agencias y destinos | BusPerú».
- **Ya no existen** la cabecera de empresa, el pie de empresa, el Inicio ampliado ni las rutas por sección.
- **«Ver viajes»** abre `/buscar?company_id=…&date=<próxima salida>` con 6 viajes encontrados.
- **Consola y red:** sin errores.

No se añadió ningún diseño ni mejora.

## 7. Producción

**NOT DEPLOYED.** No se tocó AWS en esta fase.

## 8. Staging

**NO MODIFICADO durante esta fase.** Staging sigue sirviendo la release F18-20 desplegada antes:
- backend `2026-09-26-3`;
- web `2026-09-26-3`.

Hasta que se autorice volver a desplegar el estado F18-19D, staging **no** coincide con `master`. Para restaurarlo, cuando se autorice:
- **Backend:** publicar una release nueva desde `f8725ad`, o volver a desplegar `2026-09-26-2`, que sigue en el bucket de artefactos y corresponde al estado F18-19D.
- **Frontend:** publicar `f8725ad` con `publish-web.mjs --env staging`.

## 9. Git

| | |
|---|---|
| Commit revertido | `e07acb1fb12eb4ad6f9317bb8f44b3355e5c5c62` |
| Commit de rollback | `f8725ad98d68e88c6b42e5f31b0302ef496356b2` |
| HEAD tras el push del rollback | `f8725ad98d68e88c6b42e5f31b0302ef496356b2` |
| origin/master tras el push del rollback | `f8725ad98d68e88c6b42e5f31b0302ef496356b2` |
| Push | `git push origin master` (`e07acb1..f8725ad`), sin `--force` |

- `2e05222` y `da4d474` no se modificaron y no se reescribió ningún commit.
- Este informe se añade después en un commit aparte, solo de documentación, para que el commit de rollback siga siendo un árbol idéntico a `2e05222`.

## 10. Archivos heredados

Los cinco archivos heredados sin seguimiento no se modificaron ni se incluyeron en ningún commit. Su SHA-256 es idéntico antes y después:

| Archivo | SHA-256 |
|---|---|
| `docs/production/F18-12-COMMIT-PREP.md` | `3aa2a765…e4ef780e` |
| `docs/production/F18-12A-COMMIT-RECONCILIATION.md` | `fb3dd96a…0a2de039` |
| `docs/production/F18-12B-COMMIT-PLAN-RESULT.md` | `8909af99…62c206b` |
| `docs/production/F18-12C-COMMITS-CREATED.md` | `a022af32…e6e5ca7` |
| `qa-manifest-e2e-mug3ixsf.json` | `a4d7bfb2…646b130` |
