/**
 * Cargadores de los módulos (chunks) del panel ADMIN (F18-11B, ampliado en F18-16).
 *
 * `routes/index.tsx` los usa en sus `React.lazy` y el panel los precarga (ver `admin-prefetch.ts`):
 * es el MISMO `import()`, así que es el mismo chunk y la primera visita a una sección ya no espera
 * a descargarlo. Se mantiene el code splitting: cada sección sigue siendo su propio chunk.
 */
export const loadAdminDashboard = () => import('@/pages/admin/AdminDashboard');
export const loadAdminManagementPages = () => import('@/pages/modules/AdminManagementPages');
export const loadTripPages = () => import('@/pages/modules/TripPages');
export const loadSalesPages = () => import('@/pages/modules/SalesPages');
export const loadDestinationsAdminPage = () => import('@/pages/admin/DestinationsAdminPage');
export const loadSystemPages = () => import('@/pages/modules/SystemPages');
export const loadFleetPages = () => import('@/pages/modules/FleetPages');
export const loadCompanyPages = () => import('@/pages/modules/CompanyPages');
export const loadCompanyDocumentsPage = () => import('@/pages/modules/CompanyDocumentsPage');
export const loadFinancePages = () => import('@/pages/modules/FinancePages');
export const loadMarketingPages = () => import('@/pages/modules/MarketingPages');
export const loadIntegrationsPage = () => import('@/pages/modules/IntegrationsPage');
export const loadBrandingPage = () => import('@/pages/admin/BrandingPage');

/** Chunk que necesita cada entrada del menú ADMIN (misma lista que `ADMIN_NAV`). */
export const ADMIN_ROUTE_CHUNKS: Readonly<Record<string, () => Promise<unknown>>> = {
  '/admin/dashboard': loadAdminDashboard,
  '/admin/users': loadAdminManagementPages,
  '/admin/roles': loadAdminManagementPages,
  '/admin/companies': loadAdminManagementPages,
  '/admin/company-documents': loadCompanyDocumentsPage,
  '/admin/buses': loadFleetPages,
  '/admin/bus-types': loadCompanyPages,
  '/admin/seat-types': loadCompanyPages,
  '/admin/locations': loadFleetPages,
  '/admin/routes': loadFleetPages,
  '/admin/trips': loadTripPages,
  '/admin/bookings': loadSalesPages,
  '/admin/payments': loadSalesPages,
  '/admin/refunds': loadSalesPages,
  '/admin/commissions': loadFinancePages,
  '/admin/settlements': loadFinancePages,
  '/admin/financial': loadFinancePages,
  '/admin/reports': loadFinancePages,
  '/admin/destinations': loadDestinationsAdminPage,
  '/admin/promotions': loadMarketingPages,
  '/admin/coupons': loadMarketingPages,
  '/admin/reviews': loadMarketingPages,
  '/admin/notifications': loadSystemPages,
  '/admin/support': loadSystemPages,
  '/admin/audit': loadSystemPages,
  '/admin/api-keys': loadSystemPages,
  '/admin/settings': loadSystemPages,
  '/admin/integrations': loadIntegrationsPage,
  '/admin/branding': loadBrandingPage,
};
