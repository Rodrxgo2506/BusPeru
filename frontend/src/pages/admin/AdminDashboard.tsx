import { AlertTriangle, Building2, BusFront, CheckCircle2, DollarSign, Info, Percent, Receipt, Ticket, TrendingUp, Users, Wallet } from 'lucide-react';
import { Link } from 'react-router-dom';
import { DonutChart, SalesAreaChart } from '@/components/charts/Charts';
import { Card, CardHeader, ErrorState, LoadingState, PageHeader, StatCard } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { dashboardService } from '@/services';
import { AUDIT_ACTION_LABELS, PAYMENT_METHOD_LABELS } from '@/constants/labels';
import { formatCurrency, formatDate, formatDateTime, formatNumber } from '@/utils/format';

interface AdminDashboardData {
  totals: Record<string, number> | null;
  salesSeries: Array<{ day: string; amount: number; payments: number }>;
  topCompanies: Array<{ id: number; name: string; revenue: number; bookings: number }>;
  topRoutes: Array<{ route: string; bookings: number; revenue: number }>;
  paymentMethods: Array<{ method: string; amount: number; payments: number }>;
  recentActivity: Array<{ action: string; entity_type: string | null; description: string | null; created_at: string; first_name: string | null; last_name: string | null }>;
  alerts: Record<string, number> | null;
}

export function AdminDashboard() {
  const dashboard = useAsync(() => dashboardService.admin() as Promise<unknown>, []);

  if (dashboard.loading) return <LoadingState label="Cargando el panel de administración..." />;
  if (dashboard.error || !dashboard.data) {
    return (
      <Card padded={false}>
        <ErrorState error={dashboard.error} onRetry={dashboard.reload} />
      </Card>
    );
  }

  const data = dashboard.data as AdminDashboardData;
  const totals = data.totals ?? {};
  const alerts = data.alerts ?? {};

  const series = data.salesSeries.map((point) => ({ label: formatDate(point.day).slice(0, 6), value: Number(point.amount) }));
  const methods = data.paymentMethods.map((entry) => ({ label: PAYMENT_METHOD_LABELS[entry.method] ?? entry.method, value: Number(entry.amount) }));

  const alertItems = [
    { key: 'companies_pending', label: 'empresas pendientes de aprobación', description: 'Requieren revisión de documentos', to: '/admin/companies?status=PENDING', tone: 'warning' as const },
    { key: 'refunds_pending', label: 'reembolsos pendientes', description: 'Esperando aprobación', to: '/admin/refunds', tone: 'warning' as const },
    { key: 'tickets_open', label: 'tickets de soporte abiertos', description: 'Requieren atención', to: '/admin/support', tone: 'info' as const },
    { key: 'settlements_pending', label: 'liquidaciones pendientes', description: 'Pendientes de pago a empresas', to: '/admin/settlements', tone: 'info' as const },
    { key: 'reviews_pending', label: 'reseñas por moderar', description: 'Publicación pendiente', to: '/admin/reviews', tone: 'info' as const },
  ].filter((item) => Number(alerts[item.key] ?? 0) > 0);

  return (
    <>
      <PageHeader title="¡Bienvenido de vuelta, Admin!" description="Resumen general de la plataforma BusPerú" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Empresas registradas" value={formatNumber(totals.companies_total ?? 0)} icon={<Building2 className="h-5 w-5" />} tone="purple" />
        <StatCard label="Pendientes de aprobación" value={formatNumber(totals.companies_pending ?? 0)} icon={<AlertTriangle className="h-5 w-5" />} tone="warning" />
        <StatCard label="Usuarios registrados" value={formatNumber(totals.users_total ?? 0)} icon={<Users className="h-5 w-5" />} tone="info" />
        <StatCard label="Viajes activos" value={formatNumber(totals.trips_active ?? 0)} icon={<BusFront className="h-5 w-5" />} tone="success" />
        <StatCard label="Pasajes vendidos" value={formatNumber(totals.tickets_sold ?? 0)} icon={<Ticket className="h-5 w-5" />} tone="danger" />
        <StatCard label="Ingresos totales" value={formatCurrency(totals.revenue_total ?? 0)} icon={<DollarSign className="h-5 w-5" />} tone="brand" />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Reservas confirmadas" value={formatNumber(totals.bookings_confirmed ?? 0)} icon={<CheckCircle2 className="h-5 w-5" />} tone="success" />
        <StatCard label="Reembolsos procesados" value={formatNumber(totals.refunds_processed ?? 0)} icon={<Receipt className="h-5 w-5" />} tone="danger" />
        <StatCard label="Comisiones de BusPerú" value={formatCurrency(totals.commissions_total ?? 0)} icon={<Percent className="h-5 w-5" />} tone="purple" />
        <StatCard label="Liquidado a empresas" value={formatCurrency(totals.settlements_paid ?? 0)} icon={<Wallet className="h-5 w-5" />} tone="info" />
        <StatCard label="Viajes hoy" value={formatNumber(totals.trips_today ?? 0)} icon={<BusFront className="h-5 w-5" />} tone="brand" hint="En todas las empresas" />
        <StatCard label="Ingresos por pagos" value={formatCurrency(totals.revenue_total ?? 0)} icon={<TrendingUp className="h-5 w-5" />} tone="success" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Ventas de pasajes" description="Últimos 30 días" />
          <div className="mt-4">
            {series.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted">Aún no hay pagos registrados en la plataforma.</p>
            ) : (
              <SalesAreaChart data={series} height={280} />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Alertas importantes" action={<Link to="/admin/support" className="text-sm font-medium text-danger-600">Ver todas</Link>} />
          {alertItems.length === 0 ? (
            <div className="mt-4 flex items-center gap-3 rounded-card bg-success-50 p-4">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-success-600" />
              <p className="text-sm">
                <span className="block font-semibold text-ink">Todo en orden</span>
                <span className="text-muted">No hay alertas pendientes en la plataforma</span>
              </p>
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {alertItems.map((item) => (
                <li key={item.key}>
                  <Link
                    to={item.to}
                    className={`flex items-start gap-3 rounded-card p-3 transition ${item.tone === 'warning' ? 'bg-warning-50 hover:bg-warning-100' : 'bg-info-50 hover:bg-info-100'}`}
                  >
                    {item.tone === 'warning' ? (
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-600" />
                    ) : (
                      <Info className="mt-0.5 h-4 w-4 shrink-0 text-info-600" />
                    )}
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

      <div className="mt-6 grid gap-6 lg:grid-cols-4">
        <Card>
          <CardHeader title="Top empresas por ventas" />
          {data.topCompanies.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">Sin ventas registradas.</p>
          ) : (
            <ol className="mt-4 space-y-3">
              {data.topCompanies.map((company, index) => (
                <li key={company.id} className="flex items-center gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-600">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{company.name}</span>
                    <span className="text-xs text-muted">{company.bookings} reservas</span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold text-ink">{formatCurrency(company.revenue)}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card>
          <CardHeader title="Rutas más populares" />
          {data.topRoutes.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">Sin reservas registradas.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {data.topRoutes.map((route) => (
                <li key={route.route} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate text-slate-600">{route.route}</span>
                  <span className="shrink-0 font-semibold text-ink">{formatNumber(route.bookings)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Métodos de pago" />
          {methods.length === 0 ? <p className="py-10 text-center text-sm text-muted">Sin pagos.</p> : <DonutChart data={methods} height={220} />}
        </Card>

        <Card>
          <CardHeader title="Actividad reciente" action={<Link to="/admin/audit" className="text-sm font-medium text-danger-600">Ver todo</Link>} />
          {data.recentActivity.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">Sin actividad registrada.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {data.recentActivity.map((entry, index) => (
                <li key={index} className="border-b border-border pb-3 text-sm last:border-0 last:pb-0">
                  <p className="font-medium text-ink">{entry.description ?? AUDIT_ACTION_LABELS[entry.action] ?? entry.action}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {entry.first_name ? `${entry.first_name} ${entry.last_name} · ` : ''}
                    {formatDateTime(entry.created_at)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
