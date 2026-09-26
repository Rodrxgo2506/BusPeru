import { AlertTriangle, BookOpen } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, Input, LoadingState, Modal, PageHeader, Select, Textarea, TablePagination, type Column } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { useList } from '@/hooks/useList';
import { ApiError } from '@/services/api';
import { complaintService } from '@/services/complaint-book';
import type { ComplaintDetail, ComplaintRow } from '@/types/complaint-book';
import { complaintEventLabel } from '@/utils/complaint-book';
import { formatDate, formatDateTime } from '@/utils/format';

/**
 * F18-19 · Libro de Reclamaciones (ADMIN). Todo lo que se ve aquí lo protege la API (`requireRole('ADMIN')`); ocultar
 * el menú es solo comodidad.
 */

function message(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const fields = error.fields ? Object.values(error.fields as Record<string, string>) : [];
  return fields.length ? fields.join(' · ') : error.message;
}

const COMPLAINT_STATUS: Record<string, { label: string; tone: 'neutral' | 'warning' | 'success' | 'info' }> = {
  RECEIVED: { label: 'Recibida', tone: 'warning' },
  IN_REVIEW: { label: 'En revisión', tone: 'info' },
  ANSWERED: { label: 'Respondida', tone: 'success' },
  CLOSED: { label: 'Cerrada', tone: 'neutral' },
};

export function ComplaintStatusBadge({ status }: { status: string }) {
  const entry = COMPLAINT_STATUS[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}

export function ComplaintsAdminPage() {
  const list = useList<ComplaintRow>((params) => complaintService.list(params));
  const [selected, setSelected] = useState<number | null>(null);
  const columns: Array<Column<ComplaintRow>> = [
    { key: 'code', header: 'Hoja', render: (row) => <span><span className="block font-semibold text-ink">{row.code}</span><span className="text-xs text-muted">{row.kind === 'RECLAMO' ? 'Reclamo' : 'Queja'}</span></span> },
    { key: 'consumer', header: 'Consumidor', render: (row) => <span><span className="block">{row.consumer_name}</span><span className="block max-w-xs truncate text-xs text-muted">{row.item_description}</span></span> },
    { key: 'company', header: 'Empresa relacionada', render: (row) => row.company_name ?? '—' },
    { key: 'dates', header: 'Registro / límite', render: (row) => <span className="text-xs"><span className="block">{formatDateTime(row.created_at)}</span><span className={row.overdue ? 'font-semibold text-danger-600' : 'text-muted'}>{formatDate(row.due_date)}{row.overdue ? ' · VENCIDA' : ''}</span></span> },
    { key: 'status', header: 'Estado', render: (row) => <ComplaintStatusBadge status={row.status} /> },
  ];
  return (
    <>
      <PageHeader title="Libro de Reclamaciones" description="Hojas del Libro virtual de BusPerú. Plazo de respuesta: 15 días hábiles (DS 101-2022-PCM). Las hojas no se borran (se conservan 2 años)." breadcrumbs={[{ label: 'Configuración' }, { label: 'Libro de Reclamaciones' }]} />
      <Card padded={false}>
        <div className="flex flex-wrap gap-3 border-b border-border p-4">
          <Input aria-label="Buscar" placeholder="Código, nombre, documento o reserva" value={list.search} onChange={(event) => list.setSearch(event.target.value)} containerClassName="w-full sm:w-80" />
          <Select aria-label="Estado" placeholder="Todos los estados" value={list.filters.status ?? ''} onChange={(event) => list.setFilter('status', event.target.value || null)} options={Object.entries(COMPLAINT_STATUS).map(([value, entry]) => ({ value, label: entry.label }))} containerClassName="w-full sm:w-48" />
          <Select aria-label="Tipo" placeholder="Reclamos y quejas" value={list.filters.kind ?? ''} onChange={(event) => list.setFilter('kind', event.target.value || null)} options={[{ value: 'RECLAMO', label: 'Reclamos' }, { value: 'QUEJA', label: 'Quejas' }]} containerClassName="w-full sm:w-48" />
          <Select aria-label="Vencidas" placeholder="Todas" value={list.filters.overdue ?? ''} onChange={(event) => list.setFilter('overdue', event.target.value || null)} options={[{ value: 'true', label: 'Solo vencidas sin respuesta' }]} containerClassName="w-full sm:w-56" />
        </div>
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : (
          <>
            <DataTable columns={columns} rows={list.rows} rowKey={(row) => row.id} loading={list.loading} onRowClick={(row) => setSelected(row.id)}
              emptyState={<EmptyState title="No hay hojas" description="Aún no se ha registrado ningún reclamo o queja con estos filtros." icon={<BookOpen className="h-7 w-7" />} />} />
            {!list.loading && list.rows.length > 0 && <TablePagination pagination={list.pagination} onPageChange={list.setPage} />}
          </>
        )}
      </Card>
      {selected !== null && <ComplaintDetailModal id={selected} onClose={() => { setSelected(null); list.reload(); }} />}
    </>
  );
}

function ComplaintDetailModal({ id, onClose }: { id: number; onClose: () => void }) {
  const toast = useToast();
  const detail = useAsync(() => complaintService.detail(id), [id]);
  const [response, setResponse] = useState('');
  const [channel, setChannel] = useState<'EMAIL' | 'CARTA'>('EMAIL');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (action: () => Promise<ComplaintDetail>, success: string) => {
    setBusy(true);
    try {
      detail.setData(await action());
      toast.success(success);
      setResponse('');
      setNote('');
    } catch (error) {
      toast.error('No se pudo completar la acción', message(error));
    } finally {
      setBusy(false);
    }
  };
  const d = detail.data;
  return (
    <Modal open onClose={onClose} title={d ? `Hoja ${d.code}` : 'Hoja de reclamación'} size="xl">
      {detail.error ? <ErrorState error={detail.error} onRetry={detail.reload} /> : !d ? <LoadingState /> : (
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <ComplaintStatusBadge status={d.status} />
            <Badge>{d.kind === 'RECLAMO' ? 'Reclamo' : 'Queja'}</Badge>
            {d.overdue && <Badge tone="danger"><AlertTriangle className="h-3.5 w-3.5" /> Plazo vencido</Badge>}
            <span className="text-muted">Límite: {formatDate(d.due_date)}</span>
            {d.company_name && <span className="text-muted">· Empresa relacionada: {d.company_name}</span>}
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-control bg-slate-50 p-3 font-sans text-slate-700 ring-1 ring-black/5">{d.sheet}</pre>

          {d.response ? (
            <div className="rounded-control bg-success-50 p-3">
              <p className="font-semibold text-ink">Respuesta ({d.response_channel}) · {d.response_at ? formatDateTime(d.response_at) : ''}</p>
              <p className="mt-1 whitespace-pre-line">{d.response}</p>
              {d.response_channel === 'EMAIL' && <p className="mt-1 text-xs text-muted">{d.response_emailed_at ? `Correo enviado el ${formatDateTime(d.response_emailed_at)}` : 'El correo no se pudo enviar: enviar por otro medio y dejar nota.'}</p>}
            </div>
          ) : d.status !== 'CLOSED' && (
            <div className="space-y-3 rounded-control ring-1 ring-border p-3">
              <Textarea label="Respuesta al consumidor (escrita, única)" rows={4} maxLength={5000} value={response} onChange={(event) => setResponse(event.target.value)} />
              <div className="flex flex-wrap items-end gap-2">
                <Select label="Canal" value={channel} onChange={(event) => setChannel(event.target.value as 'EMAIL' | 'CARTA')} options={[{ value: 'EMAIL', label: 'Correo electrónico' }, { value: 'CARTA', label: 'Carta' }]} containerClassName="w-48" />
                <Button loading={busy} disabled={!response.trim()} onClick={() => void act(() => complaintService.update(id, { response: response.trim(), response_channel: channel }), 'Respuesta registrada.')}>Registrar respuesta</Button>
                {d.status === 'RECEIVED' && <Button variant="outline" loading={busy} onClick={() => void act(() => complaintService.update(id, { status: 'IN_REVIEW' }), 'Hoja en revisión.')}>Marcar en revisión</Button>}
              </div>
            </div>
          )}
          {d.status === 'ANSWERED' && <Button variant="outline" loading={busy} onClick={() => void act(() => complaintService.update(id, { status: 'CLOSED' }), 'Hoja cerrada.')}>Cerrar hoja</Button>}

          <div>
            <h3 className="font-semibold text-ink">Historial</h3>
            <ol className="mt-2 space-y-2">
              {d.events.map((event) => (
                <li key={event.id} className="rounded-control bg-slate-50 px-3 py-2">
                  <span className="font-medium">{complaintEventLabel(event.event, event.to_status)}</span> ·{' '}<span className="text-muted">{formatDateTime(event.created_at)} · {event.first_name ?? event.actor_role ?? 'Sistema'}</span>
                  {event.note && <p className="mt-1 whitespace-pre-line text-slate-700">{event.note}</p>}
                </li>
              ))}
            </ol>
            <div className="mt-3 flex gap-2">
              <Input aria-label="Nota interna" placeholder="Nota interna (no la ve el consumidor ni la empresa)" value={note} onChange={(event) => setNote(event.target.value)} containerClassName="flex-1" />
              <Button variant="outline" disabled={!note.trim()} loading={busy} onClick={() => void act(() => complaintService.addNote(id, note.trim()), 'Nota registrada.')}>Añadir</Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

