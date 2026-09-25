export type UserStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'PENDING';
export type ActiveStatus = 'ACTIVE' | 'INACTIVE';
export type CompanyStatus = 'PENDING' | 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'REJECTED';
export type BusStatus = 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE';
export type TripStatus = 'SCHEDULED' | 'BOARDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'DELAYED';
export type BookingStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'EXPIRED';
export type PaymentMethod = 'CARD' | 'YAPE' | 'PLIN' | 'TRANSFER' | 'CASH' | 'OTHER';
export type PaymentStatus = 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED' | 'CANCELLED' | 'REFUNDED';
export type RefundStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'WAITING_USER' | 'RESOLVED' | 'CLOSED';
export type RoleName = 'ADMIN' | 'COMPANY_ADMIN' | 'OPERATOR' | 'CUSTOMER';

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  pagination?: Pagination;
}

export interface AuthUser {
  id: number;
  role_id: number;
  role: RoleName;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  avatar_url: string | null;
  status: UserStatus;
  email_verified_at: string | null;
  last_login_at: string | null;
  created_at: string;
  permissions: string[];
  companyIds: number[];
}

export interface Company {
  id: number;
  name: string;
  legal_name: string | null;
  tax_id: string | null;
  email: string | null;
  phone: string | null;
  logo_url: string | null;
  description: string | null;
  status: CompanyStatus;
  buses_count?: number;
  routes_count?: number;
  created_at: string;
}

export interface Bus {
  id: number;
  company_id: number;
  bus_type_id: number | null;
  code: string;
  plate_number: string;
  brand: string | null;
  model: string | null;
  year: number | null;
  capacity: number;
  amenities: string | null;
  status: BusStatus;
  bus_type_name?: string | null;
  company_name?: string;
  seats_count?: number;
}

/* --------------------------------------------- distribución física del bus (migración 010) */

/** Una VERSIÓN de la distribución. Los viajes se anclan a una y ya no cambia. */
export interface BusLayout {
  id: number;
  bus_id: number;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  name: string | null;
  seat_count: number;
  published_at: string | null;
}

export interface BusLayoutDeck {
  id: number;
  layout_id: number;
  deck_number: number;
  name: string | null;
  row_count: number;
  column_count: number;
}

export type LayoutElementType = 'BATHROOM' | 'STAIRS' | 'DRIVER' | 'DOOR' | 'EMPTY';

/** Lo que ocupa una casilla y NO se vende: baño, escalera, conductor, puerta, hueco. */
export interface BusLayoutElement {
  id: number;
  deck_id: number;
  element_type: LayoutElementType;
  row_number: number;
  column_number: number;
  row_span: number;
  col_span: number;
  label: string | null;
}

export interface LayoutSeat {
  id: number;
  deck_id: number | null;
  seat_type_id: number | null;
  seat_type_name: string | null;
  seat_number: string;
  row_number: number | null;
  column_number: number | null;
  is_window: 0 | 1;
  is_aisle: 0 | 1;
  status: 'AVAILABLE' | 'INACTIVE';
}

/** La versión entera, tal como la devuelve `GET /layouts/:id`. */
export interface LayoutTree {
  layout: BusLayout;
  decks: BusLayoutDeck[];
  elements: BusLayoutElement[];
  seats: LayoutSeat[];
}

export interface Driver {
  id: number;
  company_id: number;
  first_name: string;
  last_name: string;
  document_number: string;
  license_number: string;
  license_expires_at: string | null;
  phone: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: string;
  /** Viajes en los que figura como conductor o copiloto. Lo calcula la API. */
  trips_count?: number;
}

export type IntegrationCategory = 'PAYMENT_GATEWAY' | 'INVOICING' | 'ANALYTICS' | 'MESSAGING' | 'OTHER';
export type IntegrationStatus = 'CONNECTED' | 'DISCONNECTED' | 'NEEDS_CONFIG';

/**
 * Integración por empresa (mockup 37). Las credenciales NUNCA llegan completas: la API
 * publica qué campos están puestos y sus cuatro últimos caracteres.
 */
export interface Integration {
  provider: string;
  label: string;
  category: IntegrationCategory;
  description: string;
  status: IntegrationStatus;
  connected_at: string | null;
  fields: Array<{ name: string; label: string; secret: boolean; required: boolean }>;
  configured_fields: string[];
  missing_fields: string[];
  credentials_preview: Record<string, string | null>;
  /** Recordatorio del backend: configurar no es operar. */
  processing_active: false;
}

export interface IntegrationList {
  encryption_configured: boolean;
  integrations: Integration[];
}

export type CompanyDocumentType = 'RUC' | 'LICENSE' | 'INSURANCE' | 'LEGAL_REP_ID' | 'OTHER';
export type CompanyDocumentStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';

/**
 * Documento de verificación de empresa. La API nunca devuelve la ruta del archivo: solo
 * `has_file`, y el contenido se descarga por un endpoint que valida sesión y empresa.
 */
export interface CompanyDocument {
  id: number;
  company_id: number;
  company_name: string;
  type: CompanyDocumentType;
  status: CompanyDocumentStatus;
  has_file: boolean;
  reviewed_by: number | null;
  reviewer_name: string | null;
  reviewed_at: string | null;
  /** Motivo del rechazo cuando el estado es REJECTED. */
  notes: string | null;
  created_at: string;
}

export interface VerificationStage {
  key: string;
  label: string;
  description: string;
  status: 'DONE' | 'IN_PROGRESS' | 'PENDING' | 'BLOCKED';
}

export interface VerificationStatus {
  company: { id: number; name: string; status: string; created_at: string };
  documents: { total: number; pending: number; verified: number; rejected: number };
  stages: VerificationStage[];
}

export interface BankAccount {
  id: number;
  company_id: number;
  bank_name: string;
  account_type: 'CHECKING' | 'SAVINGS';
  currency: string;
  /** Solo llega completo a quien puede editar la cuenta; si no, es null. */
  account_number: string | null;
  interbank_code: string | null;
  account_number_masked: string | null;
  interbank_code_masked: string | null;
  masked: boolean;
  holder_name: string;
  holder_document: string | null;
  is_primary: 0 | 1;
  status: 'PENDING' | 'VERIFIED' | 'REJECTED';
  created_at: string;
  updated_at: string;
}

export interface BusType {
  id: number;
  name: string;
  description: string | null;
  default_capacity: number | null;
  status: ActiveStatus;
}

export interface SeatType {
  id: number;
  name: string;
  description: string | null;
}

export interface Seat {
  id: number;
  bus_id: number;
  seat_type_id: number | null;
  seat_number: string;
  row_number: number | null;
  column_number: number | null;
  is_window: 0 | 1;
  is_aisle: 0 | 1;
  status: 'AVAILABLE' | 'INACTIVE';
  seat_type_name?: string | null;
}

/**
 * Asiento tal como lo devuelve `GET /public/trips/:id/seats`.
 *
 * `price` es el precio de ESE asiento en ESE viaje —`trip_seat_type_prices` si hay fila,
 * `trips.base_price` si no—, ya resuelto por el backend. Llega como cadena porque es un
 * DECIMAL: conviértelo con `Number` al sumar, nunca lo recalcules.
 */
export interface SeatAvailability extends Seat {
  is_taken: 0 | 1;
  price: string;
  deck_id: number | null;
  deck_number: number | null;
}

/** Piso de la geometría pública: la rejilla declarada y lo que no se vende. */
export interface TripLayoutDeck {
  id: number;
  deck_number: number;
  name: string | null;
  row_count: number;
  column_count: number;
  elements: Array<Omit<BusLayoutElement, 'deck_id'>>;
}

/**
 * Forma del bus del viaje, de `GET /public/trips/:id/layout`. Es la versión CONGELADA del
 * viaje, así que un viaje vendido sobre la v1 se sigue dibujando con la v1. No trae asientos
 * ni precios: eso vive en el mapa de asientos, y están separados a propósito.
 */
export interface TripLayout {
  layout_id: number;
  version: number;
  status: BusLayout['status'];
  name: string | null;
  decks: TripLayoutDeck[];
}

export interface Location {
  id: number;
  name: string;
  city: string;
  province: string | null;
  department: string | null;
  country_code: string;
  latitude: number | null;
  longitude: number | null;
  type: 'CITY' | 'TERMINAL' | 'AGENCY' | 'OTHER';
  address: string | null;
  status: ActiveStatus;
}

export interface Route {
  id: number;
  company_id: number;
  origin_location_id: number;
  destination_location_id: number;
  name: string | null;
  distance_km: number | null;
  estimated_duration_minutes: number | null;
  status: ActiveStatus;
  origin_name?: string;
  origin_city?: string;
  destination_name?: string;
  destination_city?: string;
  company_name?: string;
  trips_count?: number;
  stops_count?: number;
}

export interface Trip {
  driver_id?: number | null;
  co_driver_id?: number | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  co_driver_name?: string | null;
  co_driver_phone?: string | null;
  id: number;
  route_id: number;
  bus_id: number;
  departure_datetime: string;
  arrival_datetime: string | null;
  base_price: number;
  available_seats: number | null;
  status: TripStatus;
  boarding_notes: string | null;
  company_id?: number;
  company_name?: string;
  origin_city?: string;
  origin_terminal?: string;
  destination_city?: string;
  destination_terminal?: string;
  bus_code?: string;
  plate_number?: string;
  capacity?: number;
  bus_type_name?: string | null;
  distance_km?: number | null;
  estimated_duration_minutes?: number | null;
  bookings_count?: number;
  seats_sold?: number;
  revenue?: number;
}

/**
 * Viaje tal y como lo publica la búsqueda pública.
 *
 * La disponibilidad es `seats_available`, que el backend calcula a partir de los asientos
 * realmente ocupados. `available_seats` se excluye a propósito (BP-15): es la columna
 * denormalizada de `trips`, no viaja en esta respuesta y usarla aquí daba un número que
 * podía no coincidir con el del buscador.
 */
export interface PublicTrip extends Omit<Trip, 'available_seats'> {
  seats_available: number;
  company_logo: string | null;
  company_rating: number | null;
  company_reviews: number;
  amenities: string | null;
}

/**
 * Un tramo de la búsqueda de itinerarios. Sus viajes son `PublicTrip`: el backend resuelve cada
 * tramo con la misma `searchTrips` que la búsqueda de ida, así que la forma es idéntica.
 */
export interface ItinerarySegmentResults {
  segment_order: number;
  origin: string;
  destination: string;
  date: string;
  trips: PublicTrip[];
  total: number;
}

export interface Booking {
  id: number;
  booking_code: string;
  /** Compra de varios tramos. Ausente o null en una compra de ida simple. */
  group_id?: number | null;
  group_code?: string | null;
  trip_type?: 'ROUND_TRIP' | 'MULTI_CITY' | null;
  segment_order?: number;
  group_segments?: number;
  user_id: number;
  trip_id: number;
  passenger_count: number;
  subtotal: number;
  discount_amount: number;
  service_fee: number;
  total_amount: number;
  status: BookingStatus;
  passenger_name: string | null;
  passenger_document: string | null;
  passenger_phone: string | null;
  passenger_email: string | null;
  notes: string | null;
  expires_at: string | null;
  confirmed_at: string | null;
  created_at: string;
  departure_datetime?: string;
  arrival_datetime?: string | null;
  origin_city?: string;
  origin_terminal?: string;
  destination_city?: string;
  destination_terminal?: string;
  company_name?: string;
  /** Referencia del logotipo de la empresa en el almacén público (F17C-UI-13). */
  company_logo?: string | null;
  bus_code?: string;
  bus_type_name?: string | null;
  seat_numbers?: string | null;
  payment_status?: PaymentStatus | null;
  payment_method?: PaymentMethod | null;
  first_name?: string;
  last_name?: string;
  user_email?: string;
  seats?: BookingSeat[];
  payments?: Payment[];
}

export interface BookingSeat {
  id: number;
  booking_id: number;
  seat_id: number;
  price: number;
  passenger_name: string | null;
  passenger_document: string | null;
  seat_number: string;
  seat_type_name?: string | null;
}

export interface Payment {
  id: number;
  booking_id: number;
  transaction_code: string | null;
  amount: number;
  currency: string;
  method: PaymentMethod;
  status: PaymentStatus;
  provider: string | null;
  paid_at: string | null;
  created_at: string;
  booking_code?: string;
  passenger_name?: string | null;
  company_name?: string;
  origin_city?: string;
  destination_city?: string;
}

export interface Refund {
  id: number;
  payment_id: number;
  booking_id: number;
  amount: number;
  reason: string | null;
  status: RefundStatus;
  processed_at: string | null;
  created_at: string;
  booking_code?: string;
  passenger_name?: string | null;
  company_name?: string;
  user_email?: string;
  origin_city?: string;
  destination_city?: string;
  departure_datetime?: string;
}

export interface Role {
  id: number;
  name: string;
  description: string | null;
  status: ActiveStatus;
  users_count?: number;
  permissions_count?: number;
  permissions?: Permission[];
}

export interface Permission {
  id: number;
  name: string;
  module: string;
  description: string | null;
}

export interface UserRow {
  id: number;
  role_id: number;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  avatar_url: string | null;
  status: UserStatus;
  last_login_at: string | null;
  created_at: string;
  role_name: RoleName;
  company_id: number | null;
  company_name: string | null;
  position: string | null;
  bookings_count?: number;
}

export interface Notification {
  id: number;
  title: string;
  message: string;
  type: 'EMAIL' | 'PUSH' | 'SMS' | 'IN_APP';
  is_read: 0 | 1;
  read_at: string | null;
  created_at: string;
}

export interface SupportTicket {
  id: number;
  ticket_code: string;
  user_id: number;
  subject: string;
  category: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  status: TicketStatus;
  created_at: string;
  updated_at: string;
  first_name?: string;
  last_name?: string;
  user_email?: string;
  company_name?: string | null;
  messages_count?: number;
  last_message_at?: string | null;
  messages?: SupportMessage[];
}

export interface SupportMessage {
  id: number;
  ticket_id: number;
  user_id: number;
  message: string;
  is_internal: 0 | 1;
  created_at: string;
  first_name?: string;
  last_name?: string;
  role_name?: RoleName;
}

export interface Settlement {
  id: number;
  company_id: number;
  settlement_code: string;
  period_start: string;
  period_end: string;
  gross_amount: number;
  commission_amount: number;
  refund_amount: number;
  adjustment_amount: number;
  net_amount: number;
  status: 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED' | 'CANCELLED';
  paid_at: string | null;
  created_at: string;
  company_name?: string;
  items_count?: number;
  items?: SettlementItem[];
}

export interface SettlementItem {
  id: number;
  type: 'SALE' | 'COMMISSION' | 'REFUND' | 'ADJUSTMENT';
  amount: number;
  description: string | null;
  booking_code?: string | null;
}

export interface AuditLog {
  id: number;
  user_id: number | null;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  description: string | null;
  old_values: string | null;
  new_values: string | null;
  ip_address: string | null;
  created_at: string;
  first_name?: string | null;
  last_name?: string | null;
  user_email?: string | null;
  role_name?: string | null;
}

export interface Promotion {
  id: number;
  company_id: number | null;
  name: string;
  description: string | null;
  discount_type: 'PERCENTAGE' | 'FIXED_AMOUNT';
  discount_value: number;
  minimum_amount: number | null;
  maximum_discount: number | null;
  start_at: string;
  end_at: string;
  usage_limit: number | null;
  usage_count: number;
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'EXPIRED';
  company_name?: string | null;
  coupons_count?: number;
}

export interface Coupon {
  id: number;
  promotion_id: number;
  code: string;
  usage_limit: number | null;
  usage_count: number;
  per_user_limit: number | null;
  status: 'ACTIVE' | 'INACTIVE' | 'EXPIRED';
  promotion_name?: string;
  discount_type?: 'PERCENTAGE' | 'FIXED_AMOUNT';
  discount_value?: number;
}

export interface Review {
  id: number;
  user_id: number;
  company_id: number;
  rating: number;
  title: string | null;
  comment: string | null;
  status: 'PENDING' | 'PUBLISHED' | 'HIDDEN' | 'REJECTED';
  created_at: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  booking_code?: string;
  origin_city?: string;
  destination_city?: string;
  responses_count?: number;
  responses?: Array<{ id: number; response: string; created_at: string; first_name: string; last_name: string }>;
}

export interface SystemSetting {
  id: number;
  setting_key: string;
  setting_value: string | null;
  setting_type: 'STRING' | 'INTEGER' | 'DECIMAL' | 'BOOLEAN' | 'JSON';
  description: string | null;
  is_public: 0 | 1;
  updated_at: string;
}

export interface ApiKey {
  id: number;
  company_id: number | null;
  name: string;
  key_prefix: string;
  environment: 'TEST' | 'PRODUCTION';
  last_used_at: string | null;
  expires_at: string | null;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  created_at: string;
  company_name?: string | null;
  plain_key?: string;
}

/* ------------------------------------------------------------------ FASE 17 · contenido de destinos */

export type ContentStatus = 'ACTIVE' | 'INACTIVE';

export interface Destination {
  id: number;
  name: string;
  slug: string;
  subtitle: string | null;
  description: string | null;
  price_from: string | number | null;
  hero_image: string | null;
  /** FASE 17B · imagen de la sección «Calendario festivo». */
  festivities_image: string | null;
  address: string | null;
  ticket_schedule: string | null;
  package_schedule: string | null;
  travel_duration: string | null;
  temperature: string | null;
  altitude_masl: number | null;
  time_from_lima: string | null;
  /** Ciudad real de `locations`; el nombre llega resuelto por la API. */
  location_id: number | null;
  origin_location_id: number | null;
  location_city?: string | null;
  origin_city?: string | null;
  status: ContentStatus;
  display_order: number;
  attractions_count?: number;
  festivities_count?: number;
  created_at: string;
  updated_at: string;
}

export interface DestinationAttraction {
  id: number;
  destination_id: number;
  name: string;
  description: string | null;
  image: string | null;
  display_order: number;
  status: ContentStatus;
}

export interface DestinationFestivity {
  id: number;
  destination_id: number;
  name: string;
  date_label: string;
  description: string | null;
  display_order: number;
  status: ContentStatus;
}

/** Tarjeta de «Descubre más destinos». */
/** Logotipo de una empresa. `logo_url` es una referencia del almacén público, no una URL. */
export interface CompanyLogo {
  company_id: number;
  logo_url: string | null;
}

export type PublicDestinationCard = Pick<Destination, 'id' | 'name' | 'slug' | 'subtitle' | 'price_from' | 'hero_image' | 'display_order'>;

export interface PublicDestinationDetail
  extends Pick<
    Destination,
    | 'id' | 'name' | 'slug' | 'subtitle' | 'description' | 'price_from' | 'hero_image' | 'festivities_image'
    | 'address' | 'ticket_schedule' | 'package_schedule' | 'travel_duration' | 'temperature' | 'altitude_masl' | 'time_from_lima'
  > {
  /** Ciudad del destino y ciudad de origen sugerida, ya resueltas (o `null` si no hay). */
  city: string | null;
  origin_city: string | null;
  attractions: Array<Pick<DestinationAttraction, 'id' | 'name' | 'description' | 'image'>>;
  festivities: Array<Pick<DestinationFestivity, 'id' | 'name' | 'date_label' | 'description'>>;
}

export type BrandingAsset = 'logo' | 'favicon' | 'logo_mobile' | 'og_image';
export type BrandingReferences = Record<BrandingAsset, string | null>;
