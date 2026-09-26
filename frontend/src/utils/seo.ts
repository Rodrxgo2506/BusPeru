/**
 * F18-19B (F-05) · URL canónica de una página pública: el ORIGEN real desde el que se sirve la web (staging en
 * staging, el dominio de producción en producción; nunca uno escrito a mano) más la ruta, sin query ni fragmento
 * (`/buscar?origin=…` y `/empresas/x#agencias` son la misma página) y sin barra final salvo en la raíz.
 */
export function canonicalUrl(origin: string, pathname: string): string {
  const base = origin.replace(/\/+$/, '');
  const path = `/${pathname.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
  return `${base}${path.length > 1 ? path.replace(/\/+$/, '') : '/'}`;
}
