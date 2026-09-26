import {
  Armchair,
  BadgeCheck,
  Bell,
  BookOpen,
  Bus,
  Building2,
  CalendarClock,
  CreditCard,
  FileText,
  Gauge,
  Headphones,
  KeyRound,
  Landmark,
  MapPin,
  MapPinned,
  Megaphone,
  Palette,
  Percent,
  Plug,
  Receipt,
  RotateCcw,
  Route as RouteIcon,
  ScrollText,
  Settings,
  ShieldCheck,
  Store,
  Star,
  Ticket,
  TicketCheck,
  UserRound,
  Users,
  Wallet,
} from 'lucide-react';
import type { ReactNode } from 'react';

export interface NavItem {
  label: string;
  to: string;
  icon: ReactNode;
  /** Item is hidden when the user holds none of these permissions. Empty = always visible. */
  permissions?: string[];
  section?: string;
  /** Shown but not navigable: the mockup includes it, the schema has no table behind it yet. */
  disabled?: boolean;
}

const iconProps = { className: 'h-[18px] w-[18px]' };

/**
 * Navegación pública. Vive aquí porque la comparten el layout público y la cabecera de las
 * pantallas de autenticación; duplicarla llevaría a que se desincronizaran.
 */
export const PUBLIC_NAV_LINKS: Array<{ label: string; to: string }> = [
  { label: 'Inicio', to: '/' },
  { label: 'Destinos', to: '/destinos' },
  { label: 'Empresas', to: '/empresas' },
  { label: 'Ofertas', to: '/ofertas' },
  { label: 'Ayuda', to: '/ayuda' },
];

export const COMPANY_NAV: NavItem[] = [
  { label: 'Dashboard', to: '/company/dashboard', icon: <Gauge {...iconProps} /> },
  { label: 'Mis buses', to: '/company/buses', icon: <Bus {...iconProps} />, permissions: ['buses.view'] },
  { label: 'Rutas', to: '/company/routes', icon: <RouteIcon {...iconProps} />, permissions: ['routes.view'] },
  { label: 'Terminales', to: '/company/terminals', icon: <MapPin {...iconProps} />, permissions: ['routes.view'] },
  { label: 'Conductores', to: '/company/drivers', icon: <UserRound {...iconProps} />, permissions: ['buses.view'] },
  { label: 'Viajes', to: '/company/trips', icon: <CalendarClock {...iconProps} />, permissions: ['trips.view'] },
  { label: 'Reservas', to: '/company/bookings', icon: <Ticket {...iconProps} />, permissions: ['bookings.view'] },
  { label: 'Pasajeros', to: '/company/passengers', icon: <Users {...iconProps} />, permissions: ['bookings.view'] },
  { label: 'Pagos', to: '/company/payments', icon: <CreditCard {...iconProps} />, permissions: ['payments.view'] },
  { label: 'Reembolsos', to: '/company/refunds', icon: <RotateCcw {...iconProps} />, permissions: ['payments.view'] },
  { label: 'Liquidaciones', to: '/company/settlements', icon: <Wallet {...iconProps} />, permissions: ['reports.view'] },
  { label: 'Reportes', to: '/company/reports', icon: <FileText {...iconProps} />, permissions: ['reports.view'] },
  { label: 'Promociones', to: '/company/promotions', icon: <Percent {...iconProps} />, permissions: ['promotions.view'] },
  { label: 'Reseñas', to: '/company/reviews', icon: <Star {...iconProps} />, permissions: ['reviews.view'] },
  { label: 'Datos bancarios', to: '/company/bank-accounts', icon: <Landmark {...iconProps} />, permissions: ['companies.view'], section: 'Gestión' },
  { label: 'Verificación', to: '/company/documents', icon: <BadgeCheck {...iconProps} />, permissions: ['companies.view'], section: 'Gestión' },
  { label: 'Integraciones', to: '/company/integrations', icon: <Plug {...iconProps} />, permissions: ['companies.view'], section: 'Gestión' },
  { label: 'Usuarios', to: '/company/users', icon: <ShieldCheck {...iconProps} />, permissions: ['users.view'], section: 'Gestión' },
  { label: 'Notificaciones', to: '/company/notifications', icon: <Bell {...iconProps} />, section: 'Gestión' },
  { label: 'Soporte', to: '/company/support', icon: <Headphones {...iconProps} />, section: 'Gestión' },
  { label: 'Configuración', to: '/company/settings', icon: <Settings {...iconProps} />, permissions: ['companies.view'], section: 'Gestión' },
  // F18-19 · «Mi empresa → Perfil público» y hojas del Libro de Reclamaciones relacionadas con la empresa.
  { label: 'Perfil público', to: '/company/profile', icon: <Store {...iconProps} />, permissions: ['companies.view'], section: 'Mi empresa' },
  { label: 'Libro de reclamaciones', to: '/company/complaints', icon: <BookOpen {...iconProps} />, permissions: ['companies.update'], section: 'Mi empresa' },
];

export const ADMIN_NAV: NavItem[] = [
  { label: 'Dashboard', to: '/admin/dashboard', icon: <Gauge {...iconProps} />, section: 'Gestión principal' },
  { label: 'Usuarios', to: '/admin/users', icon: <Users {...iconProps} />, permissions: ['users.view'], section: 'Gestión principal' },
  { label: 'Roles y permisos', to: '/admin/roles', icon: <ShieldCheck {...iconProps} />, permissions: ['roles.view'], section: 'Gestión principal' },
  { label: 'Empresas', to: '/admin/companies', icon: <Building2 {...iconProps} />, permissions: ['companies.view'], section: 'Gestión principal' },
  { label: 'Verificación de empresas', to: '/admin/company-documents', icon: <BadgeCheck {...iconProps} />, permissions: ['companies.update'], section: 'Gestión principal' },
  { label: 'Buses', to: '/admin/buses', icon: <Bus {...iconProps} />, permissions: ['buses.view'], section: 'Gestión principal' },
  { label: 'Tipos de bus', to: '/admin/bus-types', icon: <Bus {...iconProps} />, permissions: ['buses.view'], section: 'Gestión principal' },
  { label: 'Tipos de asiento', to: '/admin/seat-types', icon: <Armchair {...iconProps} />, permissions: ['buses.view'], section: 'Gestión principal' },
  { label: 'Ciudades y terminales', to: '/admin/locations', icon: <MapPin {...iconProps} />, permissions: ['routes.view'], section: 'Gestión principal' },
  { label: 'Rutas', to: '/admin/routes', icon: <RouteIcon {...iconProps} />, permissions: ['routes.view'], section: 'Gestión principal' },
  { label: 'Viajes', to: '/admin/trips', icon: <CalendarClock {...iconProps} />, permissions: ['trips.view'], section: 'Gestión principal' },
  { label: 'Reservas', to: '/admin/bookings', icon: <Ticket {...iconProps} />, permissions: ['bookings.view'], section: 'Gestión principal' },
  { label: 'Pagos', to: '/admin/payments', icon: <CreditCard {...iconProps} />, permissions: ['payments.view'], section: 'Gestión principal' },
  { label: 'Reembolsos', to: '/admin/refunds', icon: <RotateCcw {...iconProps} />, permissions: ['payments.view'], section: 'Gestión principal' },
  { label: 'Comisiones', to: '/admin/commissions', icon: <Percent {...iconProps} />, permissions: ['reports.view'], section: 'Gestión principal' },
  { label: 'Liquidaciones', to: '/admin/settlements', icon: <Wallet {...iconProps} />, permissions: ['reports.view'], section: 'Gestión principal' },
  { label: 'Finanzas', to: '/admin/financial', icon: <Receipt {...iconProps} />, permissions: ['reports.view'], section: 'Gestión principal' },

  { label: 'Destinos', to: '/admin/destinations', icon: <MapPinned {...iconProps} />, permissions: ['settings.view'], section: 'Contenido' },
  { label: 'Perfiles públicos', to: '/admin/company-profiles', icon: <Store {...iconProps} />, permissions: ['companies.update'], section: 'Contenido' },
  { label: 'Libro de reclamaciones', to: '/admin/complaints', icon: <BookOpen {...iconProps} />, permissions: ['settings.view'], section: 'Contenido' },

  { label: 'Reportes', to: '/admin/reports', icon: <FileText {...iconProps} />, permissions: ['reports.view'], section: 'Configuración' },
  { label: 'Promociones', to: '/admin/promotions', icon: <Megaphone {...iconProps} />, permissions: ['promotions.view'], section: 'Configuración' },
  { label: 'Cupones', to: '/admin/coupons', icon: <TicketCheck {...iconProps} />, permissions: ['promotions.view'], section: 'Configuración' },
  { label: 'Reseñas', to: '/admin/reviews', icon: <Star {...iconProps} />, permissions: ['reviews.view'], section: 'Configuración' },
  { label: 'Notificaciones', to: '/admin/notifications', icon: <Bell {...iconProps} />, section: 'Configuración' },
  { label: 'Soporte y reclamos', to: '/admin/support', icon: <Headphones {...iconProps} />, section: 'Configuración' },
  { label: 'Auditoría', to: '/admin/audit', icon: <ScrollText {...iconProps} />, permissions: ['audit_logs.view'], section: 'Configuración' },
  { label: 'Integraciones', to: '/admin/integrations', icon: <Plug {...iconProps} />, permissions: ['companies.update'], section: 'Configuración' },
  { label: 'API keys', to: '/admin/api-keys', icon: <KeyRound {...iconProps} />, permissions: ['settings.view'], section: 'Configuración' },
  { label: 'Configuración', to: '/admin/settings', icon: <Settings {...iconProps} />, permissions: ['settings.view'], section: 'Configuración' },
  { label: 'Identidad visual', to: '/admin/branding', icon: <Palette {...iconProps} />, permissions: ['settings.view'], section: 'Configuración' },
];

/**
 * Union of the customer sidebars in mockups 7 and 11. Entries the schema cannot back yet
 * (saved cards, addresses, coupon wallet) stay visible but disabled, as agreed.
 * "Datos personales" (mockup 7) and "Mi perfil" (mockup 11) are the same screen, so they
 * appear once to avoid two identical links.
 */
export const CUSTOMER_NAV: NavItem[] = [
  { label: 'Mi perfil', to: '/customer/profile', icon: <UserRound {...iconProps} /> },
  { label: 'Mis viajes', to: '/customer/trips', icon: <Ticket {...iconProps} /> },
  { label: 'Mis reservas', to: '/customer/bookings', icon: <TicketCheck {...iconProps} /> },
  { label: 'Métodos de pago', to: '/customer/payment-methods', icon: <CreditCard {...iconProps} />, disabled: true },
  { label: 'Direcciones', to: '/customer/addresses', icon: <MapPin {...iconProps} />, disabled: true },
  { label: 'Cupones y descuentos', to: '/customer/coupons', icon: <Percent {...iconProps} />, disabled: true },
  { label: 'Notificaciones', to: '/customer/notifications', icon: <Bell {...iconProps} /> },
  { label: 'Seguridad', to: '/customer/profile#seguridad', icon: <ShieldCheck {...iconProps} /> },
  { label: 'Ayuda y soporte', to: '/customer/support', icon: <Headphones {...iconProps} /> },
];

/** Hiding an item is a UX affordance only; the API enforces the same permissions. */
export function visibleNav(items: NavItem[], hasPermission: (...permissions: string[]) => boolean): NavItem[] {
  return items.filter((item) => !item.permissions || item.permissions.length === 0 || hasPermission(...item.permissions));
}
