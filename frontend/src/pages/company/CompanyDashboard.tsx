import { AlertTriangle, BusFront, CheckCircle2, DollarSign, Route, Ticket, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { DonutChart, SalesAreaChart } from '@/components/charts/Charts';
import { Card, CardHeader, ErrorState, LoadingState, PageHeader, StatCard, StatusBadge } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useAsync } from '@/hooks/useAsync';
import { dashboardService } from '@/services';
import { PAYMENT_METHOD_LABELS } from '@/constants/labels';
import { formatCurrency, formatNumber, formatTime } from '@/utils/format';

interface CompanyDashboardData {
  totals: Record<string, number> | null;
  salesSeries: Array<{ day: string; amount: number }>;
  upcomingTrips: Array<Record<string, unknown>>;
  paymentMethods: Array<{ method: string; amount: number; payments: number }>;
  topRoutes: Array<{ route: string; revenue: number; bookings: number }>;
  alerts: Record<string, number> | null;
}

const WEEKDAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export function CompanyDashboard() {
  const { user } = useAuth();
  const dashboard = useAsync(() => dashboardService.company() as Promise<unknown>, []);

  /* El encabezado se pinta siempre (F17C-NAV-02): el nombre ya lo da la sesión, así que mientras
     llega el resumen el indicador ocupa solo la zona de los datos. Igual que «Identidad visual». */
  return (
    <>
      <PageHeader
        title={`¡Bienvenido de nuevo, ${user?.first_name}!`}
        description="Aquí tienes un resumen general de tu empresa."
      />
      {dashboard.loading ? (
        <LoadingState label="Cargando tu panel..." className="min-h-[60vh]" />
      ) : dashboard.error || !dashboard.data ? (
        <Card padded={false}>
          <ErrorState error={dashboard.error} onRetry={dashboard.reload} />
        </Card>
      ) : (
        <DashboardBody data={dashboard.data as CompanyDashboardData} />
      )}
    </>
  );
}

/** Cuerpo del panel: solo se monta cuando el resumen ya está disponible. */
function DashboardBody({ data }: { data: CompanyDashboardData }) {
  const totals = data.totals ?? {};
  const alerts = data.alerts ?? {};

  const salesToday = Number(totals.sales_today ?? 0);
  const salesYesterday = Number(totals.sales_yesterday ?? 0);
  const delta = salesYesterday > 0 ? ((salesToday - salesYesterday) / salesYesterday) * 100 : null;

  const weekTotal = data.salesSeries.reduce((sum, point) => sum + Number(point.amount), 0);
  const series = data.salesSeries.map((point) => ({
    label: WEEKDAYS[new Date(`${point.day}T00:00:00`).getDay()] ?? point.day,
    value: Number(point.amount),
  }));

  const methods = data.paymentMethods.map((entry) => ({
    label: PAYMENT_METHOD_LABELS[entry.method] ?? entry.method,
    value: Number(entry.amount),
  }));

  const alertItems = [
    { key: 'buses_maintenance', label: 'buses en mantenimiento', description: 'Revisa el estado de tu flota', to: '/company/buses' },
    { key: 'tickets_open', label: 'tickets de soporte abiertos', description: 'Requieren tu respuesta', to: '/company/support' },
    { key: 'settlements_pending', label: 'liquidaciones pendientes', description: 'Pendientes de pago', to: '/company/settlements' },
    { key: 'reviews_pending', label: 'reseñas por moderar', description: 'Responde a tus pasajeros', to: '/company/reviews' },
  ].filter((item) => Number(alerts[item.key] ?? 0) > 0);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Ventas de hoy"
          value={formatCurrency(salesToday)}
          icon={<DollarSign className="h-5 w-5" />}
          tone="brand"
          delta={delta === null ? null : { value: `${Math.abs(delta).toFixed(1)}% vs ayer`, positive: delta >= 0 }}
        />
        <StatCard label="Pasajes vendidos" value={formatNumber(totals.tickets_sold ?? 0)} icon={<Ticket className="h-5 w-5" />} tone="purple" />
        <StatCard label="Viajes programados hoy" value={formatNumber(totals.trips_today ?? 0)} icon={<BusFront className="h-5 w-5" />} tone="info" hint="Hoy" />
        <StatCard
          label="Buses activos"
          value={`${formatNumber(totals.buses_active ?? 0)} / ${formatNumber(totals.buses_total ?? 0)}`}
          icon={<CheckCircle2 className="h-5 w-5" />}
          tone="success"
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            as="h2"
            title="Ventas"
            description={`${formatCurrency(weekTotal)} en los últimos 7 días`}
            action={<span className="rounded-control border border-border px-3 py-1.5 text-sm text-slate-600">Esta semana</span>}
          />
          <div className="mt-4">
            {series.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted">Aún no hay ventas registradas en este periodo.</p>
            ) : (
              <SalesAreaChart data={series} />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader as="h2" title="Próximos viajes" action={<Link to="/company/trips" className="text-sm font-medium text-brand-600">Ver todos</Link>} />
          {data.upcomingTrips.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">No hay viajes programados.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {data.upcomingTrips.map((trip) => {
                const seatsSold = Number(trip.seats_sold ?? 0);
                const capacity = Number(trip.capacity ?? 0);
                return (
                  <li key={String(trip.id)} className="flex items-center justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink">{formatTime(String(trip.departure_datetime))}</p>
                      <p className="truncate text-sm text-muted">
                        {String(trip.origin_city)} → {String(trip.destination_city)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs text-muted">
                        {String(trip.bus_code)} · {seatsSold}/{capacity}
                      </p>
                      <StatusBadge status={String(trip.status)} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader as="h2" title="Ventas por método de pago" />
          {methods.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted">Sin pagos registrados todavía.</p>
          ) : (
            <DonutChart data={methods} />
          )}
        </Card>

        <Card>
          <CardHeader as="h2" title="Top rutas" action={<Link to="/company/reports" className="text-sm font-medium text-brand-600">Ver reporte</Link>} />
          {data.topRoutes.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted">Sin ventas por ruta todavía.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {data.topRoutes.map((route) => {
                const max = Math.max(...data.topRoutes.map((entry) => Number(entry.revenue)), 1);
                return (
                  <li key={route.route}>
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate text-slate-600">{route.route}</span>
                      <span className="shrink-0 font-semibold text-ink">{formatCurrency(route.revenue)}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-brand-500" style={{ width: `${(Number(route.revenue) / max) * 100}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader as="h2" title="Alertas importantes" />
          {alertItems.length === 0 ? (
            <div className="flex items-center gap-3 rounded-card bg-success-50 p-4">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-success-600" />
              <p className="text-sm">
                <span className="block font-semibold text-ink">Todo en orden</span>
                <span className="text-muted">No hay problemas con tus viajes programados</span>
              </p>
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {alertItems.map((item) => (
                <li key={item.key}>
                  <Link to={item.to} className="flex items-start gap-3 rounded-card bg-warning-50 p-3 transition hover:bg-warning-100">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-600" />
                    <span className="text-sm">
                      <span className="block font-semibold text-ink">
                        {alerts[item.key]} {item.label}
                      </span>
                      <span className="text-muted">{item.description}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Rutas registradas" value={formatNumber(totals.routes_total ?? 0)} icon={<Route className="h-5 w-5" />} tone="info" />
        <StatCard label="Reservas pendientes" value={formatNumber(totals.bookings_pending ?? 0)} icon={<Ticket className="h-5 w-5" />} tone="warning" />
        <StatCard label="Ventas de la semana" value={formatCurrency(weekTotal)} icon={<TrendingUp className="h-5 w-5" />} tone="success" />
        <StatCard label="Ventas de ayer" value={formatCurrency(salesYesterday)} icon={<DollarSign className="h-5 w-5" />} tone="brand" />
      </div>
    </>
  );
}
