import { lazy, useLayoutEffect } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { RouteSuspense } from '@/components/common/RouteSuspense';
import { AdminLayout, CompanyLayout, CustomerLayout, PublicLayout } from '@/layouts';
import { GuestRoute, PermissionRoute, ProtectedRoute, RoleRoute } from '@/guards';
import { CheckoutProvider } from '@/pages/public/checkout/CheckoutContext';
import { loadAdminManagementPages, loadDestinationsAdminPage, loadSalesPages, loadSystemPages, loadTripPages } from './admin-chunks';

const HomePage = lazy(() => import('@/pages/public/HomePage').then((module) => ({ default: module.HomePage })));
const SearchResultsPage = lazy(() => import('@/pages/public/SearchResultsPage').then((module) => ({ default: module.SearchResultsPage })));
const DestinationDetailPage = lazy(() => import('@/pages/public/DestinationDetailPage').then((module) => ({ default: module.DestinationDetailPage })));
const DestinationsPage = lazy(() => import('@/pages/public/DestinationsPage').then((module) => ({ default: module.DestinationsPage })));
const CompaniesPublicPage = lazy(() => import('@/pages/public/InfoPages').then((module) => ({ default: module.CompaniesPage })));
const OffersPage = lazy(() => import('@/pages/public/InfoPages').then((module) => ({ default: module.OffersPage })));
const HelpPage = lazy(() => import('@/pages/public/InfoPages').then((module) => ({ default: module.HelpPage })));
const NotFoundPage = lazy(() => import('@/pages/public/InfoPages').then((module) => ({ default: module.NotFoundPage })));

const SeatSelectionPage = lazy(() => import('@/pages/public/checkout/SeatSelectionPage').then((module) => ({ default: module.SeatSelectionPage })));
const PassengerPage = lazy(() => import('@/pages/public/checkout/PassengerPage').then((module) => ({ default: module.PassengerPage })));
const PaymentPage = lazy(() => import('@/pages/public/checkout/PaymentPage').then((module) => ({ default: module.PaymentPage })));
const ConfirmationPage = lazy(() => import('@/pages/public/checkout/ConfirmationPage').then((module) => ({ default: module.ConfirmationPage })));
const ItineraryConfirmationPage = lazy(() => import('@/pages/public/checkout/ItineraryConfirmationPage').then((module) => ({ default: module.ItineraryConfirmationPage })));

const LoginPage = lazy(() => import('@/pages/auth/LoginPage').then((module) => ({ default: module.LoginPage })));
const RegisterPage = lazy(() => import('@/pages/auth/RegisterPage').then((module) => ({ default: module.RegisterPage })));
const ForgotPasswordPage = lazy(() => import('@/pages/auth/PasswordPages').then((module) => ({ default: module.ForgotPasswordPage })));
const OAuthCallbackPage = lazy(() => import('@/pages/auth/OAuthCallbackPage').then((module) => ({ default: module.OAuthCallbackPage })));
const CompanyLoginPage = lazy(() => import('@/pages/auth/CompanyAuthPages').then((module) => ({ default: module.CompanyLoginPage })));
const CompanyRegisterPage = lazy(() => import('@/pages/auth/CompanyAuthPages').then((module) => ({ default: module.CompanyRegisterPage })));
const AdminLoginPage = lazy(() => import('@/pages/auth/AdminLoginPage').then((module) => ({ default: module.AdminLoginPage })));

const MyTripsPage = lazy(() => import('@/pages/customer/MyTripsPage').then((module) => ({ default: module.MyTripsPage })));
const BookingDetailPage = lazy(() => import('@/pages/customer/CustomerPages').then((module) => ({ default: module.BookingDetailPage })));
const CustomerNotificationsPage = lazy(() => import('@/pages/customer/CustomerPages').then((module) => ({ default: module.CustomerNotificationsPage })));
const CustomerSupportPage = lazy(() => import('@/pages/customer/CustomerPages').then((module) => ({ default: module.CustomerSupportPage })));
const CustomerTicketDetailPage = lazy(() => import('@/pages/customer/CustomerPages').then((module) => ({ default: module.CustomerTicketDetailPage })));
const CustomerProfilePage = lazy(() => import('@/pages/customer/ProfilePage').then((module) => ({ default: module.CustomerProfilePage })));

const CompanyDashboard = lazy(() => import('@/pages/company/CompanyDashboard').then((module) => ({ default: module.CompanyDashboard })));
const AdminDashboard = lazy(() => import('@/pages/admin/AdminDashboard').then((module) => ({ default: module.AdminDashboard })));

const BusesPage = lazy(() => import('@/pages/modules/FleetPages').then((module) => ({ default: module.BusesPage })));
const LocationsPage = lazy(() => import('@/pages/modules/FleetPages').then((module) => ({ default: module.LocationsPage })));
const RoutesModulePage = lazy(() => import('@/pages/modules/FleetPages').then((module) => ({ default: module.RoutesPage })));
const TripsPage = lazy(() => loadTripPages().then((module) => ({ default: module.TripsPage })));
const PassengersPage = lazy(() => loadTripPages().then((module) => ({ default: module.PassengersPage })));
const SeatConfigPage = lazy(() => import('@/pages/modules/SeatConfigPage').then((module) => ({ default: module.SeatConfigPage })));
const BookingsPage = lazy(() => loadSalesPages().then((module) => ({ default: module.BookingsPage })));
const PaymentsPage = lazy(() => loadSalesPages().then((module) => ({ default: module.PaymentsPage })));
const RefundsPage = lazy(() => loadSalesPages().then((module) => ({ default: module.RefundsPage })));
const PromotionsPage = lazy(() => import('@/pages/modules/MarketingPages').then((module) => ({ default: module.PromotionsPage })));
const CouponsPage = lazy(() => import('@/pages/modules/MarketingPages').then((module) => ({ default: module.CouponsPage })));
const ReviewsPage = lazy(() => import('@/pages/modules/MarketingPages').then((module) => ({ default: module.ReviewsPage })));
const SettlementsPage = lazy(() => import('@/pages/modules/FinancePages').then((module) => ({ default: module.SettlementsPage })));
const FinancialTransactionsPage = lazy(() => import('@/pages/modules/FinancePages').then((module) => ({ default: module.FinancialTransactionsPage })));
const ReportsPage = lazy(() => import('@/pages/modules/FinancePages').then((module) => ({ default: module.ReportsPage })));
const CommissionsPage = lazy(() => import('@/pages/modules/FinancePages').then((module) => ({ default: module.CommissionsPage })));
const UsersPage = lazy(() => loadAdminManagementPages().then((module) => ({ default: module.UsersPage })));
const RolesPage = lazy(() => loadAdminManagementPages().then((module) => ({ default: module.RolesPage })));
const AdminCompaniesPage = lazy(() => loadAdminManagementPages().then((module) => ({ default: module.CompaniesPage })));
const SupportPage = lazy(() => loadSystemPages().then((module) => ({ default: module.SupportPage })));
const NotificationsAdminPage = lazy(() => loadSystemPages().then((module) => ({ default: module.NotificationsAdminPage })));
const AuditPage = lazy(() => loadSystemPages().then((module) => ({ default: module.AuditPage })));
const ApiKeysPage = lazy(() => loadSystemPages().then((module) => ({ default: module.ApiKeysPage })));
const SettingsPage = lazy(() => loadSystemPages().then((module) => ({ default: module.SettingsPage })));
const CompanyNotificationsPage = lazy(() => import('@/pages/modules/CompanyPages').then((module) => ({ default: module.CompanyNotificationsPage })));
const CompanyProfilePage = lazy(() => import('@/pages/modules/CompanyPages').then((module) => ({ default: module.CompanyProfilePage })));
const BusTypesPage = lazy(() => import('@/pages/modules/CompanyPages').then((module) => ({ default: module.BusTypesPage })));
const SeatTypesPage = lazy(() => import('@/pages/modules/CompanyPages').then((module) => ({ default: module.SeatTypesPage })));
const BankAccountsPage = lazy(() => import('@/pages/modules/BankAccountsPage').then((module) => ({ default: module.BankAccountsPage })));
const DriversPage = lazy(() => import('@/pages/modules/DriversPage').then((module) => ({ default: module.DriversPage })));
const IntegrationsPage = lazy(() => import('@/pages/modules/IntegrationsPage').then((module) => ({ default: module.IntegrationsPage })));
const CompanyDocumentsPage = lazy(() => import('@/pages/modules/CompanyDocumentsPage').then((module) => ({ default: module.CompanyDocumentsPage })));
const DestinationsAdminPage = lazy(() => loadDestinationsAdminPage().then((module) => ({ default: module.DestinationsAdminPage })));
const DestinationContentPage = lazy(() => import('@/pages/admin/DestinationContentPage').then((module) => ({ default: module.DestinationContentPage })));
const BrandingPage = lazy(() => import('@/pages/admin/BrandingPage').then((module) => ({ default: module.BrandingPage })));
const DocumentReviewPage = lazy(() => import('@/pages/modules/CompanyDocumentsPage').then((module) => ({ default: module.DocumentReviewPage })));

/**
 * Armazón de las pantallas de autenticación, que no usan ningún layout con navegación. Les da su
 * propio límite de carga para no necesitar uno global por encima de `<Routes>` (F17C-NAV-01): el
 * indicador solo aparece en esta rama del árbol, nunca sobre el resto de la aplicación.
 */
function StandaloneRoutes() {
  return (
    <RouteSuspense>
      <Outlet />
    </RouteSuspense>
  );
}

/**
 * Coloca cada ruta nueva arriba del todo (F17C-NAV-03).
 *
 * Sin esto la posición vertical se arrastraba de una página a la siguiente: se aterrizaba a media
 * página y, si la nueva era más corta, el navegador recortaba y luego restauraba el desplazamiento,
 * lo que dibujaba restos de la pantalla anterior.
 *
 * `POP` es atrás/adelante del navegador: ahí la posición la restaura él y no se toca. Un `hash` en la
 * URL tampoco se pisa, para que los anclajes sigan funcionando. Depende solo de la ruta, así que
 * filtrar o paginar (que solo cambian la consulta) no mueve la página.
 */
function ScrollToTop() {
  const { pathname, hash } = useLocation();
  const navigationType = useNavigationType();

  useLayoutEffect(() => {
    if (navigationType === 'POP' || hash) return;
    window.scrollTo(0, 0);
  }, [pathname, hash, navigationType]);

  return null;
}

export function AppRoutes() {
  return (
    <CheckoutProvider>
      <ScrollToTop />
      <Routes>
        {/* Autenticación (fuera de los layouts con navegación) */}
        <Route element={<StandaloneRoutes />}>
          <Route
            path="/login"
            element={
              <GuestRoute>
                <LoginPage />
              </GuestRoute>
            }
          />
          <Route
            path="/registro"
            element={
              <GuestRoute>
                <RegisterPage />
              </GuestRoute>
            }
          />
          <Route path="/recuperar-contrasena" element={<ForgotPasswordPage />} />
          {/* Retorno del proveedor OAuth. Sin GuestRoute: el ticket llega antes de haber sesión. */}
          <Route path="/auth/oauth/callback" element={<OAuthCallbackPage />} />
          <Route
            path="/empresa/login"
            element={
              <GuestRoute>
                <CompanyLoginPage />
              </GuestRoute>
            }
          />
          <Route path="/empresa/registro" element={<CompanyRegisterPage />} />
          <Route
            path="/admin/login"
            element={
              <GuestRoute>
                <AdminLoginPage />
              </GuestRoute>
            }
          />
        </Route>

        {/* Portal público y área de cliente */}
        <Route element={<PublicLayout />}>
          <Route index element={<HomePage />} />
          <Route path="buscar" element={<SearchResultsPage />} />
          <Route path="destinos" element={<DestinationsPage />} />
          <Route path="destinos/:slug" element={<DestinationDetailPage />} />
          <Route path="empresas" element={<CompaniesPublicPage />} />
          <Route path="ofertas" element={<OffersPage />} />
          <Route path="ayuda" element={<HelpPage />} />

          <Route path="viaje/:tripId/asientos" element={<SeatSelectionPage />} />
          <Route path="reserva/pasajeros" element={<PassengerPage />} />
          <Route path="reserva/pago" element={<PaymentPage />} />
          <Route
            path="reserva/confirmacion/itinerario/:groupId"
            element={
              <ProtectedRoute>
                <ItineraryConfirmationPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="reserva/confirmacion/:bookingId"
            element={
              <ProtectedRoute>
                <ConfirmationPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="customer"
            element={
              <ProtectedRoute>
                <CustomerLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="/customer/trips" replace />} />
            <Route path="trips" element={<MyTripsPage />} />
            <Route path="bookings" element={<MyTripsPage />} />
            <Route path="bookings/:bookingId" element={<BookingDetailPage />} />
            <Route path="notifications" element={<CustomerNotificationsPage />} />
            <Route path="support" element={<CustomerSupportPage />} />
            <Route path="support/:ticketId" element={<CustomerTicketDetailPage />} />
            <Route path="profile" element={<CustomerProfilePage />} />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Route>

        {/* Portal Empresa */}
        <Route
          path="/company"
          element={
            <RoleRoute roles={['COMPANY_ADMIN', 'OPERATOR', 'ADMIN']} loginPath="/empresa/login" requiresCompany>
              <CompanyLayout />
            </RoleRoute>
          }
        >
          <Route index element={<Navigate to="/company/dashboard" replace />} />
          <Route path="dashboard" element={<CompanyDashboard />} />
          <Route
            path="buses"
            element={
              <PermissionRoute permission="buses.view">
                <BusesPage scope="company" />
              </PermissionRoute>
            }
          />
          <Route
            path="buses/:busId/asientos"
            element={
              <PermissionRoute permission="buses.view">
                <SeatConfigPage scope="company" />
              </PermissionRoute>
            }
          />
          <Route
            path="routes"
            element={
              <PermissionRoute permission="routes.view">
                <RoutesModulePage scope="company" />
              </PermissionRoute>
            }
          />
          <Route
            path="terminals"
            element={
              <PermissionRoute permission="routes.view">
                <LocationsPage scope="company" />
              </PermissionRoute>
            }
          />
          <Route
            path="drivers"
            element={
              <PermissionRoute permission="buses.view">
                <DriversPage />
              </PermissionRoute>
            }
          />
          <Route
            path="trips"
            element={
              <PermissionRoute permission="trips.view">
                <TripsPage scope="company" />
              </PermissionRoute>
            }
          />
          <Route
            path="bookings"
            element={
              <PermissionRoute permission="bookings.view">
                <BookingsPage scope="company" />
              </PermissionRoute>
            }
          />
          <Route
            path="passengers"
            element={
              <PermissionRoute permission="bookings.view">
                <PassengersPage />
              </PermissionRoute>
            }
          />
          <Route
            path="payments"
            element={
              <PermissionRoute permission="payments.view">
                <PaymentsPage scope="company" />
              </PermissionRoute>
            }
          />
          <Route
            path="refunds"
            element={
              <PermissionRoute permission="payments.view">
                <RefundsPage scope="company" />
              </PermissionRoute>
            }
          />
          <Route
            path="settlements"
            element={
              <PermissionRoute permission="reports.view">
                <SettlementsPage scope="company" />
              </PermissionRoute>
            }
          />
          <Route
            path="reports"
            element={
              <PermissionRoute permission="reports.view">
                <ReportsPage scope="company" />
              </PermissionRoute>
            }
          />
          <Route
            path="promotions"
            element={
              <PermissionRoute permission="promotions.view">
                <PromotionsPage scope="company" />
              </PermissionRoute>
            }
          />
          <Route
            path="reviews"
            element={
              <PermissionRoute permission="reviews.view">
                <ReviewsPage scope="company" />
              </PermissionRoute>
            }
          />
          <Route
            path="users"
            element={
              <PermissionRoute permission="users.view">
                <UsersPage scope="company" />
              </PermissionRoute>
            }
          />
          <Route
            path="bank-accounts"
            element={
              <PermissionRoute permission="companies.view">
                <BankAccountsPage />
              </PermissionRoute>
            }
          />
          <Route
            path="documents"
            element={
              <PermissionRoute permission="companies.view">
                <CompanyDocumentsPage />
              </PermissionRoute>
            }
          />
          <Route
            path="integrations"
            element={
              <PermissionRoute permission="companies.view">
                <IntegrationsPage scope="company" />
              </PermissionRoute>
            }
          />
          <Route path="notifications" element={<CompanyNotificationsPage />} />
          <Route path="support" element={<SupportPage scope="company" />} />
          <Route
            path="settings"
            element={
              <PermissionRoute permission="companies.view">
                <CompanyProfilePage />
              </PermissionRoute>
            }
          />
        </Route>

        {/* Panel administrativo */}
        <Route
          path="/admin"
          element={
            <RoleRoute roles={['ADMIN']} loginPath="/admin/login">
              <AdminLayout />
            </RoleRoute>
          }
        >
          <Route index element={<Navigate to="/admin/dashboard" replace />} />
          <Route path="dashboard" element={<AdminDashboard />} />
          <Route
            path="users"
            element={
              <PermissionRoute permission="users.view">
                <UsersPage scope="admin" />
              </PermissionRoute>
            }
          />
          <Route
            path="roles"
            element={
              <PermissionRoute permission="roles.view">
                <RolesPage />
              </PermissionRoute>
            }
          />
          <Route
            path="companies"
            element={
              <PermissionRoute permission="companies.view">
                <AdminCompaniesPage />
              </PermissionRoute>
            }
          />
          <Route
            path="buses"
            element={
              <PermissionRoute permission="buses.view">
                <BusesPage scope="admin" />
              </PermissionRoute>
            }
          />
          <Route
            path="buses/:busId/asientos"
            element={
              <PermissionRoute permission="buses.view">
                <SeatConfigPage scope="admin" />
              </PermissionRoute>
            }
          />
          <Route
            path="bus-types"
            element={
              <PermissionRoute permission="buses.view">
                <BusTypesPage />
              </PermissionRoute>
            }
          />
          <Route
            path="seat-types"
            element={
              <PermissionRoute permission="buses.view">
                <SeatTypesPage />
              </PermissionRoute>
            }
          />
          <Route
            path="locations"
            element={
              <PermissionRoute permission="routes.view">
                <LocationsPage scope="admin" />
              </PermissionRoute>
            }
          />
          <Route
            path="routes"
            element={
              <PermissionRoute permission="routes.view">
                <RoutesModulePage scope="admin" />
              </PermissionRoute>
            }
          />
          <Route
            path="trips"
            element={
              <PermissionRoute permission="trips.view">
                <TripsPage scope="admin" />
              </PermissionRoute>
            }
          />
          <Route
            path="bookings"
            element={
              <PermissionRoute permission="bookings.view">
                <BookingsPage scope="admin" />
              </PermissionRoute>
            }
          />
          <Route
            path="payments"
            element={
              <PermissionRoute permission="payments.view">
                <PaymentsPage scope="admin" />
              </PermissionRoute>
            }
          />
          <Route
            path="refunds"
            element={
              <PermissionRoute permission="payments.view">
                <RefundsPage scope="admin" />
              </PermissionRoute>
            }
          />
          <Route
            path="commissions"
            element={
              <PermissionRoute permission="reports.view">
                <CommissionsPage />
              </PermissionRoute>
            }
          />
          <Route
            path="settlements"
            element={
              <PermissionRoute permission="reports.view">
                <SettlementsPage scope="admin" />
              </PermissionRoute>
            }
          />
          <Route
            path="financial"
            element={
              <PermissionRoute permission="reports.view">
                <FinancialTransactionsPage />
              </PermissionRoute>
            }
          />
          <Route
            path="reports"
            element={
              <PermissionRoute permission="reports.view">
                <ReportsPage scope="admin" />
              </PermissionRoute>
            }
          />
          <Route
            path="promotions"
            element={
              <PermissionRoute permission="promotions.view">
                <PromotionsPage scope="admin" />
              </PermissionRoute>
            }
          />
          <Route
            path="coupons"
            element={
              <PermissionRoute permission="promotions.view">
                <CouponsPage />
              </PermissionRoute>
            }
          />
          <Route
            path="reviews"
            element={
              <PermissionRoute permission="reviews.view">
                <ReviewsPage scope="admin" />
              </PermissionRoute>
            }
          />
          <Route path="notifications" element={<NotificationsAdminPage scope="admin" />} />
          <Route path="support" element={<SupportPage scope="admin" />} />
          <Route
            path="audit"
            element={
              <PermissionRoute permission="audit_logs.view">
                <AuditPage />
              </PermissionRoute>
            }
          />
          <Route
            path="company-documents"
            element={
              <PermissionRoute permission="companies.update">
                <DocumentReviewPage />
              </PermissionRoute>
            }
          />
          <Route
            path="integrations"
            element={
              <PermissionRoute permission="companies.update">
                <IntegrationsPage scope="admin" />
              </PermissionRoute>
            }
          />
          <Route
            path="api-keys"
            element={
              <PermissionRoute permission="settings.view">
                <ApiKeysPage />
              </PermissionRoute>
            }
          />
          <Route
            path="settings"
            element={
              <PermissionRoute permission="settings.view">
                <SettingsPage scope="admin" />
              </PermissionRoute>
            }
          />
          {/* FASE 17 · contenido público e identidad visual (la API exige además rol ADMIN). */}
          <Route
            path="destinations"
            element={
              <PermissionRoute permission="settings.view">
                <DestinationsAdminPage />
              </PermissionRoute>
            }
          />
          <Route
            path="destinations/:destinationId"
            element={
              <PermissionRoute permission="settings.view">
                <DestinationContentPage />
              </PermissionRoute>
            }
          />
          <Route
            path="branding"
            element={
              <PermissionRoute permission="settings.view">
                <BrandingPage />
              </PermissionRoute>
            }
          />
        </Route>
      </Routes>
    </CheckoutProvider>
  );
}
