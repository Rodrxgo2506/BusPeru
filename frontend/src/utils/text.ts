/**
 * Utilidades de texto sin dependencias (FASE 17), para poder probarlas con `node --test`.
 */

/** Minúsculas y sin tildes: «Huánuco» y «huanuco» se consideran iguales al buscar. */
export function normalizeForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Opciones que contienen el texto buscado, sin distinguir tildes ni mayúsculas. Conserva el orden. */
export function filterOptions(options: readonly string[], search: string): string[] {
  const needle = normalizeForSearch(search);
  if (!needle) return [...options];
  return options.filter((option) => normalizeForSearch(option).includes(needle));
}

export const SLUG_MAX = 120;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** «La Merced» → «la-merced». Misma regla que aplica el backend (`destination.validators.ts`). */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}
