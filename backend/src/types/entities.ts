/**
 * Entity types mirror Dump20260831.sql exactly: same column names, same ENUM values.
 * Do not add fields here that the schema does not have.
 */

export type UserStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'PENDING';
export type ActiveStatus = 'ACTIVE' | 'INACTIVE';
export type CompanyStatus = 'PENDING' | 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'REJECTED';
export type BusStatus = 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE';
export type SeatStatus = 'AVAILABLE' | 'INACTIVE';
export type LocationType = 'CITY' | 'TERMINAL' | 'AGENCY' | 'OTHER';
export type TripStatus = 'SCHEDULED' | 'BOARDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'DELAYED';
export type BookingStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'EXPIRED';
export type PaymentMethod = 'CARD' | 'YAPE' | 'PLIN' | 'TRANSFER' | 'CASH' | 'OTHER';
export type PaymentStatus = 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED' | 'CANCELLED' | 'REFUNDED';
export type RefundStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type PromotionStatus = 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'EXPIRED';
export type CouponStatus = 'ACTIVE' | 'INACTIVE' | 'EXPIRED';
export type ReviewStatus = 'PENDING' | 'PUBLISHED' | 'HIDDEN' | 'REJECTED';
export type NotificationType = 'EMAIL' | 'PUSH' | 'SMS' | 'IN_APP';
export type NotificationStatus = 'PENDING' | 'SENT' | 'FAILED' | 'READ';
export type TicketCategory = 'BOOKING' | 'PAYMENT' | 'REFUND' | 'TRAVEL' | 'ACCOUNT' | 'TECHNICAL' | 'OTHER';
export type TicketPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'WAITING_USER' | 'RESOLVED' | 'CLOSED';
export type TransactionType = 'PAYMENT' | 'REFUND' | 'COMMISSION' | 'PAYOUT' | 'ADJUSTMENT';
export type TransactionDirection = 'CREDIT' | 'DEBIT';
export type TransactionStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type SettlementStatus = 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED' | 'CANCELLED';
export type SettlementItemType = 'SALE' | 'COMMISSION' | 'REFUND' | 'ADJUSTMENT';
export type CommissionType = 'PERCENTAGE' | 'FIXED';
export type DiscountType = 'PERCENTAGE' | 'FIXED_AMOUNT';
export type SettingType = 'STRING' | 'INTEGER' | 'DECIMAL' | 'BOOLEAN' | 'JSON';
export type ApiKeyEnvironment = 'TEST' | 'PRODUCTION';
export type ApiKeyStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

export const ROLE = {
  ADMIN: 'ADMIN',
  COMPANY_ADMIN: 'COMPANY_ADMIN',
  OPERATOR: 'OPERATOR',
  CUSTOMER: 'CUSTOMER',
} as const;

export type RoleName = (typeof ROLE)[keyof typeof ROLE];

export interface Role {
  id: number;
  name: RoleName;
  description: string | null;
  status: ActiveStatus;
  created_at: string;
  updated_at: string;
}

export interface Permission {
  id: number;
  name: string;
  module: string;
  description: string | null;
  created_at: string;
}

/** users row without password_hash — password_hash must never leave the repository layer. */
export interface User {
  id: number;
  role_id: number;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  avatar_url: string | null;
  status: UserStatus;
  email_verified_at: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
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
  created_at: string;
  updated_at: string;
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
  created_at: string;
  updated_at: string;
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
  status: SeatStatus;
  created_at: string;
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
  type: LocationType;
  address: string | null;
  status: ActiveStatus;
  created_at: string;
  updated_at: string;
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
  created_at: string;
  updated_at: string;
}

export interface Trip {
  id: number;
  route_id: number;
  bus_id: number;
  departure_datetime: string;
  arrival_datetime: string | null;
  base_price: number;
  available_seats: number | null;
  status: TripStatus;
  boarding_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Booking {
  id: number;
  booking_code: string;
  user_id: number;
  trip_id: number;
  origin_stop_id: number | null;
  destination_stop_id: number | null;
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
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
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
  provider_transaction_id: string | null;
  payment_data: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuthenticatedUser extends User {
  role: RoleName;
  permissions: string[];
  companyIds: number[];
}
