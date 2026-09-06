/** Spanish labels for the ENUM values defined in the database. Never invent new states here. */
export const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Activo',
  INACTIVE: 'Inactivo',
  SUSPENDED: 'Suspendido',
  PENDING: 'Pendiente',
  REJECTED: 'Rechazado',
  VERIFIED: 'Verificado',
  MAINTENANCE: 'En mantenimiento',
  AVAILABLE: 'Disponible',
  SCHEDULED: 'Programado',
  BOARDING: 'En embarque',
  IN_PROGRESS: 'En viaje',
  COMPLETED: 'Completado',
  CANCELLED: 'Cancelado',
  DELAYED: 'Retrasado',
  CONFIRMED: 'Confirmado',
  EXPIRED: 'Expirado',
  PROCESSING: 'Procesando',
  PAID: 'Pagado',
  FAILED: 'Fallido',
  REFUNDED: 'Reembolsado',
  PUBLISHED: 'Publicado',
  HIDDEN: 'Oculto',
  DRAFT: 'Borrador',
  SENT: 'Enviado',
  READ: 'Leído',
  OPEN: 'Abierto',
  WAITING_USER: 'Esperando respuesta',
  RESOLVED: 'Resuelto',
  CLOSED: 'Cerrado',
  REVOKED: 'Revocado',
};

export const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Administrador',
  COMPANY_ADMIN: 'Administrador de empresa',
  OPERATOR: 'Operador',
  CUSTOMER: 'Cliente',
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CARD: 'Tarjeta',
  YAPE: 'Yape',
  PLIN: 'Plin',
  TRANSFER: 'Transferencia',
  CASH: 'Efectivo',
  OTHER: 'Otro',
};

export const PRIORITY_LABELS: Record<string, string> = {
  LOW: 'Baja',
  MEDIUM: 'Media',
  HIGH: 'Alta',
  URGENT: 'Urgente',
};

export const TICKET_CATEGORY_LABELS: Record<string, string> = {
  BOOKING: 'Reservas',
  PAYMENT: 'Pagos',
  REFUND: 'Reembolsos',
  TRAVEL: 'Viajes',
  ACCOUNT: 'Cuenta',
  TECHNICAL: 'Técnico',
  OTHER: 'Otro',
};

export const LOCATION_TYPE_LABELS: Record<string, string> = {
  CITY: 'Ciudad',
  TERMINAL: 'Terminal',
  AGENCY: 'Agencia',
  OTHER: 'Otro',
};

export const TRANSACTION_TYPE_LABELS: Record<string, string> = {
  PAYMENT: 'Pago',
  REFUND: 'Reembolso',
  COMMISSION: 'Comisión',
  PAYOUT: 'Liquidación',
  ADJUSTMENT: 'Ajuste',
};

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  LOGIN: 'Inicio de sesión',
  LOGOUT: 'Cierre de sesión',
  CREATE: 'Creación',
  UPDATE: 'Actualización',
  DELETE: 'Eliminación',
  CANCEL: 'Cancelación',
  REFUND: 'Reembolso',
  PAYMENT: 'Pago',
};

export function label(dictionary: Record<string, string>, value: string | null | undefined): string {
  if (!value) return '—';
  return dictionary[value] ?? value;
}
