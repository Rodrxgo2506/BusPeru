import { AlertTriangle, Copy, Eye, Headphones, KeyRound, Plus, ScrollText, Send, Settings as SettingsIcon, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { ResourceForm } from '@/components/common/ResourceForm';
import { ResourcePage } from '@/components/common/ResourcePage';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  Modal,
  PageHeader,
  SearchBar,
  Select,
  StatCard,
  StatusBadge,
  Tabs,
  TablePagination,
  TableSkeleton,
  Textarea,
  type Column,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { useList } from '@/hooks/useList';
import { ApiError } from '@/services/api';
import { apiKeyService, auditService, notificationService, settingService, supportService, templateService, userService } from '@/services';
import type { ApiKey, AuditLog, SupportTicket, SystemSetting } from '@/types';
import { AUDIT_ACTION_LABELS, PRIORITY_LABELS, TICKET_CATEGORY_LABELS } from '@/constants/labels';
import { formatDateTime, formatNumber } from '@/utils/format';

export function SupportPage({ scope }: { scope: 'company' | 'admin' }) {
  const toast = useToast();
  const summary = useAsync(() => supportService.summary(), []);
  const list = useList<SupportTicket>((params) => supportService.list(params));
  const [selected, setSelected] = useState<SupportTicket | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);

  const detail = useAsync(() => (selected ? supportService.get(selected.id) : Promise.resolve(null)), [selected?.id]);

  const send = async () => {
    if (!selected || !reply.trim()) return;
    setSending(true);
    try {
      await supportService.reply(selected.id, { message: reply });
      setReply('');
      detail.reload();
      toast.success('Respuesta enviada.');
    } catch (error) {
      toast.error('No se pudo enviar', error instanceof ApiError ? error.message : undefined);
    } finally {
      setSending(false);
    }
  };

  const changeStatus = async (status: string) => {
    if (!selected) return;
    try {
      await supportService.update(selected.id, { status });
      toast.success('Ticket actualizado.');
      detail.reload();
      list.reload();
      summary.reload();
    } catch (error) {
      toast.error('No se pudo actualizar', error instanceof ApiError ? error.message : undefined);
    }
  };

  const columns: Array<Column<SupportTicket>> = [
    {
      key: 'ticket',
      header: 'Ticket',
      render: (ticket) => (
        <div className="min-w-0">
          <p className="font-semibold text-brand-600">{ticket.ticket_code}</p>
          <p className="truncate text-sm text-ink">{ticket.subject}</p>
        </div>
      ),
    },
    { key: 'category', header: 'Categoría', render: (ticket) => <Badge>{TICKET_CATEGORY_LABELS[ticket.category] ?? ticket.category}</Badge>, hideOnMobile: true },
    {
      key: 'user',
      header: 'Solicitante',
      render: (ticket) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">
            {ticket.first_name} {ticket.last_name}
          </p>
          <p className="truncate text-xs text-muted">{ticket.user_email}</p>
        </div>
      ),
      hideOnMobile: true,
    },
    { key: 'priority', header: 'Prioridad', render: (ticket) => <Badge tone={ticket.priority === 'URGENT' || ticket.priority === 'HIGH' ? 'danger' : 'neutral'}>{PRIORITY_LABELS[ticket.priority]}</Badge> },
    { key: 'updated', header: 'Última actualización', sortColumn: 'st.updated_at', render: (ticket) => formatDateTime(ticket.updated_at), hideOnMobile: true },
    { key: 'status', header: 'Estado', render: (ticket) => <StatusBadge status={ticket.status} /> },
    {
      key: 'actions',
      header: '',
      headerClassName: 'text-right',
      className: 'text-right',
      render: (ticket) => (
        <Button size="sm" variant="ghost" icon={<Eye className="h-4 w-4" />} onClick={() => setSelected(ticket)}>
          Ver
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Centro de soporte" description="Gestiona las consultas y solicitudes de ayuda." breadcrumbs={[{ label: scope === 'company' ? 'Portal Empresa' : 'Administración' }, { label: 'Soporte' }]} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Total tickets" value={formatNumber(summary.data?.total ?? 0)} icon={<Headphones className="h-5 w-5" />} tone="brand" />
        <StatCard label="Abiertos" value={formatNumber(summary.data?.open ?? 0)} icon={<AlertTriangle className="h-5 w-5" />} tone="info" />
        <StatCard label="En proceso" value={formatNumber(summary.data?.in_progress ?? 0)} icon={<Headphones className="h-5 w-5" />} tone="warning" />
        <StatCard label="Resueltos" value={formatNumber(summary.data?.resolved ?? 0)} icon={<Headphones className="h-5 w-5" />} tone="success" />
        <StatCard label="Cerrados" value={formatNumber(summary.data?.closed ?? 0)} icon={<Headphones className="h-5 w-5" />} tone="danger" />
      </div>

      <Card padded={false}>
        <div className="border-b border-border p-4">
          <FilterBar>
            <SearchBar className="min-w-0 flex-1 sm:max-w-sm" placeholder="Buscar por ticket, asunto o correo..." value={list.search} onChange={(event) => list.setSearch(event.target.value)} />
            <Select
              options={[
                { value: 'OPEN', label: 'Abierto' },
                { value: 'IN_PROGRESS', label: 'En proceso' },
                { value: 'WAITING_USER', label: 'Esperando respuesta' },
                { value: 'RESOLVED', label: 'Resuelto' },
                { value: 'CLOSED', label: 'Cerrado' },
              ]}
              placeholder="Todos los estados"
              value={list.filters.status ?? ''}
              onChange={(event) => list.setFilter('status', event.target.value || null)}
              containerClassName="w-full sm:w-auto sm:min-w-[180px]"
            />
            <Select
              options={Object.entries(TICKET_CATEGORY_LABELS).map(([value, labelText]) => ({ value, label: labelText }))}
              placeholder="Todas las categorías"
              value={list.filters.category ?? ''}
              onChange={(event) => list.setFilter('category', event.target.value || null)}
              containerClassName="w-full sm:w-auto sm:min-w-[180px]"
            />
          </FilterBar>
        </div>

        {list.error ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={list.rows}
              rowKey={(ticket) => ticket.id}
              onRowClick={(ticket) => setSelected(ticket)}
              sort={list.sort}
              onSort={list.toggleSort}
              loading={list.loading}
              loadingState={<TableSkeleton />}
              emptyState={<EmptyState title="No hay tickets de soporte" description="Las consultas de los usuarios aparecerán aquí." icon={<Headphones className="h-7 w-7" />} />}
            />
            {!list.loading && list.rows.length > 0 && <TablePagination pagination={list.pagination} onPageChange={list.setPage} />}
          </>
        )}
      </Card>

      <Modal
        open={selected !== null}
        onClose={() => setSelected(null)}
        size="lg"
        title={selected?.subject ?? 'Ticket'}
        description={selected ? `${selected.ticket_code} · ${TICKET_CATEGORY_LABELS[selected.category] ?? selected.category}` : undefined}
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void changeStatus('IN_PROGRESS')}>
                En proceso
              </Button>
              <Button size="sm" variant="success" onClick={() => void changeStatus('RESOLVED')}>
                Marcar resuelto
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void changeStatus('CLOSED')}>
                Cerrar
              </Button>
            </div>
            <Button onClick={() => void send()} loading={sending} disabled={!reply.trim()} icon={<Send className="h-4 w-4" />}>
              Enviar respuesta
            </Button>
          </div>
        }
      >
        {detail.loading ? (
          <TableSkeleton rows={3} columns={2} />
        ) : detail.data ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={detail.data.status} />
              <Badge tone={detail.data.priority === 'URGENT' ? 'danger' : 'neutral'}>{PRIORITY_LABELS[detail.data.priority]}</Badge>
              <span className="text-sm text-muted">Creado {formatDateTime(detail.data.created_at)}</span>
            </div>

            <ul className="max-h-80 space-y-3 overflow-y-auto">
              {(detail.data.messages ?? []).map((message) => (
                <li key={message.id} className={message.role_name === 'CUSTOMER' ? 'mr-auto max-w-[85%]' : 'ml-auto max-w-[85%]'}>
                  <div className={message.is_internal === 1 ? 'rounded-card bg-warning-50 p-4' : message.role_name === 'CUSTOMER' ? 'rounded-card bg-slate-100 p-4' : 'rounded-card bg-brand-50 p-4'}>
                    <p className="text-xs font-semibold text-ink">
                      {message.first_name} {message.last_name}
                      {message.is_internal === 1 && <span className="ml-2 text-warning-700">(nota interna)</span>}
                    </p>
                    <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{message.message}</p>
                    <p className="mt-2 text-xs text-slate-400">{formatDateTime(message.created_at)}</p>
                  </div>
                </li>
              ))}
            </ul>

            <Textarea label="Responder" placeholder="Escribe tu respuesta..." value={reply} onChange={(event) => setReply(event.target.value)} />
          </div>
        ) : (
          <ErrorState error={detail.error} onRetry={detail.reload} />
        )}
      </Modal>
    </>
  );
}

export function NotificationsAdminPage({ scope }: { scope: 'company' | 'admin' }) {
  const toast = useToast();
  const { hasPermission } = useAuth();
  const [tab, setTab] = useState<'sent' | 'templates'>('sent');
  const [sendOpen, setSendOpen] = useState(false);

  const users = useAsync(() => userService.list({ limit: 200 }), []);
  const notifications = useAsync(() => notificationService.list({ limit: 50 }), []);

  return (
    <>
      <PageHeader
        title="Notificaciones"
        description="Comunica información importante a los usuarios de la plataforma."
        breadcrumbs={[{ label: scope === 'company' ? 'Portal Empresa' : 'Administración' }, { label: 'Notificaciones' }]}
        actions={
          hasPermission('settings.update') ? (
            <Button icon={<Send className="h-4 w-4" />} onClick={() => setSendOpen(true)}>
              Enviar notificación
            </Button>
          ) : undefined
        }
      />

      <Tabs
        tabs={[
          { id: 'sent', label: 'Mis notificaciones' },
          { id: 'templates', label: 'Plantillas' },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-6"
      />

      {tab === 'sent' ? (
        <Card padded={false}>
          {notifications.loading ? (
            <TableSkeleton />
          ) : notifications.error ? (
            <ErrorState error={notifications.error} onRetry={notifications.reload} />
          ) : (notifications.data?.data ?? []).length === 0 ? (
            <EmptyState title="No tienes notificaciones" description="Las notificaciones que recibas aparecerán aquí." />
          ) : (
            <ul className="divide-y divide-border">
              {(notifications.data?.data ?? []).map((notification) => (
                <li key={notification.id} className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-semibold text-ink">{notification.title}</p>
                      <p className="mt-0.5 text-sm text-muted">{notification.message}</p>
                    </div>
                    <span className="shrink-0 text-xs text-muted">{formatDateTime(notification.created_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : (
        <TemplatesTable />
      )}

      <ResourceForm
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        title="Enviar notificación"
        description="Se enviará como notificación in-app a los usuarios seleccionados."
        submitLabel="Enviar"
        fields={[
          { name: 'title', label: 'Título', required: true, full: true, placeholder: 'Ej: Cambios en horario de viaje' },
          { name: 'message', label: 'Mensaje', type: 'textarea', required: true },
          {
            name: 'user_ids',
            label: 'Destinatario',
            type: 'select',
            required: true,
            options: (users.data?.data ?? []).map((user) => ({ value: user.id, label: `${user.first_name} ${user.last_name} (${user.email})` })),
          },
          {
            name: 'type',
            label: 'Tipo',
            type: 'select',
            options: [
              { value: 'IN_APP', label: 'En la aplicación' },
              { value: 'EMAIL', label: 'Correo' },
              { value: 'PUSH', label: 'Push' },
              { value: 'SMS', label: 'SMS' },
            ],
          },
        ]}
        onSubmit={async (values) => {
          await notificationService.send({ ...values, user_ids: [Number(values.user_ids)] });
          toast.success('Notificación enviada correctamente.');
          notifications.reload();
        }}
      />
    </>
  );
}

function TemplatesTable() {
  return (
    <ResourcePage<{ id: number; name: string; type: string; subject: string | null; title: string | null; body: string; status: string }>
      title=""
      loader={(params) => templateService.list(params)}
      columns={[
        { key: 'name', header: 'Plantilla', render: (row) => <span className="font-semibold text-ink">{row.name}</span> },
        { key: 'type', header: 'Tipo', render: (row) => <Badge>{row.type}</Badge> },
        { key: 'subject', header: 'Asunto', render: (row) => row.subject ?? row.title ?? '—', hideOnMobile: true },
        { key: 'status', header: 'Estado', render: (row) => <StatusBadge status={row.status} /> },
      ]}
      permissionModule="settings"
      entityLabel="Plantilla"
      entityGender="f"
      searchPlaceholder="Buscar plantillas..."
      formFields={[
        { name: 'name', label: 'Nombre', required: true },
        {
          name: 'type',
          label: 'Tipo',
          type: 'select',
          required: true,
          options: [
            { value: 'IN_APP', label: 'En la aplicación' },
            { value: 'EMAIL', label: 'Correo' },
            { value: 'PUSH', label: 'Push' },
            { value: 'SMS', label: 'SMS' },
          ],
        },
        { name: 'subject', label: 'Asunto' },
        { name: 'title', label: 'Título' },
        { name: 'body', label: 'Contenido', type: 'textarea', required: true, hint: 'Puedes usar variables como {{nombre}} o {{codigo_reserva}}.' },
        {
          name: 'status',
          label: 'Estado',
          type: 'select',
          options: [
            { value: 'ACTIVE', label: 'Activa' },
            { value: 'INACTIVE', label: 'Inactiva' },
          ],
        },
      ]}
      onCreate={(values) => templateService.create(values).then(() => undefined)}
      onUpdate={(id, values) => templateService.update(id, values).then(() => undefined)}
      onDelete={(id) => templateService.remove(id).then(() => undefined)}
      emptyTitle="No hay plantillas creadas"
      emptyDescription="Crea plantillas reutilizables para tus notificaciones."
    />
  );
}

export function AuditPage() {
  const filters = useAsync(() => auditService.filters(), []);
  const list = useList<AuditLog>((params) => auditService.list(params));
  const [detail, setDetail] = useState<AuditLog | null>(null);

  const columns: Array<Column<AuditLog>> = [
    { key: 'date', header: 'Fecha', render: (log) => formatDateTime(log.created_at) },
    {
      key: 'user',
      header: 'Usuario',
      render: (log) =>
        log.user_id ? (
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">
              {log.first_name} {log.last_name}
            </p>
            <p className="truncate text-xs text-muted">{log.user_email}</p>
          </div>
        ) : (
          <span className="text-muted">Sistema</span>
        ),
    },
    { key: 'action', header: 'Acción', render: (log) => <Badge tone={log.action === 'DELETE' ? 'danger' : log.action === 'CREATE' ? 'success' : 'neutral'}>{AUDIT_ACTION_LABELS[log.action] ?? log.action}</Badge> },
    { key: 'module', header: 'Módulo', render: (log) => <span className="font-mono text-xs">{log.entity_type ?? '—'}</span>, hideOnMobile: true },
    { key: 'description', header: 'Detalle', render: (log) => <span className="text-slate-600">{log.description ?? '—'}</span> },
    { key: 'ip', header: 'IP', render: (log) => <span className="font-mono text-xs">{log.ip_address ?? '—'}</span>, hideOnMobile: true },
    {
      key: 'actions',
      header: '',
      headerClassName: 'text-right',
      className: 'text-right',
      render: (log) =>
        log.old_values || log.new_values ? (
          <Button size="sm" variant="ghost" onClick={() => setDetail(log)}>
            Ver JSON
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader title="Auditoría" description="Registro de las operaciones realizadas en la plataforma." breadcrumbs={[{ label: 'Administración' }, { label: 'Auditoría' }]} />

      <Card padded={false}>
        <div className="border-b border-border p-4">
          <FilterBar>
            <SearchBar className="min-w-0 flex-1 sm:max-w-sm" placeholder="Buscar por descripción, acción, correo o IP..." value={list.search} onChange={(event) => list.setSearch(event.target.value)} />
            <Select
              options={(filters.data?.actions ?? []).map((action) => ({ value: action, label: AUDIT_ACTION_LABELS[action] ?? action }))}
              placeholder="Todas las acciones"
              value={list.filters.action ?? ''}
              onChange={(event) => list.setFilter('action', event.target.value || null)}
              containerClassName="w-full sm:w-auto sm:min-w-[180px]"
            />
            <Select
              options={(filters.data?.entities ?? []).map((entity) => ({ value: entity, label: entity }))}
              placeholder="Todos los módulos"
              value={list.filters.entity_type ?? ''}
              onChange={(event) => list.setFilter('entity_type', event.target.value || null)}
              containerClassName="w-full sm:w-auto sm:min-w-[180px]"
            />
          </FilterBar>
        </div>

        {list.error ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={list.rows}
              rowKey={(log) => log.id}
              loading={list.loading}
              loadingState={<TableSkeleton />}
              emptyState={<EmptyState title="No hay registros de auditoría" description="Las operaciones administrativas quedarán registradas aquí." icon={<ScrollText className="h-7 w-7" />} />}
            />
            {!list.loading && list.rows.length > 0 && <TablePagination pagination={list.pagination} onPageChange={list.setPage} />}
          </>
        )}
      </Card>

      <Modal open={detail !== null} onClose={() => setDetail(null)} size="lg" title="Detalle del registro" description={detail?.description ?? undefined}>
        <div className="space-y-4">
          {detail?.old_values && (
            <div>
              <p className="mb-2 text-sm font-semibold text-ink">Valores anteriores</p>
              <pre className="max-h-64 overflow-auto rounded-card bg-slate-900 p-4 text-xs text-slate-100">{prettyJson(detail.old_values)}</pre>
            </div>
          )}
          {detail?.new_values && (
            <div>
              <p className="mb-2 text-sm font-semibold text-ink">Valores nuevos</p>
              <pre className="max-h-64 overflow-auto rounded-card bg-slate-900 p-4 text-xs text-slate-100">{prettyJson(detail.new_values)}</pre>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function ApiKeysPage() {
  const toast = useToast();
  const { hasPermission } = useAuth();
  const keys = useAsync(() => apiKeyService.list(), []);
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [busy, setBusy] = useState(false);

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      await apiKeyService.revoke(revoking.id);
      toast.success('API key revocada.');
      setRevoking(null);
      keys.reload();
    } catch (error) {
      toast.error('No se pudo revocar', error instanceof ApiError ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="API keys"
        description="Llaves de integración para conectar sistemas externos con BusPerú."
        breadcrumbs={[{ label: 'Administración' }, { label: 'API keys' }]}
        actions={
          hasPermission('settings.update') ? (
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              Nueva API key
            </Button>
          ) : undefined
        }
      />

      <Card className="mb-6 flex gap-3 border-warning-200 bg-warning-50">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning-600" />
        <p className="text-sm text-warning-800">
          La llave completa solo se muestra <strong>una vez</strong> al crearla. BusPerú almacena únicamente su hash y el prefijo, por lo que no
          es posible recuperarla después.
        </p>
      </Card>

      {keys.loading ? (
        <TableSkeleton />
      ) : keys.error ? (
        <Card padded={false}>
          <ErrorState error={keys.error} onRetry={keys.reload} />
        </Card>
      ) : (keys.data ?? []).length === 0 ? (
        <Card padded={false}>
          <EmptyState title="No hay API keys creadas" description="Crea una llave para integrar sistemas externos." icon={<KeyRound className="h-7 w-7" />} />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(keys.data ?? []).map((key) => (
            <Card key={key.id}>
              <CardHeader title={key.name} description={key.company_name ?? 'Plataforma'} action={<StatusBadge status={key.status} />} />
              <p className="mt-4 rounded-control bg-slate-100 p-2.5 font-mono text-sm text-slate-700">{key.key_prefix}••••••••</p>
              <dl className="mt-3 space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted">Entorno</dt>
                  <dd>
                    <Badge tone={key.environment === 'PRODUCTION' ? 'danger' : 'neutral'}>{key.environment}</Badge>
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">Último uso</dt>
                  <dd className="font-medium text-ink">{formatDateTime(key.last_used_at)}</dd>
                </div>
              </dl>
              {key.status === 'ACTIVE' && hasPermission('settings.update') && (
                <Button size="sm" variant="secondary" fullWidth className="mt-4" onClick={() => setRevoking(key)}>
                  Revocar
                </Button>
              )}
            </Card>
          ))}
        </div>
      )}

      <ResourceForm
        open={creating}
        onClose={() => setCreating(false)}
        title="Nueva API key"
        submitLabel="Crear llave"
        fields={[
          { name: 'name', label: 'Nombre', required: true, full: true, placeholder: 'Ej: Integración ERP' },
          {
            name: 'environment',
            label: 'Entorno',
            type: 'select',
            options: [
              { value: 'TEST', label: 'Pruebas' },
              { value: 'PRODUCTION', label: 'Producción' },
            ],
          },
          { name: 'expires_at', label: 'Expira el', type: 'date' },
        ]}
        onSubmit={async (values) => {
          const created = await apiKeyService.create(values);
          setCreatedKey(created);
          keys.reload();
        }}
      />

      <Modal open={createdKey !== null} onClose={() => setCreatedKey(null)} title="Guarda tu API key" description="Esta es la única vez que verás la llave completa.">
        <div className="flex items-center gap-2 rounded-card bg-slate-900 p-4">
          <code className="min-w-0 flex-1 break-all text-sm text-slate-100">{createdKey?.plain_key}</code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(createdKey?.plain_key ?? '');
              toast.success('Llave copiada al portapapeles.');
            }}
            className="rounded-lg p-2 text-slate-300 transition hover:bg-white/10 hover:text-white"
            aria-label="Copiar llave"
          >
            <Copy className="h-4 w-4" />
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={revoke}
        loading={busy}
        title="Revocar API key"
        confirmLabel="Sí, revocar"
        message={`La llave "${revoking?.name}" dejará de funcionar inmediatamente. Esta acción no se puede deshacer.`}
      />
    </>
  );
}

const SETTING_TABS = [
  { id: 'site', label: 'General', prefix: 'site.' },
  { id: 'booking', label: 'Reservas', prefix: 'booking.' },
  { id: 'platform', label: 'Plataforma', prefix: 'platform.' },
  { id: 'other', label: 'Otros', prefix: '' },
] as const;

export function SettingsPage({ scope }: { scope: 'company' | 'admin' }) {
  const [tab, setTab] = useState<(typeof SETTING_TABS)[number]['id']>('site');

  const knownPrefixes = SETTING_TABS.filter((entry) => entry.prefix !== '').map((entry) => entry.prefix);
  const activePrefix = SETTING_TABS.find((entry) => entry.id === tab)?.prefix ?? '';

  return (
    <>
      <PageHeader
        title="Configuración"
        description="Parámetros del sistema almacenados en la tabla system_settings."
        breadcrumbs={[{ label: scope === 'company' ? 'Portal Empresa' : 'Administración' }, { label: 'Configuración' }]}
      />

      <Card className="mb-6 flex gap-3 border-info-100 bg-info-50">
        <SettingsIcon className="mt-0.5 h-5 w-5 shrink-0 text-info-600" />
        <p className="text-sm text-info-700">
          Los mockups muestran pestañas adicionales (Correos, SEO, Términos, integraciones y datos bancarios). Solo se implementan los campos
          soportados por <code>system_settings</code>; el resto requiere una extensión documentada del esquema.
        </p>
      </Card>

      <Tabs tabs={SETTING_TABS.map((entry) => ({ id: entry.id, label: entry.label }))} active={tab} onChange={setTab} className="mb-6" />

      <SettingsTable key={tab} prefix={activePrefix} knownPrefixes={knownPrefixes} />
    </>
  );
}

function SettingsTable({ prefix, knownPrefixes }: { prefix: string; knownPrefixes: string[] }) {
  return (
    <ResourcePage<SystemSetting>
      title=""
      loader={async (params) => {
        const result = await settingService.list({ ...params, limit: 100 });
        const rows = result.data.filter((setting) =>
          prefix === '' ? !knownPrefixes.some((known) => setting.setting_key.startsWith(known)) : setting.setting_key.startsWith(prefix),
        );
        return { data: rows, pagination: { page: 1, limit: rows.length || 1, total: rows.length, totalPages: 1 } };
      }}
      columns={[
        { key: 'key', header: 'Clave', render: (setting) => <span className="font-mono text-sm font-medium text-ink">{setting.setting_key}</span> },
        { key: 'value', header: 'Valor', render: (setting) => <span className="text-slate-700">{setting.setting_value ?? '—'}</span> },
        { key: 'type', header: 'Tipo', render: (setting) => <Badge>{setting.setting_type}</Badge>, hideOnMobile: true },
        { key: 'description', header: 'Descripción', render: (setting) => <span className="text-sm text-muted">{setting.description ?? '—'}</span>, hideOnMobile: true },
        { key: 'public', header: 'Público', render: (setting) => (setting.is_public === 1 ? <Badge tone="success">Sí</Badge> : <Badge>No</Badge>) },
      ]}
      permissionModule="settings"
      entityLabel="Configuración"
      entityGender="f"
      searchPlaceholder="Buscar por clave o descripción..."
      formFields={[
        { name: 'setting_key', label: 'Clave', required: true, placeholder: 'Ej: site.name', hint: 'Usa el prefijo del módulo, por ejemplo site. o booking.' },
        {
          name: 'setting_type',
          label: 'Tipo',
          type: 'select',
          options: [
            { value: 'STRING', label: 'Texto' },
            { value: 'INTEGER', label: 'Entero' },
            { value: 'DECIMAL', label: 'Decimal' },
            { value: 'BOOLEAN', label: 'Booleano' },
            { value: 'JSON', label: 'JSON' },
          ],
        },
        { name: 'setting_value', label: 'Valor', full: true },
        { name: 'description', label: 'Descripción', type: 'textarea' },
        { name: 'is_public', label: 'Visible para el sitio público', type: 'checkbox' },
      ]}
      onCreate={(values) => settingService.create(values).then(() => undefined)}
      onUpdate={(id, values) => settingService.update(id, values).then(() => undefined)}
      onDelete={(id) => settingService.remove(id).then(() => undefined)}
      toFormValues={(setting) => ({ ...setting, is_public: setting.is_public === 1 })}
      emptyTitle="No hay configuraciones en esta sección"
      emptyDescription="Agrega una clave de configuración para esta sección."
    />
  );
}
