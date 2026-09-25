import { BarChart3, Download, FileText, Percent, Receipt, Wallet } from 'lucide-react';
import { useState } from 'react';
import { CategoryBarChart, DonutChart } from '@/components/charts/Charts';
import { ResourceForm } from '@/components/common/ResourceForm';
import { ResourcePage } from '@/components/common/ResourcePage';
import {
  Badge,
  Button,
  Card,
  CardHeader,
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
  TablePagination,
  TableSkeleton,
  type Column,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { useList } from '@/hooks/useList';
import { ApiError } from '@/services/api';
import { commissionService, companyService, financeService, reportService } from '@/services';
import type { Settlement } from '@/types';
import { TRANSACTION_TYPE_LABELS } from '@/constants/labels';
import { formatCurrency, formatDate, formatDateTime, formatNumber, todayIso } from '@/utils/format';

export function SettlementsPage({ scope }: { scope: 'company' | 'admin' }) {
  const toast = useToast();
  const { hasPermission } = useAuth();
  const summary = useAsync(() => financeService.settlementSummary(), []);
  const list = useList<Settlement>((params) => financeService.settlements(params));
  const companies = useAsync(() => (scope === 'admin' ? companyService.list({ limit: 200 }) : Promise.resolve({ data: [] })), [scope]);

  const [generating, setGenerating] = useState(false);
  const [detail, setDetail] = useState<Settlement | null>(null);
  const detailData = useAsync(() => (detail ? financeService.settlement(detail.id) : Promise.resolve(null)), [detail?.id]);

  const columns: Array<Column<Settlement>> = [
    { key: 'code', header: 'Código', render: (settlement) => <span className="font-semibold text-brand-600">{settlement.settlement_code}</span> },
    ...(scope === 'admin' ? [{ key: 'company', header: 'Empresa', render: (settlement: Settlement) => settlement.company_name ?? '—' }] : []),
    {
      key: 'period',
      header: 'Periodo',
      sortColumn: 's.period_start',
      render: (settlement) => (
        <span className="text-sm text-slate-600">
          {formatDate(settlement.period_start)} — {formatDate(settlement.period_end)}
        </span>
      ),
    },
    { key: 'gross', header: 'Ventas totales', render: (settlement) => formatCurrency(settlement.gross_amount), hideOnMobile: true },
    { key: 'commission', header: 'Comisión', render: (settlement) => <span className="text-danger-600">- {formatCurrency(settlement.commission_amount)}</span>, hideOnMobile: true },
    { key: 'net', header: 'Monto líquido', sortColumn: 's.net_amount', render: (settlement) => <span className="font-bold text-success-700">{formatCurrency(settlement.net_amount)}</span> },
    { key: 'status', header: 'Estado', render: (settlement) => <StatusBadge status={settlement.status} /> },
    {
      key: 'actions',
      header: 'Acciones',
      headerClassName: 'text-right',
      className: 'text-right',
      render: (settlement) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDetail(settlement)}>
            Ver detalle
          </Button>
          {scope === 'admin' && settlement.status === 'PENDING' && hasPermission('settings.update') && (
            <Button
              size="sm"
              variant="success"
              onClick={async () => {
                try {
                  await financeService.updateSettlement(settlement.id, { status: 'PAID' });
                  toast.success('Liquidación marcada como pagada.');
                  list.reload();
                  summary.reload();
                } catch (error) {
                  toast.error('No se pudo actualizar', error instanceof ApiError ? error.message : undefined);
                }
              }}
            >
              Marcar pagada
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Liquidaciones"
        description="Consulta y gestiona las liquidaciones generadas a partir de las transacciones financieras."
        breadcrumbs={[{ label: scope === 'company' ? 'Portal Empresa' : 'Administración' }, { label: 'Liquidaciones' }]}
        actions={
          hasPermission('settings.update') ? (
            <Button icon={<Wallet className="h-4 w-4" />} onClick={() => setGenerating(true)}>
              Generar liquidación
            </Button>
          ) : undefined
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total liquidaciones" value={formatCurrency(summary.data?.total ?? 0)} icon={<Wallet className="h-5 w-5" />} tone="brand" />
        <StatCard label="Pendientes" value={formatCurrency(summary.data?.pending ?? 0)} icon={<Receipt className="h-5 w-5" />} tone="warning" />
        <StatCard label="Pagadas" value={formatCurrency(summary.data?.paid ?? 0)} icon={<Wallet className="h-5 w-5" />} tone="success" />
        <StatCard label="Anuladas" value={formatCurrency(summary.data?.cancelled ?? 0)} icon={<Receipt className="h-5 w-5" />} tone="danger" />
      </div>

      <Card padded={false}>
        <div className="border-b border-border p-4">
          <FilterBar>
            <SearchBar className="min-w-0 flex-1 sm:max-w-sm" placeholder="Buscar por código o empresa..." value={list.search} onChange={(event) => list.setSearch(event.target.value)} />
            <Select
              options={[
                { value: 'PENDING', label: 'Pendiente' },
                { value: 'PROCESSING', label: 'Procesando' },
                { value: 'PAID', label: 'Pagada' },
                { value: 'CANCELLED', label: 'Anulada' },
              ]}
              placeholder="Todos los estados"
              value={list.filters.status ?? ''}
              onChange={(event) => list.setFilter('status', event.target.value || null)}
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
              rowKey={(settlement) => settlement.id}
              sort={list.sort}
              onSort={list.toggleSort}
              loading={list.loading}
              loadingState={<TableSkeleton />}
              emptyState={<EmptyState title="No hay liquidaciones" description="Genera una liquidación para un periodo con transacciones completadas." icon={<Wallet className="h-7 w-7" />} />}
            />
            {!list.loading && list.rows.length > 0 && <TablePagination pagination={list.pagination} onPageChange={list.setPage} />}
          </>
        )}
      </Card>

      <ResourceForm
        open={generating}
        onClose={() => setGenerating(false)}
        title="Generar liquidación"
        description="Se agruparán las transacciones completadas del periodo que aún no formen parte de otra liquidación."
        submitLabel="Generar"
        fields={[
          ...(scope === 'admin'
            ? [
                {
                  name: 'company_id',
                  label: 'Empresa',
                  type: 'select' as const,
                  required: true,
                  options: (companies.data?.data ?? []).map((company) => ({ value: company.id, label: company.name })),
                },
              ]
            : []),
          { name: 'period_start', label: 'Inicio del periodo', type: 'date', required: true },
          { name: 'period_end', label: 'Fin del periodo', type: 'date', required: true },
        ]}
        initialValues={{ period_start: todayIso().slice(0, 8) + '01', period_end: todayIso() }}
        onSubmit={async (values) => {
          await financeService.createSettlement(values);
          toast.success('Liquidación generada correctamente.');
          list.reload();
          summary.reload();
        }}
      />

      <Modal open={detail !== null} onClose={() => setDetail(null)} size="lg" title={`Liquidación ${detail?.settlement_code ?? ''}`}>
        {detailData.loading ? (
          <TableSkeleton rows={4} columns={3} />
        ) : detailData.data ? (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Empresa" value={detailData.data.company_name ?? '—'} />
              <Field label="Periodo" value={`${formatDate(detailData.data.period_start)} — ${formatDate(detailData.data.period_end)}`} />
              <Field label="Estado" value={<StatusBadge status={detailData.data.status} />} />
              <Field label="Fecha de pago" value={formatDateTime(detailData.data.paid_at)} />
            </div>

            <div className="rounded-card border border-border p-4">
              <p className="mb-3 font-semibold text-ink">Resumen de montos</p>
              <dl className="space-y-1.5 text-sm">
                <RowItem label="Ventas totales" value={formatCurrency(detailData.data.gross_amount)} />
                <RowItem label="Comisión BusPerú" value={`- ${formatCurrency(detailData.data.commission_amount)}`} />
                <RowItem label="Reembolsos" value={`- ${formatCurrency(detailData.data.refund_amount)}`} />
                <RowItem label="Ajustes" value={formatCurrency(detailData.data.adjustment_amount)} />
                <div className="flex justify-between border-t border-border pt-2">
                  <dt className="font-semibold text-ink">Monto líquido</dt>
                  <dd className="text-lg font-bold text-success-700">{formatCurrency(detailData.data.net_amount)}</dd>
                </div>
              </dl>
            </div>

            <div>
              <p className="mb-3 font-semibold text-ink">Detalle ({detailData.data.items?.length ?? 0} movimientos)</p>
              <ul className="max-h-64 space-y-2 overflow-y-auto text-sm">
                {(detailData.data.items ?? []).map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-3 border-b border-border pb-2 last:border-0">
                    <span className="min-w-0">
                      <Badge>{TRANSACTION_TYPE_LABELS[item.type] ?? item.type}</Badge>
                      <span className="ml-2 text-slate-600">{item.description ?? item.booking_code ?? '—'}</span>
                    </span>
                    <span className="shrink-0 font-medium">{formatCurrency(item.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <ErrorState error={detailData.error} onRetry={detailData.reload} />
        )}
      </Modal>
    </>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 font-medium text-ink">{value}</p>
    </div>
  );
}

function RowItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}

export function FinancialTransactionsPage() {
  const summary = useAsync(() => financeService.transactionSummary(), []);
  const list = useList<Record<string, unknown>>((params) => financeService.transactions(params));

  const columns: Array<Column<Record<string, unknown> & { id: number }>> = [
    { key: 'date', header: 'Fecha', sortColumn: 'ft.transaction_date', render: (row) => formatDateTime(String(row.transaction_date)) },
    { key: 'type', header: 'Tipo', render: (row) => <Badge>{TRANSACTION_TYPE_LABELS[String(row.type)] ?? String(row.type)}</Badge> },
    { key: 'direction', header: 'Dirección', render: (row) => <Badge tone={row.direction === 'CREDIT' ? 'success' : 'danger'}>{row.direction === 'CREDIT' ? 'Ingreso' : 'Egreso'}</Badge>, hideOnMobile: true },
    { key: 'description', header: 'Descripción', render: (row) => <span className="text-slate-600">{String(row.description ?? '—')}</span> },
    { key: 'company', header: 'Empresa', render: (row) => String(row.company_name ?? '—'), hideOnMobile: true },
    { key: 'amount', header: 'Monto', sortColumn: 'ft.amount', render: (row) => <span className="font-semibold">{formatCurrency(Number(row.amount))}</span> },
    { key: 'status', header: 'Estado', render: (row) => <StatusBadge status={String(row.status)} /> },
  ];

  return (
    <>
      <PageHeader title="Transacciones financieras" description="Movimientos generados por pagos, comisiones, reembolsos y liquidaciones." breadcrumbs={[{ label: 'Administración' }, { label: 'Finanzas' }]} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Ingresos brutos" value={formatCurrency(summary.data?.gross_income ?? 0)} icon={<Receipt className="h-5 w-5" />} tone="success" />
        <StatCard label="Comisiones" value={formatCurrency(summary.data?.commissions ?? 0)} icon={<Percent className="h-5 w-5" />} tone="purple" />
        <StatCard label="Reembolsos" value={formatCurrency(summary.data?.refunds ?? 0)} icon={<Receipt className="h-5 w-5" />} tone="danger" />
        <StatCard label="Liquidado" value={formatCurrency(summary.data?.payouts ?? 0)} icon={<Wallet className="h-5 w-5" />} tone="info" />
      </div>

      <Card padded={false}>
        <div className="border-b border-border p-4">
          <FilterBar>
            <SearchBar className="min-w-0 flex-1 sm:max-w-sm" placeholder="Buscar por referencia o descripción..." value={list.search} onChange={(event) => list.setSearch(event.target.value)} />
            <Select
              options={Object.entries(TRANSACTION_TYPE_LABELS).map(([value, labelText]) => ({ value, label: labelText }))}
              placeholder="Todos los tipos"
              value={list.filters.type ?? ''}
              onChange={(event) => list.setFilter('type', event.target.value || null)}
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
              rows={list.rows as Array<Record<string, unknown> & { id: number }>}
              rowKey={(row) => row.id}
              sort={list.sort}
              onSort={list.toggleSort}
              loading={list.loading}
              loadingState={<TableSkeleton />}
              emptyState={<EmptyState title="No hay transacciones" description="Se registran automáticamente al confirmar pagos y procesar reembolsos." icon={<Receipt className="h-7 w-7" />} />}
            />
            {!list.loading && list.rows.length > 0 && <TablePagination pagination={list.pagination} onPageChange={list.setPage} />}
          </>
        )}
      </Card>
    </>
  );
}

const REPORT_LABELS: Record<string, { title: string; description: string }> = {
  'sales-by-date': { title: 'Ventas por fecha', description: 'Reporte de ventas agrupadas por fecha.' },
  'sales-by-route': { title: 'Ventas por ruta', description: 'Reporte de ventas agrupadas por ruta.' },
  'sales-by-bus': { title: 'Ventas por bus', description: 'Reporte de ventas agrupadas por bus.' },
  'payment-methods': { title: 'Métodos de pago', description: 'Reporte de ventas por método de pago.' },
  cancellations: { title: 'Cancelaciones', description: 'Reporte de cancelaciones de boletos.' },
  passengers: { title: 'Pasajeros', description: 'Reporte de pasajeros por viaje.' },
  occupancy: { title: 'Ocupación', description: 'Ocupación de los viajes por ruta.' },
};

export function ReportsPage({ scope }: { scope: 'company' | 'admin' }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [range, setRange] = useState({ from: '', to: '' });

  const report = useAsync(() => (selected ? reportService.run(selected, { from: range.from || undefined, to: range.to || undefined }) : Promise.resolve(null)), [selected, range.from, range.to]);

  const rows = report.data?.rows ?? [];
  const chartData = rows
    .slice(0, 12)
    .map((row) => ({ label: String(row.label ?? ''), value: Number(row.revenue ?? row.bookings ?? row.cancellations ?? row.seats_sold ?? 0) }));

  return (
    <>
      <PageHeader
        title="Reportes"
        description={scope === 'company' ? 'Genera y descarga los reportes de tu operación.' : 'Genera y descarga los reportes de toda la plataforma.'}
        breadcrumbs={[{ label: scope === 'company' ? 'Portal Empresa' : 'Administración' }, { label: 'Reportes' }]}
        actions={
          rows.length > 0 ? (
            <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={() => downloadCsv(selected ?? 'reporte', rows)}>
              Exportar CSV
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries(REPORT_LABELS).map(([key, meta]) => (
          <Card key={key} className={selected === key ? 'border-brand-500 ring-1 ring-brand-500/20' : undefined}>
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                <FileText className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="font-semibold text-ink">{meta.title}</p>
                <p className="mt-0.5 text-sm text-muted">{meta.description}</p>
              </div>
            </div>
            <Button size="sm" variant={selected === key ? 'primary' : 'outline'} className="mt-4" onClick={() => setSelected(key)}>
              Generar
            </Button>
          </Card>
        ))}
      </div>

      {selected && (
        <Card className="mt-6" padded={false}>
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border p-5">
            <CardHeader title={REPORT_LABELS[selected]?.title ?? selected} description={REPORT_LABELS[selected]?.description} />
            <div className="flex flex-wrap gap-3">
              <label className="text-sm">
                <span className="field-label">Desde</span>
                <input
                  type="date"
                  value={range.from}
                  onChange={(event) => setRange({ ...range, from: event.target.value })}
                  className="h-11 rounded-control border border-border px-3 text-sm focus:border-brand-500 focus:outline-none"
                />
              </label>
              <label className="text-sm">
                <span className="field-label">Hasta</span>
                <input
                  type="date"
                  value={range.to}
                  onChange={(event) => setRange({ ...range, to: event.target.value })}
                  className="h-11 rounded-control border border-border px-3 text-sm focus:border-brand-500 focus:outline-none"
                />
              </label>
            </div>
          </div>

          {report.loading ? (
            <TableSkeleton />
          ) : report.error ? (
            <ErrorState error={report.error} onRetry={report.reload} />
          ) : rows.length === 0 ? (
            <EmptyState title="Sin datos para este reporte" description="No hay registros en el periodo seleccionado." icon={<BarChart3 className="h-7 w-7" />} />
          ) : (
            <>
              <div className="p-5">
                {selected === 'payment-methods' ? <DonutChart data={chartData} /> : <CategoryBarChart data={chartData} />}
              </div>
              <div className="overflow-x-auto border-t border-border">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-border bg-slate-50/80 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {Object.keys(rows[0] ?? {}).map((key) => (
                        <th key={key} className="px-4 py-3">
                          {key}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={index} className="border-b border-border/70 last:border-0">
                        {Object.entries(row).map(([key, value]) => (
                          <td key={key} className="px-4 py-3 text-slate-700">
                            {typeof value === 'number' && (key.includes('revenue') || key.includes('amount') || key.includes('spent'))
                              ? formatCurrency(value)
                              : typeof value === 'number'
                                ? formatNumber(value)
                                : String(value ?? '—')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}
    </>
  );
}

function downloadCsv(name: string, rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0] ?? {});
  const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const csv = [headers.join(','), ...rows.map((row) => headers.map((header) => escape(row[header])).join(','))].join('\n');

  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}-${todayIso()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function CommissionsPage() {
  const companies = useAsync(() => companyService.list({ limit: 200 }), []);

  return (
    <ResourcePage<{ id: number; company_id: number; commission_type: string; commission_value: number; status: string; company_name?: string; effective_from: string }>
      title="Comisiones"
      description="Comisión que BusPerú aplica sobre las ventas de cada empresa."
      breadcrumbs={[{ label: 'Administración' }, { label: 'Comisiones' }]}
      loader={(params) => commissionService.list(params)}
      columns={[
        { key: 'company', header: 'Empresa', render: (row) => <span className="font-medium text-ink">{row.company_name ?? `#${row.company_id}`}</span> },
        { key: 'type', header: 'Tipo', render: (row) => <Badge>{row.commission_type === 'PERCENTAGE' ? 'Porcentaje' : 'Monto fijo'}</Badge> },
        { key: 'value', header: 'Valor', render: (row) => (row.commission_type === 'PERCENTAGE' ? `${row.commission_value}%` : formatCurrency(row.commission_value)) },
        { key: 'from', header: 'Vigente desde', sortColumn: 'cs.effective_from', render: (row) => formatDate(row.effective_from) },
        { key: 'status', header: 'Estado', render: (row) => <StatusBadge status={row.status} /> },
      ]}
      permissionModule="settings"
      entityLabel="Comisión"
      entityGender="f"
      searchPlaceholder="Buscar por empresa..."
      filters={[
        {
          key: 'status',
          placeholder: 'Todos los estados',
          options: [
            { value: 'ACTIVE', label: 'Activa' },
            { value: 'INACTIVE', label: 'Inactiva' },
          ],
        },
      ]}
      formFields={[
        {
          name: 'company_id',
          label: 'Empresa',
          type: 'select',
          required: true,
          options: (companies.data?.data ?? []).map((company) => ({ value: company.id, label: company.name })),
        },
        {
          name: 'commission_type',
          label: 'Tipo de comisión',
          type: 'select',
          required: true,
          options: [
            { value: 'PERCENTAGE', label: 'Porcentaje (%)' },
            { value: 'FIXED', label: 'Monto fijo (S/)' },
          ],
        },
        { name: 'commission_value', label: 'Valor', type: 'number', step: '0.01', required: true, placeholder: '10.00' },
        { name: 'effective_from', label: 'Vigente desde', type: 'datetime-local', required: true },
        { name: 'effective_until', label: 'Vigente hasta', type: 'datetime-local' },
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
      onCreate={(values) => commissionService.create(values).then(() => undefined)}
      onUpdate={(id, values) => commissionService.update(id, values).then(() => undefined)}
      onDelete={(id) => commissionService.remove(id).then(() => undefined)}
      emptyTitle="No hay comisiones configuradas"
      emptyDescription="Define la comisión que aplicará BusPerú a cada empresa."
    />
  );
}
