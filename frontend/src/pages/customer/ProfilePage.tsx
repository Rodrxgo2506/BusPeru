import {
  AlertCircle,
  Armchair,
  BadgeCheck,
  BarChart3,
  CalendarDays,
  Camera,
  ChevronRight,
  Clock,
  Contact,
  Gift,
  IdCard,
  LayoutList,
  MapPin,
  Pencil,
  Phone,
  Route,
  Star,
  Ticket,
  User,
  Wallet,
} from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, Card, Input, PageHeader, StatusBadge } from '@/components/ui';
import { ResourceForm } from '@/components/common/ResourceForm';
import { TravelBackdrop } from '@/components/common/TravelBackdrop';
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
 *
 * COMPOSICIÓN, siguiendo el mockup de referencia:
 *
 *   · La columna principal es UNA sola tarjeta alta, dividida por filetes de 1 px. No son
 *     tarjetas sueltas apiladas: el mockup mantiene identidad, datos, preferencias y
 *     seguridad dentro del mismo plano, y esa continuidad es lo que hace que se lea como
 *     una ficha de perfil y no como un panel de widgets.
 *   · Los datos personales van SIN recuadro. Un icono tenue, la etiqueta pequeña y el valor
 *     en negrita bastan para la jerarquía; encerrarlos en cajas competía con la tarjeta que
 *     ya los contiene y ensuciaba la cuadrícula.
 *   · La columna derecha sí son tarjetas independientes, porque ahí cada bloque es un tema
 *     distinto.
 *
 * No cambió ni un dato, ni una llamada, ni una acción: las ausencias siguen diciendo
 * «No registrado» y «No disponible», que es la verdad.
 */
export function CustomerProfilePage() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const summary = useAsync(() => dashboardService.customer() as Promise<{ totals: Record<string, number> }>, []);

  const [editing, setEditing] = useState(false);
  const [passwords, setPasswords] = useState({ current_password: '', new_password: '' });
  const [savingPassword, setSavingPassword] = useState(false);

  const totals = summary.data?.totals ?? {};
  const verified = Boolean(user?.email_verified_at);

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
      <TravelBackdrop />

      <PageHeader
        title="Mi perfil"
        description="Administra tu información personal y preferencias."
        actions={
          <Button icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>
            Editar perfil
          </Button>
        }
      />

      {/* La columna derecha es de ancho fijo, como en el mockup: así la principal absorbe el
          espacio sobrante y la cuadrícula de datos no se estrecha.

          El reparto en dos columnas empieza en `xl`, no en `lg`. Entre 1024 y 1279 px la
          barra lateral del área de cliente ya se lleva 260 px, y descontar además un raíl
          fijo dejaba la ficha en unos 350 px: las etiquetas se partían en tres líneas y la
          rejilla de datos se leía peor que apilada. Ahí abajo, pues, la ficha ocupa todo el
          ancho y el raíl pasa debajo repartido en dos. */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_344px] xl:gap-7">
        <Card className="border-white/70 bg-white/85 p-6 shadow-panel backdrop-blur-md sm:p-7">
          {/* ───────────────────────────────────────────────────────── identidad */}
          <div className="flex items-start gap-5">
            <span className="relative shrink-0">
              <span className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-brand-100 text-2xl font-bold text-brand-600">
                {user?.avatar_url ? (
                  <img src={user.avatar_url} alt="" className="h-20 w-20 object-cover" />
                ) : (
                  `${user?.first_name?.[0] ?? ''}${user?.last_name?.[0] ?? ''}`.toUpperCase()
                )}
              </span>
              <span className="absolute -bottom-0.5 -right-0.5 flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-slate-100 text-slate-500">
                <Camera className="h-3.5 w-3.5" />
              </span>
            </span>

            <div className="min-w-0 pt-1">
              <h2 className="truncate text-xl font-bold tracking-tight text-ink">
                {user?.first_name} {user?.last_name}
              </h2>
              <p className="mt-0.5 truncate text-sm text-muted">{user?.email}</p>
              {/* Verde solo si la cuenta lo está: pintar «sin verificar» en verde engañaba. */}
              <span
                className={`mt-2.5 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                  verified ? 'bg-success-50 text-success-700' : 'bg-warning-50 text-warning-600'
                }`}
              >
                {verified ? <BadgeCheck className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
                {verified ? 'Cuenta verificada' : 'Cuenta sin verificar'}
              </span>
            </div>
          </div>

          {/* ──────────────────────────────────────────────── datos personales */}
          <dl className="mt-6 grid gap-x-10 gap-y-5 border-t border-border pt-6 sm:grid-cols-2">
            <Field icon={<User />} label="Nombres" value={user?.first_name} />
            <Field icon={<Phone />} label="Teléfono" value={user?.phone} />
            <Field icon={<Contact />} label="Apellidos" value={user?.last_name} />
            <Field icon={<IdCard />} label="Documento de identidad" missing />
            <Field icon={<CalendarDays />} label="Fecha de nacimiento" missing />
            <Field icon={<MapPin />} label="País" missing />
            <Field icon={<User />} label="Estado de la cuenta" value={<StatusBadge status={user?.status} />} />
            <Field icon={<CalendarDays />} label="Miembro desde" value={formatDate(user?.created_at)} />
          </dl>

          {/* ────────────────────────────────────────────────────── preferencias */}
          <div className="mt-6 border-t border-border pt-6">
            <h3 className="text-[15px] font-bold text-ink">Preferencias de viaje</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Preference icon={<Armchair className="h-4 w-4" />} label="Asiento preferido" />
              <Preference icon={<Route className="h-4 w-4" />} label="Tipo de servicio" />
              <Preference icon={<LayoutList className="h-4 w-4" />} label="Boletos por página" />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted">
              Las preferencias de viaje requieren una extensión del esquema; están documentadas en PENDIENTES.md.
            </p>
          </div>

          {/* ───────────────────────────────────────────────────────── seguridad */}
          <div id="seguridad" className="mt-6 scroll-mt-24 border-t border-border pt-6">
            <h3 className="text-[15px] font-bold text-ink">Seguridad</h3>
            <p className="mt-0.5 text-sm text-muted">Actualiza tu contraseña de acceso.</p>

            <form onSubmit={savePassword} className="mt-4 grid gap-5 sm:grid-cols-2">
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
                <Button type="submit" loading={savingPassword}>
                  Cambiar contraseña
                </Button>
              </div>
            </form>

            <LinkedProvider />
          </div>
        </Card>

        {/* ═══════════════════════════════════════════════════ columna derecha */}
        <div className="grid content-start gap-6 sm:grid-cols-2 xl:grid-cols-1">
          <Card padded={false} className="overflow-hidden border-white/70 bg-white/85 shadow-panel backdrop-blur-md">
            <div className="flex items-center gap-3 bg-gradient-to-r from-brand-500 to-brand-600 px-5 py-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-white/20 text-white">
                <BarChart3 className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h2 className="text-[15px] font-bold text-white">Resumen de tu cuenta</h2>
                <p className="mt-0.5 text-xs leading-snug text-white/85">Aquí puedes ver un resumen de tu actividad.</p>
              </div>
            </div>

            <dl className="divide-y divide-border">
              <SummaryRow icon={<Ticket className="h-[18px] w-[18px]" />} label="Viajes realizados" value={formatNumber(totals.trips_taken ?? 0)} />
              <SummaryRow icon={<Wallet className="h-[18px] w-[18px]" />} label="Gasto total" value={formatCurrency(totals.total_spent ?? 0)} />
              <SummaryRow
                icon={<Star className="h-[18px] w-[18px]" />}
                label="Puntos acumulados"
                value={<span className="text-sm font-semibold text-slate-400">No disponible</span>}
              />
            </dl>

            <p className="border-t border-border px-5 py-3 text-xs text-muted">
              El programa de puntos no existe en el esquema actual.
            </p>
          </Card>

          <Card className="relative overflow-hidden border-brand-100/70 bg-brand-50/85 p-5 shadow-panel backdrop-blur-md">
            <div className="relative z-10 max-w-[62%]">
              <span className="flex h-11 w-11 items-center justify-center rounded-control bg-brand-500 text-white">
                <Gift className="h-5 w-5" />
              </span>
              <h2 className="mt-3 text-[17px] font-bold text-ink">Invita a tus amigos</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted">Gana puntos y descuentos por cada amigo que viaje.</p>
              <Button size="sm" className="mt-4" disabled title="Disponible próximamente">
                Invitar amigos
              </Button>
            </div>
            {/* Decoración: el regalo del mockup. No es un control, no hace nada. */}
            <Gift
              className="pointer-events-none absolute -bottom-5 -right-5 h-36 w-36 text-brand-200"
              strokeWidth={1.25}
              aria-hidden
            />
          </Card>

          <Card className="border-white/70 bg-white/85 p-5 shadow-panel backdrop-blur-md">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-500">
                <Clock className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h2 className="text-[15px] font-bold text-ink">Actividad</h2>
                <p className="mt-0.5 text-xs leading-snug text-muted">Tu actividad reciente en la plataforma.</p>
              </div>
            </div>
            <dl className="mt-5 space-y-3.5">
              <ActivityRow icon={<Clock className="h-[18px] w-[18px]" />} label="Último acceso" value={formatDateTime(user?.last_login_at)} />
              <ActivityRow icon={<CalendarDays className="h-[18px] w-[18px]" />} label="Viajes próximos" value={formatNumber(totals.upcoming ?? 0)} />
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


/**
 * Un dato personal: icono tenue, etiqueta pequeña y valor destacado. Sin recuadro.
 *
 * Lo que no existe se escribe en gris claro y con peso normal, de modo que la cuadrícula
 * distingue sola lo registrado de lo que falta, sin necesidad de leerlo.
 */
function Field({ icon, label, value, missing = false }: { icon: ReactNode; label: string; value?: ReactNode; missing?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0 text-slate-400 [&>svg]:h-[18px] [&>svg]:w-[18px]" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="text-[13px] leading-tight text-muted">{label}</dt>
        <dd className={missing ? 'mt-1 text-[15px] text-slate-400' : 'mt-1 text-[15px] font-semibold text-ink'}>
          {missing ? 'No registrado' : (value ?? '—')}
        </dd>
      </div>
    </div>
  );
}

/** Preferencia: píldora horizontal con el chevron del mockup. Es informativa, no un enlace. */
function Preference({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-control bg-slate-50 px-2.5 py-2.5">
      <span className="shrink-0 text-slate-500 [&>svg]:h-4 [&>svg]:w-4" aria-hidden>
        {icon}
      </span>
      {/* Sin `truncate`: cortar «Asiento preferido» a «Asiento…» se lee peor que dejar que
          la etiqueta ocupe dos líneas cuando la columna se estrecha. */}
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] leading-tight text-muted">{label}</span>
        <span className="mt-1 block text-xs leading-tight text-slate-400">No disponible</span>
      </span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-300" aria-hidden />
    </div>
  );
}

function SummaryRow({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3.5">
      <dt className="flex min-w-0 items-center gap-3 text-sm text-slate-600">
        <span className="shrink-0 text-brand-500" aria-hidden>
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </dt>
      <dd className="shrink-0 text-right text-[15px] font-bold text-ink">{value}</dd>
    </div>
  );
}

function ActivityRow({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <dt className="flex shrink-0 items-center gap-3 text-sm text-slate-600">
        <span className="shrink-0 text-brand-500" aria-hidden>
          {icon}
        </span>
        {label}
      </dt>
      <dd className="ml-auto text-right text-sm font-bold text-ink">{value}</dd>
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
      <h3 className="text-[15px] font-bold text-ink">Inicio de sesión con proveedor</h3>
      <p className="mt-0.5 text-sm text-muted">
        Vincula una cuenta para entrar sin escribir tu contraseña. Solo puedes tener un proveedor a la vez.
      </p>

      {link.loading ? (
        <p className="mt-4 text-sm text-muted">Consultando…</p>
      ) : current ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-control border border-border p-3.5">
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
