/** F18-19 · perfil público de empresas y Libro de Reclamaciones. Espejo de la API. */

export type ReviewStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED';
export type AgencyService = 'TICKET_SALES' | 'BOARDING' | 'PARCELS' | 'CUSTOMER_SERVICE' | 'BAGGAGE_STORAGE' | 'WAITING_ROOM';
export type GalleryCategory = 'BUS' | 'INTERIOR' | 'EXTERIOR' | 'AGENCY' | 'OFFICE' | 'FACILITIES' | 'OTHER';
export type SocialNetwork = 'facebook' | 'instagram' | 'tiktok' | 'youtube' | 'x' | 'linkedin';

export interface TimeRange {
  open: string;
  close: string;
}
/** Un día: cerrado o con tramos. Un día ausente = horario no informado. */
export type DayHours = { closed: true } | { ranges: TimeRange[] };
/** Claves ISO: '1' = lunes … '7' = domingo. */
export type WeeklyHours = Partial<Record<'1' | '2' | '3' | '4' | '5' | '6' | '7', DayHours>>;
export interface SpecialHours {
  date: string;
  closed?: boolean;
  ranges?: TimeRange[];
  note?: string | null;
}

/** Estado de moderación que acompaña a cada contenido en el panel. */
export interface Moderated {
  review_status: ReviewStatus;
  is_published: boolean;
  published_at?: string | null;
  moderation_note?: string | null;
  submitted_at?: string | null;
  reviewed_at?: string | null;
  suspended_at?: string | null;
  suspension_reason?: string | null;
}

export interface ProfileContent {
  tagline: string | null;
  cover_image: string | null;
  about_title: string | null;
  about_body: string | null;
  history: string | null;
  mission: string | null;
  vision: string | null;
  values_list: string[] | null;
  about_image: string | null;
  contact_phone: string | null;
  contact_whatsapp: string | null;
  contact_email: string | null;
  website_url: string | null;
  social_links: Partial<Record<SocialNetwork, string>> | null;
  main_address: string | null;
}

export interface CompanyProfile extends ProfileContent, Moderated {
  company_id: number;
  slug: string;
  company: { id: number; name: string; status: string; logo_url: string | null };
}

export interface ServiceContent {
  name: string;
  description: string | null;
  features: string[] | null;
  image: string | null;
}
export interface CompanyServiceItem extends ServiceContent, Moderated {
  id: number;
  display_order: number;
  is_active: boolean;
}

export interface AgencyContent {
  name: string;
  city: string;
  department: string | null;
  location_id: number | null;
  address: string;
  reference: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  latitude: number | null;
  longitude: number | null;
  image: string | null;
  services: AgencyService[] | null;
  weekly_hours: WeeklyHours | null;
  special_hours: SpecialHours[] | null;
}
export interface CompanyAgencyItem extends AgencyContent, Moderated {
  id: number;
  display_order: number;
  is_active: boolean;
}

export interface GalleryContent {
  image: string;
  width: number | null;
  height: number | null;
  title: string | null;
  description: string | null;
  category: GalleryCategory;
}
export interface CompanyGalleryItem extends GalleryContent, Moderated {
  id: number;
  display_order: number;
  is_active: boolean;
}

export interface CompanyDestinationCard {
  city: string;
  department: string | null;
  destination: { slug: string; name: string; subtitle: string | null; image: string | null } | null;
  upcoming_trips: number;
  min_price: number | null;
  origins: Array<{ city: string; upcoming_trips: number }>;
}

export interface FleetGroup {
  type: string;
  description: string | null;
  buses: number;
  min_capacity: number;
  max_capacity: number;
  amenities: string[];
}

export interface ReviewSummary {
  rating: number | null;
  total: number;
  distribution: Record<string, number>;
}

/** Vista pública (o vista previa) de un perfil. En la vista previa los elementos traen su estado. */
export interface PublicCompanyProfile {
  company: { id: number; name: string; logo_url: string | null; description: string | null };
  slug: string;
  profile: ProfileContent;
  reviews: ReviewSummary;
  // F18-19B (F-06): la respuesta pública no trae ids internos; la vista previa de la empresa sí (copia de trabajo).
  services: Array<ServiceContent & { id?: number; review_status?: ReviewStatus; is_published?: boolean }>;
  agencies: Array<AgencyContent & { id?: number; review_status?: ReviewStatus; is_published?: boolean }>;
  gallery: { items: Array<GalleryContent & { id?: number; review_status?: ReviewStatus }>; total: number; page_size: number };
  destinations: CompanyDestinationCard[];
  fleet: FleetGroup[];
  preview?: boolean;
  profile_status?: ReviewStatus;
  is_published?: boolean;
}

export interface PublicCompanyReview {
  rating: number;
  title: string | null;
  comment: string | null;
  created_at: string;
  first_name: string;
  company_response: string | null;
  company_response_at: string | null;
}

export interface ModerationQueueRow {
  company_id: number;
  name: string;
  company_status: string;
  logo_url: string | null;
  slug: string | null;
  profile_status: ReviewStatus | null;
  profile_published_at: string | null;
  profile_suspended_at: string | null;
  pending_count: number;
  rejected_count: number;
}

export interface AdminProfileDetail {
  company: { id: number; name: string; status: string; logo_url: string | null; description: string | null };
  profile: CompanyProfile & { published_content: ProfileContent | null };
  services: Array<CompanyServiceItem & { published_content: ServiceContent | null }>;
  agencies: Array<CompanyAgencyItem & { published_content: AgencyContent | null }>;
  gallery: Array<CompanyGalleryItem & { published_content: GalleryContent | null }>;
  destinations: CompanyDestinationCard[];
  fleet: FleetGroup[];
  reviews: ReviewSummary;
}

export interface ProfileAuditRow {
  id: number;
  action: string;
  description: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  created_at: string;
  first_name: string | null;
  last_name: string | null;
  role: string | null;
}

// --------------------------------------------------------------------------- Libro de Reclamaciones
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
