import { z } from 'zod';
import { activeStatus, id, jsonColumn, money, optionalId, optionalText, shortText, toUpdateSchema } from './common';

/* ------------------------------------------------------------------ companies */
/**
 * Entrada del CRUD de empresas. NO incluye `logo_url` (F17C-CLEAN-01): desde
 * F17C-COMPANY-LOGO-01-A esa columna solo la escribe `POST/DELETE /company/logo`, y aceptarla aquí
 * para descartarla después hacía que la API aparentase admitir un campo que no es editable.
 *
 * Esto es el esquema de ESCRITURA. La lectura no cambia: las respuestas siguen devolviendo
 * `logo_url` donde corresponde (`/public/companies`, viajes, reservas, `/company/logo`).
 */
export const companyShape = {
  name: shortText(150),
  legal_name: optionalText(200),
  tax_id: z.string().trim().regex(/^\d{11}$/, 'El RUC debe tener 11 dígitos').nullable().optional(),
  email: z.string().email('Correo inválido').max(150).nullable().optional(),
  phone: optionalText(30),
  description: optionalText(5000),
  status: z.enum(['PENDING', 'ACTIVE', 'INACTIVE', 'SUSPENDED', 'REJECTED']).optional(),
};
export const createCompanySchema = z.object(companyShape);
export const updateCompanySchema = toUpdateSchema(companyShape);

/* ------------------------------------------------------------------ bus types */
export const busTypeShape = {
  name: shortText(100),
  description: optionalText(255),
  default_capacity: z.coerce.number().int().min(1).max(120).nullable().optional(),
  status: activeStatus.optional(),
};
export const createBusTypeSchema = z.object(busTypeShape);
export const updateBusTypeSchema = toUpdateSchema(busTypeShape);

/* ------------------------------------------------------------------ buses */
export const busShape = {
  company_id: optionalId,
  bus_type_id: optionalId,
  code: shortText(50),
  plate_number: z.string().trim().min(6, 'Placa inválida').max(20),
  brand: optionalText(100),
  model: optionalText(100),
  year: z.coerce.number().int().min(1950).max(2100).nullable().optional(),
  capacity: z.coerce.number().int().min(1, 'La capacidad debe ser mayor a 0').max(120),
  amenities: jsonColumn,
  status: z.enum(['ACTIVE', 'INACTIVE', 'MAINTENANCE']).optional(),
};
export const createBusSchema = z.object(busShape);
export const updateBusSchema = toUpdateSchema(busShape);

/* ------------------------------------------------------------------ seat types */
export const seatTypeShape = {
  name: shortText(50),
  description: optionalText(255),
};
export const createSeatTypeSchema = z.object(seatTypeShape);
export const updateSeatTypeSchema = toUpdateSchema(seatTypeShape);

/* ------------------------------------------------------------------ seats */
export const seatShape = {
  bus_id: id,
  seat_type_id: optionalId,
  seat_number: shortText(10),
  row_number: z.coerce.number().int().min(1).max(60).nullable().optional(),
  column_number: z.coerce.number().int().min(1).max(10).nullable().optional(),
  is_window: z.coerce.boolean().transform((value) => (value ? 1 : 0)).optional(),
  is_aisle: z.coerce.boolean().transform((value) => (value ? 1 : 0)).optional(),
  status: z.enum(['AVAILABLE', 'INACTIVE']).optional(),
};
export const createSeatSchema = z.object(seatShape);
export const updateSeatSchema = toUpdateSchema(seatShape);

/* ------------------------------------------------------------------ locations */
export const locationShape = {
  name: shortText(150),
  city: shortText(150),
  province: optionalText(150),
  department: optionalText(150),
  country_code: z.string().trim().length(2).default('PE').optional(),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
  type: z.enum(['CITY', 'TERMINAL', 'AGENCY', 'OTHER']).optional(),
  address: optionalText(255),
  status: activeStatus.optional(),
};
export const createLocationSchema = z.object(locationShape);
export const updateLocationSchema = toUpdateSchema(locationShape);

/* ------------------------------------------------------------------ routes */
export const routeShape = {
  company_id: optionalId,
  origin_location_id: id,
  destination_location_id: id,
  name: optionalText(200),
  distance_km: z.coerce.number().min(0).max(10000).nullable().optional(),
  estimated_duration_minutes: z.coerce.number().int().min(0).max(10080).nullable().optional(),
  status: activeStatus.optional(),
};
export const createRouteSchema = z
  .object(routeShape)
  .refine((value) => value.origin_location_id !== value.destination_location_id, {
    message: 'El origen y el destino deben ser diferentes',
    path: ['destination_location_id'],
  });
export const updateRouteSchema = toUpdateSchema(routeShape);

/* ------------------------------------------------------------------ route stops */
export const routeStopShape = {
  route_id: id,
  location_id: id,
  stop_order: z.coerce.number().int().min(1).max(100),
  arrival_offset_minutes: z.coerce.number().int().min(0).nullable().optional(),
  departure_offset_minutes: z.coerce.number().int().min(0).nullable().optional(),
};
export const createRouteStopSchema = z.object(routeStopShape);
export const updateRouteStopSchema = toUpdateSchema(routeStopShape);

/* ------------------------------------------------------------------ trips */
export const tripShape = {
  route_id: id,
  bus_id: id,
  // Tripulación del viaje (mockup 31). Nullable: un viaje puede no tenerla asignada aún.
  driver_id: optionalId,
  co_driver_id: optionalId,
  departure_datetime: z.string().min(1, 'La fecha y hora de salida es obligatoria'),
  arrival_datetime: z.string().nullable().optional(),
  base_price: money,
  available_seats: z.coerce.number().int().min(0).max(120).nullable().optional(),
  status: z.enum(['SCHEDULED', 'BOARDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DELAYED']).optional(),
  boarding_notes: optionalText(500),
};
export const createTripSchema = z.object(tripShape);
export const updateTripSchema = toUpdateSchema(tripShape);

/* ------------------------------------------------------------------ payments */
export const paymentShape = {
  booking_id: id,
  transaction_code: optionalText(100),
  amount: money,
  currency: z.string().trim().length(3).default('PEN').optional(),
  method: z.enum(['CARD', 'YAPE', 'PLIN', 'TRANSFER', 'CASH', 'OTHER']),
  status: z.enum(['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED']).optional(),
  provider: optionalText(100),
  provider_transaction_id: optionalText(150),
  paid_at: z.string().nullable().optional(),
};
export const createPaymentSchema = z.object(paymentShape);
export const updatePaymentSchema = toUpdateSchema(paymentShape);

/* ------------------------------------------------------------------ refunds */
export const refundShape = {
  payment_id: id,
  booking_id: id,
  amount: money,
  reason: optionalText(500),
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
  provider_refund_id: optionalText(150),
  processed_at: z.string().nullable().optional(),
};
export const createRefundSchema = z.object(refundShape);
export const updateRefundSchema = toUpdateSchema(refundShape);

/* ------------------------------------------------------------------ promotions */
export const promotionShape = {
  company_id: optionalId,
  name: shortText(150),
  description: optionalText(500),
  discount_type: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']),
  discount_value: money,
  minimum_amount: z.coerce.number().min(0).nullable().optional(),
  maximum_discount: z.coerce.number().min(0).nullable().optional(),
  start_at: z.string().min(1, 'Fecha de inicio requerida'),
  end_at: z.string().min(1, 'Fecha de fin requerida'),
  usage_limit: z.coerce.number().int().min(1).nullable().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE', 'EXPIRED']).optional(),
};
export const createPromotionSchema = z.object(promotionShape).refine((value) => value.end_at > value.start_at, {
  message: 'La fecha de fin debe ser posterior a la de inicio',
  path: ['end_at'],
});
export const updatePromotionSchema = toUpdateSchema(promotionShape);

/* ------------------------------------------------------------------ coupons */
export const couponShape = {
  promotion_id: id,
  code: z.string().trim().min(3).max(50).transform((value) => value.toUpperCase()),
  usage_limit: z.coerce.number().int().min(1).nullable().optional(),
  per_user_limit: z.coerce.number().int().min(1).nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'EXPIRED']).optional(),
};
export const createCouponSchema = z.object(couponShape);
export const updateCouponSchema = toUpdateSchema(couponShape);

/* ------------------------------------------------------------------ reviews */
export const reviewShape = {
  booking_id: id,
  // Se aceptan por compatibilidad con el cliente, pero el servidor los deriva de la reserva.
  trip_id: optionalId,
  company_id: optionalId,
  rating: z.coerce.number().int().min(1, 'La calificación mínima es 1').max(5, 'La calificación máxima es 5'),
  title: optionalText(150),
  comment: optionalText(5000),
  status: z.enum(['PENDING', 'PUBLISHED', 'HIDDEN', 'REJECTED']).optional(),
};
export const createReviewSchema = z.object(reviewShape);
export const updateReviewSchema = toUpdateSchema(reviewShape);

export const reviewResponseSchema = z.object({
  review_id: id,
  response: shortText(5000),
});

/* ------------------------------------------------------------------ notification templates */
export const notificationTemplateShape = {
  name: shortText(100),
  type: z.enum(['EMAIL', 'PUSH', 'SMS', 'IN_APP']),
  subject: optionalText(255),
  title: optionalText(255),
  body: shortText(20000),
  variables: jsonColumn,
  status: activeStatus.optional(),
};
export const createNotificationTemplateSchema = z.object(notificationTemplateShape);
export const updateNotificationTemplateSchema = toUpdateSchema(notificationTemplateShape);

/* ------------------------------------------------------------------ support */
export const createTicketSchema = z.object({
  booking_id: optionalId,
  company_id: optionalId,
  subject: shortText(255),
  category: z.enum(['BOOKING', 'PAYMENT', 'REFUND', 'TRAVEL', 'ACCOUNT', 'TECHNICAL', 'OTHER']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  message: shortText(10000),
});

export const updateTicketSchema = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_USER', 'RESOLVED', 'CLOSED']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  assigned_to: optionalId,
});

export const createTicketMessageSchema = z.object({
  message: shortText(10000),
  attachments: jsonColumn,
  is_internal: z.coerce.boolean().optional(),
});

/* ------------------------------------------------------------------ settlements */

/**
 * F12-04 · ¿Es `value` una fecha de calendario REAL con formato exacto AAAA-MM-DD?
 * Se comprueba con aritmética de calendario (años bisiestos incluidos), sin `Date`: así no
 * depende de la zona horaria del proceso y rechaza «2026-02-30», «2026-1-1» o «2026/01/01».
 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const bisiesto = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const diasDelMes = [31, bisiesto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= diasDelMes;
}

/**
 * F12-04 · periodo de una liquidación: dos fechas reales AAAA-MM-DD con inicio ≤ fin. Devuelve
 * los errores por campo (vacío si es válido). La ruta responde 400 con ellos: es un periodo
 * imposible, no un cuerpo mal formado (esos siguen siendo 422 por Zod).
 */
export function settlementPeriodErrors(periodStart: unknown, periodEnd: unknown): Record<string, string> {
  const errores: Record<string, string> = {};
  if (!isCalendarDate(periodStart)) errores.period_start = 'Debe ser una fecha real con formato AAAA-MM-DD';
  if (!isCalendarDate(periodEnd)) errores.period_end = 'Debe ser una fecha real con formato AAAA-MM-DD';
  // Con formato AAAA-MM-DD el orden de texto es el orden de calendario.
  if (Object.keys(errores).length === 0 && String(periodStart) > String(periodEnd)) {
    errores.period_end = 'El fin del periodo no puede ser anterior a su inicio';
  }
  return errores;
}

export const settlementShape = {
  company_id: id,
  period_start: z.string().min(1),
  period_end: z.string().min(1),
  status: z.enum(['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED']).optional(),
  payment_reference: optionalText(150),
};
export const createSettlementSchema = z.object(settlementShape);
export const updateSettlementSchema = toUpdateSchema(settlementShape);

/* ------------------------------------------------------------------ commission settings */
export const commissionShape = {
  company_id: id,
  commission_type: z.enum(['PERCENTAGE', 'FIXED']),
  commission_value: money,
  effective_from: z.string().min(1),
  effective_until: z.string().nullable().optional(),
  status: activeStatus.optional(),
};
export const createCommissionSchema = z.object(commissionShape);
export const updateCommissionSchema = toUpdateSchema(commissionShape);

/* ------------------------------------------------------------------ system settings */
export const systemSettingShape = {
  setting_key: z.string().trim().min(2).max(150).regex(/^[a-z0-9_.]+$/i, 'Clave inválida'),
  setting_value: z.string().max(65535).nullable().optional(),
  setting_type: z.enum(['STRING', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'JSON']).optional(),
  description: optionalText(500),
  is_public: z.coerce.boolean().transform((value) => (value ? 1 : 0)).optional(),
};
export const createSystemSettingSchema = z.object(systemSettingShape);
export const updateSystemSettingSchema = toUpdateSchema(systemSettingShape);

/* ------------------------------------------------------------------ api keys */
export const createApiKeySchema = z.object({
  company_id: optionalId,
  name: shortText(150),
  environment: z.enum(['TEST', 'PRODUCTION']).optional(),
  permissions: jsonColumn,
  expires_at: z.string().nullable().optional(),
});

/* ------------------------------------------------------------------ roles */
export const roleShape = {
  name: z.string().trim().min(3).max(50).regex(/^[A-Z_]+$/, 'Usa mayúsculas y guiones bajos, ej. SUPERVISOR'),
  description: optionalText(255),
  status: activeStatus.optional(),
};
export const createRoleSchema = z.object(roleShape);
export const updateRoleSchema = toUpdateSchema(roleShape);
export const setRolePermissionsSchema = z.object({
  permission_ids: z.array(id).max(200),
});

/* ------------------------------------------------------------------ users (admin managed) */
export const createUserSchema = z.object({
  role_id: id,
  first_name: shortText(100),
  last_name: shortText(100),
  email: z.string().email('Correo inválido').max(150),
  phone: optionalText(30),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').max(72),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'PENDING']).optional(),
  company_id: optionalId,
  position: optionalText(100),
});

export const updateUserSchema = z.object({
  role_id: optionalId,
  first_name: shortText(100).optional(),
  last_name: shortText(100).optional(),
  phone: optionalText(30),
  avatar_url: optionalText(500),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'PENDING']).optional(),
  password: z.string().min(8).max(72).optional(),
});
