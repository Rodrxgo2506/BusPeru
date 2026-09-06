import { Armchair, BadgeCheck, Camera, Gift, LayoutList, Pencil, Route, Star, Ticket, Wallet } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, Card, Input, PageHeader, StatusBadge } from '@/components/ui';
import { ResourceForm } from '@/components/common/ResourceForm';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { ApiError } from '@/services/api';
import { authService, dashboardService, oauthService } from '@/services';
import { PROVIDER_LABELS } from '@/pages/auth/AuthShell';
import { formatCurrency, formatDate, formatDateTime, formatNumber } from '@/utils/format';

/**
 * Mockup 11. Fields the schema does not have (document, birth date, country, travel
 * preferences, loyalty points) are rendered in their exact position but marked as not
 * registered instead of being invented — see database/migrations/PENDIENTES.md.
 */
export function CustomerProfilePage() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const summary = useAsync(() => dashboardService.customer() as Promise<{ totals: Record<string, number> }>, []);

  const [editing, setEditing] = useState(false);
  const [passwords, setPasswords] = useState({ current_password: '', new_password: '' });
  const [savingPassword, setSavingPassword] = useState(false);

  const totals = summary.data?.totals ?? {};

  const savePassword = async (event: FormEvent) => {
    event.preventDefault();
    setSavingPassword(true);
    try {
      await authService.changePassword(passwords);
      setPasswords({ current_password: '', new_password: '' });
      toast.success('Contraseña actualizada correctamente.');
    } catch (error) {
      toast.error('No se pudo cambiar la contraseña', error instanceof ApiError ? error.message : undefined);
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Mi perfil"
        description="Administra tu información personal y preferencias."
        actions={
          <Button variant="outline" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>
            Editar perfil
          </Button>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <div className="flex flex-wrap items-center gap-5">
            <span className="relative">
              <span className="flex h-20 w-20 items-center justify-center rounded-full bg-brand-100 text-3xl font-bold text-brand-600">
                {user?.avatar_url ? (
                  <img src={user.avatar_url} alt="" className="h-20 w-20 rounded-full object-cover" />
                ) : (
                  `${user?.first_name?.[0] ?? ''}${user?.last_name?.[0] ?? ''}`.toUpperCase()
                )}
              </span>
              <span className="absolute bottom-0 right-0 flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-slate-200 text-slate-500">
                <Camera className="h-3.5 w-3.5" />
              </span>
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-ink">
                {user?.first_name} {user?.last_name}
              </h2>
              <p className="text-sm text-muted">{user?.email}</p>
              <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-success-50 px-2.5 py-1 text-xs font-semibold text-success-700">
                <BadgeCheck className="h-3.5 w-3.5" />
                {user?.email_verified_at ? 'Cuenta verificada' : 'Cuenta sin verificar'}
              </span>
            </div>
          </div>

          <dl className="mt-6 grid gap-5 border-t border-border pt-6 sm:grid-cols-2">
            <Field label="Nombres" value={user?.first_name} />
            <Field label="Teléfono" value={user?.phone} />
            <Field label="Apellidos" value={user?.last_name} />
            <Field label="Documento de identidad" value={null} missing />
            <Field label="Fecha de nacimiento" value={null} missing />
            <Field label="País" value={null} missing />
            <Field label="Estado de la cuenta" value={<StatusBadge status={user?.status} />} />
            <Field label="Miembro desde" value={formatDate(user?.created_at)} />
          </dl>

          <div className="mt-6 border-t border-border pt-6">
            <h3 className="font-semibold text-ink">Preferencias de viaje</h3>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Preference icon={<Armchair className="h-4 w-4" />} label="Asiento preferido" />
              <Preference icon={<Route className="h-4 w-4" />} label="Tipo de servicio" />
              <Preference icon={<LayoutList className="h-4 w-4" />} label="Boletos por página" />
            </div>
            <p className="mt-3 text-xs text-muted">
              Las preferencias de viaje requieren una extensión del esquema; están documentadas en <code>PENDIENTES.md</code>.
            </p>
          </div>

          <div id="seguridad" className="mt-6 scroll-mt-24 border-t border-border pt-6">
            <h3 className="font-semibold text-ink">Seguridad</h3>
            <p className="mt-0.5 text-sm text-muted">Actualiza tu contraseña de acceso.</p>
            <form onSubmit={savePassword} className="mt-4 grid gap-4 sm:grid-cols-2">
              <Input
                label="Contraseña actual"
                type="password"
                value={passwords.current_password}
                onChange={(event) => setPasswords({ ...passwords, current_password: event.target.value })}
                required
              />
              <Input
                label="Nueva contraseña"
                type="password"
                value={passwords.new_password}
                onChange={(event) => setPasswords({ ...passwords, new_password: event.target.value })}
                hint="Mínimo 8 caracteres, una mayúscula y un número."
                required
              />
              <div className="sm:col-span-2">
                <Button type="submit" variant="outline" loading={savingPassword}>
                  Cambiar contraseña
                </Button>
              </div>
            </form>

            <LinkedProvider />
          </div>
        </Card>

        <div className="space-y-5">
          <Card>
            <h2 className="font-semibold text-ink">Resumen de tu cuenta</h2>
            <dl className="mt-4 space-y-4">
              <SummaryRow icon={<Ticket className="h-4 w-4 text-brand-500" />} label="Viajes realizados" value={formatNumber(totals.trips_taken ?? 0)} />
              <SummaryRow icon={<Wallet className="h-4 w-4 text-brand-500" />} label="Gasto total" value={formatCurrency(totals.total_spent ?? 0)} />
              <SummaryRow
                icon={<Star className="h-4 w-4 text-brand-500" />}
                label="Puntos acumulados"
                value={<span className="text-slate-400">No disponible</span>}
              />
            </dl>
            <p className="mt-4 border-t border-border pt-3 text-xs text-muted">
              El programa de puntos no existe en el esquema actual.
            </p>
          </Card>

          <Card className="relative overflow-hidden bg-brand-50">
            <h2 className="font-semibold text-ink">Invita a tus amigos</h2>
            <p className="mt-1 max-w-[70%] text-sm text-muted">Gana puntos y descuentos por cada amigo que viaje.</p>
            <Button size="sm" className="mt-4" disabled title="Disponible próximamente">
              Invitar amigos
            </Button>
            <Gift className="pointer-events-none absolute -bottom-3 -right-3 h-24 w-24 text-brand-200" aria-hidden />
          </Card>

          <Card>
            <h2 className="font-semibold text-ink">Actividad</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted">Último acceso</dt>
                <dd className="font-medium text-ink">{formatDateTime(user?.last_login_at)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted">Viajes próximos</dt>
                <dd className="font-medium text-ink">{formatNumber(totals.upcoming ?? 0)}</dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>

      <ResourceForm
        open={editing}
        onClose={() => setEditing(false)}
        title="Editar perfil"
        description="Actualiza tu información personal."
        submitLabel="Guardar cambios"
        initialValues={{ first_name: user?.first_name, last_name: user?.last_name, phone: user?.phone ?? '' }}
        fields={[
          { name: 'first_name', label: 'Nombres', required: true },
          { name: 'last_name', label: 'Apellidos', required: true },
          { name: 'phone', label: 'Teléfono', type: 'tel', full: true },
        ]}
        onSubmit={async (values) => {
          await authService.updateProfile(values);
          await refresh();
          toast.success('Los cambios se guardaron correctamente.');
        }}
      />
    </>
  );
}

function Field({ label, value, missing = false }: { label: string; value?: React.ReactNode; missing?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={missing ? 'mt-0.5 text-sm text-slate-400' : 'mt-0.5 font-medium text-ink'}>{missing ? 'No registrado' : (value ?? '—')}</dd>
    </div>
  );
}

function Preference({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-500">{icon}</span>
      <span className="min-w-0">
        <span className="block text-xs text-muted">{label}</span>
        <span className="block text-sm text-slate-400">No disponible</span>
      </span>
    </div>
  );
}

function SummaryRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="flex items-center gap-2.5 text-sm text-muted">
        {icon}
        {label}
      </dt>
      <dd className="text-right font-bold text-ink">{value}</dd>
    </div>
  );
}

/**
 * Vinculación de Google / Microsoft con la cuenta (PENDIENTES.md §2, caso C).
 *
 * Aquí la prueba de identidad es la sesión activa, no el correo que diga el proveedor: por
 * eso vincular desde el perfil es seguro y hacerlo automáticamente al iniciar sesión no lo
 * sería. La cuenta que se vincula la resuelve el backend a partir del token; esta pantalla
 * no envía ningún identificador.
 */
function LinkedProvider() {
  const toast = useToast();
  const link = useAsync(() => oauthService.currentLink(), []);
  const providers = useAsync(() => oauthService.providers(), []);
  const [busy, setBusy] = useState(false);

  const configured = (providers.data ?? []).filter((entry) => entry.configured);
  // Sin proveedores configurados en el servidor no hay nada que ofrecer.
  if (providers.loading || configured.length === 0) return null;

  const current = link.data?.provider ?? null;

  const start = async (provider: 'GOOGLE' | 'MICROSOFT') => {
    setBusy(true);
    try {
      const { url } = await oauthService.link(provider);
      window.location.href = url;
    } catch (error) {
      toast.error('No se pudo iniciar la vinculación', error instanceof ApiError ? error.message : undefined);
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await oauthService.unlink();
      toast.success('Proveedor desvinculado', 'A partir de ahora entrarás con tu correo y contraseña.');
      link.reload();
    } catch (error) {
      toast.error('No se pudo desvincular', error instanceof ApiError ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 border-t border-border pt-6">
      <h3 className="font-semibold text-ink">Inicio de sesión con proveedor</h3>
      <p className="mt-0.5 text-sm text-muted">
        Vincula una cuenta para entrar sin escribir tu contraseña. Solo puedes tener un proveedor a la vez.
      </p>

      {link.loading ? (
        <p className="mt-4 text-sm text-muted">Consultando…</p>
      ) : current ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-medium text-ink">{PROVIDER_LABELS[current]}</p>
            <p className="text-xs text-muted">Vinculado a tu cuenta.</p>
          </div>
          <Button variant="outline" size="sm" loading={busy} onClick={() => void remove()}>
            Desvincular
          </Button>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          {configured.map((entry) => (
            <Button key={entry.provider} variant="outline" size="sm" loading={busy} onClick={() => void start(entry.provider)}>
              Vincular {PROVIDER_LABELS[entry.provider]}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
