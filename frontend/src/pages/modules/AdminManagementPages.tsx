import { Building2, CheckCircle2, ShieldCheck, UserX, Users } from 'lucide-react';
import { useState } from 'react';
import { ResourcePage } from '@/components/common/ResourcePage';
import { Avatar, Badge, Button, Card, CardHeader, Checkbox, ErrorState, LoadingState, Modal, PageHeader, StatCard, StatusBadge, type Column } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { ApiError } from '@/services/api';
import { companyService, permissionService, roleService, userService } from '@/services';
import type { Company, Permission, Role, UserRow } from '@/types';
import { ROLE_LABELS } from '@/constants/labels';
import { formatDateTime, formatNumber } from '@/utils/format';

export function UsersPage({ scope }: { scope: 'company' | 'admin' }) {
  const roles = useAsync(() => roleService.list(), []);
  const companies = useAsync(() => (scope === 'admin' ? companyService.list({ limit: 200 }) : Promise.resolve({ data: [] })), [scope]);
  const stats = useAsync(() => (scope === 'admin' ? userService.stats() : Promise.resolve(null)), [scope]);

  const columns: Array<Column<UserRow>> = [
    {
      key: 'user',
      header: 'Usuario',
      sortColumn: 'u.first_name',
      render: (user) => (
        <div className="flex items-center gap-3">
          <Avatar firstName={user.first_name} lastName={user.last_name} src={user.avatar_url} size="sm" />
          <span className="min-w-0">
            <span className="block font-semibold text-ink">
              {user.first_name} {user.last_name}
            </span>
            <span className="block truncate text-xs text-muted">{user.email}</span>
          </span>
        </div>
      ),
    },
    { key: 'role', header: 'Rol', render: (user) => <Badge tone="purple">{ROLE_LABELS[user.role_name] ?? user.role_name}</Badge> },
    ...(scope === 'admin' ? [{ key: 'company', header: 'Empresa', render: (user: UserRow) => user.company_name ?? '—', hideOnMobile: true }] : [{ key: 'position', header: 'Cargo', render: (user: UserRow) => user.position ?? '—', hideOnMobile: true }]),
    { key: 'phone', header: 'Teléfono', render: (user) => user.phone ?? '—', hideOnMobile: true },
    { key: 'last_login', header: 'Último acceso', sortColumn: 'u.last_login_at', render: (user) => formatDateTime(user.last_login_at), hideOnMobile: true },
    { key: 'status', header: 'Estado', render: (user) => <StatusBadge status={user.status} /> },
  ];

  return (
    <ResourcePage<UserRow>
      title={scope === 'company' ? 'Usuarios y permisos' : 'Usuarios'}
      description={scope === 'company' ? 'Gestiona los usuarios de tu empresa y sus accesos.' : 'Administra todos los usuarios de la plataforma.'}
      breadcrumbs={[{ label: scope === 'company' ? 'Portal Empresa' : 'Administración' }, { label: 'Usuarios' }]}
      loader={(params) => userService.list(params)}
      columns={columns}
      permissionModule="users"
      entityLabel="Usuario"
      searchPlaceholder="Buscar por nombre, correo o teléfono..."
      filters={[
        {
          key: 'role_id',
          placeholder: 'Todos los roles',
          options: (roles.data ?? []).map((role) => ({ value: String(role.id), label: ROLE_LABELS[role.name] ?? role.name })),
        },
        {
          key: 'status',
          placeholder: 'Todos los estados',
          options: [
            { value: 'ACTIVE', label: 'Activo' },
            { value: 'PENDING', label: 'Pendiente' },
            { value: 'INACTIVE', label: 'Inactivo' },
            { value: 'SUSPENDED', label: 'Suspendido' },
          ],
        },
      ]}
      stats={
        scope === 'admin' ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Total de usuarios" value={formatNumber(stats.data?.total ?? 0)} icon={<Users className="h-5 w-5" />} tone="brand" />
            <StatCard label="Usuarios activos" value={formatNumber(stats.data?.active ?? 0)} icon={<CheckCircle2 className="h-5 w-5" />} tone="success" />
            <StatCard label="Administradores" value={formatNumber(stats.data?.admins ?? 0)} icon={<ShieldCheck className="h-5 w-5" />} tone="purple" />
            <StatCard label="Suspendidos" value={formatNumber(stats.data?.suspended ?? 0)} icon={<UserX className="h-5 w-5" />} tone="danger" />
          </div>
        ) : undefined
      }
      formFields={[
        { name: 'first_name', label: 'Nombres', required: true },
        { name: 'last_name', label: 'Apellidos', required: true },
        { name: 'email', label: 'Correo electrónico', type: 'email', required: true, createOnly: true },
        { name: 'phone', label: 'Teléfono', type: 'tel' },
        {
          name: 'role_id',
          label: 'Rol',
          type: 'select',
          required: true,
          options: (roles.data ?? []).map((role) => ({ value: role.id, label: ROLE_LABELS[role.name] ?? role.name })),
        },
        ...(scope === 'admin'
          ? [
              {
                name: 'company_id',
                label: 'Empresa (opcional)',
                type: 'select' as const,
                createOnly: true,
                options: (companies.data?.data ?? []).map((company) => ({ value: company.id, label: company.name })),
              },
            ]
          : [{ name: 'position', label: 'Cargo', createOnly: true, placeholder: 'Ej: Operaciones' }]),
        { name: 'password', label: 'Contraseña', type: 'password', required: true, createOnly: true, hint: 'Mínimo 8 caracteres.' },
        {
          name: 'status',
          label: 'Estado',
          type: 'select',
          options: [
            { value: 'ACTIVE', label: 'Activo' },
            { value: 'PENDING', label: 'Pendiente' },
            { value: 'INACTIVE', label: 'Inactivo' },
            { value: 'SUSPENDED', label: 'Suspendido' },
          ],
        },
      ]}
      onCreate={(values) => userService.create(values).then(() => undefined)}
      onUpdate={(id, values) => userService.update(id, values).then(() => undefined)}
      onDelete={(id) => userService.remove(id).then(() => undefined)}
      toFormValues={(user) => ({ ...user, role_id: user.role_id })}
      emptyTitle="No hay usuarios registrados"
      emptyDescription="Crea el primer usuario para comenzar."
    />
  );
}

export function RolesPage() {
  const toast = useToast();
  const { hasPermission } = useAuth();
  const roles = useAsync(() => roleService.list(), []);
  const permissions = useAsync(() => permissionService.list(), []);

  const [editing, setEditing] = useState<Role | null>(null);
  const [selectedPermissions, setSelectedPermissions] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);

  const openRole = async (role: Role) => {
    try {
      const detail = await roleService.get(role.id);
      setEditing(detail);
      setSelectedPermissions((detail.permissions ?? []).map((permission) => permission.id));
    } catch (error) {
      toast.error('No se pudo cargar el rol', error instanceof ApiError ? error.message : undefined);
    }
  };

  const savePermissions = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await roleService.setPermissions(editing.id, selectedPermissions);
      toast.success('Permisos actualizados correctamente.');
      setEditing(null);
      roles.reload();
    } catch (error) {
      toast.error('No se pudieron guardar los permisos', error instanceof ApiError ? error.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const grouped = permissions.data?.grouped ?? {};

  return (
    <>
      <PageHeader title="Roles y permisos" description="Define qué puede hacer cada rol dentro de la plataforma." breadcrumbs={[{ label: 'Administración' }, { label: 'Roles y permisos' }]} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Roles definidos" value={formatNumber(roles.data?.length ?? 0)} icon={<ShieldCheck className="h-5 w-5" />} tone="purple" />
        <StatCard label="Permisos disponibles" value={formatNumber(permissions.data?.permissions.length ?? 0)} icon={<CheckCircle2 className="h-5 w-5" />} tone="info" />
        <StatCard label="Módulos" value={formatNumber(Object.keys(grouped).length)} icon={<Building2 className="h-5 w-5" />} tone="brand" />
        <StatCard
          label="Usuarios asignados"
          value={formatNumber((roles.data ?? []).reduce((sum, role) => sum + Number(role.users_count ?? 0), 0))}
          icon={<Users className="h-5 w-5" />}
          tone="success"
        />
      </div>

      {roles.loading ? (
        <LoadingState />
      ) : roles.error ? (
        <Card padded={false}>
          <ErrorState error={roles.error} onRetry={roles.reload} />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {(roles.data ?? []).map((role) => (
            <Card key={role.id}>
              <CardHeader title={ROLE_LABELS[role.name] ?? role.name} description={role.description ?? undefined} action={<StatusBadge status={role.status} />} />
              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted">Usuarios</dt>
                  <dd className="font-semibold text-ink">{formatNumber(role.users_count ?? 0)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">Permisos</dt>
                  <dd className="font-semibold text-ink">{formatNumber(role.permissions_count ?? 0)}</dd>
                </div>
              </dl>
              <Button size="sm" variant="outline" fullWidth className="mt-4" onClick={() => void openRole(role)}>
                {hasPermission('roles.update') ? 'Gestionar permisos' : 'Ver permisos'}
              </Button>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        size="lg"
        title={`Permisos de ${ROLE_LABELS[editing?.name ?? ''] ?? editing?.name ?? ''}`}
        description="Los permisos se aplican también en el backend: ocultar un botón no basta como seguridad."
        footer={
          hasPermission('roles.update') ? (
            <>
              <Button variant="secondary" onClick={() => setEditing(null)}>
                Cancelar
              </Button>
              <Button onClick={() => void savePermissions()} loading={saving}>
                Guardar permisos
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cerrar
            </Button>
          )
        }
      >
        <div className="space-y-5">
          {Object.entries(grouped).map(([module, modulePermissions]) => {
            const ids = (modulePermissions as Permission[]).map((permission) => permission.id);
            const allSelected = ids.every((id) => selectedPermissions.includes(id));

            return (
              <div key={module} className="rounded-card border border-border p-4">
                <div className="mb-3 flex items-center justify-between">
                  <p className="font-semibold capitalize text-ink">{module.replace('_', ' ')}</p>
                  {hasPermission('roles.update') && (
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedPermissions((current) =>
                          allSelected ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])],
                        )
                      }
                      className="text-sm font-medium text-brand-600 hover:text-brand-700"
                    >
                      {allSelected ? 'Quitar todos' : 'Seleccionar todos'}
                    </button>
                  )}
                </div>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {(modulePermissions as Permission[]).map((permission) => (
                    <Checkbox
                      key={permission.id}
                      checked={selectedPermissions.includes(permission.id)}
                      disabled={!hasPermission('roles.update')}
                      onChange={(event) =>
                        setSelectedPermissions((current) =>
                          event.target.checked ? [...current, permission.id] : current.filter((id) => id !== permission.id),
                        )
                      }
                      label={
                        <span>
                          <span className="block text-sm font-medium text-ink">{permission.description ?? permission.name}</span>
                          <span className="block font-mono text-xs text-muted">{permission.name}</span>
                        </span>
                      }
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Modal>
    </>
  );
}

export function CompaniesPage() {
  const toast = useToast();
  const { hasPermission } = useAuth();
  const [reloadToken, setReloadToken] = useState(0);

  const columns: Array<Column<Company>> = [
    {
      key: 'company',
      header: 'Empresa',
      sortColumn: 'c.name',
      render: (company) => (
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            <Building2 className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block font-semibold text-ink">{company.name}</span>
            <span className="block truncate text-xs text-muted">{company.legal_name ?? '—'}</span>
          </span>
        </div>
      ),
    },
    { key: 'tax_id', header: 'RUC', render: (company) => company.tax_id ?? '—' },
    { key: 'email', header: 'Email', render: (company) => company.email ?? '—', hideOnMobile: true },
    { key: 'phone', header: 'Teléfono', render: (company) => company.phone ?? '—', hideOnMobile: true },
    { key: 'buses', header: 'Buses', render: (company) => formatNumber(company.buses_count ?? 0), hideOnMobile: true },
    { key: 'routes', header: 'Rutas', render: (company) => formatNumber(company.routes_count ?? 0), hideOnMobile: true },
    { key: 'status', header: 'Estado', render: (company) => <StatusBadge status={company.status} /> },
  ];

  const changeStatus = async (company: Company, status: Company['status']) => {
    try {
      await companyService.update(company.id, { status });
      toast.success(status === 'ACTIVE' ? 'Empresa aprobada correctamente.' : 'Estado de la empresa actualizado.');
      setReloadToken((token) => token + 1);
    } catch (error) {
      toast.error('No se pudo actualizar', error instanceof ApiError ? error.message : undefined);
    }
  };

  return (
    <ResourcePage<Company>
      title="Empresas"
      description="Gestiona todas las empresas de transporte registradas en la plataforma."
      breadcrumbs={[{ label: 'Administración' }, { label: 'Empresas' }]}
      loader={(params) => companyService.list(params)}
      reloadToken={reloadToken}
      columns={columns}
      permissionModule="companies"
      entityLabel="Empresa"
      entityGender="f"
      searchPlaceholder="Buscar por nombre, RUC o correo..."
      filters={[
        {
          key: 'status',
          placeholder: 'Todos los estados',
          options: [
            { value: 'PENDING', label: 'Pendiente' },
            { value: 'ACTIVE', label: 'Aprobada' },
            { value: 'REJECTED', label: 'Rechazada' },
            { value: 'SUSPENDED', label: 'Suspendida' },
            { value: 'INACTIVE', label: 'Inactiva' },
          ],
        },
      ]}
      formFields={[
        { name: 'name', label: 'Nombre comercial', required: true },
        { name: 'legal_name', label: 'Razón social' },
        { name: 'tax_id', label: 'RUC', placeholder: '20123456789' },
        { name: 'email', label: 'Correo', type: 'email' },
        { name: 'phone', label: 'Teléfono', type: 'tel' },
        { name: 'logo_url', label: 'URL del logo' },
        { name: 'description', label: 'Descripción', type: 'textarea' },
        {
          name: 'status',
          label: 'Estado',
          type: 'select',
          options: [
            { value: 'PENDING', label: 'Pendiente' },
            { value: 'ACTIVE', label: 'Aprobada' },
            { value: 'REJECTED', label: 'Rechazada' },
            { value: 'SUSPENDED', label: 'Suspendida' },
            { value: 'INACTIVE', label: 'Inactiva' },
          ],
        },
      ]}
      onCreate={(values) => companyService.create(values).then(() => undefined)}
      onUpdate={(id, values) => companyService.update(id, values).then(() => undefined)}
      onDelete={(id) => companyService.remove(id).then(() => undefined)}
      extraActions={(company) =>
        company.status === 'PENDING' && hasPermission('companies.update') ? (
          <div className="flex gap-1">
            <Button size="sm" variant="success" onClick={() => void changeStatus(company, 'ACTIVE')}>
              Aprobar
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void changeStatus(company, 'REJECTED')}>
              Rechazar
            </Button>
          </div>
        ) : null
      }
      emptyTitle="No hay empresas registradas"
      emptyDescription="Las empresas aparecerán aquí tras registrarse desde el Portal Empresa."
    />
  );
}
