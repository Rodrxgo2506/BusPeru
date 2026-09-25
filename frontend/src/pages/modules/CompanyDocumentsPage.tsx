import {
  AlertTriangle,
  Check,
  Clock,
  Download,
  FileText,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  PageHeader,
  StatusBadge,
  Textarea,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { ApiError } from '@/services/api';
import { companyDocumentService } from '@/services';
import type { CompanyDocument, CompanyDocumentType, VerificationStage } from '@/types';
import { cn } from '@/utils/cn';
import { formatDateTime } from '@/utils/format';

/**
 * Documentos de verificación de la empresa (mockups 13 y 14).
 *
 * La empresa la resuelve siempre el backend desde la sesión: esta pantalla nunca envía
 * `company_id`. Los archivos tampoco tienen URL pública — se descargan con el token, así
 * que se piden como Blob y se abren desde memoria.
 */

const DOCUMENT_TYPES: Array<{ value: CompanyDocumentType; label: string; hint: string; required: boolean }> = [
  { value: 'RUC', label: 'Ficha RUC', hint: 'Ficha RUC vigente emitida por SUNAT.', required: true },
  { value: 'LICENSE', label: 'Licencia de operación', hint: 'Autorización del MTC para transporte interprovincial.', required: true },
  { value: 'INSURANCE', label: 'Póliza de seguro', hint: 'SOAT o póliza vigente de la flota.', required: true },
  { value: 'LEGAL_REP_ID', label: 'Documento del representante legal', hint: 'DNI o carné de extranjería del representante.', required: true },
  { value: 'OTHER', label: 'Otro documento', hint: 'Cualquier documento adicional que quieras adjuntar.', required: false },
];

const ACCEPT = '.pdf,.jpg,.jpeg,.png';
const MAX_MB = 5;

export function CompanyDocumentsPage() {
  const { hasPermission } = useAuth();
  const toast = useToast();

  const documents = useAsync(() => companyDocumentService.list(), []);
  const verification = useAsync(() => companyDocumentService.verificationStatus(), []);

  const [uploading, setUploading] = useState<CompanyDocumentType | null>(null);
  const [deleting, setDeleting] = useState<CompanyDocument | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  const canEdit = hasPermission('companies.update');
  const rows = documents.data ?? [];
  const byType = new Map(rows.map((document) => [document.type, document]));

  const reload = () => {
    documents.reload();
    verification.reload();
  };

  const upload = async (type: CompanyDocumentType, file: File) => {
    if (file.size > MAX_MB * 1024 * 1024) {
      toast.error('El archivo es demasiado grande', `El máximo permitido es ${MAX_MB} MB.`);
      return;
    }

    setUploading(type);
    try {
      await companyDocumentService.upload(file, type);
      toast.success('Documento enviado', 'Quedó pendiente de revisión por nuestro equipo.');
      reload();
    } catch (error) {
      toast.error('No se pudo subir el documento', error instanceof ApiError ? error.message : undefined);
    } finally {
      setUploading(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      await companyDocumentService.remove(deleting.id);
      toast.success('Documento eliminado.');
      setDeleting(null);
      reload();
    } catch (error) {
      toast.error('No se pudo eliminar', error instanceof ApiError ? error.message : undefined);
    } finally {
      setDeletingBusy(false);
    }
  };

  const rejected = rows.filter((document) => document.status === 'REJECTED');

  return (
    <>
      <PageHeader
        title="Verificación de empresa"
        description="Sube tus documentos legales para completar la verificación de tu empresa."
        breadcrumbs={[{ label: 'Portal Empresa' }, { label: 'Verificación' }]}
      />

      {documents.error ? (
        <Card padded={false}>
          <ErrorState error={documents.error} onRetry={reload} />
        </Card>
      ) : documents.loading ? (
        <LoadingState />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-6">
            {rejected.length > 0 && (
              <Card className="border-danger-100 bg-danger-50/60">
                <div className="flex gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger-600" />
                  <div>
                    <p className="font-semibold text-ink">
                      {rejected.length === 1
                        ? 'Un documento fue rechazado'
                        : `${rejected.length} documentos fueron rechazados`}
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      Revisa el motivo en cada uno y vuelve a subirlo corregido. Al reemplazarlo pasa de nuevo a revisión.
                    </p>
                  </div>
                </div>
              </Card>
            )}

            <section className="space-y-3">
              <h2 className="text-lg font-bold text-ink">Documentos legales</h2>
              {DOCUMENT_TYPES.map((type) => (
                <DocumentCard
                  key={type.value}
                  definition={type}
                  document={byType.get(type.value) ?? null}
                  canEdit={canEdit}
                  uploading={uploading === type.value}
                  onUpload={(file) => void upload(type.value, file)}
                  onDelete={(document) => setDeleting(document)}
                />
              ))}
            </section>

            {rows.length === 0 && !canEdit && (
              <Card padded={false}>
                <EmptyState
                  title="Todavía no hay documentos"
                  description="Un administrador de la empresa debe subir la documentación legal."
                  icon={<FileText className="h-7 w-7" />}
                />
              </Card>
            )}
          </div>

          <aside className="min-w-0 space-y-4">
            <VerificationTimeline
              stages={verification.data?.stages ?? []}
              loading={verification.loading}
              error={verification.error}
              onRetry={verification.reload}
            />

            <Card>
              <h3 className="mb-3 flex items-center gap-2 font-semibold text-ink">
                <ShieldCheck className="h-5 w-5 text-success-600" />
                Sobre tus documentos
              </h3>
              <ul className="space-y-2 text-sm text-slate-600">
                {[
                  'Formatos aceptados: PDF, JPG y PNG.',
                  `Tamaño máximo por archivo: ${MAX_MB} MB.`,
                  'Solo tu empresa y nuestro equipo de verificación pueden verlos.',
                  'Los archivos no tienen enlace público: se descargan desde esta pantalla.',
                ].map((item) => (
                  <li key={item} className="flex gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success-600" />
                    {item}
                  </li>
                ))}
              </ul>
            </Card>
          </aside>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        loading={deletingBusy}
        title="Eliminar documento"
        confirmLabel="Sí, eliminar"
        message="El archivo se borrará definitivamente y tendrás que volver a subirlo para completar la verificación."
      />
    </>
  );
}

/** Tarjeta de un tipo de documento: subir el primero, reemplazar o ver el motivo del rechazo. */
function DocumentCard({
  definition,
  document,
  canEdit,
  uploading,
  onUpload,
  onDelete,
}: {
  definition: { value: CompanyDocumentType; label: string; hint: string; required: boolean };
  document: CompanyDocument | null;
  canEdit: boolean;
  uploading: boolean;
  onUpload: (file: File) => void;
  onDelete: (document: CompanyDocument) => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          <span
            className={cn(
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg',
              document?.status === 'VERIFIED'
                ? 'bg-success-100 text-success-700'
                : document?.status === 'REJECTED'
                  ? 'bg-danger-100 text-danger-700'
                  : document
                    ? 'bg-warning-100 text-warning-600'
                    : 'bg-slate-100 text-slate-500',
            )}
          >
            <FileText className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold text-ink">{definition.label}</p>
              {document ? <StatusBadge status={document.status} /> : <Badge tone="neutral">Sin subir</Badge>}
              {definition.required && !document && <Badge tone="warning">Requerido</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted">{definition.hint}</p>
            {document && (
              <p className="mt-2 text-xs text-muted">
                Subido el {formatDateTime(document.created_at)}
                {document.reviewed_at && ` · Revisado el ${formatDateTime(document.reviewed_at)}`}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {document && <DownloadButton document={document} />}
          {canEdit && (
            <>
              <input
                ref={input}
                type="file"
                accept={ACCEPT}
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  // El input se limpia para poder volver a elegir el mismo archivo.
                  event.target.value = '';
                  if (file) onUpload(file);
                }}
              />
              <Button
                variant={document ? 'outline' : 'primary'}
                size="sm"
                loading={uploading}
                icon={<Upload className="h-4 w-4" />}
                onClick={() => input.current?.click()}
              >
                {document ? 'Reemplazar' : 'Subir'}
              </Button>
              {document && document.status !== 'VERIFIED' && (
                <button
                  type="button"
                  onClick={() => onDelete(document)}
                  className="rounded-lg p-2 text-slate-500 transition hover:bg-danger-50 hover:text-danger-600"
                  aria-label={`Eliminar ${definition.label}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {document?.status === 'REJECTED' && document.notes && (
        <div className="mt-4 rounded-lg border border-danger-100 bg-danger-50/60 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-danger-700">Motivo del rechazo</p>
          <p className="mt-1 text-sm text-slate-700">{document.notes}</p>
          <p className="mt-2 text-xs text-muted">Sube una versión corregida para volver a enviarlo a revisión.</p>
        </div>
      )}
    </Card>
  );
}

/** Descarga el archivo con el token de sesión y lo abre desde memoria. */
function DownloadButton({ document: row }: { document: CompanyDocument }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    try {
      const blob = await companyDocumentService.file(row.id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      // Se libera en el siguiente ciclo, cuando la pestaña ya tomó el contenido.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      toast.error('No se pudo abrir el archivo', error instanceof ApiError ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant="ghost" size="sm" loading={busy} icon={<Download className="h-4 w-4" />} onClick={() => void download()}>
      Ver
    </Button>
  );
}

const STAGE_STYLES: Record<VerificationStage['status'], { dot: string; icon: JSX.Element | null; label: string }> = {
  DONE: { dot: 'bg-success-600 text-white', icon: <Check className="h-3.5 w-3.5" />, label: 'Completado' },
  IN_PROGRESS: { dot: 'bg-brand-600 text-white', icon: <Clock className="h-3.5 w-3.5" />, label: 'En proceso' },
  BLOCKED: { dot: 'bg-danger-600 text-white', icon: <X className="h-3.5 w-3.5" />, label: 'Requiere tu acción' },
  PENDING: { dot: 'bg-slate-200 text-slate-500', icon: null, label: 'Pendiente' },
};

/** Línea de tiempo del mockup 14. La deriva el backend; aquí solo se dibuja. */
function VerificationTimeline({
  stages,
  loading,
  error,
  onRetry,
}: {
  stages: VerificationStage[];
  loading: boolean;
  error: ApiError | null;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader title="Estado de verificación" description="Así avanza la revisión de tu empresa." />
      {error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : loading ? (
        <LoadingState />
      ) : (
        <ol className="space-y-5">
          {stages.map((stage, index) => {
            const style = STAGE_STYLES[stage.status];
            return (
              <li key={stage.key} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold', style.dot)}>
                    {style.icon ?? index + 1}
                  </span>
                  {index < stages.length - 1 && <span className="mt-1 w-px flex-1 bg-border" />}
                </div>
                <div className="min-w-0 pb-1">
                  <p className="text-sm font-semibold text-ink">{stage.label}</p>
                  <p className="mt-0.5 text-xs text-muted">{stage.description}</p>
                  <p
                    className={cn(
                      'mt-1 text-xs font-semibold',
                      stage.status === 'BLOCKED' ? 'text-danger-600' : stage.status === 'DONE' ? 'text-success-700' : 'text-muted',
                    )}
                  >
                    {style.label}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

/**
 * Revisión administrativa (Panel Admin). Muestra la bandeja de documentos pendientes de
 * todas las empresas y permite aprobar o rechazar indicando el motivo.
 */
export function DocumentReviewPage() {
  const toast = useToast();
  const pending = useAsync(() => companyDocumentService.pendingReview(), []);

  const [reviewing, setReviewing] = useState<CompanyDocument | null>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<'VERIFIED' | 'REJECTED' | null>(null);

  const resolve = async (status: 'VERIFIED' | 'REJECTED') => {
    if (!reviewing) return;
    if (status === 'REJECTED' && !notes.trim()) {
      toast.error('Indica el motivo del rechazo', 'La empresa lo necesita para poder corregir el documento.');
      return;
    }

    setBusy(status);
    try {
      await companyDocumentService.review(reviewing.id, status, notes.trim() || undefined);
      toast.success(status === 'VERIFIED' ? 'Documento verificado.' : 'Documento rechazado.');
      setReviewing(null);
      setNotes('');
      pending.reload();
    } catch (error) {
      toast.error('No se pudo registrar la revisión', error instanceof ApiError ? error.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const rows = pending.data ?? [];

  return (
    <>
      <PageHeader
        title="Verificación de empresas"
        description="Revisa la documentación legal que envían las empresas antes de aprobarlas."
        breadcrumbs={[{ label: 'Administración' }, { label: 'Verificación de empresas' }]}
      />

      {pending.error ? (
        <Card padded={false}>
          <ErrorState error={pending.error} onRetry={pending.reload} />
        </Card>
      ) : pending.loading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            title="No hay documentos pendientes"
            description="Cuando una empresa envíe documentación, aparecerá aquí para su revisión."
            icon={<ShieldCheck className="h-7 w-7" />}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((document) => (
            <Card key={document.id}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-semibold text-ink">{document.company_name}</p>
                  <p className="mt-1 text-sm text-muted">
                    {DOCUMENT_TYPES.find((type) => type.value === document.type)?.label ?? document.type} · enviado el{' '}
                    {formatDateTime(document.created_at)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <DownloadButton document={document} />
                  <Button
                    size="sm"
                    onClick={() => {
                      setReviewing(document);
                      setNotes('');
                    }}
                  >
                    Revisar
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={reviewing !== null}
        onClose={() => setReviewing(null)}
        title="Revisar documento"
        description={
          reviewing
            ? `${DOCUMENT_TYPES.find((type) => type.value === reviewing.type)?.label ?? reviewing.type} de ${reviewing.company_name}`
            : undefined
        }
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setReviewing(null)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              loading={busy === 'REJECTED'}
              icon={<X className="h-4 w-4" />}
              onClick={() => void resolve('REJECTED')}
            >
              Rechazar
            </Button>
            <Button loading={busy === 'VERIFIED'} icon={<Check className="h-4 w-4" />} onClick={() => void resolve('VERIFIED')}>
              Verificar
            </Button>
          </div>
        }
      >
        {reviewing && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">Archivo enviado</p>
                <p className="text-xs text-muted">Ábrelo para comprobarlo antes de resolver.</p>
              </div>
              <DownloadButton document={reviewing} />
            </div>

            <Textarea
              label="Comentario"
              hint="Obligatorio si rechazas el documento: es lo que verá la empresa para corregirlo."
              rows={4}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Ej: La ficha RUC está vencida, adjunta una emitida en los últimos 30 días."
            />
          </div>
        )}
      </Modal>
    </>
  );
}
