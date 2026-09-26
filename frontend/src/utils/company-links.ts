/**
 * Enlace «Ver viajes» de la tarjeta de empresa en /empresas: el buscador existente filtrado por la empresa.
 *
 * F18-19D · la fecha es la de la próxima salida visible si el backend la conoce (`next_departure_date`); si no, la
 * indicada (hoy). Así «Ver viajes» no abre un día sin salidas. Se conserva aunque se retiraron los perfiles públicos:
 * no depende de ellos.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function companyTripsHref(company: { id: number; next_departure_date?: string | null }, fallbackDate: string): string {
  const next = company.next_departure_date;
  const date = next && ISO_DATE.test(next) ? next : fallbackDate;
  return `/buscar?company_id=${company.id}&date=${date}`;
}
