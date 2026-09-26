import { api, apiData, type QueryParams } from './api';
import type { ComplaintDetail, ComplaintForm, ComplaintLookup, ComplaintReceipt, ComplaintRow, LegalInfo } from '@/types/complaint-book';

/** Libro de Reclamaciones: formulario y consulta públicos, bandeja del ADMIN y de la empresa relacionada. */
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
