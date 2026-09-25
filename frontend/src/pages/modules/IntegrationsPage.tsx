import { AlertTriangle, Check, Info, Plug, Settings2, ShieldCheck, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Modal,
  PageHeader,
  Tabs,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { ApiError } from '@/services/api';
import { integrationService } from '@/services';
import type { Integration, IntegrationCategory, IntegrationStatus } from '@/types';
import { cn } from '@/utils/cn';
import { formatDateTime } from '@/utils/format';

/**
 * Integraciones (mockup 37).
 *
 * ALCANCE: esta pantalla **solo guarda configuración**. Conectar una integración almacena
 * sus credenciales cifradas; no activa cobros, ni webhooks, ni ninguna llamada al proveedor.
 * La interfaz lo dice de forma explícita en vez de aparentar que la integración opera.
 *
 * Las credenciales nunca vuelven completas de la API: se muestran los cuatro últimos
 * caracteres y los campos se dejan vacíos, de modo que escribir en uno lo reemplaza y
 * dejarlo en blanco conserva el valor guardado.
 */

const TABS: Array<{ id: string; label: string; categories: IntegrationCategory[] }> = [
  { id: 'pagos', label: 'Pasarela de pagos', categories: ['PAYMENT_GATEWAY'] },
  { id: 'facturacion', label: 'Facturación electrónica', categories: ['INVOICING'] },
  { id: 'otras', label: 'Otras integraciones', categories: ['ANALYTICS', 'MESSAGING', 'OTHER'] },
];

const STATUS_META: Record<IntegrationStatus, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  CONNECTED: { label: 'Conectada', tone: 'success' },
  NEEDS_CONFIG: { label: 'Requiere configuración', tone: 'warning' },
  DISCONNECTED: { label: 'No conectada', tone: 'neutral' },
};

export function IntegrationsPage({ scope = 'company' }: { scope?: 'company' | 'admin' }) {
  const { hasPermission, hasRole } = useAuth();
  const toast = useToast();

  const data = useAsync(() => integrationService.list(scope), [scope]);

  const [tab, setTab] = useState('pagos');
  const [editing, setEditing] = useState<Integration | null>(null);
  const [deleting, setDeleting] = useState<Integration | null>(null);
  const [busy, setBusy] = useState(false);

  // El Panel Admin gestiona la integración de plataforma; ahí se exige además el rol.
  const canEdit = hasPermission('companies.update') && (scope === 'company' || hasRole('ADMIN'));

  const integrations = useMemo(() => data.data?.integrations ?? [], [data.data]);
  const encryptionReady = data.data?.encryption_configured ?? false;

  const visible = useMemo(() => {
    const categories = TABS.find((entry) => entry.id === tab)?.categories ?? [];
    return integrations.filter((integration) => categories.includes(integration.category));
  }, [integrations, tab]);

  const summary = useMemo(
    () => ({
      connected: integrations.filter((i) => i.status === 'CONNECTED').length,
      needsConfig: integrations.filter((i) => i.status === 'NEEDS_CONFIG').length,
      disconnected: integrations.filter((i) => i.status === 'DISCONNECTED').length,
      total: integrations.length,
    }),
    [integrations],
  );

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      data.reload();
      return true;
    } catch (error) {
      toast.error('No se pudo completar la acción', error instanceof ApiError ? error.message : undefined);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Integraciones"
        description="Conecta BusPerú con herramientas y servicios para potenciar tu negocio."
        breadcrumbs={[{ label: scope === 'admin' ? 'Administración' : 'Portal Empresa' }, { label: 'Integraciones' }]}
      />

      {/*
        Aviso permanente y deliberado: sin él, un badge de "Conectada" daría a entender que
        la pasarela está operando, que es justo lo que todavía no ocurre.
      */}
      <Card className="mb-6 border-info-100 bg-info-50/60">
        <div className="flex gap-3">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-info-600" />
          <div>
            <p className="font-semibold text-ink">Por ahora esto solo guarda la configuración</p>
            <p className="mt-1 text-sm text-slate-600">
              Conectar una integración almacena sus credenciales de forma cifrada, pero{' '}
              <strong>el procesamiento de operaciones todavía no está activo</strong>: ningún cobro, notificación ni
              informe se envía aún a estos proveedores.
            </p>
          </div>
        </div>
      </Card>

      {!encryptionReady && !data.loading && (
        <Card className="mb-6 border-warning-100 bg-warning-50/60">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning-600" />
            <div>
              <p className="font-semibold text-ink">El cifrado de credenciales no está configurado</p>
              <p className="mt-1 text-sm text-slate-600">
                Este servidor no tiene clave de cifrado, así que no es posible guardar credenciales. No se almacenará
                nada en texto plano. Contacta con el administrador del sistema.
              </p>
            </div>
          </div>
        </Card>
      )}

      <Tabs tabs={TABS.map(({ id, label }) => ({ id, label }))} active={tab} onChange={setTab} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-3">
          {data.error ? (
            <Card padded={false}>
              <ErrorState error={data.error} onRetry={data.reload} />
            </Card>
          ) : data.loading ? (
            <LoadingState />
          ) : visible.length === 0 ? (
            <Card padded={false}>
              <EmptyState
                title="No hay integraciones en esta categoría"
                description="Aquí aparecerán los proveedores disponibles cuando se incorporen."
                icon={<Plug className="h-7 w-7" />}
              />
            </Card>
          ) : (
            visible.map((integration) => (
              <IntegrationCard
                key={integration.provider}
                integration={integration}
                canEdit={canEdit && encryptionReady}
                busy={busy}
                onConfigure={() => setEditing(integration)}
                onConnect={() =>
                  void run(() => integrationService.connect(integration.provider, scope), `${integration.label} conectada.`)
                }
                onDisconnect={() =>
                  void run(
                    () => integrationService.disconnect(integration.provider, scope),
                    `${integration.label} desconectada. Sus credenciales se eliminaron.`,
                  )
                }
                onDelete={() => setDeleting(integration)}
              />
            ))
          )}
        </div>

        <aside className="min-w-0 space-y-4">
          <Card>
            <CardHeader title="Estado de integraciones" />
            <p className="text-3xl font-bold text-ink">
              {summary.connected}
              <span className="text-base font-medium text-muted">/{summary.total}</span>
            </p>
            <p className="text-xs text-muted">configuradas</p>
            <ul className="mt-4 space-y-2 text-sm">
              <SummaryRow tone="bg-success-500" label="Conectadas" value={summary.connected} />
              <SummaryRow tone="bg-warning-500" label="Requieren configuración" value={summary.needsConfig} />
              <SummaryRow tone="bg-slate-300" label="No conectadas" value={summary.disconnected} />
            </ul>
          </Card>

          <Card>
            <h3 className="mb-3 flex items-center gap-2 font-semibold text-ink">
              <ShieldCheck className="h-5 w-5 text-success-600" />
              Seguridad y confianza
            </h3>
            <ul className="space-y-2 text-sm text-slate-600">
              {[
                'Las credenciales se cifran antes de guardarse; nunca se almacenan en texto plano.',
                'Una vez guardadas no vuelven a mostrarse: solo verás sus últimos cuatro caracteres.',
                'Al desconectar una integración, sus credenciales se eliminan.',
                'Cada cambio queda registrado en la auditoría, sin guardar los valores.',
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

      <ConfigureModal
        integration={editing}
        scope={scope}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          data.reload();
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        loading={busy}
        onConfirm={async () => {
          if (!deleting) return;
          const ok = await run(
            () => integrationService.remove(deleting.provider, scope),
            `Se eliminó la configuración de ${deleting.label}.`,
          );
          if (ok) setDeleting(null);
        }}
        title="Eliminar integración"
        confirmLabel="Sí, eliminar"
        message="Se borrará la configuración y sus credenciales. Tendrás que volver a introducirlas para conectarla de nuevo."
      />
    </>
  );
}

function SummaryRow({ tone, label, value }: { tone: string; label: string; value: number }) {
  return (
    <li className="flex items-center gap-2">
      <span className={cn('h-2.5 w-2.5 rounded-full', tone)} />
      <span className="font-semibold text-ink">{value}</span>
      <span className="text-muted">{label}</span>
    </li>
  );
}

function IntegrationCard({
  integration,
  canEdit,
  busy,
  onConfigure,
  onConnect,
  onDisconnect,
  onDelete,
}: {
  integration: Integration;
  canEdit: boolean;
  busy: boolean;
  onConfigure: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onDelete: () => void;
}) {
  const meta = STATUS_META[integration.status];
  const configured = integration.configured_fields.length > 0;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
            <Plug className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold text-ink">{integration.label}</p>
              <Badge tone={meta.tone}>{meta.label}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted">{integration.description}</p>

            {integration.status === 'CONNECTED' && integration.connected_at && (
              <p className="mt-2 text-xs text-muted">Configurada el {formatDateTime(integration.connected_at)}</p>
            )}
            {integration.missing_fields.length > 0 && (
              <p className="mt-2 text-xs font-medium text-warning-600">
                Faltan datos: {integration.missing_fields.join(', ')}
              </p>
            )}
            {configured && (
              <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
                {integration.fields.map((field) => (
                  <div key={field.name} className="flex gap-1.5">
                    <dt className="text-muted">{field.label}:</dt>
                    <dd className="font-medium text-ink">{integration.credentials_preview[field.name] ?? '—'}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>

        {canEdit && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {integration.status === 'CONNECTED' ? (
              <Button variant="outline" size="sm" loading={busy} onClick={onDisconnect}>
                Desconectar
              </Button>
            ) : (
              <Button size="sm" loading={busy} disabled={integration.missing_fields.length > 0} onClick={onConnect}>
                Conectar
              </Button>
            )}
            <Button variant="ghost" size="sm" icon={<Settings2 className="h-4 w-4" />} onClick={onConfigure}>
              Configurar
            </Button>
            {configured && (
              <button
                type="button"
                onClick={onDelete}
                className="rounded-lg p-2 text-slate-500 transition hover:bg-danger-50 hover:text-danger-600"
                aria-label={`Eliminar ${integration.label}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/** Formulario de credenciales. Se envía vacío lo que no se quiera cambiar. */
function ConfigureModal({
  integration,
  scope,
  onClose,
  onSaved,
}: {
  integration: Integration | null;
  scope: 'company' | 'admin';
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!integration) return;
    setSaving(true);
    try {
      await integrationService.save(integration.provider, values, scope);
      toast.success(`Configuración de ${integration.label} guardada.`, 'Recuerda que el procesamiento aún no está activo.');
      setValues({});
      onSaved();
    } catch (error) {
      toast.error('No se pudo guardar', error instanceof ApiError ? error.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={integration !== null}
      onClose={() => {
        setValues({});
        onClose();
      }}
      title={integration ? `Configurar ${integration.label}` : ''}
      description="Las credenciales se cifran antes de guardarse y no vuelven a mostrarse."
      footer={
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setValues({});
              onClose();
            }}
          >
            Cancelar
          </Button>
          <Button loading={saving} onClick={() => void submit()}>
            Guardar
          </Button>
        </div>
      }
    >
      {integration && (
        <div className="space-y-4">
          {integration.fields.map((field) => {
            const stored = integration.credentials_preview[field.name];
            return (
              <Input
                key={field.name}
                label={field.label}
                type={field.secret ? 'password' : 'text'}
                autoComplete="off"
                value={values[field.name] ?? ''}
                onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
                placeholder={stored ? `Guardada (${stored}) — déjalo vacío para conservarla` : 'Sin configurar'}
                hint={field.required ? undefined : 'Opcional'}
              />
            );
          })}

          <p className="rounded-lg bg-slate-50 p-3 text-xs text-muted">
            Guardar la configuración no activa el procesamiento. Estas credenciales quedan almacenadas de forma segura
            para cuando la integración entre en funcionamiento.
          </p>
        </div>
      )}
    </Modal>
  );
}
