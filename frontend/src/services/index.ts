import { API_BASE_URL, api, apiBlob, apiData, type QueryParams } from './api';
import type {
  ApiKey,
  BankAccount,
  AuditLog,
  AuthUser,
  Booking,
  Bus,
  BusType,
  Company,
  CompanyDocument,
  Coupon,
  Driver,
  Integration,
  IntegrationList,
  Location,
  Notification,
  Payment,
  Permission,
  Promotion,
  PublicTrip,
  Refund,
  Review,
  Role,
  Route,
  SeatAvailability,
  SeatType,
  BusLayout,
  BusLayoutDeck,
  BusLayoutElement,
  LayoutSeat,
  LayoutTree,
  Settlement,
  SupportTicket,
  SystemSetting,
  Trip,
  TripLayout,
  UserRow,
  VerificationStatus,
} from '@/types';

/** Generic CRUD helper so each module does not repeat the same five calls. */
function crud<T>(resource: string) {
  return {
    list: (params?: QueryParams) => api.get<T[]>(resource, params),
    get: (id: number) => apiData(api.get<T>(`${resource}/${id}`)),
    create: (body: unknown) => apiData(api.post<T>(resource, body)),
    update: (id: number, body: unknown) => apiData(api.put<T>(`${resource}/${id}`, body)),
    remove: (id: number) => apiData(api.delete<{ id: number }>(`${resource}/${id}`)),
  };
}

export const authService = {
  login: (email: string, password: string) => apiData(api.post<{ token: string; user: AuthUser }>('/auth/login', { email, password })),
  register: (body: unknown) => apiData(api.post<{ token: string; user: AuthUser }>('/auth/register', body)),
  registerCompany: (body: unknown) => apiData(api.post<{ companyId: number; userId: number; message: string }>('/auth/register/company', body)),
  me: () => apiData(api.get<AuthUser>('/auth/me')),
  updateProfile: (body: unknown) => apiData(api.put<AuthUser>('/auth/me', body)),
  changePassword: (body: unknown) => apiData(api.put<{ message: string }>('/auth/me/password', body)),
  logout: () => apiData(api.post<{ message: string }>('/auth/logout')),

  // Recuperación de contraseña (mockup 10). Ninguna respuesta revela si el correo existe.
  forgotPassword: (email: string) => apiData(api.post<{ message: string }>('/auth/forgot-password', { email })),
  resendResetCode: (email: string) => apiData(api.post<{ message: string }>('/auth/resend-reset-code', { email })),
  verifyResetCode: (email: string, code: string) =>
    apiData(api.post<{ ticket: string; expires_in_minutes: number }>('/auth/verify-reset-code', { email, code })),
  resetPassword: (body: { email: string; ticket: string; new_password: string; confirm_password?: string }) =>
    apiData(api.post<{ message: string }>('/auth/reset-password', body)),
};

export const publicService = {
  cities: () => apiData(api.get<Array<{ city: string; department: string | null; terminals: number }>>('/public/cities')),
  terminals: (city?: string) => apiData(api.get<Location[]>('/public/terminals', { city })),
  companies: () => apiData(api.get<Array<Company & { rating: number | null; reviews_count: number; routes_count: number }>>('/public/companies')),
  searchTrips: (params: QueryParams) => api.get<PublicTrip[]>('/public/trips', params),
  /** Búsqueda de itinerarios de varios tramos: ida y vuelta y multidestino. */
  searchItinerary: (body: { trip_type: string; segments: Array<{ origin: string; destination: string; date: string }> }) =>
    apiData(api.post<Array<{
      segment_order: number;
      origin: string;
      destination: string;
      date: string;
      trips: Array<Record<string, unknown>>;
      total: number;
    }>>('/public/itineraries/search', body)),
  trip: (id: number) => apiData(api.get<PublicTrip & { stops: Array<{ name: string; city: string; stop_order: number }> }>(`/public/trips/${id}`)),
  tripSeats: (id: number) => apiData(api.get<SeatAvailability[]>(`/public/trips/${id}/seats`)),
  /** Geometría del bus del viaje: pisos, rejilla y elementos. Sin asientos ni precios. */
  tripLayout: (id: number) => apiData(api.get<TripLayout>(`/public/trips/${id}/layout`)),
  destinations: () => apiData(api.get<Array<{ city: string; department: string | null; min_price: number; trips: number }>>('/public/destinations')),
  promotions: () => apiData(api.get<Promotion[]>('/public/promotions')),
  reviews: (companyId?: number) => apiData(api.get<Review[]>('/public/reviews', { company_id: companyId })),
  settings: () => apiData(api.get<Record<string, unknown>>('/public/settings')),
  stats: () => apiData(api.get<{ companies: number; routes: number; bookings: number; terminals: number }>('/public/stats')),
};

export const userService = {
  ...crud<UserRow>('/users'),
  stats: () => apiData(api.get<Record<string, number>>('/users/stats')),
};

export const roleService = {
  list: () => apiData(api.get<Role[]>('/roles')),
  get: (id: number) => apiData(api.get<Role>(`/roles/${id}`)),
  create: (body: unknown) => apiData(api.post<Role>('/roles', body)),
  update: (id: number, body: unknown) => apiData(api.put<Role>(`/roles/${id}`, body)),
  remove: (id: number) => apiData(api.delete<{ id: number }>(`/roles/${id}`)),
  setPermissions: (id: number, permissionIds: number[]) =>
    apiData(api.put<{ role_id: number; permissions: Permission[] }>(`/roles/${id}/permissions`, { permission_ids: permissionIds })),
};

export const permissionService = {
  list: () => apiData(api.get<{ permissions: Permission[]; grouped: Record<string, Permission[]> }>('/permissions')),
};

export const companyService = crud<Company>('/companies');

/** Datos bancarios de la empresa. La API resuelve la empresa desde la sesión. */
export const bankAccountService = {
  list: () => apiData(api.get<BankAccount[]>('/company/bank-accounts')),
  history: () => apiData(api.get<Array<Record<string, unknown>>>('/company/bank-accounts/history')),
  create: (body: unknown) => apiData(api.post<BankAccount>('/company/bank-accounts', body)),
  update: (id: number, body: unknown) => apiData(api.put<BankAccount>(`/company/bank-accounts/${id}`, body)),
  remove: (id: number) => apiData(api.delete<{ id: number }>(`/company/bank-accounts/${id}`)),
};
/**
 * Documentos de verificación (mockups 13 y 14). La empresa la resuelve la API desde la
 * sesión; `companyId` solo lo usa el ADMIN para revisar una empresa concreta.
 */
/**
 * Inicio de sesión con Google / Microsoft (PENDIENTES.md §2).
 *
 * El navegador nunca ve el `client_secret` ni el `id_token`: solo navega al backend, que
 * conduce el flujo, y vuelve con un ticket de un solo uso que se canjea por la sesión.
 */
export const oauthService = {
  providers: () => apiData(api.get<Array<{ provider: 'GOOGLE' | 'MICROSOFT'; configured: boolean }>>('/auth/oauth/providers')),
  /** URL a la que hay que navegar para arrancar el flujo. No es una llamada AJAX. */
  startUrl: (provider: 'GOOGLE' | 'MICROSOFT', scope: 'CUSTOMER' | 'COMPANY' | 'ADMIN') =>
    `${API_BASE_URL}/auth/oauth/${provider.toLowerCase()}/start?scope=${scope}`,
  session: (ticket: string) => apiData(api.post<{ token: string; user: AuthUser }>('/auth/oauth/session', { ticket })),
  link: (provider: 'GOOGLE' | 'MICROSOFT') => apiData(api.post<{ url: string }>(`/auth/oauth/${provider.toLowerCase()}/link`)),
  currentLink: () => apiData(api.get<{ provider: 'GOOGLE' | 'MICROSOFT' | null }>('/auth/oauth/link')),
  unlink: () => apiData(api.delete<{ message: string }>('/auth/oauth/link')),
};

/**
 * Integraciones por empresa (mockup 37). El alcance actual es SOLO configuración: guardar
 * y conectar no activa ningún procesamiento.
 */
export const integrationService = {
  list: (scope: 'company' | 'admin' = 'company') => apiData(api.get<IntegrationList>(base(scope))),
  get: (provider: string, scope: 'company' | 'admin' = 'company') =>
    apiData(api.get<Integration>(`${base(scope)}/${provider}`)),
  save: (provider: string, credentials: Record<string, string>, scope: 'company' | 'admin' = 'company') =>
    apiData(api.put<Integration>(`${base(scope)}/${provider}`, { credentials })),
  connect: (provider: string, scope: 'company' | 'admin' = 'company') =>
    apiData(api.post<Integration>(`${base(scope)}/${provider}/connect`)),
  disconnect: (provider: string, scope: 'company' | 'admin' = 'company') =>
    apiData(api.post<Integration>(`${base(scope)}/${provider}/disconnect`)),
  remove: (provider: string, scope: 'company' | 'admin' = 'company') =>
    apiData(api.delete<{ provider: string }>(`${base(scope)}/${provider}`)),
};

/** `admin` opera sobre la integración de plataforma (`company_id = NULL`). */
const base = (scope: 'company' | 'admin') => (scope === 'admin' ? '/admin/integrations' : '/company/integrations');

export const companyDocumentService = {
  list: (companyId?: number) => apiData(api.get<CompanyDocument[]>('/company/documents', { company_id: companyId ?? null })),
  pendingReview: () => apiData(api.get<CompanyDocument[]>('/company/documents/pending-review')),
  verificationStatus: (companyId?: number) =>
    apiData(api.get<VerificationStatus>('/company/documents/verification-status', { company_id: companyId ?? null })),
  upload: (file: File, type: string) => {
    const form = new FormData();
    form.append('type', type);
    form.append('file', file);
    return apiData(api.upload<CompanyDocument>('/company/documents', form));
  },
  review: (id: number, status: 'VERIFIED' | 'REJECTED', notes?: string) =>
    apiData(api.put<CompanyDocument>(`/company/documents/${id}/review`, { status, notes: notes ?? null })),
  remove: (id: number) => apiData(api.delete<{ id: number }>(`/company/documents/${id}`)),
  /** El archivo viaja como Blob porque la ruta exige el token de sesión. */
  file: (id: number) => apiBlob(`/company/documents/${id}/file`),
};

export const busService = crud<Bus>('/buses');

/** Personal de conducción. La API resuelve la empresa desde la sesión. */
export const driverService = {
  list: (params?: QueryParams) => apiData(api.get<Driver[]>('/company/drivers', params)),
  get: (id: number) => apiData(api.get<Driver>(`/company/drivers/${id}`)),
  create: (body: unknown) => apiData(api.post<Driver>('/company/drivers', body)),
  update: (id: number, body: unknown) => apiData(api.put<Driver>(`/company/drivers/${id}`, body)),
  remove: (id: number) => apiData(api.delete<{ id: number }>(`/company/drivers/${id}`)),
};
export const busTypeService = crud<BusType>('/bus-types');
/**
 * Distribución física del bus: versiones, pisos, elementos y asientos.
 *
 * La empresa nunca viaja en el cuerpo: el backend la deduce del bus y la contrasta con la
 * sesión. Tampoco se envían `layout_id` ni `bus_id` al crear un asiento; los pone el
 * servidor a partir del piso.
 */
export const busLayoutService = {
  listByBus: (busId: number) => apiData(api.get<BusLayout[]>(`/buses/${busId}/layouts`)),
  tree: (layoutId: number) => apiData(api.get<LayoutTree>(`/layouts/${layoutId}`)),
  /** Borrador vacío. Solo para un bus que todavía no tiene ninguna versión. */
  createDraft: (busId: number, body?: { name?: string; decks?: Array<{ deck_number: number; name?: string; row_count?: number; column_count?: number }> }) =>
    apiData(api.post<BusLayout>(`/buses/${busId}/layouts`, body ?? {})),
  /** Copy-on-write: duplica una versión en un borrador editable. */
  clone: (layoutId: number) => apiData(api.post<BusLayout>(`/layouts/${layoutId}/clone`, {})),
  publish: (layoutId: number) => apiData(api.post<BusLayout>(`/layouts/${layoutId}/publish`, {})),
  removeLayout: (layoutId: number) => apiData(api.delete<{ deleted: boolean }>(`/layouts/${layoutId}`)),

  listDecks: (layoutId: number) => apiData(api.get<BusLayoutDeck[]>(`/layouts/${layoutId}/decks`)),
  createDeck: (layoutId: number, body: Partial<BusLayoutDeck>) => apiData(api.post<BusLayoutDeck>(`/layouts/${layoutId}/decks`, body)),
  updateDeck: (deckId: number, body: Partial<BusLayoutDeck>) => apiData(api.patch<BusLayoutDeck>(`/decks/${deckId}`, body)),
  removeDeck: (deckId: number) => apiData(api.delete<{ deleted: boolean }>(`/decks/${deckId}`)),

  listElements: (deckId: number) => apiData(api.get<BusLayoutElement[]>(`/decks/${deckId}/elements`)),
  createElement: (deckId: number, body: Partial<BusLayoutElement>) => apiData(api.post<BusLayoutElement>(`/decks/${deckId}/elements`, body)),
  updateElement: (elementId: number, body: Partial<BusLayoutElement>) => apiData(api.patch<BusLayoutElement>(`/elements/${elementId}`, body)),
  removeElement: (elementId: number) => apiData(api.delete<{ deleted: boolean }>(`/elements/${elementId}`)),

  listSeats: (deckId: number) => apiData(api.get<LayoutSeat[]>(`/decks/${deckId}/seats`)),
  createSeat: (deckId: number, body: Partial<LayoutSeat>) => apiData(api.post<LayoutSeat>(`/decks/${deckId}/seats`, body)),
  updateSeat: (seatId: number, body: Partial<LayoutSeat> & { deck_id?: number }) => apiData(api.patch<LayoutSeat>(`/layout-seats/${seatId}`, body)),
  removeSeat: (seatId: number) => apiData(api.delete<{ deleted: boolean }>(`/layout-seats/${seatId}`)),
};
export const seatTypeService = crud<SeatType>('/seat-types');
export const locationService = crud<Location>('/locations');
export const routeService = crud<Route>('/routes');
export const routeStopService = crud<{ id: number; route_id: number; location_id: number; stop_order: number; location_name: string; location_city: string }>('/route-stops');
export const promotionService = crud<Promotion>('/promotions');
export const couponService = crud<Coupon>('/coupons');
export const settingService = crud<SystemSetting>('/system-settings');
export const commissionService = crud<{ id: number; company_id: number; commission_type: string; commission_value: number; status: string; company_name?: string; effective_from: string }>('/commissions');

export const tripService = {
  ...crud<Trip>('/trips'),
  seats: (id: number) => apiData(api.get<SeatAvailability[]>(`/trips/${id}/seats`)),
  passengers: (id: number) => apiData(api.get<Array<Record<string, unknown>>>(`/trips/${id}/passengers`)),
  cancel: (id: number) => apiData(api.post<Trip>(`/trips/${id}/cancel`)),
};

/** Compras de varios tramos. La de un solo tramo sigue usando `bookingService`. */
export const itineraryService = {
  create: (body: unknown) => apiData(api.post<Record<string, unknown>>('/bookings/itineraries', body)),
  get: (groupId: number) => apiData(api.get<Record<string, unknown>>(`/bookings/itineraries/${groupId}`)),
  pay: (groupId: number, body: unknown) => apiData(api.post<Record<string, unknown>>(`/bookings/itineraries/${groupId}/pay`, body)),
};

export const bookingService = {
  list: (params?: QueryParams) => api.get<Booking[]>('/bookings', params),
  get: (id: number) => apiData(api.get<Booking>(`/bookings/${id}`)),
  create: (body: unknown) => apiData(api.post<Booking>('/bookings', body)),
  pay: (id: number, body: unknown) => apiData(api.post<Booking>(`/bookings/${id}/pay`, body)),
  cancel: (id: number, body: unknown) => apiData(api.post<Booking>(`/bookings/${id}/cancel`, body)),
};

/**
 * Configuración publicable de la pasarela. Devuelve SOLO la llave pública: la privada no
 * sale del backend y no existe ninguna variable `VITE_` para ella.
 */
export const culqiService = {
  config: () =>
    apiData(
      api.get<{ provider: string; public_key: string; card_enabled: boolean; currency: string }>('/culqi/config'),
    ),
};

export const paymentService = {
  list: (params?: QueryParams) => api.get<Payment[]>('/payments', params),
  get: (id: number) => apiData(api.get<Payment>(`/payments/${id}`)),
  summary: () => apiData(api.get<Record<string, number>>('/payments/summary')),
  /** Verificación manual de Yape, Plin, transferencia, efectivo u otro (H-22). */
  approve: (id: number) => apiData(api.post<Payment>(`/payments/${id}/approve`, {})),
  reject: (id: number, reason?: string) => apiData(api.post<Payment>(`/payments/${id}/reject`, { reason: reason ?? null })),
};

export const refundService = {
  list: (params?: QueryParams) => api.get<Refund[]>('/refunds', params),
  summary: () => apiData(api.get<Record<string, number>>('/refunds/summary')),
  create: (body: unknown) => apiData(api.post<Refund>('/refunds', body)),
  process: (id: number, body: unknown) => apiData(api.post<Refund>(`/refunds/${id}/process`, body)),
};

export const reviewService = {
  list: (params?: QueryParams) => api.get<Review[]>('/reviews', params),
  get: (id: number) => apiData(api.get<Review>(`/reviews/${id}`)),
  create: (body: unknown) => apiData(api.post<Review>('/reviews', body)),
  update: (id: number, body: unknown) => apiData(api.put<Review>(`/reviews/${id}`, body)),
  respond: (id: number, response: string) => apiData(api.post(`/reviews/${id}/responses`, { response })),
  remove: (id: number) => apiData(api.delete<{ id: number }>(`/reviews/${id}`)),
};

export const notificationService = {
  list: (params?: QueryParams) => api.get<Notification[]>('/notifications', params),
  unreadCount: () => apiData(api.get<{ unread: number }>('/notifications/unread-count')),
  markRead: (id: number) => apiData(api.put<Notification>(`/notifications/${id}/read`)),
  markAllRead: () => apiData(api.put<{ updated: number }>('/notifications/read-all')),
  remove: (id: number) => apiData(api.delete<{ id: number }>(`/notifications/${id}`)),
  send: (body: unknown) => apiData(api.post<{ sent: number }>('/notifications/send', body)),
};

export const templateService = crud<{ id: number; name: string; type: string; subject: string | null; title: string | null; body: string; status: string }>('/notification-templates');

export const supportService = {
  list: (params?: QueryParams) => api.get<SupportTicket[]>('/support/tickets', params),
  get: (id: number) => apiData(api.get<SupportTicket>(`/support/tickets/${id}`)),
  summary: () => apiData(api.get<Record<string, number>>('/support/tickets/summary')),
  create: (body: unknown) => apiData(api.post<SupportTicket>('/support/tickets', body)),
  update: (id: number, body: unknown) => apiData(api.put<SupportTicket>(`/support/tickets/${id}`, body)),
  reply: (id: number, body: unknown) => apiData(api.post(`/support/tickets/${id}/messages`, body)),
};

export const financeService = {
  transactions: (params?: QueryParams) => api.get<Array<Record<string, unknown>>>('/financial-transactions', params),
  transactionSummary: () => apiData(api.get<Record<string, number>>('/financial-transactions/summary')),
  settlements: (params?: QueryParams) => api.get<Settlement[]>('/settlements', params),
  settlement: (id: number) => apiData(api.get<Settlement>(`/settlements/${id}`)),
  settlementSummary: () => apiData(api.get<Record<string, number>>('/settlements/summary')),
  createSettlement: (body: unknown) => apiData(api.post<Settlement>('/settlements', body)),
  updateSettlement: (id: number, body: unknown) => apiData(api.put<Settlement>(`/settlements/${id}`, body)),
};

export const auditService = {
  list: (params?: QueryParams) => api.get<AuditLog[]>('/audit-logs', params),
  filters: () => apiData(api.get<{ actions: string[]; entities: string[] }>('/audit-logs/actions')),
};

export const apiKeyService = {
  list: () => apiData(api.get<ApiKey[]>('/api-keys')),
  create: (body: unknown) => apiData(api.post<ApiKey>('/api-keys', body)),
  revoke: (id: number) => apiData(api.post<ApiKey>(`/api-keys/${id}/revoke`)),
};

export const reportService = {
  list: () => apiData(api.get<string[]>('/reports')),
  run: (report: string, params?: QueryParams) =>
    apiData(api.get<{ report: string; rows: Array<Record<string, unknown>> }>(`/reports/${report}`, params)),
};

export const dashboardService = {
  admin: () => apiData(api.get<Record<string, never> & Record<string, unknown>>('/dashboard/admin')),
  company: () => apiData(api.get<Record<string, unknown>>('/dashboard/company')),
  customer: () => apiData(api.get<Record<string, unknown>>('/dashboard/customer')),
};
