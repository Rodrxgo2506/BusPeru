import { AlertTriangle, BookOpen, Building2, CheckCircle2, ExternalLink, Pencil, ShieldOff, ShieldCheck, XCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { CompanyProfileView } from '@/components/company-profile/CompanyProfileView';
import { ModerationSummary, ReviewStatusBadge } from '@/components/company-profile/ProfileEditors';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, Input, LoadingState, Modal, PageHeader, Select, Tabs, Textarea, TablePagination, type Column } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { useList } from '@/hooks/useList';
import { ApiError, mediaUrl } from '@/services/api';
import { adminCompanyProfileService, companyProfileService, complaintService } from '@/services/company-profile';
import type { AdminProfileDetail, ComplaintDetail, ComplaintRow, ModerationQueueRow } from '@/types/company-profile';
import { AGENCY_SERVICE_LABELS, complaintEventLabel, formatDayHours, GALLERY_CATEGORY_LABELS, WEEK_DAYS } from '@/utils/company-profile';
import { formatDate, formatDateTime } from '@/utils/format';
import { CompanyPublicProfilePage } from '@/pages/company/CompanyPublicProfilePage';

/**
 * F18-19 · supervisión ADMIN del contenido público: perfiles de empresa (moderación) y Libro de Reclamaciones.
 * Todo lo que se ve aquí lo protege la API (`requireRole('ADMIN')`); ocultar el menú es solo comodidad.
 */

function message(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const fields = error.fields ? Object.values(error.fields as Record<string, string>) : [];
  return fields.length ? fields.join(' · ') : error.message;
}

// ================================================================================ perfiles públicos
export function CompanyProfilesAdminPage() {
  const [filter, setFilter] = useState<'PENDING' | 'REJECTED' | 'ALL'>('PENDING');
  const [selected, setSelected] = useState<number | null>(null);
  const queue = useAsync(() => adminCompanyProfileService.queue(filter === 'ALL' ? undefined : filter), [filter]);

  if (selected !== null) return <ProfileModeration companyId={selected} onBack={() => { setSelected(null); queue.reload(); }} />;

  const columns: Array<Column<ModerationQueueRow>> = [
    {
      key: 'name',
      header: 'Empresa',
      render: (row) => (
        <span className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-brand-50">
            {row.logo_url ? <img src={mediaUrl(row.logo_url) ?? ''} alt="" className="max-h-full max-w-full object-contain" /> : <Building2 className="h-4 w-4 text-brand-600" />}
          </span>
          <span className="min-w-0">
            <span className="block font-semibold text-ink">{row.name}</span>
            <span className="block text-xs text-muted">{row.slug ? `/empresas/${row.slug}` : 'Sin perfil creado'}</span>
          </span>
        </span>
      ),
    },
    { key: 'profile', header: 'Perfil', render: (row) => <span className="flex flex-wrap gap-1"><ReviewStatusBadge status={row.profile_status} />{row.profile_suspended_at && <Badge tone="danger">Suspendido</Badge>}{row.profile_published_at && <Badge tone="info">Publicado</Badge>}</span> },
    { key: 'pending', header: 'Pendientes', render: (row) => (row.pending_count > 0 ? <Badge tone="warning">{row.pending_count}</Badge> : '—') },
    { key: 'rejected', header: 'Rechazados', render: (row) => (row.rejected_count > 0 ? <Badge tone="danger">{row.rejected_count}</Badge> : '—') },
    { key: '__actions', header: '', className: 'text-right', render: (row) => <Button size="sm" variant="outline" onClick={() => setSelected(row.company_id)}>Revisar</Button> },
  ];

  return (
    <>
      <PageHeader title="Perfiles públicos" description="Contenido que las empresas quieren publicar: nada llega al público sin tu aprobación." breadcrumbs={[{ label: 'Contenido' }, { label: 'Perfiles públicos' }]} />
      <Card padded={false}>
        <div className="border-b border-border p-4">
          <Select
            aria-label="Filtro"
            value={filter}
            onChange={(event) => setFilter(event.target.value as typeof filter)}
            options={[{ value: 'PENDING', label: 'Con contenido pendiente' }, { value: 'REJECTED', label: 'Con contenido rechazado' }, { value: 'ALL', label: 'Todas las empresas' }]}
            containerClassName="w-full sm:w-72"
          />
        </div>
        {queue.error ? <ErrorState error={queue.error} onRetry={queue.reload} /> : (
          <DataTable
            columns={columns}
            rows={queue.data ?? []}
            rowKey={(row) => row.company_id}
            loading={queue.loading}
            onRowClick={(row) => setSelected(row.company_id)}
            emptyState={<EmptyState title="Nada que revisar" description="No hay empresas en este filtro." icon={<CheckCircle2 className="h-7 w-7" />} />}
          />
        )}
      </Card>
    </>
  );
}

type Entity = 'profile' | 'service' | 'agency' | 'gallery';
type Action = 'approve' | 'reject' | 'suspend' | 'unsuspend';
const ACTION_LABEL: Record<Action, string> = { approve: 'Aprobar y publicar', reject: 'Rechazar', suspend: 'Suspender', unsuspend: 'Levantar suspensión' };

function ProfileModeration({ companyId, onBack }: { companyId: number; onBack: () => void }) {
  const toast = useToast();
  const detail = useAsync(() => adminCompanyProfileService.detail(companyId), [companyId]);
  const [tab, setTab] = useState<'info' | 'about' | 'services' | 'agencies' | 'destinations' | 'fleet' | 'gallery' | 'reviews' | 'contact' | 'audit' | 'edit' | 'preview'>('info');
  const [pending, setPending] = useState<{ entity: Entity; id?: number; action: Action } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [slug, setSlug] = useState('');

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      detail.setData(await adminCompanyProfileService.moderate(companyId, { ...pending, note: note.trim() || undefined }));
      toast.success('Moderación registrada.');
      setPending(null);
      setNote('');
    } catch (error) {
      toast.error('No se pudo moderar', message(error));
    } finally {
      setBusy(false);
    }
  };

  const Actions = ({ entity, id, status, suspended }: { entity: Entity; id?: number; status: string; suspended: boolean }) => (
    <span className="flex flex-wrap gap-1.5">
      {(status === 'PENDING' || status === 'DRAFT') && <Button size="sm" variant="success" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => setPending({ entity, id, action: 'approve' })}>Aprobar</Button>}
      {status === 'PENDING' && <Button size="sm" variant="outline" icon={<XCircle className="h-4 w-4" />} onClick={() => setPending({ entity, id, action: 'reject' })}>Rechazar</Button>}
      {suspended
        ? <Button size="sm" variant="ghost" icon={<ShieldCheck className="h-4 w-4" />} onClick={() => setPending({ entity, id, action: 'unsuspend' })}>Levantar suspensión</Button>
        : <Button size="sm" variant="ghost" icon={<ShieldOff className="h-4 w-4 text-danger-600" />} onClick={() => setPending({ entity, id, action: 'suspend' })}>Suspender</Button>}
    </span>
  );

  if (detail.error) return <Card padded={false}><ErrorState error={detail.error} onRetry={detail.reload} /></Card>;
  if (detail.loading || !detail.data) return <LoadingState className="min-h-[40vh]" />;
  const data: AdminProfileDetail = detail.data;
  const { profile } = data;
  const pendingCount = [profile, ...data.services, ...data.agencies, ...data.gallery].filter((item) => item.review_status === 'PENDING').length;

  const Field = ({ label, working, published }: { label: string; working: ReactNode; published?: ReactNode }) => (
    <div className="grid gap-2 border-t border-border py-3 first:border-t-0 md:grid-cols-[180px_1fr_1fr]">
      <span className="text-sm font-medium text-muted">{label}</span>
      <span className="whitespace-pre-line break-words text-sm text-ink">{working || '—'}</span>
      <span className="whitespace-pre-line break-words text-sm text-slate-500">{published === undefined ? '' : published || '—'}</span>
    </div>
  );
  const pub = profile.published_content;
  const socials = (value: Record<string, string> | null | undefined) => Object.entries(value ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n');

  return (
    <>
      <PageHeader
        title={`Perfil público · ${data.company.name}`}
        description={`${pendingCount} elemento(s) pendientes de revisión.`}
        breadcrumbs={[{ label: 'Contenido' }, { label: 'Perfiles públicos' }, { label: data.company.name }]}
        actions={
          <span className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={onBack}>Volver</Button>
            {profile.is_published && !profile.suspended_at && data.company.status === 'ACTIVE' && (
              <Button variant="outline" icon={<ExternalLink className="h-4 w-4" />} onClick={() => window.open(`/empresas/${profile.slug}`, '_blank', 'noopener')}>Página pública</Button>
            )}
          </span>
        }
      />
      <Tabs
        className="mb-5"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'info', label: 'Información' },
          { id: 'about', label: 'Nosotros' },
          { id: 'services', label: 'Servicios', count: data.services.length },
          { id: 'agencies', label: 'Agencias', count: data.agencies.length },
          { id: 'destinations', label: 'Destinos', count: data.destinations.length },
          { id: 'fleet', label: 'Flota', count: data.fleet.length },
          { id: 'gallery', label: 'Galería', count: data.gallery.length },
          { id: 'reviews', label: 'Opiniones', count: data.reviews.total },
          { id: 'contact', label: 'Contacto' },
          { id: 'audit', label: 'Auditoría' },
          { id: 'edit', label: 'Editar' },
          { id: 'preview', label: 'Vista previa' },
        ]}
      />

      {(tab === 'info' || tab === 'about' || tab === 'contact') && (
        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <ModerationSummary item={profile} />
            <Actions entity="profile" status={profile.review_status} suspended={Boolean(profile.suspended_at)} />
          </div>
          <div className="hidden text-xs font-semibold uppercase text-muted md:grid md:grid-cols-[180px_1fr_1fr]"><span /><span>Copia de trabajo</span><span>Publicado</span></div>
          {tab === 'info' && (
            <>
              <Field label="Empresa" working={`${data.company.name} (${data.company.status})`} />
              <Field label="Eslogan" working={profile.tagline} published={pub?.tagline} />
              <Field label="Portada" working={profile.cover_image ? <img src={mediaUrl(profile.cover_image) ?? ''} alt="" className="h-20 rounded object-cover" /> : null} published={pub?.cover_image ? <img src={mediaUrl(pub.cover_image) ?? ''} alt="" className="h-20 rounded object-cover" /> : null} />
              <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-4">
                <Input label="URL pública (solo ADMIN)" placeholder={profile.slug} value={slug} onChange={(event) => setSlug(event.target.value)} containerClassName="w-72" />
                <Button variant="outline" disabled={!slug.trim()} onClick={() => void companyProfileService.updateSlug(slug.trim(), companyId).then(() => { toast.success('URL actualizada.'); setSlug(''); detail.reload(); }).catch((error) => toast.error('No se pudo cambiar la URL', message(error)))}>Cambiar URL</Button>
              </div>
            </>
          )}
          {tab === 'about' && (
            <>
              <Field label="Título" working={profile.about_title} published={pub?.about_title} />
              <Field label="Descripción" working={profile.about_body} published={pub?.about_body} />
              <Field label="Historia" working={profile.history} published={pub?.history} />
              <Field label="Misión" working={profile.mission} published={pub?.mission} />
              <Field label="Visión" working={profile.vision} published={pub?.vision} />
              <Field label="Valores" working={profile.values_list?.join(', ')} published={pub?.values_list?.join(', ')} />
            </>
          )}
          {tab === 'contact' && (
            <>
              <Field label="Teléfono" working={profile.contact_phone} published={pub?.contact_phone} />
              <Field label="WhatsApp" working={profile.contact_whatsapp} published={pub?.contact_whatsapp} />
              <Field label="Correo" working={profile.contact_email} published={pub?.contact_email} />
              <Field label="Sitio web" working={profile.website_url} published={pub?.website_url} />
              <Field label="Redes" working={socials(profile.social_links as Record<string, string> | null)} published={socials(pub?.social_links as Record<string, string> | null)} />
              <Field label="Dirección" working={profile.main_address} published={pub?.main_address} />
            </>
          )}
        </Card>
      )}

      {tab === 'services' && (
        <ItemList empty="La empresa no tiene servicios." items={data.services.map((s) => ({
          id: s.id, item: s, title: s.name,
          body: <><p className="whitespace-pre-line">{s.description}</p><p className="mt-1 text-xs text-muted">{s.features?.join(' · ')}</p></>,
          image: s.image,
          actions: <Actions entity="service" id={s.id} status={s.review_status} suspended={Boolean(s.suspended_at)} />,
        }))} />
      )}
      {tab === 'agencies' && (
        <ItemList empty="La empresa no tiene agencias." items={data.agencies.map((a) => ({
          id: a.id, item: a, title: `${a.name} · ${a.city}`,
          body: (
            <>
              <p>{a.address}{a.reference ? ` (${a.reference})` : ''}</p>
              <p className="text-xs text-muted">{[a.phone, a.whatsapp, a.email].filter(Boolean).join(' · ')} · {a.latitude !== null ? `${a.latitude}, ${a.longitude}` : 'sin coordenadas'}</p>
              <p className="text-xs text-muted">{(a.services ?? []).map((s) => AGENCY_SERVICE_LABELS[s]).join(' · ')}</p>
              <p className="text-xs text-muted">{WEEK_DAYS.map((d) => `${d.short}: ${formatDayHours(a.weekly_hours?.[d.key])}`).join(' | ')}</p>
            </>
          ),
          image: a.image,
          actions: <Actions entity="agency" id={a.id} status={a.review_status} suspended={Boolean(a.suspended_at)} />,
        }))} />
      )}
      {tab === 'gallery' && (
        <ItemList empty="La galería está vacía." items={data.gallery.map((g) => ({
          id: g.id, item: g, title: g.title ?? 'Sin título',
          body: <><p>{g.description}</p><p className="text-xs text-muted">{GALLERY_CATEGORY_LABELS[g.category]} · {g.width}×{g.height}px</p></>,
          image: g.image,
          actions: <Actions entity="gallery" id={g.id} status={g.review_status} suspended={Boolean(g.suspended_at)} />,
        }))} />
      )}
      {tab === 'destinations' && (
        <Card>
          <p className="mb-3 text-sm text-muted">Derivados de las rutas activas de la empresa (no requieren moderación).</p>
          <ul className="divide-y divide-border text-sm">{data.destinations.map((d) => <li key={d.city} className="py-2">{d.city} · desde {d.origins.map((o) => o.city).join(', ')} · {d.upcoming_trips} viajes</li>)}</ul>
        </Card>
      )}
      {tab === 'fleet' && (
        <Card>
          <p className="mb-3 text-sm text-muted">Derivada de los buses activos. Sin placas ni códigos.</p>
          <ul className="divide-y divide-border text-sm">{data.fleet.map((f) => <li key={f.type} className="py-2">{f.type} · {f.buses} buses · {f.amenities.join(', ')}</li>)}</ul>
        </Card>
      )}
      {tab === 'reviews' && (
        <Card>
          <p className="text-sm">Valoración: <strong>{data.reviews.rating ?? '—'}</strong> · {data.reviews.total} opiniones publicadas.</p>
          <p className="mt-2 text-sm text-muted">La moderación de opiniones se hace en <a href="/admin/reviews" className="text-brand-600 underline">Reseñas</a> (sistema existente).</p>
        </Card>
      )}
      {tab === 'audit' && <AuditTab companyId={companyId} />}
      {tab === 'edit' && (
        <div>
          <p className="mb-3 flex items-center gap-2 rounded-control bg-amber-50 px-3 py-2 text-sm text-amber-900"><Pencil className="h-4 w-4" aria-hidden /> Editas como plataforma: cada cambio queda auditado a tu nombre y vuelve a borrador hasta que lo apruebes.</p>
          <CompanyPublicProfilePage companyId={companyId} embedded />
        </div>
      )}
      {tab === 'preview' && <AdminPreview companyId={companyId} />}

      <Modal open={pending !== null} onClose={() => setPending(null)} title={pending ? ACTION_LABEL[pending.action] : ''}>
        <div className="space-y-4">
          {pending && (pending.action === 'reject' || pending.action === 'suspend') ? (
            <Textarea label="Motivo (lo verá la empresa)" required rows={3} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
          ) : (
            <p className="text-sm text-slate-600">{pending?.action === 'approve' ? 'La copia de trabajo actual se publicará tal cual.' : 'El contenido volverá a ser visible si está publicado y activo.'}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPending(null)}>Cancelar</Button>
            <Button loading={busy} disabled={Boolean(pending && (pending.action === 'reject' || pending.action === 'suspend') && !note.trim())} onClick={() => void confirm()}>Confirmar</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

function ItemList({ items, empty }: { items: Array<{ id: number; item: Parameters<typeof ModerationSummary>[0]['item']; title: string; body: ReactNode; image: string | null; actions: ReactNode }>; empty: string }) {
  if (items.length === 0) return <Card padded={false}><EmptyState title={empty} /></Card>;
  return (
    <Card padded={false}>
      <ul className="divide-y divide-border">
        {items.map((entry) => (
          <li key={entry.id} className="flex flex-wrap gap-4 p-4">
            {entry.image && <img src={mediaUrl(entry.image) ?? ''} alt="" className="h-20 w-28 shrink-0 rounded object-cover" loading="lazy" />}
            <div className="min-w-0 flex-1 text-sm text-slate-700">
              <p className="font-semibold text-ink">{entry.title}</p>
              <div className="mt-1">{entry.body}</div>
              <div className="mt-2"><ModerationSummary item={entry.item} /></div>
            </div>
            <div>{entry.actions}</div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AuditTab({ companyId }: { companyId: number }) {
  const [page, setPage] = useState(1);
  const audit = useAsync(() => adminCompanyProfileService.audit(companyId, { page, limit: 20 }), [companyId, page]);
  if (audit.error) return <Card padded={false}><ErrorState error={audit.error} onRetry={audit.reload} /></Card>;
  if (audit.loading || !audit.data) return <LoadingState />;
  return (
    <Card padded={false}>
      <ul className="divide-y divide-border">
        {audit.data.data.map((row) => (
          <li key={row.id} className="p-4 text-sm">
            <p className="flex flex-wrap items-center gap-2"><Badge>{row.action}</Badge><span className="text-ink">{row.description}</span></p>
            <p className="mt-1 text-xs text-muted">{formatDateTime(row.created_at)} · {row.first_name ? `${row.first_name} ${row.last_name ?? ''} (${row.role})` : 'Sistema'}</p>
          </li>
        ))}
        {audit.data.data.length === 0 && <li className="p-6 text-center text-sm text-muted">Sin movimientos.</li>}
      </ul>
      {audit.data.pagination && <TablePagination pagination={audit.data.pagination} onPageChange={setPage} />}
    </Card>
  );
}

function AdminPreview({ companyId }: { companyId: number }) {
  const preview = useAsync(() => companyProfileService.preview(companyId), [companyId]);
  if (preview.error) return <Card padded={false}><ErrorState error={preview.error} onRetry={preview.reload} /></Card>;
  if (preview.loading || !preview.data) return <LoadingState />;
  return <div className="overflow-hidden rounded-card ring-1 ring-black/10"><CompanyProfileView data={preview.data} /></div>;
}

// ================================================================================ Libro de Reclamaciones (ADMIN)
const COMPLAINT_STATUS: Record<string, { label: string; tone: 'neutral' | 'warning' | 'success' | 'info' }> = {
  RECEIVED: { label: 'Recibida', tone: 'warning' },
  IN_REVIEW: { label: 'En revisión', tone: 'info' },
  ANSWERED: { label: 'Respondida', tone: 'success' },
  CLOSED: { label: 'Cerrada', tone: 'neutral' },
};

export function ComplaintStatusBadge({ status }: { status: string }) {
  const entry = COMPLAINT_STATUS[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}

export function ComplaintsAdminPage() {
  const list = useList<ComplaintRow>((params) => complaintService.list(params));
  const [selected, setSelected] = useState<number | null>(null);
  const columns: Array<Column<ComplaintRow>> = [
    { key: 'code', header: 'Hoja', render: (row) => <span><span className="block font-semibold text-ink">{row.code}</span><span className="text-xs text-muted">{row.kind === 'RECLAMO' ? 'Reclamo' : 'Queja'}</span></span> },
    { key: 'consumer', header: 'Consumidor', render: (row) => <span><span className="block">{row.consumer_name}</span><span className="block max-w-xs truncate text-xs text-muted">{row.item_description}</span></span> },
    { key: 'company', header: 'Empresa relacionada', render: (row) => row.company_name ?? '—' },
    { key: 'dates', header: 'Registro / límite', render: (row) => <span className="text-xs"><span className="block">{formatDateTime(row.created_at)}</span><span className={row.overdue ? 'font-semibold text-danger-600' : 'text-muted'}>{formatDate(row.due_date)}{row.overdue ? ' · VENCIDA' : ''}</span></span> },
    { key: 'status', header: 'Estado', render: (row) => <ComplaintStatusBadge status={row.status} /> },
  ];
  return (
    <>
      <PageHeader title="Libro de Reclamaciones" description="Hojas del Libro virtual de BusPerú. Plazo de respuesta: 15 días hábiles (DS 101-2022-PCM). Las hojas no se borran (se conservan 2 años)." breadcrumbs={[{ label: 'Configuración' }, { label: 'Libro de Reclamaciones' }]} />
      <Card padded={false}>
        <div className="flex flex-wrap gap-3 border-b border-border p-4">
          <Input aria-label="Buscar" placeholder="Código, nombre, documento o reserva" value={list.search} onChange={(event) => list.setSearch(event.target.value)} containerClassName="w-full sm:w-80" />
          <Select aria-label="Estado" placeholder="Todos los estados" value={list.filters.status ?? ''} onChange={(event) => list.setFilter('status', event.target.value || null)} options={Object.entries(COMPLAINT_STATUS).map(([value, entry]) => ({ value, label: entry.label }))} containerClassName="w-full sm:w-48" />
          <Select aria-label="Tipo" placeholder="Reclamos y quejas" value={list.filters.kind ?? ''} onChange={(event) => list.setFilter('kind', event.target.value || null)} options={[{ value: 'RECLAMO', label: 'Reclamos' }, { value: 'QUEJA', label: 'Quejas' }]} containerClassName="w-full sm:w-48" />
          <Select aria-label="Vencidas" placeholder="Todas" value={list.filters.overdue ?? ''} onChange={(event) => list.setFilter('overdue', event.target.value || null)} options={[{ value: 'true', label: 'Solo vencidas sin respuesta' }]} containerClassName="w-full sm:w-56" />
        </div>
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : (
          <>
            <DataTable columns={columns} rows={list.rows} rowKey={(row) => row.id} loading={list.loading} onRowClick={(row) => setSelected(row.id)}
              emptyState={<EmptyState title="No hay hojas" description="Aún no se ha registrado ningún reclamo o queja con estos filtros." icon={<BookOpen className="h-7 w-7" />} />} />
            {!list.loading && list.rows.length > 0 && <TablePagination pagination={list.pagination} onPageChange={list.setPage} />}
          </>
        )}
      </Card>
      {selected !== null && <ComplaintDetailModal id={selected} onClose={() => { setSelected(null); list.reload(); }} />}
    </>
  );
}

function ComplaintDetailModal({ id, onClose }: { id: number; onClose: () => void }) {
  const toast = useToast();
  const detail = useAsync(() => complaintService.detail(id), [id]);
  const [response, setResponse] = useState('');
  const [channel, setChannel] = useState<'EMAIL' | 'CARTA'>('EMAIL');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (action: () => Promise<ComplaintDetail>, success: string) => {
    setBusy(true);
    try {
      detail.setData(await action());
      toast.success(success);
      setResponse('');
      setNote('');
    } catch (error) {
      toast.error('No se pudo completar la acción', message(error));
    } finally {
      setBusy(false);
    }
  };
  const d = detail.data;
  return (
    <Modal open onClose={onClose} title={d ? `Hoja ${d.code}` : 'Hoja de reclamación'} size="xl">
      {detail.error ? <ErrorState error={detail.error} onRetry={detail.reload} /> : !d ? <LoadingState /> : (
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <ComplaintStatusBadge status={d.status} />
            <Badge>{d.kind === 'RECLAMO' ? 'Reclamo' : 'Queja'}</Badge>
            {d.overdue && <Badge tone="danger"><AlertTriangle className="h-3.5 w-3.5" /> Plazo vencido</Badge>}
            <span className="text-muted">Límite: {formatDate(d.due_date)}</span>
            {d.company_name && <span className="text-muted">· Empresa relacionada: {d.company_name}</span>}
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-control bg-slate-50 p-3 font-sans text-slate-700 ring-1 ring-black/5">{d.sheet}</pre>

          {d.response ? (
            <div className="rounded-control bg-success-50 p-3">
              <p className="font-semibold text-ink">Respuesta ({d.response_channel}) · {d.response_at ? formatDateTime(d.response_at) : ''}</p>
              <p className="mt-1 whitespace-pre-line">{d.response}</p>
              {d.response_channel === 'EMAIL' && <p className="mt-1 text-xs text-muted">{d.response_emailed_at ? `Correo enviado el ${formatDateTime(d.response_emailed_at)}` : 'El correo no se pudo enviar: enviar por otro medio y dejar nota.'}</p>}
            </div>
          ) : d.status !== 'CLOSED' && (
            <div className="space-y-3 rounded-control ring-1 ring-border p-3">
              <Textarea label="Respuesta al consumidor (escrita, única)" rows={4} maxLength={5000} value={response} onChange={(event) => setResponse(event.target.value)} />
              <div className="flex flex-wrap items-end gap-2">
                <Select label="Canal" value={channel} onChange={(event) => setChannel(event.target.value as 'EMAIL' | 'CARTA')} options={[{ value: 'EMAIL', label: 'Correo electrónico' }, { value: 'CARTA', label: 'Carta' }]} containerClassName="w-48" />
                <Button loading={busy} disabled={!response.trim()} onClick={() => void act(() => complaintService.update(id, { response: response.trim(), response_channel: channel }), 'Respuesta registrada.')}>Registrar respuesta</Button>
                {d.status === 'RECEIVED' && <Button variant="outline" loading={busy} onClick={() => void act(() => complaintService.update(id, { status: 'IN_REVIEW' }), 'Hoja en revisión.')}>Marcar en revisión</Button>}
              </div>
            </div>
          )}
          {d.status === 'ANSWERED' && <Button variant="outline" loading={busy} onClick={() => void act(() => complaintService.update(id, { status: 'CLOSED' }), 'Hoja cerrada.')}>Cerrar hoja</Button>}

          <div>
            <h3 className="font-semibold text-ink">Historial</h3>
            <ol className="mt-2 space-y-2">
              {d.events.map((event) => (
                <li key={event.id} className="rounded-control bg-slate-50 px-3 py-2">
                  <span className="font-medium">{complaintEventLabel(event.event, event.to_status)}</span> ·{' '}<span className="text-muted">{formatDateTime(event.created_at)} · {event.first_name ?? event.actor_role ?? 'Sistema'}</span>
                  {event.note && <p className="mt-1 whitespace-pre-line text-slate-700">{event.note}</p>}
                </li>
              ))}
            </ol>
            <div className="mt-3 flex gap-2">
              <Input aria-label="Nota interna" placeholder="Nota interna (no la ve el consumidor ni la empresa)" value={note} onChange={(event) => setNote(event.target.value)} containerClassName="flex-1" />
              <Button variant="outline" disabled={!note.trim()} loading={busy} onClick={() => void act(() => complaintService.addNote(id, note.trim()), 'Nota registrada.')}>Añadir</Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

