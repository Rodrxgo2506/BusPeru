/** Libro de Reclamaciones virtual (DS 011-2011-PCM) e identidad legal del proveedor. */
export type ComplaintKind = 'RECLAMO' | 'QUEJA';
export type ComplaintStatus = 'RECEIVED' | 'IN_REVIEW' | 'ANSWERED' | 'CLOSED';
export type DocumentType = 'DNI' | 'CE' | 'PASAPORTE' | 'RUC' | 'OTRO';

export interface LegalInfo {
  business_name: string | null;
  ruc: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
}

export interface ComplaintForm {
  kind: ComplaintKind;
  consumer_name: string;
  consumer_document_type: DocumentType;
  consumer_document_number: string;
  consumer_address: string;
  consumer_phone: string;
  consumer_email: string;
  is_minor: boolean;
  guardian_name?: string | null;
  guardian_address?: string | null;
  guardian_phone?: string | null;
  guardian_email?: string | null;
  item_type: 'PRODUCTO' | 'SERVICIO';
  item_description: string;
  claimed_amount?: number | null;
  booking_code?: string | null;
  company_id?: number | null;
  detail: string;
  request: string;
  accepted: boolean;
}

export interface ComplaintReceipt {
  code: string;
  created_at: string;
  due_date: string;
  kind: ComplaintKind;
  copy_emailed: boolean;
  sheet: string;
  provider: LegalInfo;
}

export interface ComplaintLookup {
  code: string;
  kind: ComplaintKind;
  status: ComplaintStatus;
  created_at: string;
  due_date: string;
  response: string | null;
  response_at: string | null;
  response_channel: 'EMAIL' | 'CARTA' | null;
}

export interface ComplaintEvent {
  id: number;
  event: 'CREATED' | 'COPY_EMAILED' | 'STATUS_CHANGED' | 'RESPONSE_SENT' | 'INTERNAL_NOTE' | 'COMPANY_NOTE';
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  actor_role: string | null;
  created_at: string;
  first_name: string | null;
  last_name: string | null;
}

export interface ComplaintRow {
  id: number;
  code: string;
  kind: ComplaintKind;
  status: ComplaintStatus;
  consumer_name: string;
  item_description: string;
  booking_code: string | null;
  company_id: number | null;
  company_name?: string | null;
  created_at: string;
  due_date: string;
  response_at: string | null;
  overdue?: boolean;
}

export interface ComplaintDetail extends ComplaintRow {
  consumer_document_type?: DocumentType;
  consumer_document_number?: string;
  consumer_address?: string;
  consumer_phone?: string;
  consumer_email?: string;
  is_minor?: number | boolean;
  guardian_name?: string | null;
  item_type: 'PRODUCTO' | 'SERVICIO';
  claimed_amount: number | null;
  detail: string;
  request: string;
  response: string | null;
  response_channel?: 'EMAIL' | 'CARTA' | null;
  response_emailed_at?: string | null;
  copy_emailed_at?: string | null;
  events: ComplaintEvent[];
  sheet?: string;
}
