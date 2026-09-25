import { ArrowDown, ArrowUp, CalendarDays, ExternalLink, Eye, EyeOff, ImageOff, Landmark, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { ImageUploadField } from '@/components/common/ImageUploadField';
import { ResourceForm } from '@/components/common/ResourceForm';
import { Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { attractionService, destinationService, festivityService, locationService } from '@/services';
import { ApiError, mediaUrl } from '@/services/api';
import type { DestinationAttraction, DestinationFestivity } from '@/types';
import { formatCurrency } from '@/utils/format';
import { parseId } from './parse-id';
import { ATTRACTION_FIELDS, childPayload, destinationFields, destinationPayload, FESTIVITY_FIELDS } from './destination-forms';

/**
 * Contenido › Destinos › «Gestionar contenido» (FASE 17): imagen principal, «Qué visitar» y
 * «Calendario festivo» de UN destino. Cada bloque llama a su propio recurso; la API comprueba que
 * cada atractivo o festividad pertenezca a este destino.
 */

type Deleting = { kind: 'attraction'; item: DestinationAttraction } | { kind: 'festivity'; item: DestinationFestivity } | null;

export function DestinationContentPage() {
  const toast = useToast();
  const destinationId = parseId(useParams().destinationId);

  const destination = useAsync(() => destinationService.get(destinationId), [destinationId]);
  const attractions = useAsync(
    () => attractionService.list({ destination_id: destinationId, limit: 100, sort: 'da.display_order', order: 'ASC' }),
    [destinationId],
  );
  const festivities = useAsync(
    () => festivityService.list({ destination_id: destinationId, limit: 100, sort: 'df.display_order', order: 'ASC' }),
    [destinationId],
  );
  const locations = useAsync(() => locationService.list({ limit: 100, sort: 'l.city', order: 'ASC', type: 'TERMINAL' }), []);

  const [editingDestination, setEditingDestination] = useState(false);
  const [attractionForm, setAttractionForm] = useState<{ open: boolean; item: DestinationAttraction | null }>({ open: false, item: null });
  const [festivityForm, setFestivityForm] = useState<{ open: boolean; item: DestinationFestivity | null }>({ open: false, item: null });
  const [deleting, setDeleting] = useState<Deleting>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const fail = (title: string, error: unknown) => toast.error(title, error instanceof ApiError ? error.message : undefined);

  /* Mientras llega el destino se mantiene el encabezado con su ruta de navegación y el indicador
     ocupa solo la zona de los datos (F17C-NAV-02). El nombre todavía no se conoce, así que el
     título es genérico hasta que la API responde. */
  if (destination.loading || destination.error || !destination.data) {
    return (
      <>
        <PageHeader
          title="Destino"
          description={destination.loading ? 'Cargando la información del destino…' : undefined}
          breadcrumbs={[{ label: 'Contenido' }, { label: 'Destinos', to: '/admin/destinations' }]}
        />
        {destination.loading ? (
          <LoadingState label="Cargando destino..." className="min-h-[60vh]" />
        ) : (
          <Card padded={false}>
            <ErrorState error={destination.error ?? new ApiError(404, 'Destino no encontrado')} onRetry={destination.reload} />
          </Card>
        )}
      </>
    );
  }

  const data = destination.data;
  const attractionList = attractions.data?.data ?? [];
  const festivityList = festivities.data?.data ?? [];

  const withBusy = async (key: string, action: () => Promise<void>, errorTitle: string) => {
    setBusy(key);
    try {
      await action();
    } catch (error) {
      fail(errorTitle, error);
    } finally {
      setBusy(null);
    }
  };

  const reorder = async <T extends { id: number }>(list: T[], item: T, direction: -1 | 1, save: (ids: number[]) => Promise<unknown>, reload: () => void) => {
    const index = list.findIndex((entry) => entry.id === item.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= list.length) return;
    const ids = list.map((entry) => entry.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    await withBusy('reorder', async () => {
      await save(ids);
      reload();
    }, 'No se pudo reordenar');
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    await withBusy('delete', async () => {
      if (deleting.kind === 'attraction') {
        await attractionService.remove(deleting.item.id);
        attractions.reload();
      } else {
        await festivityService.remove(deleting.item.id);
        festivities.reload();
      }
      toast.success(`«${deleting.item.name}» eliminado.`);
      setDeleting(null);
    }, 'No se pudo eliminar');
  };

  return (
    <>
      <PageHeader
        title={data.name}
        description={`/destinos/${data.slug}`}
        breadcrumbs={[{ label: 'Contenido' }, { label: 'Destinos', to: '/admin/destinations' }, { label: data.name }]}
        actions={
          <>
            {data.status === 'ACTIVE' && (
              <Button variant="secondary" to={`/destinos/${data.slug}`} icon={<ExternalLink className="h-4 w-4" />}>
                Ver en la web
              </Button>
            )}
            <Button variant="outline" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditingDestination(true)}>
              Editar datos
            </Button>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-1">
          <CardHeader title="Imagen principal" description="Portada de la tarjeta y del encabezado de la página." />
          <ImageUploadField
            label="Imagen"
            hint="JPG, PNG o WebP · máx. 5 MB · recomendado horizontal, 1600 px de ancho."
            currentUrl={mediaUrl(data.hero_image)}
            busy={busy === 'hero'}
            layout="stacked"
            previewClassName="h-40"
            onSelect={(file) =>
              void withBusy('hero', async () => {
                destination.setData(await destinationService.uploadImage(data.id, file));
                toast.success('Imagen principal actualizada.');
              }, 'No se pudo subir la imagen')
            }
            onRemove={() =>
              void withBusy('hero', async () => {
                destination.setData(await destinationService.removeImage(data.id));
                toast.success('Imagen principal quitada.');
              }, 'No se pudo quitar la imagen')
            }
          />
          {/* FASE 17B · imagen de fondo de la sección «Calendario festivo». */}
          <div className="mt-6 border-t border-border pt-5">
            <ImageUploadField
              label="Imagen del calendario festivo"
              hint="JPG, PNG o WebP · máx. 5 MB · se ve a la derecha del panel naranja."
              currentUrl={mediaUrl(data.festivities_image)}
              busy={busy === 'festivities'}
              layout="stacked"
              previewClassName="h-32"
              onSelect={(file) =>
                void withBusy('festivities', async () => {
                  destination.setData(await destinationService.uploadFestivitiesImage(data.id, file));
                  toast.success('Imagen del calendario festivo actualizada.');
                }, 'No se pudo subir la imagen')
              }
              onRemove={() =>
                void withBusy('festivities', async () => {
                  destination.setData(await destinationService.removeFestivitiesImage(data.id));
                  toast.success('Imagen del calendario festivo quitada.');
                }, 'No se pudo quitar la imagen')
              }
            />
          </div>

          <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4 text-sm">
            <Info label="Estado" value={<StatusBadge status={data.status} />} />
            <Info label="Precio desde" value={data.price_from === null ? '—' : formatCurrency(data.price_from)} />
            <Info label="Orden" value={String(data.display_order)} />
            <Info label="Subtítulo" value={data.subtitle ?? '—'} />
            <Info label="Ciudad" value={data.location_city ?? 'Sin asociar'} />
            <Info label="Origen sugerido" value={data.origin_city ?? 'Sin asociar'} />
          </dl>
        </Card>

        <div className="space-y-6 xl:col-span-2">
          {/* Qué visitar ------------------------------------------------------- */}
          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader
                title="Qué visitar"
                description="Atractivos turísticos del destino."
                action={
                  <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setAttractionForm({ open: true, item: null })}>
                    Agregar atractivo
                  </Button>
                }
              />
            </div>
            {attractions.error ? (
              <ErrorState error={attractions.error} onRetry={attractions.reload} />
            ) : attractions.loading ? (
              <LoadingState />
            ) : attractionList.length === 0 ? (
              <EmptyState icon={<Landmark className="h-7 w-7" />} title="Sin atractivos" description="Agrega los lugares que vale la pena visitar." />
            ) : (
              <ul className="divide-y divide-border">
                {attractionList.map((item, index) => (
                  <li key={item.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
                    <ChildImage
                      item={item}
                      busy={busy === `attraction-${item.id}`}
                      onUpload={(file) =>
                        void withBusy(`attraction-${item.id}`, async () => {
                          await attractionService.uploadImage(item.id, file);
                          attractions.reload();
                        }, 'No se pudo subir la imagen')
                      }
                      onRemove={() =>
                        void withBusy(`attraction-${item.id}`, async () => {
                          await attractionService.removeImage(item.id);
                          attractions.reload();
                        }, 'No se pudo quitar la imagen')
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 font-semibold text-ink">
                        {item.name} {item.status === 'INACTIVE' && <Badge tone="neutral">Oculto</Badge>}
                      </p>
                      {item.description && <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm text-muted">{item.description}</p>}
                    </div>
                    <ChildActions
                      name={item.name}
                      active={item.status === 'ACTIVE'}
                      first={index === 0}
                      last={index === attractionList.length - 1}
                      disabled={busy !== null}
                      onUp={() => void reorder(attractionList, item, -1, (ids) => attractionService.reorder(data.id, ids), attractions.reload)}
                      onDown={() => void reorder(attractionList, item, 1, (ids) => attractionService.reorder(data.id, ids), attractions.reload)}
                      onEdit={() => setAttractionForm({ open: true, item })}
                      onToggle={() =>
                        void withBusy(`attraction-${item.id}`, async () => {
                          await attractionService.update(item.id, { status: item.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' });
                          attractions.reload();
                        }, 'No se pudo cambiar el estado')
                      }
                      onDelete={() => setDeleting({ kind: 'attraction', item })}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Calendario festivo ---------------------------------------------- */}
          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader
                title="Calendario festivo"
                description="Fiestas y celebraciones del destino."
                action={
                  <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setFestivityForm({ open: true, item: null })}>
                    Agregar festividad
                  </Button>
                }
              />
            </div>
            {festivities.error ? (
              <ErrorState error={festivities.error} onRetry={festivities.reload} />
            ) : festivities.loading ? (
              <LoadingState />
            ) : festivityList.length === 0 ? (
              <EmptyState icon={<CalendarDays className="h-7 w-7" />} title="Sin festividades" description="Agrega las celebraciones del destino." />
            ) : (
              <ul className="divide-y divide-border">
                {festivityList.map((item, index) => (
                  <li key={item.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
                    <span className="flex h-12 w-24 shrink-0 items-center justify-center rounded-lg bg-brand-50 px-2 text-center text-xs font-bold uppercase text-brand-700">
                      {item.date_label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 font-semibold text-ink">
                        {item.name} {item.status === 'INACTIVE' && <Badge tone="neutral">Oculta</Badge>}
                      </p>
                      {item.description && <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm text-muted">{item.description}</p>}
                    </div>
                    <ChildActions
                      name={item.name}
                      active={item.status === 'ACTIVE'}
                      first={index === 0}
                      last={index === festivityList.length - 1}
                      disabled={busy !== null}
                      onUp={() => void reorder(festivityList, item, -1, (ids) => festivityService.reorder(data.id, ids), festivities.reload)}
                      onDown={() => void reorder(festivityList, item, 1, (ids) => festivityService.reorder(data.id, ids), festivities.reload)}
                      onEdit={() => setFestivityForm({ open: true, item })}
                      onToggle={() =>
                        void withBusy(`festivity-${item.id}`, async () => {
                          await festivityService.update(item.id, { status: item.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' });
                          festivities.reload();
                        }, 'No se pudo cambiar el estado')
                      }
                      onDelete={() => setDeleting({ kind: 'festivity', item })}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <ResourceForm
        open={editingDestination}
        onClose={() => setEditingDestination(false)}
        onSubmit={async (values) => {
          destination.setData(await destinationService.update(data.id, destinationPayload(values)));
          toast.success('Destino actualizado.');
        }}
        title={`Editar «${data.name}»`}
        description="Cambiar el nombre no cambia la URL publicada."
        fields={destinationFields(locations.data?.data ?? [])}
        size="lg"
        initialValues={data as unknown as Record<string, unknown>}
      />

      <ResourceForm
        open={attractionForm.open}
        onClose={() => setAttractionForm({ open: false, item: null })}
        onSubmit={async (values) => {
          const payload = childPayload(values);
          if (attractionForm.item) await attractionService.update(attractionForm.item.id, payload);
          else await attractionService.create({ ...payload, destination_id: data.id, display_order: payload.display_order ?? attractionList.length + 1 });
          toast.success(attractionForm.item ? 'Atractivo actualizado.' : 'Atractivo agregado. Ya puedes subir su imagen.');
          attractions.reload();
        }}
        title={attractionForm.item ? `Editar «${attractionForm.item.name}»` : 'Agregar atractivo'}
        fields={ATTRACTION_FIELDS}
        initialValues={attractionForm.item ? (attractionForm.item as unknown as Record<string, unknown>) : { status: 'ACTIVE' }}
      />

      <ResourceForm
        open={festivityForm.open}
        onClose={() => setFestivityForm({ open: false, item: null })}
        onSubmit={async (values) => {
          const payload = childPayload(values);
          if (festivityForm.item) await festivityService.update(festivityForm.item.id, payload);
          else await festivityService.create({ ...payload, destination_id: data.id, display_order: payload.display_order ?? festivityList.length + 1 });
          toast.success(festivityForm.item ? 'Festividad actualizada.' : 'Festividad agregada.');
          festivities.reload();
        }}
        title={festivityForm.item ? `Editar «${festivityForm.item.name}»` : 'Agregar festividad'}
        fields={FESTIVITY_FIELDS}
        initialValues={festivityForm.item ? (festivityForm.item as unknown as Record<string, unknown>) : { status: 'ACTIVE' }}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        loading={busy === 'delete'}
        title={deleting?.kind === 'festivity' ? 'Eliminar festividad' : 'Eliminar atractivo'}
        confirmLabel="Eliminar"
        message={<>Se eliminará «{deleting?.item.name}»{deleting?.kind === 'attraction' ? ' y su imagen' : ''}. Esta acción no se puede deshacer.</>}
      />
    </>
  );
}

function Info({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 truncate text-ink">{value}</dd>
    </div>
  );
}

function ChildImage({ item, busy, onUpload, onRemove }: { item: DestinationAttraction; busy: boolean; onUpload: (file: File) => void; onRemove: () => void }) {
  const [failed, setFailed] = useState(false);
  const url = failed ? null : mediaUrl(item.image);
  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      <span className="flex h-20 w-28 items-center justify-center overflow-hidden rounded-lg bg-slate-100">
        {url ? <img src={url} alt={item.name} onError={() => setFailed(true)} className="h-full w-full object-cover" /> : <ImageOff className="h-6 w-6 text-slate-300" aria-hidden />}
      </span>
      <label className="cursor-pointer text-center text-xs font-semibold text-brand-600 hover:underline">
        {busy ? 'Subiendo…' : url ? 'Reemplazar' : 'Subir imagen'}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) onUpload(file);
          }}
        />
      </label>
      {url && (
        <button type="button" onClick={onRemove} disabled={busy} className="text-xs text-muted hover:text-danger-600">
          Quitar
        </button>
      )}
    </div>
  );
}

function ChildActions({
  name,
  active,
  first,
  last,
  disabled,
  onUp,
  onDown,
  onEdit,
  onToggle,
  onDelete,
}: {
  name: string;
  active: boolean;
  first: boolean;
  last: boolean;
  disabled: boolean;
  onUp: () => void;
  onDown: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const base = 'rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30';
  return (
    <span className="flex shrink-0 items-center gap-0.5 self-end sm:self-start">
      <button type="button" className={base} aria-label={`Subir ${name}`} title="Subir" disabled={disabled || first} onClick={onUp}>
        <ArrowUp className="h-4 w-4" />
      </button>
      <button type="button" className={base} aria-label={`Bajar ${name}`} title="Bajar" disabled={disabled || last} onClick={onDown}>
        <ArrowDown className="h-4 w-4" />
      </button>
      <button type="button" className={base} aria-label={`Editar ${name}`} title="Editar" onClick={onEdit}>
        <Pencil className="h-4 w-4" />
      </button>
      <button type="button" className={base} aria-label={active ? `Ocultar ${name}` : `Publicar ${name}`} title={active ? 'Ocultar' : 'Publicar'} disabled={disabled} onClick={onToggle}>
        {active ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
      <button type="button" className="rounded-lg p-1.5 text-slate-500 transition hover:bg-danger-50 hover:text-danger-600" aria-label={`Eliminar ${name}`} title="Eliminar" onClick={onDelete}>
        <Trash2 className="h-4 w-4" />
      </button>
    </span>
  );
}
