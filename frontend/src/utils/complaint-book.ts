/**
 * Libro de Reclamaciones: utilidades puras (sin React ni DOM; se prueban con `node --test`).
 */
/** Libro de Reclamaciones: estados y eventos del historial en castellano. */
export const COMPLAINT_STATUS_LABELS: Record<string, string> = {
  RECEIVED: 'Recibida',
  IN_REVIEW: 'En revisión',
  ANSWERED: 'Respondida',
  CLOSED: 'Cerrada',
};

export const COMPLAINT_EVENT_LABELS: Record<string, string> = {
  CREATED: 'Hoja registrada',
  COPY_EMAILED: 'Copia enviada al consumidor',
  STATUS_CHANGED: 'Cambio de estado',
  RESPONSE_SENT: 'Respuesta registrada',
  INTERNAL_NOTE: 'Nota interna',
  COMPANY_NOTE: 'Descargo de la empresa',
};

/** «Cambio de estado → Cerrada» (el código se muestra tal cual si no se conoce). */
export function complaintEventLabel(event: string, toStatus: string | null | undefined): string {
  const label = COMPLAINT_EVENT_LABELS[event] ?? event;
  return toStatus ? `${label} → ${COMPLAINT_STATUS_LABELS[toStatus] ?? toStatus}` : label;
}
