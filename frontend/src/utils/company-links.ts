/**
 * F18-19D · acciones de la tarjeta de empresa del listado público (/empresas).
 *
 * - «Ver perfil» SOLO si el backend entrega el slug de un perfil público aprobado (`slug` ≠ null). El slug nunca
 *   se construye en el frontend a partir del nombre: una URL inventada llevaría a «Empresa no encontrada».
 * - «Ver viajes» siempre, con el mismo destino que antes de F18-19 (el buscador filtrado por la empresa), en la fecha de
 *   su PRÓXIMA salida visible si el backend la conoce (`next_departure_date`); si no, en la fecha indicada (hoy).
 */
export interface CompanyCardAction {
  href: string;
  label: string;
  /** Nombre accesible completo: dice a qué empresa lleva el enlace (varias tarjetas repiten el mismo texto). */
  ariaLabel: string;
}

export interface CompanyCardActions {
  profile: CompanyCardAction | null;
  trips: CompanyCardAction;
}

export function companyCardActions(
  company: { id: number; name: string; slug?: string | null; next_departure_date?: string | null },
  fallbackDate: string,
): CompanyCardActions {
  const slug = typeof company.slug === 'string' && company.slug.trim() !== '' ? company.slug.trim() : null;
  const date = typeof company.next_departure_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(company.next_departure_date) ? company.next_departure_date : fallbackDate;
  return {
    profile: slug
      ? { href: `/empresas/${encodeURIComponent(slug)}`, label: 'Ver perfil', ariaLabel: `Ver el perfil de ${company.name}` }
      : null,
    trips: {
      href: `/buscar?company_id=${encodeURIComponent(String(company.id))}&date=${encodeURIComponent(date)}`,
      label: 'Ver viajes',
      ariaLabel: `Ver los viajes de ${company.name}`,
    },
  };
}
