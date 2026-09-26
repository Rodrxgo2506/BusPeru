import { BookOpen } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, Input, LoadingState, Modal, PageHeader, TablePagination, type Column } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { useList } from '@/hooks/useList';
import { ApiError } from '@/services/api';
import { complaintService } from '@/services/company-profile';
import type { ComplaintDetail, ComplaintRow } from '@/types/company-profile';
import { complaintEventLabel } from '@/utils/company-profile';
import { formatDate, formatDateTime } from '@/utils/format';

/**
 * F18-19 · hojas del Libro de Reclamaciones de BusPerú RELACIONADAS con esta empresa. La empresa las ve sin
 * los datos de contacto del consumidor y puede dejar su descargo; la respuesta formal la da BusPerú.
 */
const STATUS: Record<string, { label: string; tone: 'warning' | 'info' | 'success' | 'neutral' }> = {
  RECEIVED: { label: 'Recibida', tone: 'warning' },
  IN_REVIEW: { label: 'En revisión', tone: 'info' },
  ANSWERED: { label: 'Respondida', tone: 'success' },
  CLOSED: { label: 'Cerrada', tone: 'neutral' },
};

export function CompanyComplaintsPage() {
  const list = useList<ComplaintRow>((params) => complaintService.companyList(params));
  const [selected, setSelected] = useState<number | null>(null);
  const columns: Array<Column<ComplaintRow>> = [
    { key: 'code', header: 'Hoja', render: (row) => <span className="font-semibold text-ink">{row.code}</span> },
    { key: 'kind', header: 'Tipo', render: (row) => (row.kind === 'RECLAMO' ? 'Reclamo' : 'Queja') },
    { key: 'item', header: 'Servicio', render: (row) => <span className="block max-w-xs truncate">{row.item_description}</span> },
    { key: 'dates', header: 'Registro / límite', render: (row) => <span className="text-xs">{formatDateTime(row.created_at)}<span className="block text-muted">{formatDate(row.due_date)}</span></span> },
    { key: 'status', header: 'Estado', render: (row) => <Badge tone={STATUS[row.status]?.tone ?? 'neutral'}>{STATUS[row.status]?.label ?? row.status}</Badge> },
  ];
  return (
    <>
      <PageHeader
        title="Libro de Reclamaciones"
        description="Reclamos y quejas registrados en el Libro de BusPerú que mencionan a tu empresa. Puedes aportar tu descargo; BusPerú da la respuesta formal."
        breadcrumbs={[{ label: 'Portal Empresa' }, { label: 'Libro de Reclamaciones' }]}
      />
      <Card padded={false}>
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : (
          <>
            <DataTable columns={columns} rows={list.rows} rowKey={(row) => row.id} loading={list.loading} onRowClick={(row) => setSelected(row.id)}
              emptyState={<EmptyState title="Sin hojas relacionadas" description="No hay reclamos ni quejas que mencionen a tu empresa." icon={<BookOpen className="h-7 w-7" />} />} />
            {!list.loading && list.rows.length > 0 && <TablePagination pagination={list.pagination} onPageChange={list.setPage} />}
          </>
        )}
      </Card>
      {selected !== null && <Detail id={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function Detail({ id, onClose }: { id: number; onClose: () => void }) {
  const toast = useToast();
  const detail = useAsync(() => complaintService.companyDetail(id), [id]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const d: ComplaintDetail | null = detail.data;
  const send = async () => {
    setBusy(true);
    try {
      detail.setData(await complaintService.companyNote(id, note.trim()));
      setNote('');
      toast.success('Descargo registrado.');
    } catch (error) {
      toast.error('No se pudo registrar', error instanceof ApiError ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={d ? `Hoja ${d.code}` : 'Hoja'} size="lg">
      {detail.error ? <ErrorState error={detail.error} onRetry={detail.reload} /> : !d ? <LoadingState /> : (
        <div className="space-y-4 text-sm">
          <p><strong>{d.kind === 'RECLAMO' ? 'Reclamo' : 'Queja'}</strong> de {d.consumer_name} · {formatDateTime(d.created_at)} · límite {formatDate(d.due_date)}</p>
          <p><span className="text-muted">Servicio:</span> {d.item_description}{d.booking_code ? ` · Reserva ${d.booking_code}` : ''}</p>
          <div><p className="font-semibold text-ink">Detalle</p><p className="whitespace-pre-line">{d.detail}</p></div>
          <div><p className="font-semibold text-ink">Pedido</p><p className="whitespace-pre-line">{d.request}</p></div>
          {d.response && <div className="rounded-control bg-success-50 p-3"><p className="font-semibold">Respuesta de BusPerú</p><p className="whitespace-pre-line">{d.response}</p></div>}
          <div>
            <p className="font-semibold text-ink">Historial</p>
            <ol className="mt-2 space-y-1.5">
              {d.events.map((event) => (
                <li key={event.id} className="rounded bg-slate-50 px-3 py-1.5">
                  {complaintEventLabel(event.event, event.to_status)} ·{' '}<span className="text-muted">{formatDateTime(event.created_at)}</span>
                  {event.note && <p className="whitespace-pre-line text-slate-700">{event.note}</p>}
                </li>
              ))}
            </ol>
          </div>
          <div className="flex gap-2">
            <Input aria-label="Descargo" placeholder="Tu descargo o información para BusPerú" value={note} onChange={(event) => setNote(event.target.value)} containerClassName="flex-1" />
            <Button loading={busy} disabled={note.trim().length < 3} onClick={() => void send()}>Enviar</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
