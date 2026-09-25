/**
 * Cargadores de los módulos de las secciones principales del panel ADMIN (F18-11B).
 *
 * `routes/index.tsx` los usa en sus `React.lazy` y `AdminLayout` los precarga en segundo plano
 * cuando el panel ya está pintado y el navegador está ocioso. Es el MISMO `import()`, así que es el
 * mismo chunk: la primera visita a una sección ya no espera a descargarlo.
 *
 * Solo módulos que el ADMIN usa en su navegación habitual (Empresas, Usuarios, Viajes, Reservas,
 * Pagos, Destinos, Configuración). No se precarga nada de los portales CUSTOMER ni COMPANY.
 */
export const loadAdminManagementPages = () => import('@/pages/modules/AdminManagementPages');
export const loadTripPages = () => import('@/pages/modules/TripPages');
export const loadSalesPages = () => import('@/pages/modules/SalesPages');
export const loadDestinationsAdminPage = () => import('@/pages/admin/DestinationsAdminPage');
export const loadSystemPages = () => import('@/pages/modules/SystemPages');

const ADMIN_SECTION_LOADERS = [loadAdminManagementPages, loadTripPages, loadSalesPages, loadDestinationsAdminPage, loadSystemPages];

let prefetched = false;

/**
 * Descarga los módulos uno tras otro (no compiten entre sí ni con las peticiones de la página) y
 * una sola vez por sesión de la SPA. Un fallo de red no importa: la ruta lo volverá a pedir al entrar.
 */
export async function prefetchAdminSections(): Promise<void> {
  if (prefetched) return;
  prefetched = true;
  for (const load of ADMIN_SECTION_LOADERS) {
    try {
      await load();
    } catch {
      /* se reintentará al navegar */
    }
  }
}
