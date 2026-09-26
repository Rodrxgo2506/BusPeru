import { api, apiData, type QueryParams } from './api';
import type {
  AdminProfileDetail,
  CompanyAgencyItem,
  CompanyGalleryItem,
  CompanyProfile,
  CompanyServiceItem,
  ComplaintDetail,
  ComplaintForm,
  ComplaintLookup,
  ComplaintReceipt,
  ComplaintRow,
  LegalInfo,
  ModerationQueueRow,
  ProfileAuditRow,
  PublicCompanyProfile,
  PublicCompanyReview,
} from '@/types/company-profile';

/**
 * F18-19 · servicios del perfil público de empresas y del Libro de Reclamaciones.
 *
 * `companyId` solo lo usa el ADMIN (para supervisar una empresa concreta); un rol de empresa lo omite y
 * la API usa la de su sesión. Aunque lo enviara, la API lo ignora para los roles de empresa.
 */
const withCompany = (path: string, companyId?: number) => (companyId ? `${path}${path.includes('?') ? '&' : '?'}company_id=${companyId}` : path);

type ItemPath = 'services' | 'agencies' | 'gallery';
type ItemOf<P extends ItemPath> = P extends 'services' ? CompanyServiceItem : P extends 'agencies' ? CompanyAgencyItem : CompanyGalleryItem;

function upload<T>(path: string, file: File, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append('file', file);
  for (const [key, value] of Object.entries(fields)) if (value !== '') form.append(key, value);
  return apiData(api.upload<T>(path, form));
}

export const companyProfileService = {
  get: (companyId?: number) => apiData(api.get<CompanyProfile>(withCompany('/company/profile', companyId))),
  update: (body: Record<string, unknown>, companyId?: number) => apiData(api.put<CompanyProfile>(withCompany('/company/profile', companyId), body)),
  updateSlug: (slug: string, companyId: number) => apiData(api.put<CompanyProfile>(withCompany('/company/profile/slug', companyId), { slug })),
  submit: (companyId?: number) => apiData(api.post<CompanyProfile>(withCompany('/company/profile/submit', companyId))),
  preview: (companyId?: number) => apiData(api.get<PublicCompanyProfile>(withCompany('/company/profile/preview', companyId))),
  uploadImage: (slot: 'cover' | 'about', file: File, companyId?: number) => upload<CompanyProfile>(withCompany(`/company/profile/images/${slot}`, companyId), file),
  removeImage: (slot: 'cover' | 'about', companyId?: number) => apiData(api.delete<CompanyProfile>(withCompany(`/company/profile/images/${slot}`, companyId))),

  list: <P extends ItemPath>(items: P, companyId?: number) => apiData(api.get<Array<ItemOf<P>>>(withCompany(`/company/profile/${items}`, companyId))),
  create: <P extends Exclude<ItemPath, 'gallery'>>(items: P, body: Record<string, unknown>, companyId?: number) =>
    apiData(api.post<ItemOf<P>>(withCompany(`/company/profile/${items}`, companyId), body)),
  update_item: <P extends ItemPath>(items: P, id: number, body: Record<string, unknown>, companyId?: number) =>
    apiData(api.put<ItemOf<P>>(withCompany(`/company/profile/${items}/${id}`, companyId), body)),
  remove: (items: ItemPath, id: number, companyId?: number) => apiData(api.delete<{ deleted: boolean }>(withCompany(`/company/profile/${items}/${id}`, companyId))),
  submitItem: <P extends ItemPath>(items: P, id: number, companyId?: number) =>
    apiData(api.post<ItemOf<P>>(withCompany(`/company/profile/${items}/${id}/submit`, companyId))),
  setActive: <P extends ItemPath>(items: P, id: number, isActive: boolean, companyId?: number) =>
    apiData(api.patch<ItemOf<P>>(withCompany(`/company/profile/${items}/${id}/active`, companyId), { is_active: isActive })),
  reorder: <P extends ItemPath>(items: P, ids: number[], companyId?: number) =>
    apiData(api.put<Array<ItemOf<P>>>(withCompany(`/company/profile/${items}/reorder`, companyId), { ids })),
  uploadItemImage: <P extends Exclude<ItemPath, 'gallery'>>(items: P, id: number, file: File, companyId?: number) =>
    upload<ItemOf<P>>(withCompany(`/company/profile/${items}/${id}/image`, companyId), file),
  removeItemImage: <P extends Exclude<ItemPath, 'gallery'>>(items: P, id: number, companyId?: number) =>
    apiData(api.delete<ItemOf<P>>(withCompany(`/company/profile/${items}/${id}/image`, companyId))),
  uploadGallery: (file: File, fields: { title?: string; description?: string; category?: string }, companyId?: number) =>
    upload<CompanyGalleryItem>(withCompany('/company/profile/gallery', companyId), file, fields as Record<string, string>),
};

export const adminCompanyProfileService = {
  queue: (status?: string) => apiData(api.get<ModerationQueueRow[]>('/admin/company-profiles', status ? { status } : undefined)),
  detail: (companyId: number) => apiData(api.get<AdminProfileDetail>(`/admin/company-profiles/${companyId}`)),
  moderate: (companyId: number, body: { entity: 'profile' | 'service' | 'agency' | 'gallery'; id?: number; action: 'approve' | 'reject' | 'suspend' | 'unsuspend'; note?: string }) =>
    apiData(api.post<AdminProfileDetail>(`/admin/company-profiles/${companyId}/moderation`, body)),
  audit: (companyId: number, params?: QueryParams) => api.get<ProfileAuditRow[]>(`/admin/company-profiles/${companyId}/audit`, params),
};

export const publicCompanyService = {
  profile: (slug: string) => apiData(api.get<PublicCompanyProfile>(`/public/companies/${encodeURIComponent(slug)}`)),
  gallery: (slug: string, page: number) => api.get<PublicCompanyProfile['gallery']['items']>(`/public/companies/${encodeURIComponent(slug)}/gallery`, { page }),
  reviews: (slug: string, page: number) => api.get<PublicCompanyReview[]>(`/public/companies/${encodeURIComponent(slug)}/reviews`, { page, limit: 6 }),
};

export const complaintService = {
  legal: () => apiData(api.get<LegalInfo>('/public/legal')),
  create: (body: ComplaintForm) => apiData(api.post<ComplaintReceipt>('/public/complaints', body)),
  lookup: (code: string, documentNumber: string) => apiData(api.post<ComplaintLookup>('/public/complaints/lookup', { code, document_number: documentNumber })),
  // ADMIN
  list: (params?: QueryParams) => api.get<ComplaintRow[]>('/admin/complaints', params),
  detail: (id: number) => apiData(api.get<ComplaintDetail>(`/admin/complaints/${id}`)),
  update: (id: number, body: { status?: 'IN_REVIEW' | 'CLOSED'; response?: string; response_channel?: 'EMAIL' | 'CARTA' }) =>
    apiData(api.patch<ComplaintDetail>(`/admin/complaints/${id}`, body)),
  addNote: (id: number, note: string) => apiData(api.post<ComplaintDetail>(`/admin/complaints/${id}/notes`, { note })),
  // Empresa relacionada
  companyList: (params?: QueryParams) => api.get<ComplaintRow[]>('/company/complaints', params),
  companyDetail: (id: number) => apiData(api.get<ComplaintDetail>(`/company/complaints/${id}`)),
  companyNote: (id: number, note: string) => apiData(api.post<ComplaintDetail>(`/company/complaints/${id}/notes`, { note })),
};
