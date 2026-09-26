import { Building2, ExternalLink, Eye, EyeOff, Image as ImageIcon, MapPin, Pencil, Plus, Save, Send, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { CompanyProfileView } from '@/components/company-profile/CompanyProfileView';
import { ModerationSummary, OrderButtons, SpecialHoursEditor, TextListEditor, WeeklyHoursEditor } from '@/components/company-profile/ProfileEditors';
import { ImageUploadField } from '@/components/common/ImageUploadField';
import { Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, ErrorState, Input, LoadingState, Modal, PageHeader, PermissionDenied, Select, Tabs, Textarea } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { ApiError, mediaUrl } from '@/services/api';
import { publicService } from '@/services';
import { companyProfileService } from '@/services/company-profile';
import type {
  AgencyService,
  CompanyAgencyItem,
  CompanyGalleryItem,
  CompanyProfile,
  CompanyServiceItem,
  GalleryCategory,
  SocialNetwork,
  SpecialHours,
  WeeklyHours,
} from '@/types/company-profile';
import { AGENCY_SERVICE_LABELS, GALLERY_CATEGORY_LABELS, SOCIAL_LABELS, formatDayHours } from '@/utils/company-profile';

/**
 * F18-19 · «Mi empresa → Perfil público».
 *
 * La empresa edita su COPIA DE TRABAJO y la envía a revisión; BusPerú la aprueba (se publica) o la rechaza
 * con un motivo. Mientras tanto, el público sigue viendo lo último aprobado. El ADMIN reutiliza este editor
 * con `companyId` para corregir información crítica de una empresa concreta.
 */

type TabId = 'general' | 'about' | 'services' | 'agencies' | 'destinations' | 'gallery' | 'contact' | 'preview';

function errorMessage(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const fields = error.fields ? Object.values(error.fields as Record<string, string>) : [];
  return fields.length ? fields.slice(0, 3).join(' · ') : error.message;
}

export function CompanyPublicProfilePage({ companyId, embedded = false }: { companyId?: number; embedded?: boolean }) {
  const { user, hasPermission } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<TabId>('general');
  const profile = useAsync(() => companyProfileService.get(companyId), [companyId]);
  const canEdit = hasPermission('companies.update') && (user?.role === 'COMPANY_ADMIN' || user?.role === 'ADMIN');

  if (!hasPermission('companies.view')) return <PermissionDenied />;
  if (!companyId && !user?.companyIds.length && user?.role !== 'ADMIN') {
    return (
      <Card padded={false}>
        <EmptyState title="Tu usuario no está asociado a ninguna empresa" icon={<Building2 className="h-7 w-7" />} />
      </Card>
    );
  }

  const run = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      toast.success(success);
      profile.reload();
      return true;
    } catch (error) {
      toast.error('No se pudo completar la acción', errorMessage(error));
      return false;
    }
  };

  const data = profile.data;
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'general', label: 'Información general' },
    { id: 'about', label: 'Nosotros' },
    { id: 'services', label: 'Servicios' },
    { id: 'agencies', label: 'Agencias' },
    { id: 'destinations', label: 'Destinos y flota' },
    { id: 'gallery', label: 'Galería' },
    { id: 'contact', label: 'Contacto' },
    { id: 'preview', label: 'Vista previa' },
  ];

  return (
    <>
      {!embedded && (
        <PageHeader
          title="Perfil público"
          description="Lo que verán los pasajeros en la página de tu empresa. Cada cambio pasa por la revisión de BusPerú antes de publicarse."
          breadcrumbs={[{ label: 'Portal Empresa' }, { label: 'Perfil público' }]}
          actions={
            data?.is_published && !data.suspended_at ? (
              <Button variant="outline" icon={<ExternalLink className="h-4 w-4" />} onClick={() => window.open(`/empresas/${data.slug}`, '_blank', 'noopener')}>
                Ver página pública
              </Button>
            ) : undefined
          }
        />
      )}

      {profile.error ? (
        <Card padded={false}><ErrorState error={profile.error} onRetry={profile.reload} /></Card>
      ) : profile.loading || !data ? (
        <LoadingState className="min-h-[40vh]" />
      ) : (
        <>
          <Card className="mb-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-muted">Perfil de <strong className="text-ink">{data.company.name}</strong> · URL pública: <code className="rounded bg-slate-100 px-1.5">/empresas/{data.slug}</code></p>
                <div className="mt-2"><ModerationSummary item={data} /></div>
              </div>
              {canEdit && (
                <Button
                  icon={<Send className="h-4 w-4" />}
                  disabled={data.review_status === 'PENDING' || data.review_status === 'APPROVED'}
                  onClick={() => void run(() => companyProfileService.submit(companyId), 'Perfil enviado a revisión.')}
                >
                  Enviar perfil a revisión
                </Button>
              )}
            </div>
            <p className="mt-3 text-xs text-muted">
              Flujo: <strong>Borrador</strong> → <strong>En revisión</strong> → <strong>Publicado</strong> (o <strong>Rechazado</strong> con motivo). Cualquier edición vuelve a
              borrador; lo ya publicado sigue visible hasta que BusPerú apruebe la nueva versión. Servicios, agencias y fotos se envían por separado.
            </p>
          </Card>

          <Tabs tabs={tabs} active={tab} onChange={setTab} className="mb-5" />

          {tab === 'general' && <GeneralTab profile={data} canEdit={canEdit} companyId={companyId} run={run} />}
          {tab === 'about' && <AboutTab profile={data} canEdit={canEdit} companyId={companyId} run={run} />}
          {tab === 'contact' && <ContactTab profile={data} canEdit={canEdit} companyId={companyId} run={run} />}
          {tab === 'services' && <ServicesTab canEdit={canEdit} companyId={companyId} />}
          {tab === 'agencies' && <AgenciesTab canEdit={canEdit} companyId={companyId} />}
          {tab === 'gallery' && <GalleryTab canEdit={canEdit} companyId={companyId} />}
          {tab === 'destinations' && <DerivedTab companyId={companyId} />}
          {tab === 'preview' && <PreviewTab companyId={companyId} />}
        </>
      )}
    </>
  );
}

type Run = (action: () => Promise<unknown>, success: string) => Promise<boolean>;

// ================================================================================ perfil: general / nosotros / contacto
function useDraft(profile: CompanyProfile, fields: string[]) {
  const initial = () => Object.fromEntries(fields.map((field) => [field, (profile as unknown as Record<string, unknown>)[field] ?? null]));
  const [draft, setDraft] = useState<Record<string, unknown>>(initial);
  useEffect(() => setDraft(initial()), [profile]); // eslint-disable-line react-hooks/exhaustive-deps
  const text = (field: string) => ({
    value: String(draft[field] ?? ''),
    onChange: (event: { target: { value: string } }) => setDraft((current) => ({ ...current, [field]: event.target.value })),
  });
  return { draft, setDraft, text };
}

function SaveBar({ canEdit, onSave, saving }: { canEdit: boolean; onSave: () => void; saving: boolean }) {
  if (!canEdit) return <p className="text-sm text-muted">Solo el administrador de la empresa puede editar el perfil.</p>;
  return (
    <div className="flex justify-end border-t border-border pt-4">
      <Button icon={<Save className="h-4 w-4" />} loading={saving} onClick={onSave}>Guardar como borrador</Button>
    </div>
  );
}

function GeneralTab({ profile, canEdit, companyId, run }: { profile: CompanyProfile; canEdit: boolean; companyId?: number; run: Run }) {
  const { draft, text } = useDraft(profile, ['tagline']);
  const [saving, setSaving] = useState(false);
  const [busyImage, setBusyImage] = useState(false);
  return (
    <Card className="space-y-5">
      <Input label="Descripción corta (eslogan)" maxLength={300} hint="Aparece bajo el nombre de la empresa. Máximo 300 caracteres." disabled={!canEdit} {...text('tagline')} />
      <ImageUploadField
        label="Portada"
        hint="Imagen horizontal (se recomienda 1600 × 600 px o más). JPG, PNG o WebP, hasta 5 MB."
        currentUrl={mediaUrl(profile.cover_image)}
        busy={busyImage}
        previewClassName="aspect-[16/6]"
        layout="stacked"
        onSelect={(file) => {
          if (!canEdit) return;
          setBusyImage(true);
          void run(() => companyProfileService.uploadImage('cover', file, companyId), 'Portada actualizada (queda en borrador).').finally(() => setBusyImage(false));
        }}
        onRemove={canEdit && profile.cover_image ? () => void run(() => companyProfileService.removeImage('cover', companyId), 'Portada quitada.') : undefined}
      />
      <p className="text-xs text-muted">El nombre comercial, el logotipo y los datos legales se gestionan en «Configuración»; el RUC solo lo cambia BusPerú.</p>
      <SaveBar canEdit={canEdit} saving={saving} onSave={() => { setSaving(true); void run(() => companyProfileService.update({ tagline: draft.tagline || null }, companyId), 'Cambios guardados como borrador.').finally(() => setSaving(false)); }} />
    </Card>
  );
}

function AboutTab({ profile, canEdit, companyId, run }: { profile: CompanyProfile; canEdit: boolean; companyId?: number; run: Run }) {
  const { draft, setDraft, text } = useDraft(profile, ['about_title', 'about_body', 'history', 'mission', 'vision', 'values_list']);
  const [saving, setSaving] = useState(false);
  const [busyImage, setBusyImage] = useState(false);
  const save = () => {
    setSaving(true);
    const body = Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, typeof v === 'string' ? v.trim() || null : v]));
    void run(() => companyProfileService.update(body, companyId), 'Cambios guardados como borrador.').finally(() => setSaving(false));
  };
  return (
    <Card className="space-y-5">
      <Input label="Título de la sección" maxLength={150} placeholder="Nosotros" disabled={!canEdit} {...text('about_title')} />
      <Textarea label="Descripción principal" rows={5} maxLength={6000} disabled={!canEdit} {...text('about_body')} />
      <Textarea label="Historia" rows={4} maxLength={6000} disabled={!canEdit} {...text('history')} />
      <div className="grid gap-4 md:grid-cols-2">
        <Textarea label="Misión" rows={3} maxLength={2000} disabled={!canEdit} {...text('mission')} />
        <Textarea label="Visión" rows={3} maxLength={2000} disabled={!canEdit} {...text('vision')} />
      </div>
      {canEdit ? (
        <TextListEditor label="Valores" max={12} placeholder="Ej.: Puntualidad" values={(draft.values_list as string[] | null) ?? []} onChange={(values) => setDraft((current) => ({ ...current, values_list: values.length ? values : null }))} />
      ) : (
        <p className="text-sm">Valores: {((draft.values_list as string[] | null) ?? []).join(', ') || '—'}</p>
      )}
      <ImageUploadField
        label="Imagen de «Nosotros»"
        hint="Foto de la empresa, un bus o una agencia. JPG, PNG o WebP, hasta 5 MB."
        currentUrl={mediaUrl(profile.about_image)}
        busy={busyImage}
        onSelect={(file) => {
          if (!canEdit) return;
          setBusyImage(true);
          void run(() => companyProfileService.uploadImage('about', file, companyId), 'Imagen actualizada (queda en borrador).').finally(() => setBusyImage(false));
        }}
        onRemove={canEdit && profile.about_image ? () => void run(() => companyProfileService.removeImage('about', companyId), 'Imagen quitada.') : undefined}
      />
      <p className="text-xs text-muted">Solo texto plano: no se admite HTML. Los saltos de línea se respetan.</p>
      <SaveBar canEdit={canEdit} saving={saving} onSave={save} />
    </Card>
  );
}

const NETWORKS = Object.keys(SOCIAL_LABELS) as SocialNetwork[];

function ContactTab({ profile, canEdit, companyId, run }: { profile: CompanyProfile; canEdit: boolean; companyId?: number; run: Run }) {
  const { draft, setDraft, text } = useDraft(profile, ['contact_phone', 'contact_whatsapp', 'contact_email', 'website_url', 'main_address', 'social_links']);
  const [saving, setSaving] = useState(false);
  const socials = (draft.social_links as Partial<Record<SocialNetwork, string>> | null) ?? {};
  const save = () => {
    setSaving(true);
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(draft)) body[key] = typeof value === 'string' ? value.trim() || null : value;
    body.social_links = Object.fromEntries(Object.entries(socials).filter(([, url]) => url && url.trim()));
    void run(() => companyProfileService.update(body, companyId), 'Contacto guardado como borrador.').finally(() => setSaving(false));
  };
  return (
    <Card className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        <Input label="Teléfono" type="tel" disabled={!canEdit} {...text('contact_phone')} />
        <Input label="WhatsApp" type="tel" hint="Con código de país o un celular peruano de 9 dígitos." disabled={!canEdit} {...text('contact_whatsapp')} />
        <Input label="Correo" type="email" disabled={!canEdit} {...text('contact_email')} />
        <Input label="Sitio web" placeholder="https://" hint="Solo direcciones https." disabled={!canEdit} {...text('website_url')} />
        <Input label="Dirección principal" containerClassName="md:col-span-2" disabled={!canEdit} {...text('main_address')} />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {NETWORKS.map((network) => (
          <Input
            key={network}
            label={SOCIAL_LABELS[network]}
            placeholder="https://"
            disabled={!canEdit}
            value={socials[network] ?? ''}
            onChange={(event) => setDraft((current) => ({ ...current, social_links: { ...socials, [network]: event.target.value } }))}
          />
        ))}
      </div>
      <p className="text-xs text-muted">Cada red solo acepta enlaces de su dominio oficial. No publiques datos personales de trabajadores o pasajeros.</p>
      <SaveBar canEdit={canEdit} saving={saving} onSave={save} />
    </Card>
  );
}

// ================================================================================ elementos: acciones comunes
function ItemActions({ canEdit, item, onEdit, onSubmit, onToggle, onDelete, extra }: {
  canEdit: boolean;
  item: { review_status: string; is_active: boolean };
  onEdit?: () => void;
  onSubmit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  extra?: ReactNode;
}) {
  if (!canEdit) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {extra}
      {onEdit && <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={onEdit}>Editar</Button>}
      <Button size="sm" variant="outline" icon={<Send className="h-4 w-4" />} disabled={item.review_status === 'PENDING' || item.review_status === 'APPROVED'} onClick={onSubmit}>Enviar a revisión</Button>
      <Button size="sm" variant="ghost" icon={item.is_active ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />} onClick={onToggle}>{item.is_active ? 'Ocultar' : 'Mostrar'}</Button>
      <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4 text-danger-600" />} onClick={onDelete} aria-label="Eliminar" />
    </div>
  );
}

function useItems<P extends 'services' | 'agencies' | 'gallery'>(items: P, companyId?: number) {
  const toast = useToast();
  const list = useAsync(() => companyProfileService.list(items, companyId), [items, companyId]);
  const act = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      toast.success(success);
      list.reload();
      return true;
    } catch (error) {
      toast.error('No se pudo completar la acción', errorMessage(error));
      return false;
    }
  };
  const move = (from: number, to: number) => {
    const rows = [...(list.data ?? [])];
    const [row] = rows.splice(from, 1);
    rows.splice(to, 0, row!);
    void act(() => companyProfileService.reorder(items, rows.map((r) => r.id), companyId), 'Orden actualizado.');
  };
  return { list, act, move };
}

// ================================================================================ servicios
function ServicesTab({ canEdit, companyId }: { canEdit: boolean; companyId?: number }) {
  const { list, act, move } = useItems('services', companyId);
  const [editing, setEditing] = useState<CompanyServiceItem | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CompanyServiceItem | null>(null);
  const rows = list.data ?? [];
  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-muted">Modalidades de servicio (Bus Cama, Ejecutivo, Comercial…) con sus características.</p>
        {canEdit && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>Agregar servicio</Button>}
      </div>
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : list.loading ? <LoadingState /> : rows.length === 0 ? (
        <EmptyState title="Aún no hay servicios" description="Agrega las modalidades que ofrece tu empresa." />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((service, index) => (
            <li key={service.id} className="flex flex-wrap items-start gap-3 py-4">
              {canEdit && <OrderButtons index={index} total={rows.length} onMove={move} />}
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-ink">{service.name}</p>
                <p className="line-clamp-2 text-sm text-muted">{service.description ?? 'Sin descripción'}</p>
                <div className="mt-2"><ModerationSummary item={service} /></div>
              </div>
              <ItemActions
                canEdit={canEdit}
                item={service}
                onEdit={() => setEditing(service)}
                onSubmit={() => void act(() => companyProfileService.submitItem('services', service.id, companyId), 'Servicio enviado a revisión.')}
                onToggle={() => void act(() => companyProfileService.setActive('services', service.id, !service.is_active, companyId), service.is_active ? 'Servicio oculto.' : 'Servicio visible.')}
                onDelete={() => setDeleting(service)}
              />
            </li>
          ))}
        </ul>
      )}
      {editing && <ServiceForm service={editing === 'new' ? null : editing} companyId={companyId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => void act(() => companyProfileService.remove('services', deleting!.id, companyId), 'Servicio eliminado.').then(() => setDeleting(null))}
        title="Eliminar servicio"
        confirmLabel="Sí, eliminar"
        message="Deja de mostrarse al instante. El registro se conserva en el historial."
      />
    </Card>
  );
}

function ServiceForm({ service, companyId, onClose, onSaved }: { service: CompanyServiceItem | null; companyId?: number; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(service?.name ?? '');
  const [description, setDescription] = useState(service?.description ?? '');
  const [features, setFeatures] = useState<string[]>(service?.features ?? []);
  const [saving, setSaving] = useState(false);
  const [busyImage, setBusyImage] = useState(false);
  const [current, setCurrent] = useState(service);

  const save = async () => {
    setSaving(true);
    try {
      const body = { name: name.trim(), description: description.trim() || null, features: features.length ? features : null };
      if (current) await companyProfileService.update_item('services', current.id, body, companyId);
      else setCurrent(await companyProfileService.create('services', body, companyId));
      toast.success('Servicio guardado como borrador.');
      if (current) onSaved();
    } catch (error) {
      toast.error('No se pudo guardar', errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={current && !service ? onSaved : onClose} title={service ? 'Editar servicio' : 'Nuevo servicio'} size="lg">
      <div className="space-y-4">
        <Input label="Nombre" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
        <Textarea label="Descripción" rows={3} maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} />
        <TextListEditor label="Características" max={20} placeholder="Ej.: Asientos reclinables" values={features} onChange={setFeatures} />
        {current ? (
          <ImageUploadField
            label="Imagen del servicio"
            currentUrl={mediaUrl(current.image)}
            busy={busyImage}
            onSelect={(file) => {
              setBusyImage(true);
              void companyProfileService.uploadItemImage('services', current.id, file, companyId).then(setCurrent).catch((error) => toast.error('No se pudo subir la imagen', errorMessage(error))).finally(() => setBusyImage(false));
            }}
            onRemove={current.image ? () => void companyProfileService.removeItemImage('services', current.id, companyId).then(setCurrent) : undefined}
          />
        ) : (
          <p className="text-xs text-muted">Podrás añadir la imagen después de guardar.</p>
        )}
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="ghost" onClick={current && !service ? onSaved : onClose}>{current && !service ? 'Terminar' : 'Cancelar'}</Button>
          <Button loading={saving} disabled={!name.trim()} onClick={() => void save()}>Guardar</Button>
        </div>
      </div>
    </Modal>
  );
}

// ================================================================================ agencias
function AgenciesTab({ canEdit, companyId }: { canEdit: boolean; companyId?: number }) {
  const { list, act, move } = useItems('agencies', companyId);
  const [editing, setEditing] = useState<CompanyAgencyItem | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CompanyAgencyItem | null>(null);
  const rows = list.data ?? [];
  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-muted">Agencias con dirección, coordenadas para el mapa, horarios y servicios.</p>
        {canEdit && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>Agregar agencia</Button>}
      </div>
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : list.loading ? <LoadingState /> : rows.length === 0 ? (
        <EmptyState title="Aún no hay agencias" description="Agrega tus agencias para que los pasajeros sepan dónde encontrarte." icon={<MapPin className="h-7 w-7" />} />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((agency, index) => (
            <li key={agency.id} className="flex flex-wrap items-start gap-3 py-4">
              {canEdit && <OrderButtons index={index} total={rows.length} onMove={move} />}
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-ink">{agency.name} <span className="font-normal text-muted">· {agency.city}</span></p>
                <p className="text-sm text-muted">{agency.address}</p>
                <p className="mt-1 text-xs text-muted">
                  {agency.latitude !== null ? 'Con ubicación en el mapa' : 'Sin coordenadas: no se mostrará el mapa'} · Lunes: {formatDayHours(agency.weekly_hours?.['1'])}
                </p>
                <div className="mt-2"><ModerationSummary item={agency} /></div>
              </div>
              <ItemActions
                canEdit={canEdit}
                item={agency}
                onEdit={() => setEditing(agency)}
                onSubmit={() => void act(() => companyProfileService.submitItem('agencies', agency.id, companyId), 'Agencia enviada a revisión.')}
                onToggle={() => void act(() => companyProfileService.setActive('agencies', agency.id, !agency.is_active, companyId), agency.is_active ? 'Agencia oculta.' : 'Agencia visible.')}
                onDelete={() => setDeleting(agency)}
              />
            </li>
          ))}
        </ul>
      )}
      {editing && <AgencyForm agency={editing === 'new' ? null : editing} companyId={companyId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => void act(() => companyProfileService.remove('agencies', deleting!.id, companyId), 'Agencia eliminada.').then(() => setDeleting(null))}
        title="Eliminar agencia"
        confirmLabel="Sí, eliminar"
        message="Deja de mostrarse al instante. El registro se conserva en el historial."
      />
    </Card>
  );
}

const SERVICE_CODES = Object.keys(AGENCY_SERVICE_LABELS) as AgencyService[];

function AgencyForm({ agency, companyId, onClose, onSaved }: { agency: CompanyAgencyItem | null; companyId?: number; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const terminals = useAsync(() => publicService.terminals(), []);
  const [form, setForm] = useState({
    name: agency?.name ?? '',
    city: agency?.city ?? '',
    department: agency?.department ?? '',
    location_id: agency?.location_id ? String(agency.location_id) : '',
    address: agency?.address ?? '',
    reference: agency?.reference ?? '',
    phone: agency?.phone ?? '',
    whatsapp: agency?.whatsapp ?? '',
    email: agency?.email ?? '',
    latitude: agency?.latitude !== null && agency?.latitude !== undefined ? String(agency.latitude) : '',
    longitude: agency?.longitude !== null && agency?.longitude !== undefined ? String(agency.longitude) : '',
  });
  const [services, setServices] = useState<AgencyService[]>(agency?.services ?? []);
  const [weekly, setWeekly] = useState<WeeklyHours>(agency?.weekly_hours ?? {});
  const [special, setSpecial] = useState<SpecialHours[]>(agency?.special_hours ?? []);
  const [saving, setSaving] = useState(false);
  const [current, setCurrent] = useState(agency);
  const [busyImage, setBusyImage] = useState(false);
  const field = (key: keyof typeof form) => ({ value: form[key], onChange: (event: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: event.target.value })) });

  const save = async () => {
    setSaving(true);
    const blank = (value: string) => value.trim() || null;
    try {
      const body = {
        name: form.name.trim(),
        city: form.city.trim(),
        department: blank(form.department),
        location_id: form.location_id ? Number(form.location_id) : null,
        address: form.address.trim(),
        reference: blank(form.reference),
        phone: blank(form.phone),
        whatsapp: blank(form.whatsapp),
        email: blank(form.email),
        latitude: form.latitude.trim() === '' ? null : Number(form.latitude),
        longitude: form.longitude.trim() === '' ? null : Number(form.longitude),
        services: services.length ? services : null,
        weekly_hours: Object.keys(weekly).length ? weekly : null,
        special_hours: special.length ? special.map((day) => ({ ...day, note: day.note?.trim() || null })) : null,
      };
      if (current) await companyProfileService.update_item('agencies', current.id, body, companyId);
      else setCurrent(await companyProfileService.create('agencies', body, companyId));
      toast.success('Agencia guardada como borrador.');
      if (current) onSaved();
    } catch (error) {
      toast.error('No se pudo guardar', errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={current && !agency ? onSaved : onClose} title={agency ? 'Editar agencia' : 'Nueva agencia'} size="xl">
      <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Input label="Nombre" required maxLength={150} {...field('name')} />
          <Select
            label="Terminal o ciudad del catálogo (opcional)"
            placeholder="Ninguno"
            value={form.location_id}
            onChange={(event) => {
              const location = (terminals.data ?? []).find((t) => String(t.id) === event.target.value);
              setForm((f) => ({ ...f, location_id: event.target.value, city: location?.city ?? f.city }));
            }}
            options={(terminals.data ?? []).map((t) => ({ value: String(t.id), label: `${t.name} · ${t.city}` }))}
          />
          <Input label="Ciudad" required maxLength={150} {...field('city')} />
          <Input label="Departamento / región" maxLength={150} {...field('department')} />
          <Input label="Dirección" required maxLength={255} containerClassName="md:col-span-2" {...field('address')} />
          <Input label="Referencia" maxLength={255} containerClassName="md:col-span-2" {...field('reference')} />
          <Input label="Teléfono" type="tel" {...field('phone')} />
          <Input label="WhatsApp" type="tel" {...field('whatsapp')} />
          <Input label="Correo" type="email" {...field('email')} />
          <div className="grid grid-cols-2 gap-2">
            <Input label="Latitud" inputMode="decimal" placeholder="-12.046400" {...field('latitude')} />
            <Input label="Longitud" inputMode="decimal" placeholder="-77.042800" {...field('longitude')} />
          </div>
        </div>
        <p className="-mt-2 text-xs text-muted">Las coordenadas deben estar dentro del Perú. Sin ellas no se muestra el mapa ni «Cómo llegar».</p>

        <fieldset>
          <legend className="text-sm font-medium text-ink">Servicios de la agencia</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {SERVICE_CODES.map((code) => (
              <Checkbox key={code} label={AGENCY_SERVICE_LABELS[code]} checked={services.includes(code)} onChange={(event) => setServices((list) => (event.target.checked ? [...list, code] : list.filter((c) => c !== code)))} />
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-ink">Horario semanal</legend>
          <WeeklyHoursEditor value={weekly} onChange={setWeekly} />
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-ink">Horarios especiales y feriados</legend>
          <SpecialHoursEditor value={special} onChange={setSpecial} />
        </fieldset>

        {current ? (
          <ImageUploadField
            label="Foto de la agencia"
            currentUrl={mediaUrl(current.image)}
            busy={busyImage}
            onSelect={(file) => {
              setBusyImage(true);
              void companyProfileService.uploadItemImage('agencies', current.id, file, companyId).then(setCurrent).catch((error) => toast.error('No se pudo subir la imagen', errorMessage(error))).finally(() => setBusyImage(false));
            }}
            onRemove={current.image ? () => void companyProfileService.removeItemImage('agencies', current.id, companyId).then(setCurrent) : undefined}
          />
        ) : (
          <p className="text-xs text-muted">Podrás añadir la foto después de guardar.</p>
        )}

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="ghost" onClick={current && !agency ? onSaved : onClose}>{current && !agency ? 'Terminar' : 'Cancelar'}</Button>
          <Button loading={saving} disabled={!form.name.trim() || !form.city.trim() || !form.address.trim()} onClick={() => void save()}>Guardar</Button>
        </div>
      </div>
    </Modal>
  );
}

// ================================================================================ galería
const CATEGORIES = Object.keys(GALLERY_CATEGORY_LABELS) as GalleryCategory[];

function GalleryTab({ canEdit, companyId }: { canEdit: boolean; companyId?: number }) {
  const toast = useToast();
  const { list, act } = useItems('gallery', companyId);
  const [upload, setUpload] = useState<{ file: File | null; title: string; category: GalleryCategory }>({ file: null, title: '', category: 'BUS' });
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<CompanyGalleryItem | null>(null);
  const [deleting, setDeleting] = useState<CompanyGalleryItem | null>(null);
  const rows = list.data ?? [];

  const send = async () => {
    if (!upload.file) return;
    setUploading(true);
    try {
      await companyProfileService.uploadGallery(upload.file, { title: upload.title.trim(), category: upload.category }, companyId);
      toast.success('Foto subida como borrador.');
      setUpload({ file: null, title: '', category: upload.category });
      list.reload();
    } catch (error) {
      toast.error('No se pudo subir la foto', errorMessage(error));
    } finally {
      setUploading(false);
    }
  };

  return (
    <Card>
      {canEdit && (
        <div className="mb-5 grid gap-3 rounded-control bg-slate-50 p-4 sm:grid-cols-[1fr_1fr_180px_auto] sm:items-end">
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-ink">Foto</span>
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setUpload((u) => ({ ...u, file: event.target.files?.[0] ?? null }))} className="block w-full text-sm" />
          </label>
          <Input label="Título (opcional)" maxLength={120} value={upload.title} onChange={(event) => setUpload((u) => ({ ...u, title: event.target.value }))} />
          <Select label="Categoría" value={upload.category} onChange={(event) => setUpload((u) => ({ ...u, category: event.target.value as GalleryCategory }))} options={CATEGORIES.map((c) => ({ value: c, label: GALLERY_CATEGORY_LABELS[c] }))} />
          <Button icon={<ImageIcon className="h-4 w-4" />} loading={uploading} disabled={!upload.file} onClick={() => void send()}>Subir</Button>
          <p className="text-xs text-muted sm:col-span-4">JPG, PNG o WebP de hasta 5 MB y entre 160 y 6000 px por lado. Cada foto se revisa antes de publicarse.</p>
        </div>
      )}
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : list.loading ? <LoadingState /> : rows.length === 0 ? (
        <EmptyState title="La galería está vacía" description="Sube fotos de tus buses, agencias e instalaciones." icon={<ImageIcon className="h-7 w-7" />} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((item) => (
            <li key={item.id} className="overflow-hidden rounded-card ring-1 ring-black/5">
              <img src={mediaUrl(item.image) ?? ''} alt={item.title ?? ''} className="aspect-video w-full object-cover" loading="lazy" />
              <div className="space-y-2 p-3">
                <p className="text-sm font-semibold text-ink">{item.title ?? 'Sin título'} <Badge>{GALLERY_CATEGORY_LABELS[item.category]}</Badge></p>
                <ModerationSummary item={item} />
                <ItemActions
                  canEdit={canEdit}
                  item={item}
                  onEdit={() => setEditing(item)}
                  onSubmit={() => void act(() => companyProfileService.submitItem('gallery', item.id, companyId), 'Foto enviada a revisión.')}
                  onToggle={() => void act(() => companyProfileService.setActive('gallery', item.id, !item.is_active, companyId), item.is_active ? 'Foto oculta.' : 'Foto visible.')}
                  onDelete={() => setDeleting(item)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && <GalleryForm item={editing} companyId={companyId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => void act(() => companyProfileService.remove('gallery', deleting!.id, companyId), 'Foto eliminada.').then(() => setDeleting(null))}
        title="Eliminar foto"
        confirmLabel="Sí, eliminar"
        message="Deja de mostrarse al instante. El registro se conserva en el historial."
      />
    </Card>
  );
}

function GalleryForm({ item, companyId, onClose, onSaved }: { item: CompanyGalleryItem; companyId?: number; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(item.title ?? '');
  const [description, setDescription] = useState(item.description ?? '');
  const [category, setCategory] = useState<GalleryCategory>(item.category);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await companyProfileService.update_item('gallery', item.id, { title: title.trim() || null, description: description.trim() || null, category }, companyId);
      toast.success('Foto actualizada (queda en borrador).');
      onSaved();
    } catch (error) {
      toast.error('No se pudo guardar', errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Editar foto">
      <div className="space-y-4">
        <Input label="Título" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
        <Textarea label="Descripción" rows={3} maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} />
        <Select label="Categoría" value={category} onChange={(event) => setCategory(event.target.value as GalleryCategory)} options={CATEGORIES.map((c) => ({ value: c, label: GALLERY_CATEGORY_LABELS[c] }))} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={saving} onClick={() => void save()}>Guardar</Button></div>
      </div>
    </Modal>
  );
}

// ================================================================================ destinos y flota / vista previa
function DerivedTab({ companyId }: { companyId?: number }) {
  const preview = useAsync(() => companyProfileService.preview(companyId), [companyId]);
  if (preview.error) return <Card padded={false}><ErrorState error={preview.error} onRetry={preview.reload} /></Card>;
  if (preview.loading || !preview.data) return <LoadingState />;
  const { destinations, fleet } = preview.data;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <h3 className="font-bold text-ink">Destinos</h3>
        <p className="mt-1 text-sm text-muted">Se calculan solos a partir de tus <strong>rutas activas</strong> y sus viajes programados. Para cambiarlos, gestiona tus rutas.</p>
        <ul className="mt-3 divide-y divide-border text-sm">
          {destinations.length === 0 && <li className="py-2 text-muted">No hay rutas activas.</li>}
          {destinations.map((d) => (
            <li key={d.city} className="flex justify-between gap-2 py-2"><span>{d.city} <span className="text-muted">desde {d.origins.map((o) => o.city).join(', ')}</span></span><span>{d.upcoming_trips} viajes</span></li>
          ))}
        </ul>
      </Card>
      <Card>
        <h3 className="font-bold text-ink">Flota</h3>
        <p className="mt-1 text-sm text-muted">Sale de tus <strong>buses activos</strong>. Nunca se muestran placas, códigos ni datos internos.</p>
        <ul className="mt-3 divide-y divide-border text-sm">
          {fleet.length === 0 && <li className="py-2 text-muted">No hay buses activos.</li>}
          {fleet.map((g) => (
            <li key={g.type} className="flex justify-between gap-2 py-2"><span>{g.type}</span><span>{g.buses} {g.buses === 1 ? 'bus' : 'buses'}</span></li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function PreviewTab({ companyId }: { companyId?: number }) {
  const preview = useAsync(() => companyProfileService.preview(companyId), [companyId]);
  if (preview.error) return <Card padded={false}><ErrorState error={preview.error} onRetry={preview.reload} /></Card>;
  if (preview.loading || !preview.data) return <LoadingState />;
  return (
    <div className="overflow-hidden rounded-card ring-1 ring-black/10">
      <CompanyProfileView data={preview.data} />
    </div>
  );
}
