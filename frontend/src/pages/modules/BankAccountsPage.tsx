import { Building2, Check, Landmark, Pencil, Plus, ShieldCheck, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ResourceForm, type FormField } from '@/components/common/ResourceForm';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StatusBadge,
  Tabs,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { ApiError } from '@/services/api';
import { bankAccountService } from '@/services';
import type { BankAccount } from '@/types';
import { formatDateTime } from '@/utils/format';

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  CHECKING: 'Cuenta corriente',
  SAVINGS: 'Cuenta de ahorros',
};

const CURRENCY_LABELS: Record<string, string> = {
  PEN: 'Soles (PEN)',
  USD: 'Dólares (USD)',
};

const FORM_FIELDS: FormField[] = [
  { name: 'bank_name', label: 'Banco', required: true, placeholder: 'Ej: Banco de Crédito del Perú (BCP)' },
  {
    name: 'account_type',
    label: 'Tipo de cuenta',
    type: 'select',
    required: true,
    options: Object.entries(ACCOUNT_TYPE_LABELS).map(([value, label]) => ({ value, label })),
  },
  {
    name: 'currency',
    label: 'Moneda',
    type: 'select',
    required: true,
    options: Object.entries(CURRENCY_LABELS).map(([value, label]) => ({ value, label })),
  },
  { name: 'account_number', label: 'Número de cuenta', required: true, placeholder: '193-2456789-0-12' },
  { name: 'interbank_code', label: 'CCI (20 dígitos)', placeholder: '002-193-002456789012-56', hint: 'Código de cuenta interbancario' },
  { name: 'holder_name', label: 'Titular de la cuenta', required: true, full: true, placeholder: 'Razón social de tu empresa' },
  { name: 'holder_document', label: 'RUC o DNI del titular', placeholder: '20123456789' },
];

/**
 * Datos bancarios de la empresa (mockup 36).
 *
 * Los números de cuenta solo llegan completos a quien puede editarlos; para el resto de
 * roles la API devuelve `account_number: null` y solo la versión enmascarada, así que la
 * pantalla muestra lo que reciba sin decidir por su cuenta qué ocultar.
 */
export function BankAccountsPage() {
  const { hasPermission } = useAuth();
  const toast = useToast();

  const accounts = useAsync(() => bankAccountService.list(), []);
  const history = useAsync(() => bankAccountService.history(), []);

  const [tab, setTab] = useState('cuenta');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<BankAccount | null>(null);
  const [deleting, setDeleting] = useState<BankAccount | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  const canEdit = hasPermission('companies.update');
  const rows = accounts.data ?? [];
  const primary = rows.find((account) => Number(account.is_primary) === 1) ?? null;
  const additional = rows.filter((account) => account.id !== primary?.id);

  const reload = () => {
    accounts.reload();
    history.reload();
  };

  const submit = async (values: Record<string, unknown>) => {
    const payload = {
      ...values,
      interbank_code: values.interbank_code ? String(values.interbank_code) : null,
      holder_document: values.holder_document ? String(values.holder_document) : null,
    };

    if (editing) await bankAccountService.update(editing.id, payload);
    else await bankAccountService.create(payload);

    toast.success(editing ? 'Cuenta bancaria actualizada.' : 'Cuenta bancaria registrada.');
    reload();
  };

  const makePrimary = async (account: BankAccount) => {
    try {
      await bankAccountService.update(account.id, { is_primary: true });
      toast.success('Cuenta principal actualizada.');
      reload();
    } catch (error) {
      toast.error('No se pudo cambiar la cuenta principal', error instanceof ApiError ? error.message : undefined);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      await bankAccountService.remove(deleting.id);
      toast.success('Cuenta bancaria eliminada.');
      setDeleting(null);
      reload();
    } catch (error) {
      toast.error('No se pudo eliminar', error instanceof ApiError ? error.message : undefined);
    } finally {
      setDeletingBusy(false);
    }
  };

  const openForm = (account: BankAccount | null) => {
    setEditing(account);
    setFormOpen(true);
  };

  return (
    <>
      <PageHeader
        title="Datos bancarios"
        description="Gestiona la información de tu cuenta bancaria para recibir tus liquidaciones."
        breadcrumbs={[{ label: 'Portal Empresa' }, { label: 'Datos bancarios' }]}
        actions={
          canEdit ? (
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => openForm(null)}>
              Agregar cuenta
            </Button>
          ) : undefined
        }
      />

      <Tabs
        tabs={[
          { id: 'cuenta', label: 'Cuenta bancaria' },
          { id: 'titular', label: 'Titular de la cuenta' },
          { id: 'historial', label: 'Historial de cambios' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          {accounts.error ? (
            <Card padded={false}>
              <ErrorState error={accounts.error} onRetry={accounts.reload} />
            </Card>
          ) : accounts.loading ? (
            <LoadingState />
          ) : tab === 'historial' ? (
            <HistoryPanel history={history} />
          ) : tab === 'titular' ? (
            <HolderPanel account={primary} />
          ) : rows.length === 0 ? (
            <Card padded={false}>
              <EmptyState
                title="Aún no registraste una cuenta bancaria"
                description="Registra la cuenta donde quieres recibir las liquidaciones de tus ventas."
                icon={<Landmark className="h-7 w-7" />}
                action={
                  canEdit ? (
                    <Button icon={<Plus className="h-4 w-4" />} onClick={() => openForm(null)}>
                      Agregar cuenta
                    </Button>
                  ) : undefined
                }
              />
            </Card>
          ) : (
            <>
              <section>
                <div className="mb-3 flex items-center gap-3">
                  <h2 className="text-lg font-bold text-ink">Cuenta bancaria principal</h2>
                  {primary && <Badge tone="success">Activa</Badge>}
                </div>
                {primary ? (
                  <AccountCard
                    account={primary}
                    canEdit={canEdit}
                    onEdit={() => openForm(primary)}
                    onDelete={() => setDeleting(primary)}
                  />
                ) : (
                  <Card>
                    <p className="text-sm text-muted">Ninguna de tus cuentas está marcada como principal.</p>
                  </Card>
                )}
              </section>

              <section>
                <h2 className="mb-3 text-lg font-bold text-ink">Cuentas bancarias adicionales</h2>
                {additional.length === 0 ? (
                  <Card padded={false}>
                    <EmptyState
                      title="Aún no tienes cuentas bancarias adicionales"
                      description="Puedes agregar más cuentas para uso futuro."
                      icon={<Landmark className="h-7 w-7" />}
                      action={
                        canEdit ? (
                          <Button variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => openForm(null)}>
                            Agregar cuenta adicional
                          </Button>
                        ) : undefined
                      }
                    />
                  </Card>
                ) : (
                  <div className="space-y-3">
                    {additional.map((account) => (
                      <AccountCard
                        key={account.id}
                        account={account}
                        canEdit={canEdit}
                        onEdit={() => openForm(account)}
                        onDelete={() => setDeleting(account)}
                        onMakePrimary={() => void makePrimary(account)}
                      />
                    ))}
                  </div>
                )}
              </section>

              <Card className="border-info-100 bg-info-50/60">
                <h3 className="mb-3 flex items-center gap-2 font-semibold text-ink">Información importante</h3>
                <ul className="space-y-2 text-sm text-slate-600">
                  {[
                    'Asegúrate de que los datos ingresados sean correctos.',
                    'Las liquidaciones solo se realizarán a cuentas del titular de la empresa.',
                    'Los cambios en los datos bancarios pueden tardar hasta 24 horas en reflejarse.',
                    'Si tienes dudas, contáctanos en nuestro centro de soporte.',
                  ].map((item) => (
                    <li key={item} className="flex gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success-600" />
                      {item}
                    </li>
                  ))}
                </ul>
              </Card>
            </>
          )}
        </div>

        <aside className="min-w-0 space-y-4">
          <Card>
            <h3 className="mb-3 flex items-center gap-2 font-semibold text-ink">
              <ShieldCheck className="h-5 w-5 text-success-600" />
              Seguridad
            </h3>
            <ul className="space-y-2 text-sm text-slate-600">
              {[
                'Tu información bancaria está protegida y solo la ve tu empresa.',
                'Solo los administradores de tu empresa pueden editar estos datos.',
                'Cada cambio queda registrado en el historial.',
              ].map((item) => (
                <li key={item} className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success-600" />
                  {item}
                </li>
              ))}
            </ul>
          </Card>

          {primary && (
            <Card>
              <CardHeader title="Última actualización" />
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-xs text-muted">Fecha</dt>
                  <dd className="font-medium text-ink">{formatDateTime(primary.updated_at)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Estado de verificación</dt>
                  <dd>
                    <StatusBadge status={primary.status} />
                  </dd>
                </div>
              </dl>
            </Card>
          )}
        </aside>
      </div>

      <ResourceForm
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        onSubmit={submit}
        title={editing ? 'Editar cuenta bancaria' : 'Agregar cuenta bancaria'}
        description="Los datos deben coincidir con el titular de la empresa."
        fields={FORM_FIELDS}
        size="lg"
        initialValues={editing ? (editing as unknown as Record<string, unknown>) : null}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        loading={deletingBusy}
        title="Eliminar cuenta bancaria"
        confirmLabel="Sí, eliminar"
        message="Dejarás de poder recibir liquidaciones en esta cuenta. Esta acción no se puede deshacer."
      />
    </>
  );
}

function AccountCard({
  account,
  canEdit,
  onEdit,
  onDelete,
  onMakePrimary,
}: {
  account: BankAccount;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMakePrimary?: () => void;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            <Building2 className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-lg font-bold text-ink">{account.bank_name}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <StatusBadge status={account.status} />
              {Number(account.is_primary) === 1 && <Badge tone="brand">Principal</Badge>}
            </div>
          </div>
        </div>

        {canEdit && (
          <div className="flex shrink-0 items-center gap-1">
            {onMakePrimary && (
              <button
                type="button"
                onClick={onMakePrimary}
                className="rounded-lg p-2 text-slate-500 transition hover:bg-brand-50 hover:text-brand-600"
                aria-label="Marcar como principal"
                title="Marcar como principal"
              >
                <Star className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={onEdit}
              className="rounded-lg p-2 text-slate-500 transition hover:bg-brand-50 hover:text-brand-600"
              aria-label="Editar cuenta bancaria"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="rounded-lg p-2 text-slate-500 transition hover:bg-danger-50 hover:text-danger-600"
              aria-label="Eliminar cuenta bancaria"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      <dl className="mt-5 grid gap-4 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs text-muted">Tipo de cuenta</dt>
          <dd className="font-semibold text-ink">{ACCOUNT_TYPE_LABELS[account.account_type] ?? account.account_type}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Moneda</dt>
          <dd className="font-semibold text-ink">{CURRENCY_LABELS[account.currency] ?? account.currency}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted">Número de cuenta</dt>
          <dd className="truncate font-semibold text-ink">{account.account_number ?? account.account_number_masked ?? '—'}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted">CCI</dt>
          <dd className="truncate font-semibold text-ink">{account.interbank_code ?? account.interbank_code_masked ?? '—'}</dd>
        </div>
      </dl>

      {account.masked && (
        <p className="mt-3 text-xs text-muted">
          Tu rol puede consultar la cuenta pero no editarla, por eso los números se muestran parcialmente.
        </p>
      )}
    </Card>
  );
}

function HolderPanel({ account }: { account: BankAccount | null }) {
  if (!account) {
    return (
      <Card padded={false}>
        <EmptyState title="Sin cuenta principal" description="Registra una cuenta bancaria para ver los datos del titular." />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title="Titular de la cuenta" description="Debe coincidir con la razón social de tu empresa." />
      <dl className="grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted">Titular</dt>
          <dd className="font-semibold text-ink">{account.holder_name}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">RUC o DNI</dt>
          <dd className="font-semibold text-ink">{account.holder_document ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Banco</dt>
          <dd className="font-semibold text-ink">{account.bank_name}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Estado</dt>
          <dd>
            <StatusBadge status={account.status} />
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function HistoryPanel({ history }: { history: ReturnType<typeof useAsync<Array<Record<string, unknown>>>> }) {
  if (history.loading) return <LoadingState />;
  if (history.error) {
    return (
      <Card padded={false}>
        <ErrorState error={history.error} onRetry={history.reload} />
      </Card>
    );
  }

  const rows = history.data ?? [];
  if (rows.length === 0) {
    return (
      <Card padded={false}>
        <EmptyState title="Sin cambios registrados" description="Aquí aparecerá cada alta, edición o baja de tus cuentas bancarias." />
      </Card>
    );
  }

  return (
    <Card padded={false}>
      <ul className="divide-y divide-border">
        {rows.map((entry) => (
          <li key={String(entry.id)} className="flex items-start justify-between gap-4 p-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">{String(entry.description ?? entry.action)}</p>
              <p className="mt-1 text-xs text-muted">{String(entry.user_name ?? 'Sistema')}</p>
            </div>
            <span className="shrink-0 text-xs text-muted">{formatDateTime(String(entry.created_at))}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
